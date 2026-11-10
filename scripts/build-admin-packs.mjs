#!/usr/bin/env node
/**
 * Build the bundled administrative-boundary packs read by
 * `src/data/adminBoundaries.js`:
 *
 *   src/data/local_data/natural_earth/states_provinces.json
 *     Natural Earth 10m admin-1 states and provinces (public domain).
 *   src/data/local_data/us_census_counties/counties.json
 *     US Census Bureau cartographic boundary counties (public domain).
 *   src/data/local_data/natural_earth/places.json
 *     Natural Earth 10m populated places (public domain): the cities the
 *     GLOBAL ABUNDANCE MAP draws, read by src/abundanceUnits.mjs.
 *   src/data/local_data/natural_earth/admin1_population.json
 *     Wikidata's population of each state and province (CC0), the people
 *     the GLOBAL ABUNDANCE MAP weighs a state or province by; carried into
 *     the states pack as `pop`.
 *
 * Both sources are pinned by URL and SHA-256, so a rerun reproduces the packs
 * byte for byte. Downloads are cached outside the repository (default: the
 * system temp directory) and are never committed. Wikidata is live, so its
 * snapshot is asked for on its own (`--only population`) and committed; the
 * states pack is built from the snapshot, never from the live service.
 *
 * Usage:
 *   node scripts/build-admin-packs.mjs [--cache <dir>] [--only countries|admin1|counties|places|population]
 *
 * The provenance READMEs beside each pack record these parameters.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { normalizeAdminName } from '../src/data/adminBoundaries.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NE_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const NE_BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_COMMIT}/geojson`;

export const SOURCES = Object.freeze({
  countries: {
    url: `${NE_BASE}/ne_10m_admin_0_countries.geojson`,
    sha256: '239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255',
  },
  mapUnits: {
    url: `${NE_BASE}/ne_10m_admin_0_map_units.geojson`,
    sha256: '57da82be755f4afccd8f3b14251bb2752f5df1395f47d2d86f817470c4a48862',
  },
  admin1: {
    url: `${NE_BASE}/ne_10m_admin_1_states_provinces.geojson`,
    sha256: '22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5',
  },
  places: {
    url: `${NE_BASE}/ne_10m_populated_places_simple.geojson`,
    sha256: 'fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f',
  },
  counties: {
    url: 'https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_county_5m.zip',
    sha256: 'faec522080681e79be5be435c981009a77891206ff8a7f1d142f3bf5da9ebd74',
  },
});

/**
 * Pack parameters. The Douglas-Peucker tolerance scales with the unit's size
 * (`toleranceFactor` × √area, clamped to `[minToleranceDeg, maxToleranceDeg]`)
 * because a unit is viewed at a zoom that fits it: Texas keeps ~2 km detail,
 * Bavaria ~1 km, Travis County ~150 m. Parts smaller than `minPartKm2` or than
 * `minPartShare` of the largest part are dropped (the largest part always
 * stays); holes under `minHoleKm2` are dropped.
 */
export const PARAMS = Object.freeze({
  countries: {
    toleranceFactor: 0.004,
    minToleranceDeg: 0.005,
    maxToleranceDeg: 0.02,
    decimals: 3,
    minPartKm2: 20,
    minPartShare: 0.00003,
    minHoleKm2: 20,
  },
  admin1: {
    toleranceFactor: 0.004,
    minToleranceDeg: 0.005,
    maxToleranceDeg: 0.02,
    decimals: 3,
    minPartKm2: 20,
    minPartShare: 0.0003,
    minHoleKm2: 20,
  },
  counties: {
    toleranceFactor: 0.003,
    minToleranceDeg: 0.0005,
    maxToleranceDeg: 0.01,
    decimals: 4,
    minPartKm2: 1,
    minPartShare: 0.001,
    minHoleKm2: 1,
  },
  // A bare admin-1 name is marked ambiguous — the resolver then lets a
  // geocoder decide — when it is also a country, the name of a city of at
  // least `insideMinPopulation` inside the unit's box ("New York", "Madrid"),
  // or the name of a city of at least `elsewhereMinPopulation` outside it
  // ("Santa Fe", "Victoria"). A unit no larger than `cityStateMaxKm2` whose
  // own city lies inside is the city itself (Berlin, Vienna, Paris): it is
  // marked `cityState` and may be named alone however small.
  ambiguity: {
    insideMinPopulation: 200_000,
    elsewhereMinPopulation: 50_000,
    cityStateMaxKm2: 1_000,
  },
  // A unit's population from the Wikidata snapshot is carried into the
  // states pack when its point in time is `minYear` or later (an older
  // census says little about today's share of the country) or has no date.
  population: { minYear: 1990 },
});

/**
 * The Wikidata snapshot: the population (P1082) of every state and province,
 * asked of the SPARQL service by the unit's Wikidata item (Natural Earth's
 * `wikidataid`) when that item is the unit's alone, else by its ISO 3166-2
 * code (P300) when that code is the unit's alone, else by its name among its
 * country's units with a population (a unit sharing item and code with
 * another is Natural Earth's split polygon or slip; the rest of the keyless
 * are its units without an item, or with one Wikidata holds no figure for).
 * An item the query service has no triples for at all (British Columbia and
 * Prince Edward Island in November 2026) is asked of the Wikidata API; an
 * item without a population that one item replaced one for one (Turin's
 * province, now its metropolitan city) takes that successor's; a unit whose
 * item was replaced by several, some not drawn by Natural Earth (the old
 * Kasaï-Oriental, split in three), or is dissolved with no successor known
 * (Moyen-Cavally) is not asked by name, what bears its name now not being
 * the unit drawn (Oman's Ash Sharqiyah, drawn as North and South, is). By
 * name, a
 * candidate must be of the unit's kind and level and no bare settlement, not
 * a unit inside a unit of the level, and not an item that holds another of
 * the country's units drawn apart from it (Lima's department, with Lima
 * Province beside it); labels are read in the countries' own languages and
 * the language-neutral "mul"; when two units name one item, GeoNames' name
 * for the polygon says which is the unit and which a mislabelled neighbour.
 * The best-ranked statement with the latest point in time (P585) wins;
 * among those on the same date, the larger; a count that moves by half or
 * more within five years against the item's recent figures gives way to the
 * last figure before the jump (POPULATION_JUMP: Vietnam's merged provinces,
 * Cebu's count swapped with Bohol's). A unit without a figure is left to the
 * server's share-out.
 */
export const POPULATION_PACK =
  'src/data/local_data/natural_earth/admin1_population.json';
export const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
export const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const WIKIDATA_USER_AGENT =
  'GodsEyeViewCanada/0.2 (https://github.com/AiCanada/Gods-Eye-View-Canada; scripts/build-admin-packs.mjs)';
const WIKIDATA_BATCH = 250;
const WIKIDATA_API_BATCH = 50;
const WIKIDATA_PAUSE_MS = 1_000;
const WIKIDATA_TRIES = 4;
/**
 * A population that moves by `factor` or more (either way) against the
 * median of the item's dated figures of the `memory` years before, when the
 * figure before it is within `years`, is a count of other bounds or another
 * place (bestPopulation).
 */
export const POPULATION_JUMP = Object.freeze({
  factor: 1.5,
  years: 5,
  memory: 15,
});

const args = process.argv.slice(2);
const cacheDir = path.resolve(
  args.includes('--cache')
    ? args[args.indexOf('--cache') + 1]
    : path.join(os.tmpdir(), 'gev-admin-packs'),
);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

export async function fetchPinned(name, source = SOURCES[name]) {
  const { url, sha256 } = source;
  const file = path.join(cacheDir, path.basename(new URL(url).pathname));
  let bytes = await readFile(file).catch(() => null);
  if (!bytes) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, bytes);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256)
    throw new Error(
      `${name}: SHA-256 ${digest} does not match the pinned ${sha256}`,
    );
  return { bytes, digest };
}

// ── geometry ────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** Spherical ring area (km²); matches src/data/naturalEarthRegions.js. */
export function ringAreaKm2(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % n];
    sum +=
      toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/** Signed planar (shoelace) area: positive counter-clockwise in lon/lat. */
export function signedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return sum / 2;
}

function segDist(p, a, b) {
  let [x, y] = p;
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x -= x2;
      y -= y2;
      return Math.hypot(x, y);
    }
    if (t > 0) {
      x -= x1 + dx * t;
      y -= y1 + dy * t;
      return Math.hypot(x, y);
    }
  }
  return Math.hypot(x - x1, y - y1);
}

/** Iterative Douglas-Peucker over an open point list. */
function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDist(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tolerance && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Simplify a closed ring to an OPEN rounded ring. The ring is split at its
 * farthest vertex from the start so Douglas-Peucker has two anchored halves
 * (a closed ring has no chord to measure against). Returns null when fewer
 * than `minVertices` distinct vertices survive (four by default; a pack that
 * keeps triangles passes three).
 */
function simplifyRing(ring, tolerance, decimals, minVertices = 4) {
  let open = ring.slice();
  const first = open[0];
  const last = open[open.length - 1];
  if (open.length > 1 && first[0] === last[0] && first[1] === last[1])
    open = open.slice(0, -1);
  if (open.length < minVertices) return null;
  let far = 1;
  let farDist = -1;
  for (let i = 1; i < open.length; i++) {
    const d = Math.hypot(open[i][0] - first[0], open[i][1] - first[1]);
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  const a = douglasPeucker(open.slice(0, far + 1), tolerance);
  const b = douglasPeucker([...open.slice(far), first], tolerance);
  const simplified = [...a, ...b.slice(1, -1)];
  const factor = 10 ** decimals;
  const out = [];
  for (const [lon, lat] of simplified) {
    const p = [
      Math.round(lon * factor) / factor,
      Math.round(lat * factor) / factor,
    ];
    const prev = out[out.length - 1];
    if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
    out.push(p);
  }
  while (
    out.length > 1 &&
    out[0][0] === out[out.length - 1][0] &&
    out[0][1] === out[out.length - 1][1]
  )
    out.pop();
  return out.length >= minVertices ? out : null;
}

/**
 * Simplify polygons ([outer, ...holes][]): drop parts and holes under the
 * area floors (the largest part always stays), orient outers
 * counter-clockwise and holes clockwise, sort parts by area descending.
 */
export function simplifyPolygons(polygons, params, tolerance, decimals) {
  const minVertices = params.minRingVertices ?? 4;
  const parts = [];
  for (const poly of polygons) {
    const outer = simplifyRing(poly[0], tolerance, decimals, minVertices);
    if (!outer) continue;
    const area = ringAreaKm2(outer);
    if (signedArea(outer) < 0) outer.reverse();
    const holes = [];
    for (const hole of poly.slice(1)) {
      const ring = simplifyRing(hole, tolerance, decimals, minVertices);
      if (!ring || ringAreaKm2(ring) < params.minHoleKm2) continue;
      if (signedArea(ring) > 0) ring.reverse();
      holes.push(ring);
    }
    parts.push({ rings: [outer, ...holes], area });
  }
  parts.sort((x, y) => y.area - x.area);
  const floor = Math.max(
    params.minPartKm2,
    (parts[0]?.area || 0) * params.minPartShare,
  );
  return parts
    .filter((part, index) => index === 0 || part.area >= floor)
    .map((part) => part.rings);
}

/**
 * Simplify one unit at its size-scaled tolerance. A unit too small to
 * survive the pack precision (a Maldives atoll) is kept at one more decimal
 * and a fifth of the minimum tolerance, or failing that unsimplified at two
 * more decimals; the caller records `d`.
 */
export function unitTolerance(polygons, params) {
  const sourceArea = polygons.reduce(
    (sum, poly) => sum + ringAreaKm2(poly[0]),
    0,
  );
  return Math.min(
    params.maxToleranceDeg,
    Math.max(
      params.minToleranceDeg,
      (params.toleranceFactor * Math.sqrt(sourceArea)) / 111.32,
    ),
  );
}

export function simplifyUnit(polygons, params) {
  const tolerance = unitTolerance(polygons, params);
  const coarse = simplifyPolygons(polygons, params, tolerance, params.decimals);
  if (coarse.length) return { polygons: coarse, decimals: params.decimals };
  const fine = simplifyPolygons(
    polygons,
    params,
    params.minToleranceDeg / 5,
    params.decimals + 1,
  );
  if (fine.length) return { polygons: fine, decimals: params.decimals + 1 };
  // Smaller still (Vatican City): the source ring as drawn.
  const exact = simplifyPolygons(polygons, params, 0, params.decimals + 2);
  return { polygons: exact, decimals: params.decimals + 2 };
}

/**
 * Encode a rounded open ring as integers in units of 10^-decimals degrees:
 * the first vertex absolute, every later vertex as a delta from the previous
 * one — [lon0, lat0, dLon1, dLat1, …]. Decoded by `decodeRing` in
 * src/data/adminBoundaries.js.
 */
function encodeRing(ring, decimals) {
  const factor = 10 ** decimals;
  const out = [];
  let px = 0;
  let py = 0;
  for (const [lon, lat] of ring) {
    const x = Math.round(lon * factor);
    const y = Math.round(lat * factor);
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out;
}

export function encodeUnit({ polygons, decimals }) {
  return polygons.map((poly) => poly.map((ring) => encodeRing(ring, decimals)));
}

function geojsonPolygons(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function bboxOf(polygons) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of polygons)
    for (const [lon, lat] of poly[0]) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  return [w, s, e, n];
}

// ── zip / shapefile / dbf ───────────────────────────────────────────────

/** Read named entries from a zip archive (stored or deflated). */
export function unzip(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('zip: bad central directory entry');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataStart =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(dataStart, dataStart + compressed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`zip: unsupported method ${method} for ${name}`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Polygon records (shape type 5) as arrays of closed [lon, lat] rings. */
export function readShp(buffer) {
  const shapes = [];
  let offset = 100;
  while (offset < buffer.length) {
    const length = buffer.readInt32BE(offset + 4) * 2;
    const content = offset + 8;
    const type = buffer.readInt32LE(content);
    const rings = [];
    if (type === 5) {
      const numParts = buffer.readInt32LE(content + 36);
      const numPoints = buffer.readInt32LE(content + 40);
      const partsAt = content + 44;
      const pointsAt = partsAt + numParts * 4;
      for (let p = 0; p < numParts; p++) {
        const start = buffer.readInt32LE(partsAt + p * 4);
        const end =
          p + 1 < numParts
            ? buffer.readInt32LE(partsAt + (p + 1) * 4)
            : numPoints;
        const ring = [];
        for (let i = start; i < end; i++)
          ring.push([
            buffer.readDoubleLE(pointsAt + i * 16),
            buffer.readDoubleLE(pointsAt + i * 16 + 8),
          ]);
        rings.push(ring);
      }
    } else if (type !== 0) {
      throw new Error(`shp: unsupported shape type ${type}`);
    }
    shapes.push(rings);
    offset = content + length;
  }
  return shapes;
}

/** dBASE records as plain objects (character and numeric fields). */
export function readDbf(buffer) {
  const count = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  for (let at = 32; buffer[at] !== 0x0d; at += 32) {
    fields.push({
      name: buffer.toString('latin1', at, at + 11).replace(/\0.*$/, ''),
      length: buffer[at + 16],
    });
  }
  const records = [];
  for (let r = 0; r < count; r++) {
    let at = headerLength + r * recordLength + 1;
    const record = {};
    for (const field of fields) {
      record[field.name] = buffer
        .toString('utf8', at, at + field.length)
        .trim();
      at += field.length;
    }
    records.push(record);
  }
  return records;
}

/** Group shapefile rings into polygons: clockwise outers, holes assigned by containment. */
export function shpPolygons(rings) {
  const outers = [];
  const holes = [];
  for (const ring of rings) {
    if (ring.length < 4) continue;
    (signedArea(ring) < 0 ? outers : holes).push(ring);
  }
  const polygons = outers.map((outer) => [outer]);
  for (const hole of holes) {
    const [x, y] = hole[0];
    const owner = polygons.find(([outer]) => pointInRing(outer, x, y));
    if (owner) owner.push(hole);
    else polygons.push([hole.slice().reverse()]);
  }
  return polygons;
}

export function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// ── packs ────────────────────────────────────────────────────────────────

const LATIN = /^[\p{Script=Latin}\p{N}\s.,'’()\-/&]+$/u;

function uniqueNames(values, exclude) {
  const seen = new Set(exclude.map(normalizeAdminName));
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    const key = normalizeAdminName(text);
    if (!text || !key || seen.has(key) || !LATIN.test(text)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

async function buildCountries() {
  const source = await fetchPinned('countries');
  const mapUnits = await fetchPinned('mapUnits');
  const params = PARAMS.countries;
  const features = [];
  for (const { properties: p, geometry } of JSON.parse(source.bytes).features) {
    const unit = simplifyUnit(geojsonPolygons(geometry), params);
    if (!unit.polygons.length) continue;
    const name = p.ADMIN || p.NAME_EN || p.NAME;
    features.push({
      name,
      alt: uniqueNames(
        [p.NAME, p.NAME_LONG, p.NAME_EN, p.FORMAL_EN, p.BRK_NAME].filter(
          Boolean,
        ),
        [name],
      ),
      country: name,
      iso: p.ADM0_A3,
      iso2: p.ISO_A2_EH || p.ISO_A2,
      type: 'Country',
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  }
  for (const { properties: p, geometry } of JSON.parse(mapUnits.bytes)
    .features) {
    if (p.ADM0_A3 !== 'GBR') continue;
    const unit = simplifyUnit(geojsonPolygons(geometry), params);
    features.push({
      name: p.GEOUNIT,
      country: p.ADMIN,
      iso: p.GU_A3,
      iso2: 'GB',
      type: 'Constituent country',
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  }
  features.sort((a, b) => a.name.localeCompare(b.name));
  return {
    meta: {
      title: 'Natural Earth admin-0 countries',
      mapUnits: SOURCES.mapUnits,
      source: 'ne_10m_admin_0_countries',
      url: SOURCES.countries.url,
      sha256: source.digest,
      commit: NE_COMMIT,
      license:
        'Public domain (https://www.naturalearthdata.com/about/terms-of-use/)',
      decimals: params.decimals,
      curation: params,
      script: 'scripts/build-admin-packs.mjs',
    },
    features,
  };
}

/**
 * The larger region a unit sits in, for figures a source gives that region
 * and not the unit (the GLOBAL ABUNDANCE MAP's OECD regions): Natural
 * Earth's `region` (a French région for a département, an Italian regione
 * for a province, a Japanese region for a prefecture). The United Kingdom's
 * units take their constituent country (Scotland, Wales, Northern Ireland)
 * and, in England, the English region, with Natural Earth's two spellings
 * of the East of England and Greater London written one way.
 */
const ENGLAND_REGIONS = Object.freeze({
  east: 'East of England',
  eastern: 'East of England',
  'greater london': 'London',
});
export function admin1Group(p) {
  const region = String(p.region || '').trim();
  if (p.iso_a2 === 'GB') {
    const part = String(p.geonunit || '').trim();
    if (['Scotland', 'Wales', 'Northern Ireland'].includes(part)) return part;
    return ENGLAND_REGIONS[region.toLowerCase()] || region || null;
  }
  return region || null;
}

// ── the states' and provinces' people (Wikidata) ────────────────────────

/**
 * The keys each unit's population is asked by, aligned with `properties`
 * (Natural Earth's admin-1 feature properties): `item`, its Wikidata item,
 * when no other named unit carries it, and `code`, its ISO 3166-2 code,
 * when no other named unit carries that; null for a key shared or missing.
 * The item is asked first, the code when the item has no figure (Natural
 * Earth's Mount Athos is the mountain, its code GR-69 the monastic
 * community). Unnamed units are not in the pack and count for nothing.
 */
export function admin1PopulationKeys(properties) {
  const items = new Map();
  const codes = new Map();
  const rows = properties.map((p) => {
    const name = String(p.name || '').trim();
    const item = /^Q\d+$/.test(p.wikidataid || '') ? p.wikidataid : null;
    const code =
      p.iso_3166_2 && !String(p.iso_3166_2).includes('~') ? p.iso_3166_2 : null;
    if (name) {
      if (item) items.set(item, (items.get(item) || 0) + 1);
      if (code) codes.set(code, (codes.get(code) || 0) + 1);
    }
    return { name, item, code };
  });
  return rows.map(({ name, item, code }) => ({
    item: name && item && items.get(item) === 1 ? item : null,
    code: name && code && codes.get(code) === 1 ? code : null,
  }));
}

/** The year of a Wikidata point in time ("2011-01-01T00:00:00Z"); null without one. */
function yearOf(when) {
  const match = /^(-?\d+)-/.exec(String(when || ''));
  return match ? Number(match[1]) : null;
}

/** Whether a statement's rank (the API's word or the query service's URI) is preferred. */
const isPreferred = (rank) => /preferred/i.test(String(rank || ''));

/** The latest of some parsed statements: the latest year, dated before undated, the larger on the same date. */
function latestOf(list) {
  let best = null;
  for (const s of list)
    if (
      !best ||
      (s.year ?? -Infinity) > (best.year ?? -Infinity) ||
      (s.year === best.year && s.pop > best.pop)
    )
      best = s;
  return best;
}

/**
 * The figure to keep among a unit's population statements ({pop, when?,
 * item?, rank?} rows, every statement but the deprecated): of the best-ranked
 * (the preferred when there are any, else the normal), the latest point in
 * time, a dated statement before an undated one, and among those on the
 * same date the larger. Null with none usable.
 *
 * A count that moves by half or more against the item's recent figures
 * within POPULATION_JUMP.years is not a count of the same place: the unit's
 * bounds moved (Vietnam's provinces merged in 2025 and the merged counts sit
 * on the old items), or the figure is another's (Cebu's and Bohol's 2024
 * counts are swapped on Wikidata, Kuala Lumpur's 2025 figure is its metro
 * area's). The latest figure from before the jump stands instead, for the
 * polygon as Natural Earth drew it, and the row says what it stands in for
 * (`instead: {pop, year, ratio}`). The reference is the median of the dated
 * figures of the POPULATION_JUMP.memory years before; a ten-year census gap
 * that doubles is left alone, as are a reference of zero and the tiny.
 */
export function bestPopulation(rows) {
  const parsed = [];
  for (const row of rows || []) {
    const pop = Math.round(Number(row.pop));
    if (!Number.isFinite(pop) || pop < 0) continue;
    parsed.push({
      pop,
      year: yearOf(row.when),
      item: row.item || null,
      preferred: isPreferred(row.rank),
    });
  }
  if (!parsed.length) return null;
  const ranked = parsed.some((s) => s.preferred)
    ? parsed.filter((s) => s.preferred)
    : parsed;
  const best = latestOf(ranked);
  const out = { pop: best.pop, year: best.year, item: best.item };
  if (best.year === null) return out;
  const earlier = parsed.filter((s) => s.year !== null && s.year < best.year);
  const near = earlier.filter(
    (s) => s.year >= best.year - POPULATION_JUMP.years,
  );
  if (!near.length) return out;
  const memory = earlier
    .filter((s) => s.year >= best.year - POPULATION_JUMP.memory)
    .map((s) => s.pop)
    .sort((a, b) => a - b);
  const median =
    memory.length % 2
      ? memory[(memory.length - 1) / 2]
      : (memory[memory.length / 2 - 1] + memory[memory.length / 2]) / 2;
  if (!(median > 0)) return out;
  const ratio = best.pop / median;
  if (ratio < POPULATION_JUMP.factor && ratio > 1 / POPULATION_JUMP.factor)
    return out;
  const before = latestOf(earlier);
  return {
    pop: before.pop,
    year: before.year,
    item: before.item,
    instead: { pop: best.pop, year: best.year, ratio },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const entityId = (uri) => String(uri || '').replace(/^.*\//, '');

/**
 * One Wikidata request's JSON body; asked again after a refusal, a failure
 * or an answer cut short, waiting longer each time (and as long as the
 * service asks), the client named in every request.
 */
async function wikidataJson(url, init = {}) {
  let pause = WIKIDATA_PAUSE_MS;
  for (let attempt = 1; ; attempt++) {
    let response = null;
    let failure = null;
    try {
      response = await fetch(url, {
        ...init,
        headers: { ...(init.headers || {}), 'user-agent': WIKIDATA_USER_AGENT },
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) return await response.json();
    } catch (error) {
      failure = error;
    }
    if (attempt >= WIKIDATA_TRIES) {
      if (failure) throw failure;
      throw new Error(`Wikidata: HTTP ${response.status} for the query`);
    }
    const retryAfter = Number(response?.headers?.get('retry-after'));
    pause = Math.max(
      pause * 2,
      Number.isFinite(retryAfter) ? retryAfter * 1000 : 0,
    );
    const why = !response
      ? 'no answer'
      : response.ok
        ? 'an answer cut short'
        : `HTTP ${response.status}`;
    console.log(`Wikidata: ${why}, asking again in ${pause / 1000} s`);
    await sleep(pause);
  }
}

/** One SPARQL query's rows as plain values. */
async function sparql(query) {
  const { results } = await wikidataJson(WIKIDATA_SPARQL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/sparql-results+json',
    },
    body: new URLSearchParams({ query }),
  });
  return results.bindings.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value.value]),
    ),
  );
}

/** The entities the Wikidata API holds for `ids` (their claims), as {id: entity}. */
async function wikidataEntities(ids) {
  const { entities } = await wikidataJson(
    `${WIKIDATA_API}?${new URLSearchParams({
      action: 'wbgetentities',
      ids: ids.join('|'),
      props: 'claims',
      format: 'json',
    })}`,
    { headers: { accept: 'application/json' } },
  );
  return entities || {};
}

/**
 * An entity's population rows ({item, pop, when, codes, rank}) from the
 * Wikidata API's claims, every statement but the deprecated, as the query
 * service would write them (bestPopulation ranks them): `when` the point in
 * time (P585) qualifier, `codes` the item's ISO 3166-2 codes (P300) joined
 * by "|", `rank` the statement's. For the items the service has no triples
 * for.
 */
export function populationRows(entity, item = entity?.id) {
  const claims = (entity?.claims?.P1082 || []).filter(
    (c) => c.rank !== 'deprecated',
  );
  const codes = (entity?.claims?.P300 || [])
    .filter((c) => c.rank !== 'deprecated')
    .map((c) => c.mainsnak?.datavalue?.value)
    .filter((code) => typeof code === 'string')
    .join('|');
  return claims.flatMap((c) => {
    const amount = c.mainsnak?.datavalue?.value?.amount;
    if (amount === undefined) return [];
    const when = c.qualifiers?.P585?.[0]?.datavalue?.value?.time;
    return [
      {
        item,
        pop: String(amount).replace(/^\+/, ''),
        when: when ? String(when).replace(/^\+/, '') : undefined,
        codes,
        rank: c.rank || 'normal',
      },
    ];
  });
}

// ── the units asked by name ──────────────────────────────────────────────

/**
 * The words an administrative name may carry that a label may not, or the
 * other way round ("Region", "Province of", "Metropolitan City of",
 * "Provincia di"), folded away for a loose match.
 */
const ADMIN_WORDS =
  /\b(region\w*|provinc\w*|district\w*|municipalit\w*|municipal|county|counties|metropolitan|city|prefecture|departe?ment\w*|governorate|state|territory|parish|division|zone|area|autonomous|special|administrative|federal|capital|commune|canton|oblast|raion|of|the|de|du|des|di|del|della|delle|degli|da|do|dos|das|la|le|el|los|las|and|y|et|e)\b/g;
/**
 * The same words as the countries write them, in GeoNames' names and
 * Wikidata's local labels ("Rēzeknes novads", "Opština Zvečan", "Sha`biyat
 * al Wahat", "Muhafazat Mubarak al Kabir", "Provincia de Lima"), and the
 * Arabic article as it is transliterated ("Al Marj", "Marj District").
 */
const LOCAL_ADMIN_WORDS =
  /\b(al|el|ash|ad|adh|an|ar|as|at|ath|az|rajons?|rajona|novads|novada|pagasts|opstin[aey]|opcin[aey]|obcin[aey]|okres|powiat|kraj|judet(ul)?|voivodeship|zupanija|uyezd|gmina|comuna|concelho|freguesia|distrito|departamentos?|gouvernorat|m[ou]hafazah?|m[ou]hafazat|wilaya[ht]?|velayat|vilayet(i)?|viloyat(i)?|welayat|sha biyat|shabiyat|baladiya[ht]?|baladiyat|mintaqa[ht]|qada|kaza|nahiya[h]?|amphoe|changwat|kabupaten|kota|lalawigan|probinsi?ya|lungsod|tinh|thanh pho|cercle|arrondissement|comarca|partido|parroquia|kommune?|kunta|komun[ae]|qarku|rrethi|rayonu?|raioni|oblys[y]?|aimag|aymag|dzongkhag|zilla?|jela|jilla|tehsil|taluka?|mandal|upazila|sous|prefeitura|provincie|provinz|regierungsbezirk|bezirk|landkreis|kreis|amt|regione|provincia|dipartimento|circondario|contea|comune|municipio|municipalidad|cantone|estado|gobernacion|intendencia|departement)\b/g;
export function looseAdminName(text) {
  return normalizeAdminName(text)
    .replace(ADMIN_WORDS, ' ')
    .replace(LOCAL_ADMIN_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
/** A label that names an administrative unit rather than a bare place. */
const GENERIC_LABEL =
  /\b(region\w*|provinc\w*|district\w*|municipalit\w*|county|metropolitan|prefecture|departe?ment\w*|governorate|state|territory|parish|division|zone|area|atoll|commune|canton|oblast|raion|comarca|wilaya|kabupaten)\b/i;
/**
 * A unit whose own kind is a city (Natural Earth's type: "Highly Urbanized
 * City", "Republican City", "Town"): a bare label fits it. A municipality is
 * not one: it is the unit around a town of the same name, and the town's
 * figure is not its own. Italy's metropolitan cities are provinces.
 */
const CITY_TYPE = /\b(city|town|borough)\b/i;
export function admin1IsCity(type) {
  const text = String(type || '');
  return CITY_TYPE.test(text) && !/metropolitan/i.test(text);
}
/**
 * Whether an item's classes (its P31 labels in English: "city", "big city",
 * "highly urbanized city", "town") make it a city rather than an
 * administrative unit; "municipalities and cities of Serbia" and
 * "metropolitan city of Italy" do not.
 */
const CITY_CLASS = /\b(city|town|borough)\b/i;
export function classIsCity(labels) {
  return (labels || []).some(
    (l) => CITY_CLASS.test(l) && !/metropolitan/i.test(l),
  );
}
/**
 * Whether an item's classes make it a bare settlement and nothing more (a
 * hamlet, a village, a locality, a quarter: every class a place to live,
 * none an administrative unit): Åland's Brändö is a municipality, and a
 * village of that name in it is not the municipality. "Human settlement"
 * beside "district of Hong Kong" leaves the district a district.
 */
const SETTLEMENT_CLASS =
  /\b(city|town|borough|village|hamlet|settlement|locality|neighbou?rhood|quarter|suburb|urban area|populated place|census-designated place)\b/i;
export function classIsSettlementOnly(labels) {
  const list = labels || [];
  return list.length > 0 && list.every((l) => SETTLEMENT_CLASS.test(l));
}
/**
 * Whether an item keyed to a unit of a city kind is plainly a larger unit
 * instead (a region, province, prefecture, state, department or
 * governorate by its classes, and no city): Natural Earth's Manila carries
 * Metro Manila's id, its Cebu city its province's. Classes that say
 * nothing either way ("human settlement", "atoll of the Maldives",
 * "first-level administrative division") leave the key as it is.
 */
const LARGER_UNIT_CLASS =
  /\b(region|province|prefecture|state|department|governorate)\b/i;
export function cityItemMisplaced(labels) {
  const list = labels || [];
  return (
    list.length > 0 &&
    !classIsCity(list) &&
    list.some((l) => LARGER_UNIT_CLASS.test(l))
  );
}

/**
 * The spellings a unit may be labelled by: Natural Earth's name, English
 * name, local name and GeoNames name, each alone and with the unit's kind
 * ("Lima Region", "Province of Turin"). Its alternate names and Yahoo name
 * are left out: for many units they name the region above (Rimini's say
 * "Emilia Romagna", a Guinean prefecture's "Labé"), whose figure is not the
 * unit's.
 */
export function admin1NameVariants(p) {
  const type = String(p.type_en || p.type || '').trim();
  const names = [p.name, p.name_en, p.name_local, p.gn_name]
    .map((n) => String(n || '').trim())
    .filter(Boolean);
  const out = new Set();
  for (const n of names) {
    out.add(n);
    if (type) {
      out.add(`${n} ${type}`);
      out.add(`${type} of ${n}`);
    }
  }
  return [...out];
}
/**
 * The spellings among `admin1NameVariants(p)` that GeoNames' name alone
 * gives (normalized), for `matchUnitByName`'s `secondary`.
 */
export function admin1SecondaryVariants(p) {
  const own = new Set(
    admin1NameVariants({ ...p, gn_name: null }).map(normalizeAdminName),
  );
  return admin1NameVariants(p)
    .map(normalizeAdminName)
    .filter((v) => v && !own.has(v));
}

/**
 * Whether a candidate may stand for a unit at all, whatever its labels: of
 * the unit's own kind when Natural Earth names one (a city for a city, an
 * administrative unit for the rest, read off the candidate's classes), and,
 * for the administrative units (cities are not nested as regions are): no
 * bare settlement (a village or hamlet of the unit's name is not the unit);
 * not a unit inside a unit of the level (a candidate whose parent is of a
 * class the country's keyed units of the unit's kind have is a step below
 * them: Libya's Ajdabiya, a municipality in the Al Wahat district, for the
 * district drawn as Ajdabiya); and at the units' level: of a class the
 * country's keyed units of that kind have (else any keyed unit of the
 * country has), or, with none keyed, of a class with members enough in the
 * country for the units of that kind and not three times too many (four
 * fifths of them at least; Kosovo's thirty units are its municipalities,
 * not its seven districts nor its fourteen hundred villages). A candidate
 * of no known class is never admitted. The context: `peerClasses` (a Set,
 * or null with no keyed unit), `sameKindPeerClasses` (the classes of the
 * keyed units of the unit's own kind alone, or null), `classCounts`
 * (class → items of it in the country), `unitsOfKind` (the country's units
 * of the unit's kind), `peerClassShares` (class → share of the keyed units
 * of the kind carrying it), `levelless`, `contested` (a Set of items no
 * unit could take). The candidate: `classes`, `classLabels`, `unitClasses` (the
 * classes that are no city), `parentUnits` ({id, classes} of the units it
 * is located in).
 */
export function admissibleUnit(unit, candidate, context) {
  const classes = candidate.classes || [];
  if (!classes.length) return false;
  const labels = candidate.classLabels || [];
  const cityLike = classIsCity(labels);
  if (unit.city) return !unit.type || cityLike;
  // A city that is also a unit of the level (The Valley, Anguilla's capital
  // and one of its fourteen districts) stands for the unit by its unit
  // class; a bare city does not.
  const atLevel = (ids) => {
    const peers = context?.peerClasses;
    // Of a class most of the keyed units of the kind carry
    // (`peerClassShares`), not of a stray one: Italy's provinces are
    // "province of Italy", and one keyed to a comune does not make every
    // capital comune a province. Without the shares, any peer class.
    const shares = context?.peerClassShares;
    if (peers?.size)
      return ids.some((c) =>
        shares ? (shares.get(c) || 0) >= 0.5 : peers.has(c),
      );
    // A country with no keyed unit and no unit located in it on Wikidata
    // (the Cook Islands' islands carry a country alone) has no level to hold
    // a candidate to: its units' names found what there is.
    if (context?.levelless) return ids.length > 0;
    const units = context?.unitsOfKind || 0;
    return ids.some((c) => {
      const n = context?.classCounts?.get(c) || 0;
      return n >= 0.8 * units && n <= 3 * units;
    });
  };
  if (unit.type && cityLike) {
    const unitClasses = candidate.unitClasses || [];
    return unitClasses.length > 0 && atLevel(unitClasses);
  }
  if (classIsSettlementOnly(labels)) return false;
  // A unit inside a unit of the level is a step below it, unless that
  // parent is an item the unit was just denied for naming it with another
  // (`contested`): Natural Earth's North and South Tipperary both name
  // County Tipperary, and each is then the riding inside it.
  const sameKind = context?.sameKindPeerClasses;
  const contested = context?.contested;
  if (
    sameKind?.size &&
    (candidate.parentUnits || []).some(
      (parent) =>
        !contested?.has(parent.id) &&
        (parent.classes || []).some((c) => sameKind.has(c)),
    )
  )
    return false;
  return atLevel(classes);
}

/**
 * Whether Natural Earth's names for a unit agree with GeoNames' name for
 * the polygon (`gn_name`, the words of the kind folded away; true with
 * none). Natural Earth labels a few polygons with a neighbour's name, and
 * GeoNames tells: its second "Parwan" is Panjshir, its second "Uruzgan"
 * Daykundi, its second "Mbarara" Kiruhura. When two units name one item,
 * the one GeoNames agrees with takes it.
 */
export function nameAgreesWithGeoNames(p) {
  const gn = looseAdminName(p.gn_name || '');
  if (!gn) return true;
  return [p.name, p.name_en, p.name_local].some((n) => {
    const own = looseAdminName(n || '');
    return own && (own === gn || gn.includes(own) || own.includes(gn));
  });
}

/**
 * The candidate a unit's names pick among its country's units on Wikidata
 * ({item, labels, direct, classes, classLabels}; with a `context`, only
 * those `admissibleUnit` admits): an exact label beats a loose one (the
 * administrative words folded away), an exact label that names the kind
 * ("Lima Province") beats a bare one ("Lima", which a region, a province
 * and a city all answer to), a label of the unit's own kind (an
 * administrative word for a region, a bare name for a city) beats one of
 * the other, and a unit directly in the country beats one a step down.
 * Null with no match or a tie at the top.
 */
export function matchUnitByName(unit, candidates, context = null) {
  const exact = new Set(
    (unit.variants || []).map(normalizeAdminName).filter(Boolean),
  );
  const loose = new Set(
    (unit.variants || []).map(looseAdminName).filter(Boolean),
  );
  // The spellings that come from GeoNames alone (normalized): an exact hit
  // on one of them weighs a little less than one on Natural Earth's own
  // names, as GeoNames' name is now and then a neighbour's (Malabon's says
  // Caloocan City; Malabon is Malabon first).
  const secondary = new Set(unit.secondary || []);
  let best = null;
  let bestScore = 0;
  let tie = false;
  for (const c of candidates || []) {
    if (context && !admissibleUnit(unit, c, context)) continue;
    const labels = c.labels || [];
    const exactLabels = labels.filter((l) => exact.has(normalizeAdminName(l)));
    const hitExact = exactLabels.length > 0;
    const hitLoose =
      hitExact || labels.some((l) => loose.has(looseAdminName(l)));
    if (!hitLoose) continue;
    const generic = labels.some((l) => GENERIC_LABEL.test(l));
    const ownExact = exactLabels.some(
      (l) => !secondary.has(normalizeAdminName(l)),
    );
    let score = hitExact ? (ownExact ? 3 : 2.5) : 1;
    if (exactLabels.some((l) => GENERIC_LABEL.test(l))) score += 1;
    if (generic !== Boolean(unit.city)) score += 2;
    if (c.direct) score += 0.5;
    if (score > bestScore) {
      best = c;
      bestScore = score;
      tie = false;
    } else if (score === bestScore) tie = true;
  }
  return best && !tie ? best : null;
}

/**
 * The languages a candidate's labels and aliases are read in: English, the
 * language-neutral "mul" label many items carry alone since 2024 (Cebu's
 * only label is "Cebu"@mul), and the languages of the countries with units
 * asked by name, whose own spelling Natural Earth often carries ("Rēzeknes
 * novads").
 */
/** The languages the units' names are looked up in as labels (the second candidate pool). */
export const LABEL_POOL_LANGUAGES = [
  'en',
  'mul',
  'fr',
  'es',
  'pt',
  'de',
  'it',
  'nl',
  'ru',
  'ar',
  'zh',
  'id',
  'tl',
];
export const LABEL_LANGUAGES = [
  'en',
  'mul',
  'fr',
  'es',
  'pt',
  'it',
  'de',
  'nl',
  'sq',
  'id',
  'ms',
  'tl',
  'ceb',
  'sw',
  'no',
  'nb',
  'sv',
  'da',
  'fi',
  'is',
  'fo',
  'hr',
  'sr',
  'bs',
  'sl',
  'mk',
  'bg',
  'tr',
  'az',
  'ka',
  'hy',
  'kk',
  'ky',
  'uz',
  'tg',
  'tk',
  'mn',
  'pl',
  'cs',
  'sk',
  'hu',
  'ro',
  'el',
  'ru',
  'uk',
  'be',
  'lv',
  'lt',
  'et',
  'ga',
  'cy',
  'gd',
  'mt',
  'lb',
  'eu',
  'ca',
  'gl',
  'oc',
  'ar',
  'he',
  'fa',
  'ps',
  'ur',
  'ku',
  'hi',
  'bn',
  'ne',
  'si',
  'ta',
  'te',
  'ml',
  'kn',
  'mr',
  'gu',
  'pa',
  'or',
  'as',
  'dv',
  'my',
  'th',
  'lo',
  'km',
  'vi',
  'zh',
  'yue',
  'ja',
  'ko',
  'am',
  'ti',
  'so',
  'om',
  'ha',
  'yo',
  'ig',
  'ff',
  'wo',
  'bm',
  'rw',
  'rn',
  'ln',
  'kg',
  'sg',
  'mg',
  'ny',
  'sn',
  'st',
  'tn',
  'ts',
  'ss',
  'zu',
  'xh',
  'af',
  'ht',
  'sm',
  'to',
  'fj',
  'bi',
  'na',
  'mh',
  'ch',
  'gil',
  'tvl',
  'pau',
  'tpi',
  'ho',
  'ty',
  'crs',
  'kea',
  'ay',
  'qu',
  'gn',
]
  .map((code) => JSON.stringify(code))
  .join(',');

/**
 * Every population statement of ?item but the deprecated, with its rank
 * (bestPopulation ranks them and reads the jumps): ?pop, ?when, ?rank.
 */
const POPULATION_PATTERN =
  '?item p:P1082 ?statement . ?statement ps:P1082 ?pop ; wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank) OPTIONAL { ?statement pq:P585 ?when . }';

/**
 * The one item that replaced `item` (its "replaced by" items in
 * `successors`, a Set) and replaced it alone (the "replaces" items of each
 * successor in `replacedBy`, a Map of Sets); null with none, several, or a
 * successor that also replaced others (a merger: the successor's figure
 * would count other units' people).
 */
export function soleSuccessor(item, successors, replacedBy) {
  if (!successors || successors.size !== 1) return null;
  const [next] = successors;
  const replaced = replacedBy?.get(next);
  if (!replaced || replaced.size !== 1 || !replaced.has(item)) return null;
  return next;
}

/**
 * Whether an item's ISO 3166-2 codes on Wikidata ("BE-WLX|BE-WLX" as the
 * query concatenates them) put it in the unit's country (`iso2`, Natural
 * Earth's): a code under the country, or a territory's code written under
 * its parent (US-PR for Puerto Rico, whose Natural Earth code is PR); true
 * with no code or no country to compare. Natural Earth's `wikidataid`
 * sometimes names a namesake elsewhere (Belgium's Luxembourg province as
 * the Grand Duchy's canton, a Kosovo district as Serbia's whole Kosovo and
 * Metohija); its figure would be another place's.
 */
export function codesInCountry(codes, iso2) {
  const list = String(codes || '')
    .split('|')
    .filter(Boolean);
  if (!list.length || !/^[A-Z]{2}$/.test(iso2 || '')) return true;
  return list.some(
    (code) => code.startsWith(`${iso2}-`) || code.endsWith(`-${iso2}`),
  );
}

/**
 * The Wikidata snapshot (POPULATION_PACK): every unit's population by its
 * item, else by its ISO 3166-2 code, else by its name among its country's
 * units, asked in batches a second apart. An item whose own ISO 3166-2
 * codes are all another country's is set aside, as is an item that is no
 * city keyed to a unit of a city kind; both are then asked by name.
 */
async function buildAdmin1Population() {
  const source = await fetchPinned('admin1');
  const properties = JSON.parse(source.bytes.toString('utf8')).features.map(
    (f) => f.properties,
  );
  const keys = admin1PopulationKeys(properties);
  const countryOf = new Map();
  keys.forEach((key, index) => {
    if (key.item) countryOf.set(key.item, properties[index].iso_a2);
  });
  const itemIds = [...new Set(keys.map((k) => k.item).filter(Boolean))].sort();
  const byItem = new Map();
  let asked = 0;
  for (const batch of chunks(itemIds, WIKIDATA_BATCH)) {
    console.log(
      `Wikidata: items ${asked + 1}–${asked + batch.length} of ${itemIds.length}`,
    );
    const rows = await sparql(
      `SELECT ?item ?pop ?when ?rank (GROUP_CONCAT(DISTINCT ?iso; separator="|") AS ?codes) WHERE { VALUES ?item { ${batch.map((q) => `wd:${q}`).join(' ')} } ${POPULATION_PATTERN} OPTIONAL { ?item wdt:P300 ?iso . } } GROUP BY ?item ?pop ?when ?rank`,
    );
    for (const row of rows) {
      const item = entityId(row.item);
      if (!byItem.has(item)) byItem.set(item, []);
      byItem.get(item).push(row);
    }
    asked += batch.length;
    await sleep(WIKIDATA_PAUSE_MS);
  }
  // A figure that stands in for a later one that jumped (bestPopulation).
  const logInstead = (what, best) => {
    if (!best?.instead) return;
    const { pop, year, ratio } = best.instead;
    console.log(
      `Wikidata: ${what}: ${pop.toLocaleString('en-US')} (${year}) is ×${ratio.toFixed(2)} the figures before it; ${best.pop.toLocaleString('en-US')} (${best.year}) stands`,
    );
  };
  // The query service has no triples at all for a few items (British
  // Columbia, Prince Edward Island and Newport in November 2026): the items
  // it left unanswered are asked of the Wikidata API, whose claims are read
  // as the service would rank them.
  const unanswered = itemIds.filter((item) => !byItem.has(item));
  let answered = 0;
  asked = 0;
  for (const batch of chunks(unanswered, WIKIDATA_API_BATCH)) {
    console.log(
      `Wikidata: API, items ${asked + 1}–${asked + batch.length} of the ${unanswered.length} the query service left unanswered`,
    );
    const entities = await wikidataEntities(batch);
    for (const item of batch) {
      const rows = populationRows(entities[item], item);
      if (!rows.length) continue;
      byItem.set(item, rows);
      answered += 1;
    }
    asked += batch.length;
    await sleep(WIKIDATA_PAUSE_MS);
  }
  console.log(
    `Wikidata: the API holds a population for ${answered} of the ${unanswered.length} items the query service left unanswered`,
  );
  // An item without a population that one item replaced (P1366), and that
  // replaced it alone (P1365), gives its successor's figure: Natural Earth
  // keys Turin, Naples and Florence to the provinces their metropolitan
  // cities succeeded one for one. A unit merged into a larger one (Nepal's
  // zones into its provinces) is not followed.
  const orphans = itemIds.filter((item) => !bestPopulation(byItem.get(item)));
  const successorsOf = new Map();
  const replacedBy = new Map();
  // The orphans Wikidata marks dissolved (P576), successor known or not:
  // Ivory Coast's Moyen-Cavally ended in 2011 with no "replaced by", and
  // the Cavally region named for it covers three of its four departments.
  const dissolved = new Set();
  asked = 0;
  for (const batch of chunks(orphans, WIKIDATA_BATCH)) {
    console.log(
      `Wikidata: successors of items ${asked + 1}–${asked + batch.length} of the ${orphans.length} without a population`,
    );
    const rows = await sparql(
      `SELECT ?item ?next ?prev ?ended WHERE { VALUES ?item { ${batch.map((q) => `wd:${q}`).join(' ')} } OPTIONAL { ?item wdt:P1366 ?next . OPTIONAL { ?next wdt:P1365 ?prev . } } OPTIONAL { ?item wdt:P576 ?ended . } }`,
    );
    for (const row of rows) {
      const item = entityId(row.item);
      if (row.ended) dissolved.add(item);
      if (!row.next) continue;
      const next = entityId(row.next);
      if (!successorsOf.has(item)) successorsOf.set(item, new Set());
      successorsOf.get(item).add(next);
      if (row.prev) {
        if (!replacedBy.has(next)) replacedBy.set(next, new Set());
        replacedBy.get(next).add(entityId(row.prev));
      }
    }
    asked += batch.length;
    await sleep(WIKIDATA_PAUSE_MS);
  }
  const succession = new Map();
  for (const item of orphans) {
    const next = soleSuccessor(item, successorsOf.get(item), replacedBy);
    if (next) succession.set(item, next);
  }
  const bySuccessor = new Map();
  const successorIds = [...new Set(succession.values())].sort();
  for (const batch of chunks(successorIds, WIKIDATA_BATCH)) {
    const rows = await sparql(
      `SELECT ?item ?pop ?when ?rank (GROUP_CONCAT(DISTINCT ?iso; separator="|") AS ?codes) WHERE { VALUES ?item { ${batch.map((q) => `wd:${q}`).join(' ')} } ${POPULATION_PATTERN} OPTIONAL { ?item wdt:P300 ?iso . } } GROUP BY ?item ?pop ?when ?rank`,
    );
    for (const row of rows) {
      const item = entityId(row.item);
      if (!bySuccessor.has(item)) bySuccessor.set(item, []);
      bySuccessor.get(item).push(row);
    }
    await sleep(WIKIDATA_PAUSE_MS);
  }
  let succeeded = 0;
  for (const [item, next] of succession) {
    const rows = bySuccessor.get(next);
    if (!rows || !bestPopulation(rows)) {
      succession.delete(item);
      continue;
    }
    byItem.set(item, rows);
    succeeded += 1;
    console.log(
      `Wikidata: ${item} takes the figure of ${next}, which replaced it`,
    );
  }
  console.log(
    `Wikidata: ${succeeded} items without a population take their one successor's`,
  );
  const items = {};
  let setAside = 0;
  for (const item of itemIds) {
    const rows = byItem.get(item);
    const best = bestPopulation(rows);
    if (!best) continue;
    if (!codesInCountry(rows[0].codes, countryOf.get(item))) {
      setAside += 1;
      console.log(
        `Wikidata: ${item} (${rows[0].codes}) is not in ${countryOf.get(item)}; set aside`,
      );
      continue;
    }
    const via = succession.get(item);
    logInstead(item, best);
    items[item] = via ? [best.pop, best.year, via] : [best.pop, best.year];
  }
  // The Wikidata ids of each country's units, for the successors test.
  const unitIdsOf = new Map();
  for (const p of properties)
    if (String(p.name || '').trim() && /^Q\d+$/.test(p.wikidataid || '')) {
      if (!unitIdsOf.has(p.adm0_a3)) unitIdsOf.set(p.adm0_a3, new Set());
      unitIdsOf.get(p.adm0_a3).add(p.wikidataid);
    }
  // Whether a unit's own item is a unit no longer drawn as it was: replaced
  // by several, more than one of them drawn nowhere by Natural Earth (its
  // Kasaï-Oriental is the old province, split in three, Lomami and Sankuru
  // drawn nowhere), or dissolved with no successor known (Moyen-Cavally).
  // What bears its name or code now is not the unit drawn, so neither the
  // code nor the name is asked. When every other successor is a unit of the
  // country itself (Oman's Ash Sharqiyah, drawn as North and South, the
  // South under the old region's id), the polygon is the one successor
  // left, and the unit is asked.
  const replacedUnit = (item, adm0) => {
    if (!item || succession.has(item)) return false;
    const successors = successorsOf.get(item);
    if (successors?.size)
      return (
        [...successors].filter((next) => !unitIdsOf.get(adm0)?.has(next))
          .length > 1
      );
    return dissolved.has(item);
  };
  // The codes of the units their item gives no figure (none, or one
  // without a population): Natural Earth's codes are now and then another
  // unit's (Uganda's renumbered districts, Latvia's merged municipalities),
  // so a code is asked only where it is needed, and only then does its
  // item count as taken.
  const codeIds = [
    ...new Set(
      keys
        .map((k, index) =>
          k.code &&
          !(k.item && items[k.item]) &&
          !replacedUnit(k.item, properties[index].adm0_a3)
            ? k.code
            : null,
        )
        .filter(Boolean),
    ),
  ].sort();
  const byCode = new Map();
  asked = 0;
  for (const batch of chunks(codeIds, WIKIDATA_BATCH)) {
    console.log(
      `Wikidata: codes ${asked + 1}–${asked + batch.length} of ${codeIds.length}`,
    );
    const rows = await sparql(
      `SELECT ?code ?item ?pop ?when ?rank WHERE { VALUES ?code { ${batch.map((c) => JSON.stringify(c)).join(' ')} } ?item wdt:P300 ?code . ${POPULATION_PATTERN} }`,
    );
    for (const row of rows) {
      if (!byCode.has(row.code)) byCode.set(row.code, []);
      byCode.get(row.code).push({ ...row, item: entityId(row.item) });
    }
    asked += batch.length;
    await sleep(WIKIDATA_PAUSE_MS);
  }
  const codes = {};
  for (const code of codeIds) {
    const best = bestPopulation(byCode.get(code));
    if (!best) continue;
    logInstead(`${code} (${best.item})`, best);
    codes[code] = [best.pop, best.year, best.item];
  }
  // The classes (P31) of items, and the classes' English labels, asked in
  // batches and kept.
  const classesOf = new Map();
  const classLabelOf = new Map();
  const fetchClasses = async (ids, what) => {
    const wanted = ids.filter((id) => !classesOf.has(id)).sort();
    let done = 0;
    for (const batch of chunks(wanted, WIKIDATA_BATCH)) {
      console.log(
        `Wikidata: classes of ${what} ${done + 1}–${done + batch.length} of ${wanted.length}`,
      );
      for (const id of batch) classesOf.set(id, new Set());
      const rows = await sparql(
        `SELECT ?item ?class WHERE { VALUES ?item { ${batch.map((q) => `wd:${q}`).join(' ')} } ?item wdt:P31 ?class . }`,
      );
      for (const row of rows)
        classesOf.get(entityId(row.item))?.add(entityId(row.class));
      done += batch.length;
      await sleep(WIKIDATA_PAUSE_MS);
    }
  };
  const fetchClassLabels = async (ids) => {
    const wanted = ids.filter((id) => !classLabelOf.has(id)).sort();
    for (const batch of chunks(wanted, WIKIDATA_BATCH)) {
      for (const id of batch) classLabelOf.set(id, '');
      // English, else the language-neutral label.
      const rows = await sparql(
        `SELECT ?class ?label (LANG(?label) AS ?lang) WHERE { VALUES ?class { ${batch.map((q) => `wd:${q}`).join(' ')} } ?class rdfs:label ?label . FILTER(LANG(?label) IN ("en", "mul")) }`,
      );
      for (const row of rows) {
        const id = entityId(row.class);
        if (row.lang === 'en' || !classLabelOf.get(id))
          classLabelOf.set(id, row.label);
      }
      await sleep(WIKIDATA_PAUSE_MS);
    }
  };
  const classLabelsOf = (item) =>
    [...(classesOf.get(item) || [])]
      .map((c) => classLabelOf.get(c) || '')
      .filter(Boolean);
  // A unit of a city kind (Natural Earth's "Highly Urbanized City",
  // "Republican City", "City") keyed to an item that is plainly a larger
  // unit carries another place's id (Natural Earth's Manila has Metro
  // Manila's, its Zamboanga its region's, its Cebu city its province's):
  // set aside for now and asked by name below like the rest; a unit that
  // then finds no city of its name gets its key back (Natural Earth's
  // Suðurnes is typed a town, and is the region its id names).
  const kindOf = (p) => String(p.type_en || p.type || '').trim();
  const cityKeyed = new Map();
  properties.forEach((p, index) => {
    if (!String(p.name || '').trim() || !admin1IsCity(kindOf(p))) return;
    const { item, code } = keys[index];
    const figured =
      (item && items[item] && item) || (code && codes[code]?.[2]) || null;
    if (!figured) return;
    if (!cityKeyed.has(figured)) cityKeyed.set(figured, []);
    cityKeyed.get(figured).push(p);
  });
  await fetchClasses([...cityKeyed.keys()], 'units of a city kind');
  await fetchClassLabels([
    ...new Set(
      [...cityKeyed.keys()].flatMap((item) => [...(classesOf.get(item) || [])]),
    ),
  ]);
  const provisional = new Map();
  for (const [item, units] of cityKeyed) {
    const labels = classLabelsOf(item);
    if (!cityItemMisplaced(labels)) continue;
    console.log(
      `Wikidata: ${item} (${labels.join(', ')}) is no city; ${units.map((p) => `${p.admin}/${p.name}`).join(' and ')} set aside, asked by name`,
    );
    const kept = { units, item: items[item] || null, codes: {} };
    delete items[item];
    for (const [code, row] of Object.entries(codes))
      if (row[2] === item) {
        kept.codes[code] = row;
        delete codes[code];
      }
    provisional.set(item, kept);
  }
  // The rest by name: the units still without a figure (the set-aside
  // among them), each against its country's units on Wikidata (those
  // located in the country, or in a unit located in it, with a
  // population), kept by Natural Earth's own admin-1 code. A unit alone in
  // its country is not asked: the server gives it the country's people
  // whatever the snapshot says.
  const countryItemOf = new Map();
  const sovereignOf = new Map();
  const countryFeatures = JSON.parse(
    (await fetchPinned('countries')).bytes,
  ).features;
  for (const { properties: c } of countryFeatures)
    if (/^Q\d+$/.test(c.WIKIDATAID || ''))
      countryItemOf.set(c.ADM0_A3, c.WIKIDATAID);
  // A territory's items name the sovereign as their country (P17): Saint
  // Pierre and Miquelon's commune is in France, American Samoa's districts
  // in the United States.
  for (const { properties: c } of countryFeatures)
    if (c.SOV_A3 && c.SOV_A3 !== c.ADM0_A3 && countryItemOf.get(c.SOV_A3))
      sovereignOf.set(c.ADM0_A3, countryItemOf.get(c.SOV_A3));
  const taken = new Set([
    ...Object.keys(items),
    ...Object.values(items)
      .map((row) => row[2])
      .filter(Boolean),
    ...Object.values(codes).map((row) => row[2]),
  ]);
  const unitsOf = new Map();
  for (const p of properties)
    if (String(p.name || '').trim())
      unitsOf.set(p.adm0_a3, (unitsOf.get(p.adm0_a3) || 0) + 1);
  const pending = new Map();
  let alone = 0;
  let replaced = 0;
  properties.forEach((p, index) => {
    const { item, code } = keys[index];
    if (!String(p.name || '').trim()) return;
    if ((item && items[item]) || (code && codes[code])) return;
    const country = countryItemOf.get(p.adm0_a3);
    if (!country) return;
    if (unitsOf.get(p.adm0_a3) === 1) {
      alone += 1;
      return;
    }
    if (replacedUnit(item, p.adm0_a3)) {
      replaced += 1;
      return;
    }
    if (!pending.has(country)) pending.set(country, []);
    pending.get(country).push(p);
  });
  if (alone)
    console.log(
      `Wikidata: ${alone} units alone in their country are not asked by name; each takes its country's people`,
    );
  if (replaced)
    console.log(
      `Wikidata: ${replaced} units whose own item was replaced by others or dissolved are not asked by name; what bears the name now is not the unit drawn`,
    );
  // The level a name match must be at: the classes (P31) of the country's
  // keyed units, by Natural Earth's kind of unit; and the count of the
  // country's units of each kind, for a country with no keyed unit.
  const peerItems = new Map();
  const kindCounts = new Map();
  properties.forEach((p, index) => {
    if (!String(p.name || '').trim()) return;
    if (!pending.has(countryItemOf.get(p.adm0_a3))) return;
    const kind = kindOf(p);
    if (!kindCounts.has(p.adm0_a3)) kindCounts.set(p.adm0_a3, new Map());
    const counts = kindCounts.get(p.adm0_a3);
    counts.set(kind, (counts.get(kind) || 0) + 1);
    const { item, code } = keys[index];
    const figured =
      (item && items[item] && item) || (code && codes[code]?.[2]) || null;
    if (!figured) return;
    if (!peerItems.has(p.adm0_a3)) peerItems.set(p.adm0_a3, new Map());
    const byKind = peerItems.get(p.adm0_a3);
    if (!byKind.has(kind)) byKind.set(kind, new Set());
    byKind.get(kind).add(figured);
  });
  await fetchClasses(
    [...peerItems.values()].flatMap((byKind) =>
      [...byKind.values()].flatMap((set) => [...set]),
    ),
    'keyed units',
  );
  // The classes of the country's keyed units of a kind (else of any kind,
  // unless `sameKindOnly`); null with none.
  const peerItemsOf = (adm0, kind, sameKindOnly = false) => {
    const byKind = peerItems.get(adm0);
    if (!byKind) return null;
    const sets = byKind.get(kind)?.size
      ? [byKind.get(kind)]
      : sameKindOnly
        ? []
        : [...byKind.values()];
    return sets.length ? sets.flatMap((set) => [...set]) : null;
  };
  const peerClassesOf = (adm0, kind, sameKindOnly = false) => {
    const peers = peerItemsOf(adm0, kind, sameKindOnly);
    if (!peers) return null;
    const out = new Set();
    for (const item of peers)
      for (const c of classesOf.get(item) || []) out.add(c);
    return out;
  };
  // The share of the keyed units of the unit's own kind carrying each class;
  // null with none of that kind (a unit of a kind of its own, Peru's Lima
  // Province among the departments, is held to any class the keyed units
  // have, not to the class most of them share).
  const peerClassSharesOf = (adm0, kind) => {
    const peers = peerItemsOf(adm0, kind, true);
    if (!peers) return null;
    const counts = new Map();
    for (const item of peers)
      for (const c of classesOf.get(item) || [])
        counts.set(c, (counts.get(c) || 0) + 1);
    return new Map([...counts].map(([c, n]) => [c, n / peers.length]));
  };
  const names = {};
  // Every unit asked, with its candidates and the context its match is
  // judged in: {p, unit, list, context}; matched below, country by country
  // first, then across them.
  const queue = [];
  let askedCountries = 0;
  let failedCountries = 0;
  for (const [country, units] of pending) {
    askedCountries += 1;
    console.log(
      `Wikidata: by name, ${units.length} units of ${units[0].admin} (${country}), country ${askedCountries} of ${pending.size}`,
    );
    // Light queries, each written from the country item outward with the
    // planner held to that order (left to itself it scans every population
    // statement there is and times out): the units with a population, their
    // classes, then the labels of those not yet keyed, in batches; the
    // figures come afterwards, for the items named. A country that fails is
    // logged and left for the next run.
    const candidates = new Map();
    const classCounts = new Map();
    let levelless = false;
    try {
      const rows = await sparql(
        `SELECT DISTINCT ?item ?direct ?mid WHERE { hint:Query hint:optimizer "None" . { ?item wdt:P131 wd:${country} . BIND(true AS ?direct) } UNION { ?mid wdt:P131 wd:${country} . ?item wdt:P131 ?mid . BIND(false AS ?direct) } ?item wdt:P1082 ?any . } LIMIT 20000`,
      );
      const all = new Set();
      const parents = new Set();
      // An item that one of the country's units (of no city kind) is located
      // in counts that unit's people with its own, and Natural Earth draws
      // the two apart: Peru's Lima department holds Lima Province, drawn
      // beside it. Its figure is not the polygon's; it is no candidate.
      const unitItems = new Set();
      for (const p of properties)
        if (
          p.adm0_a3 === units[0].adm0_a3 &&
          String(p.name || '').trim() &&
          !admin1IsCity(kindOf(p)) &&
          /^Q\d+$/.test(p.wikidataid || '')
        )
          unitItems.add(p.wikidataid);
      const holdsUnit = new Set();
      for (const row of rows) {
        const item = entityId(row.item);
        all.add(item);
        const mid = row.mid ? entityId(row.mid) : null;
        if (mid && mid !== item && unitItems.has(item)) holdsUnit.add(mid);
        if (taken.has(item)) continue;
        let c = candidates.get(item);
        if (!c) {
          c = { item, labels: new Set(), direct: false, parents: new Set() };
          candidates.set(item, c);
        }
        if (row.direct === 'true') c.direct = true;
        if (mid) {
          c.parents.add(mid);
          parents.add(mid);
        }
      }
      for (const item of holdsUnit)
        if (candidates.delete(item))
          console.log(
            `Wikidata: ${item} holds a unit of ${units[0].admin} drawn apart from it; not a candidate`,
          );
      await sleep(WIKIDATA_PAUSE_MS);
      // The units' names looked up as labels among the country's items with
      // a population (P17), for the units nested deeper than a step below
      // the country (the Philippines' component cities sit in provinces in
      // regions, Ireland's cities in counties in provinces) and for items
      // located in nothing (an island with a country alone).
      levelless = all.size === 0;
      const texts = new Set(units.flatMap((p) => admin1NameVariants(p)));
      const states = [
        ...new Set(
          [country, sovereignOf.get(units[0].adm0_a3)].filter(Boolean),
        ),
      ];
      const labelled = await sparql(
        `SELECT DISTINCT ?item ?parent WHERE { hint:Query hint:optimizer "None" . VALUES ?label { ${[...texts].flatMap((t) => LABEL_POOL_LANGUAGES.map((l) => `${JSON.stringify(t)}@${l}`)).join(' ')} } { ?item rdfs:label ?label } UNION { ?item skos:altLabel ?label } VALUES ?state { ${states.map((q) => `wd:${q}`).join(' ')} } ?item wdt:P17 ?state . ?item wdt:P1082 ?any . OPTIONAL { ?item wdt:P131 ?parent . } }`,
      );
      let byLabel = 0;
      for (const row of labelled) {
        const item = entityId(row.item);
        if (holdsUnit.has(item) || taken.has(item)) continue;
        all.add(item);
        let c = candidates.get(item);
        if (!c) {
          c = { item, labels: new Set(), direct: false, parents: new Set() };
          candidates.set(item, c);
          byLabel += 1;
        }
        const parent = row.parent ? entityId(row.parent) : null;
        if (parent === country) c.direct = true;
        else if (parent) {
          c.parents.add(parent);
          parents.add(parent);
        }
      }
      if (byLabel)
        console.log(
          `Wikidata: ${byLabel} more candidates of ${units[0].admin} by label`,
        );
      await sleep(WIKIDATA_PAUSE_MS);
      await fetchClasses([...all, ...parents], `${units[0].admin}'s units`);
      for (const item of all)
        for (const c of classesOf.get(item) || [])
          classCounts.set(c, (classCounts.get(c) || 0) + 1);
      await fetchClassLabels([
        ...new Set(
          [...candidates.keys()].flatMap((item) => [
            ...(classesOf.get(item) || []),
          ]),
        ),
      ]);
      for (const batch of chunks([...candidates.keys()], WIKIDATA_BATCH)) {
        const labelled = await sparql(
          `SELECT ?item ?label WHERE { VALUES ?item { ${batch.map((q) => `wd:${q}`).join(' ')} } { ?item rdfs:label ?label } UNION { ?item skos:altLabel ?label } FILTER(LANG(?label) IN (${LABEL_LANGUAGES})) }`,
        );
        for (const row of labelled)
          candidates.get(entityId(row.item))?.labels.add(row.label);
        await sleep(WIKIDATA_PAUSE_MS);
      }
    } catch (error) {
      failedCountries += 1;
      console.log(
        `Wikidata: ${units[0].admin} by name failed (${error.message}); left for the next run`,
      );
      continue;
    }
    const list = [...candidates.values()].map((c) => {
      const classes = [...(classesOf.get(c.item) || [])];
      return {
        ...c,
        labels: [...c.labels],
        classes,
        classLabels: classes
          .map((id) => classLabelOf.get(id) || '')
          .filter(Boolean),
        // The classes that are no city: a city's unit class, when it is one.
        unitClasses: classes.filter(
          (id) => !classIsCity([classLabelOf.get(id) || '']),
        ),
        parentUnits: [...c.parents].map((mid) => ({
          id: mid,
          classes: [...(classesOf.get(mid) || [])],
        })),
      };
    });
    for (const p of units) {
      const kind = kindOf(p);
      queue.push({
        p,
        unit: {
          variants: admin1NameVariants(p),
          secondary: admin1SecondaryVariants(p),
          type: kind,
          city: admin1IsCity(kind),
        },
        list,
        context: {
          peerClasses: peerClassesOf(p.adm0_a3, kind),
          peerClassShares: peerClassSharesOf(p.adm0_a3, kind),
          sameKindPeerClasses: peerClassesOf(p.adm0_a3, kind, true),
          classCounts,
          unitsOfKind: kindCounts.get(p.adm0_a3)?.get(kind) || 0,
          levelless: levelless && !peerItems.has(p.adm0_a3),
        },
      });
    }
  }
  // Each unit's best candidate. An item two units of one country name goes
  // to the one GeoNames names as Natural Earth does (the other polygon is a
  // neighbour's, mislabelled), else to neither; units of two countries may
  // each name one item (Sevastopol under Russia and under Ukraine: a figure
  // weighs within its country alone). A unit beaten to an item, or left
  // without one for naming it with another, tries again among the items no
  // unit named: Natural Earth's second "Uruzgan" is Daykundi by its GeoNames
  // name, and Uruzgan's item gone to the real Uruzgan, it finds Daykundi's.
  const holders = [];
  const named = new Set();
  let shared = 0;
  let round = queue;
  for (let pass = 1; pass <= 2 && round.length; pass++) {
    const claims = new Map();
    for (const a of round) {
      const hit = matchUnitByName(
        a.unit,
        named.size ? a.list.filter((c) => !named.has(c.item)) : a.list,
        pass === 1 ? a.context : { ...a.context, contested: named },
      );
      if (!hit) continue;
      if (!claims.has(hit.item)) claims.set(hit.item, []);
      claims.get(hit.item).push(a);
    }
    const losers = [];
    for (const [item, list] of claims) {
      named.add(item);
      const byCountry = new Map();
      for (const a of list) {
        if (!byCountry.has(a.p.adm0_a3)) byCountry.set(a.p.adm0_a3, []);
        byCountry.get(a.p.adm0_a3).push(a);
      }
      for (const same of byCountry.values()) {
        let holder = same[0];
        if (same.length > 1) {
          const who = same.map((a) => `${a.p.admin}/${a.p.name}`).join(' and ');
          const agreeing = same.filter((a) => nameAgreesWithGeoNames(a.p));
          if (agreeing.length !== 1) {
            shared += same.length;
            console.log(`Wikidata: ${item} named by ${who}; none takes it`);
            losers.push(...same);
            continue;
          }
          holder = agreeing[0];
          console.log(
            `Wikidata: ${item} named by ${who}; ${holder.p.adm1_code} takes it, the other polygon being GeoNames' ${same
              .filter((a) => a !== holder)
              .map((a) => a.p.gn_name)
              .join(' and ')}`,
          );
          losers.push(...same.filter((a) => a !== holder));
        }
        holders.push({ item, a: holder });
      }
    }
    if (pass === 1 && losers.length)
      console.log(
        `Wikidata: ${losers.length} units beaten to an item try again among the items no unit named`,
      );
    round = losers;
  }
  // The figures of the items held, in batches; then each to its holder.
  const namedIds = [...new Set(holders.map((h) => h.item))].sort();
  const byNamed = new Map();
  asked = 0;
  for (const batch of chunks(namedIds, WIKIDATA_BATCH)) {
    console.log(
      `Wikidata: named items ${asked + 1}–${asked + batch.length} of ${namedIds.length}`,
    );
    const rows = await sparql(
      `SELECT ?item ?pop ?when ?rank WHERE { VALUES ?item { ${batch.map((q) => `wd:${q}`).join(' ')} } ${POPULATION_PATTERN} }`,
    );
    for (const row of rows) {
      const item = entityId(row.item);
      if (!byNamed.has(item)) byNamed.set(item, []);
      byNamed.get(item).push(row);
    }
    asked += batch.length;
    await sleep(WIKIDATA_PAUSE_MS);
  }
  let unfigured = 0;
  for (const { item, a } of holders) {
    const best = bestPopulation(byNamed.get(item));
    if (!best) {
      unfigured += 1;
      continue;
    }
    logInstead(`${item} for ${a.p.admin}/${a.p.name}`, best);
    names[a.p.adm1_code] = [best.pop, best.year, item];
  }
  console.log(
    `Wikidata: by name, ${Object.keys(names).length} units figured of ${[...pending.values()].reduce((n, u) => n + u.length, 0)} asked in ${pending.size} countries (${failedCountries} failed); ${shared} shared a namesake; ${unfigured} named an item without a usable figure`,
  );
  // A unit of a city kind set aside above that found no city of its name
  // keeps its key after all; a claim another unit laid on that item goes.
  for (const [item, kept] of provisional) {
    if (kept.units.every((p) => names[p.adm1_code])) {
      setAside += 1;
      continue;
    }
    if (kept.item) items[item] = kept.item;
    Object.assign(codes, kept.codes);
    for (const [adm1, row] of Object.entries(names))
      if (row[2] === item) delete names[adm1];
    for (const p of kept.units) delete names[p.adm1_code];
    console.log(
      `Wikidata: ${item} kept for ${kept.units.map((p) => `${p.admin}/${p.name}`).join(' and ')}: no city of that name`,
    );
  }
  return {
    meta: {
      title: 'Wikidata populations of the Natural Earth admin-1 units',
      source:
        'Wikidata, population (P1082): the best-ranked statement with the latest point in time (P585), the larger on the same date',
      endpoint: WIKIDATA_SPARQL,
      api: WIKIDATA_API,
      units: SOURCES.admin1.url,
      unitsSha256: source.digest,
      fetched: new Date().toISOString().slice(0, 10),
      license: 'CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/)',
      schema:
        'items: {Wikidata item: [population, year or null, the one item that replaced it when the figure is that successor’s]} for the units whose Natural Earth wikidataid is theirs alone; codes: {ISO 3166-2 code: [population, year or null, Wikidata item]} for the others with a code of their own (P300); an item whose codes are all another country’s is set aside, as is a region or province keyed to a unit of a city kind when a city of the unit’s name is found instead; names: {Natural Earth adm1_code: [population, year or null, Wikidata item]} for the rest matched by name among their country’s units (located in the country or a step down, with a population, of the unit’s kind, no bare settlement, not inside a unit of the level, and, for an administrative unit, at the level of the country’s keyed units, else of a class with members enough for the country’s units of that kind and not three times too many; an exact label first, one naming the kind before a bare one, then one with the administrative words folded away, of the unit’s own kind, directly in the country); an item two units name goes to the one whose name GeoNames agrees with, else to neither; a unit whose own item was replaced by several is not asked. Every figure is the best-ranked statement with the latest date, unless that figure is ×jump.factor or more against the median of the item’s dated figures of the jump.memory years before with one within jump.years: then the latest figure before the jump stands (the count is of other bounds or another place)',
      jump: POPULATION_JUMP,
      setAside,
      script: 'scripts/build-admin-packs.mjs --only population',
    },
    items,
    codes,
    names,
  };
}

async function buildAdmin1() {
  const params = PARAMS.admin1;
  const source = await fetchPinned('admin1');
  const places = await fetchPinned('places');
  const collection = JSON.parse(source.bytes.toString('utf8'));
  const { ambiguity } = PARAMS;
  // The people: the committed Wikidata snapshot, by the unit's own key.
  const population = JSON.parse(
    await readFile(path.join(ROOT, POPULATION_PACK), 'utf8').catch(
      () => 'null',
    ),
  );
  if (!population)
    console.warn(
      `${POPULATION_PACK} is missing: the units carry no pop (run --only population first)`,
    );
  const populationKeys = admin1PopulationKeys(
    collection.features.map((f) => f.properties),
  );
  const populationOf = (index) => {
    const { item, code } = populationKeys[index];
    const row =
      (item && population?.items?.[item]) ||
      (code && population?.codes?.[code]) ||
      population?.names?.[collection.features[index].properties.adm1_code] ||
      null;
    if (!row) return null;
    const [pop, year] = row;
    if (year !== null && year < PARAMS.population.minYear) return null;
    return Number.isFinite(pop) && pop >= 0 ? pop : null;
  };
  let peopled = 0;
  const cities = JSON.parse(places.bytes.toString('utf8'))
    .features.map((f) => f.properties)
    .filter((p) => p.pop_max >= ambiguity.elsewhereMinPopulation)
    .map((p) => ({
      keys: new Set([p.name, p.nameascii].map(normalizeAdminName)),
      lon: p.longitude,
      lat: p.latitude,
      population: p.pop_max,
      country: p.adm0name,
    }));
  const countryNames = new Set();
  for (const { properties: p } of collection.features)
    for (const name of [p.admin, p.geonunit])
      if (name) countryNames.add(normalizeAdminName(name));

  const features = [];
  for (const [
    index,
    { properties: p, geometry },
  ] of collection.features.entries()) {
    const name = String(p.name || '').trim();
    if (!name) continue;
    const unit = simplifyUnit(geojsonPolygons(geometry), params);
    if (!unit.polygons.length) continue;
    const pop = populationOf(index);
    if (pop !== null) peopled += 1;
    const nameEn =
      p.name_en && normalizeAdminName(p.name_en) !== normalizeAdminName(name)
        ? String(p.name_en).trim()
        : null;
    const alt = uniqueNames(
      String(p.name_alt || '').split('|'),
      [name, nameEn].filter(Boolean),
    );
    const bbox = bboxOf(unit.polygons);
    const areaKm2 = unit.polygons.reduce(
      (sum, poly) => sum + ringAreaKm2(poly[0]),
      0,
    );
    const keys = new Set(
      [name, nameEn, ...alt].filter(Boolean).map(normalizeAdminName),
    );
    const amb = [];
    const ambAbroad = [];
    let cityState = false;
    const inBox = (c) =>
      c.lon >= bbox[0] &&
      c.lon <= bbox[2] &&
      c.lat >= bbox[1] &&
      c.lat <= bbox[3];
    for (const key of keys) {
      const namesakes = cities.filter((c) => c.keys.has(key));
      const ownCity = namesakes.some(
        (c) => inBox(c) && c.population >= ambiguity.insideMinPopulation,
      );
      const cityInside = ownCity && areaKm2 > ambiguity.cityStateMaxKm2;
      if (ownCity && !cityInside) cityState = true;
      const elsewhere = namesakes.filter((c) => !inBox(c));
      if (
        countryNames.has(key) ||
        cityInside ||
        elsewhere.some((c) => c.country === p.admin)
      )
        amb.push(key);
      // Only abroad: "Victoria, Australia" settles it; "Victoria" alone not.
      else if (elsewhere.length) ambAbroad.push(key);
    }
    const postal = String(p.postal || '').trim();
    const group = admin1Group(p);
    features.push({
      name,
      ...(nameEn ? { nameEn } : {}),
      ...(alt.length ? { alt } : {}),
      ...(/^[A-Z]{2}$/.test(postal) ? { postal } : {}),
      type: p.type_en || p.type || null,
      ...(Number.isFinite(p.min_label) ? { rank: p.min_label } : {}),
      ...(group ? { group } : {}),
      country: p.admin,
      iso2: p.iso_a2 && p.iso_a2 !== '-99' ? p.iso_a2 : null,
      iso: p.iso_3166_2 && !p.iso_3166_2.includes('~') ? p.iso_3166_2 : null,
      ...(pop !== null ? { pop } : {}),
      ...(amb.length ? { amb: amb.sort() } : {}),
      ...(ambAbroad.length ? { ambAbroad: ambAbroad.sort() } : {}),
      ...(cityState ? { cityState } : {}),
      ...(Number.isFinite(p.longitude) && Number.isFinite(p.latitude)
        ? {
            label: [
              Math.round(p.longitude * 1000) / 1000,
              Math.round(p.latitude * 1000) / 1000,
            ],
          }
        : {}),
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  }
  features.sort(
    (a, b) =>
      a.country.localeCompare(b.country) ||
      a.name.localeCompare(b.name) ||
      (a.iso || '').localeCompare(b.iso || ''),
  );
  return {
    meta: {
      title: 'Natural Earth admin-1 states and provinces',
      source: 'ne_10m_admin_1_states_provinces',
      url: SOURCES.admin1.url,
      sha256: source.digest,
      ambiguitySource: SOURCES.places.url,
      ambiguitySha256: places.digest,
      commit: NE_COMMIT,
      license:
        'Public domain (https://www.naturalearthdata.com/about/terms-of-use/)',
      population: population
        ? {
            source: POPULATION_PACK,
            fetched: population.meta?.fetched || null,
            license: population.meta?.license || null,
            units: peopled,
          }
        : null,
      schema:
        'features[]: name, nameEn?, alt?[], postal?, type, rank? (min_label: the zoom at which Natural Earth labels the unit; lower is more prominent), group? (the larger region the unit sits in: Natural Earth region, or the UK constituent country and English region), country, iso2, iso (ISO 3166-2), pop? (the unit’s people: Wikidata’s population from meta.population.source, by the unit’s own Wikidata item or ISO 3166-2 code, else by its name among its country’s units, dated meta.curation.population.minYear or later), amb?[] (normalized names that are also a country or a city — alone or with the country named), ambAbroad?[] (names shared only with a city in another country — ambiguous alone, settled by naming the country), cityState? (the unit is its own city), label? [lon, lat] label point, d? (decimals when not meta.decimals), polygons[][ring] (first ring outer, rest holes; each ring open and encoded as integers in 10^-d degrees, first vertex absolute then [dLon, dLat] deltas)',
      decimals: params.decimals,
      curation: { ...params, ambiguity, population: PARAMS.population },
      script: 'scripts/build-admin-packs.mjs',
    },
    features,
  };
}

/**
 * The populated places pack: every Natural Earth 10m populated place with
 * its country, its state or province, its point and its population, for the
 * GLOBAL ABUNDANCE MAP's city level (owner request 2026-10-22). No geometry
 * beyond the point, so the pack stays small. `ne_id` is Natural Earth's own
 * stable id and is the unit id on the globe and the server.
 */
async function buildPlaces() {
  const source = await fetchPinned('places');
  const countries = JSON.parse((await fetchPinned('countries')).bytes);
  const iso2ByIso3 = new Map();
  for (const { properties: p } of countries.features) {
    const iso2 = p.ISO_A2_EH || p.ISO_A2;
    if (p.ADM0_A3 && /^[A-Z]{2}$/.test(iso2 || ''))
      iso2ByIso3.set(p.ADM0_A3, iso2);
  }
  const features = [];
  for (const { properties: p } of JSON.parse(source.bytes).features) {
    const name = String(p.name || '').trim();
    if (!name || !Number.isFinite(p.longitude) || !Number.isFinite(p.latitude))
      continue;
    const iso2 =
      p.iso_a2 && /^[A-Z]{2}$/.test(p.iso_a2)
        ? p.iso_a2
        : iso2ByIso3.get(p.adm0_a3) || null;
    const alt = uniqueNames(
      [
        p.nameascii,
        p.meganame,
        ...String(p.namealt || '').split(','),
        ...String(p.ls_name || '').split(','),
      ],
      [name],
    );
    features.push({
      id: p.ne_id,
      name,
      ...(alt.length ? { alt } : {}),
      country: p.adm0name,
      iso: p.adm0_a3,
      ...(iso2 ? { iso2 } : {}),
      ...(p.adm1name ? { adm1: p.adm1name } : {}),
      lon: Math.round(p.longitude * 1000) / 1000,
      lat: Math.round(p.latitude * 1000) / 1000,
      pop: Math.max(0, Math.round(p.pop_max || 0)),
      ...(p.adm0cap === 1 ? { capital: true } : {}),
      rank: p.scalerank,
    });
  }
  features.sort(
    (a, b) =>
      a.country.localeCompare(b.country) ||
      a.name.localeCompare(b.name) ||
      a.id - b.id,
  );
  return {
    meta: {
      title: 'Natural Earth 10m populated places',
      source: 'ne_10m_populated_places_simple',
      url: SOURCES.places.url,
      sha256: source.digest,
      countrySource: SOURCES.countries.url,
      commit: NE_COMMIT,
      license:
        'Public domain (https://www.naturalearthdata.com/about/terms-of-use/)',
      schema:
        'features[]: id (ne_id), name, alt?[], country, iso (adm0_a3), iso2?, adm1? (state or province name), lon, lat (3 decimals), pop (pop_max), capital? (a national capital), rank (scalerank: lower is more prominent)',
      script: 'scripts/build-admin-packs.mjs',
    },
    features,
  };
}

async function buildCounties() {
  const params = PARAMS.counties;
  const source = await fetchPinned('counties');
  const files = unzip(source.bytes);
  const base = path.basename(new URL(SOURCES.counties.url).pathname, '.zip');
  const shapes = readShp(files.get(`${base}.shp`));
  const records = readDbf(files.get(`${base}.dbf`));
  if (shapes.length !== records.length)
    throw new Error('counties: shp/dbf record counts differ');
  const features = [];
  records.forEach((record, index) => {
    const unit = simplifyUnit(shpPolygons(shapes[index]), params);
    if (!unit.polygons.length) return;
    const lsad = record.NAMELSAD.startsWith(record.NAME)
      ? record.NAMELSAD.slice(record.NAME.length).trim()
      : '';
    features.push({
      name: record.NAME,
      full: record.NAMELSAD,
      ...(lsad ? { lsad } : {}),
      state: record.STATE_NAME,
      st: record.STUSPS,
      geoid: record.GEOID,
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  });
  features.sort((a, b) => a.geoid.localeCompare(b.geoid));
  return {
    meta: {
      title: 'US Census Bureau cartographic boundary counties',
      source: base,
      url: SOURCES.counties.url,
      sha256: source.digest,
      license: 'Public domain (U.S. Government work, 17 U.S.C. § 105)',
      schema:
        'features[]: name, full (NAMELSAD), lsad? (County, Parish, Borough, …), state, st (USPS), geoid, d? (decimals when not meta.decimals), polygons[][ring] (first ring outer, rest holes; each ring open and encoded as integers in 10^-d degrees, first vertex absolute then [dLon, dLat] deltas)',
      decimals: params.decimals,
      curation: params,
      script: 'scripts/build-admin-packs.mjs',
    },
    features,
  };
}

async function writePack(relative, pack) {
  const file = path.join(ROOT, relative);
  await mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(pack) + '\n';
  await writeFile(file, text);
  if (!pack.features[0]?.polygons) {
    console.log(
      `${relative}: ${pack.features.length} features, ${Buffer.byteLength(text)} bytes`,
    );
    return;
  }
  const parts = pack.features.reduce((n, f) => n + f.polygons.length, 0);
  const vertices = pack.features.reduce(
    (n, f) => n + f.polygons.flat().reduce((m, ring) => m + ring.length / 2, 0),
    0,
  );
  console.log(
    `${relative}: ${pack.features.length} features, ${parts} parts, ${vertices} vertices, ${Buffer.byteLength(text)} bytes`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  // Wikidata is live: its snapshot is asked for by name only, never by the
  // default run, so a rerun of the packs stays reproducible.
  if (only === 'population') {
    const snapshot = await buildAdmin1Population();
    const file = path.join(ROOT, POPULATION_PACK);
    await mkdir(path.dirname(file), { recursive: true });
    const text = JSON.stringify(snapshot) + '\n';
    await writeFile(file, text);
    console.log(
      `${POPULATION_PACK}: ${Object.keys(snapshot.items).length} items, ${Object.keys(snapshot.codes).length} codes, ${Buffer.byteLength(text)} bytes`,
    );
  }
  if (!only || only === 'countries')
    await writePack(
      'src/data/local_data/natural_earth/countries.json',
      await buildCountries(),
    );
  if (!only || only === 'admin1')
    await writePack(
      'src/data/local_data/natural_earth/states_provinces.json',
      await buildAdmin1(),
    );
  if (!only || only === 'counties')
    await writePack(
      'src/data/local_data/us_census_counties/counties.json',
      await buildCounties(),
    );
  if (!only || only === 'places')
    await writePack(
      'src/data/local_data/natural_earth/places.json',
      await buildPlaces(),
    );
}
