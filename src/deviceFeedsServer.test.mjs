import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { DEVICE_FEED_STORE } from './deviceFeedsCore.mjs';
import { ULTRA_TOKEN_PATTERN, newUltraToken, sealUltraToken, ultraTokenId } from './ultraTokens.mjs';
import { deviceFeedsProxy, fetchDeviceResource, isDeviceFeedStoreRequest } from '../server/providers/device-feeds.js';

const PAGE_ORIGIN = 'http://localhost:4173';
const pageHeaders = (extra = {}) => ({ origin: PAGE_ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...extra });
const answer = (status, headers = {}, body = '') => new Response(body, { status, headers });
const jsonAnswer = (value) => answer(200, { 'content-type': 'application/json' }, JSON.stringify(value));

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-device-feeds-'));
  fs.mkdirSync(path.join(root, 'config'));
  return root;
}

/** Drive the plugin's API middleware the way connect would. */
function harness(plugin, hook = 'configureServer') {
  const uses = [];
  plugin[hook]({ middlewares: { use: (...args) => uses.push(args) } });
  const handler = uses.find((args) => args[0] === '/api/device-feeds')[1];
  const request = (url, { method = 'GET', headers = {}, remoteAddress = '127.0.0.1', body } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const req = new EventEmitter();
      Object.assign(req, { url, method, headers: { host: 'localhost:4173', ...headers }, socket: { remoteAddress } });
      req.destroy = () => {};
      let fed = false;
      req.on('newListener', (event) => {
        if (event !== 'data' || fed) return;
        fed = true;
        setImmediate(() => {
          if (payload) req.emit('data', payload);
          req.emit('end');
        });
      });
      const res = {
        headersSent: false,
        writeHead(status, responseHeaders = {}) {
          Object.assign(this, { status, headers: responseHeaders, headersSent: true });
        },
        end(chunk) {
          const bytes = chunk === undefined ? Buffer.alloc(0) : Buffer.from(chunk);
          resolve({ status: this.status, headers: this.headers || {}, bytes, json: () => JSON.parse(bytes.toString('utf8')) });
        },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
  return { request, uses };
}

test('both server hooks install the store guard first, then the routes', () => {
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const { uses } = harness(deviceFeedsProxy({ sourceRoot: tempRoot() }), hook);
    assert.equal(uses.length, 2, hook);
    assert.equal(typeof uses[0][0], 'function', `${hook}: the guard is mounted on every path`);
    assert.equal(uses[1][0], '/api/device-feeds');
  }
});

test('the store is never served as a file', () => {
  const root = tempRoot();
  for (const url of ['/config/device-feeds.json', '/config/DEVICE-FEEDS.JSON?raw', '/config/device%2Dfeeds.json', '/@fs/x/config/device-feeds.json', '/config/.device-feeds.json.123.tmp', '/config/local-integrity.json', '/config/LOCAL-INTEGRITY.KEY', '/config/.local-integrity.json.ab12cd34.tmp', '/config/local-integrity.key::$DATA', '/config/social-accounts.json', '/config/social-accounts.key', '/config/SOCIAL-ACCOUNTS.KEY', '/config/.social-accounts.json.ab12cd34.tmp']) {
    assert.equal(isDeviceFeedStoreRequest(url, { sourceRoot: root }), true, url);
  }
  assert.equal(isDeviceFeedStoreRequest('/config/cctv_thumbnail_alignments.json', { sourceRoot: root }), false);
  assert.equal(isDeviceFeedStoreRequest('/config/DEVICE~1.JSO', { sourceRoot: root, realpath: () => path.join(root, 'config', 'device-feeds.json') }), true, 'a Windows short name');

  const { uses } = harness(deviceFeedsProxy({ sourceRoot: root }));
  let status = 0;
  let passed = false;
  uses[0][0]({ url: '/config/device-feeds.json' }, { writeHead: (code) => { status = code; }, end() {} }, () => { passed = true; });
  assert.deepEqual([status, passed], [404, false]);
  uses[0][0]({ url: '/index.html' }, {}, () => { passed = true; });
  assert.equal(passed, true);
});

test('only this machine, only this page', async () => {
  const { request } = harness(deviceFeedsProxy({ sourceRoot: tempRoot(), fetchImpl: async () => jsonAnswer({}) }));
  assert.equal((await request('/status', { remoteAddress: '192.168.1.20' })).status, 403, 'a LAN peer');
  assert.equal((await request('/status', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'another website');
  assert.equal((await request('/positions', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await request('/status', { headers: { host: 'evil.example' } })).status, 403, 'a rebound host name');
  assert.equal((await request('/config', { method: 'POST', headers: pageHeaders({ origin: 'https://evil.example' }), body: {} })).status, 403, 'a foreign origin');
  assert.equal((await request('/config', { method: 'POST', headers: pageHeaders({ 'content-type': 'text/plain' }), body: '{}' })).status, 415, 'a form-style post');
  assert.equal((await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await request('/nowhere', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 404);
});

test('save, status, positions, remove: and never a secret back', async () => {
  const root = tempRoot();
  const asked = [];
  const fetchImpl = async (url, options) => {
    asked.push({ url, headers: options.headers, redirect: options.redirect });
    return jsonAnswer([{ latitude: 45.27, longitude: -66.06, speed: 10, course: 90 }]);
  };
  const { request } = harness(deviceFeedsProxy({ sourceRoot: root, fetchImpl }));
  const bad = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'tracker', name: 'Van', method: 'mqtt', url: 'https://gps.example.com/' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json().error, /needs a bridge/);
  assert.equal((await request('/config', { method: 'POST', headers: pageHeaders(), body: '{not json' })).status, 400);

  const saved = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'tracker', name: 'Van', method: 'traccar', url: 'https://gps.example.com/', auth: 'bearer', token: 'TOPSECRET' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json().feedId, 'tracker-van');
  assert.ok(!saved.bytes.toString().includes('TOPSECRET'));
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, DEVICE_FEED_STORE), 'utf8'));
  assert.equal(onDisk.feeds[0].token, 'TOPSECRET');
  assert.equal(fs.existsSync(path.join(root, 'config', 'ultra-outbound.json')), false);

  const positions = await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(positions.status, 200);
  const [device] = positions.json().devices;
  assert.deepEqual([device.id, device.lat, device.lon, device.live, device.kind], ['device-tracker-van', 45.27, -66.06, true, 'tracker']);
  assert.ok(!positions.bytes.toString().match(/TOPSECRET|gps\.example/));
  assert.deepEqual([asked[0].url, asked[0].headers.Authorization, asked[0].redirect], ['https://gps.example.com/api/positions', 'Bearer TOPSECRET', 'manual']);

  // Asked again at once, the device is not: its answer is held for the poll floor.
  await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(asked.length, 1);

  const status = (await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  const feed = status.kinds.find((kind) => kind.id === 'tracker').feeds[0];
  assert.deepEqual([status.editable, feed.tokenSet, feed.state?.ok], [true, true, true]);

  const removed = await request('/config', { method: 'POST', headers: pageHeaders(), body: { removeFeedId: 'tracker-van' } });
  assert.equal(removed.status, 200);
  assert.deepEqual((await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json().devices, []);
});

test('preview serves positions but never edits', async () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, DEVICE_FEED_STORE), JSON.stringify({ version: 1, feeds: [{ id: 'robot-dock', kind: 'robot', name: 'Dock', method: 'snapshot', pictureUrl: 'https://r.example/snap.jpg', lat: 45, lon: -66 }] }));
  const { request } = harness(deviceFeedsProxy({ sourceRoot: root, fetchImpl: async () => answer(200, { 'content-type': 'image/jpeg' }, 'JPEG') }), 'configurePreviewServer');
  assert.equal((await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).json().editable, false);
  assert.equal((await request('/config', { method: 'POST', headers: pageHeaders(), body: { removeFeedId: 'robot-dock' } })).status, 403);
  const [device] = (await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json().devices;
  assert.deepEqual([device.lat, device.lon, device.fixed, device.pictureUrl], [45, -66, true, '/api/device-feeds/frame/device-robot-dock']);
  const frame = await request('/frame/device-robot-dock', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.deepEqual([frame.status, frame.headers['Content-Type'], frame.bytes.toString()], [200, 'image/jpeg', 'JPEG']);
  assert.equal((await request('/frame/device-nope', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 404);
  assert.equal(fs.existsSync(path.join(root, 'config', 'local-integrity.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'config', 'local-integrity.key')), false);
});

test('a picture that is not a picture is refused, and a motion-JPEG gives its first frame', async () => {
  const root = tempRoot();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('frame-one'), Buffer.from([0xff, 0xd9])]);
  const stream = Buffer.concat([Buffer.from('--b\r\nContent-Type: image/jpeg\r\n\r\n'), jpeg, Buffer.from('\r\n--b\r\nContent-Type: image/jpeg\r\n\r\n')]);
  fs.writeFileSync(path.join(root, DEVICE_FEED_STORE), JSON.stringify({ version: 1, feeds: [
    { id: 'robot-html', kind: 'robot', name: 'Html', method: 'snapshot', pictureUrl: 'https://r.example/page', lat: 1, lon: 1 },
    { id: 'robot-mjpeg', kind: 'robot', name: 'Mjpeg', method: 'snapshot', pictureUrl: 'https://r.example/stream', lat: 1, lon: 1 },
  ] }));
  const fetchImpl = async (url) => (url.endsWith('/page')
    ? answer(200, { 'content-type': 'text/html' }, '<html>')
    : answer(200, { 'content-type': 'multipart/x-mixed-replace; boundary=b' }, stream));
  const { request } = harness(deviceFeedsProxy({ sourceRoot: root, fetchImpl }));
  assert.equal((await request('/frame/device-robot-html', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 502);
  const frame = await request('/frame/device-robot-mjpeg', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(frame.status, 200);
  assert.deepEqual(frame.bytes, jpeg);
});

test('an unreadable store is never overwritten by a save', async () => {
  const root = tempRoot();
  const file = path.join(root, DEVICE_FEED_STORE);
  fs.writeFileSync(file, '{ this is not json');
  const { request } = harness(deviceFeedsProxy({ sourceRoot: root }));
  const result = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'tracker', name: 'Van', method: 'http-json', url: 'https://g.example/' } });
  assert.equal(result.status, 500);
  assert.match(result.json().error, /^Not saved/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json');
});

test('a damaged store is reported without quoting it: a password around the fault stays out of the log', async () => {
  const root = tempRoot();
  // The fault sits right after a password, where the parser's message would quote it.
  fs.writeFileSync(path.join(root, DEVICE_FEED_STORE), '{"version":1,"feeds":[{"password": hunter2sec, "reportKey": "k"}]}');
  const logged = [];
  const warn = console.warn;
  console.warn = (...args) => logged.push(args.map(String).join(' '));
  try {
    const { request } = harness(deviceFeedsProxy({ sourceRoot: root, listen: false }));
    assert.equal((await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
  } finally {
    console.warn = warn;
  }
  const said = logged.filter((line) => line.includes(DEVICE_FEED_STORE));
  assert.equal(said.length, 1, logged.join('\n'));
  assert.match(said[0], /could not be read \(not valid JSON\)/);
  assert.equal(said[0].includes('hunter2'), false, said[0]);
});

test('a password answers a challenge only; a redirect is never followed', async () => {
  const calls = [];
  const challenge = async (_url, options) => {
    calls.push(options.headers.Authorization || '');
    return calls.length === 1 ? answer(401, { 'www-authenticate': 'Digest realm="d", nonce="n", qop="auth"' }) : jsonAnswer({ lat: 1, lon: 2 });
  };
  const ok = await fetchDeviceResource({ auth: 'basic', username: 'u', password: 'p' }, 'https://d.example/pos?x=1', { fetchImpl: challenge });
  assert.equal(ok.status, 200);
  assert.equal(calls[0], '');
  assert.match(calls[1], /^Digest .*uri="\/pos\?x=1"/);

  const basicCalls = [];
  await fetchDeviceResource({ auth: 'basic', username: 'u', password: 'p' }, 'https://d.example/', {
    fetchImpl: async (_url, options) => {
      basicCalls.push(options.headers.Authorization || '');
      return basicCalls.length === 1 ? answer(401, { 'www-authenticate': 'Basic realm="d"' }) : jsonAnswer({});
    },
  });
  assert.equal(basicCalls[1], `Basic ${Buffer.from('u:p').toString('base64')}`);

  const root = tempRoot();
  fs.writeFileSync(path.join(root, DEVICE_FEED_STORE), JSON.stringify({ version: 1, feeds: [{ id: 'drone-a', kind: 'drone', name: 'A', method: 'http-json', url: 'https://d.example/pos', auth: 'bearer', token: 't' }] }));
  const hops = [];
  const { request } = harness(deviceFeedsProxy({ sourceRoot: root, fetchImpl: async (url, options) => { hops.push([url, options.redirect]); return answer(302, { location: 'https://elsewhere.example/' }); } }));
  const positions = (await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  assert.deepEqual(positions.devices, [], 'no position, no fixed place');
  assert.deepEqual(hops, [['https://d.example/pos', 'manual']]);
  const status = (await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  assert.match(status.kinds[0].feeds[0].state.error, /redirect refused/);
});

test('a phone reports in by its key alone; the map and the recorder see where it is', async () => {
  const root = tempRoot();
  const { request } = harness(deviceFeedsProxy({ sourceRoot: root, listen: false }));
  const saved = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'security', name: 'Samsung', method: 'report-in', follow: true, record: true } });
  assert.equal(saved.status, 200, saved.bytes.toString());
  const status = saved.json().status;
  const feed = status.kinds.find((kind) => kind.id === 'security').feeds[0];
  assert.match(feed.reportKey, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(status.reportListener, { port: null, wanted: false, error: '' }, 'no listener in this test');

  // Before any report: known, not placed.
  let positions = (await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  assert.deepEqual(positions.devices, [], 'nothing to place yet');

  // From the phone (not loopback, no page origin): a wrong key is not found, the right one is taken.
  const phone = { remoteAddress: '10.66.0.2', headers: { host: '10.66.0.1:44173' } };
  const wrong = await request(`/report/${'x'.repeat(43)}?lat=45&lon=-66`, phone);
  assert.equal(wrong.status, 404);
  assert.equal((await request('/report/short?lat=45&lon=-66', phone)).status, 404);
  const taken = await request(`/report/${feed.reportKey}?id=123&lat=45.27&lon=-66.06&timestamp=1700000000&speed=10&bearing=90`, phone);
  assert.deepEqual([taken.status, taken.bytes.toString()], [200, 'OK']);
  // Traccar Client's own shape: the key as the device identifier, POST with an empty body.
  const asId = await request(`/report?id=${feed.reportKey}&lat=45.28&lon=-66.07&timestamp=1700000010`, { ...phone, method: 'POST', body: '' });
  assert.equal(asId.status, 200);
  // A buffered fix older than the newest does not move the device back.
  const stale = await request(`/report/${feed.reportKey}?lat=40&lon=-70&timestamp=1600000000`, phone);
  assert.equal(stale.status, 200);
  // OwnTracks JSON gets the answer its app expects.
  const own = await request(`/report/${feed.reportKey}`, { ...phone, method: 'POST', headers: { ...phone.headers, 'content-type': 'application/json' }, body: { _type: 'lwt' } });
  assert.equal(own.status, 400);

  positions = (await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  const [device] = positions.devices;
  assert.deepEqual([device.id, device.lat, device.lon, device.live, device.follow, device.headingDeg], ['device-security-samsung', 45.28, -66.07, true, true, null]);
  assert.ok(!positions.devices[0].error);
  const shown = (await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).json().kinds.find((kind) => kind.id === 'security').feeds[0];
  assert.deepEqual([shown.state.ok, shown.transport], [true, 'reports-in']);

  // The recorder is checked against the reported position, not the page's claim.
  const record = await request('/record/device-security-samsung', { method: 'POST', headers: pageHeaders(), body: { center: { lat: 45.28, lon: -66.07 }, items: [] } });
  assert.equal(record.status, 200, record.bytes.toString());

  // The newest report survives a restart.
  const again = harness(deviceFeedsProxy({ sourceRoot: root, listen: false }));
  const recalled = (await again.request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json().devices[0];
  assert.deepEqual([recalled.lat, recalled.lon, recalled.live], [45.28, -66.07, true]);

  // A new key retires the old one at once.
  const minted = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'security', id: 'security-samsung', name: 'Samsung', method: 'report-in', newReportKey: true } });
  const newKey = minted.json().status.kinds.find((kind) => kind.id === 'security').feeds[0].reportKey;
  assert.notEqual(newKey, feed.reportKey);
  assert.equal((await request(`/report/${feed.reportKey}?lat=45&lon=-66`, phone)).status, 404);
  assert.equal((await request(`/report/${newKey}?lat=45&lon=-66`, phone)).status, 200);
});

test('the report listener opens with the first reporting device, serves that route only, and closes with the server', async () => {
  const root = tempRoot();
  const plugin = deviceFeedsProxy({ sourceRoot: root, reportPort: 0, reportHost: '127.0.0.1' });
  const httpServer = new EventEmitter();
  const { request } = harness(plugin);
  // configureServer through the harness installed the routes; now the lifecycle part.
  const uses = [];
  plugin.configureServer({ middlewares: { use: (...args) => uses.push(args) }, httpServer });
  assert.equal(plugin.reportListener().port, null, 'nothing to listen for yet');

  const saved = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'tracker', name: 'Phone', method: 'report-in' } });
  const key = saved.json().status.kinds.find((kind) => kind.id === 'tracker').feeds[0].reportKey;
  for (let i = 0; i < 50 && !plugin.reportListener().port; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const port = plugin.reportListener().port;
  assert.ok(port > 0, 'listening');
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/?id=${key}&lat=45.1&lon=-66.1&timestamp=1700000000`, { method: 'POST' });
    assert.deepEqual([ok.status, await ok.text()], [200, 'OK']);
    const other = await fetch(`http://127.0.0.1:${port}/api/device-feeds/status`);
    assert.equal(other.status, 404, 'no other route on that port');
    assert.equal((await fetch(`http://127.0.0.1:${port}/${key}`, { method: 'PUT' })).status, 405);
    const positions = (await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
    assert.deepEqual([positions.devices[0].lat, positions.devices[0].lon], [45.1, -66.1]);
    const status = (await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
    assert.equal(status.reportListener.port, port);
    assert.ok(status.reportAddresses.every((address) => address.endsWith(`:${port}`)));
    // Removing the last reporting device closes the port.
    await request('/config', { method: 'POST', headers: pageHeaders(), body: { removeFeedId: 'tracker-phone' } });
    assert.equal(plugin.reportListener().port, null);
  } finally {
    httpServer.emit('close');
    plugin.stopReportListener();
  }
});

test('every spelling of /ultra/ reaches the phone routes, and a refused report never logs a key-sized path segment', async () => {
  const root = tempRoot();
  const plugin = deviceFeedsProxy({ sourceRoot: root, reportPort: 0, reportHost: '127.0.0.1' });
  // The phone routes read the saved packages from their own provider's root.
  const { ultraHelpProxy } = await import('../server/providers/ultra-help.js');
  ultraHelpProxy({ sourceRoot: root });
  const httpServer = new EventEmitter();
  const { request } = harness(plugin);
  plugin.configureServer({ middlewares: { use: () => {} }, httpServer });
  const saved = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'security', name: 'Samsung', method: 'report-in' } });
  const key = saved.json().status.kinds.find((kind) => kind.id === 'security').feeds[0].reportKey;
  for (let i = 0; i < 50 && !plugin.reportListener().port; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const port = plugin.reportListener().port;
  assert.ok(port > 0, 'listening');
  // Raw sockets, so the request target reaches the listener byte for byte.
  const net = await import('node:net');
  const raw = (target, extra = '') =>
    new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let data = '';
      socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extra}Connection: close\r\n\r\n`));
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
  const FAKE = `uht1.${'A'.repeat(43)}`;
  const logged = [];
  const warn = console.warn;
  console.warn = (...args) => logged.push(args.map(String).join(' '));
  try {
    // A base pasted with its trailing slash, a dictated capital, a percent-encoded letter:
    // all reach the phone routes, which answer their uniform 404 and log nothing.
    for (const target of [`//ultra/help/${FAKE}`, `/Ultra/help/${FAKE}`, `/%75ltra/help/${FAKE}`]) {
      const answer = await raw(target);
      assert.match(answer, /^HTTP\/1\.1 404 /, target);
      // The body may be chunk-framed on a raw socket; the phone routes' text is in it either way.
      assert.ok(answer.includes('\r\n\r\n') && answer.split('\r\n\r\n')[1].includes('Not found'), target);
    }
    assert.deepEqual(logged, [], 'the phone routes never log a path');
    for (const target of [`/Ultra/${key}/cam`, `//ultra/${key}/cam`]) assert.match(await raw(target), /^HTTP\/1\.1 200 /, target);
    // A refused report blanks every key-sized segment of the path it names, and
    // repeats tailscale's login header only from its loopback proxy socket, capped.
    // (Node's parser already refuses control characters in a header value, so only the length cap is exercised here.)
    const refused = await raw(`/report/${FAKE}`, `Tailscale-User-Login: mallory@example.com${'x'.repeat(200)}\r\n`);
    assert.match(refused, /^HTTP\/1\.1 404 /);
    assert.equal(logged.length, 1);
    assert.ok(!logged[0].includes(FAKE) && !logged[0].includes(key), logged[0]);
    assert.ok(logged[0].includes('GET /report/<key>'), logged[0]);
    assert.ok(logged[0].includes('tailnet user mallory@example.com'), logged[0]);
    assert.ok(logged[0].length < logged[0].indexOf('tailnet user') + 100, logged[0]);
  } finally {
    console.warn = warn;
    httpServer.emit('close');
    plugin.stopReportListener();
  }
});

test('the saved route comes back as points, oldest first, thinned, positions only', async () => {
  const root = tempRoot();
  const { request } = harness(deviceFeedsProxy({ sourceRoot: root, listen: false }));
  await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'tracker', name: 'Van', method: 'report-in', record: true } });
  const folder = path.join(root, 'config', 'device-recordings', 'tracker-van');
  fs.mkdirSync(folder, { recursive: true });
  const line = (at, lat, lon) => JSON.stringify({ device: 'Van', kind: 'tracker', at, target: { lat, lon, altM: null, headingDeg: 90, speedMps: 5 }, radiusKm: 2, layers: { cctv: [{ id: 'cam', lat, lon, name: 'SECRET CAMERA' }] } });
  fs.writeFileSync(path.join(folder, '2026-09-25.jsonl'), `${line('2026-09-25T10:00:00Z', 45.20, -66.10)}\n${line('2026-09-25T10:00:10Z', 45.20, -66.10)}\nnot json\n`);
  fs.writeFileSync(path.join(folder, '2026-09-26.jsonl'), `${line('2026-09-26T10:00:00Z', 45.21, -66.11)}\n`);
  fs.writeFileSync(path.join(folder, 'last-report.json'), '{}');

  const track = await request('/track/device-tracker-van', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(track.status, 200);
  const payload = track.json();
  assert.deepEqual([payload.days, payload.total, payload.points.length], [2, 3, 2], 'two days, three lines, one unmoved fix dropped');
  assert.deepEqual(payload.points.map((point) => [point.lat, point.lon]), [[45.2, -66.1], [45.21, -66.11]]);
  assert.equal(payload.from, Date.parse('2026-09-25T10:00:00Z'));
  assert.ok(!track.bytes.toString().includes('SECRET CAMERA'), 'what was recorded around the device never comes back');
  assert.equal((await request('/track/device-tracker-van?days=1', { headers: { 'sec-fetch-site': 'same-origin' } })).json().points.length, 1);
  assert.equal((await request('/track/device-nobody', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 404);
  assert.equal((await request('/track/device-tracker-van', { remoteAddress: '10.66.0.2' })).status, 403, 'loopback only, like positions');

  // The poll tells the map a recording exists and when it last grew.
  const positions = (await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  assert.deepEqual(positions.devices, [], 'no position yet: nothing to place');
  await request(`/report?id=${(await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).json().kinds.find((kind) => kind.id === 'tracker').feeds[0].reportKey}&lat=45.22&lon=-66.12`, { remoteAddress: '10.66.0.2', headers: { host: '10.66.0.1:44173' } });
  const placed = (await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json().devices[0];
  assert.equal(placed.history.days, 2);
  assert.ok(placed.history.lastAt > 0);
});

test('a call for help received from the help network is a pin on the same layer', async () => {
  const root = tempRoot();
  const { ultraHelpProxy, pollUltraNetworkOnce, noteUltraEndpoint } = await import('../server/providers/ultra-help.js');
  const PEER_LINK = `https://peer.tail9.ts.net/ultra/help/uht1.${'Pp7'.repeat(14)}A`;
  let released = true;
  // The peer's /network is the only thing this machine ever asks it for; the
  // reverse geocode is refused, so the row falls back to the coordinates.
  const ultraFetch = async (url) => {
    if (url !== `${PEER_LINK}/network`) throw new Error('offline');
    return jsonAnswer(released
      ? { released: true, name: 'Sam', lat: 45.27, lon: -66.06, at: Date.now() - 5000, until: Date.now() + 14_395_000, incident: 'fire' }
      : { released: false });
  };
  const mounted = [];
  ultraHelpProxy({ sourceRoot: root, fetchImpl: ultraFetch }).configureServer({ middlewares: { use: (...args) => mounted.push(args) } });
  const ultraHandler = mounted.find((args) => args[0] === '/api/ultra-help')[1];
  const ultraPost = (url, body) =>
    new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const req = { url, method: 'POST', headers: { host: 'localhost:4173', ...pageHeaders() }, socket: { remoteAddress: '127.0.0.1' } };
      req[Symbol.asyncIterator] = async function* iterate() {
        yield payload;
      };
      const res = {
        writeHead(status, headers = {}) {
          Object.assign(this, { status, headers });
        },
        end(chunk) {
          const text = Buffer.from(chunk || '').toString('utf8');
          resolve({ status: this.status, text, json: () => JSON.parse(text) });
        },
      };
      Promise.resolve(ultraHandler(req, res)).catch(reject);
    });

  const { request } = harness(deviceFeedsProxy({ sourceRoot: root, listen: false }));
  const saved = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'security', name: 'Samsung', method: 'report-in' } });
  assert.equal(saved.status, 200, saved.bytes.toString());
  const key = saved.json().status.kinds.find((kind) => kind.id === 'security').feeds[0].reportKey;
  await request(`/report/${key}?lat=45.2&lon=-66`, { remoteAddress: '10.66.0.2', headers: { host: '10.66.0.1:44173' } });

  noteUltraEndpoint(['https://me.tail9.ts.net']);
  const added = await ultraPost('/network', { add: true, link: PEER_LINK, name: 'Sam' });
  assert.equal(added.status, 200, added.text);
  await pollUltraNetworkOnce(Date.now());

  const positions = (await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  assert.equal(positions.devices[0].id, 'device-security-samsung', 'the saved devices come first');
  const pin = positions.devices.find((device) => String(device.id).startsWith('ultra-network:'));
  assert.ok(pin, JSON.stringify(positions.devices));
  assert.deepEqual([pin.kind, pin.follow, pin.record, pin.live, pin.name], ['help', false, false, true, 'Sam']);
  assert.match(pin.kindLabel, /^NEEDS HELP · \d\d:\d\d$/);
  assert.deepEqual([pin.lat, pin.lon, pin.color], [45.27, -66.06, '#ffb000']);
  assert.ok(!JSON.stringify(positions.devices).includes('uht1.'), 'never a token');

  // Their stand-down ends the episode, and the pin is gone at the next poll.
  // CHECK NOW, because the twenty-second cadence has not come round yet.
  released = false;
  await ultraPost('/network', { poll: true });
  const after = (await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  assert.deepEqual(after.devices.filter((device) => String(device.id).startsWith('ultra-network:')), []);
});

test('a rewritten phone package is not fetched or admitted until its check is saved again', async () => {
  const root = tempRoot();
  // This module may still be pointed at another temp dir, or at the checkout.
  // The check is judged from this dir's own key and seal.
  const key = Buffer.alloc(32, 9);
  fs.writeFileSync(path.join(root, 'config', 'ultra-tokens.key'), `${key.toString('hex')}\n`);
  const token = newUltraToken(() => Buffer.alloc(32, 3));
  assert.equal(ULTRA_TOKEN_PATTERN.test(token), true);
  const id = ultraTokenId(() => Buffer.alloc(8, 4));
  fs.writeFileSync(path.join(root, 'config', 'ultra-tokens.json'), `${JSON.stringify({
    version: 1,
    tokens: [{ id, sealed: sealUltraToken(token, key, { id }), revokedAt: null }],
  }, null, 2)}\n`);
  const asked = [];
  const fetchImpl = async (url, options = {}) => {
    asked.push({ url: String(url), authorization: options.headers?.Authorization || '' });
    if (String(url).includes('gps.example')) return jsonAnswer([{ latitude: 45.27, longitude: -66.06, speed: 0, course: 0 }]);
    return jsonAnswer({ lat: 45.2, lon: -66.1 });
  };
  const { request } = harness(deviceFeedsProxy({ sourceRoot: root, listen: false, fetchImpl }));
  const save = (body) => request('/config', { method: 'POST', headers: pageHeaders(), body });
  const tracker = await save({ kind: 'tracker', name: 'Van', method: 'traccar', url: 'https://gps.example/' });
  assert.equal(tracker.status, 200, tracker.bytes.toString());
  assert.equal(tracker.json().feedId, 'tracker-van');
  const phoneSaved = await save({
    kind: 'security', name: 'Phone', method: 'http-json',
    url: 'https://phone.example/pos', pictureUrl: 'https://phone.example/pic.jpg',
    auth: 'bearer', token: 'phone-bearer-fixture', lat: 45.2, lon: -66.1,
  });
  assert.equal(phoneSaved.status, 200, phoneSaved.bytes.toString());
  assert.equal(phoneSaved.json().feedId, 'security-phone');
  const handset = await save({ kind: 'security', name: 'Handset', method: 'report-in' });
  assert.equal(handset.status, 200, handset.bytes.toString());
  assert.equal(handset.json().feedId, 'security-handset');
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, DEVICE_FEED_STORE), 'utf8'));
  const reportKey = onDisk.feeds.find((feed) => feed.id === 'security-handset').reportKey;
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(reportKey), true);
  const outboundPath = path.join(root, 'config', 'ultra-outbound.json');
  const outbound = fs.readFileSync(outboundPath, 'utf8');
  assert.match(JSON.parse(outbound).feedsMac, /^[0-9a-f]{64}$/);
  assert.equal(outbound.includes('https://'), false);
  assert.equal(outbound.includes('phone-bearer-fixture'), false);
  assert.equal(outbound.includes(reportKey), false);

  onDisk.feeds.find((feed) => feed.id === 'security-phone').lat = 45.27123456789;
  fs.writeFileSync(path.join(root, DEVICE_FEED_STORE), `${JSON.stringify(onDisk, null, 2)}\n`);
  const first = await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(first.status, 200);
  assert.equal(asked.some((call) => call.url === 'https://gps.example/api/positions'), true);
  assert.equal(asked.some((call) => call.url === 'https://phone.example/pos'), true);

  const realNow = Date.now;
  try {
    onDisk.feeds.find((feed) => feed.id === 'security-phone').url = 'https://evil.example/pos-taken';
    fs.writeFileSync(path.join(root, DEVICE_FEED_STORE), `${JSON.stringify(onDisk, null, 2)}\n`);
    Date.now = () => realNow() + 20_000;
    asked.length = 0;
    await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(asked.some((call) => call.url === 'https://gps.example/api/positions'), true);
    assert.equal(asked.some((call) => call.url.includes('evil.example')), false);
    assert.equal(asked.some((call) => call.authorization.includes('phone-bearer-fixture')), false);
    const phone = { remoteAddress: '10.66.0.2', headers: { host: '10.66.0.1:44173' } };
    const refused = await request(`/report/${reportKey}?lat=45.2&lon=-66.1`, phone);
    assert.equal(refused.status, 404);
    assert.equal(refused.bytes.toString(), 'Not found');
    const frame = await request('/frame/device-security-phone', { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(frame.status, 502);
    assert.equal(frame.json().error, 'The device did not give a picture');
    assert.equal(asked.some((call) => call.url.includes('pic.jpg')), false);

    fs.unlinkSync(outboundPath);
    Date.now = () => realNow() + 40_000;
    asked.length = 0;
    await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(asked.some((call) => call.url === 'https://evil.example/pos-taken'), true);
    const taken = await request(`/report/${reportKey}?lat=45.22&lon=-66.12`, phone);
    assert.equal(taken.status, 200);
    assert.equal(taken.bytes.toString(), 'OK');
  } finally {
    Date.now = realNow;
  }
});

function rewriteFeeds(root, mutate) {
  const file = path.join(root, DEVICE_FEED_STORE);
  const before = fs.statSync(file).size;
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(onDisk);
  let text = `${JSON.stringify(onDisk, null, 2)}\n`;
  if (Buffer.byteLength(text) === before) text += '\n';
  fs.writeFileSync(file, text);
  assert.notEqual(fs.statSync(file).size, before);
}

test('saving only a phone still checks other devices, so a drone added by hand is not fetched', async () => {
  const root = tempRoot();
  const asked = [];
  const { request } = harness(deviceFeedsProxy({
    sourceRoot: root,
    listen: false,
    fetchImpl: async (url) => {
      asked.push(String(url));
      return jsonAnswer([{ latitude: 45, longitude: -66 }]);
    },
  }));
  const saved = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'security', name: 'Phone', method: 'report-in' } });
  assert.equal(saved.status, 200, saved.bytes.toString());
  const reportKey = saved.json().status.kinds.find((kind) => kind.id === 'security').feeds[0].reportKey;
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(reportKey), true);
  const checkText = fs.readFileSync(path.join(root, 'config', 'local-integrity.json'), 'utf8');
  assert.match(JSON.parse(checkText).devicesMac, /^[0-9a-f]{64}$/);
  assert.equal(checkText.includes(reportKey), false);
  assert.equal(fs.existsSync(path.join(root, 'config', 'ultra-outbound.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'config', 'local-integrity.key')), true);
  rewriteFeeds(root, (onDisk) => {
    onDisk.feeds.push({ id: 'drone-a', kind: 'drone', name: 'A', method: 'http-json', url: 'https://evil.example/pos' });
  });
  const positions = await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(positions.status, 200);
  assert.equal(asked.length, 0);
  const phone = { remoteAddress: '10.66.0.2', headers: { host: '10.66.0.1:44173' } };
  const taken = await request(`/report/${reportKey}?lat=45.2&lon=-66.1`, phone);
  assert.equal(taken.status, 200);
  assert.equal(taken.bytes.toString(), 'OK');
});

test('a changed tracker is not fetched or admitted, and a phone without its own check still is', async () => {
  const root = tempRoot();
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push({ url: String(url) });
    if (String(url).includes('gps.example') || String(url).includes('evil.example')) {
      return jsonAnswer([{ latitude: 45.27, longitude: -66.06, speed: 0, course: 0 }]);
    }
    return jsonAnswer({ lat: 45.2, lon: -66.1 });
  };
  const { request } = harness(deviceFeedsProxy({ sourceRoot: root, listen: false, fetchImpl }));
  const save = (body) => request('/config', { method: 'POST', headers: pageHeaders(), body });
  const tracker = await save({ kind: 'tracker', name: 'Van', method: 'traccar', url: 'https://gps.example/', auth: 'bearer', token: 'TOPSECRET' });
  assert.equal(tracker.status, 200, tracker.bytes.toString());
  const phoneSaved = await save({
    kind: 'security', name: 'Phone', method: 'http-json',
    url: 'https://phone.example/pos', auth: 'bearer', token: 'phone-bearer-fixture', lat: 45.2, lon: -66.1,
  });
  assert.equal(phoneSaved.status, 200, phoneSaved.bytes.toString());
  const walker = await save({ kind: 'tracker', name: 'Walker', method: 'report-in' });
  assert.equal(walker.status, 200, walker.bytes.toString());
  const reportKey = walker.json().status.kinds.find((kind) => kind.id === 'tracker').feeds.find((feed) => feed.id === 'tracker-walker').reportKey;
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(reportKey), true);
  const checkPath = path.join(root, 'config', 'local-integrity.json');
  const checkText = fs.readFileSync(checkPath, 'utf8');
  assert.match(JSON.parse(checkText).devicesMac, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(root, 'config', 'ultra-outbound.json')), false);
  for (const secret of ['TOPSECRET', 'phone-bearer-fixture', 'gps.example', 'phone.example', reportKey]) {
    assert.equal(checkText.includes(secret), false);
  }

  // A device that already has a fix answers before its refresh finishes.
  // The next poll has to see that refresh done, or it is skipped as still in flight.
  const positionsAt = async () => {
    const result = await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } });
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return result;
  };
  const first = await positionsAt();
  assert.equal(first.status, 200);
  assert.equal(asked.some((call) => call.url === 'https://gps.example/api/positions'), true);
  assert.equal(asked.some((call) => call.url === 'https://phone.example/pos'), true);

  const realNow = Date.now;
  const warnings = [];
  const realWarn = console.warn;
  try {
    console.warn = (...args) => {
      warnings.push(args.map((part) => String(part)).join(' '));
    };
    rewriteFeeds(root, (onDisk) => {
      onDisk.feeds.find((feed) => feed.id === 'tracker-van').lat = 45.271111;
    });
    Date.now = () => realNow() + 20_000;
    asked.length = 0;
    await positionsAt();
    assert.equal(asked.some((call) => call.url === 'https://gps.example/api/positions'), true);
    assert.equal(asked.some((call) => call.url === 'https://phone.example/pos'), true);

    rewriteFeeds(root, (onDisk) => {
      onDisk.feeds.find((feed) => feed.id === 'security-phone').url = 'https://evil-phone.example/pos';
    });
    Date.now = () => realNow() + 40_000;
    asked.length = 0;
    await positionsAt();
    assert.equal(asked.some((call) => call.url === 'https://gps.example/api/positions'), true);
    assert.equal(asked.some((call) => call.url === 'https://evil-phone.example/pos'), true);

    rewriteFeeds(root, (onDisk) => {
      onDisk.feeds.find((feed) => feed.id === 'tracker-van').url = 'https://evil.example/';
    });
    Date.now = () => realNow() + 60_000;
    asked.length = 0;
    const refusedPositions = await positionsAt();
    assert.equal(asked.some((call) => call.url === 'https://evil.example/api/positions'), false);
    assert.equal(asked.some((call) => call.url === 'https://evil-phone.example/pos'), true);
    const van = refusedPositions.json().devices.find((device) => device.id === 'device-tracker-van');
    assert.equal(van.error, 'the device package was changed');
    const phone = { remoteAddress: '10.66.0.2', headers: { host: '10.66.0.1:44173' } };
    const refused = await request(`/report/${reportKey}?lat=45.2&lon=-66.1`, phone);
    assert.equal(refused.status, 404);
    assert.equal(refused.bytes.toString(), 'Not found');
    const refusedLine = '[Device feeds] Report refused: the device package was changed and is not being used';
    assert.equal(warnings.includes(refusedLine), true);
    assert.equal(warnings.some((line) => line.includes(reportKey)), false);

    fs.unlinkSync(checkPath);
    Date.now = () => realNow() + 80_000;
    asked.length = 0;
    await positionsAt();
    assert.equal(asked.some((call) => call.url === 'https://evil.example/api/positions'), true);
    const taken = await request(`/report/${reportKey}?lat=45.22&lon=-66.12`, phone);
    assert.equal(taken.status, 200);
    assert.equal(taken.bytes.toString(), 'OK');
  } finally {
    Date.now = realNow;
    console.warn = realWarn;
  }
});

test('a changed report address is left off the card and its certificate is not loaded', async () => {
  const root = tempRoot();
  const previous = {
    DEVICE_REPORT_PUBLIC_BASE: process.env.DEVICE_REPORT_PUBLIC_BASE,
    DEVICE_REPORT_PUBLIC_HOST: process.env.DEVICE_REPORT_PUBLIC_HOST,
    DEVICE_REPORT_TLS_CERT: process.env.DEVICE_REPORT_TLS_CERT,
    DEVICE_REPORT_TLS_KEY: process.env.DEVICE_REPORT_TLS_KEY,
  };
  const restoreEnv = () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  process.env.DEVICE_REPORT_PUBLIC_BASE = 'https://reports.example/';
  process.env.DEVICE_REPORT_PUBLIC_HOST = 'reports.example';
  process.env.DEVICE_REPORT_TLS_CERT = path.join(root, 'missing-cert.pem');
  process.env.DEVICE_REPORT_TLS_KEY = path.join(root, 'missing-key.pem');
  const plugin = deviceFeedsProxy({ sourceRoot: root, reportPort: 0, reportHost: '127.0.0.1' });
  const httpServer = new EventEmitter();
  const { request } = harness(plugin);
  plugin.configureServer({ middlewares: { use: () => {} }, httpServer });
  const waitForPort = async () => {
    for (let i = 0; i < 50 && !plugin.reportListener().port; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return plugin.reportListener().port;
  };
  try {
    const saved = await request('/config', {
      method: 'POST',
      headers: pageHeaders(),
      body: { kind: 'tracker', name: 'Phone', method: 'report-in' },
    });
    assert.equal(saved.status, 200);
    const checkPath = path.join(root, 'config', 'local-integrity.json');
    const checkText = fs.readFileSync(checkPath, 'utf8');
    assert.match(JSON.parse(checkText).listenerMac, /^[0-9a-f]{64}$/);
    assert.equal(checkText.includes('reports.example'), false);
    assert.equal(checkText.includes('missing-cert.pem'), false);
    assert.equal(fs.existsSync(path.join(root, 'config', 'ultra-outbound.json')), false);
    assert.ok(await waitForPort() > 0);
    const shown = (await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
    assert.equal(shown.reportAddresses[0], 'https://reports.example');
    assert.equal(shown.reportAddresses.some((address) => address.startsWith('http://reports.example:')), true);

    process.env.DEVICE_REPORT_PUBLIC_BASE = 'https://evil.example';
    process.env.DEVICE_REPORT_PUBLIC_HOST = 'evil.example';
    const sentinel = path.join(root, 'evil-cert.pem');
    fs.writeFileSync(sentinel, 'SENTINEL-CERT');
    process.env.DEVICE_REPORT_TLS_CERT = sentinel;
    process.env.DEVICE_REPORT_TLS_KEY = sentinel;
    const hidden = (await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
    const ownMachine = (addresses) => addresses.length > 0
      && addresses.every((address) => /^http:\/\/[^/]+:\d+$/.test(address))
      && addresses.every((address) => !address.includes('example'));
    assert.equal(ownMachine(hidden.reportAddresses), true);
    assert.equal(fs.readFileSync(checkPath, 'utf8'), checkText);

    plugin.stopReportListener();
    const store = path.join(root, DEVICE_FEED_STORE);
    fs.writeFileSync(store, `${fs.readFileSync(store, 'utf8')}\n`);
    await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.ok(await waitForPort() > 0);
    const restarted = (await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
    assert.equal(ownMachine(restarted.reportAddresses), true);
    assert.equal(plugin.reportListener().error, '');

    fs.unlinkSync(checkPath);
    const open = (await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
    assert.equal(open.reportAddresses[0], 'https://evil.example');
    assert.equal(open.reportAddresses.some((address) => address.startsWith('http://evil.example:')), true);
  } finally {
    httpServer.emit('close');
    plugin.stopReportListener();
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a fix dated in the future counts as now: the true reports after it still land, after a restart too', async () => {
  const root = tempRoot();
  const { request } = harness(deviceFeedsProxy({ sourceRoot: root, listen: false }));
  const saved = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'tracker', name: 'Van GPS', method: 'report-in' } });
  const key = saved.json().status.kinds.find((kind) => kind.id === 'tracker').feeds[0].reportKey;
  const phone = { remoteAddress: '10.66.0.2', headers: { host: '10.66.0.1:44173' } };
  const where = async (api = request) => {
    const [device] = (await api('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json().devices;
    return [device.lat, device.lon];
  };
  const seconds = () => Math.ceil(Date.now() / 1000) + 1;
  // A phone clock a day ahead is taken, as now...
  const ahead = await request(`/report/${key}?lat=45.1&lon=-66.1&timestamp=${seconds() + 86_400}`, phone);
  assert.equal(ahead.status, 200);
  assert.deepEqual(await where(), [45.1, -66.1]);
  // ...so the true report a moment later still moves the device.
  assert.equal((await request(`/report/${key}?lat=45.2&lon=-66.2&timestamp=${seconds()}`, phone)).status, 200);
  assert.deepEqual(await where(), [45.2, -66.2]);
  // A fix older than the newest is still not taken.
  assert.equal((await request(`/report/${key}?lat=40&lon=-70&timestamp=1600000000`, phone)).status, 200);
  assert.deepEqual(await where(), [45.2, -66.2]);

  // A future fix kept on disk before this rule existed does not shut out the next report after a restart.
  const kept = path.join(root, 'config', 'device-recordings', 'tracker-van-gps', 'last-report.json');
  const file = JSON.parse(fs.readFileSync(kept, 'utf8'));
  assert.ok(file.position.at <= Date.now(), 'nothing from the future is kept');
  file.position = { ...file.position, lat: 45.3, lon: -66.3, at: Date.now() + 86_400_000 };
  fs.writeFileSync(kept, JSON.stringify(file));
  const again = harness(deviceFeedsProxy({ sourceRoot: root, listen: false }));
  assert.deepEqual(await where(again.request), [45.3, -66.3]);
  assert.equal((await again.request(`/report/${key}?lat=45.4&lon=-66.4&timestamp=${seconds()}`, phone)).status, 200);
  assert.deepEqual(await where(again.request), [45.4, -66.4]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a port-in-use retry never opens the report port once the last reporting device is gone', async () => {
  const root = tempRoot();
  // Hold a port, as a previous dev server still does for a moment.
  const net = await import('node:net');
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const port = holder.address().port;
  const plugin = deviceFeedsProxy({ sourceRoot: root, reportPort: port, reportHost: '127.0.0.1' });
  const httpServer = new EventEmitter();
  const { request } = harness(plugin);
  plugin.configureServer({ middlewares: { use: () => {} }, httpServer });
  try {
    await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'tracker', name: 'Phone', method: 'report-in' } });
    // The first attempt finds the port taken and waits to try again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(plugin.reportListener().port, null);
    // The device goes, then the port comes free: the pending retry must not take it.
    await request('/config', { method: 'POST', headers: pageHeaders(), body: { removeFeedId: 'tracker-phone' } });
    await new Promise((resolve) => holder.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(plugin.reportListener().port, null, 'nothing listens without a reporting device');
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
    // A device saved again starts afresh, with its own retries, and listens.
    await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'tracker', name: 'Phone', method: 'report-in' } });
    for (let i = 0; i < 50 && !plugin.reportListener().port; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(plugin.reportListener().port, port);
  } finally {
    httpServer.emit('close');
    plugin.stopReportListener();
    if (holder.listening) await new Promise((resolve) => holder.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the recordings folder is restricted to this account once a process, and again when it is made anew', async () => {
  const root = tempRoot();
  const folder = path.join(root, 'config', 'device-recordings');
  const hardened = [];
  let restricts = true;
  const { request } = harness(deviceFeedsProxy({ sourceRoot: root, listen: false, hardenFolder: (dir) => (hardened.push(dir), restricts) }));
  const saved = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'tracker', name: 'Van GPS', method: 'report-in' } });
  const key = saved.json().status.kinds.find((kind) => kind.id === 'tracker').feeds[0].reportKey;
  const phone = { remoteAddress: '10.66.0.2', headers: { host: '10.66.0.1:44173' } };
  assert.equal((await request(`/report/${key}?lat=45.1&lon=-66.1`, phone)).status, 200);
  assert.equal((await request(`/report/${key}?lat=45.2&lon=-66.2`, phone)).status, 200);
  assert.deepEqual(hardened, [folder], 'once, before the first position is written');
  assert.ok(fs.existsSync(path.join(folder, 'tracker-van-gps', 'last-report.json')));
  // Deleted and made anew, it is restricted again before anything lands in it.
  fs.rmSync(folder, { recursive: true, force: true });
  restricts = false;
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.map(String).join(' '));
  try {
    assert.equal((await request(`/report/${key}?lat=45.3&lon=-66.3`, phone)).status, 200);
    assert.equal((await request(`/report/${key}?lat=45.4&lon=-66.4`, phone)).status, 200);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(hardened, [folder, folder]);
  // A folder that cannot be restricted is said once, and the position is still kept.
  assert.equal(warned.filter((line) => line.includes('could not be restricted')).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'tracker-van-gps', 'last-report.json'), 'utf8')).position.lat, 45.4);
  fs.rmSync(root, { recursive: true, force: true });
});

test('on Windows, positions already recorded and the last report are left to this account alone', { skip: process.platform !== 'win32' }, async () => {
  const root = tempRoot();
  // What a secondary drive grants: every signed-in account may change what is under it.
  execFileSync('icacls', [root, '/grant', '*S-1-5-11:(OI)(CI)M'], { stdio: 'ignore' });
  const feedFolder = path.join(root, 'config', 'device-recordings', 'tracker-van-gps');
  fs.mkdirSync(feedFolder, { recursive: true });
  const older = path.join(feedFolder, '2026-09-28.jsonl');
  fs.writeFileSync(older, '{"lat":45,"lon":-66}\n');
  const sids = (file) =>
    execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-Acl -LiteralPath $env:GEV_TEST_FILE).Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }'],
      { env: { ...process.env, GEV_TEST_FILE: file }, encoding: 'utf8' },
    )
      .split(/\r?\n/)
      .filter(Boolean);
  assert.ok(sids(older).includes('S-1-5-11'), 'the broad grant reached the old file');
  const { request } = harness(deviceFeedsProxy({ sourceRoot: root, listen: false }));
  const saved = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'tracker', name: 'Van GPS', method: 'report-in' } });
  const key = saved.json().status.kinds.find((kind) => kind.id === 'tracker').feeds[0].reportKey;
  assert.equal((await request(`/report/${key}?lat=45.1&lon=-66.1`, { remoteAddress: '10.66.0.2', headers: { host: '10.66.0.1:44173' } })).status, 200);
  for (const file of [older, path.join(feedFolder, 'last-report.json')]) {
    const granted = sids(file);
    assert.equal(granted.includes('S-1-5-11'), false, `${path.basename(file)}: ${granted}`);
    assert.equal(granted.includes('S-1-5-32-545'), false, `${path.basename(file)}: ${granted}`);
    assert.equal(granted.length, 3, `${path.basename(file)}: ${granted}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('a device looping refused reports is said once a minute per address, and a long forwarded header is cut', async () => {
  const root = tempRoot();
  const plugin = deviceFeedsProxy({ sourceRoot: root, reportPort: 0, reportHost: '127.0.0.1', hardenFolder: () => true });
  const httpServer = new EventEmitter();
  const { request } = harness(plugin);
  plugin.configureServer({ middlewares: { use: () => {} }, httpServer });
  await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'tracker', name: 'Phone', method: 'report-in' } });
  for (let i = 0; i < 50 && !plugin.reportListener().port; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const port = plugin.reportListener().port;
  assert.ok(port > 0, 'listening');
  const refuse = (forwarded) => fetch(`http://127.0.0.1:${port}/report/nope`, { headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });
  const logged = [];
  const warn = console.warn;
  console.warn = (...args) => logged.push(args.map(String).join(' '));
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const long = `100.64.0.9${'9'.repeat(8000)}`;
    for (let i = 0; i < 30; i += 1) assert.equal((await refuse(long)).status, 404);
    assert.equal(logged.length, 1, 'thirty refusals, one line');
    assert.ok(logged[0].length < 300, `${logged[0].length} characters`);
    assert.ok(logged[0].includes('100.64.0.9'), logged[0]);
    assert.ok(!logged[0].includes('9'.repeat(70)), 'the forwarded header is cut');
    // Another address is said on its own...
    assert.equal((await refuse('100.64.0.10')).status, 404);
    assert.equal(logged.length, 2);
    // ...and a minute on, the first is said again.
    now += 60_001;
    assert.equal((await refuse(long)).status, 404);
    assert.equal(logged.length, 3);
  } finally {
    Date.now = realNow;
    console.warn = warn;
    httpServer.emit('close');
    plugin.stopReportListener();
  }
});

test('the report listener holds no more connections than its cap', async () => {
  const root = tempRoot();
  const plugin = deviceFeedsProxy({ sourceRoot: root, reportPort: 0, reportHost: '127.0.0.1', reportMaxConnections: 2, hardenFolder: () => true });
  const httpServer = new EventEmitter();
  const { request } = harness(plugin);
  plugin.configureServer({ middlewares: { use: () => {} }, httpServer });
  const saved = await request('/config', { method: 'POST', headers: pageHeaders(), body: { kind: 'tracker', name: 'Phone', method: 'report-in' } });
  const key = saved.json().status.kinds.find((kind) => kind.id === 'tracker').feeds[0].reportKey;
  for (let i = 0; i < 50 && !plugin.reportListener().port; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const port = plugin.reportListener().port;
  const net = await import('node:net');
  const open = () =>
    new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.closedEarly = false;
      socket.on('close', () => {
        socket.closedEarly = true;
      });
      socket.on('error', () => {});
      socket.on('connect', () => resolve(socket));
    });
  const held = [await open(), await open()];
  const extra = await open();
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(
      held.map((socket) => socket.closedEarly),
      [false, false],
      'the first two are kept',
    );
    assert.equal(extra.closedEarly, true, 'the third is dropped');
    // Once one closes, a phone gets in again.
    held[0].destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ok = await fetch(`http://127.0.0.1:${port}/?id=${key}&lat=45.1&lon=-66.1`, { method: 'POST' });
    assert.equal(ok.status, 200);
  } finally {
    for (const socket of [...held, extra]) socket.destroy();
    httpServer.emit('close');
    plugin.stopReportListener();
  }
});
