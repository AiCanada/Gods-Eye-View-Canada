import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { gravityLinks } from '../outbreakEpi.mjs';
import { parseNpy, parseTar } from '../outbreakEpiShard.mjs';
import { trackedPlaces, worldCountries } from '../outbreakEpiTape.mjs';
import {
  loadWorldSnapshot,
  writeWorldSnapshot,
} from '../../server/shared/outbreakWorldStore.mjs';
import {
  createDatasetJob,
  datasetSpec,
} from '../../server/shared/outbreakDatasetJob.mjs';
import { assembleEpidemicNetwork } from '../../server/shared/outbreakEpidemicWorld.mjs';
import { parseArgs as parseWorldArgs } from '../../scripts/outbreak-world.mjs';
import {
  parseArgs as parseDatasetArgs,
  projection,
} from '../../scripts/outbreak-dataset.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HOUR = 3_600_000;

function tinyWorld() {
  const airport = (id, lat, lon, population, country, size = 'M') => ({
    id,
    code: id,
    name: id,
    lat,
    lon,
    population,
    kind: 'airport',
    size,
    country,
  });
  const nodes = [
    airport('AAA', 10, 10, 2_000_000, 'RU', 'L'),
    airport('BBB', 14, 16, 1_500_000, 'RU'),
    airport('CCC', 6, 3, 1_000_000, 'NG'),
    {
      id: 'g1',
      code: '',
      name: 'Town',
      lat: 10.2,
      lon: 10.1,
      population: 60_000,
      kind: 'city',
      country: 'RU',
    },
  ];
  const daily = (from, to, tod, hours, passengers, extra = {}) => ({
    from,
    to,
    timeOfDayMs: tod * HOUR,
    lengthMs: hours * HOUR,
    passengers,
    ...extra,
  });
  const routes = [
    daily(0, 1, 6, 3, 800),
    daily(1, 0, 9, 3, 800),
    daily(0, 2, 7, 5, 300),
    daily(2, 0, 20, 5, 300),
    daily(0, 3, 8, 0.5, 200, { mode: 'rail', km: 25 }),
  ];
  const links = gravityLinks(nodes);
  const { countries, countryOfNode } = worldCountries(nodes);
  return {
    nodes,
    routes,
    flights: [],
    flown: [],
    links,
    tracked: trackedPlaces(nodes, 3),
    countries,
    countryOfNode,
    meta: { sources: [], railSource: 'off' },
  };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gev-dataset-'));
}

function readShard(file) {
  const members = parseTar(new Uint8Array(gunzipSync(fs.readFileSync(file))));
  return new Map(members.map((m) => [m.name, m.bytes]));
}

test('a world snapshot round-trips, and its id is its content', () => {
  const root = tmp();
  try {
    const world = tinyWorld();
    const first = writeWorldSnapshot(world, root);
    assert.match(first.worldId, /^[0-9a-f]{16}$/);
    assert.equal(writeWorldSnapshot(world, root).kept, true);
    const back = loadWorldSnapshot(first.dir);
    assert.equal(back.worldId, first.worldId);
    assert.deepEqual(
      back.nodes.map(({ id, kind, size, country, population }) => ({
        id,
        kind,
        size: size ?? null,
        country,
        population,
      })),
      world.nodes.map(({ id, kind, size, country, population }) => ({
        id,
        kind,
        size: size ?? null,
        country,
        population,
      })),
    );
    assert.deepEqual(back.routes, world.routes);
    assert.deepEqual(back.links, world.links);
    assert.deepEqual(Array.from(back.tracked), Array.from(world.tracked));
    assert.deepEqual(back.countries, world.countries);
    const meta = JSON.parse(
      fs.readFileSync(path.join(first.dir, 'world.json'), 'utf8'),
    );
    assert.equal(meta.schema, 'gev-outbreak-world/1');
    assert.equal(meta.counts.nodes, 4);
    assert.ok(meta.licences.some((l) => /GeoNames/.test(l)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a dataset job: shards of episodes, an index that matches them, resume rewrites the same bytes', async () => {
  const root = tmp();
  try {
    const { dir: worldDir } = writeWorldSnapshot(
      tinyWorld(),
      path.join(root, 'worlds'),
    );
    const datasetDir = path.join(root, 'datasets', 'test');
    const spec = datasetSpec({
      seed: 7,
      scenarios: 6,
      runs: 2,
      days: 4,
      perShard: 2,
    });
    const run = () =>
      createDatasetJob({
        root: ROOT,
        worldDir,
        datasetDir,
        spec,
        workers: 2,
      }).start();
    const status = await run();
    assert.equal(status.state, 'done');
    assert.equal(status.doneShards, 3);
    const lines = fs
      .readFileSync(path.join(datasetDir, 'index.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, status.episodes);
    const shards = path.join(datasetDir, 'shards');
    const names = fs.readdirSync(shards).sort();
    assert.deepEqual(names, [
      'shard-000000.tar.gz',
      'shard-000001.tar.gz',
      'shard-000002.tar.gz',
    ]);
    for (const name of names) {
      const members = readShard(path.join(shards, name));
      const shard = Number(name.slice(6, 12));
      const keys = lines
        .filter((l) => l.shard === shard)
        .map((l) => l.key)
        .sort();
      const inShard = [...members.keys()]
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -5))
        .sort();
      assert.deepEqual(inShard, keys);
      for (const key of keys) {
        const meta = JSON.parse(
          new TextDecoder().decode(members.get(`${key}.json`)),
        );
        assert.equal(meta.schema, 'gev-outbreak-episode/1');
        const g = parseNpy(members.get(`${key}.global.npy`));
        assert.deepEqual(g.shape, [5, 20]);
        const cs = parseNpy(members.get(`${key}.country_state.npy`));
        assert.deepEqual(cs.shape, [5, 3, 15]);
      }
    }
    const meta = JSON.parse(
      fs.readFileSync(path.join(datasetDir, 'dataset.json'), 'utf8'),
    );
    assert.equal(meta.schema, 'gev-outbreak-dataset/1');
    assert.equal(meta.counts.episodes, status.episodes);
    assert.match(
      fs.readFileSync(path.join(datasetDir, 'README.md'), 'utf8'),
      /CC BY 4\.0/,
    );
    // Resume: a lost shard is written again, byte for byte, listed once.
    const lost = path.join(shards, 'shard-000001.tar.gz');
    const before = fs.readFileSync(lost);
    fs.rmSync(lost);
    fs.writeFileSync(`${lost}.partial`, 'half written');
    const again = await run();
    assert.equal(again.state, 'done');
    assert.deepEqual(fs.readFileSync(lost), before);
    assert.equal(fs.existsSync(`${lost}.partial`), false);
    const relisted = fs
      .readFileSync(path.join(datasetDir, 'index.jsonl'), 'utf8')
      .trim()
      .split('\n');
    assert.equal(relisted.length, lines.length);
    assert.equal(
      new Set(relisted.map((l) => JSON.parse(l).key)).size,
      lines.length,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a dataset job pauses (the running shard finishes), continues, and stops at a pilot limit', async () => {
  const root = tmp();
  try {
    const { dir: worldDir } = writeWorldSnapshot(
      tinyWorld(),
      path.join(root, 'worlds'),
    );
    const spec = datasetSpec({
      seed: 9,
      scenarios: 8,
      runs: 1,
      days: 3,
      perShard: 1,
    });
    let job;
    let pausedOnce = false;
    const states = [];
    job = createDatasetJob({
      root: ROOT,
      worldDir,
      datasetDir: path.join(root, 'datasets', 'paused'),
      spec,
      workers: 1,
      onProgress: (status) => {
        states.push(status.state);
        if (!pausedOnce && status.doneShards === 1) {
          pausedOnce = true;
          job.pause();
          setTimeout(() => job.continue(), 50);
        }
      },
    });
    const status = await job.start();
    assert.equal(status.state, 'done');
    assert.equal(status.doneShards, 8);
    assert.ok(states.includes('paused'), states.join(','));
    // A pilot: two shards, then it stops and says so.
    const pilot = await createDatasetJob({
      root: ROOT,
      worldDir,
      datasetDir: path.join(root, 'datasets', 'pilot'),
      spec,
      workers: 2,
      maxShards: 2,
    }).start();
    assert.equal(pilot.state, 'paused-at-limit');
    assert.equal(pilot.doneShards, 2);
    const p = projection(pilot, spec, 2);
    assert.ok(p.gb > 0 && p.episodesPerShard === 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the network assembly: places and daily routes from the tables; rail pending until built, off when off', async () => {
  const airports = [
    { code: 'AAA', name: 'A', lat: 10, lon: 10, country: 'RU', kind: 'L' },
    { code: 'BBB', name: 'B', lat: 14, lon: 16, country: 'RU', kind: 'M' },
  ];
  const byFrom = new Map([
    [
      'AAA',
      [
        {
          from: 'AAA',
          to: 'BBB',
          timeOfDayMs: 6 * HOUR,
          lengthMs: 3 * HOUR,
          passengers: 100,
        },
      ],
    ],
  ]);
  const base = {
    airports,
    byFrom,
    scheduled: [],
    cityRows: [
      {
        id: 1,
        name: 'Near',
        lat: 10.1,
        lon: 10.1,
        country: 'RU',
        population: 50_000,
      },
    ],
    locations: [],
    profile: {},
    scanFlights: [],
    startMs: 0,
    untilMs: 86_400_000,
  };
  const off = await assembleEpidemicNetwork({ ...base, rail: { on: false } });
  assert.equal(off.railSource, 'off');
  assert.equal(off.nodes.length, 2);
  assert.equal(
    off.nodes[0].population,
    50_000,
    'the town folds into its airport',
  );
  assert.deepEqual(
    off.routes.map((r) => [r.from, r.to]),
    [[0, 1]],
  );
  const pending = await assembleEpidemicNetwork({
    ...base,
    rail: { on: true, build: null },
  });
  assert.equal(pending.railSource, 'pending');
});

test('the CLIs read their options', () => {
  const world = parseWorldArgs(['--places', '100', '--no-rail'], ROOT);
  assert.equal(world.places, 100);
  assert.equal(world.rail, false);
  const dataset = parseDatasetArgs(
    ['--scenarios', '10', '--pilot', '4', '--force'],
    ROOT,
  );
  assert.equal(dataset.scenarios, 10);
  assert.equal(dataset.pilot, 4);
  assert.equal(dataset.force, true);
  assert.throws(() => parseDatasetArgs(['--bogus'], ROOT), /Unknown option/);
});

test('recorded conditions: scenarios start on binned days, take their drivers, and say so', async () => {
  const root = tmp();
  try {
    const { npyBytes } = await import('../outbreakEpiShard.mjs');
    const { BIN_GROUPS } = await import('../worldTapeBin.mjs');
    const { writeShard } =
      await import('../../server/shared/outbreakDatasetEpisodes.mjs');
    const { binnedClasses, binnedDays, createBinsDrivers } =
      await import('../../server/shared/outbreakDatasetDrivers.mjs');
    const { dir } = writeWorldSnapshot(tinyWorld(), path.join(root, 'worlds'));
    const world = loadWorldSnapshot(dir);
    const K = world.tracked.length;
    const bins = path.join(root, 'bins');
    const day = (date, humidity, classes) => {
      const [y, m, d] = date.split('-');
      const folder = path.join(bins, world.worldId, y, m);
      fs.mkdirSync(folder, { recursive: true });
      for (const [group, names] of Object.entries(BIN_GROUPS)) {
        const data = new Float32Array(24 * K * names.length).fill(NaN);
        if (group === 'weather')
          for (let h = 0; h < 24; h += 1)
            for (let k = 0; k < K; k += 1)
              data[(h * K + k) * names.length + names.indexOf('humidity')] =
                humidity;
        fs.writeFileSync(
          path.join(folder, `${d}.${group}.npy`),
          npyBytes(data, [24, K, names.length]),
        );
      }
      if (classes)
        fs.writeFileSync(
          path.join(folder, `${d}.classes.json`),
          JSON.stringify(classes),
        );
    };
    day('2026-10-11', 0.004, { weather: ['open'], mobility: ['nc'] });
    day('2026-10-12', 0.016);
    const startDays = binnedDays(bins, world.worldId);
    assert.deepEqual(startDays, [Date.UTC(2026, 9, 11), Date.UTC(2026, 9, 12)]);
    assert.deepEqual(binnedClasses(bins, world.worldId, startDays), [
      'nc',
      'open',
      'unclear',
    ]);
    // Dry air spreads more than the model's own season; humid air less.
    const source = createBinsDrivers({ binsRoot: bins, world });
    const { drivers, recordedDays } = source.driversFor(startDays[0], 4);
    assert.equal(recordedDays, 2);
    const at = world.tracked[0];
    assert.ok(drivers.season(at, 0, 1) > 1);
    assert.ok(drivers.season(at, 1, 1) < 1);
    assert.equal(drivers.season(at, 2, 0.8), 0.8, 'no bins: the formula');

    const spec = datasetSpec({
      seed: 3,
      scenarios: 2,
      runs: 1,
      days: 3,
      perShard: 2,
      drivers: { binsRoot: bins, startDays },
    });
    assert.deepEqual(spec.drivers.startDays, startDays, 'frozen in the spec');
    const shards = path.join(root, 'shards');
    fs.mkdirSync(shards, { recursive: true });
    const result = await writeShard(world, spec, 0, shards);
    assert.ok(result.episodes >= 2);
    const members = readShard(result.file);
    for (const line of result.lines) {
      const meta = JSON.parse(
        new TextDecoder().decode(members.get(`${line.key}.json`)),
      );
      assert.ok(startDays.includes(meta.startMs), 'starts on a binned day');
      assert.deepEqual(meta.drivers.kinds, ['season', 'travel', 'commute']);
      assert.ok(meta.drivers.recordedDays >= 1);
      assert.equal(line.recordedDays, meta.drivers.recordedDays);
    }
    // No bins for the world: a clear refusal, not a silent fallback.
    await assert.rejects(
      writeShard(
        world,
        { ...spec, drivers: { binsRoot: bins, startDays: [] } },
        1,
        shards,
      ),
      /world-tape:bin/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a downloaded box run as a sweep’s base: its places, window and scan flights on the world', async () => {
  const root = tmp();
  try {
    const { writeShard } =
      await import('../../server/shared/outbreakDatasetEpisodes.mjs');
    const { exportBase, readExport } =
      await import('../../server/shared/outbreakExportScenario.mjs');
    const { epidemicExport } = await import('../outbreakEpiExport.mjs');
    const { dir } = writeWorldSnapshot(tinyWorld(), path.join(root, 'worlds'));
    const world = loadWorldSnapshot(dir);
    const start = Date.UTC(2026, 2, 3, 6);
    // What DOWNLOAD RESULTS saves, flights and all.
    const doc = epidemicExport(
      { places: [], totals: [] },
      {
        startMs: start,
        untilMs: start + 3 * 86_400_000 + 3_600_000,
        runs: 4,
        seed: 12,
        locations: [{ id: 'x', name: 'Near AAA', lat: 10.05, lon: 10.02 }],
        outbreakAirports: ['AAA'],
        flights: [
          {
            from: 'AAA',
            to: 'CCC',
            departMs: start + 3_600_000,
            arriveMs: start + 6 * 3_600_000,
          },
          { from: 'AAA', to: 'ZZZ', departMs: start, arriveMs: start + 1 },
        ],
        flightCount: 2,
        profile: { preset: 'covid2020', initialCases: 4000 },
      },
    );
    const file = path.join(root, 'run.json');
    fs.writeFileSync(file, JSON.stringify(doc));
    const { sha256 } = readExport(file);
    const base = exportBase(doc, world);
    assert.deepEqual(base.origins, [0], 'the outbreak place is AAA');
    assert.equal(base.days, 4, 'a part day counts');
    assert.equal(base.flights.length, 1);
    assert.equal(base.dropped.flights, 1, 'ZZZ is not on this world');
    assert.equal(base.flights[0].to, 2);
    assert.ok(base.flights[0].passengers > 0);
    assert.throws(
      () => exportBase({ request: { ...doc.request, locations: [] } }, world),
      /No world place/,
    );

    const spec = datasetSpec({
      seed: 2,
      scenarios: 3,
      runs: 1,
      days: base.days,
      perShard: 3,
      policyMix: [1, 0, 0],
      fromExport: { file, sha256 },
    });
    const shards = path.join(root, 'shards');
    fs.mkdirSync(shards, { recursive: true });
    const result = await writeShard(world, spec, 0, shards);
    assert.equal(result.lines.length, 3);
    const members = readShard(result.file);
    for (const line of result.lines) {
      const meta = JSON.parse(
        new TextDecoder().decode(members.get(`${line.key}.json`)),
      );
      assert.equal(meta.preset, 'export');
      assert.equal(meta.startMs, start);
      assert.deepEqual(meta.origins, [0]);
      assert.deepEqual(meta.fromExport, { sha256, flights: 1 });
    }
    // The file changed since the sweep began: refused.
    fs.writeFileSync(file, JSON.stringify({ ...doc, exportedAt: 'later' }));
    const fresh = await import(
      `../../server/shared/outbreakDatasetEpisodes.mjs?again=${Date.now()}`
    );
    await assert.rejects(
      fresh.writeShard(world, spec, 1, shards),
      /changed since the sweep started/,
    );
    assert.equal(
      parseDatasetArgs(['--from-export', 'run.json'], root).fromExport,
      path.join(root, 'run.json'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
