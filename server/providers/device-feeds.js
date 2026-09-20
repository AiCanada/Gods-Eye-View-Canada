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
import fs from 'node:fs';
import path from 'node:path';
import { defaultSourceRoot } from './common/source-root.js';
import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';
import { replaceCredentialStore } from '../../src/keySetupHardening.mjs';
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
  emptyDeviceFeedConfig,
  extractDevicePosition,
  normalizeDeviceFeedConfig,
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
/** A recording device's surroundings are saved no more often than this. */
export const DEVICE_RECORD_MIN_INTERVAL_MS = 10_000;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const PICTURE_TTL_MS = 4000;
const IMAGE_TYPE = /^image\/(jpeg|pjpeg|png|webp|gif)\b/i;
const STORE_NAME_PATTERN = /device-feeds\.json|device-recordings/i;
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

/** Vite plugin for the device feed routes. */
export function deviceFeedsProxy({ sourceRoot = defaultSourceRoot, fetchImpl } = {}) {
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
          console.warn(`[Device feeds] ${DEVICE_FEED_STORE} could not be read (${error?.message || error}); no device is shown until it is fixed.`);
        }
      }
      cache = { stamp, config, unreadable };
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
    const built = buildDeviceRecordingLine(parsed, position, { at: now });
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
    return deviceFeedStatus(config, { live: states, recordings });
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

  const servePositions = async (res) => {
    const config = readConfig();
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
      if (record) devices.push({ ...record, error: state?.error || '' });
    }
    respondJson(res, 200, { devices, minPollMs: DEVICE_FEED_MIN_POLL_MS });
  };

  const fetchPicture = async (feed) => {
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
    configureServer: (server) => install(server, { allowEdit: true }),
    configurePreviewServer: (server) => install(server, { allowEdit: false }),
  };
}
