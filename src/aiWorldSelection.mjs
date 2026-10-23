/**
 * ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM: the pure half of the left-hand
 * tab (src/aiWorldPanel.js, docs/AI-WORLD-TAB.md). No DOM, no Node: the tick
 * box list, the ALL box, the buttons each state allows, and every line of
 * text the tab shows, from the server's answers.
 *
 * TRAIN ON is one row per DataManager layer (in the DataManager's order),
 * then the server catalog's items that are not layers, then the four entries
 * that are never layers: NEWS EVENTS, POPULATION DEMOGRAPHICS, OUTBREAK SIM
 * EPISODES and YOUR DEVICES. One row per id. A layer's label is its catalog
 * label when the catalog knows its id, else the layer's own name; every label
 * is upper case. A licence class the catalog does not give reads STATIC.
 *
 * The text is marked with tl() and tln() from src/i18n/marker.js: the fork
 * locales' language on the page (src/i18n/fork-locales.json), English in
 * every other locale and on the server, which loads this module for
 * stripExcluded().
 */

import { localDigits, msgl, tl, tln } from './i18n/marker.js';
import { marketAsset } from './marketAssets.mjs';
import { formatSkill, measuredLinkLines } from './trainingLinks.mjs';

/**
 * Military layers stay on the map. They are not training rows, not part of
 * ALL, and not a prediction. Military flights use the same ids.
 */
export const AI_WORLD_EXCLUDED = Object.freeze([
  'military',
  'military-awareness',
  'military-installations',
]);

const EXCLUDED_IDS = new Set(AI_WORLD_EXCLUDED);

/** Drop military ids. Other ids keep their order. */
export function stripExcluded(selection) {
  return (Array.isArray(selection) ? selection : []).filter(
    (id) => typeof id === 'string' && id && !EXCLUDED_IDS.has(id),
  );
}

/** The entries that are not data layers, always present, in this order. */
export const AI_WORLD_EXTRAS = Object.freeze([
  Object.freeze({ id: 'news', label: msgl('NEWS EVENTS'), cls: 'static' }),
  Object.freeze({
    id: 'demographics',
    label: msgl('POPULATION DEMOGRAPHICS'),
    cls: 'static',
  }),
  // The GLOBAL ABUNDANCE MAP's figures as static features of every place
  // (owner request 2026-10-23).
  Object.freeze({
    id: 'abundance',
    label: msgl('GLOBAL ABUNDANCE'),
    cls: 'open',
  }),
  Object.freeze({
    id: 'outbreak-sim',
    label: msgl('OUTBREAK SIM EPISODES'),
    cls: 'static',
  }),
  // The owner's own devices are personal data by definition
  // (docs/WORLD-MODEL-DATA.md, Licence classes).
  Object.freeze({
    id: 'devices',
    label: msgl('YOUR DEVICES'),
    cls: 'personal',
  }),
]);

/**
 * The labels the server's catalog gives the TRAIN ON rows
 * (server/shared/worldTape), upper case as the rows show them. Listed so
 * the rows are translated; a label not here shows as the server gives it.
 */
export const AI_WORLD_FEED_LABELS = Object.freeze([
  msgl('GLOBAL ABUNDANCE'),
  msgl('EARTHQUAKES'),
  msgl('TRANSIT (BUSES, TRAMS, METRO, TRAINS)'),
  msgl('FLIGHTS (WORLDWIDE)'),
  msgl('WEATHER RADAR (NOAA MRMS)'),
  msgl('SATELLITE CLOUDS (GOES AND GLOBAL INFRARED)'),
  msgl('LIGHTNING DENSITY'),
  msgl('WIND AND SURFACE FIELDS (GFS, ECMWF IFS)'),
  msgl('TROPICAL CYCLONES (NHC/CPHC)'),
  msgl('ACTIVE FIRES (NASA FIRMS)'),
  msgl('WILDFIRE PERIMETERS (NIFC WFIGS)'),
  msgl('SATELLITES (CELESTRAK ELEMENTS)'),
  msgl('ROCKET LAUNCHES (LAUNCH LIBRARY 2)'),
  msgl('BIKE-SHARE STATIONS (GBFS)'),
  msgl('RADIO STATIONS (METADATA)'),
  msgl('RECENT SATELLITE IMAGERY (NASA GIBS)'),
  msgl('VESSELS (AIS)'),
  msgl('ROAD TRAFFIC (TOMTOM FLOW)'),
  msgl('PUBLIC CAMERAS (STILLS)'),
  msgl('STREET-LEVEL IMAGERY COVERAGE (MAPILLARY)'),
  msgl('NEWS HEADLINES (REGIONAL)'),
  msgl('LOCAL ADS-B RECEIVER'),
  msgl('YOUR DEVICES'),
  msgl('PRIVATE CAMERAS'),
  msgl('AIRCRAFT TYPES (ADSBDB)'),
  msgl('PLATE-READER CAMERAS (OPENSTREETMAP)'),
  msgl('SUBMARINE CABLES (TELEGEOGRAPHY)'),
  msgl('DATACENTERS (OPENSTREETMAP)'),
  msgl('DAMS (OPENSTREETMAP)'),
  msgl('BHOTE KOSHI 2026 FLOOD (EVENT PACK)'),
  msgl('BHOTE KOSHI LOCATOR'),
  msgl('SEA SURFACE TEMPERATURE'),
  msgl('OBSERVED WEATHER'),
  msgl('PUBLIC CAMERAS (VIDEO)'),
  msgl('NEWS URLS'),
  msgl('FINANCIAL ASSETS (LIVE QUOTES)'),
  msgl('AIR QUALITY (PM2.5)'),
  msgl('US STREAM GAUGES'),
  msgl('POPULATION DEMOGRAPHICS'),
  msgl('OUTBREAK SIM EPISODES'),
]);

/**
 * The licence notes the server's catalog gives the TRAIN ON rows, shown
 * when the pointer rests on a row's licence class. Listed so they are
 * translated; a note not here shows as the server gives it.
 */
export const AI_WORLD_LICENCES = Object.freeze([
  msgl(
    'World Bank WDI and Our World in Data (CC BY 4.0) and the OECD regional database (OECD terms), joined to the Natural Earth countries',
  ),
  msgl('USGS earthquake catalog (U.S. public domain)'),
  msgl(
    'Per-feed open realtime data: MBTA/MassDOT, CapMetro, Metro Transit, OVapi, Entur (NLOD), TransLink, HSL (CC BY 4.0)',
  ),
  msgl(
    'OpenSky Network (non-commercial research/education licence); adsb.lol regional fallback (ODbL 1.0)',
  ),
  msgl(
    'NOAA nowCOAST, NWS/OAR MRMS radar (U.S. government data; NOAA disclaimer)',
  ),
  msgl(
    'NOAA nowCOAST; NESDIS GOES and global satellite partners (U.S. government data; NOAA disclaimer)',
  ),
  msgl(
    'NOAA/NWS nowCOAST lightning density, derived from Vaisala NLDN/GLD360 (NOAA Level-5 product; public distribution permitted, not raw detections)',
  ),
  msgl(
    'NOAA GFS (U.S. public domain); ECMWF IFS open data (CC BY 4.0 and the ECMWF Terms of Use; resampled to 1°)',
  ),
  msgl(
    'NOAA/NWS National Hurricane Center and Central Pacific Hurricane Center advisories (U.S. government data; NWS disclaimer)',
  ),
  msgl(
    "NASA FIRMS (U.S. public domain / CC0; acknowledgement of NASA's FIRMS requested)",
  ),
  msgl(
    'National Interagency Fire Center WFIGS perimeters (U.S. public domain)',
  ),
  msgl(
    'CelesTrak (U.S.-government-origin data; citation requested: CelesTrak, Dr. T.S. Kelso)',
  ),
  msgl(
    'The Space Devs Launch Library 2 (data may be used and shared in any form; attribution encouraged)',
  ),
  msgl(
    'GBFS feeds per operator (Lyft, BCycle and others; attribution to each operator and its license_url)',
  ),
  msgl(
    'Radio Browser directory (PDDL 1.0); station metadata only, never audio',
  ),
  msgl(
    "NASA GIBS / Worldview snapshots of HLS (Sentinel-2, Landsat 8/9) and VIIRS (U.S. public domain; acknowledgement of NASA's GIBS requested)",
  ),
  msgl(
    'AISStream.io (free beta, no formal terms of use); AIS is a public broadcast',
  ),
  msgl(
    'TomTom Traffic flow (TomTom terms; storage and derived use not licensed: local only)',
  ),
  msgl(
    'Per camera operator (each record names its operator licence); many listings have unconfirmed terms',
  ),
  msgl(
    'Mapillary contributors, CC BY-SA 4.0 (share-alike: a database derived from it stays CC BY-SA 4.0)',
  ),
  msgl(
    "GDELT Project (open with citation) and Google News RSS (personal, non-commercial); articles are their publishers'",
  ),
  msgl(
    "The owner's own receiver (ADS-B is an unauthenticated public broadcast)",
  ),
  msgl("The owner's own devices and their recordings"),
  msgl("The owner's own home and business cameras"),
  msgl(
    'adsbdb (no published licence or quota; aircraft data from PlaneBase): types and registrations only, local use',
  ),
  msgl(
    'OpenStreetMap contributors (ODbL 1.0), from the hourly extract at tiles.dontgetflocked.com',
  ),
  msgl('TeleGeography Submarine Cable Map (CC BY-NC-SA 3.0)'),
  msgl('OpenStreetMap contributors (ODbL 1.0)'),
  msgl('OpenStreetMap contributors (ODbL 1.0), via Open Infrastructure Map'),
  msgl(
    "Vantor Open Data imagery and GeoPera reconstruction (CC BY-NC 4.0); witness posts keep their owners' terms",
  ),
  msgl(
    'GeoPera river centreline (CC BY-NC 4.0; Planet Labs PBC / Vantor open data); incident places from the event pack',
  ),
  msgl('NASA OceanColor MODIS Aqua Level-3 SST (U.S. public domain)'),
  msgl('Open-Meteo (CC BY 4.0)'),
  msgl(
    'Per camera operator (each clip names its operator licence). Fragmented MP4 only.',
  ),
  msgl("Each item is its publisher's. Only the title and link are stored."),
  msgl(
    'Twelve Data forex and gold, OilPriceAPI WTI, copper and fuels, and Yahoo Finance for yields, stock indexes, other commodities, crypto, and whatever a free cap leaves out. Not a recommendation.',
  ),
  msgl(
    'CAMS global air quality via Open-Meteo. Attribution required. Not a health warning.',
  ),
  msgl('USGS NWIS instantaneous discharge (US public domain).'),
  msgl(
    'GeoNames cities500 (CC BY 4.0); World Bank WDI age structure and urbanisation (CC BY 4.0)',
  ),
  msgl(
    'Generated by the Outbreak model; world from OurAirports, GeoNames (CC BY 4.0), World Bank (CC BY 4.0), OSM rail (ODbL)',
  ),
]);

/** Licence classes, in the order docs/WORLD-MODEL-DATA.md lists them. */
export const AI_WORLD_CLASSES = Object.freeze([
  'open',
  'nc',
  'restricted',
  'unclear',
  'personal',
  'static',
]);

/** What PREDICTIONS can draw on the globe (the Prediction's domain). */
export const AI_WORLD_DOMAINS = Object.freeze([
  Object.freeze({ id: 'outbreak', label: msgl('OUTBREAK') }),
  Object.freeze({ id: 'mobility', label: msgl('MOBILITY') }),
  Object.freeze({ id: 'trains', label: msgl('TRAINS') }),
  Object.freeze({ id: 'traffic', label: msgl('TRAFFIC') }),
  Object.freeze({ id: 'weather', label: msgl('WEATHER') }),
  Object.freeze({ id: 'hazards', label: msgl('HAZARDS') }),
  Object.freeze({ id: 'news', label: msgl('NEWS') }),
  Object.freeze({ id: 'tracks', label: msgl('TRACKS') }),
  Object.freeze({ id: 'flights', label: msgl('FLIGHTS') }),
  Object.freeze({ id: 'vessels', label: msgl('VESSELS') }),
  Object.freeze({ id: 'transit', label: msgl('TRANSIT') }),
  Object.freeze({ id: 'supply', label: msgl('SUPPLY') }),
  Object.freeze({ id: 'markets', label: msgl('PRICE MOVES') }),
  Object.freeze({ id: 'air-quality', label: msgl('AIR QUALITY') }),
  Object.freeze({ id: 'stream-gauges', label: msgl('STREAM GAUGES') }),
]);

/** The DELETE scopes, as the menu names them. */
export const AI_WORLD_DELETE_SCOPES = Object.freeze([
  Object.freeze({ id: 'all', label: msgl('ALL DATA') }),
  Object.freeze({ id: 'tape', label: msgl('TAPE') }),
  Object.freeze({ id: 'bins', label: msgl('BINS') }),
  Object.freeze({ id: 'datasets', label: msgl('SIM DATASETS') }),
  Object.freeze({ id: 'worlds', label: msgl('WORLDS') }),
  Object.freeze({ id: 'models', label: msgl('MODELS') }),
  Object.freeze({ id: 'predictions', label: msgl('PREDICTIONS') }),
  Object.freeze({ id: 'demographics', label: msgl('DEMOGRAPHICS') }),
]);

/** States in which the work moves, so the status is asked for often. */
export const AI_WORLD_ACTIVE_STATES = Object.freeze([
  'initializing',
  'running',
  'paused',
  'stopping',
]);

export const AI_WORLD_POLL_ACTIVE_MS = 3_000;
export const AI_WORLD_POLL_IDLE_MS = 15_000;
export const AI_WORLD_HORIZON_DEFAULT = 24;
export const AI_WORLD_HORIZON_MIN = 1;
export const AI_WORLD_HORIZON_MAX = 168;

const BYTE_UNITS = [
  msgl('B'),
  msgl('KB'),
  msgl('MB'),
  msgl('GB'),
  msgl('TB'),
  msgl('PB'),
];
const DOMAIN_IDS = new Set(AI_WORLD_DOMAINS.map((domain) => domain.id));

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A known licence class, else 'static'. */
export function cleanClass(value) {
  const cls = text(value).toLowerCase();
  return AI_WORLD_CLASSES.includes(cls) ? cls : 'static';
}

/** The tag a row shows for its licence class: OPEN, NC, … STATIC. */
export function classTag(value) {
  switch (cleanClass(value)) {
    case 'open':
      return tl('OPEN', { context: 'licence' });
    case 'nc':
      return tl('NC', { context: 'licence' });
    case 'restricted':
      return tl('RESTRICTED', { context: 'licence' });
    case 'unclear':
      return tl('UNCLEAR', { context: 'licence' });
    case 'personal':
      return tl('PERSONAL', { context: 'licence' });
    default:
      return tl('STATIC', { context: 'licence' });
  }
}

function catalogItem(raw) {
  const id = text(raw?.id);
  if (!id) return null;
  return {
    id,
    label: text(raw.label),
    cls: cleanClass(raw.class),
    kind: text(raw.kind) || 'static',
    licence: text(raw.licence),
  };
}

/**
 * Every TRAIN ON row: `{ id, label, cls, kind, licence, source }`, source
 * 'layer', 'catalog' or 'extra'.
 * @param {{layers?: Array<{id: string, name?: string, showInTogglePanel?: boolean}>, catalog?: Array<object>}} [input]
 */
export function buildSelectionItems({ layers = [], catalog = [] } = {}) {
  const known = new Map();
  for (const raw of Array.isArray(catalog) ? catalog : []) {
    const item = catalogItem(raw);
    if (item && !known.has(item.id)) known.set(item.id, item);
  }
  const items = [];
  const seen = new Set();
  const add = (item) => {
    if (!item.id || seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };
  for (const layer of Array.isArray(layers) ? layers : []) {
    const id = text(layer?.id);
    // A layer kept out of the Data Layers list is scene machinery, not data.
    if (!id || layer.showInTogglePanel === false || EXCLUDED_IDS.has(id))
      continue;
    const entry = known.get(id);
    add({
      id,
      label: (entry?.label || text(layer.name) || id).toUpperCase(),
      cls: entry ? entry.cls : 'static',
      kind: entry ? entry.kind : 'static',
      licence: entry?.licence || '',
      source: 'layer',
    });
  }
  const extraIds = new Set(AI_WORLD_EXTRAS.map((extra) => extra.id));
  for (const entry of known.values()) {
    if (extraIds.has(entry.id) || EXCLUDED_IDS.has(entry.id)) continue;
    add({
      ...entry,
      label: (entry.label || entry.id).toUpperCase(),
      source: 'catalog',
    });
  }
  for (const extra of AI_WORLD_EXTRAS) {
    const entry = known.get(extra.id);
    add({
      id: extra.id,
      label: extra.label,
      cls: entry ? entry.cls : extra.cls,
      kind: entry ? entry.kind : 'static',
      licence: entry?.licence || '',
      source: 'extra',
    });
  }
  return items;
}

function idsOf(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .filter((id) => typeof id === 'string' && id);
}

/**
 * The ALL box: 'all' when every row is ticked, 'none' when none is (or there
 * are no rows), 'some' otherwise.
 * @param {string[]} selection
 * @param {Array<{id: string}|string>} items
 * @returns {'all'|'none'|'some'}
 */
export function allState(selection, items) {
  const ids = idsOf(items);
  if (!ids.length) return 'none';
  const ticked = new Set(Array.isArray(selection) ? selection : []);
  const count = ids.filter((id) => ticked.has(id)).length;
  if (count === 0) return 'none';
  return count === ids.length ? 'all' : 'some';
}

/** ALL pressed: every row ticked, or none. */
export function toggleAll(items, on) {
  return on ? [...new Set(idsOf(items))] : [];
}

/** One row ticked or unticked; the rest of the selection keeps its order. */
export function toggle(selection, id, on) {
  const current = stripExcluded(selection);
  if (typeof id !== 'string' || !id || EXCLUDED_IDS.has(id))
    return [...current];
  const without = current.filter((entry) => entry !== id);
  return on ? [...without, id] : without;
}

/** The same ids, whatever their order. */
export function sameSelection(a, b) {
  const left = new Set(Array.isArray(a) ? a : []);
  const right = new Set(Array.isArray(b) ? b : []);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/** Bytes as "1.2 GB" (decimal units, as the storage cap is given). */
export function formatBytes(n) {
  const bytes = Number(n);
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${tl(BYTE_UNITS[0])}`;
  let unit = 0;
  let value = bytes;
  for (;;) {
    const shown =
      unit === 0 || value >= 100
        ? Math.round(value)
        : Math.round(value * 10) / 10;
    if (shown >= 1000 && unit < BYTE_UNITS.length - 1) {
      value /= 1000;
      unit += 1;
      continue;
    }
    const number = Number.isInteger(shown) ? String(shown) : shown.toFixed(1);
    return `${localDigits(number)} ${tl(BYTE_UNITS[unit])}`;
  }
}

/** A whole number with thousands separators, the English way: 12,345. */
function englishCount(n) {
  const value = Math.round(Number(n));
  if (!Number.isFinite(value)) return '0';
  const sign = value < 0 ? '-' : '';
  return `${sign}${String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** A whole number with thousands separators: 12,345 (12 345 in Quebec French). */
export function formatCount(n) {
  return localDigits(englishCount(n));
}

/** A count as tln() takes it: the plural form follows this number. */
function whole(n) {
  return Math.round(Number(n)) || 0;
}

/**
 * The state, stage, scope and reason words the server sends, as stateLabel
 * makes them: these are translated, any other word shows as sent. The
 * prediction domains' ids are among them (MARKETS is PRICE MOVES's id).
 */
const STATE_WORDS = new Set([
  ...AI_WORLD_DOMAINS.map((domain) => domain.label),
  msgl('MARKETS'),
  msgl('IDLE'),
  msgl('INITIALIZING'),
  msgl('RUNNING'),
  msgl('PAUSED'),
  msgl('STOPPING'),
  msgl('STOPPED'),
  msgl('WAITING'),
  msgl('DONE'),
  msgl('OFF'),
  msgl('ERROR'),
  msgl('QUOTA'),
  msgl('RESTART'),
  msgl('PAUSE'),
  msgl('CONTINUE'),
  msgl('STOP'),
  msgl('TAPE'),
  msgl('BINS'),
  msgl('DATASETS'),
  msgl('WORLDS'),
  msgl('MODELS'),
  msgl('PREDICTIONS'),
  msgl('DEMOGRAPHICS'),
]);

/** A state name as upper-case words: 'outbreak-sim' → 'OUTBREAK SIM'. */
export function stateLabel(state) {
  const words = String(state ?? '')
    .trim()
    .replace(/[-_\s]+/g, ' ')
    .trim()
    .toUpperCase();
  if (!words) return tl('UNKNOWN');
  return STATE_WORDS.has(words) ? tl(words) : words;
}

/** How long ago: JUST NOW, 2 MIN AGO, 5 H AGO, 3 D AGO; '' without a time. */
export function agoLabel(atMs, nowMs = Date.now()) {
  const at = Number(atMs);
  if (!Number.isFinite(at) || at <= 0) return '';
  const seconds = Math.max(0, (Number(nowMs) - at) / 1000);
  if (!(seconds >= 60)) return tl('JUST NOW');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return tl('{minutes} MIN AGO', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return tl('{hours} H AGO', { hours });
  return tl('{days} D AGO', { days: Math.floor(hours / 24) });
}

/** A duration: UNDER 1 MIN, 12 MIN, 5 H, 3 D; '' without one. */
export function durationLabel(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  const minutes = Math.round(value / 60_000);
  if (minutes < 1) return tl('UNDER 1 MIN');
  if (minutes < 60) return tl('{minutes} MIN', { minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return tl('{hours} H', { hours });
  return tl('{days} D', { days: Math.round(hours / 24) });
}

/** A count of files: 1 FILE, 1,200 FILES. */
export function fileCount(n) {
  return tln(whole(n), '{count} FILE', '{count} FILES', {
    count: formatCount(n),
  });
}

function shortError(value) {
  const error = text(value);
  return error.length > 80 ? `${error.slice(0, 79)}…` : error;
}

function line(parts) {
  return parts.filter(Boolean).join(' · ');
}

/**
 * A row's live status from `status.feeds`: RECORDING · 12.4 MB · 2 MIN AGO,
 * PAUSED, OFF, WAITING, QUOTA, ERROR · why; '' when the server says nothing.
 */
export function feedStatusText(feed, nowMs = Date.now()) {
  if (!feed || typeof feed !== 'object') return '';
  const state = text(feed.state).toLowerCase();
  if (!state) return '';
  const size = Number(feed.bytes) > 0 ? formatBytes(feed.bytes) : '';
  const ago = agoLabel(feed.lastAt, nowMs);
  switch (state) {
    case 'recording':
      return line([tl('RECORDING'), size || formatBytes(0), ago]);
    case 'static':
      // A one-off snapshot of a layer with no live feed.
      return line([tl('SNAPSHOT'), size, ago]);
    case 'error':
      return line([tl('ERROR'), shortError(feed.error)]);
    case 'paused':
    case 'off':
    case 'waiting':
    case 'quota':
    default:
      return stateLabel(state);
  }
}

/**
 * Which buttons each state allows. PAUSE becomes CONTINUE while paused;
 * a state the tab does not know yet (no answer) acts as idle. The label is
 * English, shown through tl().
 */
export function controlStates(state) {
  switch (state) {
    case 'initializing':
    case 'running':
      return {
        initialize: false,
        pause: true,
        pauseLabel: msgl('PAUSE'),
        pauseAction: 'pause',
        stop: true,
        delete: false,
      };
    case 'paused':
      return {
        initialize: false,
        pause: true,
        pauseLabel: msgl('CONTINUE'),
        pauseAction: 'continue',
        stop: true,
        delete: false,
      };
    case 'stopping':
      return {
        initialize: false,
        pause: false,
        pauseLabel: msgl('PAUSE'),
        pauseAction: 'pause',
        stop: false,
        delete: false,
      };
    default:
      return {
        initialize: true,
        pause: false,
        pauseLabel: msgl('PAUSE'),
        pauseAction: 'pause',
        stop: false,
        delete: true,
      };
  }
}

/** How long until the status is asked for again. */
export function pollDelay(state) {
  return AI_WORLD_ACTIVE_STATES.includes(state)
    ? AI_WORLD_POLL_ACTIVE_MS
    : AI_WORLD_POLL_IDLE_MS;
}

function stageState(stage) {
  return stateLabel(stage?.state || 'off');
}

function stageError(stage) {
  return stage?.error
    ? tl('ERROR {error}', { error: shortError(stage.error) })
    : '';
}

function formatLoss(value) {
  // No loss yet (null) is no loss shown, not 0.
  if (value === null || value === undefined || value === '') return '';
  const loss = Number(value);
  if (!Number.isFinite(loss)) return '';
  return localDigits(
    Math.abs(loss) >= 100 ? loss.toFixed(0) : loss.toPrecision(3),
  );
}

/**
 * The server's TRAINING note (server/shared/aiWorldJobs.mjs) in the page's
 * words. The three it sends are known; anything else shows as sent.
 */
function trainerNote(value) {
  const note = text(value);
  const needs = /^NEEDS (\d+) BINNED DAYS · (\d+) SO FAR$/.exec(note);
  if (needs)
    return tl('NEEDS {need} BINNED DAYS · {have} SO FAR', {
      need: needs[1],
      have: needs[2],
    });
  const binning = /^BINNING (\S+) · (?:LAST DAY|(\d+) DAYS? LEFT)$/.exec(note);
  if (binning && binning[2] === undefined)
    return tl('BINNING {day} · LAST DAY', { day: binning[1] });
  if (binning) {
    const left = Number(binning[2]);
    return tln(
      left,
      'BINNING {day} · {count} DAY LEFT',
      'BINNING {day} · {count} DAYS LEFT',
      {
        day: binning[1],
        count: formatCount(left),
      },
    );
  }
  if (note === 'TRIED AGAIN WHEN A NEW DAY IS BINNED')
    return tl('TRIED AGAIN WHEN A NEW DAY IS BINNED');
  return note;
}

/** The keys of `stageLines`, in the order the STATUS list shows them. */
export const AI_WORLD_STAGE_KEYS = Object.freeze([
  'state',
  'recorder',
  'generator',
  'trainer',
  'predictor',
  'storage',
  'gaps',
  'compute',
  'links',
]);

/**
 * The STATUS lines: the job's state, then each stage (recording, sim
 * episodes, training, predicting), storage against the cap, gaps, compute,
 * and the measured links (one per line, blank until there is a report).
 * Without a status yet, each says it is waiting.
 * @param {object|null} status The server's `status`.
 * @param {number} [nowMs]
 * @returns {Record<string, string>}
 */
export function stageLines(status, nowMs = Date.now()) {
  if (!status || typeof status !== 'object') {
    return {
      state: tl('STATE · WAITING FOR THE SERVER'),
      recorder: tl('RECORDING · OFF'),
      generator: tl('SIM EPISODES · OFF'),
      trainer: tl('TRAINING · OFF'),
      predictor: tl('PREDICTING · OFF'),
      storage: tl('STORAGE · NOTHING RECORDED'),
      gaps: tl('GAPS · NONE'),
      compute: tl('COMPUTE · WAITING FOR THE SERVER'),
      links: '',
    };
  }
  const stages = status.stages || {};
  const recorder = stages.recorder || {};
  const generator = stages.generator || {};
  const trainer = stages.trainer || {};
  const predictor = stages.predictor || {};
  const storage = status.storage || {};
  const compute = status.compute || {};
  const gaps = Array.isArray(status.gaps) ? status.gaps : [];
  const since = agoLabel(status.since, nowMs);
  const used = Number(storage.usedBytes) || 0;
  const cap = Number(status.capBytes) || 0;
  const free = Number(storage.freeBytes) || 0;
  const domains = (Array.isArray(predictor.domains) ? predictor.domains : [])
    .map((domain) => stateLabel(domain))
    .join(', ');
  const lastGap = gaps.at(-1);
  const workers = Number(compute.workers) || 0;
  const feeds = Number(recorder.feeds) || 0;
  const episodes = Number(generator.episodes) || 0;
  const eta = durationLabel(generator.etaMs);
  const loss = formatLoss(trainer.loss);
  const updated = agoLabel(predictor.updatedAt, nowMs);
  return {
    state: line([
      tl('STATE'),
      stateLabel(status.state),
      since ? tl('CHANGED {ago}', { ago: since }) : '',
    ]),
    recorder: line([
      tl('RECORDING'),
      stageState(recorder),
      feeds > 0
        ? tln(whole(feeds), '{count} FEED', '{count} FEEDS', {
            count: formatCount(feeds),
          })
        : '',
      Number(recorder.bytesPerDay) > 0
        ? tl('{size} A DAY', { size: formatBytes(recorder.bytesPerDay) })
        : '',
      stageError(recorder),
    ]),
    generator: line([
      tl('SIM EPISODES'),
      stageState(generator),
      Number(generator.total) > 0
        ? `${formatCount(generator.done)} / ${formatCount(generator.total)}`
        : '',
      episodes > 0
        ? tln(whole(episodes), '{count} EPISODE', '{count} EPISODES', {
            count: formatCount(episodes),
          })
        : '',
      eta ? tl('ETA {duration}', { duration: eta }) : '',
      stageError(generator),
    ]),
    trainer: line([
      tl('TRAINING'),
      stageState(trainer),
      // The model's id as written: it names its folder under ai-world/models.
      text(trainer.model),
      Number(trainer.epochs) > 0
        ? tl('EPOCH {epoch} / {epochs}', {
            epoch: formatCount(trainer.epoch),
            epochs: formatCount(trainer.epochs),
          })
        : '',
      loss ? tl('LOSS {loss}', { loss }) : '',
      formatSkill(trainer.skill),
      trainer.channelsGrown
        ? tl('NEW CHANNELS: MODEL GROWN, WHAT IT KNEW KEPT')
        : trainer.channelMismatch
          ? tl('NEW CHANNELS, NEW MODEL')
          : '',
      // What it waits for: BINNING 2026-09-13 · 29 DAYS LEFT, NEEDS 3 BINNED
      // DAYS · 1 SO FAR, TRIED AGAIN WHEN A NEW DAY IS BINNED.
      trainerNote(trainer.note),
      stageError(trainer),
    ]),
    predictor: line([
      tl('PREDICTING'),
      stageState(predictor),
      domains,
      updated ? tl('UPDATED {ago}', { ago: updated }) : '',
      stageError(predictor),
    ]),
    storage: line([
      tl('STORAGE'),
      cap > 0
        ? `${formatBytes(used)} / ${formatBytes(cap)}`
        : tl('{size} USED', { size: formatBytes(used) }),
      cap > 0
        ? tl('{percent}%', {
            percent: Math.min(100, Math.round((used / cap) * 100)),
          })
        : '',
      free > 0 ? tl('{size} FREE ON DISK', { size: formatBytes(free) }) : '',
    ]),
    gaps: line([
      tl('GAPS'),
      gaps.length ? formatCount(gaps.length) : tl('NONE'),
      lastGap?.reason
        ? tl('LAST {reason}', { reason: stateLabel(lastGap.reason) })
        : '',
    ]),
    compute: line([
      tl('COMPUTE'),
      workers > 0
        ? tln(
            whole(workers),
            '{busy} / {count} WORKER BUSY',
            '{busy} / {count} WORKERS BUSY',
            {
              busy: formatCount(compute.busy),
              count: formatCount(workers),
            },
          )
        : tl('NO WORKERS'),
      text(compute.gpu)
        ? tl('GPU {gpu}', { gpu: text(compute.gpu) })
        : tl('NO GPU · CPU ONLY'),
    ]),
    links: measuredLinkLines(status.links).join('\n'),
  };
}

/** Days as the estimate shows them, English marks: 1.5, 12, 1,234. */
function dayCount(days) {
  if (!Number.isFinite(days) || days <= 0) return '';
  return days < 10 ? days.toFixed(1).replace(/\.0$/, '') : englishCount(days);
}

/**
 * What the estimate block says before INITIALIZE starts anything.
 * @param {object} estimate The server's `Estimate`.
 * @param {(id: string) => string} [labelFor] A row's label, for the heaviest feeds.
 * @returns {string[]}
 */
export function estimateLines(estimate, labelFor = (id) => stateLabel(id)) {
  if (!estimate || typeof estimate !== 'object') return [];
  const perDay = Number(estimate.bytesPerDay) || 0;
  const cap = Number(estimate.capBytes) || 0;
  let days = Number(estimate.daysToCap);
  if (!(days > 0) && perDay > 0 && cap > 0) days = cap / perDay;
  const feeds = (Array.isArray(estimate.feeds) ? estimate.feeds : [])
    .filter((feed) => text(feed?.id) && Number(feed.bytesPerDay) > 0)
    .sort((a, b) => Number(b.bytesPerDay) - Number(a.bytesPerDay));
  const lines = [
    perDay > 0
      ? tl('RECORDS ABOUT {size} A DAY', { size: formatBytes(perDay) })
      : tl('RECORDS NOTHING LIVE: SNAPSHOTS AND SIM ONLY'),
  ];
  const shownDays = perDay > 0 ? dayCount(days) : '';
  // The plural follows the days as shown: 1 DAY, 1.5 DAYS.
  const daysShown = Number(shownDays.replace(/,/g, ''));
  if (cap > 0)
    lines.push(
      shownDays
        ? tln(
            daysShown,
            'STORAGE CAP {cap} · FULL IN ABOUT {count} DAY',
            'STORAGE CAP {cap} · FULL IN ABOUT {count} DAYS',
            {
              cap: formatBytes(cap),
              count: localDigits(shownDays),
            },
          )
        : tl('STORAGE CAP {cap}', { cap: formatBytes(cap) }),
    );
  if (feeds.length)
    lines.push(
      [
        tl('HEAVIEST'),
        ...feeds
          .slice(0, 3)
          .map(
            (feed) => `${labelFor(feed.id)} ${formatBytes(feed.bytesPerDay)}`,
          ),
      ].join(' · '),
    );
  const workers = Number(estimate.workers) || 0;
  lines.push(
    workers > 0
      ? tln(whole(workers), '{count} WORKER', '{count} WORKERS', {
          count: formatCount(workers),
        })
      : tl('NO WORKERS'),
  );
  lines.push(
    text(estimate.gpu)
      ? tl('GPU {gpu}', { gpu: text(estimate.gpu) })
      : tl('NO GPU · CPU ONLY'),
  );
  return lines;
}

/**
 * What DELETE will remove, from the server's `DeletePreview`: one line per
 * group, the total, and the confirm button's label.
 */
export function deletePreviewView(preview) {
  const groups = (Array.isArray(preview?.groups) ? preview.groups : []).map(
    (group) =>
      line([
        stateLabel(group?.kind),
        text(group?.id),
        text(group?.path),
        fileCount(group?.files || 0),
        formatBytes(group?.bytes),
      ]),
  );
  const files = Math.max(0, Math.round(Number(preview?.totalFiles) || 0));
  const bytes = Math.max(0, Number(preview?.totalBytes) || 0);
  const root = text(preview?.root);
  return {
    groups,
    files,
    bytes,
    total: line([
      tl('TOTAL'),
      fileCount(files),
      formatBytes(bytes),
      root ? tl('IN {root}', { root }) : '',
    ]),
    confirm:
      files > 0
        ? tl('DELETE {files} · {size}', {
            files: fileCount(files),
            size: formatBytes(bytes),
          })
        : tl('NOTHING TO DELETE'),
    canDelete: files > 0 && Boolean(text(preview?.token)),
  };
}

/** What AREAS says with no area: the feeds that wait for one (via tl()). */
export const AI_WORLD_NO_AREAS = msgl(
  'NO AREAS · CAMERAS, TRAFFIC, NEWS AND IMAGERY RECORD AROUND AN AREA',
);

/**
 * The AREAS rows from the server's `status.areas`: `{ key, name, where }`,
 * the name upper case and the point to three decimals. Entries without a key
 * or a finite point are left out.
 * @param {Array<{key?: string, name?: string, lat?: number, lon?: number}>} areas
 */
export function areaRows(areas) {
  const rows = [];
  for (const area of Array.isArray(areas) ? areas : []) {
    const key = text(area?.key);
    const lat = Number(area?.lat);
    const lon = Number(area?.lon);
    if (!key || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const point = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    const name = (text(area.name) || point).toUpperCase();
    // An area named by its point shows the point once.
    rows.push({ key, name, where: name === point ? '' : point });
  }
  return rows;
}

/**
 * A PREDICTIONS domain the predictor cannot draw yet: the days recorded so
 * far and, when more days are binned than recorded (backfilled history
 * counts for the world model too), the days binned. A bare number is the
 * recorded days.
 */
export function learningLabel(learning) {
  const object = learning && typeof learning === 'object';
  const days = Number(object ? learning.daysRecorded : learning);
  if (!Number.isFinite(days) || days < 0) return tl('LEARNING');
  const recorded = Math.floor(days);
  const parts = [
    tl('LEARNING'),
    tln(recorded, '{count} DAY RECORDED', '{count} DAYS RECORDED', {
      count: formatCount(recorded),
    }),
  ];
  const binned = object ? Number(learning.daysBinned) : NaN;
  if (Number.isFinite(binned) && binned > recorded) {
    const shown = Math.floor(binned);
    parts.push(
      tln(shown, '{count} DAY BINNED', '{count} DAYS BINNED', {
        count: formatCount(shown),
      }),
    );
  }
  return parts.join(' · ');
}

/** A whole number within bounds, else the fallback. */
export function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (value === '' || value === null || !Number.isFinite(number))
    return fallback;
  return Math.min(max, Math.max(min, number));
}

/** The PREDICTIONS choice as stored: known domains and a 1–168 h horizon. */
export function cleanPredictions(raw, allowed = null) {
  const known = allowed ? new Set(allowed) : DOMAIN_IDS;
  const domains = [];
  for (const id of Array.isArray(raw?.domains) ? raw.domains : [])
    if (
      known.has(id) &&
      id !== 'military' &&
      !String(id).startsWith('military-') &&
      !domains.includes(id)
    )
      domains.push(id);
  return {
    domains,
    horizonHours: clampInt(
      raw?.horizonHours,
      AI_WORLD_HORIZON_MIN,
      AI_WORLD_HORIZON_MAX,
      AI_WORLD_HORIZON_DEFAULT,
    ),
  };
}

/** A prediction row: READY or LEARNING, plus a held-out score when one exists. */
export function domainNote(ready, learning, skill) {
  const score = formatSkill(skill);
  return [ready ? tl('READY') : learning, score].filter(Boolean).join(' · ');
}

/** The horizon's value label: 24 H. */
export function horizonLabel(hours) {
  return tl('{hours} H', {
    hours: clampInt(
      hours,
      AI_WORLD_HORIZON_MIN,
      AI_WORLD_HORIZON_MAX,
      AI_WORLD_HORIZON_DEFAULT,
    ),
  });
}

/** A predicted move as the MARKETS list shows it: `24 H ▲ 0.40%`. */
function moveText(value, horizonHours) {
  if (value === null || value === '' || value === undefined) return '';
  const pct = Number(value);
  if (!Number.isFinite(pct)) return '';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '■';
  const percent = tl('{percent}%', {
    percent: localDigits(Math.abs(pct).toFixed(2)),
  });
  return `${horizonLabel(horizonHours)} ${arrow} ${percent}`;
}

/** A quote's unit as the MARKETS list shows it; currency codes as sent. */
function unitName(unit) {
  if (unit === 'percent') return tl('percent', { context: 'unit' });
  if (unit === 'index') return tl('index', { context: 'unit' });
  return unit || '';
}

/**
 * The MARKETS list: each live quote, with the world model's predicted move
 * beside it when there is one, then any asset predicted but not quoted
 * (a quote the server no longer has). A price is a readout, not advice.
 * @param {Array<object>} quotes The server's latest quotes.
 * @param {object|null} prediction GET /predict?domain=markets (its `assets`).
 * @param {number} horizonHours
 * @returns {string[]}
 */
export function marketLines(quotes, prediction, horizonHours) {
  const moves = new Map();
  const ready = prediction && !prediction.learning;
  for (const asset of ready && Array.isArray(prediction.assets)
    ? prediction.assets
    : [])
    if (typeof asset?.series === 'string') moves.set(asset.series, asset);
  const lines = [];
  const shown = new Set();
  for (const quote of Array.isArray(quotes) ? quotes : []) {
    if (typeof quote?.series !== 'string') continue;
    shown.add(quote.series);
    const label = tl(
      quote.label || marketAsset(quote.series)?.label || quote.series,
    );
    const source = quote.source ? ` · ${quote.source}` : '';
    const move = moveText(moves.get(quote.series)?.value, horizonHours);
    const value = `${localDigits(quote.value)} ${unitName(quote.unit)}`.trim();
    lines.push(
      tl('{label}: {value}', { label, value }) +
        source +
        (move ? ` · ${move}` : ''),
    );
  }
  for (const [series, asset] of moves) {
    if (shown.has(series)) continue;
    const move = moveText(asset.value, horizonHours);
    if (!move) continue;
    const label = tl(asset.label || marketAsset(series)?.label || series);
    lines.push(tl('{label}: {value}', { label, value: move }));
  }
  return lines;
}

/**
 * The POST-TRAIN line: the last run's held-out loss before and after, or
 * what is saved, or what the kit already does by itself.
 * @param {{adapter?: string, checkpoint?: string, daily?: boolean, last?: object|null}|null} posttrain
 */
export function postTrainNote(posttrain) {
  const own = tl(
    "THE KIT'S OWN WORLD MODEL POST-TRAINS ITSELF EVERY DAY ON ALL RECORDED DAYS, AND GROWS WHEN A NEW LAYER OR ASSET ARRIVES.",
  );
  if (!posttrain?.adapter) return own;
  const last = posttrain.last;
  const saved = posttrain.daily
    ? tl('SAVED {adapter} · DAILY', { adapter: posttrain.adapter })
    : tl('SAVED {adapter}', { adapter: posttrain.adapter });
  if (!last) return tl('{saved} · NOT RUN YET', { saved });
  // A blank score (null) is no score: Number(null) would read 0.
  const num = (v) =>
    v === null || v === undefined || v === '' ? NaN : Number(v);
  const before = num(last.before);
  const after = num(last.after);
  const score =
    Number.isFinite(before) && Number.isFinite(after)
      ? tl('HELD-OUT LOSS {before} → {after} · {verdict}', {
          before: localDigits(before.toFixed(3)),
          after: localDigits(after.toFixed(3)),
          verdict: last.helped ? tl('HELPED') : tl('DID NOT HELP'),
        })
      : tl('NO HELD-OUT SCORE');
  return last.trainedThrough
    ? tl('{saved} · LAST: {score} · TRAINED THROUGH {day}', {
        saved,
        score,
        day: last.trainedThrough,
      })
    : tl('{saved} · LAST: {score}', { saved, score });
}
