import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { tilesForBounds, tileToBBox } from './tomtomTiles.js';

/**
 * @file Road geometry for the Street Traffic layer, from vector tiles.
 *
 * Fetches OpenFreeMap planet tiles through the local disk-cached proxy
 * (`/api/roads/tiles/{z}/{x}/{y}.pbf`, server/providers/roads-tiles.js) and
 * decodes the OpenMapTiles `transportation` layer into the Overpass shape the
 * traffic layer already parses — `{elements:[{type:'way', id, tags:{highway,
 * oneway?}, geometry:[{lat, lon}…]}]}` — so `parseRoads` and TomTom flow
 * matching work unchanged. Replaces the public Overpass mirrors as the primary
 * road source (2026-09-14: overpass-api.de and lz4 answer 406 to the proxy,
 * kumi.systems and private.coffee time out, so uncached cities had no roads).
 *
 * Road classes match the Overpass query this replaces (traffic.js
 * buildOverpassQuery, still the fallback), so the dot budget goes to the same
 * roads:
 * - Major pass, z12: motorway, trunk, primary, secondary.
 * - Full pass, z14 (the highest zoom OpenFreeMap serves): adds tertiary, and
 *   every OpenMapTiles `minor` road as residential. OpenMapTiles folds OSM
 *   residential, unclassified, living_street and road into `minor` with no
 *   subclass (checked against decoded Austin planet tiles), so they cannot be
 *   told apart; residential is the weight the old query gave most of them.
 * - Skipped: `service` roads (alleys, driveways, parking aisles and untagged
 *   service ways, about 45% of a dense z14 city tile) and ramps (`ramp: 1`, the
 *   OSM *_link roads). The old query fetched neither, and each short piece
 *   would take a seed dot from the arterials. Paths, tracks, rail, ferries,
 *   piers, bridges-as-areas and construction are skipped too.
 *
 * Clipping: every line is clipped to its own tile (tiles carry a buffer, so
 * neighbours would otherwise draw the same road twice) and then to the fetch
 * bounds (so the dot budget stays on the requested box).
 *
 * Attribution (required by OpenFreeMap): "OpenFreeMap © OpenMapTiles Data
 * from OpenStreetMap" — ROAD_TILES_ATTRIBUTION / ROAD_TILES_CREDIT.
 *
 * @module data/roadTiles
 */

/** @const {number} Tile zoom for the major-roads pass. */
export const ROAD_TILE_MAJOR_ZOOM = 12;
/** @const {number} Tile zoom for the full road graph (OpenFreeMap maxzoom). */
export const ROAD_TILE_FULL_ZOOM = 14;
/** @const {string} Plain-text attribution OpenFreeMap requires. */
export const ROAD_TILES_ATTRIBUTION =
  'OpenFreeMap © OpenMapTiles Data from OpenStreetMap';
/** Credit for the viewer's "Data attribution" popover, registered on first use. */
export const ROAD_TILES_CREDIT = {
  key: 'openfreemap-roads',
  html:
    'Road geometry (traffic): ' +
    '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
    '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> ' +
    'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
};

/** @const {string} OpenMapTiles layer holding roads. */
const ROAD_LAYER_NAME = 'transportation';
/** @const {number} Decoded tiles kept in memory (versioned tiles never change). */
const DECODE_CACHE_MAX_ENTRIES = 32;
/** OpenMapTiles classes the major pass keeps (the old Overpass major query). */
const MAJOR_ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);
/** OpenMapTiles classes that keep their own name as the highway value. */
const NAMED_ROAD_CLASSES = new Set([...MAJOR_ROAD_CLASSES, 'tertiary']);

/**
 * Decoded-tile cache keyed "z/x/y", oldest first.
 * @type {Map<string, Array<{highway:string, major:boolean, oneway:string|null, coords:number[][], key:string}>>}
 */
const _decodeCache = new Map();
/** @type {number} Tile requests issued to the proxy this session. */
let _tilesFetched = 0;
/** @type {number} Tile requests that failed this session. */
let _tileFailures = 0;

/**
 * The traffic-layer highway value for an OpenMapTiles transportation feature,
 * or null when the old Overpass road set had no such road. Values are the ones
 * traffic.js weights (SPEED_MPS / DENSITY_MULT / SIZE_BY_TYPE).
 * - motorway, trunk, primary, secondary, tertiary keep their class.
 * - minor is residential whatever else it carries (planet tiles send no
 *   subclass for it).
 * - Ramps (`ramp: 1`, OSM *_link), service roads and every other class are null.
 * @param {object} properties Feature properties (class, ramp, service…).
 * @returns {string|null}
 */
export function roadTileHighway(properties) {
  if (!properties || properties.ramp === 1 || properties.ramp === true) {
    return null;
  }
  const roadClass = properties.class;
  if (NAMED_ROAD_CLASSES.has(roadClass)) return roadClass;
  if (roadClass === 'minor') return 'residential';
  return null;
}

/**
 * Clip one segment to an axis-aligned rectangle (Liang–Barsky).
 * @returns {number[][]|null} The clipped [a, b], or null when outside.
 */
function clipSegment(p0, p1, minX, minY, maxX, maxY) {
  const [x0, y0] = p0;
  const [x1, y1] = p1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const edges = [
    [-dx, x0 - minX],
    [dx, maxX - x0],
    [-dy, y0 - minY],
    [dy, maxY - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  const a = t0 === 0 ? p0 : [x0 + t0 * dx, y0 + t0 * dy];
  const b = t1 === 1 ? p1 : [x0 + t1 * dx, y0 + t1 * dy];
  return [a, b];
}

/**
 * Clip a polyline to a rectangle. A line that leaves and re-enters becomes
 * several pieces; pieces shorter than two distinct points are dropped.
 * @param {number[][]} points [x, y] vertices (tile pixels or [lon, lat]).
 * @returns {number[][][]} Pieces inside the rectangle.
 */
export function clipPolyline(points, minX, minY, maxX, maxY) {
  const pieces = [];
  let current = null;
  const close = () => {
    if (
      current &&
      current.some((p) => p[0] !== current[0][0] || p[1] !== current[0][1])
    ) {
      pieces.push(current);
    }
    current = null;
  };
  for (let i = 0; i < points.length - 1; i++) {
    const clipped = clipSegment(points[i], points[i + 1], minX, minY, maxX, maxY);
    if (!clipped) {
      close();
      continue;
    }
    const [a, b] = clipped;
    const tail = current?.[current.length - 1];
    if (tail && tail[0] === a[0] && tail[1] === a[1]) current.push(b);
    else {
      close();
      current = [a, b];
    }
    // The segment left the rectangle: whatever follows is a new piece.
    if (b !== points[i + 1]) close();
  }
  close();
  return pieces;
}

/** Tile-pixel position → [lon, lat] degrees (Web Mercator). */
function tilePixelToLonLat(px, py, z, x, y, extent) {
  const n = 2 ** z;
  const lon = ((x + px / extent) / n) * 360 - 180;
  const lat =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / extent)) / n))) * 180) /
    Math.PI;
  return [lon, lat];
}

/**
 * Decode one road tile into drivable road polylines clipped to the tile.
 * @param {Uint8Array|ArrayBuffer} data Raw MVT bytes (an empty body is an empty tile).
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {Array<{highway:string, major:boolean, oneway:string|null, coords:number[][], key:string}>}
 *   Returns [] for undecodable bytes or a tile without a transportation layer.
 */
export function decodeRoadTile(data, z, x, y) {
  let layer;
  try {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (!bytes?.length) return [];
    layer = new VectorTile(new PbfReader(bytes)).layers[ROAD_LAYER_NAME];
  } catch {
    return [];
  }
  if (!layer) return [];
  const extent = layer.extent || 4096;
  const roads = [];
  for (let i = 0; i < layer.length; i++) {
    let feature;
    let parts;
    try {
      feature = layer.feature(i);
      if (feature.type !== 2) continue;
      parts = feature.loadGeometry();
    } catch {
      continue; // one malformed feature must not drop the tile
    }
    const properties = feature.properties || {};
    const highway = roadTileHighway(properties);
    if (!highway) continue;
    const oneway =
      properties.oneway === 1 ? 'yes' : properties.oneway === -1 ? '-1' : null;
    let piece = 0;
    for (const part of parts) {
      const pixels = part.map((point) => [point.x, point.y]);
      for (const clipped of clipPolyline(pixels, 0, 0, extent, extent)) {
        roads.push({
          highway,
          major: MAJOR_ROAD_CLASSES.has(properties.class),
          oneway,
          coords: clipped.map(([px, py]) =>
            tilePixelToLonLat(px, py, z, x, y, extent),
          ),
          key: `${z}/${x}/${y}/${i}/${piece++}`,
        });
      }
    }
  }
  return roads;
}

/** Insert into the decode cache with oldest-entry eviction. */
function cacheSet(key, roads) {
  _decodeCache.delete(key);
  if (_decodeCache.size >= DECODE_CACHE_MAX_ENTRIES) {
    _decodeCache.delete(_decodeCache.keys().next().value);
  }
  _decodeCache.set(key, roads);
}

function abortError() {
  const error = new Error('road tile fetch aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Fetch and decode the road tiles covering `bounds`, as an Overpass-shaped
 * payload clipped to the bounds.
 *
 * Tiles are fetched in parallel; decoded tiles are cached (bounded) so a
 * revisit is free. When some tiles fail the rest are returned with
 * `partial: true` (the caller should not cache that result); the promise
 * rejects only when every tile failed or the signal aborted.
 *
 * @param {{south:number, west:number, north:number, east:number}} bounds Degrees.
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.majorOnly=false] z12 motorway…secondary instead of the z14 full graph.
 * @returns {Promise<{elements:Array<{type:'way', id:string, tags:{highway:string, oneway?:string}, geometry:Array<{lat:number, lon:number}>}>, partial?:boolean}>}
 */
export async function fetchRoadsForBounds(bounds, { signal, majorOnly = false } = {}) {
  const zoom = majorOnly ? ROAD_TILE_MAJOR_ZOOM : ROAD_TILE_FULL_ZOOM;
  const tiles = tilesForBounds(bounds, zoom);
  if (tiles.length === 0) return { elements: [] };

  const results = await Promise.allSettled(
    tiles.map(async ({ z, x, y }) => {
      const key = `${z}/${x}/${y}`;
      const cached = _decodeCache.get(key);
      if (cached) return cached;
      _tilesFetched += 1;
      try {
        const res = await fetch(`/api/roads/tiles/${z}/${x}/${y}.pbf`, { signal });
        if (!res.ok) throw new Error(`road tile ${key}: HTTP ${res.status}`);
        const roads = decodeRoadTile(await res.arrayBuffer(), z, x, y);
        if (!signal?.aborted) cacheSet(key, roads);
        return roads;
      } catch (error) {
        if (error?.name !== 'AbortError') _tileFailures += 1;
        throw error;
      }
    }),
  );
  if (signal?.aborted) throw abortError();

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length === results.length) {
    const reason = failed[0].reason;
    if (reason?.name === 'AbortError') throw reason;
    throw new Error(`road tiles unavailable: ${reason?.message || reason}`);
  }

  const { south, west, north, east } = bounds;
  const elements = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const road of result.value) {
      if (majorOnly && !road.major) continue;
      let piece = 0;
      for (const coords of clipPolyline(road.coords, west, south, east, north)) {
        elements.push({
          type: 'way',
          id: `${road.key}/${piece++}`,
          tags: road.oneway
            ? { highway: road.highway, oneway: road.oneway }
            : { highway: road.highway },
          geometry: coords.map(([lon, lat]) => ({ lat, lon })),
        });
      }
    }
  }
  return failed.length ? { elements, partial: true } : { elements };
}

/** Great-circle km (the traffic keep radius is coarse; haversine is plenty). */
function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Release decoded tiles whose centre lies farther than `radiusKm` from a
 * location-switch destination (every tile when the point is unknown).
 * Memory only: the proxy's disk cache still answers a revisit.
 * @param {{lat:number, lon:number}|null} point
 * @param {number} radiusKm
 * @returns {number} Tiles released.
 */
export function releaseRoadTilesAwayFrom(point, radiusKm) {
  const known = Number.isFinite(point?.lat) && Number.isFinite(point?.lon);
  let released = 0;
  for (const key of [..._decodeCache.keys()]) {
    const [z, x, y] = key.split('/').map(Number);
    const box = tileToBBox(z, x, y);
    const near =
      known &&
      distanceKm(
        point.lat,
        point.lon,
        (box.south + box.north) / 2,
        (box.west + box.east) / 2,
      ) <= radiusKm;
    if (near) continue;
    _decodeCache.delete(key);
    released += 1;
  }
  return released;
}

/**
 * Session diagnostics for `getStats()` surfaces.
 * @returns {{tilesFetched:number, tileFailures:number, cachedTiles:number}}
 */
export function getRoadTileSessionStats() {
  return {
    tilesFetched: _tilesFetched,
    tileFailures: _tileFailures,
    cachedTiles: _decodeCache.size,
  };
}

/** Clear the decode cache (tests + layer teardown). Session counters persist. */
export function resetRoadTileCache() {
  _decodeCache.clear();
}
