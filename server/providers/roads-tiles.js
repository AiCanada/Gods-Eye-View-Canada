import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { isValidTileCoord, tileToBBox } from '../../src/data/tomtomTiles.js';
import { haversineKm } from './common/geo.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';

// ---------------------------------------------------------------------------
// Road geometry vector tiles (OpenFreeMap) for the Street Traffic layer
// ---------------------------------------------------------------------------

/** OpenFreeMap planet TileJSON; its `tiles` template names the current build. */
const OPENFREEMAP_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

/** Versioned tile URL root. Built here, never taken from the TileJSON host. */
const OPENFREEMAP_TILE_ROOT = 'https://tiles.openfreemap.org/planet';

/** Highest zoom OpenFreeMap serves (TileJSON maxzoom, verified 2026-09-14). */
const ROADS_TILES_MAX_ZOOM = 14;

/** Disk cache root: tilejson.json plus <version>/<z>/<x>/<y>.pbf. */
const ROADS_TILES_CACHE_DIR = path.join(
  process.cwd(),
  '.gev-cache',
  'roads-tiles',
);

/** Honest identifying User-Agent (OpenFreeMap asks nothing else of callers). */
const ROADS_TILES_USER_AGENT =
  'gods-eye-view-roads-tiles/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

/** A known planet version is re-checked at most this often. */
const ROADS_TILEJSON_REFRESH_MS = 24 * 60 * 60_000;

/** After a failed TileJSON refresh, the next attempt waits this long. */
const ROADS_TILEJSON_RETRY_MS = 10 * 60_000;

/** Upstream timeout for one tile or the TileJSON (ms). */
const ROADS_TILES_TIMEOUT_MS = 15_000;

/** Concurrent upstream tile fetches; more wait in a bounded queue. */
const ROADS_TILES_MAX_CONCURRENT = 6;

/** Requests allowed to wait for an upstream slot before answering busy. */
const ROADS_TILES_MAX_QUEUE = 128;

/** Byte ceiling for one upstream tile (a dense z14 city tile is ~350 KB). */
const ROADS_TILES_MAX_BYTES = 8 * 1024 * 1024;

/** Byte ceiling for the TileJSON document. */
const ROADS_TILEJSON_MAX_BYTES = 256 * 1024;

/**
 * Memory LRU bounds: tiles and total bytes. Disk keeps every tile of the
 * planet build in use and of the build before it; older builds are removed.
 */
const ROADS_TILES_MEM_MAX_ENTRIES = 96;
const ROADS_TILES_MEM_MAX_BYTES = 48 * 1024 * 1024;

/**
 * Upstream-wide failures in a row (network error, timeout, HTTP 5xx or 429)
 * that open the breaker. A failure about one tile never counts.
 */
const ROADS_BREAKER_FAILURE_THRESHOLD = 3;

/** First open-breaker window; doubles each time the half-open probe fails. */
const ROADS_UPSTREAM_BACKOFF_BASE_MS = 5_000;
const ROADS_UPSTREAM_BACKOFF_MAX_MS = 5 * 60_000;

/** A tile-specific failure answers 502 for that tile alone for this long. */
const ROADS_TILE_NEGATIVE_TTL_MS = 15_000;

/** Failing tiles remembered at once (oldest dropped first). */
const ROADS_TILE_NEGATIVE_MAX_ENTRIES = 1_024;

/** Error codes that describe one tile's answer, not the upstream as a whole. */
const ROADS_TILE_SPECIFIC_CODES = new Set([
  'RESPONSE_TOO_LARGE',
  'NOT_A_TILE',
  'BAD_TILE_BODY',
]);

/** A planet version is a path segment on disk, so only this shape is used. */
const ROADS_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * Memory tiers of every installed proxy, registered on install so a location
 * switch can release far tiles without reaching into the closure.
 * @type {Set<Map<string, Buffer>>}
 */
const _roadTileMemoryTiers = new Set();

/**
 * Validate a road tile coordinate (z 0–14, x and y inside the zoom's grid).
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function isValidRoadTileCoord(z, x, y) {
  return isValidTileCoord(z, x, y, {
    minZoom: 0,
    maxZoom: ROADS_TILES_MAX_ZOOM,
  });
}

/**
 * The planet build named by an OpenFreeMap TileJSON document, or null when the
 * document has no tile template of the expected shape.
 * @param {unknown} tilejson Parsed TileJSON.
 * @returns {?string} e.g. '20260906_080001_pt'.
 */
function parseOpenFreeMapVersion(tilejson) {
  const templates = Array.isArray(tilejson?.tiles) ? tilejson.tiles : [];
  for (const template of templates) {
    const match = String(template).match(
      /^https:\/\/tiles\.openfreemap\.org\/planet\/([^/]+)\/\{z\}\/\{x\}\/\{y\}\.pbf$/,
    );
    if (match && ROADS_VERSION_RE.test(match[1])) return match[1];
  }
  return null;
}

/**
 * Release memory-cached road tiles whose centre lies farther than `radiusKm`
 * from a point, after the user switches location. Memory only: every tile
 * stays in .gev-cache/roads-tiles and is read back from disk when asked for.
 * @param {{latitude: number, longitude: number}} point
 * @param {number} radiusKm
 * @param {Iterable<Map<string, Buffer>>} [tiers] Memory maps keyed
 *   `version/z/x/y`; defaults to every installed proxy.
 * @returns {number} How many tiles were removed.
 */
function pruneRoadTileMemoryOutside(
  point,
  radiusKm,
  tiers = _roadTileMemoryTiers,
) {
  const latitude = point?.latitude;
  const longitude = point?.longitude;
  if (![latitude, longitude, radiusKm].every(Number.isFinite) || radiusKm < 0)
    return 0;
  let removed = 0;
  for (const mem of tiers) {
    for (const key of [...mem.keys()]) {
      const [z, x, y] = String(key).split('/').slice(-3).map(Number);
      if (!isValidRoadTileCoord(z, x, y)) continue;
      const box = tileToBBox(z, x, y);
      const distanceKm = haversineKm(
        latitude,
        longitude,
        (box.south + box.north) / 2,
        (box.west + box.east) / 2,
      );
      if (distanceKm <= radiusKm) continue;
      mem.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Read a fetch Response body as bytes with a hard cap.
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readResponseBytesCapped(response, maxBytes) {
  const tooLarge = () =>
    Object.assign(new Error('Upstream response too large'), {
      code: 'RESPONSE_TOO_LARGE',
    });
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel?.().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) throw tooLarge();
    return buf;
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Tile bytes as the browser decodes them. Node's fetch already undoes a
 * `Content-Encoding: gzip` transfer, but a body that is itself gzip (magic
 * 1f 8b) would reach the client undecodable, so it is inflated here and the
 * proxy always stores and serves plain MVT bytes with no Content-Encoding.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function plainTileBytes(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return gunzipSync(buf, { maxOutputLength: 4 * ROADS_TILES_MAX_BYTES });
    } catch (err) {
      throw Object.assign(new Error('tile body is not valid gzip'), {
        code: 'BAD_TILE_BODY',
        cause: err,
      });
    }
  }
  return buf;
}

/**
 * What a failed upstream tile fetch says about the upstream.
 * - 'upstream': the upstream as a whole is in trouble (network error,
 *   timeout, HTTP 5xx or 429). Only these count toward the breaker.
 * - 'tile': only this tile's answer was unusable (another HTTP status, too
 *   large, not a tile, bad gzip). The upstream answered.
 * - 'local': this proxy's own queue was full.
 * @param {unknown} err
 * @returns {'upstream'|'tile'|'local'}
 */
function roadTileFailureScope(err) {
  if (err?.code === 'BUSY') return 'local';
  const status = err?.status;
  if (Number.isInteger(status)) {
    return status >= 500 || status === 429 ? 'upstream' : 'tile';
  }
  return ROADS_TILE_SPECIFIC_CODES.has(err?.code) ? 'tile' : 'upstream';
}

/** Retry-After seconds (at least 1) for a wait in milliseconds. */
const retryAfterSeconds = (ms) => String(Math.max(1, Math.ceil(ms / 1000)));

/**
 * Write a file beside its destination and rename it over, so a concurrent read
 * or a crash mid-write never sees a truncated file.
 */
async function writeFileAtomic(file, data) {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(temp, data);
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Vite plugin: road-geometry vector tiles for the Street Traffic layer.
 *
 * GET /api/roads/tiles/{z}/{x}/{y}.pbf answers the OpenFreeMap planet tile
 * (OpenMapTiles schema; the client reads its `transportation` layer) as
 * application/x-protobuf. OpenFreeMap is free, keyless and has no request
 * limits; it requires the attribution "OpenFreeMap © OpenMapTiles Data from
 * OpenStreetMap", which the traffic layer shows.
 *
 * - The planet version comes from the TileJSON once, is kept in memory and in
 *   .gev-cache/roads-tiles/tilejson.json, and is re-checked at most daily in
 *   the background. Offline with no TileJSON, the newest version already on
 *   disk is used.
 * - Versioned tiles are immutable: .gev-cache/roads-tiles/<version>/<z>/<x>/<y>.pbf
 *   never expires (atomic writes). A small memory LRU sits in front of it and
 *   is released beyond 300 km by a location switch. When a new build is in
 *   use, build directories other than it and the one before it (the offline
 *   fallback) are removed in the background, once at startup too.
 * - Upstream: one shared request per tile, ROADS_TILES_MAX_CONCURRENT at a
 *   time, a timeout and a byte cap.
 * - Breaker: ROADS_BREAKER_FAILURE_THRESHOLD upstream-wide failures in a row
 *   (network, timeout, 5xx, 429) open it, and uncached tiles answer 502 in
 *   milliseconds for a window that doubles per failed probe. After the window
 *   one probe request goes upstream while the rest still answer 502; its
 *   success closes the breaker. Requests already in flight when it opened
 *   cannot extend it.
 * - A failure about one tile (404 or another status, too large, not a tile,
 *   bad gzip) never touches the breaker: that tile alone answers 502 for
 *   ROADS_TILE_NEGATIVE_TTL_MS, then is asked again.
 *
 * GET /api/roads/status → {version, cachedTiles, upstreamFetches, errors}.
 *
 * @param {object} [options] Test seams.
 * @param {string} [options.cacheDir]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @returns {import('vite').Plugin}
 */
function roadsTilesProxy({
  cacheDir = ROADS_TILES_CACHE_DIR,
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
} = {}) {
  const TILEJSON_PATH = path.join(cacheDir, 'tilejson.json');

  /** @type {Map<string, Buffer>} `version/z/x/y` -> plain tile bytes (LRU). */
  const mem = new Map();
  /** @type {Map<string, Promise<Buffer>>} one upstream request per tile. */
  const inflight = new Map();

  /** @type {{version:string, fetchedAt:number}|null} */
  let planet = null;
  let planetLoaded = false;
  let planetRetryAt = 0;
  /** @type {Promise<?string>|null} */
  let planetRefresh = null;

  let active = 0;
  /** @type {Array<() => void>} */
  const queue = [];

  let upstreamFetches = 0;
  let errors = 0;
  /** Upstream-wide failures in a row while the breaker is closed. */
  let consecutiveFailures = 0;
  /** Times the breaker opened with no upstream answer between (0 = closed). */
  let trips = 0;
  /** While open, uncached tiles answer 502 until this time. */
  let blockedUntil = 0;
  /** A half-open probe is in flight: nothing else may go upstream. */
  let probing = false;
  /** @type {Map<string, number>} `version/z/x/y` -> 502 without upstream until. */
  const failedTiles = new Map();
  /** Old planet build cleanup, one pass at a time. */
  let prunePass = Promise.resolve();
  let prunedAtStartup = false;

  // Upstream-bound requests only; memory and disk hits never count.
  const allowUpstream = makeRateLimiter({
    windowMs: 60_000,
    max: 600,
    globalMax: 1200,
  });

  const tileFile = (version, z, x, y) =>
    path.join(cacheDir, version, String(z), String(x), `${y}.pbf`);

  function memGet(key) {
    const buf = mem.get(key);
    if (!buf) return null;
    mem.delete(key);
    mem.set(key, buf);
    return buf;
  }

  function memSet(key, buf) {
    mem.delete(key);
    mem.set(key, buf);
    // Summed on write rather than tracked: a location-switch prune deletes
    // from the map directly, and the entry cap keeps this loop tiny.
    let bytes = 0;
    for (const value of mem.values()) bytes += value.length;
    while (
      mem.size > ROADS_TILES_MEM_MAX_ENTRIES ||
      (bytes > ROADS_TILES_MEM_MAX_BYTES && mem.size > 1)
    ) {
      const oldest = mem.keys().next().value;
      bytes -= mem.get(oldest).length;
      mem.delete(oldest);
    }
  }

  /**
   * Whether an uncached tile may go upstream now; claims nothing. Closed: yes.
   * Open: no, until blockedUntil. Half-open (the window passed): one probe.
   * @returns {{allowed: true, probe: boolean}|{allowed: false, retryAfterMs: number}}
   */
  function breakerGate() {
    if (trips === 0) return { allowed: true, probe: false };
    const t = now();
    if (t < blockedUntil) {
      return { allowed: false, retryAfterMs: blockedUntil - t };
    }
    if (probing) return { allowed: false, retryAfterMs: 1_000 };
    return { allowed: true, probe: true };
  }

  /** The upstream answered (a tile, or a definite answer about one): close. */
  function noteUpstreamAnswered() {
    consecutiveFailures = 0;
    trips = 0;
    blockedUntil = 0;
  }

  /**
   * An upstream-wide failure. While closed it counts toward the threshold; a
   * failed probe reopens with a doubled window. A request that was already in
   * flight when the breaker opened changes nothing, so a burst of concurrent
   * timeouts opens it once instead of escalating once per tile.
   * @param {boolean} probe The failed request was the half-open probe.
   */
  function noteUpstreamFailure(probe) {
    if (trips > 0 && !probe) return;
    if (trips === 0) {
      consecutiveFailures += 1;
      if (consecutiveFailures < ROADS_BREAKER_FAILURE_THRESHOLD) return;
      consecutiveFailures = 0;
    }
    trips += 1;
    blockedUntil =
      now() +
      Math.min(
        ROADS_UPSTREAM_BACKOFF_MAX_MS,
        ROADS_UPSTREAM_BACKOFF_BASE_MS * 2 ** (trips - 1),
      );
  }

  /** When a tile's own failure still answers 502 until, or 0. */
  function failedTileUntil(key) {
    const until = failedTiles.get(key);
    if (until === undefined) return 0;
    if (now() < until) return until;
    failedTiles.delete(key);
    return 0;
  }

  function noteTileFailure(key) {
    failedTiles.delete(key);
    failedTiles.set(key, now() + ROADS_TILE_NEGATIVE_TTL_MS);
    while (failedTiles.size > ROADS_TILE_NEGATIVE_MAX_ENTRIES) {
      failedTiles.delete(failedTiles.keys().next().value);
    }
  }

  /**
   * Remove planet build directories other than `current` and the build before
   * it: `previous` when it is on disk, else the newest other build. The disk
   * then holds the tiles in use plus one offline fallback instead of a copy per
   * build. Only directory names shaped like a version are touched.
   * @param {string} current
   * @param {?string} [previous]
   * @returns {Promise<void>}
   */
  function pruneOldVersions(current, previous = null) {
    if (!ROADS_VERSION_RE.test(String(current || ''))) return prunePass;
    prunePass = prunePass.then(async () => {
      let entries;
      try {
        entries = await fsp.readdir(cacheDir, { withFileTypes: true });
      } catch {
        return;
      }
      const others = entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            ROADS_VERSION_RE.test(entry.name) &&
            entry.name !== current,
        )
        .map((entry) => entry.name)
        .sort();
      const fallback = others.includes(previous) ? previous : others.at(-1);
      for (const name of others) {
        if (name === fallback) continue;
        await fsp
          .rm(path.join(cacheDir, name), { recursive: true, force: true })
          .catch((err) =>
            console.warn(
              `[roads-tiles] old build cleanup failed for ${name}:`,
              err?.code || err?.message || err,
            ),
          );
      }
    });
    return prunePass;
  }

  async function withUpstreamSlot(task) {
    if (active >= ROADS_TILES_MAX_CONCURRENT) {
      if (queue.length >= ROADS_TILES_MAX_QUEUE) {
        throw Object.assign(new Error('road tile queue full'), {
          code: 'BUSY',
        });
      }
      await new Promise((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  }

  async function loadPlanetFromDisk() {
    if (planetLoaded) return;
    planetLoaded = true;
    try {
      const saved = JSON.parse(await fsp.readFile(TILEJSON_PATH, 'utf8'));
      if (
        ROADS_VERSION_RE.test(String(saved?.version || '')) &&
        Number.isFinite(saved?.fetchedAt)
      ) {
        planet = { version: saved.version, fetchedAt: saved.fetchedAt };
      }
    } catch {
      /* no saved TileJSON yet */
    }
  }

  /** Newest version directory already on disk (offline fallback). */
  async function newestDiskVersion() {
    try {
      const entries = await fsp.readdir(cacheDir, { withFileTypes: true });
      const versions = entries
        .filter(
          (entry) => entry.isDirectory() && ROADS_VERSION_RE.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort();
      return versions.at(-1) || null;
    } catch {
      return null;
    }
  }

  function refreshPlanet() {
    if (planetRefresh) return planetRefresh;
    planetRefresh = (async () => {
      try {
        const res = await fetchImpl(OPENFREEMAP_TILEJSON_URL, {
          headers: {
            'User-Agent': ROADS_TILES_USER_AGENT,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(ROADS_TILES_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`TileJSON HTTP ${res.status}`);
        const bytes = await readResponseBytesCapped(
          res,
          ROADS_TILEJSON_MAX_BYTES,
        );
        const version = parseOpenFreeMapVersion(
          JSON.parse(bytes.toString('utf8')),
        );
        if (!version) throw new Error('TileJSON has no planet tile template');
        const previous = planet?.version || null;
        planet = { version, fetchedAt: now() };
        planetRetryAt = 0;
        await writeFileAtomic(TILEJSON_PATH, JSON.stringify(planet)).catch(
          (err) =>
            console.warn(
              '[roads-tiles] TileJSON cache write failed:',
              err?.code || err?.message || err,
            ),
        );
        // A new build is never read from the old directories again.
        if (previous && previous !== version) {
          void pruneOldVersions(version, previous);
        }
        return version;
      } catch (err) {
        errors += 1;
        planetRetryAt = now() + ROADS_TILEJSON_RETRY_MS;
        console.warn(
          '[roads-tiles] TileJSON refresh failed:',
          err?.code || err?.message || err,
        );
        return null;
      } finally {
        planetRefresh = null;
      }
    })();
    return planetRefresh;
  }

  /**
   * The planet version to serve. A known version answers at once and is
   * re-checked in the background when due; only a first-ever lookup waits.
   * @returns {Promise<?string>}
   */
  async function resolveVersion() {
    const version = await resolveVersionNow();
    // Builds left over from earlier runs go once, when the first version is known.
    if (version && !prunedAtStartup) {
      prunedAtStartup = true;
      void pruneOldVersions(version);
    }
    return version;
  }

  async function resolveVersionNow() {
    await loadPlanetFromDisk();
    const t = now();
    if (planet) {
      if (
        t - planet.fetchedAt >= ROADS_TILEJSON_REFRESH_MS &&
        t >= planetRetryAt
      ) {
        void refreshPlanet();
      }
      return planet.version;
    }
    if (t >= planetRetryAt) {
      const version = await refreshPlanet();
      if (version) return version;
    }
    const offline = await newestDiskVersion();
    if (offline) planet = { version: offline, fetchedAt: 0 };
    return offline;
  }

  async function readDiskTile(version, z, x, y) {
    try {
      return await fsp.readFile(tileFile(version, z, x, y));
    } catch {
      return null;
    }
  }

  async function fetchUpstreamTile(version, z, x, y) {
    return withUpstreamSlot(async () => {
      upstreamFetches += 1;
      const res = await fetchImpl(
        `${OPENFREEMAP_TILE_ROOT}/${version}/${z}/${x}/${y}.pbf`,
        {
          headers: { 'User-Agent': ROADS_TILES_USER_AGENT },
          signal: AbortSignal.timeout(ROADS_TILES_TIMEOUT_MS),
        },
      );
      // 204 is an empty tile (open ocean); anything else but 200 is a failure.
      if (res.status === 204) return Buffer.alloc(0);
      if (res.status !== 200) {
        void res.body?.cancel?.().catch(() => {});
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      }
      const type = String(res.headers?.get?.('content-type') || '');
      if (/^text\/|html|json/i.test(type)) {
        void res.body?.cancel?.().catch(() => {});
        throw Object.assign(new Error(`unexpected content type ${type}`), {
          code: 'NOT_A_TILE',
        });
      }
      return plainTileBytes(
        await readResponseBytesCapped(res, ROADS_TILES_MAX_BYTES),
      );
    });
  }

  const installMiddleware = (server) => {
    _roadTileMemoryTiers.add(mem);
    server.middlewares.use('/api/roads', async (req, res) => {
      const sendJson = (status, obj, extraHeaders = {}) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...extraHeaders,
        });
        res.end(JSON.stringify(obj));
      };
      const sendTile = (buf, cacheStatus) => {
        if (res.headersSent) return;
        res.writeHead(200, {
          'Content-Type': 'application/x-protobuf',
          'Content-Length': String(buf.length),
          // The URL carries no version; a day lets a new build reach the
          // browser while repeat views stay off the network.
          'Cache-Control': 'public, max-age=86400',
          'X-Roads-Cache': cacheStatus,
        });
        res.end(buf);
      };

      try {
        const urlPath = String(req.url || '').split('?')[0];
        if (req.method !== 'GET') {
          sendJson(405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
          return;
        }

        if (urlPath === '/status') {
          await loadPlanetFromDisk();
          sendJson(200, {
            version: planet?.version || null,
            cachedTiles: mem.size,
            upstreamFetches,
            errors,
          });
          return;
        }

        const m = urlPath.match(
          /^\/tiles\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.pbf$/,
        );
        if (!m) {
          sendJson(404, { error: 'not_found' });
          return;
        }
        const z = Number(m[1]);
        const x = Number(m[2]);
        const y = Number(m[3]);
        if (!isValidRoadTileCoord(z, x, y)) {
          sendJson(400, { error: 'invalid_tile' });
          return;
        }

        const version = await resolveVersion();
        if (!version) {
          sendJson(502, { error: 'tilejson' }, { 'Retry-After': '60' });
          return;
        }
        const key = `${version}/${z}/${x}/${y}`;

        const cached = memGet(key);
        if (cached) {
          sendTile(cached, 'HIT');
          return;
        }
        const disk = await readDiskTile(version, z, x, y);
        if (disk) {
          memSet(key, disk);
          sendTile(disk, 'DISK');
          return;
        }

        let pending = inflight.get(key);
        if (!pending) {
          const failedUntil = failedTileUntil(key);
          if (failedUntil) {
            sendJson(
              502,
              { error: 'upstream' },
              { 'Retry-After': retryAfterSeconds(failedUntil - now()) },
            );
            return;
          }
          const gate = breakerGate();
          if (!gate.allowed) {
            sendJson(
              502,
              { error: 'upstream' },
              { 'Retry-After': retryAfterSeconds(gate.retryAfterMs) },
            );
            return;
          }
          if (!allowUpstream(clientKey(req))) {
            sendJson(429, { error: 'rate_limited' }, { 'Retry-After': '10' });
            return;
          }
          const { probe } = gate;
          if (probe) probing = true;
          pending = fetchUpstreamTile(version, z, x, y)
            .then(async (buf) => {
              noteUpstreamAnswered();
              memSet(key, buf);
              await writeFileAtomic(tileFile(version, z, x, y), buf).catch(
                (err) =>
                  console.warn(
                    `[roads-tiles] tile cache write failed for ${z}/${x}/${y}:`,
                    err?.code || err?.message || err,
                  ),
              );
              return buf;
            })
            .catch((err) => {
              const scope = roadTileFailureScope(err);
              if (scope !== 'local') errors += 1;
              if (scope === 'upstream') noteUpstreamFailure(probe);
              if (scope === 'tile') {
                noteUpstreamAnswered();
                noteTileFailure(key);
              }
              console.warn(
                `[roads-tiles] ${z}/${x}/${y} fetch failed:`,
                err?.code || err?.message || err,
              );
              throw err;
            })
            .finally(() => {
              inflight.delete(key);
              if (probe) probing = false;
            });
          inflight.set(key, pending);
        }
        let buf;
        try {
          buf = await pending;
        } catch (err) {
          if (err?.code === 'BUSY') {
            sendJson(503, { error: 'busy' }, { 'Retry-After': '2' });
          } else {
            sendJson(502, { error: 'upstream' });
          }
          return;
        }
        sendTile(buf, 'MISS');
      } catch (err) {
        console.warn('[roads-tiles] error:', err?.code || err?.message || err);
        sendJson(500, { error: 'proxy' });
      }
    });
  };

  return {
    name: 'roads-tiles-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

export {
  OPENFREEMAP_TILEJSON_URL,
  ROADS_TILES_MAX_ZOOM,
  isValidRoadTileCoord,
  parseOpenFreeMapVersion,
  pruneRoadTileMemoryOutside,
  roadsTilesProxy,
};
