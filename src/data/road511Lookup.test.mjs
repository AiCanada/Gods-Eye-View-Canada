import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cctvProxy } from '../../server/providers/cctv.js';
import {
  ROAD511_API_BASE,
  ROAD511_NEGATIVE_TTL_MS,
  ROAD511_POSITIVE_TTL_MS,
  ROAD511_SPACING_MS,
} from '../../server/providers/cctv/constants.js';
import {
  createRoad511Lookup,
  road511FeatureId,
  road511StillUrl,
  safeRoad511StillUrl,
} from '../../server/providers/cctv/road511-lookup.js';

// Every request here goes to a fake fetch: the real Road511 API is never called.
const KEY = 'r511-secret-key-never-logged';
const camera = (id, fields = {}) => ({ id, name: id, lookup: 'road511', feedType: 'none', ...fields });
const noSleep = async () => {};
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return { calls, fetchImpl };
}

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-road511-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('feature ids come from pack ids; anything unexpected is never sent', () => {
  assert.equal(road511FeatureId('us511-TX-cam-1001'), 'TX-cam-1001');
  assert.equal(road511FeatureId('us511-NE-cam-77-N'), 'NE-cam-77', 'a view suffix is not part of the feature');
  assert.equal(road511FeatureId('us511-NE-cam-77-SW'), 'NE-cam-77');
  assert.equal(road511FeatureId('us511-TX-cam-12/../../admin'), '');
  assert.equal(road511FeatureId('us511-tx-cam-1'), '', 'the state code is upper case');
  assert.equal(road511FeatureId('us511-IL-cam-IL-ISTHA-Qy9m='), '');
  assert.equal(
    road511FeatureId('us511-ME-cam-I-95 Mile 108 NB (Augusta)'),
    'ME-cam-I-95 Mile 108 NB (Augusta)',
    'Road511 ids for ME, NH and VT carry spaces and brackets',
  );
  assert.equal(road511FeatureId('us511-NH-cam-Route 3, Exit 5?'), 'NH-cam-Route 3, Exit 5?');
  assert.equal(road511FeatureId('us511-VT-cam-a+b'), '');
  assert.equal(road511FeatureId('us511-on511-1234'), '');
  assert.equal(road511FeatureId('on511-1234'), '');
  assert.equal(road511FeatureId(''), '');
});

test('the still comes from url fields, then a views list or dictionary; HLS and unsafe hosts are skipped', () => {
  assert.equal(road511StillUrl({ data: { url: 'https://511.example.gov/map/Cctv/1' } }), 'https://511.example.gov/map/Cctv/1');
  assert.equal(road511StillUrl({ data: { properties: { image_url: 'https://cams.example.org/a.jpg' } } }), 'https://cams.example.org/a.jpg');
  assert.equal(road511StillUrl({ imageUrl: 'https://cams.example.org/b.jpg' }), 'https://cams.example.org/b.jpg');
  assert.equal(
    road511StillUrl({ data: { views: [{ url: 'https://cams.example.org/v.m3u8' }, { image_url: 'https://cams.example.org/v1.jpg' }] } }),
    'https://cams.example.org/v1.jpg',
  );
  assert.equal(
    road511StillUrl({ data: { views: { N: { url: 'https://cams.example.org/n.jpg' }, S: 'https://cams.example.org/s.jpg' } } }),
    'https://cams.example.org/n.jpg',
  );
  assert.equal(
    road511StillUrl({ data: { views: { N: 'https://cams.example.org/n.jpg', S: 'https://cams.example.org/s.jpg' } } }, { view: 'S' }),
    'https://cams.example.org/s.jpg',
    'a view entry prefers its own direction',
  );
  assert.equal(road511StillUrl({ data: { url: 'https://cams.example.org/live/playlist.m3u8' } }), '');
  assert.equal(road511StillUrl({ data: { url: 'http://169.254.169.254/latest/meta-data' } }), '');
  assert.equal(road511StillUrl({ data: { url: 'https://localhost/x.jpg' } }), '');
  assert.equal(road511StillUrl({ data: { url: 'https://nas.local/x.jpg' } }), '');
  assert.equal(road511StillUrl({ data: { url: 'ftp://cams.example.org/x.jpg' } }), '');
  assert.equal(road511StillUrl(null), '');
  assert.equal(safeRoad511StillUrl('https://user:pw@cams.example.org/x.jpg'), '');
  for (const hidden of [
    'http://localhost./x.jpg',
    'http://localhost.:8123/api/camera_proxy/x',
    'https://foo.localhost./x.jpg',
    'http://metadata.google.internal./computeMetadata/v1/',
    'https://nas.local../x.jpg',
  ]) {
    assert.equal(safeRoad511StillUrl(hidden), '', `a trailing dot does not hide a local name: ${hidden}`);
  }
  assert.equal(safeRoad511StillUrl('https://cams.example.org./x.jpg'), 'https://cams.example.org./x.jpg', 'a public name stays public');
});

test('a Road511 redirect is never followed, so ROAD511_API_KEY never reaches another host', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  let clock = 0;
  const answers = [
    () => new Response(null, { status: 302, headers: { location: 'http://collector.example.net/steal' } }),
    () => new Response(null, { status: 308, headers: { location: 'https://api.road511.com.evil.example/x' } }),
    () => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), body: null }),
  ];
  const { calls, fetchImpl } = fakeFetch((_url, _init, n) => answers[n - 1]());
  const lookup = createRoad511Lookup({ env: { ROAD511_API_KEY: KEY }, fetchImpl, now: () => clock, sleep: noSleep });
  for (const id of ['us511-TX-cam-60', 'us511-TX-cam-61', 'us511-TX-cam-62']) {
    const answer = await lookup.lookup(camera(id));
    assert.equal(answer.lookupState, 'backoff', id);
    assert.ok(answer.retryAfterMs >= 30000, id);
    assert.equal(lookup.peek(camera(id)).lookupState, 'unresolved', 'a redirect caches nothing');
  }
  assert.equal(calls.length, 3, 'one request per camera, none to a redirect target');
  assert.ok(calls.every((call) => call.init.redirect === 'manual'), 'fetch is told not to follow');
  assert.ok(calls.every((call) => call.url.startsWith(`${ROAD511_API_BASE}/features/`)));
  assert.equal((await lookup.lookup(camera('us511-TX-cam-60'))).lookupState, 'backoff');
  assert.equal(calls.length, 3, 'backing off, not retried at once');
  const lines = warnings.mock.calls.map((call) => call.arguments.map(String).join(' '));
  assert.ok(lines.every((line) => !line.includes(KEY) && !line.includes('collector.example.net')));
});

test('calls queued for a request slot make no request once a 429 or a refused key lands', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const [status, expected] of [[429, 'backoff'], [401, 'key-rejected']]) {
    const { calls, fetchImpl } = fakeFetch(() =>
      status === 429
        ? new Response('slow down', { status, headers: { 'retry-after': '120' } })
        : new Response('no', { status }),
    );
    // Real (short) spacing sleeps: the first answer lands while the other five wait their turn.
    const lookup = createRoad511Lookup({ env: { ROAD511_API_KEY: KEY }, fetchImpl, spacingMs: 5, spacingWaitMs: 25 });
    const answers = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) => lookup.lookup(camera(`us511-TX-cam-q${status}-${i}`))),
    );
    assert.deepEqual(answers.map((a) => a.lookupState), Array(6).fill(expected), String(status));
    assert.equal(calls.length, 1, `${status}: only the first call reached Road511`);
    assert.equal(lookup.counters.road511Calls, 1, `${status}: only real requests are counted`);
  }
});

test('no key makes no request; a key saved later is read on the next call', async () => {
  const env = {};
  const { calls, fetchImpl } = fakeFetch(() => json({ data: { url: 'https://cams.example.org/1001.jpg' } }));
  const lookup = createRoad511Lookup({ env, fetchImpl, sleep: noSleep });
  const houston = camera('us511-TX-cam-1001');
  assert.deepEqual(await lookup.lookup(houston), { lookupState: 'no-key', url: '', retryAfterMs: 0 });
  assert.equal(calls.length, 0);
  assert.equal(lookup.hasKey(), false);

  env.ROAD511_API_KEY = KEY;
  const answer = await lookup.lookup(houston);
  assert.equal(answer.lookupState, 'resolved');
  assert.equal(answer.url, 'https://cams.example.org/1001.jpg');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.road511.com/api/v1/features/TX-cam-1001/details');
  assert.equal(calls[0].url, `${ROAD511_API_BASE}/features/TX-cam-1001/details`);
  assert.equal(calls[0].init.headers['X-API-Key'], KEY);
  assert.equal(lookup.counters.road511Calls, 1);

  assert.equal((await lookup.lookup(houston)).lookupState, 'resolved');
  assert.equal(calls.length, 1, 'answered from the cache');
  assert.equal(lookup.counters.road511CacheHits, 1);
  assert.deepEqual(lookup.peek(houston), { lookupState: 'resolved', url: 'https://cams.example.org/1001.jpg', kind: 'still' });
});

test('only a catalogue camera marked for Road511 is ever looked up', async () => {
  const { calls, fetchImpl } = fakeFetch(() => json({}));
  const lookup = createRoad511Lookup({ env: { ROAD511_API_KEY: KEY }, fetchImpl, sleep: noSleep });
  assert.equal((await lookup.lookup(undefined)).lookupState, 'unknown');
  assert.equal((await lookup.lookup(camera('us511-TX-cam-1', { lookup: '' }))).lookupState, 'not-lookup');
  assert.equal((await lookup.lookup(camera('us511-TX-cam-1', { feedType: 'image' }))).lookupState, 'not-lookup');
  assert.equal((await lookup.lookup(camera('us511-IL-cam-IL-ISTHA-Qy9m='))).lookupState, 'not-lookup');
  assert.equal((await lookup.lookup(camera('on511-44'))).lookupState, 'not-lookup');
  assert.equal(calls.length, 0);
});

test('an HLS-only or missing feature is a cached no-image for a day', async () => {
  let clock = 1_000_000;
  const { calls, fetchImpl } = fakeFetch((url) =>
    url.includes('TX-cam-2')
      ? json({ data: { views: [{ url: 'https://cams.example.org/2.m3u8' }] } })
      : new Response('not found', { status: 404 }),
  );
  const lookup = createRoad511Lookup({ env: { ROAD511_API_KEY: KEY }, fetchImpl, now: () => clock, sleep: noSleep });
  assert.equal((await lookup.lookup(camera('us511-TX-cam-2'))).lookupState, 'no-image');
  assert.equal((await lookup.lookup(camera('us511-TX-cam-3'))).lookupState, 'no-image');
  assert.equal((await lookup.lookup(camera('us511-TX-cam-3'))).lookupState, 'no-image');
  assert.equal(calls.length, 2);
  assert.equal(lookup.peek(camera('us511-TX-cam-3')).lookupState, 'no-image');
  clock += ROAD511_NEGATIVE_TTL_MS + 1;
  await lookup.lookup(camera('us511-TX-cam-3'));
  assert.equal(calls.length, 3, 'asked again after a day');
  assert.equal(ROAD511_POSITIVE_TTL_MS, 24 * 3600 * 1000);
  assert.equal(ROAD511_NEGATIVE_TTL_MS, 24 * 3600 * 1000);
});

test('concurrent opens share one request, and requests are spaced at least a second apart', async () => {
  const sleeps = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, fetchImpl } = fakeFetch(async () => {
    await held;
    return json({ data: { url: 'https://cams.example.org/x.jpg' } });
  });
  const lookup = createRoad511Lookup({
    env: { ROAD511_API_KEY: KEY },
    fetchImpl,
    now: () => 5000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const first = lookup.lookup(camera('us511-TX-cam-10'));
  const again = lookup.lookup(camera('us511-TX-cam-10'));
  const other = lookup.lookup(camera('us511-TX-cam-11'));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const answers = await Promise.all([first, again, other]);
  assert.deepEqual(answers.map((a) => a.lookupState), ['resolved', 'resolved', 'resolved']);
  assert.equal(calls.length, 2, 'one request per camera');
  assert.deepEqual(sleeps, [1000], 'the second camera waited its turn');
  assert.ok(ROAD511_SPACING_MS >= 1000);
});

test('a lookup that would wait more than five seconds answers busy without a request', async () => {
  const { calls, fetchImpl } = fakeFetch(() => json({ data: { url: 'https://cams.example.org/x.jpg' } }));
  const lookup = createRoad511Lookup({ env: { ROAD511_API_KEY: KEY }, fetchImpl, now: () => 0, sleep: noSleep });
  const states = [];
  for (let i = 0; i < 7; i += 1) states.push((await lookup.lookup(camera(`us511-TX-cam-b${i}`))).lookupState);
  assert.deepEqual(states, ['resolved', 'resolved', 'resolved', 'resolved', 'resolved', 'resolved', 'busy']);
  assert.equal(calls.length, 6);
});

test('429 pauses every lookup; 401/403 stops lookups for that key and is logged once, without the key', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  let clock = 0;
  let mode = 429;
  const env = { ROAD511_API_KEY: KEY };
  const { calls, fetchImpl } = fakeFetch(() =>
    mode === 429
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '120' } })
      : new Response('no', { status: mode }),
  );
  const lookup = createRoad511Lookup({ env, fetchImpl, now: () => clock, sleep: noSleep });
  const paused = await lookup.lookup(camera('us511-TX-cam-20'));
  assert.deepEqual(paused, { lookupState: 'backoff', url: '', retryAfterMs: 120000 });
  assert.equal((await lookup.lookup(camera('us511-TX-cam-21'))).lookupState, 'backoff');
  assert.equal(calls.length, 1, 'no request while paused');

  clock += 120001;
  mode = 401;
  assert.equal((await lookup.lookup(camera('us511-TX-cam-21'))).lookupState, 'key-rejected');
  assert.equal((await lookup.lookup(camera('us511-TX-cam-22'))).lookupState, 'key-rejected');
  assert.equal(calls.length, 2, 'a refused key is not sent again');
  assert.equal(lookup.keyRejected(), true);

  env.ROAD511_API_KEY = `${KEY}-replaced`;
  mode = 403;
  assert.equal(lookup.keyRejected(), false);
  await lookup.lookup(camera('us511-TX-cam-22'));
  assert.equal(calls.length, 3, 'a new key is tried');
  const lines = warnings.mock.calls.map((call) => call.arguments.map(String).join(' '));
  assert.equal(lines.filter((line) => line.includes('refused')).length, 2, 'once per refused key');
  assert.ok(lines.every((line) => !line.includes(KEY)), 'the key never appears in a log line');
});

test('a server error or a timeout backs that camera off and caches nothing', async () => {
  let clock = 0;
  const { calls, fetchImpl } = fakeFetch((url, init) =>
    url.includes('cam-30')
      ? new Response('oops', { status: 502 })
      : new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }),
  );
  const lookup = createRoad511Lookup({ env: { ROAD511_API_KEY: KEY }, fetchImpl, now: () => clock, sleep: noSleep, timeoutMs: 20 });
  const failed = await lookup.lookup(camera('us511-TX-cam-30'));
  assert.equal(failed.lookupState, 'backoff');
  assert.ok(failed.retryAfterMs >= 30000);
  assert.equal((await lookup.lookup(camera('us511-TX-cam-30'))).lookupState, 'backoff');
  assert.equal(calls.length, 1);
  assert.equal(lookup.peek(camera('us511-TX-cam-30')).lookupState, 'unresolved');
  clock += 10_000;
  assert.equal((await lookup.lookup(camera('us511-TX-cam-31'))).lookupState, 'backoff', 'a timeout');
  assert.equal(calls.length, 2);
});

test('the disk cache is reused by a new instance with no request, and holds no key', async (t) => {
  const dir = tempDir(t);
  const cacheFile = path.join(dir, 'road511-lookups.json');
  const { fetchImpl } = fakeFetch((url) =>
    url.includes('cam-40') ? json({ data: { url: 'https://cams.example.org/40.jpg' } }) : json({ data: {} }),
  );
  const first = createRoad511Lookup({ cacheFile, env: { ROAD511_API_KEY: KEY }, fetchImpl, sleep: noSleep });
  await first.lookup(camera('us511-TX-cam-40'));
  await first.lookup(camera('us511-TX-cam-41'));
  await first.flush();
  const text = readFileSync(cacheFile, 'utf8');
  assert.ok(!text.includes(KEY), 'no key on disk');
  const saved = JSON.parse(text);
  assert.equal(saved.format, 'gev-road511-lookups/1');
  assert.deepEqual(Object.keys(saved.entries).sort(), ['us511-TX-cam-40', 'us511-TX-cam-41']);
  // `kind` tells a still from a stream; `v` marks answers given since streams are read.
  assert.deepEqual(Object.keys(saved.entries['us511-TX-cam-40']).sort(), ['at', 'kind', 'state', 'url', 'v']);
  assert.deepEqual(Object.keys(saved.entries['us511-TX-cam-41']).sort(), ['at', 'state', 'v']);

  const restarted = fakeFetch(() => {
    throw new Error('a restart must not look anything up again');
  });
  const second = createRoad511Lookup({ cacheFile, env: { ROAD511_API_KEY: KEY }, fetchImpl: restarted.fetchImpl, sleep: noSleep });
  assert.deepEqual(await second.lookup(camera('us511-TX-cam-40')), {
    lookupState: 'resolved',
    url: 'https://cams.example.org/40.jpg',
    kind: 'still',
    retryAfterMs: 0,
  });
  assert.equal((await second.lookup(camera('us511-TX-cam-41'))).lookupState, 'no-image');
  const keyless = createRoad511Lookup({ cacheFile, env: {}, fetchImpl: restarted.fetchImpl });
  assert.equal((await keyless.lookup(camera('us511-TX-cam-40'))).lookupState, 'resolved', 'a cached answer needs no key');
  assert.equal(restarted.calls.length, 0);

  writeFileSync(
    cacheFile,
    JSON.stringify({ format: 'gev-road511-lookups/1', entries: { 'us511-TX-cam-42': { state: 'resolved', url: 'http://127.0.0.1/x.jpg', at: Date.now() } } }),
  );
  const tampered = createRoad511Lookup({ cacheFile, env: {} });
  await tampered.ready();
  assert.equal(tampered.peek(camera('us511-TX-cam-42')).lookupState, 'unresolved', 'an unsafe cached still is ignored');
});

/** Mounts the CCTV middleware; requests carry a method and headers. */
function install(plugin, { hook = 'configureServer', config } = {}) {
  let handler;
  plugin[hook]({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
    config,
  });
  return async (url, { method = 'GET', headers = {} } = {}) => {
    const res = {
      writeHead(status, responseHeaders) {
        Object.assign(this, { status, headers: responseHeaders });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url, method, headers }, res);
    return res;
  };
}

function routeFixture(t) {
  const root = tempDir(t);
  mkdirSync(path.join(root, 'config'));
  const file = path.join(root, 'config', 'pack.json');
  writeFileSync(
    file,
    JSON.stringify([
      { id: 'us511-TX-cam-50', name: 'I-45 at Main', city: 'Houston', country: 'US', region: 'TX', lat: 29.76, lon: -95.37, feedType: 'none', lookup: 'road511' },
      { id: 'us511-TX-cam-51', name: 'Has a still', city: 'Houston', country: 'US', region: 'TX', lat: 29.77, lon: -95.37, feedType: 'image', url: 'https://cams.example.org/51.jpg' },
    ]),
  );
  for (const [name, value] of Object.entries({
    CCTV_SOURCES_FILE: file,
    CCTV_SOURCES_JSON: undefined,
    CCTV_COUNTRIES: 'US',
    CCTV_STREETVIEW_FALLBACK: undefined,
    ROAD511_API_KEY: undefined,
    GOOGLE_MAPS_SERVER_API_KEY: undefined,
    GOOGLE_MAPS_API_KEY: undefined,
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

const POST = {
  method: 'POST',
  headers: {
    host: 'localhost:4173',
    origin: 'http://localhost:4173',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  },
};
const withHeaders = (headers) => ({ ...POST, headers: { ...POST.headers, ...headers } });

test('POST /api/cctv/lookup/:id: same-origin JSON only, one Road511 request per camera, reflected in /sources', async (t) => {
  const root = routeFixture(t);
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('the lookup route reaches the network only through the Road511 lookup');
  });
  const road511 = fakeFetch(() => json({ data: { url: 'https://cams.example.org/50.jpg' } }));
  const request = install(
    cctvProxy({
      sourceRoot: root,
      road511Lookup: createRoad511Lookup({
        cacheFile: path.join(root, '.gev-cache', 'road511-lookups.json'),
        fetchImpl: road511.fetchImpl,
        sleep: noSleep,
      }),
    }),
  );
  const body = (res) => JSON.parse(res.body);

  assert.equal((await request('/lookup/us511-TX-cam-50')).status, 405);
  assert.equal((await request('/lookup/us511-TX-cam-50', withHeaders({ 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal((await request('/lookup/us511-TX-cam-50', withHeaders({ origin: 'https://evil.example' }))).status, 403);
  assert.equal((await request('/lookup/us511-TX-cam-50', withHeaders({ 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await request('/lookup/%E0%A4%A', POST)).status, 400);
  assert.deepEqual(body(await request('/lookup/nope', POST)), { id: 'nope', lookupState: 'unknown', feedType: 'none', retryAfterMs: 0 });
  assert.deepEqual(body(await request('/lookup/us511-TX-cam-51', POST)), {
    id: 'us511-TX-cam-51',
    lookupState: 'not-lookup',
    feedType: 'image',
    retryAfterMs: 0,
  });
  assert.deepEqual(body(await request('/lookup/us511-TX-cam-50', POST)), {
    id: 'us511-TX-cam-50',
    lookupState: 'no-key',
    feedType: 'none',
    retryAfterMs: 0,
  });
  assert.equal(road511.calls.length, 0, 'no refused, ineligible or keyless request reaches Road511');

  const listed = async () =>
    body(await request('/sources?lat=29.76&lon=-95.37')).sources.find((s) => s.id === 'us511-TX-cam-50');
  const before = await listed();
  assert.equal(before.feedType, 'none');
  assert.equal(before.lookup, 'road511');
  assert.equal(before.lookupState, 'unresolved');

  process.env.ROAD511_API_KEY = KEY;
  assert.deepEqual(body(await request('/lookup/us511-TX-cam-50', POST)), {
    id: 'us511-TX-cam-50',
    lookupState: 'resolved',
    feedType: 'image',
    retryAfterMs: 0,
  });
  assert.equal(road511.calls.length, 1);
  const after = await listed();
  assert.equal(after.feedType, 'image');
  assert.equal(after.lookupState, 'resolved');

  await request('/lookup/us511-TX-cam-50', withHeaders({ origin: undefined, 'sec-fetch-site': undefined }));
  assert.equal(road511.calls.length, 1, 'reopening is answered from the cache');
  const health = body(await request('/health'));
  assert.equal(health.counters.road511Calls, 1);
  assert.equal(health.counters.road511CacheHits, 1);
  assert.equal(network.mock.callCount(), 0);
});

test('the lookup route refuses Hosts the server does not serve: a DNS-rebinding page or a tunnel spends no lookup', async (t) => {
  const root = routeFixture(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('no network');
  });
  let lookups = 0;
  const road511Lookup = {
    ready: async () => {},
    peek: () => ({ lookupState: 'unresolved', url: '' }),
    eligible: () => true,
    hasKey: () => true,
    keyRejected: () => false,
    flush: async () => {},
    counters: { road511Calls: 0, road511CacheHits: 0 },
    lookup: async () => {
      lookups += 1;
      return { lookupState: 'no-image', url: '', retryAfterMs: 0 };
    },
  };
  const send = (request, headers) => request('/lookup/us511-TX-cam-50', withHeaders(headers));
  const listed = ['localhost', '127.0.0.1', '.local'];
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    for (const config of [undefined, { server: { allowedHosts: listed }, preview: { allowedHosts: listed } }]) {
      const request = install(cctvProxy({ sourceRoot: root, road511Lookup }), { hook, config });
      for (const headers of [
        // A rebinding page: its Origin matches the Host it was loaded from.
        { host: 'attacker.example:4173', origin: 'http://attacker.example:4173', 'sec-fetch-site': 'same-origin' },
        // A tunnel: curl-style, no Origin or Fetch Metadata.
        { host: 'random.trycloudflare.com', origin: undefined, 'sec-fetch-site': undefined },
        { host: 'local.attacker.example:4173', origin: 'http://local.attacker.example:4173' },
        { host: 'localhost.:4173', origin: 'http://localhost.:4173' },
        { host: undefined, origin: undefined },
        { host: 'localhost:4173', origin: 'https://localhost:4173' },
        { host: 'localhost:4173', origin: 'http://localhost:4173/app' },
        { host: 'localhost:4173', origin: 'null' },
        { host: 'localhost:4173', origin: '' },
      ]) {
        const res = await send(request, headers);
        assert.equal(res.status, 403, `${hook} ${JSON.stringify(headers)}`);
      }
      assert.equal(lookups, 0, 'no refused request reaches the lookup');
      for (const headers of [
        {},
        { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' },
        { host: 'mybox.local:4173', origin: 'http://mybox.local:4173' },
        { origin: undefined, 'sec-fetch-site': undefined },
      ]) {
        assert.equal((await send(request, headers)).status, 200, `${hook} ${JSON.stringify(headers)}`);
      }
      assert.equal(lookups, 4);
      lookups = 0;
    }
  }

  // HOST=0.0.0.0 (LAN mode) sets allowedHosts true; each hook reads its own server's setting.
  const lan = { server: { allowedHosts: true }, preview: { allowedHosts: listed } };
  const lanHost = { host: 'mybox.lan:4173', origin: 'http://mybox.lan:4173' };
  const dev = install(cctvProxy({ sourceRoot: root, road511Lookup }), { config: lan });
  assert.equal((await send(dev, lanHost)).status, 200);
  const preview = install(cctvProxy({ sourceRoot: root, road511Lookup }), { hook: 'configurePreviewServer', config: lan });
  assert.equal((await send(preview, lanHost)).status, 403);
  // Vite also serves the host name the server was started with.
  const named = install(cctvProxy({ sourceRoot: root, road511Lookup }), {
    config: { server: { allowedHosts: [] }, additionalAllowedHosts: ['mybox.lan'] },
  });
  assert.equal((await send(named, lanHost)).status, 200);
  assert.equal((await send(named, { host: 'attacker.example:4173', origin: 'http://attacker.example:4173' })).status, 403);
  assert.equal(lookups, 2);
});

test('the lookup route is rate limited per client', async (t) => {
  const root = routeFixture(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('no network');
  });
  const request = install(cctvProxy({ sourceRoot: root }));
  const statuses = [];
  for (let i = 0; i < 31; i += 1) statuses.push((await request('/lookup/nope', POST)).status);
  assert.deepEqual([...new Set(statuses.slice(0, 30))], [200]);
  assert.equal(statuses[30], 429);
});
