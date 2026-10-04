import {
  ACTIVE_FRAME_REFRESH_MS,
  FRAME_ENDPOINT,
  MEDIA_ENDPOINT,
} from './sourcePolicy.js';
function safeNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
/**
 * Builds the URL for fetching a camera frame image from the backend
 * (contract 4: `/api/cctv/frame/:id?ts=<tick>[&active=1]`). The server reads
 * the camera's label and position from its own catalogue, so none ride along.
 * A home or business camera loads from its own loopback-only frame route.
 * @param {Object} camera - Camera object.
 * @param {number} [refreshMs=ACTIVE_FRAME_REFRESH_MS] - Refresh interval used for tick bucketing.
 * @param {Object} [options]
 * @param {boolean} [options.active=false] - Only the active camera's monitor
 *   plane and panel preview set this; map cards never do.
 * @returns {string} Frame URL.
 */
function frameUrlFor(
  camera,
  refreshMs = ACTIVE_FRAME_REFRESH_MS,
  { active = false } = {},
) {
  const cadenceMs = Math.max(
    1000,
    safeNumber(refreshMs, ACTIVE_FRAME_REFRESH_MS),
  );
  const tick = Math.floor(Date.now() / cadenceMs);
  if (camera.privateFrameUrl) return `${camera.privateFrameUrl}?ts=${tick}`;
  const params = new URLSearchParams({ ts: String(tick) });
  if (active) params.set('active', '1');
  return `${FRAME_ENDPOINT}/${encodeURIComponent(camera.id)}?${params.toString()}`;
}
function mediaUrlFor(camera) {
  return `${MEDIA_ENDPOINT}/${encodeURIComponent(camera.id)}?ts=${Math.floor(Date.now() / 15000)}`;
}
/** Supply catalog/health records and the existing registered camera URL families. */
export function createCctvSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function read(path, key, { signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl(path, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Camera source HTTP ' + response.status);
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.[key]))
      throw new Error('Malformed camera ' + key + ' snapshot');
    return payload;
  }
  return {
    /**
     * The public cameras nearest a point (contract 2): at most 1,000 within
     * `radiusKm` (50 km), nearest first, plus the server's `area` report. The
     * server answers no cameras without a point.
     * @param {{signal?: AbortSignal, lat?: number, lon?: number, radiusKm?: number}} [options]
     */
    getCatalog(options = {}) {
      const params = new URLSearchParams();
      if (Number.isFinite(options?.lat) && Number.isFinite(options?.lon)) {
        params.set('lat', options.lat.toFixed(5));
        params.set('lon', options.lon.toFixed(5));
        if (Number.isFinite(options.radiusKm))
          params.set('radiusKm', String(options.radiusKm));
      }
      const query = params.toString();
      return read(
        `/api/cctv/sources${query ? `?${query}` : ''}`,
        'sources',
        options,
      );
    },
    getHealth(options) {
      return read('/api/cctv/health', 'cameras', options);
    },
    getFrameUrl: frameUrlFor,
    getMediaUrl: mediaUrlFor,
    /** Read one current frame through the registered frame endpoint. */
    async getFrame(camera, { signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(frameUrlFor(camera), {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error('Camera frame HTTP ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      const type = response.headers.get('content-type') || '';
      return { contentType: type.split(';')[0].trim().toLowerCase(), bytes };
    },
  };
}
