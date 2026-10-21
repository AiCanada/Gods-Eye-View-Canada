/**
 * World tape feed: Mapillary coverage around each area, through the app's
 * own routes, which add the server's token, cache for 24 hours and
 * rate-limit:
 * - Sequences, from the coverage tiles the Street Level layer reads
 *   (/api/mapillary/tiles/coverage): each recorded once, its id, a
 *   representative image, capture time, panorama flag and extent.
 * - Images, from small-box metadata searches (/api/mapillary/images): each
 *   recorded once (`kind: 'image'`), its id, capture time, position,
 *   compass angle, sequence, panorama flag and camera type. Each area's box
 *   is walked in 0.05° grid cells, nearest first, at most
 *   IMAGE_SEARCHES_PER_AREA_DAY a day; a cell that comes back truncated is
 *   split in four (down to 0.0125°) and asked later in the walk. Pixels are
 *   never fetched: Mapillary's thumbnails are signed links on CDN hosts
 *   that vary from image to image.
 * Daily.
 */
import { decodeCoverageTile } from '../../../../src/layers/streetLevel/providers/mapillary/decode.js';
import { tilesForBbox } from '../../../../src/layers/streetLevel/tileMath.js';
import {
  DAY,
  bboxArray,
  boxAround,
  discard,
  finite,
  haversineKm,
  requireAreas,
  round,
  text,
} from './_util.mjs';

const DEFAULT_RADIUS_KM = 10;
const MAX_RADIUS_KM = 25;
/** Sequence tiles: z12, or z11 when an area would need more than this many. */
const MAX_TILES = 25;
/**
 * Image searches per area per rolling day. 32 walks the default 10 km box
 * (16 to 32 cells from the equator to 60°) in a day; a 25 km box or split
 * cells carry on over the next days. Eight areas make at most 256 searches
 * a day: a sliver of Mapillary's 10,000 a minute, inside the route's own
 * per-IP limit even all at once, and a poll of minutes.
 */
export const IMAGE_SEARCHES_PER_AREA_DAY = 32;
/** Cell edges are whole multiples of 1/80° (0.0125°, the smallest split). */
const UNITS_PER_DEG = 80;
/** 0.05°: the largest box /api/mapillary/images takes. */
const CELL_UNITS = 4;
/** Image ids remembered (the oldest are forgotten first). */
const MAX_IMAGE_IDS = 500_000;

function extent(parts) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let points = 0;
  for (const part of parts)
    for (const [lon, lat] of part) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      points += 1;
    }
  return points ? { west, south, east, north, points } : null;
}

/** The box an area records: its radius (10 km unless set, 25 km at most). */
function areaBox(area) {
  return boxAround(
    area,
    Math.min(MAX_RADIUS_KM, area.radiusKm ?? DEFAULT_RADIUS_KM),
  );
}

/** The 0.05° grid cells a box touches, nearest the area first. */
function imageCells(box, area) {
  const cells = [];
  const left = Math.floor((box.west * UNITS_PER_DEG) / CELL_UNITS);
  const bottom = Math.floor((box.south * UNITS_PER_DEG) / CELL_UNITS);
  for (let x = left * CELL_UNITS; x < box.east * UNITS_PER_DEG; x += CELL_UNITS)
    for (
      let y = bottom * CELL_UNITS;
      y < box.north * UNITS_PER_DEG;
      y += CELL_UNITS
    )
      cells.push({ x, y, size: CELL_UNITS });
  const away = ({ x, y, size }) =>
    haversineKm(area, {
      lat: (y + size / 2) / UNITS_PER_DEG,
      lon: (x + size / 2) / UNITS_PER_DEG,
    });
  return cells
    .map((cell) => ({ cell, km: away(cell) }))
    .sort((a, b) => a.km - b.km)
    .map(({ cell }) => cell);
}

/** A cell's four quarters. */
function split({ x, y, size }) {
  const half = size / 2;
  return [
    { x, y, size: half },
    { x: x + half, y, size: half },
    { x, y: y + half, size: half },
    { x: x + half, y: y + half, size: half },
  ];
}

/** `west,south,east,north`; multiples of 1/80° print exactly. */
const cellBbox = ({ x, y, size }) =>
  [x, y, x + size, y + size].map((units) => units / UNITS_PER_DEG).join(',');

/**
 * An area's image walk: the cells left to ask and its budget for the
 * rolling day. A new radius walks its new box from the start; the budget
 * stays.
 */
function imageWalk(walks, area, box, t) {
  const sig = bboxArray(box).join(',');
  let walk = walks.get(area.key);
  if (!walk) {
    walk = { sig, cells: [], since: t, used: 0 };
    walks.set(area.key, walk);
  }
  if (walk.sig !== sig) Object.assign(walk, { sig, cells: [] });
  if (!(t - walk.since < DAY)) Object.assign(walk, { since: t, used: 0 });
  return walk;
}

/**
 * A route's refusal as an error, flagged `keyRejected` when Mapillary
 * refused the token; a missing token ends the poll.
 */
async function refusal(response, what) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    await discard(response);
  }
  if (payload?.keyRequired || payload?.error === 'no_key')
    throw new Error('NO MAPILLARY TOKEN');
  if (payload?.keyRejected)
    return Object.assign(new Error('MAPILLARY REJECTED THE TOKEN'), {
      keyRejected: true,
    });
  return new Error(payload?.error || `${what} HTTP ${response.status}`);
}

export default {
  id: 'street-level',
  label: 'Street-level imagery coverage (Mapillary)',
  layers: ['street-level'],
  kind: 'feed',
  class: 'open',
  licence:
    'Mapillary contributors, CC BY-SA 4.0 (share-alike: a database derived from it stays CC BY-SA 4.0)',
  cadenceMs: DAY,
  phase: 2,
  // Sequences, plus up to 32 searches an area of up to 2,000 images (about
  // 30 bytes an image gzipped); an image already recorded is not again.
  bytesPerDay: 4e6,
  async poll({ fetch, areas, state, now, signal }) {
    const list = requireAreas(areas, { max: 8 });
    if (typeof fetch !== 'function')
      throw new Error('Street level needs the app API');
    state.seen ??= new Map(); // sequence id → ms first recorded
    state.images ??= new Set(); // image ids recorded
    state.imageWalks ??= new Map(); // area key → image walk
    const t = now();
    const records = [];
    // Ids and walks are kept once the poll runs through, so one cut short
    // asks again rather than losing what it found.
    const newSequences = new Set();
    const newImages = new Set();
    const walks = [];
    let answered = 0;
    let failure = null;
    let limited = false;
    for (const area of list) {
      if (limited) break;
      const box = areaBox(area);
      const corners = [box.west, box.south, box.east, box.north];
      let tiles = tilesForBbox(corners, 12);
      if (tiles.length > MAX_TILES)
        tiles = tilesForBbox(corners, 11, { limit: MAX_TILES });
      for (const tile of tiles) {
        const response = await fetch(
          `/api/mapillary/tiles/coverage/${tile.z}/${tile.x}/${tile.y}`,
          { signal },
        );
        if (response.status === 204) {
          answered += 1;
          continue;
        }
        if (!response.ok) {
          const error = await refusal(response, 'Mapillary tile');
          if (error.keyRejected) throw error;
          failure ??= error;
          // Rate limited: the rest waits for the next poll.
          if (response.status === 429) {
            limited = true;
            break;
          }
          continue;
        }
        answered += 1;
        const decoded = decodeCoverageTile(
          new Uint8Array(await response.arrayBuffer()),
          tile,
        );
        for (const sequence of decoded.sequences) {
          if (state.seen.has(sequence.id) || newSequences.has(sequence.id))
            continue;
          const box2 = extent(sequence.parts);
          if (!box2) continue;
          // Sequences reaching into the area's box only.
          if (
            box2.east < box.west ||
            box2.west > box.east ||
            box2.north < box.south ||
            box2.south > box.north
          )
            continue;
          newSequences.add(sequence.id);
          const first = sequence.parts[0][0];
          const lastPart = sequence.parts.at(-1);
          const last = lastPart.at(-1);
          records.push({
            area: area.name,
            sequence: sequence.id,
            image: sequence.imageId,
            capturedAt: sequence.capturedAt || null,
            pano: sequence.isPano,
            onFoot: sequence.onFoot,
            quality: sequence.quality,
            bbox: bboxArray(box2),
            start: [round(first[0], 6), round(first[1], 6)],
            end: [round(last[0], 6), round(last[1], 6)],
            points: box2.points,
          });
        }
      }
    }

    // Image metadata: each area's walk, within its budget for the day.
    const keys = new Set(list.map((area) => area.key));
    for (const key of state.imageWalks.keys())
      if (!keys.has(key)) state.imageWalks.delete(key);
    let imagesLimited = false;
    for (const area of list) {
      if (imagesLimited) break;
      const box = areaBox(area);
      const walk = imageWalk(state.imageWalks, area, box, t);
      // A finished walk starts again on the next poll, never the same one.
      const cells = walk.cells.length ? [...walk.cells] : imageCells(box, area);
      walks.push([walk, cells]);
      while (walk.used < IMAGE_SEARCHES_PER_AREA_DAY && cells.length) {
        const cell = cells.shift();
        walk.used += 1;
        const response = await fetch(
          `/api/mapillary/images?bbox=${cellBbox(cell)}`,
          { signal },
        );
        if (!response.ok) {
          const error = await refusal(response, 'Mapillary images');
          failure ??= error;
          // Rate limited, busy, or the token refused for searches (the
          // tiles took it): this cell and the rest wait; sequences still count.
          if (
            error.keyRejected ||
            response.status === 429 ||
            response.status === 503
          ) {
            cells.unshift(cell);
            imagesLimited = true;
            break;
          }
          continue;
        }
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          failure ??= new Error('Mapillary images: unreadable answer');
          continue;
        }
        answered += 1;
        if (payload?.truncated === true && cell.size > 1)
          cells.push(...split(cell));
        const images = Array.isArray(payload?.images) ? payload.images : [];
        for (const image of images) {
          const id = text(image?.id, 64);
          const lat = finite(image?.lat);
          const lon = finite(image?.lon);
          if (!id || lat === null || lon === null) continue;
          if (state.images.has(id) || newImages.has(id)) continue;
          // Images inside the area's box only.
          if (
            lon < box.west ||
            lon > box.east ||
            lat < box.south ||
            lat > box.north
          )
            continue;
          newImages.add(id);
          records.push({
            kind: 'image',
            id,
            capturedAt: finite(image.capturedAt),
            lat: round(lat, 6),
            lon: round(lon, 6),
            compass: round(image.compass, 2),
            sequence: text(image.sequence, 64),
            isPano: image.isPano === true,
            cameraType: text(image.cameraType, 32),
            area: area.name,
          });
        }
      }
    }
    limited ||= imagesLimited;
    for (const [walk, cells] of walks) walk.cells = cells;
    for (const id of newSequences) state.seen.set(id, t);
    for (const id of newImages) state.images.add(id);
    while (state.seen.size > 500_000)
      state.seen.delete(state.seen.keys().next().value);
    while (state.images.size > MAX_IMAGE_IDS)
      state.images.delete(state.images.values().next().value);
    // Nothing yet, or rate limited before anything new: the recorder's error
    // backoff asks again within half an hour rather than in a day.
    if ((!answered || (limited && !records.length)) && failure) throw failure;
    return { records };
  },
};
