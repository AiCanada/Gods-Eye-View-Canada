/**
 * Offline reverse lookup over the bundled Natural Earth packs: the country and
 * first-level region (province, state or territory: Natural Earth admin-1) a
 * point is in, and the nearest city. Nothing is fetched, so the point never
 * leaves this machine, and no Nominatim endpoint or daily allowance is needed.
 *
 * Data: `local_data/natural_earth/{countries,states_provinces,places}.json`
 * (Natural Earth 10m admin-0, admin-1 and populated places, public domain;
 * built by `scripts/build-admin-packs.mjs`, provenance in the folder's README).
 *
 * The borders follow the coast, so a point inside no border but within 12
 * nautical miles of one (the territorial sea: a harbour, a bay, a lake shore)
 * belongs to the nearest. Farther out at sea it is unplaced (null). At this
 * 1:10m scale a border is drawn to about a kilometre, so a point that close
 * to one (St. Stephen and Calais across the St. Croix) may read as the
 * neighbour.
 *
 * PURE data module, no Cesium, node-testable; the server's location-region and
 * nearest-city routes use it. The packs load on the first lookup (never at
 * start) through `loadBundledJson`, a failed load is retried later
 * (`createRetryableLoader`), and only the borders a lookup tests are decoded,
 * then kept.
 */

import { loadBundledJson } from './bundledJson.js';
import { createRetryableLoader } from './retryableLoad.js';
import {
  boxDistanceKm,
  containsAnchor,
  decodeRing,
} from './adminBoundaries.js';
import { EARTH_RADIUS_KM, greatCircleKm } from '../geoDistance.js';

const PACKS = {
  countries: new URL(
    './local_data/natural_earth/countries.json',
    import.meta.url,
  ),
  admin1: new URL(
    './local_data/natural_earth/states_provinces.json',
    import.meta.url,
  ),
  places: new URL('./local_data/natural_earth/places.json', import.meta.url),
};

/** 12 nautical miles, the territorial sea: how far off a border a point still belongs to it. */
export const TERRITORIAL_SEA_KM = 22.224;

/**
 * How far away a city may be and still be named the nearest: the reach of
 * the page's own gazetteer (`CLOSEST_CITY_MAX_KM` in `src/locations.js`).
 */
export const NEAREST_CITY_MAX_KM = 150;

/**
 * Countries whose units in the pack sit below the first level (French
 * departments, Italian and Spanish provinces, British boroughs and unitary
 * authorities, Irish counties, Belgian provinces, Philippine provinces and
 * cities, ...), with `group` naming the region above them: there a region is
 * that group (Île-de-France, Lazio, London, Scotland), so moving around one
 * city or region stays in it. Elsewhere `group` is a larger grouping (the US
 * South, Western Canada) and a region is the unit itself.
 */
export const REGION_GROUP_COUNTRIES = new Set([
  'BA',
  'BE',
  'BF',
  'ES',
  'FR',
  'GB',
  'GN',
  'GW',
  'IE',
  'IT',
  'KN',
  'LK',
  'MW',
  'PH',
  'UG',
]);

const REGION_CODE = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const KM_PER_DEGREE = (Math.PI / 180) * EARTH_RADIUS_KM;

/**
 * One polygon of each unit, with the box of its outer ring. The rings stay
 * encoded until a lookup tests that polygon. Natural Earth cuts its borders
 * at the antimeridian (only Antarctica's ring runs along it, and
 * `containsAnchor` reads that one as stored), so every box is on one side.
 */
function partsOf(pack) {
  const parts = [];
  const packDecimals = pack.meta?.decimals ?? 3;
  for (const feature of pack.features || []) {
    const decimals = feature.d ?? packDecimals;
    const factor = 10 ** decimals;
    for (const polygon of feature.polygons || []) {
      const outer = polygon?.[0];
      if (!Array.isArray(outer) || outer.length < 6) continue;
      let x = 0;
      let y = 0;
      let west = Infinity;
      let south = Infinity;
      let east = -Infinity;
      let north = -Infinity;
      for (let i = 0; i + 1 < outer.length; i += 2) {
        x += outer[i];
        y += outer[i + 1];
        if (x < west) west = x;
        if (x > east) east = x;
        if (y < south) south = y;
        if (y > north) north = y;
      }
      parts.push({
        feature,
        decimals,
        encoded: polygon,
        rings: null,
        bbox: [west / factor, south / factor, east / factor, north / factor],
      });
    }
  }
  return parts;
}

function ringsOf(part) {
  part.rings ||= part.encoded.map((ring) => decodeRing(ring, part.decimals));
  return part.rings;
}

function boxContains([west, south, east, north], lat, lon) {
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

function boxArea([west, south, east, north]) {
  return (east - west) * (north - south);
}

/** The unit holding the point; where units overlap, the smallest. */
function containing(parts, lat, lon) {
  let best = null;
  for (const part of parts) {
    if (!boxContains(part.bbox, lat, lon)) continue;
    if (!containsAnchor([ringsOf(part)], lat, lon)) continue;
    const area = boxArea(part.bbox);
    if (!best || area < best.area) best = { part, area };
  }
  return best?.part.feature ?? null;
}

/** Km from the origin to segment a-b, in a plane around the point. */
function segmentKm(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2
    ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2))
    : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Km from the point to a ring's nearest edge (flat around the point: fine within a few tens of km). */
function ringKm(ring, lat, lon) {
  const kx = Math.cos((lat * Math.PI) / 180) * KM_PER_DEGREE;
  const project = ([x, y]) => [
    (((x - lon + 540) % 360) - 180) * kx,
    (y - lat) * KM_PER_DEGREE,
  ];
  let best = Infinity;
  let [ax, ay] = project(ring[ring.length - 1]);
  for (const vertex of ring) {
    const [bx, by] = project(vertex);
    const km = segmentKm(ax, ay, bx, by);
    if (km < best) best = km;
    ax = bx;
    ay = by;
  }
  return best;
}

/** The unit whose border is nearest the point, if within `maxKm`. */
function nearestWithin(parts, lat, lon, maxKm) {
  let best = null;
  for (const part of parts) {
    if (boxDistanceKm(part.bbox, lat, lon) > maxKm) continue;
    const km = ringKm(ringsOf(part)[0], lat, lon);
    if (km <= maxKm && (!best || km < best.km)) best = { part, km };
  }
  return best?.part.feature ?? null;
}

function unitAt(parts, lat, lon) {
  return (
    containing(parts, lat, lon) ||
    nearestWithin(parts, lat, lon, TERRITORIAL_SEA_KM)
  );
}

const codeOf = (value, pattern) => {
  const code = String(value || '')
    .trim()
    .toUpperCase();
  return pattern.test(code) ? code : null;
};

/**
 * The three packs, loaded and indexed on the first call and kept: the cache.
 * A failed load is retried later (`createRetryableLoader`). A server keeps one
 * per process (see `server/providers/regional/place.js`), so a Vite restart's
 * fresh module copy reuses it instead of pinning another.
 *
 * @returns {() => Promise<object>}
 */
export function createNaturalEarthIndexLoader() {
  return createRetryableLoader(async () => {
    const [countries, admin1, places] = await Promise.all([
      loadBundledJson(PACKS.countries),
      loadBundledJson(PACKS.admin1),
      loadBundledJson(PACKS.places),
    ]);
    return {
      countries: partsOf(countries),
      admin1: partsOf(admin1),
      places: (places.features || []).filter(
        (city) => Number.isFinite(city?.lat) && Number.isFinite(city?.lon),
      ),
    };
  });
}

function validPoint(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

/**
 * The key a location switch compares: the unit's ISO 3166-2 code, else the
 * country and its group ("GB:London"), else the country code, else ''.
 */
function regionKey({ regionCode, countryCode, group }) {
  if (regionCode) return regionCode;
  if (!countryCode) return '';
  return group ? `${countryCode}:${group}` : countryCode;
}

function regionIn(index, lat, lon) {
  const unit = unitAt(index.admin1, lat, lon);
  let place = null;
  if (unit) {
    const countryCode = codeOf(unit.iso2, COUNTRY_CODE);
    const group =
      countryCode && unit.group && REGION_GROUP_COUNTRIES.has(countryCode)
        ? String(unit.group)
        : null;
    place = {
      region: group || unit.nameEn || unit.name || null,
      regionCode: group ? null : codeOf(unit.iso, REGION_CODE),
      country: unit.country || null,
      countryCode,
      group,
    };
  }
  if (!place?.countryCode) {
    const country = unitAt(index.countries, lat, lon);
    if (country)
      place = {
        region: place?.region ?? null,
        regionCode: place?.regionCode ?? null,
        country: place?.country || country.country || country.name || null,
        countryCode: codeOf(country.iso2, COUNTRY_CODE),
        group: null,
      };
  }
  if (!place) return null;
  return {
    key: regionKey(place),
    region: place.region,
    regionCode: place.regionCode,
    country: place.country,
    countryCode: place.countryCode,
  };
}

function cityIn(index, lat, lon) {
  const point = { lat, lon };
  let pick = null;
  for (const city of index.places) {
    const km = greatCircleKm(point, city);
    if (km <= NEAREST_CITY_MAX_KM && (!pick || km < pick.km))
      pick = { city, km };
  }
  if (!pick?.city.name) return null;
  const cityRegion = regionIn(index, pick.city.lat, pick.city.lon);
  return {
    locality: pick.city.name,
    region: cityRegion?.region || pick.city.adm1 || null,
    country: cityRegion?.country || pick.city.country || null,
    countryCode:
      cityRegion?.countryCode || codeOf(pick.city.iso2, COUNTRY_CODE),
    distanceKm: pick.km,
  };
}

/**
 * The two lookups over one index loader.
 *
 * `regionAt(latitude, longitude)`: the province, state or territory and the
 * country a point is in, as `{key, region, regionCode, country, countryCode}`,
 * or null at sea. `regionCode` is the unit's ISO 3166-2 code ("CA-ON",
 * "US-TX"), `countryCode` its ISO 3166-1 alpha-2 code ("CA"), and `key` what a
 * location switch compares (see `regionKey`).
 *
 * `cityAt(latitude, longitude)`: the nearest city (one of the pack's 7,342
 * populated places) within `NEAREST_CITY_MAX_KM`, at sea too, with that
 * city's own region as `regionAt` names it there, as
 * `{locality, region, country, countryCode, distanceKm}`; null with no city
 * in reach.
 *
 * Both answer null for a point off the globe.
 *
 * @param {{loadIndex?: () => Promise<object>}} [options]
 */
export function createNaturalEarthPlaces({
  loadIndex = createNaturalEarthIndexLoader(),
} = {}) {
  return {
    async regionAt(latitude, longitude) {
      if (!validPoint(latitude, longitude)) return null;
      return regionIn(await loadIndex(), latitude, longitude);
    },
    async cityAt(latitude, longitude) {
      if (!validPoint(latitude, longitude)) return null;
      return cityIn(await loadIndex(), latitude, longitude);
    },
  };
}
