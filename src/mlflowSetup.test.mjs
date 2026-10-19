// The MLFLOW sections of the AI World tab (src/mlflowSetup.js): the words each
// state shows, and the six expandable sections built once and updated in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MLFLOW_SECTIONS,
  evaluationLines,
  initMlflowSetup,
  mlflowControlStates,
  mlflowHeadText,
  mlflowRunText,
  registryLines,
  serverText,
  servingText,
  sourceLabel,
  traceHref,
  trackedRunLines,
  trackingText,
  versionOptions,
} from './mlflowSetup.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.value = '';
    this.text = '';
  }
  get textContent() {
    return this.tagName === '#TEXT'
      ? this.text
      : this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.children = [];
    if (String(value ?? '')) this.append(String(value));
  }
  append(...nodes) {
    for (const node of nodes)
      this.children.push(
        typeof node === 'string'
          ? Object.assign(new FakeElement('#text'), { text: node })
          : node,
      );
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
  fire(type) {
    for (const listener of this.listeners.get(type) || []) listener({});
  }
  click() {
    this.fire('click');
  }
  all() {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

const doc = { createElement: (tag) => new FakeElement(tag) };
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const NOW = Date.UTC(2026, 9, 18, 12);

function status(extra = {}) {
  return {
    installed: { checking: false, mlflow: '3.17.1', python: '3.13.1' },
    settings: { tracking: true },
    server: { state: 'running', url: '/api/mlflow/ui/', held: false },
    tracking: {
      enabled: true,
      active: 0,
      queued: 0,
      dropped: 0,
      logged: 12,
      recent: [],
    },
    registry: { models: [], error: null },
    sources: [
      {
        id: 'world',
        kind: 'world',
        label: 'KIT WORLD MODEL (PYTORCH)',
        defaultName: 'gev-world',
      },
      {
        id: 'llm:my-llm',
        kind: 'llm',
        label: 'CUSTOM LLM MY-LLM',
        defaultName: 'gev-llm-my-llm',
      },
    ],
    run: { kind: null, state: 'idle', busy: false },
    last: {},
    serving: {
      state: 'off',
      name: null,
      version: null,
      url: '/api/mlflow/serve/invocations',
    },
    ...extra,
  };
}

const models = {
  models: [
    {
      name: 'gev-world',
      kind: 'world',
      aliases: { champion: '2', challenger: '3' },
      versions: [
        { version: '3', tags: {} },
        { version: '2', tags: { 'gev.eval.mae': '0.000418' } },
      ],
    },
  ],
};

test('the words: what this PC has, the job, tracking, the server, the registry, serving, evaluation, traces', () => {
  assert.equal(
    mlflowHeadText(status()),
    'MLFLOW 3.17.1 · PYTHON 3.13.1 · SERVER RUNNING',
  );
  assert.equal(
    mlflowHeadText({ installed: { checking: true } }),
    'MLFLOW · CHECKING THIS PC',
  );
  assert.match(
    mlflowHeadText({ installed: { checking: false, mlflow: null } }),
    /pip install mlflow/,
  );
  assert.equal(mlflowRunText({}), 'JOB · NONE YET');
  assert.equal(
    mlflowRunText({
      kind: 'evaluate',
      state: 'running',
      done: 0,
      total: 2,
      name: 'gev-world',
      version: '3',
    }),
    'EVALUATION · RUNNING · MODEL 1/2 · GEV-WORLD V3',
  );
  assert.equal(
    mlflowRunText({
      kind: 'register',
      state: 'error',
      error: 'no checkpoint.pt',
    }),
    'MODEL REGISTRY · ERROR · NO CHECKPOINT.PT',
  );
  assert.equal(trackingText({ enabled: false }), 'TRACKING · OFF');
  assert.equal(
    trackingText({
      enabled: true,
      active: 1,
      logged: 1234,
      queued: 20,
      dropped: 3,
    }),
    'TRACKING · ON · 1 RUN GOING · 1,234 POINTS SENT · 20 WAITING FOR THE SERVER · 3 DROPPED',
  );
  assert.deepEqual(
    trackedRunLines(
      [
        {
          name: 'world 2026-10-18 11:58',
          state: 'FINISHED',
          startedAt: NOW - 2 * 60_000,
          last: {
            'train/loss': 0.0123,
            'held-out/mae': 0.1,
            'held-out/persistence': 0.2,
          },
        },
      ],
      NOW,
    ),
    [
      'WORLD 2026-10-18 11:58 · DONE · LOSS 0.0123 · MAE 0.100 VS PERSISTENCE 0.200 · 2 MIN AGO',
    ],
  );
  assert.equal(
    serverText({ state: 'off', held: true }),
    'MLFLOW SERVER · OFF (TRACKING WAITS UNTIL YOU START IT)',
  );
  assert.equal(
    serverText({ state: 'error', error: 'port in use' }),
    'MLFLOW SERVER · ERROR · PORT IN USE',
  );
  assert.deepEqual(registryLines(models), [
    'GEV-WORLD · WORLD MODEL (PYTORCH) · V2 CHAMPION · V3 CHALLENGER · 2 VERSIONS · V2 EVALUATED MAE 0.000418',
  ]);
  assert.deepEqual(versionOptions(models), [
    { value: 'gev-world/3', text: 'GEV-WORLD V3 · CHALLENGER' },
    { value: 'gev-world/2', text: 'GEV-WORLD V2 · CHAMPION' },
  ]);
  assert.equal(versionOptions(models, ['llm']).length, 0);
  assert.equal(servingText({ state: 'off' }), 'SERVING · OFF');
  assert.equal(
    servingText({
      state: 'running',
      name: 'gev-world',
      version: '2',
      test: { ok: true, shape: [1, 6, 4, 73], ms: 22 },
    }),
    'SERVING · RUNNING · GEV-WORLD V2 · TEST OK · SHAPE 1 × 6 × 4 × 73 · 22 MS',
  );
  assert.equal(
    servingText({
      state: 'running',
      name: 'gev-llm',
      version: '1',
      test: { ok: true, answer: 'Shipping.' },
    }),
    'SERVING · RUNNING · GEV-LLM V1 · TEST ANSWER: Shipping.',
  );
  assert.deepEqual(evaluationLines(null), ['NOT EVALUATED YET']);
  assert.deepEqual(
    evaluationLines({
      rows: [
        {
          name: 'gev-world',
          version: '2',
          mae: 0.1,
          persistence: 0.2,
          domains: { hazards: { mae: 0.05, persistence: 0.1 } },
        },
        { name: 'gev-tf-world', version: '1', mae: null, persistence: null },
      ],
      best: { name: 'gev-world', version: '2' },
      heldOutDays: ['2026-10-15', '2026-10-16'],
    }),
    [
      'GEV-WORLD V2 · MAE 0.100 VS PERSISTENCE 0.200 · BEST',
      'GEV-TF-WORLD V1 · NO OBSERVED TARGETS',
      'HAZARDS · MAE 0.0500 VS PERSISTENCE 0.100',
      'HELD OUT 2026-10-15 TO 2026-10-16',
    ],
  );
  assert.equal(
    traceHref({ traceId: 'tr-1', experimentId: '7' }),
    '/api/mlflow/ui/#/experiments/7/traces?selectedEvaluationId=tr-1&traceId=tr-1',
  );
  assert.equal(traceHref({ traceId: null }), '');
  assert.equal(
    sourceLabel({ kind: 'llm', label: 'CUSTOM LLM MY-LLM' }),
    'CUSTOM LLM MY-LLM',
  );
  assert.equal(
    sourceLabel({ kind: 'world', label: 'KIT WORLD MODEL (PYTORCH)' }),
    'KIT WORLD MODEL (PYTORCH)',
  );
  assert.deepEqual(mlflowControlStates(status()), {
    serverStart: false,
    serverStop: true,
    open: true,
    job: true,
    alias: true,
    serveStart: true,
    serveStop: false,
    serveTest: false,
  });
  assert.equal(
    mlflowControlStates(status({ run: { busy: true } })).job,
    false,
    'one job at a time',
  );
  assert.equal(
    mlflowControlStates(status({ installed: { mlflow: null } })).serverStart,
    false,
  );
});

function mount(answer) {
  const host = new FakeElement('div');
  const calls = [];
  const fetchImpl = async (url, init) => {
    const route = url.slice('/api/mlflow/'.length);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, method: init.method, body });
    const { status: code = 200, payload } = answer(route, body);
    return { ok: code < 300, status: code, json: async () => payload };
  };
  const setup = initMlflowSetup({
    host,
    documentRef: doc,
    fetchImpl,
    timers: { setTimeout: () => 0, clearTimeout() {} },
    now: () => NOW,
  });
  const find = (pred) => host.all().find(pred);
  const button = (action) =>
    find((n) => n.tagName === 'BUTTON' && n.dataset.action === action);
  const field = (name) => find((n) => n.dataset.field === name);
  return { host, calls, setup, find, button, field };
}

test('six sections, built once: the buttons post to their routes, the selects keep a choice, the trace opens in MLflow', async () => {
  let next = status({ registry: models });
  const { host, calls, setup, find, button, field } = mount((route) => {
    if (route === 'ask')
      next = status({
        registry: models,
        last: {
          ask: {
            model: 'my-llm',
            prompt: 'p',
            answer: 'Shipping.',
            traceId: 'tr-1',
            experimentId: '7',
          },
        },
      });
    return { payload: next };
  });
  assert.equal(host.hidden, true);
  await settle();
  assert.equal(host.hidden, false);
  assert.deepEqual(
    host
      .all()
      .filter((n) => n.tagName === 'SUMMARY')
      .map((n) => n.textContent),
    MLFLOW_SECTIONS.map((s) => s.title),
  );
  const registry = find(
    (n) => n.tagName === 'DETAILS' && n.dataset.section === 'registry',
  );
  registry.open = true;
  assert.equal(field('tracking').checked, true);
  field('tracking').checked = false;
  field('tracking').fire('change');
  await settle();
  assert.equal(field('source').value, 'world');
  assert.equal(field('name').placeholder, 'gev-world');
  field('alias').value = 'champion';
  button('register').click();
  await settle();
  field('aliasVersion').value = 'gev-world/3';
  field('aliasName').value = 'champion';
  button('alias').click();
  await settle();
  field('serveVersion').value = 'gev-world/2';
  button('serve-start').click();
  button('evaluate').click();
  await settle();
  assert.equal(field('llm').value, 'my-llm');
  field('prompt').value = 'What moved before crude oil?';
  button('ask').click();
  await settle();
  const posts = calls
    .filter((c) => c.method === 'POST')
    .map((c) => [c.route, c.body]);
  assert.deepEqual(posts, [
    ['settings', { tracking: false }],
    ['register', { source: 'world', alias: 'champion' }],
    ['alias', { name: 'gev-world', version: '3', alias: 'champion' }],
    ['serve-start', { name: 'gev-world', version: '2' }],
    ['evaluate', {}],
    ['ask', { model: 'my-llm', prompt: 'What moved before crude oil?' }],
  ]);
  assert.equal(registry.open, true, 'an open section stays open');
  assert.equal(
    find((n) => n.className.split(' ').includes('mlflow-answer')).textContent,
    'MY-LLM: Shipping.',
  );
  const trace = find((n) => n.className.split(' ').includes('mlflow-trace'));
  assert.equal(trace.hidden, false);
  assert.equal(
    trace.href,
    '/api/mlflow/ui/#/experiments/7/traces?selectedEvaluationId=tr-1&traceId=tr-1',
  );
  const open = find((n) => n.className.split(' ').includes('mlflow-open'));
  assert.equal(open.href, '/api/mlflow/ui/');
  assert.equal(open.hidden, false);
  setup.render(status({ server: { state: 'off', held: true } }));
  assert.equal(open.hidden, true, 'nothing to open while the server is off');
  assert.equal(button('server-start').disabled, false);
  setup.destroy();
});

test('a refusal shows in the job line; no server route keeps the sections hidden', async () => {
  const { find, button } = mount((route) =>
    route === 'evaluate'
      ? {
          status: 400,
          payload: { error: 'no registered world model to evaluate' },
        }
      : { payload: status() },
  );
  await settle();
  button('evaluate').click();
  await settle();
  const line = find((n) => n.className.split(' ').includes('mlflow-run'));
  assert.equal(line.textContent, 'no registered world model to evaluate');
  assert.equal(line.dataset.ok, 'false');
  const hidden = mount(() => ({ status: 404, payload: {} }));
  await settle();
  assert.equal(hidden.host.hidden, true);
});
