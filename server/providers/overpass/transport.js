import {
  OVERPASS_MAX_RESPONSE_BYTES,
  OVERPASS_MIRROR_BACKOFF_BASE_MS,
  OVERPASS_MIRROR_BACKOFF_MAX_MS,
  OVERPASS_PUBLIC_MIRRORS,
  resolveOverpassUpstreams,
  OVERPASS_USER_AGENT,
  OVERPASS_TIMEOUT_MS,
} from './constants.js';
import { readResponseTextCapped } from '../common/http.js';
import { simplifyOverpassPayloadBody } from './geometry.js';

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

const cooldowns = new Map();

/** A stable, non-retryable capability response shared by every Overpass route. */
export function overpassNotConfigured() {
  return {
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({
      error: 'Detailed OpenStreetMap queries are not configured',
      code: 'OVERPASS_NOT_CONFIGURED',
      retryable: false,
    }),
  };
}

/** Honor Retry-After dates/seconds; absent values use bounded exponential backoff. */
function retryDelay(value, failures, now) {
  const seconds = Number(value);
  const explicit =
    value && Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(value) - now;
  return Number.isFinite(explicit)
    ? Math.max(1000, explicit)
    : Math.min(300_000, 30_000 * 2 ** Math.min(failures, 4));
}

function refusal(status, retryAfterMs) {
  return {
    status,
    contentType: 'application/json',
    rateLimited: status === 429 || status === 406,
    retryAfterMs,
    body: JSON.stringify({
      error: 'Configured Overpass upstream unavailable',
      code: 'OVERPASS_UNAVAILABLE',
      retryable: true,
      retryAfterMs,
    }),
  };
}

/**
 * Whether an endpoint may be asked now. One inside its cooldown is not. Once
 * the cooldown passes, exactly one caller probes it (half-open); others keep
 * skipping it until that probe settles, so a still-dead endpoint costs one
 * timeout per window instead of one per concurrent query.
 * @param {Map<string, object>} health
 * @param {string} endpoint
 * @param {number} now
 * @returns {boolean}
 */
function overpassMirrorAdmits(health, endpoint, now) {
  const entry = health.get(endpoint);
  if (!entry) return true;
  if (now < entry.until || entry.probing) return false;
  entry.probing = true;
  return true;
}

/**
 * Put an endpoint in cooldown. Retry-After (seconds or HTTP date) is honoured;
 * otherwise the window grows per consecutive failure: operator-configured
 * instances use the bounded 30 s to 5 min backoff, public mirrors the measured
 * OVERPASS_MIRROR_BACKOFF_BASE_MS to OVERPASS_MIRROR_BACKOFF_MAX_MS one.
 * Concurrent queries that fail on the same outage step the backoff once.
 * @returns {number} The cooldown in ms.
 */
function coolDown(
  health,
  endpoint,
  now,
  { retryAfter = null, status, backoff },
) {
  const current = health.get(endpoint);
  if (current && now < current.until) return current.until - now;
  const failures = (current?.failures || 0) + 1;
  const delay =
    OVERPASS_PUBLIC_MIRRORS.includes(endpoint) && !retryAfter
      ? Math.min(
          backoff.maxMs,
          backoff.baseMs * 2 ** Math.min(failures - 1, 30),
        )
      : retryDelay(retryAfter, failures - 1, now);
  health.set(endpoint, {
    until: now + delay,
    failures,
    status,
    probing: false,
  });
  while (health.size > 64) health.delete(health.keys().next().value);
  // Host only: a configured endpoint may carry credentials or a token.
  let host = 'a configured endpoint';
  try {
    host = new URL(endpoint).host;
  } catch {
    // keep the generic label
  }
  console.warn(
    `[Overpass Proxy] skipping ${host} for ${Math.round(delay / 1000)} s after HTTP ${status}`,
  );
  return delay;
}

/** Forget every endpoint's failures (tests, and a manual recovery hook). */
function resetOverpassMirrorHealth(health = cooldowns) {
  health.clear();
}

/**
 * Current cooldowns by endpoint, for diagnostics and tests.
 * @returns {Object<string, {failures:number, openUntil:number}>}
 */
function overpassMirrorHealthSnapshot(health = cooldowns) {
  return Object.fromEntries(
    [...health].map(([endpoint, { failures, until }]) => [
      endpoint,
      { failures, openUntil: until },
    ]),
  );
}

/** A query every endpoint refused as malformed or too large; not retryable. */
function queryRefusal(status) {
  return {
    status,
    contentType: 'application/json',
    rateLimited: false,
    body: JSON.stringify({
      error: 'Overpass refused this query',
      code: 'OVERPASS_QUERY_REFUSED',
      retryable: false,
    }),
  };
}

/**
 * Query only the configured chain with capped reads, timeouts and per-endpoint
 * cooldowns (a circuit breaker with a single half-open probe). Explicit
 * endpoint/I/O/breaker overrides are server-only test seams. Empty data is valid.
 *
 * An endpoint that times out, cannot be reached, refuses the proxy or
 * rate-limits it is skipped for its cooldown. Answers about the query itself
 * (a 400/413/414, a runtime-error remark or an oversized body) move on to the
 * next endpoint but leave this one in rotation. Every failure returns a
 * sanitized refusal (never an endpoint URL); this never throws.
 * @param {string} body URL-encoded Overpass QL query body.
 * @param {number} [maxResponseBytes] Endpoint-specific response cap.
 * @param {object} [options]
 * @returns {Promise<{status:number,body:string,contentType:string,endpoint?:string,rateLimited:boolean,retryAfterMs?:number}>}
 */
async function fetchOverpassPayload(
  body,
  maxResponseBytes = OVERPASS_MAX_RESPONSE_BYTES,
  {
    endpoints = resolveOverpassUpstreams(),
    fetchImpl = fetch,
    readBody = readResponseTextCapped,
    simplify = simplifyOverpassPayloadBody,
    now = Date.now,
    mirrorHealth = cooldowns,
    backoffBaseMs = OVERPASS_MIRROR_BACKOFF_BASE_MS,
    backoffMaxMs = OVERPASS_MIRROR_BACKOFF_MAX_MS,
  } = {},
) {
  if (!endpoints.length) return overpassNotConfigured();
  const backoff = { baseMs: backoffBaseMs, maxMs: backoffMaxMs };
  let failure = refusal(502, 30_000);
  let queryRefused = null;
  for (const endpoint of endpoints) {
    if (!overpassMirrorAdmits(mirrorHealth, endpoint, now())) {
      const previous = mirrorHealth.get(endpoint);
      failure = refusal(
        previous?.status || 502,
        Math.max(1000, (previous?.until || 0) - now()),
      );
      continue;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const requestUrl = new URL(endpoint);
      const authorization =
        requestUrl.username || requestUrl.password
          ? 'Basic ' +
            Buffer.from(
              `${decodeURIComponent(requestUrl.username)}:${decodeURIComponent(requestUrl.password)}`,
            ).toString('base64')
          : null;
      requestUrl.username = '';
      requestUrl.password = '';
      const upstream = await fetchImpl(requestUrl.href, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': OVERPASS_USER_AGENT,
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body,
        signal: controller.signal,
      });
      const responseBody = await readBody(upstream, maxResponseBytes);
      // The endpoint answered about this query, not about itself: try the
      // next one, but keep this one in rotation.
      if (OVERPASS_QUERY_REFUSAL_STATUSES.has(upstream.status)) {
        mirrorHealth.delete(endpoint);
        if (!queryRefused) queryRefused = queryRefusal(upstream.status);
        continue;
      }
      const rateLimited =
        upstream.status === 429 ||
        upstream.status === 406 ||
        overpassLooksRateLimited(responseBody);
      const answered = upstream.status >= 200 && upstream.status < 300;
      if (!rateLimited && answered && overpassLooksRuntimeError(responseBody)) {
        // A 200 carrying a runtime error / timeout is transient for this
        // query; the endpoint did answer, so it stays in rotation.
        mirrorHealth.delete(endpoint);
        continue;
      }
      if (rateLimited || !answered) {
        const status = rateLimited
          ? upstream.status === 406
            ? 406
            : 429
          : 502;
        const delay = coolDown(mirrorHealth, endpoint, now(), {
          retryAfter: upstream.headers?.get?.('retry-after') ?? null,
          status,
          backoff,
        });
        failure = refusal(status, delay);
        continue;
      }
      const parsed = JSON.parse(responseBody);
      if (!Array.isArray(parsed?.elements) || parsed.remark)
        throw new Error('Malformed Overpass response');
      mirrorHealth.delete(endpoint);
      return {
        status: upstream.status,
        body: simplify(responseBody),
        contentType: 'application/json',
        // Never retain a secret-bearing endpoint in cache or response metadata.
        endpoint: 'configured',
        rateLimited: false,
      };
    } catch (error) {
      // An oversized body is about this query; the endpoint itself answered.
      if (error?.code === 'RESPONSE_TOO_LARGE') {
        mirrorHealth.delete(endpoint);
        if (!queryRefused) queryRefused = queryRefusal(413);
        continue;
      }
      const delay = coolDown(mirrorHealth, endpoint, now(), {
        status: 502,
        backoff,
      });
      failure = refusal(502, delay);
    } finally {
      clearTimeout(timeoutId);
      const entry = mirrorHealth.get(endpoint);
      if (entry) entry.probing = false;
    }
  }
  if (failure.rateLimited) return failure;
  return queryRefused || failure;
}

export {
  overpassPayloadIsData,
  fetchOverpassPayload,
  overpassMirrorHealthSnapshot,
  resetOverpassMirrorHealth,
};
