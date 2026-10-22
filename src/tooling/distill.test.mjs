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
      studentsPerQuestion: 0,
      calls: 30,
      pastesPerQuestion: 2,
      pastes: 20,
    },
  );
  // Students answer first (turn 0); the first teacher turn upgrades their answers instead of answering cold.
  const full = (h, cfg) =>
    planTurns(h, cfg).turns.map(
      (t) => `${t.turn}:${t.role}:${t.teacher}${t.of ? `<${t.of}` : ''}`,
    );
  assert.deepEqual(full(3, { t1: 'a', students: ['m', 'c', 'm'] }), [
    '0:student:m',
    '0:student:c',
    '1:upgrade:a',
    '2:review:a<1',
  ]);
  assert.deepEqual(
    full(2, {
      teachers: ['a', 'b'],
      review: true,
      reviewers: ['c'],
      students: ['b'],
    }),
    ['0:student:b', '1:upgrade:a', '1:upgrade:b', '2:grade:c'],
  );
  assert.deepEqual(full(1, { t1: 'a', students: [] }), ['1:answer:a']);
  assert.deepEqual(full(6, { t1: 'a', t2: 'b', students: ['c'] }), [
    '0:student:c',
    '1:upgrade:a',
    '2:review:b<1',
    '3:review:b<2',
  ]);
  assert.match(planTurns(1, { students: ['a'] }).error, /teacher/);
  assert.equal(
    estimateRun({
      turns: planTurns(1, { t1: 'a', students: ['b', 'c'] }).turns,
      questionsLeft: 2,
      manual: ['c'],
    }).studentsPerQuestion,
    2,
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
    readGrades('S1: 4/10 too short\nS2: 7/10 fine\nS3: 9/10', ['S1', 'S2'])
      .scores,
    { S1: 4, S2: 7 },
    "a student's grades read the same way; unknown ids are dropped",
  );
  assert.deepEqual(
    readGrades(
      '**S1** — 2 errors, misses the date: 6/10\nStudent 2 (S2): 7.5 / 10\nAnswer 3: 9 out of 10.',
      ['S1', 'S2', 'R3'],
    ).scores,
    { S1: 6, S2: 7.5, R3: 9 },
    'bold ids, a count before the score, "Student n" and "Answer n"',
  );
  assert.deepEqual(
    readGrades('S1: no score, see S2. S2: 8/10\nS3: 7/100', ['S1', 'S2', 'S3'])
      .scores,
    { S2: 8 },
    'a score belongs to the last id before it; 7/100 is not a grade',
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
  assert.equal(
    groundTruthOf('Notes.\n**GROUND TRUTH ANSWER:**\nParis.'),
    'Paris.',
    'Markdown bold around the line',
  );
  assert.equal(
    groundTruthOf(
      'Its GROUND TRUTH ANSWER: Rome was wrong.\nGROUND TRUTH ANSWER:\nParis.',
    ),
    'Paris.',
    'the last line counts: a review may quote the one it reviews',
  );
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
  assert.deepEqual(
    none.map((x) => `${x.id}:${x.ready}:${x.routes.join('/')}`),
    [
      'llm:nvidia:false:',
      'llm:xai:false:',
      'llm:openrouter:false:',
      'llm:custom:false:',
      'llm:anthropic:false:',
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
  // An id made here (the key gave none) is not sent back: the turn starts over with the system prompt.
  await askTeacher(dots, {
    system: 'SYS',
    prompt: 'Review it',
    previous: { route: 'key', responseId: 'gev-0123456789ab' },
    env: { OPENAI_DOTS_API_KEY: 'dots-key' },
    fetchImpl: bot.fetchImpl,
  });
  assert.equal(bot.sent[1].body.previous_response_id, undefined);
  assert.deepEqual(
    bot.sent[1].body.input.map((m) => m.role),
    ['system', 'user'],
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
    if (prompt.includes('STUDENT ANSWERS:'))
      return {
        text: `S1: 4/10 too short\nS2: 7/10 fine\nGROUND TRUTH ANSWER:\n${teacher.id} upgraded`,
        responseId: `${teacher.id}-u`,
        model: 'm',
        route: 'api',
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
    studentsPerQuestion: 0,
    calls: 4,
    pastesPerQuestion: 0,
    pastes: 0,
    from: 1,
    mode: 'ahead',
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

test('students answer first; the teacher grades them, fixes the errors and upgrades; the heading goes on from the upgrade', async (t) => {
  const { manager, add, records, calls } = setup(t);
  // Heading 1 with two students: one upgrade turn, its grades read, its answer the ground truth.
  const one = add(1, { t1: 'a', students: ['b', 'c'] }, 'Q1?');
  assert.deepEqual(
    [
      manager.estimate({ id: one }).callsPerQuestion,
      manager.estimate({ id: one }).studentsPerQuestion,
    ],
    [3, 2],
  );
  manager.start({ id: one, confirm: true });
  await manager.started;
  const [r1] = records(one);
  assert.deepEqual(
    r1.turns.map(
      (x) => `${x.turn}:${x.role}:${x.teacher}${x.id ? `=${x.id}` : ''}`,
    ),
    ['0:student:b=S1', '0:student:c=S2', '1:upgrade:a'],
  );
  assert.deepEqual([r1.pickedBy, r1.groundTruth], ['upgrade', 'a upgraded']);
  assert.deepEqual(r1.studentGrades, [
    { teacher: 'a', label: 'A', scores: { S1: 4, S2: 7 }, critiques: {} },
  ]);
  const upgrade = calls.find((c) => c.prompt.includes('STUDENT ANSWERS:'));
  assert.equal(upgrade.teacher, 'a');
  assert.match(
    upgrade.prompt,
    /^QUESTION:\nQ1\?\n\nSTUDENT ANSWERS:\nS1 \(RESPONSE ID b-1, from B\):\nb says Q1\?\n\nS2 \(RESPONSE ID c-1, from C\):\nc says Q1\?\n\nYou are the teacher\. Grade each student answer/,
  );
  // Heading 3: the review turn reviews the upgrade, on the same teacher's talk.
  calls.length = 0;
  const three = add(3, { t1: 'a', students: ['b'] }, 'Q3?');
  manager.start({ id: three, confirm: true });
  await manager.started;
  const [r3] = records(three);
  assert.deepEqual(
    r3.turns.map((x) => x.role),
    ['student', 'upgrade', 'review'],
  );
  assert.deepEqual([r3.pickedBy, r3.groundTruth], ['final-turn', 'a fixed']);
  assert.deepEqual(r3.studentGrades[0].scores, { S1: 4 });
  assert.match(
    calls[2].prompt,
    /^ORIGINAL QUESTION:\nQ3\?\n\nRESPONSE ID: a-u\nRESPONSE \(from A\):\nS1: 4\/10 too short/,
  );
  assert.deepEqual(
    calls.map((c) => [c.teacher, c.history]),
    [
      ['b', 0],
      ['a', 0],
      ['a', 2],
    ],
  );
  // Heading 2: every teacher upgrades the students' answers; the reviewers grade the upgraded answers.
  calls.length = 0;
  const two = add(
    2,
    { teachers: ['a', 'b'], review: true, reviewers: ['c'], students: ['m'] },
    'Q2?',
  );
  manager.start({ id: two, confirm: true });
  await manager.started;
  const [r2] = records(two);
  assert.deepEqual(
    r2.turns.map((x) => `${x.role}:${x.teacher}`),
    ['student:m', 'upgrade:a', 'upgrade:b', 'grade:c'],
  );
  assert.deepEqual([r2.pickedBy, r2.groundTruth], ['best-graded', 'a upgraded']);
  assert.deepEqual(
    r2.studentGrades.map((g) => [g.teacher, g.scores.S1]),
    [
      ['a', 4],
      ['b', 4],
    ],
  );
  const graded = calls.find((c) => c.prompt.includes('Grade each answer'));
  assert.match(
    graded.prompt,
    /R1 \(RESPONSE ID a-u, from A\):\na upgraded\n\nR2 \(RESPONSE ID b-u, from B\):\nb upgraded/,
    'the reviewers see the upgraded answers, not the grades',
  );
  // The dataset as CSV: the students and their grades in their own columns.
  const csv = manager.exportData({ id: one, format: 'csv' });
  assert.match(
    csv.body,
    /^id,heading,question,ground_truth,picked_by,teachers,students,student_grades,class\r\n/,
  );
  assert.match(
    csv.body,
    /Q1\?,a upgraded,upgrade,A,B \| C,S1: 4\/10 \(A\) \| S2: 7\/10 \(A\),restricted/,
  );
});

test('a student on a manual route waits for its paste as STUDENT n; with no student answer the question fails', async (t) => {
  const { manager, add, records, teachers } = setup(t, { manual: ['m'] });
  // One student skipped, one answered: the question goes on, and the record says who did not answer.
  const some = add(1, { t1: 'a', students: ['b', 'm'] }, 'Q?');
  manager.start({ id: some, confirm: true });
  await settle(30);
  manager.skipPaste();
  await manager.started;
  const [r] = records(some);
  assert.deepEqual(
    [r.pickedBy, r.turns.map((x) => `${x.role}:${x.teacher}`), r.failures],
    [
      'upgrade',
      ['student:b', 'upgrade:a'],
      [
        {
          role: 'student',
          teacher: 'm',
          label: 'M',
          error: 'Skipped: no answer was pasted.',
        },
      ],
    ],
  );
  assert.deepEqual(
    manager.status().features.find((f) => f.id === some).last.failed,
    ['M'],
  );
  // Heading 2 without REVIEW and with students: each record is an upgrade.
  const two = add(2, { teachers: ['a'], review: false, students: ['b'] }, 'Q2?');
  manager.start({ id: two, confirm: true });
  await manager.started;
  assert.deepEqual(
    [records(two)[0].pickedBy, records(two)[0].groundTruth],
    ['upgrade', 'a upgraded'],
  );
  // A teacher gone from the list mid-run (a custom LLM deleted) fails its turn plainly.
  const gone = add(1, { t1: 'a', students: ['c'] }, 'Q1?\nQ2?');
  manager.start({ id: gone, confirm: true });
  teachers.splice(
    teachers.findIndex((x) => x.id === 'c'),
    1,
  );
  await manager.started;
  const view = manager.status().features.find((f) => f.id === gone);
  assert.deepEqual([view.done, view.failed, view.failedQuestions], [1, 1, [2]]);
  assert.match(
    manager.status().run.errors[0].error,
    /No student answered: c: c is not on the list any more\./,
  );
  teachers.push({
    id: 'c',
    label: 'C',
    kind: 'llm',
    ready: true,
    routes: ['api'],
    manualOnly: false,
    app: 'grok-bot',
  });
  const id = add(1, { t1: 'a', students: ['m'] }, 'Q?');
  manager.start({ id, confirm: true });
  assert.deepEqual(
    manager.status().run.now,
    { teacher: 'm', label: 'M', question: 1, turn: 0, student: 1 },
    'the line says who is answering',
  );
  await settle(30);
  const run = manager.status().run;
  assert.equal(run.state, 'waiting');
  assert.equal(run.now, null, 'nobody answers while a paste is waited for');
  assert.deepEqual(
    [run.pending.teacher, run.pending.turn, run.pending.student],
    ['m', 0, 1],
  );
  assert.equal(run.pending.prompt, 'Q?', 'a student gets the question itself');
  manager.skipPaste();
  await manager.started;
  assert.match(manager.status().run.errors[0].error, /No student answered/);
  assert.equal(manager.status().features.find((f) => f.id === id).records, 0);
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
  assert.equal(manager.status().run.pauseWanted, true);
  manager.paste({ answer: 'review\nGROUND TRUTH ANSWER:\npasted truth' });
  await manager.started;
  run = manager.status().run;
  assert.deepEqual(
    [run.state, run.pauseWanted, run.calls],
    ['paused', false, 2],
  );
  assert.equal(records(id)[0].groundTruth, 'pasted truth');
  assert.equal(records(id)[0].turns[1].route, 'desktop');
  manager.continue();
  await settle(30);
  run = manager.status().run;
  assert.equal(run.question, 2);
  assert.ok(run.calls >= 2, 'CONTINUE keeps the count of calls');
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
  run = manager.status().run;
  assert.equal(run.question, 3, 'CONTINUE takes up the dropped question');
  assert.match(
    run.errors[0].error,
    /Skipped/,
    'CONTINUE keeps the errors so far',
  );
  manager.stop();
  await manager.started;
});

test('a failed question is listed; RETRY THE FAILED QUESTIONS runs those again and takes them off; ONE QUESTION, THEN PAUSE', async (t) => {
  const { manager, add, records } = setup(t, { manual: ['m'] });
  const id = add(5, { t1: 'a', t2: 'm' }, 'Q1?\nQ2?\nQ3?');
  const view = () => manager.status().features.find((f) => f.id === id);
  const progress = () => {
    const v = view();
    return [v.cursor, v.done, v.failed, v.failedQuestions, v.records];
  };
  manager.start({ id, confirm: true, pauseAfter: 1 });
  await settle(30);
  assert.equal(manager.status().run.pauseAfter, 1);
  manager.paste({ answer: 'GROUND TRUTH ANSWER:\none' });
  await manager.started;
  assert.equal(manager.status().run.state, 'paused', 'one question, then pause');
  assert.deepEqual(progress(), [1, 1, 0, [], 1]);
  // Questions 2 and 3 are skipped: both fail and are listed.
  manager.continue();
  await settle(30);
  assert.equal(manager.status().run.pauseAfter, undefined);
  manager.skipPaste();
  await settle(30);
  manager.skipPaste();
  await manager.started;
  assert.equal(manager.status().run.state, 'done');
  assert.deepEqual(progress(), [3, 1, 2, [2, 3], 1]);
  assert.throws(
    () => manager.start({ id, confirm: true }),
    /Every question is done/,
  );
  const estimate = manager.estimate({ id, retry: true });
  assert.deepEqual(
    [estimate.questions, estimate.from, estimate.mode, estimate.calls],
    [2, 2, 'retry', 4],
  );
  assert.throws(
    () => manager.start({ id, confirm: true, fresh: true, retry: true }),
    /not both/,
  );
  // The run confirmed is the run estimated: another count of calls is refused.
  assert.throws(
    () => manager.start({ id, confirm: true, retry: true, calls: 6 }),
    /The estimate changed: press ESTIMATE again\./,
  );
  assert.equal(manager.status().run.state, 'done', 'nothing started');
  // The retry: question 2 passes, then pauses; CONTINUE keeps retrying with question 3.
  manager.start({ id, confirm: true, retry: true, pauseAfter: 1, calls: 4 });
  await settle(30);
  let run = manager.status().run;
  assert.deepEqual(
    [run.question, run.retry, run.retryAt, run.retryOf],
    [2, true, 1, 2],
  );
  manager.paste({ answer: 'GROUND TRUTH ANSWER:\ntwo' });
  await manager.started;
  assert.equal(manager.status().run.state, 'paused');
  assert.deepEqual(progress(), [3, 2, 1, [3], 2]);
  manager.continue();
  await settle(30);
  run = manager.status().run;
  assert.deepEqual([run.question, run.retry], [3, true]);
  manager.paste({ answer: 'GROUND TRUTH ANSWER:\nthree' });
  await manager.started;
  assert.equal(manager.status().run.state, 'done');
  assert.deepEqual(progress(), [3, 3, 0, [], 3]);
  assert.throws(
    () => manager.start({ id, confirm: true, retry: true }),
    /No failed questions/,
  );
  assert.deepEqual(
    records(id).map((r) => r.groundTruth),
    ['one', 'two', 'three'],
  );
});

test('the status tells what a dataset holds: its count, each student mean grade and the last ground truth, read as the file grows', async (t) => {
  const { manager, add, dataRoot } = setup(t);
  const id = add(1, { t1: 'a', students: ['b', 'c'] }, 'Q1?\nQ2?');
  const view = () => manager.status().features.find((f) => f.id === id);
  assert.deepEqual([view().records, view().last, view().students], [0, null, []]);
  manager.start({ id, confirm: true, pauseAfter: 1 });
  await manager.started;
  assert.equal(view().records, 1);
  manager.continue();
  await manager.started;
  const v = view();
  assert.equal(v.records, 2);
  assert.deepEqual(v.students, [
    { teacher: 'b', label: 'B', answers: 2, graded: 2, mean: 4 },
    { teacher: 'c', label: 'C', answers: 2, graded: 2, mean: 7 },
  ]);
  assert.deepEqual(
    [
      v.last.question,
      v.last.groundTruth,
      v.last.pickedBy,
      v.last.teachers,
      v.last.grades,
    ],
    ['Q2?', 'a upgraded', 'upgrade', ['A'], ['B: 4/10 (A)', 'C: 7/10 (A)']],
  );
  manager.clearDataset({ id });
  assert.deepEqual([view().records, view().last, view().students], [0, null, []]);
  // A write under way: the bytes after the last line break wait, even mid-character.
  const file = path.join(dataRoot, 'distill', id, 'dataset.jsonl');
  const line = Buffer.from(
    `${JSON.stringify({ id: `${id}-9`, question: 'Qué?', groundTruth: 'Sí.', turns: [] })}\n`,
  );
  const cut = line.indexOf(Buffer.from('é')) + 1; // inside the two bytes of é
  fs.writeFileSync(file, line.subarray(0, cut));
  assert.equal(view().records, 0, 'half a line is not a record yet');
  fs.appendFileSync(file, line.subarray(cut));
  const v9 = view();
  assert.deepEqual(
    [v9.records, v9.last.question, v9.last.questionNumber, v9.last.more],
    [1, 'Qué?', 9, false],
  );
  // The status carries a long record's head on one line; the record itself keeps its lines.
  const long = {
    id: `${id}-10`,
    question: 'Why?',
    groundTruth: `First line.\n\nSecond line, ${'x'.repeat(600)}`,
    turns: [],
  };
  fs.appendFileSync(file, `${JSON.stringify(long)}\n`);
  const v10 = view();
  assert.equal(v10.last.more, true);
  assert.match(v10.last.groundTruth, /^First line\. Second line, x+…$/);
  assert.equal(v10.last.groundTruth.length, 600);
  const whole = manager.record({ id, at: 0 }).record;
  assert.deepEqual([whole.groundTruth, whole.more], [long.groundTruth, false]);
});

test('records are looked at one by one from the newest; DROP THIS RECORD takes a question out and lists it for RETRY', async (t) => {
  const { manager, add, records } = setup(t);
  const id = add(1, { t1: 'a' }, 'Q1?\nQ2?\nQ3?');
  const view = () => manager.status().features.find((f) => f.id === id);
  manager.start({ id, confirm: true });
  await manager.started;
  const second = manager.record({ id, at: 1 });
  assert.deepEqual(
    [
      second.total,
      second.at,
      second.record.questionNumber,
      second.record.question,
      second.record.groundTruth,
      second.record.teachers,
      second.record.students,
    ],
    [3, 1, 2, 'Q2?', 'a says Q2?', ['A'], []],
  );
  assert.equal(manager.record({ id, at: 3 }).record, null, 'past the first');
  assert.throws(() => manager.dropRecords({ id, at: 3 }), /No such record/);
  manager.dropRecords({ id, at: 1 });
  let v = view();
  assert.deepEqual(
    [v.records, v.done, v.failed, v.failedQuestions, v.last.questionNumber],
    [2, 2, 1, [2], 3],
  );
  assert.deepEqual(
    records(id).map((r) => r.question),
    ['Q1?', 'Q3?'],
  );
  // RETRY does the dropped question again; its record comes last.
  manager.start({ id, confirm: true, retry: true });
  await manager.started;
  v = view();
  assert.deepEqual([v.records, v.failedQuestions, v.last.questionNumber], [3, [], 2]);
  // Heading 2 without review keeps one record per answer: a drop takes the whole question out.
  const two = add(2, { teachers: ['a', 'b'], review: false }, 'Q7?');
  manager.start({ id: two, confirm: true });
  await manager.started;
  assert.equal(manager.record({ id: two }).total, 2);
  manager.dropRecords({ id: two, at: 0 });
  const w = manager.status().features.find((f) => f.id === two);
  assert.deepEqual([w.records, w.failedQuestions, w.last], [0, [1], null]);
});

test('a Grok Bot computer on a swarm task is waited for, five seconds at a time; after ten minutes the next route is tried', async () => {
  const grok = {
    id: 'grok-bot',
    label: 'GROK BOT',
    kind: 'bot',
    app: 'grok-bot',
    routes: ['computer', 'desktop'],
  };
  const env = {
    GROK_BOT_GATEWAY_URL: 'http://127.0.0.1:18789',
    GROK_BOT_GATEWAY_TOKEN: 'tok',
  };
  let busyLeft = 2;
  let clock = 0;
  const waits = [];
  const askComputer = async () => {
    if (busyLeft-- > 0)
      throw Object.assign(new Error('Grok Bot is on a task.'), {
        code: 'busy',
      });
    return 'the report';
  };
  const got = await askTeacher(grok, {
    system: 'S',
    prompt: 'P',
    env,
    askComputer,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    clock: () => clock,
  });
  assert.deepEqual(
    [got.text, got.route, waits],
    ['the report', 'computer', [5000, 5000]],
  );
  busyLeft = Infinity;
  clock = 0;
  waits.length = 0;
  const later = await askTeacher(grok, {
    system: 'S',
    prompt: 'P',
    env,
    askComputer,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    clock: () => clock,
  });
  assert.deepEqual([later.manual, later.route], [true, 'desktop']);
  assert.match(later.tried[0].error, /on a task/);
  assert.equal(waits.length, 120, 'ten minutes of five-second waits');
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
    () => manager.addQuestions({ id, text: 'Same?' }),
    /That question is there already\./,
  );
  assert.throws(
    () => manager.addQuestions({ id, text: 'Same?\nOther?' }),
    /Those questions are there already\./,
  );
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
  assert.throws(
    () => manager.start({ id, fresh: true }),
    /Confirm the estimate/,
  );
  assert.equal(
    manager.status().features.find((f) => f.id === id).cursor,
    3,
    'START OVER without CONFIRM changes nothing',
  );
  const csv = manager.exportData({ id, format: 'csv' });
  assert.equal(csv.filename, 'distill-my-1.csv');
  assert.match(
    csv.body,
    /^id,heading,question,ground_truth,picked_by,teachers,students,student_grades,class\r\n/,
  );
  assert.match(
    csv.body,
    /"Third, with comma\?","a says Third, with comma\?",single,A,,,restricted/,
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
