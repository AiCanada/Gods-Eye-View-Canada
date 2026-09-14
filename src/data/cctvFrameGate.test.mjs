import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cctvProxy } from '../../server/providers/cctv.js';
import {
  CCTV_FRAME_CACHE_TTL_MS,
  CCTV_FRAME_FAILURES_MAX,
  CCTV_HOST_BLOCK_MAX_MS,
  CCTV_HOST_BLOCK_MIN_MS,
  CCTV_HOST_MAX_CONCURRENT,
  CCTV_HOST_SPACING_MS,
} from '../../server/providers/cctv/constants.js';
import { createFrameCache } from '../../server/providers/cctv/frame-cache.js';
import { createHostBudget } from '../../server/providers/cctv/host-budget.js';
import { createUpstreamGate, parseRetryAfterMs } from '../../server/providers/cctv/upstream-gate.js';

// Every upstream here is a mocked fetch: no real camera, 511 site or Google API is called.
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const image = () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
const refused = (status) => new Response('refused', { status, headers: { 'content-type': 'text/plain' } });
const cam = (id, fields = {}) => ({
  id, name: `Camera ${id}`, city: 'Toronto', country: 'CA', region: 'ON', lat: 43.65, lon: -79.38, feedType: 'image', ...fields,
});

function setup(t, sources, env = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-cctv-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  const file = path.join(root, 'config', 'pack.json');
  writeFileSync(file, JSON.stringify(sources));
  for (const [name, value] of Object.entries({
    CCTV_SOURCES_FILE: file,
    CCTV_SOURCES_JSON: undefined,
    CCTV_COUNTRIES: 'CA,US',
    CCTV_STREETVIEW_FALLBACK: undefined,
    CCTV_BROWSER_DIRECT_HOSTS: undefined,
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
  return async (url, { method = 'GET', headers = {} } = {}) => {
    const res = {
      writeHead(status, responseHeaders) { Object.assign(this, { status, headers: responseHeaders }); },
      end(body) { this.body = body; },
    };
    await handler({ url, method, headers }, res);
    return res;
  };
}

function upstream(t, handler) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), at: Date.now() });
    return handler(String(url), init);
  });
  return calls;
}

const health = async (request) => JSON.parse((await request('/health')).body);

test('an unknown camera id gets a placeholder with no upstream request, Street View included', async (t) => {
  const root = setup(t, [cam('known', { url: 'https://cams.example.org/known.jpg' })], {
    CCTV_STREETVIEW_FALLBACK: '1',
    GOOGLE_MAPS_SERVER_API_KEY: 'street-view-key',
  });
  const calls = upstream(t, () => image());
  const request = install(cctvProxy({ sourceRoot: root }));
  const res = await request('/frame/not-a-camera?label=Injected%20Label&city=Nowhere&lat=43.6&lon=-79.4&heading=90&active=1');
  assert.equal(res.headers['X-CCTV-Source'], 'synthetic');
  assert.doesNotMatch(String(res.body), /Injected Label|Nowhere/);
  assert.equal(calls.length, 0);
  const report = await health(request);
  assert.equal(report.counters.streetViewFetches, 0);
  assert.equal(report.counters.upstreamFrameFetches, 0);
  assert.deepEqual(report.cameras, [], 'an unknown id leaves no health entry');
});

test('a camera with no public still makes no request, even with ROAD511_API_KEY set', async (t) => {
  const root = setup(t, [
    cam('us511-TX-cam-7', {
      country: 'US', region: 'TX', city: 'Houston', lat: 29.76, lon: -95.37, feedType: 'none', lookup: 'road511',
      videoUrl: 'https://cams.example.org/7.m3u8',
    }),
    cam('us511-MD-cam-8', { country: 'US', region: 'MD', lat: 39.29, lon: -76.61, feedType: 'none' }),
  ]);
  const calls = upstream(t, () => image());
  const request = install(cctvProxy({ sourceRoot: root }));

  let res = await request('/frame/us511-TX-cam-7?active=1');
  assert.equal(res.headers['X-CCTV-Lookup'], 'no-key');
  assert.match(String(res.body), /ROAD511 KEY NOT SET/);
  process.env.ROAD511_API_KEY = 'set-but-this-route-never-uses-it';
  res = await request('/frame/us511-TX-cam-7?active=1');
  assert.equal(res.headers['X-CCTV-Lookup'], 'unresolved');
  assert.match(String(res.body), /SELECT CAMERA TO LOOK UP/);
  res = await request('/frame/us511-MD-cam-8');
  assert.equal(res.headers['X-CCTV-Lookup'], 'no-image');
  assert.match(String(res.body), /NO PUBLIC IMAGE/);

  assert.equal((await request('/media/us511-TX-cam-7')).status, 404, 'the kept video address is never proxied');
  const stream = JSON.parse((await request('/stream/us511-TX-cam-7')).body);
  assert.equal(stream.feedType, 'none');
  assert.equal(stream.mediaUrl, null);
  assert.equal(calls.length, 0);
  assert.equal((await health(request)).counters.road511Calls, 0);
});

test('a looked-up or page-advertised still is fetched without trusting its redirects', async (t) => {
  const root = setup(t, [
    cam('us511-TX-cam-9', { country: 'US', region: 'TX', city: 'Houston', lat: 29.76, lon: -95.37, feedType: 'none', lookup: 'road511' }),
    cam('us511-TX-cam-10', { country: 'US', region: 'TX', city: 'Houston', lat: 29.77, lon: -95.37, feedType: 'none', lookup: 'road511' }),
    cam('og-redirect-off', { pageUrl: 'https://www.skaping.com/page-off', frameResolver: 'og-image', frameHosts: ['skaping.s3.example.net'] }),
    cam('og-redirect-on', { pageUrl: 'https://www.skaping.com/page-on', frameResolver: 'og-image', frameHosts: ['skaping.s3.example.net'] }),
  ]);
  const pages = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    pages.push(href);
    const name = href.endsWith('-off') ? 'off' : 'on';
    if (href.startsWith('https://www.skaping.com/page-')) {
      return new Response(`<meta property="og:image" content="https://www.skaping.com/${name}.jpg">`, { headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`a still must not go through the default fetch: ${href}`);
  });
  const looked = { 'us511-TX-cam-9': 'https://cams.example.org/9.jpg', 'us511-TX-cam-10': 'https://cams.example.org/10.jpg' };
  const road511Lookup = {
    ready: async () => {},
    peek: (source) => (looked[source.id] ? { lookupState: 'resolved', url: looked[source.id] } : { lookupState: 'unresolved', url: '' }),
    eligible: () => true,
    hasKey: () => true,
    keyRejected: () => false,
    lookup: async () => ({ lookupState: 'unresolved', url: '', retryAfterMs: 0 }),
    counters: { road511Calls: 0, road511CacheHits: 0 },
  };
  const guarded = [];
  const moved = (location) => new Response(null, { status: 302, headers: { location } });
  const request = install(
    cctvProxy({
      sourceRoot: root,
      road511Lookup,
      upstreamGate: createUpstreamGate({ spacingMs: 0 }),
      guardedFetch: async (url, init) => {
        const href = String(url);
        guarded.push({ href, redirect: init?.redirect });
        switch (href) {
          case 'https://cams.example.org/9.jpg': return moved('http://localhost:8123/api/camera_proxy/x');
          case 'https://cams.example.org/10.jpg': return moved('https://cdn.example.org/10.jpg');
          case 'https://cdn.example.org/10.jpg': return image();
          case 'https://www.skaping.com/off.jpg': return moved('https://evil-cdn.example.net/off.jpg');
          case 'https://www.skaping.com/on.jpg': return moved('https://skaping.s3.example.net/on.jpg');
          case 'https://skaping.s3.example.net/on.jpg': return image();
          default: throw new Error(`unexpected guarded fetch ${href}`);
        }
      },
    }),
  );
  const refusedLocal = await request('/frame/us511-TX-cam-9?active=1');
  assert.equal(refusedLocal.headers['X-CCTV-Source'], 'synthetic');
  assert.match(String(refusedLocal.body), /UPSTREAM UNAVAILABLE/);
  assert.equal((await request('/frame/us511-TX-cam-10?active=1')).headers['X-CCTV-Source'], 'upstream-image', 'a public hop is followed');
  assert.equal((await request('/frame/og-redirect-off?active=1')).headers['X-CCTV-Source'], 'synthetic', 'a page frame may not hop off its hosts');
  assert.equal((await request('/frame/og-redirect-on?active=1')).headers['X-CCTV-Source'], 'upstream-image', 'a hop to a listed frame host is followed');
  assert.deepEqual(guarded.map((c) => c.href), [
    'https://cams.example.org/9.jpg',
    'https://cams.example.org/10.jpg',
    'https://cdn.example.org/10.jpg',
    'https://www.skaping.com/off.jpg',
    'https://www.skaping.com/on.jpg',
    'https://skaping.s3.example.net/on.jpg',
  ]);
  assert.ok(guarded.every((c) => c.redirect === 'manual'));
  assert.deepEqual(pages, ['https://www.skaping.com/page-off', 'https://www.skaping.com/page-on'], 'only the catalogue pages use the default fetch');
});

test('Street View is used only when enabled, only for the active camera, at the catalogue position', async (t) => {
  const root = setup(
    t,
    ['a', 'b', 'c'].map((id) => cam(id, { url: `https://down-${id}.example.org/${id}.jpg` })),
    { GOOGLE_MAPS_SERVER_API_KEY: 'street-view-key' },
  );
  const calls = upstream(t, (url) => (url.startsWith('https://maps.googleapis.com/') ? image() : refused(500)));
  const request = install(cctvProxy({ sourceRoot: root }));

  const off = await request('/frame/a?active=1&label=Fake%20Label');
  assert.equal(off.headers['X-CCTV-Source'], 'synthetic', 'off by default');
  assert.match(String(off.body), /Camera a/);
  assert.doesNotMatch(String(off.body), /Fake Label/, 'the query label is ignored');

  process.env.CCTV_STREETVIEW_FALLBACK = '1';
  assert.equal((await request('/frame/b')).headers['X-CCTV-Source'], 'synthetic', 'never for a card');
  const active = await request('/frame/c?active=1&lat=1&lon=2&heading=45');
  assert.equal(active.headers['X-CCTV-Source'], 'streetview');
  const streetView = calls.filter((c) => c.url.startsWith('https://maps.googleapis.com/'));
  assert.equal(streetView.length, 1);
  assert.match(streetView[0].url, /location=43\.65%2C-79\.38/, 'the catalogue position, not the query');
  assert.equal((await health(request)).counters.streetViewFetches, 1);
});

test('concurrent requests for one camera share one upstream request, reused for 8 s', async (t) => {
  const root = setup(t, [cam('shared', { url: 'https://cams.example.org/shared.jpg' })]);
  let clock = 1_000_000;
  const calls = upstream(t, async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return image();
  });
  const request = install(
    cctvProxy({
      sourceRoot: root,
      frameCache: createFrameCache({ now: () => clock }),
      upstreamGate: createUpstreamGate({ spacingMs: 0 }),
    }),
  );
  const results = await Promise.all([request('/frame/shared'), request('/frame/shared?active=1'), request('/frame/shared')]);
  assert.equal(calls.length, 1);
  assert.deepEqual(results.map((r) => r.headers['X-CCTV-Source']), ['upstream-image', 'upstream-image', 'upstream-image']);
  assert.deepEqual([...results[1].body], [...JPEG]);

  clock += CCTV_FRAME_CACHE_TTL_MS - 1;
  const cached = await request('/frame/shared');
  assert.equal(cached.headers['X-CCTV-Cache'], 'hit');
  assert.equal(calls.length, 1);
  clock += 2;
  await request('/frame/shared');
  assert.equal(calls.length, 2, 'past 8 s the still is fetched again');
  assert.equal(CCTV_FRAME_CACHE_TTL_MS, 8000);
  const report = await health(request);
  assert.equal(report.counters.upstreamFrameFetches, 2);
  assert.equal(report.counters.frameCacheHits, 1);
});

test('one host gets at most two requests at once, started at least 250 ms apart', async (t) => {
  const ids = [1, 2, 3, 4].map((n) => `h${n}`);
  const root = setup(t, ids.map((id) => cam(id, { url: `https://busy.example.org/${id}.jpg` })));
  let running = 0;
  let peak = 0;
  const calls = upstream(t, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 400));
    running -= 1;
    return image();
  });
  const request = install(cctvProxy({ sourceRoot: root }));
  const results = await Promise.all(ids.map((id) => request(`/frame/${id}`)));
  assert.ok(results.every((r) => r.headers['X-CCTV-Source'] === 'upstream-image'));
  assert.equal(calls.length, 4);
  assert.equal(CCTV_HOST_MAX_CONCURRENT, 2);
  assert.equal(peak, CCTV_HOST_MAX_CONCURRENT);
  const starts = calls.map((c) => c.at).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= CCTV_HOST_SPACING_MS - 15, `gap ${starts[i] - starts[i - 1]} ms`);
  }
});

test('a full queue or a long wait answers throttled instead of piling up', async () => {
  const gate = createUpstreamGate({ maxConcurrent: 1, spacingMs: 0, queueMax: 1, queueWaitMs: 50 });
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const first = gate.run('https://h.example.org/1', () => hold);
  const second = gate.run('https://h.example.org/2', async () => 'second');
  assert.deepEqual(await gate.run('https://h.example.org/3', async () => 'third'), { status: 'throttled' }, 'the queue holds one');
  assert.deepEqual(await second, { status: 'throttled' }, 'gave up after its wait');
  release('first');
  assert.deepEqual(await first, { status: 'ok', value: 'first' });
  assert.deepEqual(await gate.run('https://other.example.org/x', async () => 'free'), { status: 'ok', value: 'free' });
});

test('a 429 with Retry-After blocks the whole host; blocks last between 1 and 10 minutes', async (t) => {
  const root = setup(t, [
    cam('r1', { url: 'https://limited.example.org/1.jpg' }),
    cam('r2', { url: 'https://limited.example.org/2.jpg' }),
    cam('open', { url: 'https://open.example.org/ok.jpg' }),
  ]);
  const calls = upstream(t, (url) =>
    url.includes('limited')
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '120', 'content-type': 'text/plain' } })
      : image(),
  );
  const request = install(cctvProxy({ sourceRoot: root }));
  const limited = await request('/frame/r1');
  assert.equal(limited.headers['X-CCTV-Source'], 'synthetic');
  assert.match(String(limited.body), /UPSTREAM RATE LIMITED/);
  assert.equal(limited.headers['Retry-After'], '120');
  const blocked = await request('/frame/r2?active=1');
  assert.match(String(blocked.body), /UPSTREAM RATE LIMITED/);
  assert.equal(calls.filter((c) => c.url.includes('limited')).length, 1, 'nothing more is sent to a blocked host');
  assert.equal((await request('/frame/open')).headers['X-CCTV-Source'], 'upstream-image', 'other hosts are not blocked');
  assert.ok((await health(request)).counters.hostThrottled >= 2);
  assert.equal((await request('/frame/r1')).headers['X-CCTV-Source'], 'synthetic', 'a rate limit is not a camera failure');

  let clock = 0;
  const gate = createUpstreamGate({ now: () => clock, spacingMs: 0 });
  const retry = (value) => new Headers({ 'retry-after': value });
  assert.equal(gate.noteResponse('https://a.example.org/x', { status: 429, headers: retry('5') }), CCTV_HOST_BLOCK_MIN_MS);
  assert.equal(gate.noteResponse('https://b.example.org/x', { status: 429, headers: retry('99999') }), CCTV_HOST_BLOCK_MAX_MS);
  assert.equal(gate.noteResponse('https://c.example.org/x', { status: 429 }), CCTV_HOST_BLOCK_MIN_MS, 'no Retry-After: one minute');
  assert.equal(gate.noteResponse('https://d.example.org/x', { status: 503 }), 0, 'a bare 503 is a failure, not a block');
  assert.equal(gate.noteResponse('https://e.example.org/x', { status: 503, headers: retry('180') }), 180000);
  assert.equal(gate.blockedFor('https://e.example.org/other.jpg'), 180000);
  clock += 180001;
  assert.equal(gate.blockedFor('https://e.example.org/other.jpg'), 0);
  assert.ok(parseRetryAfterMs(new Date(Date.now() + 90_000).toUTCString()) > 80_000, 'an HTTP date');
  assert.equal(CCTV_HOST_BLOCK_MIN_MS, 60000);
  assert.equal(CCTV_HOST_BLOCK_MAX_MS, 600000);
});

test('failing cameras back off, and the failure map stays bounded', async (t) => {
  const ids = [1, 2, 3, 4, 5].map((n) => `f${n}`);
  const root = setup(t, ids.map((id) => cam(id, { url: `https://${id}.example.org/still.jpg` })));
  const calls = upstream(t, () => refused(500));
  const request = install(cctvProxy({ sourceRoot: root, frameFailuresMax: 3 }));
  for (const id of ids) await request(`/frame/${id}`);
  assert.equal(calls.length, 5);
  await request('/frame/f5');
  assert.equal(calls.length, 5, 'a camera in backoff is not retried');
  assert.equal((await health(request)).frameFailures, 3);
  assert.equal(CCTV_FRAME_FAILURES_MAX, 5000);
});

test('511 stills: 15-minute card reuse, 60 s active reuse, and a spent budget serves the last good still', async (t) => {
  const on511 = (n) => cam(`on511-${n}`, { url: `https://511on.ca/map/Cctv/${n}` });
  const root = setup(t, [on511(1), on511(2), on511(3), cam('plain', { url: 'https://cams.example.org/p.jpg' })]);
  let clock = Date.UTC(2026, 8, 14, 12);
  const calls = upstream(t, () => image());
  const request = install(
    cctvProxy({
      sourceRoot: root,
      frameCache: createFrameCache({ now: () => clock }),
      upstreamGate: createUpstreamGate({ spacingMs: 0 }),
      // Three a minute here: cards may use two, the active camera all three.
      hostBudget: createHostBudget({ perMinute: 3, activeReservePerMinute: 1, perDay: 1000, activeReservePerDay: 0, now: () => clock }),
    }),
  );
  const listed = JSON.parse((await request('/sources?lat=43.65&lon=-79.38')).body).sources;
  const byId = Object.fromEntries(listed.map((s) => [s.id, s]));
  assert.equal(byId['on511-1'].frameRefreshMs, 900000);
  assert.equal(byId['on511-1'].activeFrameRefreshMs, 60000);
  assert.equal(byId.plain.frameRefreshMs, undefined);
  assert.equal(byId.plain.activeFrameRefreshMs, undefined);

  const source = (res) => `${res.headers['X-CCTV-Source']}:${res.headers['X-CCTV-Cache'] || ''}`;
  assert.equal(source(await request('/frame/on511-1')), 'upstream-image:miss');
  clock += 14 * 60 * 1000;
  assert.equal(source(await request('/frame/on511-1')), 'upstream-image:hit', 'a card reuses a still for 15 minutes');
  assert.equal(source(await request('/frame/on511-1?active=1')), 'upstream-image:miss', 'the active camera wants one under a minute old');
  assert.equal(source(await request('/frame/on511-2')), 'upstream-image:miss');
  const cardRefused = await request('/frame/on511-3');
  assert.equal(source(cardRefused), 'synthetic:', 'cards have used their share of the minute');
  assert.match(String(cardRefused.body), /511 LIMIT REACHED/);
  assert.equal(source(await request('/frame/on511-3?active=1')), 'upstream-image:miss', 'the active camera still has room');
  assert.equal(calls.length, 4);

  clock += 20 * 60 * 1000;
  await request('/frame/on511-1');
  await request('/frame/on511-3?active=1');
  assert.equal(calls.length, 6);
  const lastGood = await request('/frame/on511-2');
  assert.equal(source(lastGood), 'upstream-image:last-good', 'budget spent: the 20-minute-old still');
  assert.equal(calls.length, 6);

  clock += 45 * 60 * 1000;
  await request('/frame/on511-1');
  await request('/frame/on511-3?active=1');
  assert.equal(calls.length, 8);
  const tooOld = await request('/frame/on511-2');
  assert.equal(source(tooOld), 'synthetic:', 'past an hour the old still is not served');
  assert.match(String(tooOld.body), /511 LIMIT REACHED/);
  assert.equal(calls.length, 8);
  assert.ok(calls.every((c) => c.url.startsWith('https://511on.ca/map/Cctv/')));
  assert.equal((await health(request)).counters.budgetDenied, 3);
});

test('the media route respects the 511 budget too', async (t) => {
  const root = setup(t, [cam('on511-9', { url: 'https://511on.ca/map/Cctv/9' })]);
  const calls = upstream(t, () => image());
  const request = install(
    cctvProxy({
      sourceRoot: root,
      hostBudget: createHostBudget({ perMinute: 2, activeReservePerMinute: 1 }),
    }),
  );
  // The stub response cannot be piped into, so only the budget outcome is checked.
  assert.notEqual((await request('/media/on511-9')).status, 429);
  assert.equal(calls.length, 1);
  const denied = await request('/media/on511-9');
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers['Retry-After']) >= 1);
  assert.equal(calls.length, 1);
});
