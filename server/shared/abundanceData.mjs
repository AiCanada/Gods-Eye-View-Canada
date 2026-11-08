/**
 * The GLOBAL ABUNDANCE MAP's figures (owner request 2026-10-22): fetched
 * from the World Bank, Our World in Data and the OECD regional database,
 * kept thirty days in .gev-cache/abundance/, joined to the bundled Natural
 * Earth countries, states and provinces and cities (src/abundanceUnits.mjs)
 * and handed to the tab one level at a time (server/providers/abundance.js).
 * A state or province without a figure of its own takes its country's; a
 * city its state's, else its country's; every figure says where it came
 * from. The owner's own CSV figures (.gev-data/abundance/<level>.csv) go
 * on top. Every unit carries its people for the forecast's weights (the
 * World Bank's population for a country, shared out to its states and
 * provinces by their populated places' people, a city's own), and each
 * level's table also carries the forecast's hindcast: the figures as they
 * stood ten years ago walked forward and held against today's, with the
 * trend shift and swing scale per indicator that follow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ABUNDANCE_INDICATORS,
  ABUNDANCE_LEVELS,
  cleanLevel,
  coverageOf,
  indicatorRanks,
  oecdKey,
  packTable,
  parseAbundanceCsv,
  parseCsvRows,
} from '../../src/abundanceCore.mjs';
import {
  cityUnits,
  compoundParts,
  listUnits,
  countryUnits,
  createCountryCodes,
  createUnitMatcher,
  ISO3_FIXES,
  regionUnits,
} from '../../src/abundanceUnits.mjs';
import {
  HINDCAST_YEARS,
  PEOPLE_GROWTH_MAX,
  hindcast,
  seriesStats,
} from '../../src/abundanceForecast.mjs';
import { npyBytes } from '../../src/outbreakEpiShard.mjs';

const DEFAULT_PACKS_DIR = fileURLToPath(
  new URL('../../src/data/local_data/natural_earth/', import.meta.url),
);
/** Raw answers are kept this long before the next refresh. */
export const ABUNDANCE_CACHE_MS = 30 * 24 * 3_600_000;
const TIMEOUT_MS = 90_000;
/** A source that failed is not asked again before this. */
export const ABUNDANCE_RETRY_MS = 60 * 60_000;
/** The OECD rate-limits bursts: a pause between its requests, and one more try after a refusal. */
const OECD_PAUSE_MS = 10_000;
const RETRY_PAUSE_MS = 60_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GodsEyeViewCanada/0.2 (global abundance map)';
/**
 * Node's fetch sends `accept-language: *` unless told otherwise, and the
 * OECD answers a labelled CSV asked that way with HTTP 500 "Internal server
 * error" (2026-10-23; the same URL from curl, which sends none, answered).
 * The labels are matched against English names, so every source is asked
 * in English.
 */
const REQUEST_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: '*/*',
  'Accept-Language': 'en',
};
/** A CSV the owner loads: at most this many rows are kept. */
const IMPORT_ROWS_MAX = 20_000;

/**
 * The latest figures and the years behind them: the change over five years
 * for the readout, and the history the forecast walks forward from
 * (src/abundanceForecast.mjs: each figure's trend, swing, steps and mean).
 * The World Bank and Our World in Data give thirty years in one answer;
 * the OECD's regional tables are asked for fifteen, as most of its series
 * start around 2000 and each query carries every region of a level.
 */
export const WORLD_BANK_YEARS = 30;
export const OWID_YEARS = 30;
export const OECD_YEARS = 15;
/** A change is shown against a figure at least this many years older. */
export const TREND_YEARS = 5;
const TREND_YEARS_MIN = 3;
/** Raw answers of another shape are not read: the file names carry this. */
const CACHE_VERSION = 2;
/** A year is judged for collapse only with at least this many areas. */
const COLLAPSE_MIN_AREAS = 20;

const WORLD_BANK_URL = (code) =>
  `https://api.worldbank.org/v2/country/all/indicator/${code}?format=json&per_page=20000&mrnev=${WORLD_BANK_YEARS}`;
/** The years asked for again when a latest-values answer came back one value deep. */
const WORLD_BANK_RANGE_YEARS = 30;
const WORLD_BANK_RANGE_URL = (code, year) =>
  `https://api.worldbank.org/v2/country/all/indicator/${code}?format=json&per_page=20000&date=${year - WORLD_BANK_RANGE_YEARS}:${year}`;
const OWID_URL = (slug) =>
  `https://ourworldindata.org/grapher/${slug}.csv?v=1&csvType=full&useColumnShortNames=true`;
/** The World Bank's population series: every place's people, the forecast's weights, not an indicator. */
export const POPULATION_CODE = 'SP.POP.TOTL';

/** A population's growth weighs a year this many years back half as much as the latest: the rate of now, not of the thirty years. */
export const POPULATION_TREND_HALF_LIFE = 6;

/**
 * A population's growth a year from its series (any order): the log change
 * per year, the latest steps weighing most (half as much
 * POPULATION_TREND_HALF_LIFE years back), bounded to ±PEOPLE_GROWTH_MAX and
 * rounded; null with fewer than two points.
 */
export function populationGrowth(series) {
  const points = (series || [])
    .filter((p) => Number.isFinite(p?.year) && p?.value > 0)
    .sort((a, b) => a.year - b.year);
  if (points.length < 2) return null;
  const latest = points[points.length - 1].year;
  let span = 0;
  let rise = 0;
  for (let i = 1; i < points.length; i++) {
    const weight = Math.pow(
      0.5,
      (latest - points[i].year) / POPULATION_TREND_HALF_LIFE,
    );
    span += weight * (points[i].year - points[i - 1].year);
    rise += weight * Math.log(points[i].value / points[i - 1].value);
  }
  if (!(span > 0)) return null;
  const g = Math.max(
    -PEOPLE_GROWTH_MAX,
    Math.min(PEOPLE_GROWTH_MAX, rise / span),
  );
  return Math.round(g * 1e5) / 1e5;
}
const OECD_URL = (flow, version, key) =>
  `https://sdmx.oecd.org/public/rest/data/OECD.CFE.EDS,${flow},${version}/${key}?lastNObservations=${OECD_YEARS}&dimensionAtObservation=AllDimensions&format=csvfilewithlabels`;

/**
 * The latest point of a series and the one to measure its change against:
 * the newest at least TREND_YEARS older, else the oldest kept when it is
 * TREND_YEARS_MIN or more older; null with none.
 * @param {Array<{year: number, value: number}>} points any order
 */
export function latestAndPast(points) {
  const list = (points || [])
    .filter((p) => Number.isFinite(p?.value) && Number.isFinite(p?.year))
    .sort((a, b) => b.year - a.year);
  if (!list.length) return null;
  const latest = list[0];
  const past =
    list.find((p) => latest.year - p.year >= TREND_YEARS) ||
    (latest.year - list[list.length - 1].year >= TREND_YEARS_MIN
      ? list[list.length - 1]
      : null);
  return {
    value: latest.value,
    year: latest.year,
    past:
      past && past !== latest ? { value: past.value, year: past.year } : null,
  };
}

/**
 * One World Bank indicator (format=json, mrnev=N) as { ISO2: [{year, value}] },
 * newest first; aggregates and empty rows are left out.
 */
export function readWorldBankSeries(payload) {
  const rows = Array.isArray(payload) ? payload[1] : null;
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = row?.country?.id;
    const value = Number(row?.value);
    if (!/^[A-Z]{2}$/.test(code || '') || row?.value === null) continue;
    if (
      !Number.isFinite(value) ||
      !/^[A-Z]{3}$/.test(row?.countryiso3code || '')
    )
      continue;
    const year = Number(row.date);
    if (!Number.isFinite(year)) continue;
    (out[code] ||= []).push({ year, value });
  }
  for (const list of Object.values(out)) list.sort((a, b) => b.year - a.year);
  return out;
}

/**
 * Two answers for one series joined: newest first, each year once (the
 * first answer's figure kept), at most WORLD_BANK_YEARS points per country.
 */
export function mergeSeries(first, second) {
  const out = {};
  const codes = new Set([
    ...Object.keys(first || {}),
    ...Object.keys(second || {}),
  ]);
  for (const code of codes) {
    const byYear = new Map();
    for (const point of [...(first?.[code] || []), ...(second?.[code] || [])])
      if (!byYear.has(point.year)) byYear.set(point.year, point);
    out[code] = [...byYear.values()]
      .sort((a, b) => b.year - a.year)
      .slice(0, WORLD_BANK_YEARS);
  }
  return out;
}

/** The most points any country has in one series answer. */
const seriesDepth = (payload) =>
  Object.values(payload || {}).reduce(
    (most, list) => Math.max(most, list.length),
    0,
  );

/**
 * Every distinct source the indicators name, with the indicators and
 * levels it serves (a price level's two World Bank series are two sources),
 * and the World Bank's population, which names no indicator but weighs
 * every place in the forecast.
 */
export function abundanceSources(indicators = ABUNDANCE_INDICATORS) {
  const sources = new Map();
  const add = (id, source) => {
    const known = sources.get(id);
    if (known) {
      if (!known.indicators.includes(source.indicator))
        known.indicators.push(source.indicator);
      if (!known.levels.includes(source.level)) known.levels.push(source.level);
      return;
    }
    sources.set(id, {
      id,
      kind: source.kind,
      ...(source.code ? { code: source.code } : {}),
      label: source.label,
      url: source.url,
      indicators: [source.indicator],
      levels: [source.level],
    });
  };
  for (const indicator of indicators)
    for (const level of ABUNDANCE_LEVELS) {
      const src = indicator[level];
      if (!src) continue;
      if (src.kind === 'worldbank')
        add(`wb:${src.code}`, {
          kind: 'worldbank',
          code: src.code,
          label: `World Bank WDI ${src.code}`,
          url: WORLD_BANK_URL(src.code),
          indicator: indicator.id,
          level,
        });
      else if (src.kind === 'ratio')
        for (const code of [src.of, src.by])
          add(`wb:${code}`, {
            kind: 'worldbank',
            code,
            label: `World Bank WDI ${code}`,
            url: WORLD_BANK_URL(code),
            indicator: indicator.id,
            level,
          });
      else if (src.kind === 'owid')
        add(`owid:${src.slug}`, {
          kind: 'owid',
          label: `Our World in Data ${src.slug}`,
          url: OWID_URL(src.slug),
          indicator: indicator.id,
          level,
        });
      else if (src.kind === 'oecd') {
        const key = oecdKey(src, level);
        add(`oecd:${src.flow}:${key}`, {
          kind: 'oecd',
          label: `OECD ${src.flow.split('@').pop()} ${key}`,
          url: OECD_URL(src.flow, src.version, key),
          indicator: indicator.id,
          level,
        });
      }
    }
  const population = `wb:${POPULATION_CODE}`;
  if (!sources.has(population))
    sources.set(population, {
      id: population,
      kind: 'worldbank',
      code: POPULATION_CODE,
      label: `World Bank WDI ${POPULATION_CODE}`,
      url: WORLD_BANK_URL(POPULATION_CODE),
      indicators: [],
      levels: ['country'],
    });
  return [...sources.values()];
}

/** One indicator's Our World in Data CSV: the latest year per country code. */
export function readOwidCsv(text, column) {
  const rows = parseCsvRows(text);
  if (!rows.length) return {};
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const codeAt = header.indexOf('code');
  const yearAt = header.indexOf('year');
  let valueAt = header.indexOf(String(column).toLowerCase());
  if (valueAt < 0) valueAt = header.length - 1;
  if (codeAt < 0 || yearAt < 0) return {};
  const out = {};
  for (const row of rows.slice(1)) {
    const code = String(row[codeAt] || '').trim();
    if (!code) continue;
    const value = Number(row[valueAt]);
    const year = Number(row[yearAt]);
    if (!Number.isFinite(value) || !Number.isFinite(year)) continue;
    if (code.startsWith('OWID_') && !ISO3_FIXES[code]) continue;
    (out[code] ||= []).push({ year, value });
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => b.year - a.year);
    list.splice(OWID_YEARS);
  }
  return out;
}

/**
 * The OECD's SDMX CSV with labels: one row per observation, with the area
 * code, its name, the country (regional flows carry it; urban areas do not),
 * the territorial level, the value and the year.
 */
/**
 * The years in which a release's figures collapse: the median over its
 * areas below a twentieth of the median of its other years. A real series
 * never does this; a broken release does (the OECD's urban air pollution
 * release 1.5, 2026-10-09, wrote near-zero values for every area in 2023).
 * Exact zeros are left out: the OECD writes 0 where it has no figure (half
 * its small regions' tertiary education), which is no collapse. Years with
 * fewer than COLLAPSE_MIN_AREAS other values are not judged.
 * @param {Array<{year: number, value: number}>} rows
 * @returns {number[]}
 */
export function collapsedYears(rows) {
  const byYear = new Map();
  for (const row of rows || []) {
    if (!Number.isFinite(row?.year) || !Number.isFinite(row?.value)) continue;
    if (row.value === 0) continue;
    const list = byYear.get(row.year) || [];
    list.push(Math.abs(row.value));
    byYear.set(row.year, list);
  }
  const median = (list) => {
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const medians = [...byYear]
    .filter(([, list]) => list.length >= COLLAPSE_MIN_AREAS)
    .map(([year, list]) => [year, median(list)]);
  if (medians.length < 2) return [];
  const out = [];
  for (const [year, value] of medians) {
    const typical = median(
      medians.filter(([other]) => other !== year).map(([, v]) => v),
    );
    if (typical > 0 && value < typical / 20) out.push(year);
  }
  return out.sort((a, b) => a - b);
}

export function readOecdCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim());
  const at = (name) => header.indexOf(name);
  const area = at('REF_AREA');
  const name = at('Reference area');
  const country = at('COUNTRY');
  const level = at('TERRITORIAL_LEVEL');
  const value = at('OBS_VALUE');
  const year = at('TIME_PERIOD');
  if (area < 0 || value < 0) return [];
  const out = [];
  for (const row of rows.slice(1)) {
    const v = Number(row[value]);
    if (!Number.isFinite(v)) continue;
    out.push({
      area: String(row[area] || '').trim(),
      name: name >= 0 ? String(row[name] || '').trim() : '',
      iso3: country >= 0 ? String(row[country] || '').trim() : null,
      level: level >= 0 ? String(row[level] || '').trim() : '',
      value: v,
      year: year >= 0 ? Number(row[year]) || null : null,
    });
  }
  return out;
}

function safeName(id) {
  return `${String(id).replace(/[^A-Za-z0-9._-]+/g, '_')}.v${CACHE_VERSION}`;
}

/**
 * @param {object} options
 * @param {string} options.root The checkout: caches under .gev-cache/abundance, the owner's CSVs under .gev-data/abundance.
 */
export function createAbundanceStore({
  root = process.cwd(),
  packsDir = DEFAULT_PACKS_DIR,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = () => {},
  timeoutMs = TIMEOUT_MS,
  cacheMs = ABUNDANCE_CACHE_MS,
  oecdPauseMs = OECD_PAUSE_MS,
  retryPauseMs = RETRY_PAUSE_MS,
  indicators = ABUNDANCE_INDICATORS,
} = {}) {
  const cacheDir = path.join(root, '.gev-cache', 'abundance');
  const dataDir = path.join(root, '.gev-data', 'abundance');
  const sources = abundanceSources(indicators);
  /** Raw answers by source id: { fetchedAt, rows, payload, error, attemptedAt }. */
  const raw = new Map();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const builds = new Map();
  let packs = null;
  let refreshing = null;
  let progress = null;
  let closed = false;

  const cacheFile = (id) => path.join(cacheDir, `${safeName(id)}.json`);
  const importFile = (level) => path.join(dataDir, `${level}.csv`);

  const loadPacks = () => {
    if (packs) return packs;
    const read = (name) =>
      JSON.parse(fs.readFileSync(path.join(packsDir, name), 'utf8'));
    packs = {
      countries: read('countries.json'),
      admin1: read('states_provinces.json'),
      places: read('places.json'),
    };
    return packs;
  };

  const readCache = (source) => {
    try {
      const kept = JSON.parse(fs.readFileSync(cacheFile(source.id), 'utf8'));
      // An answer to another URL (another release, key or query) is not
      // this source's answer, nor is an OWID answer read to another depth
      // (the URL says nothing of how many years were kept).
      if (
        kept &&
        typeof kept === 'object' &&
        kept.payload &&
        kept.url === source.url &&
        (source.kind !== 'owid' || kept.years === OWID_YEARS)
      )
        raw.set(source.id, {
          fetchedAt: Number(kept.fetchedAt) || 0,
          rows: Number(kept.rows) || 0,
          payload: kept.payload,
          error: null,
        });
    } catch {
      /* no cache yet */
    }
  };
  for (const source of sources) readCache(source);

  const writeCache = (source, entry) => {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        cacheFile(source.id),
        JSON.stringify({
          id: source.id,
          url: source.url,
          ...(source.kind === 'owid' ? { years: OWID_YEARS } : {}),
          fetchedAt: entry.fetchedAt,
          rows: entry.rows,
          payload: entry.payload,
        }),
      );
    } catch (error) {
      log(`cache not written: ${error?.message || error}`);
    }
  };

  const fetchUrl = (url) =>
    fetchImpl(url, {
      headers: { ...REQUEST_HEADERS },
      signal: AbortSignal.timeout(timeoutMs),
    });
  const fetchOnce = (source) => fetchUrl(source.url);

  /**
   * The World Bank has answered mrnev=N with one value per country while
   * the same series asked by years held them all (2026-10-23: inflation
   * and forest area). A one-deep answer is asked again by years and the
   * two are joined, so the change over five years is there; the first
   * answer stands alone when the second fails.
   */
  const deepenWorldBank = async (source, payload) => {
    if (!source.code || seriesDepth(payload) > 1) return payload;
    const year = new Date(now()).getUTCFullYear();
    try {
      const again = await fetchUrl(WORLD_BANK_RANGE_URL(source.code, year));
      if (again.ok)
        return mergeSeries(payload, readWorldBankSeries(await again.json()));
      log(`${source.label} by years: HTTP ${again.status}`);
    } catch (error) {
      log(`${source.label} by years: ${error?.message || error}`);
    }
    return payload;
  };

  const fetchSource = async (source) => {
    let response = await fetchOnce(source);
    if (
      (response.status === 429 || response.status >= 500) &&
      source.kind === 'oecd'
    ) {
      await sleep(retryPauseMs);
      response = await fetchOnce(source);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (source.kind === 'worldbank') {
      const payload = await deepenWorldBank(
        source,
        readWorldBankSeries(await response.json()),
      );
      return { payload, rows: Object.keys(payload).length };
    }
    const text = await response.text();
    if (source.kind === 'owid') {
      const indicator = indicators.find((i) =>
        source.indicators.includes(i.id),
      );
      const payload = readOwidCsv(text, indicator?.country?.column);
      return { payload, rows: Object.keys(payload).length };
    }
    const payload = readOecdCsv(text);
    // A release whose figures collapse in a year is broken: refused, so
    // the source shows as failed and the last good answer stays in use.
    const collapsed = collapsedYears(payload);
    if (collapsed.length)
      throw new Error(
        `broken release: the ${collapsed.join(', ')} figures are near zero`,
      );
    return { payload, rows: payload.length };
  };

  const fresh = (entry) =>
    Boolean(entry?.payload) && now() - (entry.fetchedAt || 0) < cacheMs;
  /** Due for a fetch: no fresh answer, and no attempt within the retry wait. */
  const due = (entry) =>
    !fresh(entry) && now() - (entry?.attemptedAt || 0) >= ABUNDANCE_RETRY_MS;

  /** Fetch every source whose answer is missing or old (all with `force`); one run at a time. */
  const refresh = ({ force = false } = {}) => {
    if (refreshing) return refreshing;
    if (closed) return Promise.resolve(status());
    const todo = sources.filter((s) => force || due(raw.get(s.id)));
    progress = { done: 0, total: todo.length, current: todo[0]?.label || '' };
    refreshing = (async () => {
      let lastOecdAt = 0;
      /** One source fetched, paced after the OECD's last request; true when it answered. */
      const take = async (source) => {
        progress.current = source.label;
        if (source.kind === 'oecd') {
          const wait = oecdPauseMs - (now() - lastOecdAt);
          if (wait > 0) await sleep(wait);
        }
        let ok = true;
        try {
          const { payload, rows } = await fetchSource(source);
          const entry = {
            fetchedAt: now(),
            attemptedAt: now(),
            rows,
            payload,
            error: null,
          };
          raw.set(source.id, entry);
          writeCache(source, entry);
          log(`${source.label}: ${rows} rows`);
        } catch (error) {
          ok = false;
          const kept = raw.get(source.id);
          raw.set(source.id, {
            ...(kept || { fetchedAt: 0, rows: 0, payload: null }),
            attemptedAt: now(),
            error: String(error?.message || error),
          });
          log(`${source.label}: ${error?.message || error}`);
        }
        if (source.kind === 'oecd') lastOecdAt = now();
        return ok;
      };
      const refused = [];
      for (const source of todo) {
        if (closed) break;
        if (!(await take(source)) && source.kind === 'oecd') {
          const why = raw.get(source.id)?.error || '';
          if (/HTTP (?:429|5\d\d)/.test(why)) refused.push(source);
        }
        progress.done += 1;
      }
      // The OECD refuses bursts with 429 and 500: a second pass after a
      // rest, so the first fill is whole more often than not.
      if (refused.length && !closed) {
        progress.current = refused[0].label;
        await sleep(retryPauseMs);
        for (const source of refused) {
          if (closed) break;
          await take(source);
        }
      }
      builds.clear();
      return status();
    })().finally(() => {
      refreshing = null;
      progress = null;
    });
    return refreshing;
  };

  const payloadOf = (id) => raw.get(id)?.payload || null;

  // --- building a level -------------------------------------------------------
  const countryIso2Of = (codes, row) =>
    (row.iso3 ? codes.fromIso3(row.iso3) : null)?.iso2 ||
    codes.fromOecdArea(row.area)?.iso2 ||
    null;

  /** Own figures for one level from its sources; `countriesByIso2` for the country level's keys. */
  /**
   * A series' latest figure with its change, as a unit's value, and the
   * history behind it for the forecast (its trend `g`, swing `s`, steps `n`
   * and mean level `m` in the indicator's own walking space).
   */
  const figure = (series, from, source, indicator, level) => {
    const latest = latestAndPast(series);
    if (!latest) return null;
    const out = { v: latest.value, year: latest.year, from, source };
    if (latest.past) {
      out.d = Math.round((latest.value - latest.past.value) * 1000) / 1000;
      out.y0 = latest.past.year;
    }
    const stats = seriesStats(indicator, series, level);
    if (stats) {
      out.n = stats.n;
      out.m = stats.m;
      if (stats.g !== null) out.g = stats.g;
      if (stats.s !== null) out.s = stats.s;
    }
    return out;
  };

  /** Own figures for one level from its sources; as of `upTo` when given (the hindcast's past). */
  const applyOwn = (level, units, matcher, codes, upTo = null) => {
    const byId = new Map(units.map((u) => [u.id, u]));
    const set = (unit, indicator, series, source, from = 'own') => {
      const target = unit && byId.get(unit.id);
      if (!target) return;
      const kept = target.values[indicator.id];
      if (kept?.from === 'own' || (kept && from === 'area')) return;
      const usable = indicator.positive
        ? (series || []).filter((p) => p.value > 0)
        : series || [];
      const dated =
        upTo === null ? usable : usable.filter((p) => p.year <= upTo);
      const f = figure(dated, from, source, indicator, level);
      if (f) target.values[indicator.id] = f;
    };
    for (const indicator of indicators) {
      const src = indicator[level];
      if (!src) continue;
      if (src.kind === 'worldbank') {
        const payload = payloadOf(`wb:${src.code}`);
        for (const [iso2, series] of Object.entries(payload || {}))
          set(codes.fromIso2(iso2), indicator, series, 'worldbank');
      } else if (src.kind === 'ratio') {
        const of = payloadOf(`wb:${src.of}`) || {};
        const by = payloadOf(`wb:${src.by}`) || {};
        for (const [iso2, tops] of Object.entries(of)) {
          const bottoms = new Map(
            (by[iso2] || []).map((p) => [p.year, p.value]),
          );
          const series = (tops || [])
            .filter((p) => bottoms.get(p.year) > 0)
            .map((p) => ({
              year: p.year,
              value: Math.round((p.value / bottoms.get(p.year)) * 1000) / 1000,
            }));
          set(codes.fromIso2(iso2), indicator, series, 'worldbank');
        }
      } else if (src.kind === 'owid') {
        const payload = payloadOf(`owid:${src.slug}`);
        for (const [iso3, series] of Object.entries(payload || {}))
          set(codes.fromIso3(iso3), indicator, series, 'owid');
      } else if (src.kind === 'oecd') {
        const rows = payloadOf(`oecd:${src.flow}:${oecdKey(src, level)}`);
        if (!Array.isArray(rows)) continue;
        // One series per area, large regions before small ones: a state
        // before its districts.
        const areas = new Map();
        for (const row of rows) {
          const key = `${row.level}|${row.area}`;
          const area = areas.get(key) || {
            level: row.level,
            area: row.area,
            name: row.name,
            iso3: row.iso3,
            points: [],
          };
          area.points.push({ year: row.year, value: row.value });
          areas.set(key, area);
        }
        const ordered = [...areas.values()].sort(
          (a, b) => (a.level === 'TL3') - (b.level === 'TL3'),
        );
        // The unit the area names. A region's name listing places
        // ("Hartlepool and Stockton-on-Tees") is matched whole only by name:
        // the prefix rule would give the list's figure to its first place
        // alone. A small region's list gives it to each place it names; a
        // large region's ("Castile and León") is a larger region, never its
        // parts. An urban area named after two places is one city: found by
        // its first name ("Brighton and Hove"), else by the places it names
        // ("Cheshire West and Chester").
        const grouped = [];
        for (const area of ordered) {
          const iso2 = countryIso2Of(codes, area);
          if (!iso2) continue;
          const listed = compoundParts(area.name).length > 1;
          const strict = listed && level === 'region';
          const unit = matcher.find(iso2, area.name, { prefix: !strict });
          if (unit) {
            set(unit, indicator, area.points, 'oecd');
            continue;
          }
          const parts =
            listed && (level !== 'region' || area.level === 'TL3')
              ? listUnits(matcher, iso2, area.name)
              : [];
          for (const part of parts) set(part, indicator, area.points, 'oecd');
          if (!parts.length) grouped.push([iso2, area]);
        }
        // A larger region's figure for every unit inside it that has none.
        for (const [iso2, area] of grouped)
          for (const unit of matcher.findGroup(iso2, area.name))
            set(unit, indicator, area.points, 'oecd', 'area');
      }
    }
  };

  /** The owner's CSV for a level, applied over the sources. */
  const applyImport = (level, units, matcher, codes, countryMatcher) => {
    const file = importFile(level);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const parsed = parseAbundanceCsv(text, indicators);
    const byId = new Map(units.map((u) => [u.id, u]));
    let matched = 0;
    for (const row of parsed.rows.slice(0, IMPORT_ROWS_MAX)) {
      let unit = row.id
        ? byId.get(row.id) || byId.get(row.id.toUpperCase())
        : null;
      if (!unit && row.name) {
        const country = row.country
          ? codes.fromIso2(row.country) ||
            codes.fromIso3(row.country) ||
            countryMatcher.find(row.country)
          : null;
        const found =
          level === 'country'
            ? countryMatcher.find(row.name)
            : country
              ? matcher.find(country.iso2, row.name)
              : null;
        unit = found ? byId.get(found.id) : null;
      }
      if (!unit) continue;
      matched += 1;
      for (const [id, v] of Object.entries(row.values))
        unit.values[id] = { v, year: row.year, from: 'csv', source: 'csv' };
    }
    let at = null;
    try {
      at = fs.statSync(file).mtimeMs;
    } catch {
      /* gone */
    }
    return {
      rows: parsed.rows.length,
      matched,
      ignored: parsed.ignored,
      error: parsed.error || null,
      at,
    };
  };

  /** A unit above's figure handed down, saying where it came from. */
  const inherit = (unit, above, from) => {
    if (!above) return;
    for (const indicator of indicators) {
      if (unit.values[indicator.id]) continue;
      const f = above.values[indicator.id];
      if (!f) continue;
      unit.values[indicator.id] = {
        v: f.v,
        year: f.year,
        from: f.from === 'own' || f.from === 'csv' ? from : f.from,
        source: f.source,
        ...(Number.isFinite(f.d) ? { d: f.d, y0: f.y0 } : {}),
        // The history travels with the figure: the place walks forward on
        // the series it took.
        ...(Number.isFinite(f.n) ? { n: f.n, m: f.m } : {}),
        ...(Number.isFinite(f.g) ? { g: f.g } : {}),
        ...(Number.isFinite(f.s) ? { s: f.s } : {}),
      };
    }
  };

  /**
   * Every place's people, the forecast's weights (src/abundanceForecast.mjs,
   * peopleOf). A country's: the World Bank's population, else its populated
   * places' people together; and its growth a year from the thirty-year
   * series (populationGrowth), which its states and cities take.
   */
  const peopleOfCountries = (countryList, placeList) => {
    const placed = new Map();
    for (const p of placeList)
      if (p.iso2 && p.pop > 0)
        placed.set(p.iso2, (placed.get(p.iso2) || 0) + p.pop);
    const population = payloadOf(`wb:${POPULATION_CODE}`) || {};
    for (const unit of countryList) {
      const series = unit.iso2 ? population[unit.iso2] : null;
      const latest = series?.[0]?.value;
      const people = latest > 0 ? latest : placed.get(unit.iso2);
      if (people > 0) unit.people = Math.round(people);
      const growth = populationGrowth(series);
      if (growth !== null) unit.peopleGrowth = growth;
    }
  };

  /**
   * A state's or province's people: its share of its country's. A unit the
   * states pack gives a population (Wikidata's, `pop`) takes its share of
   * those figures, of what the country's people leave after the units
   * without one; those take the share-out, nine tenths by the people of
   * their populated places and one tenth equally (so a province with no
   * populated place still counts), equally when the country has no placed
   * people. A country with no figure at all is shared out whole. A figure
   * no smaller than the country's own, in a country of several units, is a
   * slip (a district given its whole country's people) and is left aside.
   */
  const peopleOfRegions = (regionList, matcher, countryByIso2, placeList) => {
    const byCountry = new Map();
    for (const unit of regionList) {
      if (!unit.iso2) continue;
      if (!byCountry.has(unit.iso2)) byCountry.set(unit.iso2, []);
      byCountry.get(unit.iso2).push(unit);
    }
    const placed = new Map();
    for (const p of placeList) {
      if (!p.adm1 || !(p.pop > 0)) continue;
      const region = matcher.find(p.iso2, p.adm1);
      if (region) placed.set(region.id, (placed.get(region.id) || 0) + p.pop);
    }
    for (const [iso2, regions] of byCountry) {
      const country = countryByIso2.get(iso2);
      if (!(country?.people > 0)) continue;
      const total = regions.reduce(
        (sum, r) => sum + (placed.get(r.id) || 0),
        0,
      );
      const shareOut = (r) =>
        total > 0
          ? (0.9 * (placed.get(r.id) || 0)) / total + 0.1 / regions.length
          : 1 / regions.length;
      const counted = new Set(
        regions.filter(
          (r) =>
            Number.isFinite(r.pop) &&
            r.pop >= 0 &&
            (regions.length === 1 || r.pop < country.people),
        ),
      );
      let figures = 0;
      for (const r of counted) figures += r.pop;
      let left = 1;
      if (figures > 0)
        for (const r of regions) if (!counted.has(r)) left -= shareOut(r);
      for (const r of regions) {
        const share =
          figures > 0 && counted.has(r)
            ? (r.pop / figures) * left
            : shareOut(r);
        r.people = Math.round(country.people * share);
        if (Number.isFinite(country.peopleGrowth))
          r.peopleGrowth = country.peopleGrowth;
      }
    }
  };

  /**
   * A level's units with their figures: the sources' own (as of `upTo`
   * when given: the hindcast's past), the owner's CSV on top (today only),
   * the rest handed down, and every unit's people.
   * @returns {{units: object[], imported: object|null}}
   */
  const buildUnits = (level, { upTo = null } = {}) => {
    const { countries, admin1, places } = loadPacks();
    const countryList = countryUnits(countries).map((u) => ({
      ...u,
      values: {},
    }));
    const codes = createCountryCodes(countryList);
    // Countries are matched by name alone, and answer with the real unit.
    const byCountryId = new Map(countryList.map((u) => [u.id, u]));
    const nameMatcher = createUnitMatcher(
      countryList.map((u) => ({ ...u, iso2: 'XX' })),
    );
    const countryMatcher = {
      find: (name) => {
        const hit = nameMatcher.find('XX', name);
        return hit ? byCountryId.get(hit.id) : null;
      },
    };
    const imports = upTo === null;
    applyOwn('country', countryList, countryMatcher, codes, upTo);
    const countryImport = imports
      ? applyImport(
          'country',
          countryList,
          countryMatcher,
          codes,
          countryMatcher,
        )
      : null;
    const countryByIso2 = new Map(
      countryList.filter((u) => u.iso2).map((u) => [u.iso2, u]),
    );
    const placeList = cityUnits(places);
    peopleOfCountries(countryList, placeList);
    if (level === 'country')
      return { units: countryList, imported: countryImport };

    const regionList = regionUnits(admin1).map((u) => ({ ...u, values: {} }));
    const regionMatcher = createUnitMatcher(regionList);
    applyOwn('region', regionList, regionMatcher, codes, upTo);
    const regionImport = imports
      ? applyImport('region', regionList, regionMatcher, codes, countryMatcher)
      : null;
    for (const unit of regionList)
      inherit(unit, countryByIso2.get(unit.iso2), 'country');
    peopleOfRegions(regionList, regionMatcher, countryByIso2, placeList);
    if (level === 'region')
      return { units: regionList, imported: regionImport };

    const cityList = placeList.map((u) => ({ ...u, values: {} }));
    const cityMatcher = createUnitMatcher(cityList);
    applyOwn('city', cityList, cityMatcher, codes, upTo);
    const cityImport = imports
      ? applyImport('city', cityList, cityMatcher, codes, countryMatcher)
      : null;
    for (const unit of cityList) {
      const region = unit.adm1
        ? regionMatcher.find(unit.iso2, unit.adm1)
        : null;
      inherit(unit, region, 'region');
      inherit(unit, countryByIso2.get(unit.iso2), 'country');
      if (unit.pop > 0) unit.people = unit.pop;
      const home = countryByIso2.get(unit.iso2);
      if (Number.isFinite(home?.peopleGrowth))
        unit.peopleGrowth = home.peopleGrowth;
    }
    return { units: cityList, imported: cityImport };
  };

  /**
   * The hindcast: the level's figures as they stood HINDCAST_YEARS before
   * their newest year, walked forward by the forecast and held against
   * today's (src/abundanceForecast.mjs, hindcast); null with no figures,
   * or when the replay fails.
   */
  const hindcastFor = (level, present) => {
    let newest = null;
    for (const unit of present)
      for (const f of Object.values(unit.values || {}))
        if (Number.isFinite(f?.year) && (newest === null || f.year > newest))
          newest = f.year;
    if (newest === null) return null;
    try {
      // Two windows: ten years ago against today, and twenty years ago
      // against ten years ago.
      const middle = buildUnits(level, {
        upTo: newest - HINDCAST_YEARS,
      }).units;
      const earlier = buildUnits(level, {
        upTo: newest - 2 * HINDCAST_YEARS,
      }).units;
      return hindcast(
        [
          { past: middle, present, from: newest - HINDCAST_YEARS, to: newest },
          {
            past: earlier,
            present: middle,
            from: newest - 2 * HINDCAST_YEARS,
            to: newest - HINDCAST_YEARS,
          },
        ],
        { level },
      );
    } catch (error) {
      log(`hindcast ${level}: ${error?.message || error}`);
      return null;
    }
  };

  const buildLevel = (level) => {
    const { units, imported } = buildUnits(level);
    return finish(level, units, imported, hindcastFor(level, units));
  };

  const finish = (level, units, imported, report) => {
    const table = packTable(units);
    return {
      level,
      units: table.units.map(sentUnit),
      figures: table.figures,
      coverage: coverageOf(units),
      count: units.length,
      imported,
      hindcast: report,
      builtAt: now(),
    };
  };

  const built = (level) => {
    const key = cleanLevel(level);
    let table = builds.get(key);
    if (!table) {
      table = buildLevel(key);
      builds.set(key, table);
    }
    return table;
  };

  const newestAt = () =>
    [...raw.values()].reduce((m, e) => Math.max(m, e.fetchedAt || 0), 0) ||
    null;
  const stale = () => sources.some((s) => !fresh(raw.get(s.id)));
  const anyDue = () => sources.some((s) => due(raw.get(s.id)));

  /** Everything the tab's DATA section shows. */
  function status() {
    const levels = {};
    for (const level of ABUNDANCE_LEVELS) {
      const table = built(level);
      levels[level] = {
        units: table.count,
        coverage: table.coverage,
        imported: table.imported,
        hindcast: table.hindcast,
      };
    }
    return {
      refreshing: progress ? { ...progress } : null,
      refreshedAt: newestAt(),
      stale: stale(),
      sources: sources.map((s) => {
        const entry = raw.get(s.id);
        return {
          id: s.id,
          kind: s.kind,
          label: s.label,
          url: s.url,
          indicators: s.indicators,
          levels: s.levels,
          fetchedAt: entry?.fetchedAt || null,
          rows: entry?.rows || 0,
          error: entry?.error || null,
        };
      }),
      levels,
    };
  }

  return {
    status,
    /** One level's units and figures. A stale cache starts a refresh in the background. */
    data(level) {
      if (anyDue() && !refreshing && !closed)
        refresh().catch((error) => log(`refresh: ${error?.message || error}`));
      const table = built(level);
      return {
        ...table,
        refreshedAt: newestAt(),
        refreshing: progress ? { ...progress } : null,
        stale: stale(),
      };
    },
    refresh,
    /** The owner's CSV for a level: kept under .gev-data/abundance/, applied over the sources. */
    importCsv({ level, csv } = {}) {
      const key = cleanLevel(level);
      const text = String(csv ?? '');
      const parsed = parseAbundanceCsv(text, indicators);
      if (parsed.error) return { error: parsed.error, ignored: parsed.ignored };
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(importFile(key), text);
      builds.clear();
      const table = built(key);
      return {
        ok: true,
        level: key,
        imported: table.imported,
        status: status(),
      };
    },
    clearImport({ level } = {}) {
      const key = cleanLevel(level);
      try {
        fs.rmSync(importFile(key), { force: true });
      } catch {
        /* nothing to remove */
      }
      builds.clear();
      return { ok: true, level: key, status: status() };
    },
    /**
     * The countries' places among the others, 0 to 1, per indicator and as
     * the equal-weight score, for each of a world's places by its country:
     * `{ data: Float32Array, shape: [n, channels.length], channels }`, NaN
     * where the country has no figure (src/demographics.mjs's pattern).
     */
    worldFeatures(world) {
      const table = built('country');
      const units = expandTableUnits(table);
      const byIso2 = new Map(
        units.filter((u) => u.iso2).map((u) => [u.iso2, u]),
      );
      const channels = [
        ...indicators.map((i) => `abundance_${i.id}`),
        'abundance',
      ];
      const ranks = indicators.map((i) => indicatorRanks(units, i));
      const nodes = Array.isArray(world?.nodes) ? world.nodes : [];
      const C = channels.length;
      const data = new Float32Array(nodes.length * C).fill(NaN);
      nodes.forEach((node, k) => {
        const unit = byIso2.get(String(node?.country || ''));
        if (!unit) return;
        let sum = 0;
        let counted = 0;
        ranks.forEach((map, j) => {
          const r = map.get(unit.id);
          if (r === undefined) return;
          data[k * C + j] = r / 100;
          sum += r;
          counted += 1;
        });
        if (counted) data[k * C + C - 1] = sum / counted / 100;
      });
      return { data, shape: [nodes.length, C], channels };
    },
    /** Write a world's abundance features beside its demographics: abundance-<worldId>.npy and .json. */
    writeWorldFeatures(world, outDir) {
      if (!world?.worldId) return null;
      const { data, shape, channels } = this.worldFeatures(world);
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `abundance-${world.worldId}.npy`);
      fs.writeFileSync(file, npyBytes(data, shape));
      fs.writeFileSync(
        path.join(outDir, `abundance-${world.worldId}.json`),
        JSON.stringify({
          worldId: world.worldId,
          channels,
          licence:
            'World Bank WDI (CC BY 4.0), Our World in Data (CC BY 4.0), OECD regional database (OECD terms)',
          builtAt: now(),
        }),
      );
      return file;
    },
    get sources() {
      return sources;
    },
    close() {
      closed = true;
    },
  };
}

/**
 * A unit as the tab receives it: what it names, places and counts, not the
 * alternative names, the postal code and the larger region the server
 * matched sources by. The states and provinces carry a third of their bytes
 * in those, and the tab never reads them.
 */
export function sentUnit(unit) {
  const out = { id: unit.id, name: unit.name };
  for (const key of [
    'country',
    'iso2',
    'adm1',
    'lat',
    'lon',
    'pop',
    'people',
    'peopleGrowth',
  ])
    if (unit[key] !== undefined && unit[key] !== null) out[key] = unit[key];
  if (unit.capital) out.capital = true;
  return out;
}

/** A built level's units with their values back as objects. */
function expandTableUnits(table) {
  const figures = table?.figures || {};
  return (table?.units || []).map((u, k) => {
    const values = {};
    for (const [id, column] of Object.entries(figures)) {
      const v = column?.v?.[k];
      if (v !== null && v !== undefined && Number.isFinite(Number(v)))
        values[id] = { v: Number(v) };
    }
    return { ...u, values };
  });
}
