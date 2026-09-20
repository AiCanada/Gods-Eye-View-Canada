/**
 * Saved CCTV thumbnail alignments.
 *
 * The owner lines a camera's map thumbnail up with the map by hand (right-click
 * a thumbnail, move and turn it, right-click again). What they settled on is
 * kept in a tracked file, `config/cctv_thumbnail_alignments.json`, so it is part
 * of the checkout: the next run, and anyone who pulls the repository, gets the
 * same alignment.
 *
 * One entry per camera id: where the middle of the thumbnail's picture stands
 * (lat/lon) and which compass bearing "up the picture" points to. A null
 * bearing means upright.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CCTV_THUMBNAIL_ALIGNMENTS_FILE =
  'config/cctv_thumbnail_alignments.json';
export const CCTV_THUMBNAIL_ALIGNMENTS_FORMAT =
  'gev-cctv-thumbnail-alignments/1';
/** A saved spot may not wander farther than this from its camera. */
export const CCTV_THUMBNAIL_ALIGNMENT_MAX_KM = 5;
const MAX_ENTRIES = 20_000;
const CAMERA_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Whether a string can be a camera id in this file. */
export function isAlignmentCameraId(id) {
  return typeof id === 'string' && CAMERA_ID.test(id);
}

/**
 * Validate one alignment. Pure.
 * @param {unknown} raw
 * @returns {{lat: number, lon: number, bearingDeg: number|null}|null}
 */
export function normalizeThumbnailAlignment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  let bearingDeg = null;
  if (raw.bearingDeg !== null && raw.bearingDeg !== undefined) {
    const bearing = Number(raw.bearingDeg);
    if (!Number.isFinite(bearing)) return null;
    bearingDeg = Math.round((((bearing % 360) + 360) % 360) * 10) / 10;
  }
  return {
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    bearingDeg,
  };
}

/** Read a parsed file into a clean id -> alignment map. Pure. */
export function parseThumbnailAlignments(parsed) {
  const out = new Map();
  const entries =
    parsed &&
    typeof parsed === 'object' &&
    parsed.alignments &&
    typeof parsed.alignments === 'object'
      ? parsed.alignments
      : {};
  for (const [id, raw] of Object.entries(entries)) {
    if (out.size >= MAX_ENTRIES || !isAlignmentCameraId(id)) continue;
    const alignment = normalizeThumbnailAlignment(raw);
    if (alignment) out.set(id, alignment);
  }
  return out;
}

/** The file's text: ids sorted, one entry per line, so a saved alignment is a one-line diff. */
export function serializeThumbnailAlignments(map) {
  const ids = [...map.keys()].sort();
  const lines = ids.map(
    (id) => `    ${JSON.stringify(id)}: ${JSON.stringify(map.get(id))}`,
  );
  return `{\n  "format": ${JSON.stringify(CCTV_THUMBNAIL_ALIGNMENTS_FORMAT)},\n  "alignments": {${lines.length ? `\n${lines.join(',\n')}\n  ` : ''}}\n}\n`;
}

/**
 * The alignment file, read once and re-read when it changes on disk (a pull,
 * a hand edit). Writes replace the whole file through a temporary one.
 */
export function createThumbnailAlignmentStore({
  sourceRoot = process.cwd(),
} = {}) {
  const file = path.join(sourceRoot, CCTV_THUMBNAIL_ALIGNMENTS_FILE);
  let stamp = '';
  let map = new Map();
  const refresh = () => {
    let next = 'missing';
    try {
      const stat = fs.statSync(file);
      next = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      next = 'missing';
    }
    if (next === stamp) return;
    stamp = next;
    if (next === 'missing') {
      map = new Map();
      return;
    }
    try {
      map = parseThumbnailAlignments(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      console.warn(
        `[CCTV] ${CCTV_THUMBNAIL_ALIGNMENTS_FILE} could not be read (${error?.message || error}); saved thumbnail alignments are ignored until it is fixed.`,
      );
      map = new Map();
    }
  };
  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = serializeThumbnailAlignments(map);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, text);
      fs.renameSync(temporary, file);
    } catch {
      // A rename over an existing file can be refused on Windows; the file is
      // not a secret and not shared, so writing it in place is acceptable.
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        /* nothing to clean */
      }
      fs.writeFileSync(file, text);
    }
    stamp = '';
    refresh();
  };
  return {
    file,
    all() {
      refresh();
      return Object.fromEntries(map);
    },
    get(id) {
      refresh();
      return map.get(id) || null;
    },
    set(id, alignment) {
      refresh();
      if (!isAlignmentCameraId(id)) throw new TypeError('bad camera id');
      if (!map.has(id) && map.size >= MAX_ENTRIES)
        throw new RangeError('too many alignments');
      map.set(id, alignment);
      write();
      return alignment;
    },
    remove(id) {
      refresh();
      if (!map.delete(id)) return false;
      write();
      return true;
    },
  };
}
