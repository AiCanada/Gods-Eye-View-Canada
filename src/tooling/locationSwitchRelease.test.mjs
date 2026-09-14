import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  LOCATION_SWITCH_RELEASE_RADIUS_KM,
  admitLocationSwitchRequest,
  locationSwitchReleaseEndpoint,
} from '../../server/providers/location-switch.js';
import { localProviderPlugins } from '../../server/providers/local.js';
import {
  _overpassCache,
  pruneOverpassMemoryOutside,
} from '../../server/providers/overpass/cache.js';
import {
  _militaryInstallationCache,
  pruneMilitaryInstallationMemoryOutside,
} from '../../server/providers/military-installations/cache.js';
import { pruneWeatherEffectsCacheOutside } from '../../server/providers/regional/weather-effects.js';
import { pruneAdsbLolPointCacheOutside } from '../../server/providers/aircraft/opensky.js';
import { pruneTomTomMemoryOutside } from '../../server/providers/traffic.js';
import { pruneRoadTileMemoryOutside } from '../../server/providers/roads-tiles.js';
import {
  pruneTerrainMemoryOutside,
  terrainHeightsProxy,
} from '../../server/providers/terrain.js';
import { lonLatToTile } from '../../src/data/tomtomTiles.js';

const TORONTO = { latitude: 43.6532, longitude: -79.3832 };
const ROUTE = '/api/location-switch/release';

function install(plugin, preview = false, config = undefined) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
    config,
  });
  return routes;
}
function request(
  handler,
  { method = 'POST', url = '/', body = '', headers = {} } = {},
) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, {
      method,
      url,
      headers: {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        ...headers,
      },
      socket: { remoteAddress: '127.0.0.1' },
    });
    for (const [name, value] of Object.entries(req.headers))
      if (value === undefined) delete req.headers[name];
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(status, values) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(values))
          this.headers[k.toLowerCase()] = v;
      },
      end(text = '') {
        resolve({
          status: this.statusCode,
          headers: this.headers,
          json: () => JSON.parse(String(text)),
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
const overpassKey = (ql) => `data=${encodeURIComponent(ql)}`;

test('release route refuses other methods, cross-site callers and bad bodies in development and preview', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('a release must never fetch');
  });
  t.mock.method(console, 'warn', () => {});
  const point = JSON.stringify({ latitude: 43.65, longitude: -79.38 });
  for (const preview of [false, true]) {
    const handler = install(locationSwitchReleaseEndpoint(), preview).get(
      ROUTE,
    );
    const get = await request(handler, { method: 'GET' });
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, 'POST');
    for (const headers of [
      { origin: 'https://attacker.example' },
      { origin: 'http://localhost:4173' },
      { origin: undefined },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ]) {
      assert.equal(
        (await request(handler, { body: point, headers })).status,
        403,
        JSON.stringify(headers),
      );
    }
    assert.equal(
      (
        await request(handler, {
          body: point,
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
      415,
    );
    for (const body of [
      'not json',
      '',
      'null',
      JSON.stringify({ latitude: '43.65', longitude: -79.38 }),
      JSON.stringify({ latitude: 91, longitude: 0 }),
      JSON.stringify({ latitude: 0, longitude: -181 }),
    ]) {
      assert.equal((await request(handler, { body })).status, 400, body);
    }
    const large = JSON.stringify({
      latitude: 1,
      longitude: 1,
      pad: 'x'.repeat(1100),
    });
    assert.equal((await request(handler, { body: large })).status, 413);
    assert.equal(
      (
        await request(handler, {
          body: point,
          headers: { 'content-length': '5000' },
        })
      ).status,
      413,
    );
    assert.equal(
      (await request(handler, { url: '/other', body: point })).status,
      404,
    );
    // A same-origin request without Fetch Metadata (older browsers) is admitted.
    const ok = await request(handler, {
      body: point,
      headers: { 'sec-fetch-site': undefined },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
  }
});

test('release route refuses Hosts the server does not serve, so a DNS-rebinding page cannot release memory', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('a release must never fetch');
  });
  const point = JSON.stringify({ latitude: 43.65, longitude: -79.38 });
  // A rebinding page's Origin always matches the Host it was loaded from.
  const status = async (handler, host) =>
    (
      await request(handler, {
        body: point,
        headers: { host, origin: `http://${host}` },
      })
    ).status;
  const listed = ['localhost', '127.0.0.1', '.local'];
  for (const preview of [false, true]) {
    for (const config of [
      undefined,
      { server: { allowedHosts: listed }, preview: { allowedHosts: listed } },
    ]) {
      const handler = install(
        locationSwitchReleaseEndpoint(),
        preview,
        config,
      ).get(ROUTE);
      for (const host of [
        'attacker.example:5173',
        'mybox.lan:5173',
        'evil-local:5173',
        'local.attacker.example:5173',
      ])
        assert.equal(await status(handler, host), 403, host);
      for (const host of [
        'localhost:5173',
        '127.0.0.1:5173',
        'mybox.local:5173',
        'local:5173',
        'app.localhost:5173',
        '[::1]:5173',
        '192.168.1.5:5173',
      ])
        assert.equal(await status(handler, host), 200, host);
    }
  }

  // HOST=0.0.0.0 (LAN mode) sets allowedHosts true, and each hook reads its
  // own server's setting.
  const lan = {
    server: { allowedHosts: true },
    preview: { allowedHosts: listed },
  };
  const dev = install(locationSwitchReleaseEndpoint(), false, lan).get(ROUTE);
  assert.equal(await status(dev, '192.168.1.5:5173'), 200);
  assert.equal(await status(dev, 'mybox.lan:5173'), 200);
  const preview = install(locationSwitchReleaseEndpoint(), true, lan).get(
    ROUTE,
  );
  assert.equal(await status(preview, 'mybox.lan:5173'), 403);

  // Vite also serves the host name the server was started with.
  const named = install(locationSwitchReleaseEndpoint(), false, {
    server: { allowedHosts: [] },
    additionalAllowedHosts: ['mybox.lan'],
  }).get(ROUTE);
  assert.equal(await status(named, 'mybox.lan:5173'), 200);
  assert.equal(await status(named, 'attacker.example:5173'), 403);

  // Called without options, the guard fails closed.
  const rebound = {
    method: 'POST',
    headers: {
      host: 'attacker.example:5173',
      origin: 'http://attacker.example:5173',
      'content-type': 'application/json',
    },
    socket: {},
  };
  assert.equal(admitLocationSwitchRequest(rebound).status, 403);
  assert.equal(
    admitLocationSwitchRequest(rebound, { allowedHosts: true }).ok,
    true,
  );
});

test('release route answers per-cache counts and prunes only far area entries', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('a release must never fetch');
  });
  const nearQl = `[out:json][timeout:20];way(around:320,43.6532,-79.3832)["highway"]["name"];out geom;`;
  const farQl = `[out:json][timeout:25];is_in(48.8566,2.3522)->.a;area.a["boundary"="administrative"]["admin_level"];out tags;`;
  _overpassCache.set(overpassKey(nearQl), { cachedAt: Date.now() });
  _overpassCache.set(overpassKey(farQl), { cachedAt: Date.now() });
  _militaryInstallationCache.set('43.600,-79.450,43.700,-79.350', {});
  _militaryInstallationCache.set(
    'exact:35.60000,139.60000,35.70000,139.80000',
    {},
  );
  t.after(() => {
    _overpassCache.clear();
    _militaryInstallationCache.clear();
  });
  const handler = install(locationSwitchReleaseEndpoint()).get(ROUTE);
  const res = await request(handler, { body: JSON.stringify(TORONTO) });
  assert.equal(res.status, 200);
  const { released } = res.json();
  assert.deepEqual(Object.keys(released).sort(), [
    'adsbLolPoints',
    'militaryInstallations',
    'overpass',
    'roadTiles',
    'terrainHeights',
    'tomtomTiles',
    'weatherEffects',
  ]);
  assert.equal(released.overpass, 1);
  assert.equal(released.militaryInstallations, 1);
  assert.deepEqual([..._overpassCache.keys()], [overpassKey(nearQl)]);
  assert.deepEqual(
    [..._militaryInstallationCache.keys()],
    ['43.600,-79.450,43.700,-79.350'],
  );
  assert.equal(LOCATION_SWITCH_RELEASE_RADIUS_KM, 300);
});

test('standalone composition mounts the release route exactly once, before key setup', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('construction must not fetch');
  });
  const names = localProviderPlugins().map((plugin) => plugin.name);
  assert.equal(
    names.filter((name) => name === 'location-switch-release').length,
    1,
  );
  assert.equal(names.at(-1), 'gev-key-setup');
});

test('prune helpers delete only entries whose area centre is beyond the radius', () => {
  const military = new Map(
    [
      '43.600,-79.450,43.700,-79.350',
      'exact:44.20000,-76.60000,44.30000,-76.40000', // Kingston, ~230 km
      '45.400,-75.750,45.450,-75.650', // Ottawa, ~350 km
      'not-a-box',
    ].map((key) => [key, {}]),
  );
  assert.equal(
    pruneMilitaryInstallationMemoryOutside(TORONTO, 300, military),
    1,
  );
  assert.deepEqual(
    [...military.keys()],
    [
      '43.600,-79.450,43.700,-79.350',
      'exact:44.20000,-76.60000,44.30000,-76.40000',
      'not-a-box',
    ],
  );

  const overpass = new Map(
    [
      // Road bbox around Toronto.
      '[out:json][timeout:25];(way["highway"~"motorway"](43.64,-79.40,43.66,-79.37););out geom qt;',
      // Paris road bbox.
      '[out:json][timeout:25];(way["highway"~"motorway"](48.85,2.34,48.87,2.36););out geom qt;',
      // Boundary pivot by area id: no coordinates, always kept.
      '[out:json][timeout:25];area(3600000001)->.x;rel(pivot.x);out geom;',
      // Mixed anchors: kept while any anchor is near.
      '[out:json];(way(around:100,48.85,2.35);way(around:100,43.65,-79.38););out;',
      // Quoted literals are not stripped, so this London query's fake Toronto
      // bbox reads as an anchor. An extra anchor can only keep an entry.
      '[out:json];way(around:450,51.5074,-0.1278)["name"="(43.65,-79.38,43.66,-79.37)"];out;',
    ].map((ql) => [overpassKey(ql), {}]),
  );
  assert.equal(pruneOverpassMemoryOutside(TORONTO, 300, overpass), 1);
  assert.equal(overpass.size, 4);
  assert.equal(
    [...overpass.keys()].some((key) => key.includes('48.85%2C2.34')),
    false,
  );

  const weather = new Map([
    ['43.7,-79.4', {}],
    ['48.9,2.4', {}],
    ['nonsense', {}],
  ]);
  assert.equal(pruneWeatherEffectsCacheOutside(TORONTO, 300, weather), 1);
  assert.deepEqual([...weather.keys()], ['43.7,-79.4', 'nonsense']);

  const adsb = new Map([
    ['43.75,-79.50', {}],
    ['35.75,139.75', {}],
  ]);
  assert.equal(pruneAdsbLolPointCacheOutside(TORONTO, 300, adsb), 1);
  assert.deepEqual([...adsb.keys()], ['43.75,-79.50']);

  const near = lonLatToTile(-79.38, 43.65, 12);
  const far = lonLatToTile(2.35, 48.85, 12);
  const tiles = new Map([
    [`12/${near.x}/${near.y}`, {}],
    [`12/${far.x}/${far.y}`, {}],
    ['99/0/0', {}],
  ]);
  assert.equal(pruneTomTomMemoryOutside(TORONTO, 300, [tiles]), 1);
  assert.deepEqual([...tiles.keys()], [`12/${near.x}/${near.y}`, '99/0/0']);

  // Road tiles are keyed by planet version, then z/x/y, down to z0.
  const roadNear = lonLatToTile(-79.38, 43.65, 14);
  const roadFar = lonLatToTile(2.35, 48.85, 14);
  const roads = new Map([
    [`20260906_080001_pt/14/${roadNear.x}/${roadNear.y}`, Buffer.alloc(1)],
    [`20260906_080001_pt/14/${roadFar.x}/${roadFar.y}`, Buffer.alloc(1)],
    ['20260906_080001_pt/15/0/0', Buffer.alloc(1)],
  ]);
  assert.equal(pruneRoadTileMemoryOutside(TORONTO, 300, [roads]), 1);
  assert.deepEqual(
    [...roads.keys()],
    [
      `20260906_080001_pt/14/${roadNear.x}/${roadNear.y}`,
      '20260906_080001_pt/15/0/0',
    ],
  );

  // An unusable centre or radius releases nothing.
  for (const [point, radius] of [
    [null, 300],
    [{ latitude: Number.NaN, longitude: 0 }, 300],
    [TORONTO, Number.NaN],
    [TORONTO, -1],
  ]) {
    assert.equal(pruneWeatherEffectsCacheOutside(point, radius, weather), 0);
    assert.equal(pruneOverpassMemoryOutside(point, radius, overpass), 0);
    assert.equal(pruneTomTomMemoryOutside(point, radius, [tiles]), 0);
    assert.equal(pruneRoadTileMemoryOutside(point, radius, [roads]), 0);
  }
  assert.equal(weather.size, 2);
});

const TERRAIN_CACHE_FILE = path.join(
  process.cwd(),
  '.gev-cache',
  'terrain-heights.json',
);

/**
 * In-memory stand-in for the terrain cache directory. While `hold` is set,
 * each write stays half done until the promise it returns resolves, the way
 * Node writes a large file in chunks. `failRename` makes the rename throw.
 */
function mockTerrainDisk(t, points) {
  const files = new Map([
    [TERRAIN_CACHE_FILE, JSON.stringify({ version: 2, points })],
  ]);
  const disk = {
    files,
    writes: [],
    renames: [],
    removed: [],
    hold: null,
    failRename: false,
  };
  t.mock.method(fsp, 'readFile', async (file) => {
    const text = files.get(String(file));
    if (text === undefined)
      throw Object.assign(Error('absent'), { code: 'ENOENT' });
    return text;
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async (file, text) => {
    disk.writes.push(String(file));
    if (disk.hold) {
      files.set(String(file), text.slice(0, text.length >> 1));
      await disk.hold();
    }
    files.set(String(file), text);
  });
  t.mock.method(fsp, 'rename', async (from, to) => {
    disk.renames.push([String(from), String(to)]);
    if (disk.failRename) throw Object.assign(Error('busy'), { code: 'EPERM' });
    files.set(String(to), files.get(String(from)));
    files.delete(String(from));
  });
  t.mock.method(fsp, 'rm', async (file) => {
    disk.removed.push(String(file));
    files.delete(String(file));
  });
  return disk;
}

/** A terrain proxy with its periodic flush captured; upstream answers lon + 1000. */
function terrainFixture(t) {
  const fixture = { calls: 0, flush: null, heights: null };
  t.mock.method(globalThis, 'setInterval', (callback) => {
    fixture.flush = callback;
    return { unref() {} };
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (raw) => {
    fixture.calls++;
    const points = new URL(raw).searchParams
      .get('points')
      .split(';')
      .map((p) => p.split(',').map(Number));
    return Response.json({
      results: points.map(([lon]) => ({ ellipsoid: lon + 1000 })),
    });
  });
  const handler = install(terrainHeightsProxy()).get('/api/terrain/heights');
  fixture.heights = async (points) => {
    const res = {
      headersSent: false,
      writeHead(status) {
        Object.assign(this, { status, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url: `/?points=${points}`, method: 'GET' }, res);
    return { status: res.status, ...JSON.parse(res.body) };
  };
  return fixture;
}

test('terrain release keeps the disk file whole and restores released cells from disk before upstream', async (t) => {
  const disk = mockTerrainDisk(t, {
    '-79.38000,43.65000': { at: Date.now(), result: { ellipsoid: 100 } },
    '2.35000,48.85000': { at: Date.now(), result: { ellipsoid: 200 } },
  });
  const terrain = terrainFixture(t);
  const { heights } = terrain;

  assert.deepEqual((await heights('-79.38,43.65')).results, [
    { ellipsoid: 100 },
  ]);
  assert.equal(pruneTerrainMemoryOutside(TORONTO, 300), 1, 'Paris released');
  assert.equal(pruneTerrainMemoryOutside(TORONTO, 300), 0, 'idempotent');

  // Tokyo is fetched but not yet on disk, so a release must keep it.
  assert.deepEqual((await heights('139.69,35.69')).results, [
    { ellipsoid: 1139.69 },
  ]);
  assert.equal(terrain.calls, 1);
  assert.equal(pruneTerrainMemoryOutside(TORONTO, 300), 0);

  // The flush merges the released Paris point back instead of dropping it.
  await terrain.flush();
  assert.equal(disk.writes.length, 1);
  assert.deepEqual(
    Object.keys(JSON.parse(disk.files.get(TERRAIN_CACHE_FILE)).points).sort(),
    ['-79.38000,43.65000', '139.69000,35.69000', '2.35000,48.85000'],
  );
  assert.equal(pruneTerrainMemoryOutside(TORONTO, 300), 1, 'Tokyo released');

  // Released cells come back from disk, not from upstream.
  assert.deepEqual((await heights('2.35,48.85;139.69,35.69')).results, [
    { ellipsoid: 200 },
    { ellipsoid: 1139.69 },
  ]);
  assert.equal(terrain.calls, 1);

  // An unreadable file never replaces the disk cache with memory alone.
  assert.equal(pruneTerrainMemoryOutside(TORONTO, 300), 2);
  await heights('-79.30,43.70');
  assert.equal(terrain.calls, 2);
  const truncated = '{"version":2,"points":{';
  disk.files.set(TERRAIN_CACHE_FILE, truncated);
  await terrain.flush();
  assert.equal(disk.writes.length, 1);
  assert.deepEqual([...disk.files], [[TERRAIN_CACHE_FILE, truncated]]);
});

test('terrain flush writes beside the cache file and renames it over, so a restore during the write reads the whole previous file', async (t) => {
  const disk = mockTerrainDisk(t, {
    '-79.38000,43.65000': { at: Date.now(), result: { ellipsoid: 100 } },
    '139.69000,35.69000': { at: Date.now(), result: { ellipsoid: 300 } },
  });
  const terrain = terrainFixture(t);
  const { heights } = terrain;

  await heights('-79.38,43.65');
  // The earlier proxy keeps only points near Toronto, so this one is counted.
  assert.equal(pruneTerrainMemoryOutside(TORONTO, 300), 1, 'Tokyo released');
  // Paris is new, so the next flush has something to write.
  assert.deepEqual((await heights('2.35,48.85')).results, [
    { ellipsoid: 1002.35 },
  ]);
  assert.equal(terrain.calls, 1);

  let writeStarted;
  let finishWrite;
  const started = new Promise((resolve) => (writeStarted = resolve));
  disk.hold = () => {
    writeStarted();
    return new Promise((resolve) => (finishWrite = resolve));
  };
  const flushing = terrain.flush();
  await started;
  // A request for the released Tokyo cell lands while the write is half done.
  assert.deepEqual((await heights('139.69,35.69')).results, [
    { ellipsoid: 300 },
  ]);
  assert.equal(terrain.calls, 1, 'restored from the previous file');
  finishWrite();
  await flushing;
  disk.hold = null;

  const [temp] = disk.writes;
  assert.notEqual(temp, TERRAIN_CACHE_FILE);
  assert.equal(path.dirname(temp), path.dirname(TERRAIN_CACHE_FILE));
  assert.deepEqual(disk.renames, [[temp, TERRAIN_CACHE_FILE]]);
  assert.deepEqual([...disk.files.keys()], [TERRAIN_CACHE_FILE]);
  assert.deepEqual(
    Object.keys(JSON.parse(disk.files.get(TERRAIN_CACHE_FILE)).points).sort(),
    ['-79.38000,43.65000', '139.69000,35.69000', '2.35000,48.85000'],
  );

  // A failed rename keeps the previous file, removes its temp file and
  // retries on the next tick.
  const previous = disk.files.get(TERRAIN_CACHE_FILE);
  await heights('-73.57,45.50');
  assert.equal(terrain.calls, 2);
  disk.failRename = true;
  await terrain.flush();
  assert.equal(disk.files.get(TERRAIN_CACHE_FILE), previous);
  assert.deepEqual([...disk.files.keys()], [TERRAIN_CACHE_FILE]);
  assert.deepEqual(disk.removed, [disk.writes[1]]);
  disk.failRename = false;
  await terrain.flush();
  assert.equal(disk.writes.length, 3);
  assert.ok(
    JSON.parse(disk.files.get(TERRAIN_CACHE_FILE)).points['-73.57000,45.50000'],
  );
  assert.deepEqual([...disk.files.keys()], [TERRAIN_CACHE_FILE]);
});
