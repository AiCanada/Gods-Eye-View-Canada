#!/usr/bin/env node
/**
 * Backfill the world tape from feeds that keep an archive (owner request
 * 2026-10-13): live feeds can't be recovered, but some sources publish
 * their past. Each record is filed under its own hour of the past and
 * carries `backfill: true`.
 *  - earthquakes: the USGS event catalogue (FDSN), M2.5+ (U.S. public domain)
 *  - local-firms: NASA FIRMS active fires by day (needs a MAP_KEY:
 *    --firms-key or FIRMS_MAP_KEY; the NRT archive covers recent months)
 *  - wind: the NOAA GFS archive on AWS (keyless, U.S. public domain; the
 *    bucket and object keys the Wind proxy reads, kept from the 2021-03-22
 *    12Z cycle): each 6-hourly cycle's analysis u10, v10, t2m, msl and q2m
 *    and its f006 0–6 h mean precipitation rate, resampled to 1° as the
 *    proxy serves them and written as the wind feed's int16 grid files
 *  - weather-cyclones: NHC HURDAT2 best tracks, Atlantic (from 1851) and
 *    Northeast and North Central Pacific (from 1949), U.S. public domain:
 *    the newest file of each in the NHC listing. A season is published
 *    months after it ends, so the latest dates have none yet.
 *  - recent-imagery: the NASA GIBS VIIRS daily true-colour image of each
 *    area (the AI World tab's AREAS, or --area), with the live feed's box,
 *    size, file name and record, filed under 12:00 UTC of its day
 *
 *   node scripts/world-tape-backfill.mjs --from 2026-09-01 --to 2026-10-12
 *     [--feeds earthquakes,local-firms,wind,weather-cyclones,recent-imagery]
 *     [--firms-key KEY] [--area lat,lon[,name]]... [--tape DIR]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './project-root.mjs';
import { createTapeStore } from '../server/shared/worldTapeStore.mjs';
import { parseCsv } from '../src/outbreakRealTape.mjs';
import {
  GFS_BUCKET,
  gfsObjectKey,
  selectLatestGfsCycle,
} from '../server/providers/wind/catalog.js';
import { decodeWindGribMessage } from '../server/providers/wind/decode.js';
import {
  fetchRange,
  fetchText,
  parseGfsIdx,
  windMessageRanges,
} from '../server/providers/wind/gfs.js';
import { resampleWeatherFields } from '../server/providers/wind/grid.js';
import {
  discard,
  mapLimit,
  validAreas,
} from '../server/shared/worldTape/feeds/_util.mjs';
import recentImagery from '../server/shared/worldTape/feeds/recent-imagery.mjs';
import { gridFile } from '../server/shared/worldTape/feeds/wind.mjs';
import {
  PRODUCTS,
  rankLatest,
  viirsCandidates,
} from '../src/layers/recentImagery/model.js';
import { readResponseTextCapped } from '../src/sources/httpBody.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const BACKFILL_FEEDS = Object.freeze({
  earthquakes: {
    class: 'open',
    licence: 'USGS earthquake catalog (U.S. public domain)',
  },
  'local-firms': {
    class: 'open',
    licence: 'NASA FIRMS (public domain; acknowledgement requested)',
  },
  wind: { class: 'open', licence: 'NOAA GFS (U.S. public domain)' },
  'weather-cyclones': {
    class: 'open',
    licence: 'NOAA NHC HURDAT2 (U.S. public domain)',
  },
  'recent-imagery': { class: 'open', licence: recentImagery.licence },
});

const pad = (n) => String(n).padStart(2, '0');
const isoHour = (ms) => `${new Date(ms).toISOString().slice(0, 13)}Z`;

export function parseArgs(
  argv,
  root = projectRoot(import.meta.url),
  env = process.env,
) {
  const options = {
    root,
    tape: path.join(root, '.gev-data', 'tape'),
    areasFile: path.join(root, '.gev-data', 'ai-world', 'areas.json'),
    from: null,
    to: null,
    feeds: ['earthquakes', 'local-firms'],
    firmsKey: env.FIRMS_MAP_KEY || '',
    areas: [],
  };
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    const next = () => argv[(k += 1)];
    if (arg === '--from') options.from = next();
    else if (arg === '--to') options.to = next();
    else if (arg === '--feeds')
      options.feeds = next().split(',').filter(Boolean);
    else if (arg === '--firms-key') options.firmsKey = next();
    else if (arg === '--area') options.areas.push(parseArea(next()));
    else if (arg === '--tape') options.tape = path.resolve(root, next());
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(options.from || '') ||
    !/^\d{4}-\d{2}-\d{2}$/.test(options.to || '')
  )
    throw new Error('--from and --to need dates (YYYY-MM-DD)');
  for (const feed of options.feeds)
    if (!BACKFILL_FEEDS[feed]) throw new Error(`No archive for ${feed}`);
  return options;
}

/** `--area lat,lon[,name]` → an area (the name may itself hold commas). */
export function parseArea(value) {
  const [lat, lon, ...name] = String(value ?? '').split(',');
  const [area] = validAreas([{ lat, lon, name: name.join(',') }]);
  if (!area) throw new Error(`--area needs lat,lon[,name]: ${value}`);
  return { lat: area.lat, lon: area.lon, name: area.name };
}

/** USGS GeoJSON → tape records (as the earthquakes feed records them). */
export function usgsRecords(geojson) {
  const out = [];
  for (const f of geojson?.features || []) {
    const [lon, lat, depth] = f?.geometry?.coordinates || [];
    const mag = f?.properties?.mag;
    const time = f?.properties?.time;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !(mag >= 2.5) ||
      !Number.isFinite(time)
    )
      continue;
    out.push({
      t: time,
      id: f.id,
      lat,
      lon,
      depth: Number.isFinite(depth) ? depth : null,
      mag,
      place: f.properties.place ?? null,
      time,
      backfill: true,
    });
  }
  return out;
}

/** FIRMS area CSV → tape records, timed by acquisition (UTC). */
export function firmsRecords(text) {
  const out = [];
  for (const r of parseCsv(text)) {
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    const hhmm = String(r.acq_time || '').padStart(4, '0');
    const t = Date.parse(
      `${r.acq_date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`,
    );
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t))
      continue;
    out.push({
      t,
      lat,
      lon,
      frp: Number(r.frp) || 0,
      confidence: r.confidence ?? null,
      satellite: r.satellite ?? null,
      acq: t,
      backfill: true,
    });
  }
  return out;
}

/** File records under their own hours; returns how many were written. */
export function fileByHour(store, feed, records) {
  const byHour = new Map();
  for (const r of records) {
    const hour = Math.floor(r.t / HOUR) * HOUR;
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour).push(r);
  }
  let written = 0;
  for (const [hour, list] of [...byHour].sort((a, b) => a[0] - b[0])) {
    const result = store.append(feed, list, BACKFILL_FEEDS[feed], { at: hour });
    if (!result.ok) throw new Error(`${feed}: ${result.reason}`);
    written += list.length;
  }
  return written;
}

/** Write files (`{name, bytes, record, at}`) under their hours; returns how many. */
function fileEach(store, feed, files) {
  for (const { name, bytes, record, at } of files) {
    const result = store.writeFile(
      feed,
      name,
      bytes,
      { ...record, backfill: true },
      BACKFILL_FEEDS[feed],
      { at },
    );
    if (!result.ok) throw new Error(`${feed}: ${result.reason}`);
  }
  return files.length;
}

// --------------------------------------------------------------- GFS (wind)

/**
 * The first cycle the bucket keeps in the `atmos/` layout gfsObjectKey
 * builds (GFS v16; checked 2026-10-13). The bucket starts at 2021-01-01,
 * but its cycles before this one sit in an older layout without `atmos/`.
 */
export const GFS_ARCHIVE_START = Date.UTC(2021, 2, 22, 12);
const GFS_CYCLE_HOURS = [0, 6, 12, 18];
/** The analysis's companion fields: the proxy's overlay, the tape's var. */
const GFS_ANALYSIS_FIELDS = [
  ['temperature', 't2m'],
  ['pressure', 'msl'],
  ['humidity', 'q2m'],
];
/** Byte ranges in flight at once, and each request's bound. */
const GFS_RANGE_CONCURRENCY = 4;
const GFS_TIMEOUT_MS = 60_000;

/**
 * One GFS cycle as the wind feed records it: the analysis's (f000) 10 m
 * wind, 2 m temperature, mean sea-level pressure and 2 m specific humidity,
 * and the 0–6 h mean precipitation rate from the cycle's f006, each
 * resampled to 1° as the Wind proxy serves it (u/v m/s, °C, hPa, kg/kg,
 * mm/h). Each file comes with the time it is filed under: an instant at
 * its valid time, a time mean at the middle of its window (where the
 * binner counts it). Null when either object is not in the bucket.
 * @param {{run: number, fetchImpl: typeof fetch, decodeImpl: Function,
 *   timeoutMs?: number}} input `run` is the cycle's time, ms.
 * @returns {Promise<Array<{name: string, bytes: Buffer, record: object,
 *   at: number}>|null>}
 */
export async function gfsCycle({
  run,
  fetchImpl,
  decodeImpl,
  timeoutMs = GFS_TIMEOUT_MS,
}) {
  const runIso = new Date(run).toISOString();
  const cycle = {
    date: runIso.slice(0, 10).replaceAll('-', ''),
    hour: new Date(run).getUTCHours(),
  };
  const objectUrl = (step) =>
    `https://${GFS_BUCKET}.s3.amazonaws.com/${gfsObjectKey({ ...cycle, forecastHour: step })}`;
  // fetchText says only that an object is unavailable; the status tells a
  // missing one (the cycle is skipped) from a failing request.
  let status = null;
  const watched = async (url, init) => {
    const response = await fetchImpl(url, init);
    status = response.status;
    return response;
  };
  const inventory = async (step) => {
    status = null;
    try {
      const index = await fetchText({
        url: `${objectUrl(step)}.idx`,
        fetchImpl: watched,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return parseGfsIdx(index.toString());
    } catch (error) {
      if (status === 404 || status === 403) return null;
      throw status >= 300
        ? new Error(`f${String(step).padStart(3, '0')} index HTTP ${status}`)
        : error;
    }
  };
  const analysis = await inventory(0);
  const later = analysis && (await inventory(6));
  if (!later) return null;
  const companions = GFS_ANALYSIS_FIELDS.map(([overlay]) =>
    windMessageRanges(analysis, { overlay }),
  );
  const mean = windMessageRanges(later, { overlay: 'precipitation' });
  const [u, v, ...scalars] = await mapLimit(
    [
      [0, companions[0].u],
      [0, companions[0].v],
      ...companions.map(({ scalar }) => [0, scalar]),
      [6, mean.scalar],
    ],
    GFS_RANGE_CONCURRENCY,
    async ([step, range]) =>
      decodeImpl(
        await fetchRange({
          url: objectUrl(step),
          ...range,
          fetchImpl,
          signal: AbortSignal.timeout(timeoutMs),
        }),
      ),
  );
  // The proxy's own resampling and unit conversions. The rate is resampled
  // beside the analysis's wind: the same grid, so the same geometry.
  const wind = resampleWeatherFields({ u, v, targetDx: 1 }).grid;
  const fields = [
    { name: 'u10', values: wind.u },
    { name: 'v10', values: wind.v },
  ].map((field) => ({
    ...field,
    step: 0,
    units: 'm/s',
    level: '10 m above ground',
  }));
  [...GFS_ANALYSIS_FIELDS, ['precipitation', 'prate']].forEach(
    ([overlay, name], k) => {
      const { grid, scalar } = resampleWeatherFields({
        u,
        v,
        scalar: scalars[k],
        overlay,
        targetDx: 1,
      });
      fields.push({
        name,
        values: grid.scalar,
        units: scalar.units,
        level: scalar.level,
        ...(overlay === 'precipitation'
          ? { step: 6, window: mean.window }
          : { step: 0 }),
      });
    },
  );
  return fields.map((field) => ({
    ...gridFile({
      model: 'gfs',
      run: runIso,
      valid: new Date(run + field.step * HOUR).toISOString(),
      grid: wind,
      ...field,
    }),
    at: field.window
      ? run + ((field.window.fromHour + field.window.toHour) / 2) * HOUR
      : run + field.step * HOUR,
  }));
}

// ------------------------------------------------ HURDAT2 (weather-cyclones)

export const HURDAT2_LISTING = 'https://www.nhc.noaa.gov/data/hurdat/';
/**
 * The best-track files by basin group, named by their last season and
 * version date (MMDDYY or MMDDYYYY; a letter marks a same-day reissue).
 */
const HURDAT2_FILES = Object.freeze({
  Atlantic: /^hurdat2-1851-(\d{4})-(\d{6}|\d{8})([a-z]?)\.txt$/,
  'Northeast and North Central Pacific':
    /^hurdat2-nepac-1949-(\d{4})-(\d{6}|\d{8})([a-z]?)\.txt$/,
});
const HURDAT2_LISTING_MAX_BYTES = 1024 * 1024;
const HURDAT2_FILE_MAX_BYTES = 32 * 1024 * 1024;

/** Whether `day` (`YYYY-MM-DD`) is a real calendar day. */
function realDay(day) {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

/**
 * The newest file of each basin group among the NHC listing's links: by
 * last season, then version date. Only names the strict patterns accept
 * are taken, so every URL is a file in the listing's own folder.
 * @param {string} html The listing page.
 * @returns {Record<string, {name: string, url: string, lastSeason: number,
 *   version: string}>} By group; a group with no file is missing.
 */
export function hurdat2Files(html, base = HURDAT2_LISTING) {
  const newest = {};
  const ranks = {};
  for (const [, href] of String(html).matchAll(/href="([^"]*)"/gi))
    for (const [group, pattern] of Object.entries(HURDAT2_FILES)) {
      const match = pattern.exec(href);
      if (!match) continue;
      const [, season, stamp, reissue] = match;
      const year = stamp.length === 6 ? `20${stamp.slice(4)}` : stamp.slice(4);
      const version = `${year}-${stamp.slice(0, 2)}-${stamp.slice(2, 4)}`;
      if (!realDay(version)) continue;
      const rank = `${season}|${version}|${reissue}`;
      if (ranks[group] >= rank) continue;
      ranks[group] = rank;
      newest[group] = {
        name: href,
        url: new URL(href, base).href,
        lastSeason: Number(season),
        version,
      };
    }
  return newest;
}

/** `IDALIA` → `Idalia`, `TWENTY-ONE` → `Twenty-One` (the advisories' form). */
const titleCase = (name) =>
  name
    ? name
        .toLowerCase()
        .replace(
          /(^|[^a-z])([a-z])/g,
          (_, before, c) => before + c.toUpperCase(),
        )
    : null;

/** One HURDAT2 fix line's cells → its time, position, status and intensity. */
function hurdat2Fix([date, hhmm, identifier, status, lat, lon, wind, mb]) {
  if (!/^\d{4}$/.test(hhmm)) return null;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
  const t = Date.parse(`${iso}:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 16) !== iso)
    return null;
  const north = /^(\d{1,2}(?:\.\d+)?)([NS])$/.exec(lat || '');
  const east = /^(\d{1,3}(?:\.\d+)?)([EW])$/.exec(lon || '');
  if (!north || !east || Number(north[1]) > 90 || Number(east[1]) > 180)
    return null;
  const knots = /^-?\d+$/.test(wind || '') ? Number(wind) : NaN;
  const pressure = /^-?\d+$/.test(mb || '') ? Number(mb) : NaN;
  return {
    t,
    lat: Number(north[1]) * (north[2] === 'S' ? -1 : 1),
    lon: Number(east[1]) * (east[2] === 'W' ? -1 : 1),
    // −99 and −999 mark a missing wind or pressure.
    windKt: knots >= 0 ? knots : null,
    pressure: pressure > 0 ? pressure : null,
    status: /^[A-Z]{2}$/.test(status || '') ? status : null,
    identifier: /^[A-Z]$/.test(identifier || '') ? identifier : null,
  };
}

/**
 * HURDAT2 text → tape records, in the weather-cyclones feed's field names
 * and forms (a lowercase `al092023` id, the basin, a title-case name,
 * `classification` for the status, `windKt`, `pressure` in hPa,
 * `positionAt`). A storm's header line (`AL092023, IDALIA, 47,`) is
 * followed by that many fix lines (`20230830, 1145, L, HU, 29.9N, 83.6W,
 * 90, 949, …`); `recordType` keeps the fix's identifier (L landfall,
 * P minimum pressure, I intensity peak, …; null for a synoptic fix).
 * Missing wind (−99) and pressure (−999) are null. Lines that do not
 * parse are skipped, and fix lines with no header before them ignored.
 * @param {string} text
 * @param {{from?: number, to?: number}} [range] Fixes kept: from ≤ t < to.
 */
export function hurdat2Records(text, { from = -Infinity, to = Infinity } = {}) {
  const out = [];
  let storm = null;
  for (const line of String(text).split(/\r?\n/)) {
    const cells = line.split(',').map((cell) => cell.trim());
    if (/^(?:AL|EP|CP)\d{6}$/.test(cells[0])) {
      storm = /^\d{1,4}$/.test(cells[2] || '')
        ? {
            id: cells[0].toLowerCase(),
            name: titleCase(cells[1]),
            basin: cells[0].slice(0, 2),
            left: Number(cells[2]),
          }
        : null;
      continue;
    }
    if (!storm || storm.left <= 0 || !/^\d{8}$/.test(cells[0])) continue;
    storm.left -= 1;
    const fix = hurdat2Fix(cells);
    if (!fix || fix.t < from || fix.t >= to) continue;
    out.push({
      t: fix.t,
      id: storm.id,
      name: storm.name,
      basin: storm.basin,
      classification: fix.status,
      lat: fix.lat,
      lon: fix.lon,
      windKt: fix.windKt,
      pressure: fix.pressure,
      positionAt: new Date(fix.t).toISOString(),
      recordType: fix.identifier,
      source: 'HURDAT2',
      backfill: true,
    });
  }
  return out;
}

/**
 * The HURDAT2 fixes from --from to --to, filed by hour. A season is
 * published months after it ends, so the log says where each file stops;
 * a range wholly past it downloads nothing.
 */
async function backfillHurdat2({ store, from, to, fetchImpl, log }) {
  const listing = await fetchImpl(HURDAT2_LISTING, {
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!listing.ok) {
    await discard(listing);
    throw new Error(`NHC HURDAT2 listing HTTP ${listing.status}`);
  }
  const files = hurdat2Files(
    await readResponseTextCapped(listing, HURDAT2_LISTING_MAX_BYTES),
  );
  let written = 0;
  for (const group of Object.keys(HURDAT2_FILES)) {
    const file = files[group];
    if (!file) {
      log(`[backfill] weather-cyclones: no HURDAT2 ${group} file listed`);
      continue;
    }
    const after = Date.UTC(file.lastSeason + 1, 0, 1);
    const ends = `HURDAT2 ${group} (${file.name}) ends with the ${file.lastSeason} season; best tracks are published months after a season ends, so nothing after ${file.lastSeason}-12-31 yet`;
    if (from >= after) {
      log(`[backfill] weather-cyclones: ${ends}`);
      continue;
    }
    const response = await fetchImpl(file.url, {
      signal: AbortSignal.timeout(120_000),
      redirect: 'error',
    });
    if (!response.ok) {
      await discard(response);
      throw new Error(`HURDAT2 HTTP ${response.status}`);
    }
    const records = hurdat2Records(
      await readResponseTextCapped(response, HURDAT2_FILE_MAX_BYTES),
      { from, to },
    );
    written += fileByHour(store, 'weather-cyclones', records);
    log(
      `[backfill] weather-cyclones: ${records.length} fixes from HURDAT2 ${group} (${file.name})`,
    );
    if (to > after) log(`[backfill] weather-cyclones: ${ends}`);
  }
  return written;
}

// ----------------------------------------------- GIBS VIIRS (recent-imagery)

/**
 * The first day GIBS holds each VIIRS true-colour layer (WMTS
 * DescribeDomains, checked 2026-10-13). Later days it has no image of
 * answer `Data-Present: false` and are left out.
 */
const GIBS_FIRST_DAY = Object.freeze({
  VIIRS_NOAA21_CorrectedReflectance_TrueColor: '2023-02-10',
});
const IMAGE_TIMEOUT_MS = 120_000;

/** The AI World tab's AREAS (`[{key, name, lat, lon}]`), or none. */
function readAreas(file) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * The tool services' imagery, the live feed's own source (loaded only
 * here: the tool services bring every layer's source with them), with a
 * fetch that refuses redirects and turns Worldview's blank answer for a
 * day it holds no image of (`Data-Present: false`) into a refusal.
 */
async function imageryService(fetchImpl) {
  const { createToolServices } = await import('../src/tools/services.js');
  return createToolServices({
    fetchImpl: async (url, init) => {
      const response = await fetchImpl(url, { ...init, redirect: 'error' });
      if (response.headers?.get?.('data-present') === 'false') {
        await discard(response);
        throw Object.assign(new Error('no image that day'), {
          code: 'NO_IMAGE',
        });
      }
      return response;
    },
  }).imagery;
}

/**
 * One day's VIIRS daily true-colour image of each area, made by the live
 * recent-imagery feed itself (its box, image size, file name and record),
 * with its catalog query answered by that day's VIIRS overview: the
 * candidate the layer's own model makes for the day. An area with no image
 * that day, or whose image fails, is left out and counted.
 */
async function imageryDay({ day, areas, imagery }) {
  const { candidate, reason } = rankLatest(viirsCandidates(day, 1));
  let missing = 0;
  const failures = [];
  const { files } = await recentImagery.poll({
    areas,
    state: {},
    services: {
      imagery: {
        latest: async () => ({ candidate, reason }),
        async getSnapshot(request) {
          try {
            return await imagery.getSnapshot({
              ...request,
              signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
            });
          } catch (error) {
            if (error?.code === 'NO_IMAGE') missing += 1;
            else failures.push(error);
            throw error;
          }
        },
      },
    },
  });
  const noon = Date.parse(`${day}T12:00:00Z`);
  return {
    files: files.map((file) => ({ ...file, at: noon })),
    missing,
    failures,
  };
}

// ------------------------------------------------------------------ the run

export async function backfill(
  options,
  {
    fetchImpl = globalThis.fetch,
    decodeImpl = decodeWindGribMessage,
    now = Date.now,
    log = console.log,
  } = {},
) {
  const store = createTapeStore({ root: options.tape });
  const totals = {};
  const from = Date.parse(`${options.from}T00:00:00Z`);
  const to = Date.parse(`${options.to}T00:00:00Z`) + DAY;
  if (options.feeds.includes('weather-cyclones'))
    totals['weather-cyclones'] = await backfillHurdat2({
      store,
      from,
      to,
      fetchImpl,
      log,
    });
  let latestRun = null;
  if (options.feeds.includes('wind')) {
    const latest = selectLatestGfsCycle(now());
    latestRun = Date.parse(
      `${latest.date.slice(0, 4)}-${latest.date.slice(4, 6)}-${latest.date.slice(6, 8)}T${pad(latest.hour)}:00:00Z`,
    );
    if (from < GFS_ARCHIVE_START)
      log(
        `[backfill] wind: the GFS bucket keeps this layout from the ${isoHour(GFS_ARCHIVE_START)} cycle (GFS v16; its cycles from 2021-01-01 to then have no atmos/ folder): earlier cycles are skipped`,
      );
    if (to - 6 * HOUR > latestRun)
      log(
        `[backfill] wind: cycles after ${isoHour(latestRun)} are not published yet: skipped`,
      );
  }
  let imagery = null;
  let areas = [];
  const firstImageDay = GIBS_FIRST_DAY[PRODUCTS.VIIRS.gibsLayer] ?? null;
  if (options.feeds.includes('recent-imagery')) {
    areas = options.areas?.length
      ? options.areas
      : readAreas(options.areasFile);
    if (!validAreas(areas).length)
      log(
        '[backfill] recent-imagery skipped: no areas (add them in the AI World tab, or pass --area lat,lon[,name])',
      );
    else {
      imagery = await imageryService(fetchImpl);
      if (firstImageDay && options.from < firstImageDay)
        log(
          `[backfill] recent-imagery: GIBS holds ${PRODUCTS.VIIRS.gibsLayer} from ${firstImageDay}: earlier days are skipped`,
        );
      if (to > now())
        log(
          '[backfill] recent-imagery: a day not over yet is skipped (its mosaic is still filling)',
        );
    }
  }
  for (let t = from; t < to; t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    const next = new Date(t + DAY).toISOString().slice(0, 10);
    // A day no daily feed's archive reaches passes without a line.
    let worked = false;
    if (options.feeds.includes('earthquakes')) {
      worked = true;
      const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${day}&endtime=${next}&minmagnitude=2.5`;
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
      totals.earthquakes =
        (totals.earthquakes || 0) +
        fileByHour(store, 'earthquakes', usgsRecords(await response.json()));
    }
    if (options.feeds.includes('local-firms')) {
      if (!options.firmsKey) {
        log(
          '[backfill] local-firms skipped: no FIRMS MAP_KEY (--firms-key or FIRMS_MAP_KEY)',
        );
        options.feeds = options.feeds.filter((f) => f !== 'local-firms');
      } else {
        worked = true;
        const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(options.firmsKey)}/VIIRS_SNPP_NRT/world/1/${day}`;
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error(`FIRMS HTTP ${response.status}`);
        totals['local-firms'] =
          (totals['local-firms'] || 0) +
          fileByHour(store, 'local-firms', firmsRecords(await response.text()));
      }
    }
    if (latestRun !== null) {
      // One cycle at a time; a cycle missing from the bucket, or failing,
      // is skipped and said so, and the run goes on.
      for (const hour of GFS_CYCLE_HOURS) {
        const run = t + hour * HOUR;
        if (run < GFS_ARCHIVE_START || run > latestRun) continue;
        worked = true;
        let files = null;
        try {
          files = await gfsCycle({ run, fetchImpl, decodeImpl });
          if (!files)
            log(`[backfill] wind ${isoHour(run)}: not in the bucket, skipped`);
        } catch (error) {
          log(`[backfill] wind ${isoHour(run)}: skipped (${error.message})`);
        }
        if (files)
          totals.wind = (totals.wind || 0) + fileEach(store, 'wind', files);
      }
    }
    if (
      imagery &&
      !(firstImageDay && day < firstImageDay) &&
      t + DAY <= now()
    ) {
      worked = true;
      const { files, missing, failures } = await imageryDay({
        day,
        areas,
        imagery,
      });
      totals['recent-imagery'] =
        (totals['recent-imagery'] || 0) +
        fileEach(store, 'recent-imagery', files);
      if (missing)
        log(`[backfill] recent-imagery ${day}: no image of ${missing} area(s)`);
      if (failures.length)
        log(
          `[backfill] recent-imagery ${day}: ${failures.length} image(s) failed (${failures[0].message})`,
        );
    }
    if (worked) log(`[backfill] ${day}: ${JSON.stringify(totals)}`);
  }
  return totals;
}

export async function main(argv = process.argv.slice(2)) {
  return backfill(parseArgs(argv));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(`[backfill] ${error.message}`);
    process.exitCode = 1;
  });
