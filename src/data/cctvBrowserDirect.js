/**
 * Browser-direct CCTV stills.
 *
 * Some operators (Québec 511) refuse every server-side client, so the server
 * hands those cameras' still addresses to the viewer's browser instead
 * (`browserImageUrl` on /api/cctv/sources, driven by CCTV_BROWSER_DIRECT_HOSTS).
 * The browser can show such a still in an <img>, but the operator sends no CORS
 * header, so it can never become a WebGL texture: monitor planes and camera
 * cards keep their placeholder for these cameras.
 */

/** Never ask a browser-direct operator for a new still more often than this. */
export const BROWSER_DIRECT_MIN_REFRESH_MS = 60 * 1000;

/** Whether this camera's still must be loaded by the browser itself. */
export function isBrowserDirect(camera) {
  return typeof camera?.browserImageUrl === 'string' && /^https:\/\//i.test(camera.browserImageUrl);
}

/**
 * The still address for an <img>, with a refresh tick so the browser does not
 * keep showing a day-old cached frame (these stills are served with a one-day
 * cache lifetime). The tick changes at most once per minute.
 *
 * @param {{browserImageUrl: string}} camera
 * @param {number} refreshMs Requested refresh cadence.
 * @param {number} [now]
 * @returns {string}
 */
export function browserDirectFrameUrl(camera, refreshMs, now = Date.now()) {
  const cadenceMs = Math.max(BROWSER_DIRECT_MIN_REFRESH_MS, Number(refreshMs) || 0);
  const tick = Math.floor(now / cadenceMs);
  const url = new URL(camera.browserImageUrl);
  url.searchParams.set('gev', String(tick));
  return url.toString();
}
