import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gravityLinks } from '../outbreakEpi.mjs';
import { parseNpy } from '../outbreakEpiShard.mjs';
import { trackedPlaces, worldCountries } from '../outbreakEpiTape.mjs';
import { BIN_GROUPS } from '../worldTapeBin.mjs';
import {
  loadWorldSnapshot,
  writeWorldSnapshot,
} from '../../server/shared/outbreakWorldStore.mjs';
import { createTapeStore } from '../../server/shared/worldTapeStore.mjs';
import { binTapeDay, tapeDays } from '../../scripts/world-tape-bin.mjs';

test('a day of tape becomes bins and the classes they were built from', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-bin-'));
  try {
    const nodes = [
      {
        id: 'BOS',
        code: 'BOS',
        name: 'Boston',
        lat: 42.36,
        lon: -71.0,
        population: 4e6,
        kind: 'airport',
        size: 'L',
        country: 'US',
      },
      {
        id: 'HEL',
        code: 'HEL',
        name: 'Helsinki',
        lat: 60.3,
        lon: 24.96,
        population: 1e6,
        kind: 'airport',
        size: 'L',
        country: 'FI',
      },
    ];
    const { countries, countryOfNode } = worldCountries(nodes);
    const { dir } = writeWorldSnapshot(
      {
        nodes,
        routes: [],
        flights: [],
        flown: [],
        links: gravityLinks(nodes),
        tracked: trackedPlaces(nodes, 2),
        countries,
        countryOfNode,
        meta: { sources: [] },
      },
      path.join(root, 'worlds'),
    );
    const world = loadWorldSnapshot(dir);
    const tape = path.join(root, 'tape');
    const at = Date.UTC(2026, 9, 12, 3, 10);
    const store = createTapeStore({ root: tape, now: () => at });
    store.append(
      'flights',
      [{ hex: 'a', lat: 42.4, lon: -71.1, ground: true }],
      { class: 'nc', licence: 'OpenSky' },
    );
    store.append('earthquakes', [{ id: 'q', lat: 61, lon: 25, mag: 3 }], {
      class: 'open',
      licence: 'USGS',
    });
    store.heartbeat('earthquakes');
    // A 2 m temperature grid as the wind feed records it: int16, 1° global,
    // value = q × scale + offset (100 × 0.1 = 10 °C everywhere).
    const nx = 360;
    const ny = 181;
    const grid = Buffer.alloc(nx * ny * 2);
    for (let i = 0; i < nx * ny; i += 1) grid.writeInt16LE(100, i * 2);
    store.writeFile(
      'wind',
      'gfs_20261012T000000_f003_t2m.i16',
      grid,
      {
        model: 'gfs',
        cycle: '2026-10-12T00:00:00.000Z',
        step: 3,
        valid: '2026-10-12T03:00:00.000Z',
        var: 't2m',
        units: '°C',
        grid: { nx, ny, lo1: 0, la1: 90, dx: 1, dy: 1 },
        dtype: 'int16le',
        scale: 0.1,
        offset: 0,
      },
      { class: 'open', licence: 'NOAA GFS' },
    );
    const next = Buffer.alloc(nx * ny * 2);
    for (let i = 0; i < nx * ny; i += 1) next.writeInt16LE(50, i * 2);
    store.writeFile(
      'wind',
      'gfs_20261013T000000_f000_t2m.i16',
      next,
      {
        model: 'gfs',
        cycle: '2026-10-13T00:00:00.000Z',
        step: 0,
        valid: '2026-10-13T00:00:00.000Z',
        var: 't2m',
        units: '°C',
        grid: { nx, ny, lo1: 0, la1: 90, dx: 1, dy: 1 },
        dtype: 'int16le',
        scale: 0.1,
        offset: 0,
      },
      { class: 'open', licence: 'NOAA GFS' },
      { at: Date.UTC(2026, 9, 13, 0, 5) },
    );
    assert.deepEqual(tapeDays(tape, Date.UTC(2026, 9, 13)), ['2026/10/12']);
    const out = path.join(root, 'bins');
    const files = binTapeDay({
      world,
      tapeRoot: tape,
      outRoot: out,
      day: '2026/10/12',
      store,
    });
    // One array per group, the classes they came from, and the study list.
    assert.deepEqual(
      files.map((file) => path.basename(file)).sort(),
      [
        ...Object.keys(BIN_GROUPS).map((group) => `12.${group}.npy`),
        '12.classes.json',
        'links.json',
        'assets.json',
      ].sort(),
    );
    const mobility = parseNpy(
      new Uint8Array(
        fs.readFileSync(
          path.join(out, world.worldId, '2026', '10', '12.mobility.npy'),
        ),
      ),
    );
    assert.deepEqual(mobility.shape, [24, 2, BIN_GROUPS.mobility.length]);
    const K = 2;
    const C = BIN_GROUPS.mobility.length;
    assert.equal(
      mobility.data[(3 * K + 0) * C + 0],
      1,
      'one aircraft near Boston at 03:00',
    );
    assert.ok(
      Number.isNaN(mobility.data[(4 * K + 0) * C + 0]),
      'flights not observed at 04:00',
    );
    const weather = parseNpy(
      new Uint8Array(
        fs.readFileSync(
          path.join(out, world.worldId, '2026', '10', '12.weather.npy'),
        ),
      ),
    );
    const W = BIN_GROUPS.weather.length;
    const t2m = BIN_GROUPS.weather.indexOf('t2m');
    assert.ok(
      Math.abs(weather.data[(3 * K + 1) * W + t2m] - 10) < 1e-4,
      'Helsinki at 03:00 from the recorded grid',
    );
    assert.ok(
      Number.isNaN(weather.data[(12 * K + 1) * W + t2m]),
      'no grid valid near 12:00',
    );
    assert.ok(
      Math.abs(weather.data[(22 * K + 1) * W + t2m] - 5) < 1e-4,
      '22:00 from the next day’s 00Z analysis',
    );
    assert.ok(Number.isNaN(weather.data[(20 * K + 1) * W + t2m]));
    const classes = JSON.parse(
      fs.readFileSync(
        path.join(out, world.worldId, '2026', '10', '12.classes.json'),
        'utf8',
      ),
    );
    assert.deepEqual(classes.mobility, ['nc']);
    assert.deepEqual(classes.hazards, ['open']);
    assert.deepEqual(classes.weather, ['open']);
    assert.deepEqual(classes.news, []);
    assert.ok(fs.existsSync(path.join(out, world.worldId, 'channels.json')));
    const assets = JSON.parse(
      fs.readFileSync(path.join(out, world.worldId, 'assets.json'), 'utf8'),
    );
    assert.deepEqual(assets.tsx.hub, {
      name: 'Toronto',
      lat: 43.6481,
      lon: -79.3815,
    });
    assert.equal(assets.bitcoin.hub, null, 'crypto has no home');
    assert.equal(assets.jetfuel.symbol, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
