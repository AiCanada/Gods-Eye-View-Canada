import {
  coalesceProxyRequest,
  readResponseTextCapped,
} from '../common/http.js';
import { retryAfterMs } from './tiles.js';
import {
  MAPILLARY_GRAPH_HOST,
  IMAGES_FIELDS,
  IMAGES_MAX_SIDE_DEG,
  IMAGES_LIMIT,
  IMAGES_CACHE_TTL_MS,
  IMAGES_MEMORY_BUDGET_BYTES,
  IMAGES_MEMORY_ENTRY_OVERHEAD_BYTES,
  IMAGES_MAX_BYTES,
  IMAGES_FETCH_TIMEOUT_MS,
  IMAGES_UPSTREAM_CONCURRENCY,
  IMAGES_QUEUE_MAX,
  TILE_KEY_REJECTED_HOLD_MS,
  mapillaryToken,
} from './constants.js';

/** Thrown for a search this proxy refuses (or cannot take) before asking Mapillary. */
export class ImagesRequestError extends Error {
  constructor(message, status = 400, { retryAfterSec = null } = {}) {
    super(message);
    this.name = 'ImagesRequestError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/** Mapillary answered with an error or an unusable body; 401/403 set `keyRejected`. */
export class ImagesUpstreamError extends Error {
  constructor(status, message, { retryAfterSec = null } = {}) {
    super(message || `Mapillary image search HTTP ${status}`);
    this.name = 'ImagesUpstreamError';
    this.status = status;
    this.keyRejected = status === 401 || status === 403;
    this.retryAfterSec = retryAfterSec;
  }
}

/** A plain decimal degree: no exponent, hex, plus sign, blank or padding. */
const DEGREES = /^-?\d{1,3}(?:\.\d{1,12})?$/;
/** Float slack for a side of exactly IMAGES_MAX_SIDE_DEG. */
const SIDE_SLACK = 1e-9;

/**
 * Validate `bbox=west,south,east,north`: four plain decimals on the globe,
 * west < east and south < north, at most IMAGES_MAX_SIDE_DEG a side. Edges
 * are rounded to 1e-6° (about 0.1 m); the rounded box is the cache key.
 * @param {string|null|undefined} value The query value.
 * @returns {{west:number, south:number, east:number, north:number, key:string}}
 */
export function normalizeImagesBbox(value) {
  const text = typeof value === 'string' && value.length <= 80 ? value : '';
  const parts = text.split(',');
  if (parts.length !== 4 || !parts.every((part) => DEGREES.test(part)))
    throw new ImagesRequestError(
      'bbox must be west,south,east,north in decimal degrees',
    );
  // `+ 0` turns a rounded -0 into 0, so a key never reads "-0".
  const [west, south, east, north] = parts.map(
    (part) => Number(Number(part).toFixed(6)) + 0,
  );
  if (west < -180 || east > 180 || south < -90 || north > 90)
    throw new ImagesRequestError('bbox must lie within ±180° and ±90°');
  if (!(west < east && south < north))
    throw new ImagesRequestError('bbox needs west < east and south < north');
  if (
    east - west > IMAGES_MAX_SIDE_DEG + SIDE_SLACK ||
    north - south > IMAGES_MAX_SIDE_DEG + SIDE_SLACK
  )
    throw new ImagesRequestError(
      `bbox sides must be at most ${IMAGES_MAX_SIDE_DEG}°`,
    );
  return {
    west,
    south,
    east,
    north,
    key: [west, south, east, north].join(','),
  };
}

/** Image ids are digits and sequence ids letters and digits; nothing else passes. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CAMERA_TYPE = /^[a-z0-9_]{1,32}$/;

/** A number, or a numeric string read as one; anything else is NaN. */
function numberOf(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return NaN;
}

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** An id as a bounded string of safe characters, or null. */
function idOf(value) {
  const id =
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : value;
  return typeof id === 'string' && ID.test(id) ? id : null;
}

/** An angle as a bearing in [0, 360) to 0.01°, or null. */
function bearing(angle) {
  if (!Number.isFinite(angle)) return null;
  const turned = round(((angle % 360) + 360) % 360, 2);
  return turned === 360 ? 0 : turned;
}

/**
 * One image of a search, validated: finite numbers and bounded strings, or
 * null without a usable id and position. `compass` is the computed angle
 * when Mapillary has one, else the camera's own, in [0, 360).
 */
export function trimImage(row) {
  const id = idOf(row?.id);
  const [lon, lat] = Array.isArray(row?.geometry?.coordinates)
    ? row.geometry.coordinates
    : [];
  if (
    !id ||
    typeof lon !== 'number' ||
    typeof lat !== 'number' ||
    !(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)
  )
    return null;
  const capturedAt = numberOf(row.captured_at);
  const angle = [row.computed_compass_angle, row.compass_angle]
    .map(numberOf)
    .find(Number.isFinite);
  return {
    id,
    capturedAt:
      capturedAt > 0 && capturedAt <= 8.64e15 ? Math.round(capturedAt) : null,
    lat: round(lat, 7),
    lon: round(lon, 7),
    compass: bearing(angle),
    sequence: idOf(
      row.sequence && typeof row.sequence === 'object'
        ? row.sequence.id
        : row.sequence,
    ),
    isPano: row.is_pano === true,
    cameraType:
      typeof row.camera_type === 'string' && CAMERA_TYPE.test(row.camera_type)
        ? row.camera_type
        : null,
  };
}

/**
 * Mapillary's answer as `{ images, truncated }`: at most IMAGES_LIMIT
 * validated images, each id once. `truncated` says more matched than came
 * back (Mapillary pages a bbox search no further).
 */
export function readImagesAnswer(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data))
    throw new ImagesUpstreamError(
      502,
      'Mapillary answered without an image list',
    );
  const images = [];
  const ids = new Set();
  for (const row of payload.data.slice(0, IMAGES_LIMIT)) {
    const image = trimImage(row);
    if (!image || ids.has(image.id)) continue;
    ids.add(image.id);
    images.push(image);
  }
  return {
    images,
    truncated:
      payload.data.length >= IMAGES_LIMIT ||
      typeof payload.paging?.next === 'string',
  };
}

/**
 * A rejected token or rate limit that answers every search miss until it
 * expires (or the token changes). Cached answers are still served meanwhile.
 * @type {{status: number, until: number, token: string}|null}
 */
let _upstreamHold = null;

function heldRefusal(token) {
  const hold = _upstreamHold;
  if (!hold) return null;
  const left = hold.until - Date.now();
  if (left <= 0 || hold.token !== token) {
    _upstreamHold = null;
    return null;
  }
  return new ImagesUpstreamError(hold.status, undefined, {
    retryAfterSec: Math.ceil(left / 1000),
  });
}

/** @type {Map<string, {body: string, at: number}>} insertion-ordered LRU of answer JSON */
const _memory = new Map();
let _memoryBytes = 0;
const memoryCost = (body) => body.length + IMAGES_MEMORY_ENTRY_OVERHEAD_BYTES;
/** @type {Map<string, Promise<string>>} one upstream search per box at a time */
const _inFlight = new Map();

function memoryGet(key) {
  const hit = _memory.get(key);
  if (!hit) return null;
  _memory.delete(key);
  if (Date.now() - hit.at > IMAGES_CACHE_TTL_MS) {
    _memoryBytes -= memoryCost(hit.body);
    return null;
  }
  _memory.set(key, hit);
  return hit.body;
}

function memoryPut(key, body) {
  const existing = _memory.get(key);
  if (existing) {
    _memory.delete(key);
    _memoryBytes -= memoryCost(existing.body);
  }
  _memory.set(key, { body, at: Date.now() });
  _memoryBytes += memoryCost(body);
  while (_memoryBytes > IMAGES_MEMORY_BUDGET_BYTES && _memory.size) {
    const [oldest, entry] = _memory.entries().next().value;
    _memory.delete(oldest);
    _memoryBytes -= memoryCost(entry.body);
  }
}

/** @type {{active: number, queue: Array<() => void>}} upstream slots */
let _slots = { active: 0, queue: [] };

/** Resolve with a release function once a slot is free; a full queue is refused. */
function acquireSlot() {
  const slots = _slots;
  return new Promise((resolve, reject) => {
    const grant = () => {
      slots.active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        slots.active--;
        slots.queue.shift()?.();
      });
    };
    if (slots.active < IMAGES_UPSTREAM_CONCURRENCY) return grant();
    if (slots.queue.length >= IMAGES_QUEUE_MAX)
      return reject(
        new ImagesRequestError('Mapillary image search is busy', 503, {
          retryAfterSec: 5,
        }),
      );
    slots.queue.push(grant);
  });
}

/** Ask Mapillary for one box, holding a slot until the answer is read. */
async function searchUpstream(bbox, token) {
  const release = await acquireSlot();
  try {
    // A hold set while this search waited for its slot answers it too.
    const held = heldRefusal(token);
    if (held) throw held;
    const url = new URL('/images', MAPILLARY_GRAPH_HOST);
    url.searchParams.set('bbox', bbox.key);
    url.searchParams.set('fields', IMAGES_FIELDS);
    url.searchParams.set('limit', String(IMAGES_LIMIT));
    const timeout = AbortSignal.timeout(IMAGES_FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        // Never followed, so the header cannot be carried to another host.
        redirect: 'manual',
        signal: timeout,
        headers: {
          Accept: 'application/json',
          Authorization: `OAuth ${token}`,
        },
      });
    } catch (error) {
      if (timeout.aborted)
        throw new ImagesUpstreamError(504, 'Mapillary image search timed out');
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status >= 300 && response.status < 400)
        throw new ImagesUpstreamError(502, 'Mapillary image search redirected');
      const error = new ImagesUpstreamError(response.status);
      if (error.keyRejected)
        _upstreamHold = {
          status: response.status,
          until: Date.now() + TILE_KEY_REJECTED_HOLD_MS,
          token,
        };
      else if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get('retry-after'));
        _upstreamHold = { status: 429, until: Date.now() + wait, token };
        error.retryAfterSec = Math.ceil(wait / 1000);
      }
      throw error;
    }
    let text;
    try {
      text = await readResponseTextCapped(response, IMAGES_MAX_BYTES, timeout);
    } catch (error) {
      if (error?.code === 'RESPONSE_TOO_LARGE')
        throw new ImagesUpstreamError(
          502,
          'Mapillary image search exceeds size cap',
        );
      if (timeout.aborted)
        throw new ImagesUpstreamError(504, 'Mapillary image search timed out');
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ImagesUpstreamError(502, 'Mapillary answered malformed JSON');
    }
    const body = JSON.stringify(readImagesAnswer(payload));
    memoryPut(bbox.key, body);
    return body;
  } finally {
    release();
  }
}

/** Wait for `promise` until `signal` aborts; the work itself carries on. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Image metadata in a small box, from memory, a shared search, then
 * Mapillary. A caller that leaves stops waiting; the search still finishes
 * (within IMAGES_FETCH_TIMEOUT_MS) and is cached for the next ask.
 * @param {{key: string}} bbox From normalizeImagesBbox.
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{body: string, source: 'memory'|'inflight'|'upstream'}>}
 *   `body` is `{ images, truncated }` as JSON.
 */
export async function fetchImages(bbox, { signal } = {}) {
  const cached = memoryGet(bbox.key);
  if (cached) return { body: cached, source: 'memory' };
  const token = mapillaryToken();
  if (!token)
    throw new ImagesRequestError('Mapillary token not configured', 503);
  const held = heldRefusal(token);
  if (held) throw held;
  signal?.throwIfAborted();
  const { promise, shared } = coalesceProxyRequest(_inFlight, bbox.key, () =>
    searchUpstream(bbox, token),
  );
  // Every waiter may have left before it settles; nobody awaits it then.
  if (!shared) promise.catch(() => {});
  const body = await untilAborted(promise, signal);
  return { body, source: shared ? 'inflight' : 'upstream' };
}

/** Test seam: forget cached answers, shared searches, holds and slots. */
export function _resetImagesForTest() {
  _memory.clear();
  _memoryBytes = 0;
  _inFlight.clear();
  _upstreamHold = null;
  _slots = { active: 0, queue: [] };
}

/** Test seam: how many answers memory holds and the bytes charged for them. */
export function _imagesMemoryForTest() {
  return { entries: _memory.size, bytes: _memoryBytes };
}
