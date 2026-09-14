import {
  OVERPASS_MAX_RESPONSE_BYTES,
  OVERPASS_MIRROR_BACKOFF_BASE_MS,
  OVERPASS_MIRROR_BACKOFF_MAX_MS,
  OVERPASS_UPSTREAMS,
  OVERPASS_TIMEOUT_MS,
} from './constants.js';
import { readResponseTextCapped } from '../common/http.js';
import { simplifyOverpassPayloadBody } from './geometry.js';

/**
 * Per-mirror circuit breaker state shared by every Overpass caller in this
 * process: endpoint -> {failures, openUntil, probing}. A mirror with no entry is
 * healthy. Bounded by the mirror list.
 * @type {Map<string, {failures:number, openUntil:number, probing:boolean}>}
 */
const _overpassMirrorHealth = new Map();

/**
 * Statuses that describe the query rather than the mirror. A parse error or an
 * oversized query is refused the same way by every mirror, so it must not
 * take a healthy mirror out of rotation.
 */
const OVERPASS_QUERY_REFUSAL_STATUSES = new Set([400, 413, 414]);

/**
 * Detect whether an Overpass API response body indicates rate-limiting.
 *
 * Checks for known rate-limit phrases in the body text regardless of
 * HTTP status code, since some mirrors return 200 with an error payload.
 *
 * @param {string} bodyText - Upstream response body.
 * @returns {boolean} True if the body looks rate-limited.
 */
function overpassLooksRateLimited(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return (
    text.includes('rate_limited') ||
    text.includes('quota of your ip address') ||
    text.includes('dispatcher_client::request_read_and_idx::rate_limited') ||
    text.includes('too many requests')
  );
}

/**
 * Detect an Overpass HTTP-200 body that is actually a runtime FAILURE (server-side
 * timeout / out-of-memory) via its `remark`. These are transient upstream failures,
 * not authoritative empty results, so they must not be returned or cached.
 */
function overpassLooksRuntimeError(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return (
    text.includes('runtime error') ||
    text.includes('timed out') ||
    text.includes('out of memory')
  );
}

/**
 * True only for an upstream response that is actually Overpass data.
 *
 * The proxy caches on this and serves stale on its negation, so the two
 * decisions cannot drift apart: a payload that is not data must never be
 * written to the cache and must always be eligible for a stale replacement.
 * @param {{status: number, rateLimited?: boolean, runtimeError?: boolean}} payload
 * @returns {boolean}
 */
function overpassPayloadIsData(payload) {
  const status = Number(payload?.status);
  return (
    Number.isFinite(status) &&
    status >= 200 &&
    status < 300 &&
    !payload.rateLimited &&
    !payload.runtimeError
  );
}

/**
 * Whether a mirror may be asked now. A mirror inside its skip window is not.
 * Once the window passes, exactly one caller probes it (half-open); others keep
 * skipping it until that probe settles, so a still-dead mirror costs one
 * timeout per window instead of one per concurrent query.
 * @param {Map<string, object>} health
 * @param {string} endpoint
 * @param {number} now
 * @returns {boolean}
 */
function overpassMirrorAdmits(health, endpoint, now) {
  const entry = health.get(endpoint);
  if (!entry) return true;
  if (now < entry.openUntil || entry.probing) return false;
  entry.probing = true;
  return true;
}

/**
 * Take a mirror out of rotation for a window that starts at `baseMs` and
 * doubles per consecutive failure up to `maxMs`.
 * @returns {number} The skip window in ms.
 */
function tripOverpassMirror(health, endpoint, now, baseMs, maxMs, reason) {
  const current = health.get(endpoint);
  // Concurrent queries admitted before the first failure landed report the
  // same outage; one outage is one step of the backoff, not several.
  if (current && now < current.openUntil) return current.openUntil - now;
  const failures = (current?.failures || 0) + 1;
  const windowMs = Math.min(maxMs, baseMs * 2 ** (failures - 1));
  health.set(endpoint, { failures, openUntil: now + windowMs, probing: false });
  console.warn(
    `[Overpass Proxy] skipping ${endpoint} for ${Math.round(windowMs / 1000)} s after ${reason}`,
  );
  return windowMs;
}

/** Forget every mirror's failures (tests, and a manual recovery hook). */
function resetOverpassMirrorHealth(health = _overpassMirrorHealth) {
  health.clear();
}

/**
 * Current skip windows by endpoint, for diagnostics and tests.
 * @returns {Object<string, {failures:number, openUntil:number}>}
 */
function overpassMirrorHealthSnapshot(health = _overpassMirrorHealth) {
  return Object.fromEntries(
    [...health].map(([endpoint, { failures, openUntil }]) => [
      endpoint,
      { failures, openUntil },
    ]),
  );
}

/**
 * Try each admitted mirror once, retaining response-size and per-mirror timeout
 * caps. Refusals and body-level failures rotate; total failure returns the last
 * rate-limit payload, otherwise the first refusal, or throws a network error.
 *
 * Circuit breaker: a mirror that times out, cannot be reached, refuses the
 * proxy (any non-2xx other than a query-level 400/413/414) or rate-limits it
 * is skipped for OVERPASS_MIRROR_BACKOFF_BASE_MS, doubling per consecutive
 * failure up to OVERPASS_MIRROR_BACKOFF_MAX_MS. Any real answer resets it.
 * When every mirror is inside its window the call throws at once
 * (code OVERPASS_MIRRORS_BACKING_OFF) instead of waiting out four timeouts.
 * @param {string} body URL-encoded Overpass QL query body.
 * @param {number} [maxResponseBytes] Endpoint-specific response cap.
 * @param {object} [options] Server-only endpoint, breaker and I/O overrides for tests.
 * @returns {Promise<{status:number,body:string,contentType:string,endpoint:string,rateLimited:boolean}>}
 */
async function fetchOverpassPayload(
  body,
  maxResponseBytes = OVERPASS_MAX_RESPONSE_BYTES,
  {
    endpoints = OVERPASS_UPSTREAMS,
    fetchImpl = fetch,
    readBody = readResponseTextCapped,
    simplify = simplifyOverpassPayloadBody,
    mirrorHealth = _overpassMirrorHealth,
    now = Date.now,
    backoffBaseMs = OVERPASS_MIRROR_BACKOFF_BASE_MS,
    backoffMaxMs = OVERPASS_MIRROR_BACKOFF_MAX_MS,
  } = {},
) {
  let lastError = null;
  let lastRateLimitPayload = null;
  let lastRefusalPayload = null;
  let skipped = 0;

  for (const endpoint of endpoints) {
    if (!overpassMirrorAdmits(mirrorHealth, endpoint, now())) {
      skipped += 1;
      continue;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    const trip = (reason) =>
      tripOverpassMirror(
        mirrorHealth,
        endpoint,
        now(),
        backoffBaseMs,
        backoffMaxMs,
        reason,
      );

    try {
      const upstream = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'gods-eye-view-overpass-proxy/1.0',
        },
        body,
        signal: controller.signal,
      });

      const responseBody = await readBody(upstream, maxResponseBytes);
      const contentType =
        upstream.headers.get('content-type') || 'application/json';
      const status = upstream.status;
      const rateLimited =
        status === 429 || overpassLooksRateLimited(responseBody);
      const runtimeError = overpassLooksRuntimeError(responseBody);
      const payload = {
        status,
        body: responseBody,
        contentType,
        endpoint,
        rateLimited,
        runtimeError,
      };

      if (rateLimited) {
        trip(`rate limiting (HTTP ${status})`);
        lastRateLimitPayload = payload;
        continue;
      }
      // A 200 body carrying a runtime error / timeout is a transient upstream
      // failure — skip to the next mirror rather than returning or caching it.
      // The mirror did answer, so it stays in rotation.
      if (runtimeError) {
        mirrorHealth.delete(endpoint);
        lastError = new Error(`Overpass runtime error (${endpoint})`);
        continue;
      }
      // Anything but 2xx is this mirror declining, not an answer. Only 5xx used
      // to rotate, so a 4xx ended the fan-out and was returned — and cached —
      // as data: overpass-api.de and its lz4 alias answer 406 to this proxy's
      // User-Agent while kumi.systems and private.coffee answer 200 to the very
      // same request, so every Overpass-backed layer failed on an Apache error
      // page with two healthy mirrors untried. The first refusal is kept so a
      // genuinely bad query still reports what upstream said, but only after
      // every mirror has had the chance to answer it.
      if (status < 200 || status >= 300) {
        if (OVERPASS_QUERY_REFUSAL_STATUSES.has(status))
          mirrorHealth.delete(endpoint);
        else trip(`HTTP ${status}`);
        if (!lastRefusalPayload) lastRefusalPayload = payload;
        lastError = new Error(
          `Overpass upstream returned ${status} (${endpoint})`,
        );
        continue;
      }

      // Success: decimate giant boundary geometry before it reaches the cache,
      // the disk, or the client (what makes the 32 MB read cap safe to hold).
      mirrorHealth.delete(endpoint);
      payload.body = simplify(payload.body);
      return payload;
    } catch (error) {
      lastError = error;
      // An oversized body is about this query; the mirror itself answered.
      if (error?.code === 'RESPONSE_TOO_LARGE') mirrorHealth.delete(endpoint);
      else
        trip(
          controller.signal.aborted
            ? `a ${OVERPASS_TIMEOUT_MS} ms timeout`
            : error?.code || error?.name || 'a network error',
        );
    } finally {
      clearTimeout(timeoutId);
      const entry = mirrorHealth.get(endpoint);
      if (entry) entry.probing = false;
    }
  }

  if (lastRateLimitPayload) return lastRateLimitPayload;
  if (lastRefusalPayload) return lastRefusalPayload;
  if (lastError) throw lastError;
  if (skipped > 0) {
    throw Object.assign(
      new Error('All Overpass mirrors are backing off after recent failures'),
      { code: 'OVERPASS_MIRRORS_BACKING_OFF' },
    );
  }
  throw new Error('All Overpass upstreams failed');
}

export {
  overpassPayloadIsData,
  fetchOverpassPayload,
  overpassMirrorHealthSnapshot,
  resetOverpassMirrorHealth,
};
