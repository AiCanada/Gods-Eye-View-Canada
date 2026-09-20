// Pure helpers for the Canadian webcam listing (canada_webcams.tsv): the same
// 24-column Road511 layout as the US and international listings, Canada only.
// No network and no file access here; build-canada-listing.mjs does both.
//
// The listing is the LOWEST-priority Canadian pack. Most of what it lists the
// pack already holds from the provinces' own camera lists (Ontario 511, DriveBC,
// Alberta 511, Québec 511), and merge-pack.mjs drops those copies by id, by
// address and by position. What survives is what was not acquired yet: the
// city systems (Vancouver, Surrey, Ottawa, York Region, Toronto, Calgary,
// Edmonton, Kamloops, Langley), harbours, ferries, ski hills and resorts.
import {
  VIEW_DIRECTIONS,
  cameraIdOf,
  cameraName,
  classifyLink,
  headingFromDirection,
  rowLinks,
  schoolHit,
} from './road511-tsv.mjs';
import { isDroppedEmbed, isTimestampedStill } from './intl-tsv.mjs';

export const ID_PREFIX = 'calist-';

/** Province or territory code -> the pack's cityId and its name for an address. */
export const PROVINCES = Object.freeze({
  AB: { cityId: 'ab', name: 'Alberta' },
  BC: { cityId: 'bc', name: 'British Columbia' },
  MB: { cityId: 'mb', name: 'Manitoba' },
  NB: { cityId: 'nb', name: 'New Brunswick' },
  NL: { cityId: 'nl', name: 'Newfoundland and Labrador' },
  NS: { cityId: 'ns', name: 'Nova Scotia' },
  NT: { cityId: 'nt', name: 'Northwest Territories' },
  NU: { cityId: 'nu', name: 'Nunavut' },
  ON: { cityId: 'on', name: 'Ontario' },
  PE: { cityId: 'pei', name: 'Prince Edward Island' },
  QC: { cityId: 'qc', name: 'Quebec' },
  SK: { cityId: 'sk', name: 'Saskatchewan' },
  YT: { cityId: 'yt', name: 'Yukon' },
});

/** Pose defaults, as the provinces' own packs use for a roadside camera. */
export const POSE_DEFAULTS = Object.freeze({
  pitchDeg: -6,
  fovDeg: 70,
  rangeM: 500,
  mountHeightM: 10,
  groundElevationM: 10,
});

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** "CA-ON" -> "ON", or '' for anything that is not a Canadian subdivision. */
export function provinceOf(row) {
  const match = clean(row?.state_id).toUpperCase().match(/^CA-([A-Z]{2})$/);
  return match && Object.hasOwn(PROVINCES, match[1]) ? match[1] : '';
}

/**
 * Cameras that are not the public's to watch, by what the listing says of
 * them. These are devices somebody left reachable, found by scanning address
 * space (the listing's notes name a directory of unsecured cameras), with no
 * operator page that publishes them: advertising-billboard monitors. A marina,
 * a heliport or a ski club that embeds its own camera on its own site is a
 * published webcam and stays.
 */
const UNPUBLISHED_DEVICE = /\bbillboard\b|\bDOOH\b/i;

/** Why a row is left out before it is placed, or '' to keep it. */
export function excludedReason(row) {
  if (!provinceOf(row)) return 'not a Canadian province or territory';
  if (!cameraIdOf(row)) return 'no camera id';
  if (schoolHit(row)) return 'school, university, college or library camera';
  if (UNPUBLISHED_DEVICE.test(`${clean(row.camera_name)} ${clean(row.source)}`)) {
    return 'unpublished device (billboard monitor), not an operator webcam';
  }
  return '';
}

/** A plain .m3u8 on a public https host: the only stream the server will carry. */
export function playableStream(link) {
  if (!link || link.kind !== 'video') return '';
  if (!/^https:\/\//i.test(link.href)) return '';
  return /\.m3u8(?:$|\?)/i.test(link.href) ? link.href : '';
}

/** A still the pack may store: never an embed, never a frame with its capture time baked in. */
function usableStill(link) {
  return link?.kind === 'still' && !isDroppedEmbed(link) && !isTimestampedStill(link.href) ? link : null;
}

/**
 * What a row offers to watch: one still per distinct view when it lists two or
 * more, else its one still, else its HLS stream, else nothing.
 * @returns {{kind: 'views', views: Array<{dir: string, href: string}>} | {kind: 'still', href: string, dir: string|null} | {kind: 'stream', href: string} | {kind: 'none'}}
 */
export function rowMedia(row) {
  const links = rowLinks(row);
  const views = links.views.filter((view) => usableStill(view.link)).map((view) => ({ dir: view.dir, href: view.link.href }));
  if (views.length >= 2) return { kind: 'views', views };
  const primary = usableStill(links.primary);
  if (primary) return { kind: 'still', href: primary.href, dir: views[0]?.href === primary.href ? views[0].dir : null };
  if (views.length === 1) return { kind: 'still', href: views[0].href, dir: views[0].dir };
  const stream = playableStream(links.video) || playableStream(links.primary);
  if (stream) return { kind: 'stream', href: stream };
  return { kind: 'none' };
}

const toCoord = (value) => {
  const text = clean(value);
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

/** The row's own point, or null when it has none (a missing value, or 0,0). */
export function rowPoint(row) {
  const lat = toCoord(row?.latitude);
  const lon = toCoord(row?.longitude);
  if (lat === null || lon === null || (lat === 0 && lon === 0)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** "City of Vancouver" -> Vancouver; a source that names no town -> ''. */
export function sourceTown(source) {
  const text = clean(source);
  const match =
    text.match(/^(?:City|Town|Township|District|Municipality|Ville) (?:of|de) ([\p{L}.' -]+?)(?: Traffic.*| TMC| Webcams?| Cameras?)?$/iu) ||
    text.match(/^Ontario 511 \/ (?:City of )?([\p{L}.' -]+)$/iu) ||
    text.match(/^Ozolio \/ City of ([\p{L}.' -]+)$/iu);
  if (match) return clean(match[1]);
  if (/^York Region\b/i.test(text)) return 'York Region';
  return '';
}

/**
 * The town a row belongs to: the one its source names, else the one its
 * details name ("Castanet Kelowna-area scenic webcam"). A camera the listing
 * gives no address for at all ("Ottawa Traffic Camera 379") is still known to
 * be in this town, and is placed at its centre for its owner to move.
 */
export function rowTown(row) {
  const fromSource = sourceTown(row?.source);
  if (fromSource) return fromSource;
  // One word: "Castanet Kelowna-area" is Kelowna, not "Castanet Kelowna".
  const area = clean(row?.camera_details).match(/(?:^|\s)([\p{Lu}][\p{L}.']+)-area\b/u);
  return area ? area[1] : '';
}

/** Names that are a serial number, not a place: nothing to look an address up from. */
const PLACELESS_NAME = /^(?:[\p{L}. ]+ )?(?:511 )?(?:traffic )?camera \d+$|\bloc\d+(?:--\d+)?$|\bCctv\/\d+$/iu;

const VIEW_SUFFIX = /\s+-\s+(?:North|South|East|West|Northeast|Northwest|Southeast|Southwest)$/i;
const COMPASS_WORD = /^(?:North|South|East|West)$/i;

const ordinal = (value) => {
  const n = Number(value);
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
};

/**
 * The junction behind one of Vancouver's camera file names, or ''. The city
 * names a view by its two streets run together: "Beatty Robson" is Beatty at
 * Robson, "Cambie02East" Cambie at 2nd Avenue, "Oak70" Oak at 70th, "Granville
 * Robson South" the pole on the south side of Granville at Robson.
 */
export function vancouverJunction(cameraName) {
  const text = clean(cameraName)
    .replace(VIEW_SUFFIX, '')
    .replace(/\bSWMarine\b/i, 'SW Marine Drive')
    .replace(/\bGrt Northern\b/i, 'Great Northern Way');
  const numbered = text.match(/^([A-Za-z]+?)\s?(\d{1,2})(?:st|nd|rd|th)?\s?(?:North|South|East|West|[NSEW])?$/);
  if (numbered) return `${numbered[1]} Street & ${ordinal(numbered[2])} Avenue`;
  if (/\b(?:Bridge|Greenway|Viaduct|Tunnel)\b/i.test(text)) return '';
  const words = text.split(/\s+/);
  if (words.length >= 3 && COMPASS_WORD.test(words.at(-1))) words.pop();
  if (words.length === 2) return `${words[0]} & ${words[1]}`;
  if (words.length >= 3 && words.length <= 4 && /^(?:SW|SE|NW|NE|E|W|N|S)$/i.test(words[1])) return `${words[0]} & ${words.slice(1).join(" ")}`;
  return '';
}

/**
 * Newfoundland and Labrador's highway cameras are listed by their file names,
 * which run a place name together. The place names they stand for:
 */
const SQUASHED_PLACE_NAMES = Object.freeze({
  bayroberts: 'Bay Roberts',
  birchynarrows: 'Birchy Narrows',
  flowerscove: "Flower's Cove",
  grandfallswindsor: 'Grand Falls-Windsor',
  harbourbreton: 'Harbour Breton',
  paddyspond: "Paddy's Pond",
  portauport: 'Port au Port',
  portauxbasques: 'Port aux Basques',
  pynnsbrook: "Pynn's Brook",
  rangerlake: 'Ranger Lake',
  saltpond: 'Salt Pond',
});

/** A name as an address: no view direction, no province tag, "Town (Road)" as "Road, Town". */
function addressText(value) {
  const squashed = SQUASHED_PLACE_NAMES[clean(value).toLowerCase()];
  if (squashed) return squashed;
  const text = clean(value)
    .replace(/^"+|"+$/g, '')
    .replace(VIEW_SUFFIX, '')
    .replace(/\s+(?:facing|looking)\s+[A-Za-z-]+$/i, '')
    .replace(/\s+BC$/, '');
  const bracketed = text.match(/^(.+?)\s*\(([^()]+)\)$/);
  return bracketed ? `${bracketed[2].replace(/.$/, '')}, ${bracketed[1]}` : text;
}

/**
 * The addresses to try for a row with no point, most specific first. A row
 * with nothing but a serial number yields none, and is reported rather than
 * dropped onto a city centre it may be nowhere near.
 * @returns {string[]}
 */
export function addressQueries(row) {
  const province = PROVINCES[provinceOf(row)]?.name;
  if (!province) return [];
  const name = addressText(row.camera_name);
  const location = addressText(row.location);
  const named = (text) => Boolean(text) && !PLACELESS_NAME.test(text) && !/\bcam(?:era)? [A-Z]{0,4}-?\d+$/i.test(text);
  if (!named(name) && !named(location)) return [];
  const town = sourceTown(row.source);
  const tail = [town, province, 'Canada'].filter(Boolean).join(', ');
  const queries = [];
  const add = (text) => {
    const query = clean(text);
    if (query && !queries.includes(query)) queries.push(query);
  };
  if (/^City of Vancouver$/i.test(clean(row.source))) {
    const junction = vancouverJunction(row.camera_name);
    if (junction) add(`${junction}, ${tail}`);
  }
  if (named(location)) add(`${location}, ${tail}`);
  if (named(name)) add(`${name}, ${tail}`);
  // A description ("View over the Saint John River in Fredericton") still names its town.
  const inTown = location.match(/\b(?:in|at|near|of)\s+([\p{Lu}][\p{L}.'-]+(?:\s+[\p{Lu}][\p{L}.'-]+){0,2})\s*$/u);
  if (inTown) add(`${inTown[1]}, ${province}, Canada`);
  const dashTown = clean(row.camera_name).match(/^([\p{Lu}][\p{L}.' -]+?)\s+-\s+Canada$/u);
  if (dashTown) add(`${dashTown[1]}, ${province}, Canada`);
  return queries;
}

/** How far from the town its source names a camera placed by address may be. */
export const TOWN_REACH_KM = 60;

/** Kilometres between two points. */
export function distanceKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Canada, generously bounded (the same box merge-pack.mjs applies). */
export const CANADA_BOUNDS = Object.freeze({ latMin: 41.5, latMax: 83.5, lonMin: -141.5, lonMax: -52.0 });
export const inCanada = (point) =>
  Boolean(point) &&
  point.lat >= CANADA_BOUNDS.latMin && point.lat <= CANADA_BOUNDS.latMax &&
  point.lon >= CANADA_BOUNDS.lonMin && point.lon <= CANADA_BOUNDS.lonMax;

const DIRECTION_WORDS = {
  N: 'North', S: 'South', E: 'East', W: 'West', NE: 'Northeast', NW: 'Northwest', SE: 'Southeast', SW: 'Southwest',
};

/**
 * Cameras placed by address share their address's point, and merge-pack.mjs
 * treats two cameras within 25 m as one. The Nth camera at a point steps off it
 * on a 40 m ring, so every camera survives and each can be dragged to its real
 * place later.
 */
export function spreadPoint(point, index) {
  if (!index) return { ...point };
  const ring = Math.ceil(index / 8);
  const angle = ((index - 1) % 8) * (Math.PI / 4);
  const metres = 40 * ring;
  const lat = point.lat + (metres * Math.cos(angle)) / 111_320;
  const lon = point.lon + (metres * Math.sin(angle)) / (111_320 * Math.cos((point.lat * Math.PI) / 180));
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

/**
 * The pack entries of one row at one point.
 * @param {object} row
 * @param {{lat: number, lon: number}} point
 * @param {{placedBy?: 'listing'|'address', address?: string}} [how]
 */
export function rowToEntries(row, point, { placedBy = 'listing', address = '' } = {}) {
  const media = rowMedia(row);
  if (media.kind === 'none') return [];
  const province = provinceOf(row);
  const source = clean(row.source) || 'Canadian webcam listing';
  const base = {
    city: sourceTown(row.source) || PROVINCES[province].name,
    cityId: PROVINCES[province].cityId,
    provider: source,
    sourceKind: 'configured',
    lat: point.lat,
    lon: point.lon,
    ...POSE_DEFAULTS,
    license: `Public camera published by ${source}`,
    coordConfidence: placedBy === 'address' ? 'estimated' : 'exact',
    // Placed from its address, not surveyed: the owner can drag it into place.
    ...(placedBy === 'address' ? { placedBy: 'address', placedAddress: address } : {}),
    country: 'CA',
  };
  const id = `${ID_PREFIX}${cameraIdOf(row)}`;
  const name = cameraName(row) || clean(row.camera_name) || id;
  if (media.kind === 'views') {
    return media.views.map(({ dir, href }) => ({
      id: `${id}-${dir}`,
      name: `${name} (${DIRECTION_WORDS[dir]} view)`,
      feedType: 'image',
      url: href,
      ...headingFromDirection(dir),
      ...base,
    }));
  }
  const heading = headingFromDirection(media.dir || row.direction);
  if (media.kind === 'still') return [{ id, name, feedType: 'image', url: media.href, ...heading, ...base }];
  // Stream only: no still to store, the HLS playlist kept as videoUrl. The
  // server serves such a camera as video, in every pack alike.
  return [{ id, name, feedType: 'none', url: '', videoUrl: media.href, ...heading, ...base }];
}

/**
 * One address per still, however a directory spells it. DriveBC serves camera
 * 786 at both www.drivebc.ca/images/786.jpg (its own list, the form the pack
 * holds) and images.drivebc.ca/bchighwaycam/pub/cameras/786.jpg (the listing).
 */
export function canonicalHref(href) {
  const text = String(href || '').trim().replace(/^http:/i, 'https:').replace(/\/+$/, '');
  const drivebc = text.match(/^https:\/\/images\.drivebc\.ca\/bchighwaycam\/pub\/cameras\/(\d+)\.jpg$/i);
  if (drivebc) return `https://www.drivebc.ca/images/${drivebc[1]}.jpg`;
  return text.toLowerCase();
}

/** The host a camera is served from, without "www.". */
export function hostOfHref(href) {
  try {
    return new URL(href).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The 511 traveller-information hosts: rate-limited re-listings of cameras a city also serves itself. */
const RELISTING_HOST = /^511[a-z]*\.ca$|^511\.[a-z.]+\.ca$|(?:^|\.)[a-z]*511\.ca$/i;

const metresBetween = (a, b) => {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLon = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
};

/**
 * The same camera reached through two hosts inside the listing itself: the
 * City of Toronto serves its cameras from its open-data site, and Ontario 511
 * lists them again. Within 25 m, a camera on a DIFFERENT host is a second copy
 * and is dropped; on the SAME host it is another view from the same pole and
 * stays. The operator's own host wins over a 511 re-listing.
 * @param {object[]} entries
 * @returns {{kept: object[], dropped: object[]}}
 */
export function dropCrossHostCopies(entries, radiusM = 25) {
  const ranked = entries
    .map((entry, index) => ({ entry, index, host: hostOfHref(entry.url || entry.videoUrl) }))
    .sort((a, b) => Number(RELISTING_HOST.test(a.host)) - Number(RELISTING_HOST.test(b.host)) || a.index - b.index);
  const cell = (value) => Math.floor(value / 0.001);
  const grid = new Map();
  const keptItems = [];
  const dropped = [];
  for (const item of ranked) {
    const { entry, host } = item;
    let copy = false;
    for (let dLat = -1; dLat <= 1 && !copy; dLat++) {
      for (let dLon = -1; dLon <= 1 && !copy; dLon++) {
        for (const other of grid.get(`${cell(entry.lat) + dLat},${cell(entry.lon) + dLon}`) || []) {
          if (other.host !== host && metresBetween(other.entry, entry) <= radiusM) { copy = true; break; }
        }
      }
    }
    if (copy) { dropped.push(entry); continue; }
    const key = `${cell(entry.lat)},${cell(entry.lon)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(item);
    keptItems.push(item);
  }
  return { kept: keptItems.sort((a, b) => a.index - b.index).map((item) => item.entry), dropped };
}

export { VIEW_DIRECTIONS, classifyLink };
