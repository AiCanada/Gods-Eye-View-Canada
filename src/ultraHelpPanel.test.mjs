import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyUltraHelpStatus,
  initUltraHelpPanel,
  paintMedia,
  splitUltraHandout,
  ultraNeedsLine,
} from './ultraHelpPanel.js';
import {
  DEVICE_FEEDS_CHANGED_EVENT,
  DEVICE_FEEDS_FOCUS_EVENT,
  DEVICE_FEEDS_HISTORY_EVENT,
  DEVICE_FEEDS_VISIBLE_EVENT,
  DEVICE_HISTORY_PERIODS,
} from './deviceFeedsCore.mjs';

/* The byId/createElement fake of src/overlays/worldOverlay.test.mjs, cut
 * down to what the Ultra box touches. innerHTML throws on purpose: every
 * row must be built with createElement and textContent. */
function installFakeDocument() {
  const byId = new Map();

  function dataKey(attribute) {
    return attribute
      .replace(/^data-/, '')
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.hidden = false;
      this.disabled = false;
      this.textContent = '';
      this.value = '';
      this.placeholder = '';
      this.href = '';
      this.title = '';
      this.rel = '';
      this.checked = false;
      this._classes = new Set();
      this._listeners = new Map();
      const classes = this._classes;
      this.classList = {
        add(name) {
          classes.add(name);
        },
        remove(name) {
          classes.delete(name);
        },
        contains(name) {
          return classes.has(name);
        },
      };
    }

    get className() {
      return [...this._classes].join(' ');
    }

    set className(value) {
      this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
      const classes = this._classes;
      this.classList = {
        add(name) {
          classes.add(name);
        },
        remove(name) {
          classes.delete(name);
        },
        contains(name) {
          return classes.has(name);
        },
      };
    }

    set innerHTML(_value) {
      throw new Error('innerHTML is not allowed in the Ultra box');
    }

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      register(child);
      return child;
    }

    append(...children) {
      for (const child of children) this.appendChild(child);
    }

    replaceChildren(...children) {
      for (const child of this.children) {
        unregister(child);
        blurIfInside(child);
        child.parentElement = null;
      }
      this.children = [];
      for (const child of children) this.appendChild(child);
    }

    /* As in a browser, moving a node takes it out first, and a node taken
     * out of the page takes the focus with it. */
    insertBefore(child, reference) {
      child.remove();
      const at = reference ? this.children.indexOf(reference) : -1;
      if (at < 0) return this.appendChild(child);
      child.parentElement = this;
      this.children.splice(at, 0, child);
      register(child);
      return child;
    }

    remove() {
      const parent = this.parentElement;
      if (!parent) return;
      parent.children = parent.children.filter((child) => child !== this);
      unregister(this);
      blurIfInside(this);
      this.parentElement = null;
    }

    matches(selector) {
      if (selector.includes(','))
        return selector.split(',').some((part) => this.matches(part.trim()));
      /* ':checked' narrows any selector to ticked boxes. */
      if (selector.endsWith(':checked'))
        return this.checked === true && this.matches(selector.slice(0, -8));
      if (selector === 'input[type="checkbox"]')
        return this.tagName === 'INPUT' && this.type === 'checkbox';
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this._classes.has(selector.slice(1));
      const attribute = selector.match(/^\[(data-[a-z-]+)\]$/);
      if (attribute) return dataKey(attribute[1]) in this.dataset;
      return this.tagName === selector.toUpperCase();
    }

    closest(selector) {
      let node = this;
      while (node) {
        if (node.matches(selector)) return node;
        node = node.parentElement;
      }
      return null;
    }

    querySelectorAll(selector) {
      const matches = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (child.matches(selector)) matches.push(child);
          visit(child);
        }
      };
      visit(this);
      return matches;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    contains(node) {
      for (let at = node; at; at = at.parentElement)
        if (at === this) return true;
      return false;
    }

    /* Only an element still in the page can take the focus. Each call is
     * logged with its options, so a test can tell a focus that would scroll
     * the box from one that would not. */
    focus(options) {
      documentRef.focusCalls.push({ node: this, options });
      if (body.contains(this)) documentRef.activeElement = this;
    }

    addEventListener(name, listener) {
      if (!this._listeners.has(name)) this._listeners.set(name, new Set());
      this._listeners.get(name).add(listener);
    }

    removeEventListener(name, listener) {
      this._listeners.get(name)?.delete(listener);
    }

    dispatch(name, event) {
      for (const listener of [...(this._listeners.get(name) || [])]) {
        listener({ preventDefault() {}, ...event });
      }
    }
  }

  function register(element) {
    if (element.id) byId.set(element.id, element);
    for (const child of element.children) register(child);
  }

  function unregister(element) {
    if (element.id) byId.delete(element.id);
    for (const child of element.children) unregister(child);
  }

  function blurIfInside(element) {
    if (element.contains(documentRef.activeElement))
      documentRef.activeElement = body;
  }

  const body = new MockElement('body');
  const documentRef = {
    body,
    activeElement: body,
    focusCalls: [],
    createElement(tagName) {
      return new MockElement(tagName);
    },
    getElementById(id) {
      return byId.get(id) || null;
    },
    querySelectorAll(selector) {
      return body.querySelectorAll(selector);
    },
    querySelector(selector) {
      return body.querySelector(selector);
    },
  };

  const make = (tag, id, parent, extra = {}) => {
    const element = new MockElement(tag);
    element.id = id;
    Object.assign(element, extra);
    parent.appendChild(element);
    return element;
  };
  const panel = make('div', 'ultra-panel', body);
  make('div', 'ultra-status', panel);
  make('div', 'ultra-cam-link', panel);
  /* SEND HELP, first under the status line. */
  const releaseHeading = make('div', 'ultra-release-heading', panel, {
    className: 'cctv-summary-label',
  });
  make('span', 'ultra-release-state', releaseHeading);
  const releaseRow = make('div', 'ultra-release', panel);
  make('select', 'ultra-release-package', releaseRow, { hidden: true });
  make('button', 'ultra-release-send', releaseRow, {
    textContent: 'SEND HELP',
  });
  make('button', 'ultra-release-stand-down', releaseRow, {
    textContent: 'STAND DOWN',
  });
  make('p', 'ultra-release-note', panel);
  make('div', 'ultra-release-plea', panel, { hidden: true });
  const heading = make('div', 'ultra-inbox-heading', panel, {
    className: 'cctv-summary-label',
  });
  make('span', 'ultra-inbox-count', heading);
  make('div', 'ultra-inbox', panel);
  make('input', 'ultra-read-aloud', panel, { checked: true });
  /* DISPLAY ULTRA ON MAP and how much of the path it shows. */
  make('input', 'ultra-map-show', panel, { checked: false });
  make('input', 'ultra-private-cams', panel, { checked: false });
  /* ULTRA CELLS: the list, SHOW ALL and the add form. */
  make('span', 'ultra-cells-count', panel);
  make('div', 'ultra-cells', panel);
  make('button', 'ultra-cells-all', panel);
  const cellForm = make('form', 'ultra-cell-add', panel);
  make('input', 'ultra-cell-name', cellForm, { value: '' });
  make('p', 'ultra-cell-note', panel, { hidden: true });
  make('select', 'ultra-map-period', panel, { value: '30d' });
  make('select', 'ultra-incident', panel, { value: 'threat' });
  /* The saved helpers the plea is texted to. */
  make('p', 'ultra-help-store-note', panel, { hidden: true });
  make('p', 'ultra-outbound-note', panel, { hidden: true });
  make('div', 'ultra-contacts', panel);
  make('p', 'ultra-token-note', panel);
  const numberForm = make('form', 'ultra-number', panel);
  make('input', 'ultra-number-input', numberForm);
  make('button', 'ultra-number-clear', numberForm, { hidden: true });
  const tokenForm = make('form', 'ultra-token', panel);
  make('input', 'ultra-token-label', tokenForm);
  make('input', 'ultra-token-network', tokenForm, { checked: true });
  make('input', 'ultra-token-encrypt', tokenForm, { checked: false });
  make('input', 'ultra-skill-dr', tokenForm, {
    checked: false,
    dataset: { ultraSkill: 'dr' },
  });
  make('input', 'ultra-skill-custom-1', tokenForm);
  make('input', 'ultra-skill-custom-2', tokenForm);
  make('p', 'ultra-skill-custom-preview', tokenForm, { hidden: true });
  make('select', 'ultra-token-package', tokenForm, { hidden: true });
  make('button', 'ultra-token-submit', tokenForm, {
    textContent: 'GENERATE NEW TOKEN',
  });
  const reveal = make('div', 'ultra-token-reveal', panel, { hidden: true });
  make('pre', 'ultra-token-link', reveal);
  make('button', 'ultra-token-copy-address', reveal, {
    textContent: 'COPY ADDRESS',
  });
  make('button', 'ultra-token-copy', reveal, { textContent: 'COPY TOKEN' });
  make('button', 'ultra-token-hide', reveal, { textContent: 'HIDE' });
  make('div', 'ultra-tokens', panel);
  /* HELP NETWORK closes the box. */
  const networkHeading = make('div', 'ultra-network-heading', panel, {
    className: 'cctv-summary-label',
  });
  make('span', 'ultra-network-count', networkHeading);
  make('p', 'ultra-network-note', panel);
  const meForm = make('form', 'ultra-network-me', panel);
  make('input', 'ultra-network-me-name', meForm);
  const directoryForm = make('form', 'ultra-directory', panel);
  make('input', 'ultra-directory-url', directoryForm);
  make('input', 'ultra-directory-token', directoryForm);
  make('select', 'ultra-publish-token', panel, { hidden: true });
  make('select', 'ultra-publish-package', panel, { hidden: true });
  make('button', 'ultra-network-publish', panel);
  make('button', 'ultra-network-update', panel);
  make('button', 'ultra-network-poll', panel);
  const entryBox = make('div', 'ultra-network-entry', panel, { hidden: true });
  make('pre', 'ultra-network-entry-text', entryBox);
  make('p', 'ultra-network-entry-note', entryBox);
  make('button', 'ultra-network-entry-copy', entryBox, {
    textContent: 'COPY ENTRY',
  });
  make('a', 'ultra-network-entry-mail', entryBox, { hidden: true });
  make('button', 'ultra-network-entry-hide', entryBox, { textContent: 'HIDE' });
  const addForm = make('form', 'ultra-network-add', panel);
  make('input', 'ultra-network-address', addForm);
  make('input', 'ultra-network-token', addForm);
  make('input', 'ultra-network-link-name', addForm);
  make('button', 'ultra-network-add-submit', addForm, {
    textContent: 'ADD TO HOME LIST',
  });
  make('div', 'ultra-network-list', panel);
  make('span', 'ultra-sms-relay', panel);
  make('button', 'ultra-sms-test', panel);

  return { documentRef, panel, byId: (id) => byId.get(id) || null };
}

/* The map is only ever nudged through window events; record them. */
function fakeWindow() {
  const dispatched = [];
  return {
    dispatched,
    dispatchEvent(event) {
      dispatched.push({ type: event.type, detail: event.detail });
      return true;
    },
  };
}

const NOW = Date.now();
const TOKEN = 'uht1.Qk3vZ8pLm2nW0xR7tYcB9aH4eS1dF6gJ5kM8oP3qU2w';
const PLACE = '10 Example St, Saint John, New Brunswick (45.2744, -66.0622)';
const PLEA = `Please HELP you are close by, to ${PLACE} of victim in progress, fire thank you.`;
const clock = (at) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function message(overrides = {}) {
  return {
    id: 'm-0000000000000001',
    tokenId: 't-0000000000000001',
    kind: 'message',
    label: 'Neighbour',
    from: 'Sam',
    number: '',
    text: 'Smoke at the back door',
    lat: null,
    lon: null,
    at: NOW,
    deliveredAt: null,
    readAt: null,
    ...overrides,
  };
}

/* A call for help received through the home list: the shape the status
 * poll carries for an inbox row of kind 'release'. */
function release(overrides = {}) {
  return {
    id: 'm-00000000000000e1',
    tokenId: '',
    kind: 'release',
    networkId: 'n-0123456789abcdef',
    label: 'Jeff (Van 7)',
    from: 'Jeff',
    number: '',
    text: PLEA,
    place: PLACE,
    incident: 'fire',
    lat: 45.2744,
    lon: -66.0622,
    at: NOW,
    until: NOW + 4 * 3_600_000,
    sms: 'SMS SENT 22:15',
    deliveredAt: null,
    readAt: null,
    active: true,
    distanceKm: 1.23,
    ...overrides,
  };
}

function token(overrides = {}) {
  return {
    id: 't-0000000000000001',
    feedId: 'security-van',
    label: 'Neighbour',
    sms: true,
    voice: false,
    createdAt: NOW - 86_400_000,
    revokedAt: null,
    fingerprint: 'ab12cd34',
    messages: 3,
    lastAt: NOW,
    ...overrides,
  };
}

function entry(overrides = {}) {
  return {
    id: 'n-0123456789abcdef',
    name: 'Sam',
    host: 'peer.tail9.ts.net',
    source: 'manual',
    addedAt: NOW - 3_600_000,
    lastPolledAt: NOW - 10_000,
    lastState: 'quiet',
    failures: 0,
    directoryMissing: false,
    moved: false,
    active: false,
    ...overrides,
  };
}

function network(overrides = {}) {
  return {
    me: { name: '' },
    polling: true,
    keyState: 'ok',
    directory: {
      url: '',
      configured: false,
      github: false,
      canPublish: false,
      lastUpdateAt: null,
      lastResult: null,
    },
    published: null,
    entries: [],
    relay: {
      provider: '',
      configured: false,
      host: '',
      lastTestAt: null,
      lastOutcome: '',
      sentToday: 0,
    },
    ...overrides,
  };
}

function installSpeech() {
  const spokenText = [];
  const hadSynth = Object.getOwnPropertyDescriptor(
    globalThis,
    'speechSynthesis',
  );
  const hadUtterance = Object.getOwnPropertyDescriptor(
    globalThis,
    'SpeechSynthesisUtterance',
  );
  globalThis.speechSynthesis = {
    speak(utterance) {
      spokenText.push(utterance.text);
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  return {
    spokenText,
    restore() {
      if (hadSynth)
        Object.defineProperty(globalThis, 'speechSynthesis', hadSynth);
      else delete globalThis.speechSynthesis;
      if (hadUtterance) {
        Object.defineProperty(
          globalThis,
          'SpeechSynthesisUtterance',
          hadUtterance,
        );
      } else {
        delete globalThis.SpeechSynthesisUtterance;
      }
    },
  };
}

function withConfirm(answer) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'confirm');
  globalThis.confirm = answer;
  return () => {
    if (had) Object.defineProperty(globalThis, 'confirm', had);
    else delete globalThis.confirm;
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/* Any answered request repaints the box: a message's READ press is one. */
function pressRead(documentRef, panel) {
  let read = panel.children.find((child) => child.dataset?.ultraInboxRead);
  if (!read) {
    read = documentRef.createElement('button');
    read.dataset.ultraInboxRead = 'm-00000000000000bb';
    panel.appendChild(read);
  }
  panel.dispatch('click', { target: read });
}

test('read-aloud speaks only fresh unread messages and calls for help, once, through speechSynthesis', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const speech = installSpeech();
  const windowRef = fakeWindow();
  const old = message({
    id: 'm-00000000000000aa',
    at: NOW - 20 * 60_000,
    text: 'old plea',
  });
  const fresh = message({ id: 'm-00000000000000bb', text: 'fresh plea' });
  /* A fresh call for help is spoken; one older than ten minutes and one
   * already over at load are seeded silently, so a reload stays quiet. */
  const jeff = release();
  const ann = release({
    id: 'm-00000000000000e2',
    networkId: 'n-00000000000000a2',
    from: 'Ann',
    at: NOW - 20 * 60_000,
  });
  const bob = release({
    id: 'm-00000000000000e3',
    networkId: 'n-00000000000000a3',
    from: 'Bob',
    active: false,
    until: NOW - 60_000,
  });
  const status = {
    unread: 4,
    inbox: [jeff, fresh, old, ann, bob],
    tokens: [],
    packages: [],
    network: network(),
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/ultra-help/status') {
      return { ok: true, json: async () => status };
    }
    if (url === '/api/ultra-help/tokens') {
      return {
        ok: true,
        json: async () => ({
          ...status,
          revealed: {
            id: 't-1',
            label: 'Neighbour',
            token: TOKEN,
            address: '',
          },
        }),
      };
    }
    return { ok: true, json: async () => status };
  };
  const handle = initUltraHelpPanel({ documentRef, fetchImpl, windowRef });
  try {
    await settle();
    assert.deepEqual(speech.spokenText, [
      `Jeff needs help. ${PLEA}`,
      'Help message from Sam via Neighbour: fresh plea',
    ]);
    /* A received call for help outranks the unread count on the status line. */
    assert.equal(byId('ultra-status').textContent, 'NETWORK · JEFF NEEDS HELP');
    /* The two active calls with a position turn the map layer on, once. */
    assert.deepEqual(windowRef.dispatched, [
      { type: DEVICE_FEEDS_CHANGED_EVENT, detail: { count: 1 } },
    ]);

    /* A second poll with the same inbox says nothing new and nudges nothing. */
    calls.length = 0;
    pressRead(documentRef, panel);
    await settle();
    assert.deepEqual(calls[0], {
      url: '/api/ultra-help/inbox',
      body: { read: true, id: 'm-00000000000000bb' },
    });
    assert.equal(speech.spokenText.length, 2);
    assert.equal(windowRef.dispatched.length, 1);

    /* MAP: the layer is nudged on, then asked to fly to that pin. */
    const mapButton = byId('ultra-inbox').children[0].children.find(
      (child) => child.dataset.ultraNetworkMap,
    );
    assert.equal(mapButton.textContent, 'MAP');
    panel.dispatch('click', { target: mapButton });
    assert.deepEqual(windowRef.dispatched.slice(1), [
      { type: DEVICE_FEEDS_CHANGED_EVENT, detail: { count: 1 } },
      {
        type: DEVICE_FEEDS_FOCUS_EVENT,
        detail: { id: 'ultra-network:n-0123456789abcdef' },
      },
    ]);

    /* Jeff stands down: said once. Ann's older call is still running, so it
     * takes the status line; once she stands down too (said once, even
     * though her start was seeded silently) the unread count is back on top. */
    status.inbox[0] = release({ active: false, until: NOW, readAt: NOW });
    status.unread = 3;
    pressRead(documentRef, panel);
    await settle();
    assert.equal(speech.spokenText.at(-1), 'Jeff stood down');
    assert.equal(speech.spokenText.length, 3);
    pressRead(documentRef, panel);
    await settle();
    assert.equal(speech.spokenText.length, 3);
    assert.equal(byId('ultra-status').textContent, 'NETWORK · ANN NEEDS HELP');
    status.inbox[3] = { ...ann, active: false, until: NOW, readAt: NOW };
    pressRead(documentRef, panel);
    await settle();
    assert.equal(speech.spokenText.at(-1), 'Ann stood down');
    assert.equal(speech.spokenText.length, 4);
    pressRead(documentRef, panel);
    await settle();
    assert.equal(speech.spokenText.length, 4);
    assert.equal(byId('ultra-status').textContent, 'HELP · 3 NEW');

    /* SHARE posts a reveal, the answer paints the box, HIDE clears it and
     * the copy of `latest` handed to HIDE never carried the token. */
    const shareButton = documentRef.createElement('button');
    shareButton.dataset.ultraTokenShare = 't-1';
    panel.appendChild(shareButton);
    panel.dispatch('click', { target: shareButton });
    await settle();
    assert.deepEqual(calls.at(-1).body, { reveal: true, id: 't-1' });
    const box = byId('ultra-token-reveal');
    assert.equal(box.hidden, false);
    assert.match(byId('ultra-token-link').textContent, /^Neighbour:\n/);
    assert.ok(byId('ultra-token-link').textContent.includes(TOKEN));
    panel.dispatch('click', { target: byId('ultra-token-hide') });
    assert.equal(box.hidden, true);
    assert.equal(byId('ultra-token-link').textContent, '');
    assert.equal(box.dataset.ultraToken, undefined);

    /* Revoke asks first; a refused confirm posts nothing. */
    const revokeButton = documentRef.createElement('button');
    revokeButton.dataset.ultraTokenRevoke = 't-1';
    panel.appendChild(revokeButton);
    const restoreConfirm = withConfirm(() => false);
    try {
      calls.length = 0;
      panel.dispatch('click', { target: revokeButton });
      await settle();
      assert.equal(calls.length, 0);
      globalThis.confirm = () => true;
      panel.dispatch('click', { target: revokeButton });
      await settle();
      assert.deepEqual(calls[0].body, { revoke: true, id: 't-1' });
      /* RESET TOKENS names what it empties, the home list included. */
      const resetButton = documentRef.createElement('button');
      resetButton.dataset.ultraTokenReset = '1';
      panel.appendChild(resetButton);
      const questions = [];
      globalThis.confirm = (question) => {
        questions.push(question);
        return true;
      };
      calls.length = 0;
      panel.dispatch('click', { target: resetButton });
      await settle();
      assert.deepEqual(questions, [
        'Reset every help token? Every link stops working, the key file is deleted, and your home list is emptied (UPDATE HOME LIST brings the directory back).',
      ]);
      assert.deepEqual(calls[0].body, { reset: true, confirm: true });
    } finally {
      restoreConfirm();
    }

    /* The two forms post what the design names and clear on success; the
     * Network tick is always sent, on by default. */
    byId('ultra-token-label').value = 'Courier';
    calls.length = 0;
    panel.dispatch('submit', { target: byId('ultra-token') });
    await settle();
    assert.deepEqual(calls[0].body, {
      label: 'Courier',
      network: true,
      encrypt: false,
      skills: [],
      custom: [],
    });
    assert.equal(byId('ultra-token-label').value, '');
    byId('ultra-token-label').value = 'Cousin';
    byId('ultra-token-network').checked = false;
    calls.length = 0;
    panel.dispatch('submit', { target: byId('ultra-token') });
    await settle();
    assert.equal(calls[0].body.network, false);
    byId('ultra-number-input').value = '+15065550100';
    calls.length = 0;
    panel.dispatch('submit', { target: byId('ultra-number') });
    await settle();
    assert.deepEqual(calls[0], {
      url: '/api/ultra-help/number',
      body: { number: '+15065550100' },
    });
    /* An empty SAVE MY # is not a CLEAR: nothing is posted. */
    byId('ultra-number-input').value = '   ';
    calls.length = 0;
    panel.dispatch('submit', { target: byId('ultra-number') });
    await settle();
    assert.equal(calls.length, 0);
  } finally {
    handle.destroy();
    speech.restore();
  }
});

test('a new call for help is spoken with its street address once the geocode lands', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const speech = installSpeech();
  const windowRef = fakeWindow();
  /* What the row reads while the server is still looking up the street. */
  const coords = '45.2744, -66.0622';
  const coordsPlea = `Please HELP you are close by, to ${coords} of victim in progress, fire thank you.`;
  /* Fresh ids: what was spoken is remembered for the whole page load. */
  const looking = (overrides) =>
    release({
      id: 'm-00000000000000f1',
      placing: true,
      place: coords,
      text: coordsPlea,
      ...overrides,
    });
  const status = {
    unread: 1,
    inbox: [looking()],
    tokens: [],
    packages: [],
    network: network(),
  };
  const fetchImpl = async () => ({ ok: true, json: async () => status });
  const repaint = async () => {
    pressRead(documentRef, panel);
    await settle();
  };
  const said = (who) =>
    speech.spokenText.filter((line) => line.startsWith(`${who} needs help`));
  const realNow = Date.now;
  const handle = initUltraHelpPanel({ documentRef, fetchImpl, windowRef });
  try {
    await settle();
    /* The row, the status line and the pin do not wait; only the voice does. */
    assert.deepEqual(said('Jeff'), []);
    assert.equal(byId('ultra-status').textContent, 'NETWORK · JEFF NEEDS HELP');
    assert.equal(windowRef.dispatched.length, 1);
    await repaint();
    assert.deepEqual(said('Jeff'), []);
    /* The address lands: said once, with the street. */
    status.inbox[0] = release({ id: 'm-00000000000000f1', placing: false });
    await repaint();
    assert.deepEqual(said('Jeff'), [`Jeff needs help. ${PLEA}`]);
    await repaint();
    assert.equal(said('Jeff').length, 1);
    /* A lookup that never lands holds the voice six seconds at most, then
     * the coordinates are said, once. */
    status.inbox.unshift(
      looking({
        id: 'm-00000000000000f2',
        networkId: 'n-00000000000000f2',
        from: 'Kim',
      }),
    );
    await repaint();
    assert.deepEqual(said('Kim'), []);
    Date.now = () => realNow() + 5_000;
    await repaint();
    assert.deepEqual(said('Kim'), []);
    Date.now = () => realNow() + 6_500;
    await repaint();
    assert.deepEqual(said('Kim'), [`Kim needs help. ${coordsPlea}`]);
    await repaint();
    assert.equal(said('Kim').length, 1);
  } finally {
    Date.now = realNow;
    handle.destroy();
    speech.restore();
  }
});

test('SEND HELP, the home list and SAVE DIRECTORY post what the design names', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const windowRef = fakeWindow();
  let status = {
    unread: 0,
    inbox: [],
    tokens: [token({ network: true })],
    packages: [],
    position: { lat: 45.27, lon: -66.06 },
    contacts: [],
    network: network({
      entries: [entry()],
      relay: {
        provider: 'twilio',
        configured: true,
        host: 'api.twilio.com',
        lastTestAt: null,
        lastOutcome: '',
        sentToday: 0,
      },
    }),
    ownerNumber: '+15065550100',
  };
  let keysAnswer = { ok: true, json: async () => ({ ok: true }) };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/setup/keys') return keysAnswer;
    if (url === '/api/ultra-help/network' && calls.at(-1).body?.publish) {
      return {
        ok: true,
        json: async () => ({
          ...status,
          published: {
            how: 'clipboard',
            entry: {
              name: 'Jeff',
              address: 'https://van.tail9.ts.net',
              token: TOKEN,
            },
            entryText: '{\n  "name": "Jeff"\n}',
            mailto: 'mailto:?subject=x&body=y',
            directory: '',
            at: NOW,
            error: '',
          },
        }),
      };
    }
    return { ok: true, json: async () => status };
  };
  const handle = initUltraHelpPanel({ documentRef, fetchImpl, windowRef });
  try {
    await settle();
    /* SEND HELP asks first and carries the FIND HELP incident. STAND DOWN
     * sits beside it with no call on. */
    byId('ultra-incident').value = 'fire';
    assert.equal(byId('ultra-release-send').textContent, 'SEND HELP');
    assert.equal(byId('ultra-release-stand-down').hidden, false);
    const restoreConfirm = withConfirm(() => false);
    try {
      calls.length = 0;
      panel.dispatch('click', { target: byId('ultra-release-send') });
      await settle();
      assert.equal(calls.length, 0);
      globalThis.confirm = () => true;
      panel.dispatch('click', { target: byId('ultra-release-send') });
      await settle();
      assert.deepEqual(calls[0], {
        url: '/api/ultra-help/release',
        body: { incident: 'fire' },
      });
      /* With a release running the button renews and STAND DOWN stays; it
       * posts without any confirm (the stub would refuse it). */
      status = {
        ...status,
        release: {
          at: NOW,
          until: NOW + 4 * 3_600_000,
          lat: 45.27,
          lon: -66.06,
          fixAt: NOW,
          feedId: 'security-van',
          incident: 'fire',
          holders: 1,
          watching: 1,
          plea: PLEA,
          sms: { outcome: 'SMS SENT 22:15', sent: 1, failed: 0 },
        },
      };
      globalThis.confirm = () => false;
      pressRead(documentRef, panel);
      await settle();
      assert.equal(byId('ultra-release-send').textContent, 'EXTEND HELP');
      assert.equal(byId('ultra-release-stand-down').hidden, false);
      calls.length = 0;
      panel.dispatch('click', { target: byId('ultra-release-stand-down') });
      await settle();
      assert.deepEqual(calls[0], {
        url: '/api/ultra-help/release',
        body: { standDown: true },
      });
      status = { ...status, release: null };
    } finally {
      restoreConfirm();
    }

    /* NETWORK ON/OFF flips the token's flag like SMS and VOICE do. */
    const networkButton = byId('ultra-tokens').children[0].children.find(
      (child) => child.dataset.ultraField === 'network',
    );
    assert.equal(networkButton.textContent, 'NETWORK OFF');
    calls.length = 0;
    panel.dispatch('click', { target: networkButton });
    await settle();
    assert.deepEqual(calls[0], {
      url: '/api/ultra-help/tokens',
      body: { edit: true, id: token().id, network: false },
    });

    /* The three plain buttons and TEST SMS post their flags. */
    for (const [id, body] of [
      ['ultra-network-update', { update: true }],
      ['ultra-network-poll', { poll: true }],
      ['ultra-sms-test', { testSms: true }],
    ]) {
      calls.length = 0;
      panel.dispatch('click', { target: byId(id) });
      await settle();
      assert.deepEqual(calls[0], { url: '/api/ultra-help/network', body });
    }

    /* PUBLISH: the chosen token when one is picked, else the directory one;
     * the answer's `published` paints the entry box for the clipboard path
     * with EMAIL ENTRY, the next poll leaves it alone, HIDE clears it. */
    calls.length = 0;
    panel.dispatch('click', { target: byId('ultra-network-publish') });
    await settle();
    assert.deepEqual(calls[0].body, { publish: true });
    const entryBox = byId('ultra-network-entry');
    assert.equal(entryBox.hidden, false);
    assert.equal(
      byId('ultra-network-entry-text').textContent,
      'COPY THIS ENTRY:\n{\n  "name": "Jeff"\n}',
    );
    assert.equal(entryBox.dataset.ultraEntry, '{\n  "name": "Jeff"\n}');
    assert.equal(byId('ultra-network-entry-mail').hidden, false);
    assert.equal(
      byId('ultra-network-entry-mail').href,
      'mailto:?subject=x&body=y',
    );
    assert.equal(
      byId('ultra-network-entry-note').textContent,
      'Send this to whoever keeps the directory, or paste it into the file yourself. Anyone who can read the directory sees where your phone is and threat type while you have pressed SEND HELP and have Network On.',
    );
    pressRead(documentRef, panel);
    await settle();
    assert.equal(entryBox.hidden, false, 'the poll cannot wipe the entry');
    panel.dispatch('click', { target: byId('ultra-network-entry-hide') });
    assert.equal(entryBox.hidden, true);
    assert.equal(byId('ultra-network-entry-text').textContent, '');
    assert.equal(entryBox.dataset.ultraEntry, undefined);
    assert.equal(byId('ultra-network-entry-mail').hidden, true);
    byId('ultra-publish-token').value = token().id;
    calls.length = 0;
    panel.dispatch('click', { target: byId('ultra-network-publish') });
    await settle();
    assert.deepEqual(calls[0].body, { publish: true, id: token().id });

    /* SAVE MY NAME and ADD TO HOME LIST post and clear on success. */
    byId('ultra-network-me-name').value = '  Jeff ';
    calls.length = 0;
    panel.dispatch('submit', { target: byId('ultra-network-me') });
    await settle();
    assert.deepEqual(calls[0], {
      url: '/api/ultra-help/network',
      body: { me: true, name: 'Jeff' },
    });
    assert.equal(byId('ultra-network-me-name').value, '');
    const address = 'https://peer.tail9.ts.net';
    byId('ultra-network-address').value = ` ${address} `;
    byId('ultra-network-token').value = ` ${TOKEN} `;
    byId('ultra-network-link-name').value = 'Sam';
    calls.length = 0;
    panel.dispatch('submit', { target: byId('ultra-network-add') });
    await settle();
    assert.deepEqual(calls[0], {
      url: '/api/ultra-help/network',
      body: { add: true, address, token: TOKEN, name: 'Sam' },
    });
    assert.equal(byId('ultra-network-address').value, '');
    assert.equal(byId('ultra-network-token').value, '');
    assert.equal(byId('ultra-network-link-name').value, '');

    /* RENAME borrows the add form: the name box fills, the button reads
     * RENAME, the submit posts a rename and the form goes back to ADD. */
    const row = byId('ultra-network-list').children[0];
    const renameButton = row.children.find(
      (child) => child.dataset.ultraNetworkRename,
    );
    assert.equal(renameButton.textContent, 'RENAME');
    panel.dispatch('click', { target: renameButton });
    assert.equal(byId('ultra-network-link-name').value, 'Sam');
    assert.equal(byId('ultra-network-add').dataset.ultraRenaming, entry().id);
    assert.equal(byId('ultra-network-add-submit').textContent, 'RENAME');
    byId('ultra-network-link-name').value = 'Sammy';
    calls.length = 0;
    panel.dispatch('submit', { target: byId('ultra-network-add') });
    await settle();
    assert.deepEqual(calls[0].body, {
      rename: true,
      id: entry().id,
      name: 'Sammy',
    });
    assert.equal(byId('ultra-network-add').dataset.ultraRenaming, undefined);
    assert.equal(
      byId('ultra-network-add-submit').textContent,
      'ADD TO HOME LIST',
    );

    /* REMOVE asks first. */
    const removeButton = byId('ultra-network-list').children[0].children.find(
      (child) => child.dataset.ultraNetworkRemove,
    );
    const restoreRemove = withConfirm(() => false);
    try {
      calls.length = 0;
      panel.dispatch('click', { target: removeButton });
      await settle();
      assert.equal(calls.length, 0);
      globalThis.confirm = () => true;
      panel.dispatch('click', { target: removeButton });
      await settle();
      assert.deepEqual(calls[0].body, { remove: true, id: entry().id });
    } finally {
      restoreRemove();
    }

    /* SAVE DIRECTORY goes to the key-setup route with only the filled
     * names; the token field is emptied at once, whatever comes back. */
    calls.length = 0;
    panel.dispatch('submit', { target: byId('ultra-directory') });
    await settle();
    assert.equal(calls.length, 0, 'a blank submit posts nothing');
    byId('ultra-directory-url').value =
      ' https://raw.githubusercontent.com/g/r/main/ultra-directory.json ';
    byId('ultra-directory-token').value = 'github_pat_secret';
    panel.dispatch('submit', { target: byId('ultra-directory') });
    assert.equal(byId('ultra-directory-token').value, '');
    await settle();
    assert.deepEqual(calls[0], {
      url: '/api/setup/keys',
      body: {
        ULTRA_DIRECTORY_URL:
          'https://raw.githubusercontent.com/g/r/main/ultra-directory.json',
        ULTRA_DIRECTORY_WRITE_TOKEN: 'github_pat_secret',
      },
    });
    assert.equal(
      byId('ultra-status').textContent,
      'Saved to your local .env. Restarting — this page reloads itself.',
    );
    assert.equal(byId('ultra-directory-url').value, '');
    keysAnswer = {
      ok: false,
      json: async () => ({ ok: false, error: 'Refused: bad address' }),
    };
    byId('ultra-directory-url').value = 'https://example.test/dir.json';
    calls.length = 0;
    panel.dispatch('submit', { target: byId('ultra-directory') });
    await settle();
    assert.deepEqual(calls[0].body, {
      ULTRA_DIRECTORY_URL: 'https://example.test/dir.json',
    });
    assert.equal(byId('ultra-status').textContent, 'Refused: bad address');
  } finally {
    handle.destroy();
  }
});

test('the reveal box is touched only when the status carries `revealed`', () => {
  const { documentRef, byId } = installFakeDocument();
  const box = byId('ultra-token-reveal');
  const pre = byId('ultra-token-link');
  pre.textContent = 'keep me';
  box.hidden = false;

  applyUltraHelpStatus(documentRef, { unread: 0, inbox: [], tokens: [] });
  assert.equal(box.hidden, false);
  assert.equal(pre.textContent, 'keep me');
  applyUltraHelpStatus(documentRef, null);
  assert.equal(pre.textContent, 'keep me');

  applyUltraHelpStatus(documentRef, {
    revealed: {
      id: 't-1',
      label: 'Neighbour',
      token: TOKEN,
      address: 'https://van.tail9.ts.net',
    },
  });
  assert.equal(box.hidden, false);
  assert.equal(
    pre.textContent,
    `Neighbour:\nTailnet address: https://van.tail9.ts.net\nUltra Token: ${TOKEN}`,
  );
  assert.equal(box.dataset.ultraToken, TOKEN);
  assert.equal(box.dataset.ultraAddress, 'https://van.tail9.ts.net');
  assert.equal(box.dataset.ultraLink, undefined);
  /* The token is never written into a URL, not even in the reveal. */
  assert.doesNotMatch(pre.textContent, /\/ultra\/help\//);

  applyUltraHelpStatus(documentRef, {
    revealed: { id: 't-1', label: 'Neighbour', token: TOKEN, address: '' },
  });
  assert.match(pre.textContent, /^Neighbour:\nUltra Token: /);
  assert.doesNotMatch(pre.textContent, /Tailnet address:/);
  assert.match(pre.textContent, /listener is not up/);
  assert.match(pre.textContent, /handed over with your tailnet address/);
  assert.equal(box.dataset.ultraAddress, undefined);

  applyUltraHelpStatus(documentRef, { revealed: null });
  assert.equal(box.hidden, true);
  assert.equal(pre.textContent, '');
  assert.equal(box.dataset.ultraToken, undefined);
  assert.equal(box.dataset.ultraAddress, undefined);
});

test('the published entry follows the same contract: only `published` paints it', () => {
  const { documentRef, byId } = installFakeDocument();
  const box = byId('ultra-network-entry');
  const pre = byId('ultra-network-entry-text');
  const mail = byId('ultra-network-entry-mail');
  pre.textContent = 'keep me';
  box.hidden = false;

  applyUltraHelpStatus(documentRef, { unread: 0, inbox: [], tokens: [] });
  assert.equal(box.hidden, false);
  assert.equal(pre.textContent, 'keep me');
  applyUltraHelpStatus(documentRef, null);
  assert.equal(pre.textContent, 'keep me');

  const entryText =
    '{\n  "name": "Jeff",\n  "address": "https://x.ts.net",\n  "token": "uht1.x"\n}';
  applyUltraHelpStatus(documentRef, {
    published: {
      how: 'github',
      entry: { name: 'Jeff', address: 'https://x.ts.net', token: 'uht1.x' },
      entryText,
      mailto: 'mailto:?subject=x&body=y',
      directory:
        'https://raw.githubusercontent.com/g/r/main/ultra-directory.json',
      at: NOW,
      error: '',
    },
  });
  assert.equal(box.hidden, false);
  assert.equal(
    pre.textContent,
    `PUBLISHED to https://raw.githubusercontent.com/g/r/main/ultra-directory.json:\n${entryText}`,
  );
  assert.equal(box.dataset.ultraEntry, entryText);
  assert.equal(mail.hidden, true, 'EMAIL ENTRY is for the clipboard path');
  assert.match(
    byId('ultra-network-entry-note').textContent,
    /^Written to the directory/,
  );

  applyUltraHelpStatus(documentRef, {
    published: {
      how: 'clipboard',
      entryText,
      mailto: 'mailto:?subject=x&body=y',
      directory: '',
      at: NOW,
      error:
        'GitHub refused the write token (401): it needs Contents read and write on that repository',
    },
  });
  assert.equal(
    pre.textContent,
    `COPY THIS ENTRY:\n${entryText}\nNot written to GitHub: GitHub refused the write token (401): it needs Contents read and write on that repository`,
  );
  assert.equal(mail.hidden, false);
  assert.equal(mail.href, 'mailto:?subject=x&body=y');
  /* Only a real mailto: from the loopback answer is ever set as the href. */
  applyUltraHelpStatus(documentRef, {
    published: {
      how: 'clipboard',
      entryText,
      mailto: 'javascript:alert(1)',
      at: NOW,
    },
  });
  assert.equal(mail.hidden, true);
  assert.equal(mail.href, '');

  applyUltraHelpStatus(documentRef, { published: null });
  assert.equal(box.hidden, true);
  assert.equal(pre.textContent, '');
  assert.equal(box.dataset.ultraEntry, undefined);
  assert.equal(mail.hidden, true);
});

test('the SEND HELP block says who receives it, needs a position, and reports a running release', () => {
  const { documentRef, byId } = installFakeDocument();
  const note = byId('ultra-release-note');
  const state = byId('ultra-release-state');

  /* No token with NETWORK on: nobody receives a release. */
  applyUltraHelpStatus(documentRef, {
    tokens: [token(), token({ id: 't-2', network: true, revokedAt: NOW })],
    position: { lat: 45.27, lon: -66.06 },
    contacts: [
      { id: 'c-1', label: 'Mo', number: '+15065550100', kind: 'other' },
    ],
    inbox: [],
  });
  assert.match(
    note.textContent,
    /^Nobody receives this yet: tick Network on GENERATE NEW TOKEN/,
  );
  assert.equal(state.textContent, '');
  assert.equal(byId('ultra-release-send').textContent, 'SEND HELP');
  assert.equal(byId('ultra-release-stand-down').hidden, false);
  assert.equal(byId('ultra-release-plea').hidden, true);

  /* Holders but no fix yet. */
  applyUltraHelpStatus(documentRef, {
    tokens: [token({ network: true })],
    position: null,
    inbox: [],
  });
  assert.equal(
    note.textContent,
    'Needs your position: open the phone link on the phone, or press SEND HELP there.',
  );

  /* Idle with two holders, one watching, and the chosen incident. */
  byId('ultra-incident').value = 'medical';
  applyUltraHelpStatus(documentRef, {
    tokens: [
      token({ network: true, watchedAt: NOW - 5_000 }),
      token({ id: 't-2', network: true, watchedAt: NOW - 3_600_000 }),
      token({ id: 't-3', network: true, orphaned: true, watchedAt: NOW }),
    ],
    position: { lat: 45.27, lon: -66.06 },
    contacts: [{ id: 'c-1' }, { id: 'c-2' }],
    inbox: [],
  });
  assert.equal(
    note.textContent,
    "Sends your phone's position, the incident classification and any items or skills needed to encrypted Ultra Token holders for four hours, or until STAND DOWN, and hands your phone one tap that texts the Help to 2 saved helpers. 1 watching now.",
  );

  /* A running release: EXTEND HELP, STAND DOWN, the state, the plea and the
   * SMS outcome, and the status line on top of everything else. */
  const until = NOW + 4 * 3_600_000;
  applyUltraHelpStatus(documentRef, {
    unread: 3,
    tokens: [token({ network: true })],
    position: { lat: 45.27, lon: -66.06 },
    inbox: [release()],
    pending: { kind: 'camera', label: 'REAR' },
    release: {
      at: NOW,
      until,
      lat: 45.27,
      lon: -66.06,
      fixAt: NOW,
      feedId: 'security-van',
      incident: 'fire',
      holders: 1,
      watching: 2,
      plea: PLEA,
      sms: { outcome: 'SMS SENT 22:15', sent: 1, failed: 0 },
    },
  });
  assert.equal(state.textContent, `· ON UNTIL ${clock(until)}`);
  assert.ok(state.classList.contains('ultra-release-on'));
  assert.equal(byId('ultra-release-send').textContent, 'EXTEND HELP');
  assert.equal(byId('ultra-release-stand-down').hidden, false);
  assert.equal(
    note.textContent,
    `HELP SENT ${clock(NOW)} · 1 holder · 2 watching · until ${clock(until)} · EXTEND HELP renews four hours · SMS SENT 22:15`,
  );
  assert.equal(byId('ultra-release-plea').hidden, false);
  assert.equal(byId('ultra-release-plea').textContent, `Plea: ${PLEA}`);
  assert.equal(
    byId('ultra-status').textContent,
    `HELP SENT · UNTIL ${clock(until)} · 2 WATCHING`,
  );

  /* Standing down puts the received call, then the unread count, back on top. */
  applyUltraHelpStatus(documentRef, {
    unread: 3,
    tokens: [],
    inbox: [release()],
    pending: { kind: 'camera', label: 'REAR' },
    release: null,
  });
  assert.equal(state.textContent, '');
  assert.equal(state.classList.contains('ultra-release-on'), false);
  assert.equal(byId('ultra-release-plea').hidden, true);
  assert.equal(byId('ultra-status').textContent, 'NETWORK · JEFF NEEDS HELP');
  applyUltraHelpStatus(documentRef, {
    unread: 2,
    inbox: [release({ active: false })],
    pending: { kind: 'camera', label: 'REAR' },
  });
  assert.equal(byId('ultra-status').textContent, 'HELP · 2 NEW');
});

test('with two packages the SEND HELP block shows and acts on the chosen package only', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const windowRef = fakeWindow();
  const until = NOW + 4 * 3_600_000;
  const running = (feedId, name, incident, renewedAt) => ({
    at: renewedAt,
    until,
    renewedAt,
    lat: 45.27,
    lon: -66.06,
    fixAt: renewedAt,
    feedId,
    name,
    incident,
    holders: 1,
    watching: 1,
    plea: `${name} plea`,
    sms: { outcome: 'SMS SENT 22:15', sent: 1, failed: 0 },
  });
  const van = running('security-van', 'Van 7', 'threat', NOW - 60_000);
  let status = {
    unread: 0,
    inbox: [],
    tokens: [
      token({ network: true, feedId: 'security-van' }),
      token({ id: 't-home', network: true, feedId: 'security-home' }),
    ],
    packages: [
      { id: 'security-van', name: 'Van 7' },
      { id: 'security-home', name: 'Home' },
    ],
    position: { lat: 45.27, lon: -66.06 },
    contacts: [],
    network: network(),
    release: van,
    releases: [van],
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => status };
  };
  const handle = initUltraHelpPanel({ documentRef, fetchImpl, windowRef });
  const restoreConfirm = withConfirm(() => true);
  try {
    await settle();
    const select = byId('ultra-release-package');
    /* It opens on the call that is running, marked, and shows that call. */
    assert.equal(select.hidden, false);
    assert.deepEqual(
      select.children.map((option) => [option.value, option.textContent]),
      [
        ['security-van', 'Van 7 · HELP ON'],
        ['security-home', 'Home'],
      ],
    );
    assert.equal(select.value, 'security-van');
    assert.equal(byId('ultra-release-send').textContent, 'EXTEND HELP');
    assert.equal(byId('ultra-release-plea').textContent, 'Plea: Van 7 plea');
    /* Choosing Home shows Home's own state: nothing sent, Van 7 still asking. */
    select.value = 'security-home';
    panel.dispatch('change', { target: select });
    assert.equal(byId('ultra-release-send').textContent, 'SEND HELP');
    assert.equal(byId('ultra-release-stand-down').hidden, false);
    assert.equal(
      byId('ultra-release-note').textContent,
      'Nothing sent for this package · ALSO ASKING FOR HELP: Van 7',
    );
    /* SEND HELP names Home; the poll keeps the choice. */
    calls.length = 0;
    byId('ultra-incident').value = 'fire';
    panel.dispatch('click', { target: byId('ultra-release-send') });
    await settle();
    assert.deepEqual(calls[0], {
      url: '/api/ultra-help/release',
      body: { incident: 'fire', feedId: 'security-home' },
    });
    const home = running('security-home', 'Home', 'fire', NOW);
    status = { ...status, release: home, releases: [van, home] };
    /* What the next poll paints; the newest press is Home's either way. */
    applyUltraHelpStatus(documentRef, status);
    assert.equal(select.value, 'security-home');
    assert.equal(byId('ultra-release-send').textContent, 'EXTEND HELP');
    assert.match(
      byId('ultra-release-note').textContent,
      / · ALSO ASKING FOR HELP: Van 7$/,
    );
    /* STAND DOWN names Home too, and nothing else. Van 7 is still asking,
     * so the status line stays on that call. */
    calls.length = 0;
    status = { ...status, release: van, releases: [van] };
    panel.dispatch('click', { target: byId('ultra-release-stand-down') });
    await settle();
    assert.deepEqual(calls[0], {
      url: '/api/ultra-help/release',
      body: { standDown: true, feedId: 'security-home' },
    });
    assert.equal(
      byId('ultra-status').textContent,
      `HELP SENT · UNTIL ${clock(until)} · 1 WATCHING`,
    );
    assert.equal(
      byId('ultra-release-note').textContent,
      'Nothing sent for this package · ALSO ASKING FOR HELP: Van 7',
    );
    /* Watching before a press is the chosen package's alone. Van is watching;
     * Home, the package on screen, is not. */
    status = {
      ...status,
      release: null,
      releases: [],
      tokens: [
        token({
          network: true,
          feedId: 'security-van',
          watchedAt: NOW - 5_000,
        }),
        token({ id: 't-home', network: true, feedId: 'security-home' }),
      ],
    };
    applyUltraHelpStatus(documentRef, status);
    assert.equal(
      byId('ultra-release-note').textContent,
      "Sends your phone's position, the incident classification and any items or skills needed to encrypted Ultra Token holders for four hours, or until STAND DOWN, and hands your phone one tap that texts the Help to 0 saved helpers. 0 watching now.",
    );
  } finally {
    restoreConfirm();
    handle.destroy();
  }
});

test('STAND DOWN sits beside SEND HELP with no call on, and an answer with none running says so', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  let status = {
    unread: 0,
    inbox: [],
    tokens: [token({ network: true })],
    packages: [{ id: 'security-van', name: 'Van 7' }],
    position: { lat: 45.27, lon: -66.06 },
    contacts: [],
    network: network(),
    release: null,
    releases: [],
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => status };
  };
  const handle = initUltraHelpPanel({
    documentRef,
    fetchImpl,
    windowRef: fakeWindow(),
  });
  /* The stub refuses every confirm: STAND DOWN never asks one. */
  const restoreConfirm = withConfirm(() => false);
  try {
    await settle();
    const standDown = byId('ultra-release-stand-down');
    assert.equal(standDown.hidden, false);
    assert.equal(
      standDown.parentElement,
      byId('ultra-release-send').parentElement,
    );
    calls.length = 0;
    panel.dispatch('click', { target: standDown });
    await settle();
    assert.deepEqual(calls, [
      { url: '/api/ultra-help/release', body: { standDown: true } },
    ]);
    assert.equal(
      byId('ultra-status').textContent,
      'STOOD DOWN · NO CALL FOR HELP IS ON',
    );
    assert.equal(byId('ultra-release-send').textContent, 'SEND HELP');
    /* An answer that still shows a call never says none is on. */
    const until = NOW + 4 * 3_600_000;
    status = {
      ...status,
      release: {
        at: NOW,
        until,
        feedId: 'security-van',
        incident: 'threat',
        holders: 1,
        watching: 0,
      },
    };
    panel.dispatch('click', { target: standDown });
    await settle();
    assert.equal(
      byId('ultra-status').textContent,
      `HELP SENT · UNTIL ${clock(until)} · 0 WATCHING`,
    );
  } finally {
    restoreConfirm();
    handle.destroy();
  }
});

test('the package choice follows a new call until the owner picks, offers a removed package for STAND DOWN, and EXTEND keeps the incident', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const windowRef = fakeWindow();
  const until = NOW + 4 * 3_600_000;
  const call = (feedId, name, incident, over = {}) => ({
    at: NOW,
    until,
    renewedAt: NOW,
    lat: 45.27,
    lon: -66.06,
    fixAt: NOW,
    feedId,
    name,
    incident,
    holders: 0,
    watching: 0,
    plea: '',
    sms: { outcome: 'SENDING', sent: 0, failed: 0 },
    ...over,
  });
  const packages = [
    { id: 'security-van', name: 'Van 7' },
    { id: 'security-home', name: 'Home' },
  ];
  let status = {
    unread: 0,
    inbox: [],
    tokens: [],
    packages,
    position: { lat: 45.27, lon: -66.06 },
    contacts: [],
    network: network(),
    release: null,
    releases: [],
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => status };
  };
  const handle = initUltraHelpPanel({ documentRef, fetchImpl, windowRef });
  const restoreConfirm = withConfirm(() => true);
  /* What the next poll paints: any answered request repaints the box. */
  const repaint = async () => {
    pressRead(documentRef, panel);
    await settle();
  };
  try {
    await settle();
    const select = byId('ultra-release-package');
    assert.equal(select.value, 'security-van', 'nothing running: the first');
    /* Home's phone presses SEND HELP (MEDICAL): the box follows it. */
    const home = call('security-home', 'Home', 'medical');
    status = { ...status, release: home, releases: [home] };
    await repaint();
    assert.equal(select.value, 'security-home');
    assert.equal(byId('ultra-release-send').textContent, 'EXTEND HELP');
    assert.equal(byId('ultra-release-stand-down').hidden, false);
    /* EXTEND from the box renews Home's MEDICAL call, whatever FIND HELP shows. */
    byId('ultra-incident').value = 'threat';
    calls.length = 0;
    panel.dispatch('click', { target: byId('ultra-release-send') });
    await settle();
    assert.deepEqual(calls[0].body, {
      incident: 'medical',
      feedId: 'security-home',
    });
    /* Once the owner picks a package, a newer call elsewhere does not move it. */
    select.value = 'security-van';
    panel.dispatch('change', { target: select });
    const van = call('security-van-2', 'Van 8', 'fire', { renewedAt: NOW + 5 });
    status = {
      ...status,
      packages: [...packages, { id: 'security-van-2', name: 'Van 8' }],
      release: van,
      releases: [home, van],
    };
    await repaint();
    assert.equal(select.value, 'security-van');
    /* A call whose package the store does not show is offered, to stand down only. */
    const ghost = call('security-gone', 'security-gone', 'threat', {
      removed: true,
    });
    status = { ...status, releases: [home, van, ghost] };
    await repaint();
    const labels = select.children.map((option) => option.textContent);
    assert.ok(labels.includes('security-gone · REMOVED · HELP ON'), labels);
    select.value = 'security-gone';
    panel.dispatch('change', { target: select });
    assert.equal(byId('ultra-release-send').hidden, true);
    assert.equal(byId('ultra-release-stand-down').hidden, false);
    calls.length = 0;
    panel.dispatch('click', { target: byId('ultra-release-stand-down') });
    await settle();
    assert.deepEqual(calls[0].body, {
      standDown: true,
      feedId: 'security-gone',
    });
  } finally {
    restoreConfirm();
    handle.destroy();
  }
});

test('PUBLISH with two packages names one for a new DIRECTORY TOKEN; a hand-added row the directory disagrees with says so', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const windowRef = fakeWindow();
  const status = {
    unread: 0,
    inbox: [],
    tokens: [],
    packages: [
      { id: 'security-van', name: 'Van 7' },
      { id: 'security-home', name: 'Home' },
    ],
    network: network({
      entries: [entry({ directoryDiffers: true, lastState: 'quiet' })],
    }),
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => status };
  };
  const handle = initUltraHelpPanel({ documentRef, fetchImpl, windowRef });
  try {
    await settle();
    const pick = byId('ultra-publish-package');
    assert.equal(pick.hidden, false);
    assert.deepEqual(
      pick.children.map((option) => [option.value, option.textContent]),
      [
        ['security-van', 'FOR Van 7'],
        ['security-home', 'FOR Home'],
      ],
    );
    pick.value = 'security-home';
    calls.length = 0;
    panel.dispatch('click', { target: byId('ultra-network-publish') });
    await settle();
    assert.deepEqual(calls[0], {
      url: '/api/ultra-help/network',
      body: { publish: true, feedId: 'security-home' },
    });
    assert.match(
      byId('ultra-network-list').children[0].children[0].textContent,
      / · DIRECTORY LISTS ANOTHER HOST/,
    );
  } finally {
    handle.destroy();
  }
});

test('GENERATE NEW TOKEN says GENERATING… while the token is made, then GENERATED, then goes back', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const windowRef = fakeWindow();
  const status = {
    unread: 0,
    inbox: [],
    tokens: [],
    packages: [],
    network: network(),
  };
  let release = null;
  let refuse = false;
  const posts = [];
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/ultra-help/tokens') {
      posts.push(JSON.parse(options.body));
      /* The mint waits until the test lets it answer. */
      await new Promise((resolve) => {
        release = resolve;
      });
      if (refuse)
        return {
          ok: false,
          json: async () => ({
            error: 'No Ultra Security Package is saved yet',
          }),
        };
    }
    return { ok: true, json: async () => status };
  };
  const handle = initUltraHelpPanel({ documentRef, fetchImpl, windowRef });
  try {
    await settle();
    const button = byId('ultra-token-submit');
    assert.equal(button.textContent, 'GENERATE NEW TOKEN');
    byId('ultra-token-label').value = 'Neighbour';
    panel.dispatch('submit', { target: byId('ultra-token') });
    await settle();
    assert.deepEqual(
      [button.textContent, button.disabled],
      ['GENERATING…', true],
    );
    /* A second press while it is being made is not a second token. */
    panel.dispatch('submit', { target: byId('ultra-token') });
    await settle();
    assert.equal(posts.length, 1);
    release();
    await settle();
    /* Made: it says so, and the next token can be asked for at once. */
    assert.deepEqual(
      [button.textContent, button.disabled],
      ['GENERATED', false],
    );
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    assert.deepEqual(
      [button.textContent, button.disabled],
      ['GENERATE NEW TOKEN', false],
    );
    /* A refusal puts it back at once; the reason is on the status line. */
    refuse = true;
    panel.dispatch('submit', { target: byId('ultra-token') });
    await settle();
    assert.equal(button.textContent, 'GENERATING…');
    release();
    await settle();
    assert.deepEqual(
      [button.textContent, button.disabled],
      ['GENERATE NEW TOKEN', false],
    );
    assert.equal(
      byId('ultra-status').textContent,
      'No Ultra Security Package is saved yet',
    );
  } finally {
    handle.destroy();
  }
});

test('with one package the SEND HELP block is as before: no choice, no package named', () => {
  const { documentRef, byId } = installFakeDocument();
  applyUltraHelpStatus(documentRef, {
    tokens: [token({ network: true })],
    packages: [{ id: 'security-van', name: 'Van 7' }],
    position: { lat: 45.27, lon: -66.06 },
    inbox: [],
    releases: [],
  });
  assert.equal(byId('ultra-release-package').hidden, true);
  assert.equal(byId('ultra-release-send').textContent, 'SEND HELP');
});

test('a received call for help is one text row, the plea under it, OPEN IN SMS with no recipient, MAP while it runs', () => {
  const { documentRef, byId } = installFakeDocument();
  const hostile = release({
    id: 'm-00000000000000e9',
    networkId: 'n-00000000000000e9',
    from: 'Ann',
    text: '<b>x</b>',
    place: '',
    lat: 45.3,
    lon: -66.1,
    distanceKm: 12.4,
    sms: '',
    readAt: NOW,
    active: false,
    until: NOW - 60_000,
  });
  applyUltraHelpStatus(documentRef, {
    unread: 1,
    inbox: [
      release(),
      hostile,
      release({ id: 'm-e10', networkId: 'n-e10', lat: null, lon: null }),
    ],
  });
  const rows = byId('ultra-inbox').children;
  assert.equal(rows.length, 3);
  const [first, second, third] = rows;
  assert.equal(
    first.className,
    'cctv-controls ultra-inbox-row ultra-release-row',
  );
  assert.equal(first.dataset.unread, '1');
  assert.equal(first.dataset.active, '1');
  assert.equal(
    first.children[0].textContent,
    `JEFF · NEEDS HELP · ${PLACE} · ${clock(NOW)} · 1.2 KM · SMS SENT 22:15`,
  );
  assert.equal(first.children[1].className, 'sst-readout ultra-plea');
  assert.equal(first.children[1].textContent, PLEA);
  assert.deepEqual(
    first.children.slice(2).map((child) => child.textContent),
    ['READ', 'OPEN IN SMS', 'MAP', 'REMOVE'],
  );
  const open = first.children[3];
  assert.equal(open.tagName, 'A');
  assert.equal(open.rel, 'noopener');
  assert.equal(open.href, `sms:?body=${encodeURIComponent(PLEA)}`);
  assert.equal(open.dataset.ultraOpenSms, '1');
  assert.equal(first.children[4].dataset.ultraNetworkMap, 'n-0123456789abcdef');
  assert.equal(first.children[5].dataset.ultraInboxRemove, release().id);
  /* Never a number, never TEXT BACK: nothing addresses the victim's phone. */
  assert.equal(
    first.children.some((child) => child.dataset.ultraTextBack),
    false,
  );
  assert.equal(first.children[0].textContent.includes('+1'), false);

  /* Ended, read, no address, far away, no SMS outcome: the text stays text. */
  assert.equal(second.dataset.active, '0');
  assert.equal(second.dataset.unread, '0');
  assert.equal(
    second.children[0].textContent,
    `ANN · NEEDS HELP · 45.3000, -66.1000 · ${clock(NOW)} · 12 KM · ENDED ${clock(NOW - 60_000)}`,
  );
  assert.equal(second.children[1].textContent, '<b>x</b>');
  assert.deepEqual(
    second.children.slice(2).map((child) => child.textContent),
    ['OPEN IN SMS', 'REMOVE'],
  );
  assert.equal(
    second.children[2].href,
    `sms:?body=${encodeURIComponent('<b>x</b>')}`,
  );

  /* Running but without a position: no MAP. */
  assert.equal(
    third.children.some((child) => child.dataset.ultraNetworkMap),
    false,
  );
  assert.ok(third.children[0].textContent.startsWith('JEFF · NEEDS HELP · '));
});

test('unread help messages win the status line over a pending camera', () => {
  const { documentRef, byId } = installFakeDocument();
  const pending = { kind: 'camera', label: 'REAR' };
  applyUltraHelpStatus(documentRef, { unread: 2, pending, inbox: [] });
  assert.equal(byId('ultra-status').textContent, 'HELP · 2 NEW');
  assert.equal(byId('ultra-inbox-count').textContent, '· 2 NEW');
  assert.ok(byId('ultra-inbox-heading').classList.contains('ultra-unread'));
  applyUltraHelpStatus(documentRef, { unread: 0, pending, inbox: [] });
  assert.equal(byId('ultra-status').textContent, 'LIVE VIDEO · REAR');
  assert.equal(byId('ultra-inbox-count').textContent, '');
  assert.equal(
    byId('ultra-inbox-heading').classList.contains('ultra-unread'),
    false,
  );
});

test('inbox rows are text only, and TEXT BACK appears only for an E.164 number', () => {
  const { documentRef, byId } = installFakeDocument();
  applyUltraHelpStatus(documentRef, {
    unread: 1,
    inbox: [
      message({
        id: 'm-1',
        text: '<b>x</b>',
        number: '+15065550100',
        lat: 45.27,
        lon: -66.06,
      }),
      message({ id: 'm-2', from: '', number: '', readAt: NOW }),
      message({ id: 'm-3', number: '5065550100', readAt: NOW }),
    ],
  });
  const rows = byId('ultra-inbox').children;
  assert.equal(rows.length, 3);
  const [first, second, third] = rows;
  assert.equal(first.dataset.unread, '1');
  const readout = first.children[0];
  assert.equal(readout.className, 'sst-readout');
  /* The reply number is in the readout, so the owner sees whom TEXT BACK reaches. */
  assert.ok(
    readout.textContent.includes('Neighbour · Sam (+15065550100): <b>x</b>'),
  );
  assert.ok(readout.textContent.includes('at 45.2700, -66.0600'));
  const labels = first.children.map((child) => child.textContent);
  assert.deepEqual(labels.slice(1), ['READ', 'TEXT BACK', 'REMOVE']);
  const textBack = first.children.find((child) => child.dataset.ultraTextBack);
  assert.equal(textBack.tagName, 'A');
  assert.ok(textBack.href.startsWith('sms:+15065550100?body='));
  assert.equal(textBack.rel, 'noopener');
  assert.equal(first.children[1].dataset.ultraInboxRead, 'm-1');
  assert.equal(first.children[3].dataset.ultraInboxRemove, 'm-1');

  assert.equal(second.dataset.unread, '0');
  assert.ok(second.children[0].textContent.includes('someone:'));
  assert.deepEqual(second.children.map((child) => child.textContent).slice(1), [
    'REMOVE',
  ]);
  assert.equal(
    third.children.some((child) => child.dataset.ultraTextBack),
    false,
  );
});

test('a tampered token says so and offers only REVOKE and REMOVE', () => {
  const { documentRef, byId } = installFakeDocument();
  applyUltraHelpStatus(documentRef, {
    helpBase: 'http://192.168.1.5:44173/ultra/help/',
    packages: [{ id: 'security-van', name: 'Van' }],
    tokenStore: 'ok',
    tokens: [
      token({
        tampered: true,
        encrypted: true,
        skills: [{ code: 'dr', label: 'Doctor' }],
      }),
    ],
    inbox: [],
  });
  const row = byId('ultra-tokens').children[0];
  assert.equal(row.dataset.revoked, '0');
  assert.equal(row.dataset.tampered, '1');
  assert.match(row.children[0].textContent, /Doctor · ENCRYPTED · TAMPERED$/);
  assert.doesNotMatch(row.children[0].textContent, /PACKAGE REMOVED/);
  assert.deepEqual(
    row.children.slice(1).map((child) => child.textContent),
    ['REVOKE', 'REMOVE'],
  );
  assert.equal(row.children[1].dataset.ultraTokenRevoke, token().id);
  assert.equal(row.children[2].dataset.ultraTokenRemove, token().id);
});

test('a token whose package was removed says so and offers only REVOKE and REMOVE', () => {
  const { documentRef, byId } = installFakeDocument();
  applyUltraHelpStatus(documentRef, {
    helpBase: 'http://192.168.1.5:44173/ultra/help/',
    packages: [],
    tokenStore: 'ok',
    tokens: [token({ orphaned: true })],
    inbox: [],
  });
  const row = byId('ultra-tokens').children[0];
  assert.equal(row.dataset.revoked, '0');
  assert.equal(row.dataset.orphaned, '1');
  assert.match(row.children[0].textContent, /· PACKAGE REMOVED$/);
  assert.deepEqual(
    row.children.slice(1).map((child) => child.textContent),
    ['REVOKE', 'REMOVE'],
  );
  assert.equal(row.children[2].dataset.ultraTokenRemove, token().id);
});

test('token rows carry the owner controls; revoked rows dim to REMOVE and purge appears past ten', () => {
  const { documentRef, byId } = installFakeDocument();
  const revoked = Array.from({ length: 12 }, (_, index) =>
    token({
      id: `t-${String(index).padStart(16, '0')}`,
      label: `Old ${index}`,
      revokedAt: NOW - index * 1000,
    }),
  );
  applyUltraHelpStatus(documentRef, {
    helpBase: 'http://192.168.1.5:44173/ultra/help/',
    ownerNumber: '+15065550100',
    packages: [
      { id: 'security-van', name: 'Van' },
      { id: 'security-shop', name: 'Shop' },
    ],
    tokenStore: 'ok',
    tokens: [token(), ...revoked],
    inbox: [],
  });
  const rows = byId('ultra-tokens').children;
  assert.equal(rows.length, 1 + 10 + 1);
  const live = rows[0];
  assert.equal(live.dataset.revoked, '0');
  assert.match(
    live.children[0].textContent,
    /^Neighbour · — · OPENS NOTHING UNTIL NETWORK ON · ab12cd34 · /,
  );
  assert.deepEqual(
    live.children.slice(1).map((child) => child.textContent),
    ['SHARE', 'NETWORK ON', 'REVOKE'],
  );
  assert.equal(live.children[2].dataset.ultraField, 'network');
  assert.equal(live.children[2].dataset.ultraCurrent, '0');
  assert.equal(live.children[3].dataset.ultraTokenRevoke, token().id);
  const dimmed = rows[1];
  assert.equal(dimmed.dataset.revoked, '1');
  assert.match(dimmed.children[0].textContent, /· REVOKED$/);
  assert.deepEqual(
    dimmed.children.slice(1).map((child) => child.textContent),
    ['REMOVE'],
  );
  assert.equal(rows[11].children[0].textContent, 'REMOVE ALL REVOKED');
  assert.equal(rows[11].children[0].dataset.ultraTokenPurge, '1');

  assert.match(
    byId('ultra-token-note').textContent,
    /^Only when Network is on and SEND HELP is pressed/,
  );
  assert.match(
    byId('ultra-token-note').textContent,
    / With Network off a token opens nothing\. /,
  );
  assert.equal(
    byId('ultra-token-note').textContent.includes(
      'http://192.168.1.5:44173/ultra/help/',
    ),
    false,
  );
  /* A LAN address only: no promise that a NETWORK link works over it. */
  assert.doesNotMatch(byId('ultra-token-note').textContent, /LAN/);
  assert.match(
    byId('ultra-token-note').textContent,
    /no tailnet address yet, so a Network token cannot reach another GEVC\.$/,
  );
  assert.match(
    byId('ultra-token-note').textContent,
    /Skills and Gifts are optional/,
  );
  assert.match(
    byId('ultra-token-note').textContent,
    /add up to five of your own, or leave them all off/,
  );
  assert.match(
    byId('ultra-token-note').textContent,
    /Encrypt hides those skills inside the token string/,
  );
  assert.equal(byId('ultra-token-note').textContent.includes('ANYTIME'), false);
  applyUltraHelpStatus(documentRef, {
    tokens: [token()],
    helpBase: 'http://192.168.1.5:44173/ultra/help/',
    networkBase: 'https://van.tail9.ts.net',
    ownerNumber: '+15065550100',
    inbox: [],
  });
  assert.match(
    byId('ultra-token-note').textContent,
    /Your tailnet address for holders: https:\/\/van\.tail9\.ts\.net$/,
  );
  /* Back to the status the rest of this case checks. */
  applyUltraHelpStatus(documentRef, {
    tokens: [token()],
    packages: [
      { id: 'security-van', name: 'Van 7' },
      { id: 'security-shop', name: 'Shop' },
    ],
    helpBase: 'http://192.168.1.5:44173/ultra/help/',
    ownerNumber: '+15065550100',
    inbox: [],
  });
  assert.equal(byId('ultra-number-clear').hidden, false);
  assert.match(byId('ultra-number-input').placeholder, /^SAVED: \+1506…$/);
  const select = byId('ultra-token-package');
  assert.equal(select.hidden, false);
  assert.deepEqual(
    select.children.map((option) => option.value),
    ['security-van', 'security-shop'],
  );

  /* A network token reads NET and offers NETWORK OFF. */
  applyUltraHelpStatus(documentRef, {
    helpBase: 'http://192.168.1.5:44173/ultra/help/',
    tokenStore: 'ok',
    tokens: [token({ network: true, voice: true })],
    inbox: [],
  });
  const net = byId('ultra-tokens').children[0];
  assert.match(
    net.children[0].textContent,
    /^Neighbour · NET · ONLY WHEN ASKING · ab12cd34/,
  );
  assert.equal(net.children[2].textContent, 'NETWORK OFF');
  assert.equal(net.children[2].dataset.ultraCurrent, '1');

  /* A broken store shows the failure sentence and only RESET TOKENS. */
  applyUltraHelpStatus(documentRef, {
    helpBase: '',
    tokenStore: 'unreadable',
    tokens: [token()],
    packages: [{ id: 'security-van', name: 'Van' }],
    inbox: [],
  });
  const broken = byId('ultra-tokens').children;
  assert.equal(broken.length, 1);
  assert.equal(broken[0].children[0].textContent, 'RESET TOKENS');
  assert.equal(broken[0].children[0].dataset.ultraTokenReset, '1');
  assert.match(byId('ultra-token-note').textContent, /cannot be read/);
  assert.equal(byId('ultra-token-package').hidden, true);
  assert.equal(byId('ultra-number-clear').hidden, true);

  applyUltraHelpStatus(documentRef, {
    helpBase: '',
    tokenStore: 'ok',
    tokens: [],
    inbox: [],
  });
  assert.match(
    byId('ultra-token-note').textContent,
    /^Share links need the report listener/,
  );
  assert.equal(byId('ultra-tokens').children.length, 0);
});

test('home-list rows show host, source and state, never a link; the note and relay line follow the status', () => {
  const { documentRef, byId } = installFakeDocument();
  const entries = [
    entry({
      id: 'n-0000000000000001',
      name: 'Zed',
      lastState: 'quiet',
      lastPolledAt: NOW - 5_000,
    }),
    entry({
      id: 'n-0000000000000002',
      name: 'Amy',
      lastState: 'quiet',
      lastPolledAt: NOW - 3 * 60_000,
    }),
    entry({
      id: 'n-0000000000000003',
      name: 'Sam',
      lastState: 'released',
      active: true,
      source: 'directory',
    }),
    entry({
      id: 'n-0000000000000004',
      name: 'Bea',
      lastState: 'new',
      lastPolledAt: null,
    }),
    entry({ id: 'n-0000000000000005', name: 'Cal', lastState: 'off' }),
    entry({ id: 'n-0000000000000006', name: 'Dee', lastState: 'dead' }),
    entry({
      id: 'n-0000000000000007',
      name: 'Eve',
      lastState: 'unreachable',
      failures: 3,
    }),
    entry({ id: 'n-0000000000000008', name: 'Fay', lastState: 'busy' }),
    entry({ id: 'n-0000000000000009', name: 'Gus', lastState: 'not-tailnet' }),
    entry({
      id: 'n-000000000000000a',
      name: 'Hal',
      lastState: 'missing',
      directoryMissing: true,
      source: 'directory',
    }),
    entry({
      id: 'n-000000000000000b',
      name: 'Ida',
      lastState: 'moved',
      moved: true,
      source: 'directory',
    }),
    entry({ id: 'n-000000000000000c', name: 'Jon', lastState: 'own' }),
    entry({ id: 'n-000000000000000d', name: 'Kim', lastState: 'no-key' }),
    entry({
      id: 'n-000000000000000e',
      name: 'Lou',
      lastState: 'quiet',
      directoryMissing: true,
      moved: true,
      source: 'directory',
      address: 'https://peer.tail9.ts.net',
      token: TOKEN,
    }),
    entry({
      id: 'n-000000000000000f',
      name: 'Ned',
      lastState: 'tampered',
    }),
  ];
  applyUltraHelpStatus(documentRef, {
    tokens: [
      token({ network: true, sms: false }),
      token({ id: 't-2', label: 'Cousin', fingerprint: 'ff00ff00' }),
      /* NETWORK on, but SMS or ANYTIME too: never offered for the directory. */
      token({ id: 't-3', label: 'Texter', network: true, sms: true }),
      token({
        id: 't-4',
        label: 'Always',
        network: true,
        sms: false,
        anytime: true,
      }),
    ],
    ownerNumber: '+15065550100',
    inbox: [],
    network: network({
      me: { name: 'Jeff' },
      entries,
      directory: {
        url: 'https://raw.githubusercontent.com/g/r/main/ultra-directory.json',
        configured: true,
        github: true,
        canPublish: true,
        lastUpdateAt: NOW,
        lastResult: {
          added: 3,
          updated: 1,
          missing: 1,
          own: 1,
          moved: 1,
          skipped: 2,
          total: 12,
        },
      },
      published: { tokenId: 't-9', at: NOW, how: 'github', live: false },
      relay: {
        provider: 'twilio',
        configured: true,
        host: 'api.twilio.com',
        lastTestAt: NOW,
        lastOutcome: 'SMS SENT 22:15',
        sentToday: 3,
      },
    }),
  });
  const list = byId('ultra-network-list');
  const rows = list.children;
  assert.equal(rows.length, entries.length);
  /* Active first, then by name. */
  assert.equal(rows[0].dataset.active, '1');
  assert.equal(rows[0].dataset.state, 'released');
  assert.equal(rows[0].dataset.source, 'directory');
  assert.equal(rows[0].className, 'cctv-controls ultra-network-row');
  assert.equal(
    rows[0].children[0].textContent,
    `Sam · peer.tail9.ts.net · DIRECTORY · NEEDS HELP · ${clock(NOW - 10_000)}`,
  );
  assert.deepEqual(
    rows[0].children.slice(1).map((child) => child.textContent),
    ['RENAME', 'REMOVE'],
  );
  assert.equal(
    rows[0].children[1].dataset.ultraNetworkRename,
    'n-0000000000000003',
  );
  assert.equal(
    rows[0].children[2].dataset.ultraNetworkRemove,
    'n-0000000000000003',
  );
  const readouts = Object.fromEntries(
    rows.map((row) => [
      row.children[0].textContent.split(' · ')[0],
      row.children[0].textContent,
    ]),
  );
  assert.deepEqual(
    rows.slice(1).map((row) => row.children[0].textContent.split(' · ')[0]),
    [
      'Amy',
      'Bea',
      'Cal',
      'Dee',
      'Eve',
      'Fay',
      'Gus',
      'Hal',
      'Ida',
      'Jon',
      'Kim',
      'Lou',
      'Ned',
      'Zed',
    ],
  );
  assert.match(readouts.Ned, / · TAMPERED/);
  assert.equal(
    list.children.find((row) => row.dataset.state === 'tampered')?.dataset
      .state,
    'tampered',
  );
  assert.match(readouts.Zed, / · MANUAL · WATCHING · /);
  assert.match(readouts.Amy, / · MANUAL · OK · STALE · /);
  assert.equal(
    readouts.Bea,
    'Bea · peer.tail9.ts.net · MANUAL · NOT CHECKED YET',
  );
  assert.match(readouts.Cal, / · NOT SHARING · /);
  assert.match(readouts.Dee, / · TOKEN DEAD \(404\) · /);
  assert.match(
    readouts.Eve,
    / · UNREACHABLE \(is their machine on the tailnet\?\) · /,
  );
  assert.match(readouts.Fay, / · BUSY \(429\) · /);
  assert.match(readouts.Gus, / · NOT A TAILNET ADDRESS · /);
  assert.match(
    readouts.Hal,
    /^Hal · peer\.tail9\.ts\.net · DIRECTORY · NOT IN DIRECTORY · /,
  );
  assert.match(
    readouts.Ida,
    /^Ida · peer\.tail9\.ts\.net · DIRECTORY · MOVED · /,
  );
  assert.match(readouts.Jon, / · YOUR OWN TOKEN · /);
  assert.match(readouts.Kim, / · NO KEY · /);
  assert.match(
    readouts.Lou,
    / · DIRECTORY · WATCHING · NOT IN DIRECTORY · MOVED · /,
  );
  for (const row of rows) {
    assert.equal(
      row.children[0].textContent.includes('uht1.'),
      false,
      'never a token',
    );
    assert.equal(
      row.children[0].textContent.includes('https://'),
      false,
      'never a link',
    );
  }
  assert.equal(byId('ultra-network-count').textContent, '· 1 NEED HELP');
  assert.ok(byId('ultra-network-heading').classList.contains('ultra-unread'));

  /* The note: the directory line with the last merge, then the publish state. */
  assert.equal(
    byId('ultra-network-note').textContent,
    `Directory: https://raw.githubusercontent.com/g/r/main/ultra-directory.json · write token saved, PUBLISH writes to it · UPDATED ${clock(NOW)} · 3 added · 1 renamed · 1 missing · 1 moved · 2 skipped · 12 listed · Anyone who can read the directory sees where the phones in it are while their owners ask for help, and nothing more: keep it private to your group. Your token is published (written to the directory ${new Date(NOW).toLocaleDateString()}) · THAT TOKEN IS REVOKED: publish again.`,
  );
  assert.equal(byId('ultra-network-me-name').placeholder, 'SAVED: Jeff');
  assert.equal(
    byId('ultra-directory-url').placeholder,
    'SAVED: https://raw.githubusercontent.com/g/r/main/ultra-directory.json',
  );
  assert.equal(
    byId('ultra-directory-token').placeholder,
    'write token saved — paste to replace, never shown',
  );
  const select = byId('ultra-publish-token');
  assert.equal(select.hidden, false);
  assert.deepEqual(
    select.children.map((option) => [option.value, option.textContent]),
    [
      ['', 'DIRECTORY TOKEN (made for you)'],
      [token().id, 'Neighbour · ab12cd34'],
    ],
  );
  assert.equal(
    byId('ultra-sms-relay').textContent,
    'SMS RELAY · TWILIO (api.twilio.com) · SMS SENT 22:15 · 3 SENT TODAY',
  );
  assert.equal(byId('ultra-sms-test').disabled, false);

  /* Not polling (vite preview): every row reads NOT POLLED. */
  applyUltraHelpStatus(documentRef, {
    tokens: [],
    inbox: [],
    network: network({ polling: false, entries: entries.slice(0, 3) }),
  });
  assert.equal(
    byId('ultra-network-note').textContent,
    'Polling runs under npm run dev only (vite preview shows the list without checking it)',
  );
  for (const row of byId('ultra-network-list').children) {
    assert.match(row.children[0].textContent, / · NOT POLLED/);
  }
  assert.equal(byId('ultra-network-count').textContent, '· 1 NEED HELP');

  /* No key: the key sentence wins over everything else. */
  applyUltraHelpStatus(documentRef, {
    tokens: [],
    inbox: [],
    network: network({
      keyState: 'no-key',
      polling: false,
      entries: [entry({ lastState: 'no-key' })],
    }),
  });
  assert.match(
    byId('ultra-network-note').textContent,
    /^The token key file is missing or not valid/,
  );
  assert.equal(byId('ultra-network-count').textContent, '· 1 token');

  /* No directory yet, nothing configured, no owner number: TEST SMS is off. */
  applyUltraHelpStatus(documentRef, {
    tokens: [],
    inbox: [],
    network: network({
      directory: {
        url: '',
        configured: false,
        github: false,
        canPublish: false,
        lastUpdateAt: null,
        lastResult: { error: 'The directory is not JSON' },
      },
    }),
  });
  const noDirectory =
    "Directory: none. Paste your group's directory address (an https file: GitHub, Hugging Face or Private Server) and SAVE DIRECTORY: it is written to your local .env, the dev server restarts and this page reloads. Only https Tail Net links are accepted.";
  const activate =
    'Net Work activated when Tail Net + Ultra Encryption Token is released via HELP request.';
  assert.equal(
    byId('ultra-network-note').textContent,
    `${noDirectory}\n${activate}`,
  );
  assert.equal(byId('ultra-network-count').textContent, '');
  assert.equal(
    byId('ultra-network-heading').classList.contains('ultra-unread'),
    false,
  );
  assert.equal(
    byId('ultra-network-me-name').placeholder,
    'Your name, as your holders see it',
  );
  assert.equal(
    byId('ultra-directory-token').placeholder,
    'GitHub write token (optional, never shown)',
  );
  assert.equal(byId('ultra-publish-token').hidden, true);
  assert.equal(
    byId('ultra-sms-relay').textContent,
    'SMS RELAY · NOT CONFIGURED (POWER UP → SMS RELAY)',
  );
  assert.equal(byId('ultra-sms-test').disabled, true);

  /* A token copied for the maintainer is said before that last line. */
  applyUltraHelpStatus(documentRef, {
    tokens: [],
    inbox: [],
    network: network({
      published: { how: 'clipboard', at: NOW, live: true },
    }),
  });
  assert.equal(
    byId('ultra-network-note').textContent,
    `${noDirectory} Your token is published (copied for the maintainer ${new Date(NOW).toLocaleDateString()}).\n${activate}`,
  );

  /* A failed update is named on the directory line. */
  applyUltraHelpStatus(documentRef, {
    tokens: [],
    inbox: [],
    network: network({
      directory: {
        url: 'https://example.test/dir.json',
        configured: true,
        github: false,
        canPublish: false,
        lastUpdateAt: NOW,
        lastResult: { error: 'The directory is not JSON' },
      },
    }),
  });
  assert.equal(
    byId('ultra-network-note').textContent,
    'Directory: https://example.test/dir.json · not a GitHub file: PUBLISH copies the entry for you to send · last update failed: The directory is not JSON · Anyone who can read the directory sees where the phones in it are while their owners ask for help, and nothing more: keep it private to your group.',
  );
  assert.equal(byId('ultra-help-store-note').hidden, true);
  assert.equal(byId('ultra-outbound-note').hidden, true);
  applyUltraHelpStatus(documentRef, {
    tokens: [],
    inbox: [],
    contacts: [],
    helpStore: 'tampered',
    network: network(),
  });
  assert.equal(byId('ultra-help-store-note').hidden, false);
  assert.equal(
    byId('ultra-help-store-note').textContent,
    'The helpers file was changed and is not being used. The next save replaces it.',
  );
  assert.equal(byId('ultra-outbound-note').hidden, true);
  applyUltraHelpStatus(documentRef, {
    tokens: [],
    inbox: [],
    contacts: [],
    directoryStore: 'tampered',
    relayStore: 'tampered',
    feedsStore: 'tampered',
    network: network(),
  });
  assert.equal(byId('ultra-help-store-note').hidden, true);
  assert.equal(byId('ultra-outbound-note').hidden, false);
  assert.equal(
    byId('ultra-outbound-note').textContent,
    'The directory address was changed and is not being used. Save it again from the box. The SMS relay was changed and is not being used. Save it again from POWER UP. The phone package was changed and is not being used. Save the package again.',
  );
  assert.doesNotMatch(byId('ultra-outbound-note').textContent, /LAN/);
});

test('RENAME leaves the link box usable and lets go of the form when the rename is refused or its row goes', async (t) => {
  /* No real poll timer: a request that throws must not leave one running. */
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { documentRef, panel, byId } = installFakeDocument();
  const bob = entry({ id: 'n-00000000000000b0', name: 'Bob' });
  const status = {
    unread: 0,
    inbox: [],
    tokens: [],
    packages: [],
    contacts: [],
    network: network({ entries: [entry(), bob] }),
  };
  /* How the server answers a rename: refused, never answered, or held
   * until the test lets it through. */
  let renameAnswer = 'refuse';
  let letThrough = null;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    if (body?.rename && renameAnswer === 'refuse') {
      return { ok: false, json: async () => ({ error: 'No such link' }) };
    }
    if (body?.rename && renameAnswer === 'down') {
      throw new TypeError('Failed to fetch');
    }
    if (body?.rename && renameAnswer === 'hold') {
      await new Promise((resolve) => {
        letThrough = resolve;
      });
    }
    return { ok: true, json: async () => status };
  };
  const handle = initUltraHelpPanel({
    documentRef,
    fetchImpl,
    windowRef: fakeWindow(),
  });
  const form = () => byId('ultra-network-add');
  const arm = (id) =>
    panel.dispatch('click', {
      target: byId('ultra-network-list')
        .querySelectorAll('[data-ultra-network-rename]')
        .find((node) => node.dataset.ultraNetworkRename === id),
    });
  const submit = async () => {
    panel.dispatch('submit', { target: form() });
    await settle();
  };
  const assertLetGo = () => {
    assert.equal(form().dataset.ultraRenaming, undefined);
    assert.equal(
      byId('ultra-network-add-submit').textContent,
      'ADD TO HOME LIST',
    );
    assert.match(
      byId('ultra-network-address').placeholder,
      /^Their tailnet address/,
    );
    assert.match(byId('ultra-network-token').placeholder, /^Their Ultra Token/);
  };
  try {
    await settle();
    /* Armed, the link box stays usable and says a paste is an ADD. */
    arm(entry().id);
    assert.equal(form().dataset.ultraRenaming, entry().id);
    assert.equal(byId('ultra-network-address').disabled, false);
    assert.equal(
      byId('ultra-network-address').placeholder,
      'Renaming — enter an address and token to add one instead',
    );
    /* A refused rename says why and lets go of the form. */
    await submit();
    assert.deepEqual(calls.at(-1).body, {
      rename: true,
      id: entry().id,
      name: 'Sam',
    });
    assert.equal(byId('ultra-status').textContent, 'No such link');
    assertLetGo();
    /* So does one that never got an answer. */
    renameAnswer = 'down';
    arm(entry().id);
    await submit();
    assert.equal(
      byId('ultra-status').textContent,
      'Not sent: no answer from the dev server',
    );
    assertLetGo();
    /* A repaint that still lists the row keeps RENAME armed; one without it
     * (REMOVE, RESET TOKENS) lets go. */
    arm(entry().id);
    applyUltraHelpStatus(documentRef, structuredClone(status));
    assert.equal(form().dataset.ultraRenaming, entry().id);
    applyUltraHelpStatus(documentRef, {
      ...status,
      network: network({ entries: [bob] }),
    });
    assertLetGo();
    /* A handout entered while RENAME is armed is an ADD. */
    applyUltraHelpStatus(documentRef, status);
    arm(entry().id);
    byId('ultra-network-address').value = 'https://peer.tail9.ts.net';
    byId('ultra-network-token').value = TOKEN;
    await submit();
    assert.deepEqual(calls.at(-1).body, {
      add: true,
      address: 'https://peer.tail9.ts.net',
      token: TOKEN,
      name: 'Sam',
    });
    assertLetGo();
    /* RENAME pressed on another row while a rename is on its way keeps the
     * form, and the name it filled in, when that answer lands. */
    renameAnswer = 'hold';
    arm(entry().id);
    byId('ultra-network-link-name').value = 'Sammy';
    await submit();
    assert.deepEqual(calls.at(-1).body, {
      rename: true,
      id: entry().id,
      name: 'Sammy',
    });
    arm(bob.id);
    assert.equal(byId('ultra-network-link-name').value, 'Bob');
    letThrough();
    await settle();
    assert.equal(form().dataset.ultraRenaming, bob.id);
    assert.equal(byId('ultra-network-add-submit').textContent, 'RENAME');
    assert.equal(byId('ultra-network-link-name').value, 'Bob');
  } finally {
    handle.destroy();
  }
});

test('a SAVE DIRECTORY sentence stays on the status line through the next poll', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { documentRef, panel, byId } = installFakeDocument();
  const status = {
    unread: 0,
    inbox: [],
    tokens: [],
    packages: [],
    contacts: [],
    position: { lat: 45.27, lon: -66.06 },
    network: network(),
  };
  let keys = 'refuse';
  let statusDown = false;
  const fetchImpl = async (url) => {
    if (url === '/api/setup/keys') {
      if (keys === 'down') throw new TypeError('Failed to fetch');
      if (keys === 'ok') return { ok: true, json: async () => ({ ok: true }) };
      return {
        ok: false,
        json: async () => ({ ok: false, error: 'Refused: bad address' }),
      };
    }
    if (url === '/api/ultra-help/network') {
      return {
        ok: false,
        json: async () => ({ error: 'Set the directory first' }),
      };
    }
    if (statusDown) throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => status };
  };
  const handle = initUltraHelpPanel({
    documentRef,
    fetchImpl,
    windowRef: fakeWindow(),
  });
  const line = () => byId('ultra-status').textContent;
  const saveDirectory = async () => {
    byId('ultra-directory-url').value = 'https://example.test/dir.json';
    panel.dispatch('submit', { target: byId('ultra-directory') });
    await settle();
  };
  const poll = async () => {
    t.mock.timers.tick(3000);
    await settle();
  };
  try {
    await settle();
    assert.equal(line(), 'PHONE · 45.2700, -66.0600');
    /* An older refusal, still inside its fifteen seconds, never comes back
     * over SAVE DIRECTORY's own reason. */
    panel.dispatch('click', { target: byId('ultra-network-update') });
    await settle();
    assert.equal(line(), 'Set the directory first');
    await saveDirectory();
    assert.equal(line(), 'Refused: bad address');
    await poll();
    assert.equal(line(), 'Refused: bad address');
    keys = 'down';
    await saveDirectory();
    await poll();
    assert.equal(line(), 'Not saved: no answer from the dev server');
    /* Saved: the dev server restarts, so its polls fail for a while, and the
     * line keeps saying the page reloads itself. */
    keys = 'ok';
    await saveDirectory();
    statusDown = true;
    await poll();
    assert.equal(
      line(),
      'Saved to your local .env. Restarting — this page reloads itself.',
    );
  } finally {
    handle.destroy();
  }
});

test('a SEND HELP whose request never reaches the dev server says HELP NOT SENT until it is pressed again', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { documentRef, panel, byId } = installFakeDocument();
  const status = {
    unread: 0,
    inbox: [],
    tokens: [token({ network: true })],
    packages: [],
    contacts: [],
    position: { lat: 45.27, lon: -66.06 },
    network: network(),
  };
  /* 'down' throws as fetch does with the server stopped; 'garbled' answers
   * 200 with a body cut off on the way. */
  let answer = 'ok';
  let releaseAnswer = 'down';
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    const how = url === '/api/ultra-help/release' ? releaseAnswer : answer;
    if (how === 'down') throw new TypeError('Failed to fetch');
    if (how === 'garbled') {
      return {
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      };
    }
    return { ok: true, json: async () => status };
  };
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  const restoreConfirm = withConfirm(() => true);
  const realNow = Date.now;
  const handle = initUltraHelpPanel({
    documentRef,
    fetchImpl,
    windowRef: fakeWindow(),
  });
  const line = () => byId('ultra-status').textContent;
  const poll = async () => {
    t.mock.timers.tick(3000);
    await settle();
  };
  const helpNotSent =
    'HELP NOT SENT — no answer from the dev server; press again';
  try {
    await settle();
    assert.equal(line(), 'PHONE · 45.2700, -66.0600');
    panel.dispatch('click', { target: byId('ultra-release-send') });
    await settle();
    assert.deepEqual(calls.at(-1), {
      url: '/api/ultra-help/release',
      body: { incident: 'threat' },
    });
    assert.equal(line(), helpNotSent);
    assert.equal(byId('ultra-release-send').textContent, 'SEND HELP');
    /* The server stays down: the failed poll leaves the sentence up. */
    answer = 'down';
    await poll();
    assert.equal(line(), helpNotSent);
    /* It is back: a good poll keeps it too, for its fifteen seconds. */
    answer = 'ok';
    await poll();
    assert.equal(line(), helpNotSent);
    /* Nothing was pressed again by itself. */
    assert.equal(
      calls.filter((call) => call.url === '/api/ultra-help/release').length,
      1,
    );
    /* Fifteen seconds on, a failed poll says the server is quiet again. */
    Date.now = () => realNow() + 16_000;
    answer = 'down';
    await poll();
    assert.equal(
      line(),
      'NO ANSWER FROM THE DEV SERVER — showing the last known state',
    );
    Date.now = realNow;
    /* STAND DOWN, a 200 whose body never arrived whole, and any other
     * button each say so in their own words. */
    panel.dispatch('click', { target: byId('ultra-release-stand-down') });
    await settle();
    assert.deepEqual(calls.at(-1).body, { standDown: true });
    assert.equal(
      line(),
      'STAND DOWN NOT SENT — no answer from the dev server; press STAND DOWN again',
    );
    releaseAnswer = 'garbled';
    panel.dispatch('click', { target: byId('ultra-release-send') });
    await settle();
    assert.equal(line(), helpNotSent);
    panel.dispatch('click', { target: byId('ultra-network-update') });
    await settle();
    assert.equal(line(), 'Not sent: no answer from the dev server');
    /* Pressed again with the server back: sent, and the line says so. */
    answer = 'ok';
    releaseAnswer = 'ok';
    status.release = {
      at: NOW,
      until: NOW + 4 * 3_600_000,
      feedId: 'security-van',
      incident: 'threat',
      holders: 1,
      watching: 0,
    };
    panel.dispatch('click', { target: byId('ultra-release-send') });
    await settle();
    assert.match(line(), /^HELP SENT · UNTIL /);
    assert.deepEqual(rejections, []);
  } finally {
    Date.now = realNow;
    handle.destroy();
    restoreConfirm();
    process.off('unhandledRejection', onRejection);
  }
});

test('a new token is not marked anytime, and a refused mint keeps the name', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const status = {
    unread: 0,
    inbox: [],
    tokens: [],
    packages: [{ id: 'security-van', name: 'Van 7' }],
    contacts: [],
    network: network(),
  };
  let refuse = true;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/ultra-help/tokens' && refuse) {
      return { ok: false, json: async () => ({ error: 'Not saved' }) };
    }
    return { ok: true, json: async () => status };
  };
  const handle = initUltraHelpPanel({
    documentRef,
    fetchImpl,
    windowRef: fakeWindow(),
  });
  const mint = async () => {
    panel.dispatch('submit', { target: byId('ultra-token') });
    await settle();
    return calls.at(-1);
  };
  try {
    await settle();
    assert.equal(byId('ultra-token-anytime'), null);
    byId('ultra-token-label').value = 'Partner';
    const refused = await mint();
    assert.equal(refused.url, '/api/ultra-help/tokens');
    assert.equal('anytime' in refused.body, false);
    assert.equal(byId('ultra-token-label').value, 'Partner');
    refuse = false;
    const made = await mint();
    assert.equal('anytime' in made.body, false);
    assert.equal(byId('ultra-token-label').value, '');
    /* Network is on by default and stays as it was; SMS and Voice went
     * with the help-message page. */
    assert.equal(byId('ultra-token-network').checked, true);
    assert.equal(byId('ultra-token-sms'), null);
    assert.equal(byId('ultra-token-voice'), null);
    assert.equal('sms' in made.body || 'voice' in made.body, false);
    byId('ultra-token-label').value = 'Courier';
    const next = await mint();
    assert.equal(next.body.label, 'Courier');
    assert.equal('anytime' in next.body, false);
    assert.deepEqual(next.body.skills, []);
    assert.deepEqual(next.body.custom, []);
    assert.equal(next.body.encrypt, false);
  } finally {
    handle.destroy();
  }
});

test('skill sets are sent with the token and cleared once it is minted', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const status = {
    unread: 0,
    inbox: [],
    tokens: [],
    packages: [{ id: 'security-van', name: 'Van 7' }],
    contacts: [],
    network: network(),
  };
  let refuse = true;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/ultra-help/tokens' && refuse) {
      return { ok: false, json: async () => ({ error: 'Not saved' }) };
    }
    return { ok: true, json: async () => status };
  };
  const handle = initUltraHelpPanel({
    documentRef,
    fetchImpl,
    windowRef: fakeWindow(),
  });
  const mint = async () => {
    panel.dispatch('submit', { target: byId('ultra-token') });
    await settle();
    return calls.at(-1);
  };
  try {
    await settle();
    byId('ultra-token-label').value = 'Medic';
    byId('ultra-skill-custom-1').value = 'Search and Rescue Specialist Extra';
    panel.dispatch('input', { target: byId('ultra-skill-custom-1') });
    assert.equal(byId('ultra-skill-custom-preview').hidden, false);
    assert.match(
      byId('ultra-skill-custom-preview').textContent,
      /The token will say: Search and Rescue$/,
    );
    byId('ultra-skill-custom-2').value = 'Search and Rescue Specialist Beta';
    panel.dispatch('input', { target: byId('ultra-skill-custom-2') });
    assert.match(
      byId('ultra-skill-custom-preview').textContent,
      /Two custom skill sets would share one token code/,
    );
    calls.length = 0;
    panel.dispatch('submit', { target: byId('ultra-token') });
    await settle();
    assert.equal(calls.length, 0);
    assert.match(
      byId('ultra-status').textContent,
      /Two custom skill sets would share one token code/,
    );
    assert.equal(byId('ultra-token-submit').textContent, 'GENERATE NEW TOKEN');
    assert.equal(
      byId('ultra-skill-custom-1').value,
      'Search and Rescue Specialist Extra',
    );
    byId('ultra-skill-custom-1').value = 'Coast Guard';
    byId('ultra-skill-custom-2').value = '';
    panel.dispatch('input', { target: byId('ultra-skill-custom-1') });
    assert.equal(byId('ultra-skill-custom-preview').hidden, true);
    byId('ultra-skill-dr').checked = true;
    byId('ultra-token-encrypt').checked = true;
    const refused = await mint();
    assert.deepEqual(refused.body.skills, ['dr']);
    assert.deepEqual(refused.body.custom, ['Coast Guard']);
    assert.equal(refused.body.encrypt, true);
    assert.equal(byId('ultra-skill-dr').checked, true);
    assert.equal(byId('ultra-skill-custom-1').value, 'Coast Guard');
    assert.equal(byId('ultra-token-encrypt').checked, true);
    refuse = false;
    await mint();
    assert.equal(byId('ultra-skill-dr').checked, false);
    assert.equal(byId('ultra-skill-custom-1').value, '');
    assert.equal(byId('ultra-token-encrypt').checked, false);
    assert.equal(byId('ultra-skill-custom-preview').hidden, true);
    applyUltraHelpStatus(documentRef, {
      tokenStore: 'ok',
      tokens: [
        token({
          skills: [
            { code: 'dr', label: 'Doctor' },
            { code: 'xcoast-guard', label: 'Coast Guard' },
          ],
          encrypted: true,
        }),
      ],
      inbox: [],
      network: network({
        entries: [entry({ skills: ['Firefighter'], encrypted: true })],
      }),
    });
    assert.match(
      byId('ultra-tokens').children[0].children[0].textContent,
      /Doctor, Coast Guard · ENCRYPTED$/,
    );
    assert.match(
      byId('ultra-network-list').children[0].children[0].textContent,
      /Firefighter · ENCRYPTED$/,
    );
    applyUltraHelpStatus(documentRef, {
      revealed: {
        id: 't-1',
        label: 'Medic',
        token: 'uht1.' + 'A'.repeat(43) + '.e.sealed',
        address: '',
        skills: [{ code: 'dr', label: 'Doctor' }],
        encrypted: true,
      },
    });
    assert.match(byId('ultra-token-link').textContent, /Doctor/);
    assert.match(
      byId('ultra-token-link').textContent,
      /Skills encrypted in the token/,
    );
  } finally {
    handle.destroy();
  }
});

test('an unchanged poll leaves the rows and their buttons in place; a change repaints and keeps the focus', () => {
  const { documentRef, byId } = installFakeDocument();
  const status = {
    unread: 2,
    inbox: [
      release({ id: 'm-00000000000000c1', networkId: entry().id }),
      message({ id: 'm-00000000000000c2', number: '+15065550111' }),
    ],
    tokens: [token({ network: true })],
    packages: [{ id: 'security-van', name: 'Van 7' }],
    contacts: [
      {
        id: 'c-0000000000000001',
        label: 'Ann',
        number: '+15065550122',
        kind: 'sms',
      },
    ],
    camLink: 'https://van.tail9.ts.net/ultra/abc/cam',
    network: network({ entries: [entry()] }),
  };
  const find = (listId, selector) => byId(listId).querySelector(selector);
  const nodes = () => ({
    map: find('ultra-inbox', '[data-ultra-network-map]'),
    textBack: find('ultra-inbox', '[data-ultra-text-back]'),
    revoke: find('ultra-tokens', '[data-ultra-token-revoke]'),
    networkToggle: byId('ultra-tokens')
      .querySelectorAll('[data-ultra-token-edit]')
      .find((node) => node.dataset.ultraField === 'network'),
    rename: find('ultra-network-list', '[data-ultra-network-rename]'),
    contact: find('ultra-contacts', '[data-ultra-remove]'),
    camLink: byId('ultra-cam-link').children[0],
  });
  applyUltraHelpStatus(documentRef, status);
  const before = nodes();
  for (const [name, node] of Object.entries(before)) assert.ok(node, name);
  /* A focused button in a list that did not change keeps the focus. */
  before.rename.focus();
  applyUltraHelpStatus(documentRef, structuredClone(status));
  const same = nodes();
  for (const name of Object.keys(before)) {
    assert.equal(same[name], before[name], `${name} was rebuilt`);
  }
  assert.equal(documentRef.activeElement, before.rename);
  /* NETWORK OFF pressed from the keyboard: the token row changes, and the
   * focus moves to the same button in the new row, now NETWORK ON. */
  before.networkToggle.focus();
  applyUltraHelpStatus(documentRef, {
    ...structuredClone(status),
    tokens: [token({ network: false })],
  });
  const after = nodes();
  assert.notEqual(after.revoke, before.revoke);
  assert.notEqual(after.networkToggle, before.networkToggle);
  assert.equal(after.networkToggle.textContent, 'NETWORK ON');
  assert.equal(documentRef.activeElement, after.networkToggle);
  assert.equal(after.map, before.map);
  assert.equal(after.rename, before.rename);
  /* Text that changes with time alone still repaints: WATCHING goes stale. */
  applyUltraHelpStatus(documentRef, {
    ...structuredClone(status),
    network: network({
      entries: [entry({ lastPolledAt: NOW - 3 * 60_000 })],
    }),
  });
  assert.notEqual(nodes().rename, before.rename);
  assert.match(
    byId('ultra-network-list').children[0].children[0].textContent,
    / · OK · STALE · /,
  );
});

test('a clicked button keeps the focus through the poll: focused again without a scroll, and only when its own row repaints', () => {
  const { documentRef, byId } = installFakeDocument();
  const ann = token({ id: 't-00000000000000d1', label: 'Ann' });
  const bob = token({ id: 't-00000000000000d2', label: 'Bob' });
  const paint = (tokens) =>
    applyUltraHelpStatus(documentRef, {
      unread: 0,
      inbox: [],
      tokens,
      packages: [{ id: 'security-van', name: 'Van 7' }],
      network: network({ entries: [entry()] }),
    });
  const networkButton = (id) =>
    byId('ultra-tokens')
      .querySelectorAll('[data-ultra-token-edit]')
      .find(
        (node) =>
          node.dataset.ultraTokenEdit === id &&
          node.dataset.ultraField === 'network',
      );
  paint([ann, bob]);
  /* NETWORK ON clicked on Ann's row: a mouse click leaves the focus on it,
   * and scrolling the box up to HELP MESSAGES to read does not move it. */
  const annNet = networkButton(ann.id);
  annNet.focus();
  documentRef.focusCalls.length = 0;
  /* Bob is renamed and only Bob's row repaints. Ann's row is left alone
   * and nothing is focused, so the box stays where the owner put it. */
  const bobNet = networkButton(bob.id);
  paint([ann, { ...bob, label: 'Robert' }]);
  assert.equal(networkButton(ann.id), annNet, "Ann's row was rebuilt");
  assert.notEqual(networkButton(bob.id), bobNet);
  assert.equal(documentRef.activeElement, annNet);
  assert.equal(documentRef.focusCalls.length, 0);
  /* Ann is renamed too: her row repaints and its new NETWORK ON gets the
   * focus back, with preventScroll so the box does not jump down to it. */
  paint([
    { ...ann, label: 'Annie' },
    { ...bob, label: 'Robert' },
  ]);
  const annFresh = networkButton(ann.id);
  assert.notEqual(annFresh, annNet);
  assert.equal(documentRef.activeElement, annFresh);
  assert.equal(documentRef.focusCalls.length, 1);
  assert.equal(documentRef.focusCalls[0].node, annFresh);
  assert.deepEqual(documentRef.focusCalls[0].options, { preventScroll: true });
  /* A row that goes away takes the focus with it; nothing else is focused. */
  documentRef.focusCalls.length = 0;
  paint([{ ...bob, label: 'Robert' }]);
  assert.equal(documentRef.activeElement, documentRef.body);
  assert.equal(documentRef.focusCalls.length, 0);
});

test('a call whose distance changes repaints only its own row, and a focused OPEN IN SMS or TEXT BACK keeps the focus', () => {
  const { documentRef, byId } = installFakeDocument();
  const running = release({ id: 'm-00000000000000e1', distanceKm: 1.23 });
  const ended = release({
    id: 'm-00000000000000e2',
    networkId: 'n-00000000000000e2',
    from: 'Ann',
    active: false,
    until: NOW - 60_000,
    distanceKm: 5.04,
  });
  const reply = message({ id: 'm-00000000000000e3', number: '+15065550111' });
  const plain = message({ id: 'm-00000000000000e4', text: 'Gate left open' });
  const paint = (changes = {}) =>
    applyUltraHelpStatus(documentRef, {
      unread: 4,
      inbox: [running, ended, reply, plain].map((row) => ({
        ...row,
        ...changes[row.id],
      })),
    });
  const rows = () => byId('ultra-inbox').children.slice();
  /* Node identity, not likeness: a rebuilt row looks the same. */
  const same = (now, then, which) =>
    which.forEach((at) => assert.equal(now[at], then[at], `row ${at}`));
  paint();
  const first = rows();
  const read = first[3].querySelector('[data-ultra-inbox-read]');
  /* The owner drives on and the call reads 1.3 KM: only its row is new, and
   * READ on the other message is the same node, so a press across the poll
   * still lands. */
  paint({ [running.id]: { distanceKm: 1.31 } });
  const second = rows();
  assert.notEqual(second[0], first[0]);
  assert.match(second[0].children[0].textContent, / · 1\.3 KM/);
  same(second, first, [1, 2, 3]);
  assert.ok(byId('ultra-inbox').contains(read));
  /* The ENDED call crosses a rounding step: again only its own row. */
  const moved = {
    [running.id]: { distanceKm: 1.31 },
    [ended.id]: { distanceKm: 5.12 },
  };
  paint(moved);
  const third = rows();
  assert.notEqual(third[1], second[1]);
  same(third, second, [0, 2, 3]);
  /* OPEN IN SMS focused from the keyboard on the running call: its row
   * repaints and the focus goes to the new link, without a scroll. */
  third[0].querySelector('[data-ultra-open-sms]').focus();
  documentRef.focusCalls.length = 0;
  moved[running.id] = { distanceKm: 1.42 };
  paint(moved);
  const openSms = rows()[0].querySelector('[data-ultra-open-sms]');
  assert.notEqual(rows()[0], third[0]);
  assert.equal(documentRef.activeElement, openSms);
  assert.deepEqual(documentRef.focusCalls[0]?.options, { preventScroll: true });
  /* TEXT BACK focused while its message is marked read: READ goes, the row
   * repaints, and the focus stays on TEXT BACK in the new row. */
  rows()[2].querySelector('[data-ultra-text-back]').focus();
  moved[reply.id] = { readAt: NOW };
  paint(moved);
  assert.equal(rows()[2].querySelector('[data-ultra-inbox-read]'), null);
  assert.equal(
    documentRef.activeElement,
    rows()[2].querySelector('[data-ultra-text-back]'),
  );
});

test('paint() strips `revealed` and `published` before storing `latest`, and the module never uses innerHTML', () => {
  const source = fs.readFileSync(
    new URL('./ultraHelpPanel.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /const \{ revealed, published, \.\.\.rest \} = status/);
  assert.match(source, /latest = rest;/);
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML/);
  assert.match(source, /status\.revealed === undefined\) return/);
  assert.match(source, /status\.published === undefined\) return/);
  assert.match(source, /revealed: null/);
  assert.match(source, /published: null/);
  /* The map is only ever nudged through the two device-feeds events. */
  assert.match(source, /DEVICE_FEEDS_CHANGED_EVENT/);
  assert.match(source, /DEVICE_FEEDS_FOCUS_EVENT/);
  assert.doesNotMatch(source, /trackById/);
});

test('Find Ultra Help is under development: a press asks the server nothing', async () => {
  const { documentRef, panel } = installFakeDocument();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      json: async () => ({
        unread: 0,
        inbox: [],
        tokens: [],
        network: network(),
      }),
    };
  };
  const handle = initUltraHelpPanel({
    documentRef,
    fetchImpl,
    windowRef: fakeWindow(),
  });
  try {
    await settle();
    urls.length = 0;
    panel.dispatch('click', { target: { id: 'ultra-find' } });
    await settle();
    assert.deepEqual(urls, []);
  } finally {
    handle.destroy();
  }
});

test('ultraNeedsLine counts the holders whose token carries the skill a call asks for', () => {
  const transport = { kind: 'transportation', destination: 'hospital' };
  const holders = [
    token({ skills: [{ code: 'tr', label: 'Transportation' }] }),
    token({ id: 't-2', skills: [] }),
  ];
  assert.equal(
    ultraNeedsLine(transport, holders),
    'Asks for Transportation: from current location to Hospital · 1 holder with that skill.',
  );
  assert.equal(
    ultraNeedsLine(transport, []),
    'Asks for Transportation: from current location to Hospital · 0 holders with that skill.',
  );
  assert.equal(
    ultraNeedsLine(transport, [
      ...holders,
      token({ id: 't-3', skills: ['Transportation'] }),
      token({ id: 't-4', skills: null }),
      null,
    ]),
    'Asks for Transportation: from current location to Hospital · 1 holder with that skill.',
  );
  /* Items name no skill: no holder count, whatever the holders carry. */
  assert.equal(
    ultraNeedsLine({ kind: 'items', items: ['Heart Defib'] }, holders),
    'Asks for Items: Heart Defib.',
  );
  assert.equal(ultraNeedsLine(null, holders), '');
  assert.equal(ultraNeedsLine({ kind: 'drone', items: ['x'] }, holders), '');

  /* The SEND HELP note carries the same line for the owner's default. */
  const { documentRef, byId } = installFakeDocument();
  applyUltraHelpStatus(documentRef, {
    tokens: [
      token({
        network: true,
        skills: [{ code: 'tr', label: 'Transportation' }],
      }),
      token({ id: 't-2', network: true, skills: [] }),
    ],
    position: { lat: 45.27, lon: -66.06 },
    contacts: [],
    ownerNeeds: transport,
    inbox: [],
  });
  assert.match(
    byId('ultra-release-note').textContent,
    / Asks for Transportation: from current location to Hospital · 1 holder with that skill\.$/,
  );
});

test('a sealed skill list this key cannot open reads as hidden, not as a token with no skill sets', () => {
  const { documentRef, byId } = installFakeDocument();
  const base = {
    helpBase: 'http://192.168.1.5:44173/ultra/help/',
    packages: [{ id: 'security-van', name: 'Van' }],
    inbox: [],
  };
  /* The key was replaced: the server says `hidden`, the store says so too,
   * and the rows still paint. */
  applyUltraHelpStatus(documentRef, {
    ...base,
    tokenStore: 'key-changed',
    tokens: [
      token({ encrypted: true, skills: [], hidden: true }),
      token({ id: 't-2', encrypted: true, skills: [], hidden: false }),
      token({ id: 't-3', encrypted: true, skills: [] }),
      token({
        id: 't-4',
        encrypted: true,
        skills: [{ code: 'dr', label: 'Doctor' }],
        hidden: false,
      }),
    ],
  });
  /* Four token rows, then RESET TOKENS: a replaced key is a store state. */
  const rows = byId('ultra-tokens').children;
  assert.equal(rows.length, 5);
  assert.equal(rows[4].children[0].textContent, 'RESET TOKENS');
  assert.match(
    rows[0].children[0].textContent,
    /· SKILLS HIDDEN \(KEY MISSING OR CHANGED\) · ENCRYPTED$/,
  );
  for (const row of rows.slice(1, 4)) {
    assert.doesNotMatch(row.children[0].textContent, /HIDDEN/);
  }
  assert.match(rows[1].children[0].textContent, /\d · ENCRYPTED$/);
  assert.match(rows[2].children[0].textContent, /\d · ENCRYPTED$/);
  assert.match(rows[3].children[0].textContent, /· Doctor · ENCRYPTED$/);
  assert.match(
    byId('ultra-token-note').textContent,
    /^The token key file was replaced: existing tokens still work but cannot be shown/,
  );

  /* An encrypted token minted with no skill sets, under a key that opens it,
   * says so without the hidden word. */
  applyUltraHelpStatus(documentRef, {
    ...base,
    tokenStore: 'ok',
    tokens: [token({ encrypted: true, skills: [] })],
  });
  const only = byId('ultra-tokens').children[0].children[0].textContent;
  assert.match(only, /· ENCRYPTED$/);
  assert.doesNotMatch(only, /HIDDEN/);

  /* The reveal box makes the same distinction. */
  const pre = byId('ultra-token-link');
  const sealed = 'uht1.' + 'A'.repeat(43) + '.e.sealed';
  applyUltraHelpStatus(documentRef, {
    revealed: {
      id: 't-1',
      label: 'Medic',
      token: sealed,
      address: 'https://van.tail9.ts.net',
      skills: [],
      encrypted: true,
      hidden: true,
    },
  });
  assert.match(
    pre.textContent,
    /\nSkills hidden: the token key is missing or was changed, so the sealed skill sets cannot be shown\nSkills encrypted in the token$/,
  );
  assert.doesNotMatch(pre.textContent, /No skill sets/);
  applyUltraHelpStatus(documentRef, {
    revealed: {
      id: 't-1',
      label: 'Medic',
      token: sealed,
      address: 'https://van.tail9.ts.net',
      skills: [],
      encrypted: true,
    },
  });
  assert.match(
    pre.textContent,
    /\nNo skill sets\nSkills encrypted in the token$/,
  );
  assert.doesNotMatch(pre.textContent, /hidden/);
  /* A hidden list never shows a skill name beside it. */
  applyUltraHelpStatus(documentRef, {
    revealed: {
      id: 't-1',
      label: 'Medic',
      token: sealed,
      address: '',
      skills: [{ code: 'dr', label: 'Doctor' }],
      encrypted: true,
      hidden: true,
    },
  });
  assert.doesNotMatch(pre.textContent, /Doctor/);
  assert.match(pre.textContent, /Skills hidden: the token key/);
});

/* The handout is two things, an address and a token: the token never sits
 * inside a URL, in the reveal, on the clipboard or in a request body. */
test('the reveal is a handout: labelled address and token lines, never a link', () => {
  const { documentRef, byId } = installFakeDocument();
  const box = byId('ultra-token-reveal');
  const pre = byId('ultra-token-link');
  applyUltraHelpStatus(documentRef, {
    revealed: {
      id: 't-1',
      label: 'Neighbour',
      token: TOKEN,
      address: 'https://van.tail9.ts.net',
      skills: [{ code: 'dr', label: 'Doctor' }],
    },
  });
  assert.equal(box.hidden, false);
  assert.equal(
    pre.textContent,
    `Neighbour:\nTailnet address: https://van.tail9.ts.net\nUltra Token: ${TOKEN}\nDoctor`,
  );
  assert.doesNotMatch(pre.textContent, /\/ultra\/help\//);
  assert.equal(box.dataset.ultraAddress, 'https://van.tail9.ts.net');
  assert.equal(box.dataset.ultraToken, TOKEN);
  assert.equal(box.dataset.ultraLink, undefined);
  /* A legacy answer that still carries `link` paints nothing of it. */
  applyUltraHelpStatus(documentRef, {
    revealed: {
      id: 't-1',
      label: 'Neighbour',
      token: TOKEN,
      address: '',
      link: `https://van.tail9.ts.net/ultra/help/${TOKEN}`,
    },
  });
  assert.doesNotMatch(pre.textContent, /\/ultra\/help\//);
  assert.doesNotMatch(pre.textContent, /Tailnet address:/);
  assert.match(pre.textContent, /^Neighbour:\nUltra Token: /);
  assert.equal(box.dataset.ultraAddress, undefined);
  assert.equal(box.dataset.ultraLink, undefined);
});

test('COPY ADDRESS copies only the address and COPY TOKEN only the token', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { documentRef, panel, byId } = installFakeDocument();
  const status = { unread: 0, inbox: [], tokens: [token()], packages: [] };
  const fetchImpl = async () => ({ ok: true, json: async () => status });
  const written = [];
  const navigatorBefore = Object.getOwnPropertyDescriptor(
    globalThis,
    'navigator',
  );
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text) => {
          written.push(text);
        },
      },
    },
  });
  const handle = initUltraHelpPanel({
    documentRef,
    fetchImpl,
    windowRef: fakeWindow(),
  });
  try {
    applyUltraHelpStatus(documentRef, {
      revealed: {
        id: 't-1',
        label: 'Neighbour',
        token: TOKEN,
        address: 'https://van.tail9.ts.net',
      },
    });
    const copyAddress = byId('ultra-token-copy-address');
    panel.dispatch('click', { target: copyAddress });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(written, ['https://van.tail9.ts.net']);
    assert.equal(copyAddress.textContent, 'COPIED');
    const copyToken = byId('ultra-token-copy');
    panel.dispatch('click', { target: copyToken });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(written, ['https://van.tail9.ts.net', TOKEN]);
    assert.equal(copyToken.textContent, 'COPIED');
    /* No address (Network off, or the listener down): nothing to copy. */
    applyUltraHelpStatus(documentRef, {
      revealed: { id: 't-1', label: 'Neighbour', token: TOKEN, address: '' },
    });
    panel.dispatch('click', { target: copyAddress });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(written.length, 2);
  } finally {
    handle.destroy();
    if (navigatorBefore) {
      Object.defineProperty(globalThis, 'navigator', navigatorBefore);
    } else {
      delete globalThis.navigator;
    }
  }
});

test('ADD TO HOME LIST posts address + token, refuses half a handout, and splits a legacy link locally', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { documentRef, panel, byId } = installFakeDocument();
  const status = {
    unread: 0,
    inbox: [],
    tokens: [],
    packages: [],
    contacts: [],
    network: network({ entries: [] }),
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => status };
  };
  const handle = initUltraHelpPanel({
    documentRef,
    fetchImpl,
    windowRef: fakeWindow(),
  });
  const submit = async () => {
    panel.dispatch('submit', { target: byId('ultra-network-add') });
    await settle();
  };
  try {
    await settle();
    /* Both boxes filled: the body is { add, address, token, name }. */
    byId('ultra-network-address').value = ' https://peer.tail9.ts.net/ ';
    byId('ultra-network-token').value = TOKEN;
    byId('ultra-network-link-name').value = 'Sam';
    calls.length = 0;
    await submit();
    assert.deepEqual(calls, [
      {
        url: '/api/ultra-help/network',
        body: {
          add: true,
          address: 'https://peer.tail9.ts.net/',
          token: TOKEN,
          name: 'Sam',
        },
      },
    ]);
    assert.equal(byId('ultra-network-address').value, '');
    assert.equal(byId('ultra-network-token').value, '');
    /* Half a handout is refused on the status line and never posted. */
    for (const [address, tokenValue] of [
      ['https://peer.tail9.ts.net', ''],
      ['', TOKEN],
      ['', ''],
    ]) {
      byId('ultra-network-address').value = address;
      byId('ultra-network-token').value = tokenValue;
      calls.length = 0;
      await submit();
      assert.deepEqual(calls, []);
      assert.equal(
        byId('ultra-status').textContent,
        'Enter their tailnet address (https://….ts.net) and their Ultra Token (uht1.…)',
      );
    }
    /* A legacy whole link in the address box with the token box empty is
     * split here: the server never sees the joined string. */
    byId('ultra-network-address').value =
      `https://peer.tail9.ts.net/ultra/help/${TOKEN}`;
    byId('ultra-network-token').value = '';
    byId('ultra-network-link-name').value = 'Sam';
    calls.length = 0;
    await submit();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {
      add: true,
      address: 'https://peer.tail9.ts.net',
      token: TOKEN,
      name: 'Sam',
    });
    assert.equal('link' in calls[0].body, false);
    assert.doesNotMatch(JSON.stringify(calls[0].body), /\/ultra\/help\//);
    /* A sealed token in a legacy link splits the same way. */
    const sealed = 'uht1.' + 'A'.repeat(43) + '.e.' + 'B'.repeat(40);
    byId('ultra-network-address').value =
      `http://100.64.3.9:44173/ultra/help/${sealed}/`;
    calls.length = 0;
    await submit();
    assert.deepEqual(calls[0].body, {
      add: true,
      address: 'http://100.64.3.9:44173',
      token: sealed,
      name: '',
    });
  } finally {
    handle.destroy();
  }
});

test('splitUltraHandout() only ever splits a legacy link with the token box empty', () => {
  const link = `https://peer.tail9.ts.net/ultra/help/${TOKEN}`;
  assert.deepEqual(splitUltraHandout(link, ''), {
    address: 'https://peer.tail9.ts.net',
    token: TOKEN,
  });
  assert.deepEqual(splitUltraHandout(` ${link}/ `, '  '), {
    address: 'https://peer.tail9.ts.net',
    token: TOKEN,
  });
  /* A token box already filled is left alone, whatever the address says. */
  assert.deepEqual(splitUltraHandout(link, TOKEN), {
    address: link,
    token: TOKEN,
  });
  /* A bare address, a path that is not a token, or no URL at all pass
   * through untouched for the server to judge. */
  assert.deepEqual(splitUltraHandout('https://peer.tail9.ts.net', ''), {
    address: 'https://peer.tail9.ts.net',
    token: '',
  });
  assert.deepEqual(
    splitUltraHandout('https://peer.tail9.ts.net/ultra/help/nope', ''),
    { address: 'https://peer.tail9.ts.net/ultra/help/nope', token: '' },
  );
  assert.deepEqual(splitUltraHandout('not a url', ''), {
    address: 'not a url',
    token: '',
  });
  assert.deepEqual(splitUltraHandout(undefined, null), {
    address: '',
    token: '',
  });
});

test('DISPLAY ULTRA ON MAP is the device layer switch, and the period picks how much path the map draws', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const windowRef = fakeWindow();
  let enabled = false;
  const listeners = new Set();
  const setCalls = [];
  const dataManager = {
    isEnabled: (id) => id === 'device-feeds' && enabled,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async setEnabled(id, on, options) {
      setCalls.push([id, on, options]);
      enabled = on;
      for (const fn of listeners) fn({ layerId: id });
      return true;
    },
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ unread: 0, inbox: [], tokens: [], packages: [] }),
  });
  const handle = initUltraHelpPanel({
    documentRef,
    fetchImpl,
    windowRef,
    dataManager,
  });
  try {
    await settle();
    const box = byId('ultra-map-show');
    assert.equal(box.checked, false, 'the layer is off');
    /* The layer comes on by itself (auto display): the box follows. */
    enabled = true;
    for (const fn of listeners) fn({ layerId: 'device-feeds' });
    assert.equal(box.checked, true);
    /* Unticked by its owner: switched off as a user choice. */
    box.checked = false;
    panel.dispatch('change', { target: box });
    await settle();
    assert.deepEqual(setCalls, [['device-feeds', false, { origin: 'user' }]]);
    assert.equal(box.checked, false);
    /* A period is passed to the map; an unknown one falls back to 30 days. */
    const period = byId('ultra-map-period');
    period.value = '24h';
    panel.dispatch('change', { target: period });
    period.value = 'forever';
    panel.dispatch('change', { target: period });
    assert.equal(period.value, '30d');
    assert.deepEqual(
      windowRef.dispatched.filter(
        (event) => event.type === DEVICE_FEEDS_HISTORY_EVENT,
      ),
      [
        { type: DEVICE_FEEDS_HISTORY_EVENT, detail: { period: '24h' } },
        { type: DEVICE_FEEDS_HISTORY_EVENT, detail: { period: '30d' } },
      ],
    );
    /* PRIVATE CCTV ON MAP switches the Private CCTV Cams layer the same way. */
    const privateBox = byId('ultra-private-cams');
    privateBox.checked = true;
    panel.dispatch('change', { target: privateBox });
    await settle();
    assert.deepEqual(setCalls.at(-1), [
      'private-cctv',
      true,
      { origin: 'user' },
    ]);
  } finally {
    handle.destroy();
  }
  assert.equal(listeners.size, 0, 'destroy stops watching the layer');
});

test('the Ultra box period list matches the map layer periods', () => {
  const html = fs.readFileSync(
    new URL('./ui/templates/layer-panels.html', import.meta.url),
    'utf8',
  );
  const select = html.slice(
    html.indexOf('id="ultra-map-period"'),
    html.indexOf('</select>', html.indexOf('id="ultra-map-period"')),
  );
  const values = [...select.matchAll(/<option value="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    values,
    DEVICE_HISTORY_PERIODS.map((period) => period.id),
  );
  assert.match(select, /<option value="30d" selected>/);
});

test('ULTRA CELLS: any number, each with its own ON MAP tick; SHOW ALL and + ADD ULTRA CELL', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const windowRef = fakeWindow();
  let enabled = false;
  const dataManager = {
    isEnabled: () => enabled,
    subscribe: () => () => {},
    async setEnabled(id, on) {
      enabled = on;
      return true;
    },
  };
  let packages = [
    {
      id: 'security-ann',
      name: 'Ann',
      mapId: 'device-security-ann',
      camLink: 'http://pc.example:44173/ultra/KEY-A/cam',
    },
    {
      id: 'security-bob',
      name: 'Bob',
      mapId: 'device-security-bob',
      camLink: '',
    },
  ];
  const posted = [];
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/device-feeds/config') {
      const body = JSON.parse(options.body);
      posted.push(body);
      packages = [
        ...packages,
        {
          id: 'security-cy',
          name: body.name,
          mapId: 'device-security-cy',
          camLink: '',
        },
      ];
      return { ok: true, json: async () => ({}) };
    }
    return {
      ok: true,
      json: async () => ({
        unread: 0,
        inbox: [],
        tokens: [],
        packages,
        editable: true,
      }),
    };
  };
  const handle = initUltraHelpPanel({
    documentRef,
    fetchImpl,
    windowRef,
    dataManager,
  });
  const inputs = () => byId('ultra-cells').querySelectorAll('input');
  const ticks = () =>
    inputs()
      .filter((box) => box.dataset.ultraCellMap)
      .map((box) => [box.dataset.ultraCellMap, box.checked]);
  const pathTicks = () =>
    inputs()
      .filter((box) => box.dataset.ultraCellPath)
      .map((box) => [box.dataset.ultraCellPath, box.checked]);
  const button = (action, cellId) =>
    byId('ultra-cells')
      .querySelectorAll('button')
      .find(
        (item) =>
          item.dataset.ultraCellAction === action &&
          item.dataset.ultraCellId === cellId,
      );
  const visible = () =>
    windowRef.dispatched
      .filter((event) => event.type === DEVICE_FEEDS_VISIBLE_EVENT)
      .map((event) => event.detail.hidden);
  try {
    await settle();
    assert.deepEqual(ticks(), [
      ['device-security-ann', true],
      ['device-security-bob', true],
    ]);
    assert.equal(byId('ultra-cells-count').textContent, '· 2');
    assert.equal(
      byId('ultra-cells').querySelectorAll('a').length,
      0,
      'no phone link button in the rows',
    );
    /* Ann alone: Bob is left off the map. */
    const bob = inputs().find(
      (box) => box.dataset.ultraCellMap === 'device-security-bob',
    );
    bob.checked = false;
    panel.dispatch('change', { target: bob });
    assert.deepEqual(visible(), [['device-security-bob']]);
    assert.deepEqual(ticks()[1], ['device-security-bob', false]);
    /* Ann without her path. */
    const annPath = inputs().find(
      (box) => box.dataset.ultraCellPath === 'device-security-ann',
    );
    annPath.checked = false;
    panel.dispatch('change', { target: annPath });
    assert.deepEqual(
      windowRef.dispatched
        .filter((event) => event.type === DEVICE_FEEDS_VISIBLE_EVENT)
        .at(-1).detail,
      { hidden: ['device-security-bob'], noPath: ['device-security-ann'] },
    );
    assert.deepEqual(pathTicks(), [
      ['device-security-ann', false],
      ['device-security-bob', true],
    ]);
    /* ONLY Bob: Ann leaves the map. */
    panel.dispatch('click', { target: button('only', 'device-security-bob') });
    assert.deepEqual(visible().at(-1), ['device-security-ann']);
    /* MAP Ann: back on the map, then the map flies to her. */
    panel.dispatch('click', { target: button('map', 'device-security-ann') });
    assert.deepEqual(visible().at(-1), []);
    assert.deepEqual(windowRef.dispatched.at(-1), {
      type: DEVICE_FEEDS_FOCUS_EVENT,
      detail: { id: 'device-security-ann' },
    });
    /* SHOW ALL: every cell and every path together, and the layer is on. */
    panel.dispatch('click', { target: byId('ultra-cells-all') });
    await settle();
    assert.deepEqual(visible().at(-1), []);
    assert.deepEqual(
      pathTicks().map(([, on]) => on),
      [true, true],
    );
    assert.equal(enabled, true);
    /* A third cell is added from the box; it is not the one the map follows. */
    byId('ultra-cell-name').value = 'Cy';
    panel.dispatch('submit', {
      target: byId('ultra-cell-add'),
      preventDefault() {},
    });
    await settle();
    await settle();
    assert.deepEqual(posted, [
      {
        kind: 'security',
        name: 'Cy',
        method: 'report-in',
        follow: false,
        record: true,
      },
    ]);
    assert.equal(byId('ultra-cell-name').value, '');
    assert.equal(ticks().length, 3);
  } finally {
    handle.destroy();
  }
});

test('RECORD WITHIN: each Ultra cell chooses how far around it is recorded, up to 50 km, or not at all', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const windowRef = fakeWindow();
  let packages = [
    {
      id: 'security-ann',
      name: 'Ann',
      mapId: 'device-security-ann',
      method: 'report-in',
      record: true,
      recordKm: 10,
    },
    {
      id: 'security-bob',
      name: 'Bob',
      mapId: 'device-security-bob',
      method: 'report-in',
      record: true,
      recordKm: null,
    },
  ];
  const posted = [];
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/device-feeds/config') {
      const body = JSON.parse(options.body);
      posted.push(body);
      packages = packages.map((cell) =>
        cell.id === body.id
          ? {
              ...cell,
              record: body.record,
              recordKm: body.recordKm ?? cell.recordKm,
            }
          : cell,
      );
      return { ok: true, json: async () => ({}) };
    }
    return {
      ok: true,
      json: async () => ({
        unread: 0,
        inbox: [],
        tokens: [],
        packages,
        editable: true,
      }),
    };
  };
  const handle = initUltraHelpPanel({ documentRef, fetchImpl, windowRef });
  const selects = () =>
    byId('ultra-cells')
      .querySelectorAll('select')
      .filter((select) => select.dataset.ultraCellRecord);
  try {
    await settle();
    assert.deepEqual(
      selects().map((select) => [select.dataset.ultraCellRecord, select.value]),
      [
        ['security-ann', '10'],
        ['security-bob', '50'],
      ],
    );
    assert.deepEqual(
      selects()[0]
        .children.map((option) => option.textContent)
        .slice(0, 3),
      ['Record off', 'Record within 1 km', 'Record within 2 km'],
    );
    assert.equal(
      selects()[0].children.at(-1).textContent,
      'Record within 50 km',
    );
    /* Ann records within 25 km. */
    selects()[0].value = '25';
    panel.dispatch('change', { target: selects()[0] });
    await settle();
    await settle();
    /* Bob records nothing. */
    selects()[1].value = 'off';
    panel.dispatch('change', { target: selects()[1] });
    await settle();
    await settle();
    assert.deepEqual(posted, [
      {
        id: 'security-ann',
        kind: 'security',
        name: 'Ann',
        method: 'report-in',
        record: true,
        recordKm: 25,
      },
      {
        id: 'security-bob',
        kind: 'security',
        name: 'Bob',
        method: 'report-in',
        record: false,
      },
    ]);
    assert.deepEqual(
      selects().map((select) => select.value),
      ['25', 'off'],
    );
  } finally {
    handle.destroy();
  }
});

test('the photos and videos list: newest first, each with an OPEN link to its own file', () => {
  const made = [];
  const element = () => {
    const node = {
      dataset: {},
      children: [],
      textContent: '',
      appendChild(child) {
        node.children.push(child);
      },
    };
    made.push(node);
    return node;
  };
  const list = { rows: [], replaceChildren: (...rows) => (list.rows = rows) };
  const documentRef = {
    getElementById: (id) => (id === 'ultra-media' ? list : null),
    createElement: element,
  };
  paintMedia(documentRef, [
    {
      name: 'clip-20261008T120000Z-2.webm',
      kind: 'clip',
      at: Date.UTC(2026, 9, 8, 12),
      bytes: 3_500_000,
    },
    {
      name: 'photo-20261008T115900Z-1.jpg',
      kind: 'photo',
      at: Date.UTC(2026, 9, 8, 11, 59),
      bytes: 40_000,
    },
  ]);
  assert.equal(list.rows.length, 2);
  const [tick, label, view, open] = list.rows[0].children;
  assert.deepEqual(
    [
      view.textContent,
      view.dataset.ultraMediaView,
      view.dataset.ultraMediaKind,
    ],
    ['CCTV', 'clip-20261008T120000Z-2.webm', 'clip'],
  );
  assert.equal(view.className, 'ultra-media-view', 'the small CCTV button');
  assert.equal(tick.type, 'checkbox');
  assert.equal(tick.dataset.ultraMediaName, 'clip-20261008T120000Z-2.webm');
  assert.match(label.textContent, /^VIDEO · .* · 3\.3 MB$/);
  assert.equal(open.textContent, 'OPEN');
  assert.equal(open.href, '/api/ultra-help/media/clip-20261008T120000Z-2.webm');
  assert.equal(open.target, '_blank');
  assert.match(list.rows[1].children[1].textContent, /^PHOTO · .* · <0\.1 MB$/);
});

test('DELETE: the ticked photos and videos, or every one with All ticked, after a second press', async () => {
  const { documentRef, panel, byId } = installFakeDocument();
  const add = (tag, id) => {
    const node = documentRef.createElement(tag);
    node.id = id;
    panel.appendChild(node);
    return node;
  };
  add('ul', 'ultra-media');
  const all = add('input', 'ultra-media-delete-all');
  const button = add('button', 'ultra-media-delete');
  let items = [
    { name: 'photo-20261008T120000Z-1.jpg', kind: 'photo', at: 2, bytes: 9 },
    { name: 'clip-20261008T120100Z-2.webm', kind: 'clip', at: 1, bytes: 9 },
    { name: 'photo-20261007T120000Z-3.jpg', kind: 'photo', at: 0, bytes: 9 },
  ];
  const deletes = [];
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/ultra-help/media')
      return { ok: true, json: async () => ({ items }) };
    if (url === '/api/ultra-help/media/delete') {
      const body = JSON.parse(options.body);
      deletes.push(body);
      const gone = body.all ? items.map((i) => i.name) : body.names;
      items = items.filter((item) => !gone.includes(item.name));
      return { ok: true, json: async () => ({ deleted: gone, items }) };
    }
    return { ok: true, json: async () => ({ tokens: [], packages: [] }) };
  };
  const handle = initUltraHelpPanel({
    documentRef,
    fetchImpl,
    windowRef: fakeWindow(),
  });
  try {
    await settle();
    await settle();
    // The newest photo and the newest video are ticked on a first visit.
    assert.equal(button.textContent, 'DELETE TICKED 2');
    assert.equal(button.disabled, false);
    panel.dispatch('click', { target: button });
    assert.equal(button.textContent, 'SURE? DELETE 2');
    assert.deepEqual(deletes, [], 'the first press only asks');
    panel.dispatch('click', { target: button });
    await settle();
    await settle();
    assert.deepEqual(deletes, [
      {
        names: ['photo-20261008T120000Z-1.jpg', 'clip-20261008T120100Z-2.webm'],
      },
    ]);
    assert.deepEqual(
      items.map((item) => item.name),
      ['photo-20261007T120000Z-3.jpg'],
    );
    // All ticked: every one, whether ticked or not.
    all.checked = true;
    panel.dispatch('change', { target: all });
    assert.equal(button.textContent, 'DELETE ALL 1');
    panel.dispatch('click', { target: button });
    panel.dispatch('click', { target: button });
    await settle();
    await settle();
    assert.deepEqual(deletes.at(-1), { all: true });
    assert.deepEqual(items, []);
    assert.equal(all.checked, false, 'All is unticked after a delete');
    assert.equal(button.disabled, true);
  } finally {
    handle.destroy();
  }
});

test('PHOTOS ON MAP and VIDEOS ON MAP: unticked, that kind leaves the map; the list keeps it', async () => {
  const { documentRef, panel } = installFakeDocument();
  const add = (tag, id, extra = {}) => {
    const node = documentRef.createElement(tag);
    node.id = id;
    Object.assign(node, extra);
    panel.appendChild(node);
    return node;
  };
  const list = add('ul', 'ultra-media');
  const photosBox = add('input', 'ultra-photos-on-map', { checked: true });
  const videosBox = add('input', 'ultra-videos-on-map', { checked: true });
  const photoPos = add('span', 'ultra-photo-pos');
  const items = [
    { name: 'photo-20261008T120000Z-1.jpg', kind: 'photo', at: 2, bytes: 9 },
    { name: 'clip-20261008T120100Z-2.webm', kind: 'clip', at: 1, bytes: 9 },
  ];
  const fetchImpl = async (url) =>
    url === '/api/ultra-help/media'
      ? { ok: true, json: async () => ({ items }) }
      : { ok: true, json: async () => ({ tokens: [], packages: [] }) };
  const windowRef = fakeWindow();
  const media = () =>
    windowRef.dispatched
      .filter((event) => event.type === 'gev:ultra-media')
      .at(-1)?.detail;
  const handle = initUltraHelpPanel({ documentRef, fetchImpl, windowRef });
  try {
    await settle();
    await settle();
    assert.deepEqual(
      [media().photos, media().videos],
      [[items[0].name], [items[1].name]],
    );
    photosBox.checked = false;
    panel.dispatch('change', { target: photosBox });
    assert.deepEqual([media().photos, media().videos], [[], [items[1].name]]);
    assert.equal(photoPos.textContent, 'ALL 1', 'still counted');
    assert.equal(list.children.length, 2, 'still listed, CCTV still shows it');
    videosBox.checked = false;
    panel.dispatch('change', { target: videosBox });
    assert.deepEqual([media().photos, media().videos], [[], []]);
    photosBox.checked = true;
    panel.dispatch('change', { target: photosBox });
    assert.deepEqual(media().photos, [items[0].name]);
  } finally {
    handle.destroy();
  }
});
