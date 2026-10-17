import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AI_WORLD_NOT_READY,
  AI_WORLD_PREDICTIONS_EVENT,
  AI_WORLD_STORAGE_KEY,
  AiWorldPanel,
  initAiWorldPanel,
} from './aiWorldPanel.js';
import { ownerRemovalRefusalCount } from './ui/ownerRemoval.js';

const TEMPLATE = new URL('./ui/templates/layer-panels.html', import.meta.url);
const NOW = Date.UTC(2026, 9, 13, 12);

/** The box's markup, from its opening tag to the end of the left stack. */
function boxMarkup() {
  const html = readFileSync(TEMPLATE, 'utf8');
  const start = html.indexOf('<div id="ai-world-panel"');
  assert.ok(start >= 0, 'the AI World box is in the markup');
  return html.slice(start);
}

const decode = (text) => String(text ?? '').replace(/&amp;/g, '&');

function attributesOf(text) {
  const attrs = {};
  for (const [, name, value] of text.matchAll(/([\w-]+)(?:="([^"]*)")?/g))
    attrs[name] = decode(value ?? '');
  return attrs;
}

/** Just enough of an element: text writes and listeners are counted. */
class FakeNode {
  constructor(page, tag, attrs = {}, text = '') {
    this.page = page;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.dataset = {};
    this.id = attrs.id ?? '';
    this.className = attrs.class ?? '';
    this.type = attrs.type ?? '';
    this.value = attrs.value ?? '';
    this.title = attrs.title ?? '';
    this.checked = 'checked' in attrs;
    this.disabled = 'disabled' in attrs;
    this.hidden = 'hidden' in attrs;
    this.indeterminate = false;
    this.scrollTop = 0;
    this.text = text;
  }

  get textContent() {
    return this.children.length
      ? this.children.map((child) => child.textContent).join('')
      : this.text;
  }

  set textContent(value) {
    this.page.textWrites += 1;
    this.children = [];
    this.text = String(value);
  }

  appendChild(child) {
    this.page.childWrites += 1;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.page.childWrites += 1;
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }

  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), fn]);
    this.page.listeners += 1;
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const at = list.indexOf(fn);
    if (at < 0) return;
    list.splice(at, 1);
    this.page.listeners -= 1;
  }

  /** The event bubbles up through the parents, as a real one does. */
  dispatch(type) {
    const event = { type, target: this };
    for (let node = this; node; node = node.parentNode)
      for (const fn of [...(node.listeners.get(type) || [])]) fn(event);
  }

  click() {
    if (!this.disabled) this.dispatch('click');
  }
}

/** A page holding every element of the box that has an id, as the markup has it. */
function fakePage() {
  const page = { textWrites: 0, childWrites: 0, listeners: 0, events: [] };
  const nodes = new Map();
  for (const [, tag, attrText, id, text] of boxMarkup().matchAll(
    /<(\w+)\b([^>]*?\bid="(ai-world-[^"]+)"[^>]*?)\/?>([^<]*)/g,
  ))
    if (!nodes.has(id))
      nodes.set(
        id,
        new FakeNode(page, tag, attributesOf(attrText), decode(text).trim()),
      );
  const document = {
    getElementById: (id) => nodes.get(id) || null,
    createElement: (tag) => new FakeNode(page, tag),
    dispatchEvent: (event) => {
      page.events.push(event);
      return true;
    },
  };
  return { page, nodes, document };
}

/** Timers the test moves by hand, on a clock of its own. */
function fakeTimers(start = NOW) {
  let now = start;
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      pending.set(id, {
        fn,
        ms: Number(ms) || 0,
        at: now + Math.max(0, Number(ms) || 0),
      });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    now: () => now,
    get size() {
      return pending.size;
    },
    has(ms) {
      return [...pending.values()].some((timer) => timer.ms === ms);
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        let due = null;
        for (const entry of pending)
          if (entry[1].at <= until && (!due || entry[1].at < due[1].at))
            due = entry;
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = until;
    },
  };
}

async function settle() {
  for (let i = 0; i < 6; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

/** The dev server: `routes(call)` answers `{status, body, headers}`, a promise, or throws. */
function fakeServer(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      init,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const answer = (await routes(call)) || {
      status: 404,
      body: { error: 'Not found' },
    };
    const { status = 200, body = null, headers = {} } = answer;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      json: async () => {
        if (body === undefined) throw new SyntaxError('Unexpected token <');
        return body;
      },
    };
  };
  return { fetch, calls };
}

function fakeDataManager(layers) {
  let list = layers;
  const listeners = new Set();
  return {
    getAll: () => list.map((layer) => ({ ...layer, enabled: false })),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    replace(next) {
      list = next;
      // The manager says a lot: several notices for one change.
      for (let i = 0; i < 3; i += 1)
        for (const fn of listeners) fn({ type: 'status' });
    },
    get listeners() {
      return listeners.size;
    },
  };
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

const LAYERS = [
  { id: 'flights', name: 'Flights', showInTogglePanel: true },
  { id: 'transit', name: 'Transit', showInTogglePanel: true },
  { id: 'bhote-koshi-locator', name: 'Locator', showInTogglePanel: false },
];

const CATALOG = [
  {
    id: 'transit',
    label: 'Transit',
    layers: ['transit'],
    kind: 'feed',
    class: 'open',
    licence: 'Per-feed open licences (MBTA, CapMetro)',
    cadenceMs: 30_000,
    phase: 1,
  },
  {
    id: 'gdelt-events',
    label: 'GDELT events',
    layers: [],
    kind: 'feed',
    class: 'open',
    cadenceMs: 900_000,
    phase: 2,
  },
  {
    id: 'news',
    label: 'News',
    layers: [],
    kind: 'feed',
    class: 'nc',
    cadenceMs: 600_000,
    phase: 1,
  },
  {
    id: 'devices',
    label: 'Your devices',
    layers: ['device-feeds'],
    kind: 'feed',
    class: 'personal',
    cadenceMs: 5_000,
    phase: 1,
  },
];

function statusOf(state, extra = {}) {
  return {
    state,
    since: NOW - 125_000,
    selection: [],
    capBytes: 600e9,
    feeds: [],
    stages: {
      recorder: { state: 'off', feeds: 0, bytesPerDay: 0 },
      generator: {
        state: 'off',
        done: 0,
        total: 0,
        episodes: 0,
        etaMs: null,
        error: null,
      },
      trainer: {
        state: 'off',
        model: null,
        epoch: 0,
        epochs: 0,
        loss: null,
        error: null,
      },
      predictor: { state: 'off', domains: [], updatedAt: null, error: null },
    },
    storage: { usedBytes: 0, freeBytes: 0, byKind: {} },
    compute: { workers: 8, busy: 0, gpu: 'RTX 4060' },
    gaps: [],
    learning: { daysRecorded: 2 },
    ...extra,
  };
}

/** The box on a fake page, with the server answering `routes`. */
function mount({
  routes,
  layers = LAYERS,
  storage = memoryStorage(),
  viewPoint,
} = {}) {
  const { page, nodes, document } = fakePage();
  const timers = fakeTimers();
  const server = fakeServer(routes);
  const manager = fakeDataManager(layers);
  const panel = new AiWorldPanel({
    document,
    fetch: server.fetch,
    dataManager: manager,
    viewPoint,
    storage,
    timers,
    now: timers.now,
  });
  const get = (id) => {
    const node = nodes.get(id);
    assert.ok(node, `#${id} is in the markup`);
    return node;
  };
  return { page, get, timers, server, manager, panel, storage };
}

const rows = (m) => m.get('ai-world-sources').children;
const rowIds = (m) => rows(m).map((li) => li.dataset.aiWorldRow);
const boxOf = (li) => li.children[0].children[0];
const boxes = (m) => rows(m).map(boxOf);
const boxFor = (m, id) =>
  boxOf(rows(m).find((li) => li.dataset.aiWorldRow === id));
const callsTo = (m, path) =>
  m.server.calls.filter((call) => call.url.split('?')[0].endsWith(path));
const tick = (box, on = true) => {
  box.checked = on;
  box.dispatch('change');
};

/** The ordinary server: idle, the catalog, and every POST echoed back. */
function idleServer(overrides = {}) {
  let status = statusOf('idle');
  return (call) => {
    const path = call.url.split('?')[0];
    const own = overrides[path.slice(path.lastIndexOf('/') + 1)];
    if (own) return own(call);
    if (path.endsWith('/status')) return { body: status };
    if (path.endsWith('/catalog')) return { body: { items: CATALOG } };
    if (path.endsWith('/selection')) {
      status = { ...status, selection: call.body.selection };
      return { body: status };
    }
    return undefined;
  };
}

test('the box sits last in the left stack, collapsed, with the shared chrome and live regions', () => {
  const html = readFileSync(TEMPLATE, 'utf8');
  const box = boxMarkup();
  assert.ok(
    html.indexOf('<div id="outbreak-panel"') <
      html.indexOf('<div id="ai-world-panel"'),
  );
  // data-i18n-skip: the tab's text stays English for now (scripts/i18n.mjs).
  assert.match(
    box,
    /^<div id="ai-world-panel" class="panel-collapsible collapsed" data-panel-id="ai-world-panel" data-i18n-skip>\s*<div class="panel-glow"><\/div>\s*<div class="ai-world-panel-inner">/,
  );
  assert.match(
    box,
    /<span class="panel-title" data-collapsed-title="ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM">ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM<\/span>/,
  );
  assert.match(
    box,
    /<button class="panel-collapse-btn" data-collapse-target="ai-world-panel" title="Collapse panel">\+<\/button>/,
  );
  assert.match(
    box,
    /id="ai-world-status" class="ask-status" role="status" aria-live="polite"/,
  );
  assert.match(
    box,
    /id="ai-world-output" class="ask-output" role="status" aria-live="polite" tabindex="0"/,
  );
  assert.match(
    box,
    /id="ai-world-delete-confirm" class="scene-btn ultra-danger"/,
  );
  assert.deepEqual(
    [
      ...box
        .slice(box.indexOf('id="ai-world-delete-scope"'))
        .matchAll(/<option value="([a-z]+)"[^>]*>([^<]+)</g),
    ]
      .slice(0, 8)
      .map((m) => `${m[1]}:${m[2]}`),
    [
      'all:ALL DATA',
      'tape:TAPE',
      'bins:BINS',
      'datasets:SIM DATASETS',
      'worlds:WORLDS',
      'models:MODELS',
      'predictions:PREDICTIONS',
      'demographics:DEMOGRAPHICS',
    ],
  );
  assert.match(
    box,
    /Military layers and military flights are not used for training\./,
  );
  assert.match(box, /id="ai-world-predict-all"/);
  assert.match(box, /id="ai-world-infer"/);
  assert.match(
    box,
    /id="ai-world-horizon" type="range" min="1" max="168" step="1" value="24"/,
  );
  assert.match(box, /id="ai-world-cap" type="number"[^>]*value="600"/);
  assert.match(box, /id="ai-world-scenarios" type="number"[^>]*value="2000"/);
  assert.equal(box.includes('type="password"'), false);
  // The stack's own closing tag follows the box.
  assert.match(box, /<\/div>\n    <\/div>\n  <\/div>\n?$/);
});

test('TRAIN ON: one row per layer, the catalog-only items and the four extras, each with its class and live status', async () => {
  const m = mount({
    routes: idleServer({
      status: () => ({
        body: statusOf('idle', {
          selection: ['transit'],
          feeds: [
            {
              id: 'transit',
              state: 'recording',
              bytes: 12.4e6,
              lastAt: NOW - 125_000,
            },
            { id: 'flights', state: 'quota' },
            { id: 'news', state: 'error', error: 'HTTP 429' },
          ],
        }),
      }),
    }),
  });
  await settle();
  assert.deepEqual(rowIds(m), [
    'flights',
    'transit',
    'gdelt-events',
    'news',
    'demographics',
    'outbreak-sim',
    'devices',
  ]);
  assert.deepEqual(
    rows(m).map((li) => li.children[0].children[2].textContent),
    [
      'FLIGHTS',
      'TRANSIT',
      'GDELT EVENTS',
      'NEWS EVENTS',
      'POPULATION DEMOGRAPHICS',
      'OUTBREAK SIM EPISODES',
      'YOUR DEVICES',
    ],
  );
  assert.deepEqual(
    rows(m).map((li) => li.children[1].textContent),
    ['STATIC', 'OPEN', 'OPEN', 'NC', 'STATIC', 'STATIC', 'PERSONAL'],
  );
  assert.deepEqual(
    rows(m).map((li) => li.children[2].textContent),
    [
      'QUOTA',
      'RECORDING · 12.4 MB · 2 MIN AGO',
      '',
      'ERROR · HTTP 429',
      '',
      '',
      '',
    ],
  );
  // The licence is the class tag's tooltip; the swatch takes the class.
  assert.equal(
    rows(m)[1].children[1].title,
    'Per-feed open licences (MBTA, CapMetro)',
  );
  assert.equal(rows(m)[1].children[0].dataset.class, 'open');
  assert.equal(
    boxFor(m, 'transit').getAttribute('aria-describedby'),
    'ai-world-row-transit-class ai-world-row-transit-feed',
  );
  assert.deepEqual(
    boxes(m).map((box) => box.checked),
    [false, true, false, false, false, false, false],
  );
  const all = m.get('ai-world-all');
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, true, 'ALL shows the partial state');
  // GETs are same-origin and never cached.
  for (const call of [...callsTo(m, '/status'), ...callsTo(m, '/catalog')]) {
    assert.equal(call.method, 'GET');
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal(call.init.cache, 'no-store');
  }
  m.panel.destroy();
});

test('ALL ticks every row or none, shows the partial state between, and the ticks go to the server once, 400 ms after the last change', async () => {
  const m = mount({ routes: idleServer() });
  await settle();
  const all = m.get('ai-world-all');
  const ids = rowIds(m);
  tick(all);
  assert.ok(boxes(m).every((box) => box.checked));
  assert.equal(all.checked, true);
  assert.equal(all.indeterminate, false);
  tick(boxFor(m, 'transit'), false);
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, true);
  tick(boxFor(m, 'news'), false);
  await m.timers.advance(399);
  assert.equal(
    callsTo(m, '/selection').length,
    0,
    'nothing sent while ticking',
  );
  await m.timers.advance(1);
  const sent = callsTo(m, '/selection');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].init.credentials, 'same-origin');
  assert.equal(sent[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(
    new Set(sent[0].body.selection),
    new Set(ids.filter((id) => id !== 'transit' && id !== 'news')),
  );
  // Pressed while partial (the browser checks it), ALL ticks every row again.
  tick(all, true);
  assert.ok(boxes(m).every((box) => box.checked));
  tick(all, false);
  assert.ok(boxes(m).every((box) => !box.checked));
  assert.equal(all.indeterminate, false);
  await m.timers.advance(400);
  assert.equal(callsTo(m, '/selection').length, 2);
  assert.deepEqual(callsTo(m, '/selection')[1].body.selection, []);
  // The server's answer is the selection sent: nothing moves.
  await m.timers.advance(15_000);
  assert.ok(boxes(m).every((box) => !box.checked));
  m.panel.destroy();
});

test('the buttons follow the state; PAUSE turns into CONTINUE while paused; STOP and the polls follow', async () => {
  let state = 'idle';
  const answer = (next) => () => {
    state = next;
    return { body: statusOf(next) };
  };
  const m = mount({
    routes: idleServer({
      status: () => ({ body: statusOf(state) }),
      pause: answer('paused'),
      continue: answer('running'),
      stop: answer('stopping'),
    }),
  });
  const buttons = () => ({
    init: !m.get('ai-world-init').disabled,
    pause: !m.get('ai-world-pause').disabled,
    stop: !m.get('ai-world-stop').disabled,
    del: !m.get('ai-world-delete').disabled,
    label: m.get('ai-world-pause').textContent,
  });
  const idle = {
    init: true,
    pause: false,
    stop: false,
    del: true,
    label: 'PAUSE',
  };
  const running = {
    init: false,
    pause: true,
    stop: true,
    del: false,
    label: 'PAUSE',
  };
  assert.deepEqual(buttons(), idle, 'before any answer the box acts as idle');
  await settle();
  assert.deepEqual(buttons(), idle);
  assert.ok(m.timers.has(15_000), 'idle: asked again in 15 s');
  state = 'running';
  await m.timers.advance(15_000);
  assert.deepEqual(buttons(), running);
  assert.ok(m.timers.has(3_000), 'running: asked again in 3 s');
  state = 'initializing';
  await m.timers.advance(3_000);
  assert.deepEqual(buttons(), running);
  state = 'paused';
  await m.timers.advance(3_000);
  assert.deepEqual(buttons(), {
    init: false,
    pause: true,
    stop: true,
    del: false,
    label: 'CONTINUE',
  });
  assert.ok(m.timers.has(3_000), 'paused: still every 3 s');

  m.get('ai-world-pause').click();
  await settle();
  let last = m.server.calls.at(-1);
  assert.ok(last.url.endsWith('/api/ai-world/continue'));
  assert.equal(last.method, 'POST');
  assert.deepEqual(last.body, {});
  assert.deepEqual(buttons(), running);
  assert.equal(m.get('ai-world-status').textContent, 'CONTINUE · RUNNING');

  m.get('ai-world-pause').click();
  await settle();
  assert.ok(m.server.calls.at(-1).url.endsWith('/api/ai-world/pause'));
  assert.equal(buttons().label, 'CONTINUE');

  m.get('ai-world-stop').click();
  await settle();
  last = m.server.calls.at(-1);
  assert.ok(last.url.endsWith('/api/ai-world/stop'));
  assert.deepEqual(buttons(), {
    init: false,
    pause: false,
    stop: false,
    del: false,
    label: 'PAUSE',
  });
  assert.match(m.get('ai-world-output').textContent, /STOP · STOPPING/);
  state = 'stopped';
  await m.timers.advance(3_000);
  assert.deepEqual(buttons(), idle);
  assert.ok(m.timers.has(15_000));
  m.panel.destroy();
});

test('a refused command shows the server’s reason, or HTTP n', async () => {
  const m = mount({
    routes: idleServer({
      status: () => ({ body: statusOf('running') }),
      pause: () => ({ status: 409, body: { error: 'Not running' } }),
      stop: () => ({ status: 500, body: null }),
    }),
  });
  await settle();
  m.get('ai-world-pause').click();
  await settle();
  assert.equal(
    m.get('ai-world-status').textContent,
    'PAUSE REFUSED · Not running',
  );
  m.get('ai-world-stop').click();
  await settle();
  assert.equal(m.get('ai-world-status').textContent, 'STOP REFUSED · HTTP 500');
  assert.equal(
    m.get('ai-world-pause').disabled,
    false,
    'the buttons come back',
  );
  m.panel.destroy();
});

test('a refused selection puts the server’s ticks back and says why', async () => {
  const m = mount({
    routes: idleServer({
      status: () => ({ body: statusOf('idle', { selection: ['transit'] }) }),
      selection: () => ({
        status: 400,
        body: { error: 'Unknown feed: flights' },
      }),
    }),
  });
  await settle();
  assert.equal(boxFor(m, 'transit').checked, true);
  tick(boxFor(m, 'flights'));
  assert.equal(boxFor(m, 'flights').checked, true);
  await m.timers.advance(400);
  assert.equal(
    m.get('ai-world-status').textContent,
    'SELECTION REFUSED · Unknown feed: flights',
  );
  assert.equal(boxFor(m, 'flights').checked, false);
  assert.equal(boxFor(m, 'transit').checked, true);
  assert.equal(callsTo(m, '/selection').length, 1, 'not sent again');
  await m.timers.advance(15_000);
  assert.equal(callsTo(m, '/selection').length, 1);
  m.panel.destroy();
});

test('INITIALIZE shows the estimate first and starts only on CONFIRM INITIALIZE', async () => {
  const estimate = (call) => ({
    body: {
      bytesPerDay: 1.2e9,
      feeds: [
        { id: 'transit', bytesPerDay: 0.8e9 },
        { id: 'flights', bytesPerDay: 0.4e9 },
      ],
      workers: 8,
      gpu: 'RTX 4060',
      capBytes: call.body.capGb * 1e9,
      daysToCap: (call.body.capGb * 1e9) / 1.2e9,
    },
  });
  const m = mount({
    routes: idleServer({
      estimate,
      initialize: (call) => ({
        body: statusOf('initializing', { selection: call.body.selection }),
      }),
    }),
  });
  await settle();
  const block = m.get('ai-world-estimate');
  const status = m.get('ai-world-status');
  assert.equal(block.hidden, true);

  m.get('ai-world-init').click();
  await settle();
  assert.equal(status.textContent, 'TICK AT LEAST ONE SOURCE TO TRAIN ON');
  assert.equal(callsTo(m, '/estimate').length, 0);

  tick(boxFor(m, 'transit'));
  m.get('ai-world-init').click();
  await settle();
  let estimates = callsTo(m, '/estimate');
  assert.equal(estimates.length, 1);
  assert.deepEqual(estimates[0].body, { selection: ['transit'], capGb: 600 });
  assert.equal(block.hidden, false);
  assert.deepEqual(
    m.get('ai-world-estimate-lines').children.map((li) => li.textContent),
    [
      'RECORDS ABOUT 1.2 GB A DAY',
      'STORAGE CAP 600 GB · FULL IN ABOUT 500 DAYS',
      'HEAVIEST · TRANSIT 800 MB · FLIGHTS 400 MB',
      '8 WORKERS',
      'GPU RTX 4060',
    ],
  );
  assert.equal(
    status.textContent,
    'ESTIMATE READY · CONFIRM INITIALIZE TO START',
  );
  assert.equal(
    callsTo(m, '/initialize').length,
    0,
    'nothing starts on INITIALIZE',
  );
  assert.equal(m.get('ai-world-init-confirm').disabled, false);

  // CANCEL puts it away; nothing started.
  m.get('ai-world-init-cancel').click();
  assert.equal(block.hidden, true);
  assert.equal(callsTo(m, '/initialize').length, 0);

  m.get('ai-world-init').click();
  await settle();
  assert.equal(block.hidden, false);
  // SIM SCENARIOS shows only with OUTBREAK SIM EPISODES ticked.
  assert.equal(m.get('ai-world-scenarios').hidden, true);
  assert.equal(m.get('ai-world-scenarios-label').hidden, true);
  tick(boxFor(m, 'outbreak-sim'));
  assert.equal(m.get('ai-world-scenarios').hidden, false);
  assert.equal(m.get('ai-world-scenarios-label').hidden, false);
  // A new cap is estimated again, quietly.
  const cap = m.get('ai-world-cap');
  cap.value = '1200';
  cap.dispatch('change');
  await m.timers.advance(400);
  estimates = callsTo(m, '/estimate');
  assert.deepEqual(estimates.at(-1).body, {
    selection: ['transit', 'outbreak-sim'],
    capGb: 1200,
  });
  assert.equal(
    m.get('ai-world-estimate-lines').children[1].textContent,
    'STORAGE CAP 1.2 TB · FULL IN ABOUT 1,000 DAYS',
  );
  const scenarios = m.get('ai-world-scenarios');
  scenarios.value = '-5';
  scenarios.dispatch('change');
  assert.equal(scenarios.value, '1');
  scenarios.value = '3000';

  m.get('ai-world-init-confirm').click();
  await settle();
  const started = callsTo(m, '/initialize');
  assert.equal(started.length, 1);
  assert.equal(started[0].method, 'POST');
  assert.equal(started[0].init.credentials, 'same-origin');
  assert.deepEqual(started[0].body, {
    selection: ['transit', 'outbreak-sim'],
    capGb: 1200,
    sim: { scenarios: 3000, runs: 8, days: 40 },
  });
  assert.equal(block.hidden, true);
  assert.equal(status.textContent, 'INITIALIZED · 2 SOURCES · CAP 1200 GB');
  assert.match(m.get('ai-world-output').textContent, /INITIALIZED · 2 SOURCES/);
  assert.equal(m.get('ai-world-init').disabled, true);
  assert.equal(m.get('ai-world-stop').disabled, false);
  assert.ok(m.timers.has(3_000), 'initializing: asked again in 3 s');
  m.panel.destroy();
});

test('DELETE lists exactly what it removes, sends the preview’s token, and is silent on the phone’s pc-only refusal', async () => {
  let answer = 'pc-only';
  const preview = (call) => {
    const scope = new URL(call.url, 'http://x').searchParams.get('scope');
    return {
      body: {
        scope,
        token: `token-${scope}`,
        root: '.gev-data',
        groups: [
          {
            kind: 'tape',
            id: 'transit',
            path: 'tape/transit',
            files: 1200,
            bytes: 123_456_789,
          },
          {
            kind: 'models',
            id: 'world-v1',
            path: 'ai-world/models/world-v1',
            files: 3,
            bytes: 2.5e9,
          },
        ],
        totalFiles: 1203,
        totalBytes: 2_623_456_789,
      },
    };
  };
  const remove = () => {
    if (answer === 'pc-only')
      return {
        status: 403,
        headers: { 'x-gev-removal': 'pc-only' },
        body: { removal: 'pc-only' },
      };
    if (answer === 'body-only')
      return { status: 403, body: { removal: 'pc-only' } };
    if (answer === 'changed')
      return {
        status: 409,
        body: { error: 'The files changed since the preview' },
      };
    return { body: { deleted: { files: 1203, bytes: 2_623_456_789 } } };
  };
  const m = mount({
    routes: idleServer({ 'delete-preview': preview, delete: remove }),
  });
  await settle();
  const block = m.get('ai-world-delete-panel');
  const confirm = m.get('ai-world-delete-confirm');
  const status = m.get('ai-world-status');
  const output = m.get('ai-world-output');
  assert.equal(block.hidden, true);

  m.get('ai-world-delete').click();
  assert.equal(block.hidden, false, 'the preview opens at once');
  assert.equal(confirm.disabled, true, 'nothing to confirm before the list');
  await settle();
  assert.equal(
    callsTo(m, '/delete-preview').at(-1).url,
    '/api/ai-world/delete-preview?scope=all',
  );
  assert.equal(callsTo(m, '/delete-preview').at(-1).init.cache, 'no-store');
  assert.deepEqual(
    m.get('ai-world-delete-groups').children.map((li) => li.textContent),
    [
      'TAPE · transit · tape/transit · 1,200 FILES · 123 MB',
      'MODELS · world-v1 · ai-world/models/world-v1 · 3 FILES · 2.5 GB',
    ],
  );
  assert.equal(
    m.get('ai-world-delete-total').textContent,
    'TOTAL · 1,203 FILES · 2.6 GB · IN .gev-data',
  );
  assert.equal(confirm.textContent, 'DELETE 1,203 FILES · 2.6 GB');
  assert.equal(confirm.disabled, false);

  const scope = m.get('ai-world-delete-scope');
  scope.value = 'tape';
  scope.dispatch('change');
  await settle();
  assert.equal(
    callsTo(m, '/delete-preview').at(-1).url,
    '/api/ai-world/delete-preview?scope=tape',
  );

  // The owner's phone: 403, X-GEV-Removal: pc-only. Nothing is said.
  const said = status.textContent;
  const logged = output.textContent;
  const refusals = ownerRemovalRefusalCount();
  confirm.click();
  await settle();
  const sent = callsTo(m, '/delete').filter((call) => call.method === 'DELETE');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/ai-world/delete');
  assert.equal(sent[0].init.credentials, 'same-origin');
  assert.equal(sent[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(sent[0].body, { scope: 'tape', token: 'token-tape' });
  assert.equal(status.textContent, said, 'no status line about it');
  assert.equal(output.textContent, logged, 'and nothing in the log');
  assert.equal(block.hidden, false, 'the preview stays as it was');
  assert.equal(
    ownerRemovalRefusalCount(),
    refusals + 1,
    'the voice layer hears of it',
  );
  assert.equal(confirm.disabled, false);

  // The same refusal told only by its body is just as quiet.
  answer = 'body-only';
  confirm.click();
  await settle();
  assert.equal(status.textContent, said);
  assert.equal(ownerRemovalRefusalCount(), refusals + 2);

  // Files changed since the preview: the reason, and the list again.
  answer = 'changed';
  const listed = callsTo(m, '/delete-preview').length;
  confirm.click();
  await settle();
  assert.equal(
    status.textContent,
    'DELETE REFUSED · The files changed since the preview',
  );
  assert.equal(callsTo(m, '/delete-preview').length, listed + 1);

  answer = 'ok';
  const polls = callsTo(m, '/status').length;
  confirm.click();
  await settle();
  assert.equal(status.textContent, 'DELETED 1,203 FILES · 2.6 GB');
  assert.match(output.textContent, /DELETED 1,203 FILES/);
  assert.equal(block.hidden, true);
  assert.equal(
    callsTo(m, '/status').length,
    polls + 1,
    'the storage is asked for again',
  );

  // CANCEL closes an open preview; a running job cannot delete at all.
  m.get('ai-world-delete').click();
  await settle();
  m.get('ai-world-delete-cancel').click();
  assert.equal(block.hidden, true);
  m.panel.destroy();
});

test('AREAS: ADD VIEW AS AREA sends the middle of the map, REMOVE takes one off, and the phone’s refusal is silent', async () => {
  let areas = [];
  let refuse = false;
  let view = { lat: 43.6532, lon: -79.3832 };
  const route = (call) => {
    if (call.method === 'POST') {
      const key = `${call.body.lat.toFixed(4)},${call.body.lon.toFixed(4)}`;
      areas = [
        ...areas,
        { key, name: 'Toronto', lat: call.body.lat, lon: call.body.lon },
      ];
      return { body: { areas } };
    }
    if (call.method === 'DELETE') {
      if (refuse)
        return {
          status: 403,
          headers: { 'x-gev-removal': 'pc-only' },
          body: { removal: 'pc-only' },
        };
      areas = areas.filter((a) => a.key !== call.body.key);
      return { body: { areas } };
    }
    return { body: { areas } };
  };
  const m = mount({
    routes: idleServer({ areas: route }),
    viewPoint: () => view,
  });
  await settle();
  const list = m.get('ai-world-areas');
  const add = m.get('ai-world-area-add');
  const status = m.get('ai-world-status');
  assert.deepEqual(
    list.children.map((li) => li.textContent),
    ['NO AREAS · CAMERAS, TRAFFIC, NEWS AND IMAGERY RECORD AROUND AN AREA'],
  );

  add.click();
  await settle();
  const posted = callsTo(m, '/areas').filter((c) => c.method === 'POST');
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, { lat: 43.6532, lon: -79.3832 });
  assert.equal(posted[0].init.headers['Content-Type'], 'application/json');
  assert.equal(status.textContent, 'AREA ADDED · 1 AREA');
  const row = list.children[0];
  assert.equal(row.dataset.aiWorldArea, '43.6532,-79.3832');
  assert.equal(row.children[0].textContent, 'TORONTO');
  assert.equal(row.children[1].textContent, '43.653, -79.383');
  const remove = row.children[2];
  assert.equal(remove.textContent, 'REMOVE');
  assert.equal(
    remove.getAttribute('aria-label'),
    'Stop recording around TORONTO',
  );

  // The owner's phone: 403 pc-only, nothing said, the list as it was.
  refuse = true;
  const said = status.textContent;
  const refusals = ownerRemovalRefusalCount();
  remove.click();
  await settle();
  const deleted = callsTo(m, '/areas').filter((c) => c.method === 'DELETE');
  assert.equal(deleted.length, 1);
  assert.deepEqual(deleted[0].body, { key: '43.6532,-79.3832' });
  assert.equal(status.textContent, said);
  assert.equal(ownerRemovalRefusalCount(), refusals + 1);
  assert.equal(list.children[0].dataset.aiWorldArea, '43.6532,-79.3832');

  // On the PC it goes.
  refuse = false;
  list.children[0].children[2].click();
  await settle();
  assert.equal(status.textContent, 'AREA REMOVED · 0 AREAS LEFT');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].dataset.aiWorldArea, undefined);

  // No view (the globe not ready): nothing is sent.
  view = null;
  add.click();
  await settle();
  assert.equal(status.textContent, 'NO MAP VIEW TO ADD');
  assert.equal(
    callsTo(m, '/areas').filter((c) => c.method === 'POST').length,
    1,
  );

  // The areas come with every status too.
  areas = [{ key: '1.0000,2.0000', name: 'Somewhere', lat: 1, lon: 2 }];
  m.panel._take(statusOf('idle', { areas }), 1e6);
  assert.equal(list.children[0].children[0].textContent, 'SOMEWHERE');
  m.panel.destroy();
});

test('a running job closes the DELETE preview and cannot delete', async () => {
  let state = 'idle';
  const m = mount({
    routes: idleServer({
      status: () => ({ body: statusOf(state) }),
      'delete-preview': () => ({
        body: {
          scope: 'all',
          token: 't',
          root: '.gev-data',
          groups: [],
          totalFiles: 4,
          totalBytes: 10,
        },
      }),
    }),
  });
  await settle();
  m.get('ai-world-delete').click();
  await settle();
  assert.equal(m.get('ai-world-delete-panel').hidden, false);
  state = 'running';
  await m.timers.advance(15_000);
  assert.equal(m.get('ai-world-delete-panel').hidden, true);
  assert.equal(m.get('ai-world-delete').disabled, true);
  m.get('ai-world-delete-confirm').click();
  await settle();
  assert.equal(
    callsTo(m, '/delete').filter((call) => call.method === 'DELETE').length,
    0,
  );
  m.panel.destroy();
});

test('status text is written only when it changes', async () => {
  let status = statusOf('running', {
    selection: ['transit'],
    feeds: [
      {
        id: 'transit',
        state: 'recording',
        bytes: 12.4e6,
        lastAt: NOW - 125_000,
      },
    ],
    stages: {
      recorder: { state: 'running', feeds: 1, bytesPerDay: 1.2e9 },
      generator: {
        state: 'running',
        done: 10,
        total: 2000,
        episodes: 80,
        etaMs: 3_600_000,
        error: null,
      },
      trainer: {
        state: 'waiting',
        model: null,
        epoch: 0,
        epochs: 0,
        loss: null,
        error: null,
      },
      predictor: { state: 'off', domains: [], updatedAt: null, error: null },
    },
    storage: { usedBytes: 2e9, freeBytes: 1e12, byKind: {} },
  });
  const m = mount({ routes: idleServer({ status: () => ({ body: status }) }) });
  await settle();
  assert.equal(
    m.get('ai-world-stage-state').textContent,
    'STATE · RUNNING · CHANGED 2 MIN AGO',
  );
  assert.equal(
    m.get('ai-world-stage-recorder').textContent,
    'RECORDING · RUNNING · 1 FEED · 1.2 GB A DAY',
  );
  assert.equal(
    m.get('ai-world-stage-generator').textContent,
    'SIM EPISODES · RUNNING · 10 / 2,000 · 80 EPISODES · ETA 1 H',
  );
  assert.equal(
    m.get('ai-world-stage-storage').textContent,
    'STORAGE · 2 GB / 600 GB · 0% · 1 TB FREE ON DISK',
  );
  assert.equal(
    m.get('ai-world-stage-compute').textContent,
    'COMPUTE · 0 / 8 WORKERS BUSY · GPU RTX 4060',
  );
  const texts = m.page.textWrites;
  const children = m.page.childWrites;
  await m.timers.advance(3_000);
  assert.equal(callsTo(m, '/status').length, 2);
  assert.equal(m.page.textWrites, texts, 'the same answer writes no text');
  assert.equal(m.page.childWrites, children, 'and rebuilds no list');
  status = {
    ...status,
    storage: { usedBytes: 3e9, freeBytes: 1e12, byKind: {} },
  };
  await m.timers.advance(3_000);
  assert.equal(m.page.textWrites, texts + 1, 'only the storage line changes');
  assert.equal(
    m.get('ai-world-stage-storage').textContent,
    'STORAGE · 3 GB / 600 GB · 1% · 1 TB FREE ON DISK',
  );
  m.panel.destroy();
});

test('a 404 says AI WORLD SERVER NOT READY, asks again in 60 s, and the box stays usable', async () => {
  let ready = false;
  let first = true;
  const server = idleServer({
    status: () => ({ body: statusOf('idle', { selection: ['flights'] }) }),
  });
  const m = mount({
    routes: (call) => {
      if (ready) return server(call);
      // Vite's page fallback first (HTML, not JSON), then plain 404s.
      if (first && call.url.endsWith('/status')) {
        first = false;
        return { status: 200, body: undefined };
      }
      return { status: 404, body: { error: 'Not found' } };
    },
  });
  await settle();
  const status = m.get('ai-world-status');
  assert.equal(
    status.textContent,
    AI_WORLD_NOT_READY,
    'the page instead of JSON',
  );
  assert.ok(m.timers.has(60_000), 'asked again in 60 s');
  assert.equal(m.timers.has(15_000), false);
  await m.timers.advance(60_000);
  assert.equal(callsTo(m, '/status').length, 2);
  assert.equal(status.textContent, AI_WORLD_NOT_READY, 'a 404');
  assert.ok(m.timers.has(60_000));
  assert.equal(
    m.get('ai-world-stage-state').textContent,
    'STATE · WAITING FOR THE SERVER',
  );
  // Rows from the DataManager alone, and they still tick.
  assert.deepEqual(rowIds(m), [
    'flights',
    'transit',
    'news',
    'demographics',
    'outbreak-sim',
    'devices',
  ]);
  tick(boxFor(m, 'transit'));
  assert.equal(m.get('ai-world-all').indeterminate, true);
  await m.timers.advance(400);
  assert.equal(callsTo(m, '/selection').length, 1);
  assert.equal(status.textContent, AI_WORLD_NOT_READY);
  assert.equal(
    m.get('ai-world-init').disabled,
    false,
    'INITIALIZE can still be pressed',
  );
  m.get('ai-world-init').click();
  await settle();
  assert.equal(status.textContent, AI_WORLD_NOT_READY);
  assert.equal(m.get('ai-world-estimate').hidden, true);
  // A failed fetch reads the same.
  m.get('ai-world-delete').click();
  await settle();
  assert.equal(status.textContent, AI_WORLD_NOT_READY);
  assert.equal(
    m.get('ai-world-delete-total').textContent,
    'THE FILES COULD NOT BE LISTED',
  );
  m.get('ai-world-delete-cancel').click();

  await m.timers.advance(60_000);
  assert.equal(status.textContent, AI_WORLD_NOT_READY);

  ready = true;
  await m.timers.advance(60_000);
  assert.equal(
    status.textContent,
    '',
    'the line clears once the server answers',
  );
  assert.match(
    m.get('ai-world-stage-state').textContent,
    /^STATE · IDLE · CHANGED \d+ MIN AGO$/,
  );
  assert.deepEqual(rowIds(m), [
    'flights',
    'transit',
    'gdelt-events',
    'news',
    'demographics',
    'outbreak-sim',
    'devices',
  ]);
  // The tick made while it was away is sent, not overwritten by the server's.
  await m.timers.advance(0);
  const sent = callsTo(m, '/selection');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.at(-1).body.selection, ['transit']);
  assert.equal(boxFor(m, 'transit').checked, true);
  assert.equal(boxFor(m, 'flights').checked, false);
  assert.ok(m.timers.has(15_000));
  m.panel.destroy();
});

test('a fetch that fails outright reads NOT READY too', async () => {
  const m = mount({
    routes: () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await settle();
  assert.equal(m.get('ai-world-status').textContent, AI_WORLD_NOT_READY);
  assert.ok(m.timers.has(60_000));
  m.panel.destroy();
});

test('the rows follow the DataManager, looked at once for a burst of notices, and keep their ticks', async () => {
  const m = mount({ routes: idleServer() });
  await settle();
  tick(boxFor(m, 'flights'));
  const texts = m.page.childWrites;
  m.manager.replace([
    ...LAYERS,
    { id: 'wind', name: 'Wind', showInTogglePanel: true },
  ]);
  assert.equal(rowIds(m).includes('wind'), false, 'not before the check');
  await m.timers.advance(500);
  assert.deepEqual(rowIds(m), [
    'flights',
    'transit',
    'wind',
    'gdelt-events',
    'news',
    'demographics',
    'outbreak-sim',
    'devices',
  ]);
  assert.equal(boxFor(m, 'flights').checked, true);
  // Notices that change nothing rebuild nothing.
  const after = m.page.childWrites;
  assert.ok(after > texts);
  m.manager.replace([
    ...LAYERS,
    { id: 'wind', name: 'Wind', showInTogglePanel: true },
  ]);
  await m.timers.advance(500);
  assert.equal(m.page.childWrites, after);
  m.panel.destroy();
});

test('PREDICTIONS: what the predictor draws is a live tick, the rest LEARNING; a change goes to the globe and stays in this browser', async () => {
  const storage = memoryStorage({
    [AI_WORLD_STORAGE_KEY]: JSON.stringify({
      domains: ['weather', 'bogus'],
      horizonHours: 500,
    }),
  });
  const m = mount({
    storage,
    routes: idleServer({
      status: () => ({
        body: statusOf('running', {
          stages: {
            ...statusOf('running').stages,
            predictor: {
              state: 'running',
              domains: ['outbreak', 'weather'],
              updatedAt: NOW,
              error: null,
            },
          },
          learning: { daysRecorded: 3 },
        }),
      }),
    }),
  });
  const horizon = m.get('ai-world-horizon');
  assert.equal(horizon.value, '168', 'the saved horizon, within 1–168 h');
  assert.equal(m.get('ai-world-horizon-value').textContent, '168 H');
  assert.equal(
    m.page.events.length,
    0,
    'nothing drawn before the predictor answers',
  );
  await settle();
  const box = (id) => m.get(`ai-world-domain-${id}`);
  const note = (id) => m.get(`ai-world-domain-${id}-note`).textContent;
  assert.equal(box('outbreak').disabled, false);
  assert.equal(box('outbreak').checked, false);
  assert.equal(box('weather').disabled, false);
  assert.equal(box('weather').checked, true, 'the saved tick');
  assert.equal(box('mobility').disabled, true);
  assert.equal(note('weather'), 'READY');
  assert.equal(note('mobility'), 'LEARNING · 3 DAYS RECORDED');
  assert.equal(m.page.events.length, 1);
  assert.equal(m.page.events[0].type, AI_WORLD_PREDICTIONS_EVENT);
  assert.deepEqual(m.page.events[0].detail, {
    domains: ['weather'],
    horizonHours: 168,
  });

  tick(box('outbreak'));
  assert.deepEqual(m.page.events.at(-1).detail, {
    domains: ['outbreak', 'weather'],
    horizonHours: 168,
  });
  assert.deepEqual(JSON.parse(storage.map.get(AI_WORLD_STORAGE_KEY)), {
    domains: ['outbreak', 'weather'],
    horizonHours: 168,
  });
  horizon.value = '48';
  horizon.dispatch('input');
  assert.equal(m.get('ai-world-horizon-value').textContent, '48 H');
  assert.equal(horizon.getAttribute('aria-valuetext'), '48 HOURS');
  const heard = m.page.events.length;
  horizon.dispatch('change');
  assert.equal(m.page.events.length, heard + 1);
  assert.deepEqual(m.page.events.at(-1).detail, {
    domains: ['outbreak', 'weather'],
    horizonHours: 48,
  });
  assert.equal(
    JSON.parse(storage.map.get(AI_WORLD_STORAGE_KEY)).horizonHours,
    48,
  );
  // The same answer again draws nothing new.
  await m.timers.advance(3_000);
  assert.equal(m.page.events.length, heard + 1);
  m.panel.destroy();
});

test('storage that throws leaves the choice to this visit', async () => {
  const storage = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  const m = mount({ storage, routes: idleServer() });
  await settle();
  const horizon = m.get('ai-world-horizon');
  assert.equal(horizon.value, '24');
  horizon.value = '12';
  horizon.dispatch('change');
  assert.deepEqual(m.page.events.at(-1).detail, {
    domains: [],
    horizonHours: 12,
  });
  m.panel.destroy();
});

test('destroy stops the poll, the pending send and every listener, and drops late answers', async () => {
  let release;
  let slow = false;
  const server = idleServer();
  const m = mount({
    routes: (call) => {
      if (slow && call.url.endsWith('/status'))
        return new Promise((resolve) => {
          release = () => resolve({ body: statusOf('running') });
        });
      return server(call);
    },
  });
  await settle();
  assert.ok(m.page.listeners > 0);
  assert.equal(m.manager.listeners, 1);
  slow = true;
  // The next status request goes out and hangs.
  await m.timers.advance(15_000);
  tick(boxFor(m, 'flights'));
  m.manager.replace(LAYERS);
  assert.equal(
    m.timers.size,
    3,
    'a send, a layer check and the request’s timeout are waiting',
  );
  const said = m.get('ai-world-status').textContent;
  const writes = m.page.textWrites;
  m.panel.destroy();
  assert.equal(m.timers.size, 0, 'no timer left');
  assert.equal(m.page.listeners, 0, 'no listener left');
  assert.equal(m.manager.listeners, 0, 'unsubscribed from the DataManager');
  // The status asked for before destroy lands afterwards and changes nothing.
  release();
  await settle();
  assert.equal(m.get('ai-world-status').textContent, said);
  assert.equal(m.page.textWrites, writes);
  assert.equal(m.get('ai-world-stop').disabled, true, 'still the idle buttons');
  const calls = m.server.calls.length;
  await m.timers.advance(120_000);
  assert.equal(m.server.calls.length, calls, 'nothing more is asked for');
  m.panel.destroy();
});

test('an aborted shell signal takes the box down with it', async () => {
  const controller = new AbortController();
  const { document, page } = fakePage();
  const timers = fakeTimers();
  const server = fakeServer(idleServer());
  const panel = initAiWorldPanel({
    documentRef: document,
    fetchImpl: server.fetch,
    signal: controller.signal,
    storage: memoryStorage(),
    timers,
    now: timers.now,
  });
  await settle();
  assert.ok(page.listeners > 0);
  controller.abort();
  assert.equal(timers.size, 0);
  assert.equal(page.listeners, 0);
  panel.destroy();
});

test('a page without the box: initAiWorldPanel does nothing', () => {
  let asked = 0;
  const panel = initAiWorldPanel({
    documentRef: { getElementById: () => null },
    fetchImpl: () => {
      asked += 1;
      throw new Error('no request expected');
    },
  });
  assert.equal(asked, 0);
  assert.equal(typeof panel.destroy, 'function');
  panel.destroy();
});

test('open, the box is wider than its neighbours, on desktop widths only', () => {
  const css = readFileSync(
    new URL('./ui/styles/aiWorld.css', import.meta.url),
    'utf8',
  );
  const wide = css.slice(css.indexOf('@media (min-width: 721px)'));
  assert.ok(wide.length > 100, 'the wider default is for wider screens only');
  assert.match(
    wide,
    /#ai-world-panel:not\(\.collapsed\):not\(\.panel-user-wide\) \{\s*width: min\(520px,/,
  );
});

test('POST-TRAIN: SAVE and POST-TRAIN NOW send the adapter, the checkpoint and DAILY; the last score shows', async () => {
  const sent = [];
  const m = mount({
    routes: idleServer({
      status: () => ({
        body: {
          ...statusOf('running'),
          posttrain: {
            adapter: 'kit_world:KitWorldAdapter',
            checkpoint: 'mine/world.pt',
            daily: true,
            last: {
              before: 0.5,
              after: 0.4,
              helped: true,
              trainedThrough: '2026-10-15',
            },
          },
        },
      }),
      posttrain: (call) => {
        sent.push(call.body);
        return {
          body: {
            posttrain: {
              adapter: call.body.adapter,
              checkpoint: call.body.checkpoint,
              daily: call.body.daily,
              last: null,
            },
          },
        };
      },
    }),
  });
  await m.timers.advance(0);
  await settle();
  assert.equal(
    m.get('ai-world-posttrain-adapter').value,
    'kit_world:KitWorldAdapter',
  );
  assert.equal(m.get('ai-world-posttrain-checkpoint').value, 'mine/world.pt');
  assert.equal(m.get('ai-world-posttrain-daily').checked, true);
  assert.equal(
    m.get('ai-world-posttrain-note').textContent,
    'SAVED kit_world:KitWorldAdapter · DAILY · LAST: HELD-OUT LOSS 0.500 → 0.400 · HELPED · TRAINED THROUGH 2026-10-15',
  );
  m.get('ai-world-posttrain-adapter').value = 'my_model:Mine';
  m.get('ai-world-posttrain-run').click();
  await settle();
  assert.deepEqual(sent.at(-1), {
    adapter: 'my_model:Mine',
    checkpoint: 'mine/world.pt',
    daily: true,
    run: true,
  });
  assert.equal(
    m.get('ai-world-posttrain-note').textContent,
    'SAVED my_model:Mine · DAILY · NOT RUN YET',
  );
  m.get('ai-world-posttrain-save').click();
  await settle();
  assert.equal(sent.at(-1).run, false);
  m.panel.destroy();
});
