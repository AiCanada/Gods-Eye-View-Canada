/**
 * EVERY RAIL LINE ON THE GLOBE (owner ruling 2026-10-12: "find all rail on
 * globe, and make sure to include in outbreak sim"). Pure: no DOM, no
 * network, no disk. The server's world rail job
 * (server/providers/outbreakRailWorld.js) sweeps the zoom-8 OpenFreeMap tiles
 * this module names, once and politely, and builds one world rail network
 * from them (outbreakNetwork.mjs, buildRailGraph); this module says which
 * tiles, in what order, and where each one is.
 *
 *  - The tiles: every zoom-8 tile that touches land, from Natural Earth's
 *    10m countries (the bundled pack), one tile wider all round so small
 *    islands and coasts are kept. Rail lines are in the tiles at zoom 8 and
 *    finer only (zoom 5 to 7 carried none, measured 2026-10-12).
 *  - Antarctica and everything south of 60° S are left out: no railway runs
 *    there, and every cached tile off the land mask held 0 km of rail
 *    (measured 2026-10-12).
 *  - countryAt and continentOf: where a tile or a point is, for the counts
 *    by country and by continent.
 */
import { decodeRing } from './data/adminBoundaries.js';
import { NETWORK_TILE_ZOOM, tileBounds } from './outbreakNetwork.mjs';
import { distanceKm } from './outbreakCore.mjs';

/** The world rail is swept at the network's own zoom: main lines. */
export const RAIL_WORLD_ZOOM = NETWORK_TILE_ZOOM;
/**
 * Bumped when the extract or the build changes shape: a new build follows.
 * 2 (2026-10-12): lines cut at tile edges, no joins over open sea, border
 * tiles split by country outline. The extracts are kept as they are.
 */
export const RAIL_WORLD_VERSION = 2;
/** Tiles wholly south of this are left out (no railway, measured 2026-10-12). */
export const RAIL_WORLD_SOUTH_LIMIT = -60;
export const CONTINENTS = Object.freeze(['AF', 'AS', 'EU', 'NA', 'SA', 'OC']);

/** ISO 3166 two-letter codes by continent (Antarctica apart). */
const CONTINENT_CODES = Object.freeze({
  AF: 'DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW',
  AS: 'AF AM AZ BH BD BT BN KH CN CY GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TL TR TM AE UZ VN YE IO',
  EU: 'AX AL AD AT BY BE BA BG HR CZ DK EE FO FI FR DE GI GR GG VA HU IS IE IM IT JE XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SJ SE CH UA GB',
  NA: 'AI AG AW BS BB BZ BM BQ VG CA KY CR CU CW DM DO SV GL GD GP GT HT HN JM MQ MX MS NI PA PR BL KN LC MF PM VC SX TT TC US VI UM',
  SA: 'AR BO BR CL CO EC FK GF GY PY PE SR UY VE GS',
  OC: 'AS AU CK FJ PF GU KI MH FM NR NC NZ NU NF MP PW PG PN WS SB TK TO TV VU WF',
  AN: 'AQ TF HM BV',
});
const CONTINENT_OF = new Map(
  Object.entries(CONTINENT_CODES).flatMap(([continent, list]) =>
    list.split(' ').map((code) => [code, continent]),
  ),
);
/** Natural Earth's units with no code of their own (-99), by ISO3-like id. */
const NE_CODE_FIX = Object.freeze({ CYN: 'CY', SOL: 'SO', KAS: 'IN' });

/**
 * The continent of a country code; Russia east of the Urals (60° E) is
 * Asia when the longitude is given. '' when unknown.
 */
export function continentOf(iso2, lon) {
  const code = String(iso2 || '').toUpperCase();
  if (code === 'RU' && Number.isFinite(lon) && lon > 60) return 'AS';
  return CONTINENT_OF.get(code) || '';
}

/** The two-letter code of a Natural Earth country feature, or ''. */
function featureCode(feature) {
  const iso2 = String(feature?.iso2 || '');
  if (/^[A-Z]{2}$/.test(iso2)) return iso2;
  return NE_CODE_FIX[feature?.iso] || '';
}

const tileKey = (x, y) => y * 4096 + x;

/** Mercator row of a latitude at zoom z, unrounded. */
function rowOf(lat, z) {
  const n = 2 ** z;
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const rad = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
}

/**
 * The land mask: every tile at `zoom` that touches a country, by scanline
 * fill of each country's outer rings (sampled at a quarter-tile in each
 * direction) plus each ring's own edges (densified, so a sliver of coast is
 * kept), then one tile wider all round. Antarctica and tiles wholly south
 * of RAIL_WORLD_SOUTH_LIMIT are left out.
 *
 * @param {{features: object[]}|object[]} countries Natural Earth's pack.
 * @returns {{z: number, x: number, y: number, country: string,
 *   countries: string[]}[]} By row, then column; `country` is the code of a
 *   country there ('' at a coast added by the widening), `countries` every
 *   country there.
 */
export function railWorldTiles(countries, { zoom = RAIL_WORLD_ZOOM } = {}) {
  const features = Array.isArray(countries)
    ? countries
    : countries?.features || [];
  const n = 2 ** zoom;
  const owner = new Map();
  // Every country that marks a tile (2026-10-12): a tile on a border is
  // shared, and each point there goes to its own country (countryLookup).
  const marked = new Map();
  const mark = (x, y, code) => {
    if (y < 0 || y >= n) return;
    const xx = ((x % n) + n) % n;
    const key = tileKey(xx, y);
    if (!owner.has(key) || (!owner.get(key) && code)) owner.set(key, code);
    if (code) {
      let codes = marked.get(key);
      if (!codes) marked.set(key, (codes = new Set()));
      codes.add(code);
    }
  };
  const colOf = (lon) => ((lon + 180) / 360) * n;
  for (const feature of features) {
    const code = featureCode(feature);
    if (code === 'AQ') continue;
    for (const polygon of feature?.polygons || []) {
      const encoded = polygon?.[0];
      if (!Array.isArray(encoded) || encoded.length < 6) continue;
      const ring = decodeRing(encoded, 3);
      // In tile units: x by column, y by Mercator row.
      const pts = ring.map(([lon, lat]) => [colOf(lon), rowOf(lat, zoom)]);
      // Edges, densified to a quarter tile.
      for (let i = 0; i < pts.length; i += 1) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[(i + 1) % pts.length];
        // A ring crossing the antimeridian has an edge across the map: skip it.
        if (Math.abs(x1 - x0) > n / 2) continue;
        const steps = Math.max(
          1,
          Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 4),
        );
        for (let k = 0; k <= steps; k += 1) {
          const f = k / steps;
          mark(
            Math.floor(x0 + f * (x1 - x0)),
            Math.floor(y0 + f * (y1 - y0)),
            code,
          );
        }
      }
      // Scanline fill, four lines a tile.
      let yMin = Infinity;
      let yMax = -Infinity;
      for (const [, y] of pts) {
        yMin = Math.min(yMin, y);
        yMax = Math.max(yMax, y);
      }
      for (let sy = Math.floor(yMin * 4) / 4 + 0.125; sy <= yMax; sy += 0.25) {
        const xs = [];
        for (let i = 0; i < pts.length; i += 1) {
          const [x0, y0] = pts[i];
          const [x1, y1] = pts[(i + 1) % pts.length];
          if (Math.abs(x1 - x0) > n / 2) continue;
          if (y0 > sy !== y1 > sy)
            xs.push(x0 + ((sy - y0) * (x1 - x0)) / (y1 - y0));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2)
          for (let x = Math.floor(xs[k]); x <= Math.floor(xs[k + 1]); x += 1)
            mark(x, Math.floor(sy), code);
      }
    }
  }
  // One tile wider all round.
  const base = [...owner];
  for (const [key] of base) {
    const x = key % 4096;
    const y = Math.floor(key / 4096);
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -1; dx <= 1; dx += 1)
        if (dx || dy) {
          const yy = y + dy;
          if (yy < 0 || yy >= n) continue;
          const xx = (((x + dx) % n) + n) % n;
          const k = tileKey(xx, yy);
          if (!owner.has(k)) owner.set(k, '');
        }
  }
  const tiles = [];
  for (const [key, country] of owner) {
    const x = key % 4096;
    const y = Math.floor(key / 4096);
    const bounds = tileBounds(zoom, x, y);
    if (bounds.north <= RAIL_WORLD_SOUTH_LIMIT) continue;
    const countries = [...(marked.get(key) || [])].sort();
    tiles.push({ z: zoom, x, y, country, countries });
  }
  return tiles.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Where a point is: the country of its tile in the land mask, else of the
 * nearest tile with one within two tiles. Built once from railWorldTiles.
 * In a tile two or more countries share, with `shapes` (countryShapes), the
 * country whose outline holds the point (2026-10-12: a border tile no
 * longer goes whole to the country first in the alphabet).
 *
 * @returns {(lat: number, lon: number) => string} '' when unknown.
 */
export function countryLookup(
  tiles,
  { zoom = RAIL_WORLD_ZOOM, shapes = null } = {},
) {
  const n = 2 ** zoom;
  const byKey = new Map();
  const shared = new Map();
  for (const tile of tiles) {
    if (tile.country) byKey.set(tileKey(tile.x, tile.y), tile.country);
    if (tile.countries?.length > 1)
      shared.set(tileKey(tile.x, tile.y), tile.countries);
  }
  return (lat, lon) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
    const x = Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
    const y = Math.min(n - 1, Math.max(0, Math.floor(rowOf(lat, zoom))));
    const among = shapes ? shared.get(tileKey(x, y)) : null;
    if (among) {
      const found = shapes.countryAt(lat, lon, among);
      if (found) return found;
    }
    const own = byKey.get(tileKey(x, y));
    if (own) return own;
    for (let ring = 1; ring <= 2; ring += 1)
      for (let dy = -ring; dy <= ring; dy += 1)
        for (let dx = -ring; dx <= ring; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const yy = y + dy;
          if (yy < 0 || yy >= n) continue;
          const found = byKey.get(tileKey((((x + dx) % n) + n) % n, yy));
          if (found) return found;
        }
    return '';
  };
}

/** Latitude bands of a country outline's edges, for the point tests. */
const SHAPE_BAND_DEG = 0.1;
/** Cells of the outlines' boxes, for the point tests. */
const SHAPE_CELL_DEG = 5;

/**
 * The countries' outlines from Natural Earth's pack, for point tests
 * (2026-10-12): `countryAt(lat, lon, among)` is the code of the country
 * whose outline holds the point ('' for none; only codes in `among` when
 * given), `onLand(lat, lon)` whether any outline holds it (Antarctica too).
 * Each outline's edges are kept by band of latitude, so a test crosses only
 * the edges of its own band (even-odd, holes included).
 */
export function countryShapes(countries) {
  const features = Array.isArray(countries)
    ? countries
    : countries?.features || [];
  const shapes = [];
  const grid = new Map();
  for (const feature of features) {
    const code = featureCode(feature);
    for (const polygon of feature?.polygons || []) {
      if (!Array.isArray(polygon?.[0]) || polygon[0].length < 6) continue;
      const edges = [];
      let west = Infinity;
      let east = -Infinity;
      let south = Infinity;
      let north = -Infinity;
      for (const encoded of polygon) {
        if (!Array.isArray(encoded) || encoded.length < 6) continue;
        const ring = decodeRing(encoded, 3);
        for (let i = 0; i < ring.length; i += 1) {
          const [x0, y0] = ring[i];
          const [x1, y1] = ring[(i + 1) % ring.length];
          // An edge across the antimeridian crosses the map: skipped.
          if (Math.abs(x1 - x0) > 180) continue;
          edges.push(x0, y0, x1, y1);
          west = Math.min(west, x0, x1);
          east = Math.max(east, x0, x1);
          south = Math.min(south, y0, y1);
          north = Math.max(north, y0, y1);
        }
      }
      if (!edges.length) continue;
      const bands = new Map();
      for (let e = 0; e < edges.length; e += 4) {
        const y0 = edges[e + 1];
        const y1 = edges[e + 3];
        const from = Math.floor(Math.min(y0, y1) / SHAPE_BAND_DEG);
        const to = Math.floor(Math.max(y0, y1) / SHAPE_BAND_DEG);
        for (let b = from; b <= to; b += 1) {
          let list = bands.get(b);
          if (!list) bands.set(b, (list = []));
          list.push(e);
        }
      }
      const id =
        shapes.push({
          code,
          west,
          east,
          south,
          north,
          edges: Float64Array.from(edges),
          bands,
        }) - 1;
      for (
        let cx = Math.floor(west / SHAPE_CELL_DEG);
        cx <= Math.floor(east / SHAPE_CELL_DEG);
        cx += 1
      )
        for (
          let cy = Math.floor(south / SHAPE_CELL_DEG);
          cy <= Math.floor(north / SHAPE_CELL_DEG);
          cy += 1
        ) {
          const key = `${cx}/${cy}`;
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(id);
        }
    }
  }
  const holds = (shape, lat, lon) => {
    if (
      lon < shape.west ||
      lon > shape.east ||
      lat < shape.south ||
      lat > shape.north
    )
      return false;
    const list = shape.bands.get(Math.floor(lat / SHAPE_BAND_DEG));
    if (!list) return false;
    const { edges } = shape;
    let inside = false;
    for (const e of list) {
      const x0 = edges[e];
      const y0 = edges[e + 1];
      const x1 = edges[e + 2];
      const y1 = edges[e + 3];
      if (
        y0 > lat !== y1 > lat &&
        lon < x0 + ((lat - y0) * (x1 - x0)) / (y1 - y0)
      )
        inside = !inside;
    }
    return inside;
  };
  const near = (lat, lon) =>
    grid.get(
      `${Math.floor(lon / SHAPE_CELL_DEG)}/${Math.floor(lat / SHAPE_CELL_DEG)}`,
    ) || [];
  return {
    countryAt(lat, lon, among = null) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
      for (const id of near(lat, lon)) {
        const shape = shapes[id];
        if (!shape.code || (among && !among.includes(shape.code))) continue;
        if (holds(shape, lat, lon)) return shape.code;
      }
      return '';
    },
    onLand(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
      for (const id of near(lat, lon))
        if (holds(shapes[id], lat, lon)) return true;
      return false;
    },
  };
}

/**
 * Whether a straight rail join stays on land (2026-10-12: the world build
 * never joins an island's rail to another shore's across open sea): points
 * every `stepKm` along it are tested, and the join is refused when most of
 * them are off land. A join of up to `freeKm` is always allowed (a coast
 * line drawn a little off the coast's outline).
 *
 * @param {(lat: number, lon: number) => boolean} onLand countryShapes' own.
 * @returns {(lat1: number, lon1: number, lat2: number, lon2: number) =>
 *   boolean} buildRailGraph's `joinOk`.
 */
export function landJoinOk(onLand, { stepKm = 5, freeKm = 5 } = {}) {
  return (lat1, lon1, lat2, lon2) => {
    const km = distanceKm({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
    if (!(km > freeKm)) return true;
    const steps = Math.max(3, Math.ceil(km / stepKm));
    let sea = 0;
    for (let k = 1; k < steps; k += 1) {
      const f = k / steps;
      if (!onLand(lat1 + f * (lat2 - lat1), lon1 + f * (lon2 - lon1))) sea += 1;
    }
    return sea * 2 <= steps - 1;
  };
}

/**
 * A segment cut to a box, or null when it misses it: [from, to], each
 * [lon, lat]. Cut the same way whichever end comes first, so two tiles
 * that share an edge cut a line across it at the same point.
 */
function clipSegment(a, b, box) {
  const swap = a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  const p = swap ? b : a;
  const q = swap ? a : b;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  let t0 = 0;
  let t1 = 1;
  for (const [step, room] of [
    [-dx, p[0] - box.west],
    [dx, box.east - p[0]],
    [-dy, p[1] - box.south],
    [dy, box.north - p[1]],
  ]) {
    if (step === 0) {
      if (room < 0) return null;
      continue;
    }
    const t = room / step;
    if (step < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  const at = (t) => (t <= 0 ? p : t >= 1 ? q : [p[0] + t * dx, p[1] + t * dy]);
  const from = at(t0);
  const to = at(t1);
  if (from[0] === to[0] && from[1] === to[1]) return null;
  return swap ? [to, from] : [from, to];
}

/**
 * A tile's lines cut at the tile's own edges (2026-10-12): the tiles keep
 * the first point past each edge, so without the cut the stretch across
 * every tile edge was counted twice, once by each tile.
 *
 * @param {[number, number][][]} lines [lon, lat] runs.
 * @param {{west: number, east: number, south: number, north: number}} box
 */
export function clipLinesToBox(lines, box) {
  const out = [];
  for (const line of lines || []) {
    let run = [];
    for (let k = 1; k < line.length; k += 1) {
      const cut = clipSegment(line[k - 1], line[k], box);
      if (!cut) {
        if (run.length >= 2) out.push(run);
        run = [];
        continue;
      }
      const last = run[run.length - 1];
      if (!last || last[0] !== cut[0][0] || last[1] !== cut[0][1]) {
        if (run.length >= 2) out.push(run);
        run = [cut[0]];
      }
      run.push(cut[1]);
    }
    if (run.length >= 2) out.push(run);
  }
  return out;
}

/**
 * The sweep's order: the tiles nearest any of `near` first (the outbreak
 * locations and landings asked about), then the rest by row and column.
 * Pure: a new array.
 */
export function railSweepOrder(tiles, near = []) {
  const points = near.filter(
    (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
  );
  if (!points.length) return [...tiles];
  const center = (t) => {
    const b = tileBounds(t.z, t.x, t.y);
    return { lat: (b.north + b.south) / 2, lon: (b.west + b.east) / 2 };
  };
  return tiles
    .map((tile, i) => {
      const c = center(tile);
      let best = Infinity;
      for (const p of points) best = Math.min(best, distanceKm(c, p));
      return { tile, i, km: best };
    })
    .sort((a, b) => a.km - b.km || a.i - b.i)
    .map(({ tile }) => tile);
}

/** A tile's file-safe name. */
export function railTileName(tile) {
  return `${tile.x}_${tile.y}`;
}

/**
 * A tile's rail lines as the extract keeps them: flat [lon, lat, ...] runs,
 * five decimals (about a metre).
 */
export function railExtract(lines, fetchedAt) {
  const rail = [];
  for (const line of lines || []) {
    const flat = [];
    for (const [lon, lat] of line)
      if (Number.isFinite(lon) && Number.isFinite(lat))
        flat.push(Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5);
    if (flat.length >= 4) rail.push(flat);
  }
  return { v: RAIL_WORLD_VERSION, fetchedAt, rail };
}

/** The extract's lines back as [lon, lat] runs. */
export function railExtractLines(extract) {
  const out = [];
  for (const flat of extract?.rail || []) {
    const line = [];
    for (let i = 0; i + 1 < flat.length; i += 2)
      line.push([flat[i], flat[i + 1]]);
    if (line.length >= 2) out.push(line);
  }
  return out;
}

/** The retry wait after a tile's nth failure (5, 30, then 120 minutes). */
export const RAIL_TILE_RETRY_MS = Object.freeze([
  5 * 60_000,
  30 * 60_000,
  120 * 60_000,
]);
export function railRetryDelayMs(attempts) {
  return RAIL_TILE_RETRY_MS[
    Math.min(RAIL_TILE_RETRY_MS.length - 1, Math.max(0, attempts - 1))
  ];
}
