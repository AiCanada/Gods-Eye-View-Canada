// Pure helpers for the CCTV inventory (cctv-inventory-<date>.csv): one row per
// camera site, from the operators' own camera lists (state DOTs, cities, 511
// systems, national road agencies), with the site's views as JSON. The file
// work is in build-inventory.mjs.
//
// No camera is left out for standing near another one. A camera is a
// duplicate only when it IS one already held: the same still or stream
// address, the same operator camera number, the same operator code, or the
// same name in the same state or province (a 3 km guard keeps two different
// cameras that share a common name in one state apart).
import { headingFrom } from './ibi511-list.mjs';
import { CANADA_BOUNDS, canonicalHref } from './canada-listing-tsv.mjs';
import { isTimestampedStill } from './intl-tsv.mjs';
import { US_BOUNDS } from './road511-tsv.mjs';
import { isSchoolCamera, isSchoolText } from './school-cams.mjs';
import { cctvRegionKey } from '../../server/providers/cctv/catalog.js';
import { safeHlsPlaylistUrl } from '../../server/providers/cctv/hls-proxy.js';
import { cctvStillKey } from '../../server/providers/cctv/normalize.js';

export { formatPack, expandPack } from './road511-tsv.mjs';

export const ID_PREFIX = 'inv-';
export const LISTING = 'CCTV inventory';

/** Fields every inventory camera shares; the loader spreads them under each entry. */
export const PACK_DEFAULTS = Object.freeze({
  sourceKind: 'configured',
  pitchDeg: -6,
  fovDeg: 70,
  rangeM: 500,
  mountHeightM: 10,
  headingConfidence: 'unknown',
});

export const REQUIRED_COLUMNS = Object.freeze([
  'country',
  'provider',
  'sourceId',
  'location',
  'lat',
  'lon',
  'views_json',
]);

/** Country names the inventory spells out, as ISO codes. A two-letter code passes as is. */
export const COUNTRY_CODES = Object.freeze({
  'united states': 'US',
  usa: 'US',
  'united states of america': 'US',
  canada: 'CA',
  'south korea': 'KR',
  korea: 'KR',
  'republic of korea': 'KR',
  taiwan: 'TW',
  japan: 'JP',
  'hong kong': 'HK',
  singapore: 'SG',
  indonesia: 'ID',
  malaysia: 'MY',
  thailand: 'TH',
  philippines: 'PH',
  vietnam: 'VN',
  india: 'IN',
  china: 'CN',
  australia: 'AU',
  'new zealand': 'NZ',
  'united kingdom': 'GB',
  uk: 'GB',
  ireland: 'IE',
  spain: 'ES',
  portugal: 'PT',
  france: 'FR',
  germany: 'DE',
  switzerland: 'CH',
  austria: 'AT',
  italy: 'IT',
  netherlands: 'NL',
  belgium: 'BE',
  luxembourg: 'LU',
  denmark: 'DK',
  norway: 'NO',
  sweden: 'SE',
  finland: 'FI',
  estonia: 'EE',
  latvia: 'LV',
  lithuania: 'LT',
  poland: 'PL',
  czechia: 'CZ',
  'czech republic': 'CZ',
  slovakia: 'SK',
  slovenia: 'SI',
  croatia: 'HR',
  hungary: 'HU',
  romania: 'RO',
  bulgaria: 'BG',
  greece: 'GR',
  turkey: 'TR',
  iceland: 'IS',
  mexico: 'MX',
  brazil: 'BR',
  argentina: 'AR',
  chile: 'CL',
  colombia: 'CO',
  peru: 'PE',
  'south africa': 'ZA',
});

/** The City of Austin's cameras come from the Austin open-data live pack, which
 * downloads them only when an Austin area is selected; a stored copy would
 * duplicate it. */
export const LIVE_PACK_PROVIDERS = Object.freeze(new Set(['austinatd']));

const clean = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * RFC 4180 CSV: quoted fields may hold commas, doubled quotes and line breaks.
 * @returns {{ header: string[], rows: object[], badRows: number }}
 */
export function parseCsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  const body = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (body[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      records.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    records.push(row);
  }
  const header = (records.shift() || []).map((name) => name.trim());
  const rows = [];
  let badRows = 0;
  for (const cells of records) {
    if (cells.length === 1 && cells[0] === '') continue;
    if (cells.length !== header.length) {
      badRows += 1;
      continue;
    }
    rows.push(Object.fromEntries(header.map((name, i) => [name, cells[i]])));
  }
  return { header, rows, badRows };
}

/** A country name folded for lookup: no accents, "&" as "and", "_" as a space. */
const foldCountry = (text) =>
  clean(String(text ?? '').replace(/_/g, ' '))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .toLowerCase();

/** Names the inventories use that are not the English country name. */
const COUNTRY_ALIASES = Object.freeze({
  // Australian states, territories and cities written where the country goes.
  victoria: 'AU',
  queensland: 'AU',
  'new south wales': 'AU',
  'western australia': 'AU',
  'south australia': 'AU',
  tasmania: 'AU',
  'northern territory': 'AU',
  'australian capital territory': 'AU',
  sydney: 'AU',
  'canary islands': 'ES',
  macedonia: 'MK',
  'north macedonia': 'MK',
  kosovo: 'XK',
  'gaza strip': 'PS',
  'west bank': 'PS',
  palestine: 'PS',
  macau: 'MO',
  macao: 'MO',
  'us virgin islands': 'VI',
  'u.s. virgin islands': 'VI',
  'british virgin islands': 'VG',
  'turks and caicos': 'TC',
  'turks and caicos islands': 'TC',
  'r union fr': 'RE',
  'cura ao': 'CW',
  curacao: 'CW',
  'netherlands antilles': 'CW',
  'saint barthelemy': 'BL',
  'saint vincent grenadines': 'VC',
  'democratic republic of the congo': 'CD',
  'democratic republic of congo': 'CD',
  'cape verde': 'CV',
  'south georgia': 'GS',
  'the gambia': 'GM',
  gambia: 'GM',
  'isle of man': 'IM',
  'ivory coast': 'CI',
  'east timor': 'TL',
  burma: 'MM',
  'czech republic': 'CZ',
  russia: 'RU',
  'saint martin': 'MF',
  norfolk: 'NF',
  'christmas island': 'CX',
});

/** Every English region name Intl knows, folded, as its ISO code. Built once. */
let ISO_NAMES = null;
function isoNames() {
  if (ISO_NAMES) return ISO_NAMES;
  ISO_NAMES = new Map();
  let names = null;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return ISO_NAMES;
  }
  const A = 'A'.charCodeAt(0);
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j);
      let name = '';
      try {
        name = names.of(code);
      } catch {
        continue;
      }
      if (!name || name === code) continue;
      ISO_NAMES.set(foldCountry(name), code);
      // "Congo - Kinshasa", "Hong Kong SAR China": the part before the qualifier too.
      const short = foldCountry(name.replace(/\s+(?:-\s.*|SAR China)$/, ''));
      if (!ISO_NAMES.has(short)) ISO_NAMES.set(short, code);
    }
  }
  return ISO_NAMES;
}

export function countryCode(name) {
  const text = clean(name);
  if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase();
  const folded = foldCountry(text);
  return (
    COUNTRY_CODES[text.toLowerCase()] ||
    COUNTRY_ALIASES[folded] ||
    isoNames().get(folded) ||
    ''
  );
}

/** Countries whose cameras are never stored. */
export const EXCLUDED_COUNTRIES = Object.freeze(new Set(['UA']));

/** The two-letter state or province of a US or Canadian row; '' elsewhere. */
export function regionCode(country, province) {
  if (country !== 'US' && country !== 'CA') return '';
  const key = cctvRegionKey({ country, region: clean(province) });
  return key.startsWith(`${country}-`) ? key.slice(3) : '';
}

/** Why a point cannot be stored, or ''. */
export function pointProblem(country, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'no coordinates';
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return 'coordinates out of range';
  if (lat === 0 && lon === 0) return 'coordinates at 0,0';
  const inside = (b) =>
    lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
  if (country === 'US' && !inside(US_BOUNDS))
    return 'outside the United States';
  if (country === 'CA' && !inside(CANADA_BOUNDS)) return 'outside Canada';
  return '';
}

const SIGNED_PARAM =
  /^(?:token|signature|sig|expires?|expiry|x-amz-signature|x-amz-credential|hdnts|hmac|wowzatokenhash|policy|key-pair-id)$/i;
// A per-session encrypted path (UTIC's cctvsec streams): a long run of base64
// with its '+' or '=' in it, not just a long ordinary path.
const LONG_TOKEN_RUN = /[A-Za-z0-9+/=]{40,}/g;
const hasLongToken = (path) =>
  (path.match(LONG_TOKEN_RUN) || []).some((run) => /[+=]/.test(run));
const SESSION_STREAM_HOST = /(^|\.)cctvsec\.ktict\.co\.kr$/i;
const EMBED_HOST = /(^|\.)(?:youtube\.com|youtu\.be|ytimg\.com|vimeo\.com)$/i;
const THUMB_PATH = /\/(?:thumbs?|tn)\//i;
const ALT_LABEL = /^(?:thumb(?:nail)?|reference|reference image|small)$/i;
const IMAGE_FILE = /\.(?:jpe?g|png|gif|webp|bmp)$/i;
const VIDEO_FILE = /\.(?:mp4|webm|flv|mpd|ts)$/i;
const PAGE_FILE = /\.(?:html?|aspx?|jsp|cfm|do)$/i;
const PAGE_HINT =
  /showcamera|fenetrevideo|cameraplayer|videodetail|cctvpopup|cctvview|rtmpview|\/getvideo\/|[?&]format=mp4/i;
const MJPEG_HINT = /mjpe?g|bmjpg|video\.cgi/i;
const STILL_HINT =
  /snap|still|image|img|jpe?g|png|latest|current|webcam|camera/i;
const STILL_LABEL = /snapshot|jpe?g|^image$|still|current image|mjpe?g/i;

/**
 * What one listed view link is:
 * - `still`: a picture the frame route can fetch (a still, a 511 `/map/Cctv/`
 *   still, or a motion-JPEG stream, whose first picture is the still);
 * - `hls`: a playlist the same-origin HLS proxy can play;
 * - `alt`: a thumbnail or reference copy of a still the row already has;
 * - `signed`: an address that expires (a token, a per-session path);
 * - `timestamped`: a still whose path carries its capture date;
 * - `page`, `video`, `embed`, `invalid`: nothing the app can show.
 * @returns {{ kind: string, href: string, host: string, label: string }}
 */
export function classifyView(view) {
  const raw = clean(view?.url);
  const label = clean(view?.description);
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'invalid', href: raw, host: '', label };
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password
  )
    return { kind: 'invalid', href: raw, host: '', label };
  const href = url.href;
  const host = url.hostname.toLowerCase();
  const out = (kind, at = href) => ({ kind, href: at, host, label });
  if (EMBED_HOST.test(host)) return out('embed');
  let path = url.pathname;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    /* keep the encoded path */
  }
  if (
    SESSION_STREAM_HOST.test(host) ||
    [...url.searchParams.keys()].some((k) => SIGNED_PARAM.test(k)) ||
    hasLongToken(path)
  )
    return out('signed');
  if (/\.m3u8?$/i.test(url.pathname)) {
    const playlist = safeHlsPlaylistUrl(href);
    return playlist ? out('hls', playlist) : out('invalid');
  }
  if (isTimestampedStill(href)) return out('timestamped');
  if (THUMB_PATH.test(url.pathname) || ALT_LABEL.test(label)) return out('alt');
  if (/\/map\/cctv\//i.test(url.pathname)) return out('still');
  if (PAGE_HINT.test(href) || PAGE_FILE.test(url.pathname)) return out('page');
  if (VIDEO_FILE.test(url.pathname)) return out('video');
  if (IMAGE_FILE.test(url.pathname)) return out('still');
  if (MJPEG_HINT.test(url.pathname + url.search) || /mjpe?g/i.test(label))
    return out('still');
  if (STILL_LABEL.test(label) || STILL_HINT.test(url.pathname + url.search))
    return out('still');
  return out('page');
}

const PLACEHOLDER_NAME =
  /^(?:english location|french location|unknown|n\/?a|none|null|undefined|-+)$/i;
const GENERIC_LABEL =
  /^(?:n\/?a|na|none|unknown|snapshot|jpe?g|image|still|stream|hls|camera|video|current image|public video|mjpe?g|-+)$/i;

/** The site's name: its location, else its road and direction, else the operator's number. */
export function siteName(row) {
  const location = clean(row.location);
  if (location && !PLACEHOLDER_NAME.test(location)) return location;
  const road = clean(row.roadway);
  const direction = clean(row.direction);
  if (road && !PLACEHOLDER_NAME.test(road))
    return direction && !/^(?:unknown|none)$/i.test(direction)
      ? `${road} ${direction}`
      : road;
  return `${clean(row.provider)} camera ${clean(row.sourceId)}`;
}

function viewName(base, label, index, count) {
  if (count <= 1) return base;
  if (
    !label ||
    GENERIC_LABEL.test(label) ||
    label.toLowerCase() === base.toLowerCase()
  )
    return index === 0 ? base : `${base} (view ${index + 1})`;
  if (label.length > 25 || label.toLowerCase().includes(base.toLowerCase()))
    return label;
  return `${base} (${label})`;
}

function viewHeading(label, row, count) {
  const fromLabel = headingFrom(String(label || '').replace(/^camera\s+/i, ''));
  if (fromLabel !== null) return fromLabel;
  return count === 1 ? headingFrom(clean(row.direction)) : null;
}

const slug = (text) =>
  String(text || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** The pack's provider key for an inventory provider: lower-case, dash-separated. */
export const providerKey = (provider) =>
  slug(provider).toLowerCase() || 'unknown';

/**
 * One row's cameras. Every distinct still is its own view (a pole looking
 * several ways, a preset, a direction image); a stream belongs to the still it
 * is listed beside, and a stream with no still is a stream-only camera.
 * Thumbnails and reference copies are not views.
 * @returns {{ cameras: object[], kinds: string[] }}
 */
export function rowToCameras(row) {
  let views = [];
  try {
    const parsed = JSON.parse(row.views_json || '[]');
    views = Array.isArray(parsed) ? parsed : [];
  } catch {
    views = [];
  }
  const links = views.map(classifyView);
  const unique = (kind) => {
    const seen = new Set();
    return links.filter(
      (link) =>
        link.kind === kind && !seen.has(link.href) && seen.add(link.href),
    );
  };
  // A thumbnail is the row's still when it has no other (VDOT publishes its
  // stills under /thumbs/), else another address of the one still.
  const alternates = unique('alt');
  const stills = unique('still').length ? unique('still') : alternates;
  const aliases =
    stills === alternates ? [] : alternates.map((link) => link.href);
  const streams = unique('hls');
  const pairs = [];
  if (
    stills.length === 1 ||
    (stills.length > 1 && stills.length === streams.length)
  ) {
    stills.forEach((still, i) =>
      pairs.push({
        still,
        stream: streams[stills.length === 1 ? 0 : i] || null,
      }),
    );
    if (stills.length === 1)
      for (const stream of streams.slice(1))
        pairs.push({ still: null, stream });
  } else {
    for (const still of stills) pairs.push({ still, stream: null });
    for (const stream of streams) pairs.push({ still: null, stream });
  }
  const base = siteName(row);
  const cameras = pairs.map(({ still, stream }, index) => {
    const label = (still || stream).label;
    const heading = viewHeading(label, row, pairs.length);
    return {
      name: viewName(base, label, index, pairs.length),
      feedType: still ? 'image' : 'none',
      ...(still ? { url: still.href } : {}),
      ...(stream ? { videoUrl: stream.href } : {}),
      ...(heading !== null
        ? { headingDeg: heading, headingConfidence: 'estimated' }
        : {}),
      // Only a one-camera row can say whose thumbnail is whose.
      ...(pairs.length === 1 && aliases.length ? { aliases } : {}),
      viewIndex: index,
      viewCount: pairs.length,
    };
  });
  return { cameras, kinds: links.map((link) => link.kind) };
}

/** Why a row with no camera has none, from what its links were. */
export function noFeedReason(kinds) {
  const has = (kind) => kinds.includes(kind);
  if (!kinds.length) return 'no link';
  if (has('signed')) return 'only an expiring signed link';
  if (has('timestamped'))
    return 'only a still whose address carries its capture time';
  if (has('embed')) return 'only a YouTube/Vimeo embed';
  if (has('video')) return 'only a video clip';
  if (has('page')) return 'only a web page or player';
  if (has('alt')) return 'only a thumbnail';
  return 'no usable link';
}

/** A camera on a school, by its name, the site's location, or its link. */
export function schoolCamera(row, camera) {
  return (
    isSchoolText(clean(row.location)) ||
    isSchoolCamera({
      id: camera.id,
      name: camera.name,
      url: camera.url || camera.videoUrl || '',
    })
  );
}

// ---------------------------------------------------------------------------
// Identity: what makes two entries the same camera.

const NAME_WORDS = Object.freeze({
  avenue: 'ave',
  av: 'ave',
  street: 'st',
  road: 'rd',
  drive: 'dr',
  boulevard: 'blvd',
  boul: 'blvd',
  parkway: 'pkwy',
  pky: 'pkwy',
  highway: 'hwy',
  expressway: 'expy',
  freeway: 'fwy',
  lane: 'ln',
  place: 'pl',
  court: 'ct',
  circle: 'cir',
  terrace: 'ter',
  crescent: 'cres',
  square: 'sq',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  northbound: 'nb',
  southbound: 'sb',
  eastbound: 'eb',
  westbound: 'wb',
  interstate: 'i',
  ih: 'i',
  mile: 'mi',
  route: 'rt',
  saint: 'st',
  mount: 'mt',
});
const NAME_STOP = new Set(['at', 'and', 'the', 'of', 'on', 'near', 'by']);

/** A camera name reduced to its words, with the usual road abbreviations. */
export function nameTokens(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .map((word) => NAME_WORDS[word] ?? word)
    .filter((word) => word && !NAME_STOP.has(word));
}

/** The name without a trailing view label in brackets: "X (Looking South)" is X. */
export const baseName = (text) =>
  String(text || '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .trim();

// Words that open a road or a mile marker, not an operator's camera code.
const NOT_A_CODE = new Set([
  'CAM',
  'CCTV',
  'CAMERA',
  'TV',
  'VIDEO',
  'LIVE',
  'MM',
  'MP',
  'EXIT',
  'SR',
  'US',
  'IH',
  'HWY',
  'RT',
  'CR',
  'FM',
  'KM',
]);

const code = (prefix, letters, digits, suffix) =>
  `${prefix.toUpperCase()}-${letters.toUpperCase()}${Number(digits)}${suffix.toUpperCase()}`;

/**
 * An operator code that opens a name, without its zero padding:
 * "FULT-0036: SR 70 at …" → FULT-36, "SAV-C067: SR 307 …" → SAV-C67.
 */
export function operatorCode(name) {
  const m = String(name || '')
    .trim()
    .match(/^([A-Z]{2,10})-([A-Z]{0,2})(\d{2,5})([A-Z]?)\s*[:\-–]/);
  return m && !NOT_A_CODE.has(m[1]) ? code(m[1], m[2], m[3], m[4]) : '';
}

/**
 * The same code where an operator names the camera in its stream or still
 * address, the whole name segment and nothing after it:
 * ".../FULT-CCTV-0036/playlist.m3u8" → FULT-36,
 * ".../alph-cam-002.stream/playlist.m3u8" → ALPH-2. A segment that goes on
 * (".../tus-cam-001-12.3.stream", a camera and its milepost) is no code.
 */
export function linkCode(href) {
  let pathname = '';
  try {
    pathname = new URL(href).pathname;
  } catch {
    return '';
  }
  const m = pathname.match(
    /\/([a-z]{2,10})-(?:cctv|cam)-([a-z]{0,2})(\d{2,5})([a-z]?)(?=\.stream(?:\/|$)|\/|$)/i,
  );
  return m && !NOT_A_CODE.has(m[1].toUpperCase())
    ? code(m[1], m[2], m[3], m[4])
    : '';
}

export const hostOf = (href) => {
  try {
    return new URL(href).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const feedKey = (href) => {
  const still = cctvStillKey(href);
  return still || canonicalHref(href);
};

/**
 * The addresses a pack entry is reached by. A site's "www." name is the same
 * site (www.511ny.org and 511ny.org serve the same still).
 */
export function feedKeysOf(entry) {
  const keys = new Set();
  const values = ['url', 'videoUrl', 'viewerUrl', 'snapshotUrl'].map(
    (field) => entry?.[field],
  );
  if (Array.isArray(entry?.aliases)) values.push(...entry.aliases);
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      const canonical = canonicalHref(value);
      keys.add(`feed:${feedKey(value)}`);
      keys.add(`feed:${canonical}`);
      keys.add(`feed:${canonical.replace(/^(https?:\/\/)www\./, '$1')}`);
    }
  }
  return [...keys];
}

/**
 * The operator's own camera number behind a pack id: Road511 keeps the
 * operator's id (`us511-MI-cam-1129`), DriveBC and Québec 511 entries carry
 * theirs (`bc-drivebc-2`, `qc511-4057`).
 */
export function packOperatorIds(entry) {
  const id = String(entry?.id || '');
  let m = id.match(/^us511-([A-Z]{2})-cam-(.+)$/);
  if (m) return [`opid:US-${m[1]}|${m[2].trim().toLowerCase()}`];
  m = id.match(/^bc-drivebc-(\d+)$/);
  if (m) return [`opid:drivebc|${m[1]}`];
  m = id.match(/^qc511-(\d+)$/);
  if (m) return [`opid:qc511|${m[1]}`];
  return [];
}

/** The same keys for an inventory row. */
export function rowOperatorIds(row, country, region) {
  const id = clean(row.sourceId).toLowerCase();
  if (!id) return [];
  const provider = providerKey(row.provider);
  const keys = [];
  if (country === 'US' && region) keys.push(`opid:US-${region}|${id}`);
  if (provider === 'drivebc') keys.push(`opid:drivebc|${id}`);
  if (provider.startsWith('quebec511')) keys.push(`opid:qc511|${id}`);
  return keys;
}

/** Name keys, strictest first: exact name in the region, base name on the host. */
export function nameKeysOf(entry, regionKey) {
  const keys = [];
  const words = nameTokens(entry.name);
  if (words.length >= 3 && regionKey)
    keys.push(`name:${regionKey}|${words.join(' ')}`);
  const codes = new Set(
    [
      operatorCode(entry.name),
      linkCode(entry.url),
      linkCode(entry.videoUrl),
    ].filter(Boolean),
  );
  if (regionKey)
    for (const code of codes) keys.push(`code:${regionKey}|${code}`);
  const host = hostOf(entry.url || entry.videoUrl || '');
  const base = nameTokens(baseName(entry.name));
  if (host && base.length >= 3) keys.push(`base:${host}|${base.join(' ')}`);
  return keys;
}

/**
 * Extra keys for a pack entry that has no still (a Road511 lookup camera):
 * its name with up to two leading words dropped, so "MN 36: T.H.36 WB @
 * Cleveland Ave" also answers to the operator's "T.H.36 WB @ Cleveland Ave"
 * and "IH-10 East @ San Jacinto" to "10 EAST @ SAN JACINTO".
 */
export function trimmedNameKeys(entry, regionKey) {
  const words = nameTokens(entry.name);
  const keys = [];
  for (let drop = 1; drop <= 2 && words.length - drop >= 3; drop++)
    keys.push(`name:${regionKey}|${words.slice(drop).join(' ')}`);
  return keys;
}

/** Same name in the same region is the same camera only within this distance. */
export const NAME_GUARD_KM = 1;
/** An operator number is checked against the point too, generously. */
export const OPID_GUARD_KM = 25;

export function distanceKm(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Two names that share most of their words; for checking an operator-number match. */
export function namesAgree(a, b) {
  const x = new Set(nameTokens(baseName(a)));
  const y = new Set(nameTokens(baseName(b)));
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.6;
}

/** A pack entry still waiting for a picture: no still of its own. */
export const lacksStill = (entry) =>
  !entry?.url && String(entry?.feedType || '') === 'none';
