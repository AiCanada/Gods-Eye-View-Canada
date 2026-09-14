// src/data/cctvTestHarness.mjs — shared fakes for the CCTV layer suites.
//
// Runs the real layer paths under plain node:test: a fake viewer that maps
// longitude to screen x, a recording overlay host, canvas/Image/document
// seams, a billboard-collection seam, a stubbed ground-prior resolver, and a
// camera-server fetch that answers /api/cctv/sources and /api/cctv/lookup and
// refuses everything else ("this test has no network").
import * as Cesium from 'cesium';
import cctvLayer, {
  _setCctvCoverageStateForTest,
  _setCctvGroundPriorResolverForTest,
  _setCctvOverlayHostForTest,
} from './cctv.js';

export const AUSTIN = { lat: 30.2672, lon: -97.7431 };
/** Same state as Austin, ~47 km away: outside a 50 km area's 40 km cover. */
export const SAN_MARCOS = { lat: 29.8833, lon: -97.9414 };
export const TORONTO = { lat: 43.6532, lon: -79.3832 };
export const ATLANTA = { lat: 33.749, lon: -84.388 };
/** Open Atlantic, several hundred kilometres from every test camera. */
export const OFFSHORE = { lat: 36.5, lon: -70 };
export const place = (key, point) => ({ key, region: key, country: key.slice(0, 2), ...point });
export const TEXAS = place('US-TX', AUSTIN);
export const ONTARIO = place('CA-ON', TORONTO);
/** Camera fields of a Road511 lookup camera that has not been opened yet. */
export const LOOKUP_CAMERA = Object.freeze({ feedType: 'none', lookup: 'road511', lookupState: 'unresolved' });

/** A promise with its resolve handle. */
export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `predicate()` is truthy; throws after `timeoutMs`. */
export async function waitFor(predicate, { timeoutMs = 3_000, stepMs = 5 } = {}) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await sleep(stepMs);
  }
}

/**
 * Minimal canvas, Image and document seams for the monitor-plane runtime, and
 * a fetch that only `handler` may answer (undefined → no network).
 */
export function installDomFakes(t, { fetch: handler = null } = {}) {
  const images = [];
  const gradient = { addColorStop() {} };
  // Every 2D context call is a no-op; property writes (fillStyle, font) stick.
  const makeContext = () => new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : () => gradient),
  });
  class FakeImage {
    constructor() {
      this.attributes = new Map();
      images.push(this);
    }
    set src(value) { this.attributes.set('src', value); }
    get src() { return this.attributes.get('src') || ''; }
    removeAttribute(name) { this.attributes.delete(name); }
  }
  const originals = { document: globalThis.document, Image: globalThis.Image };
  globalThis.document = {
    hidden: false,
    body: { classList: { contains: () => false } },
    createElement: () => ({ width: 0, height: 0, getContext: makeContext }),
  };
  globalThis.Image = FakeImage;
  t.after(() => {
    globalThis.document = originals.document;
    globalThis.Image = originals.Image;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const response = handler ? await handler(String(url), init || {}) : undefined;
    if (response === undefined) throw new Error('this test has no network');
    return response;
  });
  return { images };
}

export function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A public camera source as /api/cctv/sources lists it. */
export function makeSource(id, base, dLon = 0, extra = {}) {
  return {
    id,
    name: `Camera ${id}`,
    city: 'Test',
    country: 'US',
    region: 'TX',
    provider: 'Test DOT',
    lat: base.lat,
    lon: base.lon + dLon,
    headingDeg: 41,
    headingConfidence: 'estimated',
    pitchDeg: -5,
    fovDeg: 56,
    rangeM: 300,
    mountHeightM: 10,
    feedType: 'image',
    sourceKind: 'configured',
    ...extra,
  };
}

/** The `area` report of a /api/cctv/sources response (contract 2). */
export function areaReport(point, items, extra = {}) {
  return {
    lat: point.lat,
    lon: point.lon,
    radiusKm: 50,
    limit: 2500,
    inArea: items.length,
    loaded: items.length,
    dropped: 0,
    reachKm: 50,
    capped: false,
    total: items.length,
    generation: 1,
    pending: [],
    ...extra,
  };
}

export const areaAnswer = (point, sources, extra = {}) => ({ sources, area: areaReport(point, sources, extra) });

/**
 * Fake camera server. `areas(query)` answers /api/cctv/sources (may return a
 * promise); `lookup(id)` answers POST /api/cctv/lookup/:id.
 */
export function makeCameraServer({ areas = () => null, lookup = () => null } = {}) {
  const calls = { sources: [], lookups: [] };
  const handler = async (url, init) => {
    const parsed = new URL(url, 'http://localhost');
    if (parsed.pathname === '/api/cctv/sources') {
      const query = {
        lat: Number(parsed.searchParams.get('lat')),
        lon: Number(parsed.searchParams.get('lon')),
        radiusKm: Number(parsed.searchParams.get('radiusKm')),
      };
      calls.sources.push(query);
      const answer = await areas(query);
      return jsonResponse(answer || areaAnswer(query, []));
    }
    const lookupPath = /^\/api\/cctv\/lookup\/(.+)$/.exec(parsed.pathname);
    if (lookupPath) {
      const id = decodeURIComponent(lookupPath[1]);
      calls.lookups.push({ id, method: init.method, body: init.body, headers: init.headers });
      const answer = await lookup(id);
      return jsonResponse(answer || { id, lookupState: 'no-image', feedType: 'none', retryAfterMs: 0 });
    }
    return undefined;
  };
  return { calls, handler };
}

/** Replaces the Re:Earth ground-prior batch; records every batch it is asked for. */
export function installPriorResolver(t, { ellipsoid = 120 } = {}) {
  const batches = [];
  _setCctvGroundPriorResolverForTest(async (coords) => {
    batches.push(coords.map((coord) => ({ ...coord })));
    return coords.map(() => ({ ellipsoid, source: 'reearth' }));
  });
  t.after(() => _setCctvGroundPriorResolverForTest(null));
  return batches;
}

/** Billboard-collection seam that tracks the billboards alive in it. */
export function makeBillboards() {
  const live = new Set();
  return {
    live,
    show: true,
    add(options) {
      const billboard = { ...options, show: true };
      live.add(billboard);
      return billboard;
    },
    remove(billboard) {
      return live.delete(billboard);
    },
  };
}

/** Overlay host that records every publication. */
export function makeOverlayHost() {
  const calls = [];
  return {
    calls,
    setEntries(sourceId, entries) { calls.push({ type: 'entries', sourceId, entries: [...entries] }); },
    setVisible(sourceId, visible) { calls.push({ type: 'visible', sourceId, visible }); },
    clearSource(sourceId) { calls.push({ type: 'clear', sourceId }); },
    hitTest: () => null,
  };
}

/** The most recent map-card publication's entries. */
export function lastCards(host) {
  return host.calls.findLast((call) => call.type === 'entries' && call.sourceId === 'cctv')?.entries || [];
}

export const cardIds = (host) => lastCards(host).map((entry) => entry.id).sort();

/** Viewer `heightM` above `at`; cameras spread across the screen by longitude. */
export function makeViewer(at, heightM = 4_000) {
  const removedPrimitives = [];
  const viewer = {
    entities: new Cesium.EntityCollection(),
    isDestroyed: () => false,
    trackedEntity: null,
    camera: {
      flyCalls: 0,
      flyToBoundingSphere() { this.flyCalls += 1; },
    },
    scene: {
      canvas: { clientWidth: 1200, clientHeight: 800 },
      globe: { show: true },
      cartesianToCanvasCoordinates(position) {
        const carto = Cesium.Cartographic.fromCartesian(position);
        const dLon = Cesium.Math.toDegrees(carto.longitude) - viewer.lookAt.lon;
        return new Cesium.Cartesian2(600 + dLon * 10_000, 400);
      },
      primitives: {
        add: (primitive) => primitive,
        remove: (primitive) => {
          removedPrimitives.push(primitive);
          return true;
        },
      },
      requestRender() {},
    },
    removedPrimitives,
  };
  moveViewer(viewer, at, heightM);
  return viewer;
}

export function moveViewer(viewer, { lat, lon }, heightM = 4_000) {
  viewer.lookAt = { lat, lon };
  viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(lon, lat, heightM);
  viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(lon, lat, heightM);
}

export function makeRecord(id, base, dLon = 0, extra = {}) {
  const lat = base.lat;
  const lon = base.lon + dLon;
  return {
    camera: {
      id,
      name: `Camera ${id}`,
      city: 'Test',
      lat,
      lon,
      headingDeg: 41,
      pitchDeg: -5,
      fovDeg: 56,
      rangeM: 210,
      mountHeightM: 100,
      groundElevationM: 0,
      feedType: 'image',
      ...extra,
    },
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 100),
    coverageEntities: [],
    projection: null,
    groundResolved: {},
    groundSamples: {},
    frustumGeometry: null,
    frustumPositions: null,
    probeClampRangeM: null,
    viewshedPrimitive: null,
  };
}

/** Seeds the layer with a fake viewer and host; torn down after the test. */
export function primeLayer(t, {
  viewer,
  records = [],
  coverageMode = 'off',
  enabled = true,
  billboards = null,
  area = null,
}) {
  const host = makeOverlayHost();
  _setCctvOverlayHostForTest(host);
  _setCctvCoverageStateForTest({ viewer, records, activeCameraId: null, enabled, coverageMode, billboards, area });
  t.after(() => {
    cctvLayer.disable();
    _setCctvOverlayHostForTest();
    _setCctvCoverageStateForTest({ enabled: false });
  });
  return host;
}
