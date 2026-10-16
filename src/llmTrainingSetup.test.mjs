import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baseModelHint,
  initLlmTrainingSetup,
  llmControlStates,
  llmModelLines,
  llmStateText,
} from './llmTrainingSetup.js';

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
    this.children = [];
    if (String(value ?? '')) this.append(String(value));
  }
  append(...nodes) {
    for (const node of nodes) {
      const child =
        typeof node === 'string'
          ? Object.assign(new FakeElement('#text'), { text: node })
          : node;
      child.parentElement = this;
      this.children.push(child);
    }
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
  click() {
    for (const listener of this.listeners.get('click') || []) listener({});
  }
  all() {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

const doc = { createElement: (tag) => new FakeElement(tag) };
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function status(extra = {}) {
  return {
    state: 'idle',
    error: null,
    config: {
      name: 'gev-llm',
      base: 'Qwen/Qwen3-0.6B',
      sources: ['news'],
      epochs: 1,
      postTrainFrom: '',
      daily: false,
    },
    baseOnMachine: true,
    bases: [
      {
        id: 'Qwen/Qwen3.5-0.8B',
        label: 'QWEN3.5-0.8B · DEFAULT',
        onMachine: true,
      },
      {
        id: 'Qwen/Qwen3.6-35B-A3B',
        label: 'QWEN3.6-35B-A3B · 72 GB',
        onMachine: false,
      },
    ],
    sources: [
      { id: 'news', label: 'NEWS HEADLINES', class: 'nc' },
      { id: 'urls', label: 'CUSTOM URLS', class: 'unclear' },
      { id: 'local', label: 'LOCAL SOURCES', class: 'personal' },
    ],
    urls: [{ url: 'https://news.example/a', ok: true }],
    paths: ['C:\\notes'],
    stage: {},
    models: [],
    limits: { urls: 100, paths: 50 },
    ...extra,
  };
}

function mount(answer) {
  const host = new FakeElement('div');
  const calls = [];
  const fetchImpl = async (url, init) => {
    const route = url.split('/').pop();
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, method: init.method, body });
    const {
      status: code = 200,
      payload,
      headers = {},
    } = answer(route, init.method, body);
    return {
      ok: code >= 200 && code < 300,
      status: code,
      headers: { get: (n) => headers[n.toLowerCase()] ?? null },
      json: async () => payload,
    };
  };
  const setup = initLlmTrainingSetup({
    host,
    documentRef: doc,
    fetchImpl,
    timers: { setTimeout: () => 0, clearTimeout() {} },
  });
  const find = (pred) => host.all().find(pred);
  const button = (text) =>
    find((n) => n.tagName === 'BUTTON' && n.textContent === text);
  return { host, calls, setup, find, button };
}

test('the words: run state, models with their data day and held-out loss, the buttons each state allows', () => {
  assert.equal(llmStateText({ state: 'idle' }), 'IDLE');
  assert.equal(llmStateText({ state: 'building' }), 'BUILDING THE DATASET');
  assert.equal(
    llmStateText({
      state: 'training',
      stage: {
        built: { train: 40, heldout: 2 },
        epoch: 1,
        epochs: 2,
        step: 5,
        steps: 10,
        loss: 1.2345,
      },
    }),
    'TRAINING · 40 EXAMPLES (2 HELD OUT) · EPOCH 1/2 · STEP 5/10 · LOSS 1.234',
  );
  assert.equal(
    llmStateText({ state: 'error', error: 'base model not on this machine' }),
    'ERROR · BASE MODEL NOT ON THIS MACHINE',
  );
  assert.deepEqual(
    llmModelLines([
      {
        name: 'port-watch',
        base: 'Qwen/Qwen3-0.6B',
        dataThrough: '2026-10-15',
        heldOutLossBefore: 2.1,
        heldOutLossAfter: 1.4,
        helped: true,
        postTrainedFrom: 'port-watch',
      },
      { name: 'x', base: 'b', heldOutLossBefore: null, heldOutLossAfter: null },
    ]),
    [
      'PORT-WATCH · Qwen/Qwen3-0.6B · DATA TO 2026-10-15 · HELD-OUT LOSS 2.100 → 1.400 · LEARNED · POST-TRAINED FROM port-watch',
      'X · b',
    ],
  );
  assert.deepEqual(llmControlStates('training'), {
    initialize: false,
    pause: true,
    continue: false,
    stop: true,
    edit: false,
  });
  assert.equal(llmControlStates('paused').continue, true);
  assert.equal(llmControlStates('done').initialize, true);
});

test('the section: sources ticked, URLs and local sources added and removed, INITIALIZE TRAINING sent', async () => {
  let current = status();
  const m = mount((route, method, body) => {
    if (route === 'urls' && method === 'POST')
      current = status({ urls: [...current.urls, { url: body.url }] });
    if (route === 'config')
      current = status({ config: { ...current.config, ...body } });
    if (route === 'initialize') current = status({ state: 'building' });
    return { payload: current };
  });
  await settle();
  const text = m.host.textContent;
  assert.match(text, /CUSTOM LLM TRAINING · ON THIS MACHINE/);
  assert.match(text, /ON THIS MACHINE/);
  assert.match(text, /https:\/\/news\.example\/a · FETCHED/);
  assert.match(text, /C:\\notes/);
  // A URL is added.
  const urlEntry = m.find((n) => n.dataset.field === 'urls-entry');
  urlEntry.value = 'https://news.example/b';
  m.find((n) => n.tagName === 'BUTTON' && n.textContent === 'ADD').click();
  await settle();
  assert.deepEqual(m.calls.at(-1), {
    route: 'urls',
    method: 'POST',
    body: { url: 'https://news.example/b' },
  });
  assert.match(m.host.textContent, /news\.example\/b · NOT FETCHED YET/);
  // The ticked sources go with SAVE SETTINGS.
  m.find((n) => n.dataset.source === 'local').checked = true;
  m.button('SAVE SETTINGS').click();
  await settle();
  assert.deepEqual(m.calls.at(-1).body.sources, ['news', 'local']);
  // INITIALIZE TRAINING, then the buttons follow the run.
  m.button('INITIALIZE TRAINING').click();
  await settle();
  assert.equal(m.calls.at(-1).route, 'initialize');
  assert.equal(m.button('INITIALIZE TRAINING').disabled, true);
  assert.equal(m.button('STOP').disabled, false);
  assert.match(m.host.textContent, /BUILDING THE DATASET/);
  m.setup.destroy();
});

test('REMOVE on the owner’s phone is refused with no message and the list stays', async () => {
  const m = mount((route, method) =>
    method === 'DELETE'
      ? {
          status: 403,
          payload: { removal: 'pc-only' },
          headers: { 'x-gev-removal': 'pc-only' },
        }
      : { payload: status() },
  );
  await settle();
  m.find((n) => n.tagName === 'BUTTON' && n.textContent === 'REMOVE').click();
  await settle();
  assert.equal(m.calls.at(-1).method, 'DELETE');
  assert.match(m.host.textContent, /news\.example\/a/);
  assert.doesNotMatch(m.host.textContent, /ERROR|HTTP 403/);
  m.setup.destroy();
});

test('a server error is shown in the status line; no route shows nothing', async () => {
  const m = mount((route) =>
    route === 'initialize'
      ? { status: 400, payload: { error: 'Tick at least one data source.' } }
      : { payload: status() },
  );
  await settle();
  m.button('INITIALIZE TRAINING').click();
  await settle();
  assert.match(m.host.textContent, /Tick at least one data source\./);
  const gone = mount(() => ({ status: 404, payload: {} }));
  await settle();
  assert.equal(gone.host.hidden, true);
});

test('a base model not on this PC: the one command to fetch it, nothing downloaded by the app', () => {
  assert.equal(
    baseModelHint({ baseOnMachine: true, config: { base: 'Qwen/Qwen3-0.6B' } }),
    '',
  );
  assert.match(
    baseModelHint({
      baseOnMachine: false,
      config: { base: 'Qwen/Qwen3-0.6B' },
    }),
    /hf download Qwen\/Qwen3-0\.6B --local-dir \.gev-data\/llm\/base\/Qwen3-0\.6B/,
  );
  assert.match(
    baseModelHint({ baseOnMachine: false, config: { base: 'C:\models\mine' } }),
    /NO MODEL IN THAT FOLDER/,
  );
});

test('the base chooser offers Qwen3.5-0.8B and Qwen3.6-35B-A3B, says which are on this PC, and fills the box', async () => {
  const m = mount(() => ({
    payload: status({
      config: { ...status().config, base: 'Qwen/Qwen3.5-0.8B' },
    }),
  }));
  await settle();
  const choice = m.find((n) => n.dataset.field === 'base-choice');
  assert.deepEqual(
    choice.children.map((o) => o.textContent),
    [
      'QWEN3.5-0.8B · DEFAULT · ON THIS PC',
      'QWEN3.6-35B-A3B · 72 GB · NOT ON THIS PC',
      'ANOTHER MODEL (TYPE IT IN THE BOX)',
    ],
  );
  assert.equal(choice.value, 'Qwen/Qwen3.5-0.8B');
  choice.value = 'Qwen/Qwen3.6-35B-A3B';
  for (const listener of choice.listeners.get('change') || []) listener({});
  assert.equal(
    m.find((n) => n.dataset.field === 'base').value,
    'Qwen/Qwen3.6-35B-A3B',
  );
  m.setup.destroy();
});
