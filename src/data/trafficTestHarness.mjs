// src/data/trafficTestHarness.mjs
// Shared fakes for traffic layer tests: stubbed fetch for the road tiles, the
// Overpass fallback and TomTom flow; captured timers; and a fake viewer whose
// camera can be parked over a place. Not a test file itself (no .test.mjs).
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import trafficLayer from './traffic.js';
import { getRenderGovernorDiagnostics } from '../renderGovernor.js';
import { encodeTransportationTile } from './fixtures/vectorTileEncoder.mjs';
import { tileToBBox } from './tomtomTiles.js';

export const AUSTIN = { key: 'US-TX', region: 'US-TX', country: 'US', lat: 30.2672, lon: -97.7431 };
export const TORONTO = { key: 'CA-ON', region: 'CA-ON', country: 'CA', lat: 43.6532, lon: -79.3832 };
/** About 5 km north of AUSTIN, inside the 25 km keep radius. */
export const NEAR_AUSTIN = { key: 'test-near', region: 'test-near', country: 'US', lat: 30.3122, lon: -97.7431 };
/** traffic.js FETCH_DEBOUNCE. */
export const DEBOUNCE_MS = 320;
/** traffic.js FETCH_PAUSE_MAX_MS. */
export const PAUSE_WATCHDOG_MS = 15000;
/** traffic.js LOAD_KICK_MS. */
export const LOAD_KICK_MS = 1500;
const RAD = Math.PI / 180;

export function eventChannel() {
  const listeners = new Set();
  return {
    addEventListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    removeEventListener(listener) {
      listeners.delete(listener);
    },
    raise() {
      for (const listener of [...listeners]) listener();
    },
  };
}

export function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function jsonResponse(body, status = 200) {
  return { ok: status < 300, status, headers: { get: () => null }, json: async () => body };
}

/** Parse the bbox out of the form-encoded Overpass query the layer posts. */
export function overpassBox(body) {
  const query = decodeURIComponent(String(body).replace(/^data=/, ''));
  const [, south, west, north, east] = query
    .match(/\]\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/)
    .map(Number);
  return { south, west, north, east, lat: (south + north) / 2, lon: (west + east) / 2 };
}

/** Overpass fallback payload: two drivable roads through the middle of a requested box. */
export function roadsIn({ lat, lon }) {
  return {
    elements: [
      {
        type: 'way',
        tags: { highway: 'primary' },
        geometry: [
          { lat: lat - 0.008, lon: lon - 0.008 },
          { lat, lon },
          { lat: lat + 0.008, lon: lon + 0.008 },
        ],
      },
      {
        type: 'way',
        tags: { highway: 'secondary', oneway: 'yes' },
        geometry: [
          { lat: lat + 0.008, lon: lon - 0.008 },
          { lat: lat - 0.008, lon: lon + 0.008 },
        ],
      },
    ],
  };
}

let _gridTile = null;
/**
 * A road tile at any zoom: one-way primary rows and residential columns every
 * 256 px, drawn past the tile buffer, so any fetch box crosses several roads.
 */
export function roadGridTile() {
  if (!_gridTile) {
    const features = [];
    for (let v = 128; v < 4096; v += 256) {
      features.push({ properties: { class: 'primary', oneway: 1 }, geometry: [[[-64, v], [4160, v]]] });
      features.push({ properties: { surface: 'paved', class: 'minor' }, geometry: [[[v, -64], [v, 4160]]] });
    }
    _gridTile = encodeTransportationTile(features);
  }
  return _gridTile;
}

/**
 * Stub fetch and timers the way trafficTiming.test.mjs does. Live flow is on
 * so the warm-up and decode-cache paths run; flow tiles decode to no segments
 * so every road keeps simulated dots and dot counts stay deterministic.
 * `failing.tiles` / `failing.overpass` make a road source answer 502;
 * `failing.tile({z, x, y})` fails single tiles.
 */
export function createHarness() {
  const saved = {
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    log: console.log,
    warn: console.warn,
  };
  const timeouts = new Map();
  const intervals = new Map();
  let timerId = 0;
  const calls = { tiles: [], overpass: [], flow: [] };
  const held = { tiles: null, overpass: null, flow: null };
  const failing = { tiles: false, overpass: false, tile: () => false };
  const warnings = [];

  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    if (href === '/api/tomtom/status') return jsonResponse({ hasKey: true });
    const tile = href.match(/^\/api\/roads\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (tile) {
      const [z, x, y] = tile.slice(1).map(Number);
      calls.tiles.push({ z, x, y, signal: opts.signal });
      const respond = () => (failing.tiles || failing.tile({ z, x, y })
        ? new Response('{"error":"upstream"}', { status: 502 })
        : new Response(roadGridTile(), { status: 200 }));
      if (!held.tiles) return respond();
      // A held road reply ignores abort on purpose: it models a response
      // already on its way when the switch starts, which only the load
      // generation can stop.
      return new Promise((resolve) => held.tiles.push(() => resolve(respond())));
    }
    if (href === '/api/overpass') {
      const box = overpassBox(opts.body);
      calls.overpass.push({ box, signal: opts.signal });
      const respond = () => (failing.overpass
        ? jsonResponse({ error: 'Overpass proxy error' }, 502)
        : jsonResponse(roadsIn(box)));
      if (!held.overpass) return respond();
      return new Promise((resolve) => held.overpass.push(() => resolve(respond())));
    }
    if (href.startsWith('/api/tomtom/flow/')) {
      calls.flow.push({ url: href, signal: opts.signal });
      if (opts.signal?.aborted) throw abortError();
      const respond = () => new Response(Buffer.from('no flow segments'), { status: 200 });
      if (!held.flow) return respond();
      return new Promise((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        held.flow.push(() => resolve(respond()));
      });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  globalThis.setTimeout = (callback, delay = 0) => {
    const id = ++timerId;
    timeouts.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timeouts.delete(id);
  };
  globalThis.setInterval = (callback, delay) => {
    const id = ++timerId;
    intervals.set(id, { callback, delay });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };
  console.log = () => {};
  console.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
  };

  const pending = (delay) => [...timeouts].filter(([, timer]) => timer.delay === delay);
  return {
    calls,
    failing,
    warnings,
    intervals,
    pending,
    hold(kind) {
      held[kind] = [];
    },
    release(kind) {
      const queue = held[kind] || [];
      held[kind] = null;
      for (const resume of queue) resume();
    },
    /** Run the single pending timer with this delay and return its result. */
    fire(delay) {
      const matches = pending(delay);
      assert.equal(matches.length, 1, `exactly one ${delay} ms timer must be pending`);
      const [id, timer] = matches[0];
      timeouts.delete(id);
      return timer.callback();
    },
    /** Run every interval with this delay once (the load kick). */
    tick(delay = LOAD_KICK_MS) {
      for (const [, timer] of [...intervals]) if (timer.delay === delay) timer.callback();
    },
    /** Road passes that reached the tile proxy (each pass shares one signal). */
    roadPasses() {
      return new Set(calls.tiles.map((call) => call.signal)).size;
    },
    /** Whether the latest tile pass requested a tile containing `point`. */
    lastPassCovers({ lat, lon }) {
      const last = calls.tiles.at(-1)?.signal;
      return calls.tiles
        .filter((call) => call.signal === last)
        .some(({ z, x, y }) => {
          const box = tileToBBox(z, x, y);
          return lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east;
        });
    },
    restore() {
      globalThis.fetch = saved.fetch;
      globalThis.setTimeout = saved.setTimeout;
      globalThis.clearTimeout = saved.clearTimeout;
      globalThis.setInterval = saved.setInterval;
      globalThis.clearInterval = saved.clearInterval;
      console.log = saved.log;
      console.warn = saved.warn;
    },
  };
}

/** Fake viewer whose camera can be parked over a place (nadir fetch centre). */
export function createCamera(start) {
  const changed = eventChannel();
  const camera = { changed, percentageChanged: 0.5 };
  const viewer = {
    camera,
    scene: {
      canvas: { clientWidth: 0, clientHeight: 0, width: 0, height: 0 },
      preRender: eventChannel(),
      primitives: { add: (primitive) => primitive, remove: () => true },
      groundPrimitives: { add: (primitive) => primitive, remove: () => true },
    },
  };
  /** Park the camera over a place without raising camera.changed. */
  const park = ({ lat, lon }, height = 5000) => {
    camera.positionCartographic = { latitude: lat * RAD, longitude: lon * RAD, height };
    camera.positionWC = Cesium.Cartesian3.fromDegrees(lon, lat, height);
    camera.computeViewRectangle = () => ({
      south: (lat - 0.01) * RAD,
      west: (lon - 0.01) * RAD,
      north: (lat + 0.01) * RAD,
      east: (lon + 0.01) * RAD,
    });
  };
  park(start);
  return { viewer, park, changed };
}

/** Let detached promise chains (status probe, flow warm-up) run to completion. */
export async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Run the pending debounced load for the current view to completion. */
export async function loadCurrentView(h) {
  await h.fire(DEBOUNCE_MS);
  await settle();
}

export const trafficHolds = () => getRenderGovernorDiagnostics().holds.includes('traffic');

/** Enable the layer over AUSTIN with the harness installed, run, then tear down. */
export async function withTraffic(run) {
  const h = createHarness();
  const cam = createCamera(AUSTIN);
  try {
    trafficLayer.init(cam.viewer);
    trafficLayer.enable(cam.viewer);
    await run(h, cam);
    assert.deepEqual(
      h.warnings.filter((line) => /Location|World jump/.test(line)),
      [],
      'switch hooks must not fail internally',
    );
  } finally {
    trafficLayer.destroy(cam.viewer);
    h.restore();
  }
}
