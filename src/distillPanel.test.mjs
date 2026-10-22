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
  planText,
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
      upgrade: 'UPGRADE DEFAULT',
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
    featureSummary(feature({ failed: 2 })),
    'Graded run · 3 QUESTIONS · 1 DONE · 2 FAILED · 1 GROUND TRUTH',
  );
  assert.equal(
    featureSummary(feature({ cursor: 3, done: 1, failed: 2 })),
    'Graded run · 3 QUESTIONS · 1 DONE · 2 FAILED · 1 GROUND TRUTH',
    'DONE counts the questions done, not where the run got to',
  );
  assert.equal(
    planText([
      { turn: 0, role: 'student', student: 1, label: 'GROK BOT' },
      { turn: 1, role: 'upgrade', label: 'NVIDIA NIM' },
      { turn: 2, role: 'review', label: 'NVIDIA NIM' },
      { turn: 3, role: 'write', label: 'xAI Grok' },
    ]),
    'EACH QUESTION: STUDENT 1 GROK BOT, TURN 1 NVIDIA NIM GRADES THE STUDENTS AND UPGRADES, TURN 2 NVIDIA NIM REVIEWS, TURN 3 xAI Grok WRITES THE GROUND TRUTH',
  );
  assert.equal(planText([]), '');
  assert.equal(
    runText({
      state: 'running',
      featureId: 'x',
      name: 'r',
      question: 4,
      total: 9,
      calls: 2,
      retry: true,
      retryAt: 1,
      retryOf: 3,
      now: { teacher: 'grok-bot', label: 'GROK BOT', question: 4, turn: 0, student: 2 },
    }),
    'RUN · RUNNING · R · QUESTION 4/9 · 2 CALLS · RETRY 1/3 · STUDENT 2 · GROK BOT',
  );
  assert.equal(
    runText({
      state: 'running',
      featureId: 'x',
      name: 'r',
      question: 1,
      total: 1,
      now: { teacher: 'llm:xai', label: 'xAI Grok', question: 1, turn: 2 },
    }),
    'RUN · RUNNING · R · QUESTION 1/1 · TURN 2 · xAI Grok',
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
    estimateText({
      questions: 2,
      from: 1,
      callsPerQuestion: 3,
      studentsPerQuestion: 2,
      calls: 6,
      pastes: 0,
    }),
    '2 QUESTIONS FROM QUESTION 1 · 3 PAID CALLS EACH · 6 CALLS IN ALL · 2 STUDENT ANSWERS AMONG THEM',
  );
  assert.equal(
    pendingText({
      label: 'GROK BOT',
      app: 'grok-bot',
      route: 'desktop',
      question: 1,
      turn: 0,
      student: 1,
    }),
    'WAITING FOR YOUR PASTE · GROK BOT · QUESTION 1 · STUDENT 1 · OPEN GROK BOT, PASTE THE PROMPT THERE, THEN PASTE ITS REPLY HERE',
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

function mount(answer, options = {}) {
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
    ...options,
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
  // Students: a tick per model under every heading, none ticked until chosen.
  assert.equal(tick('students', 'llm:xai').checked, false);
  assert.equal(tick('students', 'llm:nvidia').disabled, true);
  assert.ok(
    inBox(
      'h6-def',
      (n) =>
        n.dataset.teacher === 'grok-bot' &&
        n.parent?.parent?.dataset.field === 'students',
    ),
    'heading 6 offers students too',
  );
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
  assert.equal(
    inBox(
      'h6-def',
      (n) => n.tagName === 'TEXTAREA' && n.value === 'UPGRADE DEFAULT',
    ) !== undefined,
    true,
    'the prompt that grades and upgrades the students is there',
  );
  const open = box('h2-abc');
  open.open = true;
  tick('teachers', 'openai-dots').checked = true;
  tick('teachers', 'openai-dots').fire('change');
  tick('students', 'llm:xai').checked = true;
  tick('students', 'llm:xai').fire('change');
  panel.render(next);
  assert.equal(box('h2-abc'), open, 'the same element');
  assert.equal(open.open, true);
  assert.equal(
    tick('teachers', 'openai-dots').checked,
    true,
    'an edit is kept until SAVE',
  );
  assert.equal(tick('students', 'llm:xai').checked, true);
  action('h2-abc', 'save').click();
  await settle();
  const save = calls.find((c) => c.route === 'features/update');
  assert.deepEqual(save.body, {
    id: 'h2-abc',
    config: {
      webSearch: true,
      prompts: {
        system: 'SYS DEFAULT',
        upgrade: 'UPGRADE DEFAULT',
        grade: 'GRADE DEFAULT',
        write: 'WRITE DEFAULT',
      },
      students: ['llm:xai'],
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
    ['llm:xai', 'grok-bot', 'turn2', 'ahead'],
    'two teachers, where turn 3 goes, and where the run starts',
  );
  // RETRY is offered once a question has failed; the summary counts the failures.
  const mode = selects.at(-1);
  assert.equal(mode.children[2].disabled, true, 'nothing failed yet');
  panel.render(
    status({
      features: [
        feature({ id: 'h6-def', heading: 6, failed: 2, failedQuestions: [2, 5] }),
      ],
    }),
  );
  assert.equal(mode.children[2].disabled, false);
  assert.match(mode.children[2].textContent, /RETRY THE FAILED QUESTIONS \(2\)/);
  assert.match(box('h6-def').children[0].textContent, / · 2 FAILED · /);
});

test('the dataset line: each student mean grade and the last ground truth, folded; OLDER and NEWER look back; DROP THIS RECORD', async () => {
  const older = {
    id: 'h2-abc-2',
    questionNumber: 2,
    question: 'What moved before gold?',
    groundTruth: 'Silver.',
    pickedBy: 'best-graded',
    teachers: ['xAI Grok'],
    students: [],
    grades: [],
  };
  const { box, inBox, find, calls, action } = mount((route, body, method) => {
    if (route === 'records?id=h2-abc&at=1')
      return { payload: { total: 3, at: 1, record: older } };
    if (method === 'DELETE')
      return {
        payload: status({
          features: [
            feature({
              records: 2,
              last: {
                id: 'h2-abc-3',
                questionNumber: 3,
                question: 'What moved before crude oil?',
                groundTruth: 'Natural gas, in the week before.',
                pickedBy: 'best-graded',
                teachers: ['xAI Grok', 'GROK BOT'],
                students: [],
                grades: [],
              },
            }),
          ],
        }),
      };
    return {
      payload: status({
        features: [
          feature({
            records: 3,
            students: [
              { teacher: 'llm:xai', label: 'xAI Grok', answers: 3, graded: 3, mean: 6.3 },
              { teacher: 'grok-bot', label: 'GROK BOT', answers: 3, graded: 0, mean: null },
            ],
            last: {
              id: 'h2-abc-3',
              questionNumber: 3,
              question: 'What moved before crude oil?',
              groundTruth: 'Natural gas, in the week before.',
              pickedBy: 'best-graded',
              teachers: ['xAI Grok', 'GROK BOT'],
              students: [],
              grades: ['xAI Grok: 7/10 (GROK BOT)'],
            },
          }),
          feature({ id: 'h6-def', heading: 6, name: 'Reflect', records: 0 }),
        ],
      }),
    };
  });
  await settle();
  assert.equal(
    inBox(
      'h2-abc',
      (n) =>
        n.className === 'distill-note' &&
        n.textContent.startsWith('STUDENT REPORT'),
    ).textContent,
    'STUDENT REPORT: xAI Grok: 6.3/10 OVER 3 GRADED ANSWERS',
    'a student nobody graded yet is left out',
  );
  const last = inBox('h2-abc', (n) => n.className === 'distill-last');
  assert.equal(last.hidden, false);
  assert.equal(
    last.children[0].textContent,
    'LAST GROUND TRUTH · QUESTION 3 · xAI Grok, GROK BOT',
  );
  assert.ok(
    find((n) => n.textContent === 'Natural gas, in the week before.', last),
  );
  assert.ok(
    find(
      (n) => n.textContent === 'STUDENT GRADES: xAI Grok: 7/10 (GROK BOT)',
      last,
    ),
  );
  assert.equal(
    inBox('h6-def', (n) => n.className === 'distill-last').hidden,
    true,
    'no record, nothing shown',
  );
  assert.ok(box('h6-def'));
  assert.equal(action('h2-abc', 'newer').disabled, true);
  assert.equal(action('h2-abc', 'older').disabled, false);
  action('h2-abc', 'older').click();
  await settle();
  assert.equal(calls.at(-1).route, 'records?id=h2-abc&at=1');
  assert.equal(
    last.children[0].textContent,
    'GROUND TRUTH 2 OF 3 · QUESTION 2 · xAI Grok',
  );
  assert.ok(find((n) => n.textContent === 'Silver.', last));
  assert.equal(action('h2-abc', 'newer').disabled, false);
  // DROP THIS RECORD takes two presses and sends where the record is.
  const drop = action('h2-abc', 'drop-record');
  drop.click();
  assert.equal(drop.textContent, 'PRESS AGAIN TO CONFIRM');
  drop.click();
  await settle();
  assert.deepEqual(calls.at(-1), {
    route: 'records',
    method: 'DELETE',
    body: { id: 'h2-abc', at: 1 },
  });
  assert.match(
    last.children[0].textContent,
    /^LAST GROUND TRUTH · QUESTION 3/,
    'back to the last record once one is dropped',
  );
  assert.equal(action('h2-abc', 'newer').disabled, true);
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
            turns: [
              { turn: 0, role: 'student', teacher: 'llm:xai', student: 1, label: 'xAI Grok' },
              { turn: 1, role: 'upgrade', teacher: 'llm:xai', answer: 1, label: 'xAI Grok' },
              { turn: 2, role: 'grade', teacher: 'grok-bot', label: 'GROK BOT' },
            ],
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
  // Settings being edited are not what the estimate or the run would use.
  const student = find(
    (n) =>
      n.dataset.teacher === 'llm:xai' &&
      n.parent?.parent?.dataset.field === 'students',
  );
  student.checked = true;
  student.fire('change');
  action('h2-abc', 'estimate').click();
  await settle();
  assert.equal(line.textContent, 'SAVE SETTINGS FIRST');
  assert.equal(
    calls.some((c) => c.route === 'estimate'),
    false,
  );
  action('h2-abc', 'save').click();
  await settle();
  action('h2-abc', 'estimate').click();
  await settle();
  assert.match(
    find(
      (n) =>
        n.className === 'distill-note' && n.textContent.includes('PAID CALLS'),
    ).textContent,
    /8 CALLS IN ALL/,
  );
  assert.equal(
    find(
      (n) =>
        n.className === 'distill-note' && n.textContent.startsWith('EACH QUESTION'),
    ).textContent,
    'EACH QUESTION: STUDENT 1 xAI Grok, TURN 1 xAI Grok GRADES THE STUDENTS AND UPGRADES, TURN 2 GROK BOT GRADES',
    'the plan under the estimate',
  );
  action('h2-abc', 'start').click();
  await settle();
  assert.deepEqual(calls.at(-1).body, {
    id: 'h2-abc',
    confirm: true,
    fresh: false,
    retry: false,
    pauseAfter: 0,
    calls: 8,
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

test('START OVER, RETRY THE FAILED QUESTIONS and ONE QUESTION, THEN PAUSE go with the estimate and the start', async () => {
  const next = status({
    features: [feature({ failed: 1, failedQuestions: [2] })],
  });
  const { calls, inBox, action } = mount((route) =>
    route === 'estimate'
      ? {
          payload: {
            estimate: {
              questions: 1,
              from: 2,
              mode: 'retry',
              callsPerQuestion: 4,
              calls: 4,
              pastes: 0,
            },
          },
        }
      : { payload: next },
  );
  await settle();
  const mode = inBox(
    'h2-abc',
    (n) => n.tagName === 'SELECT' && n.attributes.get('aria-label') === 'Where the run starts',
  );
  mode.value = 'retry';
  const once = inBox(
    'h2-abc',
    (n) => n.attributes.get('aria-label') === 'One question, then pause',
  );
  once.checked = true;
  action('h2-abc', 'estimate').click();
  await settle();
  assert.deepEqual(calls.at(-1).body, { id: 'h2-abc', fresh: false, retry: true });
  assert.match(
    inBox('h2-abc', (n) => n.className === 'distill-note' && n.textContent.includes('PAID CALLS')).textContent,
    /^1 FAILED QUESTIONS TO RETRY · 4 PAID CALLS EACH · 4 CALLS IN ALL$/,
  );
  action('h2-abc', 'start').click();
  await settle();
  assert.deepEqual(calls.at(-1).body, {
    id: 'h2-abc',
    fresh: false,
    retry: true,
    confirm: true,
    pauseAfter: 1,
    calls: 4,
  });
  assert.deepEqual([mode.value, once.checked], ['ahead', false], 'back to the usual run');
  mode.value = 'fresh';
  action('h2-abc', 'estimate').click();
  await settle();
  assert.deepEqual(calls.at(-1).body, { id: 'h2-abc', fresh: true, retry: false });
});

test('an estimate is forgotten when the run it was for changes: the RUN mode, settings saved, questions added', async () => {
  let next = status({
    features: [feature({ failed: 1, failedQuestions: [2], updatedAt: 1 })],
  });
  const { calls, inBox, action, panel } = mount((route) =>
    route === 'estimate'
      ? {
          payload: {
            estimate: { questions: 2, from: 2, callsPerQuestion: 4, calls: 8, pastes: 0 },
          },
        }
      : { payload: next },
  );
  await settle();
  const estimateLine = () =>
    inBox('h2-abc', (n) => n.className === 'distill-note' && n.textContent.includes('PAID CALLS'));
  const start = action('h2-abc', 'start');
  action('h2-abc', 'estimate').click();
  await settle();
  assert.equal(start.disabled, false);
  // Another RUN mode runs other questions: estimate again.
  const mode = inBox(
    'h2-abc',
    (n) => n.tagName === 'SELECT' && n.attributes.get('aria-label') === 'Where the run starts',
  );
  mode.value = 'retry';
  mode.fire('change');
  assert.equal(start.disabled, true, 'the mode changed');
  assert.equal(estimateLine(), undefined, 'the line is cleared');
  action('h2-abc', 'estimate').click();
  await settle();
  assert.equal(start.disabled, false);
  // Settings saved since (the sub-heading's updatedAt moves): estimate again.
  next = status({
    features: [feature({ failed: 1, failedQuestions: [2], updatedAt: 2 })],
  });
  panel.render(next);
  assert.equal(start.disabled, true, 'the settings changed');
  action('h2-abc', 'estimate').click();
  await settle();
  assert.equal(start.disabled, false);
  // Questions added since: estimate again.
  next = status({
    features: [feature({ failed: 1, failedQuestions: [2], updatedAt: 2, questions: 4 })],
  });
  panel.render(next);
  assert.equal(start.disabled, true, 'the questions changed');
  // The same status again changes nothing.
  action('h2-abc', 'estimate').click();
  await settle();
  panel.render(next);
  assert.equal(start.disabled, false);
  assert.equal(calls.filter((c) => c.route === 'estimate').length, 4);
});

test('open, the last ground truth box fetches the whole record once, with its lines; who did not answer is named', async () => {
  const head = {
    id: 'h2-abc-3',
    createdAt: 30,
    questionNumber: 3,
    question: 'What moved before crude oil?',
    groundTruth: 'Natural gas, in the week before. Then…',
    more: true,
    pickedBy: 'best-graded',
    teachers: ['xAI Grok'],
    students: ['GROK BOT'],
    failed: ['GROK BOT'],
    grades: [],
  };
  const whole = {
    ...head,
    groundTruth: 'Natural gas, in the week before.\n\nThen silver.',
    more: false,
  };
  let next = status({ features: [feature({ records: 3, last: head })] });
  const { inBox, find, calls, action, panel } = mount((route) =>
    route === 'records?id=h2-abc&at=0'
      ? { payload: { total: 3, at: 0, record: whole } }
      : { payload: next },
  );
  await settle();
  const last = inBox('h2-abc', (n) => n.className === 'distill-last');
  const truth = () =>
    find((n) => n.className === 'distill-note distill-text' && n.textContent.includes('Natural gas'), last)
      .textContent;
  assert.equal(truth(), head.groundTruth, 'folded: the head from the status');
  assert.equal(calls.filter((c) => c.route.startsWith('records')).length, 0);
  assert.equal(
    find((n) => n.textContent === 'DID NOT ANSWER: GROK BOT', last)?.hidden,
    false,
  );
  last.open = true;
  last.fire('toggle');
  await settle();
  assert.equal(calls.filter((c) => c.route === 'records?id=h2-abc&at=0').length, 1);
  assert.equal(truth(), whole.groundTruth, 'open: the whole record, its lines kept');
  assert.equal(last.children[0].textContent, 'LAST GROUND TRUTH · QUESTION 3 · xAI Grok');
  panel.render(next);
  panel.render(next);
  assert.equal(
    calls.filter((c) => c.route === 'records?id=h2-abc&at=0').length,
    1,
    'fetched once, not on every poll',
  );
  assert.equal(truth(), whole.groundTruth);
  // A new record: the box moves to it, and fetches that one when it was cut too.
  const fourth = { ...head, id: 'h2-abc-4', createdAt: 40, questionNumber: 4 };
  next = status({ features: [feature({ records: 4, last: fourth })] });
  panel.render(next);
  await settle();
  assert.equal(calls.filter((c) => c.route === 'records?id=h2-abc&at=0').length, 2);
  assert.equal(action('h2-abc', 'newer').disabled, true);
});

test('a refusal shows on the run line and gives way to the run after a while; no server route keeps the box to its instructions', async () => {
  let clock = 1_000_000;
  const { line, action, panel } = mount(
    (route) =>
      route === 'estimate'
        ? { status: 400, payload: { error: 'OPENAI DOTS is not set up' } }
        : { payload: status() },
    { now: () => clock },
  );
  await settle();
  action('h2-abc', 'estimate').click();
  await settle();
  assert.equal(line.textContent, 'OPENAI DOTS is not set up');
  assert.equal(line.dataset.ok, 'false');
  clock += 10_000;
  panel.render(status());
  assert.equal(line.textContent, 'OPENAI DOTS is not set up', 'still there after ten seconds');
  clock += 10_000;
  panel.render(status());
  assert.equal(line.textContent, 'RUN · IDLE', 'the run is back after fifteen');
  assert.equal(line.dataset.ok, 'true');
  const none = mount(() => ({ status: 404, payload: {} }));
  await settle();
  assert.equal(none.host.hidden, true);
});
