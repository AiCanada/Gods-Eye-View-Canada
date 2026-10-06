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
 *
 * The airports are OurAirports' public table, fetched once and kept in
 * .gev-cache/outbreak for thirty days. Every route answers this page only
 * (a Host this server serves, a same-origin fetch), and nothing here holds
 * a key: OpenSky's token comes from the aircraft provider.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  resolvedAllowedHosts,
  servedRequestOrigin,
} from './common/allowed-hosts.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { getOpenSkyToken } from './aircraft/opensky.js';
import { fetchOverpassPayload } from './overpass.js';
import {
  BOAT_REACH_KM,
  CONNECTING_AIRPORTS_MAX,
  OUTBREAK_AIRPORT_KM,
  RAIL_REACH_KM,
  distanceKm,
  validPoint,
} from '../../src/outbreakCore.mjs';

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
  const file = path.join(cacheDir, 'airports.json');
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
  tokenFor = getOpenSkyToken,
  overpass = fetchOverpassPayload,
} = {}) {
  const fetcher = (...args) => (fetchImpl || globalThis.fetch)(...args);
  const allow = makeRateLimiter({ windowMs: 60_000, max: 40, globalMax: 80 });
  const allowFlights = makeRateLimiter({
    windowMs: 60_000,
    max: 4,
    globalMax: 8,
  });
  const allowNews = makeRateLimiter({
    windowMs: 60_000,
    max: 6,
    globalMax: 10,
  });
  const news = new Map();
  const surroundings = new Map();

  async function handle(req, res, allowedHosts) {
    if (!admitGet(req, res, allowedHosts)) return;
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const params = url.searchParams;
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
