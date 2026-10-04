import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';

/** Default live-entry ceiling for the in-memory cache (see CACHE_MAX_ENTRIES). */
export const DEFAULT_MAX_CACHE_ENTRIES = 20_000;

/**
 * Construct an instance-owned terrainHeights service with explicit dependencies.
 * `maxCacheEntries` overrides the cache bound; it exists so the bound is
 * testable without minting twenty thousand coordinates, mirroring the injectable
 * `maxBytes` on the GBFS reader.
 */
export function createTerrainHeights({
  source,
  signal,
  maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
}) {
  if (typeof source?.getHeights !== 'function')
    throw new TypeError('Terrain heights require a source');
  signal?.throwIfAborted();
  // src/data/terrainHeights.js — batched, cached client terrain-height resolver
  // (docs/plans/2026-07-05-entity-height-datum-fix.md Task 3).
  //
  // Resolves ELLIPSOIDAL ground height per (lat, lon) via the server-side
  // `/api/terrain/heights` proxy (Task 2 — Re:Earth `heights.json`, disk-cached,
  // serve-stale). When the proxy is unreachable (or errors) AND the point isn't
  // already warm in this module's in-memory cache, falls back to bundled-geoid
  // math (Task 1, `src/data/geoid.js`):
  //
  //   sourceOrthometricM (if finite) + geoidHeight(lat, lon)  → source:'geoid-fallback'
  //   else geoidHeight(lat, lon) alone (H≈0 "at the geoid/coast" prior) → source:'geoid-fallback'
  //
  // Two things learned building the Task 2 proxy (see its report, and the
  // ledger's T2 entry) that this module builds in:
  //
  //   1. The proxy's GET has a Node http header-size ceiling — empirically a
  //      single request much past ~700-1500 points (depending on coordinate
  //      precision) risks a raw socket-level 431 *before* the proxy's own
  //      request handler runs. So every network request this module issues is
  //      chunked at CHUNK_SIZE (64 points), well under that ceiling, and
  //      chunks are sent SEQUENTIALLY (not in parallel) to keep this client
  //      well-behaved against a single dev-server proxy.
  //   2. The proxy's disk cache is keyed by the raw `points` query string, with
  //      no eviction — so a client that varies coordinate precision or point
  //      order defeats the warm cache and grows the cache file unbounded. This
  //      module rounds every coordinate to 5 decimal places (~1.1 m of
  //      precision at the equator — comfortably tighter than any of this app's
  //      placement needs) BOTH for its own in-memory cache key AND for the
  //      points string sent to the proxy, so repeated calls (including calls
  //      from a fresh page load, a different camera batch, etc.) consistently
  //      hit the same warm proxy cache entry.

  /** Max points per outgoing request to `/api/terrain/heights` (see file header, point 1). */
  // Match the server's upstream batch so sequential upstream work also fits
  // within this client's 30-second request deadline when Re:Earth slows.
  const CHUNK_SIZE = 64;

  /** Avoid repeatedly hitting a known-failing proxy from warm fallback reads. */
  const GEOID_FALLBACK_COOLDOWN_MS = 60_000;

  /**
   * Live entry ceiling for the cache below. The rounding in point 2 of the file
   * header makes repeated visits to one place share a key; it does nothing to
   * bound the number of DISTINCT places a session visits, and this cache had no
   * eviction, so a long session kept every coordinate it ever resolved for the
   * lifetime of the page.
   *
   * This is a bound, not a budget. At the ~111 m floor grid a city-scale
   * session stays well under it, so eviction is the pathological case rather
   * than the normal one and a well-behaved session sees no extra network. Sized
   * above the sibling caches (adsb.lol points 80, track history 200, TomTom
   * tiles 256) because a miss here costs a proxy round trip, not just RAM.
   */
  const CACHE_MAX_ENTRIES =
    Number.isFinite(maxCacheEntries) && maxCacheEntries > 0
      ? Math.floor(maxCacheEntries)
      : DEFAULT_MAX_CACHE_ENTRIES;

  /**
   * In-memory cache: `"lat.toFixed(5),lon.toFixed(5)"` -> `{ellipsoid, source}`.
   * Module-scoped (not exported) — the only reads are through
   * `cachedEllipsoidalGround` and the internal lookup in
   * `resolveEllipsoidalGround`. Bounded at CACHE_MAX_ENTRIES; write through
   * `cacheStore` and read a consumer-facing hit through `cacheTouch` so the
   * eviction order stays least-recently-used. A location switch also prunes
   * it by distance (`pruneTerrainHeightsOutside`).
   * @type {Map<string, {ellipsoid: number, source: 'reearth'|'geoid-fallback', retryAt?: number}>}
   */
  const cache = new Map();

  const EARTH_RADIUS_KM = 6371;

  /**
   * Location-switch generation. Bumped by `pruneTerrainHeightsOutside` each time
   * the user selects a place in another region, so work queued for the OLD area
   * (the remaining chunks of a resolve already running, fireAnchors' sequential
   * chain) is skipped instead of running ahead of the destination's cells. Each
   * upstream chunk can take 5-12 s, so without this a switch waited out the old
   * city's whole queue before the new city's floors began to land.
   */
  let switchGeneration = 0;
  /** @type {{lat: number, lon: number, radiusKm: number}|null} Area the latest switch kept. */
  let switchKeep = null;

  /** Great-circle distance in km. */
  function haversineKm(lat1, lon1, lat2, lon2) {
    const d2r = Math.PI / 180;
    const dLat = (lat2 - lat1) * d2r;
    const dLon = (lon2 - lon1) * d2r;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** @returns {number} The current location-switch generation. */
  function terrainHeightsSwitchGeneration() {
    return switchGeneration;
  }

  /**
   * Whether a point queued at switch `generation` is still worth resolving.
   * True when no switch has landed since it was queued, or when it lies inside
   * the area the latest switch kept (a hop across a nearby border still wants
   * the cells it shares with the old view).
   * @param {number} lat
   * @param {number} lon
   * @param {number} generation - `terrainHeightsSwitchGeneration()` at queue time.
   * @returns {boolean}
   */
  function terrainPointSurvivesSwitch(lat, lon, generation) {
    if (generation === switchGeneration) return true;
    if (!switchKeep || !Number.isFinite(lat) || !Number.isFinite(lon))
      return false;
    return (
      haversineKm(switchKeep.lat, switchKeep.lon, lat, lon) <=
      switchKeep.radiusKm
    );
  }

  /**
   * Location switch: releases resolved heights for places far from the
   * destination and starts a new switch generation (see `switchGeneration`).
   * Entries within `radiusKm` of `center` stay warm. Memory only — the server's
   * disk cache is untouched, so a return trip is a proxy cache hit, not an
   * upstream refetch. Idempotent; an invalid centre or radius changes nothing.
   * @param {{lat: number, lon: number}} center - The place being switched to.
   * @param {number} radiusKm - Keep radius.
   * @returns {number} Cache entries removed.
   */
  function pruneTerrainHeightsOutside(center, radiusKm) {
    const lat = center?.lat;
    const lon = center?.lon;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(radiusKm) ||
      radiusKm < 0
    )
      return 0;
    switchGeneration += 1;
    switchKeep = { lat, lon, radiusKm };
    let removed = 0;
    for (const key of [...cache.keys()]) {
      const comma = key.indexOf(',');
      const keyLat = Number(key.slice(0, comma));
      const keyLon = Number(key.slice(comma + 1));
      if (haversineKm(lat, lon, keyLat, keyLon) <= radiusKm) continue;
      cache.delete(key);
      removed += 1;
    }
    return removed;
  }

  /**
   * Store an entry and drop the coldest ones once past the cap. `Map` iterates
   * in insertion order, so deleting the first key evicts the least recently
   * used provided every write and every consumer read re-inserts its key.
   *
   * Recency rather than plain insertion order because revisits here are
   * spatial: a session comes back to cells near where it already was, so the
   * cell it is parked on must not be evicted merely for having been resolved
   * early.
   * @param {string} key
   * @param {{ellipsoid: number, source: 'reearth'|'geoid-fallback', retryAt?: number}} entry
   */
  function cacheStore(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_MAX_ENTRIES) {
      const coldest = cache.keys().next().value;
      if (coldest === undefined) break;
      cache.delete(coldest);
    }
  }

  /**
   * Read an entry and promote it to newest, so a coordinate a consumer keeps
   * asking about survives eviction. Returns undefined on a miss.
   * @param {string} key
   * @returns {{ellipsoid: number, source: 'reearth'|'geoid-fallback', retryAt?: number}|undefined}
   */
  function cacheTouch(key) {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  /**
   * Builds the rounded cache key shared between the in-memory cache and the
   * `points` string sent to the proxy (see file header, point 2).
   * @param {number} lat
   * @param {number} lon
   * @returns {string}
   */
  function cacheKey(lat, lon) {
    return `${lat.toFixed(5)},${lon.toFixed(5)}`;
  }

  /**
   * Synchronous read of a previously resolved ellipsoidal ground height.
   * Returns null if this exact (rounded) coordinate hasn't been resolved yet
   * by either the proxy path or the geoid-fallback path.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null}
   */
  function cachedEllipsoidalGround(lat, lon) {
    const entry = cacheTouch(cacheKey(lat, lon));
    return entry ? entry.ellipsoid : null;
  }

  /**
   * Field-test round 5 (2026-07-06, the "sea-level poison"): like
   * cachedEllipsoidalGround but returns null for geoid-FALLBACK entries —
   * only a real Re:Earth value counts. A fallback (cached when the proxy
   * failed mid-burst) is the geoid surface, which at Austin sits ~165 m below
   * the airport: floors built on it sank every sprite/trail, and the mesh
   * sampler's sanity gate rejected REAL surface samples against it. Floor
   * consumers read THIS; the plain read stays for display-only consumers.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null}
   */
  function cachedRealEllipsoidalGround(lat, lon) {
    const entry = cacheTouch(cacheKey(lat, lon));
    return entry && entry.source === 'reearth' ? entry.ellipsoid : null;
  }

  /**
   * Fetches one chunk (<=CHUNK_SIZE points) from the `/api/terrain/heights`
   * proxy. Returns a Map keyed by the same rounded cache key so callers can
   * look results up positionally-independent of upstream response ordering.
   * Throws on any failure (non-ok response, network error, malformed body) —
   * callers decide the fallback behavior per point.
   * @param {Array<{key: string, lat: number, lon: number}>} chunk
   * @returns {Promise<Map<string, number>>} key -> ellipsoid height (m)
   */
  async function fetchChunk(chunk, requestSignal = signal) {
    // lon,lat order (matches the proxy's documented `points=lon,lat;…` contract
    // and Task 2's implementation).
    const results = await source.getHeights(chunk, {
      signal: requestSignal
        ? AbortSignal.any([requestSignal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
    const body = { results };
    if (!Array.isArray(body?.results))
      throw new Error('malformed terrain heights response (no results array)');
    if (body.results.length !== chunk.length) {
      throw new Error(
        `terrain heights response length mismatch (expected ${chunk.length}, got ${body.results.length})`,
      );
    }
    const out = new Map();
    // The proxy is documented to preserve input order (Task 2 report verifies
    // this against the live upstream), so map positionally rather than trust
    // the response's own lon/lat fields to re-match — those are also present
    // for callers who want them, but this module doesn't need them.
    for (let i = 0; i < chunk.length; i += 1) {
      const ellipsoid = body.results[i]?.ellipsoid;
      if (!Number.isFinite(ellipsoid))
        throw new Error(`non-finite ellipsoid height at index ${i}`);
      out.set(chunk[i].key, ellipsoid);
    }
    return out;
  }

  /**
   * Computes the geoid-fallback ellipsoidal height for one point per the
   * brief's fallback chain: `sourceOrthometricM + geoidHeight` when a finite
   * orthometric source height is available, else `geoidHeight` alone (treats
   * the point as if it were at the geoid, i.e. H≈0 — a coast-level prior).
   * Assumes `ensureGeoidReady()` has already resolved.
   * @param {number} lat
   * @param {number} lon
   * @param {number} [sourceOrthometricM]
   * @returns {number}
   */
  function geoidFallback(lat, lon, sourceOrthometricM) {
    const n = geoidHeight(lat, lon);
    return Number.isFinite(sourceOrthometricM) ? sourceOrthometricM + n : n;
  }

  /**
   * Resolves ellipsoidal ground height for a batch of coordinates, in order.
   *
   * - Results already warm in the in-memory cache are returned without any
   *   network call.
   * - Remaining (deduplicated) coordinates are sent to `/api/terrain/heights`
   *   in sequential chunks of <=64 points.
   * - If a chunk request fails (network error, non-ok HTTP, malformed body),
   *   every point in THAT chunk falls back to geoid math
   *   (`sourceOrthometricM + geoidHeight` or `geoidHeight` alone) rather than
   *   failing the whole batch — a transient proxy outage in the middle of a
   *   large batch shouldn't blank out entities whose chunk happened to land
   *   earlier or later.
   * - Every resolved value (proxy or fallback) is written back into the
   *   in-memory cache before this function returns, so a later call — even
   *   with a real proxy round-trip pending — sees a warm hit.
   *
   * @param {Array<{lat:number, lon:number, sourceOrthometricM?:number}>} coords
   * @returns {Promise<Array<{ellipsoid:number, source:'reearth'|'geoid-fallback'}>>}
   *   Same length and order as `coords`.
   */
  async function resolveEllipsoidalGround(
    coords,
    { signal: consumerSignal } = {},
  ) {
    const requestSignal =
      signal && consumerSignal
        ? AbortSignal.any([signal, consumerSignal])
        : consumerSignal || signal;
    requestSignal?.throwIfAborted();
    if (!Array.isArray(coords) || coords.length === 0) return [];

    // Build the per-input work list (key + original index) up front so the
    // final assembly can map back positionally regardless of how many inputs
    // shared a cache key or a chunk.
    const work = coords.map((c, index) => ({
      index,
      lat: c.lat,
      lon: c.lon,
      sourceOrthometricM: c.sourceOrthometricM,
      key: cacheKey(c.lat, c.lon),
    }));

    // Points not yet warm in the cache, deduplicated by key (multiple inputs —
    // even within the same call — naming the same rounded coordinate should
    // only ever hit the network once). Round 5: a geoid-FALLBACK entry does
    // NOT count as permanently warm — it was cached when the proxy failed
    // mid-burst and (at elevated terrain) is a sea-level poison that sank every
    // floor built on it. Give failed keys a short cooldown before re-requesting
    // so warm consumers do not hammer a failing proxy; after it expires, a
    // successful response replaces the fallback entry and clears the path.
    const uncached = [];
    const seenKeys = new Set();
    const now = Date.now();
    for (const item of work) {
      const entry = cache.get(item.key);
      const fallbackCooling =
        entry?.source === 'geoid-fallback' &&
        Number.isFinite(entry.retryAt) &&
        now < entry.retryAt;
      if (
        (entry && entry.source === 'reearth') ||
        fallbackCooling ||
        seenKeys.has(item.key)
      )
        continue;
      seenKeys.add(item.key);
      uncached.push(item);
    }

    // What this call resolved, so the assembly below can report a point even
    // if a later chunk's writes pushed it past CACHE_MAX_ENTRIES. Without it a
    // batch big enough to evict its own earlier chunks would report points as
    // unresolved that it had in fact just resolved.
    const resolvedThisCall = new Map();

    // Resolve the network path in sequential <=CHUNK_SIZE chunks. Each chunk's
    // failure is isolated to that chunk's points (geoid fallback), so a single
    // bad chunk doesn't lose results for the rest of a large batch.
    //
    // A location switch landing between chunks drops the queued points outside
    // the destination's keep area; they stay uncached and report 'unresolved',
    // so a consumer that still holds them re-queues them on its next poll. The
    // chunk already on the wire finishes, but writes back only its points that
    // survive the switch — the rest were released while it was in flight.
    let queue = uncached;
    let next = 0;
    let generation = switchGeneration;
    while (next < queue.length) {
      if (generation !== switchGeneration) {
        const stale = generation;
        generation = switchGeneration;
        queue = queue
          .slice(next)
          .filter((item) =>
            terrainPointSurvivesSwitch(item.lat, item.lon, stale),
          );
        next = 0;
        if (!queue.length) break;
      }
      const chunk = queue.slice(next, next + CHUNK_SIZE);
      next += CHUNK_SIZE;
      try {
        const resolved = await fetchChunk(chunk, requestSignal);
        requestSignal?.throwIfAborted();
        for (const item of chunk) {
          // A switch that landed while this chunk was on the wire already
          // released the old area; do not write it back.
          if (!terrainPointSurvivesSwitch(item.lat, item.lon, generation))
            continue;
          const ellipsoid = resolved.get(item.key);
          // Round 6: only a FINITE value may be cached as 'reearth'. A point
          // the upstream response omitted used to cache {ellipsoid: undefined,
          // source: 'reearth'} — permanently "warm" yet empty, so its floor
          // read null forever and every later warm skipped it (ATL verify:
          // one contact frozen at the geoid while its neighbors resolved).
          // An omitted point now caches nothing and retries on the next warm.
          if (Number.isFinite(ellipsoid)) {
            const entry = { ellipsoid, source: 'reearth' };
            resolvedThisCall.set(item.key, entry);
            cacheStore(item.key, entry);
          }
        }
      } catch {
        requestSignal?.throwIfAborted();
        // Proxy down (or cold cache had nothing to serve-stale) — fall back to
        // geoid math for every point in this chunk. `ensureGeoidReady()` is
        // awaited lazily, only on the fallback path, so the common (proxy
        // healthy) case never pays for the geoid grid's dynamic import.
        await ensureGeoidReady();
        requestSignal?.throwIfAborted();
        for (const item of chunk) {
          if (!terrainPointSurvivesSwitch(item.lat, item.lon, generation))
            continue;
          const ellipsoid = geoidFallback(
            item.lat,
            item.lon,
            item.sourceOrthometricM,
          );
          const entry = {
            ellipsoid,
            source: 'geoid-fallback',
            retryAt: Date.now() + GEOID_FALLBACK_COOLDOWN_MS,
          };
          resolvedThisCall.set(item.key, entry);
          cacheStore(item.key, entry);
        }
      }
    }

    // Assemble the output in the original input order from the cache. A point
    // the upstream omitted has NO entry (round 6 — deliberately uncached so it
    // retries later): report it unresolved instead of throwing.
    return work.map((item) => {
      const entry = cache.get(item.key) || resolvedThisCall.get(item.key);
      return entry
        ? { ellipsoid: entry.ellipsoid, source: entry.source }
        : { ellipsoid: null, source: 'unresolved' };
    });
  }

  signal?.addEventListener('abort', () => cache.clear(), { once: true });
  return {
    cachedEllipsoidalGround,
    cachedRealEllipsoidalGround,
    resolveEllipsoidalGround,
    terrainHeightsSwitchGeneration,
    terrainPointSurvivesSwitch,
    pruneTerrainHeightsOutside,
  };
}
