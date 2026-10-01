/**
 * Device feeds: the owner's own drones, robots, marine drones, GPS trackers and
 * Ultra Security Packages (a tracker or a phone the map follows and records).
 *
 * Routes under `/api/device-feeds`, all loopback and same-origin only (the same
 * admission gate as Provider Settings and the private cameras):
 *   GET  /status     the setup card's view: shapes and presence flags, no secret
 *   POST /config     add, replace or remove one device (dev server only)
 *   GET  /positions  every device's latest position, for the map layer
 *   GET  /frame/<id> one device's camera picture, fetched with its login
 *   POST /record/<id> append what the map knows around a recording device
 *   ANY  /report/<key> a position sent by a device's own app (see below)
 *
 * "Reports to this app": a phone's tracking app (Traccar Client, OwnTracks,
 * GPSLogger, Overland) sends positions here instead of to a server of the
 * owner's. Those arrive from the phone, not from this page, so the report route
 * is the one route not behind the loopback gate: it is admitted by the device's
 * key alone (32 random bytes, minted when the device is saved), answers nothing
 * but "taken" or "not found", and can only put a position in. Because the dev
 * server itself listens on localhost, the same route is also served on its own
 * small listener (`DEVICE_REPORT_PORT`, default 44173, the app's port with a 4 in front;
 * `DEVICE_REPORT_HOST`, default every interface) that serves that route and
 * nothing else, and runs only while a reporting device is configured. The last
 * report is kept on disk so a restart does not lose the device.
 *
 * A recording is a folder of daily JSON-lines files under
 * `config/device-recordings/<device>/`. It holds where someone's tracker or
 * phone has been, so it is treated like the login store: untracked, never served
 * as a file, written only by this route, and every record in it is re-checked
 * here against the position THIS process knows, not the one the page claims.
 *
 * Addresses and logins never leave this process. The store is an untracked,
 * hardened file (`config/device-feeds.json`), and no URL that names it is ever
 * served. Devices are typically on the owner's own network, so private
 * addresses are allowed here, which is exactly why these routes answer only to
 * this machine.
 */
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { defaultSourceRoot } from './common/source-root.js';
import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';
import { handleUltraPhone, noteSecurityFeedsSaved, noteUltraEndpoint, noteUltraPhone, noteUltraPosition, ultraNetworkPins, ultraOutboundFeedsTrusted } from './ultra-help.js';
import { listenerPolicyParts, localRecordsTrusted, noteLocalDevicesSaved } from '../../src/localIntegrity.mjs';
import { hardenPrivateFolder, replaceCredentialStore } from '../../src/keySetupHardening.mjs';
import {
  DEVICE_FEED_MIN_POLL_MS,
  DEVICE_FEED_STORE,
  DEVICE_RECORDING_DIR,
  applyDeviceFeedUpdate,
  buildDeviceRecordingLine,
  deviceFeedPublicId,
  deviceFeedRequest,
  deviceFeedStatus,
  devicePositionUrl,
  devicePublicRecord,
  deviceReportReply,
  emptyDeviceFeedConfig,
  extractDevicePosition,
  methodReportsIn,
  normalizeDeviceFeedConfig,
  parseDeviceReport,
  trackedDevicePolicyRecords,
  recordRadiusKm,
  thinTrackPoints,
  trackFromRecordingLines,
} from '../../src/deviceFeedsCore.mjs';
import {
  digestAuthorization,
  parseDigestChallenge,
  privateFetchSiteAllowed,
} from './private-cameras.js';
import { createMotionJpegScanner } from './cctv/media.js';

export const DEVICE_FEED_TIMEOUT_MS = 8000;
export const DEVICE_FEED_POSITION_MAX_BYTES = 2 * 1024 * 1024;
export const DEVICE_FEED_PICTURE_MAX_BYTES = 16 * 1024 * 1024;
const CONFIG_BODY_LIMIT = 64 * 1024;
export const DEVICE_RECORD_BODY_LIMIT = 16 * 1024 * 1024;
/** A phone's report is a few hundred bytes; a batch of buffered ones a few kilobytes. */
export const DEVICE_REPORT_BODY_LIMIT = 64 * 1024;
export const DEVICE_REPORT_DEFAULT_PORT = 44173;
const LAST_REPORT_FILE = 'last-report.json';
const REFUSAL_LOG_MS = 60_000;
const REPORT_MAX_CONNECTIONS = 256;

/** A header or address as the log may show it: printable ASCII only. */
const printable = (value) => String(value ?? '').replace(/[^\x20-\x7e]/g, '');
/** How often, and how long, the listener retries a port a restarting dev server still holds. */
const LISTEN_RETRIES = 10;
const LISTEN_RETRY_MS = 1000;
/** A recording device's surroundings are saved no more often than this. */
export const DEVICE_RECORD_MIN_INTERVAL_MS = 10_000;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const PICTURE_TTL_MS = 4000;
const IMAGE_TYPE = /^image\/(jpeg|pjpeg|png|webp|gif)\b/i;
const STORE_NAME_PATTERN = /device-feeds\.json|device-recordings|ultra-help\.json|ultra-tokens\.(?:json|key)|ultra-inbox\.json|ultra-network\.json|ultra-outbound\.json|local-integrity\.(?:json|key)|social-accounts\.(?:json|key)/i;
const STORE_FAILURE_CODES = new Set(['GEV_HARDEN_FAILED', 'GEV_STORE_UNREADABLE', 'GEV_STORE_REPLACE_REFUSED']);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, private',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Whether a URL could reach the device store, or a recording, through the server's static file handling. */
export function isDeviceFeedStoreRequest(rawUrl, { sourceRoot = defaultSourceRoot, realpath = (file) => fs.realpathSync.native(file) } = {}) {
  const raw = String(rawUrl || '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed escape is checked as written.
  }
  if (STORE_NAME_PATTERN.test(raw) || STORE_NAME_PATTERN.test(decoded)) return true;
  const pathname = decoded.split(/[?#]/)[0].replace(/\\/g, '/');
  // A Windows 8.3 short name (DEVICE~1.JSO) is resolved to its real file first.
  if (!pathname.includes('~')) return false;
  const candidate = pathname.startsWith('/@fs/') ? pathname.slice('/@fs/'.length) : path.join(sourceRoot, pathname);
  try {
    return STORE_NAME_PATTERN.test(realpath(candidate));
  } catch {
    return false;
  }
}

async function readCapped(response, maxBytes) {
  if (!response.body) return null;
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      try {
        await response.body.cancel();
      } catch {
        /* already closed */
      }
      return null;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

/**
 * One request to a device with its login. Bearer and key logins go on the first
 * request; a username and password answer a challenge (Digest preferred, Basic
 * only when that is what the device asks for). A redirect is refused: a login
 * is never carried to wherever a device points.
 * @returns {Promise<Response>}
 */
export async function fetchDeviceResource(feed, address, { fetchImpl = fetch, signal } = {}) {
  const request = deviceFeedRequest(feed, address);
  const go = (headers) => fetchImpl(request.url, { headers, signal, redirect: 'manual' });
  let response = await go(request.headers);
  if (response.status === 401 && request.basic) {
    const header = response.headers.get('www-authenticate') || '';
    try {
      await response.body?.cancel();
    } catch {
      /* already closed */
    }
    const challenge = parseDigestChallenge(header);
    const target = new URL(request.url);
    let authorization = '';
    if (challenge) {
      authorization = digestAuthorization({ method: 'GET', uri: `${target.pathname}${target.search}`, username: request.basic.username, password: request.basic.password, challenge });
    } else if (/^\s*basic\b/i.test(header)) {
      authorization = `Basic ${Buffer.from(`${request.basic.username}:${request.basic.password}`).toString('base64')}`;
    }
    if (authorization) response = await go({ ...request.headers, Authorization: authorization });
  }
  return response;
}

function readCappedBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (overflowed) => {
      if (settled) return;
      settled = true;
      resolve({ overflowed, body: overflowed ? Buffer.alloc(0) : Buffer.concat(chunks) });
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        finish(true);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(false));
    req.on('close', () => finish(false));
    req.on('error', () => finish(false));
  });
}

const REPORT_KEY = /^[A-Za-z0-9_-]{43}$/;

/** The key a report presents: `/report/<key>`, `/<key>`, or `?id=<key>` (Traccar Client's device identifier). */
export function reportKeyOf(url) {
  const segments = url.pathname.split('/').filter(Boolean);
  const fromPath = segments[0] === 'report' || segments[0] === 'api' ? segments[segments.length - 1] : segments[0];
  const fromId = url.searchParams.get('id') || url.searchParams.get('deviceid') || url.searchParams.get('device');
  return [fromPath, fromId].find((value) => REPORT_KEY.test(value || '')) || '';
}

/** The IPv4 addresses this machine answers on, for the setup card. */
function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family === 'IPv4' || entry.family === 4) {
        // A link-local address (a VPN adapter that is not signed in) reaches nothing.
        if (!entry.internal && !entry.address.startsWith('169.254.')) out.push(entry.address);
      }
    }
  }
  return out;
}

/**
 * Vite plugin for the device feed routes.
 * @param {{sourceRoot?: string, fetchImpl?: Function, listen?: boolean, reportPort?: number, reportHost?: string}} options
 *   `listen: false` never opens the report listener (tests); `reportPort` 0
 *   takes any free port.
 */
export function deviceFeedsProxy({ sourceRoot = defaultSourceRoot, fetchImpl, listen = true, reportPort, reportHost, reportMaxConnections = REPORT_MAX_CONNECTIONS, hardenFolder = hardenPrivateFolder } = {}) {
  const storePath = path.join(sourceRoot, DEVICE_FEED_STORE);
  let cache = { stamp: '', config: emptyDeviceFeedConfig(), unreadable: false };
  /** feed id -> {position, at, error, failures, nextAt, pending} */
  const live = new Map();
  const pictures = new Map();
  const doFetch = (...args) => (fetchImpl || fetch)(...args);

  /**
   * The store, re-read when the file changes. A store that exists but cannot be
   * read shows no device; a SAVE over it is refused (`strict`), because that
   * would erase every device in it.
   */
  const readConfig = ({ strict = false } = {}) => {
    let stamp = 'missing';
    try {
      const stat = fs.statSync(storePath);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      stamp = 'missing';
    }
    if (stamp !== cache.stamp) {
      let config = emptyDeviceFeedConfig();
      let unreadable = false;
      if (stamp !== 'missing') {
        try {
          config = normalizeDeviceFeedConfig(JSON.parse(fs.readFileSync(storePath, 'utf8')));
        } catch (error) {
          unreadable = true;
          // The parser's message quotes the file around the fault, and the file holds device passwords and report keys: only the kind of failure is said.
          const why = error instanceof SyntaxError ? 'not valid JSON' : error?.code || 'unreadable';
          console.warn(`[Device feeds] ${DEVICE_FEED_STORE} could not be read (${why}); no device is shown until it is fixed.`);
        }
      }
      cache = { stamp, config, unreadable };
      // A store edited by hand, or by a save, decides whether reports are listened for.
      syncListener(config);
    }
    if (strict && cache.unreadable) {
      throw Object.assign(new Error(`${DEVICE_FEED_STORE} exists but cannot be read; fix or remove it first`), { code: 'GEV_STORE_UNREADABLE' });
    }
    return cache.config;
  };

  const saveConfig = (config) => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    replaceCredentialStore(storePath, `${JSON.stringify(config, null, 2)}\n`);
    cache = { stamp: '', config: emptyDeviceFeedConfig(), unreadable: false };
    // The device file is already saved. A check that cannot be written must
    // not turn that save into a 500, and the warning carries no secret.
    try {
      noteSecurityFeedsSaved(config, sourceRoot);
    } catch (error) {
      console.warn(`[Device feeds] Phone package check was not saved (${String(error?.code || 'error').slice(0, 40)})`);
    }
    // A phone package is not part of the device check. An empty other list is
    // still stamped, so a drone added by hand afterwards is not fetched. The
    // same save stamps the report address and certificate paths in use now.
    try {
      noteLocalDevicesSaved(sourceRoot, trackedDevicePolicyRecords(config));
    } catch (error) {
      console.warn(`[Device feeds] Device and report address checks were not saved (${String(error?.code || 'error').slice(0, 40)})`);
    }
  };

  /** Drones, robots, marine drones and trackers. A phone package is judged apart. */
  const trackedDevicesTrusted = () => {
    try {
      return localRecordsTrusted(sourceRoot, 'devices', trackedDevicePolicyRecords(readConfig()));
    } catch {
      return false;
    }
  };

  const respondJson = (res, status, payload) => {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
    res.end(JSON.stringify(payload));
  };

  // ---- recordings ---------------------------------------------------------
  const recordingRoot = path.join(sourceRoot, DEVICE_RECORDING_DIR);
  let recordingsPrivate = false;

  /**
   * The recordings are a phone's location history, and its last report is
   * the position SEND HELP publishes after a restart: this account only, as
   * the login store is. The folder is restricted once a process, and again
   * when it is made anew; everything inside inherits that, so no write needs
   * the hardener. A folder that cannot be restricted is said once and still
   * written, as before.
   */
  const privateRecordingRoot = () => {
    const made = !fs.existsSync(recordingRoot);
    fs.mkdirSync(recordingRoot, { recursive: true, mode: 0o700 });
    if (recordingsPrivate && !made) return;
    recordingsPrivate = true;
    if (!hardenFolder(recordingRoot)) {
      console.warn(`[Device feeds] ${DEVICE_RECORDING_DIR} could not be restricted to your account; other accounts on this computer may be able to read the recorded positions.`);
    }
  };
  /** feed id -> when its last line was saved */
  const lastRecordedAt = new Map();

  /** How much has been saved for one device: files, bytes, and the newest file's time. */
  const recordingInfo = (feedId) => {
    try {
      let bytes = 0;
      let lastAt = 0;
      const names = fs.readdirSync(path.join(recordingRoot, feedId)).filter((name) => name.endsWith('.jsonl'));
      for (const name of names) {
        const stat = fs.statSync(path.join(recordingRoot, feedId, name));
        bytes += stat.size;
        lastAt = Math.max(lastAt, stat.mtimeMs);
      }
      return names.length ? { files: names.length, bytes, lastAt: Math.round(lastAt), folder: `${DEVICE_RECORDING_DIR}/${feedId}` } : null;
    } catch {
      return null;
    }
  };

  const appendRecording = (feedId, line, at) => {
    privateRecordingRoot();
    const folder = path.join(recordingRoot, feedId);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, `${new Date(at).toISOString().slice(0, 10)}.jsonl`);
    const created = !fs.existsSync(file);
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    if (created) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* a filesystem without modes */
      }
    }
    return file;
  };

  /**
   * The route a device's recording holds, oldest first, for the map to draw:
   * the last `days` daily files (default 30, at most 366), thinned to
   * DEVICE_TRACK_MAX_POINTS. Only positions come back, never what was
   * recorded around them.
   */
  const serveTrack = (res, publicId, query) => {
    const feed = readConfig().feeds.find((item) => deviceFeedPublicId(item) === publicId);
    if (!feed) {
      respondJson(res, 404, { error: 'No such device' });
      return;
    }
    const days = Math.min(366, Math.max(1, Number.parseInt(query.get('days'), 10) || 30));
    let names = [];
    try {
      names = fs.readdirSync(path.join(recordingRoot, feed.id)).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().slice(-days);
    } catch {
      names = [];
    }
    let text = '';
    for (const name of names) {
      try {
        text += `${fs.readFileSync(path.join(recordingRoot, feed.id, name), 'utf8')}\n`;
      } catch {
        /* a file being written; the next ask sees it */
      }
    }
    const all = trackFromRecordingLines(text);
    const points = thinTrackPoints(all);
    const info = recordingInfo(feed.id);
    respondJson(res, 200, { id: publicId, days: names.length, from: all[0]?.at ?? null, to: all[all.length - 1]?.at ?? null, total: all.length, points, lastAt: info?.lastAt ?? null });
  };

  const serveRecord = async (req, res, publicId) => {
    const feed = readConfig().feeds.find((item) => deviceFeedPublicId(item) === publicId);
    if (!feed) {
      respondJson(res, 404, { error: 'No such device' });
      return;
    }
    if (!feed.record) {
      respondJson(res, 409, { error: 'Recording is off for this device' });
      return;
    }
    const now = Date.now();
    if (now - (lastRecordedAt.get(feed.id) || 0) < DEVICE_RECORD_MIN_INTERVAL_MS) {
      respondJson(res, 429, { error: 'Saved a moment ago' });
      return;
    }
    const { overflowed, body } = await readCappedBody(req, DEVICE_RECORD_BODY_LIMIT);
    if (overflowed) {
      respondJson(res, 413, { error: 'Request too large' });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8') || '{}');
    } catch {
      respondJson(res, 400, { error: 'Invalid JSON' });
      return;
    }
    // Where the device is, as this process knows it; never as the page says.
    const position = live.get(feed.id)?.position || (feed.lat !== null && feed.lon !== null ? { lat: feed.lat, lon: feed.lon } : null);
    const built = buildDeviceRecordingLine(parsed, position, { at: now, radiusKm: recordRadiusKm(feed.recordKm) });
    if (!built.ok) {
      respondJson(res, 409, { error: built.error });
      return;
    }
    appendRecording(feed.id, { device: feed.name, kind: feed.kind, ...built.line }, now);
    lastRecordedAt.set(feed.id, now);
    respondJson(res, 200, { saved: built.kept, recording: recordingInfo(feed.id) });
  };

  const stateOf = (feed) => {
    const state = live.get(feed.id);
    return state ? { ok: Boolean(state.position), at: state.at || null, error: state.error || '' } : null;
  };

  const statusFor = (config) => {
    recallReports(config);
    const states = new Map();
    for (const feed of config.feeds) {
      const state = stateOf(feed);
      if (state) states.set(feed.id, state);
    }
    const recordings = new Map();
    for (const feed of config.feeds) {
      const info = recordingInfo(feed.id);
      if (info) recordings.set(feed.id, info);
    }
    return {
      ...deviceFeedStatus(config, { live: states, recordings, reportAddresses: reportAddresses() }),
      reportListener: { port: listener.port, wanted: listen && listenerWanted && config.feeds.some((feed) => methodReportsIn(feed.method)), error: listener.error },
    };
  };

  /** Ask one device for its position, no more often than the floor, backing off while it fails. */
  const refreshPosition = (feed) => {
    const address = devicePositionUrl(feed);
    if (!address) return null;
    let state = live.get(feed.id);
    if (!state) {
      state = { position: null, at: 0, error: '', failures: 0, nextAt: 0, pending: null };
      live.set(feed.id, state);
    }
    const now = Date.now();
    if (state.pending || now < state.nextAt) return state.pending;
    // A rewritten phone package is not fetched. Leave nextAt alone so the
    // next poll, after the owner saves the package again, asks at once.
    if (feed.kind === 'security' && !ultraOutboundFeedsTrusted(sourceRoot)) {
      state.error = 'the phone package was changed';
      return null;
    }
    if (feed.kind !== 'security' && !trackedDevicesTrusted()) {
      state.error = 'the device package was changed';
      return null;
    }
    state.nextAt = now + DEVICE_FEED_MIN_POLL_MS;
    state.pending = (async () => {
      try {
        const response = await fetchDeviceResource(feed, address, { fetchImpl: doFetch, signal: AbortSignal.timeout(DEVICE_FEED_TIMEOUT_MS) });
        if (!response.ok) {
          try {
            await response.body?.cancel();
          } catch {
            /* already closed */
          }
          throw new Error(response.status >= 300 && response.status < 400 ? 'redirect refused' : `HTTP ${response.status}`);
        }
        const bytes = await readCapped(response, DEVICE_FEED_POSITION_MAX_BYTES);
        if (!bytes) throw new Error('answer too large');
        const text = bytes.toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        const position = extractDevicePosition(feed, { json, text });
        if (!position) throw new Error('no position in the answer');
        Object.assign(state, { position, at: Date.now(), error: '', failures: 0 });
      } catch (error) {
        state.failures += 1;
        state.error = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timed out' : String(error?.message || 'unreachable').slice(0, 120);
        state.nextAt = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(8, state.failures - 1));
      } finally {
        state.pending = null;
      }
    })();
    return state.pending;
  };

  const forget = (config) => {
    const ids = new Set(config.feeds.map((feed) => feed.id));
    for (const id of [...live.keys()]) if (!ids.has(id)) live.delete(id);
    for (const id of [...pictures.keys()]) if (!ids.has(id)) pictures.delete(id);
  };

  // ---- reports in ---------------------------------------------------------
  const port = Number.isInteger(reportPort) ? reportPort : Number.parseInt(process.env.DEVICE_REPORT_PORT, 10) || DEVICE_REPORT_DEFAULT_PORT;
  const host = reportHost || process.env.DEVICE_REPORT_HOST || '0.0.0.0';
  const listener = { server: null, port: null, error: '', scheme: 'http', retries: 0, retryTimer: null };

  /**
   * The address the card tells a phone to send its key to, and the certificate
   * the listener would load. A hand edit that leaves the old check blanks both:
   * the card keeps only this machine's own addresses, and no certificate is read.
   */
  const reportMaterial = () => {
    const parts = listenerPolicyParts();
    let trusted = true;
    try {
      trusted = localRecordsTrusted(sourceRoot, 'listener', parts);
    } catch {
      trusted = false;
    }
    return trusted ? parts : { publicBase: '', publicHost: '', tlsCert: '', tlsKey: '' };
  };

  /**
   * A certificate and key make the listener speak HTTPS, which a phone's
   * browser needs before it will open its camera for the Ultra page (a plain
   * http address is not a secure context). Both files must read, or the
   * listener stays on http and says so.
   */
  const tlsOptions = () => {
    const material = reportMaterial();
    const certPath = material.tlsCert;
    const keyPath = material.tlsKey;
    if (!certPath && !keyPath) return null;
    try {
      return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
    } catch (error) {
      console.warn(`[Device feeds] DEVICE_REPORT_TLS_CERT/KEY could not be read (${error?.message || error}); reports are accepted over http`);
      return null;
    }
  };

  const listenerAddresses = () => {
    if (!listener.port) return [];
    const material = reportMaterial();
    const local = localAddresses().map((address) => `${listener.scheme}://${address}:${listener.port}`);
    const named = material.publicHost ? [`${listener.scheme}://${material.publicHost}:${listener.port}`] : [];
    return [...(material.publicBase ? [material.publicBase] : []), ...named, ...local];
  };

  const lastReportPath = (feedId) => path.join(recordingRoot, feedId, LAST_REPORT_FILE);

  /** The newest report survives a restart: kept beside the device's recordings, with their permissions. */
  const rememberReport = (feed, position, at) => {
    try {
      privateRecordingRoot();
      const folder = path.join(recordingRoot, feed.id);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      fs.writeFileSync(lastReportPath(feed.id), JSON.stringify({ position, at }), { mode: 0o600 });
    } catch (error) {
      console.warn(`[Device feeds] ${feed.name}: the last report could not be kept (${error?.message || error})`);
    }
  };

  /** A reporting device that has not reported since start-up shows where it last was. */
  const recallReports = (config) => {
    for (const feed of config.feeds) {
      if (!methodReportsIn(feed.method) || live.has(feed.id)) continue;
      let kept = null;
      try {
        kept = JSON.parse(fs.readFileSync(lastReportPath(feed.id), 'utf8'));
      } catch {
        kept = null;
      }
      const position = kept?.position && Number.isFinite(kept.position.lat) && Number.isFinite(kept.position.lon) ? kept.position : null;
      // A future fix saved before the clamp above existed counts as now too,
      // or it would go on outranking every true report after a restart.
      const reportedAt = position ? Math.min(Number(position.at) || 0, Date.now()) : 0;
      live.set(feed.id, { position, at: position ? Number(kept.at) || 0 : 0, error: position ? '' : 'no report yet', failures: 0, nextAt: 0, pending: null, reportedAt });
    }
  };

  /** The reporting device a key belongs to, compared in constant time; null for any other key. */
  const feedForKey = (config, key) => {
    if (!REPORT_KEY.test(key || '')) return null;
    const given = Buffer.from(key);
    let found = null;
    for (const feed of config.feeds) {
      if (!methodReportsIn(feed.method) || !feed.reportKey) continue;
      const saved = Buffer.from(feed.reportKey);
      if (saved.length === given.length && timingSafeEqual(saved, given)) found = feed;
    }
    return found;
  };

  /**
   * Take one position from a device's app. A batch flushed from its buffer may
   * arrive out of order: the newest fix wins. A fix dated in the future (a
   * phone clock set ahead, a time read in the wrong unit) counts as now, as
   * noteUltraPosition does: kept as given, it would outrank every true report
   * after it, and the file would carry that across a restart.
   */
  const takeReport = (feed, reported) => {
    const now = Date.now();
    recallReports({ feeds: [feed] });
    const state = live.get(feed.id);
    const future = Number.isFinite(reported.at) && reported.at > now;
    const fixAt = Number.isFinite(reported.at) ? Math.min(reported.at, now) : now;
    const position = future ? { ...reported, at: now } : reported;
    if (state.position && fixAt < state.reportedAt) return false;
    Object.assign(state, { position, at: now, error: '', failures: 0, reportedAt: fixAt });
    if (!state.announced) {
      state.announced = true;
      console.log(`[Device feeds] ${feed.name}: reporting in`);
    }
    rememberReport(feed, position, now);
    if (feed.kind === 'security') {
      // The same fix time as above: a report with no time is dated now, never
      // 1970 (Number(null) is 0), or SEND HELP would call it 56 years old.
      noteUltraPosition({
        key: feed.reportKey,
        name: feed.name,
        lat: position.lat,
        lon: position.lon,
        at: fixAt,
      });
    }
    return true;
  };

  // A refusal is said once a minute for each address (or package): a device
  // looping a wrong address must not fill the terminal or bury the warnings
  // that matter.
  const refusalsSaid = new Map();
  const sayRefusal = (about, line) => {
    const now = Date.now();
    if (now - (refusalsSaid.get(about) ?? -Infinity) < REFUSAL_LOG_MS) return;
    refusalsSaid.delete(about);
    refusalsSaid.set(about, now);
    while (refusalsSaid.size > 1000) refusalsSaid.delete(refusalsSaid.keys().next().value);
    console.warn(line);
  };

  const serveReport = async (req, res, key) => {
    const reply = (status, contentType, body) => {
      res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': contentType, 'Content-Security-Policy': "default-src 'none'" });
      res.end(body);
    };
    const feed = feedForKey(readConfig(), key);
    if (!feed) {
      // Said in the log (never the key itself) so a phone with a mistyped identifier can be told apart from one that never connects.
      const socketAddress = printable(String(req.socket?.remoteAddress || '?').replace(/^::ffff:/i, '')).slice(0, 64);
      // Behind tailscale serve the tunnel names the address and node the request came from; on any other socket those headers are whatever the client typed, so they are not repeated.
      const loopback = /^(127\.|::1$)/.test(socketAddress);
      const forwarded = loopback ? printable(String(req.headers?.['x-forwarded-for'] || '').split(',')[0]).trim().slice(0, 64) : '';
      const from = forwarded ? `${forwarded} via ${socketAddress}` : socketAddress;
      const agent = printable(req.headers?.['user-agent']).slice(0, 40);
      const login = loopback ? printable(req.headers?.['tailscale-user-login']).slice(0, 80) : '';
      const node = login ? `, tailnet user ${login}` : '';
      // The path is shown with every key-sized segment blanked: a help token or a near-miss key typed into the wrong slot must never land in the log.
      const shownPath = `/${String(req.url || '/').split('?')[0].split('/').filter(Boolean).map((segment) => (/[A-Za-z0-9_-]{20,}/.test(segment) ? '<key>' : printable(segment).slice(0, 24))).join('/')}`.slice(0, 120);
      sayRefusal(from, `[Device feeds] Report refused from ${from}: ${key ? 'the identifier is not a saved device key' : 'no identifier or key in the request'} (${printable(req.method).slice(0, 10)} ${shownPath}${agent ? `, ${agent}` : ''}${node})`);
      reply(404, 'text/plain', 'Not found');
      return;
    }
    // One check covers every phone package, so a rewritten address refuses
    // the report key too. Same answer as an unknown key, and the key is not logged.
    if (feed.kind === 'security' && !ultraOutboundFeedsTrusted(sourceRoot)) {
      sayRefusal(`changed:${feed.id}`, '[Device feeds] Report refused: the phone package was changed and is not being used');
      reply(404, 'text/plain', 'Not found');
      return;
    }
    if (feed.kind !== 'security' && !trackedDevicesTrusted()) {
      sayRefusal(`changed:${feed.id}`, '[Device feeds] Report refused: the device package was changed and is not being used');
      reply(404, 'text/plain', 'Not found');
      return;
    }
    if (feed.kind === 'security') {
      // Behind a local proxy (tailscale serve) the socket is loopback; the phone's address is in the forwarded header.
      const socketAddress = String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, '');
      const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
      noteUltraPhone(key, /^(127\.|::1$)/.test(socketAddress) && forwarded ? forwarded : req.socket?.remoteAddress);
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      reply(405, 'text/plain', 'GET or POST');
      return;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const params = Object.fromEntries(url.searchParams);
    let json;
    if (req.method === 'POST') {
      const { overflowed, body } = await readCappedBody(req, DEVICE_REPORT_BODY_LIMIT);
      if (overflowed) {
        reply(413, 'text/plain', 'Too large');
        return;
      }
      const text = body.toString('utf8');
      if (/json/i.test(String(req.headers?.['content-type'] || '')) || /^\s*[[{]/.test(text)) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      } else if (text) {
        for (const [name, value] of new URLSearchParams(text)) if (!(name in params)) params[name] = value;
      }
    }
    const parsed = parseDeviceReport({ params, json });
    if (!parsed) {
      reply(400, 'text/plain', 'No position in the report');
      return;
    }
    takeReport(feed, parsed.position);
    const answer = deviceReportReply(parsed.protocol);
    reply(200, answer.contentType, answer.body);
  };

  /** The listener serves the report route and nothing else; every other path is not found. */
  const startListener = () => {
    if (listener.server || !listen) return;
    const tls = tlsOptions();
    listener.scheme = tls ? 'https' : 'http';
    const handle = async (req, res) => {
      try {
        // A doubled leading slash would otherwise parse as a host, and a typed or dictated /Ultra/ would miss the phone routes and fall into the report log.
        const url = new URL(String(req.url || '/').replace(/^\/{2,}/, '/'), 'http://localhost');
        const segments = url.pathname.split('/').filter(Boolean);
        let first = segments[0] || '';
        try {
          first = decodeURIComponent(first);
        } catch {
          /* Not percent-encoded; keep it as typed. */
        }
        if (first.toLowerCase() === 'ultra') {
          segments[0] = 'ultra';
          await handleUltraPhone(req, res, new URL(`/${segments.join('/')}${url.search}`, 'http://localhost'));
          return;
        }
        await serveReport(req, res, reportKeyOf(url));
      } catch {
        if (!res.headersSent) res.writeHead(500, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
        res.end();
      }
    };
    const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    // A handful of phones and a tailscale serve proxy need a few each; a
    // device holding sockets open must not take the process's handles.
    server.maxConnections = reportMaxConnections;
    server.on('error', (error) => {
      listener.server = null;
      listener.port = null;
      // A dev server restarting in-process still holds the port for a moment
      // through its previous listener: try again before calling it taken.
      if (error?.code === 'EADDRINUSE' && listener.retries < LISTEN_RETRIES) {
        listener.retries += 1;
        clearTimeout(listener.retryTimer);
        listener.retryTimer = setTimeout(() => {
          listener.retryTimer = null;
          // Only while a reporting device is still saved: removing the last
          // one during the retries must not open the port after all.
          if (listenerWanted && !listener.server && reportingDeviceSaved()) startListener();
        }, LISTEN_RETRY_MS);
        listener.retryTimer.unref?.();
        return;
      }
      // Out of retries: the next start (a device saved again, a restart) gets its own.
      listener.retries = 0;
      listener.error = error?.code === 'EADDRINUSE'
        ? `port ${port} is already in use (set DEVICE_REPORT_PORT to another port and restart)`
        : String(error?.message || error);
      console.warn(`[Device feeds] Reports cannot be received: ${listener.error}`);
    });
    server.listen(port, host, () => {
      listener.port = server.address()?.port ?? port;
      listener.error = '';
      listener.retries = 0;
      const bases = listenerAddresses();
      noteUltraEndpoint(bases);
      console.log(`[Device feeds] Reports accepted on port ${listener.port} over ${listener.scheme} (${bases.join(', ') || host})`);
    });
    listener.server = server;
  };

  const stopListener = () => {
    // A retry still waiting for the port is called off with the listener.
    clearTimeout(listener.retryTimer);
    listener.retryTimer = null;
    listener.retries = 0;
    const server = listener.server;
    listener.server = null;
    listener.port = null;
    if (!server) return;
    // A phone polling the camera page keeps a connection open; the port must free at once.
    server.close();
    server.closeAllConnections?.();
  };

  /** Whether a device that reports in is still saved: the only reason to listen. */
  const reportingDeviceSaved = () => readConfig().feeds.some((feed) => methodReportsIn(feed.method));

  /** Listen only while a reporting device is configured; opened and closed as devices come and go. */
  let listenerWanted = false;
  const syncListener = (config) => {
    if (!listenerWanted) return;
    if (config.feeds.some((feed) => methodReportsIn(feed.method))) startListener();
    else stopListener();
  };

  const reportAddresses = () => listenerAddresses();

  const servePositions = async (res) => {
    const config = readConfig();
    recallReports(config);
    // Whatever is already known answers at once; stale devices refresh behind it.
    const waits = config.feeds.map((feed) => {
      const pending = refreshPosition(feed);
      return live.get(feed.id)?.at ? null : pending;
    }).filter(Boolean);
    if (waits.length) await Promise.race([Promise.allSettled(waits), new Promise((resolve) => setTimeout(resolve, 2500))]);
    const devices = [];
    for (const feed of config.feeds) {
      const state = live.get(feed.id);
      const record = devicePublicRecord(feed, state?.position || null, { at: state?.at || null });
      if (!record) continue;
      // What the map needs to know whether a saved route exists and has grown.
      const info = recordingInfo(feed.id);
      devices.push({ ...record, error: state?.error || '', history: info ? { days: info.files, lastAt: info.lastAt } : null });
    }
    // A call for help received from the owner's help network is a pin for
    // this same layer: memory only, never followed and never written to the
    // device store. A package with RECORD on captures it among its
    // surroundings like any other map record (see the CHANGELOG caveat).
    respondJson(res, 200, { devices: [...devices, ...ultraNetworkPins(Date.now())], minPollMs: DEVICE_FEED_MIN_POLL_MS });
  };

  const fetchPicture = async (feed) => {
    if (feed.kind === 'security' && !ultraOutboundFeedsTrusted(sourceRoot)) {
      throw new Error('the phone package was changed');
    }
    if (feed.kind !== 'security' && !trackedDevicesTrusted()) {
      throw new Error('the device package was changed');
    }
    const response = await fetchDeviceResource(feed, feed.pictureUrl, { fetchImpl: doFetch, signal: AbortSignal.timeout(DEVICE_FEED_TIMEOUT_MS) });
    const type = response.headers.get('content-type') || '';
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      throw new Error(response.status >= 300 && response.status < 400 ? 'redirect refused' : `HTTP ${response.status}`);
    }
    // A motion-JPEG camera (web_video_server, most IP cameras): its first picture.
    if (/^multipart\/x-mixed-replace/i.test(type)) {
      const boundary = (/boundary="?([^";]+)"?/i.exec(type)?.[1] || '').replace(/^-+/, '');
      const scanner = createMotionJpegScanner(boundary);
      let total = 0;
      let frame = null;
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > DEVICE_FEED_PICTURE_MAX_BYTES) break;
        frame = scanner.push(chunk);
        if (frame) break;
      }
      try {
        await response.body.cancel();
      } catch {
        /* already closed */
      }
      if (!frame) throw new Error('no picture in the stream');
      return { body: frame, contentType: 'image/jpeg' };
    }
    if (!IMAGE_TYPE.test(type)) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      throw new Error('not a picture');
    }
    const body = await readCapped(response, DEVICE_FEED_PICTURE_MAX_BYTES);
    if (!body) throw new Error('picture too large');
    return { body, contentType: type.split(';')[0] };
  };

  const serveFrame = async (res, publicId) => {
    const feed = readConfig().feeds.find((item) => deviceFeedPublicId(item) === publicId);
    if (!feed || !feed.pictureUrl) {
      respondJson(res, 404, { error: 'No picture for this device' });
      return;
    }
    let held = pictures.get(feed.id);
    const now = Date.now();
    if (!held || (!held.pending && now - held.at > PICTURE_TTL_MS && now >= (held.nextAt || 0))) {
      const entry = { at: now, picture: held?.picture || null, failures: held?.failures || 0, nextAt: 0, pending: null };
      entry.pending = fetchPicture(feed).then((picture) => {
        Object.assign(entry, { picture, at: Date.now(), failures: 0, pending: null });
      }).catch(() => {
        entry.failures += 1;
        entry.pending = null;
        entry.nextAt = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(8, entry.failures - 1));
      });
      pictures.set(feed.id, entry);
      held = entry;
    }
    if (held.pending) await held.pending;
    if (!held.picture) {
      respondJson(res, 502, { error: 'The device did not give a picture' });
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': held.picture.contentType, 'Content-Security-Policy': "default-src 'none'" });
    res.end(held.picture.body);
  };

  const install = (server, { allowEdit }) => {
    // First, on dev and preview alike: the store is never served as a file.
    server.middlewares.use((req, res, next) => {
      if (!isDeviceFeedStoreRequest(req.url, { sourceRoot })) return next();
      respondJson(res, 404, { error: 'Not found' });
      return undefined;
    });
    server.middlewares.use('/api/device-feeds', async (req, res) => {
      try {
        // A device's report is admitted by its key, not by where it comes from.
        const reportUrl = new URL(req.url || '/', 'http://localhost');
        if (reportUrl.pathname === '/report' || reportUrl.pathname.startsWith('/report/')) {
          await serveReport(req, res, reportKeyOf(reportUrl));
          return;
        }
        const admitted = admitKeySetupRequest({
          method: req.method,
          remoteAddress: req.socket?.remoteAddress,
          hostHeader: req.headers?.host,
          protocol: req.socket?.encrypted ? 'https:' : 'http:',
          origin: req.headers?.origin,
          contentType: req.headers?.['content-type'],
          proxyHeaders: req.headers || {},
          env: process.env,
        });
        if (!admitted.ok) {
          respondJson(res, admitted.status || 403, { error: String(admitted.error || 'Refused').replace('Provider Settings', 'Device feeds') });
          return;
        }
        if (!privateFetchSiteAllowed(req.headers)) {
          respondJson(res, 403, { error: 'Cross-site request refused' });
          return;
        }
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname === '/status' && req.method === 'GET') {
          respondJson(res, 200, { ...statusFor(readConfig()), editable: allowEdit });
          return;
        }
        if (url.pathname.startsWith('/track/') && req.method === 'GET') {
          serveTrack(res, decodeURIComponent(url.pathname.slice('/track/'.length)), url.searchParams);
          return;
        }
        if (url.pathname === '/positions' && req.method === 'GET') {
          await servePositions(res);
          return;
        }
        if (url.pathname.startsWith('/frame/') && req.method === 'GET') {
          await serveFrame(res, decodeURIComponent(url.pathname.slice('/frame/'.length)));
          return;
        }
        if (url.pathname.startsWith('/record/') && req.method === 'POST') {
          await serveRecord(req, res, decodeURIComponent(url.pathname.slice('/record/'.length)));
          return;
        }
        if (url.pathname === '/config' && req.method === 'POST') {
          if (!allowEdit) {
            respondJson(res, 403, { error: 'Editing is available under the dev server only' });
            return;
          }
          const { overflowed, body } = await readCappedBody(req, CONFIG_BODY_LIMIT);
          if (overflowed) {
            respondJson(res, 413, { error: 'Request too large' });
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(body.toString('utf8') || '{}');
          } catch {
            respondJson(res, 400, { error: 'Invalid JSON' });
            return;
          }
          const result = applyDeviceFeedUpdate(parsed, readConfig({ strict: true }));
          if (!result.ok) {
            respondJson(res, 400, { error: result.error });
            return;
          }
          saveConfig(result.config);
          const config = readConfig();
          forget(config);
          // A changed device is asked again at once, with its new address or login.
          if (result.feedId) {
            live.delete(result.feedId);
            pictures.delete(result.feedId);
          }
          respondJson(res, 200, { status: { ...statusFor(config), editable: allowEdit }, feedId: result.feedId || null });
          return;
        }
        respondJson(res, 404, { error: 'Unknown device feed route' });
      } catch (error) {
        const message = STORE_FAILURE_CODES.has(error?.code) ? `Not saved: ${error.message}` : 'Device feed request failed';
        if (!res.headersSent) respondJson(res, 500, { error: message });
        else res.end();
      }
    });
  };

  return {
    name: 'gev-device-feeds',
    configureServer: (server) => {
      install(server, { allowEdit: true });
      // The report listener lives with the dev server: opened when a reporting
      // device exists, closed with the server (a config change restarts it).
      listenerWanted = true;
      cache = { stamp: '', config: emptyDeviceFeedConfig(), unreadable: false };
      readConfig();
      server.httpServer?.once?.('close', () => {
        listenerWanted = false;
        stopListener();
      });
    },
    configurePreviewServer: (server) => install(server, { allowEdit: false }),
    /** For tests: where reports are being listened for right now. */
    reportListener: () => ({ port: listener.port, error: listener.error }),
    stopReportListener: stopListener,
  };
}
