import test from 'node:test';
import assert from 'node:assert/strict';
import {
  healthPlugin,
  healthSnapshot,
} from '../../server/standalone/health.js';

test('the health snapshot counts live handles by type and reports the listener', () => {
  const snapshot = healthSnapshot({
    pid: 4242,
    uptimeMs: 1234.6,
    memory: { rss: 10, heapUsed: 5 },
    resources: ['TCPSocketWrap', 'Timeout', 'TCPSocketWrap', 'FSReqCallback'],
    restarts: 3,
    listening: true,
    port: 4173,
    extra: { ais: { vessels: 2 } },
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.pid, 4242);
  assert.equal(snapshot.uptimeMs, 1235);
  assert.deepEqual(snapshot.memory, { rss: 10, heapUsed: 5 });
  assert.deepEqual(snapshot.resources, {
    total: 4,
    byType: { TCPSocketWrap: 2, Timeout: 1, FSReqCallback: 1 },
  });
  assert.equal(snapshot.restarts, 3);
  assert.equal(snapshot.listening, true);
  assert.equal(snapshot.port, 4173);
  assert.deepEqual(snapshot.ais, { vessels: 2 });
  // Unknown inputs degrade to null/false/empty, never to a throw.
  const bare = healthSnapshot({ pid: 1, uptimeMs: -5 });
  assert.equal(bare.uptimeMs, 0);
  assert.equal(bare.memory, null);
  assert.deepEqual(bare.resources, { total: 0, byType: {} });
  assert.equal(bare.restarts, null);
  assert.equal(bare.listening, false);
  assert.equal(bare.port, null);
  assert.equal(healthSnapshot({ restarts: 'two' }).restarts, null);
});

/** A fake dev server that captures the one middleware the plugin registers. */
function fakeServer({ listening = true } = {}) {
  const registered = [];
  return {
    registered,
    middlewares: {
      use(path, handler) {
        registered.push({ path, handler });
      },
    },
    httpServer: {
      listening,
      address() {
        return { address: '127.0.0.1', port: 4173 };
      },
    },
  };
}

/** A fake response that records the status, headers and body it was given. */
function fakeResponse() {
  return {
    status: null,
    headers: null,
    body: undefined,
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(body) {
      this.body = body;
      this.ended = true;
    },
  };
}

test('the plugin serves /__gev/health as no-store JSON for GET and passes everything else on', async () => {
  const plugin = healthPlugin({ now: () => 1_000_000 });
  assert.equal(plugin.name, 'gev-health');
  assert.equal(plugin.apply, 'serve');
  const server = fakeServer();
  plugin.configureServer(server);
  assert.equal(server.registered.length, 1);
  assert.equal(server.registered[0].path, '/__gev/health');
  const { handler } = server.registered[0];

  const previous = globalThis.__GEV_DEV_SINGLE_INSTANCE;
  globalThis.__GEV_DEV_SINGLE_INSTANCE = { starts: 2 };
  try {
    const res = fakeResponse();
    let passed = 0;
    await handler({ method: 'GET', url: '/__gev/health' }, res, () => passed++);
    assert.equal(passed, 0);
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'application/json');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.ok(res.ended);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.pid, process.pid);
    // Two starts are one restart: the first start is not a restart.
    assert.equal(body.restarts, 1);
    assert.equal(body.listening, true);
    assert.equal(body.port, 4173);
    assert.ok(body.uptimeMs >= 0);
    assert.equal(typeof body.memory.rss, 'number');
    assert.equal(typeof body.resources.total, 'number');
    assert.equal(body.serverStartedAt, 1_000_000);
    assert.equal(body.serverAgeMs, 0);
    // Nothing from the environment leaks into the answer.
    assert.ok(!JSON.stringify(body).includes('API_KEY'));
  } finally {
    if (previous === undefined) delete globalThis.__GEV_DEV_SINGLE_INSTANCE;
    else globalThis.__GEV_DEV_SINGLE_INSTANCE = previous;
  }

  // A freshly launched process has restarted zero times; without the
  // single-instance state the count is simply unknown.
  const saved = globalThis.__GEV_DEV_SINGLE_INSTANCE;
  globalThis.__GEV_DEV_SINGLE_INSTANCE = { starts: 1 };
  try {
    const fresh = fakeResponse();
    await handler({ method: 'GET', url: '/__gev/health' }, fresh, () => {});
    assert.equal(JSON.parse(fresh.body).restarts, 0);
    delete globalThis.__GEV_DEV_SINGLE_INSTANCE;
    const res = fakeResponse();
    await handler({ method: 'GET', url: '/__gev/health' }, res, () => {});
    assert.equal(JSON.parse(res.body).restarts, null);
  } finally {
    if (saved !== undefined) globalThis.__GEV_DEV_SINGLE_INSTANCE = saved;
    else delete globalThis.__GEV_DEV_SINGLE_INSTANCE;
  }

  // HEAD answers the headers with no body; POST goes to the next handler.
  const head = fakeResponse();
  await handler({ method: 'HEAD', url: '/__gev/health' }, head, () => {});
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined);
  assert.ok(head.ended);
  const post = fakeResponse();
  let next = 0;
  await handler({ method: 'POST', url: '/__gev/health' }, post, () => next++);
  assert.equal(next, 1);
  assert.equal(post.status, null);
  assert.equal(post.ended, false);

  // A server that is not listening says so, with no port.
  const down = fakeServer({ listening: false });
  down.httpServer.address = () => null;
  healthPlugin().configureServer(down);
  const res = fakeResponse();
  await down.registered[0].handler({ method: 'GET' }, res, () => {});
  const body = JSON.parse(res.body);
  assert.equal(body.listening, false);
  assert.equal(body.port, null);
});
