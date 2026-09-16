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
import {
  canonicalCountryCode,
  cctvStillKey,
  normalizeSourceItem,
} from './normalize.js';
import { isSchoolCamera } from './school-filter.js';
/**
 * Parse CCTV_COUNTRIES into the set of ISO country codes to serve.
 *
 * Country gating is what keeps the catalogue from pulling every camera on the
 * planet: a country that is switched off is never fetched and never cached, so
 * its streams cost nothing. "*" or "ALL" serves every country; an explicitly
 * empty value serves none.
 *
 * The international pack's cameras carry their own ISO codes (FR, JP, TW, ...),
 * so a list such as "CA,US" leaves all of them out: name their countries too,
 * or use "*" (the default). A camera with no country (blank, or the listing's
 * "XX") cannot be classified and is served whatever the list says.
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
/** A region written with its country in front ("CA-ON", "US-TX"). */
const REGION_PREFIX = { CA: /^CA-/, US: /^US-/ };

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
    .replace(REGION_PREFIX[country], '');
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
 * Canadian, US and international packs when it is unset.
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
const NO_PROVIDER = Object.freeze({});

/** A parsed pack's cameras with its shared layers (null for a plain array),
 * or null when it holds no camera list. */
function packLayers(parsed) {
  if (Array.isArray(parsed))
    return { cameras: parsed, defaults: null, providers: null };
  if (!isPlainObject(parsed) || !Array.isArray(parsed.cameras)) return null;
  if (parsed.format !== undefined && parsed.format !== CCTV_PACK_FORMAT) {
    console.warn('[CCTV] unknown camera pack format:', String(parsed.format));
    return null;
  }
  return {
    cameras: parsed.cameras,
    defaults: isPlainObject(parsed.defaults) ? parsed.defaults : {},
    providers: isPlainObject(parsed.providers) ? parsed.providers : {},
  };
}

const providerBlock = (providers, p) =>
  typeof p === 'string' &&
  Object.hasOwn(providers, p) &&
  isPlainObject(providers[p])
    ? providers[p]
    : NO_PROVIDER;

/**
 * Raw camera entries of a parsed pack file: a plain array as-is, or a
 * gev-cctv-pack/1 envelope expanded as `{...defaults, ...providers[p], ...cam}`
 * (the `p` provider reference itself is dropped).
 *
 * @param {unknown} parsed
 * @returns {Array<object>}
 */
export function expandCctvPack(parsed) {
  const layers = packLayers(parsed);
  if (!layers) return [];
  if (!layers.defaults) return layers.cameras;
  const out = [];
  for (const camera of layers.cameras) {
    if (!isPlainObject(camera)) continue;
    const { p, ...fields } = camera;
    out.push({
      ...layers.defaults,
      ...providerBlock(layers.providers, p),
      ...fields,
    });
  }
  return out;
}

/** The same entries one at a time, without holding an expanded copy of the
 * whole pack. */
function* packEntries(parsed) {
  const layers = packLayers(parsed);
  if (!layers) return;
  if (!layers.defaults) {
    yield* layers.cameras;
    return;
  }
  for (const camera of layers.cameras) {
    if (!isPlainObject(camera)) continue;
    const { p, ...fields } = camera;
    yield {
      ...layers.defaults,
      ...providerBlock(layers.providers, p),
      ...fields,
    };
  }
}

/** Road511 listing cameras near an Austin open-data camera; see below. */
function markAustinListingDuplicates(sources, hidden, maxM) {
  // 0.001° cells are wider than 30 m at any latitude with roads, so a match is
  // always in the camera's own cell or one of its eight neighbours.
  const CELL = 0.001;
  const cellKey = (row, col) => `${row}:${col}`;
  const austin = new Map();
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    if (hidden[i] || source.sourceKind !== 'austin-open-data') continue;
    if (!Number.isFinite(source.lat) || !Number.isFinite(source.lon)) continue;
    const key = cellKey(
      Math.floor(source.lat / CELL),
      Math.floor(source.lon / CELL),
    );
    const bucket = austin.get(key);
    if (bucket) bucket.push(source);
    else austin.set(key, [source]);
  }
  if (!austin.size) return 0;
  const nearAustin = (source) => {
    const row = Math.floor(source.lat / CELL);
    const col = Math.floor(source.lon / CELL);
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        for (const near of austin.get(cellKey(row + dr, col + dc)) || []) {
          const metres =
            haversineKm(source.lat, source.lon, near.lat, near.lon) * 1000;
          if (metres <= maxM) return true;
        }
      }
    }
    return false;
  };
  let count = 0;
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    if (hidden[i] || !String(source.id).startsWith('us511-')) continue;
    if (!Number.isFinite(source.lat) || !Number.isFinite(source.lon)) continue;
    if (nearAustin(source)) {
      hidden[i] = 1;
      count += 1;
    }
  }
  return count;
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
  const hidden = new Uint8Array(sources.length);
  return markAustinListingDuplicates(sources, hidden, maxM)
    ? sources.filter((_, i) => !hidden[i])
    : sources;
}

/** headingConfidence values that come from a measurement or a hand survey. */
const MEASURED_HEADINGS = new Set([
  'high',
  'exact',
  'measured',
  'surveyed',
  'verified',
  'curated',
]);
/** headingConfidence values that say the bearing is not known: an id-hash
 * fallback ("low") is a placeholder, not a pose. */
const UNKNOWN_HEADINGS = new Set(['unknown', 'low', 'none', 'fallback']);

/**
 * How much a camera entry knows about where it points: 3 a hand-curated pose
 * (`poseSource: 'curated'`), 2 a measured heading ("high", "exact", ...), 1 any
 * other stated heading ("estimated"), 0 none (no heading, "unknown", or an
 * id-hash "low" fallback).
 *
 * @param {object} source - Normalized entry.
 * @returns {0|1|2|3}
 */
export function cctvPoseRank(source) {
  if (source?.poseSource === 'curated') return 3;
  if (!Number.isFinite(source?.headingDeg)) return 0;
  const confidence = String(source.headingConfidence || '').toLowerCase();
  if (UNKNOWN_HEADINGS.has(confidence)) return 0;
  return MEASURED_HEADINGS.has(confidence) ? 2 : 1;
}

/**
 * Hide every entry whose still another entry already shows, keeping one per
 * still (cctvStillKey of its snapshotUrl or url). Which one stays:
 *
 * 1. Between a live-pack entry and a file or CCTV_SOURCES_JSON entry, the live
 *    one when it is TfL (availability, not pose) or when its cctvPoseRank is
 *    higher; on a tie or less, the file one.
 * 2. Otherwise the entry from the earlier origin (pack files as listed, then
 *    CCTV_SOURCES_JSON, then the live packs in order), and within one origin
 *    the earlier entry.
 *
 * So a live pack that lands never swaps a file camera's id for its own unless
 * it brings a better pose, except TfL JamCams whose live list is the available
 * set.
 */
const LIVE_STILL_WINS = new Set([
  'tfl-open-data',
  'austin-open-data',
  'caltrans-open-data',
]);

function stillKeyOf(entry) {
  if (entry?.feedType === 'none' || entry?.feedType === 'video') return '';
  return cctvStillKey(entry.snapshotUrl || entry.url);
}

function markDuplicateStills(entries, hidden, partOf, live) {
  const owners = new Map();
  let duplicates = 0;
  let liveReplacements = 0;
  const keeper = (a, b) => {
    const liveA = live[partOf[a]];
    if (liveA !== live[partOf[b]]) {
      const [liveOne, other] = liveA ? [a, b] : [b, a];
      if (LIVE_STILL_WINS.has(entries[liveOne].sourceKind)) return liveOne;
      return cctvPoseRank(entries[liveOne]) > cctvPoseRank(entries[other])
        ? liveOne
        : other;
    }
    if (partOf[a] !== partOf[b]) return partOf[a] < partOf[b] ? a : b;
    return a < b ? a : b;
  };
  const hide = (loser, kept) => {
    hidden[loser] = 1;
    duplicates += 1;
    if (live[partOf[kept]] && !live[partOf[loser]]) liveReplacements += 1;
  };
  for (let i = 0; i < entries.length; i += 1) {
    if (hidden[i]) continue;
    const key = stillKeyOf(entries[i]);
    if (!key) continue;
    const a = owners.get(key);
    if (a !== undefined && !hidden[a]) {
      if (keeper(a, i) === a) hide(i, a);
      else {
        hide(a, i);
        owners.set(key, i);
      }
      continue;
    }
    owners.set(key, i);
  }
  return { duplicates, liveReplacements };
}

/**
 * Merge normalized origins into the catalogue's camera list.
 *
 * - The same id twice: the later entry replaces the earlier one in place.
 * - A Road511 listing camera within 30 m of an Austin open-data camera is
 *   hidden (hideListingDuplicatesOfAustin).
 * - Two entries with the same still: one stays (see markDuplicateStills).
 *
 * @param {Array<{sources: Array<object>, live?: boolean}>} parts - In priority
 *   order: pack files as listed, CCTV_SOURCES_JSON, then the live packs.
 * @returns {{sources: Array<object>, duplicateIds: number,
 *   austinListingDuplicates: number, duplicateStills: number,
 *   liveStillReplacements: number}}
 */
export function mergeCctvSources(parts, { austinDedupeM } = {}) {
  const entries = [];
  const partOf = [];
  const position = new Map();
  let duplicateIds = 0;
  for (let p = 0; p < parts.length; p += 1) {
    for (const source of parts[p].sources) {
      const at = position.get(source.id);
      if (at === undefined) {
        position.set(source.id, entries.length);
        entries.push(source);
        partOf.push(p);
      } else {
        entries[at] = source;
        partOf[at] = p;
        duplicateIds += 1;
      }
    }
  }
  const hidden = new Uint8Array(entries.length);
  const austinListingDuplicates = markAustinListingDuplicates(
    entries,
    hidden,
    austinDedupeM ?? CCTV_AUSTIN_DEDUPE_M,
  );
  const { duplicates, liveReplacements } = markDuplicateStills(
    entries,
    hidden,
    partOf,
    parts.map((part) => Boolean(part.live)),
  );
  const sources = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (!hidden[i]) sources.push(entries[i]);
  }
  return {
    sources,
    duplicateIds,
    austinListingDuplicates,
    duplicateStills: duplicates,
    liveStillReplacements: liveReplacements,
  };
}

/** One shared copy of each repeated string (provider, license, city, codes)
 * for the length of a build. */
function createInterner() {
  const pool = new Map();
  return (value) => {
    if (typeof value !== 'string' || !value) return value;
    const known = pool.get(value);
    if (known !== undefined) return known;
    pool.set(value, value);
    return value;
  };
}

const newCounts = () => ({
  listed: 0,
  withoutId: 0,
  otherCountries: 0,
  schoolCameras: 0,
});

function addCounts(into, from) {
  into.listed += from.listed;
  into.withoutId += from.withoutId;
  into.otherCountries += from.otherCountries;
  into.schoolCameras += from.schoolCameras;
}

/** Normalize one origin's raw entries, keeping only servable cameras. */
function admit(items, countries, intern, counts) {
  const sources = [];
  for (const item of items) {
    counts.listed += 1;
    if (!item || typeof item !== 'object') {
      counts.withoutId += 1;
      continue;
    }
    const source = normalizeSourceItem(item);
    if (!source.id) {
      counts.withoutId += 1;
      continue;
    }
    // An entry with no country cannot be classified, so it is always kept.
    if (
      source.country &&
      countries !== null &&
      !countries.has(source.country)
    ) {
      counts.otherCountries += 1;
      continue;
    }
    // School cameras are never served, whichever pack they slipped into.
    if (isSchoolCamera(source)) {
      counts.schoolCameras += 1;
      continue;
    }
    source.city = intern(source.city);
    source.cityId = intern(source.cityId);
    source.provider = intern(source.provider);
    source.license = intern(source.license);
    source.country = intern(source.country);
    source.region = intern(source.region);
    source.sourceKind = intern(source.sourceKind);
    source.headingConfidence = intern(source.headingConfidence);
    source.regionKey = intern(cctvRegionKey(source));
    sources.push(source);
  }
  return sources;
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
 * live packs have loaded, normalized, country-gated and deduplicated (by id,
 * by the Austin 30 m rule and by still address; see mergeCctvSources), with no
 * truncation. Areas are cut from it per request (see area.js), so the snapshot
 * carries an id map and a spatial grid. A snapshot is rebuilt only when a pack
 * file's path, mtime or size changes (files are stat-ed at most every
 * `statIntervalMs`), when the CCTV env changes, or when a live pack lands.
 * Each pack file is read and normalized once per version and country list:
 * a rebuild for any other reason reuses its cameras and only merges again.
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
  /** Normalized cameras of each pack file: {sig, countriesKey, sources, counts}. */
  let fileParts = new Map();

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
    const started = performance.now();
    const countries = enabledCctvCountries(e);
    const countriesKey =
      countries === null ? '*' : [...countries].sort().join(',');
    const intern = createInterner();
    const counts = newCounts();
    const parts = [];
    const nextFileParts = new Map();
    let packFiles = 0;
    let packFilesRead = 0;
    for (const { file, exists, sig } of files) {
      if (!exists) continue;
      let part = nextFileParts.get(file) || fileParts.get(file);
      if (!part || part.sig !== sig || part.countriesKey !== countriesKey) {
        let parsed;
        try {
          parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
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
        const partCounts = newCounts();
        const sources = admit(
          packEntries(parsed),
          countries,
          intern,
          partCounts,
        );
        // Let the parsed file go before the next one is read.
        parsed = null;
        part = { sig, countriesKey, sources, counts: partCounts };
        packFilesRead += 1;
      }
      nextFileParts.set(file, part);
      packFiles += 1;
      addCounts(counts, part.counts);
      parts.push({ sources: part.sources, live: false });
    }
    parts.push({
      sources: admit(loadSourcesFromEnv(e), countries, intern, counts),
      live: false,
    });
    const live = packs.sources(countries);
    parts.push({
      sources: admit(live.sources, countries, intern, counts),
      live: true,
    });

    const merged = mergeCctvSources(parts);
    const { sources } = merged;
    const byId = new Map();
    let withoutPosition = 0;
    for (const source of sources) {
      byId.set(source.id, source);
      if (!Number.isFinite(source.lat) || !Number.isFinite(source.lon))
        withoutPosition += 1;
    }
    const grid = buildCctvGrid(sources);
    fileParts = nextFileParts;
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
      grid,
      countries,
      total: sources.length,
      stats: {
        packFiles,
        packFilesRead,
        listed: counts.listed,
        withoutId: counts.withoutId,
        otherCountries: counts.otherCountries,
        schoolCameras: counts.schoolCameras,
        duplicateIds: merged.duplicateIds,
        austinListingDuplicates: merged.austinListingDuplicates,
        duplicateStills: merged.duplicateStills,
        liveStillReplacements: merged.liveStillReplacements,
        withoutPosition,
        buildMs: Math.round(performance.now() - started),
      },
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
   * `{generation, sources, byId, grid, countries, total, stats}`. `stats`
   * counts what the build left out: `withoutId`, `otherCountries`,
   * `schoolCameras`, `duplicateIds`, `austinListingDuplicates`,
   * `duplicateStills` (hidden because another entry shows the same still) and
   * `liveStillReplacements` (live-pack entries kept over a file duplicate).
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
