import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  BACKFILL_FEEDS,
  HURDAT2_LISTING,
  backfill,
  firmsRecords,
  hurdat2Files,
  hurdat2Records,
  parseArea,
  parseArgs,
  usgsRecords,
} from '../../scripts/world-tape-backfill.mjs';
import { binTapeDay, loadGrid } from '../../scripts/world-tape-bin.mjs';
import { createTapeStore } from '../../server/shared/worldTapeStore.mjs';
import recentImagery from '../../server/shared/worldTape/feeds/recent-imagery.mjs';
import { PRODUCTS } from '../layers/recentImagery/model.js';
import { parseNpy } from '../outbreakEpiShard.mjs';
import { BIN_GROUPS } from '../worldTapeBin.mjs';

const T = Date.UTC(2026, 8, 1, 5, 30);
const HOUR = 3_600_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-backfill-'));

/** The records of one tape hour file. */
function readRecords(file) {
  return gunzipSync(fs.readFileSync(file))
    .toString('utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

test('USGS and FIRMS archives become tape records timed by the event', () => {
  const quakes = usgsRecords({
    features: [
      {
        id: 'us1',
        geometry: { coordinates: [10, 20, 5] },
        properties: { mag: 3, time: T, place: 'X' },
      },
      {
        id: 'small',
        geometry: { coordinates: [10, 20, 5] },
        properties: { mag: 1, time: T },
      },
    ],
  });
  assert.equal(quakes.length, 1);
  assert.equal(quakes[0].t, T);
  assert.equal(quakes[0].backfill, true);
  const fires = firmsRecords(
    'latitude,longitude,frp,acq_date,acq_time,confidence,satellite\n1.5,2.5,12.3,2026-09-01,0530,n,N\n',
  );
  assert.equal(fires[0].t, T);
  assert.equal(fires[0].frp, 12.3);
});

test('a backfill files each record under its own past hour', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-backfill-'));
  try {
    const options = parseArgs(
      [
        '--from',
        '2026-09-01',
        '--to',
        '2026-09-01',
        '--feeds',
        'earthquakes',
        '--tape',
        root,
      ],
      root,
      {},
    );
    const fetchImpl = async (url) => {
      assert.match(url, /starttime=2026-09-01&endtime=2026-09-02/);
      return {
        ok: true,
        json: async () => ({
          features: [
            {
              id: 'us1',
              geometry: { coordinates: [10, 20, 5] },
              properties: { mag: 3, time: T },
            },
          ],
        }),
      };
    };
    const totals = await backfill(options, { fetchImpl, log: () => {} });
    assert.deepEqual(totals, { earthquakes: 1 });
    const file = path.join(
      root,
      'earthquakes',
      '2026',
      '09',
      '01',
      '05.ndjson.gz',
    );
    const records = gunzipSync(fs.readFileSync(file))
      .toString('utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(records[0].id, 'us1');
    assert.equal(records[0].class, 'open');
    assert.throws(
      () => parseArgs(['--from', 'x', '--to', 'y'], root, {}),
      /dates/,
    );
    assert.throws(
      () =>
        parseArgs(
          ['--from', '2026-01-01', '--to', '2026-01-02', '--feeds', 'flights'],
          root,
          {},
        ),
      /No archive/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- GFS (wind)

/** A cycle's inventories, as the bucket lists them: messages 3 bytes apart. */
const F000_IDX = [
  '1:0:d=2026090100:PRMSL:mean sea level:anl:',
  '2:3:d=2026090100:TMP:850 mb:anl:',
  '3:6:d=2026090100:TMP:2 m above ground:anl:',
  '4:9:d=2026090100:SPFH:2 m above ground:anl:',
  '5:12:d=2026090100:UGRD:10 m above ground:anl:',
  '6:15:d=2026090100:VGRD:10 m above ground:anl:',
  '7:18:d=2026090100:HGT:surface:anl:',
].join('\n');
const F006_IDX = [
  '1:0:d=2026090100:UGRD:10 m above ground:6 hour fcst:',
  '2:3:d=2026090100:VGRD:10 m above ground:6 hour fcst:',
  '3:6:d=2026090100:PRATE:surface:6 hour fcst:',
  '4:9:d=2026090100:PRATE:surface:0-6 hour ave fcst:',
  '5:12:d=2026090100:APCP:surface:0-6 hour acc fcst:',
].join('\n');

/**
 * The bucket: each range body is its start offset, its object's forecast
 * hour and its cycle's hour. `answer(url)` may stand in for an object.
 */
function gfsBucket(answer = () => null) {
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const [, hour, step] =
      /^https:\/\/noaa-gfs-bdp-pds\.s3\.amazonaws\.com\/gfs\.\d{8}\/(\d{2})\/atmos\/gfs\.t\1z\.pgrb2\.0p25\.f(\d{3})(?:\.idx)?$/.exec(
        url,
      );
    const stand = answer(url);
    if (stand) return stand;
    if (url.endsWith('.idx'))
      return new Response(Number(step) ? F006_IDX : F000_IDX);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    const start = Number(/^bytes=(\d+)-/.exec(init.headers.Range)[1]);
    return new Response(Uint8Array.of(start, Number(step), Number(hour)), {
      status: 206,
    });
  };
  return { fetchImpl, calls, peak: () => peak };
}

/** Decoded fields by object and offset, in the units ecCodes decodes. */
const GFS_FIELDS = {
  '0:0': [101325, 'Pa'], // PRMSL
  '0:6': [293.15, 'K'], // TMP at 2 m (each cycle 1 K warmer, below)
  '0:9': [0.0125, 'kg kg**-1'], // SPFH at 2 m
  '0:12': [3, 'm/s'], // UGRD
  '0:15': [-4, 'm/s'], // VGRD
  '6:9': [0.0005, 'kg m**-2 s**-1'], // the 0–6 h mean PRATE
};
async function decodeGfs([offset, step, hour]) {
  const [value, units] = GFS_FIELDS[`${step}:${offset}`];
  return {
    ni: 4,
    nj: 3,
    lo1: 0,
    la1: 90,
    di: 90,
    dj: 90,
    values: new Float64Array(12).fill(units === 'K' ? value + hour / 6 : value),
    units,
  };
}

const near = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;

test('wind: each GFS cycle becomes the wind feed grid files under the hours they are valid, a missing or failing cycle is skipped, and the binner reads them', async () => {
  const root = tmp();
  try {
    const options = parseArgs(
      ['--from', '2026-09-01', '--to', '2026-09-01', '--feeds', 'wind'],
      root,
      {},
    );
    options.tape = path.join(root, 'tape');
    // 18Z's f006 is not in the bucket; 06Z's index fails.
    const bucket = gfsBucket((url) =>
      url.includes('/18/') && url.endsWith('f006.idx')
        ? new Response('NoSuchKey', { status: 404 })
        : url.includes('/06/') && url.endsWith('f000.idx')
          ? new Response('SlowDown', { status: 503 })
          : null,
    );
    const lines = [];
    const totals = await backfill(options, {
      fetchImpl: bucket.fetchImpl,
      decodeImpl: decodeGfs,
      now: () => Date.UTC(2026, 8, 3),
      log: (line) => lines.push(line),
    });
    assert.deepEqual(totals, { wind: 12 });
    assert.ok(
      lines.some((l) => /wind 2026-09-01T18Z: not in the bucket/.test(l)),
    );
    assert.ok(
      lines.some((l) =>
        /wind 2026-09-01T06Z: skipped \(f000 index HTTP 503\)/.test(l),
      ),
    );
    // Polite: bounded requests, ranges at most four at a time.
    for (const { init } of bucket.calls) {
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
    }
    assert.ok(bucket.peak() <= 4 && bucket.peak() > 1, `peak ${bucket.peak()}`);
    assert.deepEqual(
      bucket.calls
        .filter((c) => c.init.headers?.Range && c.url.includes('/00/'))
        .map((c) => `${c.url.slice(-4)} ${c.init.headers.Range}`)
        .sort(),
      [
        'f000 bytes=0-2',
        'f000 bytes=12-14',
        'f000 bytes=15-17',
        'f000 bytes=6-8',
        'f000 bytes=9-11',
        'f006 bytes=9-11',
      ],
    );
    // The analysis under its own hour, the mean rate mid-window.
    const dir = path.join(options.tape, 'wind', '2026', '09', '01');
    const analysis = readRecords(path.join(dir, '00.ndjson.gz'));
    const [rate] = readRecords(path.join(dir, '03.ndjson.gz'));
    assert.deepEqual(
      analysis.map((r) => r.var),
      ['u10', 'v10', 't2m', 'msl', 'q2m'],
    );
    const units = {
      u10: 'm/s',
      v10: 'm/s',
      t2m: '°C',
      msl: 'hPa',
      q2m: 'kg/kg',
    };
    const levels = {
      u10: '10 m above ground',
      v10: '10 m above ground',
      t2m: '2 m above ground',
      msl: 'mean sea level',
      q2m: '2 m above ground',
    };
    // 293.15 K is 20 °C, 101325 Pa 1013.25 hPa, 0.0005 kg m⁻² s⁻¹ 1.8 mm/h.
    const values = {
      u10: 3,
      v10: -4,
      t2m: 20,
      msl: 1013.25,
      q2m: 0.0125,
      prate: 1.8,
    };
    for (const r of [...analysis, rate]) {
      assert.equal(r.feed, 'wind');
      assert.equal(r.class, 'open');
      assert.equal(r.licence, BACKFILL_FEEDS.wind.licence);
      assert.equal(r.backfill, true);
      assert.equal(r.model, 'gfs');
      assert.equal(r.cycle, '2026-09-01T00:00:00.000Z');
      assert.deepEqual(r.grid, {
        nx: 360,
        ny: 181,
        lo1: 0,
        la1: 90,
        dx: 1,
        dy: 1,
      });
      assert.equal(
        r.order,
        'rows from la1 southward, columns from lo1 eastward',
      );
      assert.equal(r.dtype, 'int16le');
      assert.equal(r.bytes, 360 * 181 * 2);
      for (const key of ['scale', 'offset', 'min', 'max'])
        assert.ok(Number.isFinite(r[key]), key);
      const grid = loadGrid(options.tape, r);
      assert.equal(grid.length, 360 * 181);
      assert.ok(near(grid[0], values[r.var]), r.var);
    }
    for (const r of analysis) {
      assert.equal(r.t, Date.UTC(2026, 8, 1, 0));
      assert.equal(r.step, 0);
      assert.equal(r.valid, '2026-09-01T00:00:00.000Z');
      assert.equal(r.units, units[r.var]);
      assert.equal(r.level, levels[r.var]);
      assert.equal(Object.hasOwn(r, 'window'), false);
      assert.equal(
        r.file,
        `wind/2026/09/01/00/gfs-20260901T000000-f000-${r.var}.i16`,
      );
    }
    // The rate averages the cycle's first six hours.
    assert.equal(rate.var, 'prate');
    assert.equal(rate.units, 'mm/h');
    assert.equal(rate.level, 'surface');
    assert.equal(rate.step, 6);
    assert.equal(rate.valid, '2026-09-01T06:00:00.000Z');
    assert.deepEqual(rate.window, { fromHour: 0, toHour: 6 });
    assert.equal(rate.windowStartIso, '2026-09-01T00:00:00.000Z');
    assert.equal(rate.windowEndIso, '2026-09-01T06:00:00.000Z');
    assert.equal(rate.t, Date.UTC(2026, 8, 1, 3));
    assert.equal(
      rate.file,
      'wind/2026/09/01/03/gfs-20260901T000000-f006-prate.i16',
    );
    // Only the cycles that answered are on the tape.
    assert.deepEqual(
      fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.ndjson.gz'))
        .sort(),
      ['00.ndjson.gz', '03.ndjson.gz', '12.ndjson.gz', '15.ndjson.gz'],
    );
    // The binner: finite weather at a place in the hours near each cycle,
    // NaN where the skipped cycle would have been.
    const world = {
      worldId: 'w-test',
      nodes: [{ lat: 30.27, lon: -97.74 }],
      tracked: [0],
    };
    const out = path.join(root, 'bins');
    binTapeDay({
      world,
      tapeRoot: options.tape,
      outRoot: out,
      day: '2026/09/01',
      store: createTapeStore({ root: options.tape }),
    });
    const weather = parseNpy(
      new Uint8Array(
        fs.readFileSync(
          path.join(out, 'w-test', '2026', '09', '01.weather.npy'),
        ),
      ),
    );
    const W = BIN_GROUPS.weather.length;
    const at = (hour, channel) =>
      weather.data[hour * W + BIN_GROUPS.weather.indexOf(channel)];
    const expected = {
      t2m: 20,
      humidity: 0.0125,
      precip: 1.8,
      u10: 3,
      v10: -4,
      mslp: 1013.25,
    };
    for (const [channel, value] of Object.entries(expected))
      assert.ok(near(at(1, channel), value), `${channel} at 01:00`);
    assert.ok(near(at(13, 't2m'), 22), '12Z is 2 K warmer');
    assert.ok(near(at(13, 'precip'), 1.8));
    assert.ok(Number.isNaN(at(7, 't2m')), 'no grid near 07:30');
    assert.ok(Number.isNaN(at(7, 'precip')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wind: cycles before the bucket keeps them, or not yet published, are skipped with a message', async () => {
  const root = tmp();
  try {
    const options = parseArgs(
      [
        '--from',
        '2021-03-21',
        '--to',
        '2021-03-22',
        '--feeds',
        'wind',
        '--tape',
        root,
      ],
      root,
      {},
    );
    const bucket = gfsBucket();
    const lines = [];
    const totals = await backfill(options, {
      fetchImpl: bucket.fetchImpl,
      decodeImpl: decodeGfs,
      // 15:00 is published: the 12Z cycle, not yet 18Z.
      now: () => Date.UTC(2021, 2, 22, 20),
      log: (line) => lines.push(line),
    });
    assert.deepEqual(totals, { wind: 6 });
    assert.deepEqual(
      [
        ...new Set(
          bucket.calls.map((c) => /gfs\.(\d{8}\/\d{2})/.exec(c.url)[1]),
        ),
      ],
      ['20210322/12'],
    );
    assert.ok(
      lines.some((l) =>
        /keeps this layout from the 2021-03-22T12Z cycle/.test(l),
      ),
    );
    assert.ok(
      lines.some((l) => /after 2021-03-22T12Z are not published yet/.test(l)),
    );
    assert.equal(
      lines.filter((l) => l.startsWith('[backfill] 2021-03-21:')).length,
      0,
      'a day before the archive passes quietly',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------ HURDAT2 (weather-cyclones)

const LISTING = `<html><body><h1>Index of /data/hurdat</h1><pre>
<a href="?C=N;O=D">Name</a> <a href="/data/">Parent Directory</a>
<a href="hurdat2-1851-2023-051124.txt">hurdat2-1851-2023-051124.txt</a>
<a href="hurdat2-1851-2024-04022025.txt">hurdat2-1851-2024-04022025.txt</a>
<a href="hurdat2-1851-2024-040425.txt">hurdat2-1851-2024-040425.txt</a>
<a href="hurdat2-1851-2099-133199.txt">not a date</a>
<a href="hurdat2-atl-1851-2025-042626.txt">another name</a>
<a href="https://evil.example/hurdat2-1851-2099-010199.txt">elsewhere</a>
<a href="../hurdat2-1851-2099-010199.txt">up a folder</a>
<a href="hurdat2-format-atlantic.pdf">format</a>
<a href="hurdat2-nepac-1949-2023-042624.txt">hurdat2-nepac-1949-2023-042624.txt</a>
<a href="hurdat2-nepac-1949-2024-031725.txt">hurdat2-nepac-1949-2024-031725.txt</a>
<a href="hurdat2-nepac-1949-2024-031725a.txt">hurdat2-nepac-1949-2024-031725a.txt</a>
</pre></body></html>`;

const RADII = Array(13).fill('-999').join(', ');
const ATLANTIC = [
  'AL092023,             IDALIA,      4,',
  `20230830, 0600,  , HU, 28.4N,  84.3W, 110,  942, ${RADII}`,
  `20230830, 1145, L, HU, 29.9N,  83.6W,  90,  949, ${RADII}`,
  `20230830, 1200,  , HU, 30.0N,  83.5W,  85,  952, ${RADII}`,
  `20230901, 0000,  , EX, 32.0N,  77.0W,  50, -999, ${RADII}`,
  `20230901, 0600,  , EX, 33.0N,  75.0W,  50,  990, ${RADII}`, // past the count
  '',
].join('\n');
const PACIFIC = [
  `19490611, 0000,  , TS, 20.0N, 106.0W,  45, -999, ${RADII}`, // no header yet
  'EP011949,            UNNAMED,      2,',
  `19490611, 0000,  , TS, 20.2N, 106.3W,  45, -999, ${RADII}`,
  `19490611, 0600,  , TS, 20.2N, 106.4W, -99, -999, ${RADII}`,
  'CP012024,         TWENTY-ONE,      2,',
  `20240101, 0000,  , SS, 10.5S, 179.5E,  35, 1005, ${RADII}`,
  `20240101, 0600,  , TS, 10.6X, 179.0E,  35, 1004, ${RADII}`, // no hemisphere
].join('\n');

test('weather-cyclones: the newest HURDAT2 file of each basin, by strict name, on the NHC host', () => {
  assert.deepEqual(hurdat2Files(LISTING), {
    Atlantic: {
      name: 'hurdat2-1851-2024-040425.txt',
      url: 'https://www.nhc.noaa.gov/data/hurdat/hurdat2-1851-2024-040425.txt',
      lastSeason: 2024,
      version: '2025-04-04',
    },
    'Northeast and North Central Pacific': {
      name: 'hurdat2-nepac-1949-2024-031725a.txt',
      url: 'https://www.nhc.noaa.gov/data/hurdat/hurdat2-nepac-1949-2024-031725a.txt',
      lastSeason: 2024,
      version: '2025-03-17',
    },
  });
  assert.equal(new URL(HURDAT2_LISTING).host, 'www.nhc.noaa.gov');
  assert.deepEqual(hurdat2Files('<a href="hurdat2-1851-2024.txt">'), {});
});

test('weather-cyclones: HURDAT2 fixes become cyclone records with signed positions, times and missing values', () => {
  const records = hurdat2Records(`${ATLANTIC}\n${PACIFIC}`);
  assert.deepEqual(
    records.map((r) => `${r.id} ${r.positionAt}`),
    [
      'al092023 2023-08-30T06:00:00.000Z',
      'al092023 2023-08-30T11:45:00.000Z',
      'al092023 2023-08-30T12:00:00.000Z',
      'al092023 2023-09-01T00:00:00.000Z',
      'ep011949 1949-06-11T00:00:00.000Z',
      'ep011949 1949-06-11T06:00:00.000Z',
      'cp012024 2024-01-01T00:00:00.000Z',
    ],
  );
  assert.deepEqual(records[1], {
    t: Date.UTC(2023, 7, 30, 11, 45),
    id: 'al092023',
    name: 'Idalia',
    basin: 'AL',
    classification: 'HU',
    lat: 29.9,
    lon: -83.6,
    windKt: 90,
    pressure: 949,
    positionAt: '2023-08-30T11:45:00.000Z',
    recordType: 'L',
    source: 'HURDAT2',
    backfill: true,
  });
  assert.equal(records[0].recordType, null);
  assert.equal(records[3].classification, 'EX');
  assert.equal(records[3].pressure, null, '−999 is missing');
  assert.equal(records[4].name, 'Unnamed');
  assert.equal(records[4].lat, 20.2);
  assert.equal(records[5].windKt, null, '−99 is missing');
  assert.deepEqual(
    [records[6].name, records[6].basin, records[6].lat, records[6].lon],
    ['Twenty-One', 'CP', -10.5, 179.5],
  );
  // The range: from inclusive, to exclusive.
  assert.deepEqual(
    hurdat2Records(ATLANTIC, {
      from: Date.UTC(2023, 7, 30, 11, 45),
      to: Date.UTC(2023, 8, 1),
    }).map((r) => r.positionAt),
    ['2023-08-30T11:45:00.000Z', '2023-08-30T12:00:00.000Z'],
  );
});

test('weather-cyclones: a backfill files the fixes in range by hour, and says when the dates are past the last season', async () => {
  const root = tmp();
  try {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      if (url === HURDAT2_LISTING) return new Response(LISTING);
      if (url.endsWith('/hurdat2-1851-2024-040425.txt'))
        return new Response(ATLANTIC);
      if (url.endsWith('/hurdat2-nepac-1949-2024-031725a.txt'))
        return new Response(PACIFIC);
      throw new Error(`unexpected ${url}`);
    };
    const options = parseArgs(
      [
        '--from',
        '2023-08-30',
        '--to',
        '2023-08-30',
        '--feeds',
        'weather-cyclones',
        '--tape',
        root,
      ],
      root,
      {},
    );
    const lines = [];
    const totals = await backfill(options, {
      fetchImpl,
      log: (line) => lines.push(line),
    });
    assert.deepEqual(totals, { 'weather-cyclones': 3 });
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => new URL(c.url).host === 'www.nhc.noaa.gov'));
    const dir = path.join(root, 'weather-cyclones', '2023', '08', '30');
    assert.deepEqual(
      fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.ndjson.gz'))
        .sort(),
      ['06.ndjson.gz', '11.ndjson.gz', '12.ndjson.gz'],
    );
    const [landfall] = readRecords(path.join(dir, '11.ndjson.gz'));
    assert.equal(landfall.recordType, 'L');
    assert.equal(landfall.class, 'open');
    assert.equal(landfall.licence, 'NOAA NHC HURDAT2 (U.S. public domain)');
    // Dates past the last season published: the listing only, and why.
    calls.length = 0;
    lines.length = 0;
    const recent = await backfill(
      { ...options, from: '2026-09-01', to: '2026-10-12' },
      { fetchImpl, log: (line) => lines.push(line) },
    );
    assert.deepEqual(recent, { 'weather-cyclones': 0 });
    assert.deepEqual(
      calls.map((c) => c.url),
      [HURDAT2_LISTING],
    );
    assert.equal(
      lines.filter((l) =>
        /ends with the 2024 season; best tracks are published months after a season ends/.test(
          l,
        ),
      ).length,
      2,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------- GIBS VIIRS (recent-imagery)

test('recent-imagery: each area each day, with the live feed box, size, name and record, under 12:00 UTC', async () => {
  const root = tmp();
  try {
    const areasFile = path.join(root, '.gev-data', 'ai-world', 'areas.json');
    fs.mkdirSync(path.dirname(areasFile), { recursive: true });
    fs.writeFileSync(
      areasFile,
      JSON.stringify([
        {
          key: '30.2672,-97.7431',
          name: 'Austin',
          lat: 30.2672,
          lon: -97.7431,
        },
        { key: '48.8566,2.3522', name: 'Paris', lat: 48.8566, lon: 2.3522 },
      ]),
    );
    const urls = [];
    const fetchImpl = async (url, init) => {
      urls.push(String(url));
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.redirect, 'error');
      const query = new URL(url).searchParams;
      // Worldview has no image of Paris's box on the second day.
      const blank =
        query.get('TIME') === '2026-09-02' &&
        query.get('BBOX').startsWith('48.');
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: {
          'content-type': 'image/png',
          'data-present': blank ? 'false' : 'true',
        },
      });
    };
    const options = parseArgs(
      [
        '--from',
        '2026-09-01',
        '--to',
        '2026-09-02',
        '--feeds',
        'recent-imagery',
      ],
      root,
      {},
    );
    const lines = [];
    const totals = await backfill(options, {
      fetchImpl,
      now: () => Date.UTC(2026, 8, 3, 1),
      log: (line) => lines.push(line),
    });
    assert.deepEqual(totals, { 'recent-imagery': 3 });
    assert.equal(urls.length, 4);
    for (const url of urls) {
      const u = new URL(url);
      assert.equal(u.host, 'wvs.earthdata.nasa.gov');
      assert.equal(u.searchParams.get('LAYERS'), PRODUCTS.VIIRS.gibsLayer);
      assert.equal(u.searchParams.get('WIDTH'), '1024');
    }
    assert.deepEqual(
      urls.map((url) => new URL(url).searchParams.get('TIME')),
      ['2026-09-01', '2026-09-01', '2026-09-02', '2026-09-02'],
    );
    assert.ok(
      lines.some((l) =>
        /recent-imagery 2026-09-02: no image of 1 area/.test(l),
      ),
    );
    const day1 = path.join(options.tape, 'recent-imagery', '2026', '09', '01');
    const records = readRecords(path.join(day1, '12.ndjson.gz'));
    assert.deepEqual(
      records.map((r) => r.area),
      ['Austin', 'Paris'],
    );
    for (const r of records) {
      assert.match(
        r.file,
        new RegExp(
          `^recent-imagery/2026/09/01/12/${r.area}_[0-9a-z]+-VIIRS-2026-09-01\\.png$`,
        ),
      );
      assert.ok(fs.existsSync(path.join(options.tape, r.file)));
      assert.equal(r.t, Date.UTC(2026, 8, 1, 12));
      assert.equal(r.product, 'VIIRS');
      assert.equal(r.day, '2026-09-01');
      assert.equal(r.quality, 'overview');
      assert.equal(r.coverage, 'full');
      assert.equal(r.cloud, null);
      assert.equal(r.width, 1024);
      assert.ok(r.height >= 64 && r.height <= 1024);
      assert.equal(r.backfill, true);
      assert.equal(r.class, 'open');
      assert.equal(r.licence, recentImagery.licence);
    }
    // The 25 km box the live feed takes round each area.
    const [west, south, east, north] = records[0].bbox;
    assert.ok(west < -97.7431 && -97.7431 < east);
    assert.ok(south < 30.2672 && 30.2672 < north);
    assert.ok(near((north - south) * 111.2, 50, 0.01));
    assert.equal(
      readRecords(
        path.join(
          options.tape,
          'recent-imagery',
          '2026',
          '09',
          '02',
          '12.ndjson.gz',
        ),
      ).length,
      1,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recent-imagery: --area places, none at all is a skip, and a day not over waits', async () => {
  assert.deepEqual(parseArea('30.2672,-97.7431,Austin, TX'), {
    lat: 30.2672,
    lon: -97.7431,
    name: 'Austin, TX',
  });
  assert.equal(parseArea('51.5, -0.12').name, '51.500,-0.120');
  for (const bad of ['', 'x,1', '91,0', '10', '10,200'])
    assert.throws(() => parseArea(bad), /--area needs lat,lon/);
  const root = tmp();
  try {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return new Response(new Uint8Array([1]), {
        headers: { 'content-type': 'image/png' },
      });
    };
    const lines = [];
    const none = await backfill(
      parseArgs(
        [
          '--from',
          '2026-09-01',
          '--to',
          '2026-09-01',
          '--feeds',
          'recent-imagery',
        ],
        root,
        {},
      ),
      { fetchImpl, log: (line) => lines.push(line) },
    );
    assert.deepEqual(none, {});
    assert.equal(calls.length, 0);
    assert.ok(lines.some((l) => /recent-imagery skipped: no areas/.test(l)));
    const options = parseArgs(
      [
        '--from',
        '2026-09-01',
        '--to',
        '2026-09-02',
        '--feeds',
        'recent-imagery',
        '--area',
        '30.2672,-97.7431,Austin',
      ],
      root,
      {},
    );
    assert.equal(options.areas.length, 1);
    lines.length = 0;
    const totals = await backfill(options, {
      fetchImpl,
      now: () => Date.UTC(2026, 8, 2, 18),
      log: (line) => lines.push(line),
    });
    assert.deepEqual(totals, { 'recent-imagery': 1 });
    assert.deepEqual(
      calls.map((url) => new URL(url).searchParams.get('TIME')),
      ['2026-09-01'],
    );
    assert.ok(lines.some((l) => /a day not over yet is skipped/.test(l)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
