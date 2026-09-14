// src/locationCacheRelease.test.mjs — shared location-keyed client caches
// released when the user selects a place in another region.
//
// Locks releaseSharedLocationCaches({ to, keepRadiusKm }): it prunes the
// groundFloor mesh cells and terrainHeights DEM cache to the area around the
// destination, reports what it removed, and never throws. `fetch` is injected
// via `globalThis.fetch` (no real network), same pattern as
// terrainHeights.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCATION_CACHE_KEEP_RADIUS_KM, releaseSharedLocationCaches } from './locationCacheRelease.js';
import {
  cachedMeshFloor,
  reportMeshFloorCell,
  setMeshFloorPreferred,
  _clearMeshFloorCellsForTest,
} from './data/groundFloor.js';
import {
  cachedEllipsoidalGround,
  resolveEllipsoidalGround,
  terrainHeightsSwitchGeneration,
} from './data/terrainHeights.js';

const TORONTO = { key: 'CA-ON', region: 'CA-ON', country: 'CA', lat: 43.6532, lon: -79.3832 };
const OTTAWA = { lat: 45.4215, lon: -75.6972 }; // ~352 km from Toronto
const AUSTIN = { lat: 30.2672, lon: -97.7431 }; // ~2,000 km from Toronto

/** Installs a fake proxy (ellipsoid = lon + lat) for the duration of `fn`. */
async function withEchoProxy(fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const points = new URL(String(url), 'http://internal').searchParams.get('points')
      .split(';').map((pair) => pair.split(',').map(Number));
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: points.map(([lon, lat]) => ({ lon, lat, ellipsoid: lon + lat })) }),
    };
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Seeds both caches at Toronto, Ottawa and Austin, starting from empty. */
async function seedCaches() {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  // Empties the terrain cache left by an earlier test in this file.
  releaseSharedLocationCaches({ to: { lat: -89, lon: 0 }, keepRadiusKm: 0 });
  for (const place of [TORONTO, OTTAWA, AUSTIN]) reportMeshFloorCell(place.lat, place.lon, 100);
  await withEchoProxy(() => resolveEllipsoidalGround([TORONTO, OTTAWA, AUSTIN]));
}

test('releaseSharedLocationCaches: prunes both caches outside the keep radius and reports counts', async () => {
  await seedCaches();
  const generation = terrainHeightsSwitchGeneration();
  const counts = releaseSharedLocationCaches({ to: TORONTO, keepRadiusKm: 400 });
  assert.deepEqual(counts, { released: true, meshCells: 1, pendingFloorCells: 0, terrainHeights: 1 });
  assert.equal(cachedMeshFloor(AUSTIN.lat, AUSTIN.lon), null, 'far mesh cell released');
  assert.equal(cachedEllipsoidalGround(AUSTIN.lat, AUSTIN.lon), null, 'far DEM height released');
  assert.equal(cachedMeshFloor(OTTAWA.lat, OTTAWA.lon), 100, 'mesh cell inside the radius kept');
  assert.notEqual(cachedEllipsoidalGround(TORONTO.lat, TORONTO.lon), null, 'destination DEM height kept');
  assert.equal(terrainHeightsSwitchGeneration(), generation + 1, 'queued old-area lookups are now stale');
});

test('releaseSharedLocationCaches: defaults to a 300 km keep radius', async () => {
  assert.equal(LOCATION_CACHE_KEEP_RADIUS_KM, 300);
  await seedCaches();
  const counts = releaseSharedLocationCaches({ to: TORONTO });
  assert.deepEqual(counts, { released: true, meshCells: 2, pendingFloorCells: 0, terrainHeights: 2 });
  assert.equal(cachedMeshFloor(OTTAWA.lat, OTTAWA.lon), null, 'Ottawa is ~352 km out');
  assert.equal(cachedMeshFloor(TORONTO.lat, TORONTO.lon), 100);
});

test('releaseSharedLocationCaches: a repeated call releases nothing more', async () => {
  await seedCaches();
  releaseSharedLocationCaches({ to: TORONTO });
  assert.deepEqual(
    releaseSharedLocationCaches({ to: TORONTO }),
    { released: true, meshCells: 0, pendingFloorCells: 0, terrainHeights: 0 },
  );
  assert.equal(cachedMeshFloor(TORONTO.lat, TORONTO.lon), 100);
});

test('releaseSharedLocationCaches: a missing or invalid destination releases nothing and never throws', async () => {
  await seedCaches();
  const generation = terrainHeightsSwitchGeneration();
  const nothing = { released: false, meshCells: 0, pendingFloorCells: 0, terrainHeights: 0 };
  assert.deepEqual(releaseSharedLocationCaches(), nothing);
  assert.deepEqual(releaseSharedLocationCaches({ to: null }), nothing);
  assert.deepEqual(releaseSharedLocationCaches({ to: { lat: '43.6', lon: '-79.4' } }), nothing);
  assert.deepEqual(releaseSharedLocationCaches({ to: { lat: null, lon: null } }), nothing, 'null is not (0, 0)');
  assert.deepEqual(releaseSharedLocationCaches({ to: TORONTO, keepRadiusKm: -1 }), nothing);
  assert.deepEqual(releaseSharedLocationCaches({ to: TORONTO, keepRadiusKm: Number.NaN }), nothing);
  assert.equal(cachedMeshFloor(AUSTIN.lat, AUSTIN.lon), 100, 'nothing was released');
  assert.equal(terrainHeightsSwitchGeneration(), generation, 'and no queued lookup was made stale');
});
