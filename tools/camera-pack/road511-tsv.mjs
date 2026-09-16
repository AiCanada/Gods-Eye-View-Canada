// Pure helpers for the US camera pack. They turn Road511's public-webcam
// listing (a TSV export of the US DOT cameras it indexes) into entries for
// config/cctv_sources.us.json. Nothing here touches files or the network;
// build-road511-us.mjs reads the TSV and writes the pack and its report.
//
// Every camera is kept, switched off or not. A row with no still image is
// still a camera: it is written as `feedType: 'none'` with `lookup: 'road511'`,
// and the server asks Road511 for its image only when someone opens it.
import { headingFrom } from './ibi511-list.mjs';
import { isSchoolCamera, isSchoolText } from './school-cams.mjs';
import { providerFor } from './us-providers.mjs';

export const PACK_FORMAT = 'gev-cctv-pack/1';
export const ID_PREFIX = 'us511-';

/** Fields every US camera shares; the loader spreads them under each camera. */
export const PACK_DEFAULTS = Object.freeze({
  country: 'US',
  sourceKind: 'configured',
  pitchDeg: -6,
  fovDeg: 70,
  rangeM: 500,
  mountHeightM: 10,
  headingConfidence: 'unknown',
});

/** Columns the builder cannot work without. The others are read when present. */
export const REQUIRED_COLUMNS = Object.freeze(['state_id', 'state_name', 'camera_id', 'camera_name', 'latitude', 'longitude']);

/** Per-direction still columns of a multi-view site, in the order its views are written. */
export const VIEW_DIRECTIONS = Object.freeze(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);
const DIRECTION_WORDS = {
  N: 'North', S: 'South', E: 'East', W: 'West', NE: 'Northeast', NW: 'Northwest', SE: 'Southeast', SW: 'Southwest',
};

/** Every US state and territory with cameras, generously bounded. */
export const US_BOUNDS = Object.freeze({ latMin: 17.5, latMax: 71.5, lonMin: -179.5, lonMax: -64 });

/** How far a camera may sit from the median point of its state's cameras. */
export const STATE_REACH_KM = 800;
// Alaska is wider than the lower 48 are tall, so only the US box holds it.
// California's and Texas's cameras run past 800 km from their middle
// (Crescent City and El Paso sit about 950 km out), so they get more room.
export const STATE_REACH_OVERRIDES_KM = Object.freeze({ AK: Infinity, CA: 1200, TX: 1200 });

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
/**
 * The listed camera id with only its edges trimmed. Road511's own ids can hold
 * two spaces in a row ("VT-cam-HARTFORD  RWIS CCTV" is a different camera from
 * "VT-cam-HARTFORD RWIS CCTV"), and the pack id must name the same Road511
 * feature, so inner spacing is never collapsed. clean() is for names and text.
 */
export const cameraIdOf = (row) => String(row?.camera_id ?? '').trim();
const squash = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const stateOf = (row) => clean(row.state_id).toUpperCase();
const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/**
 * Rows keyed by header name, so a re-ordered export still reads. Strips a BOM
 * and the \r of CRLF line ends, and trims every cell.
 * @returns {{ columns: string[], rows: Record<string, string>[] }}
 */
export function parseTsv(text) {
  const lines = stripBom(String(text ?? '')).split('\n').map((line) => line.replace(/\r$/, ''));
  const columns = (lines.shift() || '').split('\t').map((name) => name.trim());
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.includes(name));
  if (missing.length) throw new Error(`Road511 TSV is missing column(s): ${missing.join(', ')}`);
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    const row = {};
    columns.forEach((name, index) => {
      row[name] = (cells[index] ?? '').trim();
    });
    rows.push(row);
  }
  return { columns, rows };
}

/**
 * Identical rows (the export repeats some) drop silently. A second row that
 * reuses an id with different content is a conflict: the first one is kept
 * and the rest are reported. Rows with no camera id cannot be addressed and
 * are reported apart.
 */
export function dedupeRows(rows) {
  const byId = new Map();
  const kept = [];
  const conflicts = [];
  const missingId = [];
  let identical = 0;
  for (const row of rows) {
    const id = cameraIdOf(row);
    if (!id) {
      missingId.push(row);
      continue;
    }
    const key = JSON.stringify(row);
    const first = byId.get(id);
    if (!first) {
      byId.set(id, { row, key });
      kept.push(row);
    } else if (first.key === key) {
      identical += 1;
    } else {
      conflicts.push({ id, kept: first.row, dropped: row });
    }
  }
  return { rows: kept, identical, conflicts, missingId };
}

const toCoord = (value) => {
  const text = clean(value);
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};
const insideUs = ({ lat, lon }) =>
  lat >= US_BOUNDS.latMin && lat <= US_BOUNDS.latMax && lon >= US_BOUNDS.lonMin && lon <= US_BOUNDS.lonMax;
export const stateReachKm = (state) => STATE_REACH_OVERRIDES_KM[state] ?? STATE_REACH_KM;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Repairs what can be repaired and rejects the rest. A positive longitude is
 * a dropped minus sign when its negation lands within reach of the median
 * point of the state's cameras, so it is flipped (Alaska is exempt: the
 * Aleutians really do cross the antimeridian). A point outside the US box, or
 * farther from its state's median than the state's reach, is rejected: those
 * are placeholders ("test location" rows sitting in Ontario or the Atlantic).
 * @returns {{ rows: object[], fixes: object[], rejects: object[], medians: Map<string, {lat:number, lon:number}> }}
 */
export function fixCoordinates(rows) {
  const parsed = rows.map((row) => ({ row, state: stateOf(row), lat: toCoord(row.latitude), lon: toCoord(row.longitude) }));
  const byState = new Map();
  for (const item of parsed) {
    if (item.lat === null || item.lon === null || !insideUs(item)) continue;
    if (!byState.has(item.state)) byState.set(item.state, []);
    byState.get(item.state).push(item);
  }
  const medians = new Map(
    [...byState].map(([state, items]) => [state, { lat: median(items.map((i) => i.lat)), lon: median(items.map((i) => i.lon)) }]),
  );

  const kept = [];
  const fixes = [];
  const rejects = [];
  for (const { row, state, lat, lon } of parsed) {
    const reject = (reason) => rejects.push({ id: cameraIdOf(row), state, lat, lon, name: clean(row.camera_name), reason });
    if (lat === null || lon === null) {
      reject('no coordinates');
      continue;
    }
    const center = medians.get(state);
    const reach = stateReachKm(state);
    let point = { lat, lon };
    if (lon > 0 && state !== 'AK' && center && haversineKm(center, { lat, lon: -lon }) <= reach) {
      point = { lat, lon: -lon };
      fixes.push({ id: cameraIdOf(row), state, from: { lat, lon }, to: point, reason: 'longitude sign restored' });
    }
    if (!insideUs(point)) {
      reject('outside the US');
      continue;
    }
    const km = center ? haversineKm(center, point) : 0;
    if (km > reach) {
      reject(`${Math.round(km)} km from the median ${state} camera point (reach ${reach} km)`);
      continue;
    }
    kept.push({ ...row, lat: point.lat, lon: point.lon });
  }
  return { rows: kept, fixes, rejects, medians };
}

/** A compass label ("N", "Northbound") is an estimated view bearing; anything else is unknown. */
export function headingFromDirection(direction) {
  const deg = headingFrom(direction);
  return deg === null ? { headingDeg: null, headingConfidence: 'unknown' } : { headingDeg: deg, headingConfidence: 'estimated' };
}

const VIDEO_PATH = /\.(?:m3u8|mpd|mp4|webm|flv|ts)$/i;
const VIDEO_HOST = /(^|\.)(?:youtube\.com|youtu\.be|vimeo\.com)$/i;
const PAGE_PATH = /\.(?:html?|aspx?|php|jsp|cfm)$/i;
const STILL_HINT = /snap|still|image|thumb|jpe?g|png/i;

function isPrivateHost(host) {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (name === 'localhost' || /\.(?:localhost|local|internal|lan)$/.test(name)) return true;
  const v4 = name.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (name.includes(':')) return name === '::' || name === '::1' || /^f[cd]/.test(name) || /^fe[89ab]/.test(name);
  return false;
}

/**
 * What a listed link is. `href` is the WHATWG-serialised URL, so a path with
 * spaces ("I-70 at MM 88.jpg") is percent-encoded and a default port dropped.
 * @returns {null | { kind: 'still'|'video'|'page'|'private'|'invalid', href: string, host: string }}
 */
export function classifyLink(value) {
  const raw = clean(value);
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'invalid', href: raw, host: '' };
  }
  const host = url.hostname.toLowerCase();
  const link = (kind) => ({ kind, href: url.href, host });
  if (/^(?:rtsp|rtmp)s?:$/.test(url.protocol)) return link('video');
  if (!/^https?:$/.test(url.protocol)) return link('invalid');
  if (isPrivateHost(host)) return link('private');
  if (VIDEO_HOST.test(host) || VIDEO_PATH.test(url.pathname)) return link('video');
  if ((PAGE_PATH.test(url.pathname) && !STILL_HINT.test(url.pathname + url.search)) || url.hash) return link('page');
  return link('still');
}

/** The row's still, stream and distinct still views. */
export function rowLinks(row) {
  const views = [];
  const seen = new Set();
  for (const dir of VIEW_DIRECTIONS) {
    const link = classifyLink(row[dir]);
    if (link?.kind !== 'still' || seen.has(link.href)) continue;
    seen.add(link.href);
    views.push({ dir, link });
  }
  return { primary: classifyLink(row.primary_url), video: classifyLink(row.video_url), views };
}

/** Operator for the row, from its link hosts, else its state's DOT. */
export function rowProvider(row, links = rowLinks(row)) {
  const hosts = [links.primary, links.video, ...links.views.map((view) => view.link)].map((link) => link?.host).filter(Boolean);
  return providerFor({ state: stateOf(row), hosts });
}

const BARE_NUMBER = /^#?\d+(?:[-.]\d+)*$/;
/** One token with a digit in it: "NO0092", "TX_HOU_390", "001-CCTV", "I-470". */
const CODE = /^(?=[\w-]*\d)[\w-]+$/;
/** An opaque lowercase key ("0wyvj6n16r826rz758qn5mf48ogpj1fp") says nothing beside a road. */
const OPAQUE_KEY = /^(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{20,}$/;
const ROUTE_ONLY = /^[a-z]{1,5}[- .]?\d{1,4}[a-z]?$/i;
/** TxDOT's unset mile marker: "IH20 @ MRM 0 (WB)" names no place. */
const PLACEHOLDER = /\bMRM 0\b/;
const NOT_A_PLACE = /^(?:n\/?a|none|null|unknown|other|tbd|test|local|cnty|traffic closest to .*|camera is located .*)$/i;
const TRAVEL_DIRECTION = /\((?:[NSEW]B|north|south|east|west)(?:bound)?\)$/i;

const isWeakName = (name, road) =>
  !name || BARE_NUMBER.test(name) || CODE.test(name) || ROUTE_ONLY.test(name) || PLACEHOLDER.test(name) ||
  (Boolean(road) && squash(name) === squash(road));
const isPlaceText = (text) => text.length >= 3 && /\p{L}/u.test(text) && !NOT_A_PLACE.test(text) && !BARE_NUMBER.test(text) && !CODE.test(text);

/**
 * The listed name, unless it is empty, a bare number, a code, just the road,
 * or a placeholder. Then the location or details text stands in (New Jersey's
 * details column is the township, so it is a city, not a name), and failing
 * that the road, keeping a readable code beside it ("I-66 (NO0092)").
 */
export function cameraName(row) {
  const name = clean(row.camera_name);
  const road = clean(row.road);
  if (!isWeakName(name, road)) return name;
  const details = stateOf(row) === 'NJ' ? '' : row.camera_details;
  const place = [row.location, details].map(clean).find((text) => isPlaceText(text) && squash(text) !== squash(name));
  if (place) {
    const bound = name.match(TRAVEL_DIRECTION);
    return bound && !place.endsWith(bound[0]) ? `${place} ${bound[0]}` : place;
  }
  if (!name) return road && !NOT_A_PLACE.test(road) ? road : clean(row.camera_id);
  if (road && !NOT_A_PLACE.test(road) && squash(road) !== squash(name)) {
    if (squash(road).includes(squash(name))) return road;
    if (!squash(name).includes(squash(road))) return OPAQUE_KEY.test(name) ? road : `${road} (${name})`;
  }
  return name;
}

/** A compass letter or abbreviation standing alone: "S. Smyrna", "NW-Lom", "SW Connector". */
const COMPASS_TOKEN = /(?<![\p{L}])(?:[NSEW]|[NS][EW]|[NSEW]B)(?![\p{L}])/u;
/** A label made only of these words is a position on the road ("East End", "Upper Deck East", "View South"). */
const POSITION_WORDS = new Set([
  'north', 'south', 'east', 'west', 'northbound', 'southbound', 'eastbound', 'westbound', 'inbound', 'outbound',
  'upper', 'lower', 'middle', 'mid', 'center', 'centre', 'top', 'bottom', 'left', 'right', 'inner', 'outer', 'end',
  'both', 'off', 'on', 'main', 'median', 'view', 'looking', 'side', 'ramp', 'ramps', 'intersection', 'span', 'deck',
]);
/** Cameras, structures along a road, waterways and street types: never a town. */
const NOT_A_TOWN = new RegExp(
  `(?<![\\p{L}])(?:${[
    'ptz', 'wireless', 'cell', 'cellular', 'mini', 'dual', 'hd', 'fixed', 'camera', 'cam', 'cctv', 'rwis', 'dms', 'sign',
    'truss', 'pole', 'portable', 'temp', 'test', 'zoom', 'angle', 'overview', 'tmc', 'uscg', 'shelter', 'bridge', 'brdg',
    'br', 'tunnel', 'overpass', 'underpass', 'flyover', 'ramps?', 'exit', 'interchange', 'intersection', 'junction',
    'jct', 'split', 'connector', 'conn', 'arterial', 'approach', 'curve', 'grade', 'summit', 'shoulder', 'tower', 'gate',
    'backgate', 'entrance', 'ent', 'station', 'parking', 'lot', 'area', 'rest', 'welcome', 'visitor', 'plaza', 'toll',
    'mall', 'jail', 'stockpile', 'crossing', 'speedway', 'pavillion', 'corner', 'bldg', 'hov', 'xrd', 'perch', 'mix',
    'view', 'looking', 'side', 'river', 'creek', 'canal', 'ave', 'avenue', 'av', 'street', 'rd', 'road', 'dr', 'drive',
    'blvd', 'boulevard', 'hwy', 'highway', 'pkwy', 'parkway', 'fwy', 'freeway', 'expy', 'expwy', 'expressway', 'ln',
    'lane', 'way', 'pl', 'place', 'ct', 'court', 'cir', 'circle', 'trl', 'tr', 'trail', 'pike', 'pk', 'prk', 'loop',
    'ter', 'terrace', 'rte', 'route', 'interstate', 'bypass', 'byp', 'spur',
  ].join('|')})(?![\\p{L}])`,
  'iu',
);
const titleCase = (text) =>
  text === text.toUpperCase() ? text.toLowerCase().replace(/(^|[\s.'’-])(\p{L})/gu, (m, lead, letter) => lead + letter.toUpperCase()) : text;

/** A town or county named in a label, or '' when the label names something else. */
function townFrom(text) {
  const label = clean(text).replace(/\s+new$/i, '');
  if (label.length > 40 || !/^\p{Lu}[\p{L} .'’-]*$/u.test(label)) return '';
  const letters = label.replace(/[^\p{L}]/gu, '');
  if (letters.length < 4 || !/[aeiouy]/i.test(letters)) return '';
  if (COMPASS_TOKEN.test(label) || / - | of | near /i.test(` ${label} `)) return '';
  // A street ("Main St", but not "Bay St. Louis"), a state line, a hotel, or a
  // place with a compass word after it ("Arthur East") is a spot on the road.
  if (/(?<![\p{L}])st\.?$|\s(?:north|south|east|west)$/iu.test(label) || /(?<![\p{L}])(?:line|inn|hotel|motel)(?![\p{L}])/iu.test(label)) {
    return '';
  }
  if (label.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean).every((word) => POSITION_WORDS.has(word))) return '';
  if (NOT_A_TOWN.test(label)) return '';
  return titleCase(label);
}

const trailingParen = (text) => clean(text).match(/\(([^()]+)\)$/)?.[1] || '';

/**
 * A trailing "(Town)" in the name ("SR 11 at Star St (BARROW)" -> Barrow),
 * never a direction, a camera, a structure or a road; else New Jersey's
 * township column ("I-280 (East Orange)", "Howell Township"); else the state.
 */
export function cameraCity(row) {
  const fromName = townFrom(trailingParen(row.camera_name));
  if (fromName) return fromName;
  if (stateOf(row) === 'NJ') {
    const details = clean(row.camera_details);
    const township = townFrom(trailingParen(details) || details);
    if (township) return township;
  }
  return clean(row.state_name) || stateOf(row);
}

const headingFields = ({ headingDeg }) =>
  headingDeg === null ? {} : { headingDeg, headingConfidence: 'estimated' };

/**
 * One pack camera per row, or one per view when a row lists two or more
 * distinct view stills (Nebraska's multi-view sites): `us511-<id>-<DIR>`.
 * A row with a still is `feedType: 'image'`. A row with only a stream, a web
 * page or nothing is `feedType: 'none'` with `lookup: 'road511'`; its stream
 * address is kept as `videoUrl` but never served. Shared fields (country,
 * pose defaults) live in PACK_DEFAULTS and the operator in the providers map
 * under `p`.
 */
export function rowToEntries(row) {
  const id = `${ID_PREFIX}${cameraIdOf(row)}`;
  const name = cameraName(row);
  const lat = Number.isFinite(row.lat) ? row.lat : toCoord(row.latitude);
  const lon = Number.isFinite(row.lon) ? row.lon : toCoord(row.longitude);
  const place = { city: cameraCity(row), region: stateOf(row), lat: round6(lat), lon: round6(lon) };
  const links = rowLinks(row);
  const p = rowProvider(row, links).key;

  if (links.views.length >= 2) {
    return links.views.map(({ dir, link }) => ({
      id: `${id}-${dir}`,
      name: `${name} (${DIRECTION_WORDS[dir]} view)`,
      ...place,
      p,
      feedType: 'image',
      url: link.href,
      ...headingFields(headingFromDirection(dir)),
    }));
  }

  const view = links.views[0];
  const still = links.primary?.kind === 'still' ? links.primary : view?.link;
  let heading = headingFromDirection(row.direction);
  if (heading.headingDeg === null && view && (!still || still.href === view.link.href)) heading = headingFromDirection(view.dir);
  if (still) return [{ id, name, ...place, p, feedType: 'image', url: still.href, ...headingFields(heading) }];

  // The video column is a stream whatever its address looks like (Maryland's
  // CHART player links carry no extension); a streaming primary link is too.
  const fromVideoColumn = ['still', 'video', 'page'].includes(links.video?.kind) ? links.video : null;
  const stream = fromVideoColumn || (links.primary?.kind === 'video' ? links.primary : null);
  return [
    { id, name, ...place, p, feedType: 'none', ...headingFields(heading), lookup: 'road511', ...(stream ? { videoUrl: stream.href } : {}) },
  ];
}

const ROAD_CONNECTOR = /(?<![\p{L}])(?:at|and|of|near)(?![\p{L}])|[@&]/iu;

/**
 * Where a row places its camera on a school, or null. Links are checked for
 * school hosts, the name, location and details for school words. The road
 * column names the road itself, so a bare "University" or "Verot School"
 * there is that road; it is read only when it describes a place
 * ("SR-146 at Dillon School"). The name is judged together with the row's
 * listed link, the way the server judges the pack entry, so a 511 traffic
 * system camera named by two crossing roads ("Broadway University") stays.
 * @returns {null | { field: string, text: string }}
 */
export function schoolHit(row) {
  const id = `${ID_PREFIX}${cameraIdOf(row)}`;
  for (const field of ['primary_url', 'video_url', ...VIEW_DIRECTIONS]) {
    const url = clean(row[field]);
    if (url && isSchoolCamera({ id, url })) return { field, text: url };
  }
  const name = clean(row.camera_name);
  if (isSchoolCamera({ id, name, url: clean(row.primary_url) })) return { field: 'camera_name', text: name };
  for (const field of ['location', 'camera_details']) {
    const text = clean(row[field]);
    if (isSchoolText(text)) return { field, text };
  }
  const road = clean(row.road);
  if (ROAD_CONNECTOR.test(road) && isSchoolText(road)) return { field: 'road', text: road };
  return null;
}

/**
 * The compact pack file: one provider and one camera per line, so a rebuild
 * diffs camera by camera and the file stays small.
 */
export function formatPack({ providers, cameras, defaults = PACK_DEFAULTS }) {
  return [
    `{"format":${JSON.stringify(PACK_FORMAT)},`,
    `"defaults":${JSON.stringify(defaults)},`,
    '"providers":{',
    Object.entries(providers).map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',\n'),
    '},',
    '"cameras":[',
    cameras.map((camera) => JSON.stringify(camera)).join(',\n'),
    ']}',
    '',
  ].join('\n');
}

/** The loader's expansion, `{...defaults, ...providers[p], ...camera}` without `p`; a plain array passes through. */
export function expandPack(pack) {
  if (Array.isArray(pack)) return pack;
  const defaults = pack?.defaults || {};
  const providers = pack?.providers || {};
  return (pack?.cameras || []).map(({ p, ...camera }) => ({ ...defaults, ...(providers[p] || {}), ...camera }));
}

/**
 * The busiest `radiusKm` circles centred on a camera, at least two radii
 * apart so each names a different area. For the report: an area over the
 * server's 1,000-camera load cap shows here. Grid cells do not wrap the
 * antimeridian; no US camera cluster sits on it.
 * @param {{lat:number, lon:number}[]} points
 * @returns {{ point: object, count: number }[]}
 */
export function densestCircles(points, { radiusKm = 50, count = 10 } = {}) {
  const cellDeg = 0.5;
  const cellOf = (deg) => Math.floor(deg / cellDeg);
  const grid = new Map();
  points.forEach((point, index) => {
    const key = `${cellOf(point.lat)}:${cellOf(point.lon)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(index);
  });
  const latSpan = Math.ceil(radiusKm / (110.57 * cellDeg));
  const counts = points.map((point) => {
    const lonSpan = Math.ceil(radiusKm / (111.32 * cellDeg * Math.max(0.05, Math.cos((point.lat * Math.PI) / 180))));
    const row = cellOf(point.lat);
    const col = cellOf(point.lon);
    let n = 0;
    for (let di = -latSpan; di <= latSpan; di += 1) {
      for (let dj = -lonSpan; dj <= lonSpan; dj += 1) {
        for (const other of grid.get(`${row + di}:${col + dj}`) || []) {
          if (haversineKm(point, points[other]) <= radiusKm) n += 1;
        }
      }
    }
    return n;
  });
  const order = counts.map((_, index) => index).sort((a, b) => counts[b] - counts[a] || a - b);
  const picked = [];
  for (const index of order) {
    if (picked.length >= count) break;
    if (picked.some((circle) => haversineKm(circle.point, points[index]) < radiusKm * 2)) continue;
    picked.push({ point: points[index], count: counts[index] });
  }
  return picked;
}
