/**
 * World tape feed: public camera stills around the selected areas, through
 * the app's own CCTV routes only (services.cctv → /api/cctv/sources, and
 * /api/cctv/frame/<id> as a card asks, never `active`), so the provider's
 * per-host gate, its frame cache and the 511 request budget
 * (server/providers/cctv/host-budget.js: 20 a minute and 1,000 a day per
 * host) apply to every request. No camera host is ever called directly.
 *
 * Owner rulings, kept here as hard rules:
 * - School, university, college and library cameras are never fetched or
 *   stored: every camera passes the repo's filter
 *   (server/providers/cctv/school-filter.js) when the catalogue is read and
 *   again right before its frame is asked for.
 * - At most the nearest 1,000 cameras within 50 km of each area; no switch
 *   turns that off.
 * - Each camera at most once every 15 minutes, spread over the period. A
 *   camera whose host is over budget (the recorder's share of a 511 host's
 *   budget is used, or the server answered that it is limited) is skipped and
 *   asked again later; offline and unreachable cameras stay in the rotation.
 * - No host is special-cased as blocked or region-restricted.
 */
import { isSchoolCamera } from '../../../providers/cctv/school-filter.js';
import {
  DAY,
  MINUTE,
  discard,
  fileName,
  hash32,
  haversineKm,
  header,
  imageExt,
  mapLimit,
  requireAreas,
  retryAfterMs,
  round,
  sha1,
  text,
  timeTag,
} from './_util.mjs';

export const CCTV_PERIOD_MS = 15 * MINUTE;
export const CCTV_RADIUS_KM = 50;
export const CCTV_AREA_CAP = 1000;
/**
 * The recorder's share of a 511 host's budget. Cards stop at 15 a minute and
 * 900 a day (the rest is kept for the camera being watched); the recorder
 * takes about half of that, so the live layer keeps the other half.
 */
export const CCTV_HOST_SHARE = Object.freeze({ perMinute: 7, perDay: 450 });
const CATALOG_REFRESH_MS = 30 * MINUTE;
const CATALOG_PENDING_RETRY_MS = 2 * MINUTE;
const MAX_FRAMES_PER_POLL = 240;
const CONCURRENCY = 4;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** How long a host stays skipped after a limited answer without Retry-After. */
const LIMITED_HOLD_MS = 5 * MINUTE;
const FRAME_TYPES = /^image\/(jpeg|pjpeg|png|webp|gif)$/;

/**
 * The cameras one area may record: public stills with a position within 50
 * km (and the area's own radius), the nearest 1,000, never a school camera.
 */
export function nearestCameras(sources, area, radiusKm = CCTV_RADIUS_KM) {
  const reach = Math.min(CCTV_RADIUS_KM, radiusKm);
  return (Array.isArray(sources) ? sources : [])
    .filter(
      (camera) =>
        typeof camera?.id === 'string' &&
        camera.id &&
        Number.isFinite(camera.lat) &&
        Number.isFinite(camera.lon) &&
        // This machine's own cameras are the private-cctv feed's.
        !camera.privateFrameUrl &&
        camera.sourceKind !== 'private',
    )
    .map((camera) => ({ camera, km: haversineKm(area, camera) }))
    .filter(({ km }) => km <= reach)
    .sort((a, b) => a.km - b.km)
    .slice(0, CCTV_AREA_CAP)
    .filter(({ camera }) => !isSchoolCamera(camera));
}

/**
 * The host a camera's frames come from: the catalogue's budgetHost (the
 * still's host, the key the server's 511 ledger counts by), else, from an
 * older catalogue, its pack and provider (one 511 system per provider).
 */
export function cctvHostKey(camera) {
  const host = text(camera.budgetHost, 160);
  if (host) return host.toLowerCase();
  return `${camera.pack || ''}|${camera.provider || camera.region || ''}`
    .toLowerCase()
    .slice(0, 160);
}

/** Only 511 stills (/map/Cctv/) carry a frame refresh: those hosts are budgeted. */
const budgeted = (camera) => Number.isFinite(camera.frameRefreshMs);

/** The camera's first slot: its own offset within the 15-minute period. */
function firstSlot(id, t) {
  const phase = hash32(id) % CCTV_PERIOD_MS;
  return t + ((phase - (t % CCTV_PERIOD_MS) + CCTV_PERIOD_MS) % CCTV_PERIOD_MS);
}

function hostState(hosts, key, t) {
  let host = hosts.get(key);
  if (!host) {
    host = { minute: [], day: '', dayCount: 0, holdUntil: 0, usedAt: t };
    hosts.set(key, host);
  }
  const day = new Date(t).toISOString().slice(0, 10);
  if (host.day !== day) {
    host.day = day;
    host.dayCount = 0;
  }
  host.minute = host.minute.filter((at) => t - at < MINUTE);
  host.usedAt = t;
  return host;
}

/** Spend one request of the recorder's share of a budgeted host. */
function takeShare(host, t) {
  if (host.dayCount >= CCTV_HOST_SHARE.perDay) {
    const next = new Date(t);
    next.setUTCHours(24, 0, 0, 0);
    host.holdUntil = next.getTime();
    return false;
  }
  if (host.minute.length >= CCTV_HOST_SHARE.perMinute) return false;
  host.minute.push(t);
  host.dayCount += 1;
  return true;
}

async function refreshCatalog({ services, list, state, t, signal }) {
  const fresh = new Map();
  let answered = 0;
  let pending = false;
  let failure = null;
  for (const area of list) {
    const radiusKm = Math.min(CCTV_RADIUS_KM, area.radiusKm ?? CCTV_RADIUS_KM);
    let payload;
    try {
      payload = await services.cctv.getCatalog({
        lat: area.lat,
        lon: area.lon,
        radiusKm,
        signal,
      });
    } catch (error) {
      failure ??= error;
      continue;
    }
    answered += 1;
    if (payload?.area?.pending?.length) pending = true;
    for (const { camera, km } of nearestCameras(
      payload?.sources,
      area,
      radiusKm,
    ))
      if (!fresh.has(camera.id)) fresh.set(camera.id, { camera, area, km });
  }
  if (!answered) throw failure || new Error('Camera catalogue unavailable');
  // Cameras that left every area's nearest 1,000 go; the rest keep their
  // place in the rotation, offline or not.
  for (const id of state.cameras.keys())
    if (!fresh.has(id)) state.cameras.delete(id);
  for (const [id, { camera, area, km }] of fresh) {
    const entry = state.cameras.get(id);
    if (entry) {
      entry.camera = camera;
      entry.area = area.name;
      entry.km = km;
      entry.hostKey = cctvHostKey(camera);
    } else
      state.cameras.set(id, {
        camera,
        area: area.name,
        km,
        hostKey: cctvHostKey(camera),
        nextAt: firstSlot(id, t),
        lastSha: null,
        lastStatus: null,
      });
  }
  state.catalogUntil =
    t + (pending ? CATALOG_PENDING_RETRY_MS : CATALOG_REFRESH_MS);
}

/** One frame through the app's frame route. */
async function readFrame({ fetch, services, camera, t, signal }) {
  if (typeof fetch !== 'function') {
    // Without a resolving fetch, the source's own frame read (no headers;
    // a placeholder is an SVG, never a frame).
    const frame = await services.cctv.getFrame(camera, { signal });
    return FRAME_TYPES.test(frame.contentType)
      ? { ok: true, type: frame.contentType, bytes: frame.bytes }
      : { ok: true, type: frame.contentType };
  }
  const url = `/api/cctv/frame/${encodeURIComponent(camera.id)}?ts=${Math.floor(t / CCTV_PERIOD_MS)}`;
  const response = await fetch(url, { cache: 'no-store', signal });
  const type = String(header(response, 'content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const result = {
    ok: response.ok,
    status: response.status,
    type,
    source: header(response, 'x-cctv-source'),
    cache: header(response, 'x-cctv-cache'),
    retryAfterMs: retryAfterMs(header(response, 'retry-after'), t),
  };
  const usable =
    response.ok &&
    FRAME_TYPES.test(type) &&
    result.source !== 'synthetic' &&
    result.source !== 'streetview' &&
    result.cache !== 'last-good';
  const length = Number(header(response, 'content-length'));
  if (!usable || length > MAX_FRAME_BYTES) {
    await discard(response);
    return result;
  }
  result.bytes = new Uint8Array(await response.arrayBuffer());
  return result;
}

export default {
  id: 'cctv',
  label: 'Public cameras (stills)',
  layers: ['cctv'],
  kind: 'feed',
  class: 'unclear',
  licence:
    'Per camera operator (each record names its operator licence); many listings have unconfirmed terms',
  // A slice of the rotation each minute; every camera at most every 15.
  cadenceMs: MINUTE,
  phase: 2,
  bytesPerDay: 1.5e9,
  async poll({ services, fetch, areas, state, now, signal }) {
    const list = requireAreas(areas);
    const t = now();
    state.cameras ??= new Map(); // camera id → rotation entry
    state.hosts ??= new Map(); // host key → budget share and hold
    const areasSig = list
      .map((area) => `${area.key}:${area.radiusKm ?? ''}`)
      .join(';');
    if (state.areasSig !== areasSig || !(t < state.catalogUntil)) {
      try {
        await refreshCatalog({ services, list, state, t, signal });
        state.areasSig = areasSig;
      } catch (error) {
        // A later catalogue read that fails keeps the rotation going.
        if (state.areasSig !== areasSig || !state.cameras.size) throw error;
        state.catalogUntil = t + CATALOG_PENDING_RETRY_MS;
      }
    }

    const picked = [];
    const due = [...state.cameras.values()]
      .filter((entry) => entry.nextAt <= t)
      .sort((a, b) => a.nextAt - b.nextAt);
    for (const entry of due) {
      if (picked.length >= MAX_FRAMES_PER_POLL) break;
      // The filter again, right before any request: never a school camera.
      if (isSchoolCamera(entry.camera)) {
        state.cameras.delete(entry.camera.id);
        continue;
      }
      const host = hostState(state.hosts, entry.hostKey, t);
      // Over budget or asked to slow down: skipped now, asked again later.
      if (host.holdUntil > t) continue;
      if (budgeted(entry.camera) && !takeShare(host, t)) continue;
      entry.nextAt = t + CCTV_PERIOD_MS;
      picked.push(entry);
    }

    const files = [];
    const records = [];
    const note = (entry, status) => {
      if (entry.lastStatus === status) return;
      entry.lastStatus = status;
      records.push({ camera: entry.camera.id, area: entry.area, status });
    };
    await mapLimit(picked, CONCURRENCY, async (entry) => {
      const { camera } = entry;
      // The host answered "slow down" during this poll: ask again later.
      if (state.hosts.get(entry.hostKey)?.holdUntil > t) {
        entry.nextAt = t;
        return;
      }
      let frame;
      try {
        frame = await readFrame({ fetch, services, camera, t, signal });
      } catch {
        note(entry, 'error');
        return;
      }
      const limited =
        frame.retryAfterMs !== null && frame.retryAfterMs !== undefined;
      if (limited || frame.cache === 'last-good') {
        const host = hostState(state.hosts, entry.hostKey, t);
        host.holdUntil = Math.max(
          host.holdUntil,
          t + (limited ? frame.retryAfterMs : LIMITED_HOLD_MS),
        );
      }
      if (!frame.bytes?.length) {
        note(
          entry,
          !frame.ok
            ? `http-${frame.status}`
            : limited || frame.cache === 'last-good'
              ? 'limited'
              : 'unavailable',
        );
        return;
      }
      const digest = sha1(frame.bytes);
      if (digest === entry.lastSha) {
        note(entry, 'unchanged');
        return;
      }
      entry.lastSha = digest;
      entry.lastStatus = 'frame';
      files.push({
        name: fileName([timeTag(t), camera.id], imageExt(frame.type)),
        bytes: frame.bytes,
        record: {
          camera: camera.id,
          name: text(camera.name),
          provider: text(camera.provider),
          pack: text(camera.pack),
          country: text(camera.country, 8),
          lat: round(camera.lat, 6),
          lon: round(camera.lon, 6),
          heading: round(camera.headingDeg, 0),
          area: entry.area,
          km: round(entry.km, 2),
          contentType: frame.type,
          sha1: digest,
          cache: frame.cache ?? null,
          operatorLicence: text(camera.license, 240),
        },
      });
    });
    for (const [key, host] of state.hosts)
      if (t - host.usedAt > DAY && !(host.holdUntil > t))
        state.hosts.delete(key);
    return { files, records };
  },
};
