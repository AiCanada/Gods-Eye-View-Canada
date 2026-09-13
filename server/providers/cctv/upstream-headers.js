import { DEFAULT_CCTV_BROWSER_DIRECT_HOSTS } from './constants.js';

/** How the CCTV proxy identifies itself to camera operators. */
export const CCTV_PROXY_USER_AGENT = 'gods-eye-view-cctv-proxy/1.0';

/**
 * Hosts from CCTV_BROWSER_DIRECT_HOSTS, lower-cased, read from the live
 * environment. Unset means the default (Québec 511); set but empty means none.
 *
 * Some operators (Québec 511) put their public camera stills behind a bot
 * filter that refuses every server-side client, whatever it calls itself. For
 * a listed host the proxy does not try: the viewer's own browser loads the
 * still directly, as the operator's own map does.
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
