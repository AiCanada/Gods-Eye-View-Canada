import assert from 'node:assert/strict';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import {
  mapillaryProxy,
  TILE_ROUTE_MAX_PER_MIN,
} from 'gods-eye-view/server/providers/mapillary';
import { stripTileLayers } from '../../server/providers/mapillary/trim.js';
import {
  MAX_RETRY_AFTER_SEC,
  TILE_MAX_BYTES,
  TILE_MEMORY_MAX_TILE_BYTES,
  TILE_MEMORY_MAX_TILES,
  TILE_UPSTREAM_CONCURRENCY,
  TILE_TTL_MS,
  fetchTile,
  parseTilePath,
  _resetTileCacheForTest,
} from '../../server/providers/mapillary/tiles.js';
import {
  IMAGES_FIELDS,
  IMAGES_LIMIT,
  IMAGES_QUEUE_MAX,
  IMAGES_ROUTE_MAX_PER_MIN,
  IMAGES_UPSTREAM_CONCURRENCY,
  fetchImages,
  normalizeImagesBbox,
  ImagesRequestError,
  _resetImagesForTest,
} from '../../server/providers/mapillary/images.js';

/** Build a minimal MVT: layers with a name, a version and one opaque feature. */
function tile(layers) {
  const writer = new PbfWriter();
  for (const { name, payload } of layers) {
    writer.writeMessage(
      3,
      (layer, pbf) => {
        pbf.writeVarintField(15, 2); // version
        pbf.writeStringField(1, layer.name);
        pbf.writeMessage(2, (_f, p) => p.writeVarintField(1, 7), null); // feature
        pbf.writeVarintField(5, 4096); // extent
        if (layer.payload) pbf.writeBytesField(4, layer.payload); // a big key
      },
      { name, payload },
    );
  }
  return Buffer.from(writer.finish());
}

const SEQUENCE = tile([{ name: 'sequence' }]);
const UNTRIMMED = tile([
  { name: 'sequence' },
  { name: 'image', payload: Buffer.alloc(4000, 1) },
]);

/** Mount the plugin and return `call(route, url, method, headers, onResponse)`. */
function install(mode = 'configureServer') {
  const routes = new Map();
  mapillaryProxy()[mode]({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  const call = async (
    route,
    url = '/',
    method = 'GET',
    reqHeaders = {},
    onResponse = null,
  ) => {
    const handler = routes.get(route);
    assert.ok(handler, `route ${route} is mounted`);
    const headers = {};
    const listeners = new Map();
    const res = {
      statusCode: 200,
      headers,
      on: (type, listener) => listeners.set(type, listener),
      /** The client goes away, as Node reports it. */
      close: () => listeners.get('close')?.(),
      setHeader: (name, value) => (headers[name.toLowerCase()] = value),
      getHeader: (name) => headers[name.toLowerCase()],
      writeHead(status, extra) {
        this.statusCode = status;
        Object.assign(headers, extra || {});
      },
      end(payload) {
        this.body = payload;
        this.writableEnded = true;
      },
    };
    onResponse?.(res);
    await handler({ url, method, headers: reqHeaders }, res);
    return res;
  };
  return { routes, call };
}

const json = (res) => JSON.parse(String(res.body));
/** Every header value and the body, as text, for a token-leak check. */
const leakText = (res) =>
  [
    ...Object.values(res.headers).map(String),
    Buffer.isBuffer(res.body) ? res.body.toString('latin1') : String(res.body),
  ].join('\n');

function withToken(token, run) {
  const saved = process.env.MAPILLARY_CLIENT_TOKEN;
  if (token === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
  else process.env.MAPILLARY_CLIENT_TOKEN = token;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (saved === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
      else process.env.MAPILLARY_CLIENT_TOKEN = saved;
    });
}

/** Drive the tile route against a scripted upstream `answer(n, url)`. */
async function withUpstream(answer, run) {
  const savedFetch = globalThis.fetch;
  _resetTileCacheForTest();
  _resetImagesForTest();
  const calls = [];
  const inits = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    inits.push(init);
    return answer(calls.length, String(url), init);
  };
  try {
    await withToken('MLY|test|token', () =>
      run({ calls, inits, call: install().call }),
    );
  } finally {
    globalThis.fetch = savedFetch;
    _resetTileCacheForTest();
    _resetImagesForTest();
  }
}

const ok = (body = SEQUENCE) => new Response(body, { status: 200 });

test('the plugin mounts the status, tile and image routes for dev and preview servers', () => {
  for (const mode of ['configureServer', 'configurePreviewServer'])
    assert.deepEqual([...install(mode).routes.keys()].sort(), [
      '/api/mapillary/images',
      '/api/mapillary/status',
      '/api/mapillary/tiles',
    ]);
});

test('status reports whether a token exists, never its value', async () => {
  const { call } = install();
  await withToken(undefined, async () => {
    const res = await call('/api/mapillary/status');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { configured: false });
    assert.equal(
      (await call('/api/mapillary/status', '/', 'POST')).statusCode,
      405,
    );
  });
  await withToken('MLY|secret', async () => {
    const res = await call('/api/mapillary/status');
    assert.deepEqual(json(res), { configured: true });
    assert.doesNotMatch(leakText(res), /MLY\|/);
  });
});

test('the tile route validates the path, then needs a token', async () => {
  await withUpstream(
    () => assert.fail('Mapillary is not asked'),
    async ({ call }) => {
      for (const bad of [
        '/coverage/14/1/x',
        '/signs/14/1/2',
        '/coverage/10/0/0',
        '/coverage/15/0/0',
        '/coverage/11/2048/0',
        '/coverage/11/0/2048',
        '/coverage/14/1/2/3',
      ]) {
        const res = await call('/api/mapillary/tiles', bad);
        assert.equal(res.statusCode, 400, bad);
      }
      const post = await call(
        '/api/mapillary/tiles',
        '/coverage/14/1/2',
        'POST',
      );
      assert.equal(post.statusCode, 405);
    },
  );
  await withToken(undefined, async () => {
    const res = await install().call(
      '/api/mapillary/tiles',
      '/coverage/14/1/2',
    );
    assert.equal(res.statusCode, 503);
    assert.deepEqual(json(res), { error: 'no_key', keyRequired: true });
  });
});

test('a tile is trimmed, served with browser caching, then from memory', async () => {
  await withUpstream(
    () => ok(UNTRIMMED),
    async ({ calls, inits, call }) => {
      const res = await call('/api/mapillary/tiles', '/coverage/14/9/9');
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'application/x-protobuf');
      assert.equal(res.headers['cache-control'], 'public, max-age=3600');
      assert.equal(res.headers['x-gev-cache'], 'upstream');
      assert.deepEqual(res.body, SEQUENCE, 'the image layer is dropped');
      assert.doesNotMatch(leakText(res), /MLY\|/);
      assert.equal(
        calls[0],
        'https://tiles.mapillary.com/maps/vtp/mly1_public/2/14/9/9?access_token=MLY%7Ctest%7Ctoken',
      );
      assert.equal(inits[0].redirect, 'manual');
      const again = await call('/api/mapillary/tiles', '/coverage/14/9/9?v=2');
      assert.equal(again.headers['x-gev-cache'], 'memory');
      assert.deepEqual(again.body, SEQUENCE);
      assert.equal(calls.length, 1);
    },
  );
});

for (const status of [204, 404])
  test(`an empty upstream tile (${status}) is a 204 with no body, and is cached`, async () => {
    await withUpstream(
      () => new Response(null, { status }),
      async ({ calls, call }) => {
        for (const source of ['upstream', 'memory']) {
          const res = await call('/api/mapillary/tiles', '/coverage/14/10/10');
          assert.equal(res.statusCode, 204);
          assert.equal(res.body, undefined);
          assert.equal(res.headers['x-gev-cache'], source);
        }
        assert.equal(calls.length, 1);
      },
    );
  });

for (const status of [401, 403])
  test(`an upstream ${status} is a rejected key`, async () => {
    await withUpstream(
      () => new Response('{}', { status }),
      async ({ call }) => {
        const res = await call('/api/mapillary/tiles', '/coverage/14/5/5');
        assert.equal(res.statusCode, 403);
        assert.deepEqual(json(res), {
          error: 'Mapillary rejected the access token',
          keyRejected: true,
        });
        assert.doesNotMatch(leakText(res), /MLY\|/);
      },
    );
  });

for (const [sent, expected] of [
  ['30', 30],
  [null, 60],
  ['999999', 600],
])
  test(`an upstream 429 (Retry-After ${sent}) is passed on as ${expected} s`, async () => {
    await withUpstream(
      () =>
        new Response('{}', {
          status: 429,
          headers: sent === null ? {} : { 'Retry-After': sent },
        }),
      async ({ calls, call }) => {
        const res = await call('/api/mapillary/tiles', '/coverage/14/5/5');
        assert.equal(res.statusCode, 429);
        assert.equal(res.headers['retry-after'], String(expected));
        assert.deepEqual(json(res), {
          error: 'Mapillary is rate-limiting tile requests',
          retryAfter: expected,
        });
        // Not cached as a tile, but refused here until the wait is over.
        const again = await call('/api/mapillary/tiles', '/coverage/14/5/5');
        assert.equal(again.statusCode, 429);
        assert.equal(calls.length, 1);
      },
    );
  });

for (const status of [302, 400, 410, 500])
  test(`an upstream ${status} is a 502, not the client's fault`, async () => {
    await withUpstream(
      () => new Response('{}', { status }),
      async ({ call }) => {
        const res = await call('/api/mapillary/tiles', '/coverage/14/12/12');
        assert.equal(res.statusCode, 502);
        assert.deepEqual(json(res), {
          error: `Mapillary tiles HTTP ${status}`,
        });
      },
    );
  });

test('a streamed body past the size cap is cancelled and answered 502', async () => {
  const MB = 1024 * 1024;
  let pulled = 0;
  let cancelled = false;
  // Chunked, no Content-Length: only a running count can see it is too big.
  const body = () =>
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(MB));
        pulled += MB;
        if (pulled >= TILE_MAX_BYTES + 8 * MB) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
  await withUpstream(
    () => new Response(body(), { status: 200 }),
    async ({ call }) => {
      const res = await call('/api/mapillary/tiles', '/coverage/14/19/19');
      assert.equal(res.statusCode, 502);
      assert.deepEqual(json(res), { error: 'Mapillary tile exceeds size cap' });
      assert.equal(cancelled, true);
      assert.ok(pulled <= TILE_MAX_BYTES + 2 * MB, `stopped after ${pulled}`);
    },
  );
});

test('cross-site requests are refused on every route; the app itself passes', async () => {
  await withUpstream(
    () => ok(),
    async ({ calls, call }) => {
      const host = 'localhost:5173';
      for (const headers of [
        { host, 'sec-fetch-site': 'cross-site' }, // <img>, navigation
        { host, 'sec-fetch-site': 'same-site' },
        { host, origin: 'https://evil.example' }, // fetch from another page
        { host, origin: 'null' }, // sandboxed frame
        { host, 'x-forwarded-for': '203.0.113.9' }, // through a proxy
      ])
        for (const [route, url] of [
          ['/api/mapillary/status', '/'],
          ['/api/mapillary/tiles', '/coverage/14/13/13'],
          ['/api/mapillary/images', '/?bbox=-97.75,30.25,-97.7,30.3'],
        ]) {
          const res = await call(route, url, 'GET', headers);
          assert.equal(
            res.statusCode,
            403,
            `${route} ${JSON.stringify(headers)}`,
          );
        }
      assert.equal(calls.length, 0, 'Mapillary is never asked');
      const app = { host, 'sec-fetch-site': 'same-origin' };
      const status = await call('/api/mapillary/status', '/', 'GET', {
        ...app,
        origin: `http://${host}`,
      });
      assert.deepEqual(json(status), { configured: true });
      const res = await call(
        '/api/mapillary/tiles',
        '/coverage/14/13/14',
        'GET',
        app,
      );
      assert.equal(res.statusCode, 200);
    },
  );
});

test('the tile route answers 429 past its per-IP budget', async () => {
  await withToken(undefined, async () => {
    const { call } = install();
    for (let i = 0; i < TILE_ROUTE_MAX_PER_MIN; i++)
      assert.equal(
        (await call('/api/mapillary/tiles', '/coverage/14/1/2')).statusCode,
        503,
      );
    const over = await call('/api/mapillary/tiles', '/coverage/14/1/2');
    assert.equal(over.statusCode, 429);
    assert.equal(over.headers['retry-after'], '5');
    assert.deepEqual(json(over), {
      error: 'Too many tile requests',
      retryAfter: 5,
    });
    const status = await call('/api/mapillary/status');
    assert.equal(status.statusCode, 200, 'the status route is not limited');
  });
});

test('identical concurrent tile requests share one upstream fetch', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await withUpstream(
    async (n) =>
      n === 1 ? (await gate, ok()) : new Response('{}', { status: 500 }),
    async ({ calls, call }) => {
      const pending = [1, 2, 3].map(() =>
        call('/api/mapillary/tiles', '/coverage/14/1/1'),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls.length, 1);
      release();
      const sources = (await Promise.all(pending)).map((res) => {
        assert.deepEqual(res.body, SEQUENCE);
        return res.headers['x-gev-cache'];
      });
      assert.deepEqual(sources, ['upstream', 'inflight', 'inflight']);
      // A failed flight is not reused either.
      const failed = await call('/api/mapillary/tiles', '/coverage/14/2/2');
      assert.equal(failed.statusCode, 502);
      await call('/api/mapillary/tiles', '/coverage/14/2/2');
      assert.equal(calls.length, 3);
    },
  );
});

test('at most a few upstream fetches run at once; the rest wait their turn', async () => {
  let release;
  let gate = new Promise((resolve) => (release = resolve));
  await withUpstream(
    async () => (await gate, ok()),
    async ({ calls, call }) => {
      const tiles = TILE_UPSTREAM_CONCURRENCY + 4;
      const pending = Array.from({ length: tiles }, (_, i) =>
        call('/api/mapillary/tiles', `/coverage/14/${i}/3`),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls.length, TILE_UPSTREAM_CONCURRENCY);
      release();
      const done = await Promise.all(pending);
      assert.ok(done.every((res) => res.statusCode === 200));
      assert.equal(calls.length, tiles, 'the waiting ones ran too');
      // Every slot came back: a second burst runs as many at once again.
      let reopen;
      gate = new Promise((resolve) => (reopen = resolve));
      const again = Array.from({ length: tiles }, (_, i) =>
        call('/api/mapillary/tiles', `/coverage/14/${i}/4`),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls.length, tiles + TILE_UPSTREAM_CONCURRENCY);
      reopen();
      await Promise.all(again);
      assert.equal(calls.length, 2 * tiles);
    },
  );
});

/** An upstream that answers when released, and fails as a fetch does when aborted. */
function heldUpstream() {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const answer = (n, url, init) =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
      gate.then(() => resolve(ok()));
    });
  return { answer, release };
}

const settleSoon = () => new Promise((resolve) => setTimeout(resolve, 10));

test(
  'a queued fetch whose client left never reaches Mapillary',
  { timeout: 5000 },
  async () => {
    const upstream = heldUpstream();
    await withUpstream(upstream.answer, async ({ calls }) => {
      const busy = Array.from({ length: TILE_UPSTREAM_CONCURRENCY }, (_, i) =>
        fetchTile(parseTilePath(`/coverage/14/${i}/5`)),
      );
      const client = new AbortController();
      const queued = fetchTile(parseTilePath('/coverage/14/99/5'), {
        signal: client.signal,
      });
      await settleSoon();
      assert.equal(calls.length, TILE_UPSTREAM_CONCURRENCY, 'the 7th waits');
      client.abort();
      await assert.rejects(queued, { name: 'AbortError' });
      upstream.release();
      await Promise.all(busy);
      await settleSoon();
      assert.equal(calls.length, TILE_UPSTREAM_CONCURRENCY, 'and never ran');
      // The freed slots still serve a live request.
      await fetchTile(parseTilePath('/coverage/14/98/5'));
      assert.equal(calls.length, TILE_UPSTREAM_CONCURRENCY + 1);
    });
  },
);

test(
  'a client that disconnects cancels its tile fetch and gets no answer',
  { timeout: 5000 },
  async () => {
    const upstream = heldUpstream();
    await withUpstream(upstream.answer, async ({ inits, call }) => {
      let res;
      const done = call(
        '/api/mapillary/tiles',
        '/coverage/14/8/8',
        'GET',
        {},
        (r) => (res = r),
      );
      await settleSoon();
      res.close();
      await done;
      assert.equal(inits[0].signal.aborted, true, 'the upstream fetch stopped');
      assert.equal(res.body, undefined, 'nothing written to a closed socket');
    });
  },
);

test(
  'a shared fetch is cancelled only when its last client leaves',
  { timeout: 5000 },
  async () => {
    const upstream = heldUpstream();
    await withUpstream(upstream.answer, async ({ calls, inits }) => {
      const address = parseTilePath('/coverage/14/7/7');
      const first = new AbortController();
      const second = new AbortController();
      const a = fetchTile(address, { signal: first.signal });
      const b = fetchTile(address, { signal: second.signal });
      await settleSoon();
      assert.equal(calls.length, 1, 'one fetch for both');
      first.abort();
      await assert.rejects(a, { name: 'AbortError' });
      assert.equal(inits[0].signal.aborted, false, 'the other still waits');
      second.abort();
      await assert.rejects(b, { name: 'AbortError' });
      assert.equal(inits[0].signal.aborted, true, 'the last one left');
      // A new request starts afresh rather than joining the cancelled fetch.
      upstream.release();
      const again = await fetchTile(address);
      assert.equal(again.source, 'upstream');
      assert.equal(calls.length, 2);
    });
  },
);

test('a tile held in memory past its TTL is fetched again', async (t) => {
  await withUpstream(
    () => ok(),
    async ({ calls, call }) => {
      await call('/api/mapillary/tiles', '/coverage/14/3/3');
      await call('/api/mapillary/tiles', '/coverage/14/3/3');
      assert.equal(calls.length, 1);
      const now = Date.now();
      t.mock.method(Date, 'now', () => now + TILE_TTL_MS + 1000);
      const res = await call('/api/mapillary/tiles', '/coverage/14/3/3');
      assert.equal(res.headers['x-gev-cache'], 'upstream');
      assert.equal(calls.length, 2);
    },
  );
});

test('the memory cache evicts the least recently used tile past its size', async () => {
  await withUpstream(
    () => ok(),
    async ({ calls }) => {
      const get = async (x) =>
        (await fetchTile(parseTilePath(`/coverage/14/${x}/20`))).source;
      for (let x = 0; x < TILE_MEMORY_MAX_TILES; x++) await get(x);
      assert.equal(await get(0), 'memory', 'the first is used again');
      await get(TILE_MEMORY_MAX_TILES);
      assert.equal(await get(0), 'memory', 'so it stays');
      assert.equal(await get(1), 'upstream', 'the least recently used went');
      assert.equal(calls.length, TILE_MEMORY_MAX_TILES + 2);
    },
  );
});

// ── Upstream refusals ──

const rateLimited = (retryAfter) =>
  new Response('', { status: 429, headers: { 'retry-after': retryAfter } });

test('after a 429 the rest of the view waits out Retry-After here instead of asking Mapillary', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await withUpstream(
    (n) => (n === 1 ? rateLimited('120') : ok()),
    async ({ calls, call }) => {
      const first = await call('/api/mapillary/tiles', '/coverage/14/1/1');
      assert.equal(first.statusCode, 429);
      assert.equal(json(first).retryAfter, 120);
      const rest = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          call('/api/mapillary/tiles', `/coverage/14/2/${i}`),
        ),
      );
      assert.equal(calls.length, 1, 'nothing else reached Mapillary');
      for (const res of rest) {
        assert.equal(res.statusCode, 429);
        assert.equal(json(res).retryAfter, 120);
      }
      // Half way through the wait, the answer says what is left.
      Date.now.mock.mockImplementation(() => now + 50_000);
      const midway = await call('/api/mapillary/tiles', '/coverage/14/3/3');
      assert.equal(json(midway).retryAfter, 70);
      assert.equal(calls.length, 1);
      // Once it is over, requests go upstream again.
      Date.now.mock.mockImplementation(() => now + 121_000);
      const later = await call('/api/mapillary/tiles', '/coverage/14/3/3');
      assert.equal(later.statusCode, 200);
      assert.equal(calls.length, 2);
    },
  );
});

test('a refusal is scoped to the token that was refused', async () => {
  await withUpstream(
    (n) => (n === 1 ? rateLimited('120') : ok()),
    async ({ calls, call }) => {
      await call('/api/mapillary/tiles', '/coverage/14/1/1');
      process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|replaced|token';
      const res = await call('/api/mapillary/tiles', '/coverage/14/1/2');
      assert.equal(res.statusCode, 200, 'a new token is tried at once');
      assert.equal(calls.length, 2);
    },
  );
});

test(
  'fetches queued behind a 429 never reach Mapillary',
  { timeout: 5000 },
  async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const answer = (n) => gate.then(() => (n === 1 ? rateLimited('60') : ok()));
    await withUpstream(answer, async ({ calls }) => {
      const busy = Array.from({ length: TILE_UPSTREAM_CONCURRENCY }, (_, i) =>
        fetchTile(parseTilePath(`/coverage/14/${i}/6`)).catch((e) => e),
      );
      const queued = Array.from({ length: 3 }, (_, i) =>
        fetchTile(parseTilePath(`/coverage/14/${i}/7`)).catch((e) => e),
      );
      await settleSoon();
      assert.equal(calls.length, TILE_UPSTREAM_CONCURRENCY, 'three wait');
      release();
      const [first] = await Promise.all(busy);
      assert.equal(first.status, 429);
      for (const outcome of await Promise.all(queued)) {
        assert.equal(outcome.status, 429, 'refused here');
        assert.equal(outcome.retryAfter, '60');
      }
      assert.equal(calls.length, TILE_UPSTREAM_CONCURRENCY, 'and never ran');
    });
  },
);

test('an HTTP-date Retry-After is passed on as the seconds left; garbage means a minute', async (t) => {
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);
  t.mock.method(Date, 'now', () => now);
  const inFiveMinutes = new Date(now + 5 * 60_000).toUTCString();
  const inAnHour = new Date(now + 60 * 60_000).toUTCString();
  const anHourAgo = new Date(now - 60 * 60_000).toUTCString();
  const sent = [inFiveMinutes, inAnHour, anHourAgo, 'soon', ''];
  await withUpstream(
    (n) => rateLimited(sent[n - 1]),
    async ({ call }) => {
      const retryAfter = async (x) => {
        _resetTileCacheForTest();
        const res = await call('/api/mapillary/tiles', `/coverage/14/${x}/9`);
        assert.equal(res.statusCode, 429);
        assert.equal(res.headers['retry-after'], String(json(res).retryAfter));
        return json(res).retryAfter;
      };
      assert.equal(await retryAfter(1), 300);
      assert.equal(await retryAfter(2), MAX_RETRY_AFTER_SEC, 'capped');
      assert.equal(await retryAfter(3), 60, 'a date in the past');
      assert.equal(await retryAfter(4), 60, 'not a date');
      assert.equal(await retryAfter(5), 60, 'no header');
    },
  );
});

test('a body too big to be a trimmed tile is served but not kept in memory', async () => {
  const huge = Buffer.alloc(TILE_MEMORY_MAX_TILE_BYTES + 1, 0xff);
  await withUpstream(
    () => ok(huge),
    async ({ calls, call }) => {
      const first = await call('/api/mapillary/tiles', '/coverage/14/5/5');
      assert.equal(first.statusCode, 200);
      assert.equal(first.body.length, huge.length, 'served as it came');
      const second = await call('/api/mapillary/tiles', '/coverage/14/5/5');
      assert.equal(second.headers['x-gev-cache'], 'upstream', 'not cached');
      assert.equal(calls.length, 2);
    },
  );
});

// ── Tile trimming ──

test('dropping a layer keeps the others byte-for-byte', () => {
  const bytes = tile([
    { name: 'sequence' },
    { name: 'image', payload: Buffer.alloc(50_000, 7) },
    { name: 'overview' },
  ]);
  const trimmed = stripTileLayers(bytes, ['image']);
  assert.deepEqual(trimmed, tile([{ name: 'sequence' }, { name: 'overview' }]));
});

test('a tile without the layer is returned untouched', () => {
  assert.equal(stripTileLayers(SEQUENCE, ['image']), SEQUENCE);
  assert.equal(stripTileLayers(SEQUENCE, []), SEQUENCE);
  assert.equal(stripTileLayers(Buffer.alloc(0), ['image']).length, 0);
});

// ── Image search ──

/** Poll `check` until it holds, for at most two seconds. */
async function waitFor(check, what) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const BBOX = '-97.75,30.25,-97.7,30.3';
const imageRow = (id, extra = {}) => ({
  id,
  captured_at: 1_760_000_000_000,
  compass_angle: 91.5,
  computed_compass_angle: 92.25,
  geometry: { type: 'Point', coordinates: [-97.7431234567, 30.2672345678] },
  sequence: 'seqAbc123',
  is_pano: false,
  camera_type: 'perspective',
  ...extra,
});
const graphAnswer = (data, extra = {}) =>
  new Response(JSON.stringify({ data, ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('the image route never searches without a token', async () => {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.MAPILLARY_CLIENT_TOKEN;
  delete process.env.MAPILLARY_CLIENT_TOKEN;
  _resetImagesForTest();
  let upstream = 0;
  globalThis.fetch = async () => {
    upstream++;
    return graphAnswer([]);
  };
  try {
    const { call } = install();
    const noKey = await call('/api/mapillary/images', `/?bbox=${BBOX}`);
    assert.equal(noKey.statusCode, 503);
    assert.deepEqual(json(noKey), { error: 'no_key', keyRequired: true });
    await assert.rejects(fetchImages(normalizeImagesBbox(BBOX)), {
      name: 'ImagesRequestError',
      status: 503,
    });
    assert.equal(upstream, 0, 'Mapillary is never asked');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = savedToken;
  }
});

test('an image search box must be four plain decimals, ordered, at most 0.05° a side', async () => {
  await withUpstream(
    () => graphAnswer([]),
    async ({ calls, call }) => {
      for (const bbox of [
        null, // no bbox at all
        '',
        '-97.75,30.25,-97.7',
        '-97.75,30.25,-97.7,30.3,1',
        'a,b,c,d',
        '1e1,30.25,10.01,30.3',
        '0x10,30.25,16.01,30.3',
        'Infinity,30.25,-97.7,30.3',
        '-97.7,30.25,-97.75,30.3', // west after east
        '-97.75,30.3,-97.7,30.25', // south after north
        '-97.75,30.25,-97.75,30.3', // no width
        '-97.8,30.25,-97.7,30.3', // 0.1° wide
        '-97.75,30.2,-97.7,30.3', // 0.1° tall
        '-180.02,0,-179.99,0.01', // off the globe
        '10,90.01,10.01,90.02',
      ]) {
        const res = await call(
          '/api/mapillary/images',
          bbox === null ? '/' : `/?bbox=${bbox}`,
        );
        assert.equal(res.statusCode, 400, String(bbox));
        assert.match(json(res).error, /bbox/, String(bbox));
      }
      const path = await call('/api/mapillary/images', `/x?bbox=${BBOX}`);
      assert.equal(path.statusCode, 400);
      const post = await call(
        '/api/mapillary/images',
        `/?bbox=${BBOX}`,
        'POST',
      );
      assert.equal(post.statusCode, 405);
      assert.equal(calls.length, 0, 'Mapillary is never asked');
    },
  );
});

test('an image search carries the token only in its header and answers validated images, then from memory', async () => {
  await withUpstream(
    () =>
      graphAnswer([
        imageRow('1001'),
        imageRow(1002, {
          is_pano: true,
          camera_type: 'spherical',
          computed_compass_angle: null,
          compass_angle: -90,
        }),
        imageRow('1001'), // a repeat
        imageRow('10 03'), // not a plain id
        imageRow('1004', { geometry: null }),
        imageRow('1005', {
          geometry: { type: 'Point', coordinates: [-197.7, 30.27] },
        }),
        imageRow('1006', {
          captured_at: 'soon',
          compass_angle: 'north',
          computed_compass_angle: null,
          sequence: 'x'.repeat(65),
          camera_type: '<b>fisheye</b>',
        }),
        'not an image',
      ]),
    async ({ calls, inits, call }) => {
      const res = await call('/api/mapillary/images', `/?bbox=${BBOX}`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-gev-cache'], 'upstream');
      const place = { lat: 30.2672346, lon: -97.7431235 };
      assert.deepEqual(json(res), {
        images: [
          {
            id: '1001',
            capturedAt: 1_760_000_000_000,
            ...place,
            compass: 92.25,
            sequence: 'seqAbc123',
            isPano: false,
            cameraType: 'perspective',
          },
          {
            id: '1002',
            capturedAt: 1_760_000_000_000,
            ...place,
            compass: 270,
            sequence: 'seqAbc123',
            isPano: true,
            cameraType: 'spherical',
          },
          {
            id: '1006',
            capturedAt: null,
            ...place,
            compass: null,
            sequence: null,
            isPano: false,
            cameraType: null,
          },
        ],
        truncated: false,
      });
      assert.equal(calls.length, 1);
      const url = new URL(calls[0]);
      assert.equal(url.origin, 'https://graph.mapillary.com');
      assert.equal(url.pathname, '/images');
      assert.equal(url.searchParams.get('bbox'), BBOX);
      assert.equal(url.searchParams.get('fields'), IMAGES_FIELDS);
      assert.equal(url.searchParams.get('limit'), String(IMAGES_LIMIT));
      assert.equal(url.searchParams.has('access_token'), false);
      assert.doesNotMatch(calls[0], /MLY/, 'the token is not in the URL');
      assert.equal(inits[0].headers.Authorization, 'OAuth MLY|test|token');
      assert.equal(inits[0].redirect, 'manual');
      assert.doesNotMatch(String(res.body), /MLY/);
      // The same box written differently is the same cache entry.
      const again = await call(
        '/api/mapillary/images',
        '/?bbox=-97.750000,30.25,-97.70,30.300',
      );
      assert.equal(again.statusCode, 200);
      assert.equal(again.headers['x-gev-cache'], 'memory');
      assert.equal(again.body, res.body);
      assert.equal(calls.length, 1, 'answered from memory');
    },
  );
});

test('a full page of images, or a next link, marks the answer truncated', async () => {
  let respond = () =>
    graphAnswer(
      Array.from({ length: IMAGES_LIMIT + 5 }, (_, i) =>
        imageRow(String(5000 + i)),
      ),
    );
  await withUpstream(
    () => respond(),
    async ({ call }) => {
      const full = json(await call('/api/mapillary/images', `/?bbox=${BBOX}`));
      assert.equal(full.truncated, true);
      assert.equal(full.images.length, IMAGES_LIMIT, 'never past the limit');
      respond = () =>
        graphAnswer([imageRow('1')], {
          paging: { next: 'https://graph.mapillary.com/images?after=x' },
        });
      const paged = json(
        await call('/api/mapillary/images', '/?bbox=-97.7,30.25,-97.65,30.3'),
      );
      assert.deepEqual([paged.images.length, paged.truncated], [1, true]);
    },
  );
});

test('malformed upstream JSON is a 502, never cached, and the next ask tries again', async () => {
  const bodies = [
    '{"data": [',
    '{"data": "none"}',
    JSON.stringify({ data: [imageRow('7')] }),
  ];
  await withUpstream(
    (n) => new Response(bodies[n - 1], { status: 200 }),
    async ({ calls, call }) => {
      const broken = await call('/api/mapillary/images', `/?bbox=${BBOX}`);
      assert.equal(broken.statusCode, 502);
      assert.deepEqual(json(broken), {
        error: 'Mapillary answered malformed JSON',
      });
      const shapeless = await call('/api/mapillary/images', `/?bbox=${BBOX}`);
      assert.equal(shapeless.statusCode, 502);
      assert.deepEqual(json(shapeless), {
        error: 'Mapillary answered without an image list',
      });
      const good = await call('/api/mapillary/images', `/?bbox=${BBOX}`);
      assert.equal(good.statusCode, 200);
      assert.equal(json(good).images[0].id, '7');
      assert.equal(calls.length, 3, 'a bad answer is never cached');
    },
  );
});

test('a rejected token or a rate limit holds image searches; cached answers still serve', async (t) => {
  let status = 200;
  await withUpstream(
    () =>
      status === 200
        ? graphAnswer([imageRow('1')])
        : new Response('{}', {
            status,
            headers: status === 429 ? { 'Retry-After': '30' } : {},
          }),
    async ({ calls, call }) => {
      const ask = (bbox) => call('/api/mapillary/images', `/?bbox=${bbox}`);
      assert.equal((await ask(BBOX)).statusCode, 200);
      status = 403;
      const rejected = await ask('-97.7,30.25,-97.65,30.3');
      assert.equal(rejected.statusCode, 403);
      assert.deepEqual(json(rejected), {
        error: 'Mapillary rejected the access token',
        keyRejected: true,
      });
      assert.equal((await ask('-97.65,30.25,-97.6,30.3')).statusCode, 403);
      assert.equal(calls.length, 2, 'held: Mapillary is not asked again');
      assert.equal((await ask(BBOX)).headers['x-gev-cache'], 'memory');
      // A new token is tried at once; a 429 passes its Retry-After on.
      process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|new|token';
      status = 429;
      const limited = await ask('-97.65,30.25,-97.6,30.3');
      assert.equal(limited.statusCode, 429);
      assert.equal(limited.headers['retry-after'], '30');
      assert.deepEqual(json(limited), {
        error: 'Mapillary is rate-limiting image searches',
        retryAfter: 30,
      });
      assert.equal((await ask('-97.6,30.25,-97.55,30.3')).statusCode, 429);
      assert.equal(calls.length, 3, 'held until the Retry-After is over');
      const now = Date.now();
      t.mock.method(Date, 'now', () => now + 31_000);
      status = 200;
      assert.equal((await ask('-97.6,30.25,-97.55,30.3')).statusCode, 200);
      assert.equal(calls.length, 4);
    },
  );
});

test('an image search that redirects is refused, never followed', async () => {
  await withUpstream(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://graph.mapillary.com.evil.example/x' },
      }),
    async ({ calls, inits, call }) => {
      const res = await call('/api/mapillary/images', `/?bbox=${BBOX}`);
      assert.equal(res.statusCode, 502);
      assert.deepEqual(json(res), {
        error: 'Mapillary image search redirected',
      });
      assert.equal(calls.length, 1, 'the Location is never fetched');
      assert.equal(inits[0].redirect, 'manual');
    },
  );
});

test('identical image searches share one upstream request; a full queue is refused', async () => {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.MAPILLARY_CLIENT_TOKEN;
  process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|test|token';
  _resetImagesForTest();
  const pending = [];
  globalThis.fetch = () =>
    new Promise((resolve) =>
      pending.push(() => resolve(graphAnswer([imageRow('1')]))),
    );
  const box = (i) =>
    normalizeImagesBbox(
      `${(i * 0.05).toFixed(2)},0,${((i + 1) * 0.05).toFixed(2)},0.05`,
    );
  try {
    const first = fetchImages(box(0));
    const joined = fetchImages(box(0));
    const others = Array.from(
      { length: IMAGES_UPSTREAM_CONCURRENCY + IMAGES_QUEUE_MAX - 1 },
      (_, i) => fetchImages(box(i + 1)),
    );
    await waitFor(
      () => pending.length === IMAGES_UPSTREAM_CONCURRENCY,
      'the upstream slots to fill',
    );
    await assert.rejects(
      fetchImages(box(99)),
      (error) =>
        error instanceof ImagesRequestError &&
        error.status === 503 &&
        error.retryAfterSec === 5,
    );
    const all = Promise.all([first, joined, ...others]);
    for (let i = 0; i <= others.length; i++) {
      await waitFor(() => pending.length > 0, 'an upstream request');
      pending.shift()();
    }
    const [a, b] = await all;
    assert.deepEqual([a.source, b.source], ['upstream', 'inflight']);
    assert.equal(a.body, b.body);
    assert.equal(pending.length, 0, 'one request per box');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = savedToken;
    _resetImagesForTest();
  }
});

test('the image route answers 429 past its per-IP budget', async () => {
  const saved = process.env.MAPILLARY_CLIENT_TOKEN;
  delete process.env.MAPILLARY_CLIENT_TOKEN;
  try {
    const { call } = install();
    for (let i = 0; i < IMAGES_ROUTE_MAX_PER_MIN; i++) {
      const res = await call('/api/mapillary/images', `/?bbox=${BBOX}`);
      assert.equal(res.statusCode, 503, `request ${i + 1} is within budget`);
    }
    const over = await call('/api/mapillary/images', `/?bbox=${BBOX}`);
    assert.equal(over.statusCode, 429);
    assert.equal(over.headers['retry-after'], '5');
    assert.deepEqual(json(over), {
      error: 'Too many image requests',
      retryAfter: 5,
    });
    const tile = await call('/api/mapillary/tiles', '/coverage/14/1/2');
    assert.equal(tile.statusCode, 503, 'tiles keep their own budget');
  } finally {
    if (saved === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = saved;
  }
});
