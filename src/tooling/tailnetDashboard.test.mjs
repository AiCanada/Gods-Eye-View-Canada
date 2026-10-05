import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  isTailnetIPv4,
  tailnetAddress,
  tailnetDashboardEnabled,
  tailnetDashboardPlugin,
} from '../../Mirror of PC GEVC on Cell/tailnet-dashboard.js';

test('only a 100.64.0.0/10 address counts as the tailnet', () => {
  assert.equal(isTailnetIPv4('100.64.0.1'), true);
  assert.equal(isTailnetIPv4('100.127.255.254'), true);
  assert.equal(isTailnetIPv4('100.63.0.1'), false);
  assert.equal(isTailnetIPv4('100.128.0.1'), false);
  assert.equal(isTailnetIPv4('192.168.1.20'), false);
  assert.equal(isTailnetIPv4('127.0.0.1'), false);
  assert.equal(isTailnetIPv4('not an address'), false);
  assert.equal(
    tailnetAddress({
      wifi: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
      Tailscale: [
        { family: 'IPv6', address: 'fd7a:115c:a1e0::1', internal: false },
        { family: 'IPv4', address: '100.101.102.103', internal: false },
      ],
    }),
    '100.101.102.103',
  );
  assert.equal(
    tailnetAddress({ wifi: [{ family: 'IPv4', address: '192.168.1.20' }] }),
    '',
  );
});

test('the tailnet dashboard is off unless the setting is on', () => {
  assert.equal(tailnetDashboardEnabled({}), false);
  assert.equal(tailnetDashboardEnabled({ GEV_TAILNET_DASHBOARD: '0' }), false);
  assert.equal(tailnetDashboardEnabled({ GEV_TAILNET_DASHBOARD: '1' }), true);
  assert.equal(tailnetDashboardEnabled({ GEV_TAILNET_DASHBOARD: 'on' }), true);
});

function fakeDevServer() {
  const main = new EventEmitter();
  main.address = () => ({ port: 4173 });
  const middlewares = () => {};
  middlewares.use = () => {};
  return { server: { httpServer: main, middlewares }, main, middlewares };
}

test('it listens on the tailnet address only', () => {
  const { server, main, middlewares } = fakeDevServer();
  const made = [];
  const plugin = tailnetDashboardPlugin({
    env: { GEV_TAILNET_DASHBOARD: '1' },
    interfaces: () => ({
      wifi: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
      ts: [{ family: 'IPv4', address: '100.101.102.103', internal: false }],
    }),
    createServer: (handler) => {
      const mirror = new EventEmitter();
      mirror.listen = (port, host) => made.push({ port, host });
      mirror.close = () => made.push('closed');
      return mirror;
    },
  });
  plugin.configureServer(server);
  main.emit('listening');
  assert.deepEqual(made, [{ port: 4173, host: '100.101.102.103' }]);
  main.emit('close');
  assert.equal(made.at(-1), 'closed');
});

test('off, or with no tailnet address, it opens nothing', () => {
  for (const options of [
    {
      env: {},
      interfaces: () => ({
        ts: [{ family: 'IPv4', address: '100.101.102.103' }],
      }),
    },
    { env: { GEV_TAILNET_DASHBOARD: '1' }, interfaces: () => ({}) },
  ]) {
    const { server, main } = fakeDevServer();
    let opened = false;
    const plugin = tailnetDashboardPlugin({
      ...options,
      createServer: () => {
        opened = true;
        return new EventEmitter();
      },
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      plugin.configureServer(server);
      main.emit('listening');
    } finally {
      console.warn = warn;
      main.emit('close');
    }
    assert.equal(opened, false);
  }
});

test('it starts by itself once Tailscale connects, with no restart', async () => {
  const { server, main } = fakeDevServer();
  let up = false;
  const listened = [];
  const plugin = tailnetDashboardPlugin({
    env: { GEV_TAILNET_DASHBOARD: '1' },
    retryMs: 5,
    interfaces: () =>
      up
        ? {
            ts: [
              { family: 'IPv4', address: '100.101.102.103', internal: false },
            ],
          }
        : {},
    createServer: () => {
      const mirror = new EventEmitter();
      mirror.listen = (port, host) => listened.push(host);
      mirror.close = () => {};
      return mirror;
    },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    plugin.configureServer(server);
    main.emit('listening');
    assert.deepEqual(listened, [], 'Tailscale off: nothing yet');
    up = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(listened, ['100.101.102.103']);
  } finally {
    console.warn = warn;
    main.emit('close');
  }
});

test("only devices signed in as this machine's owner get in, and Tailscale's silence is a no", async () => {
  const { createOwnerCheck } =
    await import('../../Mirror of PC GEVC on Cell/tailnet-dashboard.js');
  const asks = [];
  const ask = async (args) => {
    asks.push(args.join(' '));
    if (args[0] === 'status') return { Self: { UserID: 7 } };
    if (args[2] === '100.64.0.10') return { UserProfile: { ID: 7 } };
    if (args[2] === '100.64.0.11') return { UserProfile: { ID: 99 } };
    return null;
  };
  const isOwner = createOwnerCheck({ ask });
  assert.equal(await isOwner('100.64.0.10'), true, 'my own phone');
  assert.equal(await isOwner('::ffff:100.64.0.10'), true, 'as a mapped IPv4');
  assert.equal(
    await isOwner('100.64.0.11'),
    false,
    "someone else's shared device",
  );
  assert.equal(
    await isOwner('100.64.0.12'),
    false,
    'Tailscale does not know it',
  );
  assert.equal(await isOwner('192.168.1.20'), false, 'not the tailnet');
  assert.equal(
    asks.filter((a) => a.includes('100.64.0.10')).length,
    1,
    'answers are kept',
  );
});

test("the tailnet handler refuses strangers and stamps only an owner's status read", async () => {
  const { ownerOnlyHandler, ownerReadRoute } =
    await import('../../Mirror of PC GEVC on Cell/tailnet-dashboard.js');
  const {
    OWNER_DEVICE_READ_HEADER,
    admitKeySetupRequest,
    setOwnerDeviceReadToken,
  } = await import('../keySetupCore.mjs');
  assert.equal(ownerReadRoute('GET', '/api/setup/status'), true);
  assert.equal(ownerReadRoute('GET', '/api/social/accounts?x=1'), true);
  assert.equal(ownerReadRoute('POST', '/api/setup/status'), false);
  assert.equal(ownerReadRoute('GET', '/api/setup/keys'), false);
  assert.equal(
    ownerReadRoute('GET', '/api/private-cams/frame/private-home--front'),
    true,
  );
  assert.equal(ownerReadRoute('GET', '/api/private-cams/frame/'), false);
  assert.equal(
    ownerReadRoute('GET', '/api/private-cams/frame/../config'),
    false,
  );
  assert.equal(ownerReadRoute('GET', '/api/road-cctv-keys?sites=1'), true);
  assert.equal(ownerReadRoute('GET', '/api/private-cams/config'), false);
  const token = 'a'.repeat(64);
  const run = (owner, method, url, headers = {}) =>
    new Promise((resolve) => {
      const req = {
        method,
        url,
        headers: { ...headers },
        socket: { remoteAddress: '100.64.0.10' },
      };
      const res = {
        writeHead(status) {
          this.status = status;
        },
        end() {
          resolve({ status: this.status, req });
        },
      };
      ownerOnlyHandler({
        isOwnerDevice: async () => owner,
        token,
        next: (r) => resolve({ status: 'next', req: r }),
      })(req, res);
    });
  assert.equal((await run(false, 'GET', '/')).status, 403);
  const read = await run(true, 'GET', '/api/setup/status');
  assert.equal(read.status, 'next');
  assert.equal(read.req.headers[OWNER_DEVICE_READ_HEADER], token);
  const write = await run(true, 'POST', '/api/setup/status', {
    [OWNER_DEVICE_READ_HEADER]: token,
  });
  assert.equal(
    write.req.headers[OWNER_DEVICE_READ_HEADER],
    undefined,
    'a forged stamp is removed',
  );
  const page = await run(true, 'GET', '/');
  assert.equal(page.req.headers[OWNER_DEVICE_READ_HEADER], undefined);

  // The gate admits the stamped read, and nothing else from the tailnet.
  const from = { remoteAddress: '100.64.0.10', hostHeader: '100.64.0.1:4173' };
  setOwnerDeviceReadToken(token);
  try {
    assert.equal(
      admitKeySetupRequest({
        ...from,
        method: 'GET',
        proxyHeaders: { [OWNER_DEVICE_READ_HEADER]: token },
      }).ok,
      true,
    );
    assert.equal(
      admitKeySetupRequest({
        ...from,
        method: 'POST',
        proxyHeaders: { [OWNER_DEVICE_READ_HEADER]: token },
      }).ok,
      false,
    );
    assert.equal(
      admitKeySetupRequest({
        ...from,
        method: 'GET',
        proxyHeaders: { [OWNER_DEVICE_READ_HEADER]: 'b'.repeat(64) },
      }).ok,
      false,
    );
    assert.equal(
      admitKeySetupRequest({ ...from, method: 'GET', proxyHeaders: {} }).ok,
      false,
    );
  } finally {
    setOwnerDeviceReadToken('');
  }
  assert.equal(
    admitKeySetupRequest({
      ...from,
      method: 'GET',
      proxyHeaders: { [OWNER_DEVICE_READ_HEADER]: token },
    }).ok,
    false,
    'no token set: the stamp means nothing',
  );
});
