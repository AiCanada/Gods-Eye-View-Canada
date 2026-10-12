import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import path from 'node:path';
import {
  codexAuthPath,
  preferCodexOAuth,
  readCodexOAuthAccessToken,
  resolveCodexExecutable,
  resolveCodexLaunch,
  startCodexChatGptLogin,
} from '../server/providers/openai/codex-auth.js';

const nowMs = Date.UTC(2026, 8, 27);
const jwt = (payload) =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const auth = (token, extras = {}) =>
  JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: token, refresh_token: 'refresh-fixture' },
    ...extras,
  });

test('optional Codex OAuth pin fails closed on ambiguous values', () => {
  assert.equal(preferCodexOAuth({}), false);
  assert.equal(preferCodexOAuth({ GEV_PREFER_CODEX_OAUTH: 'true' }), true);
  assert.equal(preferCodexOAuth({ GEV_PREFER_CODEX_OAUTH: 'off' }), false);
  assert.throws(
    () => preferCodexOAuth({ GEV_PREFER_CODEX_OAUTH: 'maybe' }),
    /must be true or false/,
  );
});

test('Codex auth path follows explicit auth file, CODEX_HOME, then home directory', () => {
  assert.equal(
    codexAuthPath({
      environment: { CODEX_AUTH_JSON: '/tmp/custom-auth.json' },
      home: '/home/fixture',
    }),
    path.resolve('/tmp/custom-auth.json'),
  );
  assert.equal(
    codexAuthPath({
      environment: { CODEX_HOME: '/tmp/codex-home' },
      home: '/home/fixture',
    }),
    path.join(path.resolve('/tmp/codex-home'), 'auth.json'),
  );
  assert.equal(
    codexAuthPath({ environment: {}, home: '/home/fixture' }),
    path.join('/home/fixture', '.codex', 'auth.json'),
  );
});

test('Codex OAuth reader accepts a current ChatGPT token and rejects unusable credentials', () => {
  const current = jwt({ exp: nowMs / 1000 + 3600 });
  assert.equal(
    readCodexOAuthAccessToken({
      authPath: '/unused',
      nowMs,
      readFile: () => auth(current),
    }),
    current,
  );
  assert.equal(
    readCodexOAuthAccessToken({
      authPath: '/unused',
      nowMs,
      readFile: () =>
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: { access_token: current },
        }),
    }),
    current,
    'GEV does not require or consume the vendor refresh token',
  );
  for (const readFile of [
    () => '{bad json',
    () => JSON.stringify({ tokens: {} }),
    () => auth(current, { auth_mode: 'apikey' }),
    () =>
      JSON.stringify({
        OPENAI_API_KEY: 'sk-fixture',
        tokens: { access_token: current, refresh_token: 'refresh-fixture' },
      }),
    () => auth('opaque-token'),
    () => auth('header.not-json.signature'),
    () => auth(jwt({ exp: 'tomorrow' })),
    () => {
      throw new Error('missing');
    },
  ]) {
    assert.throws(
      () => readCodexOAuthAccessToken({ authPath: '/unused', readFile, nowMs }),
      /ChatGPT sign-in is unavailable/,
    );
  }
});

test('Codex OAuth reader enforces expiry margin and bounds tokens without exp by file age', () => {
  for (const exp of [nowMs / 1000 - 1, nowMs / 1000 + 59]) {
    assert.throws(
      () => {
        readCodexOAuthAccessToken({
          authPath: '/unused',
          nowMs,
          readFile: () => auth(jwt({ exp })),
        });
      },
      (error) => {
        assert.match(error.message, /sign-in has expired/);
        assert.equal(error.code, 'CODEX_OAUTH_REAUTH_REQUIRED');
        return true;
      },
    );
  }
  const noExp = jwt({ sub: 'fixture' });
  const base = { authPath: '/unused', nowMs, readFile: () => auth(noExp) };
  assert.equal(
    readCodexOAuthAccessToken({
      ...base,
      statFile: () => ({ mtimeMs: nowMs }),
    }),
    noExp,
  );
  assert.throws(
    () =>
      readCodexOAuthAccessToken({
        ...base,
        statFile: () => ({ mtimeMs: nowMs - 3600_000 }),
      }),
    /sign-in has expired/,
  );
  assert.throws(
    () =>
      readCodexOAuthAccessToken({
        ...base,
        statFile: () => {
          throw new Error('missing');
        },
      }),
    /sign-in is unavailable/,
  );
});

test('Codex login resolves an installed executable before PATH and starts browser auth detached', async () => {
  const checked = [];
  assert.equal(
    resolveCodexExecutable({
      environment: {},
      home: '/home/fixture',
      platform: 'linux',
      access(candidate) {
        checked.push(candidate);
        if (candidate.endsWith('/.local/bin/codex')) return;
        throw new Error('missing');
      },
    }),
    '/home/fixture/.local/bin/codex',
  );
  assert.equal(checked.length, 1);

  const child = new EventEmitter();
  let unref = 0;
  child.unref = () => {
    unref += 1;
  };
  const calls = [];
  const pending = startCodexChatGptLogin({
    executable: '/fixture/codex',
    home: '/home/fixture',
    environment: {
      PATH: '/fixture',
      https_proxy: 'http://proxy.fixture:8080',
      OPENAI_API_KEY: 'fixture-api-key',
      GOOGLE_MAPS_SERVER_API_KEY: 'fixture-google-key',
      OPENSKY_CLIENT_SECRET: 'fixture-opensky-secret',
    },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  const login = await pending;
  assert.equal(unref, 1);
  assert.equal(calls[0].command, '/fixture/codex');
  assert.deepEqual(calls[0].args, ['login']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(
    calls[0].options.env,
    {
      PATH: '/fixture',
      https_proxy: 'http://proxy.fixture:8080',
      CODEX_HOME: path.join('/home/fixture', '.codex'),
    },
    'provider secrets stay out of the login process',
  );
  child.emit('exit', 1);
  assert.deepEqual(await login.completion, { exitCode: 1 });
});

test('Codex login refuses a read/write storage mismatch before spawning', async () => {
  await assert.rejects(
    startCodexChatGptLogin({
      environment: { CODEX_AUTH_JSON: '/tmp/another-auth.json' },
      home: '/home/fixture',
      executable: 'codex',
      spawnImpl: () => assert.fail('mismatched storage must not launch login'),
    }),
    { code: 'CODEX_OAUTH_STORAGE_MISMATCH' },
  );
});

test('Codex login resolves relative CODEX_HOME before changing the child directory', async () => {
  const child = new EventEmitter();
  const environment = { CODEX_HOME: './fixture-codex' };
  const login = await startCodexChatGptLogin({
    environment,
    executable: 'codex',
    spawnImpl(_command, _args, options) {
      assert.equal(
        options.env.CODEX_HOME,
        path.resolve(environment.CODEX_HOME),
      );
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.equal(
    environment.CODEX_HOME,
    './fixture-codex',
    'caller environment is unchanged',
  );
  child.emit('exit', 0);
  assert.deepEqual(await login.completion, { exitCode: 0 });
});

test('Codex login hides spawn errors and can cancel only its owned child', async () => {
  const child = new EventEmitter();
  await assert.rejects(
    startCodexChatGptLogin({
      executable: 'codex',
      spawnImpl() {
        queueMicrotask(() =>
          child.emit('error', new Error('private-token-fixture')),
        );
        return child;
      },
    }),
    (error) =>
      error.code === 'CODEX_OAUTH_LOGIN_FAILED' &&
      !error.message.includes('private-token-fixture'),
  );

  const running = new EventEmitter();
  let cancelled = 0;
  running.kill = (signal) => {
    assert.equal(signal, 'SIGTERM');
    cancelled += 1;
    running.emit('exit', null);
  };
  const login = await startCodexChatGptLogin({
    executable: 'codex',
    spawnImpl() {
      queueMicrotask(() => running.emit('spawn'));
      return running;
    },
  });
  login.cancel();
  assert.equal(cancelled, 1);
  assert.deepEqual(await login.completion, { exitCode: null });
});

/** A Windows file system: only these files exist. */
function windowsFiles(...files) {
  const have = new Set(files.map((file) => file.toLowerCase()));
  return (file) => {
    if (!have.has(String(file).toLowerCase())) throw new Error('missing');
  };
}

const NPM = 'C:\\Program Files\\nodejs';
const NPM_SCRIPT = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;
const WIN_HOME = 'C:\\Users\\fixture';

test('Windows: an npm codex.cmd shim runs its codex.js with node, never the .cmd', () => {
  const launch = resolveCodexLaunch({
    platform: 'win32',
    home: WIN_HOME,
    execPath: 'C:\\node\\node.exe',
    environment: { Path: `.;bin;${NPM};C:\\Windows` },
    access: windowsFiles(`${NPM}\\codex.cmd`, NPM_SCRIPT, `${NPM}\\node.exe`),
  });
  assert.deepEqual(launch, {
    command: `${NPM}\\node.exe`,
    args: [NPM_SCRIPT],
  });
  // Without a node.exe beside the shim, this node runs it.
  assert.deepEqual(
    resolveCodexLaunch({
      platform: 'win32',
      home: WIN_HOME,
      execPath: 'C:\\node\\node.exe',
      environment: { PATH: NPM },
      access: windowsFiles(`${NPM}\\codex.cmd`, NPM_SCRIPT),
    }),
    { command: 'C:\\node\\node.exe', args: [NPM_SCRIPT] },
  );
});

test('Windows: only absolute paths are run, so the home folder is never searched first', () => {
  const checked = [];
  const access = (file) => {
    checked.push(file);
    throw new Error('missing');
  };
  assert.equal(
    resolveCodexLaunch({
      platform: 'win32',
      home: WIN_HOME,
      environment: { PATH: '.;bin;"";C:\\Tools' },
      access,
    }),
    null,
  );
  assert.ok(checked.length > 0);
  for (const file of checked) assert.match(file, /^[A-Za-z]:\\/);
  // codex.exe on PATH, and Codex's own install before PATH.
  assert.deepEqual(
    resolveCodexLaunch({
      platform: 'win32',
      home: WIN_HOME,
      environment: { PATH: 'C:\\Tools' },
      access: windowsFiles('C:\\Tools\\codex.exe'),
    }),
    { command: 'C:\\Tools\\codex.exe', args: [] },
  );
  const own = `${WIN_HOME}\\.codex\\packages\\standalone\\current\\bin\\codex.exe`;
  assert.deepEqual(
    resolveCodexLaunch({
      platform: 'win32',
      home: WIN_HOME,
      environment: { PATH: 'C:\\Tools' },
      access: windowsFiles(own, 'C:\\Tools\\codex.exe'),
    }),
    { command: own, args: [] },
  );
});

test('Windows: CODEX_BIN must be a full path that exists; a .cmd there runs through node', () => {
  const base = {
    platform: 'win32',
    home: WIN_HOME,
    execPath: 'C:\\n\\node.exe',
  };
  assert.equal(
    resolveCodexLaunch({
      ...base,
      environment: { CODEX_BIN: 'codex' },
      access: windowsFiles(),
    }),
    null,
  );
  assert.deepEqual(
    resolveCodexLaunch({
      ...base,
      environment: { CODEX_BIN: `${NPM}\\codex.cmd` },
      access: windowsFiles(`${NPM}\\codex.cmd`, NPM_SCRIPT),
    }),
    { command: 'C:\\n\\node.exe', args: [NPM_SCRIPT] },
  );
});

test('Windows: the login runs the script then login, hidden; no Codex is a clear failure', async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const calls = [];
  const login = await startCodexChatGptLogin({
    home: WIN_HOME,
    environment: { PATH: NPM },
    launch: { command: `${NPM}\\node.exe`, args: [NPM_SCRIPT] },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.equal(calls[0].command, `${NPM}\\node.exe`);
  assert.deepEqual(calls[0].args, [NPM_SCRIPT, 'login']);
  assert.equal(calls[0].options.windowsHide, true);
  child.emit('exit', 0);
  await login.completion;

  let spawned = 0;
  await assert.rejects(
    startCodexChatGptLogin({
      home: WIN_HOME,
      environment: {},
      launch: null,
      spawnImpl() {
        spawned += 1;
      },
    }),
    (error) =>
      error.code === 'CODEX_OAUTH_LOGIN_FAILED' &&
      /npm install -g @openai\/codex/.test(error.message),
  );
  assert.equal(spawned, 0);
});
