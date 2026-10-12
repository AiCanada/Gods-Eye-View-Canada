import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  localMcpPlugin,
  ownerToolFetch,
  ownerToolRequestAllowed,
} from '../../server/mcp/plugin.js';
import {
  OWNER_DEVICE_AUTHORITY_HEADER,
  OWNER_DEVICE_HEADER,
  OWNER_DEVICE_READ_HEADER,
  OWNER_DEVICE_REMOVAL_HEADER,
  setOwnerDeviceToken,
} from '../keySetupCore.mjs';

const TOKEN = 'c'.repeat(64);
const MIRROR = 'http://100.64.0.1:4173';

/** Mounts the plugin and sends one request straight to its middleware. */
function mount(options) {
  let middleware;
  localMcpPlugin(options).configureServer({
    middlewares: { use: (_path, handler) => (middleware = handler) },
  });
  return ({
    remoteAddress = '100.64.0.10',
    localPort = 4173,
    headers = {},
    body = { jsonrpc: '2.0', id: 1, method: 'ping' },
  } = {}) =>
    new Promise((resolve, reject) => {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      Object.assign(req, {
        method: 'POST',
        url: '/',
        headers: {
          host: '100.64.0.1:4173',
          origin: MIRROR,
          'content-type': 'application/json',
          [OWNER_DEVICE_HEADER]: TOKEN,
          [OWNER_DEVICE_AUTHORITY_HEADER]: MIRROR,
          ...headers,
        },
        socket: { remoteAddress, localPort },
      });
      const res = {
        headersSent: false,
        writableFinished: false,
        on() {},
        off() {},
        writeHead(status) {
          this.status = status;
          this.headersSent = true;
        },
        end(chunk = '') {
          this.writableFinished = true;
          resolve({ status: this.status, body: String(chunk) });
        },
        destroy: reject,
      };
      Promise.resolve(middleware(req, res)).catch(reject);
    });
}

test("an owner device's MCP call reaches this machine's API over loopback, without the mirror's stamp", async (t) => {
  setOwnerDeviceToken(TOKEN);
  t.after(() => setOwnerDeviceToken(''));
  const created = [];
  const seenHeaders = [];
  const RealRequest = globalThis.Request;
  globalThis.Request = class extends RealRequest {
    constructor(input, init) {
      super(input, init);
      seenHeaders.push(Object.fromEntries(this.headers));
    }
  };
  t.after(() => (globalThis.Request = RealRequest));
  const send = mount({
    createServer: (options) => {
      created.push(options);
      return {
        handle: async (message) => ({
          jsonrpc: '2.0',
          id: message.id,
          result: {},
        }),
      };
    },
  });

  const answer = await send({
    headers: { [OWNER_DEVICE_READ_HEADER]: 'legacy' },
  });
  assert.equal(answer.status, 200);
  assert.equal(created.length, 1);
  assert.equal(created[0].apiBase, 'http://localhost:4173');
  assert.equal(created[0].ownerDevice, true);
  assert.equal(typeof created[0].fetchImpl, 'function');
  const forwarded = seenHeaders.find((headers) => headers.host);
  assert.ok(forwarded, 'the in-process request was built');
  for (const name of Object.keys(forwarded))
    assert.doesNotMatch(name, /^x-gev-owner-device/, name);

  // The owner device's server is kept apart from the PC's own.
  await send();
  assert.equal(created.length, 1);

  // A POST without an Origin, a forged token or a proxied request is refused.
  for (const headers of [
    { origin: undefined },
    { [OWNER_DEVICE_HEADER]: 'd'.repeat(64) },
    { 'x-forwarded-for': '203.0.113.9' },
    { host: '100.64.0.1:5173' },
  ]) {
    const refused = await send({ headers });
    assert.equal(refused.status, 403, JSON.stringify(headers));
  }
  assert.equal(
    (await send({ remoteAddress: '192.168.1.20' })).status,
    403,
    'the stamp counts only from a tailnet socket',
  );
  assert.equal(created.length, 1);
});

test("an owner device's tools may read and add, never remove anything stored on the PC", async () => {
  const allowed = (path, method = 'POST') =>
    ownerToolRequestAllowed(new URL(path, 'http://localhost:4173'), {
      method,
    });
  // Reads, and writes that save or add.
  assert.equal(allowed('/api/ultra-help/media', 'GET'), true);
  assert.equal(allowed('/api/private-cams/sources', 'GET'), true);
  assert.equal(allowed('/api/cctv/alignments/cam-1'), true);
  assert.equal(allowed('/api/outbreak/epidemic'), true);
  assert.equal(
    allowed('https://earthquake.usgs.gov/feed.geojson', 'GET'),
    true,
  );
  // Every DELETE, PUT and PATCH, and a POST to a route family that removes.
  for (const [path, method] of [
    ['/api/cctv/alignments/cam-1', 'DELETE'],
    ['/api/road-cctv-keys', 'DELETE'],
    ['/api/social/accounts', 'DELETE'],
    ['/api/anything', 'PUT'],
    ['/api/anything', 'PATCH'],
    ['/api/ultra-help/media/delete', 'POST'],
    ['/api/ultra-help/tokens', 'POST'],
    ['/api/ultra-help/contacts', 'POST'],
    ['/api/ultra-help/number', 'POST'],
    ['/api/ultra-help/inbox', 'POST'],
    ['/api/ultra-help/network', 'POST'],
    ['/api/private-cams/relay/unpair', 'POST'],
    ['/api/private-cams/%72elay/unpair', 'POST'],
    ['/API/Private-Cams/config', 'POST'],
    ['/api/device-feeds/config', 'POST'],
    ['/api/setup/keys', 'POST'],
    ['/api/road-cctv-keys', 'POST'],
    ['/api/social/accounts', 'POST'],
    ['/api/scenes/delete', 'POST'],
    ['/api/cache/clear', 'POST'],
    ['/api/whatever/remove-item', 'POST'],
  ])
    assert.equal(allowed(path, method), false, `${method} ${path}`);

  const passed = [];
  const fetchImpl = ownerToolFetch(async (input, init) => {
    passed.push([String(input), init?.method || 'GET']);
    return new Response('{}', { status: 200 });
  });
  const removal = await fetchImpl(
    new URL('/api/ultra-help/media/delete', 'http://localhost:4173'),
    { method: 'POST', body: '{}' },
  );
  // Refused with no message: the marker header and the exact body.
  assert.equal(removal.status, 403);
  assert.equal(removal.headers.get(OWNER_DEVICE_REMOVAL_HEADER), 'pc-only');
  assert.equal(removal.headers.get('cache-control'), 'no-store');
  const refusal = await removal.text();
  assert.equal(refusal, '{"removal":"pc-only"}');
  assert.equal(Object.hasOwn(JSON.parse(refusal), 'error'), false);
  for (const method of ['DELETE', 'PUT', 'PATCH']) {
    const refused = await fetchImpl(
      new URL('/api/anything', 'http://localhost:4173'),
      { method },
    );
    assert.equal(refused.status, 403, method);
    assert.equal(refused.headers.get('x-gev-removal'), 'pc-only', method);
    assert.deepEqual(await refused.json(), { removal: 'pc-only' }, method);
  }
  const read = await fetchImpl(
    new URL('/api/ultra-help/status', 'http://localhost:4173'),
  );
  assert.equal(read.status, 200);
  assert.deepEqual(passed, [
    ['http://localhost:4173/api/ultra-help/status', 'GET'],
  ]);
});
