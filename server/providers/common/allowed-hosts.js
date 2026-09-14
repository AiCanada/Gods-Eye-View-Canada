import net from 'node:net';

/**
 * Host names a local route admits when the server's own allowedHosts are not
 * known, matching build/vite.js. Without a list a guard fails closed.
 */
export const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'localhost',
  '127.0.0.1',
  '.local',
]);

/**
 * Whether a server serves a Host hostname. Vite applies its own allowedHosts
 * check only after plugin middleware, so a plugin route that must not answer
 * a DNS-rebinding page (whose Origin matches its own Host) or a tunnel checks
 * the Host itself. Same rules as Vite: `true` admits any host; localhost,
 * *.localhost and IP literals are always admitted; an entry matches exactly,
 * or by suffix when it starts with '.'.
 *
 * @param {string} hostname URL hostname: lowercase, IPv6 in brackets.
 * @param {true | readonly string[]} allowedHosts
 * @returns {boolean}
 */
export function hostAllowed(hostname, allowedHosts) {
  if (allowedHosts === true) return true;
  const bare = hostname.replace(/^\[(.*)\]$/, '$1');
  if (bare === 'localhost' || bare.endsWith('.localhost') || net.isIP(bare))
    return true;
  if (!Array.isArray(allowedHosts)) return false;
  return allowedHosts.some((entry) => {
    const allowed = String(entry || '')
      .trim()
      .toLowerCase();
    if (!allowed) return false;
    return allowed.startsWith('.')
      ? hostname === allowed.slice(1) || hostname.endsWith(allowed)
      : hostname === allowed;
  });
}

/**
 * The allowedHosts Vite resolved for one server: `server` for development,
 * `preview` for preview. Vite also admits the host names the server was
 * started with (config.additionalAllowedHosts), so those are exact entries.
 *
 * @param {object} [config] Resolved Vite config.
 * @param {'server' | 'preview'} section
 * @returns {true | readonly string[]}
 */
export function resolvedAllowedHosts(config, section) {
  const allowed = config?.[section]?.allowedHosts;
  if (allowed === true) return true;
  if (!Array.isArray(allowed)) return DEFAULT_ALLOWED_HOSTS;
  const additional = Array.isArray(config.additionalAllowedHosts)
    ? config.additionalAllowedHosts.filter(
        (host) => typeof host === 'string' && !host.startsWith('.'),
      )
    : [];
  return [...allowed, ...additional];
}

/**
 * The origin a request was addressed to, when this server serves its Host:
 * `{ hostname, origin }`, or null for a missing, malformed or unserved Host.
 *
 * @param {import('http').IncomingMessage} req
 * @param {true | readonly string[]} [allowedHosts]
 * @returns {?{hostname: string, origin: string}}
 */
export function servedRequestOrigin(req, allowedHosts = DEFAULT_ALLOWED_HOSTS) {
  const host = String(req?.headers?.host || '')
    .trim()
    .toLowerCase();
  if (!host || /[\s/\\?#@]/.test(host)) return null;
  let served;
  try {
    const protocol = req.socket?.encrypted ? 'https:' : 'http:';
    served = new URL(`${protocol}//${host}`);
  } catch {
    return null;
  }
  if (!hostAllowed(served.hostname, allowedHosts)) return null;
  return { hostname: served.hostname, origin: served.origin };
}

/**
 * Whether an Origin header names exactly `expected`: the same scheme, host and
 * port, with no credentials, path, query or fragment. A missing, empty or
 * opaque ("null") Origin never matches.
 *
 * @param {unknown} value Origin header value.
 * @param {string} expected Serialized origin, e.g. "http://localhost:4173".
 * @returns {boolean}
 */
export function originIs(value, expected) {
  let origin;
  try {
    origin = new URL(String(value ?? ''));
  } catch {
    return false;
  }
  return (
    origin.origin === expected &&
    origin.username === '' &&
    origin.password === '' &&
    origin.pathname === '/' &&
    origin.search === '' &&
    origin.hash === ''
  );
}
