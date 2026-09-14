import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as constants from '../../server/providers/cctv/constants.js';
import * as normalize from '../../server/providers/cctv/normalize.js';
import * as catalogModule from '../../server/providers/cctv/catalog.js';
import { createCctvCatalog, hideListingDuplicatesOfAustin } from '../../server/providers/cctv/catalog.js';
import { CCTV_LIVE_PACKS, createCctvLivePacks } from '../../server/providers/cctv/live-packs.js';
import { caltransDistricts, loadAustinSourcesFromOpenData } from '../../server/providers/cctv/sources.js';
import { cctvProxy } from '../../server/providers/cctv.js';

// Every download here is a mocked fetch: Austin, Caltrans and TfL are never called.
const AUSTIN = { lat: 30.2672, lon: -97.7431, radiusKm: 50 };
const HOUSTON = { lat: 29.7604, lon: -95.3698, radiusKm: 50 };
const LOS_ANGELES = { lat: 34.0522, lon: -118.2437, radiusKm: 50 };
const LONDON = { lat: 51.5074, lon: -0.1278, radiusKm: 50 };

const austinPayload = (rows) => ({
  meta: { view: { columns: [{ fieldName: 'camera_id' }, { fieldName: 'camera_status' }, { fieldName: 'location_name' }, { fieldName: 'location' }] } },
  data: rows,
});
const row = (id, status, lat, lon, name = `Camera ${id}`) => [String(id), status, name, `POINT (${lon} ${lat})`];

/** 320 switched-on cameras (past every old cap) plus the edge cases. */
function austinRows() {
  const rows = [];
  for (let i = 0; i < 320; i += 1) rows.push(row(1000 + i, 'TURNED_ON', 30.2 + (i % 40) * 0.005, -97.8 + Math.floor(i / 40) * 0.01));
  rows.push(row(1, 'TURNED_OFF', 30.27, -97.74, 'Switched off'));
  rows.push(row(2, 'TURNED_ON', 30.65, -97.68, 'Georgetown suburb')); // outside the old Austin-only box
  rows.push(row(3, '', 30.3, -97.7, 'No status'));
  rows.push(row(4, 'DESIRED', 30.3, -97.7));
  rows.push(row(5, 'REMOVED', 30.3, -97.7));
  rows.push(row(6, 'VOID', 30.3, -97.7));
  rows.push(row(7, 'TURNED_ON', 0, 0, 'Null island'));
  rows.push(row(8, 'TURNED_ON', 45, -50, 'Atlantic'));
  return rows;
}
const AUSTIN_KEPT = 323;

function fetchRecorder(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    for (const [match, respond] of routes) if (href.includes(match)) return respond(href);
    throw new Error(`unexpected fetch ${href}`);
  };
  return { calls, fetchImpl };
}

function tempRoot(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-cctv-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const quiet = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

test('the Austin pack returns every camera: switched-off and suburban ones, no cap', async (t) => {
  quiet(t);
  const { calls, fetchImpl } = fetchRecorder([['data.austintexas.gov', () => Response.json(austinPayload(austinRows()))]]);
  const cameras = await loadAustinSourcesFromOpenData({ fetchImpl, env: {} });
  assert.equal(calls.length, 1);
  assert.equal(cameras.length, AUSTIN_KEPT);
  const ids = new Set(cameras.map((c) => c.id));
  for (const kept of ['1', '2', '3', '1319']) assert.ok(ids.has(kept), kept);
  for (const gone of ['4', '5', '6', '7', '8']) assert.ok(!ids.has(gone), gone);
});

test('Austin downloads only for an area that overlaps it with the US enabled, once for concurrent requests', async (t) => {
  quiet(t);
  const dir = tempRoot(t);
  const { calls, fetchImpl } = fetchRecorder([
    ['data.austintexas.gov', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json(austinPayload(austinRows()));
    }],
  ]);
  const missing = path.join(dir, 'none.json');
  const caOnly = createCctvCatalog({
    sourceRoot: dir,
    env: { CCTV_COUNTRIES: 'CA', CCTV_SOURCES_FILE: missing, CCTV_FORCE_AUSTIN: '1', CCTV_PREFER_AUSTIN: '1' },
    fetchImpl,
  });
  assert.equal((await caOnly.snapshot()).total, 0, 'no preferred or forced Austin fallback');
  assert.deepEqual(await caOnly.ensureArea(AUSTIN), { pending: [] });
  assert.equal(calls.length, 0, 'US disabled: no download');

  const catalog = createCctvCatalog({ sourceRoot: dir, env: { CCTV_COUNTRIES: 'CA,US', CCTV_SOURCES_FILE: missing }, fetchImpl });
  await catalog.snapshot();
  assert.equal(calls.length, 0, 'nothing downloads at startup');
  assert.deepEqual(await catalog.ensureArea(HOUSTON), { pending: [] });
  assert.equal(calls.length, 0, 'an area away from Austin does not download it');
  const both = await Promise.all([catalog.ensureArea(AUSTIN), catalog.ensureArea(AUSTIN)]);
  assert.deepEqual(both, [{ pending: [] }, { pending: [] }]);
  assert.equal(calls.length, 1, 'concurrent triggers share one download');
  const snapshot = await catalog.snapshot();
  assert.equal(snapshot.total, AUSTIN_KEPT);
  assert.equal(snapshot.byId.get('2').regionKey, 'US-TX');
  await catalog.ensureArea(AUSTIN);
  assert.equal(calls.length, 1, 'fresh for a day');
  assert.ok(existsSync(path.join(dir, '.gev-cache', 'cctv-austin.json')));
});

test('a slow download answers pending, then lands in the next snapshot', async (t) => {
  quiet(t);
  const dir = tempRoot(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { calls, fetchImpl } = fetchRecorder([
    ['data.austintexas.gov', async () => {
      await held;
      return Response.json(austinPayload(austinRows()));
    }],
  ]);
  const env = { CCTV_COUNTRIES: 'US', CCTV_SOURCES_FILE: path.join(dir, 'none.json') };
  const livePacks = createCctvLivePacks({ cacheDir: path.join(dir, '.gev-cache'), env, fetchImpl, waitMs: 20 });
  const catalog = createCctvCatalog({ sourceRoot: dir, env, livePacks });
  assert.deepEqual(await catalog.ensureArea(AUSTIN), { pending: ['austin'] });
  assert.equal((await catalog.snapshot()).total, 0);
  assert.deepEqual(await catalog.ensureArea(AUSTIN), { pending: ['austin'] }, 'still loading, still one download');
  assert.equal(calls.length, 1);
  release();
  for (let i = 0; i < 100 && (await catalog.snapshot()).total === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await catalog.snapshot()).total, AUSTIN_KEPT);
  assert.deepEqual(await catalog.ensureArea(AUSTIN), { pending: [] });
});

test('a second instance within 24 h reads the disk copy and downloads nothing', async (t) => {
  quiet(t);
  const dir = tempRoot(t);
  let clock = Date.UTC(2026, 8, 14, 10);
  const env = { CCTV_COUNTRIES: '*', CCTV_SOURCES_FILE: path.join(dir, 'none.json') };
  const first = fetchRecorder([['data.austintexas.gov', () => Response.json(austinPayload(austinRows()))]]);
  const one = createCctvCatalog({ sourceRoot: dir, env, fetchImpl: first.fetchImpl, now: () => clock });
  await one.ensureArea(AUSTIN);
  assert.equal(first.calls.length, 1);
  const saved = JSON.parse(readFileSync(path.join(dir, '.gev-cache', 'cctv-austin.json'), 'utf8'));
  assert.equal(saved.pack, 'austin');
  assert.equal(saved.sources.length, AUSTIN_KEPT);

  clock += 23 * 3600 * 1000;
  const later = fetchRecorder([['data.austintexas.gov', () => Response.json(austinPayload(austinRows()))]]);
  const two = createCctvCatalog({ sourceRoot: dir, env, fetchImpl: later.fetchImpl, now: () => clock });
  assert.deepEqual(await two.ensureArea(AUSTIN), { pending: [] });
  assert.equal(later.calls.length, 0);
  assert.equal((await two.snapshot()).total, AUSTIN_KEPT);

  clock += 2 * 3600 * 1000;
  const three = createCctvCatalog({ sourceRoot: dir, env, fetchImpl: later.fetchImpl, now: () => clock });
  await three.ensureArea(AUSTIN);
  assert.equal(later.calls.length, 1, 'past a day the list is downloaded again');
});

test('Caltrans loads only with CCTV_CALTRANS_DISTRICTS and a Californian area; TfL only for London with GB on', async (t) => {
  quiet(t);
  const dir = tempRoot(t);
  const caltransPayload = {
    data: [{
      cctv: {
        inService: 'true',
        location: { latitude: '34.05', longitude: '-118.25', locationName: 'TV101 -- US-101 : Main', nearbyPlace: 'Los Angeles', direction: 'North' },
        imageData: { static: { currentImageURL: 'https://cwwp2.dot.ca.gov/data/d7/cctv/image/tv101/tv101.jpg' } },
      },
    }],
  };
  const tflPayload = [{
    id: 'JamCams_00001.01', commonName: 'Tower Bridge', lat: 51.505, lon: -0.075,
    additionalProperties: [{ key: 'available', value: 'true' }, { key: 'imageUrl', value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.01.jpg' }],
  }];
  const { calls, fetchImpl } = fetchRecorder([
    ['cwwp2.dot.ca.gov', () => Response.json(caltransPayload)],
    ['api.tfl.gov.uk', () => Response.json(tflPayload)],
  ]);
  const env = { CCTV_COUNTRIES: 'US,GB', CCTV_SOURCES_FILE: path.join(dir, 'none.json') };
  const catalog = createCctvCatalog({ sourceRoot: dir, env, fetchImpl });
  assert.deepEqual(caltransDistricts({}), [], 'no default districts');
  await catalog.ensureArea(LOS_ANGELES);
  assert.equal(calls.length, 0, 'no districts, no Caltrans');
  env.CCTV_CALTRANS_DISTRICTS = '7';
  await catalog.ensureArea(HOUSTON);
  assert.equal(calls.length, 0, 'districts set, but the area is not in California');
  await catalog.ensureArea(LOS_ANGELES);
  assert.deepEqual(calls, ['https://cwwp2.dot.ca.gov/data/d7/cctv/cctvStatusD07.json']);

  env.CCTV_TFL_ENABLED = '0';
  await catalog.ensureArea(LONDON);
  assert.equal(calls.length, 1, 'TfL switched off');
  delete env.CCTV_TFL_ENABLED;
  env.CCTV_COUNTRIES = 'US';
  await catalog.ensureArea(LONDON);
  assert.equal(calls.length, 1, 'GB not enabled');
  env.CCTV_COUNTRIES = 'US,GB';
  await catalog.ensureArea(LONDON);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'https://api.tfl.gov.uk/Place/Type/JamCam');
  assert.deepEqual((await catalog.snapshot()).sources.map((s) => s.id).sort(), ['ca-d7-tv101', 'tfl-00001.01']);
});

test('a Caltrans download with a district down is kept in memory only, and retried after the retry wait', async (t) => {
  quiet(t);
  const dir = tempRoot(t);
  const cacheDir = path.join(dir, '.gev-cache');
  const cacheFile = path.join(cacheDir, 'cctv-caltrans.json');
  const district = (n, code, lat, lon) => ({
    data: [{
      cctv: {
        inService: 'true',
        location: { latitude: String(lat), longitude: String(lon), locationName: `${code} -- Main St`, nearbyPlace: `D${n} town` },
        imageData: { static: { currentImageURL: `https://cwwp2.dot.ca.gov/data/d${n}/cctv/image/${code.toLowerCase()}/${code.toLowerCase()}.jpg` } },
      },
    }],
  });
  let d4Down = true;
  const { calls, fetchImpl } = fetchRecorder([
    ['cctvStatusD04', () => {
      if (d4Down) throw new Error('D4 timed out');
      return Response.json(district(4, 'TV402', 37.8, -122.37));
    }],
    ['cctvStatusD07', () => Response.json(district(7, 'TV701', 34.05, -118.25))],
  ]);
  let clock = Date.UTC(2026, 8, 14, 10);
  const env = { CCTV_CALTRANS_DISTRICTS: '4,7' };
  const packs = CCTV_LIVE_PACKS.filter((pack) => pack.name === 'caltrans');
  const livePacks = createCctvLivePacks({ cacheDir, env, fetchImpl, now: () => clock, packs });
  const ids = () => livePacks.sources(null).sources.map((s) => s.id).sort();

  await livePacks.ensureArea(LOS_ANGELES, null);
  assert.equal(calls.length, 2);
  assert.deepEqual(ids(), ['ca-d7-tv701'], 'the districts that answered are served meanwhile');
  assert.equal(existsSync(cacheFile), false, 'an incomplete list is never saved as the day\'s download');

  clock += constants.CCTV_LIVE_PACK_RETRY_MS - 1;
  await livePacks.ensureArea(LOS_ANGELES, null);
  assert.equal(calls.length, 2, 'not retried before the retry wait');

  clock += 2;
  d4Down = false;
  await livePacks.ensureArea(LOS_ANGELES, null);
  assert.equal(calls.length, 4, 'every district is asked again');
  assert.deepEqual(ids(), ['ca-d4-tv402', 'ca-d7-tv701']);
  assert.ok(existsSync(cacheFile), 'the complete list is saved');

  clock += 60 * 60 * 1000;
  await livePacks.ensureArea(LOS_ANGELES, null);
  assert.equal(calls.length, 4, 'a complete list stays fresh for the day');
  const restarted = fetchRecorder([['cwwp2.dot.ca.gov', () => Response.json({ data: [] })]]);
  const again = createCctvLivePacks({ cacheDir, env, fetchImpl: restarted.fetchImpl, now: () => clock, packs });
  await again.ensureArea(LOS_ANGELES, null);
  assert.equal(restarted.calls.length, 0, 'a restart reads the complete disk copy');
  assert.deepEqual(again.sources(null).sources.map((s) => s.id).sort(), ['ca-d4-tv402', 'ca-d7-tv701']);
});

test('a Road511 listing camera within 30 m of an Austin open-data camera is hidden', async (t) => {
  quiet(t);
  const dir = tempRoot(t);
  mkdirSync(path.join(dir, 'config'));
  const pack = path.join(dir, 'config', 'us.json');
  // Austin camera 1 stands at 30.27,-97.74. One listing entry ~11 m north of it, one ~220 m north.
  writeFileSync(pack, JSON.stringify({
    format: 'gev-cctv-pack/1',
    defaults: { country: 'US', sourceKind: 'configured' },
    providers: { tx: { provider: 'TxDOT', license: 'TxDOT (listing: Road511)' } },
    cameras: [
      { id: 'us511-TX-cam-near', name: 'Near', region: 'TX', lat: 30.2701, lon: -97.74, p: 'tx', feedType: 'none', lookup: 'road511' },
      { id: 'us511-TX-cam-far', name: 'Far', region: 'TX', lat: 30.272, lon: -97.74, p: 'tx', feedType: 'none', lookup: 'road511' },
    ],
  }));
  const { fetchImpl } = fetchRecorder([['data.austintexas.gov', () => Response.json(austinPayload(austinRows()))]]);
  const catalog = createCctvCatalog({ sourceRoot: dir, env: { CCTV_COUNTRIES: 'US', CCTV_SOURCES_FILE: pack }, fetchImpl });
  assert.ok((await catalog.snapshot()).byId.has('us511-TX-cam-near'), 'without the Austin pack the listing camera shows');
  await catalog.ensureArea(AUSTIN);
  const after = await catalog.snapshot();
  assert.ok(!after.byId.has('us511-TX-cam-near'));
  assert.ok(after.byId.has('us511-TX-cam-far'));
  assert.ok(after.byId.has('1'));
  assert.equal(after.byId.get('us511-TX-cam-far').provider, 'TxDOT');

  const austinCam = { id: 'a', sourceKind: 'austin-open-data', lat: 30, lon: -97 };
  const kept = hideListingDuplicatesOfAustin([
    austinCam,
    { id: 'us511-TX-cam-x', lat: 30.00026, lon: -97 }, // ~29 m
    { id: 'us511-TX-cam-y', lat: 30.0003, lon: -97 }, // ~33 m
    { id: 'other', lat: 30, lon: -97 },
  ]);
  assert.deepEqual(kept.map((s) => s.id), ['a', 'us511-TX-cam-y', 'other']);
});

test('/sources near Austin serves the open-data pack, reporting pending while it downloads', async (t) => {
  quiet(t);
  const dir = tempRoot(t);
  for (const [name, value] of Object.entries({ CCTV_COUNTRIES: 'US', CCTV_SOURCES_FILE: path.join(dir, 'none.json'), CCTV_SOURCES_JSON: undefined })) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { calls, fetchImpl } = fetchRecorder([
    ['data.austintexas.gov', async () => {
      await held;
      return Response.json(austinPayload(austinRows()));
    }],
  ]);
  const livePacks = createCctvLivePacks({ cacheDir: path.join(dir, '.gev-cache'), fetchImpl, waitMs: 20 });
  const plugin = cctvProxy({ sourceRoot: dir, catalog: createCctvCatalog({ sourceRoot: dir, livePacks }) });
  let handler;
  plugin.configureServer({ middlewares: { use(_route, fn) { handler = fn; } } });
  const get = async (url) => {
    const res = { writeHead(status, headers) { Object.assign(this, { status, headers }); }, end(body) { this.body = body; } };
    await handler({ url, method: 'GET' }, res);
    return JSON.parse(res.body);
  };
  const waiting = await get('/sources?lat=30.2672&lon=-97.7431');
  assert.deepEqual(waiting.area.pending, ['austin']);
  assert.deepEqual(waiting.sources, []);
  release();
  let ready = waiting;
  for (let i = 0; i < 100 && !ready.sources.length; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    ready = await get('/sources?lat=30.2672&lon=-97.7431');
  }
  assert.deepEqual(ready.area.pending, []);
  assert.equal(ready.sources.length, AUSTIN_KEPT);
  assert.ok(ready.sources.every((s) => s.feedType === 'image' && s.region === 'US-TX'));
  assert.equal(calls.length, 1);
});

test('school cameras in a live pack are never cached or served, including an old disk copy', async (t) => {
  quiet(t);
  const dir = tempRoot(t);
  const rows = [
    row(10, 'TURNED_ON', 30.27, -97.74, '1ST ST / 1ST ST (Akins High School - Main Entrance)'),
    row(11, 'TURNED_ON', 30.28, -97.74, '7400 BLK W US 290 HWY (ACC Pinnacle Campus NE)'),
    row(12, 'TURNED_ON', 30.29, -97.74, 'W UNIVERSITY AVE / GUADALUPE ST'),
    row(13, 'TURNED_ON', 30.3, -97.74, 'LAMAR BLVD / 38TH ST'),
  ];
  const { calls, fetchImpl } = fetchRecorder([['data.austintexas.gov', () => Response.json(austinPayload(rows))]]);
  const env = { CCTV_COUNTRIES: 'US', CCTV_SOURCES_FILE: path.join(dir, 'none.json') };
  const catalog = createCctvCatalog({ sourceRoot: dir, env, fetchImpl });
  await catalog.ensureArea(AUSTIN);
  assert.equal(calls.length, 1);
  assert.deepEqual([...(await catalog.snapshot()).byId.keys()].sort(), ['12', '13']);
  const file = path.join(dir, '.gev-cache', 'cctv-austin.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.sources.map((s) => s.id).sort(), ['12', '13'], 'the disk copy holds no school camera');

  // A copy saved before the filter existed is cleaned when it is read back.
  saved.sources.push({ ...saved.sources[0], id: '99', name: '12500 BLK N LAMAR BLVD (Connally High School)' });
  writeFileSync(file, JSON.stringify(saved));
  const later = fetchRecorder([['data.austintexas.gov', () => Response.json(austinPayload(rows))]]);
  const reopened = createCctvCatalog({ sourceRoot: dir, env, fetchImpl: later.fetchImpl });
  await reopened.ensureArea(AUSTIN);
  assert.equal(later.calls.length, 0, 'the day-old copy is still fresh');
  const ids = [...(await reopened.snapshot()).byId.keys()].sort();
  assert.deepEqual(ids, ['12', '13']);
});

test('a school camera in a pack file is left out of the catalogue', async (t) => {
  quiet(t);
  const dir = tempRoot(t);
  const pack = path.join(dir, 'pack.json');
  writeFileSync(pack, JSON.stringify([
    { id: 'a', name: 'Lincoln High School', lat: 45, lon: -66, country: 'CA', feedType: 'image', url: 'https://example.com/a.jpg' },
    { id: 'b', name: 'University Ave at Main St', lat: 45.01, lon: -66, country: 'CA', feedType: 'image', url: 'https://example.com/b.jpg' },
  ]));
  const catalog = createCctvCatalog({ sourceRoot: dir, env: { CCTV_COUNTRIES: 'CA', CCTV_SOURCES_FILE: pack } });
  assert.deepEqual([...(await catalog.snapshot()).byId.keys()], ['b']);
});

test('no special pack defaults, caps or preference switches remain', () => {
  for (const name of [
    'DEFAULT_AUSTIN_MAX_SOURCES', 'AUSTIN_DOWNTOWN', 'DEFAULT_CALTRANS_DISTRICTS', 'DEFAULT_CALTRANS_MAX_SOURCES', 'CALTRANS_ANCHORS',
    'DEFAULT_TFL_MAX_SOURCES', 'LONDON_CENTER', 'CCTV_MAX_SOURCES_HARD_CAP', 'DEFAULT_CCTV_MAX_SOURCES', 'CCTV_REGION_CAP_HARD_LIMIT',
    'DEFAULT_CCTV_REGION_CAP', 'CCTV_SOURCE_CACHE_MS', 'DEFAULT_CCTV_SOURCE_FILE',
  ]) {
    assert.equal(name in constants, false, name);
  }
  assert.equal(typeof constants.DEFAULT_AUSTIN_ROWS_URL, 'string');
  assert.equal(constants.CALTRANS_CCTV_URL(4), 'https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json');
  for (const name of ['prioritizeSources', 'isLikelyAustinCoordinate']) assert.equal(name in normalize, false, name);
  for (const name of ['capSourcesPerRegion', 'capSourcesPerCountry', 'cctvRegionCapSettings', 'regionLabel']) {
    assert.equal(name in catalogModule, false, name);
  }
  assert.equal(typeof catalogModule.cctvRegionKey, 'function');
  assert.equal(typeof catalogModule.enabledCctvCountries, 'function');
  const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../server/providers');
  for (const file of ['cctv.js', 'cctv/catalog.js', 'cctv/sources.js', 'cctv/live-packs.js', 'cctv/constants.js']) {
    const text = readFileSync(path.join(serverDir, file), 'utf8');
    for (const retired of ['CCTV_PREFER_AUSTIN', 'CCTV_FORCE_AUSTIN', 'CCTV_AUSTIN_MAX_SOURCES', 'CCTV_CALTRANS_MAX_SOURCES', 'CCTV_TFL_MAX_SOURCES', 'CCTV_MAX_SOURCES', 'CCTV_REGION_CAP']) {
      assert.equal(new RegExp(`\\b${retired}\\b`).test(text), false, `${file} mentions ${retired}`);
    }
  }
});
