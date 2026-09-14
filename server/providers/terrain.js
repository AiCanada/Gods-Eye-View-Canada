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

/**
 * Release handles of every installed terrain proxy, registered on install so a
 * location switch can release far points without reaching into the closure.
 * @type {Set<{prune: (point: {latitude:number, longitude:number}, radiusKm:number) => number}>}
 */
const _terrainMemoryTiers = new Set();

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
  tiers = _terrainMemoryTiers,
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
 * request order. Larger requests are chunked sequentially, and one failing
 * chunk does not discard the chunks that resolved.
 */
export function terrainHeightsProxy() {
  const TTL_MS = 30 * 24 * 3600_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'terrain-heights.json');
  // Sized against measured upstream latency, not the documented page cap.
  // Re:Earth serves 87-186 ms/point depending on load (observed 2026-09-12,
  // a 2x swing within one hour). 256 points therefore costs 22-48 s and blows
  // the 30 s attempt timeout whenever the service is slow — the long-standing
  // cause of "[terrain-heights-proxy] refresh incomplete" (owner incident
  // 2026-08-21). 64 points costs 5.6-12 s, inside the timeout at both ends of
  // that range.
  const UPSTREAM_CHUNK = 64;
  const MAX_POINTS = 2000;

  /** @type {Map<string, {at:number, result:object}>} keyed by canonical 5dp lon/lat. */
  const mem = new Map();
  /** @type {Map<string, Promise<Array<object>>>} single-flight per missing-point subset. */
  const inflight = new Map();
  let diskLoaded = false;
  let diskDirty = false;
  /**
   * Entry objects known to be on disk exactly as they are in memory. Only
   * these may be released: anything newer would be lost before the next flush.
   * @type {WeakSet<object>}
   */
  const persisted = new WeakSet();
  /** @type {Set<string>} 1-degree cells with points released from memory but still on disk. */
  const releasedCells = new Set();
  /** Once anything is released, flushes merge into the disk file instead of replacing it. */
  let releasedAny = false;

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
    if (diskLoaded) return;
    diskLoaded = true;
    try {
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
            mem.set(key, entry);
            persisted.add(entry);
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
            const existing = mem.get(key);
            if (!existing || entry.at > existing.at)
              mem.set(key, { at: entry.at, result });
          }
        }
        diskDirty = mem.size > 0;
      }
    } catch {
      /* no disk cache yet */
    }
    // Periodic flush, same shape as adsbdbProxy: coalesce writes instead of
    // hitting disk on every request.
    setInterval(async () => {
      if (!diskDirty) return;
      diskDirty = false;
      // Written beside the live file and renamed over it, so a restore reading
      // during the write, or a crash mid-write, never sees a truncated file.
      // Same directory, so the rename is atomic on POSIX.
      const temp = `${CACHE_PATH}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        // After a release the file holds points memory no longer does. Merge
        // them back so a flush never shrinks the disk cache; an unreadable file
        // skips this write rather than replacing it with memory alone.
        const points = releasedAny ? await readDiskPoints() : {};
        await fsp.mkdir(CACHE_DIR, { recursive: true });
        const written = [...mem.values()];
        Object.assign(points, Object.fromEntries(mem.entries()));
        await fsp.writeFile(
          temp,
          JSON.stringify({ version: 2, points }),
          'utf8',
        );
        await fsp.rename(temp, CACHE_PATH);
        for (const entry of written) persisted.add(entry);
      } catch (err) {
        diskDirty = true; // retry next tick
        await fsp.rm(temp, { force: true }).catch(() => {});
        console.warn('[terrain-heights-proxy] cache write failed');
      }
    }, 15_000).unref?.();
  }

  /**
   * Read released points back from disk for the cells a request needs, so a
   * return to an earlier area costs one file read instead of upstream calls.
   * A failed read leaves the cells released and the next request retries.
   * @param {Array<[number, number]>} points
   */
  async function restoreReleasedCells(points) {
    if (releasedCells.size === 0) return;
    const wanted = new Set();
    for (const point of points) {
      const key = terrainPointKey(point);
      const cell = terrainKeyCell(key);
      if (releasedCells.has(cell) && !mem.has(key)) wanted.add(cell);
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
        mem.has(key) ||
        !wanted.has(terrainKeyCell(key)) ||
        !entry ||
        !Number.isFinite(entry.at) ||
        !validTerrainResult(entry.result)
      )
        continue;
      mem.set(key, entry);
      persisted.add(entry);
    }
    for (const cell of wanted) releasedCells.delete(cell);
  }

  /** This proxy's handle for pruneTerrainMemoryOutside. */
  const memoryTier = {
    prune({ latitude, longitude }, radiusKm) {
      let removed = 0;
      for (const [key, entry] of mem) {
        if (!persisted.has(entry)) continue;
        const [lon, lat] = key.split(',').map(Number);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (haversineKm(latitude, longitude, lat, lon) <= radiusKm) continue;
        mem.delete(key);
        releasedCells.add(terrainKeyCell(key));
        removed += 1;
      }
      if (removed > 0) releasedAny = true;
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
    if (!inflight.has(key)) {
      const request = fetchUpstreamAll(points).finally(() => {
        if (inflight.get(key) === request) inflight.delete(key);
      });
      inflight.set(key, request);
    }
    return inflight.get(key);
  }

  const installMiddleware = (server) => {
    _terrainMemoryTiers.add(memoryTier);
    server.middlewares.use('/api/terrain/heights', async (req, res) => {
      const send = (status, bodyObj) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bodyObj));
      };
      try {
        await loadDiskOnce();
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
          send(500, {
            error: `too many points (${points.length}); max ${MAX_POINTS} per request`,
          });
          return;
        }

        await restoreReleasedCells(points);
        const outcome = await resolveTerrainHeightRequest({
          points,
          cache: mem,
          fetchMissing: fetchMissingSingleFlight,
          ttlMs: TTL_MS,
        });
        if (outcome.cacheChanged) diskDirty = true;
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
