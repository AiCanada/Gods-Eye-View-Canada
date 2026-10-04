// src/data/trafficTestHarness.mjs
// Shared fakes for Street Traffic road-source tests, ported onto upstream's
// split layer (src/layers/traffic): a real createTrafficSource whose fetches
// are stubbed (OpenFreeMap TileJSON + road tiles, the Overpass fallback proxy,
// TomTom status and flow), mocked timers and clock, and a fake viewer whose
// camera can be parked over a place. Not a test file itself (no .test.mjs).
import * as Cesium from 'cesium';
import { createTrafficLayer } from '../layers/traffic/index.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { FETCH_DEBOUNCE } from '../layers/traffic/policy.js';
import { encodeTransportationTile } from './fixtures/vectorTileEncoder.mjs';

export const AUSTIN = { lat: 30.2672, lon: -97.7431 };
export const TORONTO = { lat: 43.6532, lon: -79.3832 };
export const DEBOUNCE_MS = FETCH_DEBOUNCE;
const TILE_ORIGIN = 'https://tiles.openfreemap.org';

let gridTile = null;
/**
 * A road tile at any zoom: one-way primary rows and minor columns every
 * 256 px, drawn past the tile buffer, so any fetch box crosses several roads.
 */
export function roadGridTile() {
  if (!gridTile) {
    const features = [];
    for (let v = 128; v < 4096; v += 256) {
      features.push({
        properties: { class: 'primary', oneway: 1 },
        geometry: [
          [
            [-64, v],
            [4160, v],
          ],
        ],
      });
      features.push({
        properties: { surface: 'paved', class: 'minor' },
        geometry: [
          [
            [v, -64],
            [v, 4160],
          ],
        ],
      });
    }
    gridTile = encodeTransportationTile(features);
  }
  return gridTile;
}

/** Overpass fallback payload: two drivable roads through the requested box. */
export function roadsIn({ south, west, north, east }) {
  const lat = (south + north) / 2,
    lon = (west + east) / 2;
  return {
    elements: [
      {
        type: 'way',
        tags: { highway: 'primary' },
        geometry: [
          { lat: lat - 0.001, lon: lon - 0.001 },
          { lat, lon },
          { lat: lat + 0.001, lon: lon + 0.001 },
        ],
      },
      {
        type: 'way',
        tags: { highway: 'secondary', oneway: 'yes' },
        geometry: [
          { lat: lat + 0.001, lon: lon - 0.001 },
          { lat: lat - 0.001, lon: lon + 0.001 },
        ],
      },
    ],
  };
}

/** Parse the bbox out of the form-encoded Overpass query the source posts. */
export function overpassBox(body) {
  const query = decodeURIComponent(String(body).replace(/^data=/, ''));
  const [, south, west, north, east] = query
    .match(/\]\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/)
    .map(Number);
  return { south, west, north, east };
}

/**
 * Build a traffic layer over AUSTIN with stubbed fetches and mocked timers.
 * `failing.tiles` / `failing.overpass` make a road source answer 502;
 * `failing.tile({z, x, y})` fails single tiles; `overpassConfigured = false`
 * makes the proxy answer 503 as it does with OVERPASS_UPSTREAMS empty.
 */
export function createTrafficHarness(t, { height = 3200 } = {}) {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 1_000_000,
  });
  const calls = { tiles: [], overpass: [] };
  const failing = { tiles: false, overpass: false, tile: () => false };
  const options = { overpassConfigured: true };
  const tileFetchImpl = async (url, { signal } = {}) => {
    signal?.throwIfAborted();
    const href = String(url);
    if (href === `${TILE_ORIGIN}/planet`)
      return Response.json({
        tiles: [`${TILE_ORIGIN}/planet/test/{z}/{x}/{y}.pbf`],
      });
    const match = href.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (!match) throw new Error(`unexpected tile fetch: ${href}`);
    const [z, x, y] = match.slice(1).map(Number);
    calls.tiles.push({ z, x, y });
    return failing.tiles || failing.tile({ z, x, y })
      ? new Response('upstream', { status: 502 })
      : new Response(roadGridTile(), { status: 200 });
  };
  const overpassFetchImpl = async (url, { body, signal } = {}) => {
    signal?.throwIfAborted();
    const box = overpassBox(body);
    calls.overpass.push({ url: String(url), box });
    if (!options.overpassConfigured)
      return Response.json(
        { error: 'Detailed OpenStreetMap queries are not configured' },
        { status: 503 },
      );
    if (failing.overpass)
      return Response.json({ error: 'Overpass proxy error' }, { status: 502 });
    return Response.json(roadsIn(box));
  };
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href === '/api/tomtom/status') return Response.json({ hasKey: false });
    throw new Error(`unexpected fetch: ${href}`);
  };
  const source = createTrafficSource({
    fetchImpl,
    tileFetchImpl,
    overpassFetchImpl,
  });
  const camera = {
    positionCartographic: Cesium.Cartographic.fromDegrees(
      AUSTIN.lon,
      AUSTIN.lat,
      height,
    ),
    get positionWC() {
      return Cesium.Cartesian3.fromRadians(
        this.positionCartographic.longitude,
        this.positionCartographic.latitude,
        this.positionCartographic.height,
      );
    },
    changed: new Cesium.Event(),
    moveEnd: new Cesium.Event(),
    percentageChanged: 0.5,
    computeViewRectangle() {
      const { longitude, latitude } = this.positionCartographic;
      return new Cesium.Rectangle(
        longitude - 0.0002,
        latitude - 0.0002,
        longitude + 0.0002,
        latitude + 0.0002,
      );
    },
    pickEllipsoid: () => null,
  };
  const viewer = {
    camera,
    scene: {
      canvas: { width: 100, height: 100 },
      globe: { show: true, tilesLoaded: true, getHeight: () => 0 },
      preRender: new Cesium.Event(),
      primitives: { add: (value) => value, remove: () => true },
    },
  };
  const layer = createTrafficLayer({
    services: {
      credits: {},
      render: {
        holdContinuousRender: () => {},
        releaseContinuousRender: () => {},
      },
    },
    source,
  });
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  console.log = () => {};
  layer.init(viewer);
  t.after(() => {
    layer.destroy(viewer);
    console.warn = warn;
    console.log = log;
  });
  const park = ({ lat, lon }, h = height) => {
    camera.positionCartographic = Cesium.Cartographic.fromDegrees(lon, lat, h);
  };
  /** Advance the mocked clock and let the async chains it releases run. */
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
  };
  /** Let a pending debounced load and its fetches finish. */
  const load = async () => {
    for (let i = 0; i < 4; i++) await tick(DEBOUNCE_MS + 80);
  };
  return {
    layer,
    viewer,
    camera,
    park,
    tick,
    load,
    calls,
    failing,
    options,
  };
}
