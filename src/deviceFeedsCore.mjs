/**
 * Device feeds: drones, robots, marine drones, GPS trackers, and the Ultra
 * Security Package (a GPS tracker or a phone the map follows, with everything
 * within 50 km of it saved as it moves).
 *
 * Five POWER UP cards, one shape. Each card holds any number of the owner's own
 * devices. A device ("feed") has a name, a connection method that says how its
 * position is read, an optional picture, and a login. Everything is private to
 * this machine, exactly like the private cameras: it lives in an untracked,
 * hardened store (`config/device-feeds.json`), is never part of a share link,
 * and the viewer is only ever told names and positions, never an address or a
 * login.
 *
 * Pure: no file or network access, so the server, the setup card and the tests
 * share every rule here.
 */

export const DEVICE_FEED_STORE = 'config/device-feeds.json';
/** Fired on window when a device is saved or removed; detail.count is how many remain. */
export const DEVICE_FEEDS_CHANGED_EVENT = 'gev:device-feeds-changed';
/** Asks the Your Devices layer to fly the camera to one device by its public id; detail { id }. */
export const DEVICE_FEEDS_FOCUS_EVENT = 'gev:device-feeds-focus';
/** Asks the Your Devices layer to draw another stretch of each saved route; detail { period }. */
export const DEVICE_FEEDS_HISTORY_EVENT = 'gev:device-feeds-history';
/**
 * Asks the Cell layer to leave some devices off the map, or to draw some
 * without their path; detail { hidden: [public ids], noPath: [public ids] }.
 */
export const DEVICE_FEEDS_VISIBLE_EVENT = 'gev:device-feeds-visible';
/** This browser's devices left off the map (localStorage, a JSON list of public ids). */
export const DEVICE_HIDDEN_KEY = 'ultra-cells-hidden';
/** This browser's devices drawn without their path (localStorage, a JSON list of public ids). */
export const DEVICE_NO_PATH_KEY = 'ultra-cells-no-path';

/** The public ids in a stored or sent hidden list; anything else is dropped. */
export function deviceHiddenIds(value) {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      list = [];
    }
  }
  return Array.isArray(list)
    ? [
        ...new Set(
          list.filter(
            (id) => typeof id === 'string' && /^device-[\w-]{1,120}$/.test(id),
          ),
        ),
      ]
    : [];
}

/** This browser's choice of how much saved route the map shows (localStorage). */
export const DEVICE_HISTORY_PERIOD_KEY = 'ultra-map-period';
/** How far back the map draws a device's saved route, under its live trail. */
export const DEVICE_HISTORY_PERIODS = Object.freeze([
  Object.freeze({ id: 'live', label: 'Live only', ms: 0 }),
  Object.freeze({ id: '1h', label: 'Last hour', ms: 3_600_000 }),
  Object.freeze({ id: '6h', label: 'Last 6 hours', ms: 6 * 3_600_000 }),
  Object.freeze({ id: '24h', label: 'Last 24 hours', ms: 24 * 3_600_000 }),
  Object.freeze({ id: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 }),
  Object.freeze({ id: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 }),
  Object.freeze({ id: '365d', label: 'Last year', ms: 365 * 86_400_000 }),
]);
/** The route shown before anyone chooses: 30 days, as before the choice existed. */
export const DEVICE_HISTORY_DEFAULT_PERIOD = '30d';

/** The period with this id, or the default one. */
export function deviceHistoryPeriod(id) {
  return (
    DEVICE_HISTORY_PERIODS.find((period) => period.id === id) ||
    DEVICE_HISTORY_PERIODS.find(
      (period) => period.id === DEVICE_HISTORY_DEFAULT_PERIOD,
    )
  );
}

/** The track request for a period that starts at `nowMs`, or null for live only. */
export function deviceHistoryQuery(id, nowMs) {
  const period = deviceHistoryPeriod(id);
  if (!period.ms) return null;
  // Daily files are per calendar day: one more than the span covers both ends.
  const days = Math.min(366, Math.ceil(period.ms / 86_400_000) + 1);
  return `days=${days}&since=${Math.floor(nowMs - period.ms)}`;
}
export const DEVICE_FEED_VALUE_LIMIT = 1024;
export const DEVICE_FEED_NAME_LIMIT = 60;
/** How often one device's position may be asked for, at most. */
export const DEVICE_FEED_MIN_POLL_MS = 5000;
/** Where a recording device's surroundings are saved, one folder per device. */
export const DEVICE_RECORDING_DIR = 'config/device-recordings';
/** Everything the map knows within this distance of a recording device is saved, unless the device says otherwise. */
export const DEVICE_RECORD_RADIUS_KM = 50;
/** The distances a recording device can choose from, in km. */
export const DEVICE_RECORD_RADIUS_OPTIONS_KM = Object.freeze([
  1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50,
]);

/** A chosen recording distance, or the default for anything that is not one of the options. */
export function recordRadiusKm(value) {
  const n = Number(value);
  return DEVICE_RECORD_RADIUS_OPTIONS_KM.includes(n)
    ? n
    : DEVICE_RECORD_RADIUS_KM;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const QUERY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Every standard way in. `direct: true` methods are read by this application
 * itself, over HTTP(S). The rest are listed so the card can say plainly what
 * sits between that protocol and this application (a bridge that turns it into
 * one of the direct methods) instead of pretending or staying silent.
 *
 * `carries`: what the method can give: a position, a picture, or both.
 */
export const DEVICE_FEED_METHODS = Object.freeze({
  // The phone's app sends positions here; nothing is asked for. See `parseDeviceReport`.
  'report-in': {
    label:
      'Reports to this app (Traccar Client, OwnTracks, GPSLogger, Overland on the phone; no server of your own)',
    direct: true,
    carries: 'position',
    reportsIn: true,
    urlHint: '',
  },
  'http-json': {
    label: 'HTTP JSON position (any REST endpoint)',
    direct: true,
    carries: 'position',
    urlHint: 'https://device.example/api/position',
  },
  mavlink2rest: {
    label: 'MAVLink via mavlink2rest (ArduPilot, PX4, BlueOS)',
    direct: true,
    carries: 'position',
    urlHint: 'http://192.168.2.2:6040',
  },
  traccar: {
    label: 'Traccar server (REST API)',
    direct: true,
    carries: 'position',
    urlHint: 'https://traccar.example/api/positions?deviceId=1',
  },
  signalk: {
    label: 'Signal K server (NMEA 0183 / NMEA 2000 gateway)',
    direct: true,
    carries: 'position',
    urlHint: 'http://signalk.local:3000',
  },
  owntracks: {
    label: 'OwnTracks Recorder (HTTP)',
    direct: true,
    carries: 'position',
    urlHint: 'https://owntracks.example/api/0/last?user=me&device=phone',
  },
  'home-assistant': {
    label:
      'Home Assistant device tracker (phone companion app, iCloud, Life360, any tracker it knows)',
    direct: true,
    carries: 'position',
    urlHint:
      'http://homeassistant.local:8123/api/states/device_tracker.my_phone',
  },
  geojson: {
    label: 'GeoJSON point or feature URL',
    direct: true,
    carries: 'position',
    urlHint: 'https://device.example/position.geojson',
  },
  kml: {
    label: 'KML feed (Garmin inReach MapShare, shared tracker feeds)',
    direct: true,
    carries: 'position',
    urlHint: 'https://share.garmin.com/Feed/Share/name',
  },
  'nmea-http': {
    label: 'NMEA 0183 sentences over HTTP (GGA / RMC text)',
    direct: true,
    carries: 'position',
    urlHint: 'http://gateway.local/nmea.txt',
  },
  snapshot: {
    label: 'Still picture only (JPEG/PNG snapshot URL), fixed position',
    direct: true,
    carries: 'picture',
    urlHint: '',
  },
  // ---- need a bridge ------------------------------------------------------
  rtsp: {
    label: 'RTSP video (most drone, robot and ROV cameras)',
    direct: false,
    carries: 'picture',
    bridge:
      'MediaMTX or go2rtc: republish as a snapshot or MJPEG URL, then use the picture address.',
  },
  rtmp: {
    label: 'RTMP video (DJI and action-camera live streaming)',
    direct: false,
    carries: 'picture',
    bridge: 'MediaMTX or go2rtc: republish as a snapshot or MJPEG URL.',
  },
  webrtc: {
    label: 'WebRTC / WHEP video',
    direct: false,
    carries: 'picture',
    bridge: 'go2rtc: republish as a snapshot or MJPEG URL.',
  },
  srt: {
    label: 'SRT video',
    direct: false,
    carries: 'picture',
    bridge: 'MediaMTX: republish as a snapshot or MJPEG URL.',
  },
  'mavlink-udp': {
    label: 'MAVLink over UDP / TCP / serial (14550)',
    direct: false,
    carries: 'position',
    bridge:
      'mavlink2rest (or BlueOS, which includes it): gives the same telemetry over HTTP. Use the mavlink2rest method.',
  },
  mqtt: {
    label: 'MQTT telemetry (OwnTracks MQTT, Meshtastic, fleet brokers)',
    direct: false,
    carries: 'position',
    bridge:
      'OwnTracks Recorder, Node-RED or Home Assistant: expose the last position over HTTP. Use HTTP JSON or OwnTracks.',
  },
  ros: {
    label: 'ROS / ROS 2 (rosbridge WebSocket, Foxglove bridge)',
    direct: false,
    carries: 'both',
    bridge:
      'A small node that serves /fix (NavSatFix) as JSON over HTTP, and web_video_server for the picture (MJPEG).',
  },
  'dji-cloud': {
    label: 'DJI Cloud API (Dock, Pilot 2)',
    direct: false,
    carries: 'both',
    bridge:
      'A DJI Cloud API server of your own (MQTT + HTTPS): expose the aircraft position as HTTP JSON.',
  },
  'nmea-tcp': {
    label: 'NMEA 0183 over TCP / UDP / serial, NMEA 2000',
    direct: false,
    carries: 'position',
    bridge: 'Signal K server reads all of these. Use the Signal K method.',
  },
  ais: {
    label: 'AIS transponder (class A/B)',
    direct: false,
    carries: 'position',
    bridge:
      'Already on the map through the AIS layer; or a Signal K server with an AIS receiver.',
  },
  'phone-app': {
    label:
      'Phone tracking apps through a server of yours (Traccar, OwnTracks Recorder, Home Assistant)',
    direct: false,
    carries: 'position',
    bridge:
      'Simplest is "Reports to this app": the phone app sends straight here. Otherwise point it at your Traccar server, OwnTracks Recorder or Home Assistant, then use that method. A phone cannot be found by its number.',
  },
  'find-my': {
    label: 'Apple Find My, Google Find Hub, AirTag, Life360',
    direct: false,
    carries: 'position',
    bridge:
      'None has a public API. Home Assistant (iCloud or Life360 integration) shows them as a device tracker: use the Home Assistant method.',
  },
  'cellular-tracker': {
    label:
      'Cellular and OBD GPS trackers (GT06, TK103, Teltonika, Queclink, Concox and 200 more)',
    direct: false,
    carries: 'position',
    bridge:
      'Traccar server speaks their protocols: point the tracker at it, then use the Traccar method.',
  },
  aprs: {
    label: 'APRS',
    direct: false,
    carries: 'position',
    bridge:
      'aprs.fi API (HTTP JSON with an API key): use HTTP JSON with a query-parameter key.',
  },
  satellite: {
    label: 'Satellite trackers (Iridium, Globalstar SPOT, inReach)',
    direct: false,
    carries: 'position',
    bridge:
      'Their shared web feed: use the KML or HTTP JSON method with the feed address.',
  },
  'vendor-api': {
    label: 'Vendor cloud or gRPC API (Boston Dynamics, Skydio, fleet portals)',
    direct: false,
    carries: 'both',
    bridge:
      'The vendor SDK in a small service of your own that serves position as HTTP JSON.',
  },
  'opc-ua': {
    label: 'OPC UA / Modbus (industrial robots)',
    direct: false,
    carries: 'position',
    bridge: 'Node-RED or an OPC UA gateway: expose the pose as HTTP JSON.',
  },
});

/** Logins a direct method can use. Basic also answers a Digest challenge. */
export const DEVICE_FEED_AUTH_MODES = Object.freeze({
  none: { label: 'No login' },
  basic: {
    label: 'Username + password (HTTP Basic / Digest)',
    fields: ['username', 'password'],
  },
  bearer: {
    label: 'Bearer token (API token, JWT, Home Assistant, Signal K, Traccar)',
    fields: ['token'],
  },
  header: {
    label: 'API key in a request header',
    fields: ['keyName', 'token'],
    keyNameDefault: 'X-API-Key',
  },
  query: {
    label: 'API key in the address (query parameter)',
    fields: ['keyName', 'token'],
    keyNameDefault: 'api_key',
  },
});

const everyAuth = Object.freeze(Object.keys(DEVICE_FEED_AUTH_MODES));

/** The four cards, in display order. */
export const DEVICE_FEED_KINDS = Object.freeze([
  Object.freeze({
    id: 'drone',
    title: 'AERIAL DRONES · UAV',
    noun: 'DRONE',
    unlocks:
      'Your own uncrewed aircraft on the map, live: position, altitude, heading, and a picture from the camera when one is reachable.',
    methods: Object.freeze([
      'mavlink2rest',
      'http-json',
      'geojson',
      'traccar',
      'kml',
      'snapshot',
      'mavlink-udp',
      'rtsp',
      'rtmp',
      'webrtc',
      'srt',
      'dji-cloud',
      'mqtt',
      'ros',
      'vendor-api',
    ]),
    authModes: everyAuth,
    color: '#ffb347',
  }),
  Object.freeze({
    id: 'robot',
    title: 'ROBOTS',
    noun: 'ROBOT',
    unlocks:
      'Ground robots, rovers and legged platforms at their live position, with a camera picture when one is reachable.',
    methods: Object.freeze([
      'http-json',
      'geojson',
      'mavlink2rest',
      'traccar',
      'snapshot',
      'ros',
      'rtsp',
      'webrtc',
      'mqtt',
      'vendor-api',
      'opc-ua',
      'mavlink-udp',
    ]),
    authModes: everyAuth,
    color: '#9fe870',
  }),
  Object.freeze({
    id: 'marine',
    title: 'MARINE DRONES · USV / AUV',
    noun: 'MARINE DRONE',
    unlocks:
      'Uncrewed surface vessels and autonomous underwater vehicles at their last reported position (an AUV reports when it surfaces or over its acoustic link).',
    methods: Object.freeze([
      'signalk',
      'mavlink2rest',
      'http-json',
      'nmea-http',
      'geojson',
      'kml',
      'traccar',
      'snapshot',
      'nmea-tcp',
      'ais',
      'mavlink-udp',
      'rtsp',
      'mqtt',
      'satellite',
      'ros',
      'vendor-api',
    ]),
    authModes: everyAuth,
    color: '#5ad1ff',
  }),
  Object.freeze({
    id: 'tracker',
    title: 'GPS TRACKING DEVICES',
    noun: 'TRACKER',
    unlocks:
      'Any GPS tracker you own: vehicles, assets, people who asked to be followed, pets. A phone app reporting straight here, a Traccar server, OwnTracks, a shared satellite feed, or any JSON endpoint.',
    methods: Object.freeze([
      'report-in',
      'traccar',
      'owntracks',
      'home-assistant',
      'http-json',
      'geojson',
      'kml',
      'nmea-http',
      'signalk',
      'cellular-tracker',
      'phone-app',
      'find-my',
      'mqtt',
      'satellite',
      'aprs',
      'nmea-tcp',
      'vendor-api',
    ]),
    authModes: everyAuth,
    color: '#ff7ad9',
  }),
  Object.freeze({
    id: 'security',
    title: 'ULTRA SECURITY PACKAGE',
    noun: 'PACKAGE',
    unlocks: `A GPS tracker or a phone you are responsible for, followed live: the map keeps it in view wherever it goes, and everything the map knows within a distance you choose of it, 1 to ${DEVICE_RECORD_RADIUS_KM} km (cameras, aircraft, vessels, traffic, every layer that is on), can be saved as it moves. A phone reports through an app installed on it (simplest: straight to this app); it cannot be found by its number.`,
    methods: Object.freeze([
      'report-in',
      'traccar',
      'owntracks',
      'home-assistant',
      'http-json',
      'geojson',
      'kml',
      'nmea-http',
      'signalk',
      'cellular-tracker',
      'phone-app',
      'find-my',
      'mqtt',
      'satellite',
      'aprs',
      'nmea-tcp',
      'vendor-api',
    ]),
    authModes: everyAuth,
    color: '#ff4d4d',
    // Its trail and saved route: fluorescent green, apart from every pin.
    pathColor: '#39ff14',
    // A new package follows and records unless its owner says otherwise.
    followDefault: true,
    recordDefault: true,
  }),
]);

const KIND_BY_ID = new Map(DEVICE_FEED_KINDS.map((kind) => [kind.id, kind]));

export function emptyDeviceFeedConfig() {
  return { version: 1, feeds: [] };
}

function text(value, limit = DEVICE_FEED_VALUE_LIMIT) {
  const out = String(value ?? '').trim();
  return out.length > limit || CONTROL_CHARS.test(out) ? null : out;
}

/** An http(s) address with no embedded login, or '' / null (null = refused). */
export function cleanFeedUrl(value) {
  const raw = text(value);
  if (raw === null) return null;
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // A login belongs in the login fields, where it is stored apart and never shown.
  if (parsed.username || parsed.password) return null;
  return parsed.href;
}

/** Loopback, RFC 1918, CGNAT, link-local, ULA, `.local` and single-label names. */
export function isPrivateNetworkHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  if (!host) return false;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (!host.includes('.') && !host.includes(':'))
  )
    return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return (
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80')
  );
}

/** `https`, `lan-http` (plain http that never leaves the local network), `insecure`, or `none`. */
export function feedTransport(url) {
  if (!url) return 'none';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return 'https';
    return isPrivateNetworkHost(parsed.hostname) ? 'lan-http' : 'insecure';
  } catch {
    return 'none';
  }
}

function slug(name) {
  return (
    String(name || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'device'
  );
}

function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n += 1)
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${Date.now()}`;
}

function blankFeed(kindId) {
  return {
    id: '',
    kind: kindId,
    name: '',
    method: 'http-json',
    url: '',
    pictureUrl: '',
    latPath: '',
    lonPath: '',
    auth: 'none',
    username: '',
    password: '',
    token: '',
    keyName: '',
    lat: null,
    lon: null,
    follow: false,
    record: false,
    recordKm: DEVICE_RECORD_RADIUS_KM,
    // "Reports to this app": the secret the phone's app presents with each position.
    reportKey: '',
  };
}

/** 32 random bytes as base64url: the key a reporting device presents. */
export function newReportKey(
  randomValues = (bytes) => globalThis.crypto.getRandomValues(bytes),
) {
  const bytes = randomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const REPORT_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Whether a method takes positions the device sends, instead of asking for them. */
export function methodReportsIn(method) {
  return DEVICE_FEED_METHODS[method]?.reportsIn === true;
}

function coordinate(value, limit) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : NaN;
}

/** Coerce whatever is on disk into the current shape; anything malformed is dropped. */
export function normalizeDeviceFeedConfig(raw) {
  const out = emptyDeviceFeedConfig();
  const feeds = Array.isArray(raw?.feeds) ? raw.feeds : [];
  const taken = new Set();
  for (const item of feeds) {
    if (!item || typeof item !== 'object') continue;
    const kind = KIND_BY_ID.get(item.kind);
    const id = String(item.id || '');
    if (!kind || !ID_PATTERN.test(id) || taken.has(id)) continue;
    const method =
      DEVICE_FEED_METHODS[item.method]?.direct &&
      kind.methods.includes(item.method)
        ? item.method
        : null;
    const name = text(item.name, DEVICE_FEED_NAME_LIMIT);
    const url = cleanFeedUrl(item.url);
    const pictureUrl = cleanFeedUrl(item.pictureUrl);
    if (!method || !name || url === null || pictureUrl === null) continue;
    // A reporting device is nothing without its key; one without is dropped.
    const reportKey =
      methodReportsIn(method) &&
      REPORT_KEY_PATTERN.test(String(item.reportKey || ''))
        ? String(item.reportKey)
        : '';
    if (methodReportsIn(method) && !reportKey) continue;
    const lat = coordinate(item.lat, 90);
    const lon = coordinate(item.lon, 180);
    taken.add(id);
    out.feeds.push({
      ...blankFeed(kind.id),
      id,
      name,
      method,
      url,
      pictureUrl,
      reportKey,
      latPath: text(item.latPath, 120) || '',
      lonPath: text(item.lonPath, 120) || '',
      auth: DEVICE_FEED_AUTH_MODES[item.auth] ? item.auth : 'none',
      username: text(item.username) || '',
      password: typeof item.password === 'string' ? item.password : '',
      token: typeof item.token === 'string' ? item.token : '',
      keyName: text(item.keyName, 64) || '',
      lat: Number.isNaN(lat) ? null : lat,
      lon: Number.isNaN(lon) ? null : lon,
      // The map follows one device at a time: the first that says so.
      follow: item.follow === true && !out.feeds.some((feed) => feed.follow),
      record: item.record === true,
      recordKm: recordRadiusKm(item.recordKm),
    });
  }
  return out;
}

/**
 * The fields a device check covers, in file order. Where the map last put
 * the device, and follow and record, are left out. `include` chooses the
 * kinds: a phone package for the Ultra check, everything else for the
 * device check.
 */
function devicePolicyRecords(config, include) {
  const normalized = normalizeDeviceFeedConfig(config);
  // Normalize keeps a report key only on a method that reports in. The phone
  // route admits any security package's key, including one saved on an
  // http-json package, so that key stays in the check. The same overlay
  // covers a tracker that reports in.
  const rawKey = new Map();
  for (const item of Array.isArray(config?.feeds) ? config.feeds : []) {
    const key = String(item?.reportKey || '');
    if (item && typeof item.id === 'string' && REPORT_KEY_PATTERN.test(key))
      rawKey.set(item.id, key);
  }
  return normalized.feeds.filter(include).map((feed) => ({
    id: feed.id,
    name: feed.name,
    method: feed.method,
    reportKey: feed.reportKey || rawKey.get(feed.id) || '',
    url: feed.url,
    pictureUrl: feed.pictureUrl,
    auth: feed.auth,
    username: feed.username,
    password: feed.password,
    token: feed.token,
    keyName: feed.keyName,
  }));
}

/** Phone packages only. A drone or a tracker is not included. */
export function securityFeedPolicyRecords(config) {
  return devicePolicyRecords(config, (feed) => feed.kind === 'security');
}

/**
 * Drones, robots, marine drones and trackers, in file order. The same
 * fields as a phone package. Where the map last put the device is left out.
 * A phone package is not included: that check lives with the Ultra one.
 */
export function trackedDevicePolicyRecords(config) {
  return devicePolicyRecords(config, (feed) => feed.kind !== 'security');
}

const fail = (error) => ({ ok: false, error });

/**
 * Apply one POST body. `{removeFeedId}` removes; anything else adds or replaces
 * one feed. Secrets follow the private-camera contract: omitted or '' keeps
 * what is saved, `null` clears it, a string replaces it.
 * @returns {{ok: true, config: object, feedId?: string}|{ok: false, error: string}}
 */
export function applyDeviceFeedUpdate(body, previous, { randomValues } = {}) {
  const config = normalizeDeviceFeedConfig(previous);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return fail('Expected a JSON object');
  if (body.removeFeedId !== undefined) {
    const id = String(body.removeFeedId);
    const next = config.feeds.filter((feed) => feed.id !== id);
    if (next.length === config.feeds.length) return fail('No such device');
    return { ok: true, config: { ...config, feeds: next } };
  }
  const kind = KIND_BY_ID.get(body.kind);
  if (!kind) return fail('Unknown device type');
  const saved = body.id
    ? config.feeds.find((feed) => feed.id === String(body.id))
    : null;
  if (body.id && !saved) return fail('No such device');
  if (saved && saved.kind !== kind.id)
    return fail('A device cannot change type');
  const feed = saved ? { ...saved } : blankFeed(kind.id);

  const name = text(body.name, DEVICE_FEED_NAME_LIMIT);
  if (!name)
    return fail(
      `Name is required (up to ${DEVICE_FEED_NAME_LIMIT} characters)`,
    );
  feed.name = name;

  const method = String(body.method || '');
  const spec = DEVICE_FEED_METHODS[method];
  if (!spec || !kind.methods.includes(method))
    return fail('Unknown connection method');
  if (!spec.direct) return fail(`${spec.label} needs a bridge: ${spec.bridge}`);
  feed.method = method;

  // The card is shown a masked address, never the real one, so an address that
  // is left out keeps what is saved; `null` removes it; a string replaces it.
  const address = (value, kept) =>
    value === undefined ? kept : value === null ? '' : cleanFeedUrl(value);
  const url = address(body.url, feed.url);
  if (url === null)
    return fail(
      'The address must be http(s), with no login inside it (use the login fields)',
    );
  const pictureUrl = address(body.pictureUrl, feed.pictureUrl);
  if (pictureUrl === null)
    return fail('The picture address must be http(s), with no login inside it');
  feed.url = url;
  feed.pictureUrl = pictureUrl;
  const reportsIn = methodReportsIn(method);
  if (spec.carries === 'position' && !url && !reportsIn)
    return fail('This method needs the address it reads the position from');
  if (method === 'snapshot' && !pictureUrl)
    return fail('A picture-only device needs its picture address');
  // A reporting device is known by its key: kept across edits, minted on the
  // first save or when a new one is asked for, and never something the owner types.
  if (reportsIn) {
    feed.url = '';
    if (!feed.reportKey || body.newReportKey === true)
      feed.reportKey = newReportKey(randomValues);
  } else {
    feed.reportKey = '';
  }

  // The JSON paths and the fixed position: left out keeps what is saved (NEW
  // KEY sends only the key request), while the card's own save always sends
  // them, as '' or null when a box is empty, which removes them.
  for (const field of ['latPath', 'lonPath']) {
    if (body[field] === undefined) continue;
    const value = text(body[field], 120);
    if (value === null || (value && !/^[A-Za-z0-9_$.[\]-]+$/.test(value)))
      return fail(
        'A JSON path is letters, digits, dots and [index] only, for example data.position.lat',
      );
    feed[field] = value;
  }
  if (Boolean(feed.latPath) !== Boolean(feed.lonPath))
    return fail(
      'Give both JSON paths, or neither (they are found automatically)',
    );

  if (body.lat !== undefined || body.lon !== undefined) {
    const lat = coordinate(body.lat, 90);
    const lon = coordinate(body.lon, 180);
    if (
      Number.isNaN(lat) ||
      Number.isNaN(lon) ||
      (lat === null) !== (lon === null)
    )
      return fail(
        'A fixed position is a latitude (-90 to 90) and a longitude (-180 to 180), both or neither',
      );
    feed.lat = lat;
    feed.lon = lon;
  }
  if (method === 'snapshot' && (feed.lat === null || feed.lat === undefined))
    return fail('A picture-only device needs a fixed position to stand at');

  // The key is the login of a reporting device; there is nothing to log in to.
  const auth = reportsIn ? 'none' : String(body.auth || 'none');
  if (!DEVICE_FEED_AUTH_MODES[auth] || !kind.authModes.includes(auth))
    return fail('Unknown login type');
  feed.auth = auth;
  for (const secret of ['password', 'token']) {
    if (body[secret] === null) feed[secret] = '';
    else if (typeof body[secret] === 'string' && body[secret] !== '') {
      if (
        body[secret].length > DEVICE_FEED_VALUE_LIMIT ||
        CONTROL_CHARS.test(body[secret])
      )
        return fail('That login value is too long or has control characters');
      feed[secret] = body[secret];
    }
  }
  if (body.username !== undefined) {
    const username = text(body.username);
    if (username === null)
      return fail('That username is too long or has control characters');
    feed.username = username;
  }
  if (body.keyName !== undefined) {
    const keyName = text(body.keyName, 64);
    if (keyName === null) return fail('That key name is too long');
    feed.keyName = keyName;
  }
  const wanted = DEVICE_FEED_AUTH_MODES[auth];
  if (auth === 'basic' && (!feed.username || !feed.password))
    return fail('A username and a password are both required');
  if (
    (auth === 'bearer' || auth === 'header' || auth === 'query') &&
    !feed.token
  )
    return fail('The token or key is required');
  if (auth === 'header') {
    feed.keyName ||= wanted.keyNameDefault;
    if (!HEADER_NAME.test(feed.keyName))
      return fail('A header name is letters, digits and dashes');
    if (
      /^(host|content-length|connection|cookie|transfer-encoding)$/i.test(
        feed.keyName,
      )
    )
      return fail('That header cannot carry a key');
  }
  if (auth === 'query') {
    feed.keyName ||= wanted.keyNameDefault;
    if (!QUERY_NAME.test(feed.keyName))
      return fail(
        'A parameter name is letters, digits, dot, dash and underscore',
      );
  }
  // Leaving a login type forgets what only that type used.
  if (auth === 'none')
    Object.assign(feed, { username: '', password: '', token: '', keyName: '' });
  if (auth === 'basic') Object.assign(feed, { token: '', keyName: '' });
  if (auth === 'bearer')
    Object.assign(feed, { username: '', password: '', keyName: '' });
  if (auth === 'header' || auth === 'query')
    Object.assign(feed, { username: '', password: '' });

  // A login is never sent in the clear across the internet.
  if (auth !== 'none') {
    for (const address of [feed.url, feed.pictureUrl]) {
      if (feedTransport(address) === 'insecure')
        return fail(
          'A login is only sent over https, or over plain http to a device on your own network',
        );
    }
  }

  // Follow and record: left out keeps what is saved. The map follows one device
  // at a time, so following this one stops following any other.
  for (const option of ['follow', 'record']) {
    if (body[option] === undefined) continue;
    if (typeof body[option] !== 'boolean')
      return fail('Follow and record are on or off');
    feed[option] = body[option];
  }
  if (feed.follow)
    config.feeds = config.feeds.map((item) =>
      item.follow ? { ...item, follow: false } : item,
    );
  // How far around the device is saved: one of the offered distances; left out keeps what is saved.
  if (body.recordKm !== undefined) {
    if (!DEVICE_RECORD_RADIUS_OPTIONS_KM.includes(Number(body.recordKm)))
      return fail(
        `The recording distance is one of ${DEVICE_RECORD_RADIUS_OPTIONS_KM.join(', ')} km`,
      );
    feed.recordKm = Number(body.recordKm);
  }

  if (!saved) {
    feed.id = uniqueId(
      `${kind.id}-${slug(name)}`,
      new Set(config.feeds.map((item) => item.id)),
    );
    config.feeds.push(feed);
  } else {
    config.feeds = config.feeds.map((item) =>
      item.id === feed.id ? feed : item,
    );
  }
  return { ok: true, config, feedId: feed.id };
}

/** An address as the card may show it: host and path shape, never a key or an id. */
export function maskFeedUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .split('/')
      .map((part) => (part.length > 16 ? '•••' : part))
      .join('/');
    return `${parsed.origin}${path}${parsed.search ? '?•••' : ''}`;
  } catch {
    return '•••';
  }
}

/**
 * What the setup card is told: shapes and presence flags, never a login or an
 * address. The one value shown is a reporting device's key, because the owner
 * has to type it into the phone; it lets a phone put a position in and read
 * nothing. `reportAddresses` are the addresses this machine answers on, for the
 * same card.
 */
export function deviceFeedStatus(
  config,
  { live = new Map(), recordings = new Map(), reportAddresses = [] } = {},
) {
  const clean = normalizeDeviceFeedConfig(config);
  return {
    reportAddresses: [...reportAddresses],
    recordRadiusOptionsKm: [...DEVICE_RECORD_RADIUS_OPTIONS_KM],
    authModes: Object.entries(DEVICE_FEED_AUTH_MODES).map(([id, mode]) => ({
      id,
      label: mode.label,
      fields: mode.fields || [],
      keyNameDefault: mode.keyNameDefault || '',
    })),
    kinds: DEVICE_FEED_KINDS.map((kind) => ({
      id: kind.id,
      title: kind.title,
      noun: kind.noun,
      unlocks: kind.unlocks,
      color: kind.color,
      followDefault: kind.followDefault === true,
      recordDefault: kind.recordDefault === true,
      authModes: [...kind.authModes],
      methods: kind.methods.map((id) => ({
        id,
        label: DEVICE_FEED_METHODS[id].label,
        direct: DEVICE_FEED_METHODS[id].direct,
        carries: DEVICE_FEED_METHODS[id].carries,
        reportsIn: DEVICE_FEED_METHODS[id].reportsIn === true,
        urlHint: DEVICE_FEED_METHODS[id].urlHint || '',
        bridge: DEVICE_FEED_METHODS[id].bridge || '',
      })),
      feeds: clean.feeds
        .filter((feed) => feed.kind === kind.id)
        .map((feed) => ({
          id: feed.id,
          name: feed.name,
          method: feed.method,
          url: maskFeedUrl(feed.url),
          urlSet: Boolean(feed.url),
          pictureUrl: maskFeedUrl(feed.pictureUrl),
          pictureSet: Boolean(feed.pictureUrl),
          latPath: feed.latPath,
          lonPath: feed.lonPath,
          auth: feed.auth,
          keyName: feed.keyName,
          usernameSet: Boolean(feed.username),
          passwordSet: Boolean(feed.password),
          tokenSet: Boolean(feed.token),
          lat: feed.lat,
          lon: feed.lon,
          transport: methodReportsIn(feed.method)
            ? 'reports-in'
            : feedTransport(feed.url || feed.pictureUrl),
          reportsIn: methodReportsIn(feed.method),
          reportKey: methodReportsIn(feed.method) ? feed.reportKey : '',
          follow: feed.follow,
          record: feed.record,
          recordKm: feed.recordKm,
          recording: recordings.get(feed.id) || null,
          state: live.get(feed.id) || null,
        })),
    })),
  };
}

export function deviceFeedPublicId(feed) {
  return `device-${feed.id}`;
}

/** The request a feed's address becomes: URL (a query key added) and headers. Basic is answered on challenge. */
export function deviceFeedRequest(feed, address) {
  const headers = { Accept: '*/*' };
  let url = address;
  if (feed.auth === 'bearer') headers.Authorization = `Bearer ${feed.token}`;
  if (feed.auth === 'header') headers[feed.keyName] = feed.token;
  if (feed.auth === 'query') {
    const parsed = new URL(address);
    parsed.searchParams.set(feed.keyName, feed.token);
    url = parsed.href;
  }
  return {
    url,
    headers,
    basic:
      feed.auth === 'basic'
        ? { username: feed.username, password: feed.password }
        : null,
  };
}

/** The address a method actually reads, from the base address the owner gave. */
export function devicePositionUrl(feed) {
  // A reporting device is never asked; its positions arrive on their own.
  if (!feed.url || methodReportsIn(feed.method)) return '';
  const base = new URL(feed.url);
  const bare = base.pathname === '/' || base.pathname === '';
  if (feed.method === 'mavlink2rest' && bare)
    base.pathname =
      '/mavlink/vehicles/1/components/1/messages/GLOBAL_POSITION_INT';
  if (feed.method === 'signalk' && bare)
    base.pathname = '/signalk/v1/api/vessels/self/navigation';
  if (feed.method === 'traccar' && bare) base.pathname = '/api/positions';
  if (feed.method === 'owntracks' && bare) base.pathname = '/api/0/last';
  return base.href;
}

// ---------------------------------------------------------------- positions

const num = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' &&
        value.trim() !== '' &&
        Number.isFinite(Number(value))
      ? Number(value)
      : null;
const validPoint = (lat, lon) =>
  lat !== null &&
  lon !== null &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180 &&
  !(lat === 0 && lon === 0);

/** Read `a.b[0].c` out of a value. */
export function readJsonPath(value, path) {
  let at = value;
  for (const part of String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)) {
    if (at === null || at === undefined) return undefined;
    at = at[part];
  }
  return at;
}

const LAT_KEYS = ['lat', 'latitude', 'Latitude', 'LAT', 'y'];
const LON_KEYS = ['lon', 'lng', 'long', 'longitude', 'Longitude', 'LON', 'x'];

/** The first object, at most four levels down, that holds a usable latitude and longitude. */
function findPoint(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (!Array.isArray(value)) {
    const lat =
      LAT_KEYS.map((key) => num(value[key])).find((n) => n !== null) ?? null;
    const lon =
      LON_KEYS.map((key) => num(value[key])).find((n) => n !== null) ?? null;
    if (validPoint(lat, lon)) return { lat, lon, from: value };
  }
  const children = Array.isArray(value)
    ? value.slice(-5).reverse()
    : Object.values(value);
  for (const child of children) {
    const found = findPoint(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function extras(from) {
  if (!from || typeof from !== 'object') return {};
  const pick = (...keys) =>
    keys.map((key) => num(from[key])).find((n) => n !== null) ?? null;
  return {
    altM: pick('alt', 'altitude', 'altM', 'relative_alt_m', 'elevation'),
    headingDeg: pick('heading', 'hdg', 'course', 'cog', 'bearing', 'yaw'),
    speedMps: pick('speedMps', 'speed_mps', 'groundspeed'),
    at:
      from.fixTime ||
      from.deviceTime ||
      from.timestamp ||
      from.time ||
      from.tst ||
      null,
  };
}

/** NMEA 0183: the last GGA or RMC fix in a block of text. */
export function parseNmeaPosition(textBlock) {
  let found = null;
  for (const line of String(textBlock || '').split(/\r?\n/)) {
    const match =
      /^\$(?:GP|GN|GL|GA|BD|GB)(GGA|RMC),(.*?)(?:\*[0-9A-Fa-f]{2})?$/.exec(
        line.trim(),
      );
    if (!match) continue;
    const f = match[2].split(',');
    const at = match[1] === 'GGA' ? 1 : 2;
    const degrees = (value, hemisphere, width) => {
      if (!value || value.length < width + 2) return null;
      const d = Number(value.slice(0, width)) + Number(value.slice(width)) / 60;
      return Number.isFinite(d)
        ? hemisphere === 'S' || hemisphere === 'W'
          ? -d
          : d
        : null;
    };
    if (match[1] === 'RMC' && f[1] !== 'A') continue;
    if (match[1] === 'GGA' && (!f[5] || f[5] === '0')) continue;
    const lat = degrees(f[at], f[at + 1], 2);
    const lon = degrees(f[at + 2], f[at + 3], 3);
    if (!validPoint(lat, lon)) continue;
    found = {
      lat,
      lon,
      altM: match[1] === 'GGA' ? num(f[8]) : null,
      speedMps:
        match[1] === 'RMC' && num(f[6]) !== null ? num(f[6]) * 0.514444 : null,
      headingDeg: match[1] === 'RMC' ? num(f[7]) : null,
    };
  }
  return found;
}

/** KML: the last `<coordinates>` point (lon,lat[,alt]) in the document. */
export function parseKmlPosition(xml) {
  const all = [
    ...String(xml || '').matchAll(
      /<coordinates>\s*([^<]+?)\s*<\/coordinates>/gi,
    ),
  ];
  for (const match of all.reverse()) {
    const last = match[1].trim().split(/\s+/).pop();
    const [lon, lat, alt] = last.split(',').map((part) => num(part));
    if (validPoint(lat, lon)) return { lat, lon, altM: alt ?? null };
  }
  return null;
}

/**
 * A position out of whatever a method answered.
 * @param {object} feed
 * @param {{json?: unknown, text?: string}} answer
 * @returns {{lat:number, lon:number, altM?:number|null, headingDeg?:number|null, speedMps?:number|null, at?:string|number|null}|null}
 */
export function extractDevicePosition(feed, { json, text: body } = {}) {
  if (feed.method === 'nmea-http') return parseNmeaPosition(body);
  if (feed.method === 'kml') return parseKmlPosition(body);
  if (json === undefined || json === null) return null;
  if (feed.latPath && feed.lonPath) {
    const lat = num(readJsonPath(json, feed.latPath));
    const lon = num(readJsonPath(json, feed.lonPath));
    return validPoint(lat, lon) ? { lat, lon } : null;
  }
  if (feed.method === 'mavlink2rest') {
    const message = json?.message || json;
    const lat = num(message?.lat);
    const lon = num(message?.lon);
    if (lat === null || lon === null) return null;
    const point = { lat: lat / 1e7, lon: lon / 1e7 };
    if (!validPoint(point.lat, point.lon)) return null;
    const alt = num(message.relative_alt);
    const hdg = num(message.hdg);
    const vx = num(message.vx);
    const vy = num(message.vy);
    return {
      ...point,
      altM: alt === null ? null : alt / 1000,
      headingDeg: hdg === null || hdg === 65535 ? null : hdg / 100,
      speedMps: vx === null || vy === null ? null : Math.hypot(vx, vy) / 100,
    };
  }
  if (feed.method === 'signalk') {
    const position =
      json?.position?.value ||
      json?.navigation?.position?.value ||
      json?.value ||
      json;
    const lat = num(position?.latitude);
    const lon = num(position?.longitude);
    if (!validPoint(lat, lon)) return null;
    const cog = num(
      json?.courseOverGroundTrue?.value ??
        json?.navigation?.courseOverGroundTrue?.value,
    );
    const sog = num(
      json?.speedOverGround?.value ?? json?.navigation?.speedOverGround?.value,
    );
    return {
      lat,
      lon,
      headingDeg: cog === null ? null : (cog * 180) / Math.PI,
      speedMps: sog,
    };
  }
  if (feed.method === 'geojson') {
    const geometry =
      json?.type === 'FeatureCollection'
        ? json.features?.[json.features.length - 1]?.geometry
        : json?.type === 'Feature'
          ? json.geometry
          : json;
    const coordinates =
      geometry?.type === 'Point'
        ? geometry.coordinates
        : geometry?.type === 'LineString'
          ? geometry.coordinates?.[geometry.coordinates.length - 1]
          : null;
    const lon = num(coordinates?.[0]);
    const lat = num(coordinates?.[1]);
    return validPoint(lat, lon)
      ? { lat, lon, altM: num(coordinates?.[2]) }
      : null;
  }
  if (feed.method === 'home-assistant') {
    const attributes = json?.attributes;
    const lat = num(attributes?.latitude);
    const lon = num(attributes?.longitude);
    if (!validPoint(lat, lon)) return null;
    return {
      lat,
      lon,
      altM: num(attributes.altitude),
      headingDeg: num(attributes.course),
      speedMps: num(attributes.speed),
      at: json.last_updated || json.last_changed || null,
    };
  }
  if (feed.method === 'traccar') {
    const row = Array.isArray(json) ? json[json.length - 1] : json;
    const lat = num(row?.latitude);
    const lon = num(row?.longitude);
    if (!validPoint(lat, lon)) return null;
    const knots = num(row.speed);
    return {
      lat,
      lon,
      altM: num(row.altitude),
      headingDeg: num(row.course),
      speedMps: knots === null ? null : knots * 0.514444,
      at: row.fixTime || row.deviceTime || null,
    };
  }
  const found = findPoint(json);
  return found
    ? { lat: found.lat, lon: found.lon, ...extras(found.from) }
    : null;
}

/** A report's time as epoch milliseconds: unix seconds, milliseconds, or an ISO string; null when absent or unreadable. */
function reportTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = num(value);
  if (n !== null) return n > 1e11 ? n : n * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One position sent by a device's own app ("Reports to this app"). Read from
 * whatever the app speaks, in this order:
 *  - Traccar Client / OsmAnd protocol and GPSLogger: `lat`, `lon`, `timestamp`,
 *    `speed` (knots), `bearing`, `altitude`, in the query string or a form body;
 *  - Traccar Client 9 and later (JSON): `{location: {timestamp, coords:
 *    {latitude, longitude, speed (m/s), heading, altitude}}, device_id}`, or
 *    `location` as a list of buffered fixes, the newest kept;
 *  - OwnTracks (HTTP mode): `{_type: "location", lat, lon, tst, vel (km/h), cog, alt}`;
 *  - Overland: `{locations: [GeoJSON Feature, ...]}`, the last one;
 *  - any other JSON with a point in it.
 * @param {{params?: object, json?: any}} report
 * @returns {{protocol: string, position: {lat:number, lon:number, altM:number|null, headingDeg:number|null, speedMps:number|null, at:number|null}}|null}
 */
/** The device identifier a JSON report carries (Traccar Client 9+: device_id), or ''. */
export function reportJsonDeviceId(json) {
  if (!json || typeof json !== 'object') return '';
  const value = json.device_id ?? json.deviceId ?? json.id ?? json.deviceid;
  return typeof value === 'string' ? value.trim() : '';
}

export function parseDeviceReport({ params = {}, json } = {}) {
  const p = params || {};
  const qLat = num(p.lat ?? p.latitude);
  const qLon = num(p.lon ?? p.lng ?? p.longitude);
  if (validPoint(qLat, qLon)) {
    // OsmAnd's `speed` is knots; GPSLogger's %SPD is m/s and is sent as `speedMps`.
    const mps = num(p.speedMps ?? p.speed_mps);
    const knots = num(p.speed);
    return {
      protocol: 'osmand',
      position: {
        lat: qLat,
        lon: qLon,
        altM: num(p.altitude ?? p.alt),
        headingDeg: num(p.bearing ?? p.heading ?? p.course),
        speedMps: mps ?? (knots === null ? null : knots * 0.514444),
        at: reportTime(p.timestamp ?? p.time),
      },
    };
  }
  if (json && typeof json === 'object') {
    if (json.location && typeof json.location === 'object') {
      const fixes = (
        Array.isArray(json.location) ? json.location : [json.location]
      )
        .map((fix) => {
          const c = fix?.coords || {};
          const lat = num(c.latitude);
          const lon = num(c.longitude);
          if (!validPoint(lat, lon)) return null;
          // -1 is the app's "not known" for speed and heading.
          const speed = num(c.speed);
          const heading = num(c.heading);
          return {
            lat,
            lon,
            altM: num(c.altitude),
            headingDeg: heading === null || heading < 0 ? null : heading,
            speedMps: speed === null || speed < 0 ? null : speed,
            at: reportTime(fix.timestamp),
          };
        })
        .filter(Boolean)
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      if (fixes.length)
        return {
          protocol: 'traccar-json',
          position: fixes[fixes.length - 1],
          // Every buffered fix, oldest first, so a trip sent late is kept whole.
          positions: fixes,
        };
    }
    if (json._type === 'location') {
      const lat = num(json.lat);
      const lon = num(json.lon);
      if (!validPoint(lat, lon)) return null;
      const kmh = num(json.vel);
      return {
        protocol: 'owntracks',
        position: {
          lat,
          lon,
          altM: num(json.alt),
          headingDeg: num(json.cog),
          speedMps: kmh === null ? null : kmh / 3.6,
          at: reportTime(json.tst),
        },
      };
    }
    if (Array.isArray(json.locations)) {
      const last = json.locations[json.locations.length - 1];
      const coordinates =
        last?.geometry?.type === 'Point' ? last.geometry.coordinates : null;
      const lon = num(coordinates?.[0]);
      const lat = num(coordinates?.[1]);
      if (!validPoint(lat, lon)) return null;
      const props = last.properties || {};
      return {
        protocol: 'overland',
        position: {
          lat,
          lon,
          altM: num(props.altitude),
          headingDeg: num(props.course),
          speedMps: num(props.speed),
          at: reportTime(props.timestamp),
        },
      };
    }
    const found = findPoint(json);
    if (found)
      return {
        protocol: 'json',
        position: {
          altM: null,
          headingDeg: null,
          speedMps: null,
          at: null,
          lat: found.lat,
          lon: found.lon,
          ...extras(found.from),
        },
      };
  }
  return null;
}

/** What each protocol's app expects back once a report is taken. */
export function deviceReportReply(protocol) {
  if (protocol === 'owntracks')
    return { contentType: 'application/json', body: '[]' };
  if (protocol === 'overland')
    return { contentType: 'application/json', body: '{"result":"ok"}' };
  return { contentType: 'text/plain', body: 'OK' };
}

/** What the map layer is told about one device: never an address or a login. */
export function devicePublicRecord(feed, position, state = {}) {
  const kind = KIND_BY_ID.get(feed.kind);
  const lat = position?.lat ?? feed.lat;
  const lon = position?.lon ?? feed.lon;
  if (lat === null || lat === undefined || lon === null || lon === undefined)
    return null;
  return {
    id: deviceFeedPublicId(feed),
    kind: feed.kind,
    kindLabel: kind?.noun || feed.kind.toUpperCase(),
    color: kind?.color || '#ffffff',
    // The trail and saved route; the pin colour unless the kind has its own.
    pathColor: kind?.pathColor || kind?.color || '#ffffff',
    name: feed.name,
    lat,
    lon,
    altM: position?.altM ?? null,
    headingDeg: position?.headingDeg ?? null,
    speedMps: position?.speedMps ?? null,
    live: Boolean(position),
    fixed: !position,
    at: state.at || null,
    follow: feed.follow === true,
    record: feed.record === true,
    recordKm: recordRadiusKm(feed.recordKm),
    hasPicture: Boolean(feed.pictureUrl) || feed.kind === 'security',
    // A phone package shows its own phone's picture, by its public id: with
    // two packages, each card is its own camera, never the newest reporter's.
    pictureUrl: feed.pictureUrl
      ? `/api/device-feeds/frame/${deviceFeedPublicId(feed)}`
      : feed.kind === 'security'
        ? `/api/ultra-help/picture/${deviceFeedPublicId(feed)}`
        : null,
  };
}

// ---------------------------------------------------------------- recording

/** How many points a device's saved route is drawn with, at most. */
export const DEVICE_TRACK_MAX_POINTS = 4000;
/** Two saved fixes closer than this are one point on the drawn route. */
export const DEVICE_TRACK_MIN_STEP_M = 3;

/**
 * The route a recording holds: one point per saved line, from the `target`
 * the server checked each line against. Lines that are not JSON, or have no
 * position, are skipped; points come back oldest first.
 * @param {string} text One or more JSON-lines files, concatenated.
 * @returns {Array<{at:number, lat:number, lon:number, altM:number|null, headingDeg:number|null, speedMps:number|null}>}
 */
export function trackFromRecordingLines(text) {
  const points = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const target = parsed?.target;
    const lat = num(target?.lat);
    const lon = num(target?.lon);
    const at = Date.parse(parsed?.at);
    if (!validPoint(lat, lon) || !Number.isFinite(at)) continue;
    points.push({
      at,
      lat,
      lon,
      altM: num(target.altM),
      headingDeg: num(target.headingDeg),
      speedMps: num(target.speedMps),
    });
  }
  points.sort((a, b) => a.at - b.at);
  return points;
}

/**
 * Fewer points, same route: a fix that did not move from the previous kept one
 * is dropped, and a route longer than `maxPoints` keeps every n-th point plus
 * the last. Pure.
 */
export function thinTrackPoints(
  points,
  {
    maxPoints = DEVICE_TRACK_MAX_POINTS,
    minStepM = DEVICE_TRACK_MIN_STEP_M,
  } = {},
) {
  const moved = [];
  for (const point of points) {
    const last = moved[moved.length - 1];
    if (last && deviceDistanceKm(last, point) * 1000 < minStepM) continue;
    moved.push(point);
  }
  if (moved.length <= maxPoints) return moved;
  const step = Math.ceil(moved.length / maxPoints);
  const kept = moved.filter((_, index) => index % step === 0);
  if (kept[kept.length - 1] !== moved[moved.length - 1])
    kept.push(moved[moved.length - 1]);
  return kept;
}

/** Great-circle kilometres between two lat/lon points. */
export function deviceDistanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const RECORD_LAYER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * One saved line of a recording: where the device was, and every record the
 * viewer sent that really is within the radius of where the SERVER knows the
 * device to be. Records without a position, or outside it, are dropped.
 * @param {object} body `{layers: {layerId: Array<record>}}` from the viewer.
 * @param {{lat:number, lon:number}} target The device's position as the server knows it.
 * @returns {{ok: true, line: object, kept: number}|{ok: false, error: string}}
 */
export function buildDeviceRecordingLine(
  body,
  target,
  { at = Date.now(), radiusKm = DEVICE_RECORD_RADIUS_KM } = {},
) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return fail('Expected a JSON object');
  if (!target || !validPoint(num(target.lat), num(target.lon)))
    return fail('The device has no position yet');
  const layers = {};
  let kept = 0;
  const sent =
    body.layers &&
    typeof body.layers === 'object' &&
    !Array.isArray(body.layers)
      ? body.layers
      : {};
  for (const [layerId, records] of Object.entries(sent)) {
    if (!RECORD_LAYER_ID.test(layerId) || !Array.isArray(records)) continue;
    const inside = [];
    for (const record of records) {
      if (!record || typeof record !== 'object' || Array.isArray(record))
        continue;
      const lat = num(record.lat);
      const lon = num(record.lon);
      if (
        lat === null ||
        lon === null ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
      )
        continue;
      const km = deviceDistanceKm(target, { lat, lon });
      if (km > radiusKm) continue;
      inside.push({ ...record, distanceKm: Math.round(km * 100) / 100 });
    }
    if (inside.length) {
      layers[layerId] = inside;
      kept += inside.length;
    }
  }
  return {
    ok: true,
    kept,
    line: {
      at: new Date(at).toISOString(),
      target: {
        lat: target.lat,
        lon: target.lon,
        altM: target.altM ?? null,
        headingDeg: target.headingDeg ?? null,
        speedMps: target.speedMps ?? null,
      },
      radiusKm,
      layers,
    },
  };
}
