/**
 * Same-origin HLS for video-only cameras.
 *
 * Thousands of cameras in the Canadian, US and international packs publish
 * nothing but an HLS stream. Current Chrome plays HLS natively in a plain
 * <video>, MPEG-TS and fragmented MP4 alike, so all the application has to do
 * is bring the stream to its own origin: a playlist is rewritten so that every
 * address in it (media segments, the init segment, keys, variant playlists)
 * comes back through this proxy, and the proxy fetches those addresses itself.
 * Same origin means the picture can be drawn to a canvas (thumbnails, the side
 * panel) and textured onto the monitor plane, whatever CORS headers the
 * operator does or does not send.
 *
 * A playlist is remote content. Nothing in it may send this server anywhere
 * but the stream's own host, and that host must be a public address.
 */
import net from 'node:net';
import { isPublicAddress, isPublicHostname } from './frame-resolver.js';

/**
 * A public host: a public name, or a literal public address (several operators
 * publish their streams on a bare IP). The connection itself is checked again
 * by the public-only fetch.
 */
function isPublicHost(hostname) {
  const bare = String(hostname || '').replace(/^\[(.*)\]$/, '$1');
  return net.isIP(bare) ? isPublicAddress(bare) : isPublicHostname(hostname);
}

export const HLS_PLAYLIST_MAX_BYTES = 512 * 1024;
export const HLS_SEGMENT_MAX_BYTES = 48 * 1024 * 1024;

/**
 * An HLS playlist address the proxy may fetch: http(s) on a public host, no
 * credentials, a path ending in .m3u8 (or .m3u). '' otherwise.
 * @param {unknown} value
 * @returns {string}
 */
export function safeHlsPlaylistUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  if (parsed.username || parsed.password) return '';
  if (!isPublicHost(parsed.hostname)) return '';
  if (!/\.m3u8?$/i.test(parsed.pathname)) return '';
  return parsed.href;
}

/**
 * Whether the proxy may fetch `href` on behalf of a stream: same host as the
 * stream's playlist, http(s), public, no credentials.
 * @param {string} href
 * @param {string} playlistUrl
 * @returns {boolean}
 */
export function hlsTargetAllowed(href, playlistUrl) {
  try {
    const target = new URL(href);
    const origin = new URL(playlistUrl);
    if (target.protocol !== 'https:' && target.protocol !== 'http:')
      return false;
    if (target.username || target.password) return false;
    if (target.host !== origin.host) return false;
    return isPublicHost(target.hostname);
  } catch {
    return false;
  }
}

/** An address as it travels in the proxy's own query string. */
export function encodeHlsTarget(href) {
  return Buffer.from(String(href), 'utf8').toString('base64url');
}

/** The address back out of the query string, or '' when it is not one. */
export function decodeHlsTarget(token) {
  if (typeof token !== 'string' || !token || token.length > 4096) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return '';
  try {
    const href = Buffer.from(token, 'base64url').toString('utf8');
    return new URL(href).href;
  } catch {
    return '';
  }
}

/** Does this look like a playlist (by type, or by name when the type is vague)? */
export function isHlsPlaylist(contentType, href) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('mpegurl')) return true;
  try {
    return /\.m3u8?$/i.test(new URL(href).pathname);
  } catch {
    return false;
  }
}

/**
 * Rewrite every address in a playlist through `toProxy`. Pure.
 * Address lines, and the URI="..." of the tags that carry one (EXT-X-MAP,
 * EXT-X-KEY, EXT-X-MEDIA, EXT-X-PART, EXT-X-PRELOAD-HINT, ...).
 * @param {string} text
 * @param {string} baseUrl The playlist's own address (relative entries resolve against it).
 * @param {(absoluteHref: string) => string} toProxy Return '' to drop an entry.
 * @returns {string}
 */
export function rewriteHlsPlaylist(text, baseUrl, toProxy) {
  const resolve = (uri) => {
    try {
      return new URL(uri, baseUrl).href;
    } catch {
      return '';
    }
  };
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      out.push('');
      continue;
    }
    if (line.startsWith('#')) {
      out.push(
        line.replace(/URI="([^"]*)"/gi, (_match, uri) => {
          const absolute = resolve(uri);
          const proxied = absolute ? toProxy(absolute) : '';
          return `URI="${proxied}"`;
        }),
      );
      continue;
    }
    const absolute = resolve(line);
    const proxied = absolute ? toProxy(absolute) : '';
    // An entry that may not be fetched is left out with its EXTINF line.
    if (!proxied) {
      if (out.length && /^#EXTINF/i.test(out[out.length - 1])) out.pop();
      continue;
    }
    out.push(proxied);
  }
  return out.join('\n');
}
