// Pure helpers for the international camera pack. They turn the webcam listing
// TSV into entries for config/cctv_sources.intl.json. Nothing here touches
// files or the network; build-intl.mjs reads the TSV and writes the pack and
// its report.
//
// Every camera is kept, switched off or not. A row with no still image is
// still a camera (`feedType: 'none'`); there is no on-demand lookup. YouTube
// and Vimeo embeds are dropped: those addresses rot. Windy lists many of the
// same webcams twice, so one row is kept per Windy webcam id.
import { isSchoolCamera, isSchoolText, hasSchoolWord } from './school-cams.mjs';
import { providerFor } from './intl-providers.mjs';
import {
  VIEW_DIRECTIONS,
  cameraCity,
  cameraIdOf,
  cameraName,
  classifyLink,
  densestCircles,
  expandPack,
  formatPack,
  headingFromDirection,
  rowLinks,
} from './road511-tsv.mjs';

export { densestCircles, expandPack, formatPack };
export const ID_PREFIX = 'intl-';

/** Fields every international camera shares; country is per camera. */
export const PACK_DEFAULTS = Object.freeze({
  sourceKind: 'configured',
  pitchDeg: -6,
  fovDeg: 70,
  rangeM: 500,
  mountHeightM: 10,
  headingConfidence: 'unknown',
});

export const REQUIRED_COLUMNS = Object.freeze([
  'state_id',
  'state_name',
  'camera_id',
  'camera_name',
  'latitude',
  'longitude',
  'source',
]);

const DIRECTION_WORDS = {
  N: 'North',
  S: 'South',
  E: 'East',
  W: 'West',
  NE: 'Northeast',
  NW: 'Northwest',
  SE: 'Southeast',
  SW: 'Southwest',
};

const WINDY_STILL = /^https?:\/\/imgproxy\.windy\.com\/_\/[^/?#]+\/plain\/current\/(\d+)\//i;
const WINDY_CAM_ID = /^WINDY-cam-(\d+)$/i;
const WINDY_SOURCE_RANK = {
  Windy: 0,
  'Windy-public-list': 1,
  'Windy/weather': 2,
  'Windy/ski': 3,
  'Windy/harbor': 4,
};
const UNCLASSIFIED = new Set(['', 'XX', '??', 'INT']);
const EMBED_HOST = /(^|\.)(?:youtube\.com|youtu\.be|ytimg\.com|vimeo\.com)$/i;
const TIMESTAMPED_STILL =
  /\/20\d{2}\/\d{2}\/|\/20\d{12}\/|\/\d{4}\/\d{2}\/\d{2}\/.*\/\d{2}-\d{2}\.(?:jpg|jpeg|png)$/i;
const ROAD_CONNECTOR = /(?<![\p{L}])(?:at|and|of|near)(?![\p{L}])|[@&]/iu;

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
const toCoord = (value) => {
  const text = clean(value);
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

/**
 * Rows keyed by header name, so a re-ordered export still reads. Strips a BOM
 * and the \r of CRLF line ends, and trims every cell.
 */
export function parseTsv(text) {
  const lines = stripBom(String(text ?? ''))
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));
  const columns = (lines.shift() || '').split('\t').map((name) => name.trim());
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.includes(name));
  if (missing.length) throw new Error(`International TSV is missing column(s): ${missing.join(', ')}`);
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
 * Identical rows drop silently. A second row that reuses an id with different
 * content is a conflict: the first one is kept and the rest are reported.
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

/**
 * ISO country from the listing's state_id. Subdivisions ("AU-NSW", "GB-ENG")
 * become country + region. XX / ?? / INT are unclassified (no country).
 */
export function countryOf(stateId) {
  const raw = String(stateId || '')
    .trim()
    .toUpperCase();
  if (UNCLASSIFIED.has(raw)) return { country: '', region: '' };
  const match = raw.match(/^([A-Z]{2})(?:-([A-Z0-9]{1,8}))?$/);
  if (!match || match[1] === 'XX') return { country: '', region: '' };
  return { country: match[1], region: match[2] || '' };
}

/** Windy webcam id from the still URL, else from WINDY-cam-<id>. */
export function windyWebcamId(row) {
  const still = classifyLink(row?.primary_url);
  const fromUrl = still?.href && WINDY_STILL.exec(still.href);
  if (fromUrl) return fromUrl[1];
  const fromId = WINDY_CAM_ID.exec(cameraIdOf(row));
  return fromId ? fromId[1] : '';
}

function windyScore(row) {
  const { country } = countryOf(row.state_id);
  const lat = toCoord(row.latitude);
  const lon = toCoord(row.longitude);
  const coords =
    lat !== null &&
    lon !== null &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0);
  const rank = WINDY_SOURCE_RANK[clean(row.source)] ?? 9;
  return [country ? 1 : 0, coords ? 1 : 0, -rank];
}

function betterWindy(a, b) {
  const sa = windyScore(a);
  const sb = windyScore(b);
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return sa[i] > sb[i] ? a : b;
  }
  return a;
}

/**
 * One camera per Windy webcam id. Prefer a classified country, then real
 * coordinates, then Windy's own list over the public/weather/ski/harbour copies.
 */
export function collapseWindyRows(rows) {
  const groups = new Map();
  const passthrough = [];
  for (const row of rows) {
    const id = windyWebcamId(row);
    if (!id) {
      passthrough.push(row);
      continue;
    }
    const list = groups.get(id);
    if (list) list.push(row);
    else groups.set(id, [row]);
  }
  const kept = [...passthrough];
  const collapsed = [];
  for (const [id, list] of groups) {
    if (list.length === 1) {
      kept.push(list[0]);
      continue;
    }
    const winner = list.reduce(betterWindy);
    kept.push(winner);
    for (const dropped of list) {
      if (dropped !== winner) collapsed.push({ id, kept: winner, dropped });
    }
  }
  return { rows: kept, collapsed };
}

/**
 * Rejects missing, out-of-range and 0,0 points. Longitudes are not flipped:
 * east of Greenwich is real here.
 */
export function fixCoordinates(rows) {
  const kept = [];
  const rejects = [];
  for (const row of rows) {
    const lat = toCoord(row.latitude);
    const lon = toCoord(row.longitude);
    const { country } = countryOf(row.state_id);
    const reject = (reason) =>
      rejects.push({
        id: cameraIdOf(row),
        country,
        lat,
        lon,
        name: clean(row.camera_name),
        reason,
      });
    if (lat === null || lon === null) {
      reject('no coordinates');
      continue;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      reject('out of range');
      continue;
    }
    if (lat === 0 && lon === 0) {
      reject('null island');
      continue;
    }
    kept.push({ ...row, lat, lon });
  }
  return { rows: kept, rejects };
}

/** Compass label or a numeric degree; anything else is unknown. */
export function packHeading(direction) {
  const compass = headingFromDirection(direction);
  if (compass.headingDeg !== null) return compass;
  const text = clean(direction);
  if (!text) return compass;
  const n = Number(text);
  if (!Number.isFinite(n)) return compass;
  const wrapped = ((n % 360) + 360) % 360;
  return { headingDeg: Math.round(wrapped * 10) / 10, headingConfidence: 'estimated' };
}

export function isDroppedEmbed(link) {
  return Boolean(link?.host && EMBED_HOST.test(link.host));
}

export function isTimestampedStill(href) {
  return Boolean(href && TIMESTAMPED_STILL.test(href));
}

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

export function schoolKeptFields(row) {
  return ['camera_name', 'location', 'camera_details', 'road'].filter((field) => hasSchoolWord(row[field]));
}

const headingFields = ({ headingDeg }) =>
  headingDeg === null ? {} : { headingDeg, headingConfidence: 'estimated' };

function stillOf(links) {
  const primary = links.primary?.kind === 'still' && !isDroppedEmbed(links.primary) && !isTimestampedStill(links.primary.href)
    ? links.primary
    : null;
  const view = links.views.find((item) => !isDroppedEmbed(item.link) && !isTimestampedStill(item.link.href));
  return primary || view?.link || null;
}

function streamOf(links) {
  const fromVideo = ['still', 'video', 'page'].includes(links.video?.kind) ? links.video : null;
  const fromPrimary = links.primary?.kind === 'video' ? links.primary : null;
  const stream = fromVideo || fromPrimary;
  if (!stream || isDroppedEmbed(stream)) return null;
  return stream;
}

/**
 * One pack camera per row, or one per view when a row lists two or more
 * distinct view stills. A YouTube/Vimeo-only row is skipped (empty array).
 */
export function rowToEntries(row) {
  const id = `${ID_PREFIX}${cameraIdOf(row)}`;
  const name = cameraName(row);
  const lat = Number.isFinite(row.lat) ? row.lat : toCoord(row.latitude);
  const lon = Number.isFinite(row.lon) ? row.lon : toCoord(row.longitude);
  const { country, region } = countryOf(row.state_id);
  const place = {
    city: cameraCity(row),
    ...(region ? { region } : {}),
    ...(country ? { country } : {}),
    lat: round6(lat),
    lon: round6(lon),
  };
  const links = rowLinks(row);
  const p = providerFor(row.source).key;
  const usableViews = links.views.filter((item) => !isDroppedEmbed(item.link) && !isTimestampedStill(item.link.href));

  if (usableViews.length >= 2) {
    return usableViews.map(({ dir, link }) => ({
      id: `${id}-${dir}`,
      name: `${name} (${DIRECTION_WORDS[dir]} view)`,
      ...place,
      p,
      feedType: 'image',
      url: link.href,
      ...headingFields(packHeading(dir)),
    }));
  }

  const still = stillOf({ ...links, views: usableViews });
  let heading = packHeading(row.direction);
  if (heading.headingDeg === null && usableViews[0] && (!still || still.href === usableViews[0].link.href)) {
    heading = packHeading(usableViews[0].dir);
  }
  if (still) {
    return [{ id, name, ...place, p, feedType: 'image', url: still.href, ...headingFields(heading) }];
  }

  const stream = streamOf(links);
  const embedOnly =
    isDroppedEmbed(links.primary) || isDroppedEmbed(links.video);
  if (embedOnly && !stream) return [];
  return [
    {
      id,
      name,
      ...place,
      p,
      feedType: 'none',
      ...headingFields(heading),
      ...(stream ? { videoUrl: stream.href } : {}),
    },
  ];
}
