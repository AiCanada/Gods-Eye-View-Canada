import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';
import { replaceCredentialStore } from '../../src/keySetupHardening.mjs';
import {
  applyPrivateCameraUpdate,
  applyRelayPairing,
  clearRelayPairing,
  configurePrivateCctvFeed,
  credentialTransport,
  isPrivateCctvFeedCloudUrl,
  isRelaySite,
  movePrivateCamera,
  emptyPrivateCameraConfig,
  normalizeFingerprint,
  normalizePrivateCameraConfig,
  normalizeRelayCameraName,
  privateCameraPublicId,
  privateCameraSources,
  privateCameraStatus,
  privateFrameTarget,
  relayMatchName,
} from '../../src/privateCamerasCore.mjs';
import { defaultSourceRoot } from './common/source-root.js';
import { PRIVATE_CCTV_FEED_LOCAL_CONFIG, parsePrivateCctvFeedConfig } from '../../src/privateCctvFeedConfig.mjs';

/**
 * Private home and business security cameras — kept separate from the public
 * CCTV proxy (server/providers/cctv.js) and its catalogue.
 *
 *   GET  /api/private-cams/status     redacted configuration for POWER UP
 *   POST /api/private-cams/config     save or remove one site (dev server only)
 *   POST /api/private-cams/position   pin one camera to a map spot (dev server only)
 *   GET  /api/private-cams/sources    placed cameras, no URLs or logins
 *   GET  /api/private-cams/frame/:id  one still, fetched with the site's login
 *
 * Browser ↔ server: every route answers only the machine running the server
 * (the Provider Settings gate refuses LAN peers, tunnels, proxied requests,
 * foreign Hosts and any sharing mode), refuses cross-site requests by Fetch
 * Metadata, and marks every response same-origin, uncacheable and unframable,
 * so another website can neither embed a frame nor read the camera list.
 *
 * Server ↔ bridge/camera: a login never travels over plain http beyond the
 * local network; passwords go out only in answer to a challenge (Digest first,
 * Basic only over https or the local network); redirects are refused so a
 * login is never replayed elsewhere; a pinned certificate fingerprint is
 * enforced before any header is sent; only raster images are relayed.
 *
 * GEV Private_CCTV_Feed Relay (tools/private-cctv-feed-relay): a browser extension that, while
 * the owner's own signed-in camera site feed is open, passes the newest clip
 * picture of each camera here. Its routes answer the same machine only, and
 * only a Chrome extension (Sec-Fetch-Site none, a chrome-extension:// Origin on
 * every POST); everything but the pairing request needs its bearer secret, and
 * that pairing is approved by hand in POWER UP:
 *
 *   POST /api/private-cams/relay/pair-request  ask to be paired (answers the code GEV issued for it)
 *   GET  /api/private-cams/relay/pair-status   whether this secret is paired yet
 *   POST /api/private-cams/relay/frame         one clip picture for one camera
 *   POST /api/private-cams/relay/heartbeat     what the feed page shows right now; answers
 *                                              which seen cameras still need a picture here
 *   POST /api/private-cams/relay/approve       POWER UP approves a request (dev server only)
 *   POST /api/private-cams/relay/unpair        POWER UP forgets a pairing (dev server only)
 *
 * Each extension may have one pairing request waiting, and a request replaces
 * only its own extension's earlier one. The server issues every request's code
 * (never taken from the request, never one another waiting request shows), so
 * an extension that reads a waiting code cannot put it on its own request.
 * APPROVE names both the code and the extension id POWER UP showed, so the
 * request the user compared is the one paired. GET /status (like /frame)
 * answers any software on this machine.
 *
 * Relay pictures, heartbeats and pairing requests live in memory only; the
 * store keeps just the approved extension id and the SHA-256 of its secret.
 *
 * At rest: config/private-cameras.json, git-ignored, written through the
 * hardened credential-store writer. Secrets never reach a log or the browser.
 */

export const PRIVATE_FRAME_TIMEOUT_MS = 8000;
export const PRIVATE_FRAME_MAX_BYTES = 16 * 1024 * 1024;
/** Largest clip picture the Private_CCTV_Feed relay may send. */
export const RELAY_FRAME_MAX_BYTES = 8 * 1024 * 1024;
/** Largest pairing request or heartbeat body. */
export const RELAY_JSON_MAX_BYTES = 4096;
/** How long a pairing request waits for its approval in POWER UP. */
export const RELAY_PAIR_TTL_MS = 120000;
/** Closest together two accepted pictures of one camera may arrive. */
export const RELAY_MIN_FRAME_INTERVAL_MS = 2000;
/** A relay silent for longer than this counts as not connected. */
export const RELAY_HEARTBEAT_STALE_MS = 10 * 60 * 1000;
const CONFIG_BODY_LIMIT = 2 * 1024 * 1024;
const USER_AGENT = 'gods-eye-view-private-cameras/1.0';
const BACKOFF_BASE_MS = 15000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
/** Raster stills only: an SVG from a camera could carry script. */
const RELAYED_IMAGE = /^image\/(jpeg|pjpeg|png|webp|gif)\b/i;
const STORE_FAILURE_CODES = new Set(['GEV_HARDEN_FAILED', 'GEV_STORE_UNREADABLE', 'GEV_STORE_REPLACE_REFUSED']);
/** Pairing requests one extension may make per minute. */
const RELAY_PAIR_RATE_LIMIT = 10;
const RELAY_PAIR_RATE_WINDOW_MS = 60 * 1000;
/** Extensions tracked by the pairing rate limit at once. */
const RELAY_PAIR_CALLERS_MAX = 16;
/** Extensions that may each have one pairing request waiting at once. */
const RELAY_PENDING_MAX = 4;
const RELAY_UNKNOWN_NAMES_MAX = 5;
/**
 * Several camera site feed tabs report on their own; a recent report of a better
 * state (a tab reading the feed) is kept over another tab's worse one for this
 * long. A tab's own worse report (its page just signed out) counts at once.
 */
const RELAY_HEARTBEAT_HOLD_MS = 150 * 1000;
const RELAY_STATE_RANK = Object.freeze({ feed: 3, 'no-cards': 2, 'signed-out': 1, 'layout-unknown': 0 });
/** The opaque tag a heartbeat carries for the tab that sent it (never the tab itself). */
const RELAY_REPORTER = /^[0-9a-f]{16}$/;
const RELAY_EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
const RELAY_BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;
const RELAY_SECRET_HASH = /^[0-9a-f]{64}$/;
/** Letters of a pairing code: no I, O, 0 or 1 to misread. */
export const RELAY_PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RELAY_PAIRING_CODE_LENGTH = 6;
const RELAY_STATES = new Set(['feed', 'signed-out', 'no-cards', 'layout-unknown']);
const RELAY_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const RELAY_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The relay extension's own routes, each with the one method it answers. */
const RELAY_EXTENSION_ROUTES = new Map([
  ['/relay/pair-request', 'POST'],
  ['/relay/pair-status', 'GET'],
  ['/relay/frame', 'POST'],
  ['/relay/heartbeat', 'POST'],
]);

/** Parse the Digest challenge out of a (possibly combined) WWW-Authenticate header. */
export function parseDigestChallenge(header) {
  const text = String(header || '');
  const start = text.search(/(^|,\s*)digest\s/i);
  if (start === -1) return null;
  const challenge = text
    .slice(start)
    .replace(/^,\s*/, '')
    .slice(6)
    .split(/,\s*(?=(?:basic|bearer|negotiate|ntlm)\b)/i)[0];
  const fields = {};
  for (const match of challenge.matchAll(/([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi)) {
    fields[match[1].toLowerCase()] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3];
  }
  return fields.nonce && fields.realm !== undefined ? fields : null;
}

/**
 * RFC 7616 / 2617 Digest `Authorization` header for a GET. MD5 unless the
 * camera asks for SHA-256; qop=auth when offered.
 */
export function digestAuthorization({ method = 'GET', uri, username, password, challenge, cnonce, nc = '00000001' }) {
  const algorithm = /sha-256/i.test(challenge.algorithm || '') ? 'SHA-256' : 'MD5';
  const hash = (value) =>
    createHash(algorithm === 'SHA-256' ? 'sha256' : 'md5')
      .update(value)
      .digest('hex');
  const qop = String(challenge.qop || '')
    .split(',')
    .map((value) => value.trim())
    .includes('auth')
    ? 'auth'
    : '';
  const ha1 = hash(`${username}:${challenge.realm}:${password}`);
  const ha2 = hash(`${method}:${uri}`);
  const response = qop ? hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : hash(`${ha1}:${challenge.nonce}:${ha2}`);
  const quote = (value) => `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
  const parts = [`username=${quote(username)}`, `realm=${quote(challenge.realm)}`, `nonce=${quote(challenge.nonce)}`, `uri=${quote(uri)}`, `response=${quote(response)}`, `algorithm=${algorithm}`];
  if (challenge.opaque !== undefined) parts.push(`opaque=${quote(challenge.opaque)}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quote(cnonce)}`);
  return `Digest ${parts.join(', ')}`;
}

/**
 * GET over TLS with a pinned certificate. The fingerprint is checked on the
 * finished handshake, before a single request byte — and so before any login —
 * is written. Works for self-signed bridge and NVR certificates, which is
 * exactly when pinning matters. Redirects are not followed.
 */
export function pinnedFetch(url, { headers = {}, signal, fingerprint, maxBytes = PRIVATE_FRAME_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const expected = normalizeFingerprint(fingerprint);
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const socket = tls.connect({
      host,
      port: Number(parsed.port) || 443,
      servername: net.isIP(host) ? undefined : host,
      // Chain trust is replaced by the exact pin below, so self-signed
      // certificates work and nothing else does.
      rejectUnauthorized: false,
    });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    signal?.addEventListener('abort', () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const presented = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256);
      if (!expected || presented !== expected) {
        fail(Object.assign(new Error('certificate does not match the pinned fingerprint'), { code: 'GEV_PIN_MISMATCH' }));
        return;
      }
      const request = https.request({
        method: 'GET',
        host,
        port: Number(parsed.port) || 443,
        path: `${parsed.pathname}${parsed.search}`,
        headers: { ...headers, Host: parsed.host },
        agent: false,
        createConnection: () => socket,
      });
      request.once('error', fail);
      request.once('response', (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy();
            fail(new Error('image too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', fail);
        response.once('end', () => {
          if (settled) return;
          settled = true;
          socket.end();
          const body = Buffer.concat(chunks);
          resolve({
            status: response.statusCode,
            ok: response.statusCode >= 200 && response.statusCode < 300,
            headers: {
              get: (name) => {
                const value = response.headers[String(name).toLowerCase()];
                return Array.isArray(value) ? value.join(', ') : (value ?? null);
              },
            },
            arrayBuffer: async () => body,
          });
        });
      });
      request.end();
    });
  });
}

async function readCappedBytes(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const body = Buffer.from(await response.arrayBuffer());
  return body.length > maxBytes ? null : body;
}

/**
 * Fetch one still with the site's login.
 * @returns {Promise<{ok: true, body: Buffer, contentType: string} | {ok: false, reason: string}>}
 */
export async function fetchPrivateFrame(
  target,
  { fetchImpl = fetch, pinnedFetchImpl = pinnedFetch, timeoutMs = PRIVATE_FRAME_TIMEOUT_MS, maxBytes = PRIVATE_FRAME_MAX_BYTES } = {},
) {
  if (!target?.url) return { ok: false, reason: 'not configured' };
  // Private_CCTV_Feed's website is a sign-in page, not a picture: it is never contacted or sent a login.
  if (isPrivateCctvFeedCloudUrl(target.url)) return { ok: false, reason: 'private_cctv_feed needs a local bridge' };
  const auth = target.auth || { type: 'none' };
  const transport = credentialTransport(target.url);
  if (transport === 'invalid') return { ok: false, reason: 'invalid address' };
  if (auth.type !== 'none' && transport === 'insecure') return { ok: false, reason: 'plain http login refused' };
  const pinned = Boolean(target.tlsFingerprint) && transport === 'https';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const request = (authorization) => {
    const headers = { 'User-Agent': USER_AGENT, Accept: 'image/jpeg, image/png, image/webp, image/gif', ...(authorization ? { Authorization: authorization } : {}) };
    return pinned
      ? pinnedFetchImpl(target.url, { headers, signal: controller.signal, fingerprint: target.tlsFingerprint, maxBytes })
      : fetchImpl(target.url, { redirect: 'manual', signal: controller.signal, headers });
  };
  try {
    // A bearer token is the bridge's API credential and goes on the first
    // request; a password is sent only in answer to the camera's challenge.
    let response = await request(auth.type === 'bearer' ? `Bearer ${auth.token}` : '');
    if (response.status === 401 && auth.type === 'basic') {
      const header = response.headers.get('www-authenticate') || '';
      const digest = parseDigestChallenge(header);
      if (digest) {
        const parsed = new URL(target.url);
        response = await request(
          digestAuthorization({
            uri: `${parsed.pathname}${parsed.search}`,
            username: auth.username,
            password: auth.password,
            challenge: digest,
            cnonce: randomBytes(8).toString('hex'),
          }),
        );
      } else if (/(^|,\s*)basic\b/i.test(header)) {
        response = await request(`Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`);
      }
    }
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'login refused' };
    if (response.status >= 300 && response.status < 400) return { ok: false, reason: 'redirect refused' };
    if (!response.ok) return { ok: false, reason: `camera answered ${response.status}` };
    const contentType = response.headers.get('content-type') || '';
    if (!RELAYED_IMAGE.test(contentType)) return { ok: false, reason: 'not a still image' };
    const body = await readCappedBytes(response, maxBytes);
    return body ? { ok: true, body, contentType } : { ok: false, reason: 'image too large' };
  } catch (error) {
    if (error?.code === 'GEV_PIN_MISMATCH') return { ok: false, reason: 'certificate pin mismatch' };
    return { ok: false, reason: error?.name === 'AbortError' ? 'camera timed out' : 'camera unreachable' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Fetch Metadata gate: browsers label every request with where it came from.
 * Anything but a same-origin request (or a user typing the address) is a
 * different website reaching into this machine's cameras, and is refused.
 */
export function privateFetchSiteAllowed(headers = {}) {
  const site = String(headers['sec-fetch-site'] || '').toLowerCase();
  return site === '' || site === 'same-origin' || site === 'none';
}

/**
 * Admission for the GEV Private_CCTV_Feed Relay's own routes. Locality is exactly the
 * Provider Settings gate (loopback socket, local Host, no proxy or forwarding
 * headers, no sharing mode). On top of that only a browser extension's service
 * worker gets in: browsers label its requests Sec-Fetch-Site none, and each of
 * its POSTs carries its chrome-extension:// Origin, which no web page can send.
 * @returns {{ok: true, extensionId: string|null} | {ok: false, status: number, error: string}}
 */
export function admitRelayRequest(req) {
  const headers = req?.headers || {};
  const locality = admitKeySetupRequest({
    method: 'GET',
    remoteAddress: req?.socket?.remoteAddress,
    hostHeader: headers.host,
    protocol: req?.socket?.encrypted ? 'https:' : 'http:',
    origin: undefined,
    proxyHeaders: headers,
    env: process.env,
  });
  if (!locality.ok) return { ok: false, status: locality.status, error: locality.error.replace('Provider Settings', 'The Private_CCTV_Feed relay') };
  const refused = { ok: false, status: 403, error: 'The Private_CCTV_Feed relay answers only its browser extension' };
  if (headers['sec-fetch-site'] !== 'none') return refused;
  const origin = headers.origin;
  const match = typeof origin === 'string' ? RELAY_EXTENSION_ORIGIN.exec(origin) : null;
  if (req.method === 'POST') {
    if (!match) return refused;
  } else if (req.method === 'GET') {
    if (origin !== undefined && !match) return refused;
  } else {
    return { ok: false, status: 403, error: 'The Private_CCTV_Feed relay answers only GET and POST' };
  }
  return { ok: true, extensionId: match ? match[1] : null };
}

/**
 * A pairing code issued by this server: six letters from
 * RELAY_PAIRING_CODE_ALPHABET, unbiased, and different from every code in
 * `taken` (the codes of the requests already waiting). A request never picks
 * its own code, so an extension that reads a waiting code from GET /status
 * cannot show the same code on a request of its own.
 * @param {Iterable<string>} [taken]
 * @param {(max: number) => number} [random] crypto.randomInt
 * @returns {string}
 */
export function relayPairingCode(taken = [], random = randomInt) {
  const used = new Set(taken);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let index = 0; index < RELAY_PAIRING_CODE_LENGTH; index += 1) code += RELAY_PAIRING_CODE_ALPHABET[random(RELAY_PAIRING_CODE_ALPHABET.length)];
    if (!used.has(code)) return code;
  }
  throw Object.assign(new Error('no free pairing code'), { code: 'GEV_PAIRING_CODE' });
}

/** The relay's pairing secret from `Authorization: Bearer …`, or ''. */
function relayBearerSecret(headers = {}) {
  const header = headers.authorization;
  if (typeof header !== 'string' || header.length > 128) return '';
  return RELAY_BEARER.exec(header)?.[1] || '';
}

/** SHA-256 of the UTF-8 bytes of a secret string. */
function sha256Digest(text) {
  return createHash('sha256').update(String(text), 'utf8').digest();
}

/** Constant-time comparison of a presented SHA-256 digest with a stored hex hash. */
function digestMatches(presented, storedHex) {
  const valid = typeof storedHex === 'string' && RELAY_SECRET_HASH.test(storedHex);
  const equal = timingSafeEqual(presented, valid ? Buffer.from(storedHex, 'hex') : Buffer.alloc(presented.length));
  return valid && equal;
}

/** A percent-encoded relay header as text, or null when it is not valid. */
function relayHeaderText(value, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength * 12) return null;
  let text;
  try {
    text = decodeURIComponent(value);
  } catch {
    return null;
  }
  return text.length > maxLength || RELAY_CONTROL_CHARS.test(text) ? null : text;
}

/** The picture type a relay body really is, by its first bytes. */
function sniffRelayImage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

/**
 * Collect a request body up to `limit` bytes. Past the limit the request is
 * destroyed and nothing more is kept.
 * @returns {Promise<{overflowed: boolean, complete: boolean, body: Buffer}>}
 */
function readCappedBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (overflowed, complete) => {
      if (settled) return;
      settled = true;
      resolve({ overflowed, complete, body: overflowed ? Buffer.alloc(0) : Buffer.concat(chunks) });
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        finish(true, false);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(false, true));
    req.on('close', () => finish(false, false));
    req.on('error', () => finish(false, false));
  });
}

/** A JSON request body up to `limit` bytes, or the status and error to answer. */
async function readJsonBody(req, limit) {
  const { overflowed, body } = await readCappedBody(req, limit);
  if (overflowed) return { ok: false, status: 413, error: 'Request too large' };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8') || '{}') };
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON' };
  }
}

const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

/** One line under the reason saying what to do about it. */
const OFFLINE_HINTS = Object.freeze({
  'private_cctv_feed needs a local bridge': 'Choose Browser feed relay, or set up a local bridge, in POWER UP',
  'feed relay not connected': 'Open your camera site feed with the GEV Private_CCTV_Feed Relay',
  'feed relay not paired': 'Pair the GEV Private_CCTV_Feed Relay in POWER UP',
  'feed signed out': 'Sign in at your camera site to refresh pictures',
  'login refused': 'Check this site login in POWER UP',
  'not a still image': 'Use a JPEG snapshot address, not a web page',
  'not configured': 'Add this camera in POWER UP',
  'picture on its way': 'The Private_CCTV_Feed feed shows a clip from this camera',
  'waiting for a clip': 'Shows the next motion clip from this camera',
});

/** Local hh:mm of a time in milliseconds. */
function clockTime(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** The placeholder still: camera name, reason, what to do about it and an optional detail line. */
function offlineSvg(label, reason, detail = '') {
  const hint = OFFLINE_HINTS[reason] || '';
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#071118"/><rect x="24" y="24" width="912" height="492" fill="none" stroke="#1f6f86" stroke-width="2"/><text x="480" y="250" fill="#8fe9ff" font-family="monospace" font-size="34" text-anchor="middle">${escape(label)}</text><text x="480" y="300" fill="#5f8f9c" font-family="monospace" font-size="22" text-anchor="middle">PRIVATE CAMERA · ${escape(String(reason).toUpperCase())}</text>${hint ? `<text x="480" y="345" fill="#d6ad62" font-family="monospace" font-size="18" text-anchor="middle">${escape(hint)}</text>` : ''}${detail ? `<text x="480" y="380" fill="#5f8f9c" font-family="monospace" font-size="18" text-anchor="middle">${escape(detail)}</text>` : ''}</svg>`;
}

/** Vite plugin for the private camera routes. */
/** The credential store and its temporary files, however a URL spells or encodes the name. */
const STORE_NAME_PATTERN = /private-cameras\.json/i;

/**
 * Whether a request could reach the private camera store through the server's
 * static file handling. Vite serves the whole checkout, and Windows paths are
 * case-insensitive, accept trailing dots and stream suffixes ("::$DATA") and
 * short 8.3 names (PRIVAT~1.JSO), so a deny list of exact spellings is not
 * enough: any URL naming the store is refused, and a short name is resolved to
 * its real file first.
 * @param {string} rawUrl request URL (path and query)
 * @returns {boolean}
 */
export function isPrivateStoreRequest(rawUrl, { sourceRoot = defaultSourceRoot, realpath = (file) => fs.realpathSync.native(file) } = {}) {
  const raw = String(rawUrl || '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed escape is checked as written.
  }
  if (STORE_NAME_PATTERN.test(raw) || STORE_NAME_PATTERN.test(decoded)) return true;
  const pathname = decoded.split(/[?#]/)[0].replace(/\\/g, '/');
  if (!pathname.includes('~')) return false;
  const candidate = pathname.startsWith('/@fs/') ? pathname.slice('/@fs/'.length) : path.join(sourceRoot, pathname);
  try {
    return STORE_NAME_PATTERN.test(path.basename(realpath(candidate)));
  } catch {
    return false;
  }
}

export function privateCamerasProxy({ sourceRoot = defaultSourceRoot, fetchImpl, pinnedFetchImpl } = {}) {
  // Which site the owner's feed lives on is local, untracked configuration.
  // It decides which hosts are never sent a saved login, so it is re-read when
  // the file changes (no restart needed) and a broken file is said out loud:
  // read silently, a typo left that guard knowing only the example hosts.
  const feedConfigPath = path.join(sourceRoot, PRIVATE_CCTV_FEED_LOCAL_CONFIG);
  let feedConfigStamp = '';
  let feedConfigCheckedAt = 0;
  const refreshFeedConfig = (force = false) => {
    const now = Date.now();
    if (!force && now - feedConfigCheckedAt < 2000) return;
    feedConfigCheckedAt = now;
    let stamp = 'missing';
    try {
      const stat = fs.statSync(feedConfigPath);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      stamp = 'missing';
    }
    if (stamp === feedConfigStamp) return;
    feedConfigStamp = stamp;
    let feedRaw = null;
    if (stamp !== 'missing') {
      try {
        feedRaw = JSON.parse(fs.readFileSync(feedConfigPath, 'utf8'));
      } catch (error) {
        console.warn(`[Private cameras] ${PRIVATE_CCTV_FEED_LOCAL_CONFIG} could not be read (${error?.message || error}). The vendor site is NOT recognised until it is fixed.`);
      }
    }
    const parsed = parsePrivateCctvFeedConfig(feedRaw);
    for (const problem of parsed.problems) {
      console.warn(`[Private cameras] ${PRIVATE_CCTV_FEED_LOCAL_CONFIG}: ${problem}`);
    }
    configurePrivateCctvFeed(parsed);
  };
  refreshFeedConfig(true);
  const storePath = path.join(sourceRoot, 'config', 'private-cameras.json');
  let cache = { mtimeMs: -1, size: -1, config: emptyPrivateCameraConfig() };
  const failures = new Map();
  const inflight = new Map();
  const fetchOptions = { ...(fetchImpl ? { fetchImpl } : {}), ...(pinnedFetchImpl ? { pinnedFetchImpl } : {}) };

  // GEV Private_CCTV_Feed Relay state. Memory only: it is gone when the server stops.
  /** public camera id → { body, contentType, receivedAt, clip } */
  const relayFrames = new Map();
  /** site id → { state, seen, at, reporter } */
  const relayHeartbeats = new Map();
  /** site id → Private_CCTV_Feed feed names (normalised) that matched no camera of that site */
  const relayUnknownNames = new Map();
  /** extension id → when its recent pairing requests arrived */
  const relayPairTimes = new Map();
  /**
   * Pairing requests waiting for approval, at most one per extension:
   * extension id → { extensionId, secretHash, code, expiresAt }. A request only
   * ever replaces its own extension's earlier one, so one extension can neither
   * take over nor push out another's.
   */
  const relayPending = new Map();

  const readConfig = ({ strict = false } = {}) => {
    // Every path that may go on to fetch a camera reads the config first, so the
    // vendor-site guard is current before any saved login can be sent.
    refreshFeedConfig();
    try {
      const { mtimeMs, size } = fs.statSync(storePath);
      if (mtimeMs !== cache.mtimeMs || size !== cache.size) {
        cache = { mtimeMs, size, config: normalizePrivateCameraConfig(JSON.parse(fs.readFileSync(storePath, 'utf8'))) };
      }
      return cache.config;
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyPrivateCameraConfig();
      if (strict) {
        const unreadable = new Error('the saved camera configuration could not be read, so nothing was changed');
        unreadable.code = 'GEV_STORE_UNREADABLE';
        throw unreadable;
      }
      console.warn('[PrivateCameras] configuration unreadable');
      return emptyPrivateCameraConfig();
    }
  };

  const saveConfig = (config) => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    replaceCredentialStore(storePath, `${JSON.stringify(config, null, 2)}\n`);
    cache = { mtimeMs: -1, size: -1, config: emptyPrivateCameraConfig() };
  };

  const respondJson = (res, status, payload, extraHeaders = {}) => {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      ...extraHeaders,
    });
    res.end(JSON.stringify(payload));
  };

  /** Answer a relay request without reading its body: the connection is dropped, not drained. */
  const relayRefuse = (req, res, status, payload) => {
    respondJson(res, status, payload, { Connection: 'close' });
    const drop = () => req.destroy?.();
    if (typeof res.once === 'function' && !res.writableFinished) res.once('finish', drop);
    else drop();
  };

  /** The unexpired pairing requests, newest first. */
  const pendingPairings = () => {
    const now = Date.now();
    for (const [extensionId, pending] of relayPending) if (now >= pending.expiresAt) relayPending.delete(extensionId);
    return [...relayPending.values()].sort((a, b) => b.expiresAt - a.expiresAt);
  };

  /** The paired relay site a bearer secret belongs to. Every paired site is compared, with no early exit. */
  const pairedRelaySite = (config, secret) => {
    if (!secret) return null;
    const presented = sha256Digest(secret);
    let found = null;
    for (const site of config.sites) {
      if (!isRelaySite(site) || !site.relayExtensionId) continue;
      if (digestMatches(presented, site.relaySecretHash) && !found) found = site;
    }
    return found;
  };

  const forgetRelaySite = (siteId) => {
    relayHeartbeats.delete(siteId);
    relayUnknownNames.delete(siteId);
    const prefix = privateCameraPublicId(siteId, '');
    for (const publicId of [...relayFrames.keys()]) if (publicId.startsWith(prefix)) relayFrames.delete(publicId);
  };

  /**
   * Drop relay memory for sites that went away or stopped being relay sites, for
   * removed cameras, and for cameras that kept their id but now match another
   * Private_CCTV_Feed feed name (a new Name, a new Private_CCTV_Feed name, or two Private_CCTV_Feed names swapped): a
   * picture arrived for the Private_CCTV_Feed camera its old name matched, so keeping it
   * could show another camera's picture.
   */
  const forgetRelayChanges = (before, after) => {
    for (const site of before.sites) {
      const next = after.sites.find((candidate) => candidate.id === site.id);
      if (!next || !isRelaySite(next)) {
        forgetRelaySite(site.id);
        continue;
      }
      const matchNames = new Map(next.cameras.map((camera) => [camera.id, relayMatchName(camera)]));
      for (const camera of site.cameras) {
        if (matchNames.get(camera.id) !== relayMatchName(camera)) relayFrames.delete(privateCameraPublicId(site.id, camera.id));
      }
    }
  };

  /** A site's Private_CCTV_Feed feed names that still match none of its cameras. */
  const unknownNamesFor = (site) => {
    const matchNames = new Set(site.cameras.map((camera) => relayMatchName(camera)));
    return (relayUnknownNames.get(site.id) || []).filter((name) => !matchNames.has(name));
  };

  /** Remember an unmatched Private_CCTV_Feed feed name: names that match a camera by now are dropped, and the newest five are kept. */
  const rememberUnknownName = (site, name) => {
    if (!name) return;
    const names = unknownNamesFor(site);
    if (!names.includes(name) && !site.cameras.some((camera) => relayMatchName(camera) === name)) names.push(name);
    relayUnknownNames.set(site.id, names.slice(-RELAY_UNKNOWN_NAMES_MAX));
  };

  /** POWER UP status plus what the relay is doing right now. Never a secret or its hash. */
  const statusFor = (config) => {
    const status = privateCameraStatus(config);
    const now = Date.now();
    for (const kind of status.kinds) {
      for (const site of kind.sites) {
        const saved = config.sites.find((candidate) => candidate.id === site.id);
        if (!isRelaySite(saved) || !site.relay) continue;
        const heartbeat = relayHeartbeats.get(site.id);
        site.relay = {
          ...site.relay,
          state: heartbeat?.state ?? null,
          lastHeartbeatAt: heartbeat?.at ?? null,
          connected: Boolean(heartbeat && now - heartbeat.at <= RELAY_HEARTBEAT_STALE_MS),
          unknownNames: unknownNamesFor(saved),
        };
        for (const camera of site.cameras) {
          const frame = relayFrames.get(privateCameraPublicId(site.id, camera.id));
          camera.lastFrameAt = frame ? frame.receivedAt : null;
          camera.lastClip = frame ? frame.clip : '';
        }
      }
    }
    // Every waiting request, each with the extension that sent it: POWER UP approves one by code and extension id.
    const relayPendingList = pendingPairings().map((pending) => ({ extensionId: pending.extensionId, code: pending.code, expiresInSeconds: Math.max(1, Math.ceil((pending.expiresAt - now) / 1000)) }));
    return { ...status, relayPending: relayPendingList };
  };

  /**
   * A relay camera's latest picture, or why there is none. Nothing is fetched.
   * A picture is shown only while the relay is reporting and Private_CCTV_Feed is signed in;
   * otherwise the placeholder says why, with the time its last picture arrived,
   * so an old picture never passes for a current one.
   */
  const relayFrameFor = (publicId, target, site) => {
    const name = target.name;
    if (!site?.relayExtensionId || !site.relaySecretHash) return { ok: false, reason: 'feed relay not paired', name };
    const frame = relayFrames.get(publicId);
    const heartbeat = relayHeartbeats.get(target.siteId);
    const lastHeard = Math.max(heartbeat ? heartbeat.at : -Infinity, frame ? frame.receivedAt : -Infinity);
    const quiet = Date.now() - lastHeard > RELAY_HEARTBEAT_STALE_MS;
    const signedOut = heartbeat?.state === 'signed-out';
    if (frame && !quiet && !signedOut) return { ok: true, body: frame.body, contentType: frame.contentType, name, relay: true };
    const lastPicture = frame ? `Last clip picture arrived ${clockTime(frame.receivedAt)}` : '';
    // A signed-out report wins even once the relay goes quiet: signing in is what brings pictures back.
    if (signedOut) return { ok: false, reason: 'feed signed out', name, detail: lastPicture };
    if (quiet) return { ok: false, reason: 'feed relay not connected', name, detail: lastPicture };
    if (heartbeat?.seen?.includes(target.matchName)) return { ok: false, reason: 'picture on its way', name };
    const detail = unknownNamesFor(site).length ? 'Or set its Private_CCTV_Feed name in POWER UP if the feed calls it something else' : '';
    return { ok: false, reason: 'waiting for a clip', name, detail };
  };

  const frameFor = (publicId) => {
    const config = readConfig();
    const target = privateFrameTarget(config, publicId);
    if (!target) return Promise.resolve({ ok: false, reason: 'not configured', name: '' });
    if (target.relay) return Promise.resolve(relayFrameFor(publicId, target, config.sites.find((site) => site.id === target.siteId)));
    const failure = failures.get(publicId);
    if (failure && Date.now() < failure.until) return Promise.resolve({ ok: false, reason: failure.reason, name: target.name });
    // The panel, the projection and the map card can all ask at once: they
    // share one upstream fetch rather than hitting the camera three times.
    if (inflight.has(publicId)) return inflight.get(publicId);
    const pending = fetchPrivateFrame(target, fetchOptions)
      .then((result) => {
        if (result.ok) {
          failures.delete(publicId);
        } else {
          const count = (failures.get(publicId)?.count || 0) + 1;
          failures.set(publicId, { count, reason: result.reason, until: Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (count - 1)) });
        }
        return { ...result, name: target.name };
      })
      .finally(() => inflight.delete(publicId));
    inflight.set(publicId, pending);
    return pending;
  };

  /** The relay extension's routes: pairing, pictures and heartbeats. */
  const relayExtensionRoute = async (req, res, pathname) => {
    const refuse = (status, payload) => relayRefuse(req, res, status, payload);
    const admission = admitRelayRequest(req);
    if (!admission.ok) return refuse(admission.status, { error: admission.error });
    if (req.method !== RELAY_EXTENSION_ROUTES.get(pathname)) return refuse(405, { error: 'Method not allowed' });
    const headers = req.headers || {};

    const readRelayJson = async () => {
      const declared = headers['content-length'];
      if (declared !== undefined && !(/^\d+$/.test(declared) && Number(declared) <= RELAY_JSON_MAX_BYTES)) {
        refuse(413, { error: 'Request too large' });
        return null;
      }
      const read = await readJsonBody(req, RELAY_JSON_MAX_BYTES);
      if (!read.ok) {
        respondJson(res, read.status, { error: read.error });
        return null;
      }
      return read.value && typeof read.value === 'object' && !Array.isArray(read.value) ? read.value : {};
    };

    if (pathname === '/relay/pair-request') {
      // Rate limited per extension, so one extension cannot use up another's pairing attempts.
      const { extensionId } = admission;
      const now = Date.now();
      for (const [caller, times] of relayPairTimes) {
        const recent = times.filter((at) => now - at < RELAY_PAIR_RATE_WINDOW_MS);
        if (recent.length) relayPairTimes.set(caller, recent);
        else relayPairTimes.delete(caller);
      }
      const times = relayPairTimes.get(extensionId) || [];
      if (times.length >= RELAY_PAIR_RATE_LIMIT || (!times.length && relayPairTimes.size >= RELAY_PAIR_CALLERS_MAX)) {
        return refuse(429, { error: 'Too many pairing requests — wait a minute and try again' });
      }
      relayPairTimes.set(extensionId, [...times, now]);
      const body = await readRelayJson();
      if (!body) return undefined;
      if (typeof body.secretHash !== 'string' || !RELAY_SECRET_HASH.test(body.secretHash)) {
        return respondJson(res, 400, { error: 'A pairing request needs a secretHash' });
      }
      const waiting = pendingPairings();
      if (!relayPending.has(extensionId) && waiting.length >= RELAY_PENDING_MAX) {
        return respondJson(res, 429, { error: 'Too many pairing requests are waiting — approve one in POWER UP or wait two minutes' });
      }
      // The code is issued here, whatever the body says, and differs from every waiting
      // request's code (this extension's earlier one too), so no two requests ever show one code.
      const code = relayPairingCode(waiting.map((pending) => pending.code));
      relayPending.set(extensionId, { extensionId, secretHash: body.secretHash, code, expiresAt: Date.now() + RELAY_PAIR_TTL_MS });
      return respondJson(res, 202, { pending: true, code, expiresInSeconds: RELAY_PAIR_TTL_MS / 1000 });
    }

    const secret = relayBearerSecret(headers);

    if (pathname === '/relay/pair-status') {
      const site = pairedRelaySite(readConfig(), secret);
      let pendingMatch = false;
      if (secret) {
        // Every waiting request is compared, with no early exit.
        const presented = sha256Digest(secret);
        for (const pending of pendingPairings()) if (digestMatches(presented, pending.secretHash)) pendingMatch = true;
      }
      if (site) return respondJson(res, 200, { paired: true, siteName: site.name, cameras: site.cameras.map((camera) => camera.name) });
      if (pendingMatch) return respondJson(res, 200, { paired: false, pending: true });
      return respondJson(res, 401, { paired: false });
    }

    // Pictures and heartbeats: the paired secret, from the very extension that was approved.
    const site = pairedRelaySite(readConfig(), secret);
    if (!site) return refuse(401, { error: 'The relay is not paired — pair it in POWER UP' });
    if (admission.extensionId !== site.relayExtensionId) return refuse(403, { error: 'This extension is not the relay paired with this site' });

    if (pathname === '/relay/heartbeat') {
      const body = await readRelayJson();
      if (!body) return undefined;
      const { state, seen, reporter = '' } = body;
      if (!RELAY_STATES.has(state) || !Array.isArray(seen) || seen.length > 20 || seen.some((name) => typeof name !== 'string' || name.length > 200)) {
        return respondJson(res, 400, { error: 'Heartbeat is not valid' });
      }
      if (reporter !== '' && (typeof reporter !== 'string' || !RELAY_REPORTER.test(reporter))) return respondJson(res, 400, { error: 'Heartbeat is not valid' });
      const now = Date.now();
      const names = [...new Set(seen.map((name) => normalizeRelayCameraName(name)).filter(Boolean))];
      const previous = relayHeartbeats.get(site.id);
      // A leftover sign-in tab does not override another tab that is reading the feed, but the
      // tab that sent the better report is believed at once when its own page gets worse (Private_CCTV_Feed
      // signed it out): only a report from the very same tab tag replaces it inside the hold.
      const sameReporter = Boolean(reporter) && previous?.reporter === reporter;
      const outranked = previous && !sameReporter && now - previous.at < RELAY_HEARTBEAT_HOLD_MS && RELAY_STATE_RANK[previous.state] > RELAY_STATE_RANK[state];
      if (!outranked) relayHeartbeats.set(site.id, { state, seen: names, at: now, reporter });
      // Tell the relay which of the cameras it sees have no picture here (after a restart,
      // an approval or a config change) and which feed names match no camera, so it
      // downloads a thumbnail only when this server will take it.
      const missing = [];
      const unknown = [];
      for (const name of names) {
        const camera = site.cameras.find((candidate) => relayMatchName(candidate) === name);
        if (!camera) {
          unknown.push(name);
          rememberUnknownName(site, name);
        } else if (!relayFrames.has(privateCameraPublicId(site.id, camera.id))) {
          missing.push(name);
        }
      }
      return respondJson(res, 200, { missing, unknown });
    }

    // POST /relay/frame — every header is checked before a single body byte is read.
    const camera = relayHeaderText(headers['x-private-cctv-feed-camera'], 200);
    if (camera === null || !normalizeRelayCameraName(camera)) return refuse(400, { error: 'X-Private-Cctv-Feed-Camera must name the camera' });
    const clip = headers['x-private-cctv-feed-clip'] === undefined ? '' : relayHeaderText(headers['x-private-cctv-feed-clip'], 80);
    if (clip === null) return refuse(400, { error: 'X-Private-Cctv-Feed-Clip is not valid' });
    const contentType = headers['content-type'];
    if (!RELAY_IMAGE_TYPES.has(contentType)) return refuse(415, { error: 'Only JPEG, PNG or WebP pictures are accepted' });
    const length = headers['content-length'];
    if (length === undefined || headers['transfer-encoding'] !== undefined) return refuse(411, { error: 'Content-Length is required' });
    if (!/^\d+$/.test(length)) return refuse(400, { error: 'Content-Length is not valid' });
    const declared = Number(length);
    if (declared > RELAY_FRAME_MAX_BYTES) return refuse(413, { error: 'Picture too large' });
    const read = await readCappedBody(req, RELAY_FRAME_MAX_BYTES);
    if (read.overflowed) return respondJson(res, 413, { error: 'Picture too large' });
    if (!read.complete || read.body.length !== declared) return respondJson(res, 400, { error: 'Picture was cut short' });
    if (sniffRelayImage(read.body) !== contentType) return respondJson(res, 415, { error: 'Picture bytes do not match its Content-Type' });
    const name = normalizeRelayCameraName(camera);
    const match = site.cameras.find((candidate) => relayMatchName(candidate) === name);
    if (!match) {
      rememberUnknownName(site, name);
      return respondJson(res, 404, { error: 'Unknown camera name' });
    }
    const publicId = privateCameraPublicId(site.id, match.id);
    const now = Date.now();
    const previous = relayFrames.get(publicId);
    if (previous && now - previous.receivedAt < RELAY_MIN_FRAME_INTERVAL_MS) return respondJson(res, 429, { error: 'Pictures of one camera are accepted at most every 2 seconds' });
    relayFrames.set(publicId, { body: read.body, contentType, receivedAt: now, clip });
    res.writeHead(204, { ...SECURITY_HEADERS });
    return res.end();
  };

  const install = (server, { allowEdit }) => {
    // First, before any static file handling: the credential store is never a
    // file this server hands out, whatever the spelling of the request.
    server.middlewares.use((req, res, next) => {
      if (!isPrivateStoreRequest(req.url, { sourceRoot })) return next();
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    });
    server.middlewares.use('/api/private-cams', async (req, res) => {
      let url;
      try {
        url = new URL(req.url || '/', 'http://localhost');
      } catch {
        return respondJson(res, 400, { error: 'Bad request' });
      }
      // No relay route answers a CORS preflight, and no route ever sends CORS headers.
      if (url.pathname.startsWith('/relay/') && req.method === 'OPTIONS') return relayRefuse(req, res, 403, { error: 'The Private_CCTV_Feed relay does not answer preflight requests' });
      if (RELAY_EXTENSION_ROUTES.has(url.pathname)) {
        try {
          return await relayExtensionRoute(req, res, url.pathname);
        } catch (error) {
          console.warn('[PrivateCameras] relay request failed:', error?.code || error?.name || 'error');
          return respondJson(res, 500, { error: 'Private camera error' });
        }
      }
      const admission = admitKeySetupRequest({
        method: req.method,
        remoteAddress: req.socket?.remoteAddress,
        hostHeader: req.headers?.host,
        protocol: req.socket?.encrypted ? 'https:' : 'http:',
        origin: req.headers?.origin,
        contentType: req.headers?.['content-type'],
        proxyHeaders: req.headers || {},
        env: process.env,
      });
      if (!admission.ok) return respondJson(res, admission.status, { error: admission.error.replace('Provider Settings', 'Private cameras') });
      if (!privateFetchSiteAllowed(req.headers)) return respondJson(res, 403, { error: 'Private cameras refuse cross-site requests' });
      try {
        if (url.pathname === '/status' && req.method === 'GET') {
          return respondJson(res, 200, { ...statusFor(readConfig()), editable: allowEdit });
        }
        if (url.pathname === '/sources' && req.method === 'GET') {
          return respondJson(res, 200, { sources: privateCameraSources(readConfig()) });
        }
        if (url.pathname === '/config' && req.method === 'POST') {
          if (!allowEdit) return respondJson(res, 403, { error: 'Private cameras can only be edited under the dev server' });
          const read = await readJsonBody(req, CONFIG_BODY_LIMIT);
          if (!read.ok) return respondJson(res, read.status, { error: read.error });
          const previous = readConfig({ strict: true });
          const verdict = applyPrivateCameraUpdate(read.value, previous);
          if (!verdict.ok) return respondJson(res, 400, { error: verdict.error });
          saveConfig(verdict.config);
          failures.clear();
          forgetRelayChanges(previous, verdict.config);
          return respondJson(res, 200, { ok: true, siteId: verdict.siteId, status: statusFor(verdict.config) });
        }
        if (url.pathname === '/position' && req.method === 'POST') {
          // Dragging a camera icon on the map pins that one camera to the new spot.
          if (!allowEdit) return respondJson(res, 403, { error: 'Private cameras can only be moved under the dev server' });
          const read = await readJsonBody(req, 4096);
          if (!read.ok) return respondJson(res, read.status, { error: read.error });
          const parsed = read.value;
          const verdict = movePrivateCamera(readConfig({ strict: true }), parsed?.id, parsed?.lat, parsed?.lon);
          if (!verdict.ok) return respondJson(res, 400, { error: verdict.error });
          saveConfig(verdict.config);
          return respondJson(res, 200, { ok: true });
        }
        if (url.pathname === '/relay/approve' && req.method === 'POST') {
          // POWER UP approves one waiting pairing request for one relay site: the one
          // from the extension id and with the code the user compared, and no other.
          if (!allowEdit) return respondJson(res, 403, { error: 'The Private_CCTV_Feed relay can only be paired under the dev server' });
          const read = await readJsonBody(req, RELAY_JSON_MAX_BYTES);
          if (!read.ok) return respondJson(res, read.status, { error: read.error });
          const again = 'press PAIR WITH GODS EYE VIEW on the relay options page again';
          if (!pendingPairings().length) return respondJson(res, 409, { error: `No pairing request is waiting — ${again}` });
          const { siteId, code, extensionId } = read.value && typeof read.value === 'object' ? read.value : {};
          const pending = typeof extensionId === 'string' ? relayPending.get(extensionId) : undefined;
          if (!pending) return respondJson(res, 409, { error: `No pairing request from that extension is waiting — ${again}` });
          if (typeof code !== 'string' || code !== pending.code) return respondJson(res, 409, { error: 'That code does not match the waiting pairing request' });
          const verdict = applyRelayPairing(readConfig({ strict: true }), siteId, { extensionId: pending.extensionId, secretHash: pending.secretHash });
          if (!verdict.ok) return respondJson(res, 400, { error: verdict.error });
          saveConfig(verdict.config);
          // Anything else still waiting has to ask again.
          relayPending.clear();
          forgetRelaySite(siteId);
          return respondJson(res, 200, { ok: true, extensionId: pending.extensionId });
        }
        if (url.pathname === '/relay/unpair' && req.method === 'POST') {
          if (!allowEdit) return respondJson(res, 403, { error: 'The Private_CCTV_Feed relay can only be unpaired under the dev server' });
          const read = await readJsonBody(req, RELAY_JSON_MAX_BYTES);
          if (!read.ok) return respondJson(res, read.status, { error: read.error });
          const siteId = read.value?.siteId;
          const verdict = clearRelayPairing(readConfig({ strict: true }), siteId);
          if (!verdict.ok) return respondJson(res, 400, { error: verdict.error });
          saveConfig(verdict.config);
          forgetRelaySite(siteId);
          return respondJson(res, 200, { ok: true });
        }
        if (url.pathname.startsWith('/frame/') && req.method === 'GET') {
          let publicId = '';
          try {
            publicId = decodeURIComponent(url.pathname.slice('/frame/'.length));
          } catch {
            return respondJson(res, 400, { error: 'Bad camera id' });
          }
          const result = await frameFor(publicId);
          if (result.ok) {
            res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': result.contentType, 'X-Private-Camera': result.relay ? 'relay' : 'live' });
            return res.end(result.body);
          }
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': 'image/svg+xml',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
            'X-Private-Camera': 'offline',
          });
          return res.end(offlineSvg(result.name || 'PRIVATE CAMERA', result.reason, result.detail));
        }
        return respondJson(res, 404, { error: 'not found' });
      } catch (error) {
        console.warn('[PrivateCameras] request failed:', error?.code || error?.name || 'error');
        return respondJson(res, 500, { error: STORE_FAILURE_CODES.has(error?.code) ? `Not saved: ${error.message}` : 'Private camera error' });
      }
    });
  };

  return {
    name: 'gev-private-cameras',
    configureServer: (server) => install(server, { allowEdit: true }),
    configurePreviewServer: (server) => install(server, { allowEdit: false }),
  };
}
