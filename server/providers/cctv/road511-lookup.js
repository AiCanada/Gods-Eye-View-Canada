import { createHash } from 'node:crypto';
import { readResponseTextCapped } from '../common/http.js';
import {
  ROAD511_API_BASE,
  ROAD511_BACKOFF_MAX_MS,
  ROAD511_BACKOFF_MIN_MS,
  ROAD511_CACHE_MAX_ENTRIES,
  ROAD511_FETCH_TIMEOUT_MS,
  ROAD511_MAX_BODY_BYTES,
  ROAD511_NEGATIVE_TTL_MS,
  ROAD511_PAUSE_MAX_MS,
  ROAD511_PAUSE_MIN_MS,
  ROAD511_POSITIVE_TTL_MS,
  ROAD511_SPACING_MS,
  ROAD511_SPACING_WAIT_MS,
} from './constants.js';
import { isPublicHostname } from './frame-resolver.js';
import { readJsonFile, writeJsonFileAtomic } from './json-file.js';
import { normalizeFeedType } from './normalize.js';
import { CCTV_PROXY_USER_AGENT } from './upstream-headers.js';
import { parseRetryAfterMs } from './upstream-gate.js';

const LOOKUP_FORMAT = 'gev-road511-lookups/1';
const ID_PREFIX = 'us511-';
/** Road511 feature ids: state code, "-cam-", then a short token. Maine, New
 * Hampshire and Vermont ids carry spaces, commas, brackets and "?"
 * ("ME-cam-I-95 Mile 108 NB (Augusta)"); the id is percent-encoded in the URL.
 * No slash, "=" or "+" is ever accepted. */
export const ROAD511_FEATURE_ID_PATTERN =
  /^[A-Z]{2}-cam-[A-Za-z0-9 _.,()?-]{1,80}$/;
/** The view suffix a multi-view pack entry carries ("us511-NE-cam-12-N"). */
const VIEW_SUFFIX = /-(N|S|E|W|NE|NW|SE|SW)$/;
const BACKOFF_MAX_ENTRIES = 5000;

/**
 * Road511 feature id for a pack camera id: the id without "us511-" and without
 * a trailing view suffix. '' when the id is not a Road511 listing camera or the
 * feature id is not one the lookup may send.
 *
 * @param {string} cameraId
 * @returns {string}
 */
export function road511FeatureId(cameraId) {
  const id = String(cameraId || '');
  if (!id.startsWith(ID_PREFIX)) return '';
  let feature = id.slice(ID_PREFIX.length);
  if (VIEW_SUFFIX.test(feature)) {
    const base = feature.replace(VIEW_SUFFIX, '');
    if (ROAD511_FEATURE_ID_PATTERN.test(base)) feature = base;
  }
  return ROAD511_FEATURE_ID_PATTERN.test(feature) ? feature : '';
}

/** The view a multi-view pack entry names ("N", "SW"), or ''. */
function viewOf(cameraId) {
  const feature = String(cameraId || '').slice(ID_PREFIX.length);
  const match = VIEW_SUFFIX.exec(feature);
  return match && ROAD511_FEATURE_ID_PATTERN.test(feature.slice(0, match.index))
    ? match[1]
    : '';
}

/**
 * A still URL the proxy may later fetch: http(s) on a public host name, no
 * credentials, and not an HLS playlist. '' otherwise.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function safeRoad511StillUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  if (parsed.username || parsed.password) return '';
  if (!isPublicHostname(parsed.hostname)) return '';
  if (/\.m3u8$/i.test(parsed.pathname)) return '';
  return parsed.href;
}

const isObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Pull the camera still out of a Road511 feature-details payload. The shape is
 * read defensively: `data` (or the payload itself) merged with its
 * `properties`, then `url` / `image_url` / `imageUrl`, then a `views` list or
 * dictionary. HLS playlists and unsafe hosts are skipped.
 *
 * @param {unknown} payload
 * @param {{view?: string}} [options] - Preferred view for a multi-view entry.
 * @returns {string} Still URL, or '' when the feature has no usable image.
 */
export function road511StillUrl(payload, { view = '' } = {}) {
  const root = isObject(payload) ? payload : {};
  const data = isObject(root.data) ? root.data : root;
  const merged = {
    ...data,
    ...(isObject(data.properties) ? data.properties : {}),
  };
  const candidates = [];
  const collect = (value) => {
    if (typeof value === 'string') {
      candidates.push(value);
      return;
    }
    if (!isObject(value)) return;
    for (const field of ['url', 'image_url', 'imageUrl']) {
      if (typeof value[field] === 'string') candidates.push(value[field]);
    }
  };
  const views = merged.views;
  if (view && isObject(views)) {
    const named = Object.keys(views).find(
      (name) => name.toUpperCase() === view,
    );
    if (named) collect(views[named]);
  }
  if (view && Array.isArray(views)) {
    for (const entry of views) {
      const label = isObject(entry)
        ? String(entry.direction || entry.view || entry.name || '')
        : '';
      if (label.toUpperCase() === view) collect(entry);
    }
  }
  collect(merged.url);
  collect(merged.image_url);
  collect(merged.imageUrl);
  if (Array.isArray(views)) views.forEach(collect);
  else if (isObject(views)) Object.values(views).forEach(collect);
  for (const candidate of candidates) {
    const safe = safeRoad511StillUrl(candidate);
    if (safe) return safe;
  }
  return '';
}

/**
 * On-demand Road511 still lookups for pack cameras that list no public image.
 *
 * Only a catalogue camera with `lookup: 'road511'` and a valid feature id is
 * ever looked up, and only when `lookup()` is called (the explicit POST route).
 * The key is read from the environment on every call and never stored,
 * cached, or logged. Answers are cached in memory and in `cacheFile` (URLs
 * and states only) for a day, positive or negative.
 */
export function createRoad511Lookup({
  cacheFile = '',
  env,
  fetchImpl,
  now = Date.now,
  spacingMs = ROAD511_SPACING_MS,
  spacingWaitMs = ROAD511_SPACING_WAIT_MS,
  timeoutMs = ROAD511_FETCH_TIMEOUT_MS,
  flushDelayMs = 2000,
  maxEntries = ROAD511_CACHE_MAX_ENTRIES,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const apiKey = () =>
    String((env || process.env).ROAD511_API_KEY || '').trim();
  /** @type {Map<string, {state: 'resolved'|'no-image', url: string, at: number}>} */
  const entries = new Map();
  /** @type {Map<string, {failures: number, until: number}>} */
  const backoff = new Map();
  const inflight = new Map();
  const counters = { road511Calls: 0, road511CacheHits: 0 };
  let loaded = null;
  let pausedUntil = 0;
  /** Fingerprint of a key Road511 refused; memory only, never logged. */
  let rejectedKey = '';
  let lastCallAt = -Infinity;
  let warnedRedirect = false;
  let dirty = false;
  let flushTimer = null;
  let writing = null;

  const fingerprint = (key) => createHash('sha256').update(key).digest('hex');
  const ttlOf = (entry) =>
    entry.state === 'resolved'
      ? ROAD511_POSITIVE_TTL_MS
      : ROAD511_NEGATIVE_TTL_MS;
  const freshEntry = (id) => {
    const entry = entries.get(id);
    return entry && now() - entry.at < ttlOf(entry) ? entry : null;
  };
  const trim = () => {
    while (entries.size > maxEntries)
      entries.delete(entries.keys().next().value);
  };

  async function load() {
    if (!cacheFile) return;
    const saved = await readJsonFile(cacheFile);
    if (saved?.format !== LOOKUP_FORMAT || !isObject(saved.entries)) return;
    for (const [id, entry] of Object.entries(saved.entries)) {
      if (entries.has(id) || !isObject(entry) || !Number.isFinite(entry.at))
        continue;
      if (entry.state === 'resolved') {
        const url = safeRoad511StillUrl(entry.url);
        if (url) entries.set(id, { state: 'resolved', url, at: entry.at });
      } else if (entry.state === 'no-image') {
        entries.set(id, { state: 'no-image', url: '', at: entry.at });
      }
    }
    trim();
  }

  /** Read the disk cache once; later calls share the same read. */
  function ready() {
    if (!loaded) loaded = load();
    return loaded;
  }

  async function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    while (writing) await writing;
    if (!dirty || !cacheFile) return;
    dirty = false;
    const at = now();
    const out = {};
    for (const [id, entry] of entries) {
      if (at - entry.at >= ttlOf(entry)) continue;
      out[id] =
        entry.state === 'resolved'
          ? { state: entry.state, url: entry.url, at: entry.at }
          : { state: entry.state, at: entry.at };
    }
    writing = writeJsonFileAtomic(cacheFile, {
      format: LOOKUP_FORMAT,
      entries: out,
    })
      .then((ok) => {
        if (!ok) dirty = true;
      })
      .finally(() => {
        writing = null;
      });
    await writing;
  }

  function remember(id, state, url = '') {
    entries.delete(id);
    entries.set(id, { state, url, at: now() });
    trim();
    dirty = true;
    if (flushTimer || !cacheFile) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, flushDelayMs);
    flushTimer.unref?.();
  }

  function backOff(id) {
    const failures = (backoff.get(id)?.failures || 0) + 1;
    const waitMs = Math.min(
      ROAD511_BACKOFF_MAX_MS,
      ROAD511_BACKOFF_MIN_MS * 2 ** (failures - 1),
    );
    backoff.delete(id);
    backoff.set(id, { failures, until: now() + waitMs });
    while (backoff.size > BACKOFF_MAX_ENTRIES)
      backoff.delete(backoff.keys().next().value);
    return { lookupState: 'backoff', url: '', retryAfterMs: waitMs };
  }

  /** Is this catalogue camera one the lookup may ever send? */
  function eligible(source) {
    return (
      Boolean(source) &&
      source.lookup === 'road511' &&
      normalizeFeedType(source.feedType) === 'none' &&
      Boolean(road511FeatureId(source.id))
    );
  }

  /**
   * Cached answer for a camera without any request: 'resolved' (with its
   * still), 'no-image', or 'unresolved'. Call `ready()` first.
   */
  function peek(source) {
    const entry = source ? freshEntry(source.id) : null;
    if (entry) return { lookupState: entry.state, url: entry.url };
    return { lookupState: 'unresolved', url: '' };
  }

  const cancelBody = (response) => {
    try {
      void response.body?.cancel?.()?.catch?.(() => {});
    } catch {
      /* already closed */
    }
  };

  async function request(source, featureId) {
    const key = apiKey();
    if (!key) return { lookupState: 'no-key', url: '', retryAfterMs: 0 };
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException('Road511 lookup timed out', 'TimeoutError'),
        ),
      timeoutMs,
    );
    counters.road511Calls += 1;
    try {
      const response = await (fetchImpl || fetch)(
        `${ROAD511_API_BASE}/features/${encodeURIComponent(featureId)}/details`,
        {
          headers: {
            'X-API-Key': key,
            Accept: 'application/json',
            'User-Agent': CCTV_PROXY_USER_AGENT,
          },
          // Never follow a redirect: fetch strips only the standard credential
          // headers on one, so X-API-Key would go to whatever host (or plain
          // http) the Location names.
          redirect: 'manual',
          signal: controller.signal,
        },
      );
      if (
        response.type === 'opaqueredirect' ||
        response.status === 0 ||
        (response.status >= 300 && response.status < 400)
      ) {
        cancelBody(response);
        if (!warnedRedirect) {
          warnedRedirect = true;
          console.warn(
            `[CCTV] Road511 answered a lookup with a redirect (HTTP ${response.status}); it is not followed, so the key is never sent elsewhere.`,
          );
        }
        return backOff(source.id);
      }
      if (response.status === 401 || response.status === 403) {
        cancelBody(response);
        const print = fingerprint(key);
        if (rejectedKey !== print) {
          rejectedKey = print;
          console.warn(
            `[CCTV] Road511 refused ROAD511_API_KEY (HTTP ${response.status}); lookups stop until the key changes.`,
          );
        }
        return { lookupState: 'key-rejected', url: '', retryAfterMs: 0 };
      }
      if (response.status === 429) {
        cancelBody(response);
        const retry = parseRetryAfterMs(
          response.headers?.get?.('retry-after'),
          now(),
        );
        const pauseMs = Math.min(
          ROAD511_PAUSE_MAX_MS,
          Math.max(ROAD511_PAUSE_MIN_MS, Number.isFinite(retry) ? retry : 0),
        );
        pausedUntil = now() + pauseMs;
        console.warn(
          `[CCTV] Road511 rate limit reached; lookups paused for ${Math.round(pauseMs / 1000)} s.`,
        );
        return { lookupState: 'backoff', url: '', retryAfterMs: pauseMs };
      }
      if (response.status >= 500) {
        cancelBody(response);
        return backOff(source.id);
      }
      if (!response.ok) {
        // 404 and every other refusal of this feature: it has no image to give.
        cancelBody(response);
        backoff.delete(source.id);
        remember(source.id, 'no-image');
        return { lookupState: 'no-image', url: '', retryAfterMs: 0 };
      }
      const text = await readResponseTextCapped(
        response,
        ROAD511_MAX_BODY_BYTES,
        controller.signal,
      );
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return backOff(source.id);
      }
      backoff.delete(source.id);
      const url = road511StillUrl(payload, { view: viewOf(source.id) });
      if (url) {
        remember(source.id, 'resolved', url);
        return { lookupState: 'resolved', url, retryAfterMs: 0 };
      }
      remember(source.id, 'no-image');
      return { lookupState: 'no-image', url: '', retryAfterMs: 0 };
    } catch {
      return backOff(source.id);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Why a lookup may not send a request right now, or null when it may: no
   * key, a key Road511 refused, a rate-limit pause, or this camera backing off.
   */
  function heldBack(source) {
    const key = apiKey();
    if (!key) return { lookupState: 'no-key', url: '', retryAfterMs: 0 };
    if (rejectedKey && rejectedKey === fingerprint(key))
      return { lookupState: 'key-rejected', url: '', retryAfterMs: 0 };
    const at = now();
    if (pausedUntil > at)
      return {
        lookupState: 'backoff',
        url: '',
        retryAfterMs: pausedUntil - at,
      };
    const failing = backoff.get(source.id);
    if (failing && failing.until > at)
      return {
        lookupState: 'backoff',
        url: '',
        retryAfterMs: failing.until - at,
      };
    return null;
  }

  /**
   * Look one camera up. Answers without any request when the camera is not a
   * lookup camera, the answer is cached, no key is set, the key was refused,
   * lookups are paused or backing off, or the next request slot is more than
   * `spacingWaitMs` away (`busy`). Concurrent calls for a camera share one
   * request, and requests are spaced at least `spacingMs` apart.
   *
   * @param {object|undefined} source - Catalogue entry.
   * @returns {Promise<{lookupState: string, url: string, retryAfterMs: number}>}
   */
  async function lookup(source) {
    if (!source) return { lookupState: 'unknown', url: '', retryAfterMs: 0 };
    if (!eligible(source))
      return { lookupState: 'not-lookup', url: '', retryAfterMs: 0 };
    const featureId = road511FeatureId(source.id);
    await ready();
    const cached = freshEntry(source.id);
    if (cached) {
      counters.road511CacheHits += 1;
      return { lookupState: cached.state, url: cached.url, retryAfterMs: 0 };
    }
    const held = heldBack(source);
    if (held) return held;
    const shared = inflight.get(source.id);
    if (shared) return shared;
    const at = now();
    const waitMs = Math.max(0, lastCallAt + spacingMs - at);
    if (waitMs > spacingWaitMs)
      return { lookupState: 'busy', url: '', retryAfterMs: waitMs };
    lastCallAt = at + waitMs;
    const pending = (async () => {
      if (waitMs > 0) {
        await sleep(waitMs);
        // An answer that landed during the wait may have paused lookups or
        // refused the key: no queued call spends a request after it.
        const late = heldBack(source);
        if (late) return late;
      }
      return request(source, featureId);
    })().finally(() => {
      inflight.delete(source.id);
    });
    inflight.set(source.id, pending);
    return pending;
  }

  return {
    ready,
    peek,
    lookup,
    eligible,
    flush,
    counters,
    hasKey: () => Boolean(apiKey()),
    keyRejected: () => {
      const key = apiKey();
      return Boolean(key && rejectedKey && rejectedKey === fingerprint(key));
    },
  };
}
