import { CITY_POIS } from '../locations.js';

/**
 * Camera-to-city matching for the CCTV catalogue.
 *
 * A camera's `city` text names a preset city when it equals the preset's name
 * or one of its aliases, or partly contains one ("Montréal side"). Text alone
 * can point at the wrong place: "Hwy 1 Austin" is in Manitoba, "Vancouver
 * Island" is not Vancouver, and "Ft McMurray / N Central" covers highway
 * cameras hundreds of kilometres north of the city. So a match only counts
 * when the camera also sits near that city's view bounds.
 */

/** How far outside a city's view bounds a camera may sit and still belong to it. */
export const CITY_MATCH_MAX_KM_OUTSIDE = 25;

const KM_PER_DEGREE = 111.32;

/** Distance in km from a point to a city's view bounds; 0 when inside. */
export function kmOutsideViewBounds(city, lat, lon) {
  const { southwest: sw, northeast: ne } = city.viewBounds;
  const dLat = lat < sw.lat ? sw.lat - lat : lat > ne.lat ? lat - ne.lat : 0;
  const dLon = lon < sw.lng ? sw.lng - lon : lon > ne.lng ? lon - ne.lng : 0;
  return Math.hypot(
    dLat * KM_PER_DEGREE,
    dLon * KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180),
  );
}

/**
 * The preset city a camera belongs to, or null.
 *
 * @param {string} cityName Camera `city` text.
 * @param {number} [lat] Camera latitude; without coordinates only the name is used.
 * @param {number} [lon] Camera longitude.
 * @param {object} [cityPois] Preset cities (CITY_POIS by default).
 * @returns {string|null} CITY_POIS id.
 */
export function cityIdByName(
  cityName,
  lat = Number.NaN,
  lon = Number.NaN,
  cityPois = CITY_POIS,
) {
  const probe = String(cityName || '')
    .trim()
    .toLowerCase();
  if (!probe) return null;
  const located = Number.isFinite(lat) && Number.isFinite(lon);
  const namesOf = (city) =>
    [city.name, ...(city.aliases || [])].map((name) => name.toLowerCase());
  const nearby = (city) =>
    !located ||
    !city.viewBounds ||
    kmOutsideViewBounds(city, lat, lon) <= CITY_MATCH_MAX_KM_OUTSIDE;
  for (const [cityId, city] of Object.entries(cityPois)) {
    if (namesOf(city).includes(probe) && nearby(city)) return cityId;
  }
  for (const [cityId, city] of Object.entries(cityPois)) {
    const partly = namesOf(city).some(
      (name) => name.includes(probe) || probe.includes(name),
    );
    if (partly && nearby(city)) return cityId;
  }
  return null;
}
