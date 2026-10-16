/**
 * A world-model dataset job (owner request 2026-10-13): the scenarios of a
 * sweep, shard by shard, over a pool of worker threads, into
 * .gev-data/outbreak/datasets/<name>/ (docs/WORLD-MODEL-DATA.md). It can be
 * paused (no new shards; those running finish), continued, stopped, and
 * resumed later from the shards already on disk: a shard is a fixed slice
 * of scenarios, so the dataset is the same whatever the scheduling.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  AUX_CHANNELS,
  COUNTRY_ACTIONS,
  CUM_CHANNELS,
  EVENT_KINDS,
  FLOW_KINDS,
  FLOW_MODES,
  GLOBAL_ACTIONS,
  GLOBAL_CHANNELS,
  MAGNITUDE_CONTROLS,
  PLACE_ACTIONS,
  STATE_CHANNELS,
} from '../../src/outbreakEpiTape.mjs';
import { SAMPLER_SCHEMA } from '../../src/outbreakEpiScenarios.mjs';
import { shardName } from './outbreakDatasetEpisodes.mjs';
import { binnedClasses } from './outbreakDatasetDrivers.mjs';

export const DATASET_SCHEMA = 'gev-outbreak-dataset/1';

/** The spec, with defaults. */
export function datasetSpec({
  seed = 1,
  scenarios = 2000,
  runs = 8,
  days = 40,
  perShard = 4,
  compareShare = 0.25,
  policyMix = [0.5, 0.3, 0.2],
  year = 2026,
  drivers = null,
  fromExport = null,
} = {}) {
  return {
    seed: seed >>> 0,
    scenarios: Math.max(1, scenarios | 0),
    runs: Math.max(1, Math.min(500, runs | 0)),
    days: Math.max(1, days | 0),
    perShard: Math.max(1, perShard | 0),
    compareShare,
    policyMix,
    year,
    // A downloaded box run as every scenario's base: the file and the
    // sha256 of its bytes (a resume refuses a changed file).
    ...(fromExport
      ? {
          fromExport: {
            file: String(fromExport.file),
            sha256: String(fromExport.sha256),
          },
        }
      : {}),
    // Recorded conditions: the bins folder and the binned days the sweep
    // starts on, frozen here so a resume draws the same dates.
    ...(drivers
      ? {
          drivers: {
            binsRoot: String(drivers.binsRoot),
            startDays: [...drivers.startDays],
          },
        }
      : {}),
  };
}

/** What made the dataset: package, commit, engine files, Node. */
export function generatorInfo(root) {
  let version = null;
  try {
    version = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    ).version;
  } catch {
    /* unknown */
  }
  const git = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  const engine = createHash('sha256');
  const src = path.join(root, 'src');
  for (const name of fs.readdirSync(src).sort())
    if (/^outbreak.*\.mjs$/.test(name) && !name.endsWith('.test.mjs')) {
      engine.update(name);
      engine.update(fs.readFileSync(path.join(src, name)));
    }
  return {
    package: version,
    commit: git.status === 0 ? git.stdout.trim() : null,
    engineSha256: engine.digest('hex'),
    node: process.version,
    v8: process.versions.v8,
  };
}

const CHANNELS = {
  STATE_CHANNELS,
  CUM_CHANNELS,
  AUX_CHANNELS,
  GLOBAL_CHANNELS,
  GLOBAL_ACTIONS,
  COUNTRY_ACTIONS,
  PLACE_ACTIONS,
  MAGNITUDE_CONTROLS,
  FLOW_KINDS,
  FLOW_MODES,
  EVENT_KINDS,
};

/**
 * The index, keeping only the lines of shards whose file is on disk (a
 * shard written again on resume must not be listed twice); rewritten when
 * anything was dropped.
 */
function readIndex(file, shardsDir) {
  const done = new Set();
  const kept = [];
  let dropped = false;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { done, episodes: 0 };
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      dropped = true;
      continue;
    }
    if (fs.existsSync(path.join(shardsDir, shardName(row.shard)))) {
      done.add(row.shard);
      kept.push(line);
    } else dropped = true;
  }
  if (dropped)
    fs.writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '');
  return { done, episodes: kept.length };
}

/** The card's line on recorded conditions, when the sweep uses them. */
function conditionsLine(spec) {
  const days = spec.drivers?.startDays || [];
  if (!days.length)
    return "- Conditions: the model's own (season formula, typical travel)\n";
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return `- Conditions: recorded — scenarios start on ${days.length} binned day(s), ${iso(days[0])} to ${iso(days.at(-1))}; season from humidity, travel from departures and trains, commuting from transit service (docs/WORLD-MODEL-DATA.md)\n`;
}

/** The dataset card. */
export function datasetCard(meta) {
  return `---
license: other
tags: [epidemiology, world-model, simulation, metapopulation, synthetic]
pretty_name: ${meta.name}
---

# ${meta.name}

Synthetic epidemic episodes from the God's Eye View Outbreak model (a
stochastic hourly metapopulation model with air, rail and commuting links),
generated for training world models (owner request 2026-10-13). Each episode
is one run of one sampled scenario: the state of every country and of
${meta.places} tracked places at every day's end, the interventions applied
each day (exactly, so the run can be replayed), every infected leg, and the
run's first events. The format is docs/WORLD-MODEL-DATA.md.

- Schema: \`${DATASET_SCHEMA}\`; sampler \`${SAMPLER_SCHEMA}\`, seed ${meta.spec.seed}
- World: \`${meta.worldId}\` (${meta.world?.counts?.nodes ?? '?'} places, ${meta.world?.counts?.routes ?? '?'} routes)
- Scenarios: ${meta.spec.scenarios} × ${meta.spec.runs} runs, ${meta.spec.days} days; ${Math.round(meta.spec.compareShare * 100)} % with a paired comparison arm (common random numbers)
${conditionsLine(meta.spec)}- Episodes so far: ${meta.counts.episodes} in ${meta.counts.shards} shards (${(meta.counts.bytes / 1e9).toFixed(2)} GB)
- Generator: package ${meta.generator.package}, commit ${meta.generator.commit ?? 'uncommitted'}, engine sha256 ${meta.generator.engineSha256.slice(0, 16)}…, ${meta.generator.node}

## Limits

This is a scenario tool's output, not observed data. The world is
airport-anchored (no outbreak-specific places, no scan flights), the daily air
routes, commuting and rail flows are model assumptions, and the climate is a
formula (or, with recorded conditions, the world tape's bins where they
exist). Results hold for one V8 build (recorded above).

## Licences and attribution

Everything here stays on the machine that made it unless the owner says
otherwise. Built from: OurAirports (public domain); GeoNames cities500
(CC BY 4.0 — attribution required); World Bank WDI IS.RRS.PASG.KM (CC BY 4.0);
OpenStreetMap rail via OpenMapTiles and OpenFreeMap (ODbL 1.0: the world's
rail routes are a derived database, share-alike if published; the episodes
are produced works and carry this notice). Licence classes: ${(meta.classes || ['open']).join(', ')}.

## Sources of the model

Balcan et al. 2009 (GLEAM); Ferguson et al. 2020; Zipf 1946; Cori et al. 2013;
and the rest listed in docs/outbreak-epidemic-model.md.
`;
}

/**
 * The job.
 *
 * @param {object} options
 * @param {string} options.root The repository (generator info).
 * @param {string} options.worldDir A world snapshot folder.
 * @param {string} options.datasetDir The dataset folder.
 * @param {object} options.spec datasetSpec()
 * @param {number} [options.workers]
 * @param {number} [options.maxShards] Stop after this many shards in all
 *   (a pilot).
 */
export function createDatasetJob({
  root,
  worldDir,
  datasetDir,
  spec,
  workers = Math.max(1, Math.min(24, os.availableParallelism() - 4)),
  maxShards = Infinity,
  log = () => {},
  onProgress = () => {},
  WorkerImpl = Worker,
}) {
  const shardsDir = path.join(datasetDir, 'shards');
  const indexFile = path.join(datasetDir, 'index.jsonl');
  const totalShards = Math.ceil(spec.scenarios / spec.perShard);
  const world = JSON.parse(
    fs.readFileSync(path.join(worldDir, 'world.json'), 'utf8'),
  );
  const state = {
    state: 'idle',
    totalShards,
    doneShards: 0,
    running: 0,
    episodes: 0,
    bytes: 0,
    rawBytes: 0,
    msPerShard: null,
    etaMs: null,
    error: null,
  };
  let queue = [];
  let pool = [];
  const busy = new Set();
  let finish = null;
  let paused = false;
  let stopping = false;
  let shardsThisRun = 0;

  // The classes of what went in: the world is open; recorded conditions add
  // those of the bins they read.
  const classes = spec.drivers
    ? [
        ...new Set([
          'open',
          ...binnedClasses(
            spec.drivers.binsRoot,
            world.worldId,
            spec.drivers.startDays,
          ),
        ]),
      ].sort()
    : ['open'];
  const meta = () => ({
    schema: DATASET_SCHEMA,
    name: path.basename(datasetDir),
    worldId: world.worldId,
    world: { counts: world.counts },
    places: world.counts?.tracked ?? null,
    spec,
    channels: CHANNELS,
    generator: generatorInfo(root),
    counts: {
      scenarios: spec.scenarios,
      shards: state.doneShards,
      episodes: state.episodes,
      bytes: state.bytes,
    },
    licences: world.licences,
    classes,
  });
  const writeMeta = () => {
    const m = meta();
    fs.writeFileSync(
      path.join(datasetDir, 'dataset.json'),
      JSON.stringify(m, null, 2),
    );
    fs.writeFileSync(path.join(datasetDir, 'README.md'), datasetCard(m));
  };

  const settle = () => {
    if (state.running > 0) return;
    const finished = !queue.length || stopping || shardsThisRun >= maxShards;
    if (paused && !stopping && queue.length) {
      state.state = 'paused';
      onProgress({ ...state });
      return;
    }
    if (!finished) return;
    for (const worker of pool) worker.terminate();
    pool = [];
    writeMeta();
    state.state = stopping
      ? 'stopped'
      : queue.length
        ? 'paused-at-limit'
        : 'done';
    onProgress({ ...state });
    finish?.({ ...state });
  };

  const dispatch = (worker) => {
    if (busy.has(worker)) return undefined;
    if (paused || stopping || shardsThisRun >= maxShards) return settle();
    const shard = queue.shift();
    if (shard === undefined) return settle();
    shardsThisRun += 1;
    state.running += 1;
    busy.add(worker);
    worker.postMessage({ type: 'shard', shard });
    return undefined;
  };

  const onMessage = (worker, message) => {
    if (message.type === 'ready') return dispatch(worker);
    if (message.type === 'failed') {
      busy.delete(worker);
      state.running -= 1;
      state.error = message.error;
      log(`shard ${message.shard} failed: ${message.error}`);
      stopping = true;
      return settle();
    }
    if (message.type !== 'done') return;
    const r = message.result;
    busy.delete(worker);
    state.running -= 1;
    state.doneShards += 1;
    state.episodes += r.episodes;
    state.bytes += r.bytes;
    state.rawBytes += r.rawBytes;
    fs.appendFileSync(
      indexFile,
      r.lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    );
    state.msPerShard =
      state.msPerShard === null ? r.ms : state.msPerShard * 0.8 + r.ms * 0.2;
    state.etaMs = Math.round(
      (state.msPerShard * queue.length) / Math.max(1, pool.length),
    );
    onProgress({
      ...state,
      last: { shard: r.shard, bytes: r.bytes, episodes: r.episodes },
    });
    dispatch(worker);
  };

  return {
    status: () => ({ ...state }),
    start() {
      fs.mkdirSync(shardsDir, { recursive: true });
      // Resume: shards in the index are done; a half-written one restarts.
      const { done, episodes } = readIndex(indexFile, shardsDir);
      for (const name of fs.readdirSync(shardsDir))
        if (name.endsWith('.partial'))
          fs.rmSync(path.join(shardsDir, name), { force: true });
      for (let s = 0; s < totalShards; s += 1)
        if (done.has(s) && fs.existsSync(path.join(shardsDir, shardName(s)))) {
          state.doneShards += 1;
          state.bytes += fs.statSync(path.join(shardsDir, shardName(s))).size;
        }
      state.episodes = episodes;
      queue = [];
      for (let s = 0; s < totalShards; s += 1)
        if (!(done.has(s) && fs.existsSync(path.join(shardsDir, shardName(s)))))
          queue.push(s);
      writeMeta();
      state.state = 'running';
      const promise = new Promise((resolve) => {
        finish = resolve;
      });
      if (!queue.length || maxShards <= 0) {
        settle();
        return promise;
      }
      const count = Math.min(workers, queue.length, maxShards);
      log(
        `${queue.length} of ${totalShards} shards to write on ${count} workers`,
      );
      for (let w = 0; w < count; w += 1) {
        const worker = new WorkerImpl(
          new URL('./outbreakDatasetWorker.mjs', import.meta.url),
          { workerData: { worldDir, shardsDir, spec } },
        );
        worker.on('message', (message) => onMessage(worker, message));
        worker.on('error', (error) => {
          state.error = String(error?.message || error);
          log(`worker error: ${state.error}`);
          stopping = true;
          state.running = Math.max(0, state.running - 1);
          settle();
        });
        pool.push(worker);
      }
      return promise;
    },
    pause() {
      if (state.state !== 'running') return false;
      paused = true;
      state.state = state.running ? 'pausing' : 'paused';
      settle();
      return true;
    },
    continue() {
      if (!paused) return false;
      paused = false;
      state.state = 'running';
      for (const worker of pool) dispatch(worker);
      return true;
    },
    stop() {
      stopping = true;
      paused = false;
      state.state = state.running ? 'stopping' : 'stopped';
      settle();
    },
  };
}
