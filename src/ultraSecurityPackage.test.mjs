import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  DEVICE_FEED_KINDS,
  DEVICE_FEED_METHODS,
  DEVICE_FEED_STORE,
  DEVICE_RECORDING_DIR,
  DEVICE_RECORD_RADIUS_KM,
  applyDeviceFeedUpdate,
  buildDeviceRecordingLine,
  deviceDistanceKm,
  deviceFeedStatus,
  devicePublicRecord,
  emptyDeviceFeedConfig,
  extractDevicePosition,
  normalizeDeviceFeedConfig,
} from './deviceFeedsCore.mjs';
import { collectDeviceFeedUpdate, deviceRecordingText } from './deviceFeedsSetup.js';
import { deviceFeedsProxy, isDeviceFeedStoreRequest } from '../server/providers/device-feeds.js';

const add = (body, previous = emptyDeviceFeedConfig()) => applyDeviceFeedUpdate(body, previous);
const SAINT_JOHN = { lat: 45.2733, lon: -66.0633 };

test('the package: a tracker or a phone, every login, follow and record by default', () => {
  const kind = DEVICE_FEED_KINDS.find((item) => item.id === 'security');
  assert.equal(kind.title, 'ULTRA SECURITY PACKAGE');
  assert.deepEqual([kind.followDefault, kind.recordDefault], [true, true]);
  assert.equal(DEVICE_RECORD_RADIUS_KM, 50);
  assert.match(kind.unlocks, /within 50 km/);
  // Said plainly: a phone reports through an app on it, never by its number.
  assert.match(kind.unlocks, /cannot be found by its number/);
  for (const method of ['traccar', 'owntracks', 'home-assistant', 'http-json', 'cellular-tracker', 'phone-app', 'find-my']) {
    assert.ok(kind.methods.includes(method), method);
  }
  assert.equal(DEVICE_FEED_METHODS['home-assistant'].direct, true);
  for (const bridged of ['phone-app', 'find-my', 'cellular-tracker']) assert.equal(DEVICE_FEED_METHODS[bridged].direct, false);
  const status = deviceFeedStatus(emptyDeviceFeedConfig()).kinds.find((item) => item.id === 'security');
  assert.deepEqual([status.followDefault, status.recordDefault], [true, true]);
  assert.equal(deviceFeedStatus(emptyDeviceFeedConfig()).kinds.find((item) => item.id === 'tracker').followDefault, false);
});

test('a phone through Home Assistant', () => {
  const answer = { entity_id: 'device_tracker.pixel', state: 'not_home', attributes: { latitude: 45.31, longitude: -66.01, gps_accuracy: 12, altitude: 40, course: 180, speed: 3 }, last_updated: '2026-09-20T15:00:00+00:00' };
  assert.deepEqual(extractDevicePosition({ method: 'home-assistant' }, { json: answer }), { lat: 45.31, lon: -66.01, altM: 40, headingDeg: 180, speedMps: 3, at: '2026-09-20T15:00:00+00:00' });
  assert.equal(extractDevicePosition({ method: 'home-assistant' }, { json: { state: 'unknown', attributes: {} } }), null);
  const saved = add({ kind: 'security', name: 'Phone', method: 'home-assistant', url: 'http://homeassistant.local:8123/api/states/device_tracker.pixel', auth: 'bearer', token: 'ha-token' });
  assert.equal(saved.ok, true, 'a bearer token over plain http to the local network');
});

test('the map follows one device at a time', () => {
  const base = { kind: 'security', method: 'http-json', url: 'https://t.example/pos' };
  const one = add({ ...base, name: 'One', follow: true, record: true });
  const two = add({ ...base, name: 'Two', follow: true }, one.config);
  const flags = Object.fromEntries(two.config.feeds.map((feed) => [feed.name, [feed.follow, feed.record]]));
  assert.deepEqual(flags, { One: [false, true], Two: [true, false] });
  // Left out keeps what is saved.
  const renamed = applyDeviceFeedUpdate({ id: two.feedId, kind: 'security', name: 'Second', method: 'http-json' }, two.config);
  assert.equal(renamed.config.feeds.find((feed) => feed.id === two.feedId).follow, true);
  assert.match(add({ ...base, name: 'Bad', follow: 'yes' }).error, /on or off/);
  // A store edited by hand cannot make two devices fight for the camera.
  const coerced = normalizeDeviceFeedConfig({ feeds: two.config.feeds.map((feed) => ({ ...feed, follow: true })) });
  assert.deepEqual(coerced.feeds.map((feed) => feed.follow), [true, false]);
  const record = devicePublicRecord({ ...two.config.feeds[1] }, { lat: 1, lon: 2 });
  assert.deepEqual([record.follow, record.record], [true, false]);
});

test('the card sends the switches, and says what has been saved', () => {
  const body = collectDeviceFeedUpdate('security', '', { name: 'Van', method: 'traccar', url: 'https://g.example/', lat: '', lon: '', follow: true, record: false });
  assert.deepEqual([body.follow, body.record], [true, false]);
  assert.equal(deviceRecordingText({ record: false }), '');
  assert.match(deviceRecordingText({ record: true }), /nothing saved yet/);
  assert.equal(deviceRecordingText({ record: true, recording: { files: 2, bytes: 3 * 1024 * 1024, folder: 'config/device-recordings/security-van' } }), 'RECORDING · 2 days · 3.0 MB in config/device-recordings/security-van');
  assert.equal(deviceRecordingText({ record: false, recording: { files: 1, bytes: 900, folder: 'x' } }), 'RECORDED · 1 day · 1 KB in x');
});

test('a saved line keeps only what really is within 50 km of where the SERVER knows the device to be', () => {
  assert.ok(Math.abs(deviceDistanceKm(SAINT_JOHN, { lat: 45.9636, lon: -66.6431 }) - 89) < 2, 'Saint John to Fredericton');
  const body = {
    layers: {
      flights: [{ id: 'ACA123', lat: 45.3, lon: -66.0 }, { id: 'FAR', lat: 45.9636, lon: -66.6431 }, { id: 'NOPOS' }, null],
      cctv: [{ id: 'sj-1', name: 'King Square', lat: 45.274, lon: -66.058 }],
      '../etc': [{ id: 'x', lat: 45.27, lon: -66.06 }],
      notalist: 'x',
    },
  };
  const built = buildDeviceRecordingLine(body, { ...SAINT_JOHN, speedMps: 4 }, { at: Date.UTC(2026, 8, 20, 12) });
  assert.equal(built.ok, true);
  assert.equal(built.kept, 2);
  assert.deepEqual(Object.keys(built.line.layers), ['flights', 'cctv']);
  assert.deepEqual(built.line.layers.flights.map((record) => record.id), ['ACA123']);
  assert.ok(built.line.layers.cctv[0].distanceKm < 1);
  assert.deepEqual([built.line.at, built.line.radiusKm, built.line.target.speedMps], ['2026-09-20T12:00:00.000Z', 50, 4]);
  // The device's own track is saved even when nothing else is near it.
  assert.deepEqual(buildDeviceRecordingLine({}, SAINT_JOHN).line.layers, {});
  assert.equal(buildDeviceRecordingLine({}, null).ok, false);
  assert.equal(buildDeviceRecordingLine([], SAINT_JOHN).ok, false);
});

// ---- server ---------------------------------------------------------------

const PAGE = { origin: 'http://localhost:4173', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };

function harness(plugin) {
  const uses = [];
  plugin.configureServer({ middlewares: { use: (...args) => uses.push(args) } });
  const handler = uses.find((args) => args[0] === '/api/device-feeds')[1];
  return (url, { method = 'GET', headers = {}, remoteAddress = '127.0.0.1', body } = {}) =>
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
        writeHead(status) { Object.assign(this, { status, headersSent: true }); },
        end(chunk) { resolve({ status: this.status, json: () => JSON.parse(Buffer.from(chunk || '').toString('utf8')) }); },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
}

test('a recording is never served as a file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-usp-'));
  for (const url of ['/config/device-recordings/security-van/2026-09-20.jsonl', '/config/DEVICE-RECORDINGS/x.jsonl', '/config/device%2Drecordings/x', '/@fs/c/x/config/device-recordings/a.jsonl']) {
    assert.equal(isDeviceFeedStoreRequest(url, { sourceRoot: root }), true, url);
  }
  assert.equal(isDeviceFeedStoreRequest('/config/DEVICE~2/SECURI~1/2026-0~1.JSO', { sourceRoot: root, realpath: () => path.join(root, 'config', 'device-recordings', 'security-van', '2026-09-20.jsonl') }), true, 'a Windows short name');
});

test('record: only a recording device, only this machine, judged by the server’s own position', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-usp-'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, DEVICE_FEED_STORE), JSON.stringify({ version: 1, feeds: [
    { id: 'security-van', kind: 'security', name: 'Van', method: 'http-json', url: 'https://t.example/pos', follow: true, record: true },
    { id: 'tracker-quiet', kind: 'tracker', name: 'Quiet', method: 'http-json', url: 'https://t.example/other' },
  ] }));
  const fetchImpl = async () => new Response(JSON.stringify(SAINT_JOHN), { status: 200, headers: { 'content-type': 'application/json' } });
  const request = harness(deviceFeedsProxy({ sourceRoot: root, fetchImpl }));
  const layers = { flights: [{ id: 'NEAR', lat: 45.3, lon: -66.0 }, { id: 'FAR', lat: 10, lon: 10 }] };

  assert.equal((await request('/record/device-security-van', { method: 'POST', headers: PAGE, body: { layers } })).status, 409, 'no position known yet');
  await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } });

  assert.equal((await request('/record/device-security-van', { method: 'POST', headers: PAGE, body: { layers }, remoteAddress: '192.168.1.9' })).status, 403, 'a LAN peer');
  assert.equal((await request('/record/device-security-van', { method: 'POST', headers: { ...PAGE, 'sec-fetch-site': 'cross-site' }, body: { layers } })).status, 403, 'another website');
  assert.equal((await request('/record/device-tracker-quiet', { method: 'POST', headers: PAGE, body: { layers } })).status, 409, 'recording is off');
  assert.equal((await request('/record/device-nope', { method: 'POST', headers: PAGE, body: { layers } })).status, 404);

  const saved = await request('/record/device-security-van', { method: 'POST', headers: PAGE, body: { layers } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json().saved, 1);
  assert.equal(saved.json().recording.folder, `${DEVICE_RECORDING_DIR}/security-van`);
  assert.equal((await request('/record/device-security-van', { method: 'POST', headers: PAGE, body: { layers } })).status, 429, 'not more often than the floor');

  const folder = path.join(root, DEVICE_RECORDING_DIR, 'security-van');
  const [file] = fs.readdirSync(folder);
  assert.match(file, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  const line = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8').trim());
  assert.deepEqual([line.device, line.kind, line.radiusKm, line.target.lat], ['Van', 'security', 50, SAINT_JOHN.lat]);
  assert.deepEqual(line.layers.flights.map((record) => record.id), ['NEAR']);
  assert.ok(!JSON.stringify(line).includes('t.example'), 'never the device’s address');

  const status = (await request('/status', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  const feed = status.kinds.find((kind) => kind.id === 'security').feeds[0];
  assert.deepEqual([feed.follow, feed.record, feed.recording.files], [true, true, 1]);
  const positions = (await request('/positions', { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  assert.deepEqual(positions.devices.map((device) => [device.id, device.follow, device.record]), [['device-security-van', true, true], ['device-tracker-quiet', false, false]]);
});
