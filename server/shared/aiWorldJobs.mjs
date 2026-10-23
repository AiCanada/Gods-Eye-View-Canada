/**
 * The Artificial Intelligence World Training Sim's jobs (owner request
 * 2026-10-13): one manager for the tab's four stages — recording every
 * ticked feed (the world tape), generating Outbreak sim episodes, training
 * the models (a Python child process) and predicting (another one) — with
 * INITIALIZE, PAUSE / CONTINUE, STOP and DELETE. Its state survives a
 * dev-server restart (.gev-data/ai-world/state.json): a recorder that was
 * running starts again and the time it was down is written as a gap.
 * docs/AI-WORLD-TAB.md is the contract.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createTapeStore, folderUsage } from './worldTapeStore.mjs';
import { createRecorder } from './worldTapeRecorder.mjs';
import { buildCatalog, feedMap } from './worldTape/catalog.mjs';
import { createDatasetJob, datasetSpec } from './outbreakDatasetJob.mjs';
import {
  buildWorldSnapshot,
  latestWorld,
  writeWorldSnapshot,
} from './outbreakWorldStore.mjs';
import { deleteListed, deletePreview } from './aiWorldDelete.mjs';
import { filterPrediction, matchInfer } from './aiWorldInfer.mjs';
import { loadDemographics, writeDemographics } from './demographicsStore.mjs';
import { loadWorldSnapshot } from './outbreakWorldStore.mjs';
import { stripExcluded } from '../../src/aiWorldSelection.mjs';
import {
  addNewsUrl as pushNewsUrl,
  removeNewsUrl as dropNewsUrl,
} from './newsUrls.mjs';
import { NO_TRACKER, trackChild } from './mlflowTrack.mjs';

export const AI_WORLD_STATES = Object.freeze([
  'idle',
  'initializing',
  'running',
  'paused',
  'stopping',
  'stopped',
]);
export const PREDICTION_DOMAINS = Object.freeze([
  'outbreak',
  'mobility',
  'trains',
  'traffic',
  'weather',
  'hazards',
  'news',
  'tracks',
  'flights',
  'vessels',
  'transit',
]);

/** Civil travel the track model may learn. Military flights are not in this list. */
export const CIVIL_TRACK_FEEDS = Object.freeze([
  'flights',
  'ais-live-vessels',
  'transit',
]);

/**
 * The newest UTC day strictly before today, as `YYYY/MM/DD`.
 * Today is still being recorded, so it is not binned.
 */
export function newestCompleteTapeDay(days, nowMs) {
  const today = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '/');
  let best = '';
  for (const day of Array.isArray(days) ? days : []) {
    const key = String(day || '').replace(/-/g, '/');
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(key) || key >= today || key <= best)
      continue;
    best = key;
  }
  return best || null;
}

/**
 * The complete UTC days (before today) that have tape but no bin yet, oldest
 * first, as `YYYY/MM/DD`: backfilled history and a day the server slept
 * through at midnight are binned this way, one day at a time. `skip` holds
 * days whose binning failed, so a bad day is not tried again every tick.
 */
export function unbinnedTapeDays(days, binned, nowMs, skip = new Set()) {
  const today = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '/');
  const done = new Set(
    (Array.isArray(binned) ? binned : []).map((day) =>
      String(day || '').replace(/-/g, '/'),
    ),
  );
  const out = new Set();
  for (const day of Array.isArray(days) ? days : []) {
    const key = String(day || '').replace(/-/g, '/');
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(key) || key >= today) continue;
    if (done.has(key) || skip.has(key)) continue;
    out.add(key);
  }
  return [...out].sort();
}

/**
 * Binned days the world model needs before its first training window: with
 * the trainer's defaults (24 h of context, 24 h of horizon, a fifth of the
 * days held out and at least one) that is two days to train on and one held
 * out (ml/gevtape/train.py). Below it the trainer is not launched at all.
 */
export const WORLD_MIN_BIN_DAYS = 3;

/** The names in `dir` that match, sorted; none when it cannot be read. */
function listNames(dir, pattern) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => pattern.test(name))
      .sort();
  } catch {
    return [];
  }
}
/** Models the trainer runs, and the domains each one predicts. */
const MODELS = Object.freeze({
  outbreak: ['outbreak'],
  world: ['mobility', 'weather', 'hazards', 'news'],
  tracks: ['tracks'],
  // The outbreak model calibrated on real epidemics (ml.gevtape.calibrate):
  // a report and a checkpoint, drawn nowhere on the globe.
  'outbreak-real': [],
  // Measured interactions between the data layers and the assets
  // (ml.gevtape.links): a report for the tab's LINKS, no checkpoint.
  links: [],
  // Another world model post-trained on the newest data (ml.gevtape.posttrain).
  posttrain: [],
});
const HEARTBEAT_MS = 60_000;
const SCHEDULE_MS = 15 * 60_000;
const RETRAIN_MS = 24 * 3_600_000;
const USAGE_TTL_MS = 60_000;
/** Which state the YOUR DEVICES row shows when its feeds differ. */
const DEVICE_STATE_ORDER = Object.freeze([
  'recording',
  'error',
  'quota',
  'waiting',
  'paused',
  'off',
]);
/** The areas cameras, traffic, news and imagery record around. */
export const AREAS_MAX = 32;

const ADAPTER_SPEC = /^([a-z_][a-z0-9_]{0,63}):([A-Za-z_][A-Za-z0-9_]{0,63})$/;

/**
 * POST-TRAIN (owner request 2026-10-16: keep existing world models up to
 * date): an adapter in ml/adapters/ or .gev-data/ai-world/adapters/ and a
 * checkpoint inside .gev-data/, both checked on this machine before anything
 * runs (ml.gevtape.posttrain imports nothing else).
 * @returns {{adapter: string, checkpoint: string, daily: boolean}}
 */
export function cleanPostTrain(raw, { root, dataRoot }) {
  const refuse = (message) =>
    Object.assign(new Error(message), { status: 400 });
  const adapter = String(raw?.adapter || '').trim();
  const match = ADAPTER_SPEC.exec(adapter);
  if (!match)
    throw refuse(
      'ADAPTER is module:Class, for example kit_world:KitWorldAdapter.',
    );
  const folders = [
    path.join(root, 'ml', 'adapters'),
    path.join(dataRoot, 'ai-world', 'adapters'),
  ];
  if (
    !folders.some((folder) =>
      fs.existsSync(path.join(folder, `${match[1]}.py`)),
    )
  )
    throw refuse(
      `No ${match[1]}.py in ml/adapters/ or .gev-data/ai-world/adapters/.`,
    );
  const given = String(raw?.checkpoint || '').trim();
  if (!given)
    throw refuse('CHECKPOINT is the existing model, inside .gev-data/.');
  const base = path.resolve(dataRoot);
  const checkpoint = path.resolve(base, given);
  if (checkpoint !== base && !checkpoint.startsWith(base + path.sep))
    throw refuse('CHECKPOINT must be inside .gev-data/.');
  if (!fs.existsSync(checkpoint)) throw refuse('No model at that CHECKPOINT.');
  return { adapter, checkpoint, daily: raw?.daily === true };
}

/**
 * One area as the tab adds it: a finite point, a name (its coordinates when
 * none is given) and the key the feed adapters know it by
 * (worldTape/feeds/_util.mjs validAreas). Null when the point is not one.
 * @param {{lat?: unknown, lon?: unknown, name?: unknown}} raw
 */
export function cleanArea(raw) {
  const lat = Number(raw?.lat);
  const lon = Number(raw?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name =
    typeof raw?.name === 'string'
      ? raw.name
          .replace(/[\u0000-\u001f]/g, ' ')
          .trim()
          .slice(0, 80)
      : '';
  return {
    key: `${lat.toFixed(4)},${lon.toFixed(4)}`,
    name: name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
  };
}

/** The Python that runs ml/ (GEV_PYTHON overrides: "py -3.13", "python3"). */
export function defaultPython(env = process.env, platform = process.platform) {
  const set = String(env.GEV_PYTHON || '').trim();
  if (set) return set.split(/\s+/);
  return platform === 'win32' ? ['py', '-3.13'] : ['python3'];
}

/** The GPU's name, once, or null. */
let gpuName;
export function detectGpu(run = spawnSync) {
  if (gpuName !== undefined) return gpuName;
  try {
    const out = run(
      'nvidia-smi',
      ['--query-gpu=name', '--format=csv,noheader'],
      { encoding: 'utf8', timeout: 5000 },
    );
    gpuName =
      out.status === 0 ? out.stdout.split('\n')[0].trim() || null : null;
  } catch {
    gpuName = null;
  }
  return gpuName;
}

/**
 * A JSON-lines child process (docs/AI-WORLD-TAB.md, child-process
 * protocol): events on stdout, commands on stdin.
 */
export function createChild({
  command,
  args,
  cwd,
  onEvent = () => {},
  onExit = () => {},
  log = () => {},
  spawnImpl = spawn,
  env,
}) {
  const child = spawnImpl(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(env ? { env } : {}),
  });
  let buffer = '';
  const tail = [];
  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        log(`child: ${line.slice(0, 200)}`);
      }
    }
  });
  child.stderr?.setEncoding?.('utf8');
  child.stderr?.on('data', (chunk) => {
    tail.push(...String(chunk).split('\n').filter(Boolean));
    while (tail.length > 20) tail.shift();
  });
  child.on('exit', (code, signal) => onExit({ code, signal, tail: [...tail] }));
  child.on('error', (error) =>
    onExit({ code: -1, signal: null, tail: [String(error?.message || error)] }),
  );
  return {
    send(message) {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        /* closed */
      }
    },
    kill() {
      try {
        child.kill();
      } catch {
        /* gone */
      }
    },
    get pid() {
      return child.pid;
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.root The repository.
 * @param {() => object} options.servicesFor Tool services on this server's
 *   own API (createLocalToolServices).
 * @param {() => Function} [options.apiFetch] A fetch that resolves /api/.
 */
export function createAiWorldManager({
  root,
  dataRoot = path.join(root, '.gev-data'),
  cacheDir = path.join(root, '.gev-cache', 'outbreak'),
  servicesFor = () => ({}),
  apiFetch = () => globalThis.fetch,
  python = defaultPython(),
  now = Date.now,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  log = () => {},
  spawnImpl = spawn,
  gpu = () => detectGpu(),
  feeds = feedMap(),
  datasetWorkers,
  /** MLFLOW TRACKING: each trainer child as an MLflow run (mlflowTrack.mjs). */
  tracker = NO_TRACKER,
  /** The GLOBAL ABUNDANCE MAP's store (server/shared/abundanceData.mjs), for the GLOBAL ABUNDANCE row. */
  abundance = null,
}) {
  const stateFile = path.join(dataRoot, 'ai-world', 'state.json');
  const areasFile = path.join(dataRoot, 'ai-world', 'areas.json');
  const newsUrlFile = path.join(dataRoot, 'ai-world', 'news-urls.json');
  const marketsFile = path.join(dataRoot, 'ai-world', 'markets.json');
  const modelsDir = path.join(dataRoot, 'ai-world', 'models');
  const predictionsDir = path.join(dataRoot, 'ai-world', 'predictions');
  const worldsDir = path.join(dataRoot, 'outbreak', 'worlds');
  // Written by `npm run outbreak:real-data`; the server never fetches it.
  const realDir = path.join(dataRoot, 'real', 'owid-oxcgrt');
  const datasetsDir = path.join(dataRoot, 'outbreak', 'datasets');
  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };
  const loaded = readJson(stateFile, {});
  const persisted = {
    state: 'idle',
    since: now(),
    capBytes: 600e9,
    sim: { scenarios: 2000, runs: 8, days: 40, seed: 1 },
    lastSeenAt: null,
    trained: {},
    ...loaded,
    selection: stripExcluded(loaded.selection),
  };
  const save = () => {
    persisted.lastSeenAt = now();
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2));
    fs.renameSync(tmp, stateFile);
  };
  if (
    JSON.stringify(Array.isArray(loaded.selection) ? loaded.selection : []) !==
    JSON.stringify(persisted.selection)
  )
    save();
  const setState = (state) => {
    persisted.state = state;
    persisted.since = now();
    save();
  };

  // Storage other than the tape, counted against the same cap.
  let usageCache = null;
  const otherUsage = () => {
    if (usageCache && now() - usageCache.at < USAGE_TTL_MS) return usageCache;
    const byKind = {
      datasets: folderUsage(datasetsDir).bytes,
      worlds: folderUsage(worldsDir).bytes,
      models: folderUsage(modelsDir).bytes,
      predictions: folderUsage(predictionsDir).bytes,
      bins: folderUsage(path.join(dataRoot, 'bins')).bytes,
    };
    usageCache = {
      at: now(),
      byKind,
      bytes: Object.values(byKind).reduce((s, b) => s + b, 0),
    };
    return usageCache;
  };
  const store = createTapeStore({
    root: path.join(dataRoot, 'tape'),
    now,
    capBytes: persisted.capBytes,
    otherBytes: () => otherUsage().bytes,
  });
  const areas = () => {
    const list = readJson(areasFile, []);
    return (Array.isArray(list) ? list : [])
      .map(cleanArea)
      .filter(Boolean)
      .slice(0, AREAS_MAX);
  };
  const writeAreas = (list) => {
    fs.mkdirSync(path.dirname(areasFile), { recursive: true });
    const tmp = `${areasFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, areasFile);
  };
  const recorder = createRecorder({
    store,
    adapters: feeds,
    now,
    timers,
    log: (line) => log(`[tape] ${line}`),
    contextFor: () => ({
      services: servicesFor(),
      fetch: apiFetch(),
      areas: areas(),
      newsUrls: readNewsUrls(),
      saveMarkets: writeMarkets,
      loadMarketBudget: () => readMarketFile().budget,
      marketKeys: {
        twelveData: String(process.env.TWELVE_DATA_API_KEY || '').trim(),
        oilPrice: String(process.env.OILPRICE_API_KEY || '').trim(),
      },
    }),
  });
  const readNewsUrls = () => {
    const saved = readJson(newsUrlFile, []);
    return Array.isArray(saved)
      ? saved.filter((item) => typeof item === 'string')
      : [];
  };
  const writeNewsUrls = (list) => {
    fs.mkdirSync(path.dirname(newsUrlFile), { recursive: true });
    const tmp = `${newsUrlFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, newsUrlFile);
  };
  const readMarketFile = () => {
    const saved = readJson(marketsFile, []);
    if (Array.isArray(saved)) return { quotes: saved, budget: null };
    if (!saved || typeof saved !== 'object')
      return { quotes: [], budget: null };
    return {
      quotes: Array.isArray(saved.quotes) ? saved.quotes : [],
      budget:
        saved.budget && typeof saved.budget === 'object' ? saved.budget : null,
    };
  };
  const writeMarkets = (rows, budget) => {
    fs.mkdirSync(path.dirname(marketsFile), { recursive: true });
    const tmp = `${marketsFile}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        {
          quotes: Array.isArray(rows) ? rows : [],
          budget: budget && typeof budget === 'object' ? budget : null,
        },
        null,
        2,
      ),
    );
    fs.renameSync(tmp, marketsFile);
  };

  // Stages beyond the recorder.
  const stages = {
    generator: {
      state: 'off',
      done: 0,
      total: 0,
      episodes: 0,
      etaMs: null,
      error: null,
    },
    trainer: {
      state: 'off',
      model: null,
      epoch: 0,
      epochs: 0,
      loss: null,
      error: null,
      note: null,
    },
    predictor: { state: 'off', domains: [], updatedAt: null, error: null },
  };
  let datasetJob = null;
  let trainer = null;
  let trainerQueue = [];
  let predictor = null;
  let binChild = null;
  let worldChild = null;
  let worldBuildFailed = false;
  // Days whose binning failed this session, and the last trainer failure:
  // neither is tried again until a new day is binned.
  const binFailed = new Set();
  let lastTrainerFailure = null;
  let pending = new Map(); // predict id → resolve
  let nextId = 1;
  let heartbeat = null;
  let scheduler = null;

  const selected = (id) => persisted.selection.includes(id);
  // YOUR DEVICES is every personal feed: the owner's own recordings, private
  // cameras and local receivers.
  const deviceFeeds = () =>
    [...feeds.values()].filter((f) => f.class === 'personal').map((f) => f.id);
  const expand = (selection) => [
    ...new Set(
      selection.flatMap((id) => (id === 'devices' ? deviceFeeds() : [id])),
    ),
  ];
  const feedIds = () =>
    expand(persisted.selection).filter((id) => feeds.get(id)?.poll);

  // --- Sim episodes ---------------------------------------------------------
  const startGenerator = async () => {
    if (!selected('outbreak-sim') || datasetJob) return;
    stages.generator = { ...stages.generator, state: 'running', error: null };
    try {
      let world = latestWorld(worldsDir);
      if (!world) {
        log('[sim] building the world snapshot');
        const built = await buildWorldSnapshot({
          cacheDir,
          log: (l) => log(`[sim] ${l}`),
        });
        const { dir } = writeWorldSnapshot(built, worldsDir);
        world = { dir };
      }
      const spec = datasetSpec(persisted.sim);
      const name = `ai-world-w${path.basename(world.dir)}-s${spec.seed}`;
      datasetJob = createDatasetJob({
        root,
        worldDir: world.dir,
        datasetDir: path.join(datasetsDir, name),
        spec,
        workers: datasetWorkers,
        log: (l) => log(`[sim] ${l}`),
        onProgress: (s) => {
          stages.generator = {
            state:
              s.state === 'done'
                ? 'done'
                : s.state.startsWith('paus')
                  ? 'paused'
                  : s.state === 'stopped'
                    ? 'off'
                    : 'running',
            done: s.doneShards,
            total: s.totalShards,
            episodes: s.episodes,
            etaMs: s.etaMs,
            error: s.error,
            dataset: name,
          };
        },
      });
      const result = await datasetJob.start();
      datasetJob = null;
      if (result.state === 'done') queueTraining('outbreak');
    } catch (error) {
      datasetJob = null;
      stages.generator = {
        ...stages.generator,
        state: 'error',
        error: String(error?.message || error),
      };
      log(`[sim] ${stages.generator.error}`);
    }
  };

  // --- Population demographics (a static item: fetched once a month) -------
  let demographicsBusy = false;
  const startDemographics = async () => {
    if (!selected('demographics') || demographicsBusy) return;
    demographicsBusy = true;
    try {
      const table = await loadDemographics({
        cacheDir,
        fetchImpl: apiFetch() || globalThis.fetch,
      });
      const world = latestWorld(worldsDir);
      writeDemographics(
        table,
        world ? loadWorldSnapshot(world.dir) : null,
        path.join(dataRoot, 'demographics'),
      );
      log('[demographics] written');
    } catch (error) {
      log(`[demographics] ${error.message}`);
    } finally {
      demographicsBusy = false;
    }
  };

  // --- Global abundance (a static item: the map's country figures, per place) --
  let abundanceBusy = false;
  const startAbundance = async () => {
    if (!selected('abundance') || abundanceBusy || !abundance) return;
    abundanceBusy = true;
    try {
      const world = latestWorld(worldsDir);
      if (!world) {
        log('[abundance] no world yet: nothing to write');
        return;
      }
      abundance.writeWorldFeatures(
        loadWorldSnapshot(world.dir),
        path.join(dataRoot, 'demographics'),
      );
      log('[abundance] written');
    } catch (error) {
      log(`[abundance] ${error?.message || error}`);
    } finally {
      abundanceBusy = false;
    }
  };

  // --- Training -------------------------------------------------------------
  const modelDir = (model) => path.join(modelsDir, model);
  const savedWorldMetrics = () => {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(modelsDir, 'world', 'metrics.json'), 'utf8'),
      );
      return {
        skill: raw.skill && typeof raw.skill === 'object' ? raw.skill : null,
        domains:
          raw.domains && typeof raw.domains === 'object' ? raw.domains : null,
        model: typeof raw.model === 'string' ? raw.model : 'world',
      };
    } catch {
      return null;
    }
  };
  const trainerStatus = () => {
    // A links run has no scores of its own: the world model's stay shown.
    const live =
      stages.trainer.skill ||
      (stages.trainer.state === 'running' && stages.trainer.model !== 'links');
    const saved = live ? null : savedWorldMetrics();
    return {
      ...stages.trainer,
      skill: stages.trainer.skill ?? saved?.skill ?? null,
      domains: stages.trainer.domains ?? saved?.domains ?? null,
      model: stages.trainer.model ?? saved?.model ?? null,
    };
  };
  const postTrainStatus = () => {
    const cfg = persisted.posttrain;
    const last = readJson(
      path.join(modelDir('posttrain'), 'metrics.json'),
      null,
    );
    return {
      adapter: cfg?.adapter || '',
      checkpoint: cfg?.checkpoint
        ? path.relative(dataRoot, cfg.checkpoint)
        : '',
      daily: cfg?.daily === true,
      last:
        last && typeof last === 'object'
          ? {
              before: last.heldOutLossBefore ?? null,
              after: last.heldOutLossAfter ?? null,
              helped: last.helped === true,
              trainedThrough: last.trainedThrough ?? null,
              updatedAt: last.updatedAt ?? null,
            }
          : null,
    };
  };
  // The LINKS report (ml.gevtape.links): read again only when it changes.
  let linksCache = { mtimeMs: -1, value: null };
  const measuredLinks = () => {
    const file = path.join(modelDir('links'), 'links.json');
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
    if (mtimeMs !== linksCache.mtimeMs) {
      const raw = readJson(file, null);
      linksCache = {
        mtimeMs,
        value:
          raw && typeof raw === 'object'
            ? {
                generatedAt: raw.generatedAt ?? null,
                hours: raw.hours ?? 0,
                tested: raw.tested ?? 0,
                reason: typeof raw.reason === 'string' ? raw.reason : null,
                top: (Array.isArray(raw.results) ? raw.results : []).slice(
                  0,
                  12,
                ),
                studyPairs: Array.isArray(raw.studyPairs) ? raw.studyPairs : [],
              }
            : null,
      };
    }
    return linksCache.value;
  };
  const hasCheckpoint = (model) =>
    fs.existsSync(path.join(modelDir(model), 'checkpoint.pt'));
  // --- Bins -------------------------------------------------------------
  /** The days binned for the newest world, as `YYYY/MM/DD`, oldest first. */
  const binnedDayKeys = () => {
    const world = latestWorld(worldsDir);
    if (!world) return [];
    const folder = path.join(dataRoot, 'bins', path.basename(world.dir));
    const days = [];
    for (const year of listNames(folder, /^\d{4}$/))
      for (const month of listNames(path.join(folder, year), /^\d{2}$/))
        for (const name of listNames(
          path.join(folder, year, month),
          /^\d{2}\.mobility\.npy$/,
        ))
          days.push(`${year}/${month}/${name.slice(0, 2)}`);
    return days;
  };
  const binnedDays = () => binnedDayKeys().length;
  /** The finished days still to bin, oldest first. */
  const daysToBin = () =>
    unbinnedTapeDays(tapeDaysOnDisk(), binnedDayKeys(), now(), binFailed);
  /** What the world model waits for while nothing trains, or null. */
  const worldWaitNote = () => {
    const days = binnedDays();
    return days < WORLD_MIN_BIN_DAYS && feedIds().length
      ? `NEEDS ${WORLD_MIN_BIN_DAYS} BINNED DAYS · ${days} SO FAR`
      : null;
  };
  /** The TRAINING line while nothing runs: waiting, and for what. */
  const settleTrainerLine = () => {
    if (
      trainer ||
      binChild ||
      worldChild ||
      ['running', 'paused', 'error'].includes(stages.trainer.state)
    )
      return;
    const note = worldWaitNote();
    stages.trainer = note
      ? {
          ...stages.trainer,
          state: 'waiting',
          model: 'world',
          epoch: 0,
          epochs: 0,
          loss: null,
          error: null,
          note,
        }
      : { ...stages.trainer, state: 'waiting', note: null };
  };
  // A trainer that failed is not launched again until a new day is binned
  // (the usual cause is too little data); POST-TRAIN NOW is always honoured.
  const blocked = (model) =>
    lastTrainerFailure?.model === model &&
    lastTrainerFailure.daysBinned === binnedDays();
  const queueTraining = (model, { force = false } = {}) => {
    if (!force && blocked(model)) return false;
    if (!trainerQueue.includes(model) && trainer?.model !== model)
      trainerQueue.push(model);
    runTrainer();
    return true;
  };
  /** The world model trains only once enough days are binned. */
  const queueWorldTraining = () => {
    if (binnedDays() < WORLD_MIN_BIN_DAYS) {
      settleTrainerLine();
      return false;
    }
    return queueTraining('world');
  };
  const runTrainer = (resume = false) => {
    if (trainer || persisted.state !== 'running') return;
    const model = trainerQueue.shift();
    if (!model) {
      settleTrainerLine();
      return;
    }
    // Calibration starts over by itself when its base model or the real
    // data changed since its checkpoint.
    const task =
      model === 'outbreak-real'
        ? ['ml.gevtape.calibrate', '--model-dir', modelDir('outbreak')]
        : model === 'links'
          ? ['ml.gevtape.links']
          : model === 'posttrain'
            ? [
                'ml.gevtape.posttrain',
                '--adapter',
                persisted.posttrain?.adapter || '',
                '--checkpoint',
                persisted.posttrain?.checkpoint || '',
              ]
            : ['ml.gevtape.train', '--model', model];
    const args = [
      ...python.slice(1),
      '-m',
      task[0],
      '--data',
      dataRoot,
      ...task.slice(1),
      '--out',
      modelDir(model),
      ...(resume || hasCheckpoint(model) ? ['--resume'] : []),
      // Training curves for the tab's TENSORBOARD section
      // (server/shared/tensorflowJobs.mjs reads the same folder).
      ...(task[0] === 'ml.gevtape.train'
        ? [
            '--tensorboard',
            path.join(dataRoot, 'ai-world', 'tensorboard', model),
          ]
        : []),
    ];
    stages.trainer = {
      state: 'running',
      model,
      epoch: 0,
      epochs: 0,
      loss: null,
      error: null,
      note: null,
    };
    const tracked = trackChild(tracker, {
      experiment: `ai-world/${model}`,
      name: `${model} ${new Date(now()).toISOString().slice(0, 16).replace('T', ' ')}`,
      args,
      tags: {
        'gev.model': model,
        'gev.framework': model === 'links' ? 'numpy' : 'pytorch',
        'mlflow.source.name': task[0],
      },
    });
    const child = createChild({
      command: python[0],
      args,
      cwd: root,
      spawnImpl,
      log: (l) => log(`[train] ${l}`),
      onEvent: (event) => {
        tracked.event(event);
        if (event.event === 'progress')
          stages.trainer = {
            ...stages.trainer,
            epoch: event.epoch ?? stages.trainer.epoch,
            epochs: event.epochs ?? stages.trainer.epochs,
            loss: event.loss ?? stages.trainer.loss,
            channelMismatch:
              event.channelMismatch === true
                ? true
                : stages.trainer.channelMismatch === true,
            channelsGrown:
              event.channelsGrown === true
                ? true
                : stages.trainer.channelsGrown === true,
          };
        else if (event.event === 'metrics') {
          stages.trainer.skill = event.skill ?? null;
          stages.trainer.domains =
            event.domains && typeof event.domains === 'object'
              ? event.domains
              : null;
        } else if (event.event === 'error')
          stages.trainer.error = String(event.message || 'training failed');
        else if (event.event === 'paused') stages.trainer.state = 'paused';
        else if (event.event === 'done') {
          persisted.trained[model] = now();
          if (lastTrainerFailure?.model === model) lastTrainerFailure = null;
          save();
        }
      },
      onExit: ({ code, tail }) => {
        const wasPaused = stages.trainer.state === 'paused';
        tracked.exit({
          code,
          stopped: persisted.state !== 'running',
          files: ['metrics.json', 'manifest.json'].map((name) => [
            path.join(modelDir(model), name),
            name,
          ]),
        });
        trainer = null;
        if (code !== 0 && !wasPaused && persisted.state === 'running') {
          lastTrainerFailure = { model, daysBinned: binnedDays() };
          stages.trainer = {
            ...stages.trainer,
            state: 'error',
            error: stages.trainer.error || tail.at(-1) || `exit ${code}`,
            note: 'TRIED AGAIN WHEN A NEW DAY IS BINNED',
          };
          return;
        }
        if (wasPaused) {
          trainerQueue.unshift(model);
          return;
        }
        stages.trainer.state = 'done';
        if (model === 'outbreak') queueCalibration();
        // A new checkpoint is loaded by a fresh predictor; a links report or
        // another model's post-training is not one.
        if (model !== 'links' && model !== 'posttrain') startPredictor(true);
        runTrainer();
      },
    });
    trainer = { model, child };
  };
  /** Calibrate the outbreak model on real epidemics once both exist. */
  const queueCalibration = () => {
    const calibrated = persisted.trained['outbreak-real'];
    if (
      hasCheckpoint('outbreak') &&
      fs.existsSync(realDir) &&
      !(calibrated >= (persisted.trained.outbreak || 0))
    )
      queueTraining('outbreak-real');
  };
  const pauseTrainer = () => {
    if (!trainer) return;
    trainer.child.send({ cmd: 'pause' });
  };
  const stopTrainer = () => {
    if (!trainer) return;
    trainer.child.send({ cmd: 'stop' });
    const child = trainer.child;
    timers.setTimeout(() => child.kill(), 120_000)?.unref?.();
  };

  // --- Predicting -----------------------------------------------------------
  const worldChannelGroups = () => {
    const manifest = readJson(
      path.join(modelDir('world'), 'manifest.json'),
      null,
    );
    const channels = manifest?.data?.channels;
    if (!Array.isArray(channels)) return [...MODELS.world];
    const groups = [];
    for (const channel of channels) {
      const group = String(channel || '').split('.')[0];
      if (
        !group ||
        group === 'military' ||
        group.startsWith('military-') ||
        groups.includes(group)
      )
        continue;
      groups.push(group);
    }
    return groups.length ? groups : [...MODELS.world];
  };
  const trainedDomains = () => {
    const domains = [];
    if (hasCheckpoint('outbreak')) domains.push('outbreak');
    if (hasCheckpoint('world')) domains.push(...worldChannelGroups());
    if (hasCheckpoint('tracks'))
      domains.push('tracks', 'flights', 'vessels', 'transit');
    return domains.filter(
      (domain) => domain !== 'military' && !domain.startsWith('military-'),
    );
  };
  const knownDomain = (domain) =>
    domain === 'all' ||
    PREDICTION_DOMAINS.includes(domain) ||
    (feeds.has(domain) &&
      domain !== 'military' &&
      !String(domain).startsWith('military-'));
  const startPredictor = (restart = false) => {
    if (restart && predictor) {
      predictor.child.kill();
      predictor = null;
    }
    if (predictor || persisted.state !== 'running') return;
    const domains = trainedDomains();
    stages.predictor = { ...stages.predictor, domains };
    if (!domains.length) {
      stages.predictor.state = 'waiting';
      return;
    }
    const child = createChild({
      command: python[0],
      args: [
        ...python.slice(1),
        '-m',
        'ml.gevtape.serve',
        '--data',
        dataRoot,
        '--models',
        modelsDir,
      ],
      cwd: root,
      spawnImpl,
      log: (l) => log(`[predict] ${l}`),
      onEvent: (message) => {
        const done = pending.get(message.id);
        if (!done) return;
        pending.delete(message.id);
        done(message);
      },
      onExit: ({ code, tail }) => {
        predictor = null;
        for (const done of pending.values())
          done({ ok: false, error: 'predictor stopped' });
        pending = new Map();
        if (persisted.state === 'running' && code !== 0)
          stages.predictor = {
            ...stages.predictor,
            state: 'error',
            error: tail.at(-1) || `exit ${code}`,
          };
        else if (stages.predictor.state !== 'error')
          stages.predictor.state = 'off';
      },
    });
    predictor = { child };
    stages.predictor.state = 'running';
  };
  const stopPredictor = () => {
    predictor?.child.kill();
    predictor = null;
    stages.predictor.state = 'off';
  };

  // --- Scheduling -----------------------------------------------------------
  const daysRecorded = () => {
    const firstFeed = feedIds()
      .map((id) => store.usage().byFeed[id])
      .filter(Boolean);
    if (!firstFeed.length) return 0;
    const start = persisted.firstRecordedAt || null;
    if (!start) return 0;
    let gapMs = 0;
    for (const g of store.gaps())
      if (g.to > start) gapMs += g.to - Math.max(g.from, start);
    return Math.max(0, (now() - start - gapMs) / 86_400_000);
  };
  const schedule = () => {
    if (persisted.state !== 'running') return;
    if (!persisted.firstRecordedAt && recorder.status().some((f) => f.lastAt))
      persisted.firstRecordedAt = now();
    const stale = (model) =>
      !persisted.trained[model] ||
      now() - persisted.trained[model] > RETRAIN_MS;
    if (
      selected('outbreak-sim') &&
      !datasetJob &&
      stale('outbreak') &&
      fs.existsSync(datasetsDir)
    )
      queueTraining('outbreak');
    // The world model trains on bins, not on the raw tape. Queue it only
    // once every finished day has been binned (startBin does them, oldest
    // first) and enough days exist for a window.
    if (
      feedIds().length &&
      (daysRecorded() >= 1 || binnedDays() >= 1) &&
      !daysToBin().length
    ) {
      if (stale('world')) queueWorldTraining();
      if (stale('links')) queueTraining('links');
      if (persisted.posttrain?.daily && stale('posttrain'))
        queueTraining('posttrain');
      if (
        stale('tracks') &&
        feedIds().some((id) => CIVIL_TRACK_FEEDS.includes(id))
      )
        queueTraining('tracks');
    }
    queueCalibration();
    startPredictor();
    startBin();
    if (!trainer && !trainerQueue.length) settleTrainerLine();
  };

  const tapeDaysOnDisk = () => {
    const tapeRoot = path.join(dataRoot, 'tape');
    const days = [];
    let feedsOnDisk = [];
    try {
      feedsOnDisk = fs.readdirSync(tapeRoot, { withFileTypes: true });
    } catch {
      return days;
    }
    for (const feed of feedsOnDisk) {
      if (!feed.isDirectory() || feed.name.startsWith('.')) continue;
      const feedDir = path.join(tapeRoot, feed.name);
      let years = [];
      try {
        years = fs.readdirSync(feedDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const year of years) {
        if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
        let months = [];
        try {
          months = fs.readdirSync(path.join(feedDir, year.name), {
            withFileTypes: true,
          });
        } catch {
          continue;
        }
        for (const month of months) {
          if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
          let dayDirs = [];
          try {
            dayDirs = fs.readdirSync(
              path.join(feedDir, year.name, month.name),
              { withFileTypes: true },
            );
          } catch {
            continue;
          }
          for (const day of dayDirs)
            if (day.isDirectory() && /^\d{2}$/.test(day.name))
              days.push(`${year.name}/${month.name}/${day.name}`);
        }
      }
    }
    return days;
  };

  const newestHourFile = (dir) => {
    let best = '';
    const walk = (at) => {
      let entries = [];
      try {
        entries = fs.readdirSync(at, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ndjson.gz') && full > best) best = full;
      }
    };
    walk(dir);
    return best;
  };

  const recentTapeRecords = () => {
    const tapeRoot = path.join(dataRoot, 'tape');
    const out = [];
    let names = [];
    try {
      names = fs.readdirSync(tapeRoot, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const feed of names) {
      if (
        !feed.isDirectory() ||
        feed.name === 'military' ||
        feed.name.startsWith('military-')
      )
        continue;
      const file = newestHourFile(path.join(tapeRoot, feed.name));
      if (!file) continue;
      let body = '';
      try {
        body = gunzipSync(fs.readFileSync(file)).toString('utf8');
      } catch {
        continue;
      }
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record && typeof record === 'object')
            out.push({ ...record, feed: feed.name });
        } catch {
          /* a torn line is skipped */
        }
        if (out.length >= 400) return out;
      }
    }
    return out;
  };

  const spawnScript = (script, args, onExit) =>
    createChild({
      command: process.execPath,
      args: [path.join(root, 'scripts', script), ...args],
      cwd: root,
      spawnImpl,
      log: (line) => log(`[bin] ${line}`),
      onExit,
    });

  /**
   * Bin the oldest finished day that has no bin yet, one child at a time;
   * each finished bin starts the next, and training is queued once nothing
   * is left. A world snapshot is built first when there is none.
   */
  function startBin() {
    if (binChild || worldChild || persisted.state !== 'running') return;
    const queue = daysToBin();
    if (!queue.length) return;
    if (!latestWorld(worldsDir)) {
      if (worldBuildFailed) return;
      worldChild = spawnScript('outbreak-world.mjs', [], ({ code }) => {
        worldChild = null;
        if (code === 0) startBin();
        else worldBuildFailed = true;
      });
      return;
    }
    const dayKey = queue[0];
    const day = dayKey.replace(/\//g, '-');
    const left = queue.length - 1;
    // Binning is what training waits for: the TRAINING line says so.
    if (!trainer)
      stages.trainer = {
        ...stages.trainer,
        state: 'waiting',
        model: 'world',
        error: null,
        note: `BINNING ${day} · ${
          left === 0 ? 'LAST DAY' : `${left} DAY${left === 1 ? '' : 'S'} LEFT`
        }`,
      };
    binChild = spawnScript(
      'world-tape-bin.mjs',
      ['--day', day],
      ({ code, tail }) => {
        binChild = null;
        if (persisted.state !== 'running') return;
        if (code !== 0) {
          binFailed.add(dayKey);
          if (!trainer)
            stages.trainer = {
              ...stages.trainer,
              note: null,
              error: `binning ${day} failed: ${tail.at(-1) || `exit ${code}`}`,
            };
        } else if (!trainer) stages.trainer = { ...stages.trainer, note: null };
        startBin();
        if (binChild || worldChild) return;
        queueWorldTraining();
        queueTraining('links');
        if (feedIds().some((id) => CIVIL_TRACK_FEEDS.includes(id)))
          queueTraining('tracks');
      },
    );
  }

  const stopBin = () => {
    binChild?.kill();
    worldChild?.kill();
    binChild = null;
    worldChild = null;
  };

  const startTimers = () => {
    if (!heartbeat) {
      heartbeat = timers.setInterval(save, HEARTBEAT_MS);
      heartbeat?.unref?.();
    }
    if (!scheduler) {
      scheduler = timers.setInterval(schedule, SCHEDULE_MS);
      scheduler?.unref?.();
    }
  };
  const stopTimers = () => {
    if (heartbeat) timers.clearInterval(heartbeat);
    if (scheduler) timers.clearInterval(scheduler);
    heartbeat = scheduler = null;
  };

  const conflict = (message) => {
    const error = new Error(message);
    error.status = 409;
    return error;
  };

  const manager = {
    catalog() {
      return { items: buildCatalog([...feeds.values()]) };
    },
    setSelection(selection) {
      persisted.selection = [...new Set(stripExcluded(selection))].slice(
        0,
        200,
      );
      save();
      if (persisted.state === 'running' || persisted.state === 'paused')
        recorder.setFeeds(feedIds());
      if (persisted.state === 'running' && selected('outbreak-sim'))
        startGenerator();
      if (persisted.state === 'running') {
        startDemographics();
        startAbundance();
      }
      return manager.status();
    },
    estimate({ selection = persisted.selection, capGb } = {}) {
      const list = expand(selection)
        .map((id) => feeds.get(id))
        .filter(Boolean)
        .map((feed) => ({ id: feed.id, bytesPerDay: feed.bytesPerDay || 0 }));
      const bytesPerDay = list.reduce((s, f) => s + f.bytesPerDay, 0);
      const capBytes =
        Number.isFinite(Number(capGb)) && Number(capGb) > 0
          ? Number(capGb) * 1e9
          : persisted.capBytes;
      const used = store.usage().usedBytes + otherUsage().bytes;
      return {
        bytesPerDay,
        feeds: list,
        workers: selection.includes('outbreak-sim')
          ? (datasetWorkers ?? 24)
          : 0,
        gpu: gpu(),
        capBytes,
        daysToCap:
          bytesPerDay > 0 ? Math.max(0, (capBytes - used) / bytesPerDay) : null,
      };
    },
    initialize({ selection, capGb, sim } = {}) {
      if (!['idle', 'stopped'].includes(persisted.state))
        throw conflict('Initialize from idle or stopped only.');
      if (Array.isArray(selection))
        persisted.selection = [...new Set(stripExcluded(selection))].slice(
          0,
          200,
        );
      worldBuildFailed = false;
      const cap = Number(capGb);
      if (Number.isFinite(cap) && cap > 0) persisted.capBytes = cap * 1e9;
      store.setCap(persisted.capBytes);
      if (sim && typeof sim === 'object')
        persisted.sim = {
          ...persisted.sim,
          ...Object.fromEntries(
            ['scenarios', 'runs', 'days', 'seed']
              .filter((k) => Number.isFinite(Number(sim[k])))
              .map((k) => [k, Number(sim[k])]),
          ),
        };
      binFailed.clear();
      lastTrainerFailure = null;
      setState('initializing');
      recorder.setFeeds(feedIds());
      recorder.start();
      setState('running');
      startTimers();
      startGenerator();
      startDemographics();
      startAbundance();
      schedule();
      return manager.status();
    },
    pause() {
      if (persisted.state !== 'running')
        throw conflict('Pause a running job only.');
      recorder.pause();
      datasetJob?.pause();
      pauseTrainer();
      stopPredictor();
      setState('paused');
      return manager.status();
    },
    continue() {
      if (persisted.state !== 'paused')
        throw conflict('Continue a paused job only.');
      setState('running');
      recorder.resume();
      if (datasetJob) datasetJob.continue();
      else startGenerator();
      runTrainer(true);
      schedule();
      return manager.status();
    },
    stop() {
      if (['idle', 'stopped'].includes(persisted.state))
        throw conflict('Nothing is running.');
      setState('stopping');
      recorder.stop();
      datasetJob?.stop();
      stopTrainer();
      stopPredictor();
      stopBin();
      stopTimers();
      trainerQueue = [];
      setState('stopped');
      return manager.status();
    },
    areas() {
      return { areas: areas() };
    },
    newsUrls() {
      return { urls: readNewsUrls(), max: 100 };
    },
    addNewsUrl(url) {
      const next = pushNewsUrl(readNewsUrls(), url);
      writeNewsUrls(next);
      return { urls: next, max: 100 };
    },
    removeNewsUrl(url) {
      const next = dropNewsUrl(readNewsUrls(), url);
      writeNewsUrls(next);
      return { urls: next, max: 100 };
    },
    markets() {
      return { quotes: readMarketFile().quotes };
    },
    /** Add an area (the same point again changes nothing). */
    addArea(raw) {
      const area = cleanArea(raw);
      if (!area)
        throw Object.assign(
          new Error('An area needs a latitude and longitude.'),
          {
            status: 400,
          },
        );
      const list = areas();
      if (!list.some((a) => a.key === area.key)) {
        if (list.length >= AREAS_MAX)
          throw conflict(`At most ${AREAS_MAX} areas.`);
        list.push(area);
        writeAreas(list);
      }
      return { areas: list };
    },
    /** Stop recording around an area; what was recorded there stays. */
    removeArea(key) {
      const list = areas();
      const kept = list.filter((a) => a.key !== String(key ?? ''));
      if (kept.length !== list.length) writeAreas(kept);
      return { areas: kept };
    },
    deletePreview(scope = 'all') {
      return deletePreview(dataRoot, scope);
    },
    deleteListed(scope, token) {
      if (!['idle', 'stopped'].includes(persisted.state))
        throw conflict('Stop before deleting.');
      const result = deleteListed(dataRoot, scope, token);
      store.rescan();
      usageCache = null;
      return { deleted: result };
    },
    async predict({ domain, horizon = 24, bbox = null } = {}) {
      const horizonHours = Math.max(1, Math.min(168, Number(horizon) || 24));
      if (!knownDomain(domain))
        throw Object.assign(new Error('Unknown domain'), { status: 400 });
      if (domain === 'all') {
        const predictions = [];
        for (const id of trainedDomains())
          predictions.push(
            await manager.predict({ domain: id, horizon: horizonHours, bbox }),
          );
        return { domain: 'all', horizonHours, predictions };
      }
      const learning = {
        domain,
        horizonHours,
        generatedAt: now(),
        skill: null,
        learning: {
          daysRecorded: Math.round(daysRecorded() * 10) / 10,
          daysBinned: binnedDays(),
          needed: 7,
        },
        points: [],
        tracks: [],
      };
      const asked = ['flights', 'vessels', 'transit'].includes(domain)
        ? 'tracks'
        : domain;
      if (!predictor) {
        const cached = readJson(
          path.join(predictionsDir, `${domain}.json`),
          null,
        );
        return cached || learning;
      }
      const id = nextId++;
      const answer = await new Promise((resolve) => {
        pending.set(id, resolve);
        predictor.child.send({
          id,
          cmd: 'predict',
          domain: asked,
          horizon: horizonHours,
          bbox,
        });
        timers
          .setTimeout(() => {
            if (pending.delete(id)) resolve({ ok: false, error: 'timed out' });
          }, 30_000)
          ?.unref?.();
      });
      if (!answer.ok) return learning;
      const result = { ...answer.result, domain };
      if (
        domain === 'flights' ||
        domain === 'vessels' ||
        domain === 'transit'
      ) {
        const kind = domain === 'vessels' ? 'vessels' : domain;
        result.tracks = (result.tracks || []).filter(
          (track) => track?.kind === kind,
        );
      }
      fs.mkdirSync(predictionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(predictionsDir, `${domain}.json`),
        JSON.stringify(result),
      );
      stages.predictor.updatedAt = now();
      return result;
    },
    async infer({ kind, query, lat, lon, horizon = 24 } = {}) {
      const horizonHours = Math.max(1, Math.min(168, Number(horizon) || 24));
      const matched = matchInfer({
        kind,
        query,
        lat,
        lon,
        records: recentTapeRecords(),
      });
      const base = {
        domain: 'infer',
        inferred: true,
        kind: matched.kind,
        matched: matched.matched,
        horizonHours,
        generatedAt: now(),
        skill: null,
        learning: null,
        points: [],
        tracks: [],
        note: matched.note,
      };
      if (!matched.matched.length) return base;
      const lats = matched.matched
        .map((item) => item.lat)
        .filter(Number.isFinite);
      const lons = matched.matched
        .map((item) => item.lon)
        .filter(Number.isFinite);
      const bbox =
        lats.length && lons.length
          ? [
              Math.min(...lons) - 1,
              Math.min(...lats) - 1,
              Math.max(...lons) + 1,
              Math.max(...lats) + 1,
            ]
          : null;
      const ready = trainedDomains();
      if (!ready.length) {
        return {
          ...base,
          note: 'LEARNING',
          learning: {
            daysRecorded: Math.round(daysRecorded() * 10) / 10,
            daysBinned: binnedDays(),
            needed: 7,
          },
        };
      }
      const points = [];
      const tracks = [];
      for (const domain of ready) {
        const prediction = await manager.predict({
          domain,
          horizon: horizonHours,
          bbox,
        });
        const kept = filterPrediction(prediction, matched.matched);
        points.push(...kept.points);
        tracks.push(...kept.tracks);
      }
      if (!points.length && !tracks.length)
        return { ...base, note: base.note || 'LEARNING' };
      return { ...base, note: null, points, tracks };
    },
    status() {
      const catalogIds = new Set(
        buildCatalog([...feeds.values()]).map((i) => i.id),
      );
      const live = new Map(recorder.status().map((f) => [f.id, f]));
      const usage = store.usage();
      const feedsStatus = [...catalogIds].map((id) => {
        const f = live.get(id);
        const u = usage.byFeed[id] || {};
        const isFeed = Boolean(feeds.get(id)?.poll);
        return {
          id,
          state: f?.state || (isFeed ? 'off' : 'static'),
          records: u.records || 0,
          bytes: u.bytes || 0,
          recordsToday: u.recordsToday || 0,
          bytesToday: u.bytesToday || 0,
          lastAt: f?.lastAt ?? null,
          error: f?.error ?? null,
        };
      });
      // The YOUR DEVICES row: its personal feeds together, recording when
      // any of them is.
      const personal = feedsStatus.filter((f) => deviceFeeds().includes(f.id));
      const total = (key) => personal.reduce((sum, f) => sum + f[key], 0);
      const latest = Math.max(...personal.map((f) => f.lastAt ?? -Infinity));
      const devicesRow = personal.length
        ? {
            id: 'devices',
            state:
              DEVICE_STATE_ORDER.find((state) =>
                personal.some((f) => f.state === state),
              ) || 'off',
            records: total('records'),
            bytes: total('bytes'),
            recordsToday: total('recordsToday'),
            bytesToday: total('bytesToday'),
            lastAt: Number.isFinite(latest) ? latest : null,
            error: personal.find((f) => f.error)?.error ?? null,
          }
        : null;
      const other = otherUsage();
      let freeBytes = null;
      try {
        fs.mkdirSync(dataRoot, { recursive: true });
        const s = fs.statfsSync(dataRoot);
        freeBytes = Number(s.bavail) * Number(s.bsize);
      } catch {
        /* unknown */
      }
      const recording = feedsStatus.filter((f) => f.state === 'recording');
      return {
        state: persisted.state,
        since: persisted.since,
        selection: persisted.selection,
        capBytes: persisted.capBytes,
        feeds: devicesRow ? [...feedsStatus, devicesRow] : feedsStatus,
        stages: {
          recorder: {
            state:
              recorder.state === 'running'
                ? 'running'
                : recorder.state === 'paused'
                  ? 'paused'
                  : feedIds().length
                    ? 'waiting'
                    : 'off',
            feeds: recording.length,
            bytesPerDay: feedsStatus.reduce(
              (s, f) => s + (f.bytesToday || 0),
              0,
            ),
          },
          generator: { ...stages.generator },
          trainer: trainerStatus(),
          predictor: { ...stages.predictor, domains: trainedDomains() },
        },
        storage: {
          usedBytes: usage.usedBytes + other.bytes,
          freeBytes,
          byKind: { tape: usage.usedBytes, ...other.byKind },
        },
        compute: {
          workers: datasetJob ? (datasetWorkers ?? 24) : 0,
          busy: datasetJob ? datasetJob.status().running : 0,
          gpu: gpu(),
        },
        gaps: store.gaps().slice(-50),
        learning: {
          daysRecorded: Math.round(daysRecorded() * 10) / 10,
          daysBinned: binnedDays(),
        },
        areas: areas(),
        links: measuredLinks(),
        posttrain: postTrainStatus(),
      };
    },
    /**
     * POST-TRAIN: keep the adapter, the checkpoint and DAILY; with `run`,
     * queue a post-training now (the work must be running).
     */
    setPostTrain(body) {
      persisted.posttrain = cleanPostTrain(body, { root, dataRoot });
      save();
      if (body?.run === true) {
        if (persisted.state !== 'running')
          throw conflict('INITIALIZE first: post-training runs with the rest.');
        queueTraining('posttrain', { force: true });
      }
      return { posttrain: postTrainStatus() };
    },
    /** After a server restart: pick up where the tab left off. */
    restore() {
      const was = persisted.state;
      if (was === 'running' || was === 'initializing') {
        recorder.restarted(persisted.lastSeenAt);
        persisted.state = 'running';
        save();
        recorder.setFeeds(feedIds());
        recorder.start();
        startTimers();
        startGenerator();
        startDemographics();
        startAbundance();
        schedule();
      } else if (was === 'paused') {
        recorder.setFeeds(feedIds());
        startTimers();
      } else if (was === 'stopping') setState('stopped');
      return was;
    },
    /** Shut down with the server: nothing left running, the state kept. */
    close() {
      save();
      recorder.stop('restart');
      datasetJob?.stop();
      stopTrainer();
      stopPredictor();
      stopBin();
      stopTimers();
    },
  };
  return manager;
}
