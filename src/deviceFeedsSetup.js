/**
 * Cards for the owner's own devices: aerial drones, robots, marine drones and
 * GPS trackers in POWER UP, and the Ultra Security Package (a tracker or a
 * phone the map follows and records around) at the bottom of the Ultra tab
 * (moved from POWER UP, owner request 2026-10-17). One card per kind, any
 * number of devices in each. Any device can be followed or recorded; a
 * package does both unless its owner says otherwise.
 *
 * Every device is a small form: a name, how it connects (one of the standard
 * methods for that kind of device), the address, an optional camera picture,
 * and a login (none, username + password, bearer token, or an API key in a
 * header or in the address). Methods this application cannot speak directly
 * (RTSP, MAVLink over UDP, MQTT, ROS, ...) are listed too, each with the bridge
 * that turns it into one it can.
 *
 * The server (server/providers/device-feeds.js) owns every rule; this module
 * only renders what `/api/device-feeds/status` says and posts what was typed.
 * It is told presence flags, never a saved login, so a saved secret shows as
 * "saved" and an empty box keeps it.
 *
 * Each host mounts its own copy: `showKind` picks the kinds it shows and
 * `look` its classes (POWER UP's card look, or the Ultra tab's own labels,
 * notes, rows and buttons). A copy that saves says so, and the other copy
 * reads the status again and redraws when what its cards show has changed.
 */

import {
  DEVICE_FEEDS_CHANGED_EVENT,
  DEVICE_RECORD_RADIUS_KM,
  DEVICE_SECURITY_UNLOCKS,
} from './deviceFeedsCore.mjs';
import { localDigits, msgl, tl, tln } from './i18n/index.js';
import {
  isOwnerRemovalRefusal,
  noteOwnerRemovalRefusal,
  watchOwnerRemoval,
} from './ui/ownerRemoval.js';

export { DEVICE_FEEDS_CHANGED_EVENT };
// The cards' text is marked with tl(): Quebec French in the fork locales.

const STATUS_ENDPOINT = '/api/device-feeds/status';
const CONFIG_ENDPOINT = '/api/device-feeds/config';

/** The Ultra Security Package's kind: its cards are in the Ultra tab. */
export const ULTRA_PACKAGE_KIND = 'security';

/** Said first by POWER UP's devices section and by the Ultra package card. */
const PRIVATE_NOTE = msgl(
  'Add as many as you have. Addresses and logins stay in a protected file on this computer and are never part of a share link. They stand on the map in the Cell layer, which turns on when you save one.',
);

/**
 * Class names per host. POWER UP keeps its card look. The Ultra tab's are
 * the tab's own (src/ui/templates/layer-panels.html, src/ui/styles/ultra.css),
 * so none of POWER UP's card classes, which are styled page-wide, reach it.
 */
export const DEVICE_FEED_LOOKS = Object.freeze({
  'power-up': Object.freeze({
    kind: 'key-setup-row device-feeds-kind',
    list: 'device-feeds-list',
    feed: 'device-feeds-feed',
    feedHead: 'device-feeds-feed-head',
    badge: 'private-cams-transport',
    state: 'device-feeds-state',
    method: 'device-feeds-method',
    bridge: 'device-feeds-bridge',
    report: 'device-feeds-report',
    reportLines: 'device-feeds-report-lines',
    newKey: 'device-feeds-new-key',
    paths: 'device-feeds-paths',
    fixed: 'device-feeds-fixed',
    login: 'private-cams-login device-feeds-login',
    auth: 'private-cams-auth',
    options: 'device-feeds-options',
    option: 'device-feeds-option',
    recordKm: 'device-feeds-record-km',
    recording: 'device-feeds-state device-feeds-recording',
    actions: 'private-cams-actions',
    save: 'key-setup-apply private-cams-save',
    remove: 'private-cams-remove-site',
    note: 'private-cams-note',
    add: 'private-cams-add',
  }),
  ultra: Object.freeze({
    kind: 'ultra-package-kind',
    list: 'ultra-package-list',
    feed: 'ultra-package',
    feedHead: 'cctv-controls ultra-contact ultra-package-head',
    badge: 'ultra-package-transport',
    state: 'ultra-note ultra-package-state',
    method: 'ultra-package-method',
    bridge: 'ultra-note ultra-package-bridge',
    report: 'ultra-reveal ultra-package-report',
    reportLines: 'ultra-package-report-lines',
    newKey: 'scene-btn ultra-package-new-key',
    paths: 'cctv-controls ultra-contact ultra-package-paths',
    fixed: 'cctv-controls ultra-contact ultra-package-fixed',
    login: 'cctv-controls ultra-contact ultra-package-login',
    auth: 'ultra-package-auth',
    options: 'cctv-controls ultra-contact ultra-package-options',
    option: 'ultra-match',
    recordKm: 'ultra-package-record-km',
    recording: 'ultra-note ultra-package-recording',
    actions: 'cctv-controls ultra-contact ultra-package-actions',
    save: 'scene-btn ultra-package-save',
    remove: 'scene-btn ultra-package-remove',
    note: 'ultra-note ultra-package-note',
    add: 'scene-btn ultra-package-add',
  }),
});

/** Names each mounted copy, so a copy knows its own saves from the other's. */
let copies = 0;

const TRANSPORT_LABELS = {
  https: 'HTTPS',
  'lan-http': msgl('LOCAL NETWORK'),
  insecure: msgl('NOT ENCRYPTED'),
  none: msgl('NO ADDRESS'),
  'reports-in': msgl('REPORTS IN'),
};

/**
 * What to type into the phone for a device that reports to this app. Pure.
 * @returns {string[]} lines; empty until the device is saved
 */
export function deviceReportInstructions(feed, status, { kindId = '' } = {}) {
  if (!feed?.id || !feed.reportKey) return [];
  const addresses = Array.isArray(status?.reportAddresses)
    ? status.reportAddresses
    : [];
  const listener = status?.reportListener || {};
  const lines = [];
  if (listener.error)
    lines.push(tl('NOT LISTENING: {error}', { error: listener.error }));
  else if (!addresses.length)
    lines.push(
      tl(
        'NOT LISTENING YET: the dev server opens the report port when a reporting device is saved.',
      ),
    );
  const base =
    addresses[0] || `http://<this machine>:${listener.port || 44173}`;
  // The Ultra Security Package has a phone link: a page the phone's browser
  // opens, which sends the phone's position (and camera) itself. No app.
  if (kindId === 'security')
    lines.push(
      tl(
        'PHONE LINK (no app needed): open {link} on the phone, allow location, keep it open — the page also has SEND HELP / STAND DOWN',
        { link: `${base}/ultra/${feed.reportKey}/cam` },
      ),
    );
  // Help links are minted in the ULTRA SECURITY PACKAGE box, not here: this
  // card only points the owner at them so the phone and the links share one story.
  // A link shares nothing until SEND HELP (owner ruling, 2026-09-28), opens
  // nothing with Network off, and carries the location poll alone: no page,
  // no message box (2026-09-30). The card says so.
  if (kindId === 'security')
    lines.push(
      tl(
        "SHARE A HELP LINK: ULTRA SECURITY PACKAGE box → SHARE ENCRYPTED ULTRA TOKENS (a link works only while its Network is on and you have pressed SEND HELP for this package: then the holder's own GEVC receives this phone's position and the incident classification, and nothing else. With Network off it opens nothing)",
      ),
    );
  lines.push(
    tl('TRACCAR CLIENT: server URL {base} · device identifier {key}', {
      base,
      key: feed.reportKey,
    }),
  );
  lines.push(
    tl('OWNTRACKS (HTTP mode) or OVERLAND: {link}', {
      link: `${base}/${feed.reportKey}`,
    }),
  );
  lines.push(
    tl('GPSLOGGER (custom URL): {link}', {
      link: `${base}/${feed.reportKey}?lat=%LAT&lon=%LON&timestamp=%TIMESTAMP&speedMps=%SPD&bearing=%DIR&altitude=%ALT`,
    }),
  );
  if (addresses.length > 1)
    lines.push(
      tl('ALSO ANSWERS ON: {addresses}', {
        addresses: addresses.slice(1).join(' · '),
      }),
    );
  return lines;
}

/** What a card's kind unlocks, in the page's words. */
function kindUnlocks(kind) {
  return kind?.id === ULTRA_PACKAGE_KIND
    ? tl(DEVICE_SECURITY_UNLOCKS, { km: DEVICE_RECORD_RADIUS_KM })
    : tl(kind?.unlocks || '');
}

function element(documentRef, tag, className, text) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function input(
  documentRef,
  { name, type = 'text', value = '', placeholder = '', label },
) {
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

/**
 * The POST body for one device. Pure, exported for tests. Empty secrets are
 * left out so what is saved survives; an address is sent only when something
 * was typed, because the card is shown a masked address, not the real one.
 */
export function collectDeviceFeedUpdate(kindId, feedId, values) {
  const body = {
    kind: kindId,
    name: String(values.name || '').trim(),
    method: values.method,
    auth: values.auth || 'none',
  };
  if (feedId) body.id = feedId;
  for (const field of ['url', 'pictureUrl']) {
    const typed = String(values[field] ?? '').trim();
    // Nothing typed keeps the saved address; the word NONE removes it.
    if (/^none$/i.test(typed)) body[field] = null;
    else if (typed) body[field] = typed;
  }
  for (const field of ['latPath', 'lonPath', 'username', 'keyName']) {
    if (values[field] !== undefined) body[field] = String(values[field]).trim();
  }
  for (const secret of ['password', 'token']) {
    if (values[secret]) body[secret] = values[secret];
  }
  // A card without the FIXED boxes (an Ultra cell) keeps what is saved.
  if (values.lat !== undefined || values.lon !== undefined) {
    const lat = String(values.lat ?? '').trim();
    const lon = String(values.lon ?? '').trim();
    body.lat = lat === '' ? null : Number(lat);
    body.lon = lon === '' ? null : Number(lon);
  }
  if (typeof values.follow === 'boolean') body.follow = values.follow;
  if (typeof values.record === 'boolean') body.record = values.record;
  if (values.recordKm !== undefined && values.recordKm !== '')
    body.recordKm = Number(values.recordKm);
  return body;
}

/** "3 devices · 2 live" for a card's head. Pure. */
export function deviceFeedCountText(kind) {
  const feeds = kind?.feeds || [];
  if (!feeds.length) return tl('none added');
  const live = feeds.filter((feed) => feed.state?.ok).length;
  return tln(
    feeds.length,
    '{count} device · {live} live',
    '{count} devices · {live} live',
    { live },
  );
}

/** "RECORDING · 3 files · 1.2 MB in config/device-recordings/x". Pure. */
export function deviceRecordingText(feed) {
  const info = feed?.recording;
  if (!info)
    return feed?.record
      ? tl(
          'RECORDING · nothing saved yet (saves while the map is open and the device has a position)',
        )
      : '';
  const size =
    info.bytes >= 1024 * 1024
      ? tl('{size} MB', {
          size: localDigits((info.bytes / (1024 * 1024)).toFixed(1)),
        })
      : tl('{size} KB', { size: Math.max(1, Math.round(info.bytes / 1024)) });
  const within = feed.recordKm
    ? ` · ${tl('within {km} km', { km: feed.recordKm })}`
    : '';
  return `${feed.record ? tl('RECORDING') : tl('RECORDED')}${within} · ${tln(
    info.files,
    '{count} day · {size} in {folder}',
    '{count} days · {size} in {folder}',
    { size, folder: info.folder },
  )}`;
}

/** One line on how a device is doing. Pure. */
export function deviceFeedStateText(feed) {
  if (!feed?.state)
    return feed?.reportsIn
      ? tl('Waiting for the first report')
      : feed?.urlSet
        ? tl('Not asked yet')
        : feed?.pictureSet
          ? tl('Picture only')
          : '';
  if (feed.state.ok)
    return feed.reportsIn
      ? tl('LIVE · reporting in')
      : tl('LIVE · position received');
  return tl('NO POSITION · {why}', {
    why: feed.state.error ? tl(feed.state.error) : tl('unreachable'),
  });
}

/**
 * What a copy's cards are drawn from, less what changes by itself (a device's
 * live state and its recording size). When this changes, the copy redraws.
 * Pure.
 */
export function deviceFeedCardsKey(status, showKind = () => true) {
  return JSON.stringify([
    status?.editable === true,
    status?.reportAddresses || [],
    status?.reportListener || null,
    (status?.kinds || [])
      .filter(showKind)
      .map((kind) => [
        kind.id,
        (kind.feeds || []).map(({ state, recording, ...saved }) => saved),
      ]),
  ]);
}

export function initDeviceFeedSetup({
  host,
  documentRef = globalThis.document,
  fetchImpl,
  signal,
  onSections = null,
  // The kinds this copy shows (POWER UP: all but the package; the Ultra tab:
  // the package alone) and its look ('power-up' or 'ultra').
  showKind = () => true,
  look: lookName = 'power-up',
} = {}) {
  if (!host || !documentRef?.createElement)
    return { refresh() {}, destroy() {} };
  const look = DEVICE_FEED_LOOKS[lookName] || DEVICE_FEED_LOOKS['power-up'];
  const ultraLook = look === DEVICE_FEED_LOOKS.ultra;
  copies += 1;
  const source = `device-feeds-${copies}`;
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const lifetime = new AbortController();
  if (signal) {
    if (signal.aborted) lifetime.abort();
    else
      signal.addEventListener('abort', () => lifetime.abort(), { once: true });
  }
  let editable = false;
  let authModes = [];
  let recordRadiusOptions = [50];
  /** The last status rendered: the report addresses and listener state come from it. */
  let currentStatus = null;
  /** deviceFeedCardsKey of the status drawn last. */
  let drawnKey = '';

  const readStatus = async () => {
    const response = await doFetch(STATUS_ENDPOINT, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: lifetime.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  const post = async (body) => {
    const response = await watchOwnerRemoval(
      doFetch(CONFIG_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: lifetime.signal,
      }),
    );
    const payload = await response.json().catch(() => ({}));
    if (isOwnerRemovalRefusal(response, payload)) {
      // Only the PC removes: callers put the note back and say nothing.
      noteOwnerRemovalRefusal();
      const refused = new Error('');
      refused.ownerRemoval = true;
      throw refused;
    }
    if (!response.ok)
      throw new Error(
        payload.error ? tl(payload.error) : `HTTP ${response.status}`,
      );
    return payload;
  };

  // The map layer (src/data/deviceFeeds.js) listens: a saved device shows at once.
  const announce = (status) => {
    const count = (status?.kinds || []).reduce(
      (sum, kind) => sum + (kind.feeds?.length || 0),
      0,
    );
    try {
      globalThis.window?.dispatchEvent(
        new CustomEvent(DEVICE_FEEDS_CHANGED_EVENT, {
          detail: { count, source },
        }),
      );
    } catch {
      /* no window (tests) */
    }
  };

  const renderFeed = (kind, feed) => {
    const saved = Boolean(feed?.id);
    // An Ultra cell is shown on the map, followed and recorded from the
    // Ultra tab, and its pictures come from its phone: its card here has no
    // FOLLOW, RECORD WITHIN, FIXED LATITUDE/LONGITUDE or CAMERA PICTURE boxes
    // (owner ruling, 2026-10-06). Saving it keeps what those hold.
    const ultraCell = kind.id === ULTRA_PACKAGE_KIND;
    const block = element(documentRef, 'div', look.feed);
    const head = element(documentRef, 'div', look.feedHead);
    const name = input(documentRef, {
      name: 'name',
      value: feed?.name || '',
      placeholder: tl('{device} NAME', { device: tl(kind.noun) }),
      label: tl('Device name'),
    });
    const badge = element(
      documentRef,
      'span',
      look.badge,
      tl(TRANSPORT_LABELS[feed?.transport || 'none']),
    );
    badge.dataset.transport = feed?.transport || 'none';
    head.append(name, badge);
    block.append(head);

    const state = element(
      documentRef,
      'p',
      look.state,
      saved ? deviceFeedStateText(feed) : '',
    );
    state.dataset.ok = feed?.state?.ok ? 'true' : 'false';
    block.append(state);

    // How it connects: every standard method for this kind of device.
    const method = element(documentRef, 'select', look.method);
    method.dataset.field = 'method';
    method.setAttribute('aria-label', tl('Connection method'));
    const directGroup = element(documentRef, 'optgroup');
    directGroup.label = tl('CONNECTS DIRECTLY');
    const bridgeGroup = element(documentRef, 'optgroup');
    bridgeGroup.label = tl('NEEDS A BRIDGE (SEE NOTE)');
    for (const option of kind.methods) {
      const node = element(documentRef, 'option', '', tl(option.label));
      node.value = option.id;
      (option.direct ? directGroup : bridgeGroup).append(node);
    }
    method.append(directGroup, bridgeGroup);
    method.value =
      feed?.method || kind.methods.find((option) => option.direct)?.id || '';
    block.append(method);

    const bridgeNote = element(documentRef, 'p', look.bridge);
    bridgeNote.setAttribute('role', 'note');
    block.append(bridgeNote);

    // "Reports to this app": what to type into the phone, once the device is saved.
    const reportBlock = element(documentRef, 'div', look.report);
    const reportLines = element(documentRef, 'pre', look.reportLines);
    const newKey = button(
      documentRef,
      look.newKey,
      tl('NEW KEY'),
      tl('Mint a new key; the phone must be given the new one'),
    );
    reportBlock.append(reportLines, newKey);
    block.append(reportBlock);

    const url = input(documentRef, {
      name: 'url',
      value: '',
      placeholder: tl('ADDRESS'),
      label: tl('Address the position is read from'),
    });
    const picture = input(documentRef, {
      name: 'pictureUrl',
      value: '',
      placeholder: tl('CAMERA PICTURE ADDRESS (OPTIONAL: SNAPSHOT OR MJPEG)'),
      label: tl('Camera picture address'),
    });
    if (feed?.urlSet)
      url.placeholder = tl('SAVED: {value}', { value: feed.url });
    if (feed?.pictureSet)
      picture.placeholder = tl('SAVED: {value} (TYPE NONE TO REMOVE)', {
        value: feed.pictureUrl,
      });
    block.append(url);
    if (!ultraCell) block.append(picture);

    const paths = element(documentRef, 'div', look.paths);
    const latPath = input(documentRef, {
      name: 'latPath',
      value: feed?.latPath || '',
      placeholder: tl('LATITUDE JSON PATH (OPTIONAL)'),
      label: tl('Latitude JSON path'),
    });
    const lonPath = input(documentRef, {
      name: 'lonPath',
      value: feed?.lonPath || '',
      placeholder: tl('LONGITUDE JSON PATH (OPTIONAL)'),
      label: tl('Longitude JSON path'),
    });
    paths.append(latPath, lonPath);
    block.append(paths);

    const fixed = element(documentRef, 'div', look.fixed);
    const lat = input(documentRef, {
      name: 'lat',
      value: feed?.lat ?? '',
      placeholder: tl('FIXED LATITUDE (OPTIONAL)'),
      label: tl('Fixed latitude'),
    });
    const lon = input(documentRef, {
      name: 'lon',
      value: feed?.lon ?? '',
      placeholder: tl('FIXED LONGITUDE (OPTIONAL)'),
      label: tl('Fixed longitude'),
    });
    fixed.append(lat, lon);
    if (!ultraCell) block.append(fixed);

    // Login: every standard type; only the boxes that type uses are shown.
    const login = element(documentRef, 'div', look.login);
    const auth = element(documentRef, 'select', look.auth);
    auth.dataset.field = 'auth';
    auth.setAttribute('aria-label', tl('Login type'));
    for (const mode of authModes.filter((item) =>
      kind.authModes.includes(item.id),
    )) {
      const node = element(documentRef, 'option', '', tl(mode.label));
      node.value = mode.id;
      auth.append(node);
    }
    auth.value = feed?.auth || 'none';
    const username = input(documentRef, {
      name: 'username',
      placeholder: feed?.usernameSet ? tl('USERNAME (SAVED)') : tl('USERNAME'),
      label: tl('Username'),
    });
    const password = input(documentRef, {
      name: 'password',
      type: 'password',
      placeholder: feed?.passwordSet ? tl('PASSWORD (SAVED)') : tl('PASSWORD'),
      label: tl('Password'),
    });
    const keyName = input(documentRef, {
      name: 'keyName',
      value: feed?.keyName || '',
      placeholder: tl('KEY NAME'),
      label: tl('Header or parameter name'),
    });
    const token = input(documentRef, {
      name: 'token',
      type: 'password',
      placeholder: feed?.tokenSet
        ? tl('TOKEN / KEY (SAVED)')
        : tl('TOKEN / KEY'),
      label: tl('Token or key'),
    });
    login.append(auth, username, password, keyName, token);
    block.append(login);

    // Follow and record. One device is followed at a time: the server moves
    // the follow here when this one is saved with it on.
    const options = element(documentRef, 'div', look.options);
    const toggle = (name, labelText, checked, title) => {
      const label = element(documentRef, 'label', look.option);
      const box = element(documentRef, 'input');
      box.type = 'checkbox';
      box.dataset.field = name;
      box.checked = checked;
      label.title = title;
      label.append(box, element(documentRef, 'span', '', labelText));
      options.append(label);
      return box;
    };
    const follow = toggle(
      'follow',
      tl('FOLLOW ON THE MAP'),
      saved ? feed.follow === true : kind.followDefault === true,
      tl(
        'The map stays on this device wherever it goes. One device is followed at a time.',
      ),
    );
    const record = toggle(
      'record',
      tl('RECORD EVERYTHING WITHIN'),
      saved ? feed.record === true : kind.recordDefault === true,
      tl(
        'While the map is open, what every layer that is on knows within this distance of this device is saved on this computer as it moves.',
      ),
    );
    // How far around the device is saved: 1 to 50 km.
    const recordKm = element(documentRef, 'select', look.recordKm);
    recordKm.dataset.field = 'recordKm';
    recordKm.setAttribute('aria-label', tl('Recording distance'));
    for (const km of recordRadiusOptions) {
      const node = element(documentRef, 'option', '', tl('{km} KM', { km }));
      node.value = String(km);
      recordKm.append(node);
    }
    recordKm.value = String(
      saved && recordRadiusOptions.includes(feed.recordKm)
        ? feed.recordKm
        : (recordRadiusOptions[recordRadiusOptions.length - 1] ?? 50),
    );
    record.parentElement.append(recordKm);
    if (!ultraCell) block.append(options);
    const recording = element(
      documentRef,
      'p',
      look.recording,
      saved ? deviceRecordingText(feed) : '',
    );
    block.append(recording);

    const sync = () => {
      const spec = kind.methods.find((option) => option.id === method.value);
      const direct = Boolean(spec?.direct);
      bridgeNote.hidden = direct;
      bridgeNote.textContent = direct
        ? ''
        : `${tl('This application cannot speak {method} directly.', {
            method: spec ? tl(spec.label) : tl('that method'),
          })} ${spec?.bridge ? tl(spec.bridge) : ''}`;
      const pictureOnly = spec?.id === 'snapshot';
      const reportsIn = spec?.reportsIn === true;
      url.hidden = !direct || pictureOnly || reportsIn;
      if (spec?.urlHint && !feed?.urlSet)
        url.placeholder = tl('ADDRESS, FOR EXAMPLE {hint}', {
          hint: spec.urlHint,
        });
      picture.hidden = !direct;
      paths.hidden = !direct || spec?.id !== 'http-json';
      fixed.hidden = !direct;
      login.hidden = !direct || reportsIn;
      options.hidden = !direct;
      reportBlock.hidden = !reportsIn;
      const lines = reportsIn
        ? deviceReportInstructions(
            feed?.reportsIn ? feed : null,
            currentStatus,
            { kindId: kind.id },
          )
        : [];
      reportLines.textContent = lines.length
        ? lines.join('\n')
        : tl(
            'Save the device: its key and the address for the phone appear here.',
          );
      newKey.hidden = !reportsIn || !feed?.reportsIn;
      const mode = authModes.find((item) => item.id === auth.value);
      const fields = new Set(mode?.fields || []);
      username.hidden = !fields.has('username');
      password.hidden = !fields.has('password');
      keyName.hidden = !fields.has('keyName');
      token.hidden = !fields.has('token');
      if (fields.has('keyName') && !keyName.value)
        keyName.placeholder = tl('KEY NAME (DEFAULT {name})', {
          name: mode.keyNameDefault,
        });
      saveButton.disabled = !editable || !direct;
    };

    const actions = element(documentRef, 'div', look.actions);
    const saveButton = button(
      documentRef,
      look.save,
      tl('SAVE {device}', { device: tl(kind.noun) }),
    );
    const removeButton = button(
      documentRef,
      look.remove,
      saved ? tl('REMOVE {device}', { device: tl(kind.noun) }) : tl('DISCARD'),
    );
    const note = element(documentRef, 'span', look.note);
    note.setAttribute('role', 'status');
    actions.append(saveButton, removeButton, note);
    block.append(actions);

    method.addEventListener('change', sync);
    auth.addEventListener('change', sync);
    sync();

    saveButton.addEventListener('click', async () => {
      if (saveButton.disabled) return;
      const before = note.textContent;
      note.textContent = tl('Saving…');
      saveButton.disabled = true;
      try {
        const body = collectDeviceFeedUpdate(kind.id, feed?.id || '', {
          name: name.value,
          method: method.value,
          auth: auth.value,
          url: url.value,
          pictureUrl: ultraCell ? undefined : picture.value,
          latPath: latPath.value,
          lonPath: lonPath.value,
          username: username.value || undefined,
          keyName: keyName.value,
          password: password.value,
          token: token.value,
          ...(ultraCell
            ? // A new Ultra cell starts followed and recording, as before;
              // a saved one keeps its choices from the Ultra tab.
              saved
              ? {}
              : {
                  follow: kind.followDefault === true,
                  record: kind.recordDefault === true,
                }
            : {
                lat: lat.value,
                lon: lon.value,
                follow: follow.checked === true,
                record: record.checked === true,
                recordKm: recordKm.value,
              }),
        });
        const payload = await post(body);
        render(payload.status);
        announce(payload.status);
      } catch (error) {
        // The owner's phone: what is saved stays saved, and the note is as it
        // was. What was typed stays in the fields.
        note.textContent = error?.ownerRemoval
          ? before
          : error?.message || tl('Not saved');
        saveButton.disabled = false;
      }
    });
    newKey.addEventListener('click', async () => {
      if (!saved || !editable) return;
      if (
        typeof globalThis.confirm === 'function' &&
        !globalThis.confirm(
          tl(
            'New key for {name}? The phone stops reporting until it is given the new one.',
            { name: feed.name },
          ),
        )
      )
        return;
      note.textContent = tl('Minting…');
      try {
        const payload = await post({
          kind: kind.id,
          id: feed.id,
          name: feed.name,
          method: feed.method,
          newReportKey: true,
        });
        render(payload.status);
        announce(payload.status);
      } catch (error) {
        note.textContent = error?.message || tl('No new key');
      }
    });
    removeButton.addEventListener('click', async () => {
      if (!saved) {
        block.remove();
        return;
      }
      if (
        typeof globalThis.confirm === 'function' &&
        !globalThis.confirm(
          tl('Remove {name}? Its saved address and login are deleted.', {
            name: feed.name,
          }),
        )
      )
        return;
      const before = note.textContent;
      note.textContent = tl('Removing…');
      try {
        const payload = await post({ removeFeedId: feed.id });
        render(payload.status);
        announce(payload.status);
      } catch (error) {
        // The owner's phone: the device stays and the note is as it was.
        note.textContent = error?.ownerRemoval
          ? before
          : error?.message || tl('Not removed');
      }
    });

    if (!editable) {
      for (const control of block.querySelectorAll('input, select, button'))
        control.disabled = true;
      note.textContent = tl('Editing is available under the dev server only.');
    }
    return block;
  };

  const renderKind = (kind) => {
    const card = element(documentRef, 'section', look.kind);
    card.dataset.kindId = kind.id;
    card.dataset.set = kind.feeds.length ? 'true' : 'false';
    if (ultraLook) {
      // A section of the Ultra tab: its heading with the count beside it,
      // then its notes, as the tab's other sections have.
      const head = element(
        documentRef,
        'div',
        'cctv-summary-label',
        `${tl(kind.title)} `,
      );
      head.append(
        element(
          documentRef,
          'span',
          'ultra-package-count',
          deviceFeedCountText(kind),
        ),
      );
      card.append(
        head,
        element(documentRef, 'p', 'ultra-note', kindUnlocks(kind)),
        element(documentRef, 'p', 'ultra-note', tl(PRIVATE_NOTE)),
      );
    } else {
      const head = element(documentRef, 'div', 'key-setup-row-head');
      const led = element(documentRef, 'span', 'key-setup-led');
      led.setAttribute('aria-hidden', 'true');
      head.append(
        led,
        element(documentRef, 'strong', '', tl(kind.title)),
        element(
          documentRef,
          'span',
          'private-cams-count',
          deviceFeedCountText(kind),
        ),
      );
      card.append(
        head,
        element(documentRef, 'p', 'key-setup-unlocks', kindUnlocks(kind)),
      );
    }
    const list = element(documentRef, 'div', look.list);
    for (const feed of kind.feeds) list.append(renderFeed(kind, feed));
    card.append(list);
    const add = button(
      documentRef,
      look.add,
      tl('+ ADD {device}', { device: tl(kind.noun) }),
    );
    add.disabled = !editable;
    add.addEventListener('click', () => {
      const block = renderFeed(kind, null);
      list.append(block);
      block.querySelector('input')?.focus?.();
    });
    card.append(add);
    return card;
  };

  function render(status) {
    editable = status?.editable === true;
    authModes = Array.isArray(status?.authModes) ? status.authModes : [];
    recordRadiusOptions =
      Array.isArray(status?.recordRadiusOptionsKm) &&
      status.recordRadiusOptionsKm.length
        ? status.recordRadiusOptionsKm
        : [50];
    currentStatus = status || null;
    drawnKey = deviceFeedCardsKey(status, showKind);
    const kinds = (status?.kinds || []).filter(showKind);
    host.textContent = '';
    host.hidden = false;
    // In the Ultra tab the package's own heading says what the section is.
    if (!ultraLook)
      host.append(
        element(
          documentRef,
          'h3',
          'private-cams-heading',
          tl('YOUR DEVICES · PRIVATE TO THIS MACHINE'),
        ),
        element(documentRef, 'p', 'key-setup-unlocks', tl(PRIVATE_NOTE)),
      );
    for (const kind of kinds) host.append(renderKind(kind));
    // The dashboard chip counts each section once: ON when it holds a device.
    // A copy counts the kinds it shows, so the package is not POWER UP's.
    onSections?.(
      kinds.map((kind) => ({
        id: `devices-${kind.id}`,
        set: (kind.feeds || []).length > 0,
      })),
    );
  }

  const refresh = async ({ onlyIfChanged = false } = {}) => {
    try {
      const status = await readStatus();
      // After another copy's save (or the Ultra tab's cell rows), redraw only
      // when what these cards show has changed, so typing is kept otherwise.
      if (onlyIfChanged && deviceFeedCardsKey(status, showKind) === drawnKey)
        return;
      render(status);
    } catch {
      // No server route (a production build, a LAN visitor): show nothing.
      if (!host.childElementCount) host.hidden = true;
    }
  };
  // One device is followed at a time, so a save in one copy can change the
  // other's cards: POWER UP and the Ultra tab each keep the other in step.
  const onChanged = (event) => {
    if (event?.detail?.source !== source) void refresh({ onlyIfChanged: true });
  };
  globalThis.window?.addEventListener?.(DEVICE_FEEDS_CHANGED_EVENT, onChanged);
  refresh();

  return {
    refresh,
    destroy() {
      lifetime.abort();
      globalThis.window?.removeEventListener?.(
        DEVICE_FEEDS_CHANGED_EVENT,
        onChanged,
      );
      host.textContent = '';
    },
  };
}
