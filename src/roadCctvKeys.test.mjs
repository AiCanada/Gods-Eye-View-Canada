import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  ROAD_CCTV_KEYS_FILE,
  listRoadCctvKeys,
  normalizeRoadCctvKey,
  normalizeRoadHost,
  readRoadCctvKeys,
  removeRoadCctvKey,
  roadCctvSitesFrom,
  saveRoadCctvKey,
  withRoadCctvKey,
} from '../server/shared/roadCctvKeys.mjs';
import { roadCctvKeysProxy } from '../server/providers/roadCctvKeys.js';
import {
  fetchCctvImageFromUpstream,
  setRoadCctvKeysRoot,
  setRoadCctvSiteSource,
} from '../server/providers/cctv/media.js';
import {
  initRoadCctvKeysSetup,
  roadCctvSiteChoices,
} from './roadCctvKeysSetup.js';

const KEY = 'road-key-0123456789abcdef';
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-road-keys-'));

test('a camera site is a host, typed bare or taken from an address', () => {
  assert.equal(normalizeRoadHost('511NY.org'), '511ny.org');
  assert.equal(
    normalizeRoadHost('https://www.511ny.org/map/Cctv/1'),
    '511ny.org',
  );
  assert.equal(normalizeRoadHost('not a host'), '');
  assert.equal(normalizeRoadHost('localhost'), '');
  assert.deepEqual(
    normalizeRoadCctvKey({ host: 'fl511.com', apiKey: ` ${KEY} ` }),
    {
      ok: true,
      value: {
        label: 'fl511.com',
        host: 'fl511.com',
        param: 'key',
        apiKey: KEY,
      },
    },
  );
  assert.equal(
    normalizeRoadCctvKey({ host: 'fl511.com', apiKey: '' }).ok,
    false,
  );
  assert.equal(
    normalizeRoadCctvKey({ host: 'fl511.com', apiKey: KEY, param: 'a b' }).ok,
    false,
  );
  assert.equal(
    normalizeRoadCctvKey({ host: 'fl511.com', apiKey: 'a\u0000b' }).ok,
    false,
  );
});

test('any number of keys are kept, listed without the key, edited and removed', () => {
  const root = tempRoot();
  try {
    for (let i = 0; i < 30; i += 1) {
      assert.equal(
        saveRoadCctvKey(root, {
          host: `site${i}.example.org`,
          apiKey: `${KEY}-${i}`,
        }).ok,
        true,
      );
    }
    assert.equal(readRoadCctvKeys(root).length, 30);
    const listed = listRoadCctvKeys(root);
    assert.equal(listed.length, 30);
    assert.equal(JSON.stringify(listed).includes(KEY), false);
    assert.equal(listed[0].keyEnd, `${KEY}-0`.slice(-4));
    // A new key for an entry replaces it in place.
    const { id } = listed[0];
    assert.equal(
      saveRoadCctvKey(root, {
        id,
        host: 'site0.example.org',
        label: 'First',
        apiKey: 'replaced-key-9999',
      }).id,
      id,
    );
    assert.equal(
      readRoadCctvKeys(root).find((row) => row.id === id).apiKey,
      'replaced-key-9999',
    );
    assert.equal(readRoadCctvKeys(root).length, 30);
    assert.equal(removeRoadCctvKey(root, id).ok, true);
    assert.equal(readRoadCctvKeys(root).length, 29);
    assert.equal(removeRoadCctvKey(root, id).ok, false);
    // A broken file holds no keys.
    fs.writeFileSync(path.join(root, ROAD_CCTV_KEYS_FILE), '{broken');
    assert.deepEqual(readRoadCctvKeys(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a key is added only to its own site, over https, and never over a parameter already there', () => {
  const keys = [{ host: '511ny.org', param: 'key', apiKey: KEY }];
  assert.equal(
    withRoadCctvKey('https://511ny.org/map/Cctv/1', keys),
    `https://511ny.org/map/Cctv/1?key=${KEY}`,
  );
  assert.equal(
    withRoadCctvKey('https://www.511ny.org/x.jpg?t=1', keys),
    `https://www.511ny.org/x.jpg?t=1&key=${KEY}`,
  );
  assert.equal(
    withRoadCctvKey('https://cams.511ny.org/x.jpg', keys),
    `https://cams.511ny.org/x.jpg?key=${KEY}`,
  );
  // Not over plain http, not to another site, not to a look-alike, not twice.
  assert.equal(
    withRoadCctvKey('http://511ny.org/x.jpg', keys),
    'http://511ny.org/x.jpg',
  );
  assert.equal(
    withRoadCctvKey('https://fl511.com/x.jpg', keys),
    'https://fl511.com/x.jpg',
  );
  assert.equal(
    withRoadCctvKey('https://evil511ny.org/x.jpg', keys),
    'https://evil511ny.org/x.jpg',
  );
  assert.equal(
    withRoadCctvKey('https://511ny.org/x.jpg?key=mine', keys),
    'https://511ny.org/x.jpg?key=mine',
  );
  assert.equal(
    withRoadCctvKey('https://511ny.org/x.jpg', []),
    'https://511ny.org/x.jpg',
  );
});

test('the camera picture fetcher sends a saved key to its site', async () => {
  const root = tempRoot();
  try {
    saveRoadCctvKey(root, {
      host: 'cams.example.org',
      param: 'apikey',
      apiKey: KEY,
    });
    setRoadCctvKeysRoot(root);
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(String(url));
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    };
    await fetchCctvImageFromUpstream('https://cams.example.org/still/1.jpg', {
      fetchImpl,
      secondAttempt: false,
    });
    await fetchCctvImageFromUpstream('https://other.example.net/still/1.jpg', {
      fetchImpl,
      secondAttempt: false,
    });
    assert.equal(
      asked[0],
      `https://cams.example.org/still/1.jpg?apikey=${KEY}`,
    );
    assert.equal(asked[1], 'https://other.example.net/still/1.jpg');
  } finally {
    setRoadCctvKeysRoot(process.cwd());
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function call(
  handler,
  {
    method = 'GET',
    url = '/',
    body = '',
    origin = 'http://localhost:4173',
    remoteAddress = '127.0.0.1',
  } = {},
) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, {
      method,
      url,
      headers: {
        host: 'localhost:4173',
        origin,
        'content-type': 'application/json',
      },
      socket: { remoteAddress },
    });
    const res = {
      statusCode: 200,
      writeHead(status) {
        this.statusCode = status;
      },
      end(payload = '') {
        resolve({
          status: this.statusCode,
          body: String(payload),
          json: () => JSON.parse(String(payload)),
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('the route saves from this machine and page only, and never answers with a key', async () => {
  const root = tempRoot();
  try {
    const routes = new Map();
    roadCctvKeysProxy({ sourceRoot: root }).configureServer({
      middlewares: { use: (route, handler) => routes.set(route, handler) },
    });
    const handler = routes.get('/api/road-cctv-keys');
    const saved = await call(handler, {
      method: 'POST',
      body: JSON.stringify({ host: '511ga.org', apiKey: KEY }),
    });
    assert.equal(saved.status, 200, saved.body);
    assert.equal(saved.body.includes(KEY), false);
    const listed = await call(handler);
    assert.equal(listed.json().keys.length, 1);
    assert.equal(listed.body.includes(KEY), false);
    const foreign = await call(handler, {
      method: 'POST',
      origin: 'https://attacker.example',
      body: JSON.stringify({ host: 'x.example.org', apiKey: KEY }),
    });
    assert.notEqual(foreign.status, 200);
    const remote = await call(handler, { remoteAddress: '192.168.1.20' });
    assert.notEqual(remote.status, 200);
    const removed = await call(handler, {
      method: 'DELETE',
      body: JSON.stringify({ id: listed.json().keys[0].id }),
    });
    assert.equal(removed.json().keys.length, 0);
  } finally {
    setRoadCctvKeysRoot(process.cwd());
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fakeDocument() {
  const make = (tag) => {
    const node = {
      tag,
      children: [],
      attributes: {},
      listeners: {},
      value: '',
      className: '',
      dataset: {},
      _text: '',
      get textContent() {
        return (
          this._text + this.children.map((child) => child.textContent).join(' ')
        );
      },
      set textContent(value) {
        this._text = String(value);
        this.children = [];
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
      addEventListener(type, fn) {
        (this.listeners[type] ||= []).push(fn);
      },
      click() {
        return Promise.all((this.listeners.click || []).map((fn) => fn()));
      },
      find(predicate) {
        if (predicate(this)) return this;
        for (const child of this.children) {
          const hit = child.find?.(predicate);
          if (hit) return hit;
        }
        return null;
      },
    };
    return node;
  };
  return { createElement: make };
}

test('POWER UP adds as many generic road CCTV keys as wanted from its + ADD button', async () => {
  const documentRef = fakeDocument();
  const host = documentRef.createElement('div');
  let stored = [];
  const posts = [];
  const fetchImpl = async (_url, init = {}) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      stored = [
        ...stored,
        {
          id: `${stored.length}`.padStart(16, '0'),
          label: body.label || body.host,
          host: body.host,
          param: body.param || 'key',
          keyEnd: body.apiKey.slice(-4),
        },
      ];
      return { ok: true, json: async () => ({ ok: true, keys: stored }) };
    }
    if (String(_url).endsWith('?sites=1'))
      return {
        ok: true,
        json: async () => ({
          sites: [
            { host: '511ny.org', cameras: 900 },
            { host: 'fl511.com', cameras: 40 },
            { host: '511ga.org', cameras: 3 },
          ],
        }),
      };
    return { ok: true, json: async () => ({ keys: stored }) };
  };
  const counts = [];
  await initRoadCctvKeysSetup({
    documentRef,
    fetchImpl,
    host,
    onSections: (sections) => counts.push(sections),
  });
  const addButton = () =>
    host.find(
      (node) =>
        node.tag === 'button' &&
        node._text === '+ ADD GENERIC ROAD CCTV API KEYS',
    );
  for (const site of ['511ny.org', 'fl511.com', '511ga.org']) {
    await addButton().click();
    const forms = [];
    host.find((node) => {
      if (
        node.className === 'key-setup-row road-cctv-key-row' &&
        node.dataset.set === 'false'
      )
        forms.push(node);
      return false;
    });
    const form = forms[forms.length - 1];
    const input = (name) => form.find((node) => node.attributes?.name === name);
    // The site is picked from the catalogue's list: no address is typed.
    const picker = input('host');
    assert.equal(picker.tag, 'select');
    assert.ok(
      picker.children.some((option) => option.attributes.value === site),
    );
    picker.value = site;
    input('apiKey').value = `${KEY}-${site}`;
    await form.find((node) => node._text === 'SAVE KEY').click();
  }
  assert.deepEqual(
    posts.map((body) => body.host),
    ['511ny.org', 'fl511.com', '511ga.org'],
  );
  // Counted as one POWER UP once it holds a key, like the other sections.
  assert.deepEqual(counts.at(-1), [{ id: 'road-cctv-keys', set: true }]);
  const rows = [];
  host.find((node) => {
    if (node.className === 'key-setup-row road-cctv-key-row') rows.push(node);
    return false;
  });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.dataset.set === 'true'));
  assert.match(
    host.textContent,
    /Added to every 511ga\.org camera picture as \?key=…/,
  );
  assert.ok(
    host.find(
      (node) =>
        node.tag === 'a' && node.attributes.href === 'https://511ga.org/',
    ),
  );
  assert.equal(host.textContent.includes(KEY), false);
  // The key boxes are masked.
  assert.ok(
    host.find(
      (node) =>
        node.attributes?.name === 'apiKey' &&
        node.attributes.type === 'password',
    ),
  );
});

test('POWER UP lists the camera sites in the catalogue to pick from, most cameras first', () => {
  const sites = roadCctvSitesFrom([
    { url: 'https://cams.511ny.org/a.jpg' },
    { snapshotUrl: 'https://www.511ny.org/b.jpg', url: 'rtsp://ignored' },
    { url: 'https://511ny.org/c.jpg' },
    { url: 'https://fl511.com/d.jpg' },
    { url: 'http://plain.example/e.jpg' },
    { url: 'not a url' },
  ]);
  assert.deepEqual(sites, [
    { host: '511ny.org', cameras: 2 },
    { host: 'cams.511ny.org', cameras: 1 },
    { host: 'fl511.com', cameras: 1 },
  ]);
  // A saved site the catalogue does not list stays choosable on its own row.
  assert.deepEqual(roadCctvSiteChoices(sites, 'other511.org')[0], {
    host: 'other511.org',
    cameras: 0,
  });
  assert.equal(roadCctvSiteChoices(sites, 'fl511.com').length, 3);
});

test('editing a saved road CCTV key with the key box empty keeps its key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'road-keys-edit-'));
  try {
    const first = saveRoadCctvKey(root, {
      label: 'NY',
      host: '511ny.org',
      apiKey: KEY,
    });
    assert.equal(first.ok, true);
    const edited = saveRoadCctvKey(root, {
      id: first.id,
      label: 'New York',
      host: '511ny.org',
      apiKey: '',
    });
    assert.equal(edited.ok, true);
    const [row] = readRoadCctvKeys(root);
    assert.equal(row.label, 'New York');
    assert.equal(row.apiKey, KEY);
    // A new entry still needs its key.
    assert.equal(
      saveRoadCctvKey(root, { host: 'fl511.com', apiKey: '' }).ok,
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the route lists camera sites from the catalogue, never a key', async () => {
  const root = tempRoot();
  try {
    const routes = new Map();
    roadCctvKeysProxy({ sourceRoot: root }).configureServer({
      middlewares: { use: (route, handler) => routes.set(route, handler) },
    });
    const handler = routes.get('/api/road-cctv-keys');
    setRoadCctvSiteSource(async () => ({
      generation: 1,
      sources: [
        { url: 'https://511ny.org/a.jpg' },
        { url: 'https://511ny.org/b.jpg' },
      ],
    }));
    const listed = await call(handler, { url: '/?sites=1' });
    assert.equal(listed.status, 200, listed.body);
    assert.deepEqual(listed.json(), {
      sites: [{ host: '511ny.org', cameras: 2 }],
    });
  } finally {
    setRoadCctvSiteSource(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
