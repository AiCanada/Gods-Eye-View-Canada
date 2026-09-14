// src/data/roadTiles.test.mjs
// Road geometry for Street Traffic from OpenFreeMap vector tiles. Synthetic
// OpenMapTiles `transportation` tiles are encoded in-process; fetch is mocked,
// so no case touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeTransportationTile,
  encodeVectorTile,
} from './fixtures/vectorTileEncoder.mjs';
import {
  ROAD_TILE_FULL_ZOOM,
  ROAD_TILE_MAJOR_ZOOM,
  ROAD_TILES_ATTRIBUTION,
  ROAD_TILES_CREDIT,
  clipPolyline,
  decodeRoadTile,
  fetchRoadsForBounds,
  getRoadTileSessionStats,
  releaseRoadTilesAwayFrom,
  resetRoadTileCache,
  roadTileHighway,
} from './roadTiles.js';
import { lonLatToTile, tileToBBox, tilesForBounds } from './tomtomTiles.js';

const AUSTIN = { lat: 30.2672, lon: -97.7431 };
const TORONTO = { lat: 43.6532, lon: -79.3832 };
/** Highway values the Overpass query this replaces fetched (traffic.js buildOverpassQuery). */
const OVERPASS_MAJOR_HIGHWAYS = ['motorway', 'trunk', 'primary', 'secondary'];
const OVERPASS_FULL_HIGHWAYS = [...OVERPASS_MAJOR_HIGHWAYS, 'tertiary', 'residential', 'unclassified'];
/**
 * Transportation feature properties exactly as decoded from real OpenFreeMap
 * planet tiles (build 20260906_080001_pt: Austin 14/3743/6745, 14/3742/6744,
 * 12/935/1686 and 12/936/1686), each with the highway value traffic must draw.
 * Planet tiles send no subclass on `minor`, and a ramp is its road class plus
 * `ramp: 1`.
 */
const REAL_TRANSPORTATION_PROPERTIES = [
  [{ surface: 'paved', class: 'motorway', oneway: 1, network: 'us-interstate' }, 'motorway'],
  [{ class: 'motorway', oneway: 1, ramp: 1 }, null],
  [{ brunnel: 'tunnel', surface: 'paved', ramp: 1, class: 'motorway', toll: 1, layer: -1, oneway: 1 }, null],
  [{ bicycle: 'yes', expressway: 1, surface: 'paved', class: 'trunk', oneway: 1 }, 'trunk'],
  [{ surface: 'paved', class: 'trunk', oneway: 1, ramp: 1 }, null],
  [{ surface: 'paved', class: 'primary', oneway: 1 }, 'primary'],
  [{ surface: 'paved', class: 'primary', oneway: 1, ramp: 1 }, null],
  [{ surface: 'paved', class: 'secondary', oneway: 1 }, 'secondary'],
  [{ surface: 'paved', class: 'secondary', oneway: 1, ramp: 1 }, null],
  [{ surface: 'paved', class: 'tertiary' }, 'tertiary'],
  [{ surface: 'paved', class: 'tertiary', oneway: 1, ramp: 1 }, null],
  [{ surface: 'paved', class: 'minor' }, 'residential'],
  [{ class: 'minor', brunnel: 'tunnel' }, 'residential'],
  [{ class: 'service', layer: -1 }, null],
  [{ class: 'service', layer: -1, service: 'alley' }, null],
  [{ brunnel: 'tunnel', surface: 'paved', class: 'service', oneway: 1, service: 'driveway' }, null],
  [{ surface: 'paved', class: 'service', service: 'parking_aisle' }, null],
  [{ subclass: 'footway', surface: 'paved', class: 'path', ramp: 1 }, null],
  [{ subclass: 'cycleway', bicycle: 'designated', surface: 'paved', class: 'path', foot: 'designated' }, null],
  [{ subclass: 'steps', brunnel: 'tunnel', surface: 'paved', class: 'path', layer: -1 }, null],
  [{ class: 'track' }, null],
  [{ subclass: 'rail', class: 'rail', service: 'crossover' }, null],
  [{ surface: 'paved', class: 'pier' }, null],
  [{ class: 'bridge', layer: 1, brunnel: 'bridge' }, null],
  [{ class: 'raceway' }, null],
  [{ class: 'minor_construction', access: 'no' }, null],
  [{ class: 'path_construction' }, null],
  [{ surface: 'paved', class: 'secondary_construction', oneway: 1 }, null],
  [{ class: 'motorway_construction', oneway: 1 }, null],
];
const BOUNDS = { south: AUSTIN.lat - 0.02, west: AUSTIN.lon - 0.02, north: AUSTIN.lat + 0.02, east: AUSTIN.lon + 0.02 };

/** Horizontal primary roads (one-way) and vertical residential roads, drawn past the tile buffer. */
function gridTile(step = 512) {
  const features = [];
  for (let v = step / 2; v < 4096; v += step) {
    features.push({ properties: { class: 'primary', oneway: 1 }, geometry: [[[-64, v], [4160, v]]] });
    features.push({ properties: { surface: 'paved', class: 'minor' }, geometry: [[[v, -64], [v, 4160]]] });
  }
  return encodeTransportationTile(features);
}

/** Every real property set as a row across the tile, repeated down it so any fetch box crosses each. */
function realPropertiesTile() {
  const features = [];
  for (let row = 0; row < 8; row++) {
    REAL_TRANSPORTATION_PROPERTIES.forEach(([properties], i) => {
      const v = 16 + row * 512 + i * 16;
      features.push({ properties, geometry: [[[-64, v], [4160, v]]] });
    });
  }
  return encodeTransportationTile(features);
}

/** Mock fetch serving tiles from `/api/roads/tiles/z/x/y.pbf`; `answer` may override per tile. */
function serveTiles(t, answer = () => null) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, { signal } = {}) => {
    const match = String(url).match(/^\/api\/roads\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    assert.ok(match, `unexpected fetch ${url}`);
    const [z, x, y] = match.slice(1).map(Number);
    requests.push({ z, x, y, signal });
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return answer({ z, x, y }) || new Response(gridTile(), { status: 200 });
  });
  return requests;
}

const within = (value, lo, hi) => value >= lo - 1e-9 && value <= hi + 1e-9;

test('real planet tile properties map onto the old Overpass road set: no service roads, no ramps, minor is residential', () => {
  for (const [properties, expected] of REAL_TRANSPORTATION_PROPERTIES) {
    const highway = roadTileHighway(properties);
    assert.equal(highway, expected, JSON.stringify(properties));
    if (highway) assert.ok(OVERPASS_FULL_HIGHWAYS.includes(highway), highway);
  }
  for (const skipped of ['transit', 'ferry', 'busway', 'aerialway', 'courtyard']) {
    assert.equal(roadTileHighway({ class: skipped }), null, skipped);
  }
  assert.equal(roadTileHighway({ class: 'minor', subclass: 'unclassified' }), 'residential', 'a subclass changes nothing');
  assert.equal(roadTileHighway({ class: 'motorway', ramp: 0 }), 'motorway');
  assert.equal(roadTileHighway({}), null);
  assert.equal(roadTileHighway(null), null);
});

test('through real-shaped tiles the major pass draws motorway…secondary and the full pass only old Overpass classes', async (t) => {
  resetRoadTileCache();
  const tile = realPropertiesTile();
  serveTiles(t, () => new Response(tile, { status: 200 }));
  const highways = (payload) => [...new Set(payload.elements.map((el) => el.tags.highway))].sort();

  const major = await fetchRoadsForBounds(BOUNDS, { majorOnly: true });
  assert.deepEqual(highways(major), [...OVERPASS_MAJOR_HIGHWAYS].sort());
  const full = await fetchRoadsForBounds(BOUNDS);
  assert.deepEqual(highways(full), ['motorway', 'primary', 'residential', 'secondary', 'tertiary', 'trunk']);

  const z = ROAD_TILE_FULL_ZOOM;
  const { x, y } = lonLatToTile(AUSTIN.lon, AUSTIN.lat, z);
  const drawn = REAL_TRANSPORTATION_PROPERTIES.filter(([, highway]) => highway).length;
  assert.equal(decodeRoadTile(tile, z, x, y).length, drawn * 8, 'service roads, ramps and non-roads add no pieces');
});

test('polylines clip to a rectangle, splitting where a line leaves and re-enters', () => {
  assert.deepEqual(clipPolyline([[1, 1], [2, 2], [3, 1]], 0, 0, 4, 4), [[[1, 1], [2, 2], [3, 1]]]);
  assert.deepEqual(clipPolyline([[-2, 1], [6, 1]], 0, 0, 4, 4), [[[0, 1], [4, 1]]]);
  assert.deepEqual(
    clipPolyline([[1, 1], [1, 6], [3, 6], [3, 1]], 0, 0, 4, 4),
    [[[1, 1], [1, 4]], [[3, 4], [3, 1]]],
  );
  assert.deepEqual(clipPolyline([[5, 5], [9, 9]], 0, 0, 4, 4), []);
  assert.deepEqual(clipPolyline([[1, 1]], 0, 0, 4, 4), []);
  assert.deepEqual(clipPolyline([[-1, 0], [0, 0]], 0, 0, 4, 4), [], 'a touch at one point is not a road');
});

test('a tile decodes only drivable lines, clipped to the tile, with one-way direction kept', () => {
  const z = ROAD_TILE_FULL_ZOOM;
  const { x, y } = lonLatToTile(AUSTIN.lon, AUSTIN.lat, z);
  const box = tileToBBox(z, x, y);
  const bytes = encodeVectorTile([
    { name: 'water', features: [{ type: 3, properties: { class: 'river' }, geometry: [[[0, 0], [10, 0], [10, 10], [0, 0]]] }] },
    {
      name: 'transportation',
      features: [
        { properties: { class: 'motorway', oneway: 1, brunnel: 'bridge' }, geometry: [[[-80, 1000], [4176, 1000]]] },
        { properties: { class: 'secondary', oneway: -1 }, geometry: [[[2048, 100], [2048, 3900]]] },
        { properties: { surface: 'paved', class: 'minor' }, geometry: [[[100, 100], [900, 900]], [[3000, 3000], [3500, 3200]]] },
        { properties: { class: 'service', service: 'driveway' }, geometry: [[[10, 10], [20, 20]]] },
        { properties: { class: 'service', layer: -1 }, geometry: [[[200, 10], [400, 20]]] },
        { properties: { class: 'motorway', oneway: 1, ramp: 1 }, geometry: [[[600, 10], [800, 20]]] },
        { properties: { class: 'path', subclass: 'footway' }, geometry: [[[30, 30], [40, 40]]] },
        { properties: { class: 'rail', subclass: 'rail' }, geometry: [[[50, 50], [60, 60]]] },
        { type: 3, properties: { class: 'primary' }, geometry: [[[0, 0], [100, 0], [100, 100], [0, 0]]] },
        { type: 1, properties: { class: 'primary' }, geometry: [[[500, 500]]] },
        { properties: { class: 'tertiary' }, geometry: [[[5000, 5000], [6000, 6000]]] },
      ],
    },
  ]);
  const roads = decodeRoadTile(bytes, z, x, y);
  assert.deepEqual(
    roads.map(({ highway, major, oneway }) => [highway, major, oneway]),
    [
      ['motorway', true, 'yes'],
      ['secondary', true, '-1'],
      ['residential', false, null],
      ['residential', false, null],
    ],
  );
  const motorway = roads[0].coords;
  assert.equal(motorway.length, 2);
  assert.ok(Math.abs(motorway[0][0] - box.west) < 1e-9, 'buffer beyond the tile is clipped away');
  assert.ok(Math.abs(motorway[1][0] - box.east) < 1e-9);
  for (const road of roads) {
    for (const [lon, lat] of road.coords) {
      assert.ok(within(lon, box.west, box.east) && within(lat, box.south, box.north), `${lon},${lat} outside tile`);
    }
  }
  assert.equal(new Set(roads.map((road) => road.key)).size, roads.length, 'every piece has its own key');

  assert.deepEqual(decodeRoadTile(new Uint8Array(0), z, x, y), [], 'an empty tile is open water, not an error');
  assert.deepEqual(decodeRoadTile(new Uint8Array([0xff, 0xff, 0xff]), z, x, y), []);
  assert.deepEqual(decodeRoadTile(encodeVectorTile([{ name: 'water', features: [] }]), z, x, y), []);
});

test('the major pass reads z12 major classes; the full pass reads z14 and adds minor roads', async (t) => {
  resetRoadTileCache();
  const requests = serveTiles(t);

  const major = await fetchRoadsForBounds(BOUNDS, { majorOnly: true });
  assert.ok(requests.length > 0 && requests.every((r) => r.z === ROAD_TILE_MAJOR_ZOOM));
  assert.equal(requests.length, tilesForBounds(BOUNDS, ROAD_TILE_MAJOR_ZOOM).length);
  assert.ok(major.elements.length > 0);
  assert.equal(major.partial, undefined);
  assert.deepEqual([...new Set(major.elements.map((el) => el.tags.highway))], ['primary']);

  requests.length = 0;
  const full = await fetchRoadsForBounds(BOUNDS);
  assert.ok(requests.every((r) => r.z === ROAD_TILE_FULL_ZOOM));
  assert.equal(requests.length, tilesForBounds(BOUNDS, ROAD_TILE_FULL_ZOOM).length);
  assert.deepEqual([...new Set(full.elements.map((el) => el.tags.highway))].sort(), ['primary', 'residential']);

  for (const el of [...major.elements, ...full.elements]) {
    assert.equal(el.type, 'way');
    assert.equal(typeof el.id, 'string');
    assert.ok(el.geometry.length >= 2);
    for (const { lat, lon } of el.geometry) {
      assert.ok(within(lat, BOUNDS.south, BOUNDS.north) && within(lon, BOUNDS.west, BOUNDS.east), 'clipped to the fetch box');
    }
    if (el.tags.highway === 'primary') assert.equal(el.tags.oneway, 'yes');
    else assert.equal('oneway' in el.tags, false);
  }
  assert.equal(new Set(full.elements.map((el) => el.id)).size, full.elements.length);

  requests.length = 0;
  await fetchRoadsForBounds(BOUNDS);
  await fetchRoadsForBounds(BOUNDS, { majorOnly: true });
  assert.equal(requests.length, 0, 'decoded tiles answer a revisit without a request');
});

test('some failed tiles return the rest as partial; every tile failing rejects', async (t) => {
  resetRoadTileCache();
  const tiles = tilesForBounds(BOUNDS, ROAD_TILE_MAJOR_ZOOM);
  assert.ok(tiles.length >= 2, 'the fixture box must straddle a tile edge');
  const [broken] = tiles;
  let failAll = false;
  const requests = serveTiles(t, ({ x, y }) =>
    failAll || (x === broken.x && y === broken.y) ? new Response('{"error":"upstream"}', { status: 502 }) : null,
  );

  const partial = await fetchRoadsForBounds(BOUNDS, { majorOnly: true });
  assert.equal(partial.partial, true);
  assert.ok(partial.elements.length > 0);

  requests.length = 0;
  await fetchRoadsForBounds(BOUNDS, { majorOnly: true });
  assert.deepEqual(requests.map(({ x, y }) => `${x}/${y}`), [`${broken.x}/${broken.y}`], 'only the failed tile is asked again');

  resetRoadTileCache();
  failAll = true;
  const failuresBefore = getRoadTileSessionStats().tileFailures;
  await assert.rejects(fetchRoadsForBounds(BOUNDS, { majorOnly: true }), /road tiles unavailable: road tile .*HTTP 502/);
  assert.equal(getRoadTileSessionStats().tileFailures - failuresBefore, tiles.length);
});

test('an aborted fetch rejects as AbortError and caches nothing', async (t) => {
  resetRoadTileCache();
  serveTiles(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchRoadsForBounds(BOUNDS, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(getRoadTileSessionStats().cachedTiles, 0);
});

test('a location switch releases decoded tiles away from the destination only', async (t) => {
  resetRoadTileCache();
  serveTiles(t);
  await fetchRoadsForBounds(BOUNDS, { majorOnly: true });
  const cached = getRoadTileSessionStats().cachedTiles;
  assert.ok(cached > 0);
  assert.equal(releaseRoadTilesAwayFrom(AUSTIN, 25), 0);
  assert.equal(releaseRoadTilesAwayFrom(TORONTO, 25), cached);
  await fetchRoadsForBounds(BOUNDS, { majorOnly: true });
  assert.equal(releaseRoadTilesAwayFrom(null, 25), cached, 'an unknown destination releases every tile');
});

test('the required OpenFreeMap attribution is exported verbatim', () => {
  assert.equal(ROAD_TILES_ATTRIBUTION, 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap');
  const text = ROAD_TILES_CREDIT.html.replace(/<[^>]+>/g, '');
  assert.ok(text.endsWith(ROAD_TILES_ATTRIBUTION), text);
  assert.match(ROAD_TILES_CREDIT.html, /href="https:\/\/openfreemap\.org"/);
});
