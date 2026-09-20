import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEEDS_CHANGED_EVENT } from '../deviceFeedsCore.mjs';
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
  assert.deepEqual([entry?.token, entry?.disposition], ['v', 'enabled-only']);
});

test('only well-formed devices, and only the application’s own picture route', () => {
  assert.equal(normalizeDevicePositions(null), null);
  assert.equal(normalizeDevicePositions({ devices: 'no' }), null);
  const rows = normalizeDevicePositions({
    devices: [
      device({ pictureUrl: '/api/device-feeds/frame/device-drone-scout' }),
      device(),
      device({ id: 'b', lat: 91 }),
      device({ id: 'c', lon: '12' }),
      device({ id: 'd', color: 'url(javascript:1)', pictureUrl: 'https://evil.example/x.jpg', name: '' }),
      null,
    ],
  });
  assert.deepEqual(rows.map((row) => row.id), ['device-drone-scout', 'd']);
  assert.equal(rows[0].pictureUrl, '/api/device-feeds/frame/device-drone-scout');
  assert.deepEqual([rows[1].color, rows[1].pictureUrl, rows[1].name], ['#ffffff', '', 'DEVICE']);
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

function fixture({ answers }) {
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
  const windowRef = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const images = [];
  const asked = [];
  const layer = createDeviceFeedsLayer({
    overlayHost,
    windowRef,
    createImage: () => { const image = {}; images.push(image); return image; },
    fetchImpl: async (url) => { asked.push(url); return answers.shift()(); },
  });
  return { layer, viewer, dataSources, calls, listeners, images, asked };
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
