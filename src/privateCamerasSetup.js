/**
 * POWER UP → HOME SECURITY (Arlo via a local bridge or the browser feed relay)
 * and BUSINESS SECURITY (snapshot URL + login) cards inside the Provider
 * Settings dialog.
 *
 * Each card holds any number of sites, and each site any number of cameras.
 * Rendered entirely from GET /api/private-cams/status, which reports whether a
 * token, username or password is saved but never the value, and each camera's
 * source only in masked form. Saving posts one site to /api/private-cams/config;
 * no server restart is needed, the CCTV layer simply reloads its camera list.
 * A prod build or a LAN visitor gets no status answer and no section at all.
 *
 * A site is placed on the map from a street address or a postal / ZIP code.
 * LOCATE looks it up with OpenStreetMap (Nominatim) only;
 * the server spreads the site's cameras around that point on the side each one
 * faces, and any camera icon can then be dragged to its exact spot on the map.
 *
 * A home site can instead use the Arlo browser feed relay: a personal Chrome
 * extension (tools/arlo-feed-relay) that forwards the newest clip thumbnail of
 * each camera from the user's own signed-in my.arlo.com feed tab. Such a site
 * sends no login anywhere. Its panel shows the pairing and the relay's last
 * heartbeat, approves a pairing request or removes the pairing, and re-reads
 * GET /status every 15 s while the dialog is open without touching anything
 * typed into the form.
 */

import { COMPASS_POINTS, compassPointFor, normalizePostalCode, postalCountry } from './privateCamerasCore.mjs';

const STATUS_ENDPOINT = '/api/private-cams/status';
const CONFIG_ENDPOINT = '/api/private-cams/config';
const RELAY_APPROVE_ENDPOINT = '/api/private-cams/relay/approve';
const RELAY_UNPAIR_ENDPOINT = '/api/private-cams/relay/unpair';
const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';

/** How often an open dialog re-reads the relay panels, in milliseconds. */
export const RELAY_REFRESH_MS = 15000;
/** Same as the server's RELAY_HEARTBEAT_STALE_MS: an older heartbeat means the relay is gone. */
const RELAY_HEARTBEAT_STALE_MS = 10 * 60 * 1000;
const RELAY_SOURCE_HINT = 'Arlo camera name (blank = same as Name)';

/** Every way a home site can get its pictures, in menu order. */
const HOME_AUTH_CHOICES = Object.freeze([
  Object.freeze(['token', 'Home Assistant long-lived access token']),
  Object.freeze(['login', 'Username + password']),
  Object.freeze(['relay', 'Browser feed relay (Chrome extension)']),
]);

const RELAY_STATE_TEXT = new Map([
  ['feed', 'Relay connected — reading your Arlo feed'],
  ['no-cards', 'Your Arlo feed has no clips loaded'],
  ['layout-unknown', 'Arlo feed layout not recognised — the relay needs an update'],
]);
const RELAY_SIGNED_OUT_TEXT = 'Arlo signed out — open my.arlo.com and sign in to refresh pictures';
const RELAY_NOT_CONNECTED_TEXT = 'Relay not connected — open your my.arlo.com feed in Chrome with the extension installed';
const RELAY_NOT_PAIRED_TEXT = 'Relay not paired — open the extension options, press PAIR WITH GODS EYE VIEW and approve the request here';
/** The only addresses the relay extension can reach Gods Eye View at. */
const RELAY_GEV_ORIGINS = Object.freeze(['http://localhost:4173', 'http://127.0.0.1:4173']);

const TRANSPORT_LABELS = Object.freeze({
  pinned: ['HTTPS · PINNED', 'Encrypted, and the certificate must match the saved fingerprint'],
  https: ['HTTPS', 'Encrypted in transit'],
  'lan-http': ['LOCAL NETWORK', 'Plain http that never leaves your local network — https is still better'],
  insecure: ['NOT SECURE', 'A login would cross the internet unencrypted'],
  relay: ['BROWSER RELAY', 'Pictures come from your own signed-in Arlo feed tab through the paired Chrome extension; no login is sent anywhere'],
  none: ['', ''],
});

const COMPASS_NAMES = Object.freeze({
  N: 'North',
  NNE: 'North-northeast',
  NE: 'Northeast',
  ENE: 'East-northeast',
  E: 'East',
  ESE: 'East-southeast',
  SE: 'Southeast',
  SSE: 'South-southeast',
  S: 'South',
  SSW: 'South-southwest',
  SW: 'Southwest',
  WSW: 'West-southwest',
  W: 'West',
  WNW: 'West-northwest',
  NW: 'Northwest',
  NNW: 'North-northwest',
});

function element(documentRef, tag, className, text) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function input(documentRef, { name, type = 'text', value = '', placeholder = '', label }) {
  const field = element(documentRef, 'input');
  field.type = type;
  field.autocomplete = type === 'password' ? 'new-password' : 'off';
  field.spellcheck = false;
  field.dataset.field = name;
  field.value = value;
  field.placeholder = placeholder;
  field.setAttribute('aria-label', label || placeholder || name);
  return field;
}

function button(documentRef, className, text, title) {
  const node = element(documentRef, 'button', className, text);
  node.type = 'button';
  if (title) node.title = title;
  return node;
}

/** One line of whitespace-collapsed text. */
function tidy(value) {
  return String(value ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/**
 * Split what was typed in the location box into the saved fields: a postal or
 * ZIP code, or a street address — pure, exported for tests.
 */
export function splitSiteLocationQuery(query) {
  const text = tidy(query);
  const postal = normalizePostalCode(text);
  return postal ? { postalCode: postal, address: '' } : { postalCode: '', address: text };
}

/**
 * Turn one site's fields into a POST body — pure over plain values, exported
 * for tests. Empty secret fields are omitted so saved secrets are kept. The
 * site's position is its located address or postal code; cameras carry only a
 * facing (their dragged spots stay on the server).
 *
 * A home site on the browser feed relay sends no bridge URL, token, username,
 * password or certificate fingerprint at all, so whatever is saved for them
 * stays saved; a camera's Arlo name may be blank (it then matches its Name).
 */
export function collectPrivateSiteUpdate(kindId, siteId, values, cameras) {
  const body = { kind: kindId, name: values.name || '' };
  if (siteId) body.siteId = siteId;
  const relay = kindId === 'home' && values.auth === 'relay';
  if (!relay) {
    for (const key of kindId === 'home' ? ['token', 'password'] : ['password']) {
      if (values[key]) body[key] = values[key];
    }
    if (values.username) body.username = values.username;
    body.tlsFingerprint = values.tlsFingerprint || '';
  }
  if (kindId === 'home') {
    if (relay) {
      body.auth = 'relay';
    } else {
      body.bridgeUrl = values.bridgeUrl || '';
      body.auth = values.auth === 'login' ? 'login' : 'token';
    }
  }
  const coordinate = (value) => (value === '' || value === undefined || value === null ? null : Number(value));
  body.postalCode = values.postalCode || '';
  body.address = values.address || '';
  body.lat = coordinate(values.lat);
  body.lon = coordinate(values.lon);
  body.locationLabel = values.locationLabel || '';
  body.cameras = cameras.map((camera) => {
    const row = { name: camera.name, headingDeg: camera.headingDeg === '' ? null : camera.headingDeg };
    if (camera.id) row.id = camera.id;
    if (camera.source) row.source = camera.source;
    return row;
  });
  return body;
}

/** The connection choices a home site offers, limited to what the server accepts — pure, exported for tests. */
export function privateCameraAuthChoices(kind) {
  const modes = Array.isArray(kind?.authModes) ? kind.authModes : [];
  return HOME_AUTH_CHOICES.filter(([value]) => !modes.length || modes.includes(value));
}

/** Same rule as normalizeRelayCameraName in the core: NFKC, trimmed, single spaces, lower case. */
function relayName(text) {
  return typeof text === 'string' ? text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

/** The saved Arlo name of a relay camera when it differs from its own name, else '' — pure, exported for tests. */
export function relayArloNameOverride(camera) {
  const matchName = typeof camera?.matchName === 'string' ? camera.matchName : '';
  return matchName && matchName !== relayName(camera.name) ? matchName : '';
}

/**
 * Placeholder and accessible label of a camera row's source box — pure,
 * exported for tests. `saved` holds the masked saved source and the saved Arlo
 * name override.
 */
export function cameraSourceField(kind, saved = {}, relay = false) {
  if (relay) return { placeholder: saved.arloName ? `Arlo name “${saved.arloName}” — saved (type the Name to clear)` : RELAY_SOURCE_HINT, label: RELAY_SOURCE_HINT };
  return { placeholder: saved.source ? `${saved.source} — saved` : kind?.sourceHint || '', label: kind?.id === 'home' ? 'Camera entity or snapshot URL' : 'Snapshot URL' };
}

/** Whether a site from GET /status is saved on the browser feed relay and carries its relay report. */
export function isRelaySite(site) {
  return Boolean(site && site.auth === 'relay' && site.relay && typeof site.relay === 'object');
}

/** Whether the relay has sent a recent heartbeat: the server's flag, re-checked against `now`. */
export function relayConnected(site, now = Date.now()) {
  const relay = site?.relay;
  if (!relay?.connected) return false;
  const at = relay.lastHeartbeatAt;
  return !(Number.isFinite(at) && Number.isFinite(now) && now - at > RELAY_HEARTBEAT_STALE_MS);
}

/**
 * The one-line relay state for a saved relay site — pure, exported for tests.
 * An unpaired site says so first (it cannot report anything); then a
 * signed-out report wins, like the camera placeholder the server draws.
 */
export function relayStatusText(site, now = Date.now()) {
  const state = site?.relay?.state;
  if (!site?.relay?.paired) return RELAY_NOT_PAIRED_TEXT;
  if (state === 'signed-out') return RELAY_SIGNED_OUT_TEXT;
  if (!relayConnected(site, now)) return RELAY_NOT_CONNECTED_TEXT;
  return RELAY_STATE_TEXT.get(state) || RELAY_STATE_TEXT.get('feed');
}

/** "Paired with extension <id>" or "Not paired" — pure, exported for tests. */
export function relayPairedText(site) {
  const relay = site?.relay;
  return relay?.paired && relay.extensionId ? `Paired with extension ${relay.extensionId}` : 'Not paired';
}

function clockTime(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** What the relay last delivered for one camera, with the local time it arrived — pure, exported for tests. */
export function relayCameraLine(camera) {
  const name = tidy(camera?.name) || 'Camera';
  if (!Number.isFinite(camera?.lastFrameAt)) return `${name}: waiting for a clip`;
  const clip = tidy(camera.lastClip);
  return `${name}: last clip picture ${clockTime(camera.lastFrameAt)}${clip ? ` (${clip})` : ''}`;
}

/** The hint for Arlo camera names that matched no camera, or '' — pure, exported for tests. */
export function relayUnknownNamesText(site) {
  const names = Array.isArray(site?.relay?.unknownNames) ? site.relay.unknownNames.map(tidy).filter(Boolean) : [];
  return names.length ? `Your Arlo feed has cameras named ${names.map((name) => `“${name}”`).join(', ')} that match no camera here — set a camera's Arlo name` : '';
}

/** The pairing request line, or '' when no request is waiting — pure, exported for tests. */
export function relayPendingText(pending) {
  return pending && pending.extensionId && pending.code ? `Pairing request from extension ${pending.extensionId} — code ${pending.code}` : '';
}

/**
 * The waiting pairing requests from GET /status (a list, one per extension; a
 * single request is accepted too) as { extensionId, code, text } — pure,
 * exported for tests.
 */
export function relayPendingRequests(pending) {
  const list = Array.isArray(pending) ? pending : pending ? [pending] : [];
  return list
    .filter((request) => request && typeof request.extensionId === 'string' && typeof request.code === 'string' && relayPendingText(request))
    .map((request) => ({ extensionId: request.extensionId, code: request.code, text: relayPendingText(request) }));
}

/**
 * A warning when this page is not on the one address the relay extension can
 * reach, or '' — pure, exported for tests. An unknown origin gets no warning.
 */
export function relayOriginWarning(origin) {
  if (typeof origin !== 'string' || !/^https?:\/\//.test(origin) || RELAY_GEV_ORIGINS.includes(origin)) return '';
  return `The Arlo relay only reaches Gods Eye View at http://localhost:4173, but this page is on ${origin} — start the app on port 4173 to use it.`;
}

/**
 * Everything one relay panel shows, as plain text — pure, exported for tests.
 * `tone` is 'ok' while the feed is being read, 'warn' when the relay reports a
 * problem and 'off' when it is not paired or not connected.
 */
export function relayPanelLines(site, pending, now = Date.now()) {
  const state = site?.relay?.state;
  let tone = 'off';
  if (!site?.relay?.paired) tone = 'off';
  else if (state === 'signed-out') tone = 'warn';
  else if (relayConnected(site, now)) tone = RELAY_STATE_TEXT.has(state) && state !== 'feed' ? 'warn' : 'ok';
  return {
    tone,
    status: relayStatusText(site, now),
    paired: Boolean(site?.relay?.paired && site.relay.extensionId),
    pairedText: relayPairedText(site),
    cameras: (Array.isArray(site?.cameras) ? site.cameras : []).map(relayCameraLine),
    unknown: relayUnknownNamesText(site),
    requests: relayPendingRequests(pending),
  };
}

/** Leading house number of a street address ("42" in "42 Charlotte St"), or ''. */
function houseNumber(text) {
  return /^\s*(\d+[a-z]?)\b/i.exec(String(text || ''))?.[1]?.toLowerCase() || '';
}

/**
 * Find a site from a street address or a postal / ZIP code with OpenStreetMap
 * (Nominatim) only.
 *
 * Precision of the answer:
 *  - 'exact': the match includes the house number;
 *  - 'street': only the street was found (no house number in the map data);
 *  - 'approximate': a postal code, which lands near its area.
 * A network failure throws, so the caller can tell it apart from "not found".
 * @returns {Promise<{lat: number, lon: number, label: string, precision: string} | null>}
 */
export async function locateSiteLocation(query, { fetchImpl = globalThis.fetch?.bind(globalThis), signal } = {}) {
  const { postalCode, address } = splitSiteLocationQuery(query);
  if ((!postalCode && address.length < 4) || typeof fetchImpl !== 'function') return null;
  const url = new URL(NOMINATIM_SEARCH);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  if (postalCode) {
    url.searchParams.set('postalcode', postalCode);
    const country = postalCountry(postalCode);
    if (country) url.searchParams.set('countrycodes', country);
  } else {
    url.searchParams.set('q', address);
  }
  const response = await fetchImpl(url.toString(), { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`OpenStreetMap answered ${response.status}`);
  const results = await response.json();
  const hit = Array.isArray(results) ? results[0] : null;
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (!hit || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const label = String(hit.display_name || address || postalCode);
  const number = postalCode ? '' : houseNumber(address);
  let precision = 'exact';
  if (postalCode) precision = 'approximate';
  else if (number && !new RegExp(`(^|[^0-9a-z])${number}([^0-9a-z]|$)`, 'i').test(label)) precision = 'street';
  return { lat, lon, label, precision };
}

/** The status line shown after LOCATE, worded for how exact the answer is. */
export function siteLocateMessage(point) {
  if (point.precision === 'approximate')
    return `Approximate: ${point.label}. A postal code only lands near its area — type the street address for a closer spot, or drag each camera icon into place on the map.`;
  if (point.precision === 'street')
    return `Street only: ${point.label}. OpenStreetMap has no house number there, so the site sits somewhere on that street — drag each camera icon to its exact spot on the map.`;
  return `Placed at ${point.label}. Cameras are spread around it by facing; drag any icon on the map to fine-tune.`;
}

/** Mount the section into `host`; returns a handle whose destroy() stops pending work. */
export function initPrivateCameraSetup({ host, documentRef = globalThis.document, fetchImpl, signal } = {}) {
  if (!host || !documentRef) return { destroy() {} };
  const doFetch = fetchImpl || globalThis.fetch?.bind(globalThis);
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  signal?.addEventListener('abort', stop, { once: true });
  host.hidden = true;
  let editable = true;

  // The relay panel of each saved relay site, by site id: each one updates its
  // own status lines in place from a fresh GET /status.
  const relayPanels = new Map();
  let relayTimer = null;
  let relayRefreshing = false;
  let relayRefreshAgain = false;
  let generation = 0;
  lifetime.signal.addEventListener(
    'abort',
    () => {
      if (relayTimer) clearInterval(relayTimer);
      relayTimer = null;
      relayPanels.clear();
    },
    { once: true },
  );

  const post = async (body, endpoint = CONFIG_ENDPOINT) => {
    const response = await doFetch(endpoint, {
      method: 'POST',
      signal: lifetime.signal,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Save failed (${response.status})`);
    return payload;
  };

  const readStatus = async () => {
    const response = await doFetch(STATUS_ENDPOINT, { cache: 'no-store', credentials: 'same-origin', signal: lifetime.signal });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  };

  const updateRelayPanels = (status) => {
    const pending = status?.relayPending || null;
    for (const kind of status?.kinds || []) {
      for (const site of kind.sites || []) if (isRelaySite(site)) relayPanels.get(site.id)?.(site, pending);
    }
  };

  const refreshRelay = async () => {
    if (lifetime.signal.aborted || !relayPanels.size) return;
    if (relayRefreshing) {
      relayRefreshAgain = true;
      return;
    }
    relayRefreshing = true;
    const startedFor = generation;
    try {
      const status = await readStatus();
      // A status read before the section was re-rendered describes old panels.
      if (!lifetime.signal.aborted && startedFor === generation) updateRelayPanels(status);
    } catch {
      // A missed refresh keeps the last report; the next one tries again.
    } finally {
      relayRefreshing = false;
    }
    if (relayRefreshAgain) {
      relayRefreshAgain = false;
      void refreshRelay();
    }
  };

  // The section lives inside the POWER UP dialog, which is hidden while closed.
  const sectionShown = () => {
    if (documentRef.visibilityState === 'hidden') return false;
    for (let node = host; node; node = node.parentElement) if (node.hidden) return false;
    return true;
  };

  const syncRelayTimer = () => {
    if (relayPanels.size && !relayTimer && !lifetime.signal.aborted) {
      relayTimer = setInterval(() => {
        if (sectionShown()) void refreshRelay();
      }, RELAY_REFRESH_MS);
    } else if (!relayPanels.size && relayTimer) {
      clearInterval(relayTimer);
      relayTimer = null;
    }
  };

  // Opening the dialog (see refresh() below) or coming back to the tab reads the
  // relay at once, so a pairing request made meanwhile shows without waiting 15 s.
  const refreshIfShown = () => {
    if (!lifetime.signal.aborted && sectionShown()) void refreshRelay();
  };
  documentRef.addEventListener?.('visibilitychange', refreshIfShown, { signal: lifetime.signal });

  const facingTitle = (label) => (label ? `${COMPASS_NAMES[label]} · ${COMPASS_POINTS.find(([point]) => point === label)[1]}°` : 'Facing unknown');

  const facingSelect = (camera) => {
    const select = element(documentRef, 'select', 'private-cams-facing');
    select.dataset.field = 'headingDeg';
    select.setAttribute('aria-label', 'Which way the camera faces');
    const unknown = element(documentRef, 'option', '', '—');
    unknown.value = '';
    select.append(unknown);
    for (const [label] of COMPASS_POINTS) {
      const option = element(documentRef, 'option', '', label);
      option.value = label;
      option.title = facingTitle(label);
      select.append(option);
    }
    select.value = camera.facing || compassPointFor(camera.headingDeg) || '';
    select.title = facingTitle(select.value);
    select.addEventListener('change', () => {
      select.title = facingTitle(select.value);
    });
    return select;
  };

  const labelSource = (field, kind, relay) => {
    const { placeholder, label } = cameraSourceField(kind, { source: field.dataset.savedSource, arloName: field.dataset.arloName }, relay);
    field.placeholder = placeholder;
    field.setAttribute('aria-label', label);
  };

  const renderCameraRow = (list, kind, camera = {}, relay = false) => {
    const row = element(documentRef, 'div', 'private-cams-camera');
    if (camera.id) row.dataset.cameraId = camera.id;
    const remove = button(documentRef, 'private-cams-remove-camera', '✕', 'Remove this camera (takes effect on save)');
    remove.setAttribute('aria-label', 'Remove this camera');
    remove.addEventListener('click', () => row.remove());
    const source = input(documentRef, { name: 'source' });
    source.dataset.savedSource = camera.source || '';
    source.dataset.arloName = relayArloNameOverride(camera);
    labelSource(source, kind, relay);
    row.append(input(documentRef, { name: 'name', value: camera.name || '', placeholder: 'Name', label: 'Camera name' }), source, facingSelect(camera), remove);
    list.append(row);
  };

  const relaySetupSteps = (open) => {
    const code = (text) => element(documentRef, 'code', '', text);
    const details = element(documentRef, 'details', 'private-cams-relay-steps');
    details.open = open;
    const steps = element(documentRef, 'ol');
    for (const parts of [
      ['Run ', code('npm run arlo-relay:install'), ' in the app folder.'],
      [
        'Open ',
        code('chrome://extensions'),
        ', turn on Developer mode, choose Load unpacked and paste the folder path the install printed into the folder box (on Windows it is under AppData, a hidden folder you will not see by browsing).',
      ],
      ["Open the extension's options (Details → Extension options) and press PAIR WITH GODS EYE VIEW. Gods Eye View gives that request a code: APPROVE only the request here whose code and extension ID both match the options page."],
      [
        'Keep ',
        code('https://my.arlo.com/#/feed'),
        ' open and signed in — reload that tab once after installing or updating the extension — and add my.arlo.com to ',
        code('chrome://settings/performance'),
        ' → “Always keep these sites active”.',
      ],
    ]) {
      const step = element(documentRef, 'li');
      step.append(...parts);
      steps.append(step);
    }
    details.append(element(documentRef, 'summary', '', 'SET UP THE ARLO FEED RELAY'), steps);
    return details;
  };

  const renderRelay = (site, pending) => {
    const box = element(documentRef, 'div', 'private-cams-relay');
    box.append(
      element(documentRef, 'p', 'private-cams-warning', "Arlo's terms of service prohibit data-extraction tools and allow Arlo to close accounts. Use the relay at your own risk."),
      element(documentRef, 'p', 'private-cams-relay-limits', 'Pictures are the latest motion-clip thumbnails, not live video; Arlo signs the web page out after inactivity.'),
    );
    const originWarning = relayOriginWarning(globalThis.location?.origin);
    if (originWarning) box.append(element(documentRef, 'p', 'private-cams-warning private-cams-relay-origin', originWarning));
    if (!site.id || !isRelaySite(site)) {
      box.append(element(documentRef, 'p', 'private-cams-relay-limits', 'Save this site with Browser feed relay selected, then pair the extension here.'), relaySetupSteps(true));
      return box;
    }

    const live = element(documentRef, 'div', 'private-cams-relay-live');
    const message = element(documentRef, 'span', 'private-cams-relay-message');
    message.setAttribute('role', 'status');
    const steps = relaySetupSteps(!site.relay.paired);

    // Every line is built once and updated in place, and a request's APPROVE
    // button is replaced only when the requests themselves change, so a refresh
    // never takes away a button the user is about to press. It holds no inputs.
    const statusLine = element(documentRef, 'p', 'private-cams-relay-status');
    const pairedLine = element(documentRef, 'p', 'private-cams-relay-paired');
    const cameraList = element(documentRef, 'ul', 'private-cams-relay-cameras');
    const unknownLine = element(documentRef, 'p', 'private-cams-warning private-cams-relay-unknown');
    const requestList = element(documentRef, 'div', 'private-cams-relay-requests');
    live.append(statusLine, pairedLine, cameraList, unknownLine, requestList);
    let unpairButton = null;
    let camerasShown = '';
    let requestsShown = '';
    // While an approval or unpairing is on its way, every relay button stays disabled, however often the panel refreshes.
    let busy = false;
    const syncControls = () => {
      for (const control of requestList.querySelectorAll('button')) control.disabled = busy || !editable;
      if (unpairButton) unpairButton.disabled = busy || !editable;
    };
    const setText = (node, text) => {
      if (node.textContent !== text) node.textContent = text;
    };

    const approvePairing = async (request) => {
      if (lifetime.signal.aborted || !editable || busy) return;
      busy = true;
      syncControls();
      message.textContent = 'Approving…';
      try {
        // The code and the extension id exactly as shown here: the server pairs that request and no other.
        const payload = await post({ siteId: site.id, code: request.code, extensionId: request.extensionId }, RELAY_APPROVE_ENDPOINT);
        if (lifetime.signal.aborted) return;
        message.textContent = `Paired${payload.extensionId ? ` with extension ${payload.extensionId}` : ''}. Pictures of cameras with clips in your feed arrive within a minute.`;
        steps.open = false;
      } catch (error) {
        if (!lifetime.signal.aborted) message.textContent = error.message;
      } finally {
        busy = false;
        syncControls();
        void refreshRelay();
      }
    };

    const unpairRelay = async () => {
      if (lifetime.signal.aborted || !editable || busy) return;
      const ok = typeof globalThis.confirm !== 'function' || globalThis.confirm(`Unpair the Arlo feed relay from ${site.name}? Its cameras get no new pictures until you pair again.`);
      if (!ok) return;
      busy = true;
      syncControls();
      message.textContent = 'Unpairing…';
      try {
        await post({ siteId: site.id }, RELAY_UNPAIR_ENDPOINT);
        if (!lifetime.signal.aborted) message.textContent = 'Unpaired. Pair again from the extension options to get pictures.';
      } catch (error) {
        if (!lifetime.signal.aborted) message.textContent = error.message;
      } finally {
        busy = false;
        syncControls();
        void refreshRelay();
      }
    };

    const update = (current, currentPending) => {
      const lines = relayPanelLines(current, currentPending);
      setText(statusLine, lines.status);
      statusLine.dataset.tone = lines.tone;
      setText(pairedLine, lines.pairedText);
      const camerasKey = JSON.stringify(lines.cameras);
      if (camerasKey !== camerasShown) {
        camerasShown = camerasKey;
        cameraList.textContent = '';
        for (const line of lines.cameras) cameraList.append(element(documentRef, 'li', '', line));
        cameraList.hidden = !lines.cameras.length;
      }
      setText(unknownLine, lines.unknown);
      unknownLine.hidden = !lines.unknown;
      const requestsKey = JSON.stringify(lines.requests.map((request) => [request.extensionId, request.code]));
      if (requestsKey !== requestsShown) {
        requestsShown = requestsKey;
        requestList.textContent = '';
        for (const request of lines.requests) {
          const box = element(documentRef, 'div', 'private-cams-relay-pending');
          const approve = button(documentRef, 'key-setup-apply private-cams-save private-cams-relay-approve', 'APPROVE', 'Pair this site with the extension whose options page shows this code and extension ID');
          approve.addEventListener('click', () => void approvePairing(request));
          box.append(
            element(documentRef, 'strong', '', request.text),
            element(documentRef, 'span', 'private-cams-relay-limits', "Only approve if both this code and this extension ID are shown on the relay's options page."),
            approve,
          );
          requestList.append(box);
        }
        requestList.hidden = !lines.requests.length;
      }
      if (lines.paired && !unpairButton) {
        unpairButton = button(documentRef, 'private-cams-remove-site private-cams-relay-unpair', 'UNPAIR', 'Forget the paired extension; it sends no pictures until paired again');
        unpairButton.addEventListener('click', () => void unpairRelay());
        live.append(unpairButton);
      } else if (!lines.paired && unpairButton) {
        unpairButton.remove();
        unpairButton = null;
      }
      syncControls();
    };
    update(site, pending);
    relayPanels.set(site.id, update);
    box.append(live, message, steps);
    return box;
  };

  const renderSite = (kind, site, pending = null) => {
    const block = element(documentRef, 'div', 'private-cams-site');
    block.dataset.siteId = site.id || '';

    const head = element(documentRef, 'div', 'private-cams-site-head');
    head.append(input(documentRef, { name: 'name', value: site.name || '', placeholder: 'Site name', label: 'Site name' }));
    const [transportText, transportTitle] = TRANSPORT_LABELS[site.transport || 'none'] || TRANSPORT_LABELS.none;
    if (transportText) {
      const badge = element(documentRef, 'span', 'private-cams-transport', transportText);
      badge.dataset.transport = site.transport;
      badge.title = transportTitle;
      head.append(badge);
    }
    block.append(head);
    let arloWarning = null;
    if (site.arloWebsite) {
      arloWarning = element(
        documentRef,
        'p',
        'private-cams-warning',
        'No picture: this site points at the Arlo website (my.arlo.com), which is a sign-in page, not a camera feed — so these cameras stay dark and no login is sent there. Use a local bridge — Home Assistant with the Aarlo integration (Bridge URL http://<home-assistant>:8123, a long-lived token, cameras like camera.aarlo_front) or Scrypted with its Arlo plugin (each camera’s snapshot URL) — or choose “Browser feed relay (Chrome extension)” below to receive clip pictures from your own signed-in my.arlo.com feed (your saved login stays saved).',
      );
      block.append(arloWarning);
    }

    // Location: a street address or a postal / ZIP code places the site.
    const location = element(documentRef, 'div', 'private-cams-location');
    const where = input(documentRef, {
      name: 'locationQuery',
      value: site.address || site.postalCode || '',
      placeholder: 'Street address or postal / ZIP code, e.g. 42 Charlotte St, Saint John NB',
      label: 'Street address or postal / ZIP code for this site',
    });
    const locate = button(documentRef, 'private-cams-add private-cams-locate', 'LOCATE', 'Place this site on the map from its street address or postal code');
    const located = element(documentRef, 'span', 'private-cams-located', site.located && site.locationLabel ? `On the map at ${site.locationLabel}. Drag a camera icon on the map to fine-tune it.` : '');
    located.setAttribute('role', 'status');
    const setLocation = (point) => {
      if (point) {
        block.dataset.lat = String(point.lat);
        block.dataset.lon = String(point.lon);
        block.dataset.locationLabel = point.label || '';
      } else {
        delete block.dataset.lat;
        delete block.dataset.lon;
        delete block.dataset.locationLabel;
      }
    };
    const queryKey = (value) => tidy(value).toLowerCase();
    if (site.located) setLocation({ lat: site.lat, lon: site.lon, label: site.locationLabel });
    let locatedQuery = site.located ? queryKey(site.address || site.postalCode || '') : '';
    const runLocate = async () => {
      const query = tidy(where.value);
      const { postalCode, address } = splitSiteLocationQuery(query);
      if (!postalCode && address.length < 4) {
        located.textContent = 'Type the street address or the postal / ZIP code first.';
        return false;
      }
      if (postalCode) where.value = postalCode;
      locate.disabled = true;
      located.textContent = 'Locating…';
      try {
        const point = await locateSiteLocation(query, { fetchImpl: doFetch, signal: lifetime.signal });
        if (lifetime.signal.aborted) return false;
        if (!point) {
          located.textContent = `Could not find “${query}”. Add the city and province or state, or try the street address.`;
          return false;
        }
        setLocation(point);
        locatedQuery = queryKey(where.value);
        located.textContent = siteLocateMessage(point);
        return true;
      } catch {
        if (!lifetime.signal.aborted) located.textContent = 'Lookup failed — check the connection and try again.';
        return false;
      } finally {
        locate.disabled = false;
      }
    };
    where.addEventListener('input', () => {
      if (queryKey(where.value) !== locatedQuery) {
        setLocation(null);
        located.textContent = 'Press LOCATE, or SAVE SITE, to place this on the map.';
      }
    });
    where.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void runLocate();
      }
    });
    locate.addEventListener('click', () => void runLocate());
    location.append(where, locate, located);
    block.append(location);

    const login = element(documentRef, 'div', 'private-cams-login');
    let authSelect = null;
    if (kind.id === 'home') {
      login.append(input(documentRef, { name: 'bridgeUrl', value: site.bridgeUrl || '', placeholder: 'Bridge URL — https://homeassistant.local:8123 (cameras show a placeholder until set)', label: 'Bridge URL' }));
      authSelect = element(documentRef, 'select', 'private-cams-auth');
      authSelect.dataset.field = 'auth';
      authSelect.setAttribute('aria-label', 'How this site gets its pictures');
      const choices = privateCameraAuthChoices(kind);
      for (const [value, label] of choices) {
        const option = element(documentRef, 'option', '', label);
        option.value = value;
        authSelect.append(option);
      }
      authSelect.value = choices.some(([value]) => value === site.auth) ? site.auth : 'token';
      login.append(authSelect);
      login.append(input(documentRef, { name: 'token', type: 'password', placeholder: site.tokenSet ? 'Token saved — paste to replace' : 'Long-lived access token', label: 'Access token' }));
    }
    login.append(
      input(documentRef, { name: 'username', placeholder: site.usernameSet ? 'Username saved — type to replace' : 'Username', label: 'Username' }),
      input(documentRef, { name: 'password', type: 'password', placeholder: site.passwordSet ? 'Password saved — type to replace' : 'Password', label: 'Password' }),
      input(documentRef, {
        name: 'tlsFingerprint',
        value: site.tlsFingerprint || '',
        placeholder: 'Certificate SHA-256 fingerprint (optional, pins a self-signed https certificate)',
        label: 'Pinned certificate fingerprint',
      }),
    );
    block.append(login);
    const relayBox = kind.id === 'home' ? renderRelay(site, pending) : null;
    if (relayBox) block.append(relayBox);

    const listHead = element(documentRef, 'div', 'private-cams-camera private-cams-camera-head');
    const headCells = ['NAME', '', 'FACING', ''].map((label) => element(documentRef, 'span', '', label));
    listHead.append(...headCells);
    const list = element(documentRef, 'div', 'private-cams-cameras');
    const relayChosen = () => authSelect?.value === 'relay';
    for (const camera of site.cameras || []) renderCameraRow(list, kind, camera, relayChosen());
    const unplaced = (site.cameras || []).filter((camera) => !camera.placed).length;

    // The relay hides the bridge and login fields without clearing them: they
    // are not sent while it is chosen, so anything saved stays saved.
    const loginField = (name) => login.querySelector(`[data-field="${name}"]`);
    const syncAuth = () => {
      const mode = authSelect ? authSelect.value : 'login';
      const relay = mode === 'relay';
      if (authSelect) {
        loginField('bridgeUrl').hidden = relay;
        loginField('token').hidden = mode !== 'token';
      }
      loginField('username').hidden = mode !== 'login';
      loginField('password').hidden = mode !== 'login';
      loginField('tlsFingerprint').hidden = relay;
      if (arloWarning) arloWarning.hidden = relay;
      if (relayBox) relayBox.hidden = !relay;
      let sourceHeading = kind.id === 'home' ? 'ENTITY OR SNAPSHOT URL' : 'SNAPSHOT URL';
      if (relay) sourceHeading = 'ARLO CAMERA NAME';
      headCells[1].textContent = sourceHeading;
      for (const field of list.querySelectorAll('[data-field="source"]')) labelSource(field, kind, relay);
    };
    authSelect?.addEventListener('change', syncAuth);
    syncAuth();

    const actions = element(documentRef, 'div', 'private-cams-actions');
    const add = button(documentRef, 'private-cams-add', '+ ADD CAMERA');
    add.addEventListener('click', () => renderCameraRow(list, kind, {}, relayChosen()));
    const save = button(documentRef, 'key-setup-apply private-cams-save', 'SAVE SITE');
    const note = element(documentRef, 'span', 'private-cams-note', unplaced ? `${unplaced} camera${unplaced === 1 ? '' : 's'} not on the map yet — enter the site street address or postal code and LOCATE.` : '');
    note.setAttribute('role', 'status');
    actions.append(add, save);
    if (site.id) {
      const removeSite = button(documentRef, 'private-cams-remove-site', 'REMOVE SITE', 'Delete this site, its login and its cameras');
      removeSite.addEventListener('click', async () => {
        const ok = typeof globalThis.confirm !== 'function' || globalThis.confirm(`Remove ${site.name} with its login and ${site.cameras.length} camera(s)?`);
        if (!ok) return;
        try {
          const payload = await post({ removeSiteId: site.id });
          render({ ...payload.status, editable });
          void refreshRelay();
          globalThis.dispatchEvent?.(new CustomEvent('gev:private-cameras-changed'));
        } catch (error) {
          if (!lifetime.signal.aborted) note.textContent = error.message;
        }
      });
      actions.append(removeSite);
    } else {
      const discard = button(documentRef, 'private-cams-remove-site', 'DISCARD');
      discard.addEventListener('click', () => block.remove());
      actions.append(discard);
    }
    actions.append(note);
    block.append(listHead, list, actions);

    save.addEventListener('click', async () => {
      if (lifetime.signal.aborted || save.getAttribute('aria-disabled') === 'true') return;
      save.setAttribute('aria-disabled', 'true');
      try {
        const typed = splitSiteLocationQuery(where.value);
        const hasLocation = Boolean(typed.postalCode || typed.address);
        // A typed location that has not been looked up yet is located first.
        if (hasLocation && !block.dataset.lat) {
          note.textContent = 'Locating the site…';
          if (!(await runLocate())) {
            note.textContent = located.textContent;
            return;
          }
        }
        const field = (name) => block.querySelector(`.private-cams-site-head [data-field="${name}"], .private-cams-login [data-field="${name}"]`);
        const trimmed = (name) => field(name)?.value?.trim() ?? '';
        const cameras = [...list.querySelectorAll('.private-cams-camera')].map((row) => {
          const cell = (name) => row.querySelector(`[data-field="${name}"]`)?.value?.trim() ?? '';
          return { id: row.dataset.cameraId || '', name: cell('name'), source: cell('source'), headingDeg: cell('headingDeg') };
        });
        const saved = splitSiteLocationQuery(where.value);
        const body = collectPrivateSiteUpdate(
          kind.id,
          site.id,
          {
            name: trimmed('name'),
            postalCode: saved.postalCode,
            address: saved.address,
            lat: hasLocation ? (block.dataset.lat ?? '') : '',
            lon: hasLocation ? (block.dataset.lon ?? '') : '',
            locationLabel: hasLocation ? (block.dataset.locationLabel ?? '') : '',
            bridgeUrl: trimmed('bridgeUrl'),
            auth: authSelect?.value,
            token: field('token')?.value ?? '',
            username: trimmed('username'),
            password: field('password')?.value ?? '',
            tlsFingerprint: trimmed('tlsFingerprint'),
          },
          cameras,
        );
        note.textContent = 'Saving…';
        const payload = await post(body);
        if (lifetime.signal.aborted) return;
        render({ ...payload.status, editable });
        void refreshRelay();
        globalThis.dispatchEvent?.(new CustomEvent('gev:private-cameras-changed'));
        const savedNote = host.querySelector(`[data-site-id="${payload.siteId}"] .private-cams-note`);
        if (savedNote) savedNote.textContent = `Saved on this machine only; the camera list is reloading.${savedNote.textContent ? ` ${savedNote.textContent}` : ''}`;
      } catch (error) {
        if (!lifetime.signal.aborted) note.textContent = error.message;
      } finally {
        save.setAttribute('aria-disabled', 'false');
      }
    });

    if (!editable) {
      for (const control of block.querySelectorAll('input, select, button')) control.disabled = true;
      note.textContent = 'Editing is available under the dev server only.';
    }
    return block;
  };

  const renderKind = (kind, pending) => {
    const card = element(documentRef, 'section', 'key-setup-row private-cams-kind');
    card.dataset.kindId = kind.id;
    card.dataset.set = String(kind.sites.some((site) => site.cameras.length > 0));
    const head = element(documentRef, 'div', 'key-setup-row-head');
    const led = element(documentRef, 'span', 'key-setup-led');
    led.setAttribute('aria-hidden', 'true');
    const total = kind.sites.reduce((sum, site) => sum + site.cameras.length, 0);
    head.append(led, element(documentRef, 'strong', '', kind.title));
    head.append(element(documentRef, 'span', 'private-cams-count', `${kind.sites.length} site${kind.sites.length === 1 ? '' : 's'} · ${total} camera${total === 1 ? '' : 's'}`));
    if (kind.feedUrl) {
      const feed = element(documentRef, 'a', 'key-setup-get', 'OPEN ARLO FEED ↗');
      feed.href = kind.feedUrl;
      feed.target = '_blank';
      feed.rel = 'noopener noreferrer';
      feed.title = 'Opens your Arlo feed, where your own Arlo sign-in applies';
      head.append(feed);
    }
    const sites = element(documentRef, 'div', 'private-cams-sites');
    for (const site of kind.sites) sites.append(renderSite(kind, site, pending));
    const addSite = button(documentRef, 'private-cams-add private-cams-add-site', kind.id === 'home' ? '+ ADD HOME SITE' : '+ ADD BUSINESS SITE');
    addSite.disabled = !editable;
    addSite.addEventListener('click', () => sites.append(renderSite(kind, { name: '', cameras: [], transport: 'none' })));
    card.append(head, element(documentRef, 'p', 'key-setup-unlocks', kind.unlocks), sites, addSite);
    return card;
  };

  const render = (status) => {
    editable = status.editable !== false;
    generation += 1;
    relayPanels.clear();
    host.textContent = '';
    host.append(
      element(documentRef, 'div', 'private-cams-heading', 'SECURITY CAMERAS · PRIVATE TO THIS MACHINE'),
      element(
        documentRef,
        'p',
        'key-setup-unlocks private-cams-intro',
        'Logins and camera addresses stay in config/private-cameras.json on this computer. These cameras never enter share links or the public camera list, the server shows them only to this machine, and a login is never sent over plain http beyond your local network. LOCATE sends only the site street address or postal code to the OpenStreetMap search. Drag any private camera icon on the map to move it.',
      ),
    );
    for (const kind of status.kinds || []) host.append(renderKind(kind, status.relayPending || null));
    host.hidden = false;
    syncRelayTimer();
  };

  void (async () => {
    try {
      const status = await readStatus();
      if (!lifetime.signal.aborted) render(status);
    } catch {
      host.hidden = true;
    }
  })();

  return {
    /** Re-read the relay panels now, when the section is on screen (the POWER UP dialog calls this when it opens). */
    refresh() {
      refreshIfShown();
    },
    destroy() {
      stop();
      signal?.removeEventListener('abort', stop);
      host.textContent = '';
    },
  };
}
