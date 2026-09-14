import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approximateSurfaceDistanceM,
  classifyGoogleMilitaryPlace,
  installationRecordsOutliveUnboundedView,
  installationSourceLabel,
  installationResponseSaturated,
  installationSurfaceHeightM,
  installationWithinViewport,
} from './militaryInstallations.js';
import militaryInstallationsLayer from './militaryInstallations.js';
import {
  _clearMeshFloorCellsForTest,
  cachedGroundFloor,
  FLOOR_RESOLVE_DEADLINE_MS,
  reportMeshFloorCell,
  setMeshFloorPreferred,
} from './groundFloor.js';
import { _resetFireAnchorsForTest } from './fireAnchors.js';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  installRenderGovernor,
} from '../renderGovernor.js';
import * as Cesium from 'cesium';
import { registerEntityContext, selectEntityContext, getSelectedEntityContext } from './contextStore.js';

test('clicking a selected installation again or empty map clears it through refresh', async () => {
  const run = await runInstallationLoad({ elements: [{ type: 'node', id: 42,
    lat: 30.2, lon: -97.7, tags: { military: 'base', name: 'Site' } }] });
  try {
    for (const nextPick of ['osm:node:42', null]) {
      run.click('osm:node:42');
      assert.equal(getSelectedEntityContext()?.id, 'osm:node:42');
      run.click(nextPick);
      assert.equal(getSelectedEntityContext(), null);
      await militaryInstallationsLayer.update();
      assert.equal(getSelectedEntityContext(), null, 'refresh must not resurrect selection');
      assert.equal(run.entities()[0].point.pixelSize.getValue(), 9);
    }
  } finally { run.restore(); }
});

test('clearing a stale installation highlight does not clear or reclaim another layer selection', async () => {
  const run = await runInstallationLoad({ elements: [{ type: 'node', id: 42,
    lat: 30.2, lon: -97.7, tags: { military: 'base', name: 'Site' } }] });
  try {
    run.click('osm:node:42');
    const aircraft = { id: 'aircraft:test' };
    registerEntityContext(aircraft, { id: aircraft.id, layerId: 'military', label: 'Aircraft' });
    selectEntityContext(aircraft);
    await militaryInstallationsLayer.update();
    assert.equal(getSelectedEntityContext()?.id, aircraft.id, 'non-canvas selection survives a repaint');
    run.click('osm:node:42');
    selectEntityContext(aircraft);
    run.click(aircraft);
    assert.equal(getSelectedEntityContext()?.id, aircraft.id);
    await militaryInstallationsLayer.update();
    assert.equal(getSelectedEntityContext()?.id, aircraft.id);
  } finally { run.restore(); }
});

test('switching sites keeps the new selection through refresh and disable clears it', async () => {
  const run = await runInstallationLoad({ elements: [42, 43].map(id => ({ type: 'node', id,
    lat: 30.2, lon: -97.7, tags: { military: 'base', name: `Site ${id}` } })) });
  try {
    run.click('osm:node:42');
    run.click('osm:node:43');
    assert.equal(getSelectedEntityContext()?.id, 'osm:node:43');
    await militaryInstallationsLayer.update();
    assert.equal(getSelectedEntityContext()?.id, 'osm:node:43');
    assert.equal(run.entities().find(e => e.id === 'osm:node:42').point.pixelSize.getValue(), 9);
    assert.equal(run.entities().find(e => e.id === 'osm:node:43').point.pixelSize.getValue(), 13);
    militaryInstallationsLayer.disable();
    run.click('osm:node:42');
    assert.equal(getSelectedEntityContext(), null, 'disabled layer ignores clicks');
    militaryInstallationsLayer.enable();
    await militaryInstallationsLayer.update();
    assert.equal(getSelectedEntityContext(), null);
  } finally { run.restore(); }
});

test('cheap installation distance prefilter is local and antimeridian-safe', () => {
  const oneDegree = approximateSurfaceDistanceM(0, 0, 0, 1);
  assert.ok(oneDegree > 111000 && oneDegree < 111300);
  const acrossDateline = approximateSurfaceDistanceM(
    Cesium.Math.toRadians(10),
    Cesium.Math.toRadians(179.9),
    10,
    -179.9,
  );
  assert.ok(acrossDateline > 21000 && acrossDateline < 23000);
});

test('keeps generic Places hits distinct from explicitly typed military facilities', () => {
  assert.equal(classifyGoogleMilitaryPlace({ primaryType: 'military_base' }), 'military_land');
  assert.equal(classifyGoogleMilitaryPlace({ types: ['point_of_interest', 'military_base'] }), 'military_land');
  assert.equal(classifyGoogleMilitaryPlace({ name: 'Army Recruiting Office', types: ['government_office'] }), 'places_candidate');
  assert.equal(classifyGoogleMilitaryPlace({ name: 'Military Museum', types: ['museum'] }), 'places_candidate');
});

test('reports the record source instead of attributing Places records to OpenStreetMap', () => {
  assert.equal(installationSourceLabel({ sources: [{ name: 'Google Maps Places' }] }), 'Google Maps Places');
  assert.equal(installationSourceLabel({ sources: [{ name: 'OpenStreetMap' }, { name: 'OpenStreetMap' }] }), 'OpenStreetMap');
});

test('places installation anchors on the shared cached rendered floor', () => {
  setMeshFloorPreferred(true);
  _clearMeshFloorCellsForTest();
  reportMeshFloorCell(30.2, -97.7, 182.25);
  assert.equal(installationSurfaceHeightM({ latitude: 30.2, longitude: -97.7 }), 183.75);
  _clearMeshFloorCellsForTest();
});

test('real enabled installation entities carry no native label graphics', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const canvas = {
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/terrain/heights')) {
      return { ok: true, status: 200, json: async () => ({ results: [{ ellipsoid: 100 }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'fresh',
        retrievedAt: '2026-08-02T00:00:00.000Z',
        elements: [{
          type: 'node',
          id: 42,
          lat: 30.2,
          lon: -97.7,
          tags: { military: 'base', name: 'Runtime Installation' },
        }],
      }),
    };
  };
  const moveEndListeners = new Set();
  const dataSources = [];
  const viewer = {
    camera: {
      moveEnd: {
        addEventListener(listener) {
          moveEndListeners.add(listener);
          return () => moveEndListeners.delete(listener);
        },
      },
      computeViewRectangle() {
        return {
          south: Cesium.Math.toRadians(30),
          west: Cesium.Math.toRadians(-98),
          north: Cesium.Math.toRadians(31),
          east: Cesium.Math.toRadians(-97),
        };
      },
    },
    scene: {
      canvas,
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick() { return null; },
    },
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };

  try {
    militaryInstallationsLayer.init(viewer);
    militaryInstallationsLayer.enable();
    await militaryInstallationsLayer.update();
    const entities = dataSources[0].entities.values;
    assert.ok(entities.length > 0, 'runtime guard requires rendered installation records');
    assert.ok(entities.every((entity) => entity.label === undefined));
  } finally {
    militaryInstallationsLayer.destroy(viewer);
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

const VIEWPORT = { south: 30, west: -98, north: 31, east: -97 };

test('Context focus past the render cap selects for real instead of flying blind', async () => {
  // Context navigation walks the FULL nearby cohort; only the first 700 records
  // get entities. Focusing item 701+ used to fly the camera, find no entity,
  // silently drop the selection, and report success — so the Context subject
  // stayed stale and NEXT offered the same installation forever.
  const elements = Array.from({ length: 760 }, (_, index) => ({
    type: 'node',
    id: 1000 + index,
    lat: 30.1 + (index % 40) * 0.002,
    lon: -97.9 + Math.floor(index / 40) * 0.002,
    tags: { military: 'base', name: `Installation ${index}` },
  }));
  const run = await runInstallationLoad({ elements });
  const flights = [];
  try {
    const renderedIds = new Set(run.entities().map((entity) => entity.id));
    assert.equal(renderedIds.size, 700, 'the ambient paint stays capped');

    const cohort = militaryInstallationsLayer.getNearby(
      Cesium.Cartesian3.fromDegrees(-97.8, 30.15, 0),
      Number.POSITIVE_INFINITY,
      5000,
    );
    assert.ok(cohort.length > 700, 'the cohort reaches past the render cap');
    const beyondCap = cohort.find((record) => !renderedIds.has(record.id));
    assert.ok(beyondCap, 'a cohort item exists outside the rendered window');

    const focused = militaryInstallationsLayer.focusById(beyondCap.id);
    assert.equal(focused, true, 'focus succeeds');
    // The proof: a real entity now backs the selection, so the Context subject
    // actually changes rather than the camera moving over a stale subject.
    const nowRendered = run.entities().find((entity) => entity.id === beyondCap.id);
    assert.ok(nowRendered, 'the focused record was rendered on demand');
    assert.equal(
      run.contextLabels().at(-1),
      beyondCap.name,
      'the selection reached the context store',
    );
  } finally {
    void flights;
    run.restore();
  }
});

/**
 * Drive one real `update()` of the layer against a stubbed proxy, and expose
 * what actually reached the map and the context store.
 */
async function runInstallationLoad({
  elements = [],
  saturated = false,
  exactElements = null,
  exactSaturated = false,
  legacyPayload = false,
  failWith = null,
}) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const contextEvents = [];
  const clearedEvents = [];
  _resetRenderGovernorForTest();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = {
    dispatchEvent(event) {
      if (event?.type === 'gev:entity-selection-cleared') clearedEvents.push(event.detail);
      if (event?.detail?.label) contextEvents.push(event.detail.label);
    },
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  };
  // Swappable installations answer, so a test can hold, fail or change the
  // response between loads without rebooting the layer.
  let installationsFetch = null;
  let view = VIEWPORT;
  let cameraPosition = null;
  const moveEndListeners = new Set();
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('/api/terrain/heights')) {
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    requests.push(href);
    if (installationsFetch) return installationsFetch(href, options);
    if (failWith) {
      return { ok: false, status: 503, json: async () => ({ error: failWith }) };
    }
    const exact = href.includes('exact=1');
    const payload = {
      status: 'fresh',
      retrievedAt: '2026-08-18T00:00:00.000Z',
      elements: exact && exactElements ? exactElements : elements,
      elementCap: 700,
    };
    // A pre-fix cached entry carries no `saturated` field at all.
    if (!legacyPayload) payload.saturated = exact ? exactSaturated : saturated;
    return { ok: true, status: 200, json: async () => payload };
  };
  const dataSources = [];
  const cameraFlights = [];
  let picked = null;
  let clickAction;
  const viewer = {
    camera: {
      moveEnd: {
        addEventListener(listener) {
          moveEndListeners.add(listener);
          return () => moveEndListeners.delete(listener);
        },
      },
      flyToBoundingSphere(sphere, options) { cameraFlights.push({ sphere, options }); },
      computeViewRectangle() {
        // An unbounded (global or horizon) view has no rectangle.
        if (!view) return undefined;
        return {
          south: Cesium.Math.toRadians(view.south),
          west: Cesium.Math.toRadians(view.west),
          north: Cesium.Math.toRadians(view.north),
          east: Cesium.Math.toRadians(view.east),
        };
      },
      get positionCartographic() {
        return cameraPosition
          ? Cesium.Cartographic.fromDegrees(cameraPosition.longitude, cameraPosition.latitude, cameraPosition.height)
          : undefined;
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick() { return picked; },
      // Enough surface for the real render governor to drive this viewer, so
      // one-shot render requests are observable.
      requestRenderMode: false,
      maximumRenderTimeChange: 0,
      requestRender() {},
    },
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };

  const originalSetInputAction = Cesium.ScreenSpaceEventHandler.prototype.setInputAction;
  Cesium.ScreenSpaceEventHandler.prototype.setInputAction = function (action, type, modifier) {
    if (type === Cesium.ScreenSpaceEventType.LEFT_CLICK) clickAction = action;
    return originalSetInputAction.call(this, action, type, modifier);
  };
  try { militaryInstallationsLayer.init(viewer); }
  finally { Cesium.ScreenSpaceEventHandler.prototype.setInputAction = originalSetInputAction; }
  installRenderGovernor(viewer);
  militaryInstallationsLayer.enable();
  await militaryInstallationsLayer.update();

  return {
    requests,
    cameraFlights,
    entities: () => dataSources[0]?.entities?.values || [],
    contextLabels: () => contextEvents,
    /** Details of every gev:entity-selection-cleared dispatched so far. */
    clearedEvents: () => clearedEvents,
    stats: () => militaryInstallationsLayer.getStats(),
    click(target) {
      const entity = typeof target === 'string' ? dataSources[0].entities.getById(target) : target;
      picked = entity ? { id: entity } : undefined;
      clickAction({ position: { x: 0, y: 0 } });
    },
    renderRequests: () => getRenderGovernorDiagnostics().recentRequests.map((item) => item.reason),
    dataSource: () => dataSources[0],
    /** @param {?function(string, object): Promise<object>} next Installations answer; null restores the default. */
    setInstallationsFetch(next) { installationsFetch = next; },
    /** @param {?{south:number, west:number, north:number, east:number}} next Viewport; null is unbounded. */
    setView(next) { view = next; },
    /** @param {?{latitude:number, longitude:number, height:number}} next Camera position. */
    setCamera(next) { cameraPosition = next; },
    moveEnd() { for (const listener of [...moveEndListeners]) listener(); },
    restore() {
      militaryInstallationsLayer.destroy(viewer);
      _resetRenderGovernorForTest();
      globalThis.fetch = originalFetch;
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    },
  };
}

test('viewport membership keeps intersecting footprints and drops the snap ring', () => {
  const inside = { osmType: 'node', latitude: 30.5, longitude: -97.5, footprint: null };
  const outside = { osmType: 'node', latitude: 30.5, longitude: -96.5, footprint: null };
  assert.equal(installationWithinViewport(inside, VIEWPORT), true);
  assert.equal(installationWithinViewport(outside, VIEWPORT), false);

  // A large base whose CENTRE sits just outside but whose footprint overlaps
  // was always returned by the bbox query and must keep rendering.
  const straddling = {
    osmType: 'way',
    latitude: 30.5,
    longitude: -96.95,
    footprint: [[-97.05, 30.4], [-96.9, 30.4], [-96.9, 30.6], [-97.05, 30.6]],
  };
  assert.equal(installationWithinViewport(straddling, VIEWPORT), true);

  const farWithFootprint = {
    osmType: 'way',
    latitude: 30.5,
    longitude: -96.5,
    footprint: [[-96.6, 30.4], [-96.4, 30.4], [-96.4, 30.6], [-96.6, 30.6]],
  };
  assert.equal(installationWithinViewport(farWithFootprint, VIEWPORT), false);
  assert.equal(installationWithinViewport(null, VIEWPORT), false);
  assert.equal(installationWithinViewport(inside, null), false);
});

test('extended features with unknown extent are kept, not centre-tested', () => {
  // Relations carry geometry on their members and ways over MAX_FOOTPRINT_POINTS
  // are normalized without one, so their true extent is unknown here. Overpass
  // already proved they intersect the queried bbox; centre-testing them would
  // erase exactly the biggest installations.
  const relation = { osmType: 'relation', latitude: 30.5, longitude: -96.99, footprint: null };
  const hugeWay = { osmType: 'way', latitude: 29.5, longitude: -97.5, footprint: null };
  assert.equal(installationWithinViewport(relation, VIEWPORT), true);
  assert.equal(installationWithinViewport(hugeWay, VIEWPORT), true);
  // A node IS its geometry, so excluding it on centre loses nothing.
  assert.equal(
    installationWithinViewport({ osmType: 'node', latitude: 30.5, longitude: -96.99, footprint: null }, VIEWPORT),
    false,
  );
  // Unknown provenance is treated inclusively, same as an extended feature.
  assert.equal(installationWithinViewport({ latitude: 30.5, longitude: -96.99, footprint: null }, VIEWPORT), true);
});

test('a footprint-less relation just outside the viewport still renders', async () => {
  const harness = await runInstallationLoad({
    elements: [
      // A relation whose CENTER sits outside the viewport and whose geometry
      // lives on members Overpass did not inline. It was returned because it
      // intersects the queried bbox, so it must survive the viewport filter.
      { type: 'relation', id: 91, center: { lat: 30.5, lon: -96.995 }, tags: { military: 'range', name: 'Straddling Range' } },
      // A NODE at the same off-view spot has no extent and must still be cut.
      { type: 'node', id: 92, lat: 30.5, lon: -96.995, tags: { military: 'range', name: 'Off View Node' } },
    ],
  });
  try {
    assert.deepEqual(
      harness.entities().map((entity) => entity.gevLabelModel?.title),
      ['Straddling Range'],
    );
  } finally {
    harness.restore();
  }
});

test('a legacy cached response with no saturation flag still triggers the exact retry', () => {
  const atCap = { elements: new Array(700).fill({ type: 'node' }), elementCap: 700 };
  assert.equal(installationResponseSaturated(atCap), true, 'derived from the reported cap');
  assert.equal(
    installationResponseSaturated({ elements: new Array(699).fill({ type: 'node' }), elementCap: 700 }),
    false,
  );
  // An explicit flag always wins over the derivation.
  assert.equal(installationResponseSaturated({ ...atCap, saturated: false }), false);
  assert.equal(installationResponseSaturated({ elements: [], saturated: true }), true);
  // Nothing to derive from: do not invent saturation.
  assert.equal(installationResponseSaturated({ elements: new Array(700).fill({}) }), false);
  assert.equal(installationResponseSaturated(null), false);
});

test('a legacy-shaped payload at the cap fires the exact-viewport retry end to end', async () => {
  const elements = [];
  for (let index = 0; index < 700; index += 1) {
    elements.push({ type: 'node', id: 3000 + index, lat: 30.5, lon: -96.2, tags: { military: 'range' } });
  }
  const harness = await runInstallationLoad({
    elements,
    // Pre-fix cache shape: no `saturated` field at all, but at the cap.
    legacyPayload: true,
    exactElements: [
      { type: 'node', id: 8, lat: 30.5, lon: -97.5, tags: { military: 'range', name: 'Rescued From Legacy' } },
    ],
  });
  try {
    assert.equal(harness.requests.length, 2, 'a legacy entry must not skip the retry');
    assert.equal(harness.requests[1].includes('exact=1'), true);
    assert.deepEqual(
      harness.entities().map((entity) => entity.gevLabelModel?.title),
      ['Rescued From Legacy'],
    );
  } finally {
    harness.restore();
  }
});

test('a failed load buys the frame its status change needs', async () => {
  const harness = await runInstallationLoad({ failWith: 'Installation feed HTTP 503' });
  try {
    assert.equal(harness.stats().status, 'unavailable');
    assert.ok(
      harness.renderRequests().some((reason) => reason === 'installations-status'),
      'an idle governor would otherwise leave the last healthy readout on screen',
    );
  } finally {
    harness.restore();
  }
});

test('off-viewport records from the snapped superset never render or enter context', async () => {
  const harness = await runInstallationLoad({
    // The snapped bbox reaches ~5.5 km beyond the viewport; this node sits a
    // full degree outside it.
    elements: [
      { type: 'node', id: 1, lat: 30.5, lon: -97.5, tags: { military: 'range', name: 'In View' } },
      { type: 'node', id: 2, lat: 30.5, lon: -96.2, tags: { military: 'range', name: 'Off View' } },
    ],
  });
  try {
    const titles = harness.entities().map((entity) => entity.gevLabelModel?.title);
    assert.deepEqual(titles, ['In View'], 'only the in-viewport site renders');
    assert.equal(harness.contextLabels().includes('Off View'), false, 'and none enters context');
    assert.equal(harness.stats().count, 1);
  } finally {
    harness.restore();
  }
});

test('a saturated snapped tile refetches the exact viewport before rendering', async () => {
  const elements = [];
  for (let index = 0; index < 700; index += 1) {
    // A saturated snapped response full of OFF-viewport sites: the in-view ones
    // were crowded out upstream.
    elements.push({ type: 'node', id: 1000 + index, lat: 30.5, lon: -96.2, tags: { military: 'range' } });
  }
  const harness = await runInstallationLoad({
    elements,
    saturated: true,
    exactElements: [
      { type: 'node', id: 7, lat: 30.5, lon: -97.5, tags: { military: 'range', name: 'Rescued' } },
    ],
  });
  try {
    assert.equal(harness.requests.length, 2, 'saturation triggers exactly one retry');
    assert.equal(harness.requests[0].includes('exact=1'), false, 'first ask uses the shared snapped tile');
    assert.equal(harness.requests[1].includes('exact=1'), true, 'retry opts out of the snap');
    assert.deepEqual(
      harness.entities().map((entity) => entity.gevLabelModel?.title),
      ['Rescued'],
      'the in-viewport site is no longer starved by off-view ones',
    );
  } finally {
    harness.restore();
  }
});

test('an unsaturated response never pays for a second upstream ask', async () => {
  const harness = await runInstallationLoad({
    elements: [{ type: 'node', id: 3, lat: 30.5, lon: -97.5, tags: { military: 'range' } }],
  });
  try {
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.stats().saturated, false);
  } finally {
    harness.restore();
  }
});

test('a still-saturated exact viewport is reported honestly instead of implied complete', async () => {
  const elements = [];
  for (let index = 0; index < 700; index += 1) {
    elements.push({ type: 'node', id: 2000 + index, lat: 30.5, lon: -97.5, tags: { military: 'range' } });
  }
  const harness = await runInstallationLoad({ elements, saturated: true, exactSaturated: true });
  try {
    assert.equal(harness.stats().saturated, true);
    assert.match(harness.stats().error, /Too many mapped sites/);
  } finally {
    harness.restore();
  }
});

test('a floor that lands after the render deadline lifts the dots off the ellipsoid', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  // A cell no other test in this file warms, so the assertion is about THIS
  // load, not a cache another test left behind.
  const lat = 44.123;
  const lon = -110.456;
  let terrainCalls = 0;
  setMeshFloorPreferred(false);
  _clearMeshFloorCellsForTest();
  _resetFireAnchorsForTest();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/terrain/heights')) {
      terrainCalls += 1;
      // The production failure: the bounded pre-render resolve gives up before
      // Re:Earth answers, so the first paint has no floor to stand on.
      if (terrainCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, FLOOR_RESOLVE_DEADLINE_MS + 200));
      }
      return { ok: true, status: 200, json: async () => ({ results: [{ ellipsoid: 2400 }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'fresh',
        retrievedAt: '2026-08-18T00:00:00.000Z',
        elements: [{ type: 'node', id: 77, lat, lon, tags: { military: 'range' } }],
      }),
    };
  };
  const dataSources = [];
  const viewer = {
    camera: {
      moveEnd: { addEventListener() { return () => {}; } },
      computeViewRectangle() {
        return {
          south: Cesium.Math.toRadians(44),
          west: Cesium.Math.toRadians(-111),
          north: Cesium.Math.toRadians(45),
          east: Cesium.Math.toRadians(-110),
        };
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick() { return null; },
    },
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };

  const heightOf = (entity) => Cesium.Cartographic.fromCartesian(
    entity.position.getValue(Cesium.JulianDate.now()),
  ).height;

  try {
    militaryInstallationsLayer.init(viewer);
    militaryInstallationsLayer.enable();
    await militaryInstallationsLayer.update();

    const buried = dataSources[0].entities.values[0];
    assert.ok(buried, 'the cold-floor pass still renders the record');
    assert.ok(Math.abs(heightOf(buried)) < 1, 'a cold floor anchors at the ellipsoid, as before');

    // The warm chain resolves out of band; wait for the floor to land.
    for (let attempt = 0; attempt < 50 && cachedGroundFloor(lat, lon) == null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cachedGroundFloor(lat, lon), 2400, 'the late floor landed in the shared cache');

    const lifted = dataSources[0].entities.values[0];
    assert.ok(
      Math.abs(heightOf(lifted) - 2401.5) < 0.5,
      `re-render must lift the dot onto the resolved floor, got ${heightOf(lifted)}`,
    );
  } finally {
    militaryInstallationsLayer.destroy(viewer);
    _resetFireAnchorsForTest();
    setMeshFloorPreferred(true);
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('reports bounded installation requests as loading and clears on settlement', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let resolveInstallations;
  const installationsResponse = new Promise((resolve) => { resolveInstallations = resolve; });
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/terrain/heights')) {
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    return installationsResponse;
  };
  const viewer = {
    camera: {
      moveEnd: { addEventListener() { return () => {}; } },
      computeViewRectangle() {
        return {
          south: Cesium.Math.toRadians(30),
          west: Cesium.Math.toRadians(-98),
          north: Cesium.Math.toRadians(31),
          east: Cesium.Math.toRadians(-97),
        };
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick() { return null; },
    },
    dataSources: { add(value) { return value; }, remove() { return true; } },
  };

  try {
    militaryInstallationsLayer.init(viewer);
    militaryInstallationsLayer.enable();
    const update = militaryInstallationsLayer.update();
    assert.equal(militaryInstallationsLayer.getStats().loading, true);
    assert.equal(
      militaryInstallationsLayer.getStats().loadingLabel,
      'loading mapped installation context',
    );
    resolveInstallations({
      ok: true,
      status: 200,
      json: async () => ({ status: 'fresh', elements: [] }),
    });
    await update;
    assert.equal(militaryInstallationsLayer.getStats().loading, false);
  } finally {
    militaryInstallationsLayer.destroy(viewer);
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('zoom-out aborts an active installation request and returns non-loading guidance', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let globalView = false;
  let observedSignal;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async (_url, options = {}) => {
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };
  const viewer = {
    camera: {
      moveEnd: { addEventListener() { return () => {}; } },
      computeViewRectangle() {
        return globalView ? null : {
          south: Cesium.Math.toRadians(30),
          west: Cesium.Math.toRadians(-98),
          north: Cesium.Math.toRadians(31),
          east: Cesium.Math.toRadians(-97),
        };
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick() { return null; },
    },
    dataSources: { add(value) { return value; }, remove() { return true; } },
  };

  try {
    militaryInstallationsLayer.init(viewer);
    militaryInstallationsLayer.enable();
    const pending = militaryInstallationsLayer.update();
    assert.equal(militaryInstallationsLayer.getStats().loading, true);
    globalView = true;
    await militaryInstallationsLayer.update();
    await pending;
    assert.equal(observedSignal.aborted, true);
    assert.equal(militaryInstallationsLayer.getStats().loading, false);
    assert.equal(militaryInstallationsLayer.getStats().status, 'zoom-in');
    assert.equal(militaryInstallationsLayer.getStats().error, null, 'guidance is not a fault');
    assert.match(militaryInstallationsLayer.getStats().statusMessage, /zoom in/i);
  } finally {
    militaryInstallationsLayer.destroy(viewer);
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

// The unavailable-state retry: 'temporarily unavailable' must mean temporarily.
// Fetches otherwise fire only on enable and on camera moveEnd, so a parked
// camera whose first request failed stayed unavailable forever while the proxy
// sat healthy — observed in the field as a layer stuck reporting unavailable
// while its own endpoint served hundreds of features. The backoff progression
// is a pure exported helper so it pins without booting the layer (the full
// layer needs a Cesium viewer and interaction handlers); the wiring is pinned
// by source probes against the shipped file, the same technique the HUD datum
// tests use where a full boot is impractical.
import { installationRetryDelayMs } from './militaryInstallations.js';
import fs from 'node:fs';

const installationsSource = fs.readFileSync(
  new URL('./militaryInstallations.js', import.meta.url), 'utf8');

test('the unavailable retry backs off 30s to a 240s ceiling and restarts clean', () => {
  assert.equal(installationRetryDelayMs(0), 30000, 'first failure retries in 30s');
  assert.equal(installationRetryDelayMs(undefined), 30000, 'no prior delay means the minimum');
  assert.equal(installationRetryDelayMs(30000), 60000, 'each failure doubles');
  assert.equal(installationRetryDelayMs(60000), 120000);
  assert.equal(installationRetryDelayMs(120000), 240000, 'the ceiling is four minutes');
  assert.equal(installationRetryDelayMs(240000), 240000, 'and it stays there');
  assert.equal(installationRetryDelayMs(-5), 30000, 'garbage restarts at the minimum');
});

test('the retry is wired to every lifecycle edge, not just declared', () => {
  assert.match(installationsSource,
    /setInstallationStatus\('unavailable',[^]*?\);\n\s*scheduleUnavailableRetry\(\);/,
    'a failed load schedules the retry immediately after reporting unavailable');
  assert.match(installationsSource,
    /clearUnavailableRetry\(\);\n\s*setInstallationStatus\(\n?\s*state\.records\.length/,
    'a successful load clears the pending retry and resets the backoff');
  assert.match(installationsSource,
    /clearUnavailableRetry\(\);\n\s*setInstallationStatus\('zoom-in'/,
    'zooming out of range cancels the retry — moveEnd owns re-entry there');
  assert.match(installationsSource, /disable\(\) \{[^]*?clearUnavailableRetry\(\);/,
    'disabling the layer cancels the retry');
  assert.match(installationsSource,
    /function scheduleLoad\(\) \{[^]*?clearUnavailableRetry\(\{ resetBackoff: false \}\)/,
    'a user-driven load supersedes the retry without resetting the backoff step');
  assert.match(installationsSource,
    /state\.enabled && !state\.loading\) loadInstallations\(\)/,
    'the fired retry re-checks enablement and never races an in-flight load');
});

// Location switch hooks. A switch to a different first-level region releases
// everything fetched for the viewport being left and mutes camera-driven loads
// until the camera arrives, while the layer itself stays enabled.
const SWITCH_FROM = { key: 'US-TX', region: 'US-TX', country: 'US', lat: 30.5, lon: -97.5 };
const SWITCH_TO = { key: 'CA-ON', region: 'CA-ON', country: 'CA', lat: 43.65, lon: -79.38 };
const ARRIVAL_VIEWPORT = { south: 43, west: -80, north: 44, east: -79 };
// REQUEST_DEBOUNCE_MS (500) + slack.
const DEBOUNCE_TICK_MS = 600;
const OLD_SITE = { type: 'node', id: 42, lat: 30.5, lon: -97.5, tags: { military: 'base', name: 'Old Site' } };

function switchContext(signal = new AbortController().signal) {
  return { from: SWITCH_FROM, to: SWITCH_TO, signal, enabled: true };
}

/** An installations answer that never lands, only rejects when aborted. */
function heldInstallationsFetch(signals) {
  return (_href, options = {}) => new Promise((_resolve, reject) => {
    signals.push(options.signal);
    options.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
}

function installationsAnswer(elements) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: 'fresh',
      retrievedAt: '2026-09-14T00:00:00.000Z',
      elements,
      elementCap: 700,
      saturated: false,
    }),
  };
}

/** Fire the camera's moveEnd and run its debounce under mocked timers. */
function settleCamera(t, run) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    run.moveEnd();
    t.mock.timers.tick(DEBOUNCE_TICK_MS);
  } finally {
    t.mock.timers.reset();
  }
}

async function settleInstallationLoad() {
  for (let attempt = 0; attempt < 200 && militaryInstallationsLayer.getStats().loading; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a location switch releases the old viewport and mutes camera loads until arrival', async (t) => {
  const run = await runInstallationLoad({ elements: [OLD_SITE] });
  try {
    run.click('osm:node:42');
    assert.equal(getSelectedEntityContext()?.id, 'osm:node:42');
    const signals = [];
    run.setInstallationsFetch(heldInstallationsFetch(signals));
    const pending = militaryInstallationsLayer.update();
    assert.equal(run.stats().loading, true);

    const leave = switchContext();
    const clearedBefore = run.clearedEvents().length;
    militaryInstallationsLayer.onLocationLeave(leave);
    militaryInstallationsLayer.onLocationLeave(leave);
    await pending;

    // Tagged as a switch, neither deliberate nor an eviction, so a Contacts
    // subject on this site survives without a CONTACT LOST cue.
    assert.deepEqual(
      run.clearedEvents().slice(clearedBefore),
      [{ layerId: 'military-installations', reason: 'location-switch' }],
      'the selection clear says a location switch caused it',
    );
    assert.equal(signals[0].aborted, true, 'the old viewport fetch is cancelled');
    const released = run.stats();
    assert.equal(released.loading, false);
    assert.equal(released.count, 0, 'records for the old viewport are released');
    assert.equal(released.status, 'idle');
    assert.equal(released.error, null);
    assert.equal(released.stale, false);
    assert.equal(released.saturated, false);
    assert.equal(run.entities().length, 0, 'entities for the old viewport are released');
    assert.equal(getSelectedEntityContext(), null, 'the old selection is cleared');
    assert.deepEqual(
      militaryInstallationsLayer.getNearby(Cesium.Cartesian3.fromDegrees(-97.5, 30.5, 0), Number.POSITIVE_INFINITY),
      [],
      'awareness no longer sees old sites',
    );

    const beforeFlight = run.requests.length;
    settleCamera(t, run);
    assert.equal(run.requests.length, beforeFlight, 'a mid-flight moveEnd issues no query');

    run.setView(ARRIVAL_VIEWPORT);
    run.setInstallationsFetch(async () => installationsAnswer([
      { type: 'node', id: 7, lat: 43.6, lon: -79.4, tags: { military: 'base', name: 'New Site' } },
    ]));
    await militaryInstallationsLayer.onLocationArrive(switchContext());
    assert.equal(run.requests.length, beforeFlight + 1, 'arrival queries at once, without the debounce');
    assert.match(run.requests.at(-1), /south=43\.00000/);
    assert.deepEqual(run.entities().map((entity) => entity.gevLabelModel?.title), ['New Site']);
    assert.equal(run.stats().status, 'ready');

    settleCamera(t, run);
    assert.equal(run.requests.length, beforeFlight + 2, 'moveEnd drives loads again after arrival');
    await settleInstallationLoad();
  } finally { run.restore(); }
});

test('a location switch leaves no retry or fault behind for the old viewport', async () => {
  const run = await runInstallationLoad({ failWith: 'Installation feed HTTP 503' });
  try {
    assert.equal(run.stats().status, 'unavailable');
    assert.ok(run.stats().retryAt > 0, 'precondition: a retry is pending');
    militaryInstallationsLayer.onLocationLeave(switchContext());
    assert.equal(run.stats().retryAt, 0, 'the pending retry is cancelled');
    assert.equal(run.stats().failureReason, null);
    assert.equal(run.stats().status, 'idle');

    // A failure that surfaces after the switch, from a fetch that ignored its
    // abort signal, is not the outcome of the place being flown to.
    militaryInstallationsLayer.enable();
    let failLate;
    run.setInstallationsFetch(() => new Promise((resolve) => {
      failLate = () => resolve({ ok: false, status: 503, json: async () => ({ error: 'late failure' }) });
    }));
    const pending = militaryInstallationsLayer.update();
    militaryInstallationsLayer.onLocationLeave(switchContext());
    failLate();
    await pending;
    assert.equal(run.stats().status, 'idle');
    assert.equal(run.stats().error, null);
    assert.equal(run.stats().retryAt, 0, 'no retry is scheduled for the old viewport');
    assert.equal(run.stats().failureReason, null);
  } finally { run.restore(); }
});

test('a layer left while disabled releases its hidden sites and loads normally once enabled', async (t) => {
  const run = await runInstallationLoad({ elements: [OLD_SITE] });
  try {
    militaryInstallationsLayer.disable();
    militaryInstallationsLayer.onLocationLeave({ ...switchContext(), enabled: false });
    assert.equal(run.stats().count, 0);
    assert.equal(run.entities().length, 0);

    militaryInstallationsLayer.enable();
    await militaryInstallationsLayer.update();
    assert.equal(run.stats().count, 1);
    const before = run.requests.length;
    settleCamera(t, run);
    assert.equal(run.requests.length, before + 1, 'enabling lifts a suspension no arrival will clear');
    await settleInstallationLoad();
  } finally { run.restore(); }
});

test('an aborted arrival neither queries nor lifts the newer switch suspension', async (t) => {
  const run = await runInstallationLoad({ elements: [OLD_SITE] });
  try {
    militaryInstallationsLayer.onLocationLeave(switchContext());
    const before = run.requests.length;
    const replaced = new AbortController();
    replaced.abort();
    assert.equal(militaryInstallationsLayer.onLocationArrive(switchContext(replaced.signal)), undefined);
    assert.equal(run.requests.length, before);
    settleCamera(t, run);
    assert.equal(run.requests.length, before, 'camera loads stay muted for the live switch');

    await militaryInstallationsLayer.onLocationArrive(switchContext());
    assert.equal(run.requests.length, before + 1);
  } finally { run.restore(); }
});

test('the settle after arrival does not restart the arrival query for the same view', async (t) => {
  const run = await runInstallationLoad({ elements: [OLD_SITE] });
  try {
    militaryInstallationsLayer.onLocationLeave(switchContext());
    const signals = [];
    run.setInstallationsFetch(heldInstallationsFetch(signals));
    const before = run.requests.length;
    const arrival = militaryInstallationsLayer.onLocationArrive(switchContext());
    assert.equal(run.requests.length, before + 1);

    settleCamera(t, run);
    assert.equal(run.requests.length, before + 1, 'the same view is not asked for twice');
    assert.equal(signals[0].aborted, false, 'the arrival request keeps running');

    run.setView(ARRIVAL_VIEWPORT);
    settleCamera(t, run);
    assert.equal(run.requests.length, before + 2, 'a different view still supersedes it');
    assert.equal(signals[0].aborted, true);
    await arrival;
  } finally { run.restore(); }
});

test('a location leave swallows a cleanup fault and still mutes camera loads', async (t) => {
  const run = await runInstallationLoad({ elements: [OLD_SITE] });
  const entities = run.dataSource().entities;
  const warn = t.mock.method(console, 'warn', () => {});
  try {
    entities.removeAll = () => { throw new Error('render teardown failed'); };
    assert.doesNotThrow(() => militaryInstallationsLayer.onLocationLeave(switchContext()));
    assert.equal(warn.mock.callCount(), 1, 'the fault is reported, not thrown');
    const before = run.requests.length;
    settleCamera(t, run);
    assert.equal(run.requests.length, before);
  } finally {
    delete entities.removeAll;
    run.restore();
  }
});

test('zooming out to an unbounded view releases sites unless a low camera still sits over them', async () => {
  const run = await runInstallationLoad({ elements: [OLD_SITE] });
  try {
    run.click('osm:node:42');
    // Cockpit looking at the horizon: unbounded view, camera low over the sites.
    run.setView(null);
    run.setCamera({ latitude: 30.5, longitude: -97.5, height: 9000 });
    await militaryInstallationsLayer.update();
    assert.equal(run.stats().status, 'zoom-in');
    assert.equal(run.stats().count, 1, 'sites under a low camera stay for awareness');
    assert.equal(run.entities().length, 1);

    // A zoom-out or globe reset: the previous viewport's sites must not linger
    // on the globe or in the cohort under a "zoom in" prompt.
    run.setCamera({ latitude: 30.5, longitude: -97.5, height: 6_000_000 });
    await militaryInstallationsLayer.update();
    assert.equal(run.stats().status, 'zoom-in');
    assert.equal(run.stats().count, 0);
    assert.equal(run.entities().length, 0);
    assert.equal(getSelectedEntityContext(), null);
    assert.deepEqual(
      militaryInstallationsLayer.getNearby(Cesium.Cartesian3.fromDegrees(-97.5, 30.5, 0), Number.POSITIVE_INFINITY),
      [],
    );
  } finally { run.restore(); }
});

test('an unbounded view keeps sites only for a low camera still over their viewport', () => {
  const keep = installationRecordsOutliveUnboundedView;
  assert.equal(keep(VIEWPORT, { latitude: 30.5, longitude: -97.5, height: 9000 }), true);
  assert.equal(keep(VIEWPORT, { latitude: 31.8, longitude: -97.5, height: 9000 }), true, 'within ~110 km of the box');
  assert.equal(keep(VIEWPORT, { latitude: 33, longitude: -97.5, height: 9000 }), false, 'flown away');
  assert.equal(keep(VIEWPORT, { latitude: 30.5, longitude: -97.5, height: 2_000_000 }), false, 'zoomed out');
  assert.equal(keep(null, { latitude: 30.5, longitude: -97.5, height: 9000 }), false, 'nothing loaded');
  assert.equal(keep(VIEWPORT, null), false, 'unknown camera');
  assert.equal(keep(VIEWPORT, { latitude: Number.NaN, longitude: -97.5, height: 9000 }), false);
});
