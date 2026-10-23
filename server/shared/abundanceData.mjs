/**
 * The GLOBAL ABUNDANCE MAP's figures (owner request 2026-10-22): fetched
 * from the World Bank, Our World in Data and the OECD regional database,
 * kept thirty days in .gev-cache/abundance/, joined to the bundled Natural
 * Earth countries, states and provinces and cities (src/abundanceUnits.mjs)
 * and handed to the tab one level at a time (server/providers/abundance.js).
 * A state or province without a figure of its own takes its country's; a
 * city its state's, else its country's; every figure says where it came
 * from. The owner's own CSV figures (.gev-data/abundance/<level>.csv) go
 * on top.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ABUNDANCE_INDICATORS,
  ABUNDANCE_LEVELS,
  cleanLevel,
  coverageOf,
  oecdKey,
  packTable,
  parseAbundanceCsv,
  parseCsvRows,
} from '../../src/abundanceCore.mjs';
import {
  cityUnits,
  countryUnits,
  createCountryCodes,
  createUnitMatcher,
  ISO3_FIXES,
  regionUnits,
} from '../../src/abundanceUnits.mjs';
import { readWorldBankIndicator } from '../../src/demographics.mjs';

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
/** A CSV the owner loads: at most this many rows are kept. */
const IMPORT_ROWS_MAX = 20_000;

const WORLD_BANK_URL = (code) =>
  `https://api.worldbank.org/v2/country/all/indicator/${code}?format=json&per_page=20000&mrnev=1`;
const OWID_URL = (slug) =>
  `https://ourworldindata.org/grapher/${slug}.csv?v=1&csvType=full&useColumnShortNames=true`;
const OECD_URL = (flow, version, key) =>
  `https://sdmx.oecd.org/public/rest/data/OECD.CFE.EDS,${flow},${version}/${key}?lastNObservations=1&dimensionAtObservation=AllDimensions&format=csvfilewithlabels`;

/**
 * Every distinct source the indicators name, with the indicators and
 * levels it serves. A price level's two World Bank series are two sources.
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
          label: `World Bank WDI ${src.code}`,
          url: WORLD_BANK_URL(src.code),
          indicator: indicator.id,
          level,
        });
      else if (src.kind === 'ratio')
        for (const code of [src.of, src.by])
          add(`wb:${code}`, {
            kind: 'worldbank',
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
    if (!out[code] || out[code].year < year) out[code] = { value, year };
  }
  return out;
}

/**
 * The OECD's SDMX CSV with labels: one row per observation, with the area
 * code, its name, the country (regional flows carry it; urban areas do not),
 * the territorial level, the value and the year.
 */
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
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '_');
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
      if (kept && typeof kept === 'object' && kept.payload)
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
          fetchedAt: entry.fetchedAt,
          rows: entry.rows,
          payload: entry.payload,
        }),
      );
    } catch (error) {
      log(`cache not written: ${error?.message || error}`);
    }
  };

  const fetchOnce = (source) =>
    fetchImpl(source.url, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });

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
      const payload = readWorldBankIndicator(await response.json());
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
  const applyOwn = (level, units, matcher, codes) => {
    const byId = new Map(units.map((u) => [u.id, u]));
    const set = (unit, indicator, value, year, source) => {
      if (!unit || !Number.isFinite(value)) return;
      if (unit.values[indicator.id]?.from === 'own') return;
      unit.values[indicator.id] = {
        v: value,
        year: Number.isFinite(year) ? year : null,
        from: 'own',
        source,
      };
    };
    for (const indicator of indicators) {
      const src = indicator[level];
      if (!src) continue;
      if (src.kind === 'worldbank') {
        const payload = payloadOf(`wb:${src.code}`);
        for (const [iso2, { value, year }] of Object.entries(payload || {}))
          set(codes.fromIso2(iso2), indicator, value, year, 'worldbank');
      } else if (src.kind === 'ratio') {
        const of = payloadOf(`wb:${src.of}`) || {};
        const by = payloadOf(`wb:${src.by}`) || {};
        for (const [iso2, top] of Object.entries(of)) {
          const bottom = by[iso2];
          if (!bottom || !(bottom.value > 0)) continue;
          set(
            codes.fromIso2(iso2),
            indicator,
            Math.round((top.value / bottom.value) * 1000) / 1000,
            Math.min(top.year, bottom.year),
            'worldbank',
          );
        }
      } else if (src.kind === 'owid') {
        const payload = payloadOf(`owid:${src.slug}`);
        for (const [iso3, { value, year }] of Object.entries(payload || {}))
          set(codes.fromIso3(iso3), indicator, value, year, 'owid');
      } else if (src.kind === 'oecd') {
        const rows = payloadOf(`oecd:${src.flow}:${oecdKey(src, level)}`);
        if (!Array.isArray(rows)) continue;
        // Large regions before small ones: a state before its districts.
        const ordered = [...rows].sort(
          (a, b) => (a.level === 'TL3') - (b.level === 'TL3'),
        );
        for (const row of ordered) {
          const iso2 = countryIso2Of(codes, row);
          const unit = iso2 ? matcher.find(iso2, row.name) : null;
          set(
            unit && byId.get(unit.id),
            indicator,
            row.value,
            row.year,
            'oecd',
          );
        }
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
      };
    }
  };

  const buildLevel = (level) => {
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
    applyOwn('country', countryList, countryMatcher, codes);
    const countryImport = applyImport(
      'country',
      countryList,
      countryMatcher,
      codes,
      countryMatcher,
    );
    const countryByIso2 = new Map(
      countryList.filter((u) => u.iso2).map((u) => [u.iso2, u]),
    );
    if (level === 'country') return finish(level, countryList, countryImport);

    const regionList = regionUnits(admin1).map((u) => ({ ...u, values: {} }));
    const regionMatcher = createUnitMatcher(regionList);
    applyOwn('region', regionList, regionMatcher, codes);
    const regionImport = applyImport(
      'region',
      regionList,
      regionMatcher,
      codes,
      countryMatcher,
    );
    for (const unit of regionList)
      inherit(unit, countryByIso2.get(unit.iso2), 'country');
    if (level === 'region') return finish(level, regionList, regionImport);

    const cityList = cityUnits(places).map((u) => ({ ...u, values: {} }));
    const cityMatcher = createUnitMatcher(cityList);
    applyOwn('city', cityList, cityMatcher, codes);
    const cityImport = applyImport(
      'city',
      cityList,
      cityMatcher,
      codes,
      countryMatcher,
    );
    for (const unit of cityList) {
      const region = unit.adm1
        ? regionMatcher.find(unit.iso2, unit.adm1)
        : null;
      inherit(unit, region, 'region');
      inherit(unit, countryByIso2.get(unit.iso2), 'country');
    }
    return finish(level, cityList, cityImport);
  };

  const finish = (level, units, imported) => {
    const table = packTable(units);
    return {
      level,
      units: table.units,
      figures: table.figures,
      coverage: coverageOf(units),
      count: units.length,
      imported,
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
    get sources() {
      return sources;
    },
    close() {
      closed = true;
    },
  };
}
