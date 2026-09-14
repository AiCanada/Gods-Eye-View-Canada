import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { overpassProxy } from 'gods-eye-view/server/providers/overpass';
import { militaryInstallationsProxy } from 'gods-eye-view/server/providers/military-installations';
import {
  regionalBriefProxy,
  weatherEffectsProxy,
} from 'gods-eye-view/server/providers/regional';
import { openAiRealtimeProxy } from 'gods-eye-view/server/providers/openai';
import { keySetupEndpoint } from 'gods-eye-view/server/standalone/key-setup';
import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
    restart: async () => {},
  });
  return routes;
}
function request(
  handler,
  {
    method = 'GET',
    url = '/',
    body = '',
    origin = 'http://localhost:4173',
    signal,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, {
      method,
      url,
      headers: {
        host: 'localhost:4173',
        origin,
        'content-type': 'application/json',
      },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const headers = {};
    const res = {
      statusCode: 200,
      writableEnded: false,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      writeHead(status, values) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(values)) this.setHeader(k, v);
      },
      end(body = '') {
        this.writableEnded = true;
        resolve({
          status: this.statusCode,
          headers,
          body: String(body),
          json: () => JSON.parse(String(body)),
        });
      },
    };
    // A client that gives up closes its connection, as a browser abort does.
    signal?.addEventListener('abort', () => req.emit('close'), { once: true });
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
const ONTARIO = {
  city: 'Toronto',
  state: 'Ontario',
  'ISO3166-2-lvl4': 'CA-ON',
  country: 'Canada',
  country_code: 'ca',
};
const QUEBEC = {
  city: 'Montreal',
  state: 'Quebec',
  'ISO3166-2-lvl4': 'CA-QC',
  country: 'Canada',
  country_code: 'ca',
};
function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}
function root(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-services-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('standalone service guards run in development and preview without upstream acquisition', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('invalid requests must not fetch');
  });
  for (const preview of [false, true]) {
    for (const [factory, route] of [
      [overpassProxy, '/api/overpass'],
      [militaryInstallationsProxy, '/api/military-installations'],
      [regionalBriefProxy, '/api/regional-brief'],
      [regionalBriefProxy, '/api/location-region'],
      [weatherEffectsProxy, '/api/weather-effects'],
    ]) {
      const routes = install(factory(), preview);
      assert.equal(
        (await request(routes.get(route), { method: 'DELETE' })).status,
        405,
      );
      assert.equal(
        (
          await request(routes.get(route), {
            method: route === '/api/overpass' ? 'POST' : 'GET',
          })
        ).status,
        400,
      );
    }
  }
});

test('location-region answers the province, state or country of a point and remembers it', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    assert.equal(new URL(url).hostname, 'nominatim.openstreetmap.org');
    return Response.json({
      address: {
        city: 'Toronto',
        state: 'Ontario',
        'ISO3166-2-lvl4': 'CA-ON',
        country: 'Canada',
        country_code: 'ca',
      },
    });
  });
  const handler = install(regionalBriefProxy()).get('/api/location-region');
  const first = await request(handler, {
    url: '/?latitude=43.6511&longitude=-79.3832',
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json(), {
    key: 'CA-ON',
    regionCode: 'CA-ON',
    region: 'Ontario',
    countryCode: 'CA',
    country: 'Canada',
  });
  const nearby = await request(handler, {
    url: '/?latitude=43.6549&longitude=-79.3801',
  });
  assert.equal(nearby.headers['x-location-region'], 'HIT');
  assert.equal(calls, 1, 'a point in the same cell is answered from memory');
});

test('location-region cache hits and joined lookups never spend the request quota', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ address: QUEBEC });
  });
  const handler = install(regionalBriefProxy()).get('/api/location-region');
  const query = { url: '/?latitude=45.5017&longitude=-73.5673' };
  // More than the 30 a minute one client may start, in one ~1 km cell.
  const joined = await Promise.all(
    Array.from({ length: 20 }, () => request(handler, query)),
  );
  const hits = [];
  for (let i = 0; i < 20; i++) hits.push(await request(handler, query));
  assert.deepEqual(
    [...joined, ...hits].map((res) => res.status),
    Array(40).fill(200),
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    joined.map((res) => res.headers['x-location-region']).sort(),
    ['INFLIGHT', ...Array(18).fill('INFLIGHT'), 'MISS'],
  );
  assert.ok(hits.every((res) => res.headers['x-location-region'] === 'HIT'));
  assert.equal(hits.at(-1).json().key, 'CA-QC');
});

test('location-region remembers a point Nominatim cannot place, but not an upstream failure', async (t) => {
  let calls = 0;
  let answer = () => Response.json({ error: 'Unable to geocode' });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return answer();
  });
  const handler = install(regionalBriefProxy()).get('/api/location-region');
  const ocean = { url: '/?latitude=-60.1234&longitude=-30.5678' };
  for (let i = 0; i < 2; i++) {
    const res = await request(handler, ocean);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), {
      key: '',
      regionCode: null,
      region: null,
      countryCode: null,
      country: null,
    });
  }
  assert.equal(calls, 1, 'open water is answered from memory the second time');

  answer = () => new Response('busy', { status: 503 });
  const failing = { url: '/?latitude=-61.1234&longitude=-30.5678' };
  assert.equal((await request(handler, failing)).status, 503);
  assert.equal((await request(handler, failing)).status, 503);
  assert.equal(calls, 3, 'a real upstream error is asked again');
});

test('location-region lookups every requester abandoned never reach Nominatim, and joined ones still answer', async (t) => {
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const params = new URL(url).searchParams;
    const lat = Number(params.get('lat'));
    const lon = Number(params.get('lon'));
    asked.push(`${lat.toFixed(2)},${lon.toFixed(2)}`);
    return Response.json({ address: lon > -75 ? QUEBEC : ONTARIO });
  });
  const handler = install(regionalBriefProxy()).get('/api/location-region');
  const lookup = (latitude, longitude, signal) =>
    request(handler, {
      url: `/?latitude=${latitude}&longitude=${longitude}`,
      signal,
    });
  const abandoned = [];
  const abandon = (latitude, longitude) => {
    const client = new AbortController();
    abandoned.push(lookup(latitude, longitude, client.signal));
    return client;
  };

  // Map clicks the client has since superseded, queued behind one another.
  const clicks = [44.01, 44.03, 44.05].map((lat) => abandon(lat, -79.4));
  // Two tabs ask for one cell; one gives up, the other still wants it.
  const leaving = abandon(44.21, -79.4);
  const joined = lookup(44.21, -79.4);
  for (const client of [...clicks, leaving]) client.abort();
  // Asking again for an abandoned cell starts a lookup of its own.
  const again = lookup(44.05, -79.4);
  const pill = await lookup(46.8139, -71.208);
  await Promise.all(abandoned);

  const kept = await joined;
  assert.equal(kept.status, 200);
  assert.equal(kept.headers['x-location-region'], 'INFLIGHT');
  assert.equal(kept.json().key, 'CA-ON');
  assert.equal((await again).json().key, 'CA-ON');
  assert.equal(pill.status, 200);
  assert.equal(pill.json().key, 'CA-QC');
  assert.deepEqual(asked, ['44.21,-79.40', '44.05,-79.40', '46.81,-71.21']);
});

test('weather-only requests share upstream work and retain fresh and stale responses', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    assert.equal(new URL(url).hostname, 'api.open-meteo.com');
    if (calls > 1) throw Error('offline');
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({
      current: {
        time: '2026-09-12T12:00',
        temperature_2m: 20,
        weather_code: 0,
        wind_speed_10m: 10,
      },
    });
  });
  const handler = install(weatherEffectsProxy()).get('/api/weather-effects');
  const query = { url: '/?latitude=34.61&longitude=-112.43' };
  const pair = await Promise.all([
    request(handler, query),
    request(handler, query),
  ]);
  assert.deepEqual(pair.map((r) => r.headers['x-weather-effects']).sort(), [
    'INFLIGHT',
    'MISS',
  ]);
  assert.equal(calls, 1);
  assert.equal(
    (await request(handler, query)).headers['x-weather-effects'],
    'HIT',
  );
  now += 6 * 60_000;
  assert.equal(
    (await request(handler, query)).headers['x-weather-effects'],
    'STALE',
  );
});

test('Realtime handler preserves tools and default instructions, isolates supplied annotation guidance, and keeps the upstream key server-side', async (t) => {
  env(t, 'OPENAI_API_KEY', 'fixture-upstream-secret');
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', undefined);
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/realtime/client_secrets');
    assert.equal(
      options.headers.Authorization,
      'Bearer fixture-upstream-secret',
    );
    sent.push(JSON.parse(options.body));
    return Response.json({ value: 'fixture-ephemeral' });
  });
  for (const [options, guidance] of [
    [{}, undefined],
    [
      { annotationGuidance: 'Fixture annotation instruction.' },
      'Fixture annotation instruction.',
    ],
    [{}, undefined],
  ]) {
    const response = await request(
      install(openAiRealtimeProxy(options)).get('/api/realtime/token'),
      { url: '/?tier=unknown' },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-gev-voice-tier'], 'standard');
    assert.equal(response.headers['x-gev-voice-tier-fallback'], '1');
    assert.equal(response.body.includes('fixture-upstream-secret'), false);
    assert.equal(
      sent.at(-1).session.instructions,
      realtimeInstructions(guidance),
    );
    assert.deepEqual(sent.at(-1).session.tools, GEV_REALTIME_TOOLS);
  }
  assert.notEqual(sent[0].session.instructions, sent[1].session.instructions);
  assert.equal(sent[0].session.instructions, sent[2].session.instructions);
});

test('debug logging resolves each supplied application directory independently', async (t) => {
  const first = root(t),
    second = root(t);
  for (const [sourceRoot, marker] of [
    [first, 'first'],
    [second, 'second'],
  ]) {
    const handler = install(openAiRealtimeProxy({ sourceRoot })).get(
      '/api/realtime/debug-log',
    );
    assert.equal(
      (
        await request(handler, {
          method: 'POST',
          body: JSON.stringify({ marker }),
        })
      ).status,
      204,
    );
    const file = path.join(
      sourceRoot,
      '.gev-logs/realtime-conversations.jsonl',
    );
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).marker, marker);
  }
});

test('key setup writes only the supplied application root, retains request guards and stays absent from preview', async (t) => {
  const first = root(t),
    untouched = root(t);
  env(t, 'OPENAI_API_KEY', undefined);
  const plugin = keySetupEndpoint({ sourceRoot: first });
  assert.equal(plugin.apply({}, { command: 'serve', isPreview: true }), false);
  assert.equal(plugin.configurePreviewServer, undefined);
  const routes = install(plugin);
  const handler = routes.get('/api/setup/keys');
  const body = JSON.stringify({
    OPENAI_API_KEY: 'sk-fixture-only-not-a-real-key',
  });
  assert.equal(
    (
      await request(handler, {
        method: 'POST',
        body,
        origin: 'https://example.com',
      })
    ).status,
    403,
  );
  assert.equal(existsSync(path.join(first, '.env')), false);
  const saved = await request(handler, { method: 'POST', body });
  assert.equal(saved.status, 200);
  assert.match(
    readFileSync(path.join(first, '.env'), 'utf8'),
    /OPENAI_API_KEY=sk-fixture-only-not-a-real-key/,
  );
  if (process.platform !== 'win32')
    assert.equal(statSync(path.join(first, '.env')).mode & 0o777, 0o600);
  assert.equal(saved.body.includes('sk-fixture-only-not-a-real-key'), false);
  assert.equal(existsSync(path.join(untouched, '.env')), false);
});
