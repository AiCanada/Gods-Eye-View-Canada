/**
 * Ultra Security Package help network: the pure rules.
 * Subscription model: whoever holds one of the owner's tokens marked NETWORK
 * receives the owner's location only while the owner has pressed SEND HELP,
 * and only that: a name, a position, the time, the window end and the
 * incident class. No message, camera, picture, contact, number or history
 * ever rides the network route, and the victim's phone is never texted.
 * The receiver's own server polls the links in its home list with a plain
 * GET over the tailnet only (https *.ts.net names or 100.64.0.0/10
 * literals; never loopback, a LAN, a public name or a credential), treats
 * every byte of an answer as untrusted, composes the plea locally from the
 * incident class and its own reverse geocode, and keeps other people's
 * tokens sealed under the machine-local key with a per-entry AAD so a
 * copied home list yields hashes and ciphertext. Nothing here looks anyone
 * up by number. No file, socket or clock is touched unless the caller
 * passes one, and nothing touches Buffer or node:crypto at import time.
 */
import crypto from 'node:crypto';
import {
  ULTRA_HELP_NAME_LIMIT,
  ULTRA_HELP_TEXT_LIMIT,
  ULTRA_TOKEN_PATTERN,
  ULTRA_TOKEN_SOURCE,
  cleanHelpText,
  ultraTokenSkillFields,
  cleanPosition,
  openUltraToken,
  sealUltraToken,
  ultraMessageId,
  ultraTokenHash,
} from './ultraTokens.mjs';
import { ultraDistanceKm, ultraHelpMessage } from './ultraHelp.mjs';

export const ULTRA_RELEASE_WINDOW_MS = 14_400_000;
export const ULTRA_CLOCK_MARGIN_MS = 120_000;
export const ULTRA_NETWORK_POLL_MS = 20_000;
export const ULTRA_NETWORK_TICK_MS = 5_000;
export const ULTRA_NETWORK_TIMEOUT_MS = 5_000;
export const ULTRA_NETWORK_ANSWER_LIMIT = 4096;
export const ULTRA_NETWORK_CONCURRENCY = 4;
/**
 * The most polls in flight at once, however long the home list is. Four a
 * tick is the floor; a list too long to walk inside one poll period raises
 * the batch up to this, and past it the oldest-due go first so a long list
 * degrades in latency rather than starving anyone.
 */
export const ULTRA_NETWORK_MAX_IN_FLIGHT = 16;
export const ULTRA_NETWORK_BACKOFF_BASE_MS = 20_000;
export const ULTRA_NETWORK_BACKOFF_MAX_MS = 600_000;
export const ULTRA_NETWORK_DEAD_MS = 600_000;
export const ULTRA_NETWORK_BUSY_MS = 60_000;
export const ULTRA_NETWORK_ENTRY_LIMIT = 200;
/**
 * The most links one directory pull may leave polled on one machine. Every
 * link to a machine is polled from this one address, and a peer allows an
 * address 60 requests and 20 misses a minute, so rows a directory invents
 * for one machine must stay well under that budget, or they would spend it
 * and get that machine's real link a 429 in the middle of a call for help.
 * A link the owner adds by hand is never held to it.
 */
export const ULTRA_NETWORK_HOST_ENTRY_LIMIT = 8;
export const ULTRA_NETWORK_STALE_MS = 120_000;
export const ULTRA_NETWORK_EPISODE_GAP_MS = 600_000;
export const ULTRA_DIRECTORY_LIMIT = 500;
export const ULTRA_DIRECTORY_BYTES = 262_144;
export const ULTRA_DIRECTORY_TIMEOUT_MS = 10_000;
export const ULTRA_GITHUB_TIMEOUT_MS = 15_000;
export const ULTRA_GEOCODE_TIMEOUT_MS = 5_000;
export const ULTRA_GEOCODE_SPACING_MS = 1_000;
export const ULTRA_GEOCODE_MOVE_M = 50;
/** A reverse geocode that failed is asked again this long after, not on every poll. */
export const ULTRA_GEOCODE_RETRY_MS = 60_000;
export const ULTRA_WATCHING_MS = 60_000;
export const ULTRA_PHONE_HELP_LIMIT = Object.freeze({
  max: 6,
  windowMs: 60_000,
});
export const ULTRA_INCIDENTS = Object.freeze([
  'threat',
  'fire',
  'medical',
  'other',
]);
/**
 * A whole help link: http(s), a host with no userinfo, query or hash, the
 * fixed /ultra/help/ path and one token, optionally a trailing slash. The
 * host part is checked separately by ultraTailnetTarget.
 */
export const ULTRA_HELP_LINK_PATTERN = new RegExp(
  `^https?:\\/\\/[^\\s/?#@]+\\/ultra\\/help\\/${ULTRA_TOKEN_SOURCE}\\/?$`,
);
export const ULTRA_HELP_LINK_LIMIT = 512;
export const ULTRA_NETWORK_ID_PATTERN = /^n-[0-9a-f]{16}$/;
export const ULTRA_NETWORK_STATES = Object.freeze([
  'new',
  'quiet',
  'released',
  'off',
  'dead',
  'unreachable',
  'busy',
  'not-tailnet',
  'missing',
  'moved',
  'own',
  'no-key',
  'tampered',
]);
/** The AAD prefix that keeps a home-list blob out of the owner's own token store and back. */
export const ULTRA_NETWORK_AAD = 'ultra-network:';
export const ULTRA_NETWORK_PLACE_LIMIT = 160;
export const ULTRA_NETWORK_PIN_COLOR = '#ffb000';

const FEED_ID_LIMIT = 80;
const PIN_NAME_LIMIT = 80;
const PIN_LABEL_LIMIT = 30;
const DIRECTORY_URL_LIMIT = 2048;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_ID_PATTERN = /^t-[0-9a-f]{16}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// At least one label before ts.net: 'ts.net' alone names nobody's machine.
const TS_NET_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/;
const TAILNET_IPV6 = /^fd7a:115c:a1e0:[0-9a-f:]*$/i;
const LOOPBACK_ADDRESS = /^(127\.|::1$)/;
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;
const HUGGING_FACE_HOSTS = new Set([
  'huggingface.co',
  'www.huggingface.co',
  'hf.co',
]);
const HUGGING_FACE_FILE = new Set(['blob', 'resolve', 'raw']);
const DIRECTORY_MAIL_SUBJECT = 'GEVC Ultra help directory entry';
const DIRECTORY_MAIL_LEAD =
  'Please add this entry to our Ultra help directory:\n\n';

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A number a peer sent, or null: only a real finite JSON number counts, never a string. */
function peerNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ipv4Octets(hostname) {
  const m = IPV4_PATTERN.exec(hostname);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** Whether an IPv4 literal is in 100.64.0.0/10, the range Tailscale hands out. */
export function ultraTailnetAddress(hostname) {
  const octets = ipv4Octets(String(hostname ?? '').trim());
  return !!octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/**
 * Whether a client address is on the tailnet: 100.64.0.0/10, or Tailscale's
 * IPv6 range fd7a:115c:a1e0::/48 (as Node and tailscale print it, the three
 * leading groups are always written out).
 */
function tailnetClient(address) {
  const text = String(address ?? '')
    .trim()
    .replace(/^::ffff:/i, '');
  return ultraTailnetAddress(text) || TAILNET_IPV6.test(text);
}

/**
 * Whether a Host header names this machine the way a tailnet poll does: a
 * *.ts.net name, an address, or localhost. A DNS-rebinding page sends its
 * own public name here, so its Origin and Host can still agree.
 */
function holderHostAllowed(host) {
  const text = String(host ?? '')
    .trim()
    .toLowerCase();
  if (!text || text.length > 300 || /[\s/\\?#@]/.test(text)) return false;
  let hostname;
  try {
    hostname = new URL(`http://${text}`).hostname;
  } catch {
    return false;
  }
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    TS_NET_NAME.test(hostname) ||
    !!ipv4Octets(hostname) ||
    /^\[[0-9a-f:.]+\]$/.test(hostname)
  );
}

/**
 * Whether a help-link holder may be answered at all. The help network is
 * reached over Tailscale only (owner decision), and a published token is
 * often in a file anyone can read, so the tailnet is its second factor: the
 * asker must be a tailnet address, or this machine itself with no proxy in
 * between. Behind tailscale serve the socket is loopback and the asker is
 * the one forwarded address tailscale writes; a chain of proxies is not
 * that, and is refused. The Host must be one a tailnet poll sends, so a
 * rebinding page in a tailnet browser is refused too. Everyone else (a LAN
 * neighbour, a Funnel visitor) gets the 404 an unknown token gets.
 */
export function ultraHolderReachable({
  remoteAddress,
  forwardedFor,
  host,
} = {}) {
  const socket = String(remoteAddress ?? '')
    .trim()
    .replace(/^::ffff:/i, '');
  const hops = String(forwardedFor ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  if (LOOPBACK_ADDRESS.test(socket)) {
    if (hops.length > 1) return false;
    if (hops.length === 1 && !tailnetClient(hops[0])) return false;
  } else if (!tailnetClient(socket)) {
    return false;
  }
  return holderHostAllowed(host);
}

/**
 * The one reachability rule for a poll target: an https link whose name
 * ends in .ts.net (with a label before it), or an http(s) link to a
 * 100.64.0.0/10 literal. Everything else is refused: loopback, 10/8,
 * 172.16/12, 192.168/16, 169.254/16, 0.0.0.0, multicast, *.local, a
 * single-label name, an IPv6 literal and every public name. Enforced at
 * ADD, at every directory merge and again on the decrypted link right
 * before each poll, so the poller can never be turned against the
 * receiver's own machine or LAN.
 */
export function ultraTailnetTarget({ scheme, hostname } = {}) {
  const proto = String(scheme ?? '')
    .trim()
    .toLowerCase()
    .replace(/:$/, '');
  const host = String(hostname ?? '')
    .trim()
    .toLowerCase();
  if (!host) return false;
  if (proto === 'https' && TS_NET_NAME.test(host)) return true;
  if ((proto === 'https' || proto === 'http') && ultraTailnetAddress(host))
    return true;
  return false;
}

/** An http(s) origin with nothing after the host, as { scheme, host, hostname, origin }, or null. */
function parseBase(value) {
  if (typeof value !== 'string' || value.length > ULTRA_HELP_LINK_LIMIT)
    return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/') return null;
  return {
    scheme: url.protocol.replace(/:$/, ''),
    host: url.host,
    hostname: url.hostname,
    origin: url.origin,
  };
}

/**
 * The parts of a whole help link, or null when it is anything else: a bare
 * token, a query, a hash, userinfo, a trailing /network or /status, a
 * short token, more than 512 characters. `base` is the origin the poller
 * uses, `host` what the owner sees, `token` the peer's bearer secret.
 */
export function parseUltraHelpLink(link) {
  if (typeof link !== 'string') return null;
  const text = link.trim();
  if (!text || text.length > ULTRA_HELP_LINK_LIMIT) return null;
  if (!ULTRA_HELP_LINK_PATTERN.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const parts = url.pathname.replace(/\/+$/, '').split('/');
  if (parts.length !== 4 || parts[1] !== 'ultra' || parts[2] !== 'help')
    return null;
  const token = parts[3];
  if (!ULTRA_TOKEN_PATTERN.test(token)) return null;
  const scheme = url.protocol.replace(/:$/, '');
  if (scheme !== 'https' && scheme !== 'http') return null;
  return {
    scheme,
    host: url.host,
    hostname: url.hostname,
    base: url.origin,
    token,
  };
}

/**
 * The only URL a home-list link is ever used for, re-checked against the
 * tailnet rule right before the call, or null when the link no longer
 * passes (the entry then reads NOT A TAILNET LINK and is not polled).
 */
export function ultraNetworkPollTarget(link) {
  const parts = parseUltraHelpLink(link);
  if (!parts || !ultraTailnetTarget(parts)) return null;
  return {
    url: `${parts.base}/ultra/help/${parts.token}/network`,
    host: parts.host,
    base: parts.base,
  };
}

/**
 * The origin a help-network link must carry, chosen from the addresses the
 * report listener answers on: the first https *.ts.net name, else the first
 * plain-http 100.64.0.0/10 literal, else '' — never a LAN or public address,
 * which every receiver's poller refuses, and never https to a bare address,
 * which no certificate can name (`tailscale cert` issues only for the
 * *.ts.net name), so every receiver's fetch would fail on it. The
 * listener's first address (whatever it is) still serves the phone link and
 * message-only tokens.
 */
export function ultraTailnetBase(bases) {
  const origins = (Array.isArray(bases) ? bases : [])
    .map((base) => parseBase(typeof base === 'string' ? base : ''))
    .filter((origin) => origin && ultraTailnetTarget(origin));
  const named = origins.find(
    (origin) => origin.scheme === 'https' && TS_NET_NAME.test(origin.hostname),
  );
  const literal = origins.find(
    (origin) =>
      origin.scheme === 'http' && ultraTailnetAddress(origin.hostname),
  );
  return (named || literal)?.origin || '';
}

/** The link a home-list entry was made from, rebuilt from its base and the opened token. */
export function ultraHelpLinkFor(base, token) {
  const origin = parseBase(base);
  if (!origin || !ULTRA_TOKEN_PATTERN.test(String(token ?? ''))) return '';
  return `${origin.origin}/ultra/help/${token}`;
}

/** Whether a directory host is somewhere on the public internet (or a tailnet), never this machine or its LAN. */
function directoryHostAllowed(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (!host || host.startsWith('[')) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || !host.includes('.')) return false;
  const octets = ipv4Octets(host);
  if (!octets) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

/**
 * A Hugging Face file page or download address (<o>/<r>/blob/<ref>/<path>,
 * or resolve, also under datasets/ or spaces/) as the /raw/ address that
 * serves the file itself, or '' for anything else. The download address
 * answers with a redirect and the page with HTML, and the directory is read
 * with no redirect followed.
 */
function huggingFaceRawUrl(url) {
  const segments = url.pathname.split('/').filter(Boolean);
  const repo = segments[0] === 'datasets' || segments[0] === 'spaces' ? 3 : 2;
  if (!HUGGING_FACE_FILE.has(segments[repo]) || segments.length < repo + 3)
    return '';
  return `https://huggingface.co/${[
    ...segments.slice(0, repo),
    'raw',
    ...segments.slice(repo + 1),
  ].join('/')}`;
}

/**
 * The https URL the directory is read from, or '' when the address is
 * refused: http, ftp, userinfo, localhost, a loopback, link-local or
 * RFC1918 literal, an IPv6 literal. A github.com blob page is rewritten to
 * the raw file it shows, and a Hugging Face file page or download address
 * to its /raw/ address; a fragment is dropped (it never goes on the wire).
 */
export function ultraDirectoryUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > DIRECTORY_URL_LIMIT) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  if (!directoryHostAllowed(url.hostname)) return '';
  url.hash = '';
  const host = url.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    const api = githubDirectoryApi(url.href);
    if (api) {
      return `https://raw.githubusercontent.com/${api.owner}/${api.repo}/${api.ref}/${api.path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
    }
  }
  if (HUGGING_FACE_HOSTS.has(host)) {
    const file = huggingFaceRawUrl(url);
    if (file) return file;
  }
  return url.href;
}

/** The directory address as the owner sees it: origin and path, never a query string (it could carry a secret). */
export function displayDirectoryUrl(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    return parsed.origin + parsed.pathname;
  } catch {
    return '';
  }
}

/** A home-list entry id is random, never derived from the peer's token. */
export function ultraNetworkEntryId(randomBytes = crypto.randomBytes) {
  return 'n-' + randomBytes(8).toString('hex');
}

/** Seal a peer's token for the home list: the owner's key, the entry id and the network AAD. */
export function sealUltraNetworkToken(token, key, { id, randomBytes } = {}) {
  return sealUltraToken(token, key, {
    id,
    randomBytes,
    aad: ULTRA_NETWORK_AAD,
  });
}

/** The peer token a home-list blob holds, or null: a blob from the owner's own token store never opens here. */
export function openUltraNetworkToken(sealed, key, { id } = {}) {
  return openUltraToken(sealed, key, { id, aad: ULTRA_NETWORK_AAD });
}

const NETWORK_POLICY_TAG = 'ultra-network-policy:v1';
const HELP_POLICY_TAG = 'ultra-help-policy:v1';

/** A length-prefixed field, so one value that contains a newline cannot slide into the next. */
function policyText(value) {
  const text = String(value ?? '');
  return `${Buffer.byteLength(text, 'utf8')}:${text}`;
}

/** A finite number, or '-' when the field is empty. Null and a missing field encode the same. */
function policyNum(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-';
}

/**
 * The bytes a home-list check covers: the id, the origin the opened token
 * is sent to, and the hash of that token. Not the display name, the skill
 * labels, the poll word or the ciphertext. The ciphertext is already bound
 * to the id by its AAD; the check is what stops that opened token being
 * sent to some other tailnet host.
 */
function networkPolicyCanonical(entry) {
  return [
    NETWORK_POLICY_TAG,
    policyText(entry?.id),
    policyText(entry?.base),
    policyText(entry?.hash),
  ].join('\n');
}

/** HMAC-SHA256 of where this home-list entry points, or '' when the key cannot make one. */
export function ultraNetworkPolicyMac(entry, key) {
  if (!entry || typeof entry !== 'object') return '';
  if (!Buffer.isBuffer(key) || key.length !== 32) return '';
  return crypto
    .createHmac('sha256', key)
    .update(networkPolicyCanonical(entry), 'utf8')
    .digest('hex');
}

/** 'legacy' with no check, 'ok' when it matches, 'bad' when a check is present and does not. */
export function ultraNetworkPolicyState(entry, key) {
  const mac = entry?.policyMac;
  if (mac === undefined || mac === null || mac === '') return 'legacy';
  if (typeof mac !== 'string' || !HASH_PATTERN.test(mac)) return 'bad';
  if (!Buffer.isBuffer(key) || key.length !== 32) return 'bad';
  const expected = ultraNetworkPolicyMac(entry, key);
  if (!HASH_PATTERN.test(expected)) return 'bad';
  return crypto.timingSafeEqual(
    Buffer.from(mac, 'hex'),
    Buffer.from(expected, 'hex'),
  )
    ? 'ok'
    : 'bad';
}

/** The entry with a fresh check. Unchanged when the key cannot make one. Skills and the seal are kept. */
export function stampUltraNetworkPolicy(entry, key) {
  const policyMac = ultraNetworkPolicyMac(entry, key);
  if (!policyMac) return entry;
  return { ...entry, policyMac };
}

function networkEntryCarriesPolicyMac(entry) {
  const mac = entry?.policyMac;
  return mac !== undefined && mac !== null && mac !== '';
}

/** True when any home-list entry carries a check, including one that does not verify. */
export function ultraNetworkStoreHasPolicyMac(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list.some(networkEntryCarriesPolicyMac);
}

function networkEntryToken(entry, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return '';
  return openUltraNetworkToken(entry?.sealed, key, { id: entry?.id }) || '';
}

/**
 * Whether this entry may be polled. The seal has to open onto the stored
 * hash, and the check has to match — or be absent on every entry, which is
 * a home list from before the check. A missing or wrong check beside one
 * that is present is not polled: that is a rewritten base, and the opened
 * token must not be sent there.
 */
export function ultraNetworkPollAllowed(entry, entries, key) {
  const token = networkEntryToken(entry, key);
  if (!token || ultraTokenHash(token) !== entry?.hash) return false;
  const state = ultraNetworkPolicyState(entry, key);
  if (state === 'ok') return true;
  const hasMac = ultraNetworkStoreHasPolicyMac(entries);
  return state === 'legacy' && !hasMac;
}

/**
 * Per-entry tamper flags for the owner's rows. False when the key cannot
 * be used or it opens no seal in the list: that is a missing or replaced
 * key. An entry is tampered when its seal opens and the check does not,
 * when its check is missing while another entry still has one, when the
 * opened token is not the stored hash, or when its seal will not open
 * while some other seal in the list does.
 */
export function ultraNetworkTamperFlags(entries, key) {
  const list = Array.isArray(entries) ? entries : [];
  const flags = new Array(list.length).fill(false);
  if (!Buffer.isBuffer(key) || key.length !== 32) return flags;
  const tokens = list.map((entry) => networkEntryToken(entry, key));
  if (!tokens.some(Boolean)) return flags;
  const hasMac = ultraNetworkStoreHasPolicyMac(list);
  for (let i = 0; i < list.length; i += 1) {
    const token = tokens[i];
    if (!token || ultraTokenHash(token) !== list[i]?.hash) {
      flags[i] = true;
      continue;
    }
    const state = ultraNetworkPolicyState(list[i], key);
    flags[i] = state === 'bad' || (state === 'legacy' && hasMac);
  }
  return flags;
}

/**
 * The bytes the helpers-file check covers: the owner's number, each saved
 * helper, and each release as stored. Not the phone model. A changed
 * number, an added helper or a planted call fails it. The check itself is
 * not covered.
 */
function helpPolicyCanonical(store) {
  const contacts = Array.isArray(store?.contacts) ? store.contacts : [];
  const releases = Array.isArray(store?.releases) ? store.releases : [];
  const lines = [
    HELP_POLICY_TAG,
    policyText(store?.owner?.number),
    String(contacts.length),
  ];
  for (const item of contacts) {
    lines.push(
      policyText(item?.id),
      policyText(item?.label),
      policyText(item?.number),
      policyText(item?.kind),
    );
  }
  lines.push(String(releases.length));
  for (const item of releases) {
    lines.push(
      policyText(item?.feedId),
      policyNum(item?.at),
      policyNum(item?.until),
      policyNum(item?.lat),
      policyNum(item?.lon),
      policyNum(item?.fixAt),
      policyNum(item?.renewedAt),
      policyText(item?.incident),
    );
  }
  return lines.join('\n');
}

/** HMAC-SHA256 of the helpers file's number, contacts and releases, or '' when the key cannot make one. */
export function ultraHelpStorePolicyMac(store, key) {
  if (!store || typeof store !== 'object') return '';
  if (!Buffer.isBuffer(key) || key.length !== 32) return '';
  return crypto
    .createHmac('sha256', key)
    .update(helpPolicyCanonical(store), 'utf8')
    .digest('hex');
}

/** 'legacy' with no check, 'ok' when it matches, 'bad' when a check is present and does not. */
export function ultraHelpStorePolicyState(store, key) {
  const mac = store?.policyMac;
  if (mac === undefined || mac === null || mac === '') return 'legacy';
  if (typeof mac !== 'string' || !HASH_PATTERN.test(mac)) return 'bad';
  if (!Buffer.isBuffer(key) || key.length !== 32) return 'bad';
  const expected = ultraHelpStorePolicyMac(store, key);
  if (!HASH_PATTERN.test(expected)) return 'bad';
  return crypto.timingSafeEqual(
    Buffer.from(mac, 'hex'),
    Buffer.from(expected, 'hex'),
  )
    ? 'ok'
    : 'bad';
}

const DIRECTORY_POLICY_TAG = 'ultra-directory-policy:v1';
const RELAY_POLICY_TAG = 'ultra-relay-policy:v1';
const FEEDS_POLICY_TAG = 'ultra-feeds-policy:v1';
const FEED_POLICY_FIELDS = [
  'id',
  'name',
  'method',
  'reportKey',
  'url',
  'pictureUrl',
  'auth',
  'username',
  'password',
  'token',
  'keyName',
];

/**
 * 'legacy' when no check was stored, 'ok' when it matches the expected
 * bytes, 'bad' when a check is present and does not. A key that cannot
 * make a check is 'bad' once a check is stored: the caller trusts that
 * only when this key opens nothing.
 */
export function ultraOutboundPolicyState(stored, expected, key) {
  if (stored === undefined || stored === null || stored === '') return 'legacy';
  if (typeof stored !== 'string' || !HASH_PATTERN.test(stored)) return 'bad';
  if (!Buffer.isBuffer(key) || key.length !== 32) return 'bad';
  if (typeof expected !== 'string' || !HASH_PATTERN.test(expected)) return 'bad';
  return crypto.timingSafeEqual(
    Buffer.from(stored, 'hex'),
    Buffer.from(expected, 'hex'),
  )
    ? 'ok'
    : 'bad';
}

function outboundPolicyMac(tag, lines, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return '';
  return crypto
    .createHmac('sha256', key)
    .update([tag, ...lines].join('\n'), 'utf8')
    .digest('hex');
}

/**
 * The bytes the directory check covers: the address the directory is read
 * from, and the write token that would be sent with a publish. Both empty
 * when they are not set. The check is not the address itself.
 */
export function ultraDirectoryPolicyMac(material, key) {
  return outboundPolicyMac(
    DIRECTORY_POLICY_TAG,
    [policyText(material?.url), policyText(material?.writeToken)],
    key,
  );
}

/**
 * The bytes the SMS-relay check covers: the Twilio account, its auth token
 * and from-number, and the gateway address and bearer token. A gateway that
 * is saved but not the one in use is still covered, so it cannot wait until
 * the Twilio values are taken out. An empty field is one the relay would
 * not use.
 */
export function ultraRelayPolicyMac(material, key) {
  return outboundPolicyMac(
    RELAY_POLICY_TAG,
    [
      policyText(material?.sid),
      policyText(material?.auth),
      policyText(material?.from),
      policyText(material?.url),
      policyText(material?.token),
    ],
    key,
  );
}

/**
 * The bytes the phone-package check covers: each security package, in the
 * order the file keeps them, and only the fields that decide which key is
 * admitted and where a position or a picture is fetched. Not where the map
 * last put the phone, and not follow or record.
 */
export function ultraFeedsPolicyMac(feeds, key) {
  const list = Array.isArray(feeds) ? feeds : [];
  const lines = [String(list.length)];
  for (const feed of list) {
    for (const field of FEED_POLICY_FIELDS) lines.push(policyText(feed?.[field]));
  }
  return outboundPolicyMac(FEEDS_POLICY_TAG, lines, key);
}

/** One of the four incident classes; anything else, including a missing value, is 'other'. */
export function ultraIncident(value) {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ULTRA_INCIDENTS.includes(word) ? word : 'other';
}

/** The coordinates-only place, exactly as the server's street address falls back to it. */
export function ultraCoordinatesPlace(fix) {
  const { lat, lon } = cleanPosition(fix?.lat, fix?.lon);
  return lat === null ? '' : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

function clockTime(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** HH:MM on this machine's clock, as the rows, pins and relay outcomes paint it. */
export function ultraClockTime(ms) {
  return clockTime(ms);
}

/**
 * The owner's own release as config/ultra-help.json holds it, or null when
 * it is unusable or over: finite times, until still ahead of now, a clean
 * position, the incident coerced to the enum.
 */
export function normalizeUltraRelease(item, now) {
  if (!item || typeof item !== 'object') return null;
  const at = finiteOrNull(item.at);
  const until = finiteOrNull(item.until);
  if (at === null || until === null || !(until > Number(now))) return null;
  const { lat, lon } = cleanPosition(item.lat, item.lon);
  if (lat === null) return null;
  return {
    at,
    until,
    lat,
    lon,
    fixAt: finiteOrNull(item.fixAt) ?? at,
    // A file written before EXTEND was stamped: every press set the window
    // to four hours from itself, so the last one was `until` less four hours.
    // Either way a renewal lies between the first press and the window's end.
    renewedAt: Math.min(
      until,
      Math.max(
        at,
        finiteOrNull(item.renewedAt) ?? until - ULTRA_RELEASE_WINDOW_MS,
      ),
    ),
    feedId: String(item.feedId ?? '')
      .trim()
      .slice(0, FEED_ID_LIMIT),
    incident: ultraIncident(item.incident),
  };
}

/**
 * The release one SEND HELP press records, or null without a usable fix.
 * While a release for the same feed is still active the press is EXTEND
 * HELP: `at` stays (the time help was first sent), `renewedAt` and `until`
 * move to this press, and the fix is refreshed unless the one given is
 * older than the fix the release already carries (then that one stays).
 */
export function newUltraRelease({
  now,
  fix,
  feedId,
  incident,
  previous = null,
} = {}) {
  const at = Number(now);
  if (!Number.isFinite(at)) return null;
  const { lat, lon } = cleanPosition(fix?.lat, fix?.lon);
  if (lat === null) return null;
  const id = String(feedId ?? '')
    .trim()
    .slice(0, FEED_ID_LIMIT);
  const active =
    !!previous &&
    typeof previous === 'object' &&
    previous.feedId === id &&
    finiteOrNull(previous.at) !== null &&
    Number(previous.until) > at;
  const fixAt = finiteOrNull(fix?.at) ?? at;
  const kept = active ? cleanPosition(previous.lat, previous.lon) : null;
  const keptAt = active ? finiteOrNull(previous.fixAt) : null;
  const keep = kept && kept.lat !== null && keptAt !== null && keptAt > fixAt;
  return {
    at: active ? Number(previous.at) : at,
    until: at + ULTRA_RELEASE_WINDOW_MS,
    lat: keep ? kept.lat : lat,
    lon: keep ? kept.lon : lon,
    fixAt: keep ? keptAt : fixAt,
    renewedAt: at,
    feedId: id,
    incident: ultraIncident(incident),
  };
}

/**
 * Exactly what a NETWORK token holder is answered at
 * /ultra/help/<token>/network, one of two shapes and never another key:
 * { released: false } until the owner presses SEND HELP, or
 * { released: true, name, lat, lon, at, until, incident } while the
 * release for that feed is inside its window. The served position is the
 * phone's latest fix when it is newer than the fix recorded at the press,
 * else that fix; `at` is when this release last changed — the press, the
 * last EXTEND HELP or the served fix, whichever is latest — so a receiver
 * that reads an `at` more than four hours old as stale never ends a call
 * its owner has just extended. A release whose served position is unusable
 * reads as not released. When `feedId` is given the release must belong to it.
 */
export function ultraReleaseAnswer({
  release,
  fix = null,
  name,
  now,
  feedId,
} = {}) {
  const quiet = { released: false };
  if (!release || typeof release !== 'object') return quiet;
  const at = Number(now);
  if (!Number.isFinite(at) || !(Number(release.until) > at)) return quiet;
  if (feedId !== undefined && release.feedId !== feedId) return quiet;
  const pressAt = finiteOrNull(release.at);
  if (pressAt === null) return quiet;
  const storedAt = finiteOrNull(release.fixAt) ?? pressAt;
  const liveAt = finiteOrNull(fix?.at);
  const served =
    fix && typeof fix === 'object' && liveAt !== null && liveAt > storedAt
      ? { lat: fix.lat, lon: fix.lon, at: liveAt }
      : { lat: release.lat, lon: release.lon, at: storedAt };
  const { lat, lon } = cleanPosition(served.lat, served.lon);
  if (lat === null) return quiet;
  const renewedAt = finiteOrNull(release.renewedAt) ?? pressAt;
  return {
    released: true,
    name: cleanHelpText(name, ULTRA_HELP_NAME_LIMIT) || 'Ultra',
    lat,
    lon,
    at: Math.max(pressAt, renewedAt, served.at),
    until: Number(release.until),
    incident: ultraIncident(release.incident),
  };
}

/**
 * A peer's poll answer, every field untrusted: `released` must be a
 * boolean (anything else is an unreadable answer, null); false is quiet;
 * true needs real JSON numbers for lat, lon, at and until (a clean
 * position, else quiet), an incident coerced to the enum and a name cut at
 * 60 (the home-list name when empty). Their window is re-based on this
 * machine's clock: now + what is left on theirs, clamped to four hours.
 * What is left is measured from the peer's own clock at the moment it
 * answered (`peerNow`, the HTTP Date header its server sends), so a skewed
 * peer clock can neither shorten nor prolong a call; without that header
 * it falls back to their `at` (the press, the last EXTEND or the last fix),
 * which can only overstate it. A window closed on their clock by more than
 * the two-minute margin, or an `at` more than the window plus that margin
 * away in either direction, is stale or badly skewed and reads as quiet.
 * Only real JSON numbers count for the position and the times: a string,
 * NaN or a missing field is not a number.
 */
export function normalizeUltraNetworkAnswer(
  body,
  { now, entryName = '', peerNow = null } = {},
) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.released !== 'boolean') return null;
  const quiet = { state: 'quiet' };
  if (body.released === false) return quiet;
  const at = Number(now);
  if (!Number.isFinite(at)) return null;
  if (peerNumber(body.lat) === null || peerNumber(body.lon) === null)
    return quiet;
  const { lat, lon } = cleanPosition(body.lat, body.lon);
  if (lat === null) return quiet;
  const theirAt = peerNumber(body.at);
  const theirUntil = peerNumber(body.until);
  if (theirAt === null || theirUntil === null) return quiet;
  const theirNow = finiteOrNull(peerNow) ?? theirAt;
  const remaining = theirUntil - theirNow;
  if (remaining <= -ULTRA_CLOCK_MARGIN_MS) return quiet;
  if (Math.abs(at - theirAt) > ULTRA_RELEASE_WINDOW_MS + ULTRA_CLOCK_MARGIN_MS)
    return quiet;
  const until = at + Math.min(Math.max(remaining, 0), ULTRA_RELEASE_WINDOW_MS);
  return {
    state: 'released',
    release: {
      name:
        cleanHelpText(body.name, ULTRA_HELP_NAME_LIMIT) ||
        cleanHelpText(entryName, ULTRA_HELP_NAME_LIMIT),
      lat,
      lon,
      at: theirAt,
      until,
      incident: ultraIncident(body.incident),
    },
  };
}

/**
 * What one poll of an entry leaves behind: the state word, when to poll
 * again and the failure count. 200 with a readable answer polls again in
 * 20 s and clears the failures; 404 is a dead link retried in ten minutes
 * (one miss per ten minutes toward the peer's miss budget); 429 is busy,
 * back in a minute; anything else (a transport error, a timeout, an
 * unreadable answer, another status) is unreachable with the backoff
 * 20 s × 2^(failures − 1), capped at ten minutes.
 */
export function ultraPollOutcome({
  status,
  answer = null,
  failures = 0,
  now,
} = {}) {
  const at = Number(now);
  const code = Number(status);
  const had = Math.max(0, Math.floor(Number(failures) || 0));
  if (
    code === 200 &&
    answer &&
    typeof answer === 'object' &&
    (answer.state === 'quiet' || answer.state === 'released')
  ) {
    return {
      state: answer.state,
      nextAt: at + ULTRA_NETWORK_POLL_MS,
      failures: 0,
    };
  }
  if (code === 404)
    return { state: 'dead', nextAt: at + ULTRA_NETWORK_DEAD_MS, failures: had };
  if (code === 429)
    return { state: 'busy', nextAt: at + ULTRA_NETWORK_BUSY_MS, failures: had };
  const next = had + 1;
  const wait = Math.min(
    ULTRA_NETWORK_BACKOFF_MAX_MS,
    ULTRA_NETWORK_BACKOFF_BASE_MS * 2 ** (next - 1),
  );
  return { state: 'unreachable', nextAt: at + wait, failures: next };
}

/**
 * What a readable answer means for the entry's episode (its NEEDS HELP
 * row): 'new' opens a row (notify, speech, SMS once); 'update' moves the
 * existing row's position, window and name with no new row, notify or SMS,
 * both while the episode is active and inside the ten-minute gap after it
 * ended (the row is reused), so a flapping or hostile peer cannot fill the
 * inbox, the speaker or the relay budget; 'end' closes an active episode
 * on a quiet answer; 'none' changes nothing, including a released answer
 * inside the gap when the owner has removed the row (nothing to reuse and
 * too soon for a new one). `entry` is the memory record: episodeId (the
 * row id, kept after the episode ends so the row can be reused; cleared
 * when the row is removed), episodeUntil (the row's local window end) and
 * lastEpisodeAt (when it last ended).
 */
export function ultraEpisodeDecision({ entry, answer, now } = {}) {
  if (!answer || typeof answer !== 'object') return 'none';
  const at = Number(now);
  const memory = entry && typeof entry === 'object' ? entry : {};
  const hasRow = Boolean(memory.episodeId);
  const until = finiteOrNull(memory.episodeUntil);
  const active = hasRow && until !== null && until > at;
  if (answer.state === 'quiet') return active ? 'end' : 'none';
  if (answer.state !== 'released') return 'none';
  if (active) return 'update';
  const endedAt = Math.max(
    finiteOrNull(memory.lastEpisodeAt) ?? -Infinity,
    hasRow ? (until ?? -Infinity) : -Infinity,
  );
  const recent =
    Number.isFinite(endedAt) && at - endedAt < ULTRA_NETWORK_EPISODE_GAP_MS;
  if (recent) return hasRow ? 'update' : 'none';
  return 'new';
}

function messageIdFrom(ids) {
  if (typeof ids === 'function') return ids();
  if (typeof ids?.message === 'function') return ids.message();
  return ultraMessageId(ids?.randomBytes);
}

/**
 * The HELP MESSAGES row a new episode opens: kind 'release', the home-list
 * entry it came through, the peer's cleaned name, the place (coordinates
 * alone until the reverse geocode lands), the plea composed here from the
 * incident and that place, the local window end, never a number. `answer`
 * is a normalised poll answer or its `release`.
 */
export function ultraReleaseInboxRecord({
  entry,
  answer,
  now,
  place,
  plea,
  ids,
} = {}) {
  const release = answer?.release || answer;
  if (!release || typeof release !== 'object') return null;
  const { lat, lon } = cleanPosition(release.lat, release.lon);
  if (lat === null) return null;
  const at = Number(now);
  if (!Number.isFinite(at)) return null;
  const incident = ultraIncident(release.incident);
  const label = cleanHelpText(entry?.name, ULTRA_HELP_NAME_LIMIT);
  const where =
    cleanHelpText(place, ULTRA_NETWORK_PLACE_LIMIT) ||
    ultraCoordinatesPlace({ lat, lon });
  const text =
    cleanHelpText(plea, ULTRA_HELP_TEXT_LIMIT) ||
    ultraHelpMessage(where, incident);
  return {
    id: messageIdFrom(ids),
    tokenId: '',
    kind: 'release',
    networkId: String(entry?.id ?? ''),
    label,
    from: cleanHelpText(release.name, ULTRA_HELP_NAME_LIMIT) || label,
    number: '',
    text,
    place: where,
    incident,
    lat,
    lon,
    at,
    until: finiteOrNull(release.until) ?? at,
    sms: '',
    deliveredAt: null,
    readAt: null,
  };
}

/**
 * The same row after a later answer: position, window end, name and
 * incident follow the answer; `at` moves to now only when the position
 * moved more than 50 m; `place` and `plea` replace the row's when given
 * (the receiver's geocode), else the plea is recomposed only if the place
 * or incident changed. Returns a new row; the given one is not touched.
 */
export function ultraReleaseRowUpdate(row, answer, { place, plea, now } = {}) {
  const release = answer?.release || answer || {};
  const { lat, lon } = cleanPosition(release.lat, release.lon);
  const position = lat === null ? { lat: row.lat, lon: row.lon } : { lat, lon };
  const movedKm = lat === null ? null : ultraDistanceKm(row, position);
  const moved = movedKm !== null && movedKm * 1000 > ULTRA_GEOCODE_MOVE_M;
  const incident =
    'incident' in release ? ultraIncident(release.incident) : row.incident;
  const where =
    place === undefined
      ? row.place
      : cleanHelpText(place, ULTRA_NETWORK_PLACE_LIMIT) ||
        ultraCoordinatesPlace(position);
  let text;
  if (plea !== undefined) {
    text =
      cleanHelpText(plea, ULTRA_HELP_TEXT_LIMIT) ||
      ultraHelpMessage(where, incident);
  } else if (where !== row.place || incident !== row.incident) {
    text = ultraHelpMessage(where, incident);
  } else {
    text = row.text;
  }
  const clock = finiteOrNull(now);
  return {
    ...row,
    from: cleanHelpText(release.name, ULTRA_HELP_NAME_LIMIT) || row.from,
    ...position,
    incident,
    place: where,
    text,
    at: moved && clock !== null ? clock : row.at,
    until: finiteOrNull(release.until) ?? row.until,
  };
}

/** How many bytes a base64 field decodes to, or 0 when it is not base64 (padding may be missing, as Buffer tolerates). */
function base64Length(value) {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) return 0;
  const body = value.replace(/=+$/, '');
  if (body.length % 4 === 1) return 0;
  return Math.floor((body.length * 3) / 4);
}

function sealedShape(sealed) {
  return (
    !!sealed &&
    typeof sealed === 'object' &&
    sealed.v === 1 &&
    base64Length(sealed.iv) === 12 &&
    base64Length(sealed.tag) === 16 &&
    base64Length(sealed.data) >= 1
  );
}

/**
 * A home-list check kept on the entry. Absent, null or '' is an entry from
 * before the check and is omitted, so an older home list still deep-equals.
 * Anything present that is not 64 hex is kept as 'bad': dropping it would
 * look like an entry that was never checked.
 */
function storedNetworkPolicyMac(item) {
  if (!item || typeof item !== 'object' || !Object.hasOwn(item, 'policyMac'))
    return undefined;
  const mac = item.policyMac;
  if (mac === undefined || mac === null || mac === '') return undefined;
  return typeof mac === 'string' && HASH_PATTERN.test(mac) ? mac : 'bad';
}

/**
 * One home-list entry in the current shape, or null when it is unusable
 * (a bad id, hash, sealed blob or base). The host is always taken from the
 * base, so a stored label cannot say one thing while the poller goes to
 * another; the name falls back to that host.
 */
export function normalizeUltraNetworkEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id ?? '');
  const hash = String(item.hash ?? '');
  if (!ULTRA_NETWORK_ID_PATTERN.test(id) || !HASH_PATTERN.test(hash))
    return null;
  if (!sealedShape(item.sealed)) return null;
  const base = parseBase(item.base);
  if (!base) return null;
  const state = String(item.lastState ?? '');
  const policyMac = storedNetworkPolicyMac(item);
  return {
    id,
    name: cleanHelpText(item.name, ULTRA_HELP_NAME_LIMIT) || base.host,
    base: base.origin,
    host: base.host,
    hash,
    sealed: {
      v: 1,
      iv: item.sealed.iv,
      tag: item.sealed.tag,
      data: item.sealed.data,
    },
    source: item.source === 'directory' ? 'directory' : 'manual',
    addedAt: finiteOrNull(item.addedAt),
    lastPolledAt: finiteOrNull(item.lastPolledAt),
    lastState: ULTRA_NETWORK_STATES.includes(state) ? state : 'new',
    directoryMissing: item.directoryMissing === true,
    moved: item.moved === true,
    // Skill names copied off a clear token, and the flag when they are
    // sealed inside it. Absent on a token that has neither, so an older
    // home list reads exactly as it did.
    ...skillEntryFields(item),
    // Only a hand-added link the last pull disagreed with carries it.
    ...(item.directoryDiffers === true ? { directoryDiffers: true } : {}),
    ...(policyMac === undefined ? {} : { policyMac }),
  };
}

function skillEntryFields(item) {
  const skills = [];
  if (Array.isArray(item?.skills)) {
    for (const raw of item.skills) {
      const label = cleanHelpText(raw, 40);
      if (!label || skills.includes(label)) continue;
      skills.push(label);
      if (skills.length >= 18) break;
    }
  }
  return {
    ...(skills.length ? { skills } : {}),
    ...(item?.encrypted === true ? { encrypted: true } : {}),
  };
}

function normalizePublished(item) {
  if (!item || typeof item !== 'object') return null;
  const tokenId = String(item.tokenId ?? '');
  const at = finiteOrNull(item.at);
  if (!TOKEN_ID_PATTERN.test(tokenId) || at === null) return null;
  return {
    tokenId,
    at,
    how: item.how === 'github' ? 'github' : 'clipboard',
  };
}

/** Whatever config/ultra-network.json holds, in the current shape: junk tolerated, bad entries dropped, one entry per token hash, at most 200. */
export function normalizeUltraNetworkStore(parsed) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const items = Array.isArray(source.entries) ? source.entries : [];
  const ids = new Set();
  const hashes = new Set();
  const entries = [];
  for (const item of items) {
    const entry = normalizeUltraNetworkEntry(item);
    if (!entry || ids.has(entry.id) || hashes.has(entry.hash)) continue;
    ids.add(entry.id);
    hashes.add(entry.hash);
    entries.push(entry);
    if (entries.length >= ULTRA_NETWORK_ENTRY_LIMIT) break;
  }
  return {
    version: 1,
    me: { name: cleanHelpText(source.me?.name, ULTRA_HELP_NAME_LIMIT) },
    published: normalizePublished(source.published),
    entries,
  };
}

/**
 * The row the owner's status carries for one entry: an id, a name, a host
 * and the poll state, with the memory (poll times, failures, the episode)
 * folded over the stored values. Never the base, the hash or the sealed
 * blob. `active` is taken from memory.active when it is a boolean, else
 * from the episode's window against `now`.
 */
export function ultraNetworkPublicEntry(entry, memory = {}, now = null) {
  const m = memory && typeof memory === 'object' ? memory : {};
  const clock = finiteOrNull(now);
  const active =
    typeof m.active === 'boolean'
      ? m.active
      : Boolean(m.episodeId) &&
        clock !== null &&
        Number(m.episodeUntil) > clock;
  const state =
    typeof m.lastState === 'string' &&
    ULTRA_NETWORK_STATES.includes(m.lastState)
      ? m.lastState
      : entry.lastState;
  return {
    id: entry.id,
    name: entry.name,
    host: entry.host,
    source: entry.source,
    addedAt: entry.addedAt ?? null,
    lastPolledAt: finiteOrNull(m.lastPolledAt) ?? entry.lastPolledAt ?? null,
    lastState: state,
    failures: Math.max(0, Math.floor(Number(m.failures) || 0)),
    directoryMissing: entry.directoryMissing === true,
    moved: entry.moved === true,
    ...(entry.directoryDiffers === true ? { directoryDiffers: true } : {}),
    ...skillEntryFields(entry),
    active,
  };
}

/**
 * The group directory as fetched, each element judged on its own: an
 * object with a whole help link that passes the tailnet rule and a name
 * that cleans to something, or it is skipped and counted. At most 500
 * elements are considered (the rest count as skipped); a repeated token
 * keeps its first entry; a body that is neither { entries: [...] } nor an
 * array is unreadable and the home list is left alone.
 */
export function normalizeUltraDirectory(
  parsed,
  { hash = ultraTokenHash } = {},
) {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)
      ? parsed.entries
      : null;
  if (!list) return { entries: [], skipped: 0, total: 0, unreadable: true };
  const total = list.length;
  let skipped = Math.max(0, total - ULTRA_DIRECTORY_LIMIT);
  const seen = new Set();
  const entries = [];
  for (const item of list.slice(0, ULTRA_DIRECTORY_LIMIT)) {
    const usable = !!item && typeof item === 'object' && !Array.isArray(item);
    const parts = usable ? parseUltraHelpLink(item.link) : null;
    const name = parts ? cleanHelpText(item.name, ULTRA_HELP_NAME_LIMIT) : '';
    if (!parts || !ultraTailnetTarget(parts) || !name) {
      skipped += 1;
      continue;
    }
    const digest = hash(parts.token);
    if (seen.has(digest)) continue;
    seen.add(digest);
    entries.push({
      name,
      link: `${parts.base}/ultra/help/${parts.token}`,
      token: parts.token,
      hash: digest,
      host: parts.host,
      base: parts.base,
    });
  }
  return { entries, skipped, total, unreadable: false };
}

function toSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

function baseKey(value) {
  return String(value ?? '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * UPDATE HOME LIST: the pulled directory merged into the home list. In
 * order, for each accepted entry: my own token or base is counted `own`
 * and never added (a node must not poll itself); a token already listed
 * keeps its entry, state and episode, is renamed when it came from the
 * directory and the name differs (`updated`, a manual entry keeps the
 * owner's name), and a 'directory' entry is flagged `moved` when the
 * directory now shows it under a different base (the old base is kept, the
 * new host is never polled, and the entry is not polled at all once any
 * call it is carrying has ended: a rewritten host would hand that person's
 * token to whoever rewrote the file; REMOVE + ADD is the owner's way
 * through) and cleared again once the directory agrees with it. A link the
 * owner added by hand is never switched off by the directory: a
 * disagreement is counted in `moved` and the owner's link goes on being
 * polled (and a flag an older version set on it is cleared); anything
 * else is appended as a 'directory' entry sealed under the key, up to the
 * 200 cap and up to eight polled links per machine, counting the ones
 * already listed (extras count as skipped). Every 'directory' entry absent
 * from the pull is marked missing and, like a moved one, not polled once
 * any call it is carrying has ended; one that returns is cleared. Nothing
 * is ever deleted by a pull, and a pull with no valid entry changes
 * nothing.
 */
export function mergeUltraDirectory({
  home = [],
  directory,
  ownHashes,
  ownBases,
  now,
  seal,
  newId,
} = {}) {
  const pulled = Array.isArray(directory)
    ? { entries: directory, skipped: 0, total: directory.length }
    : directory && typeof directory === 'object'
      ? directory
      : { entries: [], skipped: 0, total: 0 };
  const list = Array.isArray(pulled.entries) ? pulled.entries : [];
  const entries = (Array.isArray(home) ? home : []).map((entry) => ({
    ...entry,
  }));
  const result = {
    entries,
    added: 0,
    updated: 0,
    missing: 0,
    own: 0,
    moved: 0,
    skipped: Math.max(0, Number(pulled.skipped) || 0),
    total: Math.max(0, Number(pulled.total) || 0),
  };
  if (list.length === 0) return result;
  const mine = toSet(ownHashes);
  const myBases = new Set([...toSet(ownBases)].map(baseKey));
  const byHash = new Map(entries.map((entry) => [entry.hash, entry]));
  const seen = new Set();
  // Links per machine that will still be polled after this pull: one the
  // owner added by hand, or a directory one the pull lists at the same base.
  // A directory one flagged missing or moved is polled at most until a call
  // it is carrying ends, so it holds no place, and a machine that changes
  // its directory token can still get the new one in. The port is not part of the machine: every port on it is
  // polled from this one address against the same budgets.
  const machine = (host) =>
    String(host ?? '')
      .toLowerCase()
      .replace(/:\d+$/, '');
  const pulledAt = new Map(list.map((item) => [item.hash, baseKey(item.base)]));
  const perMachine = new Map();
  const polledOn = (host) => perMachine.get(machine(host)) || 0;
  for (const entry of entries) {
    const polled =
      entry.source !== 'directory' ||
      pulledAt.get(entry.hash) === baseKey(entry.base);
    if (polled) perMachine.set(machine(entry.host), polledOn(entry.host) + 1);
  }
  for (const item of list) {
    if (mine.has(item.hash) || myBases.has(baseKey(item.base))) {
      result.own += 1;
      continue;
    }
    const existing = byHash.get(item.hash);
    if (existing) {
      seen.add(item.hash);
      const differs = baseKey(existing.base) !== baseKey(item.base);
      if (differs) result.moved += 1;
      // A hand-added link keeps being polled at its own host; the row says
      // the directory disagrees, so the count points at someone.
      if (existing.source !== 'directory') existing.directoryDiffers = differs;
      if (differs && existing.source === 'directory') {
        existing.moved = true;
        existing.lastState = 'moved';
      } else if (existing.moved) {
        existing.moved = false;
        if (existing.lastState === 'moved') existing.lastState = 'new';
      }
      if (existing.source === 'directory' && existing.name !== item.name) {
        existing.name = item.name;
        result.updated += 1;
      }
      if (existing.directoryMissing) {
        existing.directoryMissing = false;
        if (existing.lastState === 'missing') existing.lastState = 'new';
      }
      continue;
    }
    if (
      entries.length >= ULTRA_NETWORK_ENTRY_LIMIT ||
      polledOn(item.host) >= ULTRA_NETWORK_HOST_ENTRY_LIMIT
    ) {
      result.skipped += 1;
      continue;
    }
    perMachine.set(machine(item.host), polledOn(item.host) + 1);
    const id = newId();
    const entry = {
      id,
      name: item.name,
      base: item.base,
      host: item.host,
      hash: item.hash,
      sealed: seal(item.token, id),
      source: 'directory',
      addedAt: Number(now),
      lastPolledAt: null,
      lastState: 'new',
      directoryMissing: false,
      moved: false,
      ...ultraTokenSkillFields(item.token),
    };
    entries.push(entry);
    byHash.set(item.hash, entry);
    seen.add(item.hash);
    result.added += 1;
  }
  for (const entry of entries) {
    if (entry.source !== 'directory' || seen.has(entry.hash)) continue;
    result.missing += 1;
    entry.directoryMissing = true;
    entry.lastState = 'missing';
  }
  return result;
}

function decodedSegments(pathname) {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

/**
 * The GitHub contents-API address of a directory file, from its raw
 * (raw.githubusercontent.com/<o>/<r>/<ref>/<path>, also the refs/heads
 * form) or page (github.com/<o>/<r>/blob/<ref>/<path>) URL; null for
 * anything else, so a write token is only ever attached to a URL whose
 * host is exactly api.github.com. The path is percent-encoded segment by
 * segment; `ref` goes in the query separately.
 */
export function githubDirectoryApi(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    return null;
  const host = parsed.hostname.toLowerCase();
  const segments = decodedSegments(parsed.pathname);
  if (!segments) return null;
  let rest;
  if (host === 'raw.githubusercontent.com') {
    rest = segments.slice(2);
  } else if (host === 'github.com' || host === 'www.github.com') {
    if (segments[2] !== 'blob' && segments[2] !== 'raw') return null;
    rest = segments.slice(3);
  } else {
    return null;
  }
  const [owner, repo] = segments;
  if (!owner || !repo || !GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo))
    return null;
  let ref;
  let path;
  if (rest[0] === 'refs' && rest[1] === 'heads') {
    ref = rest[2];
    path = rest.slice(3);
  } else {
    ref = rest[0];
    path = rest.slice(1);
  }
  if (
    !ref ||
    path.length === 0 ||
    path.some((segment) => segment === '.' || segment === '..')
  )
    return null;
  return {
    contentsUrl: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
      .map(encodeURIComponent)
      .join('/')}`,
    ref,
    owner,
    repo,
    path: path.join('/'),
  };
}

/** The one shape a directory entry has: a display name and the link, nothing about the number, position, time or machine. */
export function ultraDirectoryEntry({ name, link } = {}) {
  return {
    name: cleanHelpText(name, ULTRA_HELP_NAME_LIMIT) || 'Ultra',
    link: String(link ?? '').trim(),
  };
}

/**
 * The directory file with my entry in it: every other element is kept as
 * it is (a malformed one included, so a hand-kept file is never tidied
 * away), the element whose link carries my token is replaced, else mine is
 * appended; an empty or missing file becomes { version: 1, entries: [mine] }.
 * Null when the text is not JSON or is neither { entries: [...] } nor an
 * array: such a file is never clobbered.
 */
export function mergeDirectoryDocument(
  existingText,
  entry,
  { hash = ultraTokenHash } = {},
) {
  const mine = ultraDirectoryEntry(entry);
  const parts = parseUltraHelpLink(mine.link);
  if (!parts) return null;
  const myHash = hash(parts.token);
  const text = String(existingText ?? '').trim();
  let doc;
  if (text === '') {
    doc = { version: 1, entries: [] };
  } else {
    try {
      doc = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const list = Array.isArray(doc)
    ? doc
    : doc && typeof doc === 'object' && Array.isArray(doc.entries)
      ? doc.entries
      : null;
  if (!list) return null;
  let replaced = false;
  const entries = [];
  for (const item of list) {
    const theirs =
      item && typeof item === 'object' && !Array.isArray(item)
        ? parseUltraHelpLink(item.link)
        : null;
    if (!theirs || hash(theirs.token) !== myHash) {
      entries.push(item);
      continue;
    }
    // The first element carrying my token becomes mine; a second copy of
    // my own token is not somebody else's element and is not kept.
    if (!replaced) entries.push(mine);
    replaced = true;
  }
  if (!replaced) entries.push(mine);
  const out = Array.isArray(doc) ? entries : { ...doc, entries };
  return { text: JSON.stringify(out, null, 2) + '\n', replaced };
}

/** The mailto: link that hands an entry to whoever keeps the directory. */
export function ultraDirectoryMailto(entryText) {
  return (
    'mailto:?subject=' +
    encodeURIComponent(DIRECTORY_MAIL_SUBJECT) +
    '&body=' +
    encodeURIComponent(DIRECTORY_MAIL_LEAD + String(entryText ?? ''))
  );
}

/**
 * The Your Devices row for one active episode with a position, or null
 * without one or once the window has passed. follow is off so a release
 * from one bad entry can never seize the receiver's camera or displace
 * their own package; record is off (the pin never records itself, though
 * a recording package of the receiver's nearby captures it among its
 * surroundings); the card shows the name and
 * 'NEEDS HELP · HH:MM', never the plea.
 */
export function ultraNetworkPin(entry, episode, now) {
  if (!entry || !episode || typeof episode !== 'object') return null;
  const id = String(entry.id ?? '');
  if (!ULTRA_NETWORK_ID_PATTERN.test(id)) return null;
  const { lat, lon } = cleanPosition(episode.lat, episode.lon);
  if (lat === null) return null;
  const at = finiteOrNull(episode.at);
  const until = finiteOrNull(episode.until);
  if (at === null || until === null || !(until > Number(now))) return null;
  return {
    id: 'ultra-network:' + id,
    kind: 'help',
    kindLabel: ('NEEDS HELP · ' + clockTime(at)).slice(0, PIN_LABEL_LIMIT),
    color: ULTRA_NETWORK_PIN_COLOR,
    name:
      cleanHelpText(episode.from, PIN_NAME_LIMIT) ||
      cleanHelpText(entry.name, PIN_NAME_LIMIT) ||
      'Ultra',
    lat,
    lon,
    altM: null,
    headingDeg: null,
    speedMps: null,
    live: true,
    fixed: false,
    at,
    follow: false,
    record: false,
    recordKm: 0,
    hasPicture: false,
    pictureUrl: null,
    error: '',
    history: null,
  };
}

/** How many live NETWORK tokens (of one feed when `feedId` is given) polled the network route within the last minute. */
export function ultraWatchingCount(tokens, networkPolls, now, { feedId } = {}) {
  const since = Number(now) - ULTRA_WATCHING_MS;
  let count = 0;
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (!token || typeof token !== 'object' || token.network !== true) continue;
    if (finiteOrNull(token.revokedAt) !== null) continue;
    if (feedId !== undefined && token.feedId !== feedId) continue;
    const at =
      networkPolls && typeof networkPolls.get === 'function'
        ? finiteOrNull(networkPolls.get(token.id))
        : null;
    if (at !== null && at > since) count += 1;
  }
  return count;
}

/** The cache key of a reverse geocode: the fix to four decimals, '' without a position. */
export function ultraGeocodeKey(fix) {
  const { lat, lon } = cleanPosition(fix?.lat, fix?.lon);
  return lat === null ? '' : `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/**
 * Whether a fix is far enough (more than 50 m) from the cached geocode to
 * ask again; never without a position. A cached lookup that failed
 * (`failedAt`) is no address: it is asked again once a minute has passed
 * since that failure (`now`), wherever the fix is.
 */
export function ultraNeedsGeocode(cached, fix, now) {
  const { lat, lon } = cleanPosition(fix?.lat, fix?.lon);
  if (lat === null) return false;
  const failedAt = finiteOrNull(cached?.failedAt);
  if (failedAt !== null && Number(now) - failedAt >= ULTRA_GEOCODE_RETRY_MS)
    return true;
  const have = cleanPosition(cached?.lat, cached?.lon);
  if (have.lat === null) return true;
  const km = ultraDistanceKm(have, { lat, lon });
  return km === null || km * 1000 > ULTRA_GEOCODE_MOVE_M;
}
