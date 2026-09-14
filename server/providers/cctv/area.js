import { haversineKm } from '../common/geo.js';
import {
  CCTV_AREA_GRID_DEG,
  CCTV_AREA_MIN_RADIUS_KM,
  CCTV_AREA_RADIUS_KM,
  CCTV_LOAD_CAP_HARD_LIMIT,
} from './constants.js';

/** Kilometres per degree of latitude on the sphere haversineKm uses. */
const KM_PER_DEG = (6371 * Math.PI) / 180;
const LAT_CELLS = Math.round(180 / CCTV_AREA_GRID_DEG);
const LON_CELLS = Math.round(360 / CCTV_AREA_GRID_DEG);

/** A query value as a number; missing or blank is NaN, never 0. */
function queryNumber(value) {
  if (value === null || value === undefined) return NaN;
  const text = String(value).trim();
  return text ? Number(text) : NaN;
}

function gridRow(lat) {
  return Math.min(
    LAT_CELLS - 1,
    Math.max(0, Math.floor((lat + 90) / CCTV_AREA_GRID_DEG)),
  );
}

function gridCol(index) {
  return ((index % LON_CELLS) + LON_CELLS) % LON_CELLS;
}

/**
 * The point a /sources request is centred on, or null when it has none. A
 * missing or blank coordinate is not 0: without a real point nothing loads.
 *
 * @returns {{lat: number, lon: number}|null}
 */
export function parseCctvAreaPoint(lat, lon) {
  const la = queryNumber(lat);
  const lo = queryNumber(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return { lat: la, lon: lo };
}

/** Area radius in km: 50 when unset, kept between 0.5 and 50. */
export function clampCctvAreaRadiusKm(value) {
  const radius = queryNumber(value);
  if (!Number.isFinite(radius)) return CCTV_AREA_RADIUS_KM;
  return Math.min(
    CCTV_AREA_RADIUS_KM,
    Math.max(CCTV_AREA_MIN_RADIUS_KM, radius),
  );
}

/** Grid cell holding a point; longitude wraps at the antimeridian. */
export function cctvGridCell(lat, lon) {
  return (
    gridRow(lat) * LON_CELLS +
    gridCol(Math.floor((lon + 180) / CCTV_AREA_GRID_DEG))
  );
}

/**
 * Index cameras by grid cell. Cameras without a finite position cannot be in
 * any area and are left out of the index (they stay in the catalogue).
 *
 * @param {Array<{lat: number, lon: number}>} sources
 * @returns {Map<number, Array<object>>}
 */
export function buildCctvGrid(sources) {
  const grid = new Map();
  for (const source of sources) {
    if (!Number.isFinite(source?.lat) || !Number.isFinite(source?.lon))
      continue;
    const cell = cctvGridCell(source.lat, source.lon);
    const bucket = grid.get(cell);
    if (bucket) bucket.push(source);
    else grid.set(cell, [source]);
  }
  return grid;
}

/**
 * Does a circular area touch a lat/lon box? Measured from the centre to the
 * nearest point of the box, which is exact enough for city-sized boxes.
 *
 * @param {{lat: number, lon: number, radiusKm: number}} area
 * @param {{south: number, north: number, west: number, east: number}} box
 */
export function areaOverlapsBox(area, box) {
  if (!Number.isFinite(area?.lat) || !Number.isFinite(area?.lon)) return false;
  const nearLat = Math.min(box.north, Math.max(box.south, area.lat));
  const nearLon = Math.min(box.east, Math.max(box.west, area.lon));
  return (
    haversineKm(area.lat, area.lon, nearLat, nearLon) <=
    clampCctvAreaRadiusKm(area.radiusKm)
  );
}

/** Grid columns a longitude span covers, wrapped across the antimeridian. */
function columnsFor(lon, dLon) {
  if (dLon >= 180) return Array.from({ length: LON_CELLS }, (_, i) => i);
  const from = Math.floor((lon - dLon + 180) / CCTV_AREA_GRID_DEG);
  const to = Math.floor((lon + dLon + 180) / CCTV_AREA_GRID_DEG);
  const cols = new Set();
  for (let index = from; index <= to; index += 1) cols.add(gridCol(index));
  return [...cols];
}

/**
 * The cameras one selected area loads: every camera within `radiusKm` of the
 * point, nearest first (ties by id), and at most 2,500 of them. A lower
 * `limit` is honoured; nothing raises it past the hard cap.
 *
 * `reachKm` is how far the loaded set reaches: the radius when every camera in
 * the area loaded, otherwise the distance of the farthest camera that did.
 *
 * @param {{sources: Array<object>, grid: Map<number, Array<object>>}} snapshot
 * @param {{lat: number, lon: number, radiusKm?: number, limit?: number}} query
 * @returns {{matches: Array<{source: object, distKm: number}>, area: object}}
 */
export function queryCctvArea(snapshot, { lat, lon, radiusKm, limit } = {}) {
  const radius = clampCctvAreaRadiusKm(radiusKm);
  const requested = queryNumber(limit);
  const cap =
    Number.isFinite(requested) && requested >= 1
      ? Math.min(CCTV_LOAD_CAP_HARD_LIMIT, Math.floor(requested))
      : CCTV_LOAD_CAP_HARD_LIMIT;
  const total = Array.isArray(snapshot?.sources) ? snapshot.sources.length : 0;
  const grid = snapshot?.grid instanceof Map ? snapshot.grid : new Map();
  const found = [];
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    // A small margin keeps a camera just past a cell edge from being missed:
    // great-circle distance is a little shorter than distance along a parallel.
    const dLat = (radius / KM_PER_DEG) * 1.02;
    const maxAbsLat = Math.min(
      90,
      Math.max(Math.abs(lat - dLat), Math.abs(lat + dLat)),
    );
    const cos = Math.cos((maxAbsLat * Math.PI) / 180);
    const dLon = cos > 1e-6 ? (radius / (KM_PER_DEG * cos)) * 1.02 : 360;
    const cols = columnsFor(lon, dLon);
    for (let row = gridRow(lat - dLat); row <= gridRow(lat + dLat); row += 1) {
      for (const col of cols) {
        const bucket = grid.get(row * LON_CELLS + col);
        if (!bucket) continue;
        for (const source of bucket) {
          const distKm = haversineKm(lat, lon, source.lat, source.lon);
          if (distKm <= radius) found.push({ source, distKm });
        }
      }
    }
  }
  found.sort((a, b) => {
    if (a.distKm !== b.distKm) return a.distKm - b.distKm;
    const idA = String(a.source.id);
    const idB = String(b.source.id);
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
  const matches = found.length > cap ? found.slice(0, cap) : found;
  const capped = found.length > matches.length;
  const reachKm = capped
    ? Math.round(matches[matches.length - 1].distKm * 1000) / 1000
    : radius;
  return {
    matches,
    area: {
      lat,
      lon,
      radiusKm: radius,
      limit: cap,
      inArea: found.length,
      loaded: matches.length,
      dropped: found.length - matches.length,
      reachKm,
      capped,
      total,
    },
  };
}
