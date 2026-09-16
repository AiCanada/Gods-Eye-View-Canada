// OVERPASS PROXY — which upstream answers count as an answer.
//
// One predicate governs cache reads, writes, and stale fallback. A mirror's
// refusal must neither end the search for healthy alternatives nor persist as
// data under the week/month-long cache TTLs. These cases use no live providers.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import createViteConfig, { fetchOverpassPayload, overpassPayloadIsData, readOverpassDisk } from '../vite.config.js';
import {
  overpassMirrorHealthSnapshot,
  resetOverpassMirrorHealth,
} from '../server/providers/overpass/transport.js';

const ENDPOINTS = ['https://a.example/api', 'https://b.example/api', 'https://c.example/api'];

/** Answer each endpoint from a map of url → {status, body}; record the order. */
function mirrors(byUrl) {
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(url);
    const answer = byUrl[url];
    if (answer instanceof Error) throw answer;
    return { status: answer.status, headers: { get: () => answer.contentType || 'application/json' } };
  };
  return { fetchImpl, tried, readBody: async (_, __) => byUrl[tried[tried.length - 1]]?.body ?? '' };
}

// Each fan-out case gets its own breaker state, so a refusal in one case never
// takes a mirror out of rotation for the next.
const run = (byUrl, options = {}) => {
  const m = mirrors(byUrl);
  return fetchOverpassPayload('data=x', 1e6, {
    endpoints: ENDPOINTS,
    fetchImpl: m.fetchImpl,
    readBody: m.readBody,
    simplify: (body) => body,
    mirrorHealth: new Map(),
    ...options,
  }).then((payload) => ({ payload, tried: m.tried }), (error) => ({ error, tried: m.tried }));
};

const DATA = { status: 200, body: '{"elements":[]}' };

test('disk cache rejects old refusals for fresh and stale reads but preserves last-good data', async () => {
  const key = `overpass-cache-regression-${randomUUID()}`;
  const directory = path.join(process.cwd(), '.gev-cache', 'overpass');
  const file = path.join(directory, `${createHash('sha1').update(key).digest('hex')}.json`);
  await mkdir(directory, { recursive: true });
  try {
    for (const refusal of [
      { status: 406 }, { status: 429 }, { status: 503 },
      { status: 200, rateLimited: true }, { status: 200, runtimeError: true },
    ]) {
      await writeFile(file, JSON.stringify({ ...DATA, cachedAt: Date.now(), ...refusal }));
      assert.equal(await readOverpassDisk(key, 60000), null, `fresh ${JSON.stringify(refusal)}`);
      assert.equal(await readOverpassDisk(key, Infinity), null, `stale ${JSON.stringify(refusal)}`);
    }
    const good = { ...DATA, cachedAt: Date.now() - 120000 };
    await writeFile(file, JSON.stringify(good));
    assert.equal(await readOverpassDisk(key, 60000), null, 'expired good data misses normal TTL');
    assert.deepEqual(await readOverpassDisk(key, Infinity), good, 'last-good data survives an outage');
    await writeFile(file, '{invalid');
    assert.equal(await readOverpassDisk(key, Infinity), null, 'corrupt cache is ignored');
  } finally {
    await unlink(file);
  }
});

// ── The predicate ────────────────────────────────────────────────────────────

test('only a 2xx that is neither rate-limited nor a runtime error is data', () => {
  assert.equal(overpassPayloadIsData({ status: 200 }), true);
  assert.equal(overpassPayloadIsData({ status: 204 }), true);

  // The measured refusal, and its neighbours. `< 500` admitted every one.
  for (const status of [400, 403, 406, 410, 429]) {
    assert.equal(overpassPayloadIsData({ status }), false, `${status} is not data`);
  }
  assert.equal(overpassPayloadIsData({ status: 502 }), false);
  // A 200 can still not be data: Overpass reports runtime failures in the body.
  assert.equal(overpassPayloadIsData({ status: 200, runtimeError: true }), false);
  assert.equal(overpassPayloadIsData({ status: 200, rateLimited: true }), false);
  assert.equal(overpassPayloadIsData({}), false);
  assert.equal(overpassPayloadIsData(null), false);
});

// ── The fan-out ──────────────────────────────────────────────────────────────

test('a refusal moves to the next mirror instead of ending the fan-out', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // The exact shape measured against the live mirrors.
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: { status: 406, contentType: 'text/html', body: '<!DOCTYPE HTML><title>406</title>' },
    [ENDPOINTS[1]]: DATA,
    [ENDPOINTS[2]]: DATA,
  });

  assert.equal(payload.status, 200);
  assert.equal(payload.endpoint, ENDPOINTS[1]);
  assert.deepEqual(tried, ENDPOINTS.slice(0, 2), 'the healthy mirror must be reached, and no further');
});

test('every mirror is asked with a User-Agent that identifies the application', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // The OSM API usage policy asks for a "Valid User-Agent identifying
  // application and version". Every outbound request must carry it, not just
  // the first: a mirror further down the list refusing an unidentified client
  // is exactly the case the fan-out exists to survive.
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, agent: options?.headers?.['User-Agent'] });
    // Refuse everywhere, so the loop is forced through the whole list.
    return { status: 503, headers: { get: () => 'text/html' } };
  };
  await fetchOverpassPayload('data=x', 1e6, {
    endpoints: ENDPOINTS,
    fetchImpl,
    readBody: async () => 'upstream down',
    simplify: (body) => body,
    mirrorHealth: new Map(),
  });

  assert.deepEqual(
    seen.map((request) => request.url),
    ENDPOINTS,
    'the fan-out must reach every mirror',
  );
  for (const request of seen) {
    const agent = String(request.agent || '');
    assert.match(
      agent,
      /^gods-eye-view\/\d/,
      `${request.url} must name the application and its version`,
    );
    assert.ok(
      !/proxy\/1\.0$/.test(agent),
      `${request.url} must not fall back to the unidentified label`,
    );
    assert.match(
      agent,
      /github\.com\/AiCanada\/Gods-Eye-View-Canada/,
      `${request.url} must carry a route back to this fork`,
    );
  }
});

test('a mirror that refuses the old label serves the same query under the identifying one', async () => {
  // Recorded from the canonical instance on 2026-09-14: the unidentified label
  // is answered with a 406 Not Acceptable HTML page before the query is read,
  // and the identifying one is served. This stub replays that shape so the
  // behaviour the header change buys is pinned without a live mirror.
  const REFUSED = 'gods-eye-view-overpass-proxy/1.0';
  const answer = (agent) =>
    String(agent || '').startsWith(REFUSED)
      ? {
          status: 406,
          body: '<!DOCTYPE HTML><title>406 Not Acceptable</title>',
          contentType: 'text/html',
        }
      : { status: 200, body: DATA.body, contentType: 'application/json' };

  let last = null;
  const runIdentified = (agentOverride) =>
    fetchOverpassPayload('data=x', 1e6, {
      endpoints: [ENDPOINTS[0]],
      fetchImpl: async (url, options) => {
        last = answer(agentOverride ?? options?.headers?.['User-Agent']);
        return { status: last.status, headers: { get: () => last.contentType } };
      },
      readBody: async () => last.body,
      simplify: (body) => body,
      mirrorHealth: new Map(),
    });

  const refused = await runIdentified(REFUSED);
  assert.equal(refused.status, 406, 'the old label is refused by the mirror');
  assert.equal(
    overpassPayloadIsData(refused),
    false,
    'a refusal is never treated as data',
  );

  const served = await runIdentified(undefined);
  assert.equal(served.status, 200, 'the header the proxy now sends is served');
  assert.equal(overpassPayloadIsData(served), true);
  assert.equal(served.body, DATA.body);
});

test('the first mirror to answer wins, and the rest are left alone', async () => {
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: DATA, [ENDPOINTS[1]]: DATA, [ENDPOINTS[2]]: DATA,
  });

  assert.equal(payload.endpoint, ENDPOINTS[0]);
  assert.deepEqual(tried, [ENDPOINTS[0]]);
});

test('a refusal every mirror agrees on is reported, not swallowed', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // A genuinely bad query must still say what upstream said — but only after
  // every mirror has had its chance to answer it.
  const refusal = { status: 400, body: 'line 1: parse error' };
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: refusal, [ENDPOINTS[1]]: refusal, [ENDPOINTS[2]]: refusal,
  });

  assert.equal(payload.status, 400);
  assert.equal(payload.endpoint, ENDPOINTS[0], 'the FIRST refusal is the one reported');
  assert.deepEqual(tried, ENDPOINTS);
  assert.equal(overpassPayloadIsData(payload), false, 'so it is neither cached nor served as data');
});

test('a mirror that throws is no different from one that refuses', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: new Error('ECONNRESET'),
    [ENDPOINTS[1]]: { status: 503, body: 'busy' },
    [ENDPOINTS[2]]: DATA,
  });

  assert.equal(payload.endpoint, ENDPOINTS[2]);
  assert.deepEqual(tried, ENDPOINTS);
});

test('when every mirror is unreachable the caller gets a throw, not a payload', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { error, payload } = await run({
    [ENDPOINTS[0]]: new Error('ECONNRESET'),
    [ENDPOINTS[1]]: new Error('ETIMEDOUT'),
    [ENDPOINTS[2]]: new Error('ENOTFOUND'),
  });

  assert.equal(payload, undefined);
  assert.match(error.message, /ENOTFOUND/);
});

test('production reader rotates past oversized, runtime-error and rate-limited bodies', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const [status, body] of [
    [200, 'x'.repeat(200)], [200, '{"remark":"runtime error: timed out","elements":[]}'],
    [200, 'rate_limited'], [429, 'busy'], [403, 'forbidden'],
  ]) {
    const tried = [];
    const payload = await fetchOverpassPayload('data=x', 100, {
      endpoints: ENDPOINTS,
      mirrorHealth: new Map(),
      fetchImpl: async (url) => {
        tried.push(url);
        return new Response(tried.length === 1 ? body : DATA.body, {
          status: tried.length === 1 ? status : 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.equal(payload.body, DATA.body);
    assert.deepEqual(tried, ENDPOINTS.slice(0, 2));
  }
});

function proxyHandler() {
  const plugin = createViteConfig({ mode: 'test' }).plugins.find(p => p.name === 'overpass-proxy');
  const routes = new Map();
  plugin.configureServer({ middlewares: { use: (route, handler) => routes.set(route, handler) } });
  return routes.get('/api/overpass');
}

function invoke(handler, body) {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, headers: this.headers, body }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('coalesced outage callers both receive last-good data, never a cached refusal', async (t) => {
  const handler = proxyHandler();
  t.mock.method(console, 'warn', () => {});
  t.after(() => resetOverpassMirrorHealth());
  for (const status of [406, 503, 429]) {
    // Every status below trips all four real mirrors; each case starts healthy.
    resetOverpassMirrorHealth();
    const query = `[out:json][timeout:12];node(around:10,30.27,-97.74)["name"="${randomUUID()}"];out;`;
    const body = `data=${encodeURIComponent(query)}`;
    const directory = path.join(process.cwd(), '.gev-cache', 'overpass');
    const file = path.join(directory, `${createHash('sha1').update(body).digest('hex')}.json`);
    await mkdir(directory, { recursive: true });
    const stale = { ...DATA, cachedAt: Date.now() - 40 * 86400000 };
    await writeFile(file, JSON.stringify(stale));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let fetches = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      fetches++;
      entered.resolve();
      await release.promise;
      return new Response('upstream unavailable', { status });
    });
    try {
      const first = invoke(handler, body);
      await entered.promise;
      const second = invoke(handler, body);
      // The second request consumes its in-memory stream and joins the pending
      // promise before releasing upstream. No network or elapsed-time sleep.
      await new Promise(resolve => setImmediate(resolve));
      release.resolve();
      for (const response of await Promise.all([first, second])) {
        assert.equal(response.status, 200, `${status}: both callers use last-good data`);
        assert.equal(response.body, DATA.body);
        assert.equal(response.headers['X-Overpass-Cache'], 'STALE');
      }
      assert.equal(fetches, 4, 'one shared, bounded mirror sequence');
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), stale);
    } finally {
      release.resolve();
      mock.mock.restore();
      await unlink(file);
    }
  }
});

// ── The per-mirror circuit breaker ───────────────────────────────────────────
//
// Measured 2026-09-14: two mirrors answer 406 to this proxy and two time out
// at 22 s, so every uncached query spent ~45 s re-learning that. A mirror that
// times out, refuses or rate-limits is skipped for a window instead.

const TIMEOUT = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
const ALL_DATA = { [ENDPOINTS[0]]: DATA, [ENDPOINTS[1]]: DATA, [ENDPOINTS[2]]: DATA };

test('a mirror that refuses or times out is skipped for its window, then probed again', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const health = new Map();
  let clock = 1_000_000;
  const options = { mirrorHealth: health, now: () => clock };

  const first = await run({
    [ENDPOINTS[0]]: { status: 406, contentType: 'text/html', body: '<title>406</title>' },
    [ENDPOINTS[1]]: TIMEOUT,
    [ENDPOINTS[2]]: DATA,
  }, options);
  assert.equal(first.payload.endpoint, ENDPOINTS[2]);
  assert.deepEqual(first.tried, ENDPOINTS);
  assert.deepEqual(overpassMirrorHealthSnapshot(health), {
    [ENDPOINTS[0]]: { failures: 1, openUntil: 1_120_000 },
    [ENDPOINTS[1]]: { failures: 1, openUntil: 1_120_000 },
  });

  clock += 60_000;
  const inWindow = await run(ALL_DATA, options);
  assert.deepEqual(inWindow.tried, [ENDPOINTS[2]], 'dead mirrors cost nothing inside their window');

  clock += 60_000;
  const probed = await run(ALL_DATA, options);
  assert.deepEqual(probed.tried, [ENDPOINTS[0]], 'a mirror past its window is asked again');
  assert.equal(probed.payload.endpoint, ENDPOINTS[0]);
  assert.equal(health.has(ENDPOINTS[0]), false, 'an answer resets the mirror');
  assert.equal(health.get(ENDPOINTS[1]).failures, 1, 'a mirror nobody probed keeps its count');
});

test('the window doubles per consecutive failure up to 30 minutes, and one answer resets it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const health = new Map();
  let clock = 0;
  const options = { endpoints: [ENDPOINTS[0]], mirrorHealth: health, now: () => clock };
  const windows = [];
  for (let i = 0; i < 6; i++) {
    const { payload } = await run({ [ENDPOINTS[0]]: { status: 429, body: 'Too Many Requests' } }, options);
    assert.equal(payload.rateLimited, true, 'a rate-limited mirror still reports what it said');
    windows.push(health.get(ENDPOINTS[0]).openUntil - clock);
    clock = health.get(ENDPOINTS[0]).openUntil;
  }
  assert.deepEqual(windows, [120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);

  const recovered = await run({ [ENDPOINTS[0]]: DATA }, options);
  assert.equal(recovered.payload.status, 200);
  assert.deepEqual(overpassMirrorHealthSnapshot(health), {});
});

test('query-level refusals, runtime errors and oversized bodies keep a mirror in rotation', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const health = new Map();
  for (const answer of [
    { status: 400, body: 'line 1: parse error' },
    { status: 413, body: 'query too large' },
    { status: 200, body: '{"remark":"runtime error: Query timed out"}' },
    Object.assign(new Error('Upstream response too large'), { code: 'RESPONSE_TOO_LARGE' }),
  ]) {
    await run({ [ENDPOINTS[0]]: answer, [ENDPOINTS[1]]: DATA, [ENDPOINTS[2]]: DATA }, { mirrorHealth: health });
    assert.deepEqual(overpassMirrorHealthSnapshot(health), {}, JSON.stringify(answer.status ?? answer.code));
  }
});

test('with every mirror inside its window the call fails at once without a request', async () => {
  const health = new Map(ENDPOINTS.map((endpoint) => [endpoint, { failures: 3, openUntil: 5_000, probing: false }]));
  const { error, tried } = await run(ALL_DATA, { mirrorHealth: health, now: () => 1_000 });
  assert.equal(error.code, 'OVERPASS_MIRRORS_BACKING_OFF');
  assert.deepEqual(tried, []);
});

test('after a window passes one query probes the mirror while concurrent queries skip it', async () => {
  const health = new Map([[ENDPOINTS[0], { failures: 2, openUntil: 0, probing: false }]]);
  const probe = Promise.withResolvers();
  const tried = [];
  const options = {
    endpoints: ENDPOINTS,
    simplify: (body) => body,
    mirrorHealth: health,
    now: () => 10,
    fetchImpl: async (url) => {
      tried.push(url);
      if (url === ENDPOINTS[0]) await probe.promise;
      return new Response(DATA.body, { status: 200 });
    },
  };
  const probing = fetchOverpassPayload('data=x', 1e6, options);
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await fetchOverpassPayload('data=y', 1e6, options);
  assert.equal(concurrent.endpoint, ENDPOINTS[1], 'the half-open mirror is left to its one probe');
  probe.resolve();
  assert.equal((await probing).endpoint, ENDPOINTS[0]);
  assert.deepEqual(tried, [ENDPOINTS[0], ENDPOINTS[1]]);
  assert.equal(health.size, 0);
});

test('queries that fail on the same outage together step the backoff once', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const health = new Map();
  const options = {
    endpoints: [ENDPOINTS[0]],
    simplify: (body) => body,
    mirrorHealth: health,
    now: () => 0,
    fetchImpl: async () => new Response('Not Acceptable', { status: 406 }),
  };
  await Promise.all([
    fetchOverpassPayload('data=x', 1e6, options),
    fetchOverpassPayload('data=y', 1e6, options),
  ]);
  assert.deepEqual(overpassMirrorHealthSnapshot(health), {
    [ENDPOINTS[0]]: { failures: 1, openUntil: 120_000 },
  });
});

test('the proxy never sends a new query to a mirror that just refused it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  resetOverpassMirrorHealth();
  t.after(() => resetOverpassMirrorHealth());
  const handler = proxyHandler();
  const hosts = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    hosts.push(new URL(url).hostname);
    return hosts.length === 1
      ? new Response('<title>406</title>', { status: 406 })
      : new Response(DATA.body, { status: 200 });
  });
  const query = (name) => `data=${encodeURIComponent(`[out:json][timeout:12];node(around:10,30.27,-97.74)["name"="${name}"];out;`)}`;
  const first = await invoke(handler, query(randomUUID()));
  const second = await invoke(handler, query(randomUUID()));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(hosts, ['overpass-api.de', 'overpass.kumi.systems', 'overpass.kumi.systems']);
});
