import { directionToHeading } from '../../../src/data/directionText.js';
import { CCTV_CACHE_BUSTER_PARAMS, US_COORDINATE_BOX } from './constants.js';
import { FRAME_RESOLVERS, normalizeFrameHosts } from './frame-resolver.js';

/** Shared by every camera that lists no extra frame hosts (almost all). */
const NO_FRAME_HOSTS = Object.freeze([]);
/**
 * FNV-1a 32-bit hash of a string, used to derive deterministic pseudo-random
 * values (e.g. hue for synthetic SVG billboards, fallback heading angles).
 *
 * @param {string} text
 * @returns {number} Unsigned 32-bit hash.
 */
export function hashSeed(text) {
  let h = 2166136261 >>> 0; // FNV offset basis
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  return h >>> 0;
}

/**
 * Escape special XML/HTML characters for safe embedding in SVG text nodes.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Canonicalize a CCTV feed type string to one of:
 * 'image', 'mjpeg', 'mp4', 'webm', 'hls', 'none', or pass-through.
 *
 * 'none' is a camera with no public still or stream the proxy may fetch; it
 * shows a placeholder until a lookup (Road511) finds its still.
 *
 * @param {string} value - Raw feed type (e.g. 'jpeg', 'mjpg', 'video', 'stream').
 * @returns {string} Normalized feed type.
 */
export function normalizeFeedType(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return 'image';
  if (raw === 'none') return 'none';
  if (raw === 'jpeg' || raw === 'jpg' || raw === 'png') return 'image';
  if (raw === 'mjpg') return 'mjpeg';
  if (raw === 'video') return 'mp4';
  if (raw === 'stream') return 'hls';
  return raw;
}

/**
 * Check whether a normalized feed type represents streaming video.
 *
 * @param {string} feedType
 * @returns {boolean}
 */
export function isVideoFeedType(feedType) {
  return feedType === 'mp4' || feedType === 'webm' || feedType === 'hls';
}

/**
 * Coerce a value to a finite number, returning fallback if NaN/Infinity.
 *
 * @param {*} value
 * @param {number} [fallback=NaN]
 * @returns {number}
 */
export function toFiniteNumber(value, fallback = NaN) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Normalize a column/field name to a lowercase snake_case key.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Parse a WKT POINT string (e.g. "POINT(-97.74 30.27)") into lat/lon.
 *
 * WKT uses (lon lat) order; returned object uses {lat, lon}.
 *
 * @param {string} value
 * @returns {{lat:number, lon:number}}
 */
export function parsePointString(value) {
  const match = String(value || '').match(
    /POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i,
  );
  if (!match) return { lat: NaN, lon: NaN };
  return {
    lon: toFiniteNumber(match[1]),
    lat: toFiniteNumber(match[2]),
  };
}

/**
 * Extract lat/lon from a variety of coordinate representations.
 *
 * Handles WKT POINT strings, and objects with latitude/lat/y or
 * longitude/lon/lng/x properties (various casing).
 *
 * @param {string|object|null} value
 * @returns {{lat:number, lon:number}}
 */
export function coerceLatLon(value) {
  if (!value) return { lat: NaN, lon: NaN };

  if (typeof value === 'string') {
    return parsePointString(value);
  }

  if (typeof value !== 'object') {
    return { lat: NaN, lon: NaN };
  }

  const lat = toFiniteNumber(
    value.latitude ?? value.lat ?? value.y ?? value.Latitude ?? value.Lat,
    NaN,
  );
  const lon = toFiniteNumber(
    value.longitude ??
      value.lon ??
      value.lng ??
      value.x ??
      value.Longitude ??
      value.Lon,
    NaN,
  );
  return { lat, lon };
}

/**
 * Extract geographic coordinates from an Austin Open Data camera record.
 *
 * Tries several candidate fields (location, coordinates, the_geom,
 * point, geocoded_column) via coerceLatLon, then falls back to
 * explicit latitude/longitude scalar fields.
 *
 * @param {object} record - Flattened camera record.
 * @returns {{lat:number, lon:number}}
 */
export function extractAustinCoords(record) {
  const candidates = [
    record.location,
    record.coordinates,
    record.the_geom,
    record.point,
    record.geocoded_column,
  ];
  for (const candidate of candidates) {
    const parsed = coerceLatLon(candidate);
    if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lon))
      return parsed;
  }

  const lat = toFiniteNumber(
    record.latitude ??
      record.lat ??
      record.camera_latitude ??
      record.location_latitude,
    NaN,
  );
  const lon = toFiniteNumber(
    record.longitude ??
      record.lon ??
      record.lng ??
      record.camera_longitude ??
      record.location_longitude,
    NaN,
  );
  return { lat, lon };
}

/**
 * Extract a numeric camera ID from an Austin Open Data record.
 *
 * Tries well-known field names first, then scans any field whose key
 * contains "camera"/"cam"/"device" + "id".
 *
 * @param {object} record - Flattened camera record.
 * @returns {string} Numeric ID string, or '' if none found.
 */
export function extractAustinCameraId(record) {
  const preferredKeys = [
    'camera_id',
    'cameraid',
    'cam_id',
    'device_id',
    'intersection_id',
    'id',
  ];
  for (const key of preferredKeys) {
    const value = record[key];
    if (value == null) continue;
    const asText = String(value).trim();
    if (!asText) continue;
    if (/^\d+$/.test(asText)) return asText;
  }

  for (const [key, value] of Object.entries(record)) {
    if (!/camera|cam|device/.test(key)) continue;
    if (!/id/.test(key)) continue;
    const asText = String(value || '').trim();
    if (!asText) continue;
    if (/^\d+$/.test(asText)) return asText;
  }

  return '';
}

/**
 * Extract a human-readable camera name from an Austin record.
 *
 * @param {object} record - Flattened camera record.
 * @param {string} cameraId - Fallback identifier if no name field found.
 * @returns {string}
 */
export function extractAustinName(record, cameraId) {
  const preferredKeys = [
    'camera_name',
    'location_name',
    'intersection_name',
    'location',
    'cross_street',
    'description',
    'name',
  ];
  for (const key of preferredKeys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return `Austin Camera ${cameraId}`;
}

/**
 * Extract camera heading (compass bearing) from an Austin record.
 *
 * Tries explicit numeric heading fields first, then direction-keyword
 * fields, then infers from the camera name/description text.
 *
 * @param {object} record - Flattened camera record.
 * @returns {number} Heading in degrees [0..360), or NaN if unknown.
 */
export function extractAustinHeading(record) {
  const direct = toFiniteNumber(
    record.heading_deg ?? record.heading ?? record.bearing,
    NaN,
  );
  if (Number.isFinite(direct)) return ((direct % 360) + 360) % 360;

  // Dedicated direction fields: bare cardinal words ("West") are real facings.
  const directionKeys = [
    'direction',
    'travel_direction',
    'facing',
    'facing_direction',
  ];
  for (const key of directionKeys) {
    const heading = directionToHeading(record[key], true);
    if (Number.isFinite(heading)) return heading;
  }

  // Free-form name/intersection text: only explicit travel forms ("WESTBOUND"/
  // "WB") count — a bare "West" here is a street name ("5TH ST / WEST AVE"), not
  // a facing, and must not promote the camera to a false high-confidence heading.
  const nameProbe = [
    record.camera_name,
    record.location_name,
    record.intersection_name,
    record.location,
    record.cross_street,
    record.description,
    record.name,
  ]
    .filter(Boolean)
    .join(' ');
  const inferred = directionToHeading(nameProbe);
  if (Number.isFinite(inferred)) return inferred;

  return NaN;
}

/**
 * Plain coordinate sanity check for a US camera: finite, not the 0,0 null
 * island a missing value parses to, and inside the US box. Suburban and
 * out-of-town cameras pass; only broken coordinates fail.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function isPlausibleUsCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat === 0 && lon === 0) return false;
  const box = US_COORDINATE_BOX;
  return (
    lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east
  );
}

/**
 * Derive a deterministic fallback heading from a camera ID hash.
 *
 * Produces one of 16 evenly-spaced compass directions (0, 22.5, 45, ...).
 *
 * @param {string} cameraId
 * @returns {number} Heading in degrees [0..360).
 */
export function fallbackHeadingFromId(cameraId) {
  return (hashSeed(String(cameraId)) % 16) * 22.5;
}

/**
 * Convert a Socrata rows.json array row into a keyed object using column metadata.
 *
 * @param {Array} row - Array of cell values from the Socrata payload.
 * @param {Array<{fieldName?:string, name?:string}>} columns - Column descriptors.
 * @returns {object} Keyed record with normalized snake_case keys.
 */
export function rowArrayToObject(row, columns) {
  const record = {};
  for (let idx = 0; idx < columns.length; idx++) {
    const col = columns[idx];
    const key = normalizeKey(col.fieldName || col.name || `col_${idx}`);
    if (!key) continue;
    record[key] = row[idx];
  }
  return record;
}

/**
 * Normalize a raw CCTV source item into a canonical shape with safe defaults.
 *
 * @param {object} item - Raw source from file, env, or Austin Open Data.
 * @returns {object} Normalized source with all expected fields populated.
 */
export function normalizeSourceItem(item) {
  const frameHosts = normalizeFrameHosts(item.frameHosts);
  return {
    id: String(item.id || '').trim(),
    name: String(item.name || item.id || '').trim(),
    city: String(item.city || ''),
    cityId: String(item.cityId || ''),
    provider: String(item.provider || 'Configured CCTV Source'),
    lat: toFiniteNumber(item.lat),
    lon: toFiniteNumber(item.lon),
    // null / '' mean "unknown": leave it non-finite so the client's id-hash
    // fallback applies instead of a fabricated due-north bearing (Number(null) is 0).
    headingDeg:
      item.headingDeg === null ||
      item.headingDeg === undefined ||
      item.headingDeg === ''
        ? NaN
        : toFiniteNumber(item.headingDeg),
    headingConfidence: String(
      item.headingConfidence || item.headingSource || '',
    ).toLowerCase(),
    pitchDeg: toFiniteNumber(item.pitchDeg),
    fovDeg: toFiniteNumber(item.fovDeg),
    rangeM: toFiniteNumber(item.rangeM),
    mountHeightM: toFiniteNumber(item.mountHeightM),
    groundElevationM: toFiniteNumber(item.groundElevationM),
    feedType: normalizeFeedType(item.feedType || item.type || ''),
    url: typeof item.url === 'string' ? item.url : '',
    snapshotUrl: typeof item.snapshotUrl === 'string' ? item.snapshotUrl : '',
    // A camera with no public still names the service that can look one up
    // when the user opens it. Only Road511 is known; anything else is dropped.
    lookup: item.lookup === 'road511' ? 'road511' : '',
    // An HLS-only camera keeps its stream address for reference. It is never
    // proxied or served: the app ships no HLS player.
    videoUrl: typeof item.videoUrl === 'string' ? item.videoUrl : '',
    // Some operators publish only a frame whose URL carries the capture
    // timestamp, so no single URL stays valid. Such a camera declares the page
    // that advertises its current frame plus the strategy for reading it, and
    // the frame route resolves the real URL per request instead of storing one.
    pageUrl: typeof item.pageUrl === 'string' ? item.pageUrl : '',
    frameResolver: FRAME_RESOLVERS.has(item.frameResolver)
      ? item.frameResolver
      : '',
    // Extra hosts the resolver may accept a frame from, beyond the page's own.
    frameHosts: frameHosts.length ? frameHosts : NO_FRAME_HOSTS,
    // Operators that advertise a thumbnail in the page metadata also keep a
    // full-size sibling; set this when that substitution is valid.
    framePreferLarge: item.framePreferLarge === true,
    license: String(item.license || item.licenseNote || ''),
    // ISO country code used by the CCTV_COUNTRIES gate. An entry that declares
    // no country cannot be classified, so it is never filtered out.
    country: canonicalCountryCode(item.country),
    // Optional province/state code ("ON", "CA-ON", "TX") for cctvRegionKey;
    // without one the province or state is read from cityId.
    region: String(item.region || '')
      .trim()
      .toUpperCase(),
    sourceKind: String(item.sourceKind || item.kind || 'configured'),
    // Optional CAL badge input (cctv-v2 design §3b/§9.2, additive-only per the
    // global constraints — nothing else in this file changes): hand-authored
    // file/env catalog entries may declare poseSource:'curated' so the panel
    // badge can distinguish them from raw automated priors (e.g. Austin Open
    // Data, which never sets this field). Passed through as-is to the client.
    poseSource: item.poseSource === 'curated' ? 'curated' : undefined,
    // "CA-ON", "US-TX" or the country code; the catalogue fills it in
    // (cctvRegionKey). Declared here so every entry keeps one shape.
    regionKey: '',
  };
}

const CACHE_BUSTERS = new Set(CCTV_CACHE_BUSTER_PARAMS);
const EMPTY_OR_NUMERIC = /^[0-9.]*$/;
/** Windy serves one webcam's still at several sizes ("preview", "full"). */
const WINDY_STILL =
  /^https?:\/\/imgproxy\.windy\.com\/_\/[^/?#]+\/plain\/current\/(\d+)\//i;

/**
 * The identity of a still address, for spotting two catalogue entries that
 * show the same picture. Scheme and host are lower-cased (a default port is
 * dropped) and cache-buster parameters (CCTV_CACHE_BUSTER_PARAMS, empty or
 * numeric) are ignored; the path, every other parameter and the fragment are
 * kept as written. A Windy still is its webcam id, whatever size it names.
 *
 * @param {unknown} url
 * @returns {string} The key, or '' for no address.
 */
export function cctvStillKey(url) {
  if (typeof url !== 'string') return '';
  const text = url.trim();
  if (!text) return '';
  const windy = WINDY_STILL.exec(text);
  if (windy) return `windy:${windy[1]}`;
  const hashAt = text.indexOf('#');
  const beforeHash = hashAt === -1 ? text : text.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : text.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  let address = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  let query = queryAt === -1 ? '' : beforeHash.slice(queryAt + 1);
  const schemeEnd = address.indexOf('://');
  if (schemeEnd > 0) {
    const pathAt = address.indexOf('/', schemeEnd + 3);
    const authorityEnd = pathAt === -1 ? address.length : pathAt;
    const authority = address.slice(schemeEnd + 3, authorityEnd);
    const userEnd = authority.lastIndexOf('@') + 1;
    const scheme = address.slice(0, schemeEnd).toLowerCase();
    let host = authority.slice(userEnd).toLowerCase();
    if (
      (scheme === 'http' && host.endsWith(':80')) ||
      (scheme === 'https' && host.endsWith(':443'))
    )
      host = host.slice(0, host.lastIndexOf(':'));
    address = `${scheme}://${authority.slice(0, userEnd)}${host}${address.slice(authorityEnd)}`;
  }
  if (query) {
    const kept = [];
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=');
      const name = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      if (!pair) continue;
      if (CACHE_BUSTERS.has(name.toLowerCase()) && EMPTY_OR_NUMERIC.test(value))
        continue;
      kept.push(pair);
    }
    query = kept.join('&');
  }
  return `${address}${query ? `?${query}` : ''}${fragment}`;
}

/** Common spellings of the country codes camera packs use, mapped to ISO 3166 alpha-2. */
const COUNTRY_ALIASES = {
  // The international listing's code for a camera it could not place: no country.
  XX: '',
  CAN: 'CA',
  CANADA: 'CA',
  USA: 'US',
  'U.S.': 'US',
  'U.S.A.': 'US',
  'UNITED STATES': 'US',
  'UNITED STATES OF AMERICA': 'US',
  UK: 'GB',
  GBR: 'GB',
  'GREAT BRITAIN': 'GB',
  'UNITED KINGDOM': 'GB',
};

/**
 * Upper-cased country code, with common aliases ("Canada", "USA", "UK") mapped
 * to the ISO code so every spelling counts as the same country. "XX" (unknown)
 * is no country at all, so such a camera is never gated out.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalCountryCode(value) {
  const code = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  return Object.hasOwn(COUNTRY_ALIASES, code) ? COUNTRY_ALIASES[code] : code;
}
