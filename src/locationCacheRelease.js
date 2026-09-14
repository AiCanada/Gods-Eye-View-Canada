// src/locationCacheRelease.js — releases the shared, location-keyed client
// caches when the user selects a place in another region.
//
// Layer modules release what they own through their onLocationLeave hooks.
// This covers the caches several layers SHARE and none of them owns: the
// rendered-mesh floor cells and queued floor warms (groundFloor.js) and the
// DEM height cache (terrainHeights.js). Flights, military flights, CCTV,
// radio, the cockpit and military installations all fill them.
//
// Memory only. The server's .gev-cache files are untouched, so a return trip
// is a proxy cache hit rather than an upstream refetch. Pruning also starts a
// new terrain switch generation, which skips height lookups still queued for
// the old area (terrainHeights.js, fireAnchors.js).
import { pruneGroundFloorOutside } from './data/groundFloor.js';
import { pruneTerrainHeightsOutside } from './data/terrainHeights.js';

/** @constant {number} Default keep radius around the destination, in km —
 *  the same radius the server prunes to on /api/location-switch/release. */
export const LOCATION_CACHE_KEEP_RADIUS_KM = 300;

/**
 * Prunes the shared floor and terrain caches to the area around `to`.
 * Cheap and synchronous (no network), idempotent, and never throws: an
 * invalid destination or radius releases nothing and reports `released:
 * false`.
 * @param {object} [options]
 * @param {{lat: number, lon: number}|null} [options.to] - The place being
 *   switched to (the location-switch `to` descriptor).
 * @param {number} [options.keepRadiusKm] - Entries within this distance of
 *   `to` stay warm.
 * @returns {{released: boolean, meshCells: number, pendingFloorCells: number, terrainHeights: number}}
 *   Entries removed from each cache.
 */
export function releaseSharedLocationCaches({ to, keepRadiusKm = LOCATION_CACHE_KEEP_RADIUS_KM } = {}) {
  const counts = { released: false, meshCells: 0, pendingFloorCells: 0, terrainHeights: 0 };
  const radiusKm = keepRadiusKm ?? LOCATION_CACHE_KEEP_RADIUS_KM;
  if (!Number.isFinite(to?.lat) || !Number.isFinite(to?.lon)) return counts;
  if (!Number.isFinite(radiusKm) || radiusKm < 0) return counts;
  const center = { lat: to.lat, lon: to.lon };
  try {
    counts.terrainHeights = pruneTerrainHeightsOutside(center, radiusKm);
    const floor = pruneGroundFloorOutside(center, radiusKm);
    counts.meshCells = floor.meshCells;
    counts.pendingFloorCells = floor.pendingCells;
    counts.released = true;
  } catch (error) {
    // Both prunes are plain Map walks; this only guards the switch path from
    // an unexpected failure. Whatever was not released stays warm.
    console.debug('[LocationSwitch] shared cache release skipped:', error?.message || error);
  }
  return counts;
}
