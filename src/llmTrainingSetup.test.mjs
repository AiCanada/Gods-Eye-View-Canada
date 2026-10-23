import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baseModelHint,
  fetchCommand,
  initLlmTrainingSetup,
  llmControlStates,
  llmModelLines,
  llmStateText,
  pipelineNeeds,
  pipelineText,
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
        family: 'qwen3_5',
        familyLabel: 'QWEN 3.5',
        label: '0.8B',
        gb: 2,
        fit: 'gpu',
        onMachine: true,
        default: true,
        get: 'hf download Qwen/Qwen3.5-0.8B --local-dir .gev-data/llm/base/Qwen3.5-0.8B',
      },
      {
        id: 'Qwen/Qwen3.6-35B-A3B',
        family: 'qwen3_6',
        familyLabel: 'QWEN 3.6',
        label: '35B-A3B',
        gb: 70,
        fit: 'split',
        onMachine: false,
        default: true,
        get: 'hf download Qwen/Qwen3.6-35B-A3B --local-dir .gev-data/llm/base/Qwen3.6-35B-A3B',
      },
      {
        id: 'google/gemma-4-E2B-it',
        family: 'gemma4',
        familyLabel: 'GEMMA 4',
        label: 'E2B',
        gb: 10,
        fit: 'split',
        onMachine: false,
        get: 'hf download google/gemma-4-E2B-it --local-dir .gev-data/llm/base/gemma-4-E2B-it',
      },
    ],
    pipeline: {
      family: 'qwen3_5',
      label: 'QWEN 3.5',
      licence: 'Apache-2.0',
      system: true,
      thinking: 'kwarg',
      lora: 'attention-deltanet',
      data: ['text', 'image'],
      needs: { transformers: '4.57', kernels: [], baseline: '4.57' },
      teacherOnly: false,
      experimental: false,
      size: '0.8B',
      gb: 2,
      fit: 'gpu',
    },
    teachers: [
      {
        family: 'deepseek_v4',
        label: 'DEEPSEEK V4',
        sizes: [{ label: 'PRO 1.6T-A49B' }, { label: 'FLASH 284B-A13B' }],
        served: ['OpenRouter'],
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

function mount(answer, options = {}) {
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
    ...options,
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

test('the base chooser offers every family, one group each, says how a size fits and which are on this PC, and fills the box', async () => {
  const m = mount(() => ({
    payload: status({
      config: { ...status().config, base: 'Qwen/Qwen3.5-0.8B' },
    }),
  }));
  await settle();
  const choice = m.find((n) => n.dataset.field === 'base-choice');
  assert.deepEqual(
    choice.children
      .filter((n) => n.tagName === 'OPTGROUP')
      .map((g) => g.attributes.get('label')),
    ['QWEN 3.5', 'QWEN 3.6', 'GEMMA 4'],
  );
  assert.deepEqual(
    choice
      .all()
      .filter((n) => n.tagName === 'OPTION')
      .map((o) => o.textContent),
    [
      '0.8B · 2 GB · TRAINS ON THE GPU · ON THIS PC',
      '35B-A3B · 70 GB · GPU + RAM · SLOW · NOT ON THIS PC',
      'E2B · 10 GB · GPU + RAM · SLOW · NOT ON THIS PC',
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

test('the PIPELINE line says what a family takes and trains, what it still needs, the teachers only, and COPY THE COMMAND', async () => {
  assert.equal(
    pipelineText(status().pipeline),
    'QWEN 3.5 · TEXT, IMAGES · SYSTEM ROLE · THINKING OFF IN TRAINING · LORA ON ATTENTION AND DELTANET · Apache-2.0 · TRAINS ON THE GPU',
  );
  assert.equal(pipelineNeeds(status().pipeline), '');
  const glimmer = {
    family: 'muse_glimmer',
    label: 'META MUSE GLIMMER',
    licence: 'Apache-2.0',
    system: true,
    thinking: 'strength',
    lora: 'attention-mlp',
    data: ['text', 'image'],
    needs: { transformers: '5.15', kernels: [], baseline: '4.57' },
    fit: 'split',
  };
  assert.equal(
    pipelineNeeds(glimmer),
    'NEEDS TRANSFORMERS 5.15 OR NEWER: py -3.13 -m pip install -U transformers',
  );
  const nemotron = {
    family: 'nemotron_h',
    label: 'NVIDIA NEMOTRON',
    system: true,
    thinking: 'kwarg',
    lora: 'attention-mamba-mlp',
    data: ['text'],
    needs: { transformers: '4.57', kernels: ['causal-conv1d', 'mamba-ssm'], baseline: '4.57' },
    fit: '',
  };
  assert.match(pipelineNeeds(nemotron), /^EXPERIMENTAL: THE FAST PATH NEEDS THE LINUX MAMBA KERNELS/);
  assert.equal(
    pipelineText(nemotron),
    'NVIDIA NEMOTRON · TEXT · SYSTEM ROLE · THINKING OFF IN TRAINING · LORA ON ATTENTION, MAMBA AND MLP',
  );
  assert.equal(
    pipelineText({ family: 'generic', label: 'OTHER', system: true, thinking: 'none', lora: 'attention-deltanet', data: ['text'] }),
    'OTHER · TEXT · SYSTEM ROLE · LORA ON ATTENTION AND DELTANET',
  );
  assert.equal(pipelineText(null), '');
  assert.equal(
    fetchCommand('google/gemma-4-E4B-it'),
    'hf download google/gemma-4-E4B-it --local-dir .gev-data/llm/base/gemma-4-E4B-it',
  );
  assert.equal(fetchCommand('C:\\models\\mine'), '');
  assert.deepEqual(
    llmModelLines([{ name: 'g', base: 'google/gemma-4-E4B-it', pipelineLabel: 'GEMMA 4' }]),
    ['G · google/gemma-4-E4B-it · GEMMA 4'],
  );
  // In the section: the line under the base, what it needs, the teachers, and the copy button for a base not here.
  const copied = [];
  const m = mount(
    () => ({
      payload: status({
        baseOnMachine: false,
        config: { ...status().config, base: 'google/gemma-4-E4B-it' },
        pipeline: glimmer,
      }),
    }),
    {
      copyText: async (text) => {
        copied.push(text);
        return true;
      },
    },
  );
  await settle();
  assert.equal(
    m.find((n) => n.className === 'social-note llm-training-pipeline').textContent,
    `PIPELINE: ${pipelineText(glimmer)}`,
  );
  assert.match(
    m.find((n) => n.className.includes('llm-training-needs')).textContent,
    /NEEDS TRANSFORMERS 5\.15/,
  );
  assert.equal(
    m.find((n) => n.className.includes('llm-training-teachers')).textContent,
    'TEACHERS ONLY, TOO BIG FOR THIS PC: DEEPSEEK V4 (PRO 1.6T-A49B, FLASH 284B-A13B) · USE THEM IN AI DISTILLATION THROUGH OPENROUTER OR THE CUSTOM ENDPOINT',
  );
  m.button('COPY THE COMMAND').click();
  await settle();
  assert.deepEqual(copied, [
    'hf download google/gemma-4-E4B-it --local-dir .gev-data/llm/base/gemma-4-E4B-it',
  ]);
  assert.equal(
    m.find((n) => n.className.includes('llm-training-state')).textContent,
    'COMMAND COPIED',
  );
  m.setup.destroy();
});
