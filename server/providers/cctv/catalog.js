import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CCTV_SOURCE_FILE,
  DEFAULT_CCTV_MAX_SOURCES,
  CCTV_MAX_SOURCES_HARD_CAP,
  CCTV_SOURCE_CACHE_MS,
  DEFAULT_CCTV_COUNTRIES,
  DEFAULT_CCTV_REGION_CAP,
} from './constants.js';
import { normalizeSourceItem } from './normalize.js';
import {
  loadAustinSourcesFromOpenData,
  loadCaltransSourcesFromOpenData,
  loadTflSourcesFromOpenData,
} from './sources.js';
/**
 * Parse CCTV_COUNTRIES into the set of ISO country codes to serve.
 *
 * Country gating is what keeps the catalogue from pulling every camera on the
 * planet: a country that is switched off is never fetched and never cached, so
 * its streams cost nothing. "*" or "ALL" serves every country; an explicitly
 * empty value serves none.
 *
 * @returns {Set<string>|null} Enabled codes, or null meaning every country.
 */
export function enabledCctvCountries(env = process.env) {
  const raw = String(env.CCTV_COUNTRIES ?? DEFAULT_CCTV_COUNTRIES).trim();
  if (!raw) return new Set();
  const codes = raw
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  if (codes.includes('*') || codes.includes('ALL')) return null;
  return new Set(codes);
}

/**
 * Keep at most `maxCount` cameras per country, in catalogue order, so one large
 * country never crowds another out. Entries that declare no country form their
 * own group.
 *
 * @param {Array<{country?: string}>} sources
 * @param {number} maxCount
 * @returns {{kept: Array<object>, dropped: Map<string, number>}}
 */
export function capSourcesPerCountry(sources, maxCount) {
  const kept = [];
  const counts = new Map();
  const dropped = new Map();
  for (const source of sources) {
    const country = String(source?.country || '');
    const count = counts.get(country) || 0;
    if (count >= maxCount) {
      dropped.set(country, (dropped.get(country) || 0) + 1);
      continue;
    }
    counts.set(country, count + 1);
    kept.push(source);
  }
  return { kept, dropped };
}

const CANADIAN_REGIONS = new Set([
  'AB',
  'BC',
  'MB',
  'NB',
  'NL',
  'NS',
  'NT',
  'NU',
  'ON',
  'PE',
  'QC',
  'SK',
  'YT',
]);
const US_STATES = new Set([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'PR',
]);
/** Pack cityIds that name a place inside a province or state rather than the code itself. */
const CITY_ID_REGIONS = {
  CA: { 'saint-john': 'NB', pei: 'PE' },
  US: { austin: 'TX' },
};

/**
 * The region a camera counts against under the region cap: "CA-ON" for a
 * Canadian province or territory, "US-TX" for a US state, and the bare country
 * code everywhere else. A Canadian or US camera whose province or state cannot
 * be told counts against its country as a whole; one with no country, against
 * the unclassified group "".
 *
 * @param {{country?: string, region?: string, cityId?: string}} source
 * @returns {string}
 */
export function cctvRegionKey(source) {
  const country = String(source?.country || '')
    .trim()
    .toUpperCase();
  if (country !== 'CA' && country !== 'US') return country;
  const known = country === 'CA' ? CANADIAN_REGIONS : US_STATES;
  const declared = String(source?.region || '')
    .trim()
    .toUpperCase()
    .replace(new RegExp(`^${country}-`), '');
  if (known.has(declared)) return `${country}-${declared}`;
  const cityId = String(source?.cityId || '')
    .trim()
    .toLowerCase();
  // Caltrans packs are keyed by district ("ca-d4"), all inside California.
  const fromCity =
    CITY_ID_REGIONS[country][cityId] ||
    (country === 'US' && /^ca-d\d+$/.test(cityId)
      ? 'CA'
      : cityId.toUpperCase());
  return known.has(fromCity) ? `${country}-${fromCity}` : country;
}

/**
 * Keep at most `maxCount` cameras per region (see cctvRegionKey), in catalogue
 * order, so no single province, state or country can flood the viewer.
 *
 * @param {Array<object>} sources
 * @param {number} maxCount
 * @returns {{kept: Array<object>, dropped: Map<string, number>}}
 */
export function capSourcesPerRegion(sources, maxCount) {
  const kept = [];
  const counts = new Map();
  const dropped = new Map();
  for (const source of sources) {
    const region = cctvRegionKey(source);
    const count = counts.get(region) || 0;
    if (count >= maxCount) {
      dropped.set(region, (dropped.get(region) || 0) + 1);
      continue;
    }
    counts.set(region, count + 1);
    kept.push(source);
  }
  return { kept, dropped };
}

/**
 * Region-cap settings: the per-region size (CCTV_REGION_CAP, default 2500,
 * clamped to the per-country ceiling) and whether the cap is on when the viewer
 * has not chosen (CCTV_REGION_CAP_DEFAULT, default on).
 *
 * @returns {{limit: number, enabledByDefault: boolean}}
 */
export function cctvRegionCapSettings(env = process.env) {
  const raw = Number(env.CCTV_REGION_CAP || DEFAULT_CCTV_REGION_CAP);
  const limit =
    Number.isFinite(raw) && raw >= 1
      ? Math.min(CCTV_MAX_SOURCES_HARD_CAP, Math.floor(raw))
      : DEFAULT_CCTV_REGION_CAP;
  const enabledByDefault = !/^(0|off|false|no)$/i.test(
    String(env.CCTV_REGION_CAP_DEFAULT ?? 'on').trim(),
  );
  return { limit, enabledByDefault };
}

/**
 * Read the viewer's region-cap choice from a request's `regionCap` parameter.
 *
 * @param {string|null} value - "1"/"on"/"true" or "0"/"off"/"false"; anything else uses the default.
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function regionCapRequested(value, fallback) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (/^(1|on|true|yes)$/.test(text)) return true;
  if (/^(0|off|false|no)$/.test(text)) return false;
  return fallback;
}

/**
 * Load CCTV sources from a local JSON file (CCTV_SOURCES_FILE env or default).
 *
 * @returns {Array<object>} Array of raw source objects, or [] on error.
 */
function loadSourcesFromFile(sourceRoot) {
  const sourceFile = process.env.CCTV_SOURCES_FILE || DEFAULT_CCTV_SOURCE_FILE;
  const resolved = path.isAbsolute(sourceFile)
    ? sourceFile
    : path.resolve(sourceRoot, sourceFile);
  try {
    if (!fs.existsSync(resolved)) return [];
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn(
      '[CCTV] failed to read source file:',
      resolved,
      error?.message || error,
    );
    return [];
  }
}

/**
 * Load CCTV sources from the CCTV_SOURCES_JSON env variable (inline JSON).
 *
 * @returns {Array<object>} Array of raw source objects, or [] if unset/invalid.
 */
function loadSourcesFromEnv() {
  const raw = process.env.CCTV_SOURCES_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Create an independent catalog rooted in the consuming application. */
export function createCctvCatalog({ sourceRoot = process.cwd() } = {}) {
  /** @type {Array<object>} Cached merged + normalized CCTV source list. */
  let _cctvSourceCache = [];
  /** @type {number} Epoch-ms when the source cache was last refreshed. */
  let _cctvSourceCacheAt = 0;
  /** @type {Promise<Array<object>>|null} In-flight refresh, shared by concurrent
   * callers so a post-TTL burst launches ONE refetch, not one per request. */
  let _cctvSourceInflight = null;

  /**
   * Assemble and cache the merged CCTV source list.
   *
   * Merges sources from three origins (Austin Open Data, local file,
   * env variable), deduplicates by ID, applies the global max cap, and
   * caches for CCTV_SOURCE_CACHE_MS.
   *
   * @returns {Promise<Array<object>>} Deduplicated, capped source list.
   */
  async function getCctvSources() {
    const now = Date.now();
    if (
      _cctvSourceCache.length &&
      now - _cctvSourceCacheAt <= CCTV_SOURCE_CACHE_MS
    ) {
      return _cctvSourceCache;
    }
    // Single-flight: a burst of requests arriving past the TTL shares ONE refresh
    // instead of each launching the full multi-provider refetch. The `.finally`
    // clears the ref so the next post-TTL cycle starts fresh.
    if (_cctvSourceInflight) return _cctvSourceInflight;
    _cctvSourceInflight = refreshCctvSources().finally(() => {
      _cctvSourceInflight = null;
    });
    return _cctvSourceInflight;
  }

  /**
   * Assemble and cache the merged CCTV source list from file/env + live packs.
   * Always resolves (loaders self-catch to []); on a fully-empty refresh with a
   * good prior catalog it serves stale rather than blanking the CCTV layer.
   *
   * @returns {Promise<Array<object>>} Deduplicated, capped source list.
   */
  async function refreshCctvSources() {
    const fromFile = loadSourcesFromFile(sourceRoot);
    const fromEnv = loadSourcesFromEnv();

    const forceAustin =
      String(process.env.CCTV_FORCE_AUSTIN || '').trim() === '1';
    const preferAustin =
      String(process.env.CCTV_PREFER_AUSTIN || '1').trim() !== '0';
    // Country gate. A disabled country is never fetched, so its frames are never
    // requested and never cached — that is the point of the switch, not just a
    // tidier list.
    const countries = enabledCctvCountries();
    const countryEnabled = (code) =>
      countries === null || countries.has(String(code || '').toUpperCase());
    // Live open-data packs (Austin + Caltrans + TfL) load unless a file/env pack
    // is configured and live packs aren't forced — same gate that governed the
    // Austin-only fetch, now governing all three. Each pack fails independently.
    // Naming US or GB in CCTV_COUNTRIES is itself a request for those packs, so a
    // single switch turns a country on even when a file pack is configured.
    const liveCountryNamed =
      countries !== null && (countries.has('US') || countries.has('GB'));
    const liveSourcesWanted =
      forceAustin ||
      liveCountryNamed ||
      (fromFile.length + fromEnv.length === 0 && preferAustin);
    // The built-in live packs are American (Austin, Caltrans) and British (TfL).
    const needsUsSources = liveSourcesWanted && countryEnabled('US');
    const needsGbSources = liveSourcesWanted && countryEnabled('GB');
    const needsLiveSources = needsUsSources || needsGbSources;
    const tflEnabled =
      String(process.env.CCTV_TFL_ENABLED || '1').trim() !== '0';

    let fromAustin = [];
    let fromCaltrans = [];
    let fromTfl = [];
    if (needsLiveSources) {
      const [austinResult, caltransResult, tflResult] =
        await Promise.allSettled([
          needsUsSources
            ? loadAustinSourcesFromOpenData()
            : Promise.resolve([]),
          needsUsSources
            ? loadCaltransSourcesFromOpenData()
            : Promise.resolve([]),
          needsGbSources && tflEnabled
            ? loadTflSourcesFromOpenData()
            : Promise.resolve([]),
        ]);
      fromAustin =
        austinResult.status === 'fulfilled' ? austinResult.value : [];
      fromCaltrans =
        caltransResult.status === 'fulfilled' ? caltransResult.value : [];
      fromTfl = tflResult.status === 'fulfilled' ? tflResult.value : [];
    }
    // Configured packs first: the cap below keeps the FIRST N entries, so the
    // operator's own catalogue must never be the part that gets truncated when
    // a live pack is switched on beside it.
    const merged = [
      ...fromFile,
      ...fromEnv,
      ...fromAustin,
      ...fromCaltrans,
      ...fromTfl,
    ];

    // Deduplicate by camera ID (last-write wins because of Map.set)
    const byId = new Map();
    for (const item of merged) {
      if (!item || typeof item !== 'object') continue;
      const normalized = normalizeSourceItem(item);
      if (!normalized.id) continue;
      // An entry with no country cannot be classified, so it is always kept.
      if (normalized.country && !countryEnabled(normalized.country)) continue;
      byId.set(normalized.id, normalized);
    }

    const mergedSources = Array.from(byId.values());
    const maxRaw = Number(
      process.env.CCTV_MAX_SOURCES || DEFAULT_CCTV_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(CCTV_MAX_SOURCES_HARD_CAP, Math.floor(maxRaw)))
      : DEFAULT_CCTV_MAX_SOURCES;
    const { kept: capped, dropped } = capSourcesPerCountry(
      mergedSources,
      maxCount,
    );
    for (const [country, count] of dropped) {
      console.warn(
        `[CCTV] ${country || 'unclassified'} cameras exceed ${maxCount} per country; dropped the last ${count} (raise CCTV_MAX_SOURCES or lower a per-pack cap to change which).`,
      );
    }
    if (capped.length > 0 || _cctvSourceCache.length === 0) {
      _cctvSourceCache = capped;
    } else {
      // Every source came back empty (all live packs timed out / upstream outage)
      // but a good catalog is already cached — serve it stale rather than blanking
      // every CCTV route. Advancing the timestamp waits one TTL before retrying,
      // which (with single-flight) bounds load on a persistently-down upstream.
      console.warn(
        `[CCTV] source refresh returned empty; serving ${_cctvSourceCache.length} stale cameras`,
      );
    }
    _cctvSourceCacheAt = Date.now();
    return _cctvSourceCache;
  }

  return getCctvSources;
}
