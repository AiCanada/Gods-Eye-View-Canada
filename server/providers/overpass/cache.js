import { isOverpassBoundaryQuery } from './query.js';
import {
  OVERPASS_BOUNDARY_DISK_TTL_MS,
  OVERPASS_DISK_TTL_MS,
  OVERPASS_DISK_DIR,
  OVERPASS_CACHE_MS,
  OVERPASS_CACHE_MAX_ENTRIES,
} from './constants.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { overpassPayloadIsData } from './transport.js';
import { haversineKm } from '../common/geo.js';

/** @type {Map<string,{status:number,body:string,contentType:string,endpoint:string,cachedAt:number}>} */
const _overpassCache = new Map();

/** One signed decimal coordinate, captured. */
const OVERPASS_COORDINATE = '(-?\\d+(?:\\.\\d+)?)';

/** `around:radius,lat,lon` — captures the centre. */
const OVERPASS_AROUND_POINT_RE = new RegExp(
  `around:\\s*[\\d.eE+]+\\s*,\\s*${OVERPASS_COORDINATE}\\s*,\\s*${OVERPASS_COORDINATE}`,
  'g',
);

/** `is_in(lat,lon)` — captures the point. */
const OVERPASS_IS_IN_POINT_RE = new RegExp(
  `is_in\\s*\\(\\s*${OVERPASS_COORDINATE}\\s*,\\s*${OVERPASS_COORDINATE}\\s*\\)`,
  'g',
);

/** `(s,w,n,e)` — captures all four bounds. */
const OVERPASS_BBOX_BOUNDS_RE = new RegExp(
  `\\(\\s*${[1, 2, 3, 4].map(() => OVERPASS_COORDINATE).join('\\s*,\\s*')}\\s*\\)`,
  'g',
);

/**
 * Every place a cached Overpass query is anchored to: `around:` centres,
 * `is_in(lat,lon)` points and `(s,w,n,e)` bbox centres. A boundary pivot by
 * area id carries no coordinates and yields none.
 * @param {string} cacheKey - Normalized `data=` form body.
 * @returns {Array<{latitude: number, longitude: number}>}
 */
function overpassCacheAnchors(cacheKey) {
  const ql = new URLSearchParams(String(cacheKey || '')).get('data') || '';
  const anchors = [];
  const add = (latitude, longitude) => {
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)
      anchors.push({ latitude, longitude });
  };
  for (const m of ql.matchAll(OVERPASS_AROUND_POINT_RE))
    add(Number(m[1]), Number(m[2]));
  for (const m of ql.matchAll(OVERPASS_IS_IN_POINT_RE))
    add(Number(m[1]), Number(m[2]));
  for (const m of ql.matchAll(OVERPASS_BBOX_BOUNDS_RE))
    add((Number(m[1]) + Number(m[3])) / 2, (Number(m[2]) + Number(m[4])) / 2);
  return anchors;
}

/**
 * Release memory-cached Overpass payloads anchored only to places farther than
 * `radiusKm` from a point, after the user switches location. A query with any
 * anchor inside the radius stays, and so does one with no coordinates at all
 * (boundary pivots). Memory only: the disk tier keeps every payload, so a
 * return to the old area reads it back instead of asking the mirrors.
 * @param {{latitude: number, longitude: number}} point
 * @param {number} radiusKm
 * @param {Map<string, object>} [cache]
 * @returns {number} How many entries were removed.
 */
function pruneOverpassMemoryOutside(point, radiusKm, cache = _overpassCache) {
  const latitude = point?.latitude;
  const longitude = point?.longitude;
  if (![latitude, longitude, radiusKm].every(Number.isFinite) || radiusKm < 0)
    return 0;
  let removed = 0;
  for (const key of cache.keys()) {
    const anchors = overpassCacheAnchors(key);
    if (!anchors.length) continue;
    const near = anchors.some(
      (anchor) =>
        haversineKm(latitude, longitude, anchor.latitude, anchor.longitude) <=
        radiusKm,
    );
    if (near) continue;
    cache.delete(key);
    removed += 1;
  }
  return removed;
}

/** Disk TTL for a query: boundary geometry keeps for a month, the rest 7 days. */
function overpassDiskTtlMs(cacheKey) {
  return isOverpassBoundaryQuery(cacheKey)
    ? OVERPASS_BOUNDARY_DISK_TTL_MS
    : OVERPASS_DISK_TTL_MS;
}

/** Normalized Overpass query -> stable disk-cache file path. */
function overpassDiskPath(cacheKey) {
  return path.join(
    OVERPASS_DISK_DIR,
    `${createHash('sha1').update(cacheKey).digest('hex')}.json`,
  );
}

/**
 * Read a disk-cached Overpass payload. maxAgeMs Infinity = any age (the
 * serve-stale path when every mirror is down).
 * @returns {Promise<?Object>} Payload with cachedAt, or null.
 */
async function readOverpassDisk(cacheKey, maxAgeMs) {
  try {
    const raw = await fsp.readFile(overpassDiskPath(cacheKey), 'utf8');
    const payload = JSON.parse(raw);
    if (
      !payload ||
      typeof payload.body !== 'string' ||
      !Number.isFinite(payload.cachedAt)
    )
      return null;
    // Older versions persisted 4xx refusals with normal data TTLs. Ignore
    // them on both fresh and stale reads so an upgrade can recover immediately.
    if (!overpassPayloadIsData(payload)) return null;
    if (Date.now() - payload.cachedAt > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Fire-and-forget disk write for a successful Overpass payload. */
function writeOverpassDisk(cacheKey, payload) {
  fsp
    .mkdir(OVERPASS_DISK_DIR, { recursive: true })
    .then(() =>
      fsp.writeFile(overpassDiskPath(cacheKey), JSON.stringify(payload)),
    )
    .catch((err) =>
      console.warn(
        '[Overpass Proxy] disk cache write failed:',
        err?.message || err,
      ),
    );
}

/**
 * Resolve every cache/coalescing layer before admitting a request to the local
 * upstream rate limiter. The injected limiter callback is invoked exactly once
 * for a complete cache miss and never for memory, in-flight, or disk hits.
 * Exported so the admission ordering can be tested without a Vite server.
 *
 * @param {object} options
 * @param {string} options.cacheKey
 * @param {Map<string, object>} options.memoryCache
 * @param {Map<string, Promise<object>>} options.inFlight
 * @param {()=>Promise<object|null>} options.readDisk
 * @param {()=>boolean} options.allowUpstream
 * @param {number} [options.now]
 * @param {number} [options.cacheMs]
 * @returns {Promise<{source:'HIT'|'INFLIGHT'|'DISK'|'UPSTREAM'|'RATE_LIMITED', payload:object|null}>}
 */
async function resolveOverpassPreflight({
  cacheKey,
  memoryCache,
  inFlight,
  readDisk,
  allowUpstream,
  now = Date.now(),
  cacheMs = OVERPASS_CACHE_MS,
}) {
  const cached = memoryCache.get(cacheKey);
  if (overpassPayloadIsData(cached) && now - cached.cachedAt <= cacheMs)
    return { source: 'HIT', payload: cached };

  const pending = inFlight.get(cacheKey);
  if (pending) return { source: 'INFLIGHT', payload: await pending };

  const disk = await readDisk();
  if (overpassPayloadIsData(disk)) return { source: 'DISK', payload: disk };

  return allowUpstream()
    ? { source: 'UPSTREAM', payload: null }
    : { source: 'RATE_LIMITED', payload: null };
}

/** Return only last-good Overpass data, regardless of its age. */
async function readStaleOverpass(cacheKey) {
  const cached = _overpassCache.get(cacheKey);
  return overpassPayloadIsData(cached)
    ? cached
    : readOverpassDisk(cacheKey, Infinity);
}

/** Evict oldest Overpass cache entries until size is within the cap. */
function trimOverpassCache() {
  while (_overpassCache.size > OVERPASS_CACHE_MAX_ENTRIES) {
    const oldestKey = _overpassCache.keys().next().value;
    if (!oldestKey) break;
    _overpassCache.delete(oldestKey);
  }
}

export {
  readOverpassDisk,
  resolveOverpassPreflight,
  _overpassCache,
  overpassCacheAnchors,
  pruneOverpassMemoryOutside,
  overpassDiskTtlMs,
  readStaleOverpass,
  trimOverpassCache,
  writeOverpassDisk,
};
