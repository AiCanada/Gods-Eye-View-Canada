// The AI DISTILLATION tab (src/distillPanel.js): the words, the seven headings
// with the owner's sub-headings built once and updated in place, the settings,
// the run with its estimate and the paste-back box.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateText,
  featureSummary,
  initDistillPanel,
  pendingText,
  runText,
  teacherState,
} from './distillPanel.js';
import { DISTILL_HEADINGS } from './distillCore.mjs';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parent = null;
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
    this.files = null;
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
    for (const node of nodes) {
      const child =
        typeof node === 'string'
          ? Object.assign(new FakeElement('#text'), { text: node })
          : node;
      child.parent = this;
      this.children.push(child);
    }
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function teachers() {
  return [
    {
      id: 'llm:xai',
      label: 'xAI Grok',
      kind: 'llm',
      model: 'grok-4.6',
      ready: true,
      routes: ['api'],
    },
    {
      id: 'llm:nvidia',
      label: 'NVIDIA NIM',
      kind: 'llm',
      model: 'kimi',
      ready: false,
      routes: [],
    },
    {
      id: 'grok-bot',
      label: 'GROK BOT',
      kind: 'bot',
      app: 'grok-bot',
      model: 'grok-4.6',
      ready: true,
      routes: ['computer', 'webhook', 'desktop'],
    },
    {
      id: 'openai-dots',
      label: 'OPENAI DOTS',
      kind: 'bot',
      app: 'chatgpt',
      model: 'gpt',
      ready: true,
      routes: ['desktop'],
      manualOnly: true,
    },
  ];
}

function feature(extra) {
  return {
    id: 'h2-abc',
    heading: 2,
    name: 'Graded run',
    questions: 3,
    preview: ['What moved before crude oil?'],
    cursor: 1,
    done: 1,
    failed: 0,
    records: 1,
    config: {
      teachers: ['llm:xai'],
      reviewers: ['grok-bot'],
      review: true,
      pick: 'best-graded',
      writer: '',
      webSearch: true,
      prompts: {},
    },
    ...extra,
  };
}

function status(extra = {}) {
  return {
    headings: DISTILL_HEADINGS,
    teachers: teachers(),
    prompts: {
      system: 'SYS DEFAULT',
      review: 'REVIEW DEFAULT',
      grade: 'GRADE DEFAULT',
      write: 'WRITE DEFAULT',
    },
    features: [
      feature(),
      feature({
        id: 'h6-def',
        heading: 6,
        name: 'Reflect',
        config: {
          t1: 'llm:xai',
          t2: 'grok-bot',
          turn3From: 'turn2',
          webSearch: false,
          prompts: { review: 'MY REVIEW' },
        },
      }),
    ],
    run: { state: 'idle', featureId: null, busy: false },
    datasetClass: 'restricted',
    ...extra,
  };
}

test('the words: a teacher route by route, the run, a sub-heading, the estimate and the paste box', () => {
  assert.deepEqual(teacherState(teachers()[0]), {
    state: 'ready',
    text: 'KEY · grok-4.6',
  });
  assert.deepEqual(teacherState(teachers()[1]), {
    state: 'off',
    text: 'NOT SET UP: ADD ITS KEY IN POWER UP',
  });
  assert.deepEqual(teacherState(teachers()[2]), {
    state: 'ready',
    text: 'GROK BOT COMPUTER · grok-4.6 · THEN CHIEF OF STAFF WEBHOOK, APP',
  });
  assert.deepEqual(teacherState(teachers()[3]), {
    state: 'paste',
    text: 'APP · PASTE THE REPLY BACK',
  });
  // Where this PC brings an app's reply back by itself.
  assert.deepEqual(teacherState({ ...teachers()[3], auto: true }), {
    state: 'ready',
    text: 'APP · THE REPLY COMES BACK BY ITSELF',
  });
  assert.equal(runText({ state: 'idle' }), 'RUN · IDLE');
  assert.equal(
    runText({
      state: 'running',
      featureId: 'x',
      name: 'Graded run',
      question: 2,
      total: 3,
      calls: 9,
      pauseWanted: true,
    }),
    'RUN · RUNNING · GRADED RUN · QUESTION 2/3 · 9 CALLS · PAUSES AFTER THIS QUESTION',
  );
  assert.equal(
    runText({ state: 'error', featureId: 'x', name: 'r', error: 'gone' }),
    'RUN · ERROR · R · GONE',
  );
  assert.equal(
    runText({
      state: 'running',
      featureId: 'x',
      name: 'r',
      question: 1,
      total: 1,
      desktop: { app: 'chatgpt', teacher: 'openai-dots' },
    }),
    'RUN · RUNNING · R · QUESTION 1/1 · CHATGPT IS ANSWERING: ITS REPLY COMES BACK BY ITSELF',
  );
  assert.equal(
    featureSummary(feature()),
    'Graded run · 3 QUESTIONS · 1 DONE · 1 GROUND TRUTH',
  );
  assert.equal(
    estimateText({
      questions: 2,
      from: 2,
      callsPerQuestion: 3,
      calls: 6,
      pastes: 2,
    }),
    '2 QUESTIONS FROM QUESTION 2 · 3 PAID CALLS EACH · 6 CALLS IN ALL · 2 REPLIES TO PASTE BACK',
  );
  assert.equal(
    pendingText({
      label: 'OPENAI DOTS',
      app: 'chatgpt',
      route: 'desktop',
      question: 2,
      turn: 3,
    }),
    'WAITING FOR YOUR PASTE · OPENAI DOTS · QUESTION 2 · TURN 3 · OPEN CHATGPT, PASTE THE PROMPT THERE, THEN PASTE ITS REPLY HERE',
  );
  assert.match(
    pendingText({
      label: 'GROK BOT',
      app: 'grok-bot',
      route: 'webhook',
      question: 1,
      turn: 1,
    }),
    /CHIEF OF STAFF WEBHOOK/,
  );
  // The app had the prompt, but its reply did not come back: paste only the reply.
  assert.equal(
    pendingText({
      label: 'GROK BOT',
      app: 'grok-bot',
      route: 'desktop',
      question: 1,
      turn: 2,
      sent: true,
      note: 'no finished reply in time',
    }),
    'WAITING FOR YOUR PASTE · GROK BOT · QUESTION 1 · TURN 2 · THE REPLY DID NOT COME BACK BY ITSELF (NO FINISHED REPLY IN TIME) · ALREADY IN GROK BOT: PASTE ITS REPLY HERE',
  );
});

function mount(answer) {
  const nodes = {
    'distill-body': new FakeElement('div'),
    'distill-status': new FakeElement('div'),
  };
  const doc = {
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => nodes[id] || null,
    activeElement: null,
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const route = url.startsWith('/api/distill/')
      ? url.slice('/api/distill/'.length)
      : url;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, method: init.method, body });
    const { status: code = 200, payload } = answer(route, body, init.method);
    return {
      ok: code < 300,
      status: code,
      headers: { get: () => null },
      json: async () => payload,
    };
  };
  const panel = initDistillPanel({
    documentRef: doc,
    fetchImpl,
    timers: { setTimeout: () => 0, clearTimeout() {} },
    copyText: async () => true,
  });
  const host = nodes['distill-body'];
  const find = (pred, from = host) => from.all().find(pred);
  const box = (id) =>
    find((n) => n.tagName === 'DETAILS' && n.dataset.feature === id);
  const inBox = (id, pred) => find(pred, box(id));
  const action = (id, name) =>
    inBox(id, (n) => n.tagName === 'BUTTON' && n.dataset.action === name);
  return {
    panel,
    host,
    line: nodes['distill-status'],
    calls,
    find,
    box,
    inBox,
    action,
  };
}

test('seven headings, the owner sub-headings under their own, settings kept while edited, SAVE posts what the heading asks for', async () => {
  let next = status();
  const { host, calls, find, box, inBox, action, panel } = mount((route) => {
    if (route === 'features')
      next = status({
        features: [
          ...next.features,
          feature({ id: 'h2-new', name: 'Another' }),
        ],
      });
    return { payload: next };
  });
  assert.equal(host.hidden, true);
  await settle();
  assert.equal(host.hidden, false);
  const headings = host
    .all()
    .filter((n) => n.tagName === 'DETAILS' && n.dataset.heading);
  assert.deepEqual(
    headings.map((h) => h.children[0].textContent),
    DISTILL_HEADINGS.map((h) => h.title),
  );
  assert.equal(box('h2-abc').parent.parent, headings[1], 'under heading 2');
  assert.equal(box('h6-def').parent.parent, headings[5], 'under heading 6');
  // Heading 2: a tick per teacher, the chosen ones ticked; an unready one cannot be ticked.
  const tick = (field, id) =>
    inBox(
      'h2-abc',
      (n) =>
        n.dataset.teacher === id && n.parent?.parent?.dataset.field === field,
    );
  assert.equal(tick('teachers', 'llm:xai').checked, true);
  assert.equal(tick('teachers', 'llm:nvidia').disabled, true);
  assert.equal(tick('reviewers', 'grok-bot').checked, true);
  assert.equal(
    inBox(
      'h6-def',
      (n) => n.tagName === 'TEXTAREA' && n.value === 'MY REVIEW',
    ) !== undefined,
    true,
  );
  assert.equal(
    inBox(
      'h6-def',
      (n) => n.tagName === 'TEXTAREA' && n.value === 'SYS DEFAULT',
    ) !== undefined,
    true,
    'defaults fill the rest',
  );
  const open = box('h2-abc');
  open.open = true;
  tick('teachers', 'openai-dots').checked = true;
  tick('teachers', 'openai-dots').fire('change');
  panel.render(next);
  assert.equal(box('h2-abc'), open, 'the same element');
  assert.equal(open.open, true);
  assert.equal(
    tick('teachers', 'openai-dots').checked,
    true,
    'an edit is kept until SAVE',
  );
  action('h2-abc', 'save').click();
  await settle();
  const save = calls.find((c) => c.route === 'features/update');
  assert.deepEqual(save.body, {
    id: 'h2-abc',
    config: {
      webSearch: true,
      prompts: {
        system: 'SYS DEFAULT',
        grade: 'GRADE DEFAULT',
        write: 'WRITE DEFAULT',
      },
      writer: '',
      teachers: ['llm:xai', 'openai-dots'],
      reviewers: ['grok-bot'],
      review: true,
      pick: 'best-graded',
    },
  });
  // ADD HEADING under heading 2 builds the new one there.
  const name = find((n) => n.dataset.field === 'new-name', headings[1]);
  name.value = 'Another';
  find((n) => n.dataset.action === 'add-feature', headings[1]).click();
  await settle();
  assert.deepEqual(calls.at(-1), {
    route: 'features',
    method: 'POST',
    body: { heading: 2, name: 'Another' },
  });
  assert.ok(box('h2-new'));
  // Heading 6 asks for two teachers and where turn 3 goes.
  const selects = box('h6-def')
    .all()
    .filter((n) => n.tagName === 'SELECT');
  assert.deepEqual(
    selects.map((s) => s.value),
    ['llm:xai', 'grok-bot', 'turn2'],
  );
});

test('ESTIMATE, then CONFIRM START; the paste box while a fallback waits; a delete takes two presses', async () => {
  let next = status();
  const { line, calls, find, action } = mount((route, body, method) => {
    if (route === 'estimate')
      return {
        payload: {
          estimate: {
            questions: 2,
            from: 2,
            callsPerQuestion: 4,
            calls: 8,
            pastes: 0,
          },
        },
      };
    if (route === 'start')
      next = status({
        run: {
          state: 'waiting',
          featureId: 'h2-abc',
          name: 'Graded run',
          busy: true,
          question: 2,
          total: 3,
          pending: {
            teacher: 'openai-dots',
            label: 'OPENAI DOTS',
            app: 'chatgpt',
            route: 'desktop',
            prompt: 'SYS\n\nQ2?',
            question: 2,
            turn: 1,
          },
        },
      });
    if (route === 'paste')
      next = status({
        run: {
          state: 'running',
          featureId: 'h2-abc',
          name: 'Graded run',
          busy: true,
        },
      });
    if (route === '/api/social/openai-dots/open')
      return { payload: { ok: true, pasted: true } };
    if (method === 'DELETE')
      return { payload: status({ features: [next.features[1]] }) };
    return { payload: next };
  });
  await settle();
  assert.equal(
    action('h2-abc', 'start').disabled,
    true,
    'no start before an estimate',
  );
  action('h2-abc', 'estimate').click();
  await settle();
  assert.match(
    find(
      (n) =>
        n.className === 'distill-note' && n.textContent.includes('PAID CALLS'),
    ).textContent,
    /8 CALLS IN ALL/,
  );
  action('h2-abc', 'start').click();
  await settle();
  assert.deepEqual(calls.at(-1).body, {
    id: 'h2-abc',
    confirm: true,
    fresh: false,
  });
  const pending = find((n) => n.className === 'distill-pending');
  assert.equal(pending.hidden, false);
  assert.equal(
    find((n) => n.tagName === 'TEXTAREA' && n.readOnly === true).value,
    'SYS\n\nQ2?',
  );
  assert.match(
    line.textContent,
    /WAITING FOR YOUR PASTE · GRADED RUN · QUESTION 2\/3/,
  );
  find((n) => n.dataset.action === 'open-app').click();
  await settle();
  assert.deepEqual(calls.at(-1), {
    route: '/api/social/openai-dots/open',
    method: 'POST',
    body: { paste: true, text: 'SYS\n\nQ2?' },
  });
  find(
    (n) => n.tagName === 'TEXTAREA' && n.placeholder === 'Paste the reply here',
  ).value = 'The reply';
  find((n) => n.dataset.action === 'paste').click();
  await settle();
  assert.deepEqual(calls.at(-1), {
    route: 'paste',
    method: 'POST',
    body: { answer: 'The reply' },
  });
  assert.equal(pending.hidden, true);
  next = status();
  const remove = action('h2-abc', 'remove');
  remove.click();
  assert.equal(remove.textContent, 'PRESS AGAIN TO CONFIRM');
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
  remove.click();
  await settle();
  assert.deepEqual(calls.at(-1), {
    route: 'features',
    method: 'DELETE',
    body: { id: 'h2-abc' },
  });
  assert.equal(
    find((n) => n.dataset.feature === 'h2-abc'),
    undefined,
    'gone from the tab',
  );
});

test('a refusal shows on the run line; no server route keeps the box to its instructions', async () => {
  const { line, action } = mount((route) =>
    route === 'estimate'
      ? { status: 400, payload: { error: 'OPENAI DOTS is not set up' } }
      : { payload: status() },
  );
  await settle();
  action('h2-abc', 'estimate').click();
  await settle();
  assert.equal(line.textContent, 'OPENAI DOTS is not set up');
  assert.equal(line.dataset.ok, 'false');
  const none = mount(() => ({ status: 404, payload: {} }));
  await settle();
  assert.equal(none.host.hidden, true);
});
