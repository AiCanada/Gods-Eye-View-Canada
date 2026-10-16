#!/usr/bin/env node
/**
 * Bin the world tape onto a world's tracked places (owner request
 * 2026-10-13): each complete UTC day of recorded feeds becomes hourly
 * features in .gev-data/bins/<worldId>/YYYY/MM/DD.<group>.npy
 * (docs/WORLD-MODEL-DATA.md, Bins). NaN where a feed was not observed.
 *
 *   node scripts/world-tape-bin.mjs [--world <dir|id>] [--day 2026-10-13]
 *     [--tape .gev-data/tape] [--out .gev-data/bins] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { projectRoot } from './project-root.mjs';
import { npyBytes } from '../src/outbreakEpiShard.mjs';
import {
  BIN_GROUPS,
  BIN_SOURCES,
  binDay,
  feedsToBin,
  weatherFromGrids,
} from '../src/worldTapeBin.mjs';
import { MARKET_ASSETS } from '../src/marketAssets.mjs';
import { TRAINING_LINKS } from '../src/trainingLinks.mjs';
import {
  latestWorld,
  loadWorldSnapshot,
} from '../server/shared/outbreakWorldStore.mjs';
import { createTapeStore } from '../server/shared/worldTapeStore.mjs';

export function parseArgs(argv, root = projectRoot(import.meta.url)) {
  const options = {
    root,
    tape: path.join(root, '.gev-data', 'tape'),
    out: path.join(root, '.gev-data', 'bins'),
    worlds: path.join(root, '.gev-data', 'outbreak', 'worlds'),
    world: null,
    day: null,
    force: false,
  };
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    const next = () => argv[(k += 1)];
    if (arg === '--world') options.world = next();
    else if (arg === '--day') options.day = next();
    else if (arg === '--tape') options.tape = path.resolve(root, next());
    else if (arg === '--out') options.out = path.resolve(root, next());
    else if (arg === '--force') options.force = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

/** The records of one feed's hour file, or []. */
export function readHour(tapeRoot, feed, day, hour) {
  const file = path.join(
    tapeRoot,
    feed,
    day,
    `${String(hour).padStart(2, '0')}.ndjson.gz`,
  );
  try {
    return gunzipSync(fs.readFileSync(file))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * A recorded grid file's values (little-endian int16, value = q × scale +
 * offset), or null when it is missing, the wrong size or not int16.
 */
export function loadGrid(tapeRoot, record) {
  if (record?.dtype && record.dtype !== 'int16le') return null;
  const n = record?.grid?.nx * record?.grid?.ny;
  const scale = Number(record?.scale);
  const offset = Number(record?.offset);
  if (!(n > 0) || !Number.isFinite(scale) || !Number.isFinite(offset))
    return null;
  try {
    const bytes = fs.readFileSync(path.join(tapeRoot, record.file));
    if (bytes.length !== n * 2) return null;
    const values = new Float32Array(n);
    for (let i = 0; i < n; i += 1)
      values[i] = bytes.readInt16LE(i * 2) * scale + offset;
    return values;
  } catch {
    return null;
  }
}

/** Complete UTC days with any tape, oldest first (today is not complete). */
export function tapeDays(tapeRoot, now = Date.now()) {
  const days = new Set();
  let feeds = [];
  try {
    feeds = fs.readdirSync(tapeRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const today = new Date(now).toISOString().slice(0, 10).replace(/-/g, '/');
  for (const feed of feeds) {
    if (!feed.isDirectory()) continue;
    const base = path.join(tapeRoot, feed.name);
    for (const y of safeList(base))
      for (const m of safeList(path.join(base, y)))
        for (const d of safeList(path.join(base, y, m))) {
          const day = `${y}/${m}/${d}`;
          if (/^\d{4}\/\d{2}\/\d{2}$/.test(day) && day < today) days.add(day);
        }
  }
  return [...days].sort();
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
}

/** Bin one day and write its groups; returns the files written. */
function tapeFeedNames(tapeRoot) {
  try {
    return fs
      .readdirSync(tapeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** assets.json: each market asset by id, as the bins name its channels. */
export function assetsManifest(assets = MARKET_ASSETS) {
  return Object.fromEntries(
    assets.map(({ id, label, group, unit, symbol, hub }) => [
      id,
      { label, group, unit, symbol: symbol || null, hub: hub || null },
    ]),
  );
}

export function binTapeDay({ world, tapeRoot, outRoot, day, store }) {
  const places = Array.from(world.tracked, (i) => world.nodes[i]);
  const { read, extras } = feedsToBin([
    ...Object.values(BIN_SOURCES).flat(),
    ...tapeFeedNames(tapeRoot),
  ]);
  const feeds = new Set(read);
  const hours = {};
  const observedSets = {};
  for (const feed of feeds) {
    hours[feed] = Array.from({ length: 24 }, (_, h) =>
      readHour(tapeRoot, feed, day, h),
    );
    observedSets[feed] = store.observedHours(feed, day);
  }
  const gaps = store.gaps();
  const dayStart = Date.parse(`${day.replace(/\//g, '-')}T00:00:00Z`);
  const inGap = (feed, h) =>
    gaps.some(
      (g) =>
        (!g.feeds?.length || g.feeds.includes(feed)) &&
        g.from < dayStart + (h + 1) * 3_600_000 &&
        g.to > dayStart + h * 3_600_000,
    );
  // Weather from the grids the wind feed recorded that day.
  const isGrid = (r) =>
    typeof r?.file === 'string' && typeof r.var === 'string';
  const grids = (hours.wind || []).flat().filter(isGrid);
  // The next day's first grids too: its 00Z analysis is the nearest field to
  // this day's last hours (a backfilled day has analyses 6 hours apart).
  const nextDay = new Date(dayStart + 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '/');
  for (let h = 0; h < 3; h += 1)
    grids.push(...readHour(tapeRoot, 'wind', nextDay, h).filter(isGrid));
  const bins = binDay({
    places,
    hours,
    observed: (feed, h) =>
      (observedSets[feed]?.has(h) || hours[feed]?.[h]?.length > 0) &&
      !inGap(feed, h),
    weatherAt: grids.length
      ? weatherFromGrids({
          records: grids,
          load: (record) => loadGrid(tapeRoot, record),
          dayStart,
        })
      : null,
    countFeeds: extras,
  });
  const dir = path.join(outRoot, world.worldId, ...day.split('/').slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  const stem = day.split('/')[2];
  const written = [];
  for (const [group, { data, shape }] of Object.entries(bins)) {
    const file = path.join(dir, `${stem}.${group}.npy`);
    fs.writeFileSync(file, npyBytes(data, shape));
    written.push(file);
  }
  // The licence classes each group was built from (every record carries
  // its class), so a model trained on the bins knows what it may share.
  const classes = {};
  for (const [group, sources] of Object.entries(BIN_SOURCES)) {
    const seen = new Set();
    for (const feed of sources)
      for (const records of hours[feed] || [])
        for (const r of records) seen.add(r.class || 'unclear');
    classes[group] = [...seen].sort();
  }
  const classesFile = path.join(dir, `${stem}.classes.json`);
  fs.writeFileSync(classesFile, JSON.stringify(classes, null, 2));
  written.push(classesFile);
  const channels = {};
  for (const [group, bin] of Object.entries(bins))
    channels[group] = bin.channels
      ? [...bin.channels]
      : [...(BIN_GROUPS[group] || ['count'])];
  fs.writeFileSync(
    path.join(outRoot, world.worldId, 'channels.json'),
    JSON.stringify(channels, null, 2),
  );
  const linksFile = path.join(outRoot, world.worldId, 'links.json');
  fs.writeFileSync(linksFile, JSON.stringify(TRAINING_LINKS, null, 2));
  written.push(linksFile);
  // The assets behind the `markets` and `news-markets` channels: name,
  // group, unit, quote symbol, and where each benchmark is set (null for
  // an asset with no home), so a model's price moves can be placed.
  const assetsFile = path.join(outRoot, world.worldId, 'assets.json');
  fs.writeFileSync(assetsFile, JSON.stringify(assetsManifest(), null, 2));
  written.push(assetsFile);
  return written;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const worldDir = options.world
    ? fs.existsSync(path.join(options.world, 'world.json'))
      ? options.world
      : path.join(options.worlds, options.world)
    : latestWorld(options.worlds)?.dir;
  if (!worldDir)
    throw new Error('No world yet: run node scripts/outbreak-world.mjs first.');
  const world = loadWorldSnapshot(worldDir);
  const store = createTapeStore({ root: options.tape });
  const days = options.day
    ? [options.day.replace(/-/g, '/')]
    : tapeDays(options.tape);
  let count = 0;
  for (const day of days) {
    const done = path.join(
      options.out,
      world.worldId,
      ...day.split('/').slice(0, 2),
      `${day.split('/')[2]}.mobility.npy`,
    );
    if (fs.existsSync(done) && !options.force) continue;
    binTapeDay({
      world,
      tapeRoot: options.tape,
      outRoot: options.out,
      day,
      store,
    });
    count += 1;
    console.log(`[bin] ${day} → ${world.worldId}`);
  }
  console.log(`[bin] ${count} day(s) binned`);
  return count;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(`[bin] ${error.message}`);
    process.exitCode = 1;
  });
