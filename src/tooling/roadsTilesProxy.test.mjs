// src/tooling/roadsTilesProxy.test.mjs
// GET /api/roads/tiles/{z}/{x}/{y}.pbf — OpenFreeMap road tiles for Street
// Traffic. Every upstream is a mocked fetch and every cache lives in a
// temporary directory, so no case touches the network or .gev-cache.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  OPENFREEMAP_TILEJSON_URL,
  parseOpenFreeMapVersion,
  pruneRoadTileMemoryOutside,
  roadsTilesProxy,
} from '../../server/providers/roads-tiles.js';

const VERSION = '20260906_080001_pt';
const NEXT_VERSION = '20260913_080001_pt';
const tileJson = (version) => ({
  tilejson: '3.0.0',
  tiles: [`https://tiles.openfreemap.org/planet/${version}/{z}/{x}/{y}.pbf`],
  maxzoom: 14,
});
/** A tiny valid MVT body (one empty layer message); the proxy never decodes it. */
const TILE = Buffer.from([0x1a, 0x04, 0x0a, 0x02, 0x72, 0x64]);
const AUSTIN_TILE = '14/3743/6745';
const TORONTO = { latitude: 43.6532, longitude: -79.3832 };

function cacheDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-roads-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Upstream double: TileJSON plus tiles; `tile(url)` may return a Response. */
function upstream({ version = VERSION, tile = () => null, tileJsonAnswer = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} });
    if (String(url) === OPENFREEMAP_TILEJSON_URL) {
      return tileJsonAnswer?.() || Response.json(tileJson(version));
    }
    return (
      tile(String(url)) ||
      new Response(TILE, { status: 200, headers: { 'content-type': 'application/vnd.mapbox-vector-tile' } })
    );
  };
  return { calls, fetchImpl };
}

/** Poll until `check()` holds (background work in the proxy), failing after about 2 s. */
async function waitFor(check, what) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return routes.get('/api/roads');
}

function get(handler, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body = '') {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        resolve({
          status: this.status,
          headers: this.headers,
          body: buf,
          json: () => JSON.parse(buf.toString('utf8')),
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('bad coordinates, zooms, methods and paths are answered without any upstream request', async (t) => {
  for (const preview of [false, true]) {
    const handler = install(
      roadsTilesProxy({
        cacheDir: cacheDir(t),
        fetchImpl: () => {
          throw new Error('validation must not fetch');
        },
      }),
      preview,
    );
    for (const [url, status] of [
      ['/tiles/15/0/0.pbf', 400],
      ['/tiles/14/16384/0.pbf', 400],
      ['/tiles/0/1/0.pbf', 400],
      ['/tiles/-1/0/0.pbf', 404],
      ['/tiles/1.5/0/0.pbf', 404],
      ['/tiles/3/1/1.png', 404],
      ['/tiles/3/1/1.pbf/extra', 404],
      ['/tiles/99999/1/1.pbf', 404],
      ['/elsewhere', 404],
    ]) {
      const res = await get(handler, url);
      assert.equal(res.status, status, url);
      assert.equal(res.headers['Content-Type'], 'application/json');
    }
    const post = await get(handler, '/tiles/3/1/1.pbf', 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.Allow, 'GET');
  }
});

test('the planet version comes from the TileJSON once; tiles are served from memory, then disk, never twice from upstream', async (t) => {
  const dir = cacheDir(t);
  const up = upstream();
  const handler = install(roadsTilesProxy({ cacheDir: dir, fetchImpl: up.fetchImpl }));

  const first = await get(handler, `/tiles/${AUSTIN_TILE}.pbf`);
  assert.equal(first.status, 200);
  assert.equal(first.headers['Content-Type'], 'application/x-protobuf');
  assert.equal(first.headers['Content-Encoding'], undefined, 'plain bytes the browser decodes as-is');
  assert.equal(first.headers['X-Roads-Cache'], 'MISS');
  assert.deepEqual(first.body, TILE);
  assert.deepEqual(up.calls.map((c) => c.url), [
    OPENFREEMAP_TILEJSON_URL,
    `https://tiles.openfreemap.org/planet/${VERSION}/${AUSTIN_TILE}.pbf`,
  ]);
  for (const call of up.calls) assert.match(call.headers['User-Agent'], /^gods-eye-view-roads-tiles\/1\.0 \(\+https:\/\//);

  const again = await get(handler, `/tiles/${AUSTIN_TILE}.pbf`);
  assert.equal(again.headers['X-Roads-Cache'], 'HIT');
  const other = await get(handler, '/tiles/12/935/1686.pbf');
  assert.equal(other.headers['X-Roads-Cache'], 'MISS');
  assert.equal(up.calls.length, 3, 'one TileJSON for many tiles');

  assert.deepEqual(readFileSync(path.join(dir, VERSION, '14', '3743', '6745.pbf')), TILE);
  const saved = JSON.parse(readFileSync(path.join(dir, 'tilejson.json'), 'utf8'));
  assert.equal(saved.version, VERSION);
  assert.ok(Number.isFinite(saved.fetchedAt));
  assert.deepEqual(
    (await get(handler, '/status')).json(),
    { version: VERSION, cachedTiles: 2, upstreamFetches: 2, errors: 0 },
  );

  // A restart reads the version and the tile back from disk with no request.
  const restarted = install(
    roadsTilesProxy({
      cacheDir: dir,
      fetchImpl: () => {
        throw new Error('a warm disk cache must not fetch');
      },
    }),
  );
  const fromDisk = await get(restarted, `/tiles/${AUSTIN_TILE}.pbf`);
  assert.equal(fromDisk.status, 200);
  assert.equal(fromDisk.headers['X-Roads-Cache'], 'DISK');
  assert.deepEqual(fromDisk.body, TILE);
});

test('a known version is re-checked at most daily, in the background, and a failed check keeps it', async (t) => {
  const dir = cacheDir(t);
  let clock = 1_000_000;
  let version = VERSION;
  let tileJsonDown = false;
  const up = upstream({
    tileJsonAnswer: () => (tileJsonDown ? new Response('down', { status: 503 }) : Response.json(tileJson(version))),
  });
  t.mock.method(console, 'warn', () => {});
  const handler = install(roadsTilesProxy({ cacheDir: dir, fetchImpl: up.fetchImpl, now: () => clock }));
  const tileJsonCalls = () => up.calls.filter((c) => c.url === OPENFREEMAP_TILEJSON_URL).length;
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  await get(handler, '/tiles/14/1/1.pbf');
  clock += 23 * 3600_000;
  version = NEXT_VERSION;
  await get(handler, '/tiles/14/1/2.pbf');
  assert.equal(tileJsonCalls(), 1, 'under a day old: no TileJSON request');

  clock += 2 * 3600_000;
  await get(handler, '/tiles/14/1/3.pbf');
  assert.ok(up.calls.some((c) => c.url.endsWith(`/${VERSION}/14/1/3.pbf`)), 'the due check does not hold up the tile');
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(tileJsonCalls(), 2);
  await get(handler, '/tiles/14/1/4.pbf');
  assert.ok(up.calls.at(-1).url.endsWith(`/${NEXT_VERSION}/14/1/4.pbf`), 'the new build is used once known');

  clock += 25 * 3600_000;
  tileJsonDown = true;
  await get(handler, '/tiles/14/1/5.pbf');
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(tileJsonCalls(), 3);
  const kept = await get(handler, '/tiles/14/1/6.pbf');
  assert.equal(kept.status, 200);
  assert.ok(up.calls.at(-1).url.endsWith(`/${NEXT_VERSION}/14/1/6.pbf`), 'a failed check keeps the last version');
  assert.equal(tileJsonCalls(), 3, 'and waits before asking again');
});

test('a gzip body is stored and served as plain MVT bytes', async (t) => {
  const dir = cacheDir(t);
  const up = upstream({ tile: () => new Response(gzipSync(TILE), { status: 200 }) });
  const handler = install(roadsTilesProxy({ cacheDir: dir, fetchImpl: up.fetchImpl }));
  const res = await get(handler, `/tiles/${AUSTIN_TILE}.pbf`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, TILE);
  assert.deepEqual(readFileSync(path.join(dir, VERSION, '14', '3743', '6745.pbf')), TILE);
});

test('the breaker opens only after three upstream-wide failures in a row, then lets one probe through', { timeout: 30_000 }, async (t) => {
  let clock = 0;
  const serverError = () => new Response('<html>busy</html>', { status: 500 });
  const timeout = () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  const networkError = () => {
    throw new TypeError('fetch failed');
  };
  let answer = null; // null answers a healthy tile
  let gate = null;
  let attempts = 0;
  const up = upstream({ tile: () => answer?.() || null });
  const fetchImpl = async (url, options) => {
    if (String(url) === OPENFREEMAP_TILEJSON_URL) return up.fetchImpl(url, options);
    attempts += 1;
    const held = gate;
    if (held) await held.promise;
    return up.fetchImpl(url, options);
  };
  t.mock.method(console, 'warn', () => {});
  const dir = cacheDir(t);
  const handler = install(roadsTilesProxy({ cacheDir: dir, fetchImpl, now: () => clock }));
  const tile = (n) => `/tiles/14/3743/${6740 + n}.pbf`;

  // A server error, a timeout and a network error: two in a row leave it closed.
  answer = serverError;
  const first = await get(handler, tile(0));
  assert.equal(first.status, 502);
  assert.deepEqual(first.json(), { error: 'upstream' });
  answer = timeout;
  assert.equal((await get(handler, tile(1))).status, 502);
  assert.equal(attempts, 2, 'one failure does not block the next tile');
  answer = networkError;
  assert.equal((await get(handler, tile(2))).status, 502);
  assert.equal(attempts, 3, 'nor do two');

  // The third in a row opens it: other tiles fail fast without a request.
  const fast = await get(handler, tile(3));
  assert.equal(fast.status, 502);
  assert.equal(fast.headers['Retry-After'], '5');
  assert.equal(attempts, 3, 'no request while the breaker is open');

  // Half-open: exactly one probe goes upstream; the rest still answer at once.
  clock += 5_001;
  gate = Promise.withResolvers();
  const probe = get(handler, tile(3));
  await waitFor(() => attempts === 4, 'the probe request');
  const waiting = await get(handler, tile(4));
  assert.equal(waiting.status, 502);
  assert.equal(waiting.headers['Retry-After'], '1');
  assert.equal(attempts, 4, 'only the probe reached upstream');
  answer = serverError;
  gate.resolve();
  gate = null;
  assert.equal((await probe).status, 502);

  // A failed probe reopens it for twice as long.
  const reopened = await get(handler, tile(4));
  assert.equal(reopened.status, 502);
  assert.equal(reopened.headers['Retry-After'], '10');
  assert.equal(attempts, 4);

  // A successful probe closes it again.
  clock += 10_001;
  answer = null;
  assert.equal((await get(handler, tile(4))).status, 200);
  assert.equal((await get(handler, tile(5))).status, 200);
  assert.equal(attempts, 6);
  assert.equal(existsSync(path.join(dir, VERSION, '14', '3743', `${6740 + 4}.pbf`)), true);
  assert.deepEqual((await get(handler, '/status')).json(), {
    version: VERSION,
    cachedTiles: 2,
    upstreamFetches: 6,
    errors: 4,
  });
});

test('a failure about one tile never blocks other tiles; that tile answers fast for a short while, then is asked again', async (t) => {
  let clock = 0;
  const broken = new Map([
    [AUSTIN_TILE, () => new Response('not found', { status: 404 })],
    ['14/3743/6746', () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['14/3743/6747', () => new Response(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad]), { status: 200 })],
    [
      '14/3743/6748',
      () => new Response(TILE, { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } }),
    ],
  ]);
  const tileOf = (url) => url.match(/\/(\d+\/\d+\/\d+)\.pbf$/)[1];
  const up = upstream({ tile: (url) => broken.get(tileOf(url))?.() || null });
  t.mock.method(console, 'warn', () => {});
  const dir = cacheDir(t);
  const handler = install(roadsTilesProxy({ cacheDir: dir, fetchImpl: up.fetchImpl, now: () => clock }));
  const tileCalls = () => up.calls.filter((call) => call.url !== OPENFREEMAP_TILEJSON_URL).length;

  // 404, an HTML page with a 200, a broken gzip body, and a tile over the byte cap.
  for (const tile of broken.keys()) {
    const res = await get(handler, `/tiles/${tile}.pbf`);
    assert.equal(res.status, 502, tile);
    assert.deepEqual(res.json(), { error: 'upstream' });
  }
  assert.equal(tileCalls(), 4, 'every bad tile was asked for');
  const healthy = await get(handler, '/tiles/14/3744/6745.pbf');
  assert.equal(healthy.status, 200, 'four bad tiles in a row never block a healthy one');
  assert.equal(healthy.headers['X-Roads-Cache'], 'MISS');
  assert.equal(tileCalls(), 5);
  assert.equal(existsSync(path.join(dir, VERSION, '14', '3743')), false, 'a refusal is never cached on disk');

  const again = await get(handler, `/tiles/${AUSTIN_TILE}.pbf`);
  assert.equal(again.status, 502);
  assert.equal(again.headers['Retry-After'], '15');
  assert.equal(tileCalls(), 5, 'the failed tile answers without asking again for a while');

  clock += 15_001;
  broken.delete(AUSTIN_TILE);
  const later = await get(handler, `/tiles/${AUSTIN_TILE}.pbf`);
  assert.equal(later.status, 200, 'then it is asked again');
  assert.equal(tileCalls(), 6);
  assert.equal((await get(handler, '/status')).json().errors, 4);
});

test('a burst of concurrent upstream failures opens the breaker once, not once per tile', { timeout: 30_000 }, async (t) => {
  const release = Promise.withResolvers();
  let attempts = 0;
  const fetchImpl = async (url) => {
    if (String(url) === OPENFREEMAP_TILEJSON_URL) return Response.json(tileJson(VERSION));
    attempts += 1;
    await release.promise;
    return new Response('down', { status: 503 });
  };
  t.mock.method(console, 'warn', () => {});
  const handler = install(roadsTilesProxy({ cacheDir: cacheDir(t), fetchImpl, now: () => 0 }));
  const burst = Array.from({ length: 6 }, (_, i) => get(handler, `/tiles/14/3743/${6740 + i}.pbf`));
  await waitFor(() => attempts === 6, 'six concurrent upstream requests');
  release.resolve();
  assert.deepEqual(
    (await Promise.all(burst)).map((res) => res.status),
    [502, 502, 502, 502, 502, 502],
  );
  const fast = await get(handler, '/tiles/14/3744/6745.pbf');
  assert.equal(fast.status, 502);
  assert.equal(fast.headers['Retry-After'], '5', 'the first window, not one doubling per failed tile');
  assert.equal(attempts, 6);
});

test('without any TileJSON the newest version on disk is served, and with nothing at all the route says so', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const offline = () => new Response('offline', { status: 503 });
  const empty = install(roadsTilesProxy({ cacheDir: cacheDir(t), fetchImpl: offline }));
  const none = await get(empty, `/tiles/${AUSTIN_TILE}.pbf`);
  assert.equal(none.status, 502);
  assert.deepEqual(none.json(), { error: 'tilejson' });

  const dir = cacheDir(t);
  for (const version of ['20250101_000000_pt', VERSION]) {
    mkdirSync(path.join(dir, version, '14', '3743'), { recursive: true });
    writeFileSync(path.join(dir, version, '14', '3743', '6745.pbf'), Buffer.from(version));
  }
  const handler = install(roadsTilesProxy({ cacheDir: dir, fetchImpl: offline }));
  const res = await get(handler, `/tiles/${AUSTIN_TILE}.pbf`);
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), VERSION);
});

test('old planet builds are removed from disk, keeping the build in use and the one before it', async (t) => {
  const OLDEST = '20250101_000000_pt';
  const OLDER = '20250201_000000_pt';
  const dir = cacheDir(t);
  for (const version of [OLDEST, OLDER, VERSION]) {
    mkdirSync(path.join(dir, version, '14', '3743'), { recursive: true });
    writeFileSync(path.join(dir, version, '14', '3743', '6745.pbf'), TILE);
  }
  mkdirSync(path.join(dir, '.not-a-build'));
  let clock = 1_000_000;
  writeFileSync(path.join(dir, 'tilejson.json'), JSON.stringify({ version: VERSION, fetchedAt: clock }));
  let version = VERSION;
  const up = upstream({ tileJsonAnswer: () => Response.json(tileJson(version)) });
  const handler = install(roadsTilesProxy({ cacheDir: dir, fetchImpl: up.fetchImpl, now: () => clock }));
  const onDisk = () => readdirSync(dir).sort();

  // Startup: builds left by earlier runs go, except the newest one before the build in use.
  assert.equal((await get(handler, `/tiles/${AUSTIN_TILE}.pbf`)).headers['X-Roads-Cache'], 'DISK');
  await waitFor(() => !existsSync(path.join(dir, OLDEST)), 'the oldest build to be removed');
  assert.deepEqual(onDisk(), ['.not-a-build', OLDER, VERSION, 'tilejson.json'].sort());

  // A new build: the one it replaces stays as the offline fallback, older ones go.
  clock += 25 * 3600_000;
  version = NEXT_VERSION;
  await get(handler, '/tiles/14/1/1.pbf');
  await waitFor(() => !existsSync(path.join(dir, OLDER)), 'the build before the previous one to be removed');
  await get(handler, `/tiles/${AUSTIN_TILE}.pbf`);
  assert.ok(up.calls.at(-1).url.endsWith(`/${NEXT_VERSION}/${AUSTIN_TILE}.pbf`), 'the new build is in use');
  assert.deepEqual(onDisk(), ['.not-a-build', NEXT_VERSION, VERSION, 'tilejson.json'].sort());
  assert.deepEqual(readFileSync(path.join(dir, VERSION, '14', '3743', '6745.pbf')), TILE, 'the previous build is kept whole');
});

test('concurrent requests for one tile share one upstream request', async (t) => {
  const release = Promise.withResolvers();
  let tileFetches = 0;
  const up = upstream({
    tile: () => {
      tileFetches += 1;
      return null;
    },
  });
  const held = async (url, options) => {
    if (String(url) !== OPENFREEMAP_TILEJSON_URL) await release.promise;
    return up.fetchImpl(url, options);
  };
  const handler = install(roadsTilesProxy({ cacheDir: cacheDir(t), fetchImpl: held }));
  const requests = Array.from({ length: 5 }, () => get(handler, `/tiles/${AUSTIN_TILE}.pbf`));
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((res) => res.status), [200, 200, 200, 200, 200]);
  assert.equal(tileFetches, 1);
});

test('a location-switch release drops far tiles from memory; the disk still answers them', async (t) => {
  const up = upstream();
  const handler = install(roadsTilesProxy({ cacheDir: cacheDir(t), fetchImpl: up.fetchImpl }));
  await get(handler, `/tiles/${AUSTIN_TILE}.pbf`);
  assert.ok(pruneRoadTileMemoryOutside(TORONTO, 300) >= 1);
  assert.equal((await get(handler, '/status')).json().cachedTiles, 0);
  const back = await get(handler, `/tiles/${AUSTIN_TILE}.pbf`);
  assert.equal(back.headers['X-Roads-Cache'], 'DISK');
  assert.equal(up.calls.length, 2, 'released tiles never cost an upstream request');
});

test('only an OpenFreeMap planet template with a path-safe version names a version', () => {
  assert.equal(parseOpenFreeMapVersion(tileJson(VERSION)), VERSION);
  for (const doc of [
    null,
    {},
    { tiles: 'https://tiles.openfreemap.org/planet/v1/{z}/{x}/{y}.pbf' },
    { tiles: ['https://evil.example/planet/v1/{z}/{x}/{y}.pbf'] },
    { tiles: ['http://tiles.openfreemap.org/planet/v1/{z}/{x}/{y}.pbf'] },
    { tiles: ['https://tiles.openfreemap.org/planet/../{z}/{x}/{y}.pbf'] },
    { tiles: ['https://tiles.openfreemap.org/planet/.hidden/{z}/{x}/{y}.pbf'] },
    { tiles: ['https://tiles.openfreemap.org/planet/v1/{z}/{x}/{y}.mvt'] },
  ]) {
    assert.equal(parseOpenFreeMapVersion(doc), null, JSON.stringify(doc));
  }
});
