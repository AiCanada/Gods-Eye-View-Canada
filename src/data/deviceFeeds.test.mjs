import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEEDS_CHANGED_EVENT, DEVICE_FEEDS_FOCUS_EVENT, DEVICE_FEEDS_HISTORY_EVENT, DEVICE_FEEDS_VISIBLE_EVENT, deviceHistoryQuery } from '../deviceFeedsCore.mjs';
import { WORLD_FOCUS_REQUEST_EVENT } from '../worldFocus.js';
import {
  DEVICE_FEEDS_LAYER_ID,
  DEVICE_FEEDS_OVERLAY_SOURCE_ID,
  createDeviceFeedsLayer,
  createDeviceOverlayEntry,
  deviceDetailLines,
  deviceStepMeters,
  extendDeviceTrail,
  normalizeDevicePositions,
} from './deviceFeeds.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';

const device = (extra = {}) => ({
  id: 'device-drone-scout', kind: 'drone', kindLabel: 'DRONE', color: '#36dcff', name: 'Scout',
  lat: 45.27, lon: -66.06, altM: 40, headingDeg: 90, speedMps: 10, live: true, at: 5, error: '', pictureUrl: null,
  ...extra,
});

test('the layer is in the share-link registry under its own token', () => {
  const entry = LAYER_STATE_REGISTRY.find((item) => item.id === DEVICE_FEEDS_LAYER_ID);
  // 'v' went to upstream's weather radar in the 2026-10 merge.
  assert.deepEqual([entry?.token, entry?.disposition], ['5', 'enabled-only']);
});

test('only well-formed devices, and only the application’s own picture route', () => {
  assert.equal(normalizeDevicePositions(null), null);
  assert.equal(normalizeDevicePositions({ devices: 'no' }), null);
  const rows = normalizeDevicePositions({
    devices: [
      device({ pictureUrl: '/api/device-feeds/frame/device-drone-scout' }),
      device({ id: 'device-security-phone', pictureUrl: '/api/ultra-help/picture' }),
      device(),
      device({ id: 'b', lat: 91 }),
      device({ id: 'c', lon: '12' }),
      device({ id: 'd', color: 'url(javascript:1)', pictureUrl: 'https://evil.example/x.jpg', name: '' }),
      null,
      // One phone package's own picture, by its public id; nothing else under that route.
      device({ id: 'device-security-van', pictureUrl: '/api/ultra-help/picture/device-security-van' }),
      device({ id: 'e1', pictureUrl: '/api/ultra-help/picture/../status' }),
      device({ id: 'e2', pictureUrl: '/api/ultra-help/picture/device-van?t=1' }),
      device({ id: 'e3', pictureUrl: '/api/ultra-help/picture/van' }),
    ],
  });
  assert.deepEqual(rows.map((row) => row.id), ['device-drone-scout', 'device-security-phone', 'd', 'device-security-van', 'e1', 'e2', 'e3']);
  assert.equal(rows[0].pictureUrl, '/api/device-feeds/frame/device-drone-scout');
  assert.equal(rows[1].pictureUrl, '/api/ultra-help/picture');
  assert.deepEqual([rows[2].color, rows[2].pictureUrl, rows[2].name], ['#ffffff', '', 'DEVICE']);
  assert.equal(rows[3].pictureUrl, '/api/ultra-help/picture/device-security-van');
  assert.deepEqual(rows.slice(4).map((row) => row.pictureUrl), ['', '', '']);
});

// A call for help received through the owner's help network rides the same
// /positions answer as an amber pin: follow off, so it never takes the camera.
const helpPin = (extra = {}) => ({
  id: 'ultra-network:n-0123456789abcdef', kind: 'help', kindLabel: 'NEEDS HELP · 22:14', color: '#ffb000', name: 'Jeff',
  lat: 45.2744, lon: -66.0622, altM: null, headingDeg: null, speedMps: null, live: true, fixed: false, at: 7,
  follow: false, record: false, hasPicture: false, pictureUrl: null, error: '', history: null,
  ...extra,
});

test('a NEEDS HELP pin from the help network is kept as it is: amber, live, never followed', () => {
  const rows = normalizeDevicePositions({ devices: [helpPin()] });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.id, 'ultra-network:n-0123456789abcdef');
  assert.deepEqual(
    [row.kind, row.kindLabel, row.color, row.name, row.follow, row.record, row.live, row.pictureUrl],
    ['help', 'NEEDS HELP · 22:14', '#ffb000', 'Jeff', false, false, true, ''],
  );
  assert.deepEqual([row.lat, row.lon, row.altM, row.headingDeg, row.speedMps], [45.2744, -66.0622, null, null, null]);
  assert.deepEqual(deviceDetailLines(row), ['NEEDS HELP · 22:14']);
});

test('label lines', () => {
  assert.deepEqual(deviceDetailLines(device()), ['DRONE', '36 KM/H · HDG 090 · ALT 40 M']);
  assert.deepEqual(deviceDetailLines(device({ kindLabel: 'MARINE DRONE', altM: -12, speedMps: null, headingDeg: -90 })), ['MARINE DRONE', 'HDG 270 · DEPTH 12 M']);
  assert.deepEqual(deviceDetailLines(device({ live: false, altM: null, speedMps: null, headingDeg: null })), ['DRONE · FIXED POSITION']);
  assert.deepEqual(deviceDetailLines(device({ live: false, error: 'HTTP 401', altM: null, speedMps: null, headingDeg: null })), ['DRONE · NO SIGNAL']);
  const card = createDeviceOverlayEntry({ device: device(), position: {} });
  assert.deepEqual([card.variant, card.title, card.accent, card.interactive], ['card', 'SCOUT', '#36dcff', false]);
  const picture = createDeviceOverlayEntry({ device: device(), position: {}, image: { width: 320 } });
  assert.deepEqual([picture.variant, picture.details], ['thumbnail', []]);
  assert.ok(card.priority > createDeviceOverlayEntry({ device: device({ live: false }), position: {} }).priority);
});

test('a trail grows only when the device actually moved', () => {
  const trail = [];
  assert.equal(extendDeviceTrail(trail, { lat: 45, lon: -66 }), true);
  assert.equal(extendDeviceTrail(trail, { lat: 45.000001, lon: -66 }), false, 'GPS jitter');
  assert.equal(extendDeviceTrail(trail, { lat: 45.001, lon: -66 }), true);
  assert.ok(Math.abs(deviceStepMeters(trail[0], trail[1]) - 110.54) < 0.1);
  for (let i = 0; i < 20; i += 1) extendDeviceTrail(trail, { lat: 45.002 + i * 0.001, lon: -66 }, { limit: 5 });
  assert.equal(trail.length, 5);
});

function fixture({ answers, options = {} }) {
  const dataSources = [];
  const viewer = {
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) { dataSources.splice(dataSources.indexOf(dataSource), 1); return true; },
    },
  };
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['set', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const listeners = new Map();
  const dispatched = [];
  const windowRef = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    dispatchEvent: (event) => { dispatched.push(event); return true; },
  };
  const images = [];
  const asked = [];
  const layer = createDeviceFeedsLayer({
    overlayHost,
    windowRef,
    createImage: () => { const image = {}; images.push(image); return image; },
    fetchImpl: async (url) => { asked.push(url); return answers.shift()(); },
    ...options,
  });
  return { layer, viewer, dataSources, calls, listeners, dispatched, images, asked };
}

const ok = (devices) => () => new Response(JSON.stringify({ devices }), { status: 200 });

test('devices appear, move, leave a trail, and go when removed', async () => {
  const { layer, viewer, dataSources, calls, images } = fixture({
    answers: [
      ok([device({ pictureUrl: '/api/device-feeds/frame/device-drone-scout' }), device({ id: 'device-tracker-van', kind: 'tracker', altM: null, live: false })]),
      ok([device({ lat: 45.28, pictureUrl: '/api/device-feeds/frame/device-drone-scout' })]),
      () => new Response('', { status: 404 }),
      ok('broken'),
    ],
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  const entities = dataSources[0].entities;
  assert.deepEqual(entities.values.map((entity) => entity.id).sort(), ['device-feed:device-drone-scout', 'device-feed:device-tracker-van']);
  assert.deepEqual(layer.getStats().count, 2);
  let published = calls.filter((call) => call[0] === 'set').at(-1);
  assert.equal(published[1], DEVICE_FEEDS_OVERLAY_SOURCE_ID);
  assert.deepEqual(published[2].map((entry) => entry.variant), ['card', 'card'], 'a picture shows once it has loaded');

  assert.equal(images.length, 1);
  assert.match(images[0].src, /^\/api\/device-feeds\/frame\/device-drone-scout\?t=\d+$/);
  images[0].onload();
  published = calls.filter((call) => call[0] === 'set').at(-1);
  assert.deepEqual(published[2].map((entry) => entry.variant), ['thumbnail', 'card']);

  assert.equal(await layer.update(viewer), true);
  assert.deepEqual(entities.values.map((entity) => entity.id).sort(), ['device-feed-trail:device-drone-scout', 'device-feed:device-drone-scout']);
  assert.equal(layer.getAnalystRecords().length, 1);
  assert.deepEqual(Object.keys(layer.getAnalystRecords()[0]).sort(), ['altM', 'headingDeg', 'id', 'kind', 'lat', 'live', 'lon', 'name', 'speedMps', 'timeMs']);

  // A failed poll keeps what was last known.
  assert.equal(await layer.update(viewer), false);
  assert.match(layer.getStats().error, /local server/);
  assert.equal(await layer.update(viewer), false);
  assert.equal(entities.values.length, 2);

  layer.disable(viewer);
  assert.deepEqual(calls.slice(-2), [['clear', DEVICE_FEEDS_OVERLAY_SOURCE_ID], ['visible', DEVICE_FEEDS_OVERLAY_SOURCE_ID, false]]);
  assert.deepEqual(layer.getAnalystRecords(), []);
  layer.destroy(viewer);
  assert.equal(dataSources.length, 0);
});

test('saving a device turns the layer on; a change refreshes it', async () => {
  const { layer, viewer, listeners } = fixture({ answers: [] });
  const asks = [];
  layer.attachDataManager({
    setEnabled: (...args) => { asks.push(['enable', ...args]); return Promise.resolve(true); },
    refreshLayer: (...args) => { asks.push(['refresh', ...args]); return Promise.resolve(true); },
  });
  // Before init: the manager initialises a layer only when it is first enabled.
  const changed = listeners.get(DEVICE_FEEDS_CHANGED_EVENT);
  changed({ detail: { count: 0 } });
  assert.deepEqual(asks, [], 'removing the last device does not turn the layer on');
  changed({ detail: { count: 2 } });
  assert.deepEqual(asks, [['enable', DEVICE_FEEDS_LAYER_ID, true]]);
  layer.init(viewer);
  layer.enable(viewer);
  changed({ detail: { count: 3 } });
  assert.deepEqual(asks.at(-1), ['refresh', DEVICE_FEEDS_LAYER_ID]);
  layer.destroy(viewer);
  assert.equal(listeners.size, 0);
});

test('MAP on a received call for help asks for one flight to the pin, waiting for the poll when it is not there yet', async () => {
  const other = helpPin({ id: 'ultra-network:n-fedcba9876543210', name: 'Sam', lat: 45.3, lon: -66.1 });
  const { layer, viewer, listeners, dispatched } = fixture({
    answers: [ok([device(), helpPin()]), ok([device(), helpPin(), other])],
  });
  layer.attachDataManager({ setEnabled: () => Promise.resolve(true), refreshLayer: () => Promise.resolve(true) });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  const focus = listeners.get(DEVICE_FEEDS_FOCUS_EVENT);
  assert.equal(typeof focus, 'function', 'the layer listens for the Ultra box');

  // The pin is on the map: the request goes out at once, as a help target.
  focus({ detail: { id: 'ultra-network:n-0123456789abcdef' } });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, WORLD_FOCUS_REQUEST_EVENT);
  assert.equal(dispatched[0].detail.kind, 'help');
  assert.equal(dispatched[0].detail.id, 'ultra-network:n-0123456789abcdef');
  for (const axis of ['x', 'y', 'z']) assert.ok(Number.isFinite(dispatched[0].detail.position[axis]));
  // It is a one-shot flight, never a follow: the layer tracks nothing.
  assert.equal(layer.getStats().following, null);

  // A pin the poll has not brought yet waits, and flies when it arrives.
  focus({ detail: { id: 'ultra-network:n-fedcba9876543210' } });
  assert.equal(dispatched.length, 1);
  assert.equal(await layer.update(viewer), true);
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[1].detail.id, 'ultra-network:n-fedcba9876543210');
  assert.equal(dispatched[1].detail.kind, 'help');

  // An empty or malformed ask is inert.
  focus({ detail: {} });
  focus(null);
  assert.equal(dispatched.length, 2);

  layer.destroy(viewer);
  assert.equal(listeners.has(DEVICE_FEEDS_FOCUS_EVENT), false, 'destroy removes the focus listener');
  assert.equal(listeners.size, 0);
});

test('a device with a recording draws its saved route, asked for once and again only when the recording grew', async () => {
  const track = (points) => () => new Response(JSON.stringify({ id: 'device-tracker-van', points }), { status: 200 });
  const van = (extra = {}) => device({ id: 'device-tracker-van', kind: 'tracker', kindLabel: 'TRACKER', color: '#ff7ad9', name: 'Van', ...extra });
  const { layer, viewer, dataSources, asked } = fixture({
    answers: [
      ok([van({ history: { days: 2, lastAt: 1000 } })]),
      track([{ at: 1, lat: 45.2, lon: -66.1 }, { at: 2, lat: 45.21, lon: -66.11 }, { at: 3, lat: 45.22, lon: -66.12 }]),
      ok([van({ history: { days: 2, lastAt: 1000 } })]),
      ok([van({ history: { days: 3, lastAt: 2000 } })]),
      track([{ at: 1, lat: 45.2, lon: -66.1 }, { at: 4, lat: 45.3, lon: -66.2 }]),
      ok([van({ history: null })]),
    ],
  });
  layer.init(viewer);
  layer.enable(viewer);
  const entities = dataSources[0].entities;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const historyEntity = () => entities.values.find((entity) => entity.id === 'device-feed-history:device-tracker-van');

  assert.equal(await layer.update(viewer), true);
  await settle();
  await settle();
  assert.equal(asked.filter((url) => url.startsWith('/api/device-feeds/track/')).length, 1);
  // The last 30 days unless the Ultra box chose otherwise.
  assert.match(asked[1], /^\/api\/device-feeds\/track\/device-tracker-van\?days=31&since=\d+$/);
  assert.ok(historyEntity(), 'the saved route is drawn');
  assert.equal(historyEntity().polyline.positions.getValue().length, 3);

  // Same recording: not asked again.
  assert.equal(await layer.update(viewer), true);
  await settle();
  assert.equal(asked.filter((url) => url.startsWith('/api/device-feeds/track/')).length, 1);

  // The recording grew: asked again, redrawn.
  assert.equal(await layer.update(viewer), true);
  await settle();
  await settle();
  assert.equal(asked.filter((url) => url.startsWith('/api/device-feeds/track/')).length, 2);
  assert.equal(historyEntity().polyline.positions.getValue().length, 2);

  // No recording any more: the line goes.
  assert.equal(await layer.update(viewer), true);
  await settle();
  assert.equal(historyEntity(), undefined);
  layer.destroy(viewer);
});

test('the Ultra box chooses how much saved route the map draws: live only draws none, another period asks again', async () => {
  const NOW = Date.UTC(2026, 9, 6, 12);
  const track = (points) => () => new Response(JSON.stringify({ id: 'device-tracker-van', points }), { status: 200 });
  const van = () => device({ id: 'device-tracker-van', kind: 'tracker', kindLabel: 'TRACKER', color: '#ff7ad9', name: 'Van', history: { days: 2, lastAt: 1000 } });
  const route = [{ at: 1, lat: 45.2, lon: -66.1 }, { at: 2, lat: 45.21, lon: -66.11 }];
  const { layer, viewer, dataSources, asked, listeners } = fixture({
    answers: [ok([van()]), track(route), ok([van()]), ok([van()]), track(route)],
    options: { historyPeriod: '24h', now: () => NOW },
  });
  layer.attachDataManager({ setEnabled: () => Promise.resolve(true), refreshLayer: () => Promise.resolve(true) });
  layer.init(viewer);
  layer.enable(viewer);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const tracks = () => asked.filter((url) => url.startsWith('/api/device-feeds/track/'));
  const historyEntity = () => dataSources[0].entities.values.find((entity) => entity.id === 'device-feed-history:device-tracker-van');

  // A stored choice of 24 hours: the request names that period.
  assert.equal(await layer.update(viewer), true);
  await settle();
  await settle();
  assert.deepEqual(tracks(), [`/api/device-feeds/track/device-tracker-van?${deviceHistoryQuery('24h', NOW)}`]);
  assert.ok(historyEntity(), 'the saved route is drawn');
  // Live only: no request, and the line goes.
  const choose = listeners.get(DEVICE_FEEDS_HISTORY_EVENT);
  assert.equal(typeof choose, 'function', 'the layer listens for the Ultra box');
  choose({ detail: { period: 'live' } });
  assert.equal(await layer.update(viewer), true);
  await settle();
  assert.equal(tracks().length, 1);
  assert.equal(historyEntity(), undefined);
  // Last hour: asked again, from one hour back.
  choose({ detail: { period: '1h' } });
  assert.equal(await layer.update(viewer), true);
  await settle();
  await settle();
  assert.equal(tracks().length, 2);
  assert.equal(tracks()[1], `/api/device-feeds/track/device-tracker-van?${deviceHistoryQuery('1h', NOW)}`);
  assert.equal(historyEntity().polyline.positions.getValue().length, 2);
  layer.destroy(viewer);
  assert.equal(listeners.has(DEVICE_FEEDS_HISTORY_EVENT), false, 'destroy removes the period listener');
});

test('Ultra cells show together or one at a time: a cell left off the map is not drawn', async () => {
  const cell = (id, name, lat) => device({ id, kind: 'security', kindLabel: 'PACKAGE', name, lat, follow: false, record: true });
  const both = () => ok([cell('device-security-a', 'Ann', 45.27), cell('device-security-b', 'Bob', 45.28)]);
  const { layer, viewer, dataSources, listeners } = fixture({
    answers: [both(), both(), both()],
    options: { hiddenDevices: ['device-security-b', 'not-a-device'] },
  });
  layer.attachDataManager({ setEnabled: () => Promise.resolve(true), refreshLayer: () => Promise.resolve(true) });
  layer.init(viewer);
  layer.enable(viewer);
  const drawn = () => dataSources[0].entities.values.filter((entity) => entity.point).map((entity) => entity.id).sort();
  assert.equal(await layer.update(viewer), true);
  assert.deepEqual(drawn(), ['device-feed:device-security-a']);
  assert.equal(layer.getStats().count, 1);
  // Shown together.
  listeners.get(DEVICE_FEEDS_VISIBLE_EVENT)({ detail: { hidden: [] } });
  assert.equal(await layer.update(viewer), true);
  assert.deepEqual(drawn(), ['device-feed:device-security-a', 'device-feed:device-security-b']);
  // Bob alone.
  listeners.get(DEVICE_FEEDS_VISIBLE_EVENT)({ detail: { hidden: ['device-security-a'] } });
  assert.equal(await layer.update(viewer), true);
  assert.deepEqual(drawn(), ['device-feed:device-security-b']);
  layer.destroy(viewer);
  assert.equal(listeners.has(DEVICE_FEEDS_VISIBLE_EVENT), false);
});

test('a cell can be on the map without its path, and its path comes back when asked', async () => {
  const cell = (lat) => device({ id: 'device-security-a', kind: 'security', kindLabel: 'PACKAGE', name: 'Ann', lat, follow: false });
  const { layer, viewer, dataSources, listeners } = fixture({
    answers: [ok([cell(45.27)]), ok([cell(45.28)]), ok([cell(45.29)])],
    options: { noPathDevices: ['device-security-a'] },
  });
  layer.attachDataManager({ setEnabled: () => Promise.resolve(true), refreshLayer: () => Promise.resolve(true) });
  layer.init(viewer);
  layer.enable(viewer);
  const entity = (id) => dataSources[0].entities.values.find((item) => item.id === id);
  assert.equal(await layer.update(viewer), true);
  assert.equal(await layer.update(viewer), true);
  assert.ok(entity('device-feed:device-security-a'), 'the pin is drawn');
  assert.equal(entity('device-feed-trail:device-security-a').show, false, 'the trail is kept but unseen');
  listeners.get(DEVICE_FEEDS_VISIBLE_EVENT)({ detail: { hidden: [], noPath: [] } });
  assert.equal(await layer.update(viewer), true);
  assert.equal(entity('device-feed-trail:device-security-a').show, true);
  layer.destroy(viewer);
});
