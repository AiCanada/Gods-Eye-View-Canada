// Location switch hooks for the FIRMS layer. Leave releases what was built for
// the old VIEW (never the worldwide fire dataset) and holds every rebuild
// through the flight; arrival draws the destination once from the kept data.
// Boots the REAL layer against the same headless viewer stub the horizon-cull
// suite uses, with a real Cesium.BillboardCollection and CustomDataSource.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFirmsHeatmapLayer } from './firmsHeatmap.js';
import { FIRMS_OVERLAY_SOURCE_ID } from './firmsLabels.js';
import { getContextStore } from './contextStore.js';
import { isOwnedByOtherLayer } from './pickRegistry.js';
import { unregisterSpriteCollection } from './spriteOrder.js';

const AUSTIN = { lon: -97.7, lat: 30.2 };
const TOKYO = { lon: 139.7, lat: 35.7 };
/** Camera height inside the 'local' band: individual detections as sprites. */
const DETECTIONS_HEIGHT_M = 1_500_000;
/** Camera height inside the 'global' band: aggregated heat-cell rectangles. */
const CELLS_HEIGHT_M = 12_000_000;
const FROM = { key: 'US-TX', region: 'US-TX', country: 'US', lat: AUSTIN.lat, lon: AUSTIN.lon };
const TO = { key: 'JP-13', region: 'JP-13', country: 'JP', lat: TOKYO.lat, lon: TOKYO.lon };

class MockEvent {
  constructor() { this.listeners = new Set(); }
  addEventListener(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of [...this.listeners]) listener(); }
}

/** Canvas stub good enough for the pre-baked glow sprites. */
function canvasStub() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop() {} }),
      fillStyle: null,
      fillRect() {},
    }),
    toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
  };
}

/** Proxy-shaped FIRMS record (firmsCsv shape) for the fetch stub. */
function rawFire(lat, lon, frp) {
  return {
    lat,
    lon,
    frp,
    confidence: 'h',
    brightness: 340,
    daynight: 'D',
    acqDate: '2026-08-03',
    acqTime: '0412',
    instrument: 'VIIRS',
    satellite: 'N20',
  };
}

function createHarness(rawFires, { height = DETECTIONS_HEIGHT_M, overlayHost = {} } = {}) {
  const originalFetch = globalThis.fetch;
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const originalDocument = globalThis.document;
  const originalProject = Cesium.SceneTransforms.worldToWindowCoordinates;

  let payload = rawFires;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return { ok: true, status: 200, json: async () => ({ fires: payload, fetchedAt: Date.now() }) };
  };
  // A real event target: selection clears and world-focus requests dispatch on it.
  const windowTarget = new EventTarget();
  globalThis.window = windowTarget;
  globalThis.document = { createElement: () => canvasStub() };

  // Deterministic projection: every distinct world position gets its own
  // 200 px grid slot inside a 2000x2000 canvas, so declutter never decides.
  const slots = new Map();
  Cesium.SceneTransforms.worldToWindowCoordinates = (scene, position, result) => {
    if (!slots.has(position)) slots.set(position, slots.size);
    const slot = slots.get(position);
    const out = result || new Cesium.Cartesian2();
    out.x = 100 + (slot % 10) * 200;
    out.y = 100 + Math.floor(slot / 10) * 200;
    return out;
  };

  const preRender = new MockEvent();
  const moveEnd = new MockEvent();
  const primitives = [];
  const dataSources = [];
  const published = [];
  const cleared = [];
  const viewer = {
    dataSources: { add: (value) => { dataSources.push(value); return value; }, remove: () => {} },
    camera: {
      moveEnd,
      positionWC: Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, height),
      directionWC: new Cesium.Cartesian3(0, 0, -1),
      positionCartographic: { height },
    },
    scene: {
      canvas: { clientWidth: 2000, clientHeight: 2000 },
      preRender,
      primitives: {
        add: (value) => { primitives.push(value); return value; },
        remove: () => {},
        contains: () => false,
      },
      frameState: { mode: Cesium.SceneMode.SCENE3D, mapProjection: new Cesium.GeographicProjection() },
      mapProjection: new Cesium.GeographicProjection(),
    },
  };

  const layer = createFirmsHeatmapLayer({
    id: 'firms',
    name: 'FIRMS',
    overlayHost: {
      setEntries: (sourceId, entries) => published.push(entries),
      setVisible: () => {},
      clearSource: (sourceId) => cleared.push(sourceId),
      ...overlayHost,
    },
    screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
  });

  return {
    layer,
    viewer,
    windowTarget,
    preRender,
    moveEnd,
    cleared,
    fetchCount: () => fetchCount,
    setPayload(next) { payload = next; },
    async boot() {
      layer.init(viewer);
      await layer.enable(viewer);
    },
    /** Sprites currently in the real BillboardCollection. */
    sprites: () => primitives[0]?.length ?? 0,
    /** Heat-cell rectangle entities currently in the layer's data source. */
    cellEntities: () => dataSources[0].entities.values.length,
    publishCount: () => published.length,
    latestEntries: () => published[published.length - 1] || [],
    /** `show` flags keyed by billboard pick id. */
    showById() {
      const bb = primitives[0];
      const out = new Map();
      for (let i = 0; i < bb.length; i += 1) out.set(bb.get(i).id, bb.get(i).show);
      return out;
    },
    moveCameraTo(lon, lat) {
      viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(lon, lat, height);
    },
    cleanup() {
      layer.destroy(viewer);
      unregisterSpriteCollection('firms');
      Cesium.SceneTransforms.worldToWindowCoordinates = originalProject;
      globalThis.fetch = originalFetch;
      if (hadWindow) globalThis.window = originalWindow; else delete globalThis.window;
      if (hadDocument) globalThis.document = originalDocument; else delete globalThis.document;
    },
  };
}

const firmsContextRecords = () => (
  [...getContextStore().entities.values()].filter((record) => record.layerId === 'firms')
);

test('leave releases the rendered view but keeps the worldwide fires; arrival redraws the destination', async () => {
  const h = createHarness([
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(TOKYO.lat, TOKYO.lon, 800),
  ]);
  try {
    await h.boot();
    assert.equal(h.sprites(), 2, 'precondition: both detections are rendered');
    assert.ok(h.latestEntries().length > 0, 'precondition: cards are published');
    assert.equal(isOwnedByOtherLayer('flights', 'firms-0'), true, 'precondition: the sprite is pickable');
    const fetches = h.fetchCount();
    const publishes = h.publishCount();
    const clears = h.cleared.length;

    h.layer.onLocationLeave({ from: FROM, to: TO, enabled: true });

    assert.equal(h.sprites(), 0, 'the old view\'s sprites are released');
    assert.equal(isOwnedByOtherLayer('flights', 'firms-0'), false, 'the old pick index is released');
    assert.deepEqual(h.cleared.slice(clears), [FIRMS_OVERLAY_SOURCE_ID], 'the old view\'s cards are cleared');
    assert.equal(h.publishCount(), publishes, 'no cards are republished for the view being left');
    assert.equal(firmsContextRecords().length, 0, 'the old view\'s context top-N is released');
    assert.equal(h.layer.getStats().count, 2, 'the worldwide dataset is kept');
    assert.equal(h.layer.getStrongestFire()?.frp, 800, 'global queries still answer mid-flight');
    assert.equal(h.fetchCount(), fetches, 'leave touches no network');

    // Mid-flight: the throttled watcher passes its gate on one of these two
    // ticks (the same wait-out-the-throttle pattern as the horizon suite).
    h.moveCameraTo(TOKYO.lon, TOKYO.lat);
    h.preRender.emit();
    await new Promise((resolve) => { setTimeout(resolve, 700); });
    h.preRender.emit();
    h.moveEnd.emit();
    assert.equal(h.sprites(), 0, 'no LOD rebuild runs for the mid-flight view');
    assert.equal(h.publishCount(), publishes, 'moveEnd does not re-declutter mid-flight');

    h.layer.onLocationArrive({ from: FROM, to: TO });

    const show = h.showById();
    assert.equal(show.size, 2, 'the destination view is drawn from the kept data');
    assert.equal(show.get('firms-1'), true, 'Tokyo, under the camera, is visible');
    assert.equal(show.get('firms-0'), false, 'Austin is culled behind the limb');
    assert.ok(h.publishCount() > publishes, 'destination cards are published');
    assert.ok(firmsContextRecords().length > 0, 'the destination top-N is registered');
    assert.equal(h.fetchCount(), fetches, 'arrival redraws without refetching');
  } finally {
    h.cleanup();
  }
});

test('leave clears a selected fire as a deliberate deselect, once', async () => {
  const h = createHarness([rawFire(AUSTIN.lat, AUSTIN.lon, 120)]);
  const cleared = [];
  try {
    await h.boot();
    h.windowTarget.addEventListener('gev:entity-selection-cleared', (event) => cleared.push(event.detail));
    const card = h.latestEntries().find((entry) => entry.interactive);
    assert.equal(card?.activate(), true, 'precondition: the card selects its detection');
    const publishes = h.publishCount();

    h.layer.onLocationLeave({ from: FROM, to: TO, enabled: true });
    h.layer.onLocationLeave({ from: FROM, to: TO, enabled: true });

    assert.deepEqual(
      cleared,
      [{ layerId: 'firms', reason: 'deliberate' }],
      'the detection is still in the feed, so this is a deselect, never an eviction',
    );
    assert.equal(h.publishCount(), publishes, 'clearing the selection republishes no cards');
    assert.equal(firmsContextRecords().length, 0, 'the selected record goes with the old view');
  } finally {
    h.cleanup();
  }
});

test('a poll that lands mid-switch keeps its data and leaves drawing to the arrival', async () => {
  const h = createHarness([rawFire(AUSTIN.lat, AUSTIN.lon, 120)]);
  try {
    await h.boot();
    h.layer.onLocationLeave({ from: FROM, to: TO, enabled: true });
    h.setPayload([
      rawFire(AUSTIN.lat, AUSTIN.lon, 120),
      rawFire(TOKYO.lat, TOKYO.lon, 800),
      rawFire(TOKYO.lat + 1, TOKYO.lon + 1, 60),
    ]);

    await h.layer.update();
    assert.equal(h.layer.getStats().count, 3, 'the fresh worldwide payload is adopted');
    assert.equal(h.sprites(), 0, 'nothing is drawn for the mid-flight view');

    h.moveCameraTo(TOKYO.lon, TOKYO.lat);
    h.layer.onLocationArrive({ from: FROM, to: TO });
    assert.equal(h.sprites(), 3, 'arrival draws the payload that landed in flight');
  } finally {
    h.cleanup();
  }
});

test('an arrival superseded by a newer switch keeps the rebuild hold', async () => {
  const h = createHarness([rawFire(AUSTIN.lat, AUSTIN.lon, 120)]);
  try {
    await h.boot();
    h.layer.onLocationLeave({ from: FROM, to: TO, enabled: true });
    const controller = new AbortController();
    controller.abort();

    h.layer.onLocationArrive({ from: FROM, to: TO, signal: controller.signal });
    assert.equal(h.sprites(), 0, 'an aborted arrival draws nothing');
    await h.layer.update();
    assert.equal(h.sprites(), 0, 'and does not lift the hold for a later poll');

    h.layer.onLocationArrive({ from: FROM, to: TO });
    assert.equal(h.sprites(), 1, 'the live arrival draws');
  } finally {
    h.cleanup();
  }
});

test('in the heat-cell bands leave removes the old view\'s cell rectangles', async () => {
  const h = createHarness([
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(TOKYO.lat, TOKYO.lon, 800),
  ], { height: CELLS_HEIGHT_M });
  try {
    await h.boot();
    assert.ok(h.cellEntities() > 0, 'precondition: heat cells are rendered');

    h.layer.onLocationLeave({ from: FROM, to: TO, enabled: true });
    assert.equal(h.cellEntities(), 0);

    h.layer.onLocationArrive({ from: FROM, to: TO });
    assert.ok(h.cellEntities() > 0, 'arrival rebuilds the cells from the kept aggregation');
  } finally {
    h.cleanup();
  }
});

test('a switch while the layer is off redraws the current view on re-enable', async () => {
  const h = createHarness([
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(TOKYO.lat, TOKYO.lon, 800),
  ]);
  try {
    await h.boot();
    h.layer.disable();
    h.layer.onLocationLeave({ from: FROM, to: TO, enabled: false });
    assert.equal(h.sprites(), 0, 'a switched-off layer still releases its view');
    const fetches = h.fetchCount();

    // Arrival only reaches enabled layers, so nothing lifts the hold but enable.
    h.moveCameraTo(TOKYO.lon, TOKYO.lat);
    await h.layer.enable(h.viewer);

    const show = h.showById();
    assert.equal(show.size, 2, 'enable draws the current view without a camera move');
    assert.equal(show.get('firms-1'), true);
    assert.equal(show.get('firms-0'), false);
    assert.equal(h.fetchCount(), fetches, 'the kept dataset is reused, not refetched');
  } finally {
    h.cleanup();
  }
});

test('leave never throws, even when the overlay host does', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const host = { failing: true };
  const h = createHarness([rawFire(AUSTIN.lat, AUSTIN.lon, 120)], {
    overlayHost: {
      clearSource: () => {
        if (host.failing) throw new Error('overlay host gone');
      },
    },
  });
  try {
    await h.boot();
    assert.doesNotThrow(() => h.layer.onLocationLeave({ from: FROM, to: TO, enabled: true }));
    assert.doesNotThrow(() => h.layer.onLocationLeave({ from: FROM, to: TO, enabled: true }));
    assert.equal(h.sprites(), 0, 'what was released before the failure stays released');
    assert.equal(console.warn.mock.callCount(), 2);
  } finally {
    host.failing = false;
    h.cleanup();
  }
});
