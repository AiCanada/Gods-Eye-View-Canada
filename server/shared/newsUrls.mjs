/**
 * Operator news URLs for the AI World tab. At most 100 https addresses.
 * A private, loopback, or link-local host is refused. The article body
 * is never part of this check.
 */

export const NEWS_URL_MAX = 100;

const PRIVATE_V4 = [
  [10, 0, 8],
  [127, 0, 8],
  [169, 254, 16],
  [172, 16, 12],
  [192, 168, 16],
  [0, 0, 8],
];

function ipv4Parts(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : NaN,
  );
  if (nums.some((n) => !Number.isInteger(n) || n > 255)) return null;
  return nums;
}

function inBlock(nums, base, bits) {
  const address = nums.reduce((acc, part) => (acc << 8) + part, 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const start = base.reduce((acc, part) => (acc << 8) + part, 0) >>> 0;
  return (address & mask) === (start & mask);
}

/** True when the host is an address this machine must not fetch. */
export function isPrivateHost(hostname) {
  const host = String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host === 'metadata.google.internal')
    return true;
  if (
    host === '::1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  )
    return true;
  const v4 = ipv4Parts(host);
  if (!v4) return false;
  return PRIVATE_V4.some(([a, b, bits = 8]) =>
    inBlock(v4, [a, b, 0, 0].slice(0, 4), bits),
  );
}

/**
 * A saved news URL, or null when it cannot be used.
 * @returns {string|null}
 */
export function cleanNewsUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (isPrivateHost(url.hostname)) return null;
  url.hash = '';
  return url.href;
}

/** Add one URL. Duplicates are unchanged. Past 100 is an error. */
export function addNewsUrl(list, raw) {
  const urls = Array.isArray(list)
    ? list.filter((item) => typeof item === 'string')
    : [];
  const url = cleanNewsUrl(raw);
  if (!url) {
    const error = new Error('A news URL must be public https.');
    error.status = 400;
    throw error;
  }
  if (urls.includes(url)) return urls;
  if (urls.length >= NEWS_URL_MAX) {
    const error = new Error(`At most ${NEWS_URL_MAX} news URLs.`);
    error.status = 409;
    throw error;
  }
  return [...urls, url];
}

export function removeNewsUrl(list, raw) {
  const url = cleanNewsUrl(raw) || String(raw || '').trim();
  return (Array.isArray(list) ? list : []).filter((item) => item !== url);
}

/** Titles and links from an RSS or Atom document. No article body. */
export function itemsFromFeed(xml, pageUrl) {
  const text = String(xml || '');
  const items = [];
  const blocks = text.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    const title = decode(
      (block.match(
        /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i,
      ) || [])[1],
    );
    const link =
      decode((block.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1]) ||
      decode((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]);
    if (!title || !link) continue;
    let href = link.trim();
    try {
      href = new URL(href, pageUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:\/\//.test(href)) continue;
    items.push({ title: title.slice(0, 240), url: href.slice(0, 600) });
    if (items.length >= 20) break;
  }
  return items;
}

/** The document title of an HTML page, or ''. */
export function titleFromHtml(html) {
  const raw = (String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) ||
    [])[1];
  return decode(raw).slice(0, 240);
}

function decode(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
