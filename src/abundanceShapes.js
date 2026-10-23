/**
 * The shapes the GLOBAL ABUNDANCE MAP colours: countries and states or
 * provinces as polygons, cities as points, from the bundled Natural Earth
 * packs, keyed by the same unit ids the server attaches figures to
 * (src/abundanceUnits.mjs). Each pack is fetched on the first level that
 * needs it, never at app start, and kept; a failed load is retried later
 * (`createRetryableLoader`). PURE data module — no Cesium, node-testable.
 */
import { decodeRing } from './data/adminBoundaries.js';
import { loadBundledJson } from './data/bundledJson.js';
import { createRetryableLoader } from './data/retryableLoad.js';
import { cityUnits, countryEntries, regionEntries } from './abundanceUnits.mjs';

const PACKS = {
  country: new URL(
    './data/local_data/natural_earth/countries.json',
    import.meta.url,
  ),
  region: new URL(
    './data/local_data/natural_earth/states_provinces.json',
    import.meta.url,
  ),
  city: new URL('./data/local_data/natural_earth/places.json', import.meta.url),
};

/** Test seam: count pack loads (lazy-loading contract). */
export const shapeLoads = { country: 0, region: 0, city: 0 };

/** A polygon level's shapes: [{ id, name, polygons: [[outer, ...holes]] }] with decoded [lon, lat] rings. */
function polygonShapes(entries) {
  return entries.map(({ feature, decimals, unit }) => ({
    id: unit.id,
    name: unit.name,
    polygons: (feature.polygons || []).map((poly) =>
      poly.map((ring) => decodeRing(ring, decimals)),
    ),
  }));
}

const loaders = {
  country: createRetryableLoader(async () => {
    shapeLoads.country += 1;
    const pack = await loadBundledJson(PACKS.country);
    return {
      level: 'country',
      kind: 'polygons',
      shapes: polygonShapes(countryEntries(pack)),
    };
  }),
  region: createRetryableLoader(async () => {
    shapeLoads.region += 1;
    const pack = await loadBundledJson(PACKS.region);
    return {
      level: 'region',
      kind: 'polygons',
      shapes: polygonShapes(regionEntries(pack)),
    };
  }),
  city: createRetryableLoader(async () => {
    shapeLoads.city += 1;
    const pack = await loadBundledJson(PACKS.city);
    return {
      level: 'city',
      kind: 'points',
      shapes: cityUnits(pack).map((u) => ({
        id: u.id,
        name: u.name,
        lat: u.lat,
        lon: u.lon,
        pop: u.pop,
      })),
    };
  }),
};

/**
 * The shapes of one level.
 * @param {'country'|'region'|'city'} level
 * @returns {Promise<{level: string, kind: 'polygons'|'points', shapes: object[]}>}
 */
export function loadAbundanceShapes(level) {
  const loader = loaders[level];
  if (!loader) return Promise.reject(new Error(`No shapes for ${level}`));
  return loader();
}
