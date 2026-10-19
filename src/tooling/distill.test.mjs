// AI DISTILLATION on the server: the seven headings' turns, the teachers'
// routes and fallbacks (Grok Bot, OpenAI Dots), the run with its pastes,
// and the datasets (src/distillCore.mjs, server/shared/distillTeachers.mjs,
// server/shared/distillJobs.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DISTILL_HEADINGS,
  bestGraded,
  estimateRun,
  groundTruthOf,
  planTurns,
  questionsFromCsv,
  questionsFromText,
  readGrades,
} from '../distillCore.mjs';
import {
  askTeacher,
  botRoutes,
  teacherRoster,
} from '../../server/shared/distillTeachers.mjs';
import {
  cleanConfig,
  createDistillManager,
} from '../../server/shared/distillJobs.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-distill-'));
const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

test('the seven headings, in the owner words, and the turns each one asks for', () => {
  assert.equal(DISTILL_HEADINGS.length, 7);
  assert.equal(
    DISTILL_HEADINGS[0].title,
    '1. One Question at a time- One Answer/one teacher',
  );
  assert.match(
    DISTILL_HEADINGS[6].title,
    /^7\. One Question at a time- Self-Correction \+ Multi-Turn Reflection/,
  );
  const roles = (h, cfg) =>
    planTurns(h, cfg).turns.map(
      (t) => `${t.role}:${t.teacher}${t.of ? `<${t.of}` : ''}`,
    );
  assert.deepEqual(roles(1, { t1: 'a' }), ['answer:a']);
  assert.deepEqual(roles(2, { teachers: ['a', 'b'], review: false }), [
    'answer:a',
    'answer:b',
  ]);
  assert.deepEqual(
    roles(2, {
      teachers: ['a', 'b'],
      review: true,
      reviewers: ['c', 'a'],
      pick: 'writer',
      writer: 'c',
    }),
    ['answer:a', 'answer:b', 'grade:c', 'grade:a', 'write:c'],
  );
  assert.deepEqual(roles(3, { t1: 'a' }), ['answer:a', 'review:a<1']);
  assert.deepEqual(roles(4, { t1: 'a' }), [
    'answer:a',
    'review:a<1',
    'review:a<2',
  ]);
  assert.deepEqual(roles(5, { t1: 'a', t2: 'b' }), ['answer:a', 'review:b<1']);
  assert.deepEqual(roles(6, { t1: 'a', t2: 'b' }), [
    'answer:a',
    'review:b<1',
    'review:b<2',
  ]);
  assert.deepEqual(roles(6, { t1: 'a', t2: 'b', turn3From: 'turn1' }), [
    'answer:a',
    'review:b<1',
    'review:a<2',
  ]);
  assert.deepEqual(roles(7, { t1: 'a', t2: 'b' }), [
    'answer:a',
    'review:a<1',
    'review:b<2',
  ]);
  assert.match(planTurns(5, { t1: 'a', t2: 'a' }).error, /differ/);
  assert.match(planTurns(2, { teachers: [] }).error, /teachers/);
  assert.match(
    planTurns(2, { teachers: ['a'], review: true }).error,
    /reviewers/,
  );
  assert.match(planTurns(1, {}).error, /teacher/);
  assert.deepEqual(
    estimateRun({
      turns: planTurns(6, { t1: 'a', t2: 'b' }).turns,
      questionsLeft: 10,
      manual: ['b'],
    }),
    {
      questions: 10,
      callsPerQuestion: 3,
      calls: 30,
      pastesPerQuestion: 2,
      pastes: 20,
    },
  );
});

test('questions from the box and from a CSV file; grades and the ground truth read from a reply', () => {
  assert.deepEqual(questionsFromText('What is 2+2?\nWhy is the sky blue?\n'), [
    'What is 2+2?',
    'Why is the sky blue?',
  ]);
  assert.deepEqual(questionsFromText('A long\nquestion\n\nAnother'), [
    'A long\nquestion',
    'Another',
  ]);
  assert.deepEqual(
    questionsFromCsv(
      'id,Question,answer\r\n1,"Is it, really?",x\r\n2,"Two\nlines",y\r\n3,,z\r\n',
    ),
    ['Is it, really?', 'Two\nlines'],
  );
  assert.deepEqual(
    questionsFromCsv('﻿First?\nSecond?'),
    ['First?', 'Second?'],
    'no header: the first column',
  );
  const json = readGrades(
    'Here: {"grades":[{"id":"r1","score":12,"critique":"too long"},{"id":"R2","score":6},{"id":"R9","score":1}],"best":"R2"}',
    ['R1', 'R2'],
  );
  assert.deepEqual(json, {
    scores: { R1: 10, R2: 6 },
    critiques: { R1: 'too long' },
    best: 'R2',
  });
  assert.deepEqual(
    readGrades('R1: 4/10, weak. R2 earns 9 out of 10.', ['R1', 'R2']).scores,
    { R1: 4, R2: 9 },
  );
  assert.deepEqual(
    bestGraded(
      ['R1', 'R2'],
      [{ scores: { R1: 6, R2: 8 } }, { scores: { R1: 9, R2: 8 } }],
    ),
    { label: 'R2', mean: 8, votes: 2 },
  );
  assert.equal(bestGraded(['R1'], [{ scores: {} }]), null);
  assert.equal(
    groundTruthOf('The review.\nGROUND TRUTH ANSWER:\n  Paris.'),
    'Paris.',
  );
  assert.equal(groundTruthOf('Just an answer'), 'Just an answer');
});

test('the roster: the Ask panel models with keys, Grok Bot and OpenAI Dots by every fallback, the custom LLMs here', (t) => {
  const dataRoot = tmp();
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataRoot, 'llm', 'mine', 'model'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dataRoot, 'llm', 'mine', 'model', 'adapter.json'),
    '{}',
  );
  const none = teacherRoster({ env: {}, dataRoot });
  // Every Ask panel model is listed, none ready without its key.
  const llms = none.filter((x) => x.kind === 'llm');
  assert.ok(llms.length >= 4);
  assert.ok(llms.every((x) => x.id.startsWith('llm:') && !x.ready));
  assert.deepEqual(
    none
      .filter((x) => x.kind !== 'llm')
      .map((x) => `${x.id}:${x.ready}:${x.routes.join('/')}`),
    [
      'grok-bot:true:desktop',
      'openai-dots:true:desktop',
      'local:mine:true:local',
    ],
  );
  assert.equal(none.find((x) => x.id === 'grok-bot').manualOnly, true);
  assert.equal(
    none.find((x) => x.id === 'local:mine').label,
    'TRAINED HERE · MINE',
  );
  assert.deepEqual(
    botRoutes('grok-bot', {
      GROK_BOT_WEBHOOK_URL: 'https://example.invalid/hook',
      GROK_BOT_WEBHOOK_KEY: 'k',
    }).at(-1),
    'desktop',
  );
});

/** A fetch that answers as each upstream does, and records what it was sent. */
function upstreams(replies) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    sent.push({ url: String(url), body, auth: init.headers?.Authorization });
    const reply = replies(String(url), body, sent.length);
    return {
      ok: reply.status < 300,
      status: reply.status,
      json: async () => reply.data,
      body: [Buffer.from(JSON.stringify(reply.data ?? {}))],
    };
  };
  return { fetchImpl, sent };
}

test('a chat model answers with its earlier turns as messages; a bot key goes on with previous_response_id and searches', async () => {
  const chat = upstreams(() => ({
    status: 200,
    data: {
      id: 'chatcmpl-1',
      model: 'grok-4.6',
      choices: [{ message: { content: 'Four.' } }],
    },
  }));
  const xai = {
    id: 'llm:xai',
    label: 'xAI Grok',
    kind: 'llm',
    routes: ['api'],
  };
  const got = await askTeacher(xai, {
    system: 'SYS',
    prompt: 'Review it',
    history: [
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: 'A' },
    ],
    env: { XAI_API_KEY: 'secret-key' },
    fetchImpl: chat.fetchImpl,
  });
  assert.deepEqual(
    [got.text, got.responseId, got.route],
    ['Four.', 'chatcmpl-1', 'api'],
  );
  assert.equal(chat.sent[0].url, 'https://api.x.ai/v1/chat/completions');
  assert.deepEqual(
    chat.sent[0].body.messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'user'],
  );
  assert.equal(chat.sent[0].auth, 'Bearer secret-key');
  const bot = upstreams(() => ({
    status: 200,
    data: {
      id: 'resp_2',
      output: [
        {
          type: 'message',
          content: [
            {
              text: 'Refined.',
              annotations: [{ url: 'https://example.org/a', title: 'A' }],
            },
          ],
        },
      ],
    },
  }));
  const dots = {
    id: 'openai-dots',
    label: 'OPENAI DOTS',
    kind: 'bot',
    app: 'chatgpt',
    routes: ['key', 'desktop'],
  };
  const next = await askTeacher(dots, {
    system: 'SYS',
    prompt: 'Review it',
    previous: { route: 'key', responseId: 'resp_1' },
    env: { OPENAI_DOTS_API_KEY: 'dots-key' },
    fetchImpl: bot.fetchImpl,
  });
  assert.equal(bot.sent[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(bot.sent[0].body.previous_response_id, 'resp_1');
  assert.deepEqual(bot.sent[0].body.tools, [{ type: 'web_search' }]);
  assert.deepEqual([next.responseId, next.route], ['resp_2', 'key']);
  assert.match(
    next.text,
    /Refined\.\n\nSources:\n- A: https:\/\/example\.org\/a/,
  );
});

test('Grok Bot falls back route by route: a refused key, then the webhook, which waits for a paste; the key never shows', async () => {
  const calls = upstreams((url) =>
    url.includes('api.x.ai')
      ? { status: 401, data: { error: { message: 'bad key xai-secret' } } }
      : { status: 200, data: { ok: true } },
  );
  const grok = {
    id: 'grok-bot',
    label: 'GROK BOT',
    kind: 'bot',
    app: 'grok-bot',
    routes: ['key', 'webhook', 'desktop'],
  };
  const got = await askTeacher(grok, {
    system: 'SYS',
    prompt: 'Q?',
    env: {
      GROK_BOT_API_KEY: 'xai-secret',
      GROK_BOT_WEBHOOK_URL: 'https://hook.example/run',
      GROK_BOT_WEBHOOK_KEY: 'hook-key',
    },
    fetchImpl: calls.fetchImpl,
  });
  assert.equal(got.manual, true);
  assert.equal(got.route, 'webhook');
  assert.equal(got.sent, true);
  assert.equal(got.prompt, 'SYS\n\nQ?');
  assert.equal(got.tried[0].route, 'key');
  assert.match(got.tried[0].error, /HTTP 401/);
  assert.doesNotMatch(got.tried[0].error, /xai-secret/);
  assert.equal(calls.sent[1].body.kind, 'ai-distillation');
  const desktopOnly = await askTeacher(
    { ...grok, routes: ['desktop'] },
    { system: 'S', prompt: 'P', env: {} },
  );
  assert.deepEqual(
    [desktopOnly.manual, desktopOnly.route, desktopOnly.app],
    [true, 'desktop', 'grok-bot'],
  );
  await assert.rejects(
    askTeacher(
      { id: 'llm:nvidia', label: 'NVIDIA NIM', routes: [] },
      { system: 'S', prompt: 'P', env: {} },
    ),
    /not set up/,
  );
});

/** Teachers that answer by rule: the question, then "better <prev>", a grade reply, or a paste. */
function fakeTeachers({ manual = [] } = {}) {
  const calls = [];
  const teachers = ['a', 'b', 'c', 'm'].map((id) => ({
    id,
    label: id.toUpperCase(),
    kind: 'llm',
    ready: true,
    routes: manual.includes(id) ? ['desktop'] : ['api'],
    manualOnly: manual.includes(id),
    app: 'grok-bot',
  }));
  const ask = async (teacher, { prompt, history, previous, signal }) => {
    calls.push({
      teacher: teacher.id,
      prompt,
      history: history?.length || 0,
      previous: previous?.responseId || null,
    });
    await settle(2);
    if (signal.aborted)
      throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
    if (teacher.routes[0] === 'desktop')
      return {
        manual: true,
        route: 'desktop',
        app: 'grok-bot',
        prompt,
        tried: [],
      };
    if (prompt.startsWith('QUESTION:') && prompt.includes('Grade each'))
      return {
        text: `{"grades":[{"id":"R1","score":${teacher.id === 'c' ? 9 : 3}},{"id":"R2","score":6}]}`,
        responseId: `${teacher.id}-g`,
        model: 'm',
        route: 'api',
        tried: [],
      };
    if (prompt.includes('ADVERSARIAL REVIEWS'))
      return {
        text: 'notes\nGROUND TRUTH ANSWER:\nwritten by c',
        responseId: 'w',
        model: 'm',
        route: 'api',
        tried: [],
      };
    if (prompt.startsWith('ORIGINAL QUESTION'))
      return {
        text: `review\nGROUND TRUTH ANSWER:\n${teacher.id} fixed`,
        responseId: `${teacher.id}-r${calls.length}`,
        model: 'm',
        route: 'api',
        tried: [],
      };
    return {
      text: `${teacher.id} says ${prompt}`,
      responseId: `${teacher.id}-1`,
      model: 'm',
      route: 'api',
      tried: [],
    };
  };
  return { teachers, ask, calls };
}

function setup(t, options = {}) {
  const root = tmp();
  const dataRoot = path.join(root, '.gev-data');
  const fake = fakeTeachers(options);
  const manager = createDistillManager({
    root,
    dataRoot,
    env: {},
    ask: fake.ask,
    roster: () => fake.teachers,
  });
  t.after(() => {
    manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const add = (heading, config, questions = 'Q1?\nQ2?') => {
    const id = manager
      .addFeature({ heading, name: `my ${heading}` })
      .features.at(-1).id;
    manager.updateFeature({ id, config });
    manager.addQuestions({ id, text: questions });
    return id;
  };
  const records = (id) =>
    fs
      .readFileSync(path.join(dataRoot, 'distill', id, 'dataset.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { root, dataRoot, manager, add, records, ...fake };
}

test('heading 2: every teacher answers, the reviewers grade, the best graded is the ground truth; or a reviewer writes it', async (t) => {
  const { manager, add, records, calls } = setup(t);
  const id = add(
    2,
    {
      teachers: ['a', 'b'],
      review: true,
      reviewers: ['b', 'c'],
      pick: 'best-graded',
    },
    'Q1?',
  );
  assert.deepEqual(manager.estimate({ id }), {
    questions: 1,
    callsPerQuestion: 4,
    calls: 4,
    pastesPerQuestion: 0,
    pastes: 0,
    from: 1,
    turns: manager.estimate({ id }).turns,
  });
  assert.throws(() => manager.start({ id }), /Confirm the estimate/);
  manager.start({ id, confirm: true });
  await manager.started;
  const [r] = records(id);
  assert.equal(r.pickedBy, 'best-graded');
  assert.equal(
    r.groundTruth,
    'a says Q1?',
    'R1: (3 + 9) / 2 = 6, R2: 6, a tie goes to the earlier answer',
  );
  assert.deepEqual(
    r.turns.map((x) => `${x.role}:${x.teacher}`),
    ['answer:a', 'answer:b', 'grade:b', 'grade:c'],
  );
  assert.equal(r.grades.at(-1).best, 'R1');
  assert.equal(r.class, 'restricted');
  const graded = calls.find((c) => c.prompt.includes('Grade each'));
  assert.match(graded.prompt, /R1 \(RESPONSE ID a-1, from A\):\na says Q1\?/);
  assert.equal(manager.status().run.state, 'done');
  const writer = add(
    2,
    {
      teachers: ['a', 'b'],
      review: true,
      reviewers: ['c'],
      pick: 'writer',
      writer: 'c',
    },
    'Q9?',
  );
  manager.start({ id: writer, confirm: true });
  await manager.started;
  assert.deepEqual(
    [records(writer)[0].pickedBy, records(writer)[0].groundTruth],
    ['writer', 'written by c'],
  );
  const ungraded = add(2, { teachers: ['a', 'b'], review: false }, 'Q7?');
  manager.start({ id: ungraded, confirm: true });
  await manager.started;
  assert.deepEqual(
    records(ungraded).map((x) => [x.id.split('-').at(-1), x.groundTruth]),
    [
      ['R1', 'a says Q7?'],
      ['R2', 'b says Q7?'],
    ],
  );
});

test('headings 3 to 7: the same teacher goes on its own conversation, another one gets the question, the response id and the response', async (t) => {
  const { manager, add, records, calls } = setup(t);
  const four = add(4, { t1: 'a' }, 'Q?');
  manager.start({ id: four, confirm: true });
  await manager.started;
  const [r4] = records(four);
  assert.deepEqual(
    r4.turns.map((x) => `${x.turn}:${x.teacher}`),
    ['1:a', '2:a', '3:a'],
  );
  assert.equal(r4.groundTruth, 'a fixed');
  assert.equal(r4.pickedBy, 'final-turn');
  assert.deepEqual(
    calls.map((c) => [c.history, c.previous]),
    [
      [0, null],
      [2, 'a-1'],
      [4, r4.turns[1].responseId],
    ],
  );
  assert.match(
    calls[1].prompt,
    /^ORIGINAL QUESTION:\nQ\?\n\nRESPONSE ID: a-1\nRESPONSE \(from A\):\na says Q\?/,
  );
  calls.length = 0;
  const six = add(6, { t1: 'a', t2: 'b' }, 'Q6?');
  manager.start({ id: six, confirm: true });
  await manager.started;
  assert.deepEqual(
    records(six)[0].turns.map((x) => x.teacher),
    ['a', 'b', 'b'],
  );
  assert.deepEqual(
    calls.map((c) => c.history),
    [0, 0, 2],
    'b starts fresh, then goes on its own talk',
  );
  const seven = add(7, { t1: 'a', t2: 'b' }, 'Q7?');
  manager.start({ id: seven, confirm: true });
  await manager.started;
  assert.deepEqual(
    records(seven)[0].turns.map((x) => x.teacher),
    ['a', 'a', 'b'],
  );
  assert.equal(records(seven)[0].groundTruth, 'b fixed');
});

test('a manual route waits for the paste; PAUSE ends after the question, CONTINUE goes on, STOP drops the question', async (t) => {
  const { manager, add, records } = setup(t, { manual: ['m'] });
  const id = add(5, { t1: 'a', t2: 'm' }, 'Q1?\nQ2?\nQ3?');
  assert.equal(manager.estimate({ id }).pastes, 3);
  manager.start({ id, confirm: true });
  await settle(30);
  let run = manager.status().run;
  assert.equal(run.state, 'waiting');
  assert.equal(run.pending.teacher, 'm');
  assert.equal(run.pending.question, 1);
  assert.match(run.pending.prompt, /^ORIGINAL QUESTION:\nQ1\?/);
  assert.throws(() => manager.paste({ answer: '  ' }), /Paste the answer/);
  manager.pause();
  manager.paste({ answer: 'review\nGROUND TRUTH ANSWER:\npasted truth' });
  await manager.started;
  assert.equal(manager.status().run.state, 'paused');
  assert.equal(records(id)[0].groundTruth, 'pasted truth');
  assert.equal(records(id)[0].turns[1].route, 'desktop');
  manager.continue();
  await settle(30);
  assert.equal(manager.status().run.question, 2);
  manager.skipPaste();
  await settle(30);
  assert.equal(manager.status().run.question, 3);
  assert.match(manager.status().run.errors[0].error, /Skipped/);
  manager.stop();
  await manager.started;
  run = manager.status().run;
  assert.equal(run.state, 'stopped');
  const view = manager.status().features.find((f) => f.id === id);
  assert.deepEqual(
    [view.cursor, view.done, view.failed, view.records],
    [2, 1, 1, 1],
    'question 3 was dropped, not done',
  );
  manager.continue();
  await settle(30);
  assert.equal(
    manager.status().run.question,
    3,
    'CONTINUE takes up the dropped question',
  );
  manager.stop();
  await manager.started;
});

test('sub-headings without limit, their settings checked, questions kept once, the dataset as JSONL and CSV', async (t) => {
  const { manager, add, records } = setup(t);
  for (let i = 0; i < 12; i++)
    manager.addFeature({ heading: 3, name: `run ${i}` });
  assert.equal(
    manager.status().features.filter((f) => f.heading === 3).length,
    12,
  );
  assert.throws(
    () => manager.addFeature({ heading: 8, name: 'x' }),
    /Unknown heading/,
  );
  assert.throws(
    () => manager.addFeature({ heading: 1, name: '  ' }),
    /Name the heading/,
  );
  const id = add(1, { t1: 'a' }, 'Same?\nSame?\nOther?');
  assert.equal(manager.status().features.find((f) => f.id === id).questions, 2);
  manager.addQuestions({ id, csv: 'question\n"Third, with comma?"\nOther?\n' });
  assert.equal(manager.status().features.find((f) => f.id === id).questions, 3);
  assert.throws(
    () => manager.updateFeature({ id, config: { t1: 'nobody' } }),
    /Unknown teacher/,
  );
  assert.throws(
    () => manager.updateFeature({ id, config: { pick: 'vote' } }),
    /GROUND TRUTH/,
  );
  manager.updateFeature({
    id,
    config: { prompts: { system: 'Be brief.', review: '' } },
  });
  assert.deepEqual(
    manager.status().features.find((f) => f.id === id).config.prompts,
    { system: 'Be brief.' },
  );
  manager.start({ id, confirm: true });
  await manager.started;
  assert.equal(records(id).length, 3);
  assert.throws(
    () => manager.start({ id, confirm: true }),
    /Every question is done/,
  );
  const csv = manager.exportData({ id, format: 'csv' });
  assert.equal(csv.filename, 'distill-my-1.csv');
  assert.match(
    csv.body,
    /^id,heading,question,ground_truth,picked_by,teachers,class\r\n/,
  );
  assert.match(
    csv.body,
    /"Third, with comma\?","a says Third, with comma\?",single,A,restricted/,
  );
  assert.equal(
    manager.exportData({ id }).body.split('\n').filter(Boolean).length,
    3,
  );
  manager.clearDataset({ id });
  assert.equal(manager.status().features.find((f) => f.id === id).records, 0);
  manager.removeFeature({ id });
  assert.equal(
    manager.status().features.some((f) => f.id === id),
    false,
  );
  assert.deepEqual(
    cleanConfig({ review: false, webSearch: false }, {}, []).review,
    false,
  );
});
