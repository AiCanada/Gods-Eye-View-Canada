import net from 'node:net';
import { readResponseTextCapped } from '../common/http.js';
import { CCTV_PROXY_USER_AGENT } from './upstream-headers.js';
import {
  FRAME_RESOLVE_CACHE_MS,
  FRAME_RESOLVE_MAX_PAGE_BYTES,
  FRAME_RESOLVE_STALE_MAX_MS,
  FRAME_RESOLVE_TIMEOUT_MS,
} from './constants.js';

/** Resolver strategies the proxy knows. Anything else is dropped at
 * normalisation so a typo never costs an HTML fetch per frame request. */
export const FRAME_RESOLVERS = new Set(['og-image']);

/** Resolved frame URLs, keyed by camera id: { url, at, failedAt }. */
const frameUrlCache = new Map();

/** Lower-case the extra hosts a catalogue entry lets its resolver accept. */
export function normalizeFrameHosts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((host) =>
      String(host || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** A hostname the proxy may contact on a page's (or a lookup service's) say-so:
 * public DNS names only. This reads the name alone; isPublicAddress checks
 * what it resolves to. */
export function isPublicHostname(host) {
  // A fully qualified name may end in dots ("localhost."); resolvers ignore
  // them, so the checks do too.
  const name = String(host || '')
    .toLowerCase()
    .replace(/\.+$/, '');
  if (!name || name === 'localhost' || name.endsWith('.localhost'))
    return false;
  if (
    name.endsWith('.local') ||
    name.endsWith('.internal') ||
    name.endsWith('.home.arpa')
  )
    return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return false; // IPv4 literal: loopback, RFC1918, link-local, metadata
  if (name.includes(':')) return false; // IPv6 literal
  return name.includes('.');
}

/** IPv4 ranges a still on an unvouched host may never be fetched from:
 * "this network", RFC 1918, shared CGNAT space, loopback, link-local, IETF
 * protocol assignments, benchmarking, multicast and reserved. */
const NON_PUBLIC_IPV4 = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  NON_PUBLIC_IPV4.addSubnet(prefix, bits, 'ipv4');
}

/** IPv6 ranges likewise: unspecified, loopback and IPv4-compatible (::/96),
 * unique-local, link-local, site-local and multicast. */
const NON_PUBLIC_IPV6 = new net.BlockList();
for (const [prefix, bits] of [
  ['::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  NON_PUBLIC_IPV6.addSubnet(prefix, bits, 'ipv6');
}

/** The IPv4 address inside an IPv4-mapped (::ffff:a.b.c.d) or NAT64
 * (64:ff9b::a.b.c.d) address, or ''. */
function embeddedIpv4(address) {
  let host;
  try {
    host = new URL(`http://[${address}]`).hostname;
  } catch {
    return '';
  }
  const match =
    /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host) ||
    /^\[64:ff9b::(?:(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4}))?\]$/.exec(host);
  if (!match) return '';
  const value =
    parseInt(match[1] || '0', 16) * 65536 + parseInt(match[2] || '0', 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
    .map(String)
    .join('.');
}

/**
 * Whether a resolved address is one the proxy may fetch a still from: a
 * public unicast address. Loopback, private (RFC 1918), CGNAT, link-local,
 * unique-local, unspecified, multicast and reserved addresses are refused,
 * including when wrapped in an IPv4-mapped or NAT64 IPv6 address. Anything
 * that is not an IP address is refused too.
 *
 * @param {unknown} address
 * @returns {boolean}
 */
export function isPublicAddress(address) {
  const bare = String(address || '')
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/%.*$/, '');
  const family = net.isIP(bare);
  if (family === 4) return !NON_PUBLIC_IPV4.check(bare, 'ipv4');
  if (family !== 6) return false;
  const embedded = embeddedIpv4(bare);
  if (embedded) return !NON_PUBLIC_IPV4.check(embedded, 'ipv4');
  return !NON_PUBLIC_IPV6.check(bare, 'ipv6');
}

/**
 * May the proxy fetch this resolved frame URL for this catalogue entry?
 *
 * The page names the frame, so the page's operator controls where the proxy
 * goes next. The frame must therefore live on the page's own host or on a host
 * the catalogue entry lists in `frameHosts`, must be https, and must never be
 * an address literal or an internal name.
 */
export function frameHostAllowed(source, resolved) {
  if (!resolved || resolved.protocol !== 'https:') return false;
  const host = String(resolved.hostname || '').toLowerCase();
  if (!isPublicHostname(host)) return false;
  let pageHost = '';
  try {
    pageHost = new URL(source?.pageUrl || '').hostname.toLowerCase();
  } catch {
    pageHost = '';
  }
  return (
    host === pageHost || normalizeFrameHosts(source?.frameHosts).includes(host)
  );
}

/**
 * Read the current frame URL from a camera's own page.
 *
 * Only `pageUrl` values that came from the server-registered catalogue are ever
 * passed here — never a client-supplied one — and the URL the page advertises
 * is accepted only when frameHostAllowed() says so. The page body is read under
 * a byte cap, the same discipline the snapshot fetch applies to images.
 *
 * @param {object} source - Normalized catalogue entry.
 * @param {{fetchImpl?: typeof fetch, now?: () => number, cache?: Map}} [options] - Test seams.
 * @returns {Promise<string>} Absolute frame URL, or '' when it cannot be read.
 */
export async function resolveFrameUrl(
  source,
  { fetchImpl = fetch, now = Date.now, cache = frameUrlCache } = {},
) {
  const pageUrl = source?.pageUrl || '';
  if (
    !pageUrl ||
    !/^https?:\/\//i.test(pageUrl) ||
    !FRAME_RESOLVERS.has(source?.frameResolver)
  )
    return '';

  const at = now();
  const cached = cache.get(source.id);
  if (cached?.url && at - cached.at <= FRAME_RESOLVE_CACHE_MS)
    return cached.url;
  // Serve the last good URL through a transient page outage rather than
  // dropping straight to the synthetic frame, but not indefinitely.
  const lastGood =
    cached?.url && at - cached.at <= FRAME_RESOLVE_STALE_MAX_MS
      ? cached.url
      : '';
  if (cached?.failedAt && at - cached.failedAt <= FRAME_RESOLVE_CACHE_MS)
    return lastGood;
  const failed = () => {
    cache.set(source.id, {
      url: cached?.url || '',
      at: cached?.at || 0,
      failedAt: at,
    });
    return lastGood;
  };

  try {
    const signal = AbortSignal.timeout(FRAME_RESOLVE_TIMEOUT_MS);
    const page = await fetchImpl(pageUrl, {
      headers: { 'User-Agent': CCTV_PROXY_USER_AGENT },
      signal,
    });
    if (!page.ok) {
      try {
        await page.body?.cancel();
      } catch {
        /* already closed */
      }
      return failed();
    }
    const html = await readResponseTextCapped(
      page,
      FRAME_RESOLVE_MAX_PAGE_BYTES,
      signal,
    );

    let found = '';
    if (source.frameResolver === 'og-image') {
      // Attribute order and spacing vary between operators, so match either
      // ordering rather than one exact spelling.
      const meta =
        html.match(
          /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
        ) ||
        html.match(
          /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
        );
      found = decodeHtmlEntities(meta?.[1] || '');
    }
    if (!found) return failed();

    // Resolve protocol-relative and root-relative values against the page.
    let resolved;
    try {
      resolved = new URL(found, pageUrl);
    } catch {
      return failed();
    }
    if (!frameHostAllowed(source, resolved)) return failed();
    // Operators often advertise a thumbnail; take the full-size sibling when the
    // entry says one exists.
    const url = source.framePreferLarge
      ? resolved.toString().replace('/mini/', '/large/')
      : resolved.toString();
    cache.set(source.id, { url, at, failedAt: 0 });
    return url;
  } catch {
    return failed();
  }
}

/** 15 s, doubling per consecutive failure, capped at five minutes. */
export function frameFailureBackoffMs(failures) {
  return Math.min(15 * 1000 * 2 ** Math.max(0, failures - 1), 5 * 60 * 1000);
}
