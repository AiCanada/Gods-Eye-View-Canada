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

/** A whois Node for one plain device: its own addresses and nothing more. */
function phoneNode(ip, extra = {}) {
  const own = [`${ip}/32`, 'fd7a:115c:a1e0::a/128'];
  return { Addresses: own, AllowedIPs: own, ...extra };
}

test("only devices signed in as this machine's owner get in, and Tailscale's silence is a no", async () => {
  const { createOwnerCheck } =
    await import('../../Mirror of PC GEVC on Cell/tailnet-dashboard.js');
  const asks = [];
  const ask = async (args) => {
    asks.push(args.join(' '));
    if (args[0] === 'status') return { Self: { UserID: 7 } };
    if (args[2] === '100.64.0.10') {
      return { UserProfile: { ID: 7 }, Node: phoneNode('100.64.0.10') };
    }
    if (args[2] === '100.64.0.11') {
      return { UserProfile: { ID: 99 }, Node: phoneNode('100.64.0.11') };
    }
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

test('a relaying owner node (subnet router, exit node) or a node without details is not the owner device', async () => {
  const { createOwnerCheck } =
    await import('../../Mirror of PC GEVC on Cell/tailnet-dashboard.js');
  const nodes = {
    '100.64.0.10': phoneNode('100.64.0.10'),
    '100.64.0.20': phoneNode('100.64.0.20', {
      PrimaryRoutes: ['192.168.1.0/24'],
    }),
    '100.64.0.21': phoneNode('100.64.0.21', {
      AllowedIPs: ['100.64.0.21/32', 'fd7a:115c:a1e0::a/128', '10.0.0.0/8'],
    }),
    '100.64.0.22': phoneNode('100.64.0.22', {
      AllowedIPs: ['100.64.0.22/32', '0.0.0.0/0', '::/0'],
    }),
    '100.64.0.23': undefined,
  };
  const ask = async (args) => {
    if (args[0] === 'status') return { Self: { UserID: 7 } };
    return { UserProfile: { ID: 7 }, Node: nodes[args[2]] };
  };
  const isOwner = createOwnerCheck({ ask });
  assert.equal(await isOwner('100.64.0.10'), true, 'a plain owner device');
  assert.equal(await isOwner('100.64.0.20'), false, 'subnet router');
  assert.equal(await isOwner('100.64.0.21'), false, 'extra allowed prefix');
  assert.equal(await isOwner('100.64.0.22'), false, 'exit node');
  assert.equal(await isOwner('100.64.0.23'), false, 'no node details');
});

test('tagged nodes share one user ID, so neither a tagged PC nor a tagged caller is the owner', async () => {
  const { createOwnerCheck } =
    await import('../../Mirror of PC GEVC on Cell/tailnet-dashboard.js');
  const taggedPc = createOwnerCheck({
    ask: async (args) =>
      args[0] === 'status'
        ? { Self: { UserID: 5, Tags: ['tag:server'] } }
        : { UserProfile: { ID: 5 }, Node: phoneNode('100.64.0.30') },
  });
  assert.equal(await taggedPc('100.64.0.30'), false, 'tagged PC');
  const taggedCaller = createOwnerCheck({
    ask: async (args) =>
      args[0] === 'status'
        ? { Self: { UserID: 5 } }
        : {
            UserProfile: { ID: 5 },
            Node: phoneNode('100.64.0.31', { Tags: ['tag:ci'] }),
          },
  });
  assert.equal(await taggedCaller('100.64.0.31'), false, 'tagged caller');
});

test('the mirror re-exports the core gate tailnet test', async () => {
  const core = await import('../keySetupCore.mjs');
  assert.equal(isTailnetIPv4, core.isTailnetIPv4);
});

const OWNER_AUTHORITY = 'http://100.64.0.1:4173';

/** Runs one request through ownerOnlyHandler; resolves with what happened. */
function runHandler(
  ownerOnlyHandler,
  { owner, token, authority = OWNER_AUTHORITY },
  method,
  url,
  headers = {},
) {
  return new Promise((resolve) => {
    let nextCalls = 0;
    const req = {
      method,
      url,
      headers: { ...headers },
      socket: { remoteAddress: '100.64.0.10' },
    };
    const res = {
      writeHead(status, head) {
        this.status = status;
        this.head = head;
      },
      end(body) {
        resolve({ status: this.status, head: this.head, body, req, nextCalls });
      },
    };
    ownerOnlyHandler({
      isOwnerDevice: async () => owner,
      token,
      authority,
      next: (r) => {
        nextCalls += 1;
        resolve({ status: 'next', req: r, nextCalls });
      },
    })(req, res);
  });
}

test('the tailnet handler refuses strangers and stamps every request from an owner device', async () => {
  const { ownerOnlyHandler } =
    await import('../../Mirror of PC GEVC on Cell/tailnet-dashboard.js');
  const { OWNER_DEVICE_HEADER, OWNER_DEVICE_AUTHORITY_HEADER } =
    await import('../keySetupCore.mjs');
  const token = 'a'.repeat(64);
  const owner = { owner: true, token };
  const run = (...args) => runHandler(ownerOnlyHandler, ...args);

  // A stranger with a forged stamp: the stamp is gone, 403, next never runs.
  const stranger = await run(
    { owner: false, token },
    'POST',
    '/api/setup/keys',
    {
      [OWNER_DEVICE_HEADER]: token,
      [OWNER_DEVICE_AUTHORITY_HEADER]: OWNER_AUTHORITY,
      'x-gev-owner-device-read': token,
    },
  );
  assert.equal(stranger.status, 403);
  assert.equal(stranger.nextCalls, 0);
  assert.equal(stranger.req.headers[OWNER_DEVICE_HEADER], undefined);
  assert.equal(stranger.req.headers[OWNER_DEVICE_AUTHORITY_HEADER], undefined);
  assert.equal(stranger.req.headers['x-gev-owner-device-read'], undefined);
  assert.equal((await run({ owner: false, token }, 'GET', '/')).status, 403);

  // The owner's write: a forged token and a forged authority are overwritten.
  const write = await run(owner, 'POST', '/api/setup/keys', {
    [OWNER_DEVICE_HEADER]: 'f'.repeat(64),
    [OWNER_DEVICE_AUTHORITY_HEADER]: 'http://evil:1',
    'x-gev-owner-device-read': 'f'.repeat(64),
  });
  assert.equal(write.status, 'next');
  assert.equal(write.req.headers[OWNER_DEVICE_HEADER], token);
  assert.equal(
    write.req.headers[OWNER_DEVICE_AUTHORITY_HEADER],
    OWNER_AUTHORITY,
  );
  assert.equal(
    write.req.headers['x-gev-owner-device-read'],
    undefined,
    'the old read-only stamp is stripped',
  );

  // Every method and path is stamped, the page itself included.
  for (const [method, url] of [
    ['GET', '/'],
    ['GET', '/api/setup/status'],
    ['POST', '/api/ultra-help/tokens'],
    ['POST', '/api/ultra-help/release'],
    ['PUT', '/api/anything'],
  ]) {
    const seen = await run(owner, method, url);
    assert.equal(seen.status, 'next', `${method} ${url}`);
    assert.equal(seen.req.headers[OWNER_DEVICE_HEADER], token);
    assert.equal(
      seen.req.headers[OWNER_DEVICE_AUTHORITY_HEADER],
      OWNER_AUTHORITY,
    );
  }

  // A proxied request is passed on unstamped (the gates refuse it further in).
  const proxied = await run(owner, 'GET', '/api/setup/status', {
    'x-forwarded-for': '1.2.3.4',
    [OWNER_DEVICE_HEADER]: token,
    [OWNER_DEVICE_AUTHORITY_HEADER]: OWNER_AUTHORITY,
  });
  assert.equal(proxied.status, 'next');
  assert.equal(proxied.req.headers[OWNER_DEVICE_HEADER], undefined);
  assert.equal(proxied.req.headers[OWNER_DEVICE_AUTHORITY_HEADER], undefined);

  // No token or no authority: nothing is stamped.
  for (const options of [
    { owner: true, token: '' },
    { owner: true, token, authority: '' },
  ]) {
    const bare = await run(options, 'GET', '/api/setup/status');
    assert.equal(bare.status, 'next');
    assert.equal(bare.req.headers[OWNER_DEVICE_HEADER], undefined);
    assert.equal(bare.req.headers[OWNER_DEVICE_AUTHORITY_HEADER], undefined);
  }
});

test('the owner device never removes anything stored on the PC through the mirror', async () => {
  const { ownerOnlyHandler, ownerRemovalRequest } =
    await import('../../Mirror of PC GEVC on Cell/tailnet-dashboard.js');
  const core = await import('../keySetupCore.mjs');
  assert.equal(core.OWNER_DEVICE_REMOVAL_ERROR, undefined);
  const token = 'a'.repeat(64);
  const run = (...args) => runHandler(ownerOnlyHandler, ...args);

  for (const [method, url] of [
    ['DELETE', '/api/road-cctv-keys'],
    ['DELETE', '/api/social/accounts'],
    ['DELETE', '/api/cctv/alignments/cam-1'],
    ['DELETE', '/api/anything/else'],
    ['DELETE', '/api/cctv/media/cam-1'],
    ['delete', '/api/road-cctv-keys'],
    ['POST', '/api/ultra-help/media/delete'],
    ['POST', '/API/Ultra-Help/media/delete/'],
    ['POST', '/api/ultra-help/media/delete?all=1'],
    ['POST', '//api/ultra-help//media/delete'],
    ['POST', '/api/private-cams/relay/unpair'],
  ]) {
    assert.equal(ownerRemovalRequest(method, url), true, `${method} ${url}`);
    const refused = await run({ owner: true, token }, method, url, {
      'content-type': 'application/json',
    });
    assert.equal(refused.status, 403, `${method} ${url}`);
    assert.equal(refused.nextCalls, 0, `${method} ${url} never reaches the PC`);
    assert.match(refused.head['Content-Type'], /^application\/json/);
    assert.equal(refused.head['Cache-Control'], 'no-store');
    // No message (owner ruling 2026-10-11): only the marker and the body.
    assert.equal(refused.head['x-gev-removal'], 'pc-only');
    assert.equal(refused.body, '{"removal":"pc-only"}');
    assert.deepEqual(JSON.parse(refused.body), { removal: 'pc-only' });
    assert.equal(Object.hasOwn(JSON.parse(refused.body), 'error'), false);
  }

  // Adding, editing, minting, SEND HELP, STAND DOWN and every read go through.
  for (const [method, url] of [
    ['GET', '/api/ultra-help/media'],
    ['POST', '/api/ultra-help/tokens'],
    ['POST', '/api/ultra-help/release'],
    ['POST', '/api/road-cctv-keys'],
    ['POST', '/api/social/accounts'],
    ['POST', '/api/private-cams/relay/approve'],
    ['POST', '/api/private-cams/position'],
    ['POST', '/api/cctv/alignments/cam-1'],
    // A live-stream lease release frees only the viewer's stream session.
    [
      'DELETE',
      '/api/cctv/media/cam-1?lease=0f0e0d0c-0b0a-0908-0706-050403020100',
    ],
  ]) {
    assert.equal(ownerRemovalRequest(method, url), false, `${method} ${url}`);
    assert.equal(
      (await run({ owner: true, token }, method, url)).status,
      'next',
      `${method} ${url}`,
    );
  }

  // A stranger still gets the stranger's refusal, not the owner's message.
  const stranger = await run(
    { owner: false, token },
    'DELETE',
    '/api/road-cctv-keys',
  );
  assert.equal(stranger.status, 403);
  assert.doesNotMatch(String(stranger.body), /Removing is done on the PC/);
  assert.doesNotMatch(String(stranger.body), /pc-only/);
  assert.equal(stranger.head['x-gev-removal'], undefined);
});

test('the plugin stamps its own authority, strips upgrades and drops strangers', async () => {
  const {
    OWNER_DEVICE_HEADER,
    OWNER_DEVICE_AUTHORITY_HEADER,
    admitKeySetupRequest,
  } = await import('../keySetupCore.mjs');
  const { server, main } = fakeDevServer();
  const upgrades = [];
  main.on('upgrade', (req) => upgrades.push(req));
  let handler = null;
  let mirror = null;
  const plugin = tailnetDashboardPlugin({
    env: { GEV_TAILNET_DASHBOARD: '1' },
    interfaces: () => ({
      ts: [{ family: 'IPv4', address: '100.64.0.1', internal: false }],
    }),
    ownerCheck: async (address) =>
      String(address).replace(/^::ffff:/, '') === '100.64.0.10',
    createServer: (h) => {
      handler = h;
      mirror = new EventEmitter();
      mirror.listen = () => {};
      mirror.close = () => {};
      return mirror;
    },
  });
  const log = console.log;
  console.log = () => {};
  try {
    plugin.configureServer(server);
    main.emit('listening');
    const stamped = await new Promise((resolve) => {
      server.middlewares = (req) => resolve(req);
      handler(
        {
          method: 'GET',
          url: '/api/setup/status',
          headers: { host: '100.64.0.1:4173' },
          socket: { remoteAddress: '100.64.0.10' },
        },
        { writeHead() {}, end() {} },
      );
    });
    assert.match(stamped.headers[OWNER_DEVICE_HEADER], /^[0-9a-f]{64}$/);
    assert.equal(
      stamped.headers[OWNER_DEVICE_AUTHORITY_HEADER],
      OWNER_AUTHORITY,
    );
    assert.equal(
      admitKeySetupRequest({
        method: 'GET',
        remoteAddress: '100.64.0.10',
        hostHeader: '100.64.0.1:4173',
        proxyHeaders: stamped.headers,
      }).ownerDevice,
      true,
      'the core gate accepts what the mirror stamped',
    );

    // Upgrade from the owner: forged stamps are stripped, then handed on.
    const forged = {
      [OWNER_DEVICE_HEADER]: 'f'.repeat(64),
      [OWNER_DEVICE_AUTHORITY_HEADER]: 'http://evil:1',
      'x-gev-owner-device-read': 'f'.repeat(64),
    };
    let ownerDestroyed = false;
    mirror.emit(
      'upgrade',
      { headers: { ...forged }, socket: { remoteAddress: '100.64.0.10' } },
      { destroy: () => (ownerDestroyed = true) },
      null,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(ownerDestroyed, false);
    assert.equal(upgrades.length, 1);
    assert.equal(upgrades[0].headers[OWNER_DEVICE_HEADER], undefined);
    assert.equal(upgrades[0].headers[OWNER_DEVICE_AUTHORITY_HEADER], undefined);
    assert.equal(upgrades[0].headers['x-gev-owner-device-read'], undefined);

    // Upgrade from a stranger: stripped and the socket destroyed.
    const strangerUpgrade = {
      headers: { ...forged },
      socket: { remoteAddress: '100.64.0.11' },
    };
    let strangerDestroyed = false;
    mirror.emit(
      'upgrade',
      strangerUpgrade,
      { destroy: () => (strangerDestroyed = true) },
      null,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(strangerDestroyed, true);
    assert.equal(upgrades.length, 1, 'never handed to the dev server');
    assert.equal(strangerUpgrade.headers[OWNER_DEVICE_HEADER], undefined);
  } finally {
    console.log = log;
    main.emit('close');
  }
  assert.equal(
    admitKeySetupRequest({
      method: 'GET',
      remoteAddress: '100.64.0.10',
      hostHeader: '100.64.0.1:4173',
      proxyHeaders: {
        [OWNER_DEVICE_HEADER]: 'a'.repeat(64),
        [OWNER_DEVICE_AUTHORITY_HEADER]: OWNER_AUTHORITY,
      },
    }).ok,
    false,
    'closing the dev server clears the token',
  );
});

test('the core gate admits the stamped owner device: reads and writes, never removals', async () => {
  const {
    OWNER_DEVICE_HEADER,
    OWNER_DEVICE_AUTHORITY_HEADER,
    admitKeySetupRequest,
    setOwnerDeviceToken,
  } = await import('../keySetupCore.mjs');
  const token = 'a'.repeat(64);
  const stamp = {
    [OWNER_DEVICE_HEADER]: token,
    [OWNER_DEVICE_AUTHORITY_HEADER]: OWNER_AUTHORITY,
  };
  const base = {
    remoteAddress: '100.64.0.10',
    hostHeader: '100.64.0.1:4173',
    proxyHeaders: stamp,
  };
  const json = 'application/json';
  const gate = (extra) => admitKeySetupRequest({ ...base, ...extra });
  setOwnerDeviceToken(token);
  try {
    assert.deepEqual(gate({ method: 'GET' }), { ok: true, ownerDevice: true });
    assert.deepEqual(
      gate({ method: 'POST', origin: OWNER_AUTHORITY, contentType: json }),
      { ok: true, ownerDevice: true },
    );
    assert.equal(
      gate({ method: 'PUT', origin: OWNER_AUTHORITY, contentType: json }).ok,
      true,
    );
    assert.equal(gate({ method: 'POST', contentType: json }).status, 403);
    assert.equal(
      gate({
        method: 'POST',
        origin: 'https://evil.example',
        contentType: json,
      }).status,
      403,
    );
    assert.equal(
      gate({
        method: 'POST',
        origin: OWNER_AUTHORITY,
        contentType: 'text/plain',
      }).status,
      415,
    );

    // Every DELETE is refused, with or without Origin, body or JSON.
    for (const extra of [
      {},
      { origin: OWNER_AUTHORITY },
      { origin: OWNER_AUTHORITY, contentType: json },
      {
        origin: OWNER_AUTHORITY,
        proxyHeaders: { ...stamp, 'content-length': '12' },
      },
    ]) {
      assert.deepEqual(gate({ method: 'DELETE', ...extra }), {
        ok: false,
        status: 403,
        removal: true,
      });
    }

    assert.equal(
      gate({ method: 'GET', hostHeader: 'evil.example:4173' }).status,
      403,
      'a DNS-rebinding Host',
    );
    assert.equal(
      gate({
        method: 'GET',
        proxyHeaders: {
          ...stamp,
          [OWNER_DEVICE_AUTHORITY_HEADER]: 'http://100.64.0.1:5173',
        },
      }).status,
      403,
      'an authority for another port',
    );
    const lan = gate({ method: 'GET', remoteAddress: '192.168.1.20' });
    assert.equal(lan.status, 403);
    assert.match(lan.error, /answers only the machine running the server/);
    assert.equal(
      gate({ method: 'GET', remoteAddress: '127.0.0.1' }).status,
      403,
      'a stamp on the loopback listener means nothing; the Host is not local',
    );
    for (const proxyHeaders of [
      { ...stamp, [OWNER_DEVICE_HEADER]: 'b'.repeat(64) },
      {},
      { [OWNER_DEVICE_HEADER]: token },
    ]) {
      assert.equal(gate({ method: 'GET', proxyHeaders }).ok, false);
    }
    const proxied = gate({
      method: 'GET',
      proxyHeaders: { ...stamp, 'x-forwarded-for': '1.2.3.4' },
    });
    assert.equal(proxied.status, 403);
    assert.match(proxied.error, /proxied/);
    const sharing = gate({
      method: 'GET',
      env: { PINOKIO_SHARE_CLOUDFLARE: '1' },
    });
    assert.equal(sharing.status, 403);
    assert.match(sharing.error, /sharing/);
  } finally {
    setOwnerDeviceToken('');
  }
  assert.equal(
    gate({ method: 'GET' }).ok,
    false,
    'no token set: the stamp means nothing',
  );

  // The PC itself is unchanged: it may still remove.
  assert.deepEqual(
    admitKeySetupRequest({
      method: 'DELETE',
      remoteAddress: '127.0.0.1',
      hostHeader: '127.0.0.1:4173',
      origin: 'http://127.0.0.1:4173',
      contentType: json,
    }),
    { ok: true, ownerDevice: false },
  );
});
