import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DEVICE_FEED_STORE } from './deviceFeedsCore.mjs';
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
  for (const url of ['/config/device-feeds.json', '/config/DEVICE-FEEDS.JSON?raw', '/config/device%2Dfeeds.json', '/@fs/x/config/device-feeds.json', '/config/.device-feeds.json.123.tmp']) {
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
