// The TENSORFLOW sections of the AI World tab (src/tensorflowSetup.js): the
// words each state shows, and the four expandable sections built once and
// updated in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TF_SECTIONS,
  initTensorflowSetup,
  tfBoardRunLines,
  tfBoardText,
  tfControlStates,
  tfExportLines,
  tfModelLines,
  tfPosttrainLine,
  tfRunText,
  tfRunnerText,
  tfSkillText,
} from './tensorflowSetup.js';

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
    this.open = false;
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

const doc = {
  createElement: (tag) => new FakeElement(tag),
  activeElement: null,
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const NOW = Date.UTC(2026, 9, 17, 12);
const GPU = 'NVIDIA GeForce RTX 4060 Laptop GPU';

function status(extra = {}) {
  return {
    runner: {
      checking: false,
      checkedAt: NOW,
      kind: 'wsl',
      distro: 'Ubuntu',
      python: '3.13.16',
      tensorflow: '2.21.0',
      gpu: GPU,
    },
    run: { kind: null, state: 'idle', busy: false },
    settings: { epochs: 10, device: 'auto', classes: 'all', withModel: true },
    posttrain: {
      adapter: 'keras_world:KerasWorldAdapter',
      checkpoint: 'ai-world\\tensorflow\\models\\tf-world',
      epochs: 1,
    },
    last: {},
    model: null,
    posttrained: null,
    exports: [],
    board: {
      state: 'off',
      url: '/api/tensorflow/board/',
      port: 6006,
      runs: [],
    },
    ...extra,
  };
}

test('the words: where it runs, the job, the model, TensorBoard, the exports and the post-trained model', () => {
  assert.equal(
    tfSkillText({ model: 0.000418, persistence: 0.000249 }),
    'MAE 0.000418 VS PERSISTENCE 0.000249',
  );
  assert.equal(tfSkillText(null), '');
  assert.equal(
    tfSkillText({ model: null, persistence: 0.2 }),
    '',
    'a blank score is no score',
  );
  assert.equal(tfRunnerText(null), 'RUNS ON · CHECKING THIS PC');
  assert.equal(
    tfRunnerText(status().runner),
    `RUNS ON · GPU ${GPU} · WSL2 UBUNTU · PYTHON 3.13.16 · TENSORFLOW 2.21.0`,
  );
  assert.equal(
    tfRunnerText({
      kind: 'windows',
      python: '3.13.1',
      tensorflow: '2.21.0',
      gpu: null,
      wsl: { tensorflow: null },
    }),
    'RUNS ON · CPU ONLY · WINDOWS · PYTHON 3.13.1 · TENSORFLOW 2.21.0 · FOR THE GPU: npm run tensorflow:wsl-setup',
  );
  assert.match(
    tfRunnerText({ kind: null, checkedAt: NOW }),
    /NO TENSORFLOW YET: npm run tensorflow:wsl-setup/,
  );
  assert.equal(tfRunText({ state: 'idle' }), 'JOB · NONE YET');
  assert.equal(
    tfRunText({
      kind: 'train',
      state: 'running',
      epoch: 2,
      epochs: 10,
      step: 1234,
      loss: 0.000312,
      device: `GPU ${GPU}`,
    }),
    `TENSORFLOW TRAINING · RUNNING · EPOCH 2/10 · STEP 1,234 · LOSS 0.000312 · GPU ${GPU.toUpperCase()}`,
  );
  assert.equal(
    tfRunText({
      kind: 'train',
      state: 'running',
      epoch: 0,
      epochs: 10,
      channelsGrown: true,
    }),
    'TENSORFLOW TRAINING · RUNNING · GREW TO THE NEW CHANNELS',
  );
  assert.equal(
    tfRunText({
      kind: 'export',
      state: 'running',
      stage: 'tfrecord',
      done: 3,
      total: 33,
    }),
    'EXPORT FOR TENSORFLOW · RUNNING · WRITING TFRECORDS · DAY 3/33',
  );
  assert.equal(
    tfRunText({ kind: 'posttrain', state: 'error', error: 'no model at x' }),
    'POST-TRAIN A TENSORFLOW MODEL · ERROR · NO MODEL AT X',
  );
  assert.deepEqual(tfControlStates(status()), {
    start: true,
    pause: false,
    continue: false,
    stop: false,
    posttrain: true,
  });
  assert.deepEqual(
    tfControlStates(
      status({ run: { kind: 'train', state: 'running', busy: true } }),
    ),
    {
      start: false,
      pause: true,
      continue: false,
      stop: true,
      posttrain: false,
    },
  );
  assert.equal(
    tfControlStates(
      status({ run: { kind: 'export', state: 'running', busy: true } }),
    ).pause,
    false,
    'an export only stops',
  );
  assert.deepEqual(
    tfControlStates(
      status({ run: { kind: 'train', state: 'paused', busy: false } }),
    ),
    {
      start: false,
      pause: false,
      continue: true,
      stop: true,
      posttrain: false,
    },
  );
  assert.equal(
    tfControlStates(status({ runner: { kind: null } })).start,
    false,
    'nothing to run on',
  );
  assert.deepEqual(tfModelLines(null), ['NO TENSORFLOW MODEL YET: TRAIN ONE']);
  assert.deepEqual(
    tfModelLines(
      {
        epoch: 3,
        skill: { model: 0.0004, persistence: 0.0002 },
        domains: {
          hazards: { model: 0.0004, persistence: 0.0002 },
          news: null,
          markets: { model: 0.01, persistence: 0.02 },
        },
        device: `GPU ${GPU}`,
        updatedAt: NOW - 5 * 60_000,
        folder: 'ai-world\\tensorflow\\models\\tf-world',
      },
      NOW,
    ),
    [
      `MODEL · EPOCH 3 · MAE 0.000400 VS PERSISTENCE 0.000200 · GPU ${GPU.toUpperCase()} · 5 MIN AGO`,
      'HAZARDS · MAE 0.000400 VS PERSISTENCE 0.000200',
      'PRICE MOVES · MAE 0.0100 VS PERSISTENCE 0.0200',
      'IN .gev-data/ai-world/tensorflow/models/tf-world',
    ],
  );
  assert.equal(
    tfBoardText({ state: 'off', runs: [] }),
    'TENSORBOARD · OFF · 0 RUNS',
  );
  assert.equal(
    tfBoardText({ state: 'running', runs: [{ name: 'world' }] }),
    'TENSORBOARD · RUNNING · 1 RUN',
  );
  assert.equal(
    tfBoardText({ state: 'error', error: 'port in use' }),
    'TENSORBOARD · ERROR · PORT IN USE',
  );
  assert.deepEqual(
    tfBoardRunLines(
      [{ name: 'tf-world', updatedAt: NOW - 2 * 3_600_000 }, { name: 'world' }],
      NOW,
    ),
    ['TF-WORLD · 2 H AGO', 'WORLD'],
  );
  assert.deepEqual(
    tfExportLines([
      {
        name: '2026-10-17T12-30-05Z',
        complete: true,
        days: 33,
        files: 40,
        bytes: 514e6,
        model: true,
        tfliteOk: true,
        publishable: false,
      },
      {
        name: '2026-10-16T09-00-00Z',
        complete: true,
        days: 1,
        files: 1,
        bytes: 2000,
        model: false,
        publishable: true,
      },
      { name: '2026-10-15T09-00-00Z', complete: false },
    ]),
    [
      '2026-10-17T12-30-05Z · 33 DAYS · 40 FILES · 514 MB · SAVEDMODEL + TFLITE (CHECKED) · THIS PC ONLY',
      '2026-10-16T09-00-00Z · 1 DAY · 1 FILE · 2 KB · DATASET ONLY · OPEN ONLY: SHAREABLE',
      '2026-10-15T09-00-00Z · INCOMPLETE',
    ],
  );
  assert.equal(tfPosttrainLine(null), 'NOT POST-TRAINED YET');
  assert.equal(
    tfPosttrainLine({
      before: 0.000172,
      after: 0.000171,
      helped: true,
      trainedThrough: '2026-10-15',
      folder: 'ai-world\\tensorflow\\posttrain\\model',
    }),
    'HELD-OUT LOSS 0.000172 → 0.000171 · HELPED · TRAINED THROUGH 2026-10-15 · IN .gev-data/ai-world/tensorflow/posttrain/model',
  );
  assert.equal(
    tfPosttrainLine({ before: null, after: null, paused: true }),
    'PAUSED PART WAY',
  );
});

function mount(answer) {
  const host = new FakeElement('div');
  const calls = [];
  const fetchImpl = async (url, init) => {
    const route = url.slice('/api/tensorflow/'.length);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, method: init.method, body });
    const { status: code = 200, payload } = answer(route, init.method, body);
    return {
      ok: code >= 200 && code < 300,
      status: code,
      json: async () => payload,
    };
  };
  const setup = initTensorflowSetup({
    host,
    documentRef: doc,
    fetchImpl,
    timers: { setTimeout: () => 0, clearTimeout() {} },
    now: () => NOW,
  });
  const find = (pred) => host.all().find(pred);
  const button = (action) =>
    find((n) => n.tagName === 'BUTTON' && n.dataset.action === action);
  const section = (id) =>
    find((n) => n.tagName === 'DETAILS' && n.dataset.section === id);
  return { host, calls, setup, find, button, section };
}

test('four expandable sections, built once: an open one stays open and a typed value stays while the status polls', async () => {
  let next = status();
  const { host, calls, setup, find, section } = mount((route) => ({
    payload: route === 'status' ? next : next,
  }));
  assert.equal(host.hidden, true, 'hidden until the server answers');
  await settle();
  assert.equal(host.hidden, false);
  const summaries = host
    .all()
    .filter((n) => n.tagName === 'SUMMARY')
    .map((n) => n.textContent);
  assert.deepEqual(
    summaries,
    TF_SECTIONS.map((s) => s.title),
  );
  assert.deepEqual(summaries, [
    'TENSORFLOW TRAINING',
    'TENSORBOARD',
    'EXPORT FOR TENSORFLOW',
    'POST-TRAIN A TENSORFLOW MODEL',
  ]);
  assert.ok(
    host
      .all()
      .filter((n) => n.tagName === 'DETAILS')
      .every((d) => d.open === false),
    'folded at first',
  );
  const epochs = find((n) => n.dataset.field === 'epochs');
  assert.equal(epochs.value, '10', 'filled from the server once');
  assert.equal(
    find((n) => n.dataset.field === 'checkpoint').value,
    'ai-world/tensorflow/models/tf-world',
  );
  const train = section('train');
  train.open = true;
  epochs.value = '25';
  next = status({
    run: {
      kind: 'train',
      state: 'running',
      busy: true,
      epoch: 1,
      epochs: 10,
      loss: 0.5,
    },
  });
  setup.render(next);
  assert.equal(section('train'), train, 'the same element');
  assert.equal(train.open, true, 'still open');
  assert.equal(epochs.value, '25', 'what was typed is kept');
  assert.match(
    find((n) => n.className.split(' ').includes('tf-run')).textContent,
    /EPOCH 1\/10/,
  );
  assert.equal(calls.filter((c) => c.route === 'status').length, 1);
});

test('the buttons post to their routes and the job controls follow the state', async () => {
  let next = status({
    model: { epoch: 1, skill: { model: 0.2, persistence: 0.3 } },
  });
  const { calls, button, find, setup } = mount(() => ({ payload: next }));
  await settle();
  assert.equal(
    button('train').textContent,
    'TRAIN (CARRY ON)',
    'a saved model carries on',
  );
  button('train').click();
  button('fresh').click();
  await settle();
  find((n) => n.dataset.field === 'epochs').value = '3';
  find((n) => n.dataset.field === 'device').value = 'cpu';
  find((n) => n.tagName === 'BUTTON' && n.textContent === 'SAVE').click();
  await settle();
  find((n) => n.dataset.field === 'classes').value = 'open';
  find((n) => n.dataset.field === 'withModel').checked = false;
  button('export').click();
  await settle();
  const posts = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(
    posts.map((c) => [c.route, c.body]),
    [
      ['train', {}],
      ['train', { fresh: true }],
      ['settings', { epochs: 3, device: 'cpu' }],
      ['export', {}],
    ],
  );
  // A running training: PAUSE; paused: CONTINUE; STOP in both.
  next = status({ run: { kind: 'train', state: 'running', busy: true } });
  setup.render(next);
  assert.equal(button('pause').disabled, false);
  assert.equal(button('stop').disabled, false);
  assert.equal(button('train').disabled, true, 'one job at a time');
  button('pause').click();
  await settle();
  next = status({ run: { kind: 'train', state: 'paused', busy: false } });
  setup.render(next);
  assert.equal(button('continue').textContent, 'CONTINUE');
  button('continue').click();
  await settle();
  assert.deepEqual(
    calls
      .filter((c) => c.method === 'POST')
      .slice(-2)
      .map((c) => c.route),
    ['pause', 'continue'],
  );
});

test('TensorBoard: START, then OPEN TENSORBOARD through this app and STOP', async () => {
  let next = status();
  const { calls, button, find, setup } = mount((route) => {
    if (route === 'board-start')
      next = status({
        board: {
          state: 'running',
          url: '/api/tensorflow/board/',
          runs: [{ name: 'world', updatedAt: NOW }],
        },
      });
    return { payload: next };
  });
  await settle();
  const open = find((n) => n.tagName === 'A');
  assert.equal(open.href, '/api/tensorflow/board/');
  assert.equal(open.target, '_blank');
  assert.equal(open.hidden, true, 'nothing to open yet');
  button('board-start').click();
  await settle();
  assert.equal(open.hidden, false);
  assert.equal(button('board-stop').textContent, 'STOP TENSORBOARD');
  assert.match(
    find((n) => n.className.split(' ').includes('tf-board-state')).textContent,
    /RUNNING · 1 RUN/,
  );
  assert.deepEqual(
    find((n) => n.className.split(' ').includes('tf-board-runs')).children.map(
      (li) => li.textContent,
    ),
    ['WORLD · JUST NOW'],
  );
  button('board-stop').click();
  await settle();
  assert.deepEqual(
    calls.filter((c) => c.method === 'POST').map((c) => c.route),
    ['board-start', 'board-stop'],
  );
  setup.destroy();
});

test('post-training saves its adapter, checkpoint and epochs; a refusal shows in the job line', async () => {
  const next = status();
  const { calls, button, find } = mount((route) =>
    route === 'posttrain'
      ? { status: 409, payload: { error: 'No model at that CHECKPOINT yet' } }
      : { payload: next },
  );
  await settle();
  find((n) => n.dataset.field === 'adapter').value =
    ' keras_world:KerasWorldAdapter ';
  find((n) => n.dataset.field === 'checkpoint').value = 'models/mine';
  find((n) => n.dataset.field === 'postEpochs').value = '2';
  const saves = find(
    (n) => n.tagName === 'DETAILS' && n.dataset.section === 'posttrain',
  )
    .all()
    .find((n) => n.tagName === 'BUTTON' && n.textContent === 'SAVE');
  saves.click();
  await settle();
  assert.deepEqual(calls.at(-1), {
    route: 'settings',
    method: 'POST',
    body: {
      posttrain: {
        adapter: 'keras_world:KerasWorldAdapter',
        checkpoint: 'models/mine',
        epochs: 2,
      },
    },
  });
  button('posttrain').click();
  await settle();
  const line = find((n) => n.className.split(' ').includes('tf-run'));
  assert.equal(line.textContent, 'No model at that CHECKPOINT yet');
  assert.equal(line.dataset.ok, 'false');
  assert.equal(
    find((n) => n.className.split(' ').includes('tf-posttrain')).textContent,
    'NOT POST-TRAINED YET',
  );
});

test('no server route (a production build, a LAN visitor): the sections stay hidden', async () => {
  const { host } = mount(() => ({
    status: 404,
    payload: { error: 'Not found' },
  }));
  await settle();
  assert.equal(host.hidden, true);
});
