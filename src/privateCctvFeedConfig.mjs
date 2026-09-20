/**
 * Which site the Private_CCTV_Feed relay reads, and which hosts it may fetch
 * pictures from.
 *
 * The repository names no camera vendor. It ships reserved example hosts, and
 * the owner's real ones live in `config/private_cctv_feed.local.json`, which is
 * never committed. The relay installer writes them into the installed
 * extension, and the server reads them for the feed link and for recognising a
 * site that points at the vendor's website instead of a camera feed.
 *
 * Pure: no file or network access here, so both the server and the installer
 * can share it and every rule is unit-testable.
 */

export const PRIVATE_CCTV_FEED_LOCAL_CONFIG =
  'config/private_cctv_feed.local.json';

export const PRIVATE_CCTV_FEED_DEFAULTS = Object.freeze({
  feedUrl: 'https://feed.private-cctv.example/#/feed',
  imageHosts: Object.freeze([
    'clips-z1.private-cctv.example',
    'clips-z2.private-cctv.example',
    'clips-z3.private-cctv.example',
    'clips-z4.private-cctv.example',
  ]),
  cloudHostSuffixes: Object.freeze([
    'private-cctv.example',
    'legacy.private-cctv.example',
  ]),
});

// Written without a lookbehind: this module is bundled for the browser, and
// a lookbehind is a SyntaxError in Safari before 16.4, for the whole bundle.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME = {
  test(value) {
    const host = String(value || '');
    if (!host || host.length > 253) return false;
    const labels = host.split('.');
    return labels.length >= 2 && labels.every((label) => LABEL.test(label));
  },
};

/**
 * The part of the feed's host that the vendor's other sites share: its
 * registrable domain, the last two labels. Where those two are themselves a
 * public suffix (`co.uk`, `com.au`: a two-letter country code under a short
 * second level) a third label is kept, because `co.uk` would match every
 * British camera host and block them all as "the vendor's website".
 * @param {string} hostname
 * @returns {string}
 */
export function sharedHostSuffix(hostname) {
  const labels = String(hostname || '').toLowerCase().split('.');
  if (labels.length <= 2) return labels.join('.');
  const [second, top] = labels.slice(-2);
  const looksLikePublicSuffix = top.length === 2 && second.length <= 3;
  return labels.slice(looksLikePublicSuffix ? -3 : -2).join('.');
}
const MAX_HOSTS = 16;

function cleanHosts(value) {
  if (!Array.isArray(value)) return null;
  const hosts = [
    ...new Set(
      value.map((host) =>
        String(host || '')
          .trim()
          .toLowerCase(),
      ),
    ),
  ].filter(Boolean);
  if (
    !hosts.length ||
    hosts.length > MAX_HOSTS ||
    !hosts.every((host) => HOSTNAME.test(host))
  )
    return null;
  return hosts;
}

/**
 * Validate a local config object. Anything missing or malformed falls back to
 * the example value for that field, and `configured` says whether the real
 * site was supplied at all (the installer warns when it was not).
 * @param {unknown} raw Parsed JSON, or null when there is no local file.
 * @returns {{feedUrl: string, feedOrigin: string, imageHosts: string[], cloudHostSuffixes: string[], configured: boolean, problems: string[]}}
 */
export function parsePrivateCctvFeedConfig(raw) {
  const problems = [];
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  let feedUrl = PRIVATE_CCTV_FEED_DEFAULTS.feedUrl;
  let configured = false;
  // Kept apart from `configured`: knowing which site is the vendor's protects
  // the saved login even when the relay's picture hosts are missing or wrong.
  let feedUrlValid = false;
  if (source?.feedUrl !== undefined) {
    try {
      const parsed = new URL(String(source.feedUrl));
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        !HOSTNAME.test(parsed.hostname)
      ) {
        throw new Error('not a plain https address');
      }
      feedUrl = parsed.toString();
      configured = true;
      feedUrlValid = true;
    } catch {
      problems.push(
        'feedUrl must be an https address without a login, for example https://cameras.example.com/#/feed',
      );
    }
  }
  let imageHosts = [...PRIVATE_CCTV_FEED_DEFAULTS.imageHosts];
  if (source?.imageHosts !== undefined) {
    const hosts = cleanHosts(source.imageHosts);
    if (hosts) imageHosts = hosts;
    else {
      configured = false;
      problems.push(`imageHosts must be 1 to ${MAX_HOSTS} plain host names`);
    }
  } else if (configured) {
    configured = false;
    problems.push('imageHosts is required alongside feedUrl');
  }
  const feedOrigin = new URL(feedUrl).origin;
  let cloudHostSuffixes = feedUrlValid
    ? [sharedHostSuffix(new URL(feedUrl).hostname)]
    : [...PRIVATE_CCTV_FEED_DEFAULTS.cloudHostSuffixes];
  if (source?.cloudHostSuffixes !== undefined) {
    const suffixes = cleanHosts(source.cloudHostSuffixes);
    if (suffixes) cloudHostSuffixes = suffixes;
    else problems.push('cloudHostSuffixes must be plain host names');
  }
  return {
    feedUrl,
    feedOrigin,
    imageHosts,
    cloudHostSuffixes,
    configured,
    problems,
  };
}

/** Whether a host is one of the vendor's own (a suffix match on whole labels). */
export function hostMatchesSuffixes(host, suffixes) {
  const name = String(host || '').toLowerCase();
  return (suffixes || []).some(
    (suffix) => name === suffix || name.endsWith(`.${suffix}`),
  );
}

/** The installed extension's manifest: the tracked one with the real site and picture hosts. */
export function renderRelayManifest(manifest, config) {
  const localHosts = (manifest.host_permissions || []).filter((entry) =>
    /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(entry),
  );
  return {
    ...manifest,
    content_scripts: (manifest.content_scripts || []).map((script) => ({
      ...script,
      matches: [`${config.feedOrigin}/*`],
    })),
    host_permissions: [
      ...config.imageHosts.map((host) => `https://${host}/*`),
      ...localHosts,
    ],
  };
}

/** The installed extension's relay-config.js. */
export function renderRelayConfigScript(config) {
  const body = JSON.stringify(
    { feedOrigin: config.feedOrigin, imageHosts: config.imageHosts },
    null,
    2,
  );
  return `// Written by the relay installer from ${PRIVATE_CCTV_FEED_LOCAL_CONFIG}.\nglobalThis.GevPrivateCctvFeedConfig = Object.freeze(${body});\n`;
}
