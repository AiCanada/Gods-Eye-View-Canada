import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OWNER_DEVICE_AUTHORITY_HEADER,
  OWNER_DEVICE_HEADER,
  OWNER_DEVICE_REMOVAL_HEADER,
  setOwnerDeviceToken,
} from '../keySetupCore.mjs';
import {
  baseModelOnMachine,
  cleanBaseModel,
  cleanLlmName,
  cleanLocalPath,
  createLlmTrainingManager,
  fetchUrlText,
  LLM_BASE_OPTIONS,
  LLM_DEFAULT_BASE,
  LLM_SOURCES,
  resolveBaseModel,
} from '../../server/shared/llmTraining.mjs';
import { llmTrainingProvider } from '../../server/providers/llmTraining.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-llm-'));
const write = (root, rel, text = 'x') => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

/** A fake Python: each child answers with the events given for its module. */
function fakeSpawn(byModule) {
  const children = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.received = [];
    child.stdin = {
      write(line) {
        child.received.push(JSON.parse(line));
      },
    };
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    child.command = command;
    child.args = args;
    children.push(child);
    const module = args[args.indexOf('-m') + 1];
    const plan = byModule[module] || { events: [], code: 0 };
    if (!plan.hold)
      setImmediate(() => {
        for (const event of plan.events)
          child.stdout.emit('data', `${JSON.stringify(event)}\n`);
        child.emit('exit', plan.code, null);
      });
    return child;
  };
  return { spawnImpl, children };
}

/** Wait until `ready()` holds (a busy machine runs the fake children late). */
async function until(ready, ms = 5000) {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const noTimers = { setInterval: () => 0, clearInterval() {} };

/** A Hugging Face cache with one model in it. */
function fakeHub(root, id = 'Qwen/Qwen3.5-0.8B') {
  write(
    root,
    `hub/models--${id.replace('/', '--')}/snapshots/abc/config.json`,
    '{}',
  );
  return { HF_HUB_CACHE: path.join(root, 'hub') };
}

test('names, base models and local sources are checked before anything runs', () => {
  assert.equal(cleanLlmName(' My Model!! '), 'my-model');
  assert.equal(cleanLlmName(''), 'gev-llm');
  assert.equal(cleanBaseModel('Qwen/Qwen3-0.6B'), 'Qwen/Qwen3-0.6B');
  assert.throws(() => cleanBaseModel('not a model'), /Hugging Face id/);
  const root = tmp();
  try {
    const data = path.join(root, '.gev-data');
    const env = fakeHub(root);
    assert.equal(baseModelOnMachine('Qwen/Qwen3.5-0.8B', env), true);
    // A model folder downloaded into .gev-data/llm/base/ is found by its id.
    assert.equal(
      resolveBaseModel('Qwen/Qwen3-8B', { env, dataRoot: data }),
      null,
    );
    const local = path.dirname(
      write(data, 'llm/base/Qwen3-8B/config.json', '{}'),
    );
    assert.equal(
      resolveBaseModel('Qwen/Qwen3-8B', { env, dataRoot: data }),
      local,
    );
    assert.equal(
      resolveBaseModel('Qwen/Qwen3.5-0.8B', { env, dataRoot: data }),
      'Qwen/Qwen3.5-0.8B',
    );
    assert.equal(baseModelOnMachine('nobody/else', env), false);
    write(root, 'folder-model/config.json', '{}');
    assert.equal(
      baseModelOnMachine(path.join(root, 'folder-model'), env),
      true,
    );
    write(root, 'config/ultra-tokens.json', '{}');
    write(root, 'notes/a.md', '# a');
    const refused = (p, pattern) =>
      assert.throws(() => cleanLocalPath(p, { root, dataRoot: data }), pattern);
    refused('relative/path', /full path/);
    refused(path.join(root, 'config'), /own keys/);
    refused(path.join(root, '.env'), /own keys/);
    refused(path.join(data, 'llm', 'gev-llm'), /own keys/);
    refused(root, /holds the app/);
    refused(path.join(root, 'nowhere'), /Nothing at that path/);
    assert.equal(
      cleanLocalPath(path.join(root, 'notes'), { root, dataRoot: data }),
      path.join(root, 'notes'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a custom URL: public https only, every redirect checked, text only, at most 2 MB', async () => {
  const lookup = async (host) =>
    host === 'inside.example'
      ? [{ address: '10.0.0.5' }]
      : [{ address: '93.184.216.34' }];
  const page = (body, type = 'text/html', status = 200, location = null) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (n) =>
        n.toLowerCase() === 'content-type'
          ? type
          : n.toLowerCase() === 'location'
            ? location
            : null,
    },
    body: {
      cancel: async () => {},
      getReader() {
        let sent = false;
        return {
          read: async () =>
            sent
              ? { done: true }
              : ((sent = true),
                { done: false, value: new TextEncoder().encode(body) }),
          cancel: async () => {},
        };
      },
    },
  });
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.redirect]);
    if (url.includes('/hop'))
      return page('', 'text/html', 302, 'https://inside.example/secret');
    if (url.includes('/move')) return page('', 'text/html', 301, '/report');
    if (url.includes('/pic')) return page('PNG', 'image/png');
    return page('<html><script>x()</script><p>Port &amp; storm</p></html>');
  };
  assert.deepEqual(
    await fetchUrlText('http://news.example/a', { fetchImpl, lookup }),
    {
      error: 'REFUSED ADDRESS',
    },
  );
  assert.deepEqual(
    await fetchUrlText('https://inside.example/a', { fetchImpl, lookup }),
    {
      error: 'PRIVATE ADDRESS',
    },
  );
  assert.deepEqual(
    await fetchUrlText('https://news.example/hop', { fetchImpl, lookup }),
    {
      error: 'PRIVATE ADDRESS',
    },
  );
  assert.deepEqual(
    await fetchUrlText('https://news.example/pic', { fetchImpl, lookup }),
    {
      error: 'NOT TEXT',
    },
  );
  const moved = await fetchUrlText('https://news.example/move', {
    fetchImpl,
    lookup,
  });
  assert.equal(moved.url, 'https://news.example/report');
  assert.equal(moved.text, 'Port & storm');
  assert.ok(seen.every(([, redirect]) => redirect === 'manual'));
});

test('the run: URLs fetched, the dataset built from the ticked sources and local paths, then trained', async () => {
  const root = tmp();
  try {
    const data = path.join(root, '.gev-data');
    const env = fakeHub(root);
    const notes = path.dirname(write(root, 'notes/a.md', '# a'));
    const { spawnImpl, children } = fakeSpawn({
      'ml.gevtape.llm_data': {
        events: [{ event: 'built', train: 40, heldout: 2 }],
        code: 0,
      },
      'ml.gevtape.llm_train': {
        events: [
          { event: 'progress', epoch: 1, epochs: 1, loss: 1.25 },
          { event: 'done' },
        ],
        code: 0,
      },
    });
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: (n) => (n === 'content-type' ? 'text/plain' : null) },
      text: async () => 'The port reopened.',
    });
    const manager = createLlmTrainingManager({
      root,
      dataRoot: data,
      spawnImpl,
      python: ['py', '-3.13'],
      fetchImpl,
      lookup: async () => [{ address: '93.184.216.34' }],
      env,
      timers: noTimers,
    });
    assert.deepEqual(
      manager.status().sources.map((s) => s.id),
      LLM_SOURCES.map((s) => s.id),
    );
    manager.setConfig({
      name: 'Port Watch',
      sources: ['news', 'urls', 'local', 'bogus'],
      epochs: 2,
      daily: true,
    });
    manager.addUrl('https://news.example/report');
    assert.throws(
      () => manager.addUrl('http://news.example/x'),
      /public https/,
    );
    manager.addPath(notes);
    const status = manager.status();
    assert.deepEqual(status.config.sources, ['news', 'urls', 'local']);
    assert.equal(status.config.name, 'port-watch');
    assert.equal(status.baseOnMachine, true);
    manager.initialize();
    await until(() => manager.status().state === 'done');
    const [build, trainer] = children;
    const arg = (c, flag) => c.args[c.args.indexOf(flag) + 1];
    assert.equal(arg(build, '-m'), 'ml.gevtape.llm_data');
    assert.equal(arg(build, '--sources'), 'news,urls,local');
    assert.equal(arg(build, '--path'), notes);
    assert.equal(arg(trainer, '-m'), 'ml.gevtape.llm_train');
    assert.equal(arg(trainer, '--base'), 'Qwen/Qwen3.5-0.8B');
    assert.equal(arg(trainer, '--epochs'), '2');
    assert.equal(
      arg(trainer, '--out'),
      path.join(data, 'llm', 'port-watch', 'model'),
    );
    const after = manager.status();
    assert.equal(after.state, 'done');
    assert.equal(after.stage.built.train, 40);
    assert.equal(after.stage.loss, 1.25);
    assert.equal(after.urls[0].ok, true);
    const saved = fs.readdirSync(path.join(data, 'llm', 'sources', 'urls'));
    assert.equal(saved.length, 1);
    // A URL taken off the list leaves no text behind.
    manager.removeUrl('https://news.example/report');
    assert.equal(
      fs.readdirSync(path.join(data, 'llm', 'sources', 'urls')).length,
      0,
    );
    manager.removePath(notes);
    assert.deepEqual(manager.status().paths, []);
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no base model on this machine: INITIALIZE TRAINING says so and downloads nothing', () => {
  const root = tmp();
  try {
    const manager = createLlmTrainingManager({
      root,
      spawnImpl: fakeSpawn({}).spawnImpl,
      env: { HF_HUB_CACHE: path.join(root, 'empty') },
      timers: noTimers,
    });
    assert.throws(() => manager.initialize(), /NOT ON THIS MACHINE/);
    manager.setConfig({ sources: [] });
    assert.throws(
      () => manager.initialize(),
      /NOT ON THIS MACHINE|Tick at least one/,
    );
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PAUSE saves through the trainer, CONTINUE resumes it, STOP keeps everything', async () => {
  const root = tmp();
  try {
    const env = fakeHub(root);
    const { spawnImpl, children } = fakeSpawn({
      'ml.gevtape.llm_data': { events: [], code: 0 },
      'ml.gevtape.llm_train': { hold: true },
    });
    const manager = createLlmTrainingManager({
      root,
      spawnImpl,
      env,
      timers: noTimers,
    });
    manager.initialize();
    await until(
      () => manager.status().state === 'training' && children.length === 2,
    );
    assert.equal(manager.status().state, 'training');
    manager.pause();
    const trainer = children.at(-1);
    assert.deepEqual(trainer.received, [{ cmd: 'pause' }]);
    trainer.emit('exit', 0, null);
    await until(() => manager.status().state === 'paused');
    manager.continue();
    await until(() => children.length === 3);
    const resumed = children.at(-1);
    assert.ok(resumed.args.includes('--resume'));
    assert.equal(
      children.filter((c) => c.args.includes('ml.gevtape.llm_data')).length,
      1,
      'CONTINUE does not rebuild the data',
    );
    manager.stop();
    assert.deepEqual(resumed.received, [{ cmd: 'stop' }]);
    resumed.emit('exit', 0, null);
    await until(() => manager.status().state === 'stopped');
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The provider's middleware with a fake server. */
function install(plugin) {
  let handler;
  plugin.configureServer({
    httpServer: null,
    middlewares: { use: (_mount, fn) => (handler = fn) },
  });
  return async (
    url,
    { method = 'GET', headers = {}, remoteAddress = '127.0.0.1', body } = {},
  ) => {
    const chunks =
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = new EventEmitter();
    Object.assign(req, { url, method, headers, socket: { remoteAddress } });
    req[Symbol.asyncIterator] = async function* () {
      yield* chunks;
    };
    setImmediate(() => {
      for (const c of chunks) req.emit('data', c);
      req.emit('end');
    });
    const res = {
      headersSent: false,
      writeHead(status, h) {
        Object.assign(this, { status, headers: h, headersSent: true });
      },
      setHeader() {},
      end(chunk) {
        this.body = String(chunk ?? '');
      },
      destroy() {},
    };
    await handler(req, res);
    return res;
  };
}

const TOKEN = '7'.repeat(64);
const MIRROR = 'http://100.64.0.1:4173';
const pc = {
  host: 'localhost:4173',
  origin: 'http://localhost:4173',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
};
const owner = {
  host: '100.64.0.1:4173',
  origin: MIRROR,
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
  [OWNER_DEVICE_HEADER]: TOKEN,
  [OWNER_DEVICE_AUTHORITY_HEADER]: MIRROR,
};

test('the routes: this machine runs everything; the owner phone adds and runs but never removes', async (t) => {
  const root = tmp();
  setOwnerDeviceToken(TOKEN);
  t.after(() => {
    setOwnerDeviceToken('');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = install(
    llmTrainingProvider({
      root,
      env: {},
      log: () => {},
      createManager: (options) =>
        createLlmTrainingManager({
          ...options,
          spawnImpl: fakeSpawn({}).spawnImpl,
          timers: noTimers,
        }),
    }),
  );
  const status = await request('/status', { headers: pc });
  assert.equal(status.status, 200, status.body);
  assert.equal(JSON.parse(status.body).state, 'idle');
  const crossSite = await request('/status', {
    headers: { ...pc, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  const added = await request('/urls', {
    method: 'POST',
    headers: owner,
    remoteAddress: '100.64.0.10',
    body: { url: 'https://news.example/a' },
  });
  assert.equal(added.status, 200, added.body);
  const refused = await request('/urls', {
    method: 'DELETE',
    headers: owner,
    remoteAddress: '100.64.0.10',
    body: { url: 'https://news.example/a' },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers[OWNER_DEVICE_REMOVAL_HEADER], 'pc-only');
  const still = JSON.parse((await request('/status', { headers: pc })).body);
  assert.deepEqual(
    still.urls.map((u) => u.url),
    ['https://news.example/a'],
    'nothing was taken off',
  );
  const removed = await request('/urls', {
    method: 'DELETE',
    headers: pc,
    body: { url: 'https://news.example/a' },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(JSON.parse(removed.body).urls, []);
  const bad = await request('/paths', {
    method: 'POST',
    headers: pc,
    body: { path: 'relative' },
  });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error, /full path/);
});

test('the default base is Qwen3.5-0.8B with Qwen3.6-35B-A3B offered; an untouched old default moves to it; a downloaded folder is what trains', async () => {
  assert.equal(LLM_DEFAULT_BASE, 'Qwen/Qwen3.5-0.8B');
  assert.deepEqual(
    LLM_BASE_OPTIONS.map((o) => o.id),
    ['Qwen/Qwen3.5-0.8B', 'Qwen/Qwen3.6-35B-A3B'],
  );
  const root = tmp();
  try {
    const data = path.join(root, '.gev-data');
    write(
      data,
      'llm/state.json',
      JSON.stringify({ config: { base: 'Qwen/Qwen3-0.6B', name: 'old' } }),
    );
    const folder = path.dirname(
      write(data, 'llm/base/Qwen3.5-0.8B/config.json', '{}'),
    );
    const { spawnImpl, children } = fakeSpawn({
      'ml.gevtape.llm_data': { events: [], code: 0 },
      'ml.gevtape.llm_train': { events: [], code: 0 },
    });
    const manager = createLlmTrainingManager({
      root,
      dataRoot: data,
      spawnImpl,
      env: { HF_HUB_CACHE: path.join(root, 'empty') },
      timers: noTimers,
    });
    const status = manager.status();
    assert.equal(status.config.base, 'Qwen/Qwen3.5-0.8B');
    assert.deepEqual(
      status.bases.map((b) => [b.id, b.onMachine]),
      [
        ['Qwen/Qwen3.5-0.8B', true],
        ['Qwen/Qwen3.6-35B-A3B', false],
      ],
    );
    assert.equal(status.baseOnMachine, true, 'found in .gev-data/llm/base/');
    manager.initialize();
    await until(() => children.length === 2);
    const trainer = children[1];
    assert.equal(trainer.args[trainer.args.indexOf('--base') + 1], folder);
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
