// ULTRA SECURITY PACKAGE moved from POWER UP to the bottom of the Ultra tab
// (owner request 2026-10-17): the template, both copies of the device cards,
// and the Ultra panel that mounts the package's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyDeviceFeedUpdate,
  deviceFeedStatus,
  emptyDeviceFeedConfig,
} from './deviceFeedsCore.mjs';
import {
  DEVICE_FEEDS_CHANGED_EVENT,
  DEVICE_FEED_LOOKS,
  ULTRA_PACKAGE_KIND,
  deviceFeedCardsKey,
  initDeviceFeedSetup,
} from './deviceFeedsSetup.js';
import { initUltraHelpPanel } from './ultraHelpPanel.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.id = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.text = '';
  }

  get textContent() {
    return this.tagName === '#TEXT'
      ? this.text
      : this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    if (String(value ?? '')) this.append(String(value));
  }

  get childElementCount() {
    return this.children.filter((child) => child.tagName !== '#TEXT').length;
  }

  append(...nodes) {
    for (const node of nodes) {
      const child =
        typeof node === 'string'
          ? Object.assign(new FakeElement('#text'), { text: node })
          : node;
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(
      (child) => child !== this,
    );
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter((item) => item !== listener),
    );
  }

  async fire(type) {
    for (const listener of this.listeners.get(type) || [])
      await listener({ target: this });
  }

  focus() {}

  all(match, out = []) {
    for (const child of this.children) {
      if (child.tagName === '#TEXT') continue;
      if (match(child)) out.push(child);
      child.all(match, out);
    }
    return out;
  }

  querySelectorAll(selector) {
    const tags = selector.split(',').map((part) => part.trim().toUpperCase());
    return this.all((node) => tags.includes(node.tagName));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

const documentRef = { createElement: (tag) => new FakeElement(tag) };
const classes = (node) => node.className.split(' ').filter(Boolean);
const byClass = (root, name) =>
  root.all((node) => classes(node).includes(name));
const field = (root, name) =>
  root.all((node) => node.dataset.field === name)[0];
const settle = async () => {
  for (let i = 0; i < 6; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};
const POWER_UP_ONLY = (kind) => kind.id !== ULTRA_PACKAGE_KIND;
const PACKAGE_ONLY = (kind) => kind.id === ULTRA_PACKAGE_KIND;

/** A server in miniature: the real rules, an in-memory store. */
function fakeServer() {
  let config = emptyDeviceFeedConfig();
  const posts = [];
  let statusReads = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/device-feeds/status') {
      statusReads += 1;
      return Response.json({ ...deviceFeedStatus(config), editable: true });
    }
    if (url !== '/api/device-feeds/config')
      return new Response('{}', { status: 404 });
    const body = JSON.parse(options.body);
    posts.push(body);
    const result = applyDeviceFeedUpdate(body, config);
    if (!result.ok)
      return Response.json({ error: result.error }, { status: 400 });
    config = result.config;
    return Response.json({
      status: { ...deviceFeedStatus(config), editable: true },
      feedId: result.feedId,
    });
  };
  return { fetchImpl, posts, reads: () => statusReads };
}

/** A window that delivers the device event to every copy listening. */
function fakeWindow() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
  };
}

function withWindow(t, windowRef) {
  const previous = globalThis.window;
  globalThis.window = windowRef;
  t.after(() => {
    globalThis.window = previous;
  });
}

test('the Ultra tab ends with the package cards, hidden until the server answers', () => {
  const html = readFileSync(
    new URL('./ui/templates/layer-panels.html', import.meta.url),
    'utf8',
  );
  const start = html.indexOf('<div id="ultra-panel"');
  const end = html.indexOf('<div id="social-panel"');
  assert.ok(start >= 0 && end > start);
  const panel = html.slice(start, end);
  const host =
    '<div id="ultra-package-setup" class="ultra-package-setup" hidden></div>';
  assert.equal(panel.split(host).length, 2, 'one package host, in the tab');
  assert.ok(
    panel.indexOf(host) > panel.indexOf('id="ultra-sms-test"'),
    'after the last row (TEST SMS)',
  );
  // Nothing but the closing of the tab's inner box and the tab follows it.
  const after = panel
    .slice(panel.indexOf(host) + host.length)
    .replace(/<!--[^]*?-->/g, '');
  assert.deepEqual(after.match(/<[a-z/][^>]*>/gi), ['</div>', '</div>']);
});

test('POWER UP leaves the package to the Ultra tab', async (t) => {
  withWindow(t, fakeWindow());
  const source = readFileSync(
    new URL('./keySetup.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /showKind: \(kind\) => kind\.id !== ULTRA_PACKAGE_KIND/);
  const server = fakeServer();
  const host = new FakeElement('div');
  let sections = null;
  initDeviceFeedSetup({
    host,
    documentRef,
    fetchImpl: server.fetchImpl,
    showKind: POWER_UP_ONLY,
    onSections: (list) => {
      sections = list;
    },
  });
  await settle();
  assert.deepEqual(
    byClass(host, 'device-feeds-kind').map((card) => card.dataset.kindId),
    ['drone', 'robot', 'marine', 'tracker'],
  );
  assert.deepEqual(
    sections.map((section) => section.id),
    ['devices-drone', 'devices-robot', 'devices-marine', 'devices-tracker'],
    'the dashboard chip no longer counts the package',
  );
  assert.match(host.textContent, /YOUR DEVICES · PRIVATE TO THIS MACHINE/);
});

test('the Ultra tab draws the package in its own look, with every control and save POWER UP had', async (t) => {
  withWindow(t, fakeWindow());
  const mount = async (look) => {
    const server = fakeServer();
    const host = new FakeElement('div');
    initDeviceFeedSetup({
      host,
      documentRef,
      fetchImpl: server.fetchImpl,
      showKind: PACKAGE_ONLY,
      look,
    });
    await settle();
    return { host, server };
  };
  const before = await mount('power-up');
  const ultra = await mount('ultra');

  const [section] = ultra.host.children;
  assert.equal(ultra.host.childElementCount, 1, 'the package section alone');
  assert.equal(section.dataset.kindId, 'security');
  const [heading, unlocks, privacy] = section.children;
  assert.equal(heading.className, 'cctv-summary-label');
  assert.match(heading.textContent, /^ULTRA SECURITY PACKAGE none added$/);
  assert.deepEqual(
    [classes(unlocks), classes(privacy)],
    [['ultra-note'], ['ultra-note']],
  );
  assert.match(privacy.textContent, /never part of a share link/);

  // No POWER UP card class reaches the tab: those are styled page-wide.
  const add = byClass(ultra.host, 'ultra-package-add')[0];
  assert.deepEqual(classes(add), ['scene-btn', 'ultra-package-add']);
  await add.fire('click');
  await byClass(before.host, 'private-cams-add')[0].fire('click');
  const foreign = ultra.host.all((node) =>
    classes(node).some((name) =>
      /^(device-feeds|private-cams|key-setup)-/.test(name),
    ),
  );
  assert.deepEqual(foreign, []);

  // The same controls, in the same order, with the same choices and words.
  const block = byClass(ultra.host, 'ultra-package')[0];
  const oldBlock = byClass(before.host, 'device-feeds-feed')[0];
  const controls = (root) =>
    root
      .all((node) =>
        ['INPUT', 'SELECT', 'BUTTON', 'OPTION'].includes(node.tagName),
      )
      .map((node) => [
        node.tagName,
        node.dataset.field || '',
        node.tagName === 'OPTION' ? node.value : '',
        node.tagName === 'BUTTON' ? node.textContent : '',
        node.hidden,
      ]);
  assert.deepEqual(controls(block), controls(oldBlock));
  assert.equal(field(block, 'follow'), undefined, 'the tab holds FOLLOW');
  for (const button of byClass(block, 'scene-btn'))
    assert.ok(
      ['SAVE PACKAGE', 'DISCARD', 'NEW KEY'].includes(button.textContent),
    );

  // A save posts exactly what POWER UP's card posted.
  for (const [root, save] of [
    [block, 'ultra-package-save'],
    [oldBlock, 'private-cams-save'],
  ]) {
    field(root, 'name').value = 'Ann';
    await byClass(root, save)[0].fire('click');
  }
  await settle();
  assert.deepEqual(ultra.server.posts, before.server.posts);
  assert.equal(ultra.server.posts[0].kind, 'security');
  assert.deepEqual(
    [ultra.server.posts[0].follow, ultra.server.posts[0].record],
    [true, true],
    'a new package follows and records, as before',
  );
  // Drawn again from the answer: the saved package and its report-in lines.
  const saved = byClass(ultra.host, 'ultra-package')[0];
  assert.equal(field(saved, 'name').value, 'Ann');
  const lines = byClass(saved, 'ultra-package-report-lines')[0].textContent;
  assert.match(lines, /PHONE LINK/);
  assert.match(lines, /TRACCAR CLIENT/);
  assert.equal(
    byClass(saved, 'ultra-package-remove')[0].textContent,
    'REMOVE PACKAGE',
  );
});

test('a save in one copy redraws the other only when its cards change', async (t) => {
  const windowRef = fakeWindow();
  withWindow(t, windowRef);
  const server = fakeServer();
  const powerUp = new FakeElement('div');
  const tab = new FakeElement('div');
  const first = initDeviceFeedSetup({
    host: powerUp,
    documentRef,
    fetchImpl: server.fetchImpl,
    showKind: POWER_UP_ONLY,
  });
  const second = initDeviceFeedSetup({
    host: tab,
    documentRef,
    fetchImpl: server.fetchImpl,
    showKind: PACKAGE_ONLY,
    look: 'ultra',
  });
  await settle();
  assert.equal(windowRef.listeners.get(DEVICE_FEEDS_CHANGED_EVENT).size, 2);

  // A followed drone, saved in POWER UP: the tab reads the status again, but
  // its package cards did not change, so nothing is redrawn there.
  const drone = byClass(powerUp, 'device-feeds-kind').find(
    (card) => card.dataset.kindId === 'drone',
  );
  await byClass(drone, 'private-cams-add')[0].fire('click');
  const droneBlock = byClass(drone, 'device-feeds-feed')[0];
  field(droneBlock, 'name').value = 'Hawk';
  field(droneBlock, 'method').value = 'http-json';
  await field(droneBlock, 'method').fire('change');
  field(droneBlock, 'url').value = 'https://drone.example/position';
  field(droneBlock, 'follow').checked = true;
  const tabSection = tab.children[0];
  const reads = server.reads();
  await byClass(droneBlock, 'private-cams-save')[0].fire('click');
  await settle();
  assert.equal(server.reads(), reads + 1, 'only the other copy reads again');
  assert.equal(tab.children[0], tabSection, 'the tab kept what it had drawn');

  // A new package from the tab takes the follow: POWER UP redraws its drone.
  await byClass(tab, 'ultra-package-add')[0].fire('click');
  const block = byClass(tab, 'ultra-package')[0];
  field(block, 'name').value = 'Ann';
  await byClass(block, 'ultra-package-save')[0].fire('click');
  await settle();
  const redrawn = byClass(powerUp, 'device-feeds-kind').find(
    (card) => card.dataset.kindId === 'drone',
  );
  assert.notEqual(redrawn, drone, 'POWER UP drew its cards again');
  assert.equal(field(redrawn, 'follow').checked, false, 'the follow moved');
  assert.equal(
    byClass(tab, 'ultra-package-count')[0].textContent,
    '1 device · 0 live',
  );

  first.destroy();
  second.destroy();
  assert.equal(windowRef.listeners.get(DEVICE_FEEDS_CHANGED_EVENT).size, 0);
});

test('a device going live or recording more is no reason to redraw', () => {
  const status = deviceFeedStatus(emptyDeviceFeedConfig());
  const kinds = status.kinds.map((kind) =>
    kind.id === 'security'
      ? {
          ...kind,
          feeds: [
            {
              id: 'a',
              name: 'Ann',
              follow: true,
              state: null,
              recording: null,
            },
          ],
        }
      : kind,
  );
  const quiet = { ...status, kinds };
  const live = {
    ...status,
    kinds: kinds.map((kind) =>
      kind.id === 'security'
        ? {
            ...kind,
            feeds: [
              {
                ...kind.feeds[0],
                state: { ok: true },
                recording: { files: 2, bytes: 9 },
              },
            ],
          }
        : kind,
    ),
  };
  const renamed = {
    ...status,
    kinds: kinds.map((kind) =>
      kind.id === 'security'
        ? { ...kind, feeds: [{ ...kind.feeds[0], name: 'Bea' }] }
        : kind,
    ),
  };
  assert.equal(
    deviceFeedCardsKey(quiet, PACKAGE_ONLY),
    deviceFeedCardsKey(live, PACKAGE_ONLY),
  );
  assert.notEqual(
    deviceFeedCardsKey(quiet, PACKAGE_ONLY),
    deviceFeedCardsKey(renamed, PACKAGE_ONLY),
  );
  assert.equal(
    deviceFeedCardsKey(quiet, POWER_UP_ONLY),
    deviceFeedCardsKey(renamed, POWER_UP_ONLY),
    'POWER UP does not draw the package',
  );
});

test('the Ultra panel mounts the package cards at its bottom and ends them with itself', async (t) => {
  const windowRef = fakeWindow();
  withWindow(t, windowRef);
  const panel = new FakeElement('div');
  panel.id = 'ultra-panel';
  const host = new FakeElement('div');
  host.id = 'ultra-package-setup';
  host.hidden = true;
  panel.append(host);
  const page = {
    body: panel,
    activeElement: panel,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) =>
      ({ 'ultra-panel': panel, 'ultra-package-setup': host })[id] || null,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const server = fakeServer();
  const ultra = initUltraHelpPanel({
    documentRef: page,
    fetchImpl: server.fetchImpl,
    windowRef,
  });
  t.after(() => ultra.destroy());
  await settle();
  assert.equal(host.hidden, false, 'shown once /api/device-feeds answers');
  const [section] = host.children;
  assert.equal(section.dataset.kindId, ULTRA_PACKAGE_KIND);
  assert.deepEqual(
    classes(section),
    classes({ className: DEVICE_FEED_LOOKS.ultra.kind }),
  );
  ultra.destroy();
  assert.equal(host.childElementCount, 0, 'the tab ends the cards with itself');
});
