#!/usr/bin/env node
/**
 * Generate a world-model dataset from the Outbreak model (owner request
 * 2026-10-13): sampled scenarios, run with the tape on a frozen world, into
 * .gev-data/outbreak/datasets/<name>/ (docs/WORLD-MODEL-DATA.md). Resumes
 * from the shards already written; --pilot runs the first scenarios only
 * and projects the size and time of the whole sweep. --drivers starts every
 * scenario on a day the world tape binned onto the world and runs it under
 * the conditions recorded then (humidity, departures, trains, transit).
 * --from-export takes an Outbreak box run saved with DOWNLOAD RESULTS as
 * every scenario's base (its pathogen, places, window and scan flights, on
 * the frozen world); the scenarios differ only in policy and random stream.
 *
 *   node scripts/outbreak-dataset.mjs [--world <dir|id>] [--name <name>]
 *     [--scenarios 2000] [--runs 8] [--days 40] [--seed 1]
 *     [--per-shard 4] [--workers 24] [--compare-share 0.25]
 *     [--drivers [--bins .gev-data/bins]] [--from-export run.json]
 *     [--pilot 20] [--max-gb 200] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './project-root.mjs';
import {
  createDatasetJob,
  datasetSpec,
} from '../server/shared/outbreakDatasetJob.mjs';
import { binnedDays } from '../server/shared/outbreakDatasetDrivers.mjs';
import {
  exportBase,
  readExport,
} from '../server/shared/outbreakExportScenario.mjs';
import { loadWorldSnapshot } from '../server/shared/outbreakWorldStore.mjs';
import { latestWorld } from '../server/shared/outbreakWorldStore.mjs';

export function parseArgs(argv, root = projectRoot(import.meta.url)) {
  const options = {
    root,
    worlds: path.join(root, '.gev-data', 'outbreak', 'worlds'),
    datasets: path.join(root, '.gev-data', 'outbreak', 'datasets'),
    world: null,
    name: null,
    scenarios: 2000,
    runs: 8,
    days: 40,
    seed: 1,
    perShard: 4,
    workers: null,
    compareShare: 0.25,
    pilot: 0,
    maxGb: 200,
    force: false,
    drivers: false,
    bins: path.join(root, '.gev-data', 'bins'),
    fromExport: null,
    scenariosGiven: false,
  };
  const number = (value, name) => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${name} needs a number`);
    return n;
  };
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    const next = () => argv[(k += 1)];
    if (arg === '--world') options.world = next();
    else if (arg === '--name') options.name = next();
    else if (arg === '--scenarios') {
      options.scenarios = number(next(), arg);
      options.scenariosGiven = true;
    } else if (arg === '--runs') options.runs = number(next(), arg);
    else if (arg === '--days') options.days = number(next(), arg);
    else if (arg === '--seed') options.seed = number(next(), arg);
    else if (arg === '--per-shard') options.perShard = number(next(), arg);
    else if (arg === '--workers') options.workers = number(next(), arg);
    else if (arg === '--compare-share')
      options.compareShare = number(next(), arg);
    else if (arg === '--pilot') options.pilot = number(next(), arg);
    else if (arg === '--max-gb') options.maxGb = number(next(), arg);
    else if (arg === '--force') options.force = true;
    else if (arg === '--drivers') options.drivers = true;
    else if (arg === '--from-export')
      options.fromExport = path.resolve(root, next());
    else if (arg === '--bins') options.bins = path.resolve(root, next());
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

/** The world folder: a path, an id under the worlds root, or the newest. */
export function resolveWorld(options) {
  if (options.world) {
    const asPath = path.resolve(options.root, options.world);
    if (fs.existsSync(path.join(asPath, 'world.json'))) return asPath;
    const asId = path.join(options.worlds, options.world);
    if (fs.existsSync(path.join(asId, 'world.json'))) return asId;
    throw new Error(`No world at ${options.world}`);
  }
  const latest = latestWorld(options.worlds);
  if (!latest)
    throw new Error('No world yet: run node scripts/outbreak-world.mjs first.');
  return latest.dir;
}

/** Size and time for the whole sweep, from the shards written so far. */
export function projection(status, spec, workers) {
  if (!status.doneShards) return null;
  const perShardBytes = status.bytes / status.doneShards;
  const shards = Math.ceil(spec.scenarios / spec.perShard);
  return {
    gb: (perShardBytes * shards) / 1e9,
    hours:
      ((status.msPerShard || 0) * shards) / Math.max(1, workers) / 3_600_000,
    episodesPerShard: status.episodes / status.doneShards,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const worldDir = resolveWorld(options);
  const worldId = path.basename(worldDir);
  let drivers = null;
  if (options.drivers) {
    const startDays = binnedDays(options.bins, worldId);
    if (!startDays.length)
      throw new Error(
        `No binned days for world ${worldId} under ${options.bins}: run npm run world-tape:bin first.`,
      );
    drivers = { binsRoot: options.bins, startDays };
    console.log(
      `[dataset] recorded conditions: ${startDays.length} binned day(s) from ${new Date(startDays[0]).toISOString().slice(0, 10)}`,
    );
  }
  let fromExport = null;
  let days = options.days;
  let scenarios = options.scenarios;
  if (options.fromExport) {
    const { doc, sha256 } = readExport(options.fromExport);
    // Checked here once, so a bad file fails before any worker starts.
    const base = exportBase(doc, loadWorldSnapshot(worldDir));
    fromExport = { file: options.fromExport, sha256 };
    days = base.days;
    if (!options.scenariosGiven) scenarios = 200;
    console.log(
      `[dataset] from ${path.basename(options.fromExport)}: ${base.origins.length} outbreak place(s), ${base.flights.length} scan flight(s), ${days} days${base.dropped.flights ? ` (${base.dropped.flights} flight(s) not on this world)` : ''}`,
    );
  }
  const spec = datasetSpec({
    seed: options.seed,
    scenarios,
    runs: options.runs,
    days,
    perShard: options.perShard,
    compareShare: options.compareShare,
    drivers,
    fromExport,
  });
  const name =
    options.name ||
    (fromExport
      ? `export-${fromExport.sha256.slice(0, 12)}-s${spec.seed}`
      : `w${worldId}-s${spec.seed}${drivers ? '-recorded' : ''}`);
  const datasetDir = path.join(options.datasets, name);
  const workers = options.workers ?? undefined;
  let lastLog = 0;
  const job = createDatasetJob({
    root: options.root,
    worldDir,
    datasetDir,
    spec,
    workers,
    maxShards: options.pilot
      ? Math.ceil(options.pilot / spec.perShard)
      : Infinity,
    log: (line) => console.log(`[dataset] ${line}`),
    onProgress: (status) => {
      const now = Date.now();
      if (now - lastLog < 5000 && status.state === 'running') return;
      lastLog = now;
      console.log(
        `[dataset] ${status.state}: ${status.doneShards}/${status.totalShards} shards, ${status.episodes} episodes, ${(status.bytes / 1e6).toFixed(1)} MB${status.etaMs ? `, about ${Math.round(status.etaMs / 60000)} min left` : ''}`,
      );
    },
  });
  const status = await job.start();
  const p = projection(status, spec, workers ?? 24);
  if (p)
    console.log(
      `[dataset] the whole sweep: about ${p.gb.toFixed(1)} GB and ${p.hours.toFixed(1)} h (${p.episodesPerShard.toFixed(1)} episodes a shard)`,
    );
  if (options.pilot && p && p.gb > options.maxGb && !options.force)
    console.log(
      `[dataset] that is over --max-gb ${options.maxGb}: lower --scenarios or --runs, or pass --force`,
    );
  if (status.error) {
    console.error(`[dataset] ${status.error}`);
    process.exitCode = 1;
  }
  console.log(`[dataset] ${status.state} → ${datasetDir}`);
  return { status, datasetDir };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(`[dataset] ${error.message}`);
    process.exitCode = 1;
  });
