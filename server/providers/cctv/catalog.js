import fsp from 'node:fs/promises';
import path from 'node:path';
import { haversineKm } from '../common/geo.js';
import { buildCctvGrid } from './area.js';
import {
  CCTV_AUSTIN_DEDUPE_M,
  CCTV_PACK_FORMAT,
  CCTV_SOURCE_STAT_INTERVAL_MS,
  DEFAULT_CCTV_COUNTRIES,
  DEFAULT_CCTV_SOURCE_FILES,
} from './constants.js';
import { createCctvLivePacks } from './live-packs.js';
import { canonicalCountryCode, normalizeSourceItem } from './normalize.js';
import { isSchoolCamera } from './school-filter.js';
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
    .map((c) => canonicalCountryCode(c))
    .filter(Boolean);
  if (codes.includes('*') || codes.includes('ALL')) return null;
  return new Set(codes);
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
]);
/** US territories are ISO countries of their own, so a camera there counts
 * as that code whether it is labelled "PR" or "US" + "Puerto Rico". */
const US_TERRITORIES = new Set(['PR', 'GU', 'VI', 'AS', 'MP', 'UM']);
const US_TERRITORY_NAMES = {
  'puerto rico': 'PR',
  guam: 'GU',
  'virgin islands': 'VI',
  'us virgin islands': 'VI',
  'united states virgin islands': 'VI',
  'american samoa': 'AS',
  'northern mariana islands': 'MP',
  'united states minor outlying islands': 'UM',
};
/** Pack cityIds that name a place inside a province or state rather than the code itself. */
const CITY_ID_REGIONS = {
  CA: { 'saint-john': 'NB', pei: 'PE' },
  // Washington the city is the District of Columbia, not Washington State.
  US: { austin: 'TX', washington: 'DC' },
};

/** Spelled-out province, territory and state names (lower case, accents and
 * punctuation dropped) for packs that name the region instead of coding it. */
const REGION_NAMES = {
  CA: {
    alberta: 'AB',
    'british columbia': 'BC',
    manitoba: 'MB',
    'new brunswick': 'NB',
    'newfoundland and labrador': 'NL',
    newfoundland: 'NL',
    labrador: 'NL',
    'nova scotia': 'NS',
    'northwest territories': 'NT',
    nunavut: 'NU',
    ontario: 'ON',
    'prince edward island': 'PE',
    quebec: 'QC',
    saskatchewan: 'SK',
    yukon: 'YT',
    'yukon territory': 'YT',
    pei: 'PE',
    nwt: 'NT',
    'newfoundland labrador': 'NL',
    'colombie britannique': 'BC',
    'nouveau brunswick': 'NB',
    'terre neuve et labrador': 'NL',
    'nouvelle ecosse': 'NS',
    'territoires du nord ouest': 'NT',
    'ile du prince edouard': 'PE',
  },
  US: {
    alabama: 'AL',
    alaska: 'AK',
    arizona: 'AZ',
    arkansas: 'AR',
    california: 'CA',
    colorado: 'CO',
    connecticut: 'CT',
    delaware: 'DE',
    'district of columbia': 'DC',
    'washington dc': 'DC',
    dc: 'DC',
    florida: 'FL',
    georgia: 'GA',
    hawaii: 'HI',
    idaho: 'ID',
    illinois: 'IL',
    indiana: 'IN',
    iowa: 'IA',
    kansas: 'KS',
    kentucky: 'KY',
    louisiana: 'LA',
    maine: 'ME',
    maryland: 'MD',
    massachusetts: 'MA',
    michigan: 'MI',
    minnesota: 'MN',
    mississippi: 'MS',
    missouri: 'MO',
    montana: 'MT',
    nebraska: 'NE',
    nevada: 'NV',
    'new hampshire': 'NH',
    'new jersey': 'NJ',
    'new mexico': 'NM',
    'new york': 'NY',
    'north carolina': 'NC',
    'north dakota': 'ND',
    ohio: 'OH',
    oklahoma: 'OK',
    oregon: 'OR',
    pennsylvania: 'PA',
    'rhode island': 'RI',
    'south carolina': 'SC',
    'south dakota': 'SD',
    tennessee: 'TN',
    texas: 'TX',
    utah: 'UT',
    vermont: 'VT',
    virginia: 'VA',
    washington: 'WA',
    'west virginia': 'WV',
    wisconsin: 'WI',
    wyoming: 'WY',
  },
};

/** "Québec", "british-columbia" -> "quebec", "british columbia". */
function placeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

/**
 * The region a camera belongs to: "CA-ON" for a Canadian province or
 * territory, "US-TX" for a US state, and the bare country code everywhere
 * else. The province or state comes from `region` (a code or a spelled-out
 * name), else from `cityId`. A Canadian or US camera whose province or state
 * cannot be told gets its country ("CA", "US"), and one without a two-letter
 * country code gets the unclassified group "".
 *
 * @param {{country?: string, region?: string, cityId?: string}} source
 * @returns {string}
 */
export function cctvRegionKey(source) {
  const country = canonicalCountryCode(source?.country);
  if (!/^[A-Z]{2}$/.test(country)) return '';
  if (country !== 'CA' && country !== 'US') return country;
  const known = country === 'CA' ? CANADIAN_REGIONS : US_STATES;
  const names = REGION_NAMES[country];
  const declared = String(source?.region || '')
    .trim()
    .toUpperCase()
    .replace(new RegExp(`^${country}-`), '');
  if (known.has(declared)) return `${country}-${declared}`;
  if (country === 'US' && US_TERRITORIES.has(declared)) return declared;
  const declaredName = names[placeName(source?.region)];
  if (declaredName) return `${country}-${declaredName}`;
  const declaredTerritory =
    country === 'US' && US_TERRITORY_NAMES[placeName(source?.region)];
  if (declaredTerritory) return declaredTerritory;
  const cityId = String(source?.cityId || '')
    .trim()
    .toLowerCase();
  // Caltrans packs are keyed by district ("ca-d4"), all inside California.
  const fromCity =
    CITY_ID_REGIONS[country][cityId] ||
    (country === 'US' && /^ca-d\d+$/.test(cityId)
      ? 'CA'
      : names[placeName(cityId)] ||
        (country === 'US' && US_TERRITORY_NAMES[placeName(cityId)]) ||
        cityId.toUpperCase());
  if (country === 'US' && US_TERRITORIES.has(fromCity)) return fromCity;
  return known.has(fromCity) ? `${country}-${fromCity}` : country;
}

/**
 * Pack files named by CCTV_SOURCES_FILE (a comma list), or the default
 * Canadian and US packs when it is unset.
 *
 * @returns {string[]}
 */
export function cctvSourceFiles(env = process.env) {
  return String(env.CCTV_SOURCES_FILE || DEFAULT_CCTV_SOURCE_FILES)
    .split(',')
    .map((file) => file.trim())
    .filter(Boolean);
}

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Raw camera entries of a parsed pack file: a plain array as-is, or a
 * gev-cctv-pack/1 envelope expanded as `{...defaults, ...providers[p], ...cam}`
 * (the `p` provider reference itself is dropped).
 *
 * @param {unknown} parsed
 * @returns {Array<object>}
 */
export function expandCctvPack(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!isPlainObject(parsed) || !Array.isArray(parsed.cameras)) return [];
  if (parsed.format !== undefined && parsed.format !== CCTV_PACK_FORMAT) {
    console.warn('[CCTV] unknown camera pack format:', String(parsed.format));
    return [];
  }
  const defaults = isPlainObject(parsed.defaults) ? parsed.defaults : {};
  const providers = isPlainObject(parsed.providers) ? parsed.providers : {};
  const out = [];
  for (const camera of parsed.cameras) {
    if (!isPlainObject(camera)) continue;
    const { p, ...fields } = camera;
    const provider =
      typeof p === 'string' &&
      Object.hasOwn(providers, p) &&
      isPlainObject(providers[p])
        ? providers[p]
        : {};
    out.push({ ...defaults, ...provider, ...fields });
  }
  return out;
}

/**
 * Hide Road511 listing cameras ("us511-…") that stand within `maxM` metres of
 * an Austin open-data camera: same pole, and the Austin entry has the still.
 *
 * @param {Array<object>} sources - Normalized entries.
 * @returns {Array<object>}
 */
export function hideListingDuplicatesOfAustin(
  sources,
  maxM = CCTV_AUSTIN_DEDUPE_M,
) {
  // 0.001° cells are wider than 30 m at any latitude with roads, so a match is
  // always in the camera's own cell or one of its eight neighbours.
  const CELL = 0.001;
  const cellKey = (row, col) => `${row}:${col}`;
  const austin = new Map();
  for (const source of sources) {
    if (source.sourceKind !== 'austin-open-data') continue;
    if (!Number.isFinite(source.lat) || !Number.isFinite(source.lon)) continue;
    const key = cellKey(
      Math.floor(source.lat / CELL),
      Math.floor(source.lon / CELL),
    );
    const bucket = austin.get(key);
    if (bucket) bucket.push(source);
    else austin.set(key, [source]);
  }
  if (!austin.size) return sources;
  return sources.filter((source) => {
    if (!String(source.id).startsWith('us511-')) return true;
    if (!Number.isFinite(source.lat) || !Number.isFinite(source.lon))
      return true;
    const row = Math.floor(source.lat / CELL);
    const col = Math.floor(source.lon / CELL);
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        for (const near of austin.get(cellKey(row + dr, col + dc)) || []) {
          const metres =
            haversineKm(source.lat, source.lon, near.lat, near.lon) * 1000;
          if (metres <= maxM) return false;
        }
      }
    }
    return true;
  });
}

/**
 * Load CCTV sources from the CCTV_SOURCES_JSON env variable (inline JSON).
 *
 * @returns {Array<object>} Raw source objects, or [] if unset/invalid.
 */
function loadSourcesFromEnv(env) {
  const raw = env.CCTV_SOURCES_JSON;
  if (!raw) return [];
  try {
    return expandCctvPack(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Create an independent catalogue rooted in the consuming application.
 *
 * The catalogue holds every camera: pack files, CCTV_SOURCES_JSON and whatever
 * live packs have loaded, normalized, country-gated and deduplicated, with no
 * truncation. Areas are cut from it per request (see area.js), so the snapshot
 * carries an id map and a spatial grid. A snapshot is rebuilt only when a pack
 * file's path, mtime or size changes (files are stat-ed at most every
 * `statIntervalMs`), when the CCTV env changes, or when a live pack lands.
 * Rebuilds are single-flight; if one fails, the previous snapshot is served.
 */
export function createCctvCatalog({
  sourceRoot = process.cwd(),
  cacheDir = path.join(sourceRoot, '.gev-cache'),
  env,
  fetchImpl,
  now = Date.now,
  statIntervalMs = CCTV_SOURCE_STAT_INTERVAL_MS,
  livePacks,
} = {}) {
  const envNow = () => env || process.env;
  const packs =
    livePacks || createCctvLivePacks({ cacheDir, env, fetchImpl, now });
  let current = null;
  let generation = 0;
  let statCache = null;
  let inflight = null;
  let failedSignature = '';

  /** Everything besides file stats a snapshot depends on. */
  const quickKey = (e = envNow()) =>
    JSON.stringify([
      e.CCTV_SOURCES_FILE ?? '',
      e.CCTV_SOURCES_JSON ?? '',
      e.CCTV_COUNTRIES ?? '',
      packs.signature(enabledCctvCountries(e)),
    ]);

  async function statFiles() {
    const files = cctvSourceFiles(envNow()).map((file) =>
      path.isAbsolute(file) ? file : path.resolve(sourceRoot, file),
    );
    const listKey = files.join('\n');
    if (
      statCache &&
      statCache.listKey === listKey &&
      now() - statCache.at < statIntervalMs
    )
      return statCache;
    const stats = await Promise.all(
      files.map(async (file) => {
        try {
          const stat = await fsp.stat(file);
          if (stat.isFile())
            return {
              file,
              exists: true,
              sig: `${file}:${stat.mtimeMs}:${stat.size}`,
            };
        } catch {
          /* missing: the pack is skipped quietly */
        }
        return { file, exists: false, sig: `${file}:missing` };
      }),
    );
    statCache = {
      listKey,
      at: now(),
      files: stats,
      signature: stats.map((entry) => entry.sig).join('\n'),
    };
    return statCache;
  }

  async function build(files, e, fileSignature, strict) {
    const countries = enabledCctvCountries(e);
    const raw = [];
    for (const { file, exists } of files) {
      if (!exists) continue;
      let items;
      try {
        items = expandCctvPack(JSON.parse(await fsp.readFile(file, 'utf8')));
      } catch (error) {
        // With a catalogue already served, a pack caught mid-write keeps the
        // previous snapshot instead of silently dropping its cameras.
        if (strict) throw new Error(`${file}: ${error?.message || error}`);
        console.warn(
          '[CCTV] failed to read source file:',
          file,
          error?.message || error,
        );
        continue;
      }
      for (const item of items) raw.push(item);
    }
    for (const item of loadSourcesFromEnv(e)) raw.push(item);
    const live = packs.sources(countries);
    for (const item of live.sources) raw.push(item);

    // Deduplicate by camera ID (last-write wins because of Map.set).
    const unique = new Map();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const normalized = normalizeSourceItem(item);
      if (!normalized.id) continue;
      // School cameras are never served, whichever pack they slipped into.
      if (isSchoolCamera(normalized)) continue;
      // An entry with no country cannot be classified, so it is always kept.
      if (
        normalized.country &&
        countries !== null &&
        !countries.has(normalized.country)
      )
        continue;
      unique.set(normalized.id, normalized);
    }
    const sources = hideListingDuplicatesOfAustin([...unique.values()]);
    const byId = new Map();
    for (const source of sources) {
      source.regionKey = cctvRegionKey(source);
      byId.set(source.id, source);
    }
    generation += 1;
    const key = JSON.stringify([
      e.CCTV_SOURCES_FILE ?? '',
      e.CCTV_SOURCES_JSON ?? '',
      e.CCTV_COUNTRIES ?? '',
      live.signature,
    ]);
    return {
      generation,
      signature: `${fileSignature}\n${key}`,
      quickKey: key,
      sources,
      byId,
      grid: buildCctvGrid(sources),
      countries,
      total: sources.length,
    };
  }

  async function refresh() {
    const e = envNow();
    const key = quickKey(e);
    const stat = await statFiles();
    const signature = `${stat.signature}\n${key}`;
    if (current?.signature === signature) {
      current.quickKey = key;
      return current;
    }
    if (current && failedSignature === signature) return current;
    try {
      current = await build(stat.files, e, stat.signature, Boolean(current));
      failedSignature = '';
    } catch (error) {
      failedSignature = signature;
      console.warn(
        '[CCTV] catalogue rebuild failed; serving the previous catalogue:',
        error?.message || error,
      );
    }
    return current;
  }

  /**
   * The current catalogue snapshot:
   * `{generation, sources, byId, grid, countries, total}`.
   *
   * @returns {Promise<object>}
   */
  function snapshot() {
    if (inflight) return inflight;
    if (
      current &&
      statCache &&
      now() - statCache.at < statIntervalMs &&
      current.quickKey === quickKey()
    )
      return Promise.resolve(current);
    inflight = refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    snapshot,
    /** Every catalogue camera (normalized). */
    sources: async () => (await snapshot()).sources,
    /**
     * Trigger the live packs a selected area overlaps; see live-packs.js.
     *
     * @param {{lat: number, lon: number, radiusKm: number}} area
     */
    ensureArea: (area) =>
      packs.ensureArea(area, enabledCctvCountries(envNow())),
    /** Adopt live pack lists saved on disk (no download); true if any. */
    warmFromDisk: () => packs.warmFromDisk(enabledCctvCountries(envNow())),
  };
}
