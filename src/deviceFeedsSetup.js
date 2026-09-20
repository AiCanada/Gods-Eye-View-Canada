/**
 * POWER UP cards for the owner's own devices: aerial drones, robots, marine
 * drones, GPS trackers, and the Ultra Security Package (a tracker or a phone
 * the map follows and records around). One card per kind, any number of devices
 * in each. Any device can be followed or recorded; a package does both unless
 * its owner says otherwise.
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
 */

import { DEVICE_FEEDS_CHANGED_EVENT } from './deviceFeedsCore.mjs';

export { DEVICE_FEEDS_CHANGED_EVENT };

const STATUS_ENDPOINT = '/api/device-feeds/status';
const CONFIG_ENDPOINT = '/api/device-feeds/config';

const TRANSPORT_LABELS = {
  https: 'HTTPS',
  'lan-http': 'LOCAL NETWORK',
  insecure: 'NOT ENCRYPTED',
  none: 'NO ADDRESS',
};

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

/**
 * The POST body for one device. Pure, exported for tests. Empty secrets are
 * left out so what is saved survives; an address is sent only when something
 * was typed, because the card is shown a masked address, not the real one.
 */
export function collectDeviceFeedUpdate(kindId, feedId, values) {
  const body = { kind: kindId, name: String(values.name || '').trim(), method: values.method, auth: values.auth || 'none' };
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
  const lat = String(values.lat ?? '').trim();
  const lon = String(values.lon ?? '').trim();
  body.lat = lat === '' ? null : Number(lat);
  body.lon = lon === '' ? null : Number(lon);
  if (typeof values.follow === 'boolean') body.follow = values.follow;
  if (typeof values.record === 'boolean') body.record = values.record;
  return body;
}

/** "3 devices · 2 live" for a card's head. Pure. */
export function deviceFeedCountText(kind) {
  const feeds = kind?.feeds || [];
  if (!feeds.length) return 'none added';
  const live = feeds.filter((feed) => feed.state?.ok).length;
  return `${feeds.length} ${feeds.length === 1 ? 'device' : 'devices'} · ${live} live`;
}

/** "RECORDING · 3 files · 1.2 MB in config/device-recordings/x". Pure. */
export function deviceRecordingText(feed) {
  const info = feed?.recording;
  if (!info) return feed?.record ? 'RECORDING · nothing saved yet (saves while the map is open and the device has a position)' : '';
  const size = info.bytes >= 1024 * 1024 ? `${(info.bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(info.bytes / 1024))} KB`;
  return `${feed.record ? 'RECORDING' : 'RECORDED'} · ${info.files} ${info.files === 1 ? 'day' : 'days'} · ${size} in ${info.folder}`;
}

/** One line on how a device is doing. Pure. */
export function deviceFeedStateText(feed) {
  if (!feed?.state) return feed?.urlSet ? 'Not asked yet' : feed?.pictureSet ? 'Picture only' : '';
  if (feed.state.ok) return 'LIVE · position received';
  return `NO POSITION · ${feed.state.error || 'unreachable'}`;
}

export function initDeviceFeedSetup({ host, documentRef = globalThis.document, fetchImpl, signal, onSections = null } = {}) {
  if (!host || !documentRef?.createElement) return { refresh() {}, destroy() {} };
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const lifetime = new AbortController();
  if (signal) {
    if (signal.aborted) lifetime.abort();
    else signal.addEventListener('abort', () => lifetime.abort(), { once: true });
  }
  let editable = false;
  let authModes = [];

  const readStatus = async () => {
    const response = await doFetch(STATUS_ENDPOINT, { credentials: 'same-origin', cache: 'no-store', signal: lifetime.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  const post = async (body) => {
    const response = await doFetch(CONFIG_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: lifetime.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  };

  // The map layer (src/data/deviceFeeds.js) listens: a saved device shows at once.
  const announce = (status) => {
    const count = (status?.kinds || []).reduce((sum, kind) => sum + (kind.feeds?.length || 0), 0);
    try {
      globalThis.window?.dispatchEvent(new CustomEvent(DEVICE_FEEDS_CHANGED_EVENT, { detail: { count } }));
    } catch {
      /* no window (tests) */
    }
  };

  const renderFeed = (kind, feed) => {
    const saved = Boolean(feed?.id);
    const block = element(documentRef, 'div', 'device-feeds-feed');
    const head = element(documentRef, 'div', 'device-feeds-feed-head');
    const name = input(documentRef, { name: 'name', value: feed?.name || '', placeholder: `${kind.noun} NAME`, label: 'Device name' });
    const badge = element(documentRef, 'span', 'private-cams-transport', TRANSPORT_LABELS[feed?.transport || 'none']);
    badge.dataset.transport = feed?.transport || 'none';
    head.append(name, badge);
    block.append(head);

    const state = element(documentRef, 'p', 'device-feeds-state', saved ? deviceFeedStateText(feed) : '');
    state.dataset.ok = feed?.state?.ok ? 'true' : 'false';
    block.append(state);

    // How it connects: every standard method for this kind of device.
    const method = element(documentRef, 'select', 'device-feeds-method');
    method.dataset.field = 'method';
    method.setAttribute('aria-label', 'Connection method');
    const directGroup = element(documentRef, 'optgroup');
    directGroup.label = 'CONNECTS DIRECTLY';
    const bridgeGroup = element(documentRef, 'optgroup');
    bridgeGroup.label = 'NEEDS A BRIDGE (SEE NOTE)';
    for (const option of kind.methods) {
      const node = element(documentRef, 'option', '', option.label);
      node.value = option.id;
      (option.direct ? directGroup : bridgeGroup).append(node);
    }
    method.append(directGroup, bridgeGroup);
    method.value = feed?.method || kind.methods.find((option) => option.direct)?.id || '';
    block.append(method);

    const bridgeNote = element(documentRef, 'p', 'device-feeds-bridge');
    bridgeNote.setAttribute('role', 'note');
    block.append(bridgeNote);

    const url = input(documentRef, { name: 'url', value: '', placeholder: 'ADDRESS', label: 'Address the position is read from' });
    const picture = input(documentRef, { name: 'pictureUrl', value: '', placeholder: 'CAMERA PICTURE ADDRESS (OPTIONAL: SNAPSHOT OR MJPEG)', label: 'Camera picture address' });
    if (feed?.urlSet) url.placeholder = `SAVED: ${feed.url}`;
    if (feed?.pictureSet) picture.placeholder = `SAVED: ${feed.pictureUrl} (TYPE NONE TO REMOVE)`;
    block.append(url, picture);

    const paths = element(documentRef, 'div', 'device-feeds-paths');
    const latPath = input(documentRef, { name: 'latPath', value: feed?.latPath || '', placeholder: 'LATITUDE JSON PATH (OPTIONAL)', label: 'Latitude JSON path' });
    const lonPath = input(documentRef, { name: 'lonPath', value: feed?.lonPath || '', placeholder: 'LONGITUDE JSON PATH (OPTIONAL)', label: 'Longitude JSON path' });
    paths.append(latPath, lonPath);
    block.append(paths);

    const fixed = element(documentRef, 'div', 'device-feeds-fixed');
    const lat = input(documentRef, { name: 'lat', value: feed?.lat ?? '', placeholder: 'FIXED LATITUDE (OPTIONAL)', label: 'Fixed latitude' });
    const lon = input(documentRef, { name: 'lon', value: feed?.lon ?? '', placeholder: 'FIXED LONGITUDE (OPTIONAL)', label: 'Fixed longitude' });
    fixed.append(lat, lon);
    block.append(fixed);

    // Login: every standard type; only the boxes that type uses are shown.
    const login = element(documentRef, 'div', 'private-cams-login device-feeds-login');
    const auth = element(documentRef, 'select', 'private-cams-auth');
    auth.dataset.field = 'auth';
    auth.setAttribute('aria-label', 'Login type');
    for (const mode of authModes.filter((item) => kind.authModes.includes(item.id))) {
      const node = element(documentRef, 'option', '', mode.label);
      node.value = mode.id;
      auth.append(node);
    }
    auth.value = feed?.auth || 'none';
    const username = input(documentRef, { name: 'username', placeholder: feed?.usernameSet ? 'USERNAME (SAVED)' : 'USERNAME', label: 'Username' });
    const password = input(documentRef, { name: 'password', type: 'password', placeholder: feed?.passwordSet ? 'PASSWORD (SAVED)' : 'PASSWORD', label: 'Password' });
    const keyName = input(documentRef, { name: 'keyName', value: feed?.keyName || '', placeholder: 'KEY NAME', label: 'Header or parameter name' });
    const token = input(documentRef, { name: 'token', type: 'password', placeholder: feed?.tokenSet ? 'TOKEN / KEY (SAVED)' : 'TOKEN / KEY', label: 'Token or key' });
    login.append(auth, username, password, keyName, token);
    block.append(login);

    // Follow and record. One device is followed at a time: the server moves
    // the follow here when this one is saved with it on.
    const options = element(documentRef, 'div', 'device-feeds-options');
    const toggle = (name, labelText, checked, title) => {
      const label = element(documentRef, 'label', 'device-feeds-option');
      const box = element(documentRef, 'input');
      box.type = 'checkbox';
      box.dataset.field = name;
      box.checked = checked;
      label.title = title;
      label.append(box, element(documentRef, 'span', '', labelText));
      options.append(label);
      return box;
    };
    const follow = toggle('follow', 'FOLLOW ON THE MAP', saved ? feed.follow === true : kind.followDefault === true, 'The map stays on this device wherever it goes. One device is followed at a time.');
    const record = toggle('record', 'RECORD EVERYTHING WITHIN 50 KM', saved ? feed.record === true : kind.recordDefault === true, 'While the map is open, what every layer that is on knows within 50 km of this device is saved on this computer as it moves.');
    block.append(options);
    const recording = element(documentRef, 'p', 'device-feeds-state device-feeds-recording', saved ? deviceRecordingText(feed) : '');
    block.append(recording);

    const sync = () => {
      const spec = kind.methods.find((option) => option.id === method.value);
      const direct = Boolean(spec?.direct);
      bridgeNote.hidden = direct;
      bridgeNote.textContent = direct ? '' : `This application cannot speak ${spec ? spec.label : 'that method'} directly. ${spec?.bridge || ''}`;
      const pictureOnly = spec?.id === 'snapshot';
      url.hidden = !direct || pictureOnly;
      if (spec?.urlHint && !feed?.urlSet) url.placeholder = `ADDRESS, FOR EXAMPLE ${spec.urlHint}`;
      picture.hidden = !direct;
      paths.hidden = !direct || spec?.id !== 'http-json';
      fixed.hidden = !direct;
      login.hidden = !direct;
      options.hidden = !direct;
      const mode = authModes.find((item) => item.id === auth.value);
      const fields = new Set(mode?.fields || []);
      username.hidden = !fields.has('username');
      password.hidden = !fields.has('password');
      keyName.hidden = !fields.has('keyName');
      token.hidden = !fields.has('token');
      if (fields.has('keyName') && !keyName.value) keyName.placeholder = `KEY NAME (DEFAULT ${mode.keyNameDefault})`;
      saveButton.disabled = !editable || !direct;
    };

    const actions = element(documentRef, 'div', 'private-cams-actions');
    const saveButton = button(documentRef, 'key-setup-apply private-cams-save', `SAVE ${kind.noun}`);
    const removeButton = button(documentRef, 'private-cams-remove-site', saved ? `REMOVE ${kind.noun}` : 'DISCARD');
    const note = element(documentRef, 'span', 'private-cams-note');
    note.setAttribute('role', 'status');
    actions.append(saveButton, removeButton, note);
    block.append(actions);

    method.addEventListener('change', sync);
    auth.addEventListener('change', sync);
    sync();

    saveButton.addEventListener('click', async () => {
      if (saveButton.disabled) return;
      note.textContent = 'Saving…';
      saveButton.disabled = true;
      try {
        const body = collectDeviceFeedUpdate(kind.id, feed?.id || '', {
          name: name.value, method: method.value, auth: auth.value,
          url: url.value, pictureUrl: picture.value,
          latPath: latPath.value, lonPath: lonPath.value,
          username: username.value || undefined, keyName: keyName.value,
          password: password.value, token: token.value,
          lat: lat.value, lon: lon.value,
          follow: follow.checked === true, record: record.checked === true,
        });
        const payload = await post(body);
        render(payload.status);
        announce(payload.status);
      } catch (error) {
        note.textContent = error?.message || 'Not saved';
        saveButton.disabled = false;
      }
    });
    removeButton.addEventListener('click', async () => {
      if (!saved) {
        block.remove();
        return;
      }
      if (typeof globalThis.confirm === 'function' && !globalThis.confirm(`Remove ${feed.name}? Its saved address and login are deleted.`)) return;
      note.textContent = 'Removing…';
      try {
        const payload = await post({ removeFeedId: feed.id });
        render(payload.status);
        announce(payload.status);
      } catch (error) {
        note.textContent = error?.message || 'Not removed';
      }
    });

    if (!editable) {
      for (const control of block.querySelectorAll('input, select, button')) control.disabled = true;
      note.textContent = 'Editing is available under the dev server only.';
    }
    return block;
  };

  const renderKind = (kind) => {
    const card = element(documentRef, 'section', 'key-setup-row device-feeds-kind');
    card.dataset.kindId = kind.id;
    card.dataset.set = kind.feeds.length ? 'true' : 'false';
    const head = element(documentRef, 'div', 'key-setup-row-head');
    const led = element(documentRef, 'span', 'key-setup-led');
    led.setAttribute('aria-hidden', 'true');
    head.append(led, element(documentRef, 'strong', '', kind.title), element(documentRef, 'span', 'private-cams-count', deviceFeedCountText(kind)));
    card.append(head, element(documentRef, 'p', 'key-setup-unlocks', kind.unlocks));
    const list = element(documentRef, 'div', 'device-feeds-list');
    for (const feed of kind.feeds) list.append(renderFeed(kind, feed));
    card.append(list);
    const add = button(documentRef, 'private-cams-add', `+ ADD ${kind.noun}`);
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
    host.textContent = '';
    host.hidden = false;
    host.append(
      element(documentRef, 'h3', 'private-cams-heading', 'YOUR DEVICES · PRIVATE TO THIS MACHINE'),
      element(documentRef, 'p', 'key-setup-unlocks', 'Add as many as you have. Addresses and logins stay in a protected file on this computer and are never part of a share link. They stand on the map in the YOUR DEVICES layer, which turns on when you save one.'),
    );
    for (const kind of status?.kinds || []) host.append(renderKind(kind));
    // The dashboard chip counts each section once: ON when it holds a device.
    onSections?.((status?.kinds || []).map((kind) => ({ id: `devices-${kind.id}`, set: (kind.feeds || []).length > 0 })));
  }

  const refresh = async () => {
    try {
      render(await readStatus());
    } catch {
      // No server route (a production build, a LAN visitor): show nothing.
      if (!host.childElementCount) host.hidden = true;
    }
  };
  refresh();

  return {
    refresh,
    destroy() {
      lifetime.abort();
      host.textContent = '';
    },
  };
}
