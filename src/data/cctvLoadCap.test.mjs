import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { cctvProxy } from '../../server/providers/cctv.js';

// The per-area load cap at the route: at most 1,000 cameras within 50 km of a
// selected point, nearest first; the catalogue behind it keeps every camera.

function setup(t, sources, env = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-cctv-area-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  const file = path.join(root, 'config', 'pack.json');
  writeFileSync(file, JSON.stringify(sources));
  for (const [name, value] of Object.entries({
    CCTV_SOURCES_FILE: file,
    CCTV_SOURCES_JSON: undefined,
    CCTV_COUNTRIES: 'CA,US',
    CCTV_STREETVIEW_FALLBACK: undefined,
    ROAD511_API_KEY: undefined,
    GOOGLE_MAPS_SERVER_API_KEY: undefined,
    GOOGLE_MAPS_API_KEY: undefined,
    ...env,
  })) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  return root;
}

function install(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use(_route, fn) { handler = fn; } } });
  return async (url, { headers } = {}) => {
    const res = {
      writeHead(status, responseHeaders) { Object.assign(this, { status, headers: responseHeaders }); },
      end(body) { this.body = body; },
    };
    // A request with no headers object at all must not break the route.
    await handler(headers ? { url, method: 'GET', headers } : { url, method: 'GET' }, res);
    return res;
  };
}

function noNetwork(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    throw new Error('this test has no network');
  });
  return calls;
}

const HOUSTON = { lat: 29.76, lon: -95.37 };
const DALLAS = { lat: 32.78, lon: -96.8 };
const EL_PASO = { lat: 31.76, lon: -106.49 };
const CORPUS_CHRISTI = { lat: 27.8, lon: -97.4 };

const cluster = (prefix, center, count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`, name: `${prefix} ${i}`, country: 'US', region: 'TX',
    lat: center.lat + ((i % 50) - 25) * 0.002, lon: center.lon + (Math.floor(i / 50) - 20) * 0.002,
    feedType: 'image', url: `https://cams.example.org/${prefix}/${i}.jpg`,
  }));
const areaUrl = ({ lat, lon }, extra = '') => `/sources?lat=${lat}&lon=${lon}${extra}`;

test('without a point /sources lists nothing, never the whole catalogue', async (t) => {
  const root = setup(t, cluster('hou', HOUSTON, 10));
  const calls = noNetwork(t);
  const request = install(cctvProxy({ sourceRoot: root }));
  for (const query of ['', '?lat=29.76', '?lon=-95.37', '?lat=&lon=', '?lat=abc&lon=1', '?lat=95&lon=0']) {
    const res = await request(`/sources${query}`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.sources, [], query);
    assert.equal(body.area.pointRequired, true);
    assert.equal(body.area.total, 10);
    assert.deepEqual(body.area.pending, []);
  }
  assert.equal(calls.length, 0);
});

test('an area lists its cameras nearest first with distance, region and lookup state', async (t) => {
  const root = setup(t, [
    { id: 'far', name: 'Far', country: 'US', region: 'TX', lat: 30.9, lon: -95.37, feedType: 'image', url: 'https://cams.example.org/far.jpg' },
    { id: 'us511-TX-cam-9', name: 'Lookup', city: 'Houston', country: 'US', region: 'TX', lat: 29.8, lon: -95.37, feedType: 'none', lookup: 'road511' },
    { id: 'near', name: 'Near', city: 'Houston', country: 'US', region: 'Texas', lat: 29.761, lon: -95.37, feedType: 'image', url: 'https://cams.example.org/near.jpg', headingDeg: 90 },
  ]);
  const calls = noNetwork(t);
  const request = install(cctvProxy({ sourceRoot: root }));
  const body = JSON.parse((await request(areaUrl(HOUSTON, '&radiusKm=500&limit=99999'))).body);
  assert.deepEqual(body.sources.map((s) => s.id), ['near', 'us511-TX-cam-9']);
  assert.deepEqual(
    { ...body.area },
    { lat: 29.76, lon: -95.37, radiusKm: 50, limit: 1000, inArea: 2, loaded: 2, dropped: 0, reachKm: 50, capped: false, total: 3, generation: 1, pending: [] },
  );
  const [near, lookup] = body.sources;
  for (const key of [
    'id', 'name', 'city', 'cityId', 'country', 'region', 'provider', 'lat', 'lon', 'headingDeg', 'headingConfidence', 'pitchDeg', 'fovDeg',
    'rangeM', 'mountHeightM', 'groundElevationM', 'feedType', 'sourceKind', 'license', 'distKm', 'lookup', 'lookupState',
  ]) {
    assert.ok(key in near, key);
  }
  assert.equal(near.region, 'US-TX');
  assert.equal(near.lookup, '');
  assert.equal(near.lookupState, 'resolved');
  assert.equal(near.feedType, 'image');
  assert.ok(near.distKm > 0.1 && near.distKm < 0.12, String(near.distKm));
  assert.equal(lookup.feedType, 'none');
  assert.equal(lookup.lookup, 'road511');
  assert.equal(lookup.lookupState, 'unresolved');

  const small = JSON.parse((await request(areaUrl(HOUSTON, '&radiusKm=0.1'))).body);
  assert.equal(small.area.radiusKm, 0.5);
  assert.deepEqual(small.sources.map((s) => s.id), ['near']);
  assert.equal(calls.length, 0);
});

test('the area list is gzipped when the client accepts it', async (t) => {
  const root = setup(t, cluster('hou', HOUSTON, 400));
  noNetwork(t);
  const request = install(cctvProxy({ sourceRoot: root }));
  const packed = await request(areaUrl(HOUSTON), { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  assert.equal(packed.headers['Content-Encoding'], 'gzip');
  assert.equal(packed.headers.Vary, 'Accept-Encoding');
  assert.equal(packed.headers['Content-Length'], packed.body.length);
  const unpacked = JSON.parse(gunzipSync(packed.body).toString('utf8'));
  assert.equal(unpacked.sources.length, 400);
  const plain = await request(areaUrl(HOUSTON));
  assert.equal(plain.headers['Content-Encoding'], undefined);
  assert.deepEqual(JSON.parse(plain.body), unpacked);
  assert.ok(packed.body.length < plain.body.length / 3, 'gzip pays for itself');
});

test('3,000 cameras in one state are all reachable, 1,000 at most per area', async (t) => {
  const root = setup(t, [
    ...cluster('hou', HOUSTON, 1000),
    ...cluster('dal', DALLAS, 1000),
    ...cluster('elp', EL_PASO, 1000),
    ...cluster('dense', CORPUS_CHRISTI, 3000),
  ]);
  const calls = noNetwork(t);
  const request = install(cctvProxy({ sourceRoot: root }));
  const seen = new Set();
  for (const center of [HOUSTON, DALLAS, EL_PASO]) {
    const body = JSON.parse((await request(areaUrl(center))).body);
    assert.equal(body.sources.length, 1000);
    for (const source of body.sources) seen.add(source.id);
  }
  assert.equal(seen.size, 3000);
  const dense = JSON.parse((await request(areaUrl(CORPUS_CHRISTI, '&limit=5000'))).body);
  assert.equal(dense.sources.length, 1000);
  assert.equal(dense.area.inArea, 3000);
  assert.equal(dense.area.loaded, 1000);
  assert.equal(dense.area.dropped, 2000);
  assert.equal(dense.area.capped, true);
  assert.ok(dense.area.reachKm < 50);
  assert.equal(dense.area.total, 6000);
  const distances = dense.sources.map((s) => s.distKm);
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b), 'nearest first');
  assert.equal(calls.length, 0, 'listing areas contacts no upstream');
});

test('a disabled country is not listed and its frames are never fetched', async (t) => {
  const root = setup(t, cluster('hou', HOUSTON, 3), { CCTV_COUNTRIES: 'CA' });
  const calls = noNetwork(t);
  const request = install(cctvProxy({ sourceRoot: root }));
  const body = JSON.parse((await request(areaUrl(HOUSTON))).body);
  assert.deepEqual(body.sources, []);
  assert.equal(body.area.total, 0);
  assert.equal((await request('/frame/hou-0?active=1')).headers['X-CCTV-Source'], 'synthetic');
  assert.equal((await request('/media/hou-0')).status, 404);
  assert.equal(calls.length, 0);
});
