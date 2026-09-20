import { PRIVATE_CCTV_FEED_DEFAULTS, hostMatchesSuffixes } from './privateCctvFeedConfig.mjs';
/**
 * Private security cameras (POWER UP → HOME and BUSINESS SECURITY) — the pure core.
 *
 * Home and business cameras are kept apart from the public CCTV catalogue and
 * its proxy on purpose: they have their own store (config/private-cameras.json,
 * git-ignored, permission-hardened), their own loopback-only routes
 * (server/providers/private-cameras.js) and never enter share links, the region
 * cap or the public /api/cctv/sources list.
 *
 * Any number of sites of each kind, each with any number of cameras. A site is
 * one login: a Home Assistant / Scrypted bridge for Private_CCTV_Feed cameras, or one shared
 * camera/NVR login for a business. A site is placed on the map by its postal or
 * ZIP code; its cameras are spread a few metres around that point on the side
 * each one faces, so they never sit on top of each other.
 *
 * Nothing here touches the filesystem, the network or process.env: callers pass
 * a config object in and get validated configs, redacted status and fetch
 * targets out, which is what makes every rule below unit-testable.
 */

/** Longest accepted password, token or URL. */
export const PRIVATE_CAMERA_VALUE_LIMIT = 512;
/** How far from the site point each camera is drawn, in metres. */
export const PRIVATE_CAMERA_SPREAD_M = 12;
/** Closest two cameras of one site may be drawn, in metres. */
export const PRIVATE_CAMERA_MIN_GAP_M = 8;

/** The two POWER UP cards, in display order. */
export const PRIVATE_CAMERA_KINDS = Object.freeze([
  Object.freeze({
    id: 'home',
    title: 'HOME SECURITY · PRIVATE_CCTV_FEED',
    unlocks:
      'Your Private_CCTV_Feed cameras in the CCTV panel and on the map, through a local Home Assistant or Scrypted bridge, or the GEV Private_CCTV_Feed Relay browser extension, which passes along the latest clip pictures from your own signed-in camera site feed. This app never signs in to Private_CCTV_Feed itself.',
    feedUrl: 'https://feed.private-cctv.example/#/feed',
    sourceHint: 'camera.privatecam_front or a bridge snapshot URL',
    authModes: Object.freeze(['token', 'login', 'relay']),
    defaultSiteName: 'Home',
    provider: 'Private_CCTV_Feed via local bridge',
  }),
  Object.freeze({
    id: 'business',
    title: 'BUSINESS SECURITY',
    unlocks:
      'IP cameras and NVRs by snapshot address (JPEG) with one login per site — Hikvision, Dahua, Axis, Reolink, Amcrest and most others.',
    feedUrl: '',
    sourceHint: 'https://192.168.1.64/ISAPI/Streaming/channels/101/picture',
    authModes: Object.freeze(['login']),
    defaultSiteName: 'Business',
    provider: 'Business camera',
  }),
]);

const KIND_BY_ID = new Map(PRIVATE_CAMERA_KINDS.map((kind) => [kind.id, kind]));
const ENTITY_PATTERN = /^camera\.[a-z0-9_]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Lower-case words joined by single hyphens: `--` never occurs inside an id. */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A Chrome extension id: 32 letters a–p. */
const RELAY_EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
/** SHA-256 of the relay's pairing secret, lower-case hex. */
const RELAY_SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/;
/** Longest Private_CCTV_Feed camera name a relay camera may be matched by. */
const RELAY_CAMERA_NAME_LIMIT = 60;
/** What the CCTV panel names as the source of a relay camera's pictures. */
const RELAY_PROVIDER = 'Private_CCTV_Feed browser feed relay (clip pictures)';

/** An empty store. */
export function emptyPrivateCameraConfig() {
  return { version: 2, sites: [] };
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'camera'
  );
}

/** SHA-256 certificate fingerprint as `AB:CD:…`, or '' when not one. */
export function normalizeFingerprint(value) {
  const hex = String(value || '')
    .replace(/[:\s]/g, '')
    .toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g).join(':') : '';
}

/**
 * A postal or ZIP code in its usual written form: Canadian `E2L 4S6`, US
 * `90210` or `90210-1234`, or another country's short code as typed. Returns ''
 * for an empty value and null for something that is not a postal code.
 */
export function normalizePostalCode(value) {
  const text = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  if (!text) return '';
  const canadian = text.replace(/\s/g, '').match(/^([A-Z]\d[A-Z])(\d[A-Z]\d)$/);
  if (canadian) return `${canadian[1]} ${canadian[2]}`;
  const us = text.match(/^(\d{5})(?:-?(\d{4}))?$/);
  if (us) return us[2] ? `${us[1]}-${us[2]}` : us[1];
  return /^[A-Z0-9][A-Z0-9 -]{1,8}[A-Z0-9]$/.test(text) ? text : null;
}

/** 'ca' or 'us' for a code in that country's format, otherwise ''. */
export function postalCountry(code) {
  const text = String(code || '');
  if (/^[A-Z]\d[A-Z] \d[A-Z]\d$/.test(text)) return 'ca';
  if (/^\d{5}(-\d{4})?$/.test(text)) return 'us';
  return '';
}

/**
 * True for names and addresses that stay inside a home or office network:
 * loopback, RFC 1918, link-local, carrier-grade NAT (Tailscale), IPv6 ULA and
 * link-local, `.local` / `.lan` / `.home.arpa` style names and single-label
 * hostnames.
 */
export function isPrivateNetworkHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  if (/\.(local|lan|home\.arpa|internal|intranet|home|corp)$/.test(host)) return true;
  return !host.includes('.');
}

/**
 * How a login would travel to this address: 'https', 'lan-http' (plain http
 * that never leaves the local network), 'insecure' (plain http to anything
 * else) or 'invalid'.
 */
export function credentialTransport(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return 'https';
    if (parsed.protocol === 'http:') return isPrivateNetworkHost(parsed.hostname) ? 'lan-http' : 'insecure';
    return 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * Private_CCTV_Feed's own website and cloud (feed.private-cctv.example and the rest of private-cctv.example). It is a
 * sign-in page and app, never a camera picture, so it cannot be a bridge or a
 * snapshot address; the app never sends it a login.
 */
let _feedSettings = {
  feedUrl: PRIVATE_CCTV_FEED_DEFAULTS.feedUrl,
  cloudHostSuffixes: [...PRIVATE_CCTV_FEED_DEFAULTS.cloudHostSuffixes],
};

/**
 * Tell the core which site the owner's feed lives on (the server reads it from
 * the untracked local config at start-up). Pass nothing to restore the
 * example settings.
 * @param {{feedUrl?: string, cloudHostSuffixes?: string[]}} [settings]
 */
export function configurePrivateCctvFeed(settings = {}) {
  _feedSettings = {
    feedUrl: settings.feedUrl || PRIVATE_CCTV_FEED_DEFAULTS.feedUrl,
    cloudHostSuffixes: settings.cloudHostSuffixes?.length
      ? [...settings.cloudHostSuffixes]
      : [...PRIVATE_CCTV_FEED_DEFAULTS.cloudHostSuffixes],
  };
}

/** The owner's feed page address, as configured. */
export function privateCctvFeedUrl() {
  return _feedSettings.feedUrl;
}

export function isPrivateCctvFeedCloudUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    return hostMatchesSuffixes(host, _feedSettings.cloudHostSuffixes);
  } catch {
    return false;
  }
}

/** Whether a site points at Private_CCTV_Feed's website instead of a local bridge or snapshot address. */
export function siteUsesPrivateCctvFeedWebsite(site) {
  if (isRelaySite(site)) return false;
  return Boolean(isPrivateCctvFeedCloudUrl(site?.bridgeUrl) || site?.cameras?.some((camera) => isPrivateCctvFeedCloudUrl(camera.source)));
}

/**
 * A home site whose pictures come from the GEV Private_CCTV_Feed Relay: a browser
 * extension that, while the owner's own signed-in camera site feed is open,
 * passes the newest clip picture of each camera to this server. No login of
 * this site travels anywhere.
 */
export function isRelaySite(site) {
  return Boolean(site && site.kind === 'home' && site.auth === 'relay');
}

function isHttpUrl(text) {
  try {
    return ['http:', 'https:'].includes(new URL(String(text)).protocol);
  } catch {
    return false;
  }
}

/**
 * How a camera name from the Private_CCTV_Feed feed and a camera name typed in POWER UP are
 * compared: Unicode-normalised (NFKC), trimmed, inner whitespace collapsed and
 * lower case (the feed writes "front" and only styles it "Front").
 */
export function normalizeRelayCameraName(text) {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Whether a saved camera source belongs to a bridge or snapshot setup (an
 * http(s) address or a Home Assistant entity) rather than being a Private_CCTV_Feed name.
 */
function isBridgeSource(text) {
  const source = String(text ?? '').trim();
  return Boolean(source) && (isHttpUrl(source) || ENTITY_PATTERN.test(source));
}

/**
 * The Private_CCTV_Feed feed name a relay camera answers to: its Private_CCTV_Feed name override when one
 * is saved as plain text, otherwise its own name. A saved address or entity
 * (from the site's bridge setup, or an older feed.private-cctv.example source) is never a name.
 */
export function relayMatchName(camera) {
  const source = typeof camera?.source === 'string' ? camera.source : '';
  const override = source.trim() && !isBridgeSource(source) ? normalizeRelayCameraName(source) : '';
  return override || normalizeRelayCameraName(camera?.name);
}

/** Sixteen compass points, clockwise from north, offered as the facing choices. */
export const COMPASS_POINTS = Object.freeze(
  [
    ['N', 0],
    ['NNE', 22.5],
    ['NE', 45],
    ['ENE', 67.5],
    ['E', 90],
    ['ESE', 112.5],
    ['SE', 135],
    ['SSE', 157.5],
    ['S', 180],
    ['SSW', 202.5],
    ['SW', 225],
    ['WSW', 247.5],
    ['W', 270],
    ['WNW', 292.5],
    ['NW', 315],
    ['NNW', 337.5],
  ].map((point) => Object.freeze(point)),
);
const COMPASS_BY_LABEL = new Map(COMPASS_POINTS);

/**
 * A facing from the panel or the API: a compass point name (N, NNE … NNW, any
 * case) or a number of degrees, which wraps onto 0–359 (−90 → 270). Empty means
 * unknown (null); anything else is not a facing (undefined).
 */
export function headingFromFacing(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toUpperCase();
  if (!text) return null;
  if (COMPASS_BY_LABEL.has(text)) return COMPASS_BY_LABEL.get(text);
  const number = Number(text);
  if (!Number.isFinite(number)) return undefined;
  return Number((((number % 360) + 360) % 360).toFixed(1));
}

/** The nearest of the sixteen compass points for a heading, or '' when unknown. */
export function compassPointFor(headingDeg) {
  if (headingDeg === null || headingDeg === undefined || headingDeg === '' || !Number.isFinite(Number(headingDeg))) return '';
  const normalized = ((Number(headingDeg) % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 22.5) % 16][0];
}

function blankSite(kindId) {
  return {
    id: '',
    kind: kindId,
    name: '',
    postalCode: '',
    address: '',
    lat: null,
    lon: null,
    locationLabel: '',
    bridgeUrl: '',
    auth: kindId === 'home' ? 'token' : 'login',
    token: '',
    username: '',
    password: '',
    tlsFingerprint: '',
    relayExtensionId: '',
    relaySecretHash: '',
    cameras: [],
  };
}

function validPoint(lat, lon) {
  return lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/** Coerce whatever was read from disk into the current shape, dropping junk. */
export function normalizePrivateCameraConfig(raw) {
  const config = emptyPrivateCameraConfig();
  if (!raw || typeof raw !== 'object') return config;
  let stored = [];
  if (Array.isArray(raw.sites)) {
    stored = raw.sites;
  } else if (raw.sites && typeof raw.sites === 'object') {
    // Version 1 kept exactly one home and one business site.
    for (const kind of PRIVATE_CAMERA_KINDS) {
      const site = raw.sites[kind.id];
      // Only a site that was actually set up becomes a site.
      const used = site && typeof site === 'object' && ((Array.isArray(site.cameras) && site.cameras.length) || site.token || site.username || site.password || site.bridgeUrl);
      if (used) stored.push({ ...site, id: kind.id, kind: kind.id, name: kind.defaultSiteName });
    }
  }
  const siteIds = new Set();
  for (const site of stored) {
    if (!site || typeof site !== 'object' || !KIND_BY_ID.has(site.kind)) continue;
    if (typeof site.id !== 'string' || !ID_PATTERN.test(site.id) || siteIds.has(site.id)) continue;
    siteIds.add(site.id);
    const next = blankSite(site.kind);
    next.id = site.id;
    next.name = typeof site.name === 'string' && site.name.trim() ? site.name.trim().slice(0, 60) : KIND_BY_ID.get(site.kind).defaultSiteName;
    next.postalCode = normalizePostalCode(site.postalCode) || '';
    if (typeof site.address === 'string') next.address = site.address.trim().slice(0, 200);
    const lat = finiteOrNull(site.lat);
    const lon = finiteOrNull(site.lon);
    if (validPoint(lat, lon)) {
      next.lat = lat;
      next.lon = lon;
    }
    if (typeof site.locationLabel === 'string') next.locationLabel = site.locationLabel.slice(0, 160);
    for (const key of ['username', 'password']) if (typeof site[key] === 'string') next[key] = site[key];
    if (site.kind === 'home') {
      if (typeof site.bridgeUrl === 'string') next.bridgeUrl = site.bridgeUrl;
      if (typeof site.token === 'string') next.token = site.token;
      next.auth = site.auth === 'login' || site.auth === 'relay' ? site.auth : 'token';
      // A pairing only means something on a relay site, and only in its exact shape.
      if (next.auth === 'relay') {
        if (typeof site.relayExtensionId === 'string' && RELAY_EXTENSION_ID_PATTERN.test(site.relayExtensionId)) next.relayExtensionId = site.relayExtensionId;
        if (typeof site.relaySecretHash === 'string' && RELAY_SECRET_HASH_PATTERN.test(site.relaySecretHash)) next.relaySecretHash = site.relaySecretHash;
      }
    }
    next.tlsFingerprint = normalizeFingerprint(site.tlsFingerprint);
    const cameraIds = new Set();
    for (const camera of Array.isArray(site.cameras) ? site.cameras : []) {
      if (!camera || typeof camera !== 'object' || typeof camera.name !== 'string') continue;
      if (typeof camera.id !== 'string' || !ID_PATTERN.test(camera.id) || cameraIds.has(camera.id)) continue;
      cameraIds.add(camera.id);
      next.cameras.push({
        id: camera.id,
        name: camera.name,
        source: typeof camera.source === 'string' ? camera.source : '',
        lat: finiteOrNull(camera.lat),
        lon: finiteOrNull(camera.lon),
        headingDeg: finiteOrNull(camera.headingDeg),
      });
    }
    config.sites.push(next);
  }
  return config;
}

/** http(s) URL with no embedded credentials, or an error string. */
function checkUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return `${label} is not a valid URL`;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return `${label} must start with http:// or https://`;
  if (parsed.username || parsed.password) return `${label} must not contain a login — use the site's login fields`;
  return '';
}

function uniqueId(base, taken) {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** Every address a site's login is sent to. A relay site sends its login nowhere. */
export function credentialDestinations(site) {
  const destinations = [];
  if (isRelaySite(site)) return destinations;
  const entities = site.cameras.some((camera) => ENTITY_PATTERN.test(camera.source));
  if (site.kind === 'home' && site.bridgeUrl && (entities || !site.cameras.length)) destinations.push({ label: 'Bridge URL', url: site.bridgeUrl });
  for (const camera of site.cameras) {
    if (!ENTITY_PATTERN.test(camera.source)) destinations.push({ label: `${camera.name} snapshot URL`, url: camera.source });
  }
  return destinations;
}

function siteHasCredentials(site) {
  return Boolean((site.kind === 'home' && site.auth === 'token' && site.token) || site.username);
}

/** The first Private_CCTV_Feed name two cameras of a relay site would both answer to, or ''. */
function duplicateRelayMatchName(cameras) {
  const seen = new Set();
  for (const camera of cameras) {
    const matchName = relayMatchName(camera);
    if (seen.has(matchName)) return matchName;
    seen.add(matchName);
  }
  return '';
}

/**
 * Apply one POST body to the previous config, or say exactly why not.
 *
 * `{ removeSiteId }` deletes a site. Otherwise the body saves one site:
 * `{ kind, siteId?, name, postalCode?, lat?, lon?, locationLabel?, bridgeUrl?,
 * auth?, token?, username?, password?, tlsFingerprint?, cameras }` — no siteId
 * creates a new site. `lat`/`lon` are the resolved position of the postal code.
 *
 * Secrets follow the POWER UP contract: omitted or '' keeps the saved value
 * (the panel never receives it back, so it cannot resend it), null clears it,
 * any other string replaces it. A camera row that names an existing id and
 * omits `source` keeps its saved source for the same reason.
 *
 * A camera may be saved before its bridge is connected: it appears on the map
 * straight away and shows a placeholder until the bridge answers.
 *
 * A relay site (`auth: 'relay'`) keeps any saved token, login, bridge and pin
 * untouched but sends none of them anywhere. Its cameras need no source: a
 * source there is the camera's name in the Private_CCTV_Feed feed when that differs from the
 * name here (null, or the camera's own name, clears it); a saved bridge source
 * the row leaves alone stays saved and unused. The relay pairing (`relayExtensionId`,
 * `relaySecretHash`) is never taken from a request body — only an approval in
 * POWER UP sets it — and is cleared when the site stops being a relay site.
 *
 * @returns {{ok: true, config: object, siteId: string} | {ok: false, error: string}}
 */
export function applyPrivateCameraUpdate(body, previous = emptyPrivateCameraConfig()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Body must be a JSON object' };
  const config = normalizePrivateCameraConfig(previous);

  if (body.removeSiteId !== undefined) {
    const index = config.sites.findIndex((site) => site.id === body.removeSiteId);
    if (index === -1) return { ok: false, error: 'Unknown site' };
    const [removed] = config.sites.splice(index, 1);
    return { ok: true, config, siteId: removed.id };
  }

  const kind = KIND_BY_ID.get(body.kind);
  if (!kind) return { ok: false, error: 'Unknown camera type' };
  const current = body.siteId === undefined || body.siteId === '' ? null : config.sites.find((site) => site.id === body.siteId);
  if (body.siteId && !current) return { ok: false, error: 'Unknown site' };
  if (current && current.kind !== kind.id) return { ok: false, error: 'A site cannot change type' };
  const next = current ? { ...current, cameras: [...current.cameras] } : blankSite(kind.id);

  if (body.name !== undefined || !current) {
    const name = String(body.name ?? '').trim() || (current ? '' : kind.defaultSiteName);
    if (!name || name.length > 60 || CONTROL_CHARS.test(name)) return { ok: false, error: 'Site name is not valid' };
    next.name = name;
  }

  if (body.postalCode !== undefined) {
    const code = normalizePostalCode(body.postalCode);
    if (code === null) return { ok: false, error: 'Postal or ZIP code is not valid — for example E2L 4S6 or 90210' };
    if (code !== next.postalCode && body.lat === undefined) {
      next.lat = null;
      next.lon = null;
      next.locationLabel = '';
    }
    next.postalCode = code;
  }
  if (body.address !== undefined) {
    const address = String(body.address ?? '')
      .trim()
      .split(' ')
      .filter(Boolean)
      .join(' ')
      .slice(0, 200);
    if (CONTROL_CHARS.test(address)) return { ok: false, error: 'Street address is not valid' };
    if (address !== next.address && body.lat === undefined) {
      next.lat = null;
      next.lon = null;
      next.locationLabel = '';
    }
    next.address = address;
  }
  if (body.lat !== undefined || body.lon !== undefined) {
    const lat = finiteOrNull(body.lat);
    const lon = finiteOrNull(body.lon);
    if ((lat === null) !== (lon === null)) return { ok: false, error: 'The site location needs both latitude and longitude' };
    if (lat !== null && !validPoint(lat, lon)) return { ok: false, error: 'The site location is outside the map' };
    next.lat = lat;
    next.lon = lon;
  }
  if (body.locationLabel !== undefined) {
    const label = String(body.locationLabel ?? '')
      .trim()
      .slice(0, 160);
    if (CONTROL_CHARS.test(label)) return { ok: false, error: 'Location label is not valid' };
    next.locationLabel = label;
  }

  const secretKeys = kind.id === 'home' ? ['token', 'password'] : ['password'];
  for (const key of secretKeys) {
    if (body[key] === undefined || body[key] === '') continue;
    if (body[key] === null) {
      next[key] = '';
      continue;
    }
    if (typeof body[key] !== 'string') return { ok: false, error: `${key} must be a string` };
    if (body[key].length > PRIVATE_CAMERA_VALUE_LIMIT) return { ok: false, error: `${key} is too long` };
    if (CONTROL_CHARS.test(body[key])) return { ok: false, error: `${key} contains a control character` };
    next[key] = body[key];
  }
  if (body.username !== undefined && body.username !== '') {
    if (body.username !== null && typeof body.username !== 'string') return { ok: false, error: 'username must be a string' };
    const username = String(body.username ?? '').trim();
    if (username.length > 128 || CONTROL_CHARS.test(username)) return { ok: false, error: 'username is not valid' };
    next.username = username;
  }
  if (body.tlsFingerprint !== undefined) {
    if (body.tlsFingerprint === null || body.tlsFingerprint === '') {
      next.tlsFingerprint = '';
    } else {
      const fingerprint = normalizeFingerprint(body.tlsFingerprint);
      if (!fingerprint) return { ok: false, error: 'Certificate fingerprint must be a SHA-256 fingerprint (64 hex characters)' };
      next.tlsFingerprint = fingerprint;
    }
  }
  if (kind.id === 'home') {
    if (body.auth !== undefined) {
      if (!kind.authModes.includes(body.auth)) return { ok: false, error: 'auth must be token or login, or relay' };
      next.auth = body.auth;
    }
    if (next.auth !== 'relay') {
      next.relayExtensionId = '';
      next.relaySecretHash = '';
    }
    if (body.bridgeUrl !== undefined) {
      const bridgeUrl = String(body.bridgeUrl ?? '')
        .trim()
        .replace(/\/+$/, '');
      if (bridgeUrl) {
        if (bridgeUrl.length > PRIVATE_CAMERA_VALUE_LIMIT) return { ok: false, error: 'Bridge URL is too long' };
        const problem = checkUrl(bridgeUrl, 'Bridge URL');
        if (problem) return { ok: false, error: problem };
      }
      next.bridgeUrl = bridgeUrl;
    }
  }

  const relay = isRelaySite(next);
  const explicitSpots = new Set();
  if (body.cameras !== undefined) {
    if (!Array.isArray(body.cameras)) return { ok: false, error: 'cameras must be a list' };
    const previousById = new Map((current?.cameras || []).map((camera) => [camera.id, camera]));
    const usedIds = new Set();
    const cameras = [];
    for (const [index, row] of body.cameras.entries()) {
      const where = `Camera ${index + 1}`;
      if (!row || typeof row !== 'object') return { ok: false, error: `${where} is not valid` };
      const name = String(row.name ?? '').trim();
      if (!name) return { ok: false, error: `${where} needs a name` };
      if (name.length > 60 || CONTROL_CHARS.test(name)) return { ok: false, error: `${where} name is not valid` };
      const saved = typeof row.id === 'string' ? previousById.get(row.id) : undefined;
      let source;
      if (relay && row.source === null) source = '';
      else source = row.source === undefined || row.source === '' ? saved?.source || '' : String(row.source).trim();
      if (relay) {
        // Optional: the camera's name in the Private_CCTV_Feed feed when it differs from its name here.
        // A saved bridge source (a snapshot or feed.private-cctv.example address, or a Home Assistant
        // entity) left untouched stays saved for switching back, and is never used as a name.
        const legacyBridgeSource = Boolean(saved) && source === saved.source && isBridgeSource(source);
        if (source && !legacyBridgeSource) {
          if (isHttpUrl(source)) return { ok: false, error: `${where} (${name}) Private_CCTV_Feed name must be the camera name shown in the Private_CCTV_Feed feed, not an address` };
          if (ENTITY_PATTERN.test(source)) return { ok: false, error: `${where} (${name}) Private_CCTV_Feed name must be the camera name shown in the Private_CCTV_Feed feed, not a Home Assistant entity` };
          if (source.length > RELAY_CAMERA_NAME_LIMIT || CONTROL_CHARS.test(source)) return { ok: false, error: `${where} (${name}) Private_CCTV_Feed name is not valid` };
          // A Private_CCTV_Feed name equal to the camera's own name is no override: typing the Name clears a saved one.
          if (normalizeRelayCameraName(source) === normalizeRelayCameraName(name)) source = '';
        }
      } else {
        if (!source) return { ok: false, error: `${where} (${name}) needs a ${kind.id === 'home' ? 'camera entity or snapshot URL' : 'snapshot URL'}` };
        if (source.length > PRIVATE_CAMERA_VALUE_LIMIT) return { ok: false, error: `${where} source is too long` };
        if (!(kind.id === 'home' && ENTITY_PATTERN.test(source))) {
          const problem = checkUrl(source, `${where} snapshot URL`);
          if (problem) return { ok: false, error: problem };
        }
      }
      // A camera's own coordinates are the spot it was dragged to on the map. A
      // row that leaves them out keeps them; null clears them.
      const keepSpot = row.lat === undefined && row.lon === undefined;
      const lat = keepSpot ? (saved?.lat ?? null) : finiteOrNull(row.lat);
      const lon = keepSpot ? (saved?.lon ?? null) : finiteOrNull(row.lon);
      if ((lat === null) !== (lon === null)) return { ok: false, error: `${where} (${name}) needs both latitude and longitude, or neither` };
      if (lat !== null && !validPoint(lat, lon)) return { ok: false, error: `${where} (${name}) position is outside the map` };
      // A facing is a compass point (N, NNE … NNW) or a number of degrees, which
      // wraps onto 0–359° (−90 → 270).
      const headingDeg = headingFromFacing(row.headingDeg);
      if (headingDeg === undefined) return { ok: false, error: `${where} (${name}) facing must be a compass point such as N, NE or SW` };
      const id = saved && !usedIds.has(saved.id) ? saved.id : uniqueId(slug(name), usedIds);
      usedIds.add(id);
      if (!keepSpot) explicitSpots.add(id);
      cameras.push({ id, name, source, lat, lon, headingDeg });
    }
    next.cameras = cameras;
  }

  // A site given a new postal location re-spreads its cameras around it; only a
  // spot sent in this same save survives the move.
  if (current && validPoint(next.lat, next.lon) && (next.lat !== current.lat || next.lon !== current.lon)) {
    next.cameras = next.cameras.map((camera) => (explicitSpots.has(camera.id) ? camera : { ...camera, lat: null, lon: null }));
  }

  // Each Private_CCTV_Feed feed name reaches exactly one camera of a relay site.
  if (relay) {
    const duplicate = duplicateRelayMatchName(next.cameras);
    if (duplicate) return { ok: false, error: `Two cameras would both match the Private_CCTV_Feed camera “${duplicate}”` };
  }

  // A login never crosses the internet unencrypted.
  if (siteHasCredentials(next)) {
    for (const destination of credentialDestinations(next)) {
      if (credentialTransport(destination.url) === 'insecure') {
        return {
          ok: false,
          error: `${destination.label} would send this site's login over plain http to ${new URL(destination.url).hostname}, outside your local network — use https://`,
        };
      }
    }
  }

  if (!current) {
    next.id = uniqueId(slug(next.name), new Set(config.sites.map((site) => site.id)));
    config.sites.push(next);
  } else {
    config.sites[config.sites.indexOf(current)] = next;
  }
  return { ok: true, config, siteId: next.id };
}

function offsetPoint(point, bearingDeg, meters) {
  const bearing = (bearingDeg * Math.PI) / 180;
  const metresPerDegree = 111320;
  const dLat = (meters * Math.cos(bearing)) / metresPerDegree;
  const dLon = (meters * Math.sin(bearing)) / (metresPerDegree * Math.max(0.05, Math.cos((point.lat * Math.PI) / 180)));
  return { lat: Number((point.lat + dLat).toFixed(7)), lon: Number((point.lon + dLon).toFixed(7)) };
}

function distanceM(a, b) {
  const north = (b.lat - a.lat) * 111320;
  const east = (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(north, east);
}

/**
 * Where each of a site's cameras is drawn. A camera dragged to a spot on the map
 * keeps exactly that spot. Every other camera goes PRIVATE_CAMERA_SPREAD_M out
 * from the site's postal-code point on the side it faces (evenly around it when
 * the facing is unknown), turned further round until it is at least
 * PRIVATE_CAMERA_MIN_GAP_M from every camera already placed.
 * @returns {Map<string, {lat: number, lon: number}>} camera id → position
 */
export function privateCameraPositions(site) {
  const positions = new Map();
  const anchor = validPoint(site.lat, site.lon) ? { lat: site.lat, lon: site.lon } : null;
  const placed = [];
  for (const camera of site.cameras) {
    if (!validPoint(camera.lat, camera.lon)) continue;
    const spot = { lat: camera.lat, lon: camera.lon };
    placed.push(spot);
    positions.set(camera.id, spot);
  }
  site.cameras.forEach((camera, index) => {
    if (positions.has(camera.id) || !anchor) return;
    const base = anchor;
    let bearing = camera.headingDeg ?? (index * 360) / Math.max(1, site.cameras.length);
    let point = offsetPoint(base, bearing, PRIVATE_CAMERA_SPREAD_M);
    for (let attempt = 1; attempt <= 16 && placed.some((other) => distanceM(other, point) < PRIVATE_CAMERA_MIN_GAP_M); attempt += 1) {
      bearing += 45;
      point = offsetPoint(base, bearing, PRIVATE_CAMERA_SPREAD_M + attempt * 3);
    }
    placed.push(point);
    positions.set(camera.id, point);
  });
  return positions;
}

/** Show where a saved source points without echoing path or query secrets. */
export function maskPrivateCameraSource(source) {
  const text = String(source || '');
  if (ENTITY_PATTERN.test(text)) return text;
  try {
    const parsed = new URL(text);
    const path = parsed.pathname
      .split('/')
      .map((part) => (part.length > 24 ? '•••' : part))
      .join('/');
    return `${parsed.origin}${path}${parsed.search ? '?•••' : ''}`;
  } catch {
    return '';
  }
}

/** 'relay' | 'pinned' | 'https' | 'lan-http' | 'insecure' | 'none' for a whole site. */
export function privateSiteTransport(site) {
  if (isRelaySite(site)) return 'relay';
  const transports = credentialDestinations(site).map((destination) => credentialTransport(destination.url));
  if (!transports.length) return 'none';
  if (transports.includes('insecure') || transports.includes('invalid')) return 'insecure';
  if (transports.every((transport) => transport === 'https')) return site.tlsFingerprint ? 'pinned' : 'https';
  return 'lan-http';
}

/**
 * What the POWER UP cards render: presence flags for every secret, never the
 * secret itself, and each camera's saved source only in masked form.
 */
export function privateCameraStatus(config) {
  const normalized = normalizePrivateCameraConfig(config);
  return {
    kinds: PRIVATE_CAMERA_KINDS.map((kind) => ({
      id: kind.id,
      title: kind.title,
      unlocks: kind.unlocks,
      feedUrl: kind.feedUrl ? privateCctvFeedUrl() : kind.feedUrl,
      sourceHint: kind.sourceHint,
      authModes: [...kind.authModes],
      sites: normalized.sites
        .filter((site) => site.kind === kind.id)
        .map((site) => {
          const positions = privateCameraPositions(site);
          const relaySite = isRelaySite(site);
          return {
            id: site.id,
            name: site.name,
            postalCode: site.postalCode,
            address: site.address,
            lat: site.lat,
            lon: site.lon,
            locationLabel: site.locationLabel,
            located: validPoint(site.lat, site.lon),
            bridgeUrl: kind.id === 'home' ? site.bridgeUrl : null,
            bridgeConnected: kind.id === 'home' ? Boolean(site.bridgeUrl) : null,
            auth: site.auth,
            tokenSet: Boolean(site.token),
            usernameSet: Boolean(site.username),
            passwordSet: Boolean(site.password),
            tlsFingerprint: site.tlsFingerprint,
            transport: privateSiteTransport(site),
            privateCctvFeedWebsite: siteUsesPrivateCctvFeedWebsite(site),
            // Whether a relay extension is paired, and which one. The secret's hash never leaves the store.
            relay: kind.id === 'home' ? { paired: Boolean(site.relayExtensionId && site.relaySecretHash), extensionId: site.relayExtensionId } : null,
            cameras: site.cameras.map((camera) => ({
              id: camera.id,
              name: camera.name,
              source: maskPrivateCameraSource(camera.source),
              headingDeg: camera.headingDeg,
              facing: compassPointFor(camera.headingDeg),
              placed: positions.has(camera.id),
              privateCctvFeedWebsite: !relaySite && isPrivateCctvFeedCloudUrl(camera.source),
              matchName: relayMatchName(camera),
            })),
          };
        }),
    })),
  };
}

/** The public id the viewer uses for one private camera. */
export function privateCameraPublicId(siteId, cameraId) {
  return `private-${siteId}--${cameraId}`;
}

/**
 * Pin one camera to the spot it was dragged to on the map. Its site keeps the
 * postal location; only this camera stops following the automatic spread.
 * @returns {{ok: true, config: object} | {ok: false, error: string}}
 */
export function movePrivateCamera(previous, publicId, lat, lon) {
  const config = normalizePrivateCameraConfig(previous);
  const match = /^private-([a-z0-9]+(?:-[a-z0-9]+)*)--([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(String(publicId || ''));
  const site = match ? config.sites.find((candidate) => candidate.id === match[1]) : null;
  const camera = site?.cameras.find((candidate) => candidate.id === match[2]);
  if (!camera) return { ok: false, error: 'Unknown camera' };
  const nextLat = finiteOrNull(lat);
  const nextLon = finiteOrNull(lon);
  if (!validPoint(nextLat, nextLon)) return { ok: false, error: 'That spot is outside the map' };
  camera.lat = Number(nextLat.toFixed(7));
  camera.lon = Number(nextLon.toFixed(7));
  return { ok: true, config };
}

/**
 * Placed cameras as viewer-facing source records: position, name and the
 * private frame route. No URL, entity or login leaves the server.
 */
export function privateCameraSources(config) {
  const normalized = normalizePrivateCameraConfig(config);
  const sources = [];
  for (const site of normalized.sites) {
    const kind = KIND_BY_ID.get(site.kind);
    const positions = privateCameraPositions(site);
    for (const camera of site.cameras) {
      const position = positions.get(camera.id);
      if (!position) continue;
      const id = privateCameraPublicId(site.id, camera.id);
      sources.push({
        id,
        name: camera.name,
        city: site.name,
        cityId: '',
        provider: isRelaySite(site) ? RELAY_PROVIDER : kind.provider,
        lat: position.lat,
        lon: position.lon,
        headingDeg: camera.headingDeg,
        headingConfidence: camera.headingDeg === null ? 'unknown' : 'curated',
        // Drawn like a real home or business camera: wide lens, low mount and a
        // short reach, not the highway-camera defaults of the public catalogue.
        fovDeg: 110,
        pitchDeg: -20,
        rangeM: 25,
        mountHeightM: 3,
        feedType: 'image',
        sourceKind: 'private',
        privateSite: kind.id,
        frameUrl: `/api/private-cams/frame/${encodeURIComponent(id)}`,
      });
    }
  }
  return sources;
}

/**
 * Resolve a public id to what the server must fetch and how to authenticate.
 * A home camera whose bridge is not connected yet resolves to nothing, which
 * the frame route answers with a placeholder. A relay camera resolves to the
 * Private_CCTV_Feed name its pictures arrive under instead: nothing is fetched for it.
 * @returns {{url: string, auth: {type: 'bearer', token: string} | {type: 'basic', username: string, password: string} | {type: 'none'}, name: string, tlsFingerprint: string} | {relay: true, siteId: string, cameraId: string, matchName: string, name: string} | null}
 */
export function privateFrameTarget(config, publicId) {
  const match = /^private-([a-z0-9]+(?:-[a-z0-9]+)*)--([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(String(publicId || ''));
  if (!match) return null;
  const site = normalizePrivateCameraConfig(config).sites.find((candidate) => candidate.id === match[1]);
  const camera = site?.cameras.find((candidate) => candidate.id === match[2]);
  if (!camera) return null;
  if (isRelaySite(site)) return { relay: true, siteId: site.id, cameraId: camera.id, matchName: relayMatchName(camera), name: camera.name };
  let url = camera.source;
  if (site.kind === 'home' && ENTITY_PATTERN.test(camera.source)) {
    if (!site.bridgeUrl) return null;
    url = `${site.bridgeUrl}/api/camera_proxy/${camera.source}`;
  }
  let auth = { type: 'none' };
  if (site.kind === 'home' && site.auth === 'token') {
    if (site.token) auth = { type: 'bearer', token: site.token };
  } else if (site.username) {
    auth = { type: 'basic', username: site.username, password: site.password };
  }
  return { url, auth, name: camera.name, tlsFingerprint: site.tlsFingerprint };
}

/**
 * Record that a relay extension was approved for one relay site: its Chrome
 * extension id and the SHA-256 of the secret it proves itself with.
 * @returns {{ok: true, config: object} | {ok: false, error: string}}
 */
export function applyRelayPairing(previous, siteId, { extensionId, secretHash } = {}) {
  const config = normalizePrivateCameraConfig(previous);
  const site = config.sites.find((candidate) => candidate.id === siteId);
  if (!site) return { ok: false, error: 'Unknown site' };
  if (!isRelaySite(site)) return { ok: false, error: 'Only a home site set to Browser feed relay can be paired with the relay' };
  if (typeof extensionId !== 'string' || !RELAY_EXTENSION_ID_PATTERN.test(extensionId)) return { ok: false, error: 'Extension id is not valid' };
  if (typeof secretHash !== 'string' || !RELAY_SECRET_HASH_PATTERN.test(secretHash)) return { ok: false, error: 'Pairing secret is not valid' };
  site.relayExtensionId = extensionId;
  site.relaySecretHash = secretHash;
  return { ok: true, config };
}

/**
 * Forget a site's relay pairing; the extension has to be paired and approved again.
 * @returns {{ok: true, config: object} | {ok: false, error: string}}
 */
export function clearRelayPairing(previous, siteId) {
  const config = normalizePrivateCameraConfig(previous);
  const site = config.sites.find((candidate) => candidate.id === siteId);
  if (!site) return { ok: false, error: 'Unknown site' };
  site.relayExtensionId = '';
  site.relaySecretHash = '';
  return { ok: true, config };
}
