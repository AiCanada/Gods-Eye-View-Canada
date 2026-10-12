/**
 * EVERY RAIL LINE ON THE GLOBE: the dev server's half (owner ruling
 * 2026-10-12: "find all rail on globe, and make sure to include in outbreak
 * sim"). One background job, started by the first outbreak request (never
 * at boot), that:
 *
 *  1. sweeps every zoom-8 OpenFreeMap tile on land (src/outbreakRailWorld.mjs,
 *     about 20,000), nearest the outbreak first, through the outbreak tile
 *     store: at most NETWORK_TILES_AT_ONCE (6) at once, the store's own
 *     requests first; a tile already on disk is never fetched again, however
 *     old (its rail is kept in a small extract of its own with no expiry,
 *     .gev-cache/outbreak/rail-world/z8/{x}_{y}.json, so the store's 30-day
 *     expiry never downloads the world again);
 *  2. builds one world rail network from the extracts in a worker thread
 *     with no time limit (buildRailGraph), written to
 *     .gev-cache/outbreak/net-built/rail-world-v1-<date>.bin (the last two
 *     kept);
 *  3. answers from it: reach along the rail from an outbreak location or
 *     from every landing, and the rail routes of the epidemic model, each
 *     in a worker thread. The map draws only the rail the spread reaches
 *     (owner 2026-10-12, "no grey on rail lines"): no world rail tiles.
 *
 * Until the network is built every caller falls back to what it did before.
 * A tile that fails is asked again after 5, 30, then 120 minutes, a restart
 * included; while the tile store is told to wait (a failed TileJSON, a 429
 * or a 5xx) the sweep takes no tile at all (2026-10-12); a tile the
 * store fetches again for its own reasons updates the extract, and a new
 * build follows (at most once every RAIL_REBUILD_WAIT_MS).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  CONTINENTS,
  RAIL_WORLD_VERSION,
  RAIL_WORLD_ZOOM,
  continentOf,
  railExtract,
  railRetryDelayMs,
  railSweepOrder,
  railTileName,
  railWorldTiles,
} from '../../src/outbreakRailWorld.mjs';
import {
  railVertexIndex,
  tileBounds,
  tileDistanceKm,
  unpackRailGraph,
} from '../../src/outbreakNetwork.mjs';

/** Tiles fetched at once by the sweep: OpenFreeMap's polite share. */
export const RAIL_WORLD_AT_ONCE = 6;
/** A refreshed tile's new build waits this long, to gather others. */
export const RAIL_REBUILD_WAIT_MS = 10 * 60_000;
/** World Bank rail passenger-km, kept thirty days like the other tables. */
const PKM_URL =
  'https://api.worldbank.org/v2/country/all/indicator/IS.RRS.PASG.KM?format=json&per_page=20000&mrnev=1';
const PKM_CACHE_MS = 30 * 24 * 3_600_000;
const PKM_TIMEOUT_MS = 30_000;

const COUNTRIES_FILE = path.join(
  'src',
  'data',
  'local_data',
  'natural_earth',
  'countries.json',
);

/** The World Bank's table: million passenger-km a year by ISO2. Pure. */
export function readRailPassengerKm(payload) {
  const rows = Array.isArray(payload?.[1]) ? payload[1] : [];
  const out = {};
  const years = {};
  for (const row of rows) {
    const code = String(row?.country?.id || '');
    const value = Number(row?.value);
    if (!/^[A-Z]{2}$/.test(code) || !continentOf(code)) continue;
    if (!(value > 0)) continue;
    out[code] = value;
    years[code] = String(row?.date || '');
  }
  return { pkm: out, years };
}

/**
 * Run one task against the world network file in a worker thread
 * (outbreakRailWorldTasks.mjs). The build has no time limit (`timeoutMs`
 * 0); the answers keep the network builder's 120 s.
 */
export function railWorldTaskInWorker(
  file,
  task,
  { sourceRoot = process.cwd(), timeoutMs = 120_000 } = {},
) {
  const tasks = pathToFileURL(
    path.join(sourceRoot, 'server', 'providers', 'outbreakRailWorldTasks.mjs'),
  ).href;
  const code = [
    "const { parentPort, workerData } = require('node:worker_threads');",
    'import(workerData.tasks)',
    '  .then(({ runRailWorldTask }) => runRailWorldTask(workerData.file, workerData.task))',
    '  .then((result) => parentPort.postMessage({ ok: true, result }))',
    '  .catch((error) =>',
    '    parentPort.postMessage({ ok: false, error: String((error && error.message) || error) }));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, {
      eval: true,
      workerData: { tasks, file, task },
      resourceLimits: { maxOldGenerationSizeMb: 8192 },
    });
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            worker.terminate();
            reject(new Error('The world rail took too long.'));
          }, timeoutMs)
        : null;
    worker.once('message', (message) => {
      if (timer) clearTimeout(timer);
      worker.terminate();
      if (message?.ok) resolve(message.result);
      else reject(new Error(message?.error || 'The world rail failed.'));
    });
    worker.once('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * The world rail job. `tileStore` is the outbreak tile store
 * (networkTileStore): `cached(tile)` reads its disk copy whatever its age,
 * `lines(tile, {background: true})` fetches behind the store's own requests.
 */
export function railWorldJob({
  cacheDir = path.join(process.cwd(), '.gev-cache', 'outbreak'),
  tileStore,
  sourceRoot = process.cwd(),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = () => {},
  countries = null,
  atOnce = RAIL_WORLD_AT_ONCE,
  runTask = (file, task, options) =>
    railWorldTaskInWorker(file, task, { sourceRoot, ...options }),
  rebuildWaitMs = RAIL_REBUILD_WAIT_MS,
  timers = { setTimeout, clearTimeout },
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const worldDir = path.join(cacheDir, 'rail-world');
  const extractDir = path.join(worldDir, `z${RAIL_WORLD_ZOOM}`);
  const progressFile = path.join(worldDir, 'progress.json');
  const builtDir = path.join(cacheDir, 'net-built');
  const pkmFile = path.join(cacheDir, 'worldbank-rail-pkm.json');
  const status = {
    state: 'idle',
    tilesTotal: 0,
    tilesDone: 0,
    tilesCached: 0,
    tilesFetched: 0,
    tilesFailed: 0,
    // The times OpenFreeMap asked the sweep to wait (2026-10-12).
    pauses: 0,
    railKm: 0,
    byContinent: Object.fromEntries(CONTINENTS.map((c) => [c, 0])),
    builtAt: null,
    version: RAIL_WORLD_VERSION,
    error: null,
  };
  let tiles = null;
  let pending = [];
  let hints = [];
  let sweeping = null;
  let building = null;
  let rebuildTimer = null;
  let retryTimer = null;
  let dirty = false;
  let failures = {};
  // The land tiles with no extract yet (failed, or not swept yet), by name.
  const missing = new Map();
  let built = null; // {file, meta}
  let loaded = null; // {file, graph, index}
  let inFlight = 0;
  let maxInFlight = 0;

  const extractFile = (tile) =>
    path.join(extractDir, `${railTileName(tile)}.json`);
  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  };
  const saveProgress = () => {
    try {
      writeJson(progressFile, {
        version: RAIL_WORLD_VERSION,
        failures,
        tilesCached: status.tilesCached,
        tilesFetched: status.tilesFetched,
        savedAt: now(),
      });
    } catch {
      /* Kept in memory only. */
    }
  };
  const loadCountries = () =>
    countries ||
    JSON.parse(fs.readFileSync(path.join(sourceRoot, COUNTRIES_FILE), 'utf8'));

  /** The latest build of this version on disk, if any. */
  const latestBuild = () => {
    let names = [];
    try {
      names = fs.readdirSync(builtDir);
    } catch {
      return null;
    }
    const prefix = `rail-world-v${RAIL_WORLD_VERSION}-`;
    const list = names
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const meta = readJson(path.join(builtDir, list[i]));
      const file = path.join(builtDir, list[i].replace(/\.json$/, '.bin'));
      if (meta?.version === RAIL_WORLD_VERSION && fs.existsSync(file))
        return { file, meta };
    }
    return null;
  };
  const useBuild = (found) => {
    built = found;
    status.railKm = found.meta.lengthKm || 0;
    status.byContinent = {
      ...Object.fromEntries(CONTINENTS.map((c) => [c, 0])),
      ...(found.meta.byContinent || {}),
    };
    status.builtAt = found.meta.builtAt || null;
  };

  /**
   * How long the tile store still asks everyone to wait (2026-10-12: a
   * failed TileJSON, a 429 or a 5xx from OpenFreeMap), in ms; 0 for none.
   */
  const pauseLeft = () =>
    Math.max(0, (Number(tileStore?.pausedUntil?.()) || 0) - now());

  /**
   * Fetch or read one tile into its extract: 'cached', 'fetched',
   * 'failed', or 'throttled' when the store was told to wait (not the
   * tile's own failure).
   */
  const sweepTile = async (tile) => {
    const file = extractFile(tile);
    if (fs.existsSync(file)) return 'cached';
    const fresh = tileStore?.cached?.(tile);
    if (fresh) {
      writeJson(file, railExtract(fresh.rail, now()));
      return 'cached';
    }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let lines = null;
    try {
      lines = await tileStore.lines(tile, { background: true });
    } finally {
      inFlight -= 1;
    }
    if (!lines) return pauseLeft() > 0 ? 'throttled' : 'failed';
    // The store's own note may have written it already.
    if (!fs.existsSync(file)) writeJson(file, railExtract(lines.rail, now()));
    return 'fetched';
  };

  const scheduleRetry = () => {
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = null;
    const due = Object.values(failures).map((f) => f.nextAt);
    if (!due.length) return;
    const wait = Math.max(1000, Math.min(...due) - now());
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      const ready = tiles.filter(
        (t) => failures[railTileName(t)]?.nextAt <= now(),
      );
      if (!ready.length) {
        scheduleRetry();
        return;
      }
      pending.push(...ready);
      void sweep();
    }, wait);
    retryTimer?.unref?.();
  };

  const sweep = () => {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      if (status.state !== 'ready') status.state = 'sweeping';
      let added = 0;
      const take = async () => {
        for (;;) {
          // Told to wait (2026-10-12): no tile is taken until it is over.
          const wait = pending.length ? pauseLeft() : 0;
          if (wait > 0) {
            await sleep(wait);
            continue;
          }
          const tile = pending.shift();
          if (!tile) return;
          const name = railTileName(tile);
          let outcome = 'failed';
          try {
            outcome = await sweepTile(tile);
          } catch {
            outcome = 'failed';
          }
          if (outcome === 'throttled') {
            // Not the tile's own failure: it goes back first in line.
            pending.unshift(tile);
            status.pauses += 1;
            continue;
          }
          if (outcome === 'failed') {
            const attempts = (failures[name]?.attempts || 0) + 1;
            failures[name] = {
              attempts,
              nextAt: now() + railRetryDelayMs(attempts),
            };
          } else {
            if (failures[name]) delete failures[name];
            missing.delete(name);
            status.tilesDone += 1;
            added += 1;
            if (outcome === 'cached') status.tilesCached += 1;
            else status.tilesFetched += 1;
          }
          status.tilesFailed = Object.keys(failures).length;
          if ((status.tilesCached + status.tilesFetched) % 200 === 0)
            saveProgress();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, atOnce) }, take));
      saveProgress();
      scheduleRetry();
      if (added > 0 || !built) dirty = true;
      sweeping = null;
      if (dirty) await rebuild();
      else if (built) status.state = 'ready';
    })().catch((error) => {
      sweeping = null;
      status.state = built ? 'ready' : 'error';
      status.error = String(error?.message || error);
    });
    return sweeping;
  };

  const rebuild = () => {
    if (building) return building;
    dirty = false;
    if (!built) status.state = 'building';
    building = (async () => {
      const date = new Date(now())
        .toISOString()
        .replace(/[-:T]/g, '')
        .slice(0, 14);
      const out = path.join(
        builtDir,
        `rail-world-v${RAIL_WORLD_VERSION}-${date}.bin`,
      );
      const names = tiles
        .filter((t) => fs.existsSync(extractFile(t)))
        .map(railTileName);
      log(`World rail: building from ${names.length} tiles.`);
      const meta = await runTask(
        out,
        {
          kind: 'build',
          extractDir,
          tiles: names,
          countriesFile: path.join(sourceRoot, COUNTRIES_FILE),
          builtAt: now(),
          version: RAIL_WORLD_VERSION,
        },
        { timeoutMs: 0 },
      );
      writeJson(out.replace(/\.bin$/, '.json'), meta);
      useBuild({ file: out, meta });
      // The last two builds are kept.
      try {
        const prefix = 'rail-world-v';
        const old = fs
          .readdirSync(builtDir)
          .filter((n) => n.startsWith(prefix) && n.endsWith('.bin'))
          .sort();
        for (const name of old.slice(0, -2)) {
          fs.rmSync(path.join(builtDir, name), { force: true });
          fs.rmSync(path.join(builtDir, name.replace(/\.bin$/, '.json')), {
            force: true,
          });
        }
      } catch {
        /* Kept. */
      }
      status.state = 'ready';
      status.error = null;
      log(
        `World rail: ${meta.lengthKm.toLocaleString('en-US')} km from ${names.length} tiles.`,
      );
    })()
      .catch((error) => {
        status.state = built ? 'ready' : 'error';
        status.error = String(error?.message || error);
      })
      .finally(() => {
        building = null;
        if (dirty) scheduleRebuild();
      });
    return building;
  };

  const scheduleRebuild = () => {
    if (rebuildTimer) return;
    rebuildTimer = timers.setTimeout(() => {
      rebuildTimer = null;
      if (dirty) void rebuild();
    }, rebuildWaitMs);
    rebuildTimer?.unref?.();
  };

  /** The land mask, what is on disk already, and the sweep of the rest. */
  const init = () => {
    try {
      tiles = railWorldTiles(loadCountries(), { zoom: RAIL_WORLD_ZOOM });
    } catch (error) {
      status.state = 'error';
      status.error = `The land mask did not load: ${error.message}`;
      return;
    }
    status.tilesTotal = tiles.length;
    const progress = readJson(progressFile);
    if (progress?.version === RAIL_WORLD_VERSION) {
      failures = progress.failures || {};
      status.tilesFetched = progress.tilesFetched || 0;
    }
    const found = latestBuild();
    if (found) {
      useBuild(found);
      status.state = 'ready';
    }
    // Done already: every tile with an extract (a restart resumes here). A
    // failed tile whose next try is still to come waits for it
    // (2026-10-12: a restart no longer asks every failed tile again at
    // once).
    let done = 0;
    const left = [];
    missing.clear();
    for (const tile of tiles) {
      const name = railTileName(tile);
      if (fs.existsSync(extractFile(tile))) {
        done += 1;
        delete failures[name];
        continue;
      }
      missing.set(name, tile);
      if (!(failures[name]?.nextAt > now())) left.push(tile);
    }
    for (const name of Object.keys(failures))
      if (!missing.has(name)) delete failures[name];
    status.tilesDone = done;
    status.tilesFetched = Math.min(status.tilesFetched, done);
    status.tilesCached = done - status.tilesFetched;
    status.tilesFailed = Object.keys(failures).length;
    pending = railSweepOrder(left, hints);
    // A build older than the tiles on disk is built again.
    dirty = !found || (found.meta.tiles || 0) < done;
    if (!left.length && !dirty) {
      scheduleRetry();
      return;
    }
    void sweep();
  };

  let started = false;
  let initializing = null;
  const job = {
    /**
     * Start the sweep (once; later calls only steer it): the tiles nearest
     * `near` first. Never waits for it.
     */
    start(near = []) {
      const points = near.filter(
        (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
      );
      if (points.length) hints = [...points, ...hints].slice(0, 50);
      if (started) {
        if (points.length && pending.length > 1)
          pending = railSweepOrder(pending, hints);
        return;
      }
      started = true;
      // The land mask and the look at the disk, after this request's turn.
      initializing = new Promise((resolve) => setImmediate(resolve)).then(
        () => {
          initializing = null;
          init();
        },
      );
    },
    status() {
      return { ...status, byContinent: { ...status.byContinent } };
    },
    /** For tests: the most tile fetches the sweep had going at once. */
    maxInFlight: () => maxInFlight,
    /** The sweep and any build, finished (tests). */
    async settled() {
      while (initializing || sweeping || building)
        await (initializing || sweeping || building);
    },
    ready: () => Boolean(built),
    /**
     * How many land tiles within `km` of any of `points` the world still
     * lacks (2026-10-12: failed, or not swept yet): an answer near one is
     * not complete.
     */
    missingNear(points, km) {
      if (!missing.size) return 0;
      const list = (points || []).filter(
        (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
      );
      let count = 0;
      for (const tile of missing.values()) {
        const bounds = tileBounds(tile.z, tile.x, tile.y);
        if (list.some((p) => tileDistanceKm(p, bounds) <= km)) count += 1;
      }
      return count;
    },
    /** The built network's file and when it was built, or null. */
    build: () =>
      built ? { file: built.file, builtAt: built.meta.builtAt } : null,
    meta: () => (built ? built.meta : null),
    /**
     * The store fetched a zoom-8 tile for its own reasons: its rail goes
     * into the extract, and a new build follows if it changed.
     */
    noteTile(tile, lines) {
      if (tile?.z !== RAIL_WORLD_ZOOM || !lines) return;
      const file = extractFile(tile);
      const next = railExtract(lines.rail, now());
      const was = readJson(file);
      if (was && JSON.stringify(was.rail) === JSON.stringify(next.rail)) return;
      try {
        writeJson(file, next);
      } catch {
        return;
      }
      missing.delete(railTileName(tile));
      // While the sweep runs, its own end builds again; else a build later.
      if (sweeping || building) dirty = true;
      else if (built) {
        dirty = true;
        scheduleRebuild();
      }
    },
    /** The world network in this thread (for railNear). */
    graph() {
      if (!built) return null;
      if (loaded?.file === built.file) return loaded;
      try {
        const graph = unpackRailGraph(fs.readFileSync(built.file));
        loaded = {
          file: built.file,
          graph,
          index: railVertexIndex(graph),
        };
      } catch {
        loaded = null;
      }
      return loaded;
    },
    /** True where the world rail passes within `km` of the point. */
    near(point, km) {
      const g = job.graph();
      return Boolean(g?.index.nearest(point, km));
    },
    /** Run a task against the built network in a worker. */
    task(task, options) {
      if (!built)
        return Promise.reject(new Error('The world rail is not built yet.'));
      return runTask(built.file, task, options);
    },
    /**
     * Each country's rail passenger-km a year (million): the World Bank's
     * table, kept thirty days, and the estimate for the rest.
     */
    async passengerKm() {
      let table = readJson(pkmFile);
      let stale = true;
      try {
        stale = now() - fs.statSync(pkmFile).mtimeMs > PKM_CACHE_MS;
      } catch {
        stale = true;
      }
      if (!table || stale) {
        try {
          const response = await fetchImpl(PKM_URL, {
            signal: AbortSignal.timeout(PKM_TIMEOUT_MS),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const read = readRailPassengerKm(await response.json());
          if (Object.keys(read.pkm).length) {
            table = { ...read, fetchedAt: now() };
            try {
              writeJson(pkmFile, table);
            } catch {
              /* Kept in memory only. */
            }
          }
        } catch {
          /* The kept copy, however old, or none. */
        }
      }
      return table || { pkm: {}, years: {} };
    },
  };
  return job;
}
