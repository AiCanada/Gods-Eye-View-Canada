import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  fetchTerrainChunkWithRetry,
  parseTerrainPoints,
  resolveTerrainHeightRequest,
  terrainPointKey,
  validTerrainResult,
} from '../../src/data/terrainHeightsProxy.js';
import { haversineKm } from './common/geo.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { admitSameSiteKeyless } from './common/same-site.js';

/**
 * Release handle of the installed terrain proxy, registered on install so a
 * location switch can release far points without reaching into the closure.
 * It lives with the cache it releases (globalThis.__GEV_TERRAIN_CACHE, see
 * terrainHeightsProxy), so a proxy built after an in-process restart replaces
 * the previous one's handle instead of adding a second one for the same
 * points. Nothing installed yet reads as no handles.
 * @returns {Iterable<{prune: (point: {latitude:number, longitude:number}, radiusKm:number) => number}>}
 */
function terrainMemoryTiers() {
  return globalThis.__GEV_TERRAIN_CACHE?.tiers ?? [];
}

/** 1-degree cell of a canonical `lon,lat` point key: the unit restored from disk. */
function terrainKeyCell(key) {
  const [lon, lat] = String(key).split(',').map(Number);
  return `${Math.floor(lon)},${Math.floor(lat)}`;
}

/**
 * Release memory-cached terrain points farther than `radiusKm` from a point,
 * after the user switches location. Memory only, and the disk file never
 * shrinks: only points already persisted are eligible, the periodic flush
 * folds released points back in from disk, and a later request that needs a
 * released cell reads that cell back from disk before anything goes upstream.
 * @param {{latitude: number, longitude: number}} point
 * @param {number} radiusKm
 * @param {Iterable<{prune: Function}>} [tiers] Installed proxies; defaults to all.
 * @returns {number} How many points were removed.
 */
export function pruneTerrainMemoryOutside(
  point,
  radiusKm,
  tiers = terrainMemoryTiers(),
) {
  const latitude = point?.latitude;
  const longitude = point?.longitude;
  if (![latitude, longitude, radiusKm].every(Number.isFinite) || radiusKm < 0)
    return 0;
  let removed = 0;
  for (const tier of tiers)
    removed += tier.prune({ latitude, longitude }, radiusKm);
  return removed;
}

/**
 * Re:Earth terrain point-height proxy: batched lon/lat → ellipsoidal height
 * lookups, keyless. Upstream: https://terrain.reearth.land/heights.json
 * (UPSTREAM_CHUNK points per call — sized against measured latency, see
 * below). Terrain doesn't move, so results are cached to
 * disk with a long TTL (30 days) — mirrors celestrakProxy's memory+disk
 * cache and serve-stale shape. Cache entries and stale fallback are keyed per
 * 5dp point, so reordered and partially overlapping batches reuse prior work.
 * Only missing/stale points go upstream; the response is rebuilt in exact
 * request order. Each request is bounded to one 64-point upstream chunk;
 * larger client workloads are split by the browser terrain service.
 *
 * Bounds, because every distinct 5dp point is its own key: coordinates must be
 * in WGS-84 range (rejected at parse), the point cache has an entry ceiling
 * with oldest-first eviction, an over-large cache file is not read back, and
 * the route carries an always-on per-client limiter. The route also refuses
 * cross-site browser requests, so another web page cannot use the visitor's
 * browser to fill the cache or spend the visitor's own rate-limit quota.
 * Reverse-proxied same-origin requests are admitted: terrain is keyless and
 * needed for rendering, and a 403 would send every chunk to the geoid fallback.
 */
export function terrainHeightsProxy(options = {}) {
  // Destructured in the body, not the signature: `proxyErrorResponses.test.mjs`
  // extracts these proxies by slicing to the first closing brace in column
  // zero, so a multi-line parameter list would cut the function in half.
  // Overridable so the ceilings can be exercised as behaviour rather than
  // asserted as constants; production constructs this with no arguments.
  const {
    cacheMaxEntries = 50_000,
    cacheMaxDiskBytes = 24 * 1024 * 1024,
    cachePath,
  } = options;
  const TTL_MS = 30 * 24 * 3600_000;
  const CACHE_PATH =
    cachePath || path.join(process.cwd(), '.gev-cache', 'terrain-heights.json');
  const CACHE_DIR = path.dirname(CACHE_PATH);
  // Sized against measured upstream latency, not the documented page cap.
  // Re:Earth serves 87-186 ms/point depending on load (observed 2026-09-12,
  // a 2x swing within one hour). 256 points therefore costs 22-48 s and blows
  // the 30 s attempt timeout whenever the service is slow — the long-standing
  // cause of "[terrain-heights-proxy] refresh incomplete" (owner incident
  // 2026-08-21). 64 points costs 5.6-12 s, inside the timeout at both ends of
  // that range.
  const UPSTREAM_CHUNK = 64;
  const MAX_POINTS = UPSTREAM_CHUNK;
  /**
   * Entry ceiling for the point cache, and with it the file written from it.
   *
   * Every distinct 5dp point is a separate key, so without a ceiling the map
   * — and the JSON dumped from it verbatim — grow for as long as a caller
   * supplies new coordinates. Measured against real use rather than guessed:
   * this checkout's `.gev-cache/terrain-heights.json` held 6,189 entries in
   * 1.0 MB after ordinary sessions, i.e. ~168 bytes/entry. 50,000 entries is
   * eight times that working set and ~8 MB on disk, comfortably inside the
   * 24 MB ceiling `rocketLaunchesProxy` already applies to its own cache file.
   */
  const CACHE_MAX_ENTRIES = cacheMaxEntries;
  /** Refuse to load a cache file larger than this (mirrors rocketLaunchesProxy). */
  const CACHE_MAX_DISK_BYTES = cacheMaxDiskBytes;
  /**
   * Requests/min/client. Terrain is keyless and free, so this guards the point
   * cache and the upstream community service rather than a bill. Sized from
   * measurement: across a full `npm run test:track` run — the heaviest
   * exercise this app has — the route served 10 requests, peaking at 8/min.
   * 90/min is an order of magnitude above that, and the band `/api/overpass`
   * and `/api/military-installations` already use.
   */
  const RATE_PER_MIN = 90;
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: RATE_PER_MIN,
    globalMax: RATE_PER_MIN * 3,
  });

  /**
   * Cache state that must outlive an in-process dev-server restart. Vite
   * bundles this file into its config and evaluates it afresh on every
   * server.restart() (a POWER UP save, an edit under server/), and builds the
   * proxy again; state held in this closure would then be pinned by its
   * flush timer while the new proxy started empty beside it, one more timer
   * and one more copy of the points per restart. It lives on globalThis
   * instead, the way ultra-help.js keeps its memory, filled in one field at
   * a time so a newer evaluation can add a field the running one lacks. A
   * process restart still starts it empty. A proxy given its own cache file
   * (`cachePath`, as a test does) keeps its own state beside it instead.
   */
  const SHARED = cachePath ? {} : (globalThis.__GEV_TERRAIN_CACHE ??= {});
  /** @type {Map<string, {at:number, result:object}>} keyed by canonical 5dp lon/lat. */
  SHARED.mem ??= new Map();

  /**
   * Drop the oldest entries until the map is back inside its ceiling.
   * Oldest-first by fetch time, the same shape `trackBackfillProxies` uses.
   * Terrain does not move, so evicting an old point costs one refetch, never
   * a wrong answer.
   */
  function evictOverflow() {
    const mem = SHARED.mem;
    if (mem.size <= CACHE_MAX_ENTRIES) return;
    const byAge = [...mem.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < byAge.length && mem.size > CACHE_MAX_ENTRIES; i += 1)
      mem.delete(byAge[i][0]);
  }
  /** @type {Map<string, Promise<Array<object>>>} single-flight per missing-point subset. */
  SHARED.inflight ??= new Map();
  SHARED.diskLoaded ??= false;
  SHARED.diskDirty ??= false;
  /**
   * Entry objects known to be on disk exactly as they are in memory. Only
   * these may be released: anything newer would be lost before the next flush.
   * @type {WeakSet<object>}
   */
  SHARED.persisted ??= new WeakSet();
  /** @type {Set<string>} 1-degree cells with points released from memory but still on disk. */
  SHARED.releasedCells ??= new Set();
  /** Once anything is released, flushes merge into the disk file instead of replacing it. */
  SHARED.releasedAny ??= false;
  /** The periodic flush, started by the first request and never a second time. */
  SHARED.flushTimer ??= null;
  /** @type {Set<object>} The installed proxy's handle for pruneTerrainMemoryOutside. */
  SHARED.tiers ??= new Set();

  /**
   * Read the stored point map. A missing file reads as empty; an unreadable or
   * half-written one throws, so callers never mistake it for "nothing stored".
   * @returns {Promise<Object<string, {at:number, result:object}>>}
   */
  async function readDiskPoints() {
    let raw;
    try {
      raw = await fsp.readFile(CACHE_PATH, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
    const parsed = JSON.parse(raw);
    return parsed?.version === 2 &&
      parsed.points &&
      typeof parsed.points === 'object'
      ? parsed.points
      : {};
  }

  /** Load the on-disk cache into memory once, lazily (first request only). */
  async function loadDiskOnce() {
    if (SHARED.diskLoaded) return;
    SHARED.diskLoaded = true;
    try {
      // A cache file past the ceiling is not read back into memory: loading it
      // would reinstate exactly the unbounded map the ceiling exists to stop.
      // The next flush rewrites a bounded one.
      //
      // "Cannot measure it" is not "too large": if stat is unavailable, fall
      // through and let readFile decide, so an absent file behaves exactly as
      // it did before this guard existed.
      let sizeBytes = null;
      try {
        sizeBytes = (await fsp.stat(CACHE_PATH)).size;
      } catch {
        sizeBytes = null;
      }
      if (sizeBytes !== null && sizeBytes > CACHE_MAX_DISK_BYTES)
        throw new Error('cache file too large');
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      const pointEntries =
        parsed?.version === 2 &&
        parsed.points &&
        typeof parsed.points === 'object'
          ? parsed.points
          : null;
      if (pointEntries) {
        for (const [key, entry] of Object.entries(pointEntries)) {
          if (
            entry &&
            Number.isFinite(entry.at) &&
            validTerrainResult(entry.result)
          ) {
            SHARED.mem.set(key, entry);
            SHARED.persisted.add(entry);
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        // One-time migration from the former raw-batch cache. Zip only real,
        // positionally present results; an absent value never becomes height 0.
        for (const [rawPoints, entry] of Object.entries(parsed)) {
          const points = parseTerrainPoints(rawPoints);
          if (
            !points ||
            !entry ||
            !Number.isFinite(entry.at) ||
            !Array.isArray(entry.results)
          )
            continue;
          for (let i = 0; i < points.length; i += 1) {
            const result = entry.results[i];
            if (!validTerrainResult(result)) continue;
            const key = terrainPointKey(points[i]);
            const existing = SHARED.mem.get(key);
            if (!existing || entry.at > existing.at)
              SHARED.mem.set(key, { at: entry.at, result });
          }
        }
        SHARED.diskDirty = SHARED.mem.size > 0;
      }
      evictOverflow();
    } catch {
      /* no disk cache yet */
    }
    // Periodic flush, same shape as adsbdbProxy: coalesce writes instead of
    // hitting disk on every request. One per process: a proxy built after a
    // restart finds the previous one's timer already flushing this cache, and
    // the callback reads the shared state only, never this closure's.
    SHARED.flushTimer ??= setInterval(async () => {
      if (!SHARED.diskDirty) return;
      SHARED.diskDirty = false;
      // Written beside the live file and renamed over it, so a restore reading
      // during the write, or a crash mid-write, never sees a truncated file.
      // Same directory, so the rename is atomic on POSIX.
      const temp = `${CACHE_PATH}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        // After a release the file holds points memory no longer does. Merge
        // them back so a flush never shrinks the disk cache; an unreadable file
        // skips this write rather than replacing it with memory alone.
        const points = SHARED.releasedAny ? await readDiskPoints() : {};
        await fsp.mkdir(CACHE_DIR, { recursive: true });
        const written = [...SHARED.mem.values()];
        Object.assign(points, Object.fromEntries(SHARED.mem.entries()));
        // The file keeps the same ceiling as memory: past it, the newest
        // points stay, so a merged file never grows without bound.
        const keys = Object.keys(points);
        if (keys.length > CACHE_MAX_ENTRIES) {
          keys.sort((a, b) => points[b].at - points[a].at);
          for (const key of keys.slice(CACHE_MAX_ENTRIES)) delete points[key];
        }
        await fsp.writeFile(
          temp,
          JSON.stringify({ version: 2, points }),
          'utf8',
        );
        await fsp.rename(temp, CACHE_PATH);
        for (const entry of written) SHARED.persisted.add(entry);
      } catch (err) {
        SHARED.diskDirty = true; // retry next tick
        await fsp.rm(temp, { force: true }).catch(() => {});
        console.warn('[terrain-heights-proxy] cache write failed');
      }
    }, 15_000);
    SHARED.flushTimer.unref?.();
  }

  /**
   * Read released points back from disk for the cells a request needs, so a
   * return to an earlier area costs one file read instead of upstream calls.
   * A failed read leaves the cells released and the next request retries.
   * @param {Array<[number, number]>} points
   */
  async function restoreReleasedCells(points) {
    if (SHARED.releasedCells.size === 0) return;
    const wanted = new Set();
    for (const point of points) {
      const key = terrainPointKey(point);
      const cell = terrainKeyCell(key);
      if (SHARED.releasedCells.has(cell) && !SHARED.mem.has(key))
        wanted.add(cell);
    }
    if (wanted.size === 0) return;
    let stored;
    try {
      stored = await readDiskPoints();
    } catch {
      return;
    }
    for (const [key, entry] of Object.entries(stored)) {
      if (
        SHARED.mem.has(key) ||
        !wanted.has(terrainKeyCell(key)) ||
        !entry ||
        !Number.isFinite(entry.at) ||
        !validTerrainResult(entry.result)
      )
        continue;
      SHARED.mem.set(key, entry);
      SHARED.persisted.add(entry);
    }
    for (const cell of wanted) SHARED.releasedCells.delete(cell);
  }

  /** This proxy's handle for pruneTerrainMemoryOutside. */
  const memoryTier = {
    prune({ latitude, longitude }, radiusKm) {
      let removed = 0;
      for (const [key, entry] of SHARED.mem) {
        if (!SHARED.persisted.has(entry)) continue;
        const [lon, lat] = key.split(',').map(Number);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (haversineKm(latitude, longitude, lat, lon) <= radiusKm) continue;
        SHARED.mem.delete(key);
        SHARED.releasedCells.add(terrainKeyCell(key));
        removed += 1;
      }
      if (removed > 0) SHARED.releasedAny = true;
      return removed;
    },
  };

  /**
   * Fetch all missing chunks sequentially, UPSTREAM_CHUNK points per call.
   *
   * The first try keeps its empirically required 30s timeout; network errors,
   * 429, and 5xx receive up to three jittered retries sharing a 10s added-time
   * budget, with Retry-After honored within that bound.
   *
   * A chunk that still fails yields nulls for its own positions rather than
   * rejecting: with several chunks per request, throwing would discard every
   * chunk that did resolve and re-fetch it on the next poll. The resolver
   * caches the resolved positions and reports the null ones as omitted. Total
   * failure (nothing resolved) still rejects, so the real upstream error
   * reaches the caller instead of a generic omission count.
   * @param {Array<[number, number]>} points
   * @returns {Promise<Array<object>>}
   */
  async function fetchUpstreamAll(points) {
    const results = [];
    let firstError = null;
    for (let i = 0; i < points.length; i += UPSTREAM_CHUNK) {
      const chunk = points.slice(i, i + UPSTREAM_CHUNK);
      let chunkResults = [];
      try {
        chunkResults = await fetchTerrainChunkWithRetry(chunk);
      } catch (error) {
        firstError = firstError || error;
      }
      // Keep later chunks aligned even if a malformed upstream response omits
      // trailing positions. The resolver will reject each null individually.
      for (let j = 0; j < chunk.length; j += 1)
        results.push(chunkResults[j] ?? null);
    }
    if (firstError && results.every((result) => result == null))
      throw firstError;
    return results;
  }

  /** Coalesce concurrent requests for the same canonical missing-point list. */
  function fetchMissingSingleFlight(points) {
    const key = points.map(terrainPointKey).join(';');
    if (!SHARED.inflight.has(key)) {
      const request = fetchUpstreamAll(points).finally(() => {
        if (SHARED.inflight.get(key) === request) SHARED.inflight.delete(key);
      });
      SHARED.inflight.set(key, request);
    }
    return SHARED.inflight.get(key);
  }

  const installMiddleware = (server) => {
    // One handle per cache: this proxy takes over from the one a restart
    // replaced, so a location switch releases the shared points once.
    SHARED.tiers.clear();
    SHARED.tiers.add(memoryTier);
    server.middlewares.use('/api/terrain/heights', async (req, res) => {
      // Refuse cross-site browser requests (an <img> or fetch from another
      // site) before the limiter, cache or upstream see them. Same-origin app
      // requests, non-browser loopback callers (MCP panel_request) and the app
      // served behind a reverse proxy pass.
      if (admitSameSiteKeyless(req, res)) return;
      const send = (status, bodyObj) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bodyObj));
      };
      try {
        if (!allow(clientKey(req))) {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '10',
          });
          res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
          return;
        }
        const parsedUrl = new URL(req.url || '', 'http://internal');
        const rawPoints = parsedUrl.searchParams.get('points');
        const points = parseTerrainPoints(rawPoints);
        if (!points) {
          send(400, {
            error:
              'invalid points parameter — expected "lon,lat;lon,lat;…" with finite numbers',
          });
          return;
        }
        if (points.length > MAX_POINTS) {
          send(413, {
            error: `too many points (${points.length}); max ${MAX_POINTS} per request`,
          });
          return;
        }

        await loadDiskOnce();
        await restoreReleasedCells(points);
        const outcome = await resolveTerrainHeightRequest({
          points,
          cache: SHARED.mem,
          fetchMissing: fetchMissingSingleFlight,
          ttlMs: TTL_MS,
        });
        if (outcome.cacheChanged) {
          evictOverflow();
          SHARED.diskDirty = true;
        }
        if (outcome.upstreamError) {
          console.warn(
            '[terrain-heights-proxy] refresh incomplete' +
              ' — serving stale points when available',
          );
        } else if (outcome.absentPoints > 0) {
          // Not a refresh failure. The upstream answered every position and
          // returned a null height for a few of them (~0.16%, transient);
          // the next poll re-asks and the client meanwhile resolves those
          // through its bundled geoid. Informational, not actionable.
          console.info(
            `[terrain-heights-proxy] ${outcome.absentPoints}` +
              ` of ${outcome.requestedPoints} position(s) had no upstream` +
              ' height this poll — retrying next cycle',
          );
        }
        send(outcome.status, outcome.body);
      } catch (err) {
        console.error('[terrain-heights-proxy] request failed');
        send(500, { error: 'terrain heights proxy error' });
      }
    });
  };
  return {
    name: 'terrain-heights-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
