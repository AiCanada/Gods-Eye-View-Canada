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

/** A hostname the proxy may contact on a page's say-so: public DNS names only. */
function isPublicHostname(host) {
  const name = String(host || '').toLowerCase();
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
