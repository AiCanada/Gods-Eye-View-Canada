import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import {
  RELAY_FRAME_MAX_BYTES,
  RELAY_HEARTBEAT_STALE_MS,
  RELAY_MIN_FRAME_INTERVAL_MS,
  RELAY_PAIRING_CODE_ALPHABET,
  RELAY_PAIR_TTL_MS,
  admitRelayRequest,
  digestAuthorization,
  fetchPrivateFrame,
  isPrivateStoreRequest,
  parseDigestChallenge,
  privateCamerasProxy,
  privateFetchSiteAllowed,
  relayPairingCode,
} from '../server/providers/private-cameras.js';

test('digest authorization matches the RFC 2617 worked example', () => {
  const challenge = parseDigestChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
  );
  const header = digestAuthorization({ uri: '/dir/index.html', username: 'Mufasa', password: 'Circle Of Life', challenge, cnonce: '0a4f113b' });
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
  assert.equal(parseDigestChallenge('Basic realm="x"'), null);
  const combined = parseDigestChallenge('Basic realm="basic-realm", Digest realm="digest-realm", nonce="n1"');
  assert.equal(combined.realm, 'digest-realm', 'a combined header yields the Digest challenge only');
});

const response = (status, headers = {}, body = '') => new Response(body, { status, headers });

test('a password is sent only in answer to a challenge, Digest preferred', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.headers.Authorization || '');
    if (calls.length === 1) return response(401, { 'www-authenticate': 'Basic realm="cam", Digest realm="cam", nonce="abc", qop="auth"' });
    return response(200, { 'content-type': 'image/jpeg' }, 'JPEGDATA');
  };
  const result = await fetchPrivateFrame({ url: 'http://10.0.0.2/snap.jpg?ch=1', auth: { type: 'basic', username: 'admin', password: 'pw' } }, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.body.toString(), 'JPEGDATA');
  assert.deepEqual([calls[0], calls.length], ['', 2], 'the first request carries no password');
  assert.match(calls[1], /^Digest .*uri="\/snap.jpg\?ch=1"/);
});

test('Basic is answered only when the camera asks for it', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.headers.Authorization || '');
    return calls.length === 1 ? response(401, { 'www-authenticate': 'Basic realm="cam"' }) : response(200, { 'content-type': 'image/png' }, 'PNG');
  };
  const result = await fetchPrivateFrame({ url: 'https://nvr.example.com/snap.png', auth: { type: 'basic', username: 'u', password: 'p' } }, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(calls[1], `Basic ${Buffer.from('u:p').toString('base64')}`);
});

test('transport, redirects, refused logins and unsafe content never become frames', async () => {
  let called = false;
  const never = async () => {
    called = true;
    return response(200, { 'content-type': 'image/jpeg' }, 'x');
  };
  const insecure = await fetchPrivateFrame({ url: 'http://cams.example.com/snap.jpg', auth: { type: 'bearer', token: 't' } }, { fetchImpl: never });
  assert.equal(insecure.reason, 'plain http login refused');
  assert.equal(called, false, 'nothing is sent at all');

  const target = { url: 'https://10.0.0.2/snap.jpg', auth: { type: 'bearer', token: 't' } };
  const answer = (reply) => ({
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'manual', 'a login is never replayed to a redirect target');
      return reply;
    },
  });
  assert.equal((await fetchPrivateFrame(target, answer(response(302, { location: 'https://evil.example/' })))).reason, 'redirect refused');
  assert.equal((await fetchPrivateFrame(target, answer(response(403)))).reason, 'login refused');
  assert.equal((await fetchPrivateFrame(target, answer(response(200, { 'content-type': 'text/html' }, '<html>')))).reason, 'not a still image');
  assert.equal((await fetchPrivateFrame(target, answer(response(200, { 'content-type': 'image/svg+xml' }, '<svg onload=alert(1)>')))).reason, 'not a still image', 'SVG could carry script');
});

test('a pinned site goes through the pinned transport and reports a mismatch', async () => {
  let usedPinned = null;
  const pinnedFetchImpl = async (_url, options) => {
    usedPinned = options.fingerprint;
    throw Object.assign(new Error('mismatch'), { code: 'GEV_PIN_MISMATCH' });
  };
  const result = await fetchPrivateFrame(
    { url: 'https://ha.local:8123/api/camera_proxy/camera.privatecam_front', auth: { type: 'bearer', token: 't' }, tlsFingerprint: 'AB:CD' },
    { fetchImpl: async () => assert.fail('the unpinned transport must not be used'), pinnedFetchImpl },
  );
  assert.equal(usedPinned, 'AB:CD');
  assert.equal(result.reason, 'certificate pin mismatch');
});

test('fetch metadata: only same-origin and direct requests pass', () => {
  assert.equal(privateFetchSiteAllowed({}), true);
  assert.equal(privateFetchSiteAllowed({ 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(privateFetchSiteAllowed({ 'sec-fetch-site': 'none' }), true);
  assert.equal(privateFetchSiteAllowed({ 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(privateFetchSiteAllowed({ 'sec-fetch-site': 'same-site' }), false);
});

function install(plugin, hook = 'configureServer') {
  let handler;
  plugin[hook]({ middlewares: { use: (_route, fn) => { handler = fn; } } });
  return (url, { remoteAddress = '127.0.0.1', headers = {}, method = 'GET' } = {}) =>
    new Promise((resolve) => {
      const res = {
        writeHead(status, responseHeaders) { Object.assign(this, { status, headers: responseHeaders }); },
        end(body) { resolve({ status: this.status, headers: this.headers, body: String(body ?? '') }); },
      };
      handler({ url, method, headers: { host: 'localhost:4173', ...headers }, socket: { remoteAddress }, on() {} }, res);
    });
}

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-private-cams-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'private-cameras.json'), JSON.stringify({
    version: 2,
    sites: [{
      id: 'shop',
      kind: 'business',
      name: 'Shop',
      username: 'admin',
      password: 'hunter2',
      cameras: [{ id: 'dock', name: 'Dock', source: 'http://10.0.0.2/snap.jpg', lat: 45, lon: -66, headingDeg: 180 }],
    }],
  }));
  return root;
}

test('private routes answer only this machine, refuse other sites and never reveal logins', async (t) => {
  const root = fixtureRoot(t);
  let upstreamCalls = 0;
  const request = install(privateCamerasProxy({
    sourceRoot: root,
    fetchImpl: async () => {
      upstreamCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response(200, { 'content-type': 'image/jpeg' }, 'IMG');
    },
  }));
  assert.equal((await request('/sources', { remoteAddress: '192.168.1.20' })).status, 403, 'a LAN peer is refused');
  assert.equal((await request('/sources', { headers: { host: 'example.com' } })).status, 403, 'a foreign Host is refused');
  assert.equal((await request('/sources', { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 403, 'a proxied request is refused');
  assert.equal((await request('/frame/private-shop--dock', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'another website cannot embed a frame');

  const sources = await request('/sources', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(sources.status, 200);
  assert.equal(sources.headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.match(sources.headers['Cache-Control'], /no-store/);
  assert.deepEqual(JSON.parse(sources.body).sources.map((source) => source.id), ['private-shop--dock']);
  for (const leaked of ['hunter2', 'admin', '10.0.0.2']) assert.equal(sources.body.includes(leaked), false, leaked);

  const status = await request('/status');
  assert.equal(JSON.parse(status.body).editable, true);
  assert.equal(status.body.includes('hunter2'), false);

  const [first, second] = await Promise.all([request('/frame/private-shop--dock'), request('/frame/private-shop--dock')]);
  assert.equal(first.headers['X-Private-Camera'], 'live');
  assert.equal(second.body, 'IMG');
  assert.equal(upstreamCalls, 1, 'simultaneous requests share one camera fetch');
  assert.equal(first.headers['Cross-Origin-Resource-Policy'], 'same-origin');
  const missing = await request('/frame/private-shop--nope');
  assert.equal(missing.headers['X-Private-Camera'], 'offline');
  assert.match(missing.headers['Content-Security-Policy'], /default-src 'none'/);
});

test('the preview server lists cameras but refuses edits', async (t) => {
  const root = fixtureRoot(t);
  const request = install(privateCamerasProxy({ sourceRoot: root }), 'configurePreviewServer');
  assert.equal(JSON.parse((await request('/status')).body).editable, false);
});

test('the Private_CCTV_Feed website is never contacted or sent a login', async () => {
  let requests = 0;
  const refuse = async () => {
    requests += 1;
    throw new Error('must not be called');
  };
  const result = await fetchPrivateFrame(
    { url: 'https://feed.private-cctv.example/#/feed', auth: { type: 'basic', username: 'someone@example.com', password: 'secret' } },
    { fetchImpl: refuse, pinnedFetchImpl: refuse },
  );
  assert.deepEqual(result, { ok: false, reason: 'private_cctv_feed needs a local bridge' });
  assert.equal(requests, 0);
});

test('a camera still pointing at the Private_CCTV_Feed website is told about the browser feed relay as well as a bridge', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-private-cams-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'private-cameras.json'), JSON.stringify({
    version: 2,
    sites: [{ id: 'home', kind: 'home', name: 'Home', auth: 'login', username: 'owner@example.com', password: 'feed-password', lat: 45, lon: -66, cameras: [{ id: 'front', name: 'Front', source: 'https://feed.private-cctv.example/#/feed' }] }],
  }));
  const never = async () => assert.fail('the Private_CCTV_Feed website is never contacted');
  const offline = await install(privateCamerasProxy({ sourceRoot: root, fetchImpl: never, pinnedFetchImpl: never }))('/frame/private-home--front');
  assert.equal(offline.headers['X-Private-Camera'], 'offline');
  assert.match(offline.body, /PRIVATE CAMERA · PRIVATE_CCTV_FEED NEEDS A LOCAL BRIDGE/);
  const hint = /<text[^>]*font-size="18"[^>]*>([^<]*)<\/text>/.exec(offline.body)?.[1];
  assert.equal(hint, 'Choose Browser feed relay, or set up a local bridge, in POWER UP');
  assert.ok(hint.length <= 80, 'the hint fits the 960 px placeholder');
});

test('the credential store is never served as a static file, however the URL spells it', () => {
  const refused = [
    '/config/private-cameras.json',
    '/CONFIG/Private-Cameras.JSON',
    '/config/private-cameras.json?raw',
    '/config/private-cameras.json?import',
    '/config/private%2Dcameras.json',
    '/config/private-cameras.json.',
    '/config/private-cameras.json::$DATA',
    '/config/.private-cameras.json.1234.tmp',
    '/@fs/C:/Projects/gev/config/private-cameras.json',
    '/@fs/c:/Projects%20Local/gev/config/private-cameras.json',
    '/config/private-cameras.json%',
  ];
  for (const url of refused) assert.equal(isPrivateStoreRequest(url, { sourceRoot: 'A:/repo', realpath: () => 'A:/repo/src/main.js' }), true, url);
  const allowed = ['/src/main.js', '/config/cctv_sources.canada.json', '/api/private-cams/status', '/', '/index.html?x=1'];
  for (const url of allowed) assert.equal(isPrivateStoreRequest(url, { sourceRoot: 'A:/repo', realpath: () => { throw new Error('not a short name'); } }), false, url);

  // A Windows short name is resolved to its real file before deciding.
  const resolved = [];
  const shortName = isPrivateStoreRequest('/config/PRIVAT~1.JSO', { sourceRoot: '/repo', realpath: (file) => (resolved.push(file), '/repo/config/private-cameras.json') });
  assert.equal(shortName, true);
  assert.match(resolved[0].replace(/\\/g, '/'), /config\/PRIVAT~1\.JSO$/);
  assert.equal(isPrivateStoreRequest('/PROGRA~1/app.js', { sourceRoot: '/repo', realpath: () => '/repo/Program Files/app.js' }), false);
  assert.equal(isPrivateStoreRequest('/missing~1.js', { sourceRoot: '/repo', realpath: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } }), false);
});

test('the store guard is the first middleware on both the dev and the preview server', async () => {
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const uses = [];
    privateCamerasProxy({ sourceRoot: os.tmpdir() })[hook]({ middlewares: { use: (...args) => uses.push(args) } });
    assert.equal(uses[0].length, 1, `${hook}: the guard has no route prefix, so it sees every request`);
    const guard = uses[0][0];
    const answer = (url) =>
      new Promise((resolve) => {
        const res = {
          writeHead(status, headers) { Object.assign(this, { status, headers }); },
          end(body) { resolve({ status: this.status, headers: this.headers, body: String(body ?? '') }); },
        };
        guard({ url, method: 'GET', headers: {} }, res, () => resolve({ next: true }));
      });
    const blocked = await answer('/CONFIG/Private-Cameras.JSON?raw');
    assert.equal(blocked.status, 404, hook);
    assert.match(blocked.headers['Cache-Control'] || blocked.headers['cache-control'] || '', /no-store/);
    assert.doesNotMatch(blocked.body, /password|username|sites/i);
    assert.deepEqual(await answer('/src/main.js'), { next: true }, `${hook}: other files pass through`);
  }
});

// ---------------------------------------------------------------------------
// GEV Private_CCTV_Feed Relay
// ---------------------------------------------------------------------------

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const PAGE_ORIGIN = 'http://localhost:4173';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF clip picture')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png clip picture')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 clip')]);

/** A pairing secret as the extension makes it, and the hash the server keeps. */
function secretPair() {
  const secret = randomBytes(32).toString('base64url');
  return { secret, hash: createHash('sha256').update(secret, 'utf8').digest('hex') };
}
const RELAY = secretPair();

/**
 * Drive the /api/private-cams handler with a streaming request: the body only
 * flows once something listens for 'data', exactly like a Node request, so a
 * test can tell whether the body was read at all. Every response is checked
 * for CORS headers, which no route may ever send.
 */
function relayHarness(plugin, hook = 'configureServer') {
  let handler;
  plugin[hook]({ middlewares: { use: (...args) => { handler = args[args.length - 1]; } } });
  return (url, { method = 'GET', headers = {}, remoteAddress = '127.0.0.1', body, truncate = false } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const req = new EventEmitter();
      Object.assign(req, { url, method, headers: { host: 'localhost:4173', ...headers }, socket: { remoteAddress }, destroyed: false, bodyRead: false });
      req.destroy = () => { req.destroyed = true; };
      req.on('newListener', (event) => {
        if (event !== 'data' || req.bodyRead) return;
        req.bodyRead = true;
        setImmediate(() => {
          for (let offset = 0; payload && offset < payload.length && !req.destroyed; offset += 65536) req.emit('data', payload.subarray(offset, offset + 65536));
          if (!req.destroyed && !truncate) req.emit('end');
          req.emit('close');
        });
      });
      const res = {
        writeHead(status, responseHeaders = {}) { Object.assign(this, { status, headers: responseHeaders }); },
        end(chunk) {
          const sent = this.headers || {};
          const cors = Object.keys(sent).filter((name) => /^access-control-/i.test(name));
          if (cors.length) return reject(new Error(`CORS header sent: ${cors.join(', ')}`));
          const bytes = chunk === undefined ? Buffer.alloc(0) : Buffer.from(chunk);
          return resolve({ status: this.status, headers: sent, bytes, body: bytes.toString('utf8'), json: () => JSON.parse(bytes.toString('utf8')), req });
        },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
}

const extensionHeaders = ({ origin = `chrome-extension://${EXTENSION_ID}`, secret = RELAY.secret } = {}) => ({
  'sec-fetch-site': 'none',
  ...(origin === null ? {} : { origin }),
  ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
});
const pageHeaders = (extra = {}) => ({ origin: PAGE_ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...extra });
const sendFrame = (request, camera, { bytes = JPEG, type = 'image/jpeg', clip, headers = {}, ...options } = {}) =>
  request('/relay/frame', {
    method: 'POST',
    body: bytes,
    headers: { ...extensionHeaders(), 'x-private-cctv-feed-camera': encodeURIComponent(camera), ...(clip === undefined ? {} : { 'x-private-cctv-feed-clip': encodeURIComponent(clip) }), 'content-type': type, 'content-length': String(bytes.length), ...headers },
    ...options,
  });
const sendHeartbeat = (request, state = 'feed', seen = ['front', 'ff'], headers = {}, extra = {}) =>
  request('/relay/heartbeat', { method: 'POST', body: { state, seen, ...extra }, headers: { ...extensionHeaders(), 'content-type': 'application/json', ...headers } });
/** Opaque tags the extension puts on heartbeats, one per feed.private-cctv.example tab. */
const FEED_TAB = { reporter: '0123456789abcdef' };
const OTHER_TAB = { reporter: 'fedcba9876543210' };
const offlineReason = (response) => /PRIVATE CAMERA · ([A-Z ]+)</.exec(response.body)?.[1];
const readStore = (root) => JSON.parse(fs.readFileSync(path.join(root, 'config', 'private-cameras.json'), 'utf8'));

function relayRoot(t, { paired = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-private-cctv-feed-relay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'private-cameras.json'), JSON.stringify({
    version: 2,
    sites: [
      {
        id: 'home',
        kind: 'home',
        name: 'Home',
        auth: 'relay',
        username: 'owner@example.com',
        password: 'feed-password',
        lat: 45.27,
        lon: -66.06,
        ...(paired ? { relayExtensionId: EXTENSION_ID, relaySecretHash: RELAY.hash } : {}),
        cameras: [
          { id: 'front', name: 'Front', source: '', headingDeg: 180 },
          { id: 'ff', name: 'Ff', source: 'https://feed.private-cctv.example/#/feed', headingDeg: 90 },
          { id: 'back-yard', name: 'Back Yard', source: '', headingDeg: 0 },
        ],
      },
      { id: 'shop', kind: 'business', name: 'Shop', username: 'admin', password: 'hunter2', cameras: [{ id: 'dock', name: 'Dock', source: 'http://10.0.0.2/snap.jpg', lat: 45, lon: -66 }] },
    ],
  }));
  return root;
}

test('relay admission: this machine, a browser extension, and nothing else', () => {
  const post = (headers = {}, extra = {}) =>
    admitRelayRequest({ method: 'POST', headers: { host: 'localhost:4173', 'sec-fetch-site': 'none', origin: `chrome-extension://${EXTENSION_ID}`, ...headers }, socket: { remoteAddress: '127.0.0.1' }, ...extra });
  const get = (headers = {}) => admitRelayRequest({ method: 'GET', headers: { host: '127.0.0.1:4173', 'sec-fetch-site': 'none', ...headers }, socket: { remoteAddress: '::1' } });
  assert.deepEqual(post(), { ok: true, extensionId: EXTENSION_ID });
  assert.deepEqual(get(), { ok: true, extensionId: null }, 'a GET from the service worker carries no Origin');
  assert.deepEqual(get({ origin: `chrome-extension://${EXTENSION_ID}` }), { ok: true, extensionId: EXTENSION_ID });
  const refusals = [
    ['a LAN peer', post({}, { socket: { remoteAddress: '192.168.1.20' } })],
    ['a foreign Host', post({ host: 'example.com' })],
    ['an X-Forwarded-For header', post({ 'x-forwarded-for': '1.2.3.4' })],
    ['a Forwarded header', post({ forwarded: 'for=1.2.3.4' })],
    ['a Cloudflare header', post({ 'cf-connecting-ip': '1.2.3.4' })],
    ['a same-origin web page', post({ 'sec-fetch-site': 'same-origin', origin: PAGE_ORIGIN })],
    ['a cross-site page', post({ 'sec-fetch-site': 'cross-site' })],
    ['no fetch metadata at all', post({ 'sec-fetch-site': undefined })],
    ['Sec-Fetch-Site spelled differently', post({ 'sec-fetch-site': 'None' })],
    ['a POST without Origin', post({ origin: undefined })],
    ['a POST with an empty Origin', post({ origin: '' })],
    ['the page origin', post({ origin: PAGE_ORIGIN })],
    ['a Firefox extension origin', post({ origin: `moz-extension://${EXTENSION_ID}` })],
    ['an extension id outside a-p', post({ origin: `chrome-extension://${'q'.repeat(32)}` })],
    ['an upper-case extension id', post({ origin: `chrome-extension://${EXTENSION_ID.toUpperCase()}` })],
    ['a short extension id', post({ origin: `chrome-extension://${EXTENSION_ID.slice(1)}` })],
    ['an extension origin with a path', post({ origin: `chrome-extension://${EXTENSION_ID}/` })],
    ['a GET with a web page Origin', get({ origin: PAGE_ORIGIN })],
    ['a GET from a page', get({ 'sec-fetch-site': 'same-origin' })],
    ['a preflight', post({}, { method: 'OPTIONS' })],
    ['a PUT', post({}, { method: 'PUT' })],
  ];
  for (const [label, verdict] of refusals) {
    assert.equal(verdict.ok, false, label);
    assert.equal(verdict.status, 403, label);
  }
  const previous = process.env.PINOKIO_SHARE_LOCAL;
  process.env.PINOKIO_SHARE_LOCAL = '1';
  try {
    assert.equal(post().ok, false, 'a sharing mode turns the relay off');
  } finally {
    if (previous === undefined) delete process.env.PINOKIO_SHARE_LOCAL;
    else process.env.PINOKIO_SHARE_LOCAL = previous;
  }
});

test('relay routes refuse preflights, web pages and other machines without reading a body or sending CORS headers', async (t) => {
  const root = relayRoot(t);
  const never = async () => assert.fail('a relay camera is never fetched');
  const request = relayHarness(privateCamerasProxy({ sourceRoot: root, fetchImpl: never, pinnedFetchImpl: never }));
  for (const route of ['/relay/frame', '/relay/pair-request', '/relay/pair-status', '/relay/heartbeat', '/relay/approve', '/relay/unpair']) {
    const preflight = await request(route, {
      method: 'OPTIONS',
      headers: { origin: `chrome-extension://${EXTENSION_ID}`, 'sec-fetch-site': 'none', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,x-private-cctv-feed-camera' },
    });
    assert.equal(preflight.status, 403, route);
  }
  const unread = (response, status, label) => {
    assert.equal(response.status, status, label);
    assert.equal(response.req.bodyRead, false, `${label}: the body is never read`);
    assert.equal(response.req.destroyed, true, `${label}: the request is dropped`);
  };
  unread(await sendFrame(request, 'front', { remoteAddress: '192.168.1.20' }), 403, 'a LAN peer');
  unread(await sendFrame(request, 'front', { headers: { 'x-forwarded-for': '1.2.3.4' } }), 403, 'a proxied request');
  unread(await sendFrame(request, 'front', { headers: { host: 'evil.example:4173' } }), 403, 'a foreign Host');
  unread(await sendFrame(request, 'front', { headers: { origin: PAGE_ORIGIN, 'sec-fetch-site': 'same-origin' } }), 403, 'the app page itself');
  unread(await sendFrame(request, 'front', { headers: { origin: undefined } }), 403, 'no Origin');
  unread(await sendFrame(request, 'front', { headers: { 'sec-fetch-site': 'cross-site' } }), 403, 'another website');
  unread(await sendFrame(request, 'front', { headers: { 'sec-fetch-site': undefined } }), 403, 'no fetch metadata');
  assert.equal((await request('/relay/frame', { headers: extensionHeaders({ origin: null }) })).status, 405, 'a picture is only ever POSTed');
  const pairStatusFromPage = await request('/relay/pair-status', { headers: { ...extensionHeaders({ origin: null }), 'sec-fetch-site': 'same-origin' } });
  assert.equal(pairStatusFromPage.status, 403);
  // The ordinary routes still refuse the extension's origin.
  assert.equal((await request('/sources', { headers: { origin: `chrome-extension://${EXTENSION_ID}`, 'sec-fetch-site': 'none' } })).status, 403);
  assert.equal((await request('/frame/private-home--front', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
});

test('pairing: a request waits two minutes for approval in POWER UP and is rate limited', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const root = relayRoot(t, { paired: false });
  const request = relayHarness(privateCamerasProxy({ sourceRoot: root }));
  const pending = secretPair();
  const pairRequest = (body, headers = {}) =>
    request('/relay/pair-request', { method: 'POST', body, headers: { ...extensionHeaders({ secret: null }), 'content-type': 'application/json', ...headers } });
  const pairStatus = (secret, headers = {}) => request('/relay/pair-status', { headers: { ...extensionHeaders({ origin: null, secret }), ...headers } });

  const badBodies = [
    { secretHash: pending.hash.toUpperCase() },
    { secretHash: pending.hash.slice(1) },
    { secretHash: 42 },
    { code: 'ABC234' },
    'not json',
    [],
  ];
  for (const body of badBodies) assert.equal((await pairRequest(body)).status, 400, JSON.stringify(body));
  const declaredTooLarge = await pairRequest({ secretHash: pending.hash }, { 'content-length': '5000' });
  assert.deepEqual([declaredTooLarge.status, declaredTooLarge.req.bodyRead], [413, false]);
  assert.equal((await pairRequest({ secretHash: pending.hash, padding: 'x'.repeat(5000) })).status, 413);
  assert.equal((await pairRequest({ secretHash: pending.hash }, { origin: undefined })).status, 403, 'a pairing request comes from an extension');
  assert.deepEqual((await request('/status')).json().relayPending, []);

  t.mock.timers.tick(60_000);
  // GEV issues the code: a code the extension sends, well-formed or not, is ignored.
  const accepted = await pairRequest({ secretHash: pending.hash, code: 'not a code' });
  assert.equal(accepted.status, 202);
  const { code } = accepted.json();
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.deepEqual(accepted.json(), { pending: true, code, expiresInSeconds: 120 });
  const status = await request('/status');
  assert.deepEqual(status.json().relayPending, [{ extensionId: EXTENSION_ID, code, expiresInSeconds: 120 }]);
  assert.equal(status.body.includes(pending.hash), false, 'the secret hash is never shown');

  assert.deepEqual([(await pairStatus(pending.secret)).status, (await pairStatus(pending.secret)).json()], [200, { paired: false, pending: true }]);
  assert.deepEqual((await pairStatus(pending.secret, { origin: `chrome-extension://${EXTENSION_ID}` })).json(), { paired: false, pending: true });
  for (const [label, secret] of [['a stranger', secretPair().secret], ['no secret', null], ['a malformed secret', 'short']]) {
    const refused = await pairStatus(secret);
    assert.deepEqual([refused.status, refused.json()], [401, { paired: false }], label);
  }
  assert.equal((await request('/relay/pair-status', { headers: { 'sec-fetch-site': 'none', authorization: `Bearer ${'a'.repeat(200)}` } })).status, 401, 'an overlong header');
  assert.equal((await pairStatus(pending.secret, { origin: PAGE_ORIGIN })).status, 403);

  t.mock.timers.tick(RELAY_PAIR_TTL_MS);
  assert.equal((await pairStatus(pending.secret)).status, 401, 'an unapproved request expires');
  assert.deepEqual((await request('/status')).json().relayPending, []);

  t.mock.timers.tick(60_000);
  for (let i = 1; i <= 10; i += 1) assert.equal((await pairRequest({ secretHash: pending.hash })).status, 202, `request ${i}`);
  const limited = await pairRequest({ secretHash: pending.hash });
  assert.deepEqual([limited.status, limited.req.bodyRead], [429, false], 'the eleventh request in a minute is refused unread');
  const other = secretPair();
  assert.equal((await pairRequest({ secretHash: other.hash }, { origin: `chrome-extension://${OTHER_EXTENSION_ID}` })).status, 202, 'the limit is per extension, so another cannot use it up');
  t.mock.timers.tick(60_000);
  assert.equal((await pairRequest({ secretHash: pending.hash })).status, 202, 'the limit is per minute');
});

test('pairing codes are issued by the server, unbiased, from the unambiguous alphabet and never one already waiting', () => {
  assert.equal(RELAY_PAIRING_CODE_ALPHABET, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  const draws = [];
  const scripted = (values) => (max) => {
    draws.push(max);
    return values.shift();
  };
  assert.equal(relayPairingCode([], scripted([0, 1, 2, 3, 30, 31])), 'ABCD89');
  assert.deepEqual(draws, [32, 32, 32, 32, 32, 32], 'each letter is one uniform draw over all 32');
  assert.equal(relayPairingCode(new Set(['AAAAAA']), scripted([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24])), 'AAAAA2', 'a code already waiting is drawn again');
  for (let round = 0; round < 200; round += 1) assert.match(relayPairingCode(), /^[A-HJ-NP-Z2-9]{6}$/);
  assert.throws(() => relayPairingCode(['AAAAAA'], () => 0), /no free pairing code/);
});

test('pairing: GEV issues every code, so another extension can neither copy a code, take over nor push out a waiting request', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  const root = relayRoot(t, { paired: false });
  const request = relayHarness(privateCamerasProxy({ sourceRoot: root }));
  const pairRequest = (secretHash, extensionId = EXTENSION_ID, extra = {}) =>
    request('/relay/pair-request', { method: 'POST', body: { secretHash, ...extra }, headers: { ...extensionHeaders({ origin: `chrome-extension://${extensionId}`, secret: null }), 'content-type': 'application/json' } });
  const approve = (body) => request('/relay/approve', { method: 'POST', body, headers: pageHeaders() });
  const real = secretPair();
  const hostile = secretPair();

  const realRequest = await pairRequest(real.hash);
  assert.equal(realRequest.status, 202);
  const realCode = realRequest.json().code;
  // Another extension reads the waiting code from /status and asks with that code and its own secret.
  const shown = (await request('/status')).json().relayPending;
  assert.deepEqual(shown, [{ extensionId: EXTENSION_ID, code: realCode, expiresInSeconds: 120 }]);
  const copycat = await pairRequest(hostile.hash, OTHER_EXTENSION_ID, { code: shown[0].code });
  assert.equal(copycat.status, 202);
  const hostileCode = copycat.json().code;
  assert.notEqual(hostileCode, realCode, 'the copied code is ignored, and GEV never issues a code another waiting request shows');
  assert.deepEqual((await request('/status')).json().relayPending.map((pending) => [pending.extensionId, pending.code]).sort(), [[EXTENSION_ID, realCode], [OTHER_EXTENSION_ID, hostileCode]].sort());
  const pendingStatus = (secret) => request('/relay/pair-status', { headers: extensionHeaders({ origin: null, secret }) });
  assert.equal((await pendingStatus(real.secret)).json().pending, true, "the real request is still waiting");

  assert.equal((await approve({ siteId: 'home', code: realCode })).status, 409, 'an approval names the extension');
  const wrongExtension = await approve({ siteId: 'home', code: realCode, extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.deepEqual([wrongExtension.status, wrongExtension.json().error], [409, 'No pairing request from that extension is waiting — press PAIR WITH GODS EYE VIEW on the relay options page again']);
  assert.equal((await approve({ siteId: 'home', code: realCode, extensionId: OTHER_EXTENSION_ID })).status, 409, "the real request's code with the other extension's id");
  assert.equal((await approve({ siteId: 'home', code: hostileCode, extensionId: EXTENSION_ID })).status, 409, "the other request's code with the real extension's id");
  assert.equal((await approve({ siteId: 'home', extensionId: EXTENSION_ID })).status, 409, 'an approval names the code');
  assert.equal(readStore(root).sites[0].relaySecretHash, undefined, 'a refused approval pairs nothing');
  const approved = await approve({ siteId: 'home', code: realCode, extensionId: EXTENSION_ID });
  assert.deepEqual([approved.status, approved.json()], [200, { ok: true, extensionId: EXTENSION_ID }]);
  const stored = readStore(root).sites[0];
  assert.deepEqual([stored.relayExtensionId, stored.relaySecretHash], [EXTENSION_ID, real.hash], 'exactly the request that was compared is paired');
  assert.deepEqual((await request('/status')).json().relayPending, [], 'every other waiting request has to ask again');
  assert.equal((await pendingStatus(hostile.secret)).status, 401);
  assert.equal((await pendingStatus(real.secret)).json().paired, true);

  // Each extension has one slot, only four extensions may wait at once, and each waiting request has its own code.
  const ids = ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccccccccccc', 'dddddddddddddddddddddddddddddddd', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];
  const codes = [];
  for (const id of ids) {
    const waiting = await pairRequest(secretPair().hash, id, { code: 'ABC234' });
    assert.equal(waiting.status, 202, id);
    codes.push(waiting.json().code);
  }
  assert.equal(new Set(codes).size, ids.length, 'no two waiting requests show the same code');
  assert.equal((await pairRequest(secretPair().hash, 'ffffffffffffffffffffffffffffffff')).status, 429);
  const replaced = await pairRequest(secretPair().hash, ids[0]);
  assert.equal(replaced.status, 202, 'an extension may replace its own request');
  assert.equal(codes.includes(replaced.json().code), false, 'and gets a new code for it');
  assert.deepEqual((await request('/status')).json().relayPending.map((pending) => pending.code).sort(), [replaced.json().code, ...codes.slice(1)].sort());
});

test('approval goes through the POWER UP gate and stores only the extension id and the secret hash', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  const root = relayRoot(t, { paired: false });
  const request = relayHarness(privateCamerasProxy({ sourceRoot: root }));
  const preview = relayHarness(privateCamerasProxy({ sourceRoot: root }), 'configurePreviewServer');
  const pending = secretPair();
  /** Ask to be paired; the code is the one GEV issued. */
  const pairRequest = async (secretHash) => {
    const answer = await request('/relay/pair-request', { method: 'POST', body: { secretHash }, headers: { ...extensionHeaders({ secret: null }), 'content-type': 'application/json' } });
    assert.equal(answer.status, 202, answer.body);
    return answer.json().code;
  };
  const approve = (body, headers = {}, via = request) => via('/relay/approve', { method: 'POST', body: { extensionId: EXTENSION_ID, ...body }, headers: pageHeaders(headers) });

  const nothingWaiting = await approve({ siteId: 'home', code: 'ABC234' });
  assert.equal(nothingWaiting.status, 409);
  assert.match(nothingWaiting.json().error, /No pairing request/);
  const code = await pairRequest(pending.hash);
  const otherCode = code === 'ABC234' ? 'ABC235' : 'ABC234';

  assert.equal((await approve({ siteId: 'home', code }, { origin: `chrome-extension://${EXTENSION_ID}`, 'sec-fetch-site': 'none' })).status, 403, 'the extension cannot approve itself');
  assert.equal((await approve({ siteId: 'home', code }, { origin: 'http://evil.example' })).status, 403, 'another website');
  assert.equal((await approve({ siteId: 'home', code }, { origin: undefined })).status, 403, 'no Origin');
  assert.equal((await approve({ siteId: 'home', code }, { 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site fetch metadata');
  assert.equal((await approve({ siteId: 'home', code }, { 'content-type': 'text/plain' })).status, 415, 'a simple form post');
  assert.equal((await request('/relay/approve', { method: 'POST', body: { siteId: 'home', code, extensionId: EXTENSION_ID }, headers: pageHeaders(), remoteAddress: '192.168.1.9' })).status, 403, 'a LAN peer');
  assert.equal((await approve({ siteId: 'home', code }, {}, preview)).status, 403, 'the preview server never pairs');
  const mismatch = await approve({ siteId: 'home', code: otherCode });
  assert.equal(mismatch.status, 409);
  assert.match(mismatch.json().error, /does not match/);
  assert.equal((await approve({ siteId: 'home', code, extensionId: OTHER_EXTENSION_ID })).status, 409, 'the right code from another extension');
  assert.equal((await approve({ siteId: 'home', code, extensionId: undefined })).status, 409, 'no extension id');
  assert.match((await approve({ siteId: 'shop', code })).json().error, /Browser feed relay/);
  assert.equal((await approve({ siteId: 'ghost', code })).status, 400);
  assert.equal(readStore(root).sites[0].relaySecretHash, undefined, 'nothing was written by a refused approval');

  const approved = await approve({ siteId: 'home', code });
  assert.equal(approved.status, 200, approved.body);
  assert.deepEqual(approved.json(), { ok: true, extensionId: EXTENSION_ID });
  const store = readStore(root);
  const stored = store.sites.find((site) => site.id === 'home');
  assert.deepEqual([stored.relayExtensionId, stored.relaySecretHash], [EXTENSION_ID, pending.hash]);
  assert.deepEqual([stored.username, stored.password], ['owner@example.com', 'feed-password'], 'the saved Private_CCTV_Feed login is kept');
  assert.equal(JSON.stringify(store).includes(pending.secret), false, 'the secret itself is never stored');

  const status = await request('/status');
  for (const hidden of [pending.hash, pending.secret, 'feed-password', 'owner@example.com']) assert.equal(status.body.includes(hidden), false, hidden);
  const home = status.json().kinds[0].sites[0];
  assert.deepEqual(home.relay, { paired: true, extensionId: EXTENSION_ID, state: null, lastHeartbeatAt: null, connected: false, unknownNames: [] });
  assert.deepEqual(home.cameras.map((camera) => [camera.matchName, camera.lastFrameAt, camera.lastClip]), [['front', null, ''], ['ff', null, ''], ['back yard', null, '']]);
  assert.equal(status.json().kinds[1].sites[0].relay, null);
  assert.deepEqual(status.json().relayPending, [], 'an approved request is used up');
  assert.equal((await approve({ siteId: 'home', code })).status, 409, 'and cannot be approved twice');

  const paired = await request('/relay/pair-status', { headers: extensionHeaders({ origin: null, secret: pending.secret }) });
  assert.deepEqual([paired.status, paired.json()], [200, { paired: true, siteName: 'Home', cameras: ['Front', 'Ff', 'Back Yard'] }]);
  assert.equal((await sendFrame(request, 'front', { headers: { authorization: `Bearer ${pending.secret}` } })).status, 204);

  const lateCode = await pairRequest(secretPair().hash);
  t.mock.timers.tick(RELAY_PAIR_TTL_MS);
  assert.equal((await approve({ siteId: 'home', code: lateCode })).status, 409, 'an expired request cannot be approved');
  assert.equal(readStore(root).sites[0].relaySecretHash, pending.hash, 'the approved pairing stays');
});

test('relay pictures: every check happens before the body is read, and an accepted picture is served', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 9_000_000 });
  const logged = [];
  for (const method of ['log', 'info', 'warn', 'error']) t.mock.method(console, method, (...args) => logged.push(args.map(String).join(' ')));
  const root = relayRoot(t);
  const never = async () => assert.fail('a relay camera is never fetched');
  const request = relayHarness(privateCamerasProxy({ sourceRoot: root, fetchImpl: never, pinnedFetchImpl: never }));
  const unread = (response, status, label) => {
    assert.equal(response.status, status, label);
    assert.equal(response.req.bodyRead, false, `${label}: the body is never read`);
    assert.equal(response.req.destroyed, true, `${label}: the request is dropped`);
    assert.equal(response.headers.Connection, 'close', label);
  };
  unread(await sendFrame(request, 'front', { headers: { authorization: `Bearer ${secretPair().secret}` } }), 401, 'an unknown secret');
  unread(await sendFrame(request, 'front', { headers: { authorization: undefined } }), 401, 'no secret');
  unread(await sendFrame(request, 'front', { headers: { authorization: `Basic ${RELAY.secret}` } }), 401, 'not a bearer');
  unread(await sendFrame(request, 'front', { headers: { authorization: `Bearer ${RELAY.hash}` } }), 401, 'the hash is not the secret');
  unread(await sendFrame(request, 'front', { headers: { origin: `chrome-extension://${OTHER_EXTENSION_ID}` } }), 403, 'another extension holding the secret');
  unread(await sendFrame(request, 'front', { headers: { 'x-private-cctv-feed-camera': undefined } }), 400, 'no camera name');
  unread(await sendFrame(request, 'front', { headers: { 'x-private-cctv-feed-camera': '%E0%A4%A' } }), 400, 'a broken escape');
  unread(await sendFrame(request, 'front\u0007'), 400, 'a control character');
  unread(await sendFrame(request, 'x'.repeat(201)), 400, 'a camera name over 200 characters');
  unread(await sendFrame(request, '   '), 400, 'a blank camera name');
  unread(await sendFrame(request, 'front', { clip: 'c'.repeat(81) }), 400, 'a clip label over 80 characters');
  unread(await sendFrame(request, 'front', { clip: 'Motion\n' }), 400, 'a clip label with a line break');
  unread(await sendFrame(request, 'front', { type: 'image/gif' }), 415, 'a GIF');
  unread(await sendFrame(request, 'front', { type: 'image/svg+xml' }), 415, 'an SVG');
  unread(await sendFrame(request, 'front', { type: 'image/jpeg; charset=binary' }), 415, 'a Content-Type with parameters');
  unread(await sendFrame(request, 'front', { headers: { 'content-type': undefined } }), 415, 'no Content-Type');
  unread(await sendFrame(request, 'front', { headers: { 'content-length': undefined } }), 411, 'no Content-Length');
  unread(await sendFrame(request, 'front', { headers: { 'content-length': undefined, 'transfer-encoding': 'chunked' } }), 411, 'a chunked upload');
  unread(await sendFrame(request, 'front', { headers: { 'content-length': String(RELAY_FRAME_MAX_BYTES + 1) } }), 413, 'a picture declared over 8 MiB');

  const lying = await sendFrame(request, 'front', { bytes: Buffer.concat([JPEG, Buffer.alloc(RELAY_FRAME_MAX_BYTES)]), headers: { 'content-length': '100' } });
  assert.deepEqual([lying.status, lying.req.destroyed], [413, true], 'a body longer than the cap is cut off while streaming');
  assert.equal((await sendFrame(request, 'front', { headers: { 'content-length': String(JPEG.length + 10) } })).status, 400, 'a body shorter than declared');
  assert.equal((await sendFrame(request, 'front', { truncate: true })).status, 400, 'an upload that never finished');
  assert.equal((await sendFrame(request, 'front', { type: 'image/png' })).status, 415, 'JPEG bytes labelled PNG');
  assert.equal((await sendFrame(request, 'front', { bytes: Buffer.from('RIFF0000AVI clip'), type: 'image/webp' })).status, 415, 'a RIFF file that is not WebP');
  assert.equal((await sendFrame(request, 'front', { bytes: Buffer.from('<svg onload=alert(1)>'), type: 'image/jpeg' })).status, 415, 'markup labelled JPEG');

  for (const name of ['garage', 'Garage ', 'porch', 'side', 'driveway', 'shed', 'attic']) {
    const unknown = await sendFrame(request, name);
    assert.deepEqual([unknown.status, unknown.json()], [404, { error: 'Unknown camera name' }], name);
  }
  assert.deepEqual((await request('/status')).json().kinds[0].sites[0].relay.unknownNames, ['porch', 'side', 'driveway', 'shed', 'attic'], 'the newest five distinct names are remembered');

  const accepted = await sendFrame(request, '  FRONT ', { clip: 'Person · 13 · 2:14 PM' });
  assert.equal(accepted.status, 204, accepted.body);
  const served = await request('/frame/private-home--front');
  assert.equal(served.status, 200);
  assert.equal(served.headers['Content-Type'], 'image/jpeg');
  assert.equal(served.headers['X-Private-Camera'], 'relay');
  assert.equal(served.headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(served.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(served.headers['Cache-Control'], /no-store/);
  assert.deepEqual(served.bytes, JPEG);
  const cameras = (await request('/status')).json().kinds[0].sites[0].cameras;
  assert.deepEqual(cameras.map((camera) => [camera.id, camera.lastFrameAt, camera.lastClip]), [['front', 9_000_000, 'Person · 13 · 2:14 PM'], ['ff', null, ''], ['back-yard', null, '']]);

  const tooSoon = await sendFrame(request, 'front', { bytes: PNG, type: 'image/png' });
  assert.equal(tooSoon.status, 429, 'one camera, at most one picture every two seconds');
  assert.equal((await sendFrame(request, 'Ff', { bytes: WEBP, type: 'image/webp' })).status, 204, 'other cameras are not held back, and a saved feed.private-cctv.example source still matches by name');
  t.mock.timers.tick(RELAY_MIN_FRAME_INTERVAL_MS);
  assert.equal((await sendFrame(request, 'front', { bytes: PNG, type: 'image/png' })).status, 204);
  const png = await request('/frame/private-home--front');
  assert.deepEqual([png.headers['Content-Type'], png.bytes], ['image/png', PNG]);
  const webp = await request('/frame/private-home--ff');
  assert.deepEqual([webp.headers['Content-Type'], webp.headers['X-Private-Camera'], webp.bytes], ['image/webp', 'relay', WEBP]);
  assert.equal(offlineReason(await request('/frame/private-home--dock')), 'NOT CONFIGURED');

  for (const line of logged) {
    for (const secret of [RELAY.secret, RELAY.hash]) assert.equal(line.includes(secret), false, 'a secret reached a log');
  }
});

test('a relay camera without a current picture says why: not paired, not connected, signed out or waiting for a clip', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 13, 14, 20).getTime() });
  const unpairedRoot = relayRoot(t, { paired: false });
  const unpaired = await relayHarness(privateCamerasProxy({ sourceRoot: unpairedRoot }))('/frame/private-home--front');
  assert.equal(offlineReason(unpaired), 'FEED RELAY NOT PAIRED');
  assert.match(unpaired.body, /Pair the GEV Private_CCTV_Feed Relay in POWER UP/);

  const root = relayRoot(t);
  const never = async () => assert.fail('a relay camera is never fetched');
  const request = relayHarness(privateCamerasProxy({ sourceRoot: root, fetchImpl: never, pinnedFetchImpl: never }));
  const placeholder = async (id = 'private-home--back-yard') => {
    const response = await request(`/frame/${id}`);
    assert.equal(response.headers['X-Private-Camera'], 'offline');
    return response;
  };
  let offline = await placeholder();
  assert.equal(offlineReason(offline), 'FEED RELAY NOT CONNECTED');
  assert.match(offline.body, /Open your camera site feed with the GEV Private_CCTV_Feed Relay/);
  assert.match(offline.body, /Back Yard/);

  const badHeartbeats = [
    ['an unknown state', { state: 'hacked', seen: [] }],
    ['seen that is not a list', { state: 'feed', seen: 'front' }],
    ['more than 20 names', { state: 'feed', seen: Array.from({ length: 21 }, (_, i) => `cam ${i}`) }],
    ['a name over 200 characters', { state: 'feed', seen: ['x'.repeat(201)] }],
    ['a name that is not text', { state: 'feed', seen: [42] }],
    ['a tab tag that is not 16 hex digits', { state: 'feed', seen: [], reporter: 'tab-3' }],
    ['an upper-case tab tag', { state: 'feed', seen: [], reporter: '0123456789ABCDEF' }],
    ['a tab tag that is not text', { state: 'feed', seen: [], reporter: 3 }],
  ];
  for (const [label, body] of badHeartbeats) {
    assert.equal((await request('/relay/heartbeat', { method: 'POST', body, headers: { ...extensionHeaders(), 'content-type': 'application/json' } })).status, 400, label);
  }
  assert.equal((await sendHeartbeat(request, 'feed', [], { authorization: `Bearer ${secretPair().secret}` })).status, 401);
  assert.equal((await sendHeartbeat(request, 'feed', [], { origin: `chrome-extension://${OTHER_EXTENSION_ID}` })).status, 403);
  assert.equal((await sendHeartbeat(request, 'feed', [], { origin: undefined })).status, 403);
  const oversized = await sendHeartbeat(request, 'feed', [], { 'content-length': '5000' });
  assert.deepEqual([oversized.status, oversized.req.bodyRead], [413, false]);
  assert.equal(offlineReason(await placeholder()), 'FEED RELAY NOT CONNECTED', 'refused heartbeats count for nothing');

  const startedAt = Date.now();
  const beat = await sendHeartbeat(request, 'feed', ['front', 'FF', 'Garage']);
  assert.deepEqual([beat.status, beat.json()], [200, { missing: ['front', 'ff'], unknown: ['garage'] }], 'the relay learns which pictures are wanted and which names match nothing');
  offline = await placeholder();
  assert.equal(offlineReason(offline), 'WAITING FOR A CLIP');
  assert.match(offline.body, /Shows the next motion clip from this camera/);
  assert.match(offline.body, /Or set its Private_CCTV_Feed name in POWER UP/, 'an unmatched feed name might be this camera');
  assert.equal(offlineReason(await placeholder('private-home--front')), 'PICTURE ON ITS WAY', 'the feed shows a clip of this camera');
  let relay = (await request('/status')).json().kinds[0].sites[0].relay;
  assert.deepEqual([relay.connected, relay.state, relay.lastHeartbeatAt, relay.unknownNames], [true, 'feed', startedAt, ['garage']]);

  // Another Private_CCTV_Feed tab's worse report does not override a tab reading the feed for a while.
  assert.equal((await sendHeartbeat(request, 'layout-unknown', [])).status, 200);
  assert.equal((await request('/status')).json().kinds[0].sites[0].relay.state, 'feed');
  assert.equal((await sendFrame(request, 'front', { clip: 'Motion · 2:20 PM' })).status, 204);
  const heartbeatAfterFrame = await sendHeartbeat(request, 'feed', ['front', 'ff'], {}, FEED_TAB);
  assert.deepEqual(heartbeatAfterFrame.json(), { missing: ['ff'], unknown: [] });
  assert.equal((await request('/frame/private-home--front')).headers['X-Private-Camera'], 'relay');

  // A sign-in page left open in another tab does not take the pictures down while this tab reads the feed...
  t.mock.timers.tick(1000);
  assert.equal((await sendHeartbeat(request, 'signed-out', [], {}, OTHER_TAB)).status, 200);
  assert.equal((await request('/frame/private-home--front')).headers['X-Private-Camera'], 'relay', "another tab's sign-in page is held");
  assert.equal((await request('/status')).json().kinds[0].sites[0].relay.state, 'feed');

  // ...but the reading tab's own sign-out does, straight away, not minutes later.
  t.mock.timers.tick(1000);
  assert.equal((await sendHeartbeat(request, 'signed-out', [], {}, FEED_TAB)).status, 200);
  offline = await placeholder();
  assert.equal(offlineReason(offline), 'FEED SIGNED OUT');
  assert.match(offline.body, /Sign in at your camera site to refresh pictures/);
  const signedOutFront = await placeholder('private-home--front');
  assert.equal(offlineReason(signedOutFront), 'FEED SIGNED OUT', 'an old picture is not shown as if current');
  assert.match(signedOutFront.body, /Last clip picture arrived 14:20/);

  t.mock.timers.tick(RELAY_HEARTBEAT_STALE_MS + 1);
  assert.equal(offlineReason(await placeholder()), 'FEED SIGNED OUT', 'a signed-out report still says to sign in once the relay goes quiet');
  relay = (await request('/status')).json().kinds[0].sites[0].relay;
  assert.deepEqual([relay.connected, relay.state], [false, 'signed-out']);

  assert.equal((await sendHeartbeat(request, 'feed', ['front'])).status, 200);
  assert.equal(offlineReason(await placeholder()), 'WAITING FOR A CLIP');
  assert.equal((await request('/frame/private-home--front')).headers['X-Private-Camera'], 'relay', 'signed in again, the kept picture is shown');
  t.mock.timers.tick(RELAY_HEARTBEAT_STALE_MS + 1);
  assert.equal(offlineReason(await placeholder()), 'FEED RELAY NOT CONNECTED', 'a relay silent for ten minutes is not connected');
  const quietFront = await placeholder('private-home--front');
  assert.equal(offlineReason(quietFront), 'FEED RELAY NOT CONNECTED');
  assert.match(quietFront.body, /Last clip picture arrived 14:20/);
  relay = (await request('/status')).json().kinds[0].sites[0].relay;
  assert.deepEqual([relay.connected, relay.state], [false, 'feed']);
});

test('unpairing, removed cameras, a new sign-in mode and removed sites all forget relay pictures', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 30_000_000 });
  const root = relayRoot(t);
  const request = relayHarness(privateCamerasProxy({ sourceRoot: root }));
  const preview = relayHarness(privateCamerasProxy({ sourceRoot: root }), 'configurePreviewServer');
  const save = (via, body) => via('/config', { method: 'POST', body, headers: pageHeaders() });
  const frameKind = async (via, id) => (await via(`/frame/${id}`)).headers['X-Private-Camera'];

  assert.equal((await sendHeartbeat(request)).status, 200);
  assert.equal((await sendFrame(request, 'front')).status, 204);
  assert.equal((await sendFrame(request, 'ff')).status, 204);
  assert.equal(await frameKind(request, 'private-home--ff'), 'relay');

  const removed = await save(request, { kind: 'home', siteId: 'home', auth: 'relay', cameras: [{ id: 'front', name: 'Front' }, { id: 'back-yard', name: 'Back Yard' }] });
  assert.equal(removed.status, 200, removed.body);
  assert.equal(removed.json().status.kinds[0].sites[0].relay.paired, true, 'a relay save keeps the pairing');
  assert.equal(removed.body.includes(RELAY.hash), false);
  const readded = await save(request, { kind: 'home', siteId: 'home', cameras: [{ id: 'front', name: 'Front' }, { id: 'back-yard', name: 'Back Yard' }, { name: 'Ff' }] });
  assert.equal(readded.status, 200, readded.body);
  assert.equal(readded.json().status.kinds[0].sites[0].cameras[2].id, 'ff');
  assert.equal(offlineReason(await request('/frame/private-home--ff')), 'PICTURE ON ITS WAY', 'a removed camera loses its picture; the relay stays connected');
  assert.deepEqual((await sendHeartbeat(request)).json(), { missing: ['ff'], unknown: [] }, 'and the relay is asked for it again');
  assert.equal(await frameKind(request, 'private-home--front'), 'relay');

  assert.equal((await preview('/relay/unpair', { method: 'POST', body: { siteId: 'home' }, headers: pageHeaders() })).status, 403, 'the preview server never unpairs');
  assert.equal((await request('/relay/unpair', { method: 'POST', body: { siteId: 'home' }, headers: { ...pageHeaders(), origin: `chrome-extension://${EXTENSION_ID}`, 'sec-fetch-site': 'none' } })).status, 403, 'the extension cannot use the page routes');
  assert.equal((await request('/relay/unpair', { method: 'POST', body: { siteId: 'ghost' }, headers: pageHeaders() })).status, 400);
  const unpaired = await request('/relay/unpair', { method: 'POST', body: { siteId: 'home' }, headers: pageHeaders() });
  assert.deepEqual([unpaired.status, unpaired.json()], [200, { ok: true }]);
  const stored = readStore(root).sites[0];
  assert.deepEqual([stored.relayExtensionId, stored.relaySecretHash, stored.username, stored.password], ['', '', 'owner@example.com', 'feed-password']);
  assert.equal(offlineReason(await request('/frame/private-home--front')), 'FEED RELAY NOT PAIRED', 'pictures and heartbeat are forgotten');
  assert.equal((await sendFrame(request, 'front')).status, 401, 'the old secret no longer works');
  assert.equal((await request('/relay/pair-status', { headers: extensionHeaders({ origin: null }) })).status, 401);

  // A paired site that switches to a bridge login forgets everything, and switching back does not re-pair it.
  const second = relayRoot(t);
  const other = relayHarness(privateCamerasProxy({ sourceRoot: second }));
  assert.equal((await sendHeartbeat(other)).status, 200);
  assert.equal((await sendFrame(other, 'front')).status, 204);
  const token = await save(other, {
    kind: 'home',
    siteId: 'home',
    auth: 'token',
    cameras: [{ id: 'front', name: 'Front', source: 'camera.privatecam_front' }, { id: 'ff', name: 'Ff', source: 'camera.privatecam_ff' }, { id: 'back-yard', name: 'Back Yard', source: 'camera.privatecam_back_yard' }],
  });
  assert.equal(token.status, 200, token.body);
  assert.equal(readStore(second).sites[0].relayExtensionId, '');
  const relayAgain = await save(other, { kind: 'home', siteId: 'home', auth: 'relay', cameras: [{ id: 'front', name: 'Front', source: null }, { id: 'ff', name: 'Ff', source: null }, { id: 'back-yard', name: 'Back Yard', source: null }] });
  assert.equal(relayAgain.status, 200, relayAgain.body);
  assert.equal(relayAgain.json().status.kinds[0].sites[0].relay.paired, false);
  assert.equal(offlineReason(await other('/frame/private-home--front')), 'FEED RELAY NOT PAIRED');

  // A removed site forgets its pictures even if a new site later takes the same id.
  const third = relayRoot(t);
  const another = relayHarness(privateCamerasProxy({ sourceRoot: third }));
  assert.equal((await sendHeartbeat(another)).status, 200);
  assert.equal((await sendFrame(another, 'front')).status, 204);
  assert.equal((await save(another, { removeSiteId: 'home' })).status, 200);
  assert.equal(offlineReason(await another('/frame/private-home--front')), 'NOT CONFIGURED');
  const recreated = await save(another, { kind: 'home', name: 'Home', auth: 'relay', lat: 45.27, lon: -66.06, cameras: [{ name: 'Front' }] });
  assert.deepEqual([recreated.status, recreated.json().siteId], [200, 'home']);
  assert.equal(offlineReason(await another('/frame/private-home--front')), 'FEED RELAY NOT PAIRED');
});

test('a camera whose Private_CCTV_Feed match name changes loses its picture, so it never shows another camera', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 40_000_000 });
  const root = relayRoot(t);
  const request = relayHarness(privateCamerasProxy({ sourceRoot: root }));
  const save = async (cameras) => {
    const saved = await request('/config', { method: 'POST', body: { kind: 'home', siteId: 'home', auth: 'relay', cameras }, headers: pageHeaders() });
    assert.equal(saved.status, 200, saved.body);
    return saved.json();
  };
  /** The picture a camera shows, or the reason on its placeholder. */
  const shown = async (id) => {
    const response = await request(`/frame/private-home--${id}`);
    return response.headers['X-Private-Camera'] === 'relay' ? response.bytes : offlineReason(response);
  };
  const backYard = { id: 'back-yard', name: 'Back Yard' };

  assert.equal((await sendHeartbeat(request)).status, 200);
  assert.equal((await sendFrame(request, 'front')).status, 204);
  assert.equal((await sendFrame(request, 'ff', { bytes: PNG, type: 'image/png' })).status, 204);

  await save([{ id: 'front', name: 'FRONT' }, { id: 'ff', name: 'Ff' }, backYard]);
  assert.deepEqual([await shown('front'), await shown('ff')], [JPEG, PNG], 'a Name that still matches the same Private_CCTV_Feed camera keeps its picture');

  // Renamed: the picture came from the Private_CCTV_Feed camera "front", which this camera no longer matches.
  await save([{ id: 'front', name: 'Front Door' }, { id: 'ff', name: 'Ff' }, backYard]);
  assert.deepEqual([await shown('front'), await shown('ff')], ['WAITING FOR A CLIP', PNG], 'only the renamed camera loses its picture');
  assert.deepEqual((await sendHeartbeat(request)).json(), { missing: [], unknown: ['front'] });

  // A changed Private_CCTV_Feed name override.
  await save([{ id: 'front', name: 'Front Door', source: 'Front' }, { id: 'ff', name: 'Ff' }, backYard]);
  assert.equal((await sendFrame(request, 'front')).status, 204);
  assert.deepEqual(await shown('front'), JPEG);
  await save([{ id: 'front', name: 'Front Door', source: 'Porch' }, { id: 'ff', name: 'Ff' }, backYard]);
  assert.equal(await shown('front'), 'WAITING FOR A CLIP', 'a new Private_CCTV_Feed name drops the picture of the old one');

  // Two cameras swap Private_CCTV_Feed names: neither shows the other's picture.
  await save([{ id: 'front', name: 'Front', source: null }, { id: 'ff', name: 'Ff', source: null }, backYard]);
  assert.equal((await sendFrame(request, 'front')).status, 204);
  assert.deepEqual([await shown('front'), await shown('ff')], [JPEG, PNG]);
  const swapped = await save([{ id: 'front', name: 'Front', source: 'Ff' }, { id: 'ff', name: 'Ff', source: 'Front' }, backYard]);
  assert.deepEqual(swapped.status.kinds[0].sites[0].cameras.map((camera) => [camera.id, camera.matchName, camera.lastFrameAt]), [['front', 'ff', null], ['ff', 'front', null], ['back-yard', 'back yard', null]]);
  assert.deepEqual([await shown('front'), await shown('ff')], ['PICTURE ON ITS WAY', 'PICTURE ON ITS WAY'], "neither camera keeps the other camera's picture");
  assert.deepEqual((await sendHeartbeat(request)).json(), { missing: ['front', 'ff'], unknown: [] }, 'the relay is asked for both pictures again');
  assert.equal((await sendFrame(request, 'front', { bytes: PNG, type: 'image/png' })).status, 204);
  assert.deepEqual([await shown('front'), await shown('ff')], ['PICTURE ON ITS WAY', PNG], 'the Private_CCTV_Feed camera "front" now fills the camera that names it');
});
