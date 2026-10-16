/**
 * Helpers the world tape's feed adapters share: numbers, areas and boxes,
 * bounded "seen" maps for event feeds, file names, hashes, a small
 * concurrency limit, and the nowCOAST raster feed the three weather layers
 * are made from.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const KM_PER_DEGREE = 111.2;

/** A finite number (numeric strings too, as some feeds send them), else null. */
export function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** `value` rounded to `digits` decimals, or null when it is not a number. */
export function round(value, digits = 0) {
  const number = finite(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

/** A trimmed string, or null when empty. */
export function text(value, max = 200) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Great-circle distance between two `{ lat, lon }` points, in km. */
export function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The areas a poll covers (ctx.areas): finite points with a name, an optional
 * radius and a stable key. Malformed entries and repeats are left out.
 * @param {Array<{lat:number, lon:number, name?:string, radiusKm?:number}>} areas
 */
export function validAreas(areas, { max = 32 } = {}) {
  const list = [];
  const keys = new Set();
  for (const area of Array.isArray(areas) ? areas : []) {
    const lat = finite(area?.lat);
    const lon = finite(area?.lon);
    if (lat === null || lon === null || Math.abs(lat) > 90) continue;
    if (Math.abs(lon) > 180) continue;
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const radiusKm = finite(area?.radiusKm);
    list.push({
      lat,
      lon,
      name: text(area?.name, 80) || `${lat.toFixed(3)},${lon.toFixed(3)}`,
      radiusKm: radiusKm > 0 ? radiusKm : null,
      key,
    });
    if (list.length >= max) break;
  }
  return list;
}

/** The areas, or the error a feed that records only around areas reports. */
export function requireAreas(areas, options) {
  const list = validAreas(areas, options);
  if (!list.length) throw new Error('NO AREA SELECTED');
  return list;
}

/** A box `radiusKm` around a point, inside ±85° and ±180° (never across the antimeridian). */
export function boxAround({ lat, lon }, radiusKm) {
  const dLat = radiusKm / KM_PER_DEGREE;
  const dLon =
    radiusKm /
    (KM_PER_DEGREE * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return {
    west: Math.max(-180, lon - dLon),
    south: Math.max(-85, lat - dLat),
    east: Math.min(180, lon + dLon),
    north: Math.min(85, lat + dLat),
  };
}

/** `[west, south, east, north]`, rounded to 5 decimals. */
export const bboxArray = (box) =>
  [box.west, box.south, box.east, box.north].map((v) => round(v, 5));

/**
 * Event feeds: whether `key` is new or its signature changed since it was
 * last seen. Remembers it either way, most recently seen last, so forget()
 * drops the entries seen longest ago first.
 * @param {Map<string, {sig: string, at: number}>} seen
 */
export function noteChange(seen, key, sig, at) {
  const previous = seen.get(key);
  seen.delete(key);
  seen.set(key, { sig, at });
  return !previous || previous.sig !== sig;
}

/** Forget entries not seen for `maxAgeMs`, then the oldest beyond `max`. */
export function forget(seen, now, maxAgeMs, max = Infinity) {
  for (const [key, entry] of seen)
    if (now - entry.at > maxAgeMs) seen.delete(key);
  while (seen.size > max) seen.delete(seen.keys().next().value);
}

/** Hex SHA-1 of bytes or text. */
export const sha1 = (value) => createHash('sha1').update(value).digest('hex');

/** A content signature for a JSON-serialisable value. */
export const hashOf = (value) => sha1(JSON.stringify(value));

/** A 32-bit hash of a string (FNV-1a), for spreading work evenly. */
export function hash32(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** An area for a file name: its name and a short tag of its position. */
export const areaTag = (area) =>
  `${area.name}_${hash32(area.key).toString(36).slice(0, 6)}`;

/** `HHMMSS` of a time, in UTC. */
export const timeTag = (ms) =>
  new Date(ms).toISOString().slice(11, 19).replace(/:/g, '');

/** `YYYYMMDDTHHMMSS` of an ISO time or ms, in UTC. */
export const stamp = (time) =>
  new Date(typeof time === 'number' ? time : Date.parse(time))
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, '');

/**
 * A file name the store keeps as it is: safe characters only, at most 120
 * long, the extension kept (a long stem is cut and given a short hash).
 */
export function fileName(parts, ext) {
  const stem =
    parts
      .filter((part) => part !== null && part !== undefined && part !== '')
      .map((part) => String(part).replace(/[^A-Za-z0-9._-]+/g, '_'))
      .join('-') || 'file';
  const suffix = ext ? `.${ext}` : '';
  const room = 120 - suffix.length;
  if (stem.length <= room) return stem + suffix;
  return `${stem.slice(0, room - 11)}_${sha1(stem).slice(0, 10)}${suffix}`;
}

/** The file extension for an image content type. */
export function imageExt(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type === 'image/jpeg' || type === 'image/pjpeg') return 'jpg';
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';
  return 'bin';
}

/** A JSON value as gzip bytes. */
export const gzipJson = (value) => gzipSync(Buffer.from(JSON.stringify(value)));

/** A response header, or null. */
export const header = (response, name) =>
  response?.headers?.get?.(name) ?? null;

/** A Retry-After header in ms (seconds or an HTTP date), or null. */
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || String(value).trim() === '')
    return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Aircraft the flights feed recorded lately (hex → ms), so the enrichment
 * feed can look their types up without asking for another snapshot.
 */
const recentFlightHexes = new Map();
const RECENT_FLIGHT_HEX_MAX = 60_000;

export function noteFlightHexes(hexes, at) {
  for (const hex of hexes) {
    if (typeof hex !== 'string' || !hex) continue;
    recentFlightHexes.delete(hex);
    recentFlightHexes.set(hex, at);
  }
  while (recentFlightHexes.size > RECENT_FLIGHT_HEX_MAX)
    recentFlightHexes.delete(recentFlightHexes.keys().next().value);
}

/** The hexes the flights feed recorded between `since` and `until`. */
export function flightHexesBetween(since, until) {
  const hexes = [];
  for (const [hex, at] of recentFlightHexes)
    if (at >= since && at <= until) hexes.push(hex);
  return hexes;
}

/**
 * Military travel is not training data (owner ruling 2026-10-15: "travel
 * (excluding military travel)"). The civil aircraft feeds drop every
 * airframe the app's own military list names (services.military, the
 * military layer's source) before a record is kept, so a military aircraft
 * never reaches the tape. The list is asked for at most every 10 minutes,
 * once for the whole recorder, and a list up to 6 hours old still screens;
 * with no list that recent a civil feed holds its poll rather than keep
 * aircraft it could not screen.
 */
export const MILITARY_LIST_MS = 10 * MINUTE;
export const MILITARY_LIST_MAX_AGE_MS = 6 * HOUR;
let militaryList = { hexes: null, at: -Infinity, askedAt: -Infinity };
let militaryAsking = null;

/** Forget the shared military list (tests). */
export function resetMilitaryList() {
  militaryList = { hexes: null, at: -Infinity, askedAt: -Infinity };
  militaryAsking = null;
}

/**
 * The lower-case hexes of military aircraft, or null when no list recent
 * enough can be had.
 * @param {object} services Tool services (services.military.getIdentities).
 * @param {{now: () => number, signal?: AbortSignal}} options
 * @returns {Promise<Set<string>|null>}
 */
export async function militaryHexes(services, { now, signal } = {}) {
  const source = services?.military;
  const t = typeof now === 'function' ? now() : Date.now();
  if (
    typeof source?.getIdentities === 'function' &&
    t - militaryList.askedAt >= MILITARY_LIST_MS
  ) {
    militaryList.askedAt = t;
    militaryAsking = (async () => {
      try {
        const ids = await source.getIdentities({}, { signal });
        if (Array.isArray(ids))
          militaryList = {
            ...militaryList,
            hexes: new Set(
              ids
                .map((id) =>
                  String(id || '')
                    .trim()
                    .toLowerCase(),
                )
                .filter(Boolean),
            ),
            at: t,
          };
      } catch {
        /* the last list keeps screening until it is too old */
      }
    })();
  }
  if (militaryAsking) await militaryAsking;
  return militaryList.hexes && t - militaryList.at <= MILITARY_LIST_MAX_AGE_MS
    ? militaryList.hexes
    : null;
}

/** Leave a response body unread without holding its connection. */
export async function discard(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    /* already consumed or closed */
  }
}

// --------------------------------------------------------- bundled layers

/**
 * A bundled infrastructure layer (services.infrastructure) as a static
 * snapshot: checked once a day, recorded only when the bundle changed.
 * @param {{id: string, label: string, licence: string, bytesPerDay: number,
 *   fields: (record: object) => object}} options
 */
export function infrastructureSnapshot({
  id,
  label,
  licence,
  bytesPerDay,
  fields,
}) {
  return {
    id,
    label,
    layers: [id],
    kind: 'static',
    class: 'open',
    licence,
    cadenceMs: DAY,
    phase: 1,
    bytesPerDay,
    async poll({ services, state, signal }) {
      const rows = (await services.infrastructure.getRecords(id, { signal }))
        .filter((r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lon))
        .map((record) => ({
          id: text(String(record.id ?? ''), 160),
          name: text(record.name, 160),
          operator: text(record.operator, 160),
          ...fields(record),
          lat: round(record.lat, 6),
          lon: round(record.lon, 6),
        }));
      const sig = hashOf(rows);
      if (state.sig === sig) return {};
      state.sig = sig;
      return { records: rows };
    },
  };
}

// ---------------------------------------------------------------- weather

const SNAP_DEGREES = 0.25;
/** Whole-extent frames: 2048×1024 (the proxy also offers 4096 for radar). */
const EXTENT_SIZE = Object.freeze({ width: 2048, height: 1024 });
/** Detail windows around an area. */
const WINDOW_SIZE = Object.freeze({ width: 1024, height: 512 });
/** The radius a weather window covers when an area names none, in km. */
const WINDOW_RADIUS_KM = 150;

const snapDown = (value) => Math.floor(value / SNAP_DEGREES) * SNAP_DEGREES;
const snapUp = (value) => Math.ceil(value / SNAP_DEGREES) * SNAP_DEGREES;

/**
 * A 2:1 window around an area, snapped to 0.25° and moved inside the
 * product's bounds (what the weather image route accepts as `bbox`); null
 * when the area is outside the product or no such window fits.
 */
export function weatherWindow(area, bounds, radiusKm) {
  if (
    !bounds ||
    area.lon < bounds.west ||
    area.lon > bounds.east ||
    area.lat < bounds.south ||
    area.lat > bounds.north
  )
    return null;
  const reach = radiusKm ?? area.radiusKm ?? WINDOW_RADIUS_KM;
  const height = snapUp(2 * Math.max(0.5, reach / KM_PER_DEGREE));
  const width = height * 2;
  if (width > bounds.east - bounds.west || height > bounds.north - bounds.south)
    return null;
  let west = snapDown(area.lon - width / 2);
  let south = snapDown(area.lat - height / 2);
  west = Math.min(
    Math.max(west, snapUp(bounds.west)),
    snapDown(bounds.east - width),
  );
  south = Math.min(
    Math.max(south, snapUp(bounds.south)),
    snapDown(bounds.north - height),
  );
  const box = { west, south, east: west + width, north: south + height };
  return box.west >= bounds.west &&
    box.east <= bounds.east &&
    box.south >= bounds.south &&
    box.north <= bounds.north
    ? box
    : null;
}

/**
 * A NOAA nowCOAST raster feed (radar, satellite clouds, lightning) through
 * services.weatherMaps, the layer's own source: the newest frame of each
 * product's whole extent and a detail window around every area inside it,
 * each recorded once per observation time.
 * @param {{id: string, label: string, licence: string, bytesPerDay: number,
 *   products: Array<{product: string, windows?: boolean}>}} options
 */
export function weatherRasterFeed({
  id,
  label,
  licence,
  bytesPerDay,
  products,
}) {
  return {
    id,
    label,
    layers: [id],
    kind: 'feed',
    class: 'open',
    licence,
    // The layers refresh their manifests every 2 (radar, clouds) or 10
    // (lightning) minutes; a frame every 15 minutes is well inside that.
    cadenceMs: 15 * MINUTE,
    phase: 1,
    bytesPerDay,
    async poll({ services, areas, state, signal }) {
      state.last ??= new Map(); // target key → observation time recorded
      const list = validAreas(areas);
      const files = [];
      const targetsNow = new Set();
      const answeredProducts = new Set();
      let failure = null;
      for (const { product, windows = true } of products) {
        let manifest;
        try {
          manifest = await services.weatherMaps.getSnapshot({
            product,
            signal,
          });
        } catch (error) {
          failure ??= error;
          continue;
        }
        if (manifest?.unavailable || !manifest?.latest || !manifest?.bounds) {
          failure ??= new Error(
            manifest?.reason || `${product} imagery unavailable`,
          );
          continue;
        }
        answeredProducts.add(product);
        const time = manifest.latest;
        const targets = [
          {
            key: `${product}|extent`,
            area: null,
            tag: null,
            bbox: null,
            size: EXTENT_SIZE,
          },
        ];
        if (windows)
          for (const area of list) {
            const bbox = weatherWindow(area, manifest.bounds);
            if (bbox)
              targets.push({
                key: `${product}|${area.key}`,
                area: area.name,
                tag: areaTag(area),
                bbox,
                size: WINDOW_SIZE,
              });
          }
        for (const target of targets) {
          targetsNow.add(target.key);
          if (state.last.get(target.key) === time) continue;
          try {
            const image = await services.weatherMaps.getImage({
              product,
              time,
              size: target.size,
              bbox: target.bbox,
              signal,
            });
            if (image?.contentType !== 'image/png' || !image.bytes?.length)
              continue;
            state.last.set(target.key, time);
            const box = target.bbox ?? manifest.bounds;
            files.push({
              name: fileName([product, stamp(time), target.tag], 'png'),
              bytes: image.bytes,
              record: {
                layer: id,
                product,
                time,
                timeMs: Date.parse(time),
                bbox: bboxArray(box),
                width: target.size.width,
                height: target.size.height,
                area: target.area,
              },
            });
          } catch (error) {
            failure ??= error;
          }
        }
      }
      // Windows of areas no longer selected are forgotten.
      for (const key of state.last.keys())
        if (answeredProducts.has(key.split('|')[0]) && !targetsNow.has(key))
          state.last.delete(key);
      if (!answeredProducts.size && failure) throw failure;
      return { files };
    },
  };
}
