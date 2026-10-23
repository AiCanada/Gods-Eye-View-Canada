// AI DISTILLATION's best-effort round trip through a bot's desktop app
// (server/shared/desktopReply.mjs): the tagged paste, the reader's job and
// its answer, one app at a time, and the teachers' fallback to the paste-back
// box when a reply does not come back. PowerShell, the apps and the clipboard
// are fakes: nothing here opens or pastes into a real app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDesktopRound,
  desktopTag,
  readDesktopReply,
  tagPrompt,
} from '../../server/shared/desktopReply.mjs';
import {
  askTeacher,
  teacherRoster,
} from '../../server/shared/distillTeachers.mjs';

const B = String.fromCharCode(92);
const win = (...parts) => parts.join(B);
const WINDOWS = win('C:', 'Windows');
const EXPLORER = win('C:', 'Windows', 'explorer.exe');
const POWERSHELL = win(
  'C:',
  'Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const REPO = win('C:', 'repo');
const READER = win('C:', 'repo', 'scripts', 'read-desktop-reply.ps1');
const PASTE_GROK = win('C:', 'repo', 'scripts', 'paste-grok-bot.ps1');
const PASTE_DOTS = win('C:', 'repo', 'scripts', 'paste-openai-dots.ps1');

function filesystem(paths) {
  return {
    statSync(target) {
      if (paths.includes(target))
        return { isFile: () => true, isDirectory: () => false };
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  };
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/**
 * A spawn that plays explorer, the paste scripts and the reader. `reader`
 * gets the job and returns the line the reader prints (or null to hang until
 * killed); `paste` returns the paste script's exit code.
 */
function fakeSpawn({ reader, paste = () => 0 } = {}) {
  const log = [];
  const spawnImpl = (command, args, options) => {
    const script = String(args.at(-1) || '').replaceAll('"', '');
    const rec = { command, args, options, script, stdin: '', killed: false };
    log.push(rec);
    const handlers = { exit: [], error: [] };
    const out = [];
    const child = {
      stdin: {
        write(chunk) {
          rec.stdin += String(chunk);
        },
        end() {
          queueMicrotask(() => {
            if (script === READER) {
              const line = reader?.(JSON.parse(rec.stdin), log);
              if (line == null) return;
              for (const fn of out) fn(`${JSON.stringify(line)}\n`);
              for (const fn of handlers.exit)
                fn(line.event === 'reply' ? 0 : 1);
            } else if (script === PASTE_GROK || script === PASTE_DOTS) {
              const code = paste(rec.stdin);
              for (const fn of handlers.exit) fn(code);
            }
          });
        },
      },
      stdout: {
        setEncoding() {},
        on(event, fn) {
          if (event === 'data') out.push(fn);
        },
      },
      stderr: { resume() {} },
      on(event, fn) {
        handlers[event]?.push(fn);
        return child;
      },
      kill() {
        rec.killed = true;
        for (const fn of handlers.exit) fn(null);
      },
      unref() {},
    };
    return child;
  };
  return { spawnImpl, log };
}

const seams = (
  spawnImpl,
  files = [POWERSHELL, READER, PASTE_GROK, PASTE_DOTS, EXPLORER],
) => ({
  spawnImpl,
  platform: 'win32',
  fileSystem: filesystem(files),
  env: { SystemRoot: WINDOWS },
  sourceRoot: REPO,
});

test('the tag: GEV- and hex, on its own last line of the pasted prompt', () => {
  const tag = desktopTag();
  assert.match(tag, /^GEV-[0-9a-f]{8}$/);
  assert.notEqual(desktopTag(), tag);
  assert.equal(tagPrompt('Q?', 'GEV-0a1b2c3d'), 'Q?\n\n[GEV-0a1b2c3d]');
});

test('the reader: PowerShell -File the repo script, the job on stdin, the reply decoded', async () => {
  const fake = fakeSpawn({
    reader: () => ({ event: 'reply', how: 'copy', b64: b64('Réponse **4**.') }),
  });
  const got = await readDesktopReply({
    app: 'chatgpt',
    tag: 'GEV-0a1b2c3d',
    ...seams(fake.spawnImpl),
  });
  assert.deepEqual(got, { text: 'Réponse **4**.', how: 'copy' });
  const [run] = fake.log;
  assert.equal(run.command, POWERSHELL);
  assert.deepEqual(run.args, [
    '-NoProfile',
    '-STA',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    `"${READER}"`,
  ]);
  const job = JSON.parse(run.stdin);
  assert.equal(job.app, 'chatgpt');
  assert.equal(job.tag, 'GEV-0a1b2c3d');
  // ChatGPT's own Copy response; Grok Bot has none, so it is read.
  assert.equal(job.copy, true);
  assert.equal(job.quietMs, 5_000);
  const grok = fakeSpawn({
    reader: (j) => ({
      event: 'reply',
      how: 'read',
      b64: b64(`copy ${j.copy}`),
    }),
  });
  const read = await readDesktopReply({
    app: 'grok-bot',
    tag: 'GEV-0a1b2c3d',
    ...seams(grok.spawnImpl),
  });
  assert.deepEqual(read, { text: 'copy false', how: 'read' });
});

test('the reader: its reason when nothing came back, STOP ends it, and only on Windows', async () => {
  const missing = fakeSpawn({
    reader: () => ({
      event: 'error',
      reason: 'the pasted prompt is not in the app',
    }),
  });
  await assert.rejects(
    readDesktopReply({
      app: 'grok-bot',
      tag: 'GEV-0a1b2c3d',
      ...seams(missing.spawnImpl),
    }),
    /did not come back: the pasted prompt is not in the app/,
  );
  const hang = fakeSpawn({ reader: () => null });
  const stop = new AbortController();
  const waiting = readDesktopReply({
    app: 'grok-bot',
    tag: 'GEV-0a1b2c3d',
    signal: stop.signal,
    ...seams(hang.spawnImpl),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  stop.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(hang.log[0].killed, true);
  await assert.rejects(
    readDesktopReply({
      app: 'grok-bot',
      tag: 'GEV-0a1b2c3d',
      ...seams(hang.spawnImpl),
      platform: 'linux',
    }),
    /needs Windows/,
  );
});

test('a round: opens the app, pastes the tagged prompt, reads the reply after that tag; one app at a time', async () => {
  const order = [];
  const fake = fakeSpawn({
    paste: (text) => {
      order.push(`paste ${text.slice(0, 2)}`);
      return 0;
    },
    reader: (job, log) => {
      const pasted = log
        .filter((r) => r.script === PASTE_DOTS || r.script === PASTE_GROK)
        .at(-1);
      order.push(`read ${pasted.stdin.slice(0, 2)}`);
      assert.ok(pasted.stdin.endsWith(`[${job.tag}]`));
      return {
        event: 'reply',
        how: 'read',
        b64: b64(`answer to ${pasted.stdin.slice(0, 2)}`),
      };
    },
  });
  const round = createDesktopRound({
    ...seams(fake.spawnImpl),
    sleep: async () => {},
  });
  assert.equal(round.ready(), true);
  const [one, two] = await Promise.all([
    round.ask({ app: 'grok-bot', prompt: 'Q1' }),
    round.ask({ app: 'chatgpt', prompt: 'Q2' }),
  ]);
  assert.equal(one.text, 'answer to Q1');
  assert.equal(two.text, 'answer to Q2');
  assert.match(one.tag, /^GEV-[0-9a-f]{8}$/);
  // The second paste waits until the first reply is back.
  assert.deepEqual(order, ['paste Q1', 'read Q1', 'paste Q2', 'read Q2']);
  const opened = fake.log
    .filter((r) => r.command === EXPLORER)
    .map((r) => r.args[0]);
  assert.deepEqual(opened, ['grokbot://app/v1/open', 'chatgpt://']);
  assert.equal(
    createDesktopRound({ ...seams(fake.spawnImpl, [POWERSHELL]) }).ready(),
    false,
  );
});

test('a round that fails says whether the prompt is already in the app', async () => {
  const noPaste = fakeSpawn({ paste: () => 5 });
  const round = createDesktopRound({
    ...seams(noPaste.spawnImpl),
    sleep: async () => {},
  });
  await assert.rejects(round.ask({ app: 'grok-bot', prompt: 'Q' }), (error) => {
    assert.equal(error.pasted, false);
    assert.match(error.message, /could not be pasted/);
    return true;
  });
  const noReply = fakeSpawn({
    reader: () => ({ event: 'error', reason: 'no finished reply in time' }),
  });
  const late = createDesktopRound({
    ...seams(noReply.spawnImpl),
    sleep: async () => {},
  });
  await assert.rejects(late.ask({ app: 'chatgpt', prompt: 'Q' }), (error) => {
    assert.equal(error.pasted, true);
    assert.match(error.message, /no finished reply in time/);
    return true;
  });
  const long = createDesktopRound({
    ...seams(noReply.spawnImpl),
    sleep: async () => {},
  });
  await assert.rejects(
    long.ask({ app: 'grok-bot', prompt: 'x'.repeat(17 * 1024) }),
    /too long to paste/,
  );
});

const grokBot = {
  id: 'grok-bot',
  label: 'GROK BOT',
  kind: 'bot',
  app: 'grok-bot',
  routes: ['desktop'],
};

test("a teacher's app route: the reply comes back by itself, else it waits for the owner's paste", async () => {
  const asked = [];
  const answered = await askTeacher(
    { ...grokBot, id: 'openai-dots', label: 'OPENAI DOTS', app: 'chatgpt' },
    {
      system: 'SYS',
      prompt: 'Q?',
      env: {},
      onStep: (step) => asked.push(step),
      desktop: {
        ready: () => true,
        ask: async ({ app, prompt }) => {
          asked.push({ app, prompt });
          return { text: 'Four.', how: 'copy' };
        },
      },
    },
  );
  assert.deepEqual(
    [answered.text, answered.route, answered.model, answered.how],
    ['Four.', 'desktop', 'ChatGPT app', 'copy'],
  );
  assert.match(answered.responseId, /^gev-[0-9a-f]{12}$/);
  assert.deepEqual(asked, [
    { route: 'desktop', app: 'chatgpt' },
    {
      app: 'chatgpt',
      prompt:
        'SYS\n\nWrite the reasoning trace you actually use between <think> and </think>, then the answer. Do not invent a trace you did not use.\n\nQ?',
    },
  ]);
  const late = await askTeacher(grokBot, {
    system: 'SYS',
    prompt: 'Q?',
    env: {},
    desktop: {
      ready: () => true,
      ask: async () => {
        throw Object.assign(new Error('no finished reply in time'), {
          pasted: true,
        });
      },
    },
  });
  assert.deepEqual(
    [late.manual, late.sent, late.note, late.prompt],
    [
      true,
      true,
      'no finished reply in time',
      'SYS\n\nWrite the reasoning trace you actually use between <think> and </think>, then the answer. Do not invent a trace you did not use.\n\nQ?',
    ],
  );
  // Not on Windows (or no reader): the paste box, as before.
  const plain = await askTeacher(grokBot, {
    system: 'S',
    prompt: 'P',
    env: {},
  });
  assert.deepEqual(
    [plain.manual, plain.sent, plain.note],
    [true, false, undefined],
  );
});

test('after the Chief of Staff webhook, the reply is read from the Grok Bot window by its tag', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, body: [Buffer.from('{}')] };
  };
  const reads = [];
  const got = await askTeacher(
    { ...grokBot, routes: ['webhook', 'desktop'] },
    {
      system: 'SYS',
      prompt: 'Q?',
      env: {
        GROK_BOT_WEBHOOK_URL: 'https://hook.example/run',
        GROK_BOT_WEBHOOK_KEY: 'hook-key',
      },
      fetchImpl,
      desktop: {
        ready: () => true,
        read: async ({ app, tag }) => {
          reads.push({ app, tag });
          return { text: 'From the Chief of Staff.', how: 'read' };
        },
      },
    },
  );
  assert.deepEqual(
    [got.text, got.route],
    ['From the Chief of Staff.', 'webhook'],
  );
  assert.equal(reads[0].app, 'grok-bot');
  assert.ok(sent[0].text.endsWith(`[${reads[0].tag}]`));
});

test('the roster: an app teacher whose reply can come back is not paste-only', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-desktop-'));
  const here = teacherRoster({ env: {}, dataRoot, desktopReady: true });
  const dots = here.find((t) => t.id === 'openai-dots');
  assert.deepEqual([dots.auto, dots.manualOnly], [true, false]);
  const elsewhere = teacherRoster({ env: {}, dataRoot, desktopReady: false });
  const grok = elsewhere.find((t) => t.id === 'grok-bot');
  assert.deepEqual([grok.auto, grok.manualOnly], [false, true]);
});
