// OVERPASS PROXY — which upstream answers count as an answer.
//
// One predicate governs cache reads, writes, and stale fallback. A configured
// upstream's refusal is never data, and only operator-supplied alternatives
// may be tried. These cases use no live providers.
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
import {
  OVERPASS_PUBLIC_MIRRORS,
  OVERPASS_USER_AGENT,
  parseOverpassUpstreams,
} from '../server/providers/overpass/constants.js';

const ENDPOINTS = ['https://a.example/api', 'https://b.example/api', 'https://c.example/api'];
// The public mirrors use the measured 120 s → 30 min breaker windows.
const PUBLIC = OVERPASS_PUBLIC_MIRRORS.slice(0, 3);

/** Answer each endpoint from a map of url → {status, body}; record the order. */
function mirrors(byUrl) {
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(url);
    const answer = byUrl[url];
    if (answer instanceof Error) throw answer;
    return {
      status: answer.status,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? answer.contentType || 'application/json' : null) },
    };
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

test('OVERPASS_UPSTREAMS uses no public instance unless the operator writes `public`', () => {
  assert.deepEqual(parseOverpassUpstreams(''), []);
  assert.deepEqual(parseOverpassUpstreams('public'), [...OVERPASS_PUBLIC_MIRRORS]);
  assert.deepEqual(
    parseOverpassUpstreams('https://mine.example/api, PUBLIC'),
    ['https://mine.example/api', ...OVERPASS_PUBLIC_MIRRORS],
  );
  assert.deepEqual(parseOverpassUpstreams('public,public'), [...OVERPASS_PUBLIC_MIRRORS]);
});

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
  assert.equal(payload.body, DATA.body);
  assert.equal(payload.endpoint, 'configured');
  assert.deepEqual(tried, ENDPOINTS.slice(0, 2));
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
    return { status: 503, headers: { get: () => null } };
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

test('a mirror that refuses the old label serves the same query under the identifying one', async (t) => {
  t.mock.method(console, 'warn', () => {});
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
        return { status: last.status, headers: { get: () => null } };
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

  assert.equal(payload.body, DATA.body);
  assert.deepEqual(tried, [ENDPOINTS[0]]);
});

test('a refusal every mirror agrees on is reported, not swallowed', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // A genuinely bad query must still say so — but only after every mirror
  // has had its chance to answer it.
  const refusal = { status: 400, body: 'line 1: parse error' };
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: refusal, [ENDPOINTS[1]]: refusal, [ENDPOINTS[2]]: refusal,
  });

  assert.equal(payload.status, 400);
  assert.equal(JSON.parse(payload.body).code, 'OVERPASS_QUERY_REFUSED');
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

  assert.equal(payload.body, DATA.body);
  assert.deepEqual(tried, ENDPOINTS);
});

test('when every mirror is unreachable the caller gets a sanitized refusal, not a throw', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { error, payload } = await run({
    [ENDPOINTS[0]]: new Error('ECONNRESET'),
    [ENDPOINTS[1]]: new Error('ETIMEDOUT'),
    [ENDPOINTS[2]]: new Error('ENOTFOUND https://c.example/api'),
  });

  assert.equal(error, undefined);
  assert.equal(payload.status, 502);
  assert.equal(overpassPayloadIsData(payload), false);
  assert.doesNotMatch(payload.body, /example|https:/);
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

// Configured endpoints replace defaults; refusals are sanitized and cooled down.
test('configured failover accepts empty data and keeps the application identity', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const endpoints = ['https://first.example/query?secret=one', 'http://localhost:12345/api'];
  const seen = [];
  const payload = await fetchOverpassPayload('data=x', 1024, {
    endpoints,
    fetchImpl: async (url, options) => {
      seen.push(url);
      assert.equal(options.headers['User-Agent'], OVERPASS_USER_AGENT);
      assert.match(options.headers['User-Agent'], /^gods-eye-view\/0\.1 /);
      assert.equal(options.redirect, 'error');
      return new Response(seen.length === 1 ? url : DATA.body, { status: seen.length === 1 ? 406 : 200 });
    },
  });
  assert.deepEqual(seen, endpoints);
  assert.equal(payload.body, DATA.body);
  assert.equal(payload.endpoint, 'configured');
});

test('406 and 429 honor Retry-After across different queries without more egress', async () => {
  for (const status of [406, 429]) {
    const endpoint = `https://cooldown-${status}.example/private?token=secret`;
    let count = 0, now = 1_000_000;
    const options = { endpoints: [endpoint], now: () => now, fetchImpl: async () => {
      count++;
      return new Response(`Refused ${endpoint}`, { status, headers: { 'Retry-After': '90' } });
    } };
    const first = await fetchOverpassPayload('first', 1024, options);
    assert.equal(first.status, status);
    assert.equal(first.retryAfterMs, 90_000);
    assert.doesNotMatch(JSON.stringify(first), /secret|https:/);
    now += 30_000;
    const next = await fetchOverpassPayload('different', 1024, options);
    assert.equal(count, 1);
    assert.equal(next.retryAfterMs, 60_000);
    now += 60_001;
    await fetchOverpassPayload('third', 1024, options);
    assert.equal(count, 2);
  }
});

test('HTTP-date Retry-After is respected, and absent delays use bounded backoff', async () => {
  let now = Date.parse('2026-09-23T12:00:00Z');
  const endpoint = 'https://dated.example/api';
  const payload = await fetchOverpassPayload('x', 1024, { endpoints: [endpoint], now: () => now,
    fetchImpl: async () => new Response('busy', { status: 429, headers: { 'Retry-After': 'Wed, 23 Sep 2026 12:02:00 GMT' } }) });
  assert.equal(payload.retryAfterMs, 120_000);
  const options = { endpoints: ['https://bounded.example'], now: () => now,
    fetchImpl: async () => { throw new Error('https://bounded.example/secret'); } };
  for (let i = 0; i < 8; i++) {
    const reply = await fetchOverpassPayload('x', 1024, options);
    assert.ok(reply.retryAfterMs <= 300_000);
    assert.doesNotMatch(reply.body, /secret|https:/);
    now += reply.retryAfterMs + 1;
  }
});

test('production reader rejects oversized, malformed and runtime-failure bodies', async () => {
  for (const [i, body] of ['x'.repeat(200), '{"remark":"runtime error: timed out","elements":[]}', 'rate_limited', '{}', 'not json'].entries()) {
    const endpoints = [`https://bad-${i}.example/`, `https://good-${i}.example/`];
    const seen = [];
    const payload = await fetchOverpassPayload('data=x', 100, { endpoints, fetchImpl: async (url) => {
      seen.push(url); return new Response(seen.length === 1 ? body : DATA.body);
    } });
    assert.equal(payload.body, DATA.body); assert.deepEqual(seen, endpoints);
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
  const prior = process.env.OVERPASS_UPSTREAMS;
  t.after(() => { if (prior === undefined) delete process.env.OVERPASS_UPSTREAMS; else process.env.OVERPASS_UPSTREAMS = prior; });
  for (const status of [406, 503, 429]) {
    // Each case starts healthy.
    resetOverpassMirrorHealth();
    process.env.OVERPASS_UPSTREAMS = `https://outage-${status}.example/api`;
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
      assert.equal(fetches, 1, 'one shared configured request');
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
// Measured 2026-09-14: two public mirrors answer 406 to this proxy and two
// time out at 22 s, so every uncached query spent ~45 s re-learning that. An
// endpoint that times out, refuses or rate-limits is skipped for a window
// instead. Public mirrors use the measured 120 s → 30 min windows; operator
// instances use the bounded 30 s → 5 min backoff (pinned above).

const TIMEOUT = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
const ALL_PUBLIC_DATA = { [PUBLIC[0]]: DATA, [PUBLIC[1]]: DATA, [PUBLIC[2]]: DATA };

test('a mirror that refuses or times out is skipped for its window, then probed again', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const health = new Map();
  let clock = 1_000_000;
  const options = { endpoints: PUBLIC, mirrorHealth: health, now: () => clock };

  const first = await run({
    [PUBLIC[0]]: { status: 406, contentType: 'text/html', body: '<title>406</title>' },
    [PUBLIC[1]]: TIMEOUT,
    [PUBLIC[2]]: DATA,
  }, options);
  assert.equal(first.payload.body, DATA.body);
  assert.deepEqual(first.tried, PUBLIC);
  assert.deepEqual(overpassMirrorHealthSnapshot(health), {
    [PUBLIC[0]]: { failures: 1, openUntil: 1_120_000 },
    [PUBLIC[1]]: { failures: 1, openUntil: 1_120_000 },
  });

  clock += 60_000;
  const inWindow = await run(ALL_PUBLIC_DATA, options);
  assert.deepEqual(inWindow.tried, [PUBLIC[2]], 'dead mirrors cost nothing inside their window');

  clock += 60_000;
  const probed = await run(ALL_PUBLIC_DATA, options);
  assert.deepEqual(probed.tried, [PUBLIC[0]], 'a mirror past its window is asked again');
  assert.equal(probed.payload.body, DATA.body);
  assert.equal(health.has(PUBLIC[0]), false, 'an answer resets the mirror');
  assert.equal(health.get(PUBLIC[1]).failures, 1, 'a mirror nobody probed keeps its count');
});

test('a public mirror window doubles per consecutive failure up to 30 minutes, and one answer resets it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const health = new Map();
  let clock = 0;
  const options = { endpoints: [PUBLIC[0]], mirrorHealth: health, now: () => clock };
  const windows = [];
  for (let i = 0; i < 6; i++) {
    const { payload } = await run({ [PUBLIC[0]]: { status: 429, body: 'Too Many Requests' } }, options);
    assert.equal(payload.rateLimited, true, 'a rate-limited mirror still reports that it was');
    windows.push(health.get(PUBLIC[0]).until - clock);
    clock = health.get(PUBLIC[0]).until;
  }
  assert.deepEqual(windows, [120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);

  const recovered = await run({ [PUBLIC[0]]: DATA }, options);
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
  const health = new Map(ENDPOINTS.map((endpoint) => [endpoint, { failures: 3, until: 5_000, status: 429, probing: false }]));
  const { payload, tried } = await run(
    { [ENDPOINTS[0]]: DATA, [ENDPOINTS[1]]: DATA, [ENDPOINTS[2]]: DATA },
    { mirrorHealth: health, now: () => 1_000 },
  );
  assert.equal(payload.status, 429);
  assert.equal(payload.retryAfterMs, 4_000);
  assert.equal(overpassPayloadIsData(payload), false);
  assert.deepEqual(tried, []);
});

test('after a window passes one query probes the mirror while concurrent queries skip it', async () => {
  const health = new Map([[ENDPOINTS[0], { failures: 2, until: 0, status: 502, probing: false }]]);
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
  assert.equal(concurrent.body, DATA.body);
  assert.deepEqual(tried, [ENDPOINTS[0], ENDPOINTS[1]], 'the half-open mirror is left to its one probe');
  probe.resolve();
  assert.equal((await probing).body, DATA.body);
  assert.equal(health.size, 0);
});

test('queries that fail on the same outage together step the backoff once', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const health = new Map();
  const options = {
    endpoints: [PUBLIC[0]],
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
    [PUBLIC[0]]: { failures: 1, openUntil: 120_000 },
  });
});

test('the proxy never sends a new query to a public mirror that just refused it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  resetOverpassMirrorHealth();
  t.after(() => resetOverpassMirrorHealth());
  const prior = process.env.OVERPASS_UPSTREAMS;
  t.after(() => { if (prior === undefined) delete process.env.OVERPASS_UPSTREAMS; else process.env.OVERPASS_UPSTREAMS = prior; });
  process.env.OVERPASS_UPSTREAMS = 'public';
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
