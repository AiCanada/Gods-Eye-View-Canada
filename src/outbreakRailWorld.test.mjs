/**
 * EVERY RAIL LINE ON THE GLOBE (owner ruling 2026-10-12): the land mask,
 * the polite sweep, the world network built from it, and the tile store's
 * share of the politeness. No test here reaches OpenFreeMap: every tile
 * comes from a fake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RAIL_WORLD_ZOOM,
  clipLinesToBox,
  continentOf,
  countryLookup,
  countryShapes,
  landJoinOk,
  railExtract,
  railExtractLines,
  railRetryDelayMs,
  railSweepOrder,
  railTileName,
  railWorldTiles,
} from './outbreakRailWorld.mjs';
import {
  buildRailGraph,
  railComponents,
  railVertexIndex,
  tileBounds,
  tileOf,
  unpackRailGraph,
} from './outbreakNetwork.mjs';
import {
  railWorldJob,
  readRailPassengerKm,
} from '../server/providers/outbreakRailWorld.js';
import { runRailWorldTask } from '../server/providers/outbreakRailWorldTasks.mjs';
import {
  networkTileStore,
  retryAfterMs,
} from '../server/providers/outbreak.js';

const COUNTRIES = JSON.parse(
  fs.readFileSync(
    new URL('./data/local_data/natural_earth/countries.json', import.meta.url),
    'utf8',
  ),
);

/** A country as the Natural Earth pack has it: one square ring, 3 decimals. */
function square(iso2, west, south, east, north) {
  const k = 1000;
  return {
    name: iso2,
    iso2,
    iso: `${iso2}X`,
    polygons: [
      [
        [
          west * k,
          south * k,
          (east - west) * k,
          0,
          0,
          (north - south) * k,
          (west - east) * k,
          0,
        ],
      ],
    ],
  };
}

test('the land mask: every land tile at zoom 8, one wider, without Antarctica or the far south', () => {
  const tiles = railWorldTiles(COUNTRIES);
  assert.ok(
    tiles.length > 15_000 && tiles.length < 25_000,
    `${tiles.length} tiles`,
  );
  const have = new Set(tiles.map((t) => `${t.x}/${t.y}`));
  const has = (lat, lon) => {
    const t = tileOf(lat, lon, RAIL_WORLD_ZOOM);
    return have.has(`${t.x}/${t.y}`);
  };
  assert.ok(has(48.85, 2.35), 'Paris');
  assert.ok(has(52.29, 104.3), 'Irkutsk');
  assert.ok(has(45.27, -66.06), 'Saint John NB');
  assert.ok(has(35.9, 14.5), 'Malta');
  assert.ok(has(19.7, -155.1), 'Hawaii');
  assert.ok(!has(0, -150), 'the middle of the Pacific');
  assert.ok(!has(-75, 0), 'Antarctica');
  assert.ok(tiles.every((t) => tileBounds(t.z, t.x, t.y).north > -60));
  // A small country: its own tiles, then one wider; the far south left out.
  const small = railWorldTiles([
    square('FR', 2, 48, 3, 49),
    square('AQ', 0, -80, 10, -75),
    square('GS', -40, -66, -38, -64),
  ]);
  assert.ok(small.length >= 9 && small.length <= 30, `${small.length}`);
  assert.ok(small.some((t) => t.country === 'FR'));
  assert.ok(
    small.some((t) => t.country === ''),
    'the widening',
  );
  const lookup = countryLookup(small);
  assert.equal(lookup(48.5, 2.5), 'FR');
  assert.equal(lookup(10, 10), '');
});

test('continents, the sweep order, the extract and the retry waits', () => {
  assert.equal(continentOf('FR'), 'EU');
  assert.equal(continentOf('RU', 37), 'EU');
  assert.equal(continentOf('RU', 104), 'AS', 'east of the Urals');
  assert.equal(continentOf('CA'), 'NA');
  assert.equal(continentOf('BR'), 'SA');
  assert.equal(continentOf('KE'), 'AF');
  assert.equal(continentOf('AU'), 'OC');
  assert.equal(continentOf('XX'), '');
  const tiles = [
    { z: 8, x: 0, y: 100 },
    { z: 8, x: 128, y: 90 },
    { z: 8, x: 150, y: 80 },
  ];
  const near = tileBounds(8, 150, 80);
  const ordered = railSweepOrder(tiles, [
    { lat: (near.north + near.south) / 2, lon: (near.west + near.east) / 2 },
  ]);
  assert.deepEqual(
    ordered.map((t) => t.x),
    [150, 128, 0],
    'nearest the outbreak first',
  );
  assert.deepEqual(railSweepOrder(tiles, []), tiles);
  const extract = railExtract(
    [
      [
        [1.123456789, 2.5],
        [1.2, 2.6],
      ],
      [[5, 5]],
    ],
    9,
  );
  assert.deepEqual(extract.rail, [[1.12346, 2.5, 1.2, 2.6]]);
  assert.equal(extract.fetchedAt, 9);
  assert.deepEqual(railExtractLines(extract), [
    [
      [1.12346, 2.5],
      [1.2, 2.6],
    ],
  ]);
  assert.equal(railTileName({ x: 3, y: 4 }), '3_4');
  assert.deepEqual(
    [1, 2, 3, 9].map(railRetryDelayMs),
    [300_000, 1_800_000, 7_200_000, 7_200_000],
  );
  // The World Bank's table: countries only, no aggregates, no gaps.
  const read = readRailPassengerKm([
    {},
    [
      { country: { id: 'FR' }, date: '2021', value: 86853 },
      { country: { id: 'XC' }, date: '2021', value: 2052 },
      { country: { id: 'EU' }, date: '2021', value: 1 },
      { country: { id: 'DE' }, date: '2020', value: null },
    ],
  ]);
  assert.deepEqual(read.pkm, { FR: 86853 });
  assert.deepEqual(read.years, { FR: '2021' });
});

/** A fake tile store: one rail line along the middle of each tile. */
function fakeStore({ cachedTiles = new Set(), failOnce = new Set() } = {}) {
  const fetched = [];
  let open = 0;
  let most = 0;
  const lineOf = (tile) => {
    const b = tileBounds(tile.z, tile.x, tile.y);
    const lat = Math.round(((b.north + b.south) / 2) * 1e5) / 1e5;
    return {
      motorway: [],
      major: [],
      primary: [],
      rail: [
        [
          [b.west, lat],
          [b.east, lat],
        ],
      ],
    };
  };
  return {
    fetched,
    most: () => most,
    cached: (tile) =>
      cachedTiles.has(`${tile.x}/${tile.y}`) ? lineOf(tile) : null,
    async lines(tile) {
      const key = `${tile.x}/${tile.y}`;
      fetched.push(key);
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 2));
      open -= 1;
      if (failOnce.has(key)) {
        failOnce.delete(key);
        return null;
      }
      return lineOf(tile);
    },
  };
}

const fakeTimers = () => {
  const scheduled = [];
  return {
    scheduled,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      const i = scheduled.indexOf(handle);
      if (i >= 0) scheduled.splice(i, 1);
    },
  };
};

test('the sweep: each tile once, six at a time, kept ones never fetched, a failure asked again later, then one world network', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-rail-world-'));
  try {
    const countries = [square('FR', 2, 48, 3.5, 49.5)];
    const all = railWorldTiles(countries);
    const keyOf = (t) => `${t.x}/${t.y}`;
    // One tile the store already has on disk (old): never fetched.
    const kept = keyOf(all[0]);
    // One that fails the first time.
    const flaky = keyOf(all[all.length - 1]);
    const store = fakeStore({
      cachedTiles: new Set([kept]),
      failOnce: new Set([flaky]),
    });
    const timers = fakeTimers();
    let clock = Date.UTC(2026, 9, 12);
    const job = railWorldJob({
      cacheDir: dir,
      tileStore: store,
      countries,
      timers,
      now: () => clock,
    });
    assert.equal(job.status().state, 'idle');
    job.start([{ lat: 48.5, lon: 2.5 }]);
    await job.settled();
    assert.ok(!store.fetched.includes(kept), 'a kept tile is never fetched');
    assert.equal(
      new Set(store.fetched).size,
      store.fetched.length,
      'no tile fetched twice',
    );
    assert.equal(store.fetched.length, all.length - 1);
    assert.ok(store.most() <= 6 && job.maxInFlight() <= 6, `${store.most()}`);
    let status = job.status();
    assert.equal(status.state, 'ready', status.error || '');
    assert.equal(status.tilesTotal, all.length);
    assert.equal(status.tilesDone, all.length - 1);
    assert.equal(status.tilesFailed, 1);
    assert.equal(status.tilesCached, 1);
    assert.ok(status.railKm > 100, `${status.railKm} km`);
    assert.ok(status.byContinent.EU > 100);
    assert.ok(job.ready());
    // The failed tile is asked again after 5 minutes.
    const retry = timers.scheduled.find((t) => t.ms > 1000);
    assert.ok(retry && retry.ms <= 5 * 60_000);
    clock += 5 * 60_000 + 1;
    retry.fn();
    await job.settled();
    status = job.status();
    assert.equal(status.tilesFailed, 0);
    assert.equal(status.tilesDone, all.length);
    assert.equal(store.fetched.filter((k) => k === flaky).length, 2);
    // Every extract is on disk, with no expiry of its own.
    const extracts = fs.readdirSync(path.join(dir, 'rail-world', 'z8'));
    assert.equal(extracts.length, all.length);
    // The world network answers from the location along every line.
    const reach = await job.task({
      kind: 'network',
      point: { lat: 48.6, lon: 2.6 },
      overlay: [],
      startKm: 30,
    });
    assert.equal(reach.network.world, true);
    assert.ok(reach.network.reachedKm > 50);
    assert.deepEqual(reach.network.unreached, []);
    // A restart resumes: nothing fetched again, the build read back.
    const again = fakeStore();
    const second = railWorldJob({
      cacheDir: dir,
      tileStore: again,
      countries,
      timers: fakeTimers(),
    });
    second.start();
    await second.settled();
    assert.equal(again.fetched.length, 0);
    assert.equal(second.status().state, 'ready');
    assert.equal(second.status().tilesDone, all.length);
    assert.ok(second.near({ lat: 48.6, lon: 2.6 }, 30));
    assert.ok(!second.near({ lat: 10, lon: 10 }, 30));
    // No map tiles of the whole world's rail (owner 2026-10-12).
    assert.equal(second.layerTile, undefined);
    // A tile refreshed by the store for its own reasons: a new build later.
    const timers3 = fakeTimers();
    const third = railWorldJob({
      cacheDir: dir,
      tileStore: fakeStore(),
      countries,
      timers: timers3,
    });
    third.start();
    await third.settled();
    third.noteTile(all[1], {
      rail: [
        [
          [2.1, 48.1],
          [2.2, 48.2],
        ],
      ],
    });
    assert.ok(timers3.scheduled.some((t) => t.ms === 10 * 60_000));
    // The same lines again change nothing.
    const before = timers3.scheduled.length;
    third.noteTile(all[1], {
      rail: [
        [
          [2.1, 48.1],
          [2.2, 48.2],
        ],
      ],
    });
    assert.equal(timers3.scheduled.length, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tile store: one TileJSON for 30 cold tiles, six fetches at once, the sweep behind the page, kept tiles read whatever their age', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-rail-store-'));
  try {
    let tileJson = 0;
    let open = 0;
    let most = 0;
    const order = [];
    const fetchImpl = async (url) => {
      if (url === 'https://tiles.openfreemap.org/planet') {
        tileJson += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(
          JSON.stringify({
            tiles: ['https://tiles.openfreemap.org/planet/1/{z}/{x}/{y}.pbf'],
          }),
          { status: 200 },
        );
      }
      open += 1;
      most = Math.max(most, open);
      order.push(url);
      await new Promise((resolve) => setTimeout(resolve, 3));
      open -= 1;
      return new Response(null, { status: 404 });
    };
    let clock = Date.UTC(2026, 9, 12);
    const heard = [];
    const store = networkTileStore({
      cacheDir: dir,
      fetchImpl,
      now: () => clock,
      onFetched: (tile) => heard.push(tile.x),
    });
    const tiles = Array.from({ length: 30 }, (_, i) => ({
      z: 8,
      x: i,
      y: 90,
    }));
    const page = { z: 8, x: 99, y: 90 };
    const answers = await Promise.all([
      ...tiles.map((tile) => store.lines(tile, { background: true })),
      store.lines(page),
    ]);
    assert.equal(tileJson, 1, 'one TileJSON for every cold tile');
    assert.ok(most <= 6, `${most} at once`);
    assert.ok(
      order.indexOf(order.find((u) => u.includes('/99/'))) < 10,
      'the page’s tile goes before most of the sweep’s',
    );
    assert.ok(answers.every((a) => Array.isArray(a?.rail)));
    assert.equal(heard.length, 31);
    // An empty (404) tile is kept, so it is not asked for again.
    const fresh = networkTileStore({
      cacheDir: dir,
      fetchImpl,
      now: () => clock,
    });
    const before = order.length;
    await fresh.lines(tiles[0]);
    assert.equal(order.length, before);
    // Past thirty days `lines` fetches again; `cached` never does.
    clock += 31 * 86_400_000;
    const later = networkTileStore({
      cacheDir: dir,
      fetchImpl,
      now: () => clock,
    });
    assert.ok(later.cached(tiles[1]), 'read whatever its age');
    assert.equal(order.length, before);
    await later.lines(tiles[1]);
    assert.equal(order.length, before + 1);
    assert.equal(later.cached({ z: 8, x: 200, y: 200 }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('country outlines: a border tile goes by outline, joins over open sea are refused, lines are cut at tile edges (2026-10-12)', () => {
  const shapes = countryShapes(COUNTRIES);
  assert.equal(shapes.countryAt(49.61, 6.13), 'LU', 'Luxembourg');
  assert.equal(shapes.countryAt(1.3, 103.85), 'SG', 'Singapore');
  assert.equal(shapes.countryAt(48.2, 16.37), 'AT', 'Vienna');
  assert.equal(shapes.countryAt(48.2, 16.37, ['DE']), '', 'only among');
  assert.ok(shapes.onLand(48.85, 2.35));
  assert.ok(!shapes.onLand(0, -150), 'the middle of the Pacific');
  // The land mask's lookup: a shared tile by outline, not by alphabet.
  const lookup = countryLookup(railWorldTiles(COUNTRIES), { shapes });
  assert.equal(lookup(49.61, 6.13), 'LU');
  assert.equal(lookup(1.3, 103.85), 'SG');
  assert.equal(lookup(48.85, 2.35), 'FR');
  // Joins over land are allowed; across the Taiwan Strait, refused.
  const ok = landJoinOk((lat, lon) => shapes.onLand(lat, lon));
  assert.ok(ok(48.85, 2.35, 47.9, 1.9), 'Paris to Orléans');
  assert.ok(!ok(24.8, 120.97, 26.07, 119.3), 'Taiwan to Fujian');
  assert.ok(ok(24.8, 120.97, 24.8, 120.99), 'a short join is always allowed');
  // Two tiles that share an edge, each with the first point past it: cut,
  // they add up to the line once, and meet at one point on the edge.
  const west = tileBounds(8, 134, 90);
  const east = tileBounds(8, 135, 90);
  const lat = (west.north + west.south) / 2;
  const edge = west.east;
  const a = [
    [edge - 0.5, lat],
    [edge - 0.2, lat],
    [edge + 0.3, lat],
  ];
  const b = [
    [edge - 0.2, lat],
    [edge + 0.3, lat],
    [edge + 0.6, lat],
  ];
  const cutA = clipLinesToBox([a], west);
  const cutB = clipLinesToBox([b], east);
  assert.equal(cutA.length, 1);
  assert.equal(cutB.length, 1);
  assert.deepEqual(cutA[0].at(-1), cutB[0][0], 'the same point on the edge');
  assert.ok(Math.abs(cutA[0].at(-1)[0] - edge) < 1e-9);
  const whole = buildRailGraph([
    [
      [edge - 0.5, lat],
      [edge + 0.6, lat],
    ],
  ]).lengthKm;
  const both = buildRailGraph([...cutA, ...cutB]).lengthKm;
  assert.ok(Math.abs(both - whole) <= 1, `${both} vs ${whole} km`);
  assert.ok(
    buildRailGraph([a, b]).lengthKm > whole + 20,
    'uncut, the stretch across the edge is counted twice',
  );
  assert.deepEqual(
    clipLinesToBox(
      [
        [
          [edge + 1, lat],
          [edge + 2, lat],
        ],
      ],
      west,
    ),
    [],
    'a line wholly outside is left out',
  );
});

test('the world build: lines cut at tile edges, a border tile split by outline, no join over open sea (2026-10-12)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-rail-build-'));
  try {
    const countries = [
      square('DE', 8, 48, 12, 50),
      square('AT', 12, 48, 14, 50),
      square('MT', 14, 35.8, 14.5, 36.2),
      square('IT', 14, 37, 16, 39),
    ];
    const countriesFile = path.join(dir, 'countries.json');
    fs.writeFileSync(countriesFile, JSON.stringify(countries));
    const extractDir = path.join(dir, 'z8');
    fs.mkdirSync(extractDir);
    const byTile = new Map();
    const put = (name, line) => {
      if (!byTile.has(name)) byTile.set(name, []);
      byTile.get(name).push(line);
    };
    const nameAt = (lat, lon) => railTileName(tileOf(lat, lon, 8));
    // A line across the edge of two tiles at 49° N, each tile with the
    // first point past the edge, as the tiles have it.
    const row = tileOf(49, 9, 8).y;
    const edge = tileBounds(8, 134, row).east;
    put(`134_${row}`, [
      [edge - 0.5, 49],
      [edge - 0.2, 49],
      [edge + 0.3, 49],
    ]);
    put(`135_${row}`, [
      [edge - 0.2, 49],
      [edge + 0.3, 49],
      [edge + 0.6, 49],
    ]);
    // In the tile Germany shares with Austria, on the German side.
    put(nameAt(49, 11.4), [
      [11.4, 49],
      [11.9, 49],
    ]);
    // An island's line 120 km across open sea from the shore's.
    put(nameAt(36, 14.1), [
      [14.1, 36],
      [14.4, 36],
    ]);
    put(nameAt(37.2, 14.1), [
      [14.1, 37.2],
      [15.4, 37.2],
    ]);
    for (const [name, lines] of byTile)
      fs.writeFileSync(
        path.join(extractDir, `${name}.json`),
        JSON.stringify(railExtract(lines, 1)),
      );
    const file = path.join(dir, 'world.bin');
    const meta = runRailWorldTask(file, {
      kind: 'build',
      extractDir,
      tiles: [...byTile.keys()],
      countriesFile,
      builtAt: 1,
      version: 2,
    });
    const km = (deg, at) => deg * 111.19 * Math.cos((at * Math.PI) / 180);
    const de = km(1.1, 49) + km(0.5, 49);
    assert.ok(
      Math.abs(meta.byCountry.DE - de) <= 2,
      `${meta.byCountry.DE} km in Germany, ${de.toFixed(1)} expected`,
    );
    assert.ok(!meta.byCountry.AT, 'none of it in Austria');
    assert.ok(meta.refusedJoins > 0);
    assert.ok(meta.byContinent.EU > 200);
    const graph = unpackRailGraph(fs.readFileSync(file));
    const comp = railComponents(graph);
    const index = railVertexIndex(graph);
    const at = (lat, lon) => comp[index.nearest({ lat, lon }, 1)[0]];
    assert.notEqual(at(36, 14.1), at(37.2, 14.1), 'no join across the sea');
    assert.equal(at(49, 11.9), at(49, edge - 0.5), 'joined over land');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sweep: told to wait, it takes no tile until the wait is over, and the tile is not failed (2026-10-12)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-rail-world-'));
  try {
    const countries = [square('FR', 2, 48, 3.5, 49.5)];
    const all = railWorldTiles(countries);
    let clock = Date.UTC(2026, 9, 12);
    let pausedUntil = 0;
    let asked = 0;
    const base = fakeStore();
    const store = {
      cached: base.cached,
      pausedUntil: () => pausedUntil,
      async lines(tile) {
        asked += 1;
        if (asked === 1) {
          // OpenFreeMap said 429, Retry-After 60 s.
          pausedUntil = clock + 60_000;
          return null;
        }
        assert.ok(clock >= pausedUntil, 'nothing taken while told to wait');
        return base.lines(tile);
      },
    };
    const slept = [];
    const job = railWorldJob({
      cacheDir: dir,
      tileStore: store,
      countries,
      timers: fakeTimers(),
      now: () => clock,
      // The wait passes a moment later, as a real one does.
      sleep: async (ms) => {
        slept.push(ms);
        await new Promise((resolve) => setTimeout(resolve, 5));
        clock = Math.max(clock, pausedUntil);
      },
    });
    job.start();
    await job.settled();
    const status = job.status();
    assert.equal(status.tilesFailed, 0, 'the wait is not the tile’s failure');
    assert.equal(status.pauses, 1);
    assert.equal(status.tilesDone, all.length);
    assert.equal(new Set(base.fetched).size, all.length);
    assert.ok(slept.length >= 1 && slept[0] <= 60_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restart keeps each failed tile’s wait, and the world says which tiles near a point it still lacks (2026-10-12)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-rail-world-'));
  try {
    const countries = [square('FR', 2, 48, 3.5, 49.5)];
    const all = railWorldTiles(countries);
    const flaky = all[all.length - 1];
    const flakyKey = `${flaky.x}/${flaky.y}`;
    let clock = Date.UTC(2026, 9, 12);
    const first = railWorldJob({
      cacheDir: dir,
      tileStore: fakeStore({ failOnce: new Set([flakyKey]) }),
      countries,
      timers: fakeTimers(),
      now: () => clock,
    });
    first.start();
    await first.settled();
    assert.equal(first.status().tilesFailed, 1);
    const b = tileBounds(flaky.z, flaky.x, flaky.y);
    const mid = { lat: (b.north + b.south) / 2, lon: (b.west + b.east) / 2 };
    assert.equal(first.missingNear([mid], 10), 1);
    assert.equal(first.missingNear([{ lat: 10, lon: 10 }], 10), 0);
    // A restart before its 5 minutes are up: not asked again yet, but its
    // retry is set.
    const again = fakeStore();
    const timers = fakeTimers();
    const second = railWorldJob({
      cacheDir: dir,
      tileStore: again,
      countries,
      timers,
      now: () => clock,
    });
    second.start();
    await second.settled();
    assert.equal(again.fetched.length, 0, 'nothing asked at the restart');
    assert.equal(second.status().tilesFailed, 1);
    assert.equal(second.missingNear([mid], 10), 1);
    const retry = timers.scheduled.find((t) => t.ms > 1000);
    assert.ok(retry && retry.ms <= 5 * 60_000, `${retry?.ms} ms`);
    clock += 5 * 60_000 + 1;
    retry.fn();
    await second.settled();
    assert.deepEqual(again.fetched, [flakyKey]);
    assert.equal(second.status().tilesFailed, 0);
    assert.equal(second.missingNear([mid], 10), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tile store: a failed TileJSON is not asked again for two minutes, and a 429 stops every fetch for its Retry-After (2026-10-12)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-rail-store-'));
  try {
    let tileJson = 0;
    let tileJsonUp = false;
    let tiles = 0;
    const fetchImpl = async (url) => {
      if (url === 'https://tiles.openfreemap.org/planet') {
        tileJson += 1;
        if (!tileJsonUp) return new Response('busy', { status: 503 });
        return new Response(
          JSON.stringify({
            tiles: ['https://tiles.openfreemap.org/planet/1/{z}/{x}/{y}.pbf'],
          }),
          { status: 200 },
        );
      }
      tiles += 1;
      return new Response('slow down', {
        status: 429,
        headers: { 'Retry-After': '120' },
      });
    };
    let clock = Date.UTC(2026, 9, 12);
    const store = networkTileStore({
      cacheDir: dir,
      fetchImpl,
      now: () => clock,
    });
    const many = Array.from({ length: 30 }, (_, i) => ({ z: 8, x: i, y: 91 }));
    const answers = await Promise.all(
      many.map((tile) => store.lines(tile, { background: true })),
    );
    assert.ok(answers.every((a) => a === null));
    assert.equal(tileJson, 1, 'one TileJSON for every tile, not one each');
    assert.equal(tiles, 0);
    assert.ok(store.pausedUntil() > clock);
    // Within the cool-off nothing is asked at all.
    assert.equal(await store.lines({ z: 8, x: 40, y: 91 }), null);
    assert.equal(tileJson, 1);
    // After it, the TileJSON is asked again; the tile says 429.
    clock += 2 * 60_000 + 1;
    tileJsonUp = true;
    assert.equal(await store.lines({ z: 8, x: 41, y: 91 }), null);
    assert.equal(tileJson, 2);
    assert.equal(tiles, 1);
    assert.equal(store.pausedUntil(), clock + 120_000, 'its Retry-After');
    assert.equal(await store.lines({ z: 8, x: 42, y: 91 }), null);
    assert.equal(tiles, 1, 'nothing asked while told to wait');
    clock += 120_001;
    await store.lines({ z: 8, x: 43, y: 91 });
    assert.equal(tiles, 2, 'asked again after the wait');
    // Retry-After as seconds or as a date.
    assert.equal(retryAfterMs('5'), 5000);
    assert.equal(
      retryAfterMs('12 Oct 2026 00:00:30 GMT', Date.UTC(2026, 9, 12)),
      30_000,
    );
    assert.equal(retryAfterMs(''), null);
    assert.equal(retryAfterMs('soon'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
