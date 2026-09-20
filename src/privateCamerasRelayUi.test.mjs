import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELAY_REFRESH_MS,
  cameraSourceField,
  collectPrivateSiteUpdate,
  initPrivateCameraSetup,
  isRelaySite,
  privateCameraAuthChoices,
  relayPrivateCctvFeedNameOverride,
  relayCameraLine,
  relayOriginWarning,
  relayPairedText,
  relayPanelLines,
  relayPendingRequests,
  relayPendingText,
  relayStatusText,
  relayUnknownNamesText,
} from './privateCamerasSetup.js';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const PIN = 'AB'.repeat(32);
const LOCATION = { name: 'Home', postalCode: '', address: '42 Charlotte St', lat: '45.2733', lon: '-66.0633', locationLabel: '42 Charlotte St, Saint John' };
const TYPED = { bridgeUrl: 'https://ha.local:8123', token: 'typed-token', username: 'me@example.com', password: 'typed password', tlsFingerprint: PIN };
const CREDENTIAL_KEYS = ['bridgeUrl', 'token', 'username', 'password', 'tlsFingerprint'];
const NOT_CONNECTED = 'Relay not connected — open your camera site feed in Chrome with the extension installed';
const NOT_PAIRED = 'Relay not paired — open the extension options, press PAIR WITH GODS EYE VIEW and approve the request here';
const RELAY_HINT = 'Private_CCTV_Feed camera name (blank = same as Name)';
const NOW = Date.UTC(2026, 8, 13, 18, 0, 0);

function relaySite(relay = {}, cameras = []) {
  return { id: 'home', name: 'Home', auth: 'relay', relay: { paired: true, extensionId: EXTENSION_ID, state: null, lastHeartbeatAt: null, connected: false, unknownNames: [], ...relay }, cameras };
}

test('relay mode sends auth relay, leaves out every bridge and login key, and allows a blank Private_CCTV_Feed name', () => {
  const body = collectPrivateSiteUpdate('home', 'home', { ...LOCATION, ...TYPED, auth: 'relay' }, [
    { id: 'front', name: 'Front', source: '', headingDeg: 'S' },
    { id: '', name: 'Back Yard', source: 'backyard', headingDeg: '' },
  ]);
  assert.deepEqual(body, {
    kind: 'home',
    name: 'Home',
    siteId: 'home',
    auth: 'relay',
    postalCode: '',
    address: '42 Charlotte St',
    lat: 45.2733,
    lon: -66.0633,
    locationLabel: '42 Charlotte St, Saint John',
    cameras: [
      { id: 'front', name: 'Front', headingDeg: 'S' },
      { name: 'Back Yard', source: 'backyard', headingDeg: null },
    ],
  });
  for (const key of CREDENTIAL_KEYS) assert.equal(Object.hasOwn(body, key), false, `${key} is omitted so the saved value is kept`);
});

test('token and login modes send exactly what they did before the relay', () => {
  const cameras = [{ id: 'front', name: 'Front', source: 'camera.privatecam_front', headingDeg: 'N' }];
  assert.deepEqual(collectPrivateSiteUpdate('home', 'home', { ...LOCATION, ...TYPED, auth: 'token' }, cameras), {
    kind: 'home',
    name: 'Home',
    siteId: 'home',
    token: 'typed-token',
    password: 'typed password',
    username: 'me@example.com',
    tlsFingerprint: PIN,
    bridgeUrl: 'https://ha.local:8123',
    auth: 'token',
    postalCode: '',
    address: '42 Charlotte St',
    lat: 45.2733,
    lon: -66.0633,
    locationLabel: '42 Charlotte St, Saint John',
    cameras: [{ id: 'front', name: 'Front', source: 'camera.privatecam_front', headingDeg: 'N' }],
  });
  const login = collectPrivateSiteUpdate('home', '', { ...LOCATION, bridgeUrl: 'https://ha.local:8123', auth: 'login', token: '', username: 'me', password: '', tlsFingerprint: '' }, cameras);
  assert.equal(login.auth, 'login');
  assert.equal(login.username, 'me');
  assert.equal(login.bridgeUrl, 'https://ha.local:8123');
  assert.equal(login.tlsFingerprint, '');
  for (const key of ['siteId', 'token', 'password']) assert.equal(Object.hasOwn(login, key), false, key);
  assert.equal(collectPrivateSiteUpdate('home', 'home', { ...LOCATION, auth: 'cookie' }, []).auth, 'token', 'an unknown choice falls back to token');
  const business = collectPrivateSiteUpdate('business', 'shop', { ...LOCATION, ...TYPED, auth: 'relay' }, cameras);
  for (const key of ['auth', 'bridgeUrl', 'token']) assert.equal(Object.hasOwn(business, key), false, `business sites have no ${key}`);
  assert.deepEqual([business.username, business.password, business.tlsFingerprint], ['me@example.com', 'typed password', PIN], 'the relay is a home-only choice');
});

test('relay status text follows the heartbeat state, and a stale heartbeat reads as not connected', () => {
  const beat = { connected: true, lastHeartbeatAt: NOW - 60_000 };
  assert.equal(relayStatusText(relaySite({ ...beat, state: 'feed' }), NOW), 'Relay connected — reading your Private_CCTV_Feed feed');
  assert.equal(relayStatusText(relaySite({ ...beat, state: 'signed-out' }), NOW), 'Private_CCTV_Feed signed out — open your camera site and sign in to refresh pictures');
  assert.equal(relayStatusText(relaySite({ ...beat, state: 'no-cards' }), NOW), 'Your Private_CCTV_Feed feed has no clips loaded');
  assert.equal(relayStatusText(relaySite({ ...beat, state: 'layout-unknown' }), NOW), 'Private_CCTV_Feed feed layout not recognised — the relay needs an update');
  assert.equal(relayStatusText(relaySite(), NOW), NOT_CONNECTED, 'no heartbeat yet');
  assert.equal(relayStatusText(relaySite({ state: 'feed', connected: false, lastHeartbeatAt: NOW - 11 * 60_000 }), NOW), NOT_CONNECTED, 'the server says stale');
  assert.equal(relayStatusText(relaySite({ state: 'feed', connected: true, lastHeartbeatAt: NOW - 11 * 60_000 }), NOW), NOT_CONNECTED, 'stale by the time it is shown');
  assert.equal(relayStatusText(relaySite({ state: 'signed-out', connected: false, lastHeartbeatAt: NOW - 11 * 60_000 }), NOW), 'Private_CCTV_Feed signed out — open your camera site and sign in to refresh pictures', 'matches the camera placeholder');
  assert.equal(relayStatusText(relaySite({ ...beat, state: 'constructor' }), NOW), 'Relay connected — reading your Private_CCTV_Feed feed', 'no prototype lookups');
  assert.equal(relayStatusText({ auth: 'relay' }, NOW), NOT_PAIRED);
  assert.equal(relayStatusText(relaySite({ paired: false, extensionId: '' }), NOW), NOT_PAIRED, 'an unpaired site says how to pair before anything else');
  assert.deepEqual(
    ['feed', 'signed-out', 'no-cards', 'layout-unknown'].map((state) => relayPanelLines(relaySite({ ...beat, state }), null, NOW).tone),
    ['ok', 'warn', 'warn', 'warn'],
  );
  assert.equal(relayPanelLines(relaySite(), null, NOW).tone, 'off');
  assert.equal(relayPanelLines(relaySite({ paired: false, extensionId: '' }), null, NOW).tone, 'off');
});

test('waiting pairing requests are listed one per extension, and only port 4173 reaches the relay', () => {
  const other = 'ponmlkjihgfedcbaponmlkjihgfedcba';
  assert.deepEqual(relayPendingRequests([{ extensionId: EXTENSION_ID, code: 'K7PM3Q', expiresInSeconds: 90 }, { extensionId: other, code: 'ABC234', expiresInSeconds: 30 }, null, { code: 'XYZ789' }]), [
    { extensionId: EXTENSION_ID, code: 'K7PM3Q', text: `Pairing request from extension ${EXTENSION_ID} — code K7PM3Q` },
    { extensionId: other, code: 'ABC234', text: `Pairing request from extension ${other} — code ABC234` },
  ]);
  assert.deepEqual(relayPendingRequests({ extensionId: EXTENSION_ID, code: 'K7PM3Q' }).map((request) => request.code), ['K7PM3Q'], 'a single request is accepted too');
  assert.deepEqual(relayPendingRequests(null), []);
  assert.deepEqual(relayPendingRequests([]), []);
  assert.equal(relayOriginWarning('http://localhost:4173'), '');
  assert.equal(relayOriginWarning('http://127.0.0.1:4173'), '');
  assert.equal(relayOriginWarning(undefined), '');
  assert.match(relayOriginWarning('http://localhost:5173'), /only reaches Gods Eye View at http:\/\/localhost:4173, but this page is on http:\/\/localhost:5173/);
});

test('paired, pairing request, unknown camera and per-camera lines', () => {
  assert.equal(relayPairedText(relaySite()), `Paired with extension ${EXTENSION_ID}`);
  assert.equal(relayPairedText(relaySite({ paired: false, extensionId: '' })), 'Not paired');
  assert.equal(relayPairedText({ relay: null }), 'Not paired');
  assert.equal(relayPendingText({ extensionId: EXTENSION_ID, code: 'K7PM3Q', expiresInSeconds: 90 }), `Pairing request from extension ${EXTENSION_ID} — code K7PM3Q`);
  assert.equal(relayPendingText(null), '');
  assert.equal(relayUnknownNamesText(relaySite({ unknownNames: ['garage', 'front door'] })), "Your Private_CCTV_Feed feed has cameras named “garage”, “front door” that match no camera here — set a camera's Private_CCTV_Feed name");
  assert.equal(relayUnknownNamesText(relaySite()), '');
  const at = new Date(2026, 8, 13, 14, 2, 30).getTime();
  assert.equal(relayCameraLine({ name: 'Front', lastFrameAt: at, lastClip: 'Motion · 13 · 2:02 PM' }), 'Front: last clip picture 14:02 (Motion · 13 · 2:02 PM)');
  assert.equal(relayCameraLine({ name: 'Ff', lastFrameAt: new Date(2026, 8, 13, 9, 5).getTime(), lastClip: '' }), 'Ff: last clip picture 09:05');
  assert.equal(relayCameraLine({ name: 'Back Yard', lastFrameAt: null, lastClip: '' }), 'Back Yard: waiting for a clip');
  const lines = relayPanelLines(relaySite({ unknownNames: ['garage'] }, [{ name: 'Front', lastFrameAt: at, lastClip: 'Person' }, { name: 'Back Yard', lastFrameAt: null }]), { extensionId: EXTENSION_ID, code: 'K7PM3Q' }, NOW);
  assert.deepEqual(lines.cameras, ['Front: last clip picture 14:02 (Person)', 'Back Yard: waiting for a clip']);
  assert.equal(lines.paired, true);
  assert.match(lines.unknown, /“garage”/);
  assert.deepEqual(lines.requests.map((request) => request.text), [`Pairing request from extension ${EXTENSION_ID} — code K7PM3Q`]);
});

test('home sites offer the relay only when the server accepts it, and relay rows ask for the Private_CCTV_Feed camera name', () => {
  assert.deepEqual(
    privateCameraAuthChoices({ authModes: ['token', 'login', 'relay'] }).map(([value, label]) => [value, label]),
    [
      ['token', 'Home Assistant long-lived access token'],
      ['login', 'Username + password'],
      ['relay', 'Browser feed relay (Chrome extension)'],
    ],
  );
  assert.deepEqual(privateCameraAuthChoices({ authModes: ['token', 'login'] }).map(([value]) => value), ['token', 'login']);
  const home = { id: 'home', sourceHint: 'camera.privatecam_front or a bridge snapshot URL' };
  assert.deepEqual(cameraSourceField(home, {}, true), { placeholder: RELAY_HINT, label: RELAY_HINT });
  assert.deepEqual(cameraSourceField(home, { privateCctvFeedName: 'backyard' }, true), { placeholder: 'Private_CCTV_Feed name “backyard” — saved (type the Name to clear)', label: RELAY_HINT });
  assert.deepEqual(cameraSourceField(home, { source: 'camera.privatecam_front' }, false), { placeholder: 'camera.privatecam_front — saved', label: 'Camera entity or snapshot URL' });
  assert.deepEqual(cameraSourceField({ id: 'business', sourceHint: 'https://192.168.1.64/snap.jpg' }, {}, false), { placeholder: 'https://192.168.1.64/snap.jpg', label: 'Snapshot URL' });
  assert.equal(relayPrivateCctvFeedNameOverride({ name: 'Back  Yard', matchName: 'back yard' }), '');
  assert.equal(relayPrivateCctvFeedNameOverride({ name: 'Back Yard', matchName: 'backyard' }), 'backyard');
  assert.equal(relayPrivateCctvFeedNameOverride({ name: 'Front' }), '');
  assert.equal(isRelaySite(relaySite()), true);
  assert.equal(isRelaySite({ auth: 'token', relay: { paired: false } }), false);
  assert.equal(isRelaySite({ auth: 'relay', relay: null }), false);
});

// ── A small DOM, just enough for the POWER UP section ─────────────────────────

const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function matchesCompound(node, compound) {
  const parsed = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+="[^"]*"\])*)$/i.exec(compound);
  if (!parsed) throw new Error(`The test DOM cannot match ${compound}`);
  if (parsed[1] && node.tagName !== parsed[1].toUpperCase()) return false;
  const classes = node.className.split(/\s+/);
  if (parsed[2].split('.').filter(Boolean).some((name) => !classes.includes(name))) return false;
  return [...parsed[3].matchAll(/\[([\w-]+)="([^"]*)"\]/g)].every(([, name, value]) => node.getAttribute(name) === value);
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.text = '';
  }

  get textContent() {
    return this.tagName === '#TEXT' ? this.text : this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    if (String(value ?? '')) this.append(String(value));
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? Object.assign(new FakeElement('#text'), { text: node }) : node;
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = String(value);
    else this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return name.startsWith('data-') ? (this.dataset[camel(name.slice(5))] ?? null) : (this.attributes.get(name) ?? null);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener({ type, target: this, preventDefault() {} });
  }

  click() {
    if (!this.disabled) this.dispatch('click');
  }

  matches(selector) {
    return selector.split(',').some((part) => {
      const steps = part.trim().split(/\s+/);
      if (!matchesCompound(this, steps.at(-1))) return false;
      let index = steps.length - 2;
      for (let up = this.parentElement; up && index >= 0; up = up.parentElement) if (matchesCompound(up, steps[index])) index -= 1;
      return index < 0;
    });
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.tagName === '#TEXT') continue;
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function statusFixture({ relay = {}, pending = null, cameras } = {}) {
  const camera = (id, name, matchName, extra = {}) => ({ id, name, source: '', headingDeg: 180, facing: 'S', placed: true, privateCctvFeedWebsite: false, matchName, lastFrameAt: null, lastClip: '', ...extra });
  return {
    editable: true,
    relayPending: pending,
    kinds: [
      {
        id: 'home',
        title: 'HOME SECURITY · PRIVATE_CCTV_FEED',
        unlocks: 'Your Private_CCTV_Feed cameras',
        feedUrl: 'https://feed.private-cctv.example/#/feed',
        sourceHint: 'camera.privatecam_front or a bridge snapshot URL',
        authModes: ['token', 'login', 'relay'],
        sites: [
          {
            id: 'home',
            name: 'Home',
            postalCode: '',
            address: '42 Charlotte St',
            lat: 45.2733,
            lon: -66.0633,
            locationLabel: '42 Charlotte St, Saint John',
            located: true,
            bridgeUrl: '',
            bridgeConnected: false,
            auth: 'relay',
            tokenSet: false,
            usernameSet: true,
            passwordSet: true,
            tlsFingerprint: '',
            transport: 'relay',
            privateCctvFeedWebsite: false,
            relay: { paired: false, extensionId: '', state: null, lastHeartbeatAt: null, connected: false, unknownNames: [], ...relay },
            cameras: cameras || [camera('front', 'Front', 'front'), camera('ff', 'Ff', 'ff'), camera('back-yard', 'Back Yard', 'backyard')],
          },
          {
            id: 'cottage',
            name: 'Cottage',
            postalCode: '',
            address: '',
            lat: null,
            lon: null,
            locationLabel: '',
            located: false,
            bridgeUrl: 'https://ha.local:8123',
            bridgeConnected: true,
            auth: 'token',
            tokenSet: true,
            usernameSet: false,
            passwordSet: false,
            tlsFingerprint: '',
            transport: 'https',
            privateCctvFeedWebsite: false,
            relay: { paired: false, extensionId: '' },
            cameras: [camera('porch', 'Porch', 'camera.privatecam_porch', { source: 'camera.privatecam_porch', placed: false })],
          },
        ],
      },
      { id: 'business', title: 'BUSINESS SECURITY', unlocks: 'IP cameras', feedUrl: '', sourceHint: 'https://192.168.1.64/snap.jpg', authModes: ['login'], sites: [] },
    ],
  };
}

function fakeServer(status) {
  const server = { status, calls: [], replies: new Map() };
  server.fetch = async (url, init = {}) => {
    const call = { url, method: init.method || 'GET', init, body: init.body ? JSON.parse(init.body) : undefined };
    server.calls.push(call);
    const reply = (code, payload) => ({ ok: code >= 200 && code < 300, status: code, json: async () => structuredClone(payload) });
    if (url === '/api/private-cams/status' && call.method === 'GET') return reply(200, server.status);
    const handler = server.replies.get(url);
    return handler ? reply(...handler(call.body)) : reply(404, { error: 'Not found' });
  };
  return server;
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('a Private_CCTV_Feed site still pointing at feed.private-cctv.example is told about the browser feed relay, and the warning goes once the relay is chosen', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const documentRef = { createElement: (tag) => new FakeElement(tag) };
  const dialog = new FakeElement('div');
  const host = new FakeElement('div');
  dialog.append(host);
  const status = statusFixture();
  const saved = status.kinds[0].sites[0];
  Object.assign(saved, {
    auth: 'login',
    transport: 'none',
    privateCctvFeedWebsite: true,
    relay: { paired: false, extensionId: '' },
    cameras: saved.cameras.map((camera) => ({ ...camera, source: 'https://feed.private-cctv.example/#/feed', privateCctvFeedWebsite: true, matchName: camera.name.toLowerCase() })),
  });
  const setup = initPrivateCameraSetup({ host, documentRef, fetchImpl: fakeServer(status).fetch });
  await flush();
  const home = host.querySelector('[data-site-id="home"]');
  const warning = home.querySelectorAll('.private-cams-warning').find((node) => /Private_CCTV_Feed website/.test(node.textContent));
  assert.ok(warning, 'the Private_CCTV_Feed website warning is shown');
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /Use a local bridge/);
  assert.match(warning.textContent, /choose “Browser feed relay \(Chrome extension\)” below to receive clip pictures from your own signed-in camera site feed \(your saved login stays saved\)/);
  const auth = home.querySelector('[data-field="auth"]');
  assert.equal(auth.value, 'login');
  auth.value = 'relay';
  auth.dispatch('change');
  assert.equal(warning.hidden, true, 'the old warning goes once the relay is chosen');
  setup.destroy();
});

test('POWER UP shows the relay panel, refreshes it in place without touching typed input, and stops on destroy', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const documentRef = { createElement: (tag) => new FakeElement(tag) };
  const dialog = new FakeElement('div');
  const host = new FakeElement('div');
  dialog.append(host);
  const server = fakeServer(statusFixture({ pending: [{ extensionId: EXTENSION_ID, code: 'K7PM3Q', expiresInSeconds: 110 }] }));
  const setup = initPrivateCameraSetup({ host, documentRef, fetchImpl: server.fetch });
  await flush();
  assert.equal(host.hidden, false);

  const loginField = (block, name) => block.querySelector(`.private-cams-login [data-field="${name}"]`);
  const home = host.querySelector('[data-site-id="home"]');
  const auth = home.querySelector('[data-field="auth"]');
  assert.equal(auth.value, 'relay');
  assert.deepEqual(auth.children.map((option) => [option.value, option.textContent]).at(-1), ['relay', 'Browser feed relay (Chrome extension)']);
  for (const name of CREDENTIAL_KEYS) assert.equal(loginField(home, name).hidden, true, `${name} hidden in relay mode`);
  const relayBox = home.querySelector('.private-cams-relay');
  assert.equal(relayBox.hidden, false);
  assert.match(relayBox.querySelector('.private-cams-warning').textContent, /terms of service prohibit data-extraction tools and allow Private_CCTV_Feed to close accounts/);
  assert.match(relayBox.querySelector('.private-cams-relay-steps').textContent, /npm run private-cctv-feed-relay:install.*chrome:\/\/extensions.*Always keep these sites active/);
  assert.equal(home.querySelector('.private-cams-relay-status').textContent, NOT_PAIRED);
  assert.equal(home.querySelector('.private-cams-relay-paired').textContent, 'Not paired');
  assert.deepEqual(home.querySelectorAll('.private-cams-relay-cameras li').map((line) => line.textContent), ['Front: waiting for a clip', 'Ff: waiting for a clip', 'Back Yard: waiting for a clip']);
  assert.equal(home.querySelector('.private-cams-relay-pending strong').textContent, `Pairing request from extension ${EXTENSION_ID} — code K7PM3Q`);
  assert.match(home.querySelector('.private-cams-relay-pending').textContent, /Only approve if both this code and this extension ID are shown on the relay's options page\./);
  assert.match(relayBox.querySelector('.private-cams-relay-steps').textContent, /APPROVE only the request here whose code and extension ID both match the options page/);
  assert.equal(home.querySelector('.private-cams-relay-unpair'), null, 'nothing to unpair yet');
  const sources = home.querySelectorAll('.private-cams-cameras [data-field="source"]');
  assert.deepEqual(sources.map((field) => field.placeholder), [RELAY_HINT, RELAY_HINT, 'Private_CCTV_Feed name “backyard” — saved (type the Name to clear)']);
  assert.equal(home.querySelector('.private-cams-camera-head').children[1].textContent, 'PRIVATE_CCTV_FEED CAMERA NAME');

  const cottage = host.querySelector('[data-site-id="cottage"]');
  assert.equal(cottage.querySelector('.private-cams-relay').hidden, true);
  assert.equal(loginField(cottage, 'token').hidden, false);
  assert.equal(loginField(cottage, 'bridgeUrl').hidden, false);
  assert.equal(cottage.querySelector('.private-cams-relay-live'), null, 'only a saved relay site has a live panel');

  // The user is typing when the relay reports in.
  const siteName = home.querySelector('.private-cams-site-head [data-field="name"]');
  siteName.value = 'Typed site name';
  sources[2].value = 'back yard';
  const frameAt = new Date(2026, 8, 13, 14, 2).getTime();
  const connected = { paired: true, extensionId: EXTENSION_ID, state: 'feed', connected: true, lastHeartbeatAt: Date.now() - 5000, unknownNames: ['garage'] };
  const liveCameras = statusFixture().kinds[0].sites[0].cameras.map((camera, index) => (index === 0 ? { ...camera, lastFrameAt: frameAt, lastClip: 'Motion · 2:02 PM' } : camera));
  server.status = statusFixture({ relay: connected, cameras: liveCameras });
  let calls = server.calls.length;
  t.mock.timers.tick(RELAY_REFRESH_MS);
  await flush();
  assert.equal(server.calls.length, calls + 1, 'one status read per tick');
  assert.equal(host.querySelector('[data-site-id="home"]'), home, 'the site is not re-rendered');
  assert.equal(home.querySelector('.private-cams-site-head [data-field="name"]'), siteName);
  assert.equal(siteName.value, 'Typed site name');
  assert.equal(sources[2].value, 'back yard');
  assert.equal(home.querySelector('.private-cams-relay-status').textContent, 'Relay connected — reading your Private_CCTV_Feed feed');
  assert.equal(home.querySelector('.private-cams-relay-status').dataset.tone, 'ok');
  assert.equal(home.querySelector('.private-cams-relay-paired').textContent, `Paired with extension ${EXTENSION_ID}`);
  assert.equal(home.querySelector('.private-cams-relay-cameras li').textContent, 'Front: last clip picture 14:02 (Motion · 2:02 PM)');
  assert.match(home.querySelector('.private-cams-relay-unknown').textContent, /cameras named “garage” that match no camera here/);
  assert.equal(home.querySelector('.private-cams-relay-pending'), null, 'the answered request is gone');
  assert.ok(home.querySelector('.private-cams-relay-unpair'));

  // A closed dialog is never refreshed.
  dialog.hidden = true;
  calls = server.calls.length;
  t.mock.timers.tick(RELAY_REFRESH_MS * 3);
  setup.refresh();
  await flush();
  assert.equal(server.calls.length, calls);
  dialog.hidden = false;

  // Opening the dialog reads the relay at once, without waiting for the next tick.
  const other = 'ponmlkjihgfedcbaponmlkjihgfedcba';
  server.status = statusFixture({ relay: connected, cameras: liveCameras, pending: [{ extensionId: EXTENSION_ID, code: 'ABC234', expiresInSeconds: 100 }, { extensionId: other, code: 'ABC234', expiresInSeconds: 90 }] });
  setup.refresh();
  await flush();
  assert.equal(server.calls.length, calls + 1);
  assert.deepEqual(home.querySelectorAll('.private-cams-relay-pending strong').map((line) => line.textContent), [`Pairing request from extension ${EXTENSION_ID} — code ABC234`, `Pairing request from extension ${other} — code ABC234`], 'one box per waiting extension');

  // A refresh that changes only the camera lines keeps the very same APPROVE button.
  const approveButton = home.querySelector('.private-cams-relay-approve');
  server.status = statusFixture({ relay: connected, cameras: liveCameras.map((camera) => ({ ...camera, lastFrameAt: frameAt + 60_000 })), pending: server.status.relayPending });
  t.mock.timers.tick(RELAY_REFRESH_MS);
  await flush();
  assert.equal(home.querySelector('.private-cams-relay-approve'), approveButton);

  // APPROVE posts the site, code and extension ID it shows, like SAVE SITE does, and shows the server's refusal.
  server.replies.set('/api/private-cams/relay/approve', () => [409, { error: 'That pairing request has expired' }]);
  home.querySelector('.private-cams-relay-approve').click();
  await flush();
  const approveCall = server.calls.find((call) => call.url === '/api/private-cams/relay/approve');
  assert.equal(approveCall.method, 'POST');
  assert.deepEqual(approveCall.body, { siteId: 'home', code: 'ABC234', extensionId: EXTENSION_ID });
  assert.equal(approveCall.init.headers['Content-Type'], 'application/json');
  assert.equal(approveCall.init.credentials, 'same-origin');
  assert.equal(home.querySelector('.private-cams-relay-message').textContent, 'That pairing request has expired');
  server.replies.set('/api/private-cams/relay/approve', () => [200, { ok: true, extensionId: EXTENSION_ID }]);
  home.querySelector('.private-cams-relay-approve').click();
  await flush();
  assert.match(home.querySelector('.private-cams-relay-message').textContent, new RegExp(`^Paired with extension ${EXTENSION_ID}\\.`));

  server.replies.set('/api/private-cams/relay/unpair', () => [200, { ok: true }]);
  home.querySelector('.private-cams-relay-unpair').click();
  await flush();
  assert.deepEqual(server.calls.find((call) => call.url === '/api/private-cams/relay/unpair').body, { siteId: 'home' });

  // Switching away from the relay shows the bridge fields again, without clearing them.
  auth.value = 'token';
  auth.dispatch('change');
  assert.equal(loginField(home, 'bridgeUrl').hidden, false);
  assert.equal(loginField(home, 'token').hidden, false);
  assert.equal(relayBox.hidden, true);
  assert.equal(sources[0].placeholder, 'camera.privatecam_front or a bridge snapshot URL');
  auth.value = 'relay';
  auth.dispatch('change');
  loginField(home, 'password').value = 'typed but hidden';

  server.replies.set('/api/private-cams/config', () => [200, { ok: true, siteId: 'home', status: statusFixture() }]);
  home.querySelector('.private-cams-actions .private-cams-save').click();
  await flush();
  const saveCall = server.calls.find((call) => call.url === '/api/private-cams/config');
  assert.equal(saveCall.body.auth, 'relay');
  assert.equal(saveCall.body.name, 'Typed site name');
  for (const key of CREDENTIAL_KEYS) assert.equal(Object.hasOwn(saveCall.body, key), false, `${key} not sent`);
  assert.deepEqual(saveCall.body.cameras.map((camera) => camera.source), [undefined, undefined, 'back yard']);
  assert.notEqual(host.querySelector('[data-site-id="home"]'), home, 'a save re-renders from the new status');
  assert.equal(server.calls.at(-1).url, '/api/private-cams/status', 'and fills the relay panel from a fresh status');

  calls = server.calls.length;
  setup.destroy();
  t.mock.timers.tick(RELAY_REFRESH_MS * 2);
  await flush();
  assert.equal(server.calls.length, calls, 'no refresh after destroy');
  assert.equal(host.children.length, 0);
});
