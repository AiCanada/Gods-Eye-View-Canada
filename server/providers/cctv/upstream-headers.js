import {
  DEFAULT_CCTV_BROWSER_DIRECT_HOSTS,
  DEFAULT_CCTV_ROAD_MATCH_HOSTS,
} from './constants.js';

/** How the CCTV proxy identifies itself to camera operators. */
export const CCTV_PROXY_USER_AGENT = 'gods-eye-view-cctv-proxy/1.0';

/**
 * Hosts from CCTV_BROWSER_DIRECT_HOSTS, lower-cased, read from the live
 * environment. Unset means the default (none); set but empty means none.
 *
 * A last resort for an operator whose bot filter refuses every server-side
 * client, whatever it calls itself. For a listed host the proxy does not try:
 * the viewer's own browser loads the still directly, as the operator's own map
 * does. Such a still shows in the camera panel and as a map thumbnail, but
 * never on the 3D monitor plane (a WebGL texture needs a CORS header).
 */
export function browserDirectHosts(env = process.env) {
  return String(
    env.CCTV_BROWSER_DIRECT_HOSTS ?? DEFAULT_CCTV_BROWSER_DIRECT_HOSTS,
  )
    .split(',')
    .map((host) =>
      host
        .trim()
        .toLowerCase()
        .replace(/^www\./, ''),
    )
    .filter(Boolean);
}

/**
 * The still a viewer's browser should load itself for this camera, or '' when
 * the proxy serves it. Only https stills on a listed host (or a subdomain of
 * one) qualify.
 *
 * @param {{snapshotUrl?: string, url?: string, feedType?: string}} source
 * @returns {string}
 */
export function browserDirectImageUrl(source, env = process.env) {
  const hosts = browserDirectHosts(env);
  if (!hosts.length) return '';
  const candidate = source?.snapshotUrl || source?.url || '';
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:') return '';
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const listed = hosts.some(
    (entry) => host === entry || host.endsWith(`.${entry}`),
  );
  return listed ? parsed.toString() : '';
}

/**
 * Whether this camera's map thumbnail is road-matched (CCTV_ROAD_MATCH_HOSTS:
 * a comma-separated host list, `*` for every camera, empty for none).
 * @param {{snapshotUrl?: string, url?: string}} source
 * @returns {boolean}
 */
export function roadMatchedThumbnail(source, env = process.env) {
  const hosts = String(
    env.CCTV_ROAD_MATCH_HOSTS ?? DEFAULT_CCTV_ROAD_MATCH_HOSTS,
  )
    .split(',')
    .map((host) =>
      host
        .trim()
        .toLowerCase()
        .replace(/^www\./, ''),
    )
    .filter(Boolean);
  if (!hosts.length) return false;
  if (hosts.includes('*')) return true;
  let host = '';
  try {
    host = new URL(source?.snapshotUrl || source?.url || '').hostname
      .toLowerCase()
      .replace(/^www\./, '');
  } catch {
    return false;
  }
  return hosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
}
