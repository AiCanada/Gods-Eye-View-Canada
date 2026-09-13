import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import {
  gridIndexRange,
  normalizeBbox,
  opendapSubsetUrl,
  parseDap2SstQuality,
} from '../server/providers/sst/opendap.js';
import { FRONT_SENSITIVITY, detectThermalFronts } from '../server/providers/sst/fronts.js';
import { encodeRgbaPng } from '../server/providers/sst/png.js';
import { rampColor, sstDisplayRange } from '../server/providers/sst/render.js';
import {
  CMR_LEVEL3_LIST_URL,
  createLevel3Source,
  newestLevel3Granules,
} from '../server/providers/sst/level3.js';
import { SST_FRONT_SENSITIVITIES } from './data/sstProducts.js';

/** A DAP2 SST + quality response for `range`, the way OPeNDAP writes it. */
function dods(range, rawSst, quality) {
  const parts = [Buffer.from('Dataset {\n} fixture;\nData:\n')];
  const count = (n) => {
    const b = Buffer.alloc(8);
    b.writeUInt32BE(n, 0);
    b.writeUInt32BE(n, 4);
    parts.push(b);
  };
  const floats = (n, start, step) => {
    count(n);
    const b = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i += 1) b.writeFloatBE(start + i * step, i * 4);
    parts.push(b);
  };
  const cells = range.rows * range.cols;
  count(cells);
  const s = Buffer.alloc(cells * 4);
  rawSst.forEach((v, i) => s.writeInt32BE(v, i * 4));
  parts.push(s);
  floats(range.rows, 45, -1 / 24);
  floats(range.cols, -70, 1 / 24);
  count(cells);
  const q = Buffer.alloc(cells + ((4 - (cells % 4)) % 4));
  quality.forEach((v, i) => {
    q[i] = v;
  });
  parts.push(q);
  floats(range.rows, 45, -1 / 24);
  floats(range.cols, -70, 1 / 24);
  return Buffer.concat(parts);
}

/** West half 15 °C, east half 20 °C: one sharp north-south front. */
function stepField(rows, cols) {
  return Array.from({ length: rows * cols }, (_, i) =>
    i % cols < cols / 2 ? 3000 : 4000,
  );
}

/**
 * 15 °C, a weak +0.5 °C step at column 12 (about 0.08 °C/km at 45° N) and a
 * strong +5 °C step at column 36 (about 0.76 °C/km).
 */
function twoStepField(rows, cols) {
  return Array.from({ length: rows * cols }, (_, i) => {
    const c = i % cols;
    if (c < 12) return 3000;
    if (c < 36) return 3100;
    return 4100;
  });
}

/** Alpha of pixel (x, y) in a PNG written by encodeRgbaPng (filter 0 rows). */
function pngAlpha(png, x, y) {
  const width = png.readUInt32BE(16);
  const idat = png.indexOf('IDAT');
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  return raw[y * (width * 4 + 1) + 1 + x * 4 + 3];
}

test('bbox parsing clamps latitude and widens antimeridian boxes', () => {
  assert.deepEqual(normalizeBbox('-70,40,-60,46'), { west: -70, south: 40, east: -60, north: 46 });
  assert.deepEqual(normalizeBbox('170,-10,-170,10'), { west: -180, south: -10, east: 180, north: 10 });
  assert.equal(normalizeBbox('1,2,3'), null);
  assert.equal(normalizeBbox('0,10,5,5'), null);
});

test('grid range strides a global view down to at most 1024 cells a side', () => {
  const global = gridIndexRange(normalizeBbox('-180,-90,180,90'));
  assert.equal(global.stride, 9);
  assert.equal(global.cols, 960);
  assert.equal(global.rows, 480);
  const bay = gridIndexRange(normalizeBbox('-67,44,-65,46'));
  assert.equal(bay.stride, 1);
  assert.equal(bay.rows, 48);
  assert.equal(bay.cols, 48);
  assert.equal(bay.row0, 1056);
  assert.equal(bay.col0, 2712);
  assert.deepEqual(bay.rectangle, { west: -67, south: 44, east: -65, north: 46 });
  assert.equal(
    opendapSubsetUrl('https://oceandata.sci.gsfc.nasa.gov/opendap/x.nc', { row0: 10, col0: 20, stride: 2, rows: 3, cols: 4 }),
    'https://oceandata.sci.gsfc.nasa.gov/opendap/x.nc.dods?sst%5B10:2:14%5D%5B20:2:26%5D,qual_sst%5B10:2:14%5D%5B20:2:26%5D',
  );
});

test('DAP2 decode scales SST and drops fill and poor-quality cells', () => {
  const range = { rows: 2, cols: 3 };
  const parsed = parseDap2SstQuality(
    dods(range, [3000, -32767, 4000, 5000, 6000, 7000], [0, 0, 3, 1, 2, 255]),
    range,
  );
  assert.equal(parsed.validCells, 3);
  assert.equal(parsed.sst[0], 15);
  assert.ok(Number.isNaN(parsed.sst[1]), 'fill value');
  assert.ok(Number.isNaN(parsed.sst[2]), 'quality 3 is dropped');
  assert.equal(parsed.sst[3], 25);
  assert.ok(Number.isNaN(parsed.sst[5]), 'quality fill');
  assert.equal(parsed.latitudes.length, 2);
  assert.throws(() => parseDap2SstQuality(Buffer.from('no data'), range), /no data section/);
  assert.throws(() => parseDap2SstQuality(dods(range, [1, 2, 3, 4, 5, 6], [0, 0, 0, 0, 0, 0]), { rows: 3, cols: 3 }), /expected 9/);
});

test('a sharp temperature step is found as one thin front; a calm sea has none', () => {
  const rows = 30;
  const cols = 30;
  const latitudes = Array.from({ length: rows }, () => 45);
  const step = Float32Array.from(stepField(rows, cols), (v) => v * 0.005);
  const found = detectThermalFronts({ sst: step, width: cols, height: rows, latitudes, cellDegrees: 1 / 24 });
  assert.ok(found.cells >= rows - 2, `front spans the field (${found.cells} cells)`);
  assert.ok(found.cells <= 2 * (rows - 2), 'front is thinned to a ridge');
  assert.ok(found.maxGradientCPerKm > 0.3);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (found.strength[y * cols + x] > 0) assert.ok(Math.abs(x - cols / 2) <= 1, 'front sits on the step');
    }
  }
  const calm = new Float32Array(rows * cols).fill(18);
  assert.equal(detectThermalFronts({ sst: calm, width: cols, height: rows, latitudes, cellDegrees: 1 / 24 }).cells, 0);
  const cloudy = Float32Array.from(step);
  for (let y = 0; y < rows; y += 1) cloudy[y * cols + cols / 2] = Number.NaN;
  const gappy = detectThermalFronts({ sst: cloudy, width: cols, height: rows, latitudes, cellDegrees: 1 / 24 });
  assert.equal(gappy.cells, 0, 'no front is drawn across missing data');
});

test('sensitivity levels match the box and get stricter from all to strong', () => {
  assert.deepEqual(Object.keys(FRONT_SENSITIVITY), SST_FRONT_SENSITIVITIES.map((level) => level.id));
  assert.ok(FRONT_SENSITIVITY.strong.thresholdCPerKm > FRONT_SENSITIVITY.moderate.thresholdCPerKm);
  assert.ok(FRONT_SENSITIVITY.moderate.thresholdCPerKm > FRONT_SENSITIVITY.all.thresholdCPerKm);
});

test('PNG encoder writes a valid RGBA image', () => {
  const rgba = Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 128]);
  const png = encodeRgbaPng(2, 1, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 1);
  const idat = png.indexOf('IDAT');
  const length = png.readUInt32BE(idat - 4);
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + length));
  assert.deepEqual([...raw], [0, 255, 0, 0, 255, 0, 0, 255, 128]);
  assert.throws(() => encodeRgbaPng(2, 2, rgba), /does not match/);
});

test('display range stretches to the view, at least 2 °C wide', () => {
  assert.deepEqual(sstDisplayRange(Float32Array.from([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])), { min: 10, max: 20 });
  assert.deepEqual(sstDisplayRange(Float32Array.from([15, 15.2, Number.NaN])), { min: 14.1, max: 16.1 });
  assert.equal(sstDisplayRange(Float32Array.from([Number.NaN])), null);
  assert.deepEqual(rampColor(0), [44, 15, 122]);
  assert.deepEqual(rampColor(1), [215, 38, 61]);
});

const CMR = {
  feed: {
    entry: [
      {
        time_start: '2026-07-31T00:00:00.000Z',
        time_end: '2026-07-31T23:59:59.000Z',
        links: [
          { href: 'https://oceandata.sci.gsfc.nasa.gov/cmr/getfile/AQUA_MODIS.20260731.L3m.DAY.SST.sst.4km.nc' },
          { href: 'https://oceandata.sci.gsfc.nasa.gov/opendap/MODISA/L3SMI/2026/0731/AQUA_MODIS.20260731.L3m.DAY.SST.sst.9km.nc' },
          { href: 'https://oceandata.sci.gsfc.nasa.gov/opendap/MODISA/L3SMI/2026/0731/AQUA_MODIS.20260731.L3m.DAY.SST.sst.4km.nc' },
        ],
      },
      {
        time_start: '2026-07-20T00:00:00.000Z',
        time_end: '2026-07-27T23:59:59.000Z',
        links: [
          { href: 'https://oceandata.sci.gsfc.nasa.gov/opendap/MODISA/L3SMI/2026/0720/AQUA_MODIS.20260720_20260727.L3m.8D.SST.sst.4km.nc' },
        ],
      },
    ],
  },
};

test('newest granules pick the 4 km OPeNDAP file per period', () => {
  const found = newestLevel3Granules(CMR);
  assert.equal(found.day.opendapUrl, 'https://oceandata.sci.gsfc.nasa.gov/opendap/MODISA/L3SMI/2026/0731/AQUA_MODIS.20260731.L3m.DAY.SST.sst.4km.nc');
  assert.equal(found.day.startDate, '2026-07-31');
  assert.equal(found['8d'].startDate, '2026-07-20');
  assert.equal(found['8d'].endDate, '2026-07-27');
});

const BBOX = '-67,44,-65,46';

function level3Fixture({ landMask } = {}) {
  const calls = [];
  const range = gridIndexRange(normalizeBbox(BBOX));
  const source = createLevel3Source({
    env: { EARTHDATA_TOKEN: 'fixture-token' },
    landMask,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, auth: options.headers?.Authorization });
      if (url === CMR_LEVEL3_LIST_URL) {
        return { ok: true, status: 200, headers: new Headers(), body: null, text: async () => JSON.stringify(CMR) };
      }
      const bytes = dods(range, twoStepField(range.rows, range.cols), new Array(range.rows * range.cols).fill(0));
      return { ok: true, status: 200, headers: new Headers(), body: null, arrayBuffer: async () => bytes };
    },
  });
  return { source, calls, range };
}

/** The four westernmost columns are land. */
const westCoast = async (range) => {
  const land = new Uint8Array(range.rows * range.cols);
  for (let r = 0; r < range.rows; r += 1) {
    for (let c = 0; c < 4; c += 1) land[r * range.cols + c] = 1;
  }
  return { land, landCells: range.rows * 4, zoom: 7, tiles: 1 };
};

test('a view drops land, draws SST and fronts, and the token goes only to OceanColor', async () => {
  const { source, calls, range } = level3Fixture({ landMask: westCoast });
  const view = await source({ period: 'day', bbox: BBOX });
  assert.equal(view.meta.startDate, '2026-07-31');
  assert.equal(view.meta.width, 48);
  assert.equal(view.meta.height, 48);
  assert.equal(view.meta.cellKm, 4.6);
  assert.equal(view.meta.landMask, 'applied');
  assert.equal(view.meta.landCells, range.rows * 4);
  assert.equal(view.meta.validCells, range.rows * (range.cols - 4));
  assert.deepEqual(view.meta.sstRange, { min: 15, max: 20.5 });
  assert.equal(view.meta.fronts.sensitivity, 'strong');
  assert.ok(view.meta.fronts.cells > 0, 'the strong step is a front');
  assert.equal(pngAlpha(view.sstPng, 0, 10), 0, 'land is transparent');
  assert.equal(pngAlpha(view.sstPng, 20, 10), 255, 'ocean is drawn');
  assert.deepEqual([...view.frontsPng.subarray(1, 4)], [80, 78, 71]);

  const opendap = calls.filter((call) => call.url.includes('/opendap/'));
  assert.equal(opendap.length, 1);
  assert.match(opendap[0].url, /\.dods\?sst%5B1056:1:1103%5D%5B2712:1:2759%5D,qual_sst/);
  assert.equal(opendap[0].auth, 'Bearer fixture-token');
  assert.equal(calls.find((call) => call.url === CMR_LEVEL3_LIST_URL).auth, undefined);

  await source({ period: 'day', bbox: BBOX });
  assert.equal(calls.filter((call) => call.url.includes('/opendap/')).length, 1, 'same view is cached');
});

test('a gentler sensitivity finds the weak front too, without downloading again', async () => {
  const { source, calls } = level3Fixture({ landMask: westCoast });
  const strong = await source({ period: 'day', bbox: BBOX, fronts: 'strong' });
  const all = await source({ period: 'day', bbox: BBOX, fronts: 'all' });
  assert.ok(strong.meta.fronts.cells > 0);
  assert.ok(all.meta.fronts.cells > strong.meta.fronts.cells, 'the weak step only counts at "all"');
  assert.equal(all.meta.fronts.thresholdCPerKm, FRONT_SENSITIVITY.all.thresholdCPerKm);
  assert.equal(calls.filter((call) => call.url.includes('/opendap/')).length, 1, 'the grid is reused');
  await assert.rejects(() => source({ period: 'day', bbox: BBOX, fronts: 'extreme' }), (error) => error.status === 400);
  await assert.rejects(() => source({ period: 'month', bbox: BBOX }), (error) => error.status === 400);
  await assert.rejects(() => source({ period: 'day', bbox: 'bad' }), (error) => error.status === 400);
});

test('if the land mask cannot be fetched, the view still draws and says so', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { source, range } = level3Fixture({
    landMask: async () => {
      throw new Error('offline');
    },
  });
  const view = await source({ period: '8d', bbox: BBOX });
  assert.equal(view.meta.landMask, 'unavailable');
  assert.equal(view.meta.landCells, null);
  assert.equal(view.meta.validCells, range.rows * range.cols);
  assert.equal(view.meta.startDate, '2026-07-20');
  assert.equal(view.meta.endDate, '2026-07-27');
});
