import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LL2_CACHE_TTL_MS,
  rocketLaunchesProxy,
} from '../server/providers/space/launch-library.js';

// The real Launch Library proxy, with its upstream, its clock and its disk
// cache stubbed: nothing is read from or written to .gev-cache, and nothing
// goes to the network.

const FEED = '{"results":[{"id":"ll2-fixture","name":"Falcon 9 | Fixture"}]}';
const DETAIL = 'fixture-secret-token /internal/example <html>';

function launches(t, { preview = false } = {}) {
  // No saved feed on disk, and saves go nowhere.
  t.mock.method(fs.promises, 'stat', async () => {
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  });
  t.mock.method(fs.promises, 'readFile', async () => {
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  });
  t.mock.method(fs.promises, 'mkdir', async () => {});
  t.mock.method(fs.promises, 'writeFile', async () => {});
  const logged = [];
  t.mock.method(console, 'warn', (...args) => logged.push(args.map(String).join(' ')));
  let handler = null;
  rocketLaunchesProxy()[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(route, fn) {
        if (route === '/api/launches') handler = fn;
      },
    },
  });
  assert.ok(handler, 'the proxy serves /api/launches');
  const request = (method = 'GET') =>
    new Promise((resolve, reject) => {
      const res = {
        writeHead(status, headers) {
          Object.assign(this, { status, headers });
        },
        end(body) {
          resolve({ status: this.status, headers: this.headers, body: String(body ?? '') });
        },
      };
      Promise.resolve(handler({ method, url: '/' }, res)).catch(reject);
    });
  return { request, logged };
}

test("Launch Library: the upstream's 401, 429 and 500 come back as that status, with a generic error and one short log line", async (t) => {
  for (const status of [401, 429, 500]) {
    for (const preview of [false, true]) {
      await t.test(`${status} in ${preview ? 'preview' : 'development'}`, async (t2) => {
        let calls = 0;
        t2.mock.method(globalThis, 'fetch', async () => {
          calls += 1;
          return new Response(DETAIL.repeat(1000), { status });
        });
        const { request, logged } = launches(t2, { preview });
        const res = await request();
        assert.equal(res.status, status);
        assert.deepEqual(JSON.parse(res.body), { error: 'Launch Library 2 unavailable' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(res.headers['X-GEV-Cache'], 'NONE');
        assert.equal(calls, 1);
        // One line, the status only: never the upstream's body.
        assert.equal(logged.length, 1);
        assert.match(logged[0], new RegExp(`HTTP ${status}`));
        assert.ok(logged[0].length < 100, logged[0]);
        assert.doesNotMatch(`${res.body}\n${logged.join('\n')}`, /fixture-secret-token|internal\/example|<html>/);
      });
    }
  }
});

test('Launch Library: two requests at once share one upstream fetch', async (t) => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    await gate;
    return new Response(FEED);
  });
  const { request } = launches(t);
  assert.equal((await request('POST')).status, 405, 'GET only');
  const first = request();
  const second = request();
  release();
  const pair = await Promise.all([first, second]);
  assert.equal(calls, 1, 'one fetch for both');
  assert.deepEqual(pair.map((res) => res.status), [200, 200]);
  assert.deepEqual(pair.map((res) => res.body), [FEED, FEED]);
  assert.deepEqual(pair.map((res) => res.headers['X-GEV-Cache']).sort(), ['INFLIGHT', 'MISS']);
});

test('Launch Library: a fresh copy is served from cache, and a stale one when a refresh fails', async (t) => {
  let now = Date.UTC(2026, 9, 1, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  let failing = false;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (failing) throw new Error(DETAIL);
    return new Response(FEED);
  });
  const { request, logged } = launches(t);
  const first = await request();
  assert.deepEqual([first.status, first.headers['X-GEV-Cache'], first.body], [200, 'MISS', FEED]);
  // Within the TTL the copy is served without asking upstream.
  now += LL2_CACHE_TTL_MS - 1000;
  const fresh = await request();
  assert.deepEqual([fresh.status, fresh.headers['X-GEV-Cache'], fresh.body], [200, 'HIT', FEED]);
  assert.equal(calls, 1);
  // Past it, a refresh is tried; when it fails the old copy is still served.
  now += 2000;
  failing = true;
  const stale = await request();
  assert.deepEqual([stale.status, stale.headers['X-GEV-Cache'], stale.body], [200, 'STALE-ERROR', FEED]);
  assert.equal(calls, 2);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /HTTP 502\) — serving stale cache/);
  assert.doesNotMatch(logged.join('\n'), /fixture-secret-token|internal\/example|<html>/);
  // Once upstream is back, the next press refreshes the copy.
  failing = false;
  const back = await request();
  assert.deepEqual([back.status, back.headers['X-GEV-Cache']], [200, 'MISS']);
  assert.equal(calls, 3);
});
