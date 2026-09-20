import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyDeviceFeedUpdate, deviceFeedStatus, emptyDeviceFeedConfig } from './deviceFeedsCore.mjs';
import {
  DEVICE_FEEDS_CHANGED_EVENT,
  collectDeviceFeedUpdate,
  deviceFeedCountText,
  deviceFeedStateText,
  initDeviceFeedSetup,
} from './deviceFeedsSetup.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.text = '';
  }

  get textContent() {
    return this.tagName === '#TEXT' ? this.text : this.children.map((child) => child.textContent).join('');
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
      const child = typeof node === 'string' ? Object.assign(new FakeElement('#text'), { text: node }) : node;
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  async fire(type) {
    for (const listener of this.listeners.get(type) || []) await listener({ target: this });
  }

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
const byClass = (root, name) => root.all((node) => node.className.split(' ').includes(name));
const field = (root, name) => root.all((node) => node.dataset.field === name)[0];
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A server in miniature: the real rules, an in-memory store. */
function fakeServer({ editable = true } = {}) {
  let config = emptyDeviceFeedConfig();
  const posts = [];
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/device-feeds/status') return new Response(JSON.stringify({ ...deviceFeedStatus(config), editable }), { status: 200 });
    const body = JSON.parse(options.body);
    posts.push(body);
    const result = applyDeviceFeedUpdate(body, config);
    if (!result.ok) return new Response(JSON.stringify({ error: result.error }), { status: 400 });
    config = result.config;
    return new Response(JSON.stringify({ status: { ...deviceFeedStatus(config), editable }, feedId: result.feedId }), { status: 200 });
  };
  return { fetchImpl, posts, config: () => config };
}

test('the POST body keeps what was not typed', () => {
  const kept = collectDeviceFeedUpdate('drone', 'drone-a', { name: ' Scout ', method: 'http-json', auth: 'bearer', url: '', pictureUrl: 'none', password: '', token: '', lat: '', lon: '' });
  assert.deepEqual(kept, { kind: 'drone', name: 'Scout', method: 'http-json', auth: 'bearer', id: 'drone-a', pictureUrl: null, lat: null, lon: null });
  const typed = collectDeviceFeedUpdate('tracker', '', { name: 'Van', method: 'traccar', url: ' https://g.example/ ', token: 'k', keyName: 'key', auth: 'query', lat: '45.2', lon: '-66' });
  assert.deepEqual(typed, { kind: 'tracker', name: 'Van', method: 'traccar', auth: 'query', url: 'https://g.example/', keyName: 'key', token: 'k', lat: 45.2, lon: -66 });
});

test('card text', () => {
  assert.equal(deviceFeedCountText({ feeds: [] }), 'none added');
  assert.equal(deviceFeedCountText({ feeds: [{ state: { ok: true } }] }), '1 device · 1 live');
  assert.equal(deviceFeedCountText({ feeds: [{ state: { ok: true } }, { state: null }, {}] }), '3 devices · 1 live');
  assert.equal(deviceFeedStateText({ state: { ok: true } }), 'LIVE · position received');
  assert.equal(deviceFeedStateText({ state: { ok: false, error: 'HTTP 401' } }), 'NO POSITION · HTTP 401');
  assert.equal(deviceFeedStateText({ urlSet: true }), 'Not asked yet');
  assert.equal(deviceFeedStateText({ pictureSet: true }), 'Picture only');
});

test('one card per kind; add, save, and the saved login is never shown', async () => {
  const server = fakeServer();
  const host = new FakeElement('div');
  const events = [];
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  try {
    initDeviceFeedSetup({ host, documentRef, fetchImpl: server.fetchImpl });
    await settle();
    const cards = byClass(host, 'device-feeds-kind');
    assert.deepEqual(cards.map((card) => card.dataset.kindId), ['drone', 'robot', 'marine', 'tracker', 'security']);
    assert.ok(cards.every((card) => card.dataset.set === 'false'));

    const marine = cards[2];
    await byClass(marine, 'private-cams-add')[0].fire('click');
    const block = byClass(marine, 'device-feeds-feed')[0];
    const method = field(block, 'method');
    const groups = method.children.filter((child) => child.tagName === 'OPTGROUP');
    assert.equal(groups.length, 2, 'direct methods, then the ones that need a bridge');
    assert.ok(groups[1].children.some((option) => option.value === 'ais'));
    assert.deepEqual(field(block, 'auth').children.map((option) => option.value), ['none', 'basic', 'bearer', 'header', 'query']);

    // A bridge-only method explains itself and cannot be saved.
    const save = byClass(block, 'private-cams-save')[0];
    method.value = 'nmea-tcp';
    await method.fire('change');
    const note = byClass(block, 'device-feeds-bridge')[0];
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /cannot speak .* directly/);
    assert.equal(save.disabled, true);
    assert.equal(field(block, 'url').hidden, true);

    method.value = 'signalk';
    await method.fire('change');
    assert.deepEqual([note.hidden, save.disabled, field(block, 'url').hidden], [true, false, false]);

    // Only the chosen login's boxes show.
    const auth = field(block, 'auth');
    assert.deepEqual(['username', 'password', 'keyName', 'token'].map((name) => field(block, name).hidden), [true, true, true, true]);
    auth.value = 'basic';
    await auth.fire('change');
    assert.deepEqual(['username', 'password', 'keyName', 'token'].map((name) => field(block, name).hidden), [false, false, true, true]);

    field(block, 'name').value = 'USV One';
    field(block, 'url').value = 'https://boat.example.com/';
    field(block, 'username').value = 'cap';
    field(block, 'password').value = 'hunter2';
    await save.fire('click');
    await settle();

    assert.equal(server.config().feeds[0].password, 'hunter2');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, DEVICE_FEEDS_CHANGED_EVENT);
    assert.equal(events[0].detail.count, 1);

    const saved = byClass(host, 'device-feeds-kind')[2];
    assert.equal(saved.dataset.set, 'true');
    const savedBlock = byClass(saved, 'device-feeds-feed')[0];
    assert.deepEqual([field(savedBlock, 'password').value, field(savedBlock, 'url').value], ['', '']);
    assert.equal(field(savedBlock, 'password').placeholder, 'PASSWORD (SAVED)');
    assert.match(field(savedBlock, 'url').placeholder, /^SAVED: https:\/\/boat\.example\.com/);
    assert.ok(!JSON.stringify(savedBlock, (key, value) => (key === 'parentElement' || key === 'listeners' ? undefined : value)).includes('hunter2'));

    // A rename leaves the address and the login alone.
    field(savedBlock, 'name').value = 'USV Uno';
    await byClass(savedBlock, 'private-cams-save')[0].fire('click');
    await settle();
    const feed = server.config().feeds[0];
    assert.deepEqual([feed.name, feed.url, feed.username, feed.password], ['USV Uno', 'https://boat.example.com/', 'cap', 'hunter2']);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('a refused save says why and can be tried again', async () => {
  const server = fakeServer();
  const host = new FakeElement('div');
  initDeviceFeedSetup({ host, documentRef, fetchImpl: server.fetchImpl });
  await settle();
  const tracker = byClass(host, 'device-feeds-kind')[3];
  await byClass(tracker, 'private-cams-add')[0].fire('click');
  const block = byClass(tracker, 'device-feeds-feed')[0];
  const save = byClass(block, 'private-cams-save')[0];
  await save.fire('click');
  await settle();
  assert.match(byClass(block, 'private-cams-note')[0].textContent, /Name is required/);
  assert.equal(save.disabled, false);
  // An unsaved device is discarded without asking the server.
  await byClass(block, 'private-cams-remove-site')[0].fire('click');
  assert.equal(byClass(tracker, 'device-feeds-feed').length, 0);
  assert.equal(server.posts.length, 1);
});

test('read-only under preview; hidden where there is no server route', async () => {
  const preview = new FakeElement('div');
  initDeviceFeedSetup({ host: preview, documentRef, fetchImpl: fakeServer({ editable: false }).fetchImpl });
  await settle();
  assert.ok(byClass(preview, 'private-cams-add').every((add) => add.disabled));

  const none = new FakeElement('div');
  initDeviceFeedSetup({ host: none, documentRef, fetchImpl: async () => new Response('', { status: 404 }) });
  await settle();
  assert.equal(none.hidden, true);
});

test('POWER UP mounts the device cards', () => {
  const source = readFileSync(new URL('./keySetup.js', import.meta.url), 'utf8');
  assert.match(source, /initDeviceFeedSetup\(/);
  assert.match(source, /device-feeds/);
});
