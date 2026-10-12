/**
 * OUTBREAK LOCATIONS & PREDICTED SPREAD: the dev server's half.
 *
 *   GET /api/outbreak/airports/near?lat=&lon=&km=   airports with scheduled
 *        service near an outbreak location
 *   GET /api/outbreak/airports/candidates?lat=&lon=  the airports a language
 *        model may name as destinations (every large airport, and scheduled
 *        medium ones within reach)
 *   GET /api/outbreak/airports/lookup?codes=A,B      codes to airports
 *   GET /api/outbreak/flights?airports=UIII&begin=&end=   flight history out
 *        of those airports, and the connecting flights out of where they
 *        landed (OpenSky, on the POWER UP → OPENSKY account)
 *   GET /api/outbreak/surroundings?lat=&lon=   is there a railway station
 *        near, the area's train speed, and water traffic within 100 km
 *        (OpenStreetMap through the app's Overpass mirrors)
 *   GET /api/outbreak/news?places=A;B&keywords=   a global media search
 *        (GDELT) for the outbreak
 *   GET /api/outbreak/network?lat=&lon=&mode=road|rail   the main roads or
 *        rail lines round an outbreak location, measured along from it, so
 *        the map turns them red as the spread reaches them
 *        (src/outbreakNetwork.mjs); OpenFreeMap's vector tiles of
 *        OpenStreetMap, kept thirty days
 *   POST /api/outbreak/air-roads   the roads out of every airport the
 *        outbreak lands at, each lit from its landing hour: fast for the
 *        first 100 km, then slower (src/outbreakNetwork.mjs, timed)
 *   POST /api/outbreak/air-rails   the rail lines round every airport the
 *        outbreak lands at, timed the same way at train speed, so the rail
 *        lights up after a flight too (the tiles carry rail only up close)
 *   GET /api/outbreak/rail-world/status   how far the world rail has got
 *        (owner ruling 2026-10-12: every rail line on the globe, found once
 *        in the background, outbreakRailWorld.js); once it is built the rail
 *        above answers along the whole world's network
 *   GET /api/outbreak/rail-world/tile/z/x/y   the world rail's lines for
 *        the map's world rail layer (zoom 2 to 6)
 *   POST /api/outbreak/traffic   the assumed air traffic beyond the scan
 *   POST /api/outbreak/epidemic  the EPIDEMIC MODEL (src/outbreakEpi.mjs):
 *        a stochastic ensemble over the same flights, with each airport's
 *        people from GeoNames' cities over 15,000 (CC-BY 4.0), fetched once
 *        and kept in .gev-cache/outbreak for thirty days. It runs in a worker
 *        thread so the dev server keeps answering.
 *
 * The airports are OurAirports' public table, fetched once and kept in
 * .gev-cache/outbreak for thirty days. Every route answers this page only
 * (a Host this server serves, a same-origin fetch), and nothing here holds
 * a key: OpenSky's token comes from the aircraft provider.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import {
  resolvedAllowedHosts,
  servedRequestOrigin,
} from './common/allowed-hosts.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { getOpenSkyToken } from './aircraft/opensky.js';
import { admitLlmRequestFrom } from './llm/ask.js';
import { readRequestBody } from './common/request.js';
import { fetchOverpassPayload } from './overpass.js';
import {
  BOAT_REACH_KM,
  CONNECTING_AIRPORTS_MAX,
  PLANE_ROAD_KM,
  PLANE_ROAD_ONWARD_SHARE,
  OUTBREAK_AIRPORT_KM,
  RAIL_REACH_KM,
  cleanProfile,
  distanceKm,
  packTraffic,
  simulateAirTraffic,
  validPoint,
} from '../../src/outbreakCore.mjs';
import {
  EPIDEMIC_BUDGET_MS,
  EPIDEMIC_RUNS_DEFAULT,
  RAIL_TRAVEL,
  buildEpidemicNodes,
  railCountryVolumes,
  cleanEpiProfile,
  effectiveDistances,
  epiParameters,
  flightPassengers,
  seedFromText,
  worldAirRoutes,
} from '../../src/outbreakEpi.mjs';
import { sensitivityTornado } from '../../src/outbreakEpiSensitivity.mjs';
import {
  NETWORK_JOIN_KM,
  NETWORK_PRIMARY_KM,
  NETWORK_ROAD_LEVELS,
  NETWORK_RADIUS_KM,
  NETWORK_START_KM,
  NETWORK_TILE_ZOOM,
  buildTransportNetwork,
  networkTiles,
  tileBounds,
  tileDistanceKm,
} from '../../src/outbreakNetwork.mjs';
import {
  RAIL_WORLD_VERSION,
  continentOf,
} from '../../src/outbreakRailWorld.mjs';
import { railWorldJob } from './outbreakRailWorld.js';
import { unpackRailRoutes } from './outbreakRailWorldTasks.mjs';

const AIRPORTS_URL =
  'https://davidmegginson.github.io/ourairports-data/airports.csv';
const AIRPORTS_CACHE_MS = 30 * 24 * 3_600_000;
const AIRPORTS_TIMEOUT_MS = 60_000;
const OPENSKY_DEPARTURES_URL =
  'https://opensky-network.org/api/flights/departure';
const OPENSKY_TIMEOUT_MS = 20_000;
/** OpenSky answers at most this long a window per departures request. */
const OPENSKY_WINDOW_S = 2 * 86_400;
const SCAN_MAX_S = 8 * 86_400;
const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_TIMEOUT_MS = 20_000;
const NEWS_CACHE_MS = 10 * 60_000;
/** Candidates for a model: scheduled medium airports this close, plus every large one. */
const CANDIDATE_MEDIUM_KM = 3500;
const CANDIDATES_MAX = 900;
/** The traffic body: up to 2000 flights by code and time. */
const TRAFFIC_BODY_BYTES = 1024 * 1024;
const TRAFFIC_WINDOW_MAX_MS = 10 * 86_400_000;
/**
 * Every city and town over 500 people (owner ruling, 2026-10-09: all cities
 * and towns; it was cities over 15,000): GeoNames' most complete list,
 * about 200,000 places, a 14 MB download kept for thirty days.
 */
const CITIES_URL = 'https://download.geonames.org/export/dump/cities500.zip';
const CITIES_FILE = 'cities500.txt';
const CITIES_TIMEOUT_MS = 180_000;
/** The worker is stopped past this, whatever it was doing. */
const EPIDEMIC_HARD_MS = EPIDEMIC_BUDGET_MS + 15_000;
/**
 * The model's own deadline sits this far under the hard stop, measured from
 * the worker's start: time enough to sum up and post a cut-short result
 * instead of none at all.
 */
const EPIDEMIC_ABORT_MARGIN_MS = 8_000;
const EPIDEMIC_CACHE_MAX = 8;
/**
 * Commuting link sets kept by their list of places: working them out over
 * 200,000 places is the one slow setup step, and the same places come back
 * whenever the question changes but the airports and towns do not.
 */
export const LINKS_CACHE_MAX = 4;
/** The roads out of each landing airport: this far, from coarse tiles. */
const AIR_ROADS_RADIUS_KM = 400;
/** Coarse tiles: the roads after landings span every continent. */
const AIR_ROADS_ZOOM = 5;
/** North America also gets primary roads, from these finer tiles. */
const AIR_ROADS_PRIMARY_ZOOM = 7;

/** North America, roughly: Alaska and Canada to Panama and the Caribbean. */
export function inNorthAmerica(point) {
  return point.lat > 7 && point.lat < 84 && point.lon > -170 && point.lon < -50;
}
/** At most this many landings in one request. */
const AIR_ROADS_MAX = 4000;
/** The rail lines round each landing airport: this far. */
const AIR_RAILS_RADIUS_KM = 200;
/** Rail lines are only in the tiles up close: the network's own zoom. */
const AIR_RAILS_ZOOM = NETWORK_TILE_ZOOM;
/**
 * At most this many fine tiles in one request, shared out by
 * chooseAirRailTiles so every region landed in gets its share. It was 400
 * (owner report, 2026-10-12: rail in Europe, the USA, Canada and Mexico
 * still not lit): a one-day scan out of Irkutsk lands at 965 airports, which
 * need 2,596 tiles for 60 km round each and 6,476 for the full 200 km, so
 * 400 kept 115 landings and left 850 out. Tiles are kept on disk thirty
 * days; with them kept, the 965 landings build in about 7 s (783,452 km of
 * rail, smaller than the roads after landing).
 */
export const AIR_RAILS_MAX_TILES = 7000;
/**
 * First every landing region's rail near its airport: the tiles this close,
 * the reach a landing starts the rail from (OUTBREAK_AIRPORT_KM), about 2 to
 * 6 tiles each; then, as the budget allows, the full AIR_RAILS_RADIUS_KM.
 */
const AIR_RAILS_CORE_KM = OUTBREAK_AIRPORT_KM;
/**
 * The landings taken in rounds: the earliest landing in each cell of this
 * many degrees first, then finer cells, then every other landing (0), each
 * round in landing order. So 30 landings in Asia before the first in Paris
 * still leave Paris its tiles (owner report, 2026-10-12: rail in Europe, the
 * USA, Canada and Mexico never lit when the outbreak started in Asia).
 */
const AIR_RAILS_CELL_ROUNDS = [30, 10, 5, 0];
/**
 * The rail after a landing slows past PLANE_ROAD_KM to this share of train
 * speed, the road rule. Proposed with the world rail (owner ruling
 * 2026-10-12): 1, so a train keeps train speed along the line; kept at the
 * road share until the owner rules.
 */
export const AIR_RAILS_ONWARD_SHARE = PLANE_ROAD_ONWARD_SHARE;

/**
 * Which landings' rail to fetch, within `maxTiles` fine tiles. The landings
 * are put in order by the cell rounds (one per region first, earliest
 * first); each in turn gets the tiles within `coreKm` if they fit, and a
 * landing that does not fit is passed over, not the end of the list. Then
 * the kept landings, in the same order, grow to `radiusKm` while tiles
 * remain. A landing whose tiles are all taken already costs nothing.
 *
 * @param {{lat: number, lon: number, hour: number}[]} landings
 * @returns {{sources: object[], skipped: number, tiles: object[]}} The kept
 *   landings in landing order, how many were left out, and the tiles.
 */
export function chooseAirRailTiles(
  landings,
  {
    maxTiles = AIR_RAILS_MAX_TILES,
    coreKm = AIR_RAILS_CORE_KM,
    radiusKm = AIR_RAILS_RADIUS_KM,
    zoom = AIR_RAILS_ZOOM,
    rounds = AIR_RAILS_CELL_ROUNDS,
  } = {},
) {
  const ordered = [...landings].sort((a, b) => a.hour - b.hour);
  const order = [];
  const placed = new Set();
  for (const deg of rounds) {
    const cells = new Set();
    for (let i = 0; i < ordered.length; i += 1) {
      if (placed.has(i)) continue;
      const d = ordered[i];
      if (deg) {
        const cell = `${Math.floor(d.lat / deg)},${Math.floor(d.lon / deg)}`;
        if (cells.has(cell)) continue;
        cells.add(cell);
      }
      placed.add(i);
      order.push(i);
    }
  }
  const tiles = new Map();
  const keyOf = (tile) => `${tile.z}/${tile.x}/${tile.y}`;
  const take = (list) => {
    const added = list.filter((tile) => !tiles.has(keyOf(tile)));
    if (tiles.size + added.length > maxTiles) return false;
    for (const tile of added) tiles.set(keyOf(tile), tile);
    return true;
  };
  const kept = order.filter((i) =>
    take(networkTiles(ordered[i], coreKm, zoom)),
  );
  for (const i of kept) take(networkTiles(ordered[i], radiusKm, zoom));
  return {
    sources: [...kept].sort((a, b) => a - b).map((i) => ordered[i]),
    skipped: ordered.length - kept.length,
    tiles: [...tiles.values()],
  };
}
/** Rail after landings kept in memory: this many answers. */
const AIR_RAILS_CACHE_MAX = 6;
/** The EPIDEMIC MODEL looks up to 40 days ahead (the box offers 2 to 30). */
const EPIDEMIC_WINDOW_MAX_MS = 40 * 86_400_000;

const HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function send(res, status, payload) {
  res.writeHead(status, HEADERS);
  res.end(JSON.stringify(payload));
}

/* ------------------------------------------------------------------------ */
/* Airports                                                                  */
/* ------------------------------------------------------------------------ */

/** One CSV line into its fields (OurAirports quotes every text field). */
export function splitCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * OurAirports' table as compact rows: only airports with a four-letter code,
 * of the large, medium and small kinds.
 */
export function parseAirportsCsv(text) {
  const lines = String(text).split(/\r?\n/);
  const head = splitCsvLine(lines.shift() || '');
  const col = (name) => head.indexOf(name);
  const at = {
    type: col('type'),
    name: col('name'),
    lat: col('latitude_deg'),
    lon: col('longitude_deg'),
    country: col('iso_country'),
    continent: col('continent'),
    city: col('municipality'),
    scheduled: col('scheduled_service'),
    icao: col('icao_code'),
    gps: col('gps_code'),
    ident: col('ident'),
    iata: col('iata_code'),
  };
  const kinds = { large_airport: 'L', medium_airport: 'M', small_airport: 'S' };
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    const f = splitCsvLine(line);
    const kind = kinds[f[at.type]];
    if (!kind) continue;
    const code = [f[at.icao], f[at.gps], f[at.ident]]
      .map((v) =>
        String(v || '')
          .trim()
          .toUpperCase(),
      )
      .find((v) => /^[A-Z]{4}$/.test(v));
    const point = validPoint(f[at.lat], f[at.lon]);
    if (!code || !point) continue;
    rows.push({
      code,
      iata: /^[A-Z]{3}$/.test(f[at.iata] || '') ? f[at.iata] : '',
      name: String(f[at.name] || '').slice(0, 80),
      city: String(f[at.city] || '').slice(0, 60),
      country: String(f[at.country] || '').slice(0, 2),
      continent: String(f[at.continent] || '').slice(0, 2),
      kind,
      scheduled: f[at.scheduled] === 'yes',
      lat: Math.round(point.lat * 1e4) / 1e4,
      lon: Math.round(point.lon * 1e4) / 1e4,
    });
  }
  return rows;
}

function airportView(row, from) {
  return {
    code: row.code,
    iata: row.iata,
    name: row.name,
    city: row.city,
    country: row.country,
    continent: row.continent || '',
    lat: row.lat,
    lon: row.lon,
    ...(from ? { km: Math.round(distanceKm(from, row)) } : {}),
  };
}

/** The airport table, loaded once per server: disk first, then OurAirports. */
export function airportTable({
  cacheDir = path.join(process.cwd(), '.gev-cache', 'outbreak'),
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  let rows = null;
  let byCode = null;
  let loading = null;
  let scheduledRows = null;
  let allScheduledRows = null;
  const file = path.join(cacheDir, 'airports-v2.json');
  const index = (list) => {
    rows = list;
    byCode = new Map();
    for (const row of list) {
      byCode.set(row.code, row);
      if (row.iata && (!byCode.has(row.iata) || row.scheduled))
        byCode.set(row.iata, row);
    }
    return rows;
  };
  const readDisk = () => {
    try {
      const stat = fs.statSync(file);
      if (now() - stat.mtimeMs > AIRPORTS_CACHE_MS) return null;
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(list) && list.length ? list : null;
    } catch {
      return null;
    }
  };
  const load = async () => {
    if (rows) return rows;
    if (loading) return loading;
    loading = (async () => {
      const disk = readDisk();
      if (disk) return index(disk);
      const response = await fetchImpl(AIRPORTS_URL, {
        signal: AbortSignal.timeout(AIRPORTS_TIMEOUT_MS),
      });
      if (!response.ok)
        throw new Error(`Airports table: HTTP ${response.status}`);
      const list = parseAirportsCsv(await response.text());
      if (!list.length) throw new Error('Airports table is empty');
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(list));
      } catch {
        /* Kept in memory only. */
      }
      return index(list);
    })().finally(() => {
      loading = null;
    });
    return loading;
  };
  return {
    load,
    async near(point, km = OUTBREAK_AIRPORT_KM) {
      const list = await load();
      return list
        .filter((row) => row.scheduled && row.kind !== 'S')
        .map((row) => ({ row, km: distanceKm(point, row) }))
        .filter((item) => item.km <= km)
        .sort((a, b) => a.km - b.km)
        .slice(0, 6)
        .map((item) => airportView(item.row, point));
    },
    async candidates(point) {
      const list = await load();
      return list
        .filter(
          (row) =>
            row.scheduled &&
            (row.kind === 'L' ||
              (row.kind === 'M' &&
                distanceKm(point, row) <= CANDIDATE_MEDIUM_KM)),
        )
        .map((row) => ({ row, km: distanceKm(point, row) }))
        .sort((a, b) => a.km - b.km)
        .slice(0, CANDIDATES_MAX)
        .map((item) => airportView(item.row));
    },
    /**
     * The table by code, its scheduled large and medium airports, and every
     * airport with scheduled passenger service of any size.
     */
    async index() {
      await load();
      if (!scheduledRows) {
        scheduledRows = rows.filter(
          (row) => row.scheduled && (row.kind === 'L' || row.kind === 'M'),
        );
        allScheduledRows = rows.filter((row) => row.scheduled);
      }
      return {
        get: (code) => byCode.get(code) || null,
        scheduled: scheduledRows,
        allScheduled: allScheduledRows,
      };
    },
    async lookup(codes) {
      await load();
      const out = {};
      for (const code of codes) {
        const row = byCode.get(code);
        if (row) out[code] = airportView(row);
      }
      return out;
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Cities and their people (GeoNames)                                        */
/* ------------------------------------------------------------------------ */

/**
 * One file out of a zip archive (stored or deflated), or null. Enough for
 * GeoNames' single-file dumps; no zip64.
 */
export function readZipEntry(buffer, name) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) return null;
  const entries = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  for (let n = 0; n < entries; n += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50)
      return null;
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const entryName = buf.toString('utf8', at + 46, at + 46 + nameLength);
    if (entryName === name) {
      if (buf.readUInt32LE(local) !== 0x04034b50) return null;
      const start =
        local +
        30 +
        buf.readUInt16LE(local + 26) +
        buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    at += 46 + nameLength + extra + comment;
  }
  return null;
}

/** GeoNames' tab-separated cities: id, name, place, country and people. */
export function parseGeonamesCities(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const f = line.split('\t');
    if (f.length < 15) continue;
    const lat = Number(f[4]);
    const lon = Number(f[5]);
    const population = Number(f[14]);
    if (!validPoint(lat, lon) || !(population > 0)) continue;
    out.push({
      id: Number(f[0]) || f[0],
      name: String(f[1] || '').slice(0, 80),
      lat: Math.round(lat * 1e4) / 1e4,
      lon: Math.round(lon * 1e4) / 1e4,
      country: String(f[8] || '').slice(0, 2),
      population,
    });
  }
  return out;
}

/** The cities table, loaded once per server: disk first, then GeoNames. */
export function cityTable({
  cacheDir = path.join(process.cwd(), '.gev-cache', 'outbreak'),
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  let rows = null;
  let loading = null;
  const file = path.join(cacheDir, 'cities500-v1.json');
  const readDisk = () => {
    try {
      const stat = fs.statSync(file);
      if (now() - stat.mtimeMs > AIRPORTS_CACHE_MS) return null;
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(list) && list.length
        ? list.map(([id, name, lat, lon, country, population]) => ({
            id,
            name,
            lat,
            lon,
            country,
            population,
          }))
        : null;
    } catch {
      return null;
    }
  };
  return {
    async load() {
      if (rows) return rows;
      if (loading) return loading;
      loading = (async () => {
        const disk = readDisk();
        if (disk) return (rows = disk);
        const response = await fetchImpl(CITIES_URL, {
          signal: AbortSignal.timeout(CITIES_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Cities: HTTP ${response.status}`);
        const zip = Buffer.from(await response.arrayBuffer());
        const text = readZipEntry(zip, CITIES_FILE);
        if (!text) throw new Error('Cities: not the expected archive');
        const list = parseGeonamesCities(text.toString('utf8'));
        if (!list.length) throw new Error('Cities: the list is empty');
        try {
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(
            file,
            JSON.stringify(
              list.map((c) => [
                c.id,
                c.name,
                c.lat,
                c.lon,
                c.country,
                c.population,
              ]),
            ),
          );
        } catch {
          /* Kept in memory only. */
        }
        return (rows = list);
      })().finally(() => {
        loading = null;
      });
      return loading;
    },
  };
}

/**
 * The commuting links as three flat arrays, so they cross a worker boundary
 * by transfer instead of a copy of 200,000 small objects: node `i`'s links
 * are `j[offsets[i] .. offsets[i + 1])` with their shares alongside.
 *
 * @param {{j: number, share: number}[][]} links By node index.
 * @returns {{offsets: Int32Array, j: Int32Array, share: Float64Array}}
 */
export function packLinks(links) {
  const n = links.length;
  const offsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1)
    offsets[i + 1] = offsets[i] + (links[i] ? links[i].length : 0);
  const m = offsets[n];
  const j = new Int32Array(m);
  const share = new Float64Array(m);
  for (let i = 0; i < n; i += 1) {
    let k = offsets[i];
    for (const link of links[i] || []) {
      j[k] = link.j;
      share[k] = link.share;
      k += 1;
    }
  }
  return { offsets, j, share };
}

/** The object form `simulateEpidemic` reads, back from the packed arrays. */
export function unpackLinks({ offsets, j, share }) {
  const n = offsets.length - 1;
  const links = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const list = [];
    for (let k = offsets[i]; k < offsets[i + 1]; k += 1)
      list.push({ j: j[k], share: share[k] });
    links[i] = list;
  }
  return links;
}

/** Packed links, or null: an array is the object form and gets packed. */
function packedLinksOf(links) {
  if (Array.isArray(links)) return packLinks(links);
  if (links?.offsets && links.j && links.share) return links;
  return null;
}

/**
 * Run the ensemble in a worker thread, stopped if it overruns. The worker
 * imports the model from the repository by its path, so this works whether or
 * not Vite bundles the server code. Commuting links ride in and out packed
 * (`packLinks`) by transfer: given none, the worker works them out and hands
 * them to `onLinks` beside the result, so the route can keep them.
 */
export function runEpidemicInWorker(
  input,
  { sourceRoot = process.cwd(), onLinks } = {},
) {
  const model = pathToFileURL(
    path.join(sourceRoot, 'src', 'outbreakEpi.mjs'),
  ).href;
  const { links: given, ...rest } = input;
  const links = packedLinksOf(given);
  // One absolute deadline for the whole call (both arms of a comparison).
  const deadlineMs = Number.isFinite(rest.deadlineMs)
    ? rest.deadlineMs
    : Date.now() + EPIDEMIC_HARD_MS - EPIDEMIC_ABORT_MARGIN_MS;
  const code = [
    "const { parentPort, workerData } = require('node:worker_threads');",
    'import(workerData.model)',
    '  .then(({ simulateEpidemic, gravityLinks }) => {',
    '    const { input, links: packed } = workerData;',
    '    let links;',
    '    if (packed) {',
    '      const { offsets, j, share } = packed;',
    '      links = new Array(offsets.length - 1);',
    '      for (let i = 0; i < links.length; i += 1) {',
    '        const list = [];',
    '        for (let k = offsets[i]; k < offsets[i + 1]; k += 1)',
    '          list.push({ j: j[k], share: share[k] });',
    '        links[i] = list;',
    '      }',
    '    } else links = gravityLinks(input.nodes);',
    '    const result = simulateEpidemic({ ...input, links });',
    '    if (packed) {',
    '      parentPort.postMessage({ ok: true, result, links: null });',
    '      return;',
    '    }',
    '    const offsets = new Int32Array(links.length + 1);',
    '    for (let i = 0; i < links.length; i += 1)',
    '      offsets[i + 1] = offsets[i] + links[i].length;',
    '    const j = new Int32Array(offsets[links.length]);',
    '    const share = new Float64Array(offsets[links.length]);',
    '    for (let i = 0, k = 0; i < links.length; i += 1)',
    '      for (const link of links[i]) {',
    '        j[k] = link.j;',
    '        share[k] = link.share;',
    '        k += 1;',
    '      }',
    '    parentPort.postMessage(',
    '      { ok: true, result, links: { offsets, j, share } },',
    '      [offsets.buffer, j.buffer, share.buffer],',
    '    );',
    '  })',
    '  .catch((error) =>',
    '    parentPort.postMessage({ ok: false, error: String((error && error.message) || error) }));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, {
      eval: true,
      workerData: { model, input: { ...rest, deadlineMs }, links },
      transferList: links
        ? [links.offsets.buffer, links.j.buffer, links.share.buffer]
        : [],
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('The epidemic model ran out of time.'));
    }, EPIDEMIC_HARD_MS);
    worker.once('message', (message) => {
      clearTimeout(timer);
      worker.terminate();
      if (message?.ok) {
        if (message.links && typeof onLinks === 'function')
          onLinks(message.links);
        resolve(message.result);
      } else reject(new Error(message?.error || 'The epidemic model failed.'));
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/* ------------------------------------------------------------------------ */
/* Road and rail networks (OpenFreeMap vector tiles of OpenStreetMap)       */
/* ------------------------------------------------------------------------ */

const NETWORK_CACHE_MS = 30 * 24 * 3_600_000;
const NETWORK_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const NETWORK_TILE_HOST = 'https://tiles.openfreemap.org/';
const NETWORK_TILE_BYTES = 8 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 20_000;
/** OpenFreeMap is a CDN: a few tiles at once is polite and quick. */
const NETWORK_TILES_AT_ONCE = 6;
/** After a failed TileJSON, no tile is asked for this long (2026-10-12). */
const NETWORK_TILEJSON_COOLOFF_MS = 2 * 60_000;
/**
 * OpenFreeMap asked us to slow down (a 429 or a 5xx, or no answer at all):
 * no tile is asked for this long, doubled each time in a row, up to the
 * most; a Retry-After of its own is kept instead (2026-10-12).
 */
const NETWORK_BACKOFF_MS = Object.freeze({ first: 30_000, most: 30 * 60_000 });

/** A Retry-After header in ms from now (seconds or a date), or null. */
export function retryAfterMs(value, nowMs = Date.now()) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}
const NETWORK_USER_AGENT =
  'gods-eye-view-outbreak/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';
/**
 * Where the coarse tiles have no rail near an outbreak location: the tiles
 * of this zoom within this far stand in for the coarse ones there (16 for
 * each), as they carry every rail line, not only the main ones.
 */
const NETWORK_RAIL_FINE = Object.freeze({ zoom: 10, radiusKm: 100 });
/** OpenMapTiles classes kept: the main roads, and main-line rail. */
const NETWORK_ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary']);

/** A vector tile's transportation lines, as [lon, lat] runs, by kind. */
export function readTransportTile(bytes, { z, x, y }) {
  let buf = Buffer.from(bytes);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  const tile = new VectorTile(new PbfReader(buf));
  const layer = tile.layers.transportation;
  // major: trunk roads; motorway apart, for the farthest level.
  const out = { motorway: [], major: [], primary: [], rail: [] };
  if (!layer) return out;
  const n = 2 ** z;
  const toLonLat = (px, py, extent) => {
    const lon = ((x + px / extent) / n) * 360 - 180;
    const t = Math.PI * (1 - (2 * (y + py / extent)) / n);
    const lat = (Math.atan(Math.sinh(t)) * 180) / Math.PI;
    return [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
  };
  for (let i = 0; i < layer.length; i += 1) {
    const feature = layer.feature(i);
    const cls = feature.properties?.class;
    const kind =
      cls === 'rail' && (feature.properties?.subclass ?? 'rail') === 'rail'
        ? 'rail'
        : NETWORK_ROAD_CLASSES.has(cls)
          ? cls === 'primary'
            ? 'primary'
            : cls === 'motorway'
              ? 'motorway'
              : 'major'
          : null;
    if (!kind || feature.type !== 2) continue;
    // Only the part inside the tile itself: a tile carries a margin of its
    // neighbours' lines, which would otherwise count every road twice.
    const inside = (p) =>
      p.x >= 0 && p.x <= layer.extent && p.y >= 0 && p.y <= layer.extent;
    for (const run of feature.loadGeometry()) {
      let line = [];
      for (let k = 0; k < run.length; k += 1) {
        const keep =
          inside(run[k]) ||
          (k > 0 && inside(run[k - 1])) ||
          (k + 1 < run.length && inside(run[k + 1]));
        if (keep) line.push(toLonLat(run[k].x, run[k].y, layer.extent));
        else if (line.length) {
          if (line.length >= 2) out[kind].push(line);
          line = [];
        }
      }
      if (line.length >= 2) out[kind].push(line);
    }
  }
  return out;
}

/**
 * Tiles of transportation lines: from memory, then disk (thirty days), then
 * OpenFreeMap (the tile address from its TileJSON, never another host).
 *
 * Owner ruling 2026-10-12 (every rail line on the globe): at most
 * NETWORK_TILES_AT_ONCE fetches at once from this store, whoever asks; the
 * world rail sweep's (`background`) wait behind the page's own. The
 * TileJSON is asked once for every tile waiting on it, not once each.
 * `cached` reads a tile's disk copy whatever its age (the sweep never
 * fetches a tile it already has), and `onFetched` hears of every tile
 * fetched, so the world rail keeps up with a refreshed tile.
 */
export function networkTileStore({
  cacheDir = path.join(process.cwd(), '.gev-cache', 'outbreak', 'net'),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  atOnce = NETWORK_TILES_AT_ONCE,
  onFetched = null,
} = {}) {
  const memory = new Map();
  const loading = new Map();
  let template = null;
  let templateAt = 0;
  let templateJob = null;
  // A failed TileJSON is not asked again before this (2026-10-12).
  let templateRetryAt = 0;
  // Told to wait: no tile is asked for before this, and the wait so far.
  let waitUntil = 0;
  let backoffMs = 0;
  let listener = onFetched;
  const fileOf = (key) => path.join(cacheDir, `${key}.json`);
  const pausedUntil = () => Math.max(waitUntil, template ? 0 : templateRetryAt);
  const slowDown = (response = null) => {
    backoffMs = Math.min(
      NETWORK_BACKOFF_MS.most,
      backoffMs ? backoffMs * 2 : NETWORK_BACKOFF_MS.first,
    );
    const asked = retryAfterMs(response?.headers?.get?.('retry-after'), now());
    waitUntil = Math.max(waitUntil, now() + (asked ?? backoffMs));
  };
  const tileUrl = async (z, x, y) => {
    const stale = !template || now() - templateAt > 24 * 3_600_000;
    if (stale && now() >= templateRetryAt) {
      templateJob ||= (async () => {
        const response = await fetchImpl(NETWORK_TILEJSON_URL, {
          headers: { 'User-Agent': NETWORK_USER_AGENT },
          signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`TileJSON HTTP ${response.status}`);
        const tiles = (await response.json())?.tiles;
        const first = Array.isArray(tiles) ? String(tiles[0] || '') : '';
        if (!first.startsWith(NETWORK_TILE_HOST) || !first.includes('{z}'))
          throw new Error('Unexpected tile address');
        template = first;
        templateAt = now();
      })()
        .catch((error) => {
          // Every tile waiting on it fails at once, and none asks again
          // before the cool-off is over (2026-10-12).
          templateRetryAt = now() + NETWORK_TILEJSON_COOLOFF_MS;
          throw error;
        })
        .finally(() => {
          templateJob = null;
        });
      try {
        await templateJob;
      } catch (error) {
        // A day-old address is kept while a fresh one cannot be had.
        if (!template) throw error;
      }
    }
    if (!template) throw new Error('The tile address is not known yet.');
    return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  };
  // Fetch slots: the page's requests first, the sweep's after.
  let busy = 0;
  const waiting = { front: [], back: [] };
  const slot = (background) =>
    new Promise((resolve) => {
      if (busy < atOnce) {
        busy += 1;
        resolve();
      } else (background ? waiting.back : waiting.front).push(resolve);
    });
  const release = () => {
    const next = waiting.front.shift() || waiting.back.shift();
    if (next) next();
    else busy -= 1;
  };
  const readDisk = (key, maxAgeMs) => {
    try {
      const file = fileOf(key);
      if (now() - fs.statSync(file).mtimeMs <= maxAgeMs)
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* Not kept yet. */
    }
    return null;
  };
  return {
    /** Tell `fn` of every tile fetched from now on: fn(tile, lines). */
    onFetched(fn) {
      listener = fn;
    },
    /**
     * Until when no tile is asked for (ms since the epoch; past when none):
     * a failed TileJSON's cool-off, or OpenFreeMap's ask to wait.
     */
    pausedUntil,
    /** A tile's lines from memory or disk, however old; null if never kept. */
    cached(tile) {
      const key = `omt3-${tile.z}-${tile.x}-${tile.y}`;
      return memory.get(key) || readDisk(key, Infinity);
    },
    /** The lines of one tile, or null when it could not be fetched. */
    async lines(tile, { background = false } = {}) {
      const key = `omt3-${tile.z}-${tile.x}-${tile.y}`;
      if (memory.has(key)) return memory.get(key);
      if (loading.has(key)) return loading.get(key);
      const job = (async () => {
        const kept = readDisk(key, NETWORK_CACHE_MS);
        if (kept) return kept;
        // Told to wait: nothing is asked for meanwhile, whoever asks.
        if (pausedUntil() > now()) return null;
        await slot(background);
        try {
          if (pausedUntil() > now()) return null;
          const url = await tileUrl(tile.z, tile.x, tile.y);
          let response;
          try {
            response = await fetchImpl(url, {
              headers: { 'User-Agent': NETWORK_USER_AGENT },
              signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
            });
          } catch {
            // No answer at all: the host's trouble, not the tile's.
            slowDown();
            return null;
          }
          let lines;
          if (response.status === 204 || response.status === 404) {
            // An empty tile is kept too, so it is not asked for again.
            lines = { motorway: [], major: [], primary: [], rail: [] };
          } else {
            if (response.status === 429 || response.status >= 500) {
              slowDown(response);
              return null;
            }
            if (!response.ok) return null;
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > NETWORK_TILE_BYTES) return null;
            lines = readTransportTile(bytes, tile);
          }
          backoffMs = 0;
          try {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(fileOf(key), JSON.stringify(lines));
          } catch {
            /* Kept in memory only. */
          }
          try {
            listener?.(tile, lines);
          } catch {
            /* The listener's trouble is its own. */
          }
          return lines;
        } catch {
          return null;
        } finally {
          release();
        }
      })().finally(() => loading.delete(key));
      loading.set(key, job);
      const lines = await job;
      if (lines) {
        memory.set(key, lines);
        while (memory.size > 600) memory.delete(memory.keys().next().value);
      }
      return lines;
    },
  };
}

/**
 * The road or rail network round a point: the tiles in reach, fetched a few
 * at a time, their lines joined and measured from the nearest point
 * (outbreakNetwork.mjs). Primary roads only from tiles near the point.
 */
/**
 * Build a network in a worker thread: a continent of roads takes seconds,
 * and the dev server must keep answering meanwhile. The points travel as one
 * packed array (moved, not copied).
 */
export function buildNetworkInWorker(
  lines,
  point,
  options,
  { sourceRoot = process.cwd() } = {},
) {
  let total = 0;
  for (const line of lines) total += line.length;
  const coords = new Float64Array(total * 2);
  const offsets = new Int32Array(lines.length + 1);
  let at = 0;
  lines.forEach((line, i) => {
    offsets[i] = at;
    for (const [x, y] of line) {
      coords[at * 2] = x;
      coords[at * 2 + 1] = y;
      at += 1;
    }
  });
  offsets[lines.length] = at;
  const model = pathToFileURL(
    path.join(sourceRoot, 'src', 'outbreakNetwork.mjs'),
  ).href;
  const code = [
    "const { parentPort, workerData } = require('node:worker_threads');",
    'import(workerData.model).then(({ buildTransportNetwork }) => {',
    '  const { coords, offsets, point, options } = workerData;',
    '  const lines = [];',
    '  for (let i = 0; i + 1 < offsets.length; i += 1) {',
    '    const line = [];',
    '    for (let k = offsets[i]; k < offsets[i + 1]; k += 1) line.push([coords[k * 2], coords[k * 2 + 1]]);',
    '    lines.push(line);',
    '  }',
    '  parentPort.postMessage({ ok: true, network: buildTransportNetwork(lines, point, options) });',
    '}).catch((error) => parentPort.postMessage({ ok: false, error: String((error && error.message) || error) }));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, {
      eval: true,
      workerData: { model, coords, offsets, point, options },
      transferList: [coords.buffer, offsets.buffer],
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('The road network took too long.'));
    }, 120_000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      worker.terminate();
      if (message?.ok) resolve(message.network);
      else reject(new Error(message?.error || 'The road network failed.'));
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Built networks kept on disk thirty days: one build per place and level. */
function builtNetworkCache(
  cacheDir = path.join(process.cwd(), '.gev-cache', 'outbreak', 'net-built'),
) {
  const fileOf = (key) => path.join(cacheDir, `${key}.json`);
  return {
    read(key) {
      try {
        const file = fileOf(key);
        if (Date.now() - fs.statSync(file).mtimeMs > NETWORK_CACHE_MS)
          return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
    write(key, value) {
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(fileOf(key), JSON.stringify(value));
      } catch {
        /* Kept in memory only. */
      }
    },
    /**
     * Remove every kept build whose name starts with `prefix` and not with
     * `keep` (2026-10-12: the world rail answers of an older world build,
     * about 7 MB each, are never read again).
     */
    prune(prefix, keep) {
      let names = [];
      try {
        names = fs.readdirSync(cacheDir);
      } catch {
        return 0;
      }
      let removed = 0;
      for (const name of names) {
        if (!name.startsWith(prefix) || name.startsWith(keep)) continue;
        try {
          fs.rmSync(path.join(cacheDir, name), { force: true });
          removed += 1;
        } catch {
          /* Left for the next build. */
        }
      }
      return removed;
    },
  };
}

/** About how many bytes a built network answer holds (its points). */
export function networkAnswerBytes(result) {
  let numbers = 0;
  const count = (lists) => {
    for (const flat of lists || []) numbers += flat?.length || 0;
  };
  const network = result?.network;
  for (const lists of Object.values(network?.bands || {})) count(lists);
  count(network?.unreached);
  return 1024 + numbers * 8;
}
/** The rail and road answers kept in memory: at most this many bytes. */
const NETWORKS_KEPT_BYTES = 64 * 1024 * 1024;

export async function transportNetwork(
  point,
  mode,
  store,
  {
    level = 1,
    build = async (lines, at, options) =>
      buildTransportNetwork(lines, at, options),
  } = {},
) {
  // Rail stays the first level: the tiles carry rail lines only up close.
  const levels =
    mode === 'rail'
      ? NETWORK_ROAD_LEVELS.slice(0, 1).map((l) => ({
          ...l,
          radiusKm: NETWORK_RADIUS_KM.rail,
        }))
      : NETWORK_ROAD_LEVELS.slice(0, Math.max(1, Math.min(3, level)));
  const lines = [];
  // Rail: each tile's lines, so finer tiles can stand in for some of them.
  const railByTile = new Map();
  let tileCount = 0;
  let failed = 0;
  for (const step of levels) {
    const tiles = networkTiles(point, step.radiusKm, step.zoom);
    tileCount += tiles.length;
    for (let i = 0; i < tiles.length; i += NETWORK_TILES_AT_ONCE) {
      const batch = tiles.slice(i, i + NETWORK_TILES_AT_ONCE);
      const results = await Promise.all(batch.map((tile) => store.lines(tile)));
      results.forEach((found, k) => {
        if (!found) {
          failed += 1;
          return;
        }
        if (mode === 'rail') {
          railByTile.set(`${batch[k].x}/${batch[k].y}`, found.rail);
          lines.push(...found.rail);
          return;
        }
        // Past the first level, only lines reaching beyond the finer ones.
        const beyond = (line) =>
          step.innerKm === 0 ||
          line.some(
            ([lon, lat]) =>
              distanceKm(point, { lat, lon }) > step.innerKm * 0.95,
          );
        // Motorways at every level; trunk roads up to level 2; the farthest
        // level motorways only, or a continent of trunk roads swamps it.
        for (const line of found.motorway || [])
          if (beyond(line)) lines.push(line);
        if (step.trunk !== false)
          for (const line of found.major) if (beyond(line)) lines.push(line);
        if (step.level === 1 && batch[k].km <= NETWORK_PRIMARY_KM)
          lines.push(...found.primary);
      });
    }
  }
  const options = {
    startKm: NETWORK_START_KM[mode] ?? NETWORK_START_KM.road,
    joinKm: NETWORK_JOIN_KM[mode] ?? NETWORK_JOIN_KM.road,
  };
  let network = await build(lines, point, options);
  // No rail within reach in the coarse tiles: they carry main lines only.
  // Near the location, finer tiles stand in for them (owner report,
  // 2026-10-12: Saint John NB had no rail; its nearest main line in the
  // coarse tiles is 98 km off, its own line 0.4 km in the finer ones).
  if (mode === 'rail' && !network) {
    const inner = networkTiles(
      point,
      NETWORK_RAIL_FINE.radiusKm,
      NETWORK_TILE_ZOOM,
    );
    const shift = 2 ** (NETWORK_RAIL_FINE.zoom - NETWORK_TILE_ZOOM);
    const fine = inner.flatMap((tile) =>
      Array.from({ length: shift * shift }, (_, i) => ({
        z: NETWORK_RAIL_FINE.zoom,
        x: tile.x * shift + (i % shift),
        y: tile.y * shift + Math.floor(i / shift),
      })),
    );
    tileCount += fine.length;
    const finer = [];
    for (let i = 0; i < fine.length; i += NETWORK_TILES_AT_ONCE) {
      const batch = fine.slice(i, i + NETWORK_TILES_AT_ONCE);
      for (const found of await Promise.all(
        batch.map((tile) => store.lines(tile)),
      )) {
        if (!found) failed += 1;
        else finer.push(...found.rail);
      }
    }
    if (finer.length) {
      const replaced = new Set(inner.map((tile) => `${tile.x}/${tile.y}`));
      const coarse = [...railByTile]
        .filter(([key]) => !replaced.has(key))
        .flatMap(([, found]) => found);
      network = await build([...finer, ...coarse], point, options);
    }
  }
  const last = levels[levels.length - 1];
  return {
    mode,
    level: last.level,
    lastLevel: mode === 'rail' || last.level >= NETWORK_ROAD_LEVELS.length,
    network,
    tiles: tileCount,
    failedTiles: failed,
    radiusKm: last.radiusKm,
    source: 'OpenStreetMap (OpenFreeMap tiles)',
  };
}

/**
 * The finer (zoom-10) rail lines within `radiusKm` of each point, from
 * the tile store a few at once, at most `maxTiles` tiles, the points taken
 * in order (owner ruling 2026-10-12: the world rail keeps the finer
 * branch lines near each source).
 */
export async function fineRailLines(
  points,
  store,
  {
    radiusKm = NETWORK_RAIL_FINE.radiusKm,
    maxTiles = Infinity,
    zoom = NETWORK_RAIL_FINE.zoom,
  } = {},
) {
  const tiles = new Map();
  let left = 0;
  for (const point of points) {
    const near = networkTiles(point, radiusKm, zoom);
    const added = near.filter((t) => !tiles.has(`${t.x}/${t.y}`));
    if (tiles.size + added.length > maxTiles) {
      left += 1;
      continue;
    }
    for (const tile of added) tiles.set(`${tile.x}/${tile.y}`, tile);
  }
  const list = [...tiles.values()];
  const lines = [];
  let failed = 0;
  for (let i = 0; i < list.length; i += NETWORK_TILES_AT_ONCE) {
    const batch = list.slice(i, i + NETWORK_TILES_AT_ONCE);
    for (const found of await Promise.all(
      batch.map((tile) => store.lines(tile)),
    )) {
      if (!found) failed += 1;
      else lines.push(...(found.rail || []));
    }
  }
  return { lines, tiles: list.length, failed, left };
}

/**
 * The rail reach from one outbreak location along the WORLD rail network
 * (owner ruling 2026-10-12: every rail line on the globe), with the finer
 * lines within NETWORK_RAIL_FINE.radiusKm laid over it: every source keeps
 * the branch lines the coarse tiles leave out. The answer has
 * transportNetwork's shape; `world` says it is the whole world's rail,
 * with no radius.
 */
export async function worldRailNetwork(point, store, railWorld) {
  const fine = await fineRailLines([point], store);
  const answer = await railWorld.task({
    kind: 'network',
    point,
    overlay: fine.lines,
    startKm: NETWORK_START_KM.rail,
  });
  // The world's own zoom-8 tiles still missing within the old 500 km
  // (2026-10-12): failed tiles too, so the answer is not kept as whole.
  const worldMissing =
    railWorld.missingNear?.([point], NETWORK_RADIUS_KM.rail) || 0;
  return {
    mode: 'rail',
    level: 1,
    lastLevel: true,
    world: true,
    network: answer.network,
    tiles: fine.tiles + worldMissing,
    failedTiles: fine.failed + worldMissing,
    worldMissingTiles: worldMissing,
    radiusKm: null,
    builtAt: railWorld.build()?.builtAt ?? null,
    source: 'OpenStreetMap (OpenFreeMap tiles)',
  };
}

/* ------------------------------------------------------------------------ */
/* Flight history (OpenSky)                                                  */
/* ------------------------------------------------------------------------ */

async function openSkyDepartures(airport, beginS, endS, token, fetchImpl) {
  const flights = [];
  for (let from = beginS; from < endS; from += OPENSKY_WINDOW_S) {
    const to = Math.min(endS, from + OPENSKY_WINDOW_S);
    const url = `${OPENSKY_DEPARTURES_URL}?airport=${encodeURIComponent(airport)}&begin=${from}&end=${to}`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(OPENSKY_TIMEOUT_MS),
    });
    if (response.status === 404) continue; // no flights in that window
    if (!response.ok) {
      const error = new Error(`OpenSky answered HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const list = await response.json().catch(() => []);
    if (Array.isArray(list)) flights.push(...list);
  }
  return flights;
}

/**
 * The flights out of the outbreak airports, then the connecting flights out
 * of the airports they landed at (one hop on), with both ends placed.
 */
export async function outbreakFlightHistory({
  airports,
  beginS,
  endS,
  token,
  table,
  fetchImpl = globalThis.fetch,
}) {
  const raw = [];
  for (const code of airports)
    for (const f of await openSkyDepartures(
      code,
      beginS,
      endS,
      token,
      fetchImpl,
    ))
      raw.push({ ...f, hop: 1 });
  const firstLanding = new Map();
  for (const f of raw) {
    const to = String(f.estArrivalAirport || '').toUpperCase();
    if (!to || airports.includes(to) || !Number.isFinite(f.lastSeen)) continue;
    const known = firstLanding.get(to);
    if (known === undefined || f.lastSeen < known)
      firstLanding.set(to, f.lastSeen);
  }
  const onward = [...firstLanding.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, CONNECTING_AIRPORTS_MAX);
  for (const [code, landedS] of onward) {
    if (landedS >= endS) continue;
    try {
      for (const f of await openSkyDepartures(
        code,
        landedS,
        endS,
        token,
        fetchImpl,
      ))
        raw.push({ ...f, hop: 2 });
    } catch {
      /* One airport refused: the others still count. */
    }
  }
  const codes = new Set();
  for (const f of raw) {
    if (f.estDepartureAirport)
      codes.add(String(f.estDepartureAirport).toUpperCase());
    if (f.estArrivalAirport)
      codes.add(String(f.estArrivalAirport).toUpperCase());
  }
  const places = await table.lookup([...codes]);
  const flights = [];
  for (const f of raw) {
    const from = places[String(f.estDepartureAirport || '').toUpperCase()];
    const to = places[String(f.estArrivalAirport || '').toUpperCase()];
    if (!from || !to || from.code === to.code) continue;
    if (!Number.isFinite(f.firstSeen) || !Number.isFinite(f.lastSeen)) continue;
    flights.push({
      from,
      to,
      departMs: f.firstSeen * 1000,
      arriveMs: f.lastSeen * 1000,
      hop: f.hop,
      callsign: String(f.callsign || '')
        .trim()
        .slice(0, 12),
      source: 'OpenSky flight history',
    });
  }
  return flights;
}

/* ------------------------------------------------------------------------ */
/* Surroundings (Overpass)                                                   */
/* ------------------------------------------------------------------------ */

/** The Overpass question: stations, rail speeds, and water traffic. */
export function surroundingsQuery(point) {
  const rail = `${RAIL_REACH_KM * 1000},${point.lat},${point.lon}`;
  const water = `${BOAT_REACH_KM * 1000},${point.lat},${point.lon}`;
  return [
    '[out:json][timeout:25];',
    `node(around:${rail})["railway"="station"];out tags qt 40;`,
    `way(around:${rail})["railway"="rail"]["maxspeed"];out tags qt 400;`,
    `(nwr(around:${water})["amenity"="ferry_terminal"];`,
    `way(around:${water})["route"="ferry"];`,
    `nwr(around:${water})["leisure"="marina"];`,
    `nwr(around:${water})["landuse"="harbour"];`,
    `nwr(around:${water})["harbour"="yes"];);out tags qt 40;`,
  ].join('');
}

function maxspeedKmh(value) {
  const match = String(value || '').match(/^(\d+(?:\.\d+)?)\s*(mph)?/i);
  if (!match) return null;
  const n = Number(match[1]) * (match[2] ? 1.609 : 1);
  return n > 5 && n < 450 ? n : null;
}

/** What the Overpass answer says about rail and water near the point. */
export function readSurroundings(elements) {
  let stations = 0;
  let waterPlaces = 0;
  const speeds = [];
  for (const element of Array.isArray(elements) ? elements : []) {
    const tags = element?.tags || {};
    if (tags.railway === 'station') stations += 1;
    else if (tags.railway === 'rail') {
      const kmh = maxspeedKmh(tags.maxspeed);
      if (kmh) speeds.push(kmh);
    } else if (
      tags.amenity === 'ferry_terminal' ||
      tags.route === 'ferry' ||
      tags.leisure === 'marina' ||
      tags.landuse === 'harbour' ||
      tags.harbour === 'yes'
    )
      waterPlaces += 1;
  }
  const trainKmh = speeds.length
    ? Math.round(speeds.reduce((sum, v) => sum + v, 0) / speeds.length)
    : null;
  return {
    rail: stations > 0,
    stations,
    trainKmh,
    railSpeedSamples: speeds.length,
    water: waterPlaces > 0,
    waterPlaces,
  };
}

/* ------------------------------------------------------------------------ */
/* Global media search (GDELT)                                               */
/* ------------------------------------------------------------------------ */

function quoteTerm(value) {
  const term = String(value || '')
    .replace(/["()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return term ? (term.includes(' ') ? `"${term}"` : term) : '';
}

/** GDELT's query: any of the places, with the outbreak words. */
export function outbreakNewsQuery(places, keywords) {
  const names = [
    ...new Set(places.map((p) => quoteTerm(String(p).split(',')[0]))),
  ]
    .filter((p) => p.length > 2)
    .slice(0, 8);
  const topic = quoteTerm(keywords);
  const words = topic
    ? `(${topic} OR outbreak OR epidemic OR quarantine)`
    : '(outbreak OR epidemic OR virus OR infection OR quarantine)';
  if (!names.length) return '';
  const where = names.length === 1 ? names[0] : `(${names.join(' OR ')})`;
  return `${where} ${words}`;
}

/* ------------------------------------------------------------------------ */
/* The routes                                                                */
/* ------------------------------------------------------------------------ */

function admitGet(req, res, allowedHosts) {
  if (req.method !== 'GET') {
    send(res, 405, { error: 'Method not allowed' });
    return false;
  }
  const site = String(
    req.headers?.['sec-fetch-site'] ?? 'same-origin',
  ).toLowerCase();
  if (
    !servedRequestOrigin(req, allowedHosts) ||
    (site !== 'same-origin' && site !== 'none')
  ) {
    send(res, 403, { error: 'Same-origin requests only' });
    return false;
  }
  return true;
}

function pointFrom(params) {
  return validPoint(params.get('lat'), params.get('lon'));
}

/**
 * The scan airports the world list does not hold yet, resolved through
 * `view`. Codes are compared after resolving: an IATA code (YYZ) names the
 * same airport as its ICAO code (CYYZ), and comparing the raw codes added it
 * a second time as its own place. Pure.
 */
export function scanExtraAirports(known, codes, view) {
  const seen = new Set(known.map((a) => a.code));
  const extra = [];
  for (const code of new Set(codes)) {
    const airport = view(code);
    if (!airport || seen.has(airport.code)) continue;
    seen.add(airport.code);
    extra.push(airport);
  }
  return extra;
}

function codesFrom(value, max = 40) {
  return [
    ...new Set(
      String(value || '')
        .toUpperCase()
        .split(/[\s,;]+/)
        .filter((code) => /^[A-Z0-9]{3,4}$/.test(code)),
    ),
  ].slice(0, max);
}

export function outbreakProxy({
  fetchImpl,
  table = airportTable(),
  cities = cityTable(),
  runEpidemic = runEpidemicInWorker,
  tokenFor = getOpenSkyToken,
  overpass = fetchOverpassPayload,
  networkStore = networkTileStore(),
  buildNetwork = buildNetworkInWorker,
  builtNetworks = builtNetworkCache(),
  railWorld: railWorldOption = null,
} = {}) {
  const fetcher = (...args) => (fetchImpl || globalThis.fetch)(...args);
  // EVERY RAIL LINE ON THE GLOBE (owner ruling 2026-10-12): `true` makes
  // the world rail job on this proxy's tile store (the app does; tests pass
  // their own job or none). Started by the first outbreak request.
  const railWorld =
    railWorldOption === true
      ? railWorldJob({
          tileStore: networkStore,
          log: (line) => console.log(`[outbreak] ${line}`),
        })
      : railWorldOption || null;
  if (railWorld && typeof networkStore?.onFetched === 'function')
    networkStore.onFetched((tile, lines) => railWorld.noteTile(tile, lines));
  const railWorldStart = (points = []) => {
    try {
      railWorld?.start(points);
    } catch {
      /* The world rail is a background job: it never fails a request. */
    }
  };
  const allow = makeRateLimiter({ windowMs: 60_000, max: 40, globalMax: 80 });
  const allowFlights = makeRateLimiter({
    windowMs: 60_000,
    max: 4,
    globalMax: 8,
  });
  const allowTraffic = makeRateLimiter({
    windowMs: 60_000,
    max: 10,
    globalMax: 20,
  });
  // The rail after landings is asked in the same refresh as the roads after
  // landings and the traffic: its own budget, so neither starves it.
  const allowAirRails = makeRateLimiter({
    windowMs: 60_000,
    max: 10,
    globalMax: 20,
  });
  const allowEpidemic = makeRateLimiter({
    windowMs: 60_000,
    max: 4,
    globalMax: 6,
  });
  const epidemics = new Map();
  /** Questions being answered right now, by the same key: asked once. */
  const inFlight = new Map();
  /**
   * Commuting links by the list of places they were worked out for, packed
   * (`packLinks`), newest last; the tables are told apart by identity.
   */
  const linksKept = new Map();
  /** Rail routes by their places, build and speed, as many as the links. */
  const railKept = new Map();
  const tableIds = new WeakMap();
  let tablesSeen = 0;
  const tableId = (rows) => {
    if (!tableIds.has(rows)) tableIds.set(rows, (tablesSeen += 1));
    return tableIds.get(rows);
  };
  /** The GeoNames fallback: one empty list, so its links are kept too. */
  const noCities = [];
  let worldMemo = null;
  /** Every scheduled airport and its normal daily routes, once per table. */
  const world = (index) => {
    if (worldMemo?.rows === index.allScheduled) return worldMemo;
    const airports = index.allScheduled.map((row) => ({
      ...airportView(row),
      code: row.code,
      kind: row.kind,
    }));
    const byFrom = new Map();
    for (const route of worldAirRoutes(airports, index.scheduled)) {
      if (!byFrom.has(route.from)) byFrom.set(route.from, []);
      byFrom.get(route.from).push(route);
    }
    worldMemo = { rows: index.allScheduled, airports, byFrom };
    return worldMemo;
  };
  const allowNews = makeRateLimiter({
    windowMs: 60_000,
    max: 6,
    globalMax: 10,
  });
  const news = new Map();
  const surroundings = new Map();
  const networks = new Map();
  // The answers kept in memory, by their bytes too (2026-10-12: a world
  // rail answer is about 7 MB), and the world build they were last for.
  const networkBytes = new Map();
  let networkBytesTotal = 0;
  let networksWorldBuild = null;
  const keepNetwork = (key, result) => {
    if (networks.has(key)) {
      networkBytesTotal -= networkBytes.get(key) || 0;
      networks.delete(key);
    }
    const bytes = networkAnswerBytes(result);
    networks.set(key, result);
    networkBytes.set(key, bytes);
    networkBytesTotal += bytes;
    while (
      networks.size > 20 ||
      (networks.size > 1 && networkBytesTotal > NETWORKS_KEPT_BYTES)
    ) {
      const oldest = networks.keys().next().value;
      networkBytesTotal -= networkBytes.get(oldest) || 0;
      networkBytes.delete(oldest);
      networks.delete(oldest);
    }
  };
  /** A new world build: the answers of the older ones go, kept or on disk. */
  const forgetOlderWorldAnswers = (builtAt) => {
    if (builtAt === networksWorldBuild) return;
    networksWorldBuild = builtAt;
    for (const key of [...networks.keys()])
      if (key.includes('|world-') && !key.endsWith(`|world-${builtAt}`)) {
        networkBytesTotal -= networkBytes.get(key) || 0;
        networkBytes.delete(key);
        networks.delete(key);
      }
    builtNetworks.prune?.(
      'rail4-world-',
      `rail4-world-v${RAIL_WORLD_VERSION}-${builtAt}-`,
    );
  };
  const airRoads = new Map();
  const airRails = new Map();

  /**
   * POST /api/outbreak/traffic: the air traffic that carries the outbreak
   * beyond the scan (simulateAirTraffic), worked out here where the world's
   * airports are. The body is the scan's flights by airport code and time.
   */
  async function handleTraffic(req, res, allowedHosts) {
    const admission = admitLlmRequestFrom(req, allowedHosts);
    if (!admission.ok) {
      send(res, admission.status, { error: admission.error });
      return;
    }
    if (!allowTraffic(clientKey(req))) {
      send(res, 429, { error: 'Too many requests. Wait a minute.' });
      return;
    }
    let body;
    try {
      body = JSON.parse(
        (await readRequestBody(req, TRAFFIC_BODY_BYTES)) || '{}',
      );
    } catch {
      send(res, 400, { error: 'Malformed request body' });
      return;
    }
    const startMs = Number(body?.startMs);
    const untilMs = Number(body?.untilMs);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(untilMs) ||
      !(startMs < untilMs) ||
      untilMs - startMs > TRAFFIC_WINDOW_MAX_MS
    ) {
      send(res, 400, { error: 'A window of at most 10 days is needed.' });
      return;
    }
    let index;
    try {
      index = await table.index();
    } catch (error) {
      send(res, 502, {
        error: `The airport list did not load: ${error.message}`,
      });
      return;
    }
    const place = (code) => {
      const row = index.get(String(code || '').toUpperCase());
      return row ? airportView(row) : null;
    };
    const flights = [];
    for (const raw of (Array.isArray(body?.flights) ? body.flights : []).slice(
      0,
      2000,
    )) {
      const from = place(raw?.from);
      const to = place(raw?.to);
      const departMs = Number(raw?.departMs);
      const arriveMs = Number(raw?.arriveMs);
      if (!from || !to || !(departMs < arriveMs)) continue;
      flights.push({
        from,
        to,
        departMs,
        arriveMs,
        hop: raw?.hop === 2 ? 2 : 1,
      });
    }
    const outbreakAirports = codesFrom(
      (body?.outbreakAirports || []).join(','),
      10,
    ).filter((code) => index.get(code));
    const result = simulateAirTraffic({
      flights,
      outbreakAirports,
      airport: (code) => {
        const row = index.get(code);
        return row ? { ...airportView(row), kind: row.kind } : null;
      },
      airports: index.scheduled,
      startMs,
      untilMs,
      infectedAfterHours:
        body?.infectedAfterHours === undefined
          ? undefined
          : Number(body.infectedAfterHours),
    });
    send(res, 200, packTraffic(result, startMs));
  }

  /**
   * POST /api/outbreak/epidemic: the EPIDEMIC MODEL. The body is the scan
   * (window, outbreak airports and locations, the scan's flights) and the
   * profile; the answer is the ensemble (simulateEpidemic) plus the effective
   * distance ranking and where the people came from.
   */
  /**
   * POST /api/outbreak/air-roads (owner ruling, 2026-10-09): instead of a
   * circle round each airport the outbreak lands at, the motorways and trunk
   * roads out of it in every direction, lit green from its landing hour.
   * One network for every landing: each stretch lit by whichever reaches it
   * first. Body: {destinations: [{code, lat, lon, hour}], speedKmh}.
   *
   * POST /api/outbreak/air-rails: the same body, for the rail lines round
   * each landing airport (mode 'rail'), at train speed: airRailsAnswer.
   */
  async function handleAirLines(req, res, allowedHosts, mode = 'road') {
    const admission = admitLlmRequestFrom(req, allowedHosts);
    if (!admission.ok) {
      send(res, admission.status, { error: admission.error });
      return;
    }
    if (!(mode === 'rail' ? allowAirRails : allowTraffic)(clientKey(req))) {
      send(res, 429, { error: 'Too many requests. Wait a minute.' });
      return;
    }
    let body;
    try {
      body = JSON.parse(
        (await readRequestBody(req, TRAFFIC_BODY_BYTES)) || '{}',
      );
    } catch {
      send(res, 400, { error: 'Malformed request body' });
      return;
    }
    const sources = (Array.isArray(body?.destinations) ? body.destinations : [])
      .slice(0, AIR_ROADS_MAX)
      .map((d) => {
        const point = validPoint(d?.lat, d?.lon);
        const hour = Number(d?.hour);
        return point && Number.isFinite(hour) && hour >= 0
          ? { ...point, hour: Math.round(hour * 10) / 10 }
          : null;
      })
      .filter(Boolean);
    if (!sources.length) {
      send(res, 400, { error: 'At least one landing is needed.' });
      return;
    }
    if (mode === 'rail') {
      await airRailsAnswer(res, sources, body);
      return;
    }
    const speedKmh = Math.max(1, Math.min(1000, Number(body?.speedKmh) || 100));
    const key = JSON.stringify([
      speedKmh,
      sources.map((d) => [d.lat.toFixed(2), d.lon.toFixed(2), d.hour]),
    ]);
    const kept = airRoads.get(key);
    if (kept) {
      send(res, 200, kept);
      return;
    }
    // Every coarse tile within reach of any landing, once: motorways and
    // trunk roads. Round North American landings also the finer tiles'
    // primary roads (owner ruling, 2026-10-09): many highways there are
    // primary, and without them the green roads showed gaps.
    const tiles = new Map();
    for (const source of sources) {
      for (const tile of networkTiles(
        source,
        AIR_ROADS_RADIUS_KM,
        AIR_ROADS_ZOOM,
      ))
        tiles.set(`${tile.z}/${tile.x}/${tile.y}`, { tile, primary: false });
      if (inNorthAmerica(source))
        for (const tile of networkTiles(
          source,
          AIR_ROADS_RADIUS_KM,
          AIR_ROADS_PRIMARY_ZOOM,
        ))
          tiles.set(`${tile.z}/${tile.x}/${tile.y}`, { tile, primary: true });
    }
    const list = [...tiles.values()];
    const lines = [];
    let failed = 0;
    for (let i = 0; i < list.length; i += 6) {
      const batch = list.slice(i, i + 6);
      const found = await Promise.all(
        batch.map(({ tile }) => networkStore.lines(tile)),
      );
      found.forEach((one, k) => {
        if (!one) failed += 1;
        else if (batch[k].primary) lines.push(...one.primary);
        else lines.push(...(one.motorway || []), ...one.major);
      });
    }
    let network = null;
    try {
      network = await buildNetwork(lines, sources[0], {
        sources,
        timing: {
          speedKmh,
          fastKm: PLANE_ROAD_KM,
          onwardShare: PLANE_ROAD_ONWARD_SHARE,
        },
        startKm: OUTBREAK_AIRPORT_KM,
        joinKm: NETWORK_JOIN_KM.road,
      });
    } catch (error) {
      send(res, 503, { error: error.message || 'The roads did not build.' });
      return;
    }
    const answer = {
      network,
      landings: sources.length,
      tiles: list.length,
      failedTiles: failed,
      radiusKm: AIR_ROADS_RADIUS_KM,
    };
    if (!failed) {
      airRoads.set(key, answer);
      while (airRoads.size > 6) airRoads.delete(airRoads.keys().next().value);
    }
    send(res, 200, answer);
  }

  /**
   * The rail lines round every landing airport (owner report, 2026-10-12:
   * rail in Europe and North America never lit after the outbreak flew
   * there; only the roads after landing did). Fine tiles only, as the tiles
   * carry rail only up close; each stretch lit by whichever landing reaches
   * it first, timed like the roads after landing at train speed. Up to
   * AIR_RAILS_MAX_TILES tiles, shared out by chooseAirRailTiles; the
   * landings left out are counted as skippedLandings, and those with no rail
   * within OUTBREAK_AIRPORT_KM start nothing (landings less seededLandings).
   */
  async function airRailsAnswer(res, landings, body) {
    const speedKmh = Math.max(1, Math.min(1000, Number(body?.speedKmh) || 60));
    const ordered = [...landings].sort((a, b) => a.hour - b.hour);
    railWorldStart(ordered.slice(0, 20));
    const worldBuild = railWorld?.ready() ? railWorld.build() : null;
    const key = JSON.stringify([
      'rail',
      speedKmh,
      worldBuild ? `world-${worldBuild.builtAt}` : 'tiles',
      ordered.map((d) => [d.lat.toFixed(2), d.lon.toFixed(2), d.hour]),
    ]);
    const kept = airRails.get(key);
    if (kept) {
      send(res, 200, kept);
      return;
    }
    if (worldBuild) {
      await airRailsWorldAnswer(res, ordered, speedKmh, key);
      return;
    }
    const {
      sources,
      skipped: skippedLandings,
      tiles: list,
    } = chooseAirRailTiles(ordered);
    const lines = [];
    let failed = 0;
    for (let i = 0; i < list.length; i += NETWORK_TILES_AT_ONCE) {
      const batch = list.slice(i, i + NETWORK_TILES_AT_ONCE);
      const found = await Promise.all(
        batch.map((tile) => networkStore.lines(tile)),
      );
      for (const one of found) {
        if (!one) failed += 1;
        else lines.push(...(one.rail || []));
      }
    }
    let network = null;
    try {
      network = sources.length
        ? await buildNetwork(lines, sources[0], {
            sources,
            timing: {
              speedKmh,
              fastKm: PLANE_ROAD_KM,
              onwardShare: AIR_RAILS_ONWARD_SHARE,
            },
            startKm: OUTBREAK_AIRPORT_KM,
            joinKm: NETWORK_JOIN_KM.rail,
          })
        : null;
    } catch (error) {
      send(res, 503, { error: error.message || 'The rail did not build.' });
      return;
    }
    const answer = {
      network,
      landings: sources.length,
      seededLandings: network?.seeded ?? 0,
      skippedLandings,
      tiles: list.length,
      failedTiles: failed,
      radiusKm: AIR_RAILS_RADIUS_KM,
    };
    if (!failed) {
      airRails.set(key, answer);
      while (airRails.size > AIR_RAILS_CACHE_MAX)
        airRails.delete(airRails.keys().next().value);
    }
    send(res, 200, answer);
  }

  /**
   * The rail after landing on the WORLD rail network (owner ruling
   * 2026-10-12: every rail line on the globe): every landing starts the
   * rail from the nearest world point within AIR_RAILS_CORE_KM, so none is
   * left out and no tile budget applies; each stretch is lit by the first
   * landing to reach it, however far. A landing with no world rail that
   * close gets the finer (zoom-10) lines round it, within the same
   * AIR_RAILS_MAX_TILES tiles as before.
   */
  async function airRailsWorldAnswer(res, ordered, speedKmh, key) {
    const bare = ordered.filter((d) => !railWorld.near(d, AIR_RAILS_CORE_KM));
    const fine = bare.length
      ? await fineRailLines(bare, networkStore, {
          radiusKm: AIR_RAILS_CORE_KM,
          maxTiles: AIR_RAILS_MAX_TILES,
        })
      : { lines: [], tiles: 0, failed: 0, left: 0 };
    let answer;
    try {
      answer = await railWorld.task({
        kind: 'air',
        sources: ordered.map((d) => ({ lat: d.lat, lon: d.lon, hour: d.hour })),
        overlay: fine.lines,
        startKm: AIR_RAILS_CORE_KM,
        timing: {
          speedKmh,
          fastKm: PLANE_ROAD_KM,
          onwardShare: AIR_RAILS_ONWARD_SHARE,
        },
      });
    } catch (error) {
      send(res, 503, { error: error.message || 'The rail did not build.' });
      return;
    }
    // The world's own zoom-8 tiles still missing round the landings
    // (2026-10-12): failed tiles too, so the answer is not kept as whole.
    const worldMissing =
      railWorld.missingNear?.(ordered, AIR_RAILS_RADIUS_KM) || 0;
    const result = {
      network: answer.network,
      landings: ordered.length,
      seededLandings: answer.seeded ?? 0,
      skippedLandings: 0,
      fineLandings: bare.length - fine.left,
      fineLeftOut: fine.left,
      tiles: fine.tiles + worldMissing,
      failedTiles: fine.failed + worldMissing,
      worldMissingTiles: worldMissing,
      radiusKm: null,
      world: true,
      builtAt: railWorld.build()?.builtAt ?? null,
    };
    if (!result.failedTiles) {
      airRails.set(key, result);
      while (airRails.size > AIR_RAILS_CACHE_MAX)
        airRails.delete(airRails.keys().next().value);
    }
    send(res, 200, result);
  }

  async function handleEpidemic(req, res, allowedHosts) {
    const admission = admitLlmRequestFrom(req, allowedHosts);
    if (!admission.ok) {
      send(res, admission.status, { error: admission.error });
      return;
    }
    if (!allowEpidemic(clientKey(req))) {
      send(res, 429, { error: 'Too many requests. Wait a minute.' });
      return;
    }
    let body;
    try {
      body = JSON.parse(
        (await readRequestBody(req, TRAFFIC_BODY_BYTES)) || '{}',
      );
    } catch {
      send(res, 400, { error: 'Malformed request body' });
      return;
    }
    const startMs = Number(body?.startMs);
    const untilMs = Number(body?.untilMs);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(untilMs) ||
      !(startMs < untilMs) ||
      untilMs - startMs > EPIDEMIC_WINDOW_MAX_MS
    ) {
      send(res, 400, { error: 'A window of at most 40 days is needed.' });
      return;
    }
    const locations = (Array.isArray(body?.locations) ? body.locations : [])
      .slice(0, 40)
      .map((l) => {
        const point = validPoint(l?.lat, l?.lon);
        return point
          ? {
              id: String(l?.id || '').slice(0, 40),
              name: String(l?.name || '').slice(0, 80),
              ...point,
            }
          : null;
      })
      .filter(Boolean);
    if (!locations.length) {
      send(res, 400, { error: 'At least one outbreak location is needed.' });
      return;
    }
    let index;
    try {
      index = await table.index();
    } catch (error) {
      send(res, 502, {
        error: `The airport list did not load: ${error.message}`,
      });
      return;
    }
    const profile = {
      ...cleanProfile(body?.profile),
      ...cleanEpiProfile(body?.profile),
    };
    const runs = Math.max(
      1,
      Math.min(500, Math.round(Number(body?.runs) || EPIDEMIC_RUNS_DEFAULT)),
    );
    const view = (code) => {
      const row = index.get(String(code || '').toUpperCase());
      return row ? { ...airportView(row), kind: row.kind } : null;
    };
    const scanFlights = [];
    for (const raw of (Array.isArray(body?.flights) ? body.flights : []).slice(
      0,
      2000,
    )) {
      const from = view(raw?.from);
      const to = view(raw?.to);
      const departMs = Number(raw?.departMs);
      const arriveMs = Number(raw?.arriveMs);
      if (!from || !to || !(departMs < arriveMs)) continue;
      scanFlights.push({
        from,
        to,
        departMs,
        arriveMs,
        hop: raw?.hop === 2 ? 2 : 1,
      });
    }
    const outbreakAirports = codesFrom(
      (body?.outbreakAirports || []).join(','),
      10,
    ).filter((code) => index.get(code));
    // Turning the comparison on must not move the main result: the seed
    // leaves `compare` out (the cache key below keeps it).
    const { compare: _compare, ...seedProfile } = profile;
    const seed =
      Number.isInteger(body?.seed) && body.seed >= 0 && body.seed < 2 ** 32
        ? body.seed
        : seedFromText(
            JSON.stringify([
              startMs,
              untilMs,
              outbreakAirports,
              locations,
              seedProfile,
              // Not `runs`: run r must not depend on how many were asked.
              scanFlights.map((f) => [f.from.code, f.to.code, f.departMs]),
            ]),
          );
    // Rail travel (owner ruling 2026-10-12): on unless the box's train is
    // off, at the box's train speed, from the world rail network once it is
    // built. Not in the seed: rail on and off run on the same draws.
    const rail = body?.rail !== false;
    const railSpeedKmh = Math.max(
      1,
      Math.min(1000, Number(body?.speedKmh) || RAIL_TRAVEL.speedKmh),
    );
    railWorldStart(locations);
    const railBuild = rail && railWorld?.ready() ? railWorld.build() : null;
    const key = JSON.stringify([
      startMs,
      untilMs,
      outbreakAirports,
      locations,
      profile,
      runs,
      seed,
      scanFlights.map((f) => [f.from.code, f.to.code, f.departMs]),
      rail ? railSpeedKmh : 'no rail',
      railBuild ? `rail-world-v${RAIL_WORLD_VERSION}-${railBuild.builtAt}` : '',
    ]);
    const kept = epidemics.get(key);
    if (kept) {
      send(res, 200, kept);
      return;
    }
    // The same question while it is being answered: one ensemble, both told.
    const running = inFlight.get(key);
    if (running) {
      const reply = await running;
      send(res, reply.status, reply.payload);
      return;
    }
    const job = answerEpidemic({
      index,
      key,
      startMs,
      untilMs,
      locations,
      profile,
      runs,
      scanFlights,
      outbreakAirports,
      seed,
      view,
      rail,
      railSpeedKmh,
      railBuild,
    });
    inFlight.set(key, job);
    try {
      const reply = await job;
      send(res, reply.status, reply.payload);
    } finally {
      inFlight.delete(key);
    }
  }

  /**
   * Build the places and flights and run the ensemble, answering with the
   * reply to send: `{ status, payload }`. Kept apart from the request
   * parsing so one run can answer every identical question in flight.
   */
  async function answerEpidemic({
    index,
    key,
    startMs,
    untilMs,
    locations,
    profile,
    runs,
    scanFlights,
    outbreakAirports,
    seed,
    view,
    rail = false,
    railSpeedKmh = RAIL_TRAVEL.speedKmh,
    railBuild = null,
  }) {
    // The whole world's air network (owner ruling, 2026-10-09: every
    // airport): every airport with scheduled service is a place and flies its
    // normal traffic daily; the scan's real flights fly once each, and daily
    // from then on out of the airports they left.
    const globe = world(index);
    const extra = scanExtraAirports(
      globe.airports,
      [
        ...outbreakAirports,
        ...scanFlights.flatMap((f) => [f.from.code, f.to.code]),
      ],
      view,
    );
    const airports = [...globe.airports, ...extra];
    let cityRows = noCities;
    let populationSource =
      'GeoNames cities and towns over 500 people (CC-BY 4.0)';
    try {
      cityRows = await cities.load();
    } catch {
      populationSource =
        'Airport size (GeoNames did not load): about 2 million round a large airport, 300,000 round a medium one';
    }
    // Towns on the world rail are places too, however far from an airport
    // (owner ruling 2026-10-12).
    const railGraph = railBuild ? railWorld.graph() : null;
    const { nodes, origins } = buildEpidemicNodes({
      airports,
      cities: cityRows,
      locations,
      profile,
      railNear: railGraph
        ? (lat, lon) =>
            Boolean(railGraph.index.nearest({ lat, lon }, RAIL_REACH_KM))
        : null,
    });
    const at = new Map(nodes.map((node, i) => [node.id, i]));
    const flights = [];
    const flown = [];
    const routes = [];
    const flows = new Map();
    const scanDays = Math.max(1, (untilMs - startMs) / 86_400_000);
    const flow = (fromCode, toCode, perDay) => {
      if (!flows.has(fromCode)) flows.set(fromCode, new Map());
      const out = flows.get(fromCode);
      out.set(toCode, (out.get(toCode) || 0) + perDay);
    };
    // The scan's flights, each flown once on its own day.
    for (const f of scanFlights) {
      const from = at.get(f.from.code);
      const to = at.get(f.to.code);
      if (from === undefined || to === undefined) continue;
      const passengers = flightPassengers(distanceKm(f.from, f.to), 1);
      flights.push({
        from,
        to,
        departMs: f.departMs,
        arriveMs: f.arriveMs,
        passengers,
      });
      flown.push(`${from}>${to}|${Math.round(f.departMs / 1_800_000)}`);
      flow(f.from.code, f.to.code, passengers / scanDays);
    }
    // Daily routes: the scan's, then every other airport's normal traffic.
    const scanned = new Set(scanFlights.map((f) => f.from.code));
    const daily = [
      ...worldAirRoutes([], index.scheduled, scanFlights),
      ...[...globe.byFrom]
        .filter(([code]) => !scanned.has(code))
        .flatMap(([, list]) => list),
    ];
    for (const r of daily) {
      const from = at.get(r.from);
      const to = at.get(r.to);
      if (from === undefined || to === undefined) continue;
      routes.push({ ...r, from, to });
      flow(r.from, r.to, r.passengers);
    }
    // Rail travel between the places on the world rail (RAIL_TRAVEL, owner
    // ruling 2026-10-12), worked out in a worker and kept by the places.
    // Until the world rail is built the model runs as before and says so.
    let railSource = rail ? (railBuild ? '' : 'pending') : 'off';
    let railStats = null;
    let railEstimated = [];
    if (railBuild) {
      try {
        const table = await railWorld.passengerKm();
        const { pkm, estimated } = railCountryVolumes(
          table.pkm,
          railWorld.meta()?.byCountry || {},
          (code) => continentOf(code),
        );
        railEstimated = estimated;
        const railKey = seedFromText(
          JSON.stringify([
            railBuild.builtAt,
            railSpeedKmh,
            pkm,
            nodes.map((node) => [node.id, node.population, node.lat, node.lon]),
          ]),
        );
        let packed = railKept.get(railKey);
        if (!packed || packed.places !== nodes.length) {
          packed = await railWorld.task({
            kind: 'routes',
            nodes: {
              id: nodes.map((node) => node.id),
              lat: Float64Array.from(nodes, (node) => node.lat),
              lon: Float64Array.from(nodes, (node) => node.lon),
              population: Float64Array.from(
                nodes,
                (node) => node.population || 0,
              ),
              country: nodes.map((node) => node.country || ''),
            },
            countryPkm: pkm,
            speedKmh: railSpeedKmh,
            reachKm: RAIL_REACH_KM,
          });
          packed.places = nodes.length;
          railKept.set(railKey, packed);
          while (railKept.size > LINKS_CACHE_MAX)
            railKept.delete(railKept.keys().next().value);
        }
        for (const r of unpackRailRoutes(packed.routes)) {
          if (!(r.from < nodes.length && r.to < nodes.length)) continue;
          routes.push(r);
          flow(nodes[r.from].id, nodes[r.to].id, r.passengers);
        }
        railStats = packed.stats;
        railSource = `${RAIL_TRAVEL.volumeSource}${estimated.length ? ` (estimated from the continent's median passenger-km per km of line for ${estimated.length} countries)` : ''}; ${RAIL_TRAVEL.shapeSource}; ${RAIL_TRAVEL.networkSource}`;
      } catch (error) {
        railSource = `failed: ${error.message || 'the rail routes did not build'}`;
      }
    }
    // Patient zero's own airports start the effective distance; with rail,
    // its own town too.
    const sources = [
      ...new Set([
        ...outbreakAirports,
        ...origins
          .map((i) => nodes[i].code || (railStats ? nodes[i].id : ''))
          .filter(Boolean),
      ]),
    ];
    const distance = effectiveDistances(flows, sources);
    const params = epiParameters(profile);
    // Model places carry the table code; the index also knows IATA codes.
    // The profile (seed and cache key) keeps what was typed.
    if (params.strain2?.place)
      params.strain2.place =
        index.get(params.strain2.place)?.code || params.strain2.place;
    // The commuting links depend on each place's id, population and
    // position: the tables, plus the scan's extra airports and patient
    // zero's own places (whose population follows the density band and
    // whose position follows the request). The world rail changes them
    // only through the places on it, which the node list shows already, so
    // a new rail build keeps them (2026-10-12).
    const linksKey = seedFromText(
      JSON.stringify([
        tableId(index.allScheduled),
        tableId(cityRows),
        nodes.map((node) => [node.id, node.population, node.lat, node.lon]),
      ]),
    );
    const kept = linksKept.get(linksKey);
    // A kept set must fit this node list (a hash collision must not reuse it).
    const packed =
      kept && kept.offsets.length === nodes.length + 1 ? kept : undefined;
    const links = packed
      ? {
          offsets: packed.offsets.slice(),
          j: packed.j.slice(),
          share: packed.share.slice(),
        }
      : undefined;
    const onLinks = (computed) => {
      linksKept.set(linksKey, computed);
      while (linksKept.size > LINKS_CACHE_MAX)
        linksKept.delete(linksKept.keys().next().value);
    };
    let result;
    try {
      result = await runEpidemic(
        {
          nodes,
          origins,
          flights,
          routes,
          flown,
          params,
          startMs,
          untilMs,
          runs,
          seed,
          ...(links ? { links } : {}),
        },
        { onLinks },
      );
    } catch (error) {
      return {
        status: 503,
        payload: { error: error.message || 'The epidemic model failed.' },
      };
    }
    let railCount = 0;
    for (const r of routes) if (r.mode === 'rail') railCount += 1;
    const nameOf = (code) => {
      const i = at.get(code);
      return index.get(code)?.name || (i === undefined ? '' : nodes[i].name);
    };
    const answer = {
      ...result,
      sensitivity: sensitivityTornado(profile),
      populationSource,
      network: {
        places: nodes.length,
        airports: airports.length,
        flights: flights.length,
        routes: routes.length - railCount,
        railRoutes: railCount,
      },
      railSource,
      ...(railStats ? { railStats } : {}),
      ...(railEstimated.length ? { railEstimated } : {}),
      effectiveDistance: [...distance]
        .filter(([code]) => !sources.includes(code))
        .sort((a, b) => a[1] - b[1])
        .slice(0, 30)
        .map(([code, d]) => ({
          code,
          name: nameOf(code) || code,
          distance: Math.round(d * 100) / 100,
        })),
    };
    epidemics.set(key, answer);
    while (epidemics.size > EPIDEMIC_CACHE_MAX)
      epidemics.delete(epidemics.keys().next().value);
    return { status: 200, payload: answer };
  }

  async function handle(req, res, allowedHosts) {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    if (route === '/traffic') {
      await handleTraffic(req, res, allowedHosts);
      return;
    }
    if (route === '/epidemic') {
      await handleEpidemic(req, res, allowedHosts);
      return;
    }
    if (route === '/air-roads') {
      await handleAirLines(req, res, allowedHosts, 'road');
      return;
    }
    if (route === '/air-rails') {
      await handleAirLines(req, res, allowedHosts, 'rail');
      return;
    }
    if (!admitGet(req, res, allowedHosts)) return;
    const params = url.searchParams;
    // EVERY RAIL LINE ON THE GLOBE (owner ruling 2026-10-12): how far the
    // world rail has got, and its lines for the map. Both are cheap reads
    // of what this server holds, polled by the page: same origin only, and
    // outside the request budget, which the tiles alone would spend.
    if (route === '/rail-world/status')
      return send(res, 200, {
        ...(railWorld
          ? railWorld.status()
          : { state: 'off', tilesTotal: 0, tilesDone: 0 }),
        version: RAIL_WORLD_VERSION,
      });
    const tilePath = route.match(/^\/rail-world\/tile\/(\d+)\/(\d+)\/(\d+)$/);
    if (tilePath) {
      const [z, x, y] = tilePath.slice(1).map(Number);
      if (z < 2 || z > 6 || x >= 2 ** z || y >= 2 ** z)
        return send(res, 400, { error: 'A tile at zoom 2 to 6 is needed.' });
      const answer = railWorld?.ready()
        ? railWorld.layerTile(z, x, y, tileBounds(z, x, y))
        : null;
      if (!answer)
        return send(res, 404, { error: 'The world rail is not built yet.' });
      return send(res, 200, answer);
    }
    if (!allow(clientKey(req))) {
      send(res, 429, { error: 'Too many requests. Wait a minute.' });
      return;
    }

    if (route === '/airports/near' || route === '/airports/candidates') {
      const point = pointFrom(params);
      if (!point)
        return send(res, 400, {
          error: 'A latitude and longitude are needed.',
        });
      try {
        const airports =
          route === '/airports/near'
            ? await table.near(
                point,
                Math.min(200, Number(params.get('km')) || OUTBREAK_AIRPORT_KM),
              )
            : await table.candidates(point);
        return send(res, 200, { airports });
      } catch (error) {
        return send(res, 502, {
          error: `The airport list did not load: ${error.message}`,
        });
      }
    }

    if (route === '/airports/lookup') {
      const codes = codesFrom(params.get('codes'), 400);
      try {
        return send(res, 200, { airports: await table.lookup(codes) });
      } catch (error) {
        return send(res, 502, {
          error: `The airport list did not load: ${error.message}`,
        });
      }
    }

    if (route === '/flights') {
      const airports = codesFrom(params.get('airports'), 6);
      const endS = Math.floor(Number(params.get('end')) || Date.now() / 1000);
      const beginS = Math.floor(
        Number(params.get('begin')) || endS - 2 * 86_400,
      );
      if (!airports.length || !(beginS < endS) || endS - beginS > SCAN_MAX_S)
        return send(res, 400, {
          error: 'Airports and a scan window of at most 8 days are needed.',
        });
      const token = await tokenFor().catch(() => null);
      if (!token)
        return send(res, 501, {
          unconfigured: true,
          error:
            'Flight history needs an OpenSky account: add it in POWER UP → OPENSKY.',
        });
      if (!allowFlights(clientKey(req)))
        return send(res, 429, {
          error: 'Flight history was asked for a moment ago. Wait a minute.',
        });
      try {
        const flights = await outbreakFlightHistory({
          airports,
          beginS,
          endS,
          token,
          table,
          fetchImpl: fetcher,
        });
        return send(res, 200, { flights, source: 'OpenSky Network' });
      } catch (error) {
        return send(res, 502, {
          error:
            error?.status === 403 || error?.status === 401
              ? 'OpenSky refused the flight history for this account.'
              : `Flight history did not load: ${error.message}`,
        });
      }
    }

    if (route === '/network') {
      const point =
        params.has('lat') && params.has('lon') ? pointFrom(params) : null;
      const mode = params.get('mode') === 'rail' ? 'rail' : 'road';
      if (!point)
        return send(res, 400, {
          error: 'A latitude and longitude are needed.',
        });
      const level =
        mode === 'rail'
          ? 1
          : Math.max(1, Math.min(3, Number(params.get('level')) || 1));
      if (mode === 'rail') railWorldStart([point]);
      // The world rail, once built, answers rail (owner ruling 2026-10-12);
      // until then, the rail within 500 km as before.
      const worldBuild =
        mode === 'rail' && railWorld?.ready() ? railWorld.build() : null;
      const at = `${point.lat.toFixed(2)}_${point.lon.toFixed(2)}`;
      const key = `${mode}|${level}|${point.lat.toFixed(2)},${point.lon.toFixed(2)}${worldBuild ? `|world-${worldBuild.builtAt}` : ''}`;
      // rail2: built again since the finer tiles stand in near the point;
      // rail4: the world rail, by its build, with the rail it cannot reach.
      const fileKey = worldBuild
        ? `rail4-world-v${RAIL_WORLD_VERSION}-${worldBuild.builtAt}-${at}`
        : `${mode === 'rail' ? 'rail2' : mode}-L${level}-${at}`;
      if (worldBuild) forgetOlderWorldAnswers(worldBuild.builtAt);
      const kept = networks.get(key) || builtNetworks.read(fileKey);
      if (kept) {
        keepNetwork(key, kept);
        return send(res, 200, kept);
      }
      let result;
      try {
        result = worldBuild
          ? await worldRailNetwork(point, networkStore, railWorld)
          : await transportNetwork(point, mode, networkStore, {
              level,
              build: buildNetwork,
            });
      } catch (error) {
        return send(res, 502, {
          error: `The ${mode === 'rail' ? 'rail' : 'road'} network did not load: ${error.message}`,
        });
      }
      if (!result.network && result.failedTiles === result.tiles)
        return send(res, 502, {
          error: 'The map tiles did not load. The circle is drawn instead.',
        });
      // Kept only when every tile answered: a partial network is asked again.
      if (!result.failedTiles) {
        builtNetworks.write(fileKey, result);
        keepNetwork(key, result);
      }
      return send(res, 200, result);
    }

    if (route === '/surroundings') {
      const point = pointFrom(params);
      if (!point)
        return send(res, 400, {
          error: 'A latitude and longitude are needed.',
        });
      const key = `${point.lat.toFixed(2)},${point.lon.toFixed(2)}`;
      const cached = surroundings.get(key);
      if (cached) return send(res, 200, cached);
      const answer = await overpass(
        `data=${encodeURIComponent(surroundingsQuery(point))}`,
      ).catch(() => null);
      if (
        !answer ||
        answer.status < 200 ||
        answer.status >= 300 ||
        !answer.body
      )
        return send(res, 502, {
          error: 'OpenStreetMap did not answer. Rail and water are assumed.',
        });
      let parsed;
      try {
        parsed = JSON.parse(answer.body);
      } catch {
        return send(res, 502, { error: 'OpenStreetMap answered badly.' });
      }
      const result = {
        ...readSurroundings(parsed?.elements),
        source: 'OpenStreetMap',
      };
      surroundings.set(key, result);
      if (surroundings.size > 200)
        surroundings.delete(surroundings.keys().next().value);
      return send(res, 200, result);
    }

    if (route === '/news') {
      const places = String(params.get('places') || '')
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 8);
      const query = outbreakNewsQuery(places, params.get('keywords'));
      if (!query)
        return send(res, 400, { error: 'An outbreak location is needed.' });
      const cached = news.get(query);
      if (cached && Date.now() - cached.at < NEWS_CACHE_MS)
        return send(res, 200, cached.payload);
      if (!allowNews(clientKey(req)))
        return send(res, 429, {
          error: 'The media search was run a moment ago. Wait a minute.',
        });
      const gdelt = `${GDELT_URL}?${new URLSearchParams({
        query,
        mode: 'artlist',
        format: 'json',
        maxrecords: '75',
        timespan: '7d',
        sort: 'datedesc',
      })}`;
      try {
        const response = await fetcher(gdelt, {
          signal: AbortSignal.timeout(GDELT_TIMEOUT_MS),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let data = {};
        try {
          data = JSON.parse(text);
        } catch {
          // GDELT answers a refused query in plain text.
          throw new Error(text.trim().slice(0, 160) || 'not JSON');
        }
        const articles = (Array.isArray(data?.articles) ? data.articles : [])
          .map((a) => ({
            title: String(a?.title || '').slice(0, 200),
            url: String(a?.url || '').slice(0, 500),
            domain: String(a?.domain || '').slice(0, 80),
            country: String(a?.sourcecountry || '').slice(0, 40),
            language: String(a?.language || '').slice(0, 30),
            seen: String(a?.seendate || '').slice(0, 20),
          }))
          .filter((a) => a.title && /^https?:\/\//.test(a.url));
        const payload = { query, articles, source: 'GDELT' };
        news.set(query, { at: Date.now(), payload });
        if (news.size > 50) news.delete(news.keys().next().value);
        return send(res, 200, payload);
      } catch (error) {
        return send(res, 502, {
          error: `The media search did not answer: ${error.message}`,
        });
      }
    }

    send(res, 404, { error: 'Not found' });
  }

  function install(server, section) {
    const allowedHosts = resolvedAllowedHosts(server.config, section);
    server.middlewares.use('/api/outbreak', (req, res) => {
      handle(req, res, allowedHosts).catch(() => {
        if (!res.headersSent)
          send(res, 500, { error: 'The outbreak route failed.' });
      });
    });
  }
  return {
    name: 'outbreak-proxy',
    configureServer(server) {
      install(server, 'server');
    },
    configurePreviewServer(server) {
      install(server, 'preview');
    },
  };
}
