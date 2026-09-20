// GEV Private_CCTV_Feed Relay service worker (module). All network work happens here
// because content scripts cannot reach localhost. It downloads the newest clip
// thumbnail without credentials and relays only the picture bytes, the camera
// name and a short clip label to Gods Eye View on this computer. Thumbnail
// addresses stay in memory: they are never logged, stored or sent to GEV.
import './relay-config.js';
import './relay-logic.js';

const relay = globalThis.GevPrivateCctvFeedRelay;
const GEV_ORIGIN = relay.GEV_ORIGIN;
const PRIVATE_CCTV_FEED_ORIGIN = relay.FEED_ORIGIN;
const DB_NAME = 'gev-private-cctv-feed-relay';
const DB_VERSION = 1;
const STORE_NAME = 'pairing';
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RECENT_LIMIT = 20;
const SEEN_LIMIT = 20;
const JSON_MAX_BYTES = 4096;
const RATE_LIMIT_RETRY_MS = 2500;
// A feed name GEV does not know is tried again only this rarely (the heartbeat
// answer normally stops such sends before any thumbnail is downloaded).
const UNKNOWN_CAMERA_RETRY_MS = 10 * 60 * 1000;
// Two feed tabs sending the same clip picture within this window share one push.
const RECENT_PUSH_MS = 60 * 1000;
// How often a feed tab's heartbeat may ask GEV whether a waiting pairing was approved.
const PROMOTION_CHECK_MS = 10 * 1000;
const PAGE_MESSAGES = new Set(['frame', 'heartbeat']);
const OPTIONS_MESSAGES = new Set(['pair', 'pair-status', 'forget', 'status']);
const THUMBNAIL_FETCH_OPTIONS = Object.freeze({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
const GEV_FETCH_OPTIONS = Object.freeze({ credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });

const recent = []; // newest first: { at, camera, outcome } only, never an address
const lastPushed = new Map(); // normalized camera name -> { key, epoch, at }
const inflightFrames = new Map();
let lastHeartbeat = null;
let databasePromise = null;
let epochMemo = { secret: '', epoch: '' };
let promotionCheckedAt = 0;
let pairingQueue = Promise.resolve();
// The epoch of the stored secret GEV last answered "not paired" to (a heartbeat,
// a picture or a pairing check), so the options page can say so. Memory only,
// and an opaque tag, never the secret.
let refusedEpoch = '';

// Every read-then-write of the pairing (pair, pair-status, forget and the
// promotion a heartbeat may do) runs one at a time, so none of them can drop a
// secret another one has just stored.
function serialized(task) {
  const run = pairingQueue.then(task, task);
  pairingQueue = run.catch(() => {});
  return run;
}

// Whether GEV just took (true) or refused (false) the stored secret with this epoch.
function noteRecognised(epoch, recognised) {
  if (!epoch) return;
  if (!recognised) refusedEpoch = epoch;
  else if (refusedEpoch === epoch) refusedEpoch = '';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && typeof message === 'object' && typeof message.type === 'string' ? message.type : '';
  const handler = handlerFor(type);
  if (!handler || !allowedSender(type, sender)) return false;
  handler(message, sender).then(sendResponse, () => sendResponse({ ok: false, error: 'The relay hit an unexpected error' }));
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details && details.reason === 'install') chrome.runtime.openOptionsPage().catch(() => {});
});

function handlerFor(type) {
  switch (type) {
    case 'frame':
      return handleFrame;
    case 'heartbeat':
      return handleHeartbeat;
    case 'pair':
      return handlePair;
    case 'pair-status':
      return handlePairStatus;
    case 'forget':
      return handleForget;
    case 'status':
      return handleStatus;
    default:
      return null;
  }
}

function isOptionsPage(url) {
  if (typeof url !== 'string') return false;
  const page = chrome.runtime.getURL('options.html');
  return url === page || url.startsWith(`${page}?`) || url.startsWith(`${page}#`);
}

function allowedSender(type, sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (PAGE_MESSAGES.has(type)) return sender.origin === PRIVATE_CCTV_FEED_ORIGIN && sender.frameId === 0 && Boolean(sender.tab);
  if (OPTIONS_MESSAGES.has(type)) return isOptionsPage(sender.url);
  return false;
}

// ---- pairing storage (IndexedDB only) ----

function validSecret(value) {
  return typeof value === 'string' && SECRET_PATTERN.test(value) ? value : '';
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      database.onclose = () => {
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error('Pairing storage is not available'));
    request.onblocked = () => reject(new Error('Pairing storage is busy'));
  });
}

function database() {
  if (!databasePromise) {
    databasePromise = openDatabase().catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

async function readPairing() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const secretRequest = store.get('secret');
    const pendingRequest = store.get('pendingSecret');
    transaction.oncomplete = () => resolve({ secret: validSecret(secretRequest.result), pendingSecret: validSecret(pendingRequest.result) });
    transaction.onerror = () => reject(transaction.error || new Error('Pairing storage read failed'));
    transaction.onabort = () => reject(transaction.error || new Error('Pairing storage read failed'));
  });
}

async function writePairing(changes) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    for (const key of ['secret', 'pendingSecret']) {
      if (!Object.hasOwn(changes, key)) continue;
      if (validSecret(changes[key])) store.put(changes[key], key);
      else store.delete(key);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Pairing storage write failed'));
    transaction.onabort = () => reject(transaction.error || new Error('Pairing storage write failed'));
  });
}

// An opaque, domain-separated tag that changes when the pairing changes, so the
// content script knows to send its pictures again. It is not the secret or the
// hash GEV stores.
async function epochFor(secret) {
  if (!secret) return '';
  if (epochMemo.secret !== secret) {
    const epoch = (await relay.sha256Hex(`gev-private-cctv-feed-relay-epoch:${secret}`)).slice(0, 16);
    epochMemo = { secret, epoch };
  }
  return epochMemo.epoch;
}

// An opaque tag for the tab a heartbeat comes from, so GEV believes a tab's own
// sign-out at once while a sign-in page left open in another tab still cannot
// override the tab reading the feed. It is a hash of the pairing epoch and the
// tab id, never the tab id itself or anything from Private_CCTV_Feed.
async function reporterFor(sender, epoch) {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (!epoch || !Number.isInteger(tabId) || tabId < 0) return '';
  return (await relay.sha256Hex(`gev-private-cctv-feed-relay-tab:${epoch}:${tabId}`)).slice(0, 16);
}

// ---- diagnostics (memory only) ----

function record(camera, outcome) {
  const name = relay.cleanLabel(camera, 60);
  const existing = recent.findIndex((entry) => entry.camera === name && entry.outcome === outcome);
  if (existing >= 0) recent.splice(existing, 1);
  recent.unshift({ at: Date.now(), camera: name, outcome });
  if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
}

function refusedAddressOutcome(url) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch (_) {
    return 'unsupported host: not an address';
  }
  if (relay.ALLOWED_IMAGE_HOSTS.includes(hostname)) return 'unsupported picture address';
  return `unsupported host: ${relay.cleanLabel(hostname, 100) || 'none'}`;
}

// ---- response bodies ----

function discardBody(response) {
  try {
    if (response.body && !response.bodyUsed) response.body.cancel().catch(() => {});
  } catch (_) {
    // Nothing to release.
  }
}

async function readBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    discardBody(response);
    return null;
  }
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return whole.byteLength > maxBytes ? null : whole;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJson(response) {
  try {
    const bytes = await readBody(response, JSON_MAX_BYTES);
    if (!bytes || !bytes.byteLength) return null;
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

// ---- messages from the Private_CCTV_Feed feed tab ----

async function handleFrame(message) {
  const camera = relay.cleanLabel(message.camera);
  const url = typeof message.url === 'string' ? message.url : '';
  const clip = relay.cleanLabel(message.clip, relay.CLIP_MAX_LENGTH);
  const matchKey = relay.normalizeCameraName(camera);
  const pairing = await readPairing();
  const epoch = await epochFor(pairing.secret);
  const base = { paired: Boolean(pairing.secret), epoch };
  if (!matchKey) return { ...base, ok: false, done: true, refused: true };
  if (camera.length > relay.CAMERA_NAME_MAX_LENGTH) {
    record(camera, 'camera name too long');
    return { ...base, ok: false, done: true, refused: true };
  }
  if (!relay.isAllowedThumbnailUrl(url)) {
    record(camera, refusedAddressOutcome(url));
    return { ...base, ok: false, done: true, refused: true };
  }
  if (!pairing.secret) return { ...base, ok: false, done: false, gevReady: false };
  const key = relay.urlKey(url);
  const last = lastPushed.get(matchKey);
  if (last && last.key === key && last.epoch === epoch && Date.now() - last.at < RECENT_PUSH_MS) return { ...base, ok: true, done: true };
  const flightKey = JSON.stringify([epoch, matchKey, key]);
  let flight = inflightFrames.get(flightKey);
  if (!flight) {
    flight = pushFrame({ secret: pairing.secret, epoch, camera, matchKey, key, url, clip }).finally(() => inflightFrames.delete(flightKey));
    inflightFrames.set(flightKey, flight);
  }
  return { ...base, ...(await flight) };
}

async function pushFrame({ secret, epoch, camera, matchKey, key, url, clip }) {
  let bytes;
  try {
    const thumbnail = await fetch(url, THUMBNAIL_FETCH_OPTIONS);
    const contentType = String(thumbnail.headers.get('content-type') || '')
      .trim()
      .toLowerCase();
    if (!thumbnail.ok || !contentType.startsWith('image/')) {
      // Final for this picture address: it is never requested again (an expired link stays expired).
      discardBody(thumbnail);
      record(camera, `thumbnail refused (HTTP ${thumbnail.status})`);
      return { ok: false, done: true, refused: true };
    }
    bytes = await readBody(thumbnail, relay.THUMBNAIL_MAX_BYTES);
  } catch (_) {
    record(camera, 'thumbnail not reachable');
    return { ok: false, done: false };
  }
  if (!bytes) {
    record(camera, 'thumbnail too large');
    return { ok: false, done: true, refused: true };
  }
  const type = relay.sniffImageType(bytes);
  if (!type) {
    record(camera, 'thumbnail is not a picture');
    return { ok: false, done: true, refused: true };
  }
  const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': type, 'X-Private-Cctv-Feed-Camera': encodeURIComponent(camera) };
  if (clip) headers['X-Private-Cctv-Feed-Clip'] = encodeURIComponent(clip);
  let answer;
  try {
    answer = await fetch(`${GEV_ORIGIN}/api/private-cams/relay/frame`, { ...GEV_FETCH_OPTIONS, method: 'POST', headers, body: bytes });
  } catch (_) {
    // GEV refuses an upload it will not take without reading it and drops the
    // connection, which can surface here as a network error: ask GEV which it was.
    const check = await askPairStatus(secret);
    if (check.reachable && check.status === 401) {
      noteRecognised(epoch, false);
      record(camera, 'not paired');
      return { ok: false, done: false, gevReady: false };
    }
    record(camera, check.reachable ? 'GEV dropped the upload' : 'GEV not reachable');
    return { ok: false, done: false, gevReady: check.reachable };
  }
  discardBody(answer);
  const status = answer.status;
  if (status === 204) {
    noteRecognised(epoch, true);
    lastPushed.set(matchKey, { key, epoch, at: Date.now() });
    record(camera, 'sent');
    return { ok: true, done: true };
  }
  if (status === 404) {
    record(camera, 'unknown camera name');
    return { ok: false, done: false, retryAfterMs: UNKNOWN_CAMERA_RETRY_MS };
  }
  if (status === 401 || status === 403) {
    noteRecognised(epoch, false);
    record(camera, 'not paired');
    return { ok: false, done: false, gevReady: false };
  }
  if (status === 429) {
    record(camera, 'rate limited');
    return { ok: false, done: false, retryAfterMs: RATE_LIMIT_RETRY_MS };
  }
  record(camera, `GEV answered ${status}`);
  // Any other refusal is about this picture and final; a server error is tried again later.
  return status < 500 ? { ok: false, done: true, refused: true } : { ok: false, done: false };
}

function cleanNames(list) {
  const names = [];
  if (!Array.isArray(list)) return names;
  for (const name of list) {
    if (names.length >= SEEN_LIMIT) break;
    const clean = relay.normalizeCameraName(relay.cleanLabel(name, relay.CAMERA_NAME_MAX_LENGTH));
    if (clean && !names.includes(clean)) names.push(clean);
  }
  return names;
}

// A pending secret becomes the pairing as soon as GEV approved it, even when the
// options page was closed before it could notice, and also while an older secret
// is still stored (after UNPAIR in POWER UP, or pairing again). A feed tab's
// heartbeat asks.
function promoteIfApproved() {
  return serialized(async () => {
    const pairing = await readPairing();
    if (!pairing.pendingSecret) return pairing;
    const now = Date.now();
    if (now - promotionCheckedAt < PROMOTION_CHECK_MS) return pairing;
    promotionCheckedAt = now;
    const answer = await askPairStatus(pairing.pendingSecret);
    if (answer.reply && answer.reply.paired === true) {
      await writePairing({ secret: pairing.pendingSecret, pendingSecret: null });
      lastPushed.clear();
      return { secret: pairing.pendingSecret, pendingSecret: '' };
    }
    if (answer.reachable && answer.status === 401) {
      // GEV forgot or replaced this request (it expires after two minutes); a stored pairing stays.
      await writePairing({ pendingSecret: null });
      return { secret: pairing.secret, pendingSecret: '' };
    }
    return pairing;
  });
}

async function handleHeartbeat(message, sender) {
  const state = relay.FEED_STATES.includes(message.state) ? message.state : 'layout-unknown';
  const seen = [];
  if (Array.isArray(message.seen)) {
    for (const name of message.seen) {
      if (seen.length >= SEEN_LIMIT) break;
      const clean = relay.cleanLabel(name, relay.CAMERA_NAME_MAX_LENGTH);
      if (clean) seen.push(clean);
    }
  }
  let pairing = await readPairing();
  // Whenever a pairing request waits, ask (at most every 10 seconds) whether it was approved.
  if (pairing.pendingSecret) pairing = await promoteIfApproved();
  const epoch = await epochFor(pairing.secret);
  const base = { paired: Boolean(pairing.secret), epoch };
  if (!pairing.secret) {
    lastHeartbeat = { at: Date.now(), state, outcome: pairing.pendingSecret ? 'waiting for approval' : 'not paired' };
    return { ...base, ok: false, sent: false };
  }
  const reporter = await reporterFor(sender, epoch);
  const heartbeatBody = () => JSON.stringify(reporter ? { state, seen, reporter } : { state, seen });
  let body = heartbeatBody();
  while (new TextEncoder().encode(body).byteLength > JSON_MAX_BYTES && seen.length) {
    seen.pop();
    body = heartbeatBody();
  }
  let outcome;
  let wanted = { missing: [], unknown: [] };
  try {
    const answer = await fetch(`${GEV_ORIGIN}/api/private-cams/relay/heartbeat`, {
      ...GEV_FETCH_OPTIONS,
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.secret}`, 'Content-Type': 'application/json' },
      body,
    });
    if (answer.status === 200 || answer.status === 204) {
      outcome = 'sent';
      noteRecognised(epoch, true);
      // Which cameras seen here GEV still wants a picture of, and which names match no camera there.
      const reply = answer.status === 200 ? await readJson(answer) : null;
      if (answer.status === 204) discardBody(answer);
      wanted = { missing: cleanNames(reply && reply.missing), unknown: cleanNames(reply && reply.unknown) };
    } else {
      discardBody(answer);
      const refused = answer.status === 401 || answer.status === 403;
      if (refused) noteRecognised(epoch, false);
      // A request still waiting for approval takes over from a refused pairing once approved.
      if (refused) outcome = pairing.pendingSecret ? 'waiting for approval' : 'not paired';
      else if (answer.status === 429) outcome = 'rate limited';
      else outcome = `GEV answered ${answer.status}`;
    }
  } catch (_) {
    outcome = 'GEV not reachable';
  }
  lastHeartbeat = { at: Date.now(), state, outcome };
  const sent = outcome === 'sent';
  return { ...base, ok: sent, sent, ...(sent ? wanted : {}) };
}

// ---- messages from the options page ----

function handlePair() {
  return serialized(pairNow);
}

async function pairNow() {
  const secret = relay.base64url(crypto.getRandomValues(new Uint8Array(32)));
  const secretHash = await relay.sha256Hex(new TextEncoder().encode(secret));
  let answer;
  try {
    answer = await fetch(`${GEV_ORIGIN}/api/private-cams/relay/pair-request`, {
      ...GEV_FETCH_OPTIONS,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secretHash }),
    });
  } catch (_) {
    return { ok: false, error: `Gods Eye View is not reachable at ${GEV_ORIGIN}. Start the app and try again.` };
  }
  const reply = await readJson(answer);
  if (answer.status !== 202) {
    if (answer.status === 429) return { ok: false, error: 'Too many pairing requests. Wait a minute and try again.' };
    const error = reply && typeof reply.error === 'string' ? relay.cleanLabel(reply.error, 200) : '';
    return { ok: false, error: error || `Gods Eye View answered ${answer.status}` };
  }
  // GEV issues the code (so no other extension can choose or copy it); it is shown exactly as received.
  const code = reply && relay.isPairingCode(reply.code) ? reply.code : '';
  if (!code) return { ok: false, error: 'Gods Eye View sent no pairing code. Update Gods Eye View and try again.' };
  await writePairing({ pendingSecret: secret });
  const seconds = reply && Number.isInteger(reply.expiresInSeconds) && reply.expiresInSeconds > 0 ? Math.min(reply.expiresInSeconds, 600) : 120;
  return { ok: true, code, extensionId: chrome.runtime.id, expiresInSeconds: seconds };
}

function cleanPairStatus(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.paired === true) {
    const cameras = Array.isArray(value.cameras) ? value.cameras.map((name) => relay.cleanLabel(name, 120)).filter(Boolean).slice(0, 50) : [];
    return { paired: true, siteName: relay.cleanLabel(value.siteName, 120), cameras };
  }
  if (value.pending === true) return { paired: false, pending: true };
  return { paired: false };
}

async function askPairStatus(secret) {
  let answer;
  try {
    answer = await fetch(`${GEV_ORIGIN}/api/private-cams/relay/pair-status`, { ...GEV_FETCH_OPTIONS, method: 'GET', headers: { Authorization: `Bearer ${secret}` } });
  } catch (_) {
    return { reachable: false, status: 0, reply: null };
  }
  const json = await readJson(answer);
  return { reachable: true, status: answer.status, reply: answer.status === 200 ? cleanPairStatus(json) : null };
}

const UNREACHABLE = `Gods Eye View is not reachable at ${GEV_ORIGIN}`;

function handlePairStatus() {
  return serialized(pairStatusNow);
}

async function pairStatusNow() {
  const pairing = await readPairing();
  let pendingExpired = false;
  if (pairing.pendingSecret) {
    const pending = await askPairStatus(pairing.pendingSecret);
    if (!pending.reachable) return { paired: false, reachable: false, error: UNREACHABLE, local: 'pending' };
    if (pending.reply && pending.reply.paired === true) {
      await writePairing({ secret: pairing.pendingSecret, pendingSecret: null });
      lastPushed.clear();
      return { ...pending.reply, approved: true, local: 'paired' };
    }
    if (pending.reply && pending.reply.pending === true) return { ...pending.reply, local: 'pending' };
    if (pending.status === 401) {
      // GEV forgot or replaced this request (it expires after two minutes).
      await writePairing({ pendingSecret: null });
      pendingExpired = true;
    } else {
      return { paired: false, error: `Gods Eye View answered ${pending.status}`, local: 'pending' };
    }
  }
  if (!pairing.secret) return { paired: false, pendingExpired, local: 'none' };
  const epoch = await epochFor(pairing.secret);
  const current = await askPairStatus(pairing.secret);
  if (!current.reachable) return { paired: false, reachable: false, error: UNREACHABLE, pendingExpired, local: 'paired' };
  if (current.reply && current.reply.paired === true) {
    noteRecognised(epoch, true);
    return { ...current.reply, pendingExpired, local: 'paired' };
  }
  if (current.status === 401) noteRecognised(epoch, false);
  return { paired: false, pendingExpired, local: 'paired' };
}

function handleForget() {
  return serialized(async () => {
    await writePairing({ secret: null, pendingSecret: null });
    lastPushed.clear();
    refusedEpoch = '';
    return { ok: true };
  });
}

async function handleStatus() {
  const pairing = await readPairing();
  const epoch = await epochFor(pairing.secret);
  return {
    paired: Boolean(pairing.secret),
    pending: Boolean(pairing.pendingSecret),
    // GEV refused the stored pairing and no new request waits: the relay is not paired.
    notPaired: Boolean(epoch) && refusedEpoch === epoch && !pairing.pendingSecret,
    extensionId: chrome.runtime.id,
    recent: recent.map((entry) => ({ ...entry })),
    heartbeat: lastHeartbeat ? { ...lastHeartbeat } : null,
  };
}
