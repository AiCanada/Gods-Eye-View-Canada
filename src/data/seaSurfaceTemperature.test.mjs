import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initSeaSurfaceTemperaturePanel,
  sstEarthdataLabel,
  sstFrontsLabel,
  sstTileUrlTemplate,
  sstViewBbox,
} from './seaSurfaceTemperature.js';
import {
  DEFAULT_SST_FRONT_SENSITIVITY,
  DEFAULT_SST_PRODUCT_ID,
  SST_FRONT_SENSITIVITIES,
  SST_PRODUCTS,
  sstProductById,
} from './sstProducts.js';

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function fakeElement(tagName = 'div') {
  const listeners = {};
  const classes = new Set();
  return {
    tagName,
    textContent: '',
    value: '',
    disabled: false,
    children: [],
    attributes: {},
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((entry) => entry !== fn);
    },
    dispatch(type) {
      for (const fn of listeners[type] || []) fn({ target: this });
    },
    listenerCount: (type) => (listeners[type] || []).length,
    append(child) {
      this.children.push(child);
    },
  };
}

function fakeDom() {
  const ids = [
    'sst-panel', 'sst-enable-btn', 'sst-fronts-btn', 'sst-fronts-sensitivity', 'sst-product-select',
    'sst-opacity', 'sst-date', 'sst-fronts', 'sst-earthdata', 'sst-legend-min', 'sst-legend-max', 'sst-note',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, fakeElement()]));
  elements['sst-opacity'].value = '60';
  return {
    elements,
    documentRef: {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => fakeElement(tag),
    },
  };
}

function fakeViewer() {
  const added = [];
  const moveEnd = [];
  const radians = (degrees) => (degrees * Math.PI) / 180;
  return {
    added,
    moveEnd,
    isDestroyed: () => false,
    camera: {
      computeViewRectangle: () => ({ west: radians(-67), south: radians(44), east: radians(-65), north: radians(46) }),
      moveEnd: {
        addEventListener: (fn) => {
          moveEnd.push(fn);
          return () => moveEnd.splice(moveEnd.indexOf(fn), 1);
        },
      },
    },
    scene: { globe: { show: true }, postRender: { addEventListener: () => () => {} } },
    imageryLayers: {
      add: (layer) => added.push(layer),
      remove: (layer) => added.splice(added.indexOf(layer), 1),
    },
  };
}

const STATUS = {
  products: [{ id: 'modis-aqua-night', latestDate: '2026-09-12' }],
  oceanColor: { latestModisAquaL3Date: '2026-07-31' },
  earthdata: { configured: true, authenticated: true },
};

const META = {
  period: 'day',
  startDate: '2026-07-31',
  endDate: '2026-07-31',
  cellKm: 4.6,
  width: 58,
  height: 58,
  rectangle: { west: -68, south: 43, east: -64, north: 47 },
  sstRange: { min: 12.3, max: 21.8 },
  landMask: 'applied',
  fronts: { sensitivity: 'strong', cells: 1234, maxGradientCPerKm: 0.214 },
};

function fakeServer() {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.includes('/api/sst/status')) return { ok: true, json: async () => STATUS };
    if (url.includes('/api/sst/l3/meta')) return { ok: true, status: 200, json: async () => META };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { requests, fetchImpl };
}

test('GIBS tile URL uses the product grid and the given date, or GIBS newest', () => {
  const product = sstProductById('mur-fronts');
  assert.equal(
    sstTileUrlTemplate(product, '2026-09-09'),
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature/default/2026-09-09/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png',
  );
  assert.match(sstTileUrlTemplate(product, null), /\/default\/default\//);
});

test('products: Level-3 first and default; tile products zoom as deep as their grid', () => {
  assert.equal(new Set(SST_PRODUCTS.map((product) => product.id)).size, SST_PRODUCTS.length);
  assert.equal(DEFAULT_SST_PRODUCT_ID, 'oceancolor-l3-day');
  assert.equal(sstProductById(DEFAULT_SST_PRODUCT_ID).source, 'oceancolor');
  for (const product of SST_PRODUCTS.filter((entry) => entry.source === 'gibs')) {
    assert.equal(product.matrixSet, `GoogleMapsCompatible_Level${product.maximumLevel}`);
  }
  assert.deepEqual(
    SST_PRODUCTS.filter((entry) => entry.source === 'oceancolor').map((entry) => entry.period),
    ['day', '8d'],
  );
  assert.deepEqual(SST_FRONT_SENSITIVITIES.map((level) => level.id), ['strong', 'moderate', 'all']);
  assert.equal(DEFAULT_SST_FRONT_SENSITIVITY, 'strong');
});

test('view box is padded, snapped to whole degrees, and global across the antimeridian', () => {
  assert.equal(sstViewBbox({ west: -66.5, south: 44.2, east: -65.3, north: 45.6 }), '-67,44,-65,46');
  assert.equal(sstViewBbox({ west: 170, south: -10, east: -170, north: 10 }), '-180,-12,180,12');
  assert.equal(sstViewBbox(null), '-180,-90,180,90');
});

test('readouts cover sign-in and fronts states', () => {
  assert.match(sstEarthdataLabel({ configured: false }), /NO TOKEN/);
  assert.equal(
    sstEarthdataLabel({ configured: true, authenticated: true }, { latestModisAquaL3Date: '2026-07-31' }),
    'EARTHDATA · SIGNED IN · MODIS AQUA L3 FILES TO 2026-07-31',
  );
  assert.equal(sstFrontsLabel(META, false), 'FRONTS · OFF');
  assert.equal(sstFrontsLabel(META, true), 'FRONTS · STRONG · 1,234 CELLS · STRONGEST 0.21 °C/KM');
  assert.equal(sstFrontsLabel({ fronts: { sensitivity: 'all', cells: 0 } }, true), 'FRONTS · ALL · NONE IN THIS VIEW');
});

test('the layer is off at launch and requests nothing', () => {
  const { elements, documentRef } = fakeDom();
  const viewer = fakeViewer();
  const server = fakeServer();
  const destroy = initSeaSurfaceTemperaturePanel({ viewer, documentRef, fetchImpl: server.fetchImpl });
  assert.equal(elements['sst-enable-btn'].textContent, 'SST OFF');
  assert.equal(elements['sst-product-select'].value, DEFAULT_SST_PRODUCT_ID);
  assert.equal(elements['sst-product-select'].children.length, SST_PRODUCTS.length);
  assert.equal(elements['sst-fronts-sensitivity'].value, 'strong');
  assert.equal(elements['sst-fronts-sensitivity'].children.length, SST_FRONT_SENSITIVITIES.length);
  assert.equal(elements['sst-fronts-btn'].textContent, 'FRONTS ON');
  assert.equal(viewer.added.length, 0);
  assert.equal(server.requests.length, 0);
  destroy();
  assert.equal(elements['sst-enable-btn'].listenerCount('click'), 0);
  assert.equal(elements['sst-fronts-sensitivity'].listenerCount('change'), 0);
  assert.equal(viewer.moveEnd.length, 0);
});

test('Level-3: on draws SST plus fronts for the view; sensitivity asks again', async () => {
  const { elements, documentRef } = fakeDom();
  const viewer = fakeViewer();
  const server = fakeServer();
  const destroy = initSeaSurfaceTemperaturePanel({
    viewer, documentRef, fetchImpl: server.fetchImpl, apiBase: 'http://localhost:4173',
  });
  elements['sst-enable-btn'].dispatch('click');
  await flush();
  const meta = server.requests.find((url) => url.includes('/api/sst/l3/meta'));
  assert.ok(meta.includes('period=day'));
  assert.ok(meta.includes(`bbox=${encodeURIComponent('-68,43,-64,47')}`));
  assert.ok(meta.includes('fronts=strong'));
  assert.equal(viewer.added.length, 2, 'SST image and fronts overlay');
  assert.equal(viewer.added[0].alpha, 0.6);
  assert.equal(viewer.added[1].alpha, 1);
  assert.equal(elements['sst-date'].textContent, 'DATA DATE · 2026-07-31 · 4.6 KM');
  assert.equal(elements['sst-legend-min'].textContent, '12.3 °C');
  assert.equal(elements['sst-legend-max'].textContent, '21.8 °C');
  assert.match(elements['sst-fronts'].textContent, /STRONG · 1,234 CELLS/);

  elements['sst-fronts-sensitivity'].value = 'moderate';
  elements['sst-fronts-sensitivity'].dispatch('change');
  await flush();
  assert.ok(server.requests.some((url) => url.includes('/api/sst/l3/meta') && url.includes('fronts=moderate')));
  assert.equal(viewer.added.length, 2);

  elements['sst-fronts-btn'].dispatch('click');
  await flush();
  assert.equal(viewer.added.length, 1, 'fronts off leaves only SST');
  assert.equal(elements['sst-fronts'].textContent, 'FRONTS · OFF');
  assert.equal(elements['sst-fronts-sensitivity'].disabled, true);

  elements['sst-enable-btn'].dispatch('click');
  await flush();
  assert.equal(viewer.added.length, 0);
  destroy();
});

test('GIBS tiles: choosing a tile product draws one tile layer for its newest date', async () => {
  const { elements, documentRef } = fakeDom();
  const viewer = fakeViewer();
  const server = fakeServer();
  const destroy = initSeaSurfaceTemperaturePanel({ viewer, documentRef, fetchImpl: server.fetchImpl });
  elements['sst-product-select'].value = 'modis-aqua-night';
  elements['sst-product-select'].dispatch('change');
  assert.equal(elements['sst-fronts-btn'].disabled, true, 'fronts need Level-3 data');
  assert.equal(elements['sst-fronts-sensitivity'].disabled, true);
  elements['sst-enable-btn'].dispatch('click');
  await flush();
  assert.equal(viewer.added.length, 1);
  assert.equal(elements['sst-date'].textContent, 'DATA DATE · 2026-09-12');
  assert.equal(elements['sst-legend-min'].textContent, 'COLD');
  assert.ok(!server.requests.some((url) => url.includes('/api/sst/l3/')));
  destroy();
});

// --- location switch ---------------------------------------------------------
// The panel is not a DataLayerManager layer, so it hears switches on window as
// `gev:location-switch` with detail.phase 'leave' | 'arrive'.

/** Event target that counts location-switch listeners, plus a dispatcher. */
function locationSwitchWindow() {
  const target = new EventTarget();
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  let listeners = 0;
  target.addEventListener = (type, fn, options) => {
    if (type === 'gev:location-switch') listeners += 1;
    add(type, fn, options);
  };
  target.removeEventListener = (type, fn, options) => {
    if (type === 'gev:location-switch') listeners -= 1;
    remove(type, fn, options);
  };
  return {
    windowRef: target,
    listeners: () => listeners,
    switchPhase: (phase) => target.dispatchEvent(new CustomEvent('gev:location-switch', {
      detail: { phase, from: null, to: null },
    })),
  };
}

/**
 * Level-3 server whose meta answers wait for release() while `hold` is on.
 * It ignores aborts on purpose, the way an answer already on the wire does.
 */
function heldServer() {
  const requests = [];
  const held = [];
  const server = {
    hold: false,
    metaRequests: () => requests.filter((url) => url.includes('/api/sst/l3/meta')),
    release() { for (const resolve of held.splice(0)) resolve(); },
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.includes('/api/sst/status')) return { ok: true, json: async () => STATUS };
      if (server.hold) await new Promise((resolve) => { held.push(resolve); });
      return { ok: true, status: 200, json: async () => META };
    },
  };
  return server;
}

/** Microtask flush that does not depend on (possibly mocked) setTimeout. */
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('location switch: leave drops the old Level-3 view and holds camera refreshes while SST stays on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { elements, documentRef } = fakeDom();
  const viewer = fakeViewer();
  const server = heldServer();
  const events = locationSwitchWindow();
  const destroy = initSeaSurfaceTemperaturePanel({
    viewer, documentRef, windowRef: events.windowRef, fetchImpl: server.fetchImpl,
  });
  assert.equal(events.listeners(), 1);
  elements['sst-enable-btn'].dispatch('click');
  await settle();
  assert.equal(viewer.added.length, 2, 'precondition: SST and fronts drawn for the first view');
  assert.equal(server.metaRequests().length, 1);

  // A camera-settle refresh already counting down for the old view.
  viewer.moveEnd[0]();
  events.switchPhase('leave');
  assert.equal(viewer.added.length, 0, 'the old view\'s Level-3 images are removed');
  assert.equal(elements['sst-enable-btn'].textContent, 'SST ON', 'the layer stays on');
  t.mock.timers.tick(750);
  await settle();
  assert.equal(server.metaRequests().length, 1, 'the pending old-view refresh was cancelled');

  // Camera settles during the flight wait for arrival.
  viewer.moveEnd[0]();
  t.mock.timers.tick(750);
  await settle();
  assert.equal(server.metaRequests().length, 1, 'nothing is requested for a mid-flight view');

  destroy();
  assert.equal(events.listeners(), 0, 'the disposer removes the window listener');
});

test('location switch: arrival asks once for the destination, even when the camera settles while it loads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { elements, documentRef } = fakeDom();
  const viewer = fakeViewer();
  const server = heldServer();
  const events = locationSwitchWindow();
  const destroy = initSeaSurfaceTemperaturePanel({
    viewer, documentRef, windowRef: events.windowRef, fetchImpl: server.fetchImpl,
  });
  elements['sst-enable-btn'].dispatch('click');
  await settle();
  events.switchPhase('leave');

  const radians = (degrees) => (degrees * Math.PI) / 180;
  viewer.camera.computeViewRectangle = () => ({
    west: radians(150), south: radians(-40), east: radians(152), north: radians(-38),
  });
  server.hold = true;
  events.switchPhase('arrive');
  await settle();
  assert.equal(server.metaRequests().length, 2);
  assert.ok(
    server.metaRequests()[1].includes(`bbox=${encodeURIComponent('149,-41,153,-37')}`),
    'arrival asks for the destination view straight away',
  );

  // The flight's own moveEnd lands after arrival and would restart the request.
  viewer.moveEnd[0]();
  t.mock.timers.tick(750);
  await settle();
  assert.equal(server.metaRequests().length, 2, 'the same view already on its way is not asked again');

  server.release();
  await settle();
  assert.equal(viewer.added.length, 2, 'the destination is drawn');
  destroy();
});

test('location switch: an old-view answer that lands after leave is never drawn', async () => {
  const { elements, documentRef } = fakeDom();
  const viewer = fakeViewer();
  const server = heldServer();
  const events = locationSwitchWindow();
  const destroy = initSeaSurfaceTemperaturePanel({
    viewer, documentRef, windowRef: events.windowRef, fetchImpl: server.fetchImpl,
  });
  server.hold = true;
  elements['sst-enable-btn'].dispatch('click');
  await settle();
  assert.equal(server.metaRequests().length, 1, 'precondition: the old view is loading');

  events.switchPhase('leave');
  server.release();
  await settle();
  assert.equal(viewer.added.length, 0, 'the aborted request\'s answer is dropped');
  destroy();
});

test('location switch: GIBS tiles are global and stay through a switch', async () => {
  const { elements, documentRef } = fakeDom();
  const viewer = fakeViewer();
  const server = fakeServer();
  const events = locationSwitchWindow();
  const destroy = initSeaSurfaceTemperaturePanel({
    viewer, documentRef, windowRef: events.windowRef, fetchImpl: server.fetchImpl,
  });
  elements['sst-product-select'].value = 'modis-aqua-night';
  elements['sst-product-select'].dispatch('change');
  elements['sst-enable-btn'].dispatch('click');
  await flush();
  assert.equal(viewer.added.length, 1, 'precondition: one tile layer');

  events.switchPhase('leave');
  events.switchPhase('arrive');
  await flush();
  assert.equal(viewer.added.length, 1, 'the tile layer is kept');
  assert.ok(!server.requests.some((url) => url.includes('/api/sst/l3/')), 'no Level-3 request');
  destroy();
});
