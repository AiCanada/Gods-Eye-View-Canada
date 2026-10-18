// The AI World tab's TENSORFLOW sections on the server: the runner choice
// (WSL2 with the GPU, else the Windows CPU), the four jobs' arguments,
// pause / continue / stop, TensorBoard, and the routes
// (server/shared/tensorflowJobs.mjs, server/providers/tensorflow.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  OWNER_DEVICE_AUTHORITY_HEADER,
  OWNER_DEVICE_HEADER,
  setOwnerDeviceToken,
} from '../keySetupCore.mjs';
import {
  TENSORBOARD_PREFIX,
  cleanTfSettings,
  createTensorflowManager,
  exportStamp,
  pickRunner,
  toWslPath,
} from '../../server/shared/tensorflowJobs.mjs';
import {
  proxyToBoard,
  tensorflowProvider,
} from '../../server/providers/tensorflow.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-tf-'));
const write = (root, rel, text = 'x') => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
/** Every path in the test tree as WSL2 would see it, whatever this OS is. */
const fakeWsl = (p) =>
  `/mnt/x/${String(p)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^[A-Za-z]:\//, '')}`;
const GPU = 'NVIDIA GeForce RTX 4060 Laptop GPU';

/**
 * Children that answer as the Python side does: the probe says what TensorFlow
 * each runner has; a job prints progress, then waits for pause or stop (or
 * `finish`); TensorBoard says where it serves.
 */
function fakeSpawn({
  wsl = { tensorflow: '2.21.0', tensorboard: '2.21.0', gpus: [GPU] },
  windows = { tensorflow: '2.21.0', tensorboard: '2.21.0', gpus: [] },
  board = 'ok',
} = {}) {
  const children = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.command = command;
    child.args = args;
    child.received = [];
    child.killed = false;
    const say = (event) =>
      child.stdout.emit('data', `${JSON.stringify(event)}\n`);
    const exit = (code) => setImmediate(() => child.emit('exit', code, null));
    child.kill = () => {
      child.killed = true;
      child.emit('exit', null, 'SIGTERM');
    };
    child.finish = (events = [], code = 0) => {
      for (const event of events) say(event);
      exit(code);
    };
    child.stdin = {
      write(line) {
        const message = JSON.parse(line);
        child.received.push(message);
        if (message.cmd === 'pause')
          child.finish([{ event: 'checkpoint' }, { event: 'paused' }]);
        if (message.cmd === 'stop')
          child.finish([{ event: 'checkpoint' }, { event: 'done' }]);
      },
    };
    const module = args[args.indexOf('-m') + 1];
    const onWsl = command === 'wsl.exe';
    setImmediate(() => {
      if (module === 'ml.gevtape.tf_probe') {
        const found = onWsl ? wsl : windows;
        if (found)
          child.finish([
            {
              event: 'probe',
              python: onWsl ? '3.13.16' : '3.13.1',
              gpus: [],
              ...found,
            },
          ]);
        else child.finish([], 1);
      } else if (module === 'tensorboard.main') {
        if (board === 'ok')
          child.stderr.emit(
            'data',
            `TensorBoard 2.21.0 at http://127.0.0.1:6006${TENSORBOARD_PREFIX}/ (Press CTRL+C to quit)\n`,
          );
        else {
          child.stderr.emit(
            'data',
            'E0000 TensorBoard could not bind to port 6006, it was already in use\n',
          );
          exit(1);
        }
      } else if (module === 'ml.gevtape.tf_train')
        say({
          event: 'progress',
          model: 'tf-world',
          epoch: 0,
          epochs: 10,
          device: onWsl ? `GPU ${GPU}` : 'CPU',
          tensorflow: '2.21.0',
        });
      else if (module === 'ml.gevtape.tf_export')
        say({
          event: 'progress',
          model: 'tf-export',
          stage: 'tfrecord',
          done: 1,
          total: 3,
        });
    });
    children.push(child);
    return child;
  };
  const jobs = (module) =>
    children.filter((c) => c.args[c.args.indexOf('-m') + 1] === module);
  return { spawnImpl, children, jobs };
}

function setup(t, options = {}) {
  const root = tmp();
  const dataRoot = path.join(root, '.gev-data');
  write(root, 'ml/adapters/keras_world.py', '# adapter');
  write(root, 'scripts/tensorflow-wsl-run.sh', '#!/bin/sh');
  const fake = fakeSpawn(options);
  let clock = Date.UTC(2026, 9, 17, 12, 30, 5);
  const manager = createTensorflowManager({
    root,
    dataRoot,
    env: {},
    platform: 'win32',
    python: ['py', '-3.13'],
    spawnImpl: fake.spawnImpl,
    wslPath: fakeWsl,
    now: () => clock,
    ...(options.manager || {}),
  });
  t.after(() => {
    manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(fake.children.length, 0, 'no Python until the tab asks');
  assert.equal(
    manager.status().runner.checking,
    true,
    'the first status asks the runners',
  );
  return { root, dataRoot, manager, ...fake, tick: (ms) => (clock += ms) };
}

test('the small rules: WSL paths, the runner choice, the settings and the export folder name', () => {
  assert.equal(
    toWslPath('A:\\Git Hub\\danger zone\\.gev-data'),
    '/mnt/a/Git Hub/danger zone/.gev-data',
  );
  assert.equal(toWslPath('C:/x/y'), '/mnt/c/x/y');
  assert.equal(toWslPath('D:'), '/mnt/d/');
  assert.equal(
    toWslPath('\\\\server\\share\\x'),
    null,
    'a network path has no drive',
  );
  assert.equal(toWslPath('/home/x'), null);
  const tf = { tensorflow: '2.21.0', gpus: [] };
  const gpu = { tensorflow: '2.21.0', gpus: [GPU] };
  assert.equal(pickRunner({ wsl: gpu, windows: tf }), 'wsl', 'the GPU first');
  assert.equal(
    pickRunner({ wsl: tf, windows: tf }),
    'windows',
    'no GPU: the Windows CPU',
  );
  assert.equal(
    pickRunner({ wsl: tf, windows: null }),
    'wsl',
    'WSL2 on its CPU when Windows has none',
  );
  assert.equal(pickRunner({ wsl: null, windows: { tensorflow: null } }), null);
  assert.equal(
    pickRunner({ wsl: gpu, windows: tf }, 'windows'),
    'windows',
    'GEV_TF_RUNNER',
  );
  assert.equal(
    pickRunner({ wsl: null, windows: tf }, 'wsl'),
    'windows',
    'an override needs TensorFlow there',
  );
  const base = { epochs: 10, device: 'auto', classes: 'all', withModel: true };
  assert.deepEqual(
    cleanTfSettings(
      { epochs: '3', device: 'cpu', classes: 'open', withModel: false },
      base,
    ),
    {
      epochs: 3,
      device: 'cpu',
      classes: 'open',
      withModel: false,
    },
  );
  for (const bad of [
    { epochs: 0 },
    { epochs: 201 },
    { device: 'tpu' },
    { classes: 'nc' },
  ])
    assert.throws(() => cleanTfSettings(bad, base), /is/);
  assert.equal(
    exportStamp(Date.UTC(2026, 9, 17, 12, 30, 5, 250)),
    '2026-10-17T12-30-05Z',
  );
});

test('training goes to WSL2 with the GPU, its paths moved to /mnt; PAUSE saves and CONTINUE resumes', async (t) => {
  const { dataRoot, manager, jobs } = setup(t);
  await settle();
  const runner = manager.status().runner;
  assert.equal(runner.kind, 'wsl');
  assert.equal(runner.gpu, GPU);
  assert.equal(runner.python, '3.13.16');
  manager.setSettings({ epochs: 3 });
  manager.train();
  assert.equal(manager.status().run.state, 'starting', 'it answers at once');
  await manager.started;
  await settle();
  const [child] = jobs('ml.gevtape.tf_train');
  assert.equal(child.command, 'wsl.exe');
  assert.deepEqual(child.args.slice(0, 7), [
    '-d',
    'Ubuntu',
    '--exec',
    'bash',
    fakeWsl(
      path.join(path.dirname(dataRoot), 'scripts', 'tensorflow-wsl-run.sh'),
    ),
    '-m',
    'ml.gevtape.tf_train',
  ]);
  const arg = (name) => child.args[child.args.indexOf(name) + 1];
  assert.equal(arg('--data'), fakeWsl(dataRoot));
  assert.equal(
    arg('--out'),
    fakeWsl(
      path.join(dataRoot, 'ai-world', 'tensorflow', 'models', 'tf-world'),
    ),
  );
  assert.equal(
    arg('--tensorboard'),
    fakeWsl(path.join(dataRoot, 'ai-world', 'tensorboard', 'tf-world')),
  );
  assert.equal(arg('--epochs'), '3');
  assert.equal(arg('--device'), 'auto');
  assert.ok(!child.args.includes('--resume'), 'no saved model yet');
  const run = manager.status().run;
  assert.equal(run.state, 'running');
  assert.equal(run.device, `GPU ${GPU}`);
  assert.throws(
    () => manager.exportNow(),
    /running already/,
    'one job at a time',
  );
  manager.pause();
  assert.deepEqual(child.received, [{ cmd: 'pause' }]);
  await settle();
  assert.equal(manager.status().run.state, 'paused');
  write(
    dataRoot,
    'ai-world/tensorflow/models/tf-world/state.json',
    JSON.stringify({ epoch: 0, stepInEpoch: 4 }),
  );
  manager.continue();
  await manager.started;
  await settle();
  const again = jobs('ml.gevtape.tf_train')[1];
  assert.ok(again.args.includes('--resume'));
  manager.stop();
  assert.deepEqual(again.received, [{ cmd: 'stop' }]);
  await settle();
  assert.equal(manager.status().run.state, 'stopped');
  assert.equal(manager.status().last.train.state, 'stopped');
  assert.equal(
    manager.status().model.paused,
    true,
    'its state.json is read back',
  );
  manager.train({ fresh: true });
  await manager.started;
  await settle();
  assert.ok(
    !jobs('ml.gevtape.tf_train')[2].args.includes('--resume'),
    'NEW MODEL starts over',
  );
});

test('without WSL2 TensorFlow the Windows Python 3.13 trains on the CPU; with none at all it says how to set it up', async (t) => {
  const cpu = setup(t, { wsl: null });
  await settle();
  assert.equal(cpu.manager.status().runner.kind, 'windows');
  assert.equal(cpu.manager.status().runner.gpu, null);
  cpu.manager.train();
  await cpu.manager.started;
  const [child] = cpu.jobs('ml.gevtape.tf_train');
  assert.equal(child.command, 'py');
  assert.deepEqual(child.args.slice(0, 3), [
    '-3.13',
    '-m',
    'ml.gevtape.tf_train',
  ]);
  assert.equal(
    child.args[child.args.indexOf('--data') + 1],
    cpu.dataRoot,
    'Windows paths as they are',
  );
  const none = setup(t, { wsl: null, windows: null });
  await settle();
  assert.equal(none.manager.status().runner.kind, null);
  none.manager.train();
  await none.manager.started;
  assert.equal(none.jobs('ml.gevtape.tf_train').length, 0);
  assert.equal(none.manager.status().run.state, 'error');
  assert.match(none.manager.status().run.error, /npm run tensorflow:wsl-setup/);
});

test('a failed job is an error with its message; the export goes to a new dated folder with the chosen classes', async (t) => {
  const { dataRoot, manager, jobs } = setup(t);
  await settle();
  manager.train();
  await manager.started;
  await settle();
  jobs('ml.gevtape.tf_train')[0].finish(
    [{ event: 'error', message: 'not enough bins for one window' }],
    1,
  );
  await settle();
  assert.equal(manager.status().run.state, 'error');
  assert.equal(manager.status().run.error, 'not enough bins for one window');
  manager.setSettings({ classes: 'open', withModel: false });
  manager.exportNow();
  await manager.started;
  await settle();
  const [child] = jobs('ml.gevtape.tf_export');
  const arg = (name) => child.args[child.args.indexOf(name) + 1];
  assert.equal(arg('--classes'), 'open');
  assert.ok(child.args.includes('--no-model'));
  assert.equal(
    arg('--out'),
    fakeWsl(
      path.join(
        dataRoot,
        'ai-world',
        'tensorflow',
        'exports',
        '2026-10-17T12-30-05Z',
      ),
    ),
  );
  assert.equal(manager.status().run.stage, 'tfrecord');
  assert.throws(
    () => manager.pause(),
    /Nothing to pause/,
    'an export is short: STOP only',
  );
  write(
    dataRoot,
    'ai-world/tensorflow/exports/2026-10-17T12-30-05Z/tensorflow.json',
    JSON.stringify({
      days: ['2026-10-16'],
      places: 6,
      channels: 3,
      files: [{ bytes: 10 }, { bytes: 5 }],
      publishable: true,
      model: null,
    }),
  );
  child.finish([
    {
      event: 'export',
      out: 'x',
      days: 1,
      files: 2,
      publishable: true,
      datasetClasses: ['open'],
      model: false,
    },
    { event: 'done' },
  ]);
  await settle();
  const status = manager.status();
  assert.equal(status.run.state, 'done');
  assert.equal(status.last.export.publishable, true);
  assert.deepEqual(
    status.exports.map((e) => [e.name, e.complete, e.bytes, e.publishable]),
    [['2026-10-17T12-30-05Z', true, 15, true]],
  );
});

test('post-training takes an adapter from the adapter folders and a model inside .gev-data', async (t) => {
  const { root, dataRoot, manager, jobs } = setup(t);
  await settle();
  assert.equal(
    manager.status().posttrain.adapter,
    'keras_world:KerasWorldAdapter',
  );
  assert.throws(
    () => manager.postTrain(),
    /TENSORFLOW TRAINING first/,
    'no model yet',
  );
  assert.throws(
    () =>
      manager.setSettings({
        posttrain: { adapter: 'nope:Missing', checkpoint: 'x' },
      }),
    /No nope\.py/,
  );
  write(dataRoot, 'models/mine/model.keras');
  assert.throws(
    () =>
      manager.setSettings({
        posttrain: {
          adapter: 'keras_world:KerasWorldAdapter',
          checkpoint: path.join(root, 'outside'),
        },
      }),
    /inside \.gev-data/,
  );
  manager.setSettings({
    posttrain: {
      adapter: 'keras_world:KerasWorldAdapter',
      checkpoint: 'models/mine',
      epochs: 2,
    },
  });
  manager.postTrain();
  await manager.started;
  const [child] = jobs('ml.gevtape.tf_posttrain');
  const arg = (name) => child.args[child.args.indexOf(name) + 1];
  assert.equal(arg('--adapter'), 'keras_world:KerasWorldAdapter');
  assert.equal(
    arg('--checkpoint'),
    fakeWsl(path.join(dataRoot, 'models', 'mine')),
  );
  assert.equal(arg('--epochs'), '2');
  assert.equal(
    arg('--out'),
    fakeWsl(path.join(dataRoot, 'ai-world', 'tensorflow', 'posttrain')),
  );
  child.finish([
    { event: 'posttrain', helped: true, before: 0.3, after: 0.2 },
    { event: 'done' },
  ]);
  await settle();
  assert.equal(manager.status().last.posttrain.helped, true);
  assert.equal(manager.status().last.posttrain.after, 0.2);
});

test('TensorBoard serves under /api/tensorflow/board from the Windows Python; a busy port is an error', async (t) => {
  const { dataRoot, manager, jobs } = setup(t);
  await settle();
  write(
    dataRoot,
    'ai-world/tensorboard/world/events.out.tfevents.1.pc.2.gev',
    'e',
  );
  write(
    dataRoot,
    'ai-world/tensorboard/tf-world/events.out.tfevents.1.pc.3.gev',
    'e',
  );
  write(dataRoot, 'ai-world/tensorboard/empty/readme.txt', 'no events');
  assert.equal(manager.boardTarget(), null);
  manager.startBoard();
  await manager.boardStarted;
  const [child] = jobs('tensorboard.main');
  assert.equal(child.command, 'py', 'the Windows Python has TensorBoard');
  const arg = (name) => child.args[child.args.indexOf(name) + 1];
  assert.equal(arg('--logdir'), path.join(dataRoot, 'ai-world', 'tensorboard'));
  assert.equal(arg('--host'), '127.0.0.1');
  assert.equal(arg('--path_prefix'), TENSORBOARD_PREFIX);
  await settle();
  const board = manager.status().board;
  assert.equal(board.state, 'running');
  assert.equal(board.url, `${TENSORBOARD_PREFIX}/`);
  assert.deepEqual(
    board.runs.map((r) => r.name),
    ['tf-world', 'world'],
    'folders with events only',
  );
  assert.deepEqual(manager.boardTarget(), { host: '127.0.0.1', port: 6006 });
  manager.stopBoard();
  assert.equal(child.killed, true);
  assert.equal(manager.status().board.state, 'off');
  const busy = setup(t, { board: 'busy' });
  await settle();
  busy.manager.startBoard();
  await busy.manager.boardStarted;
  await settle();
  assert.equal(busy.manager.status().board.state, 'error');
  assert.match(busy.manager.status().board.error, /already in use/);
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
    req.pipe = () => {};
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

const TOKEN = '8'.repeat(64);
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

test('the routes: this PC and the owner phone run everything; other sites and machines are refused', async (t) => {
  setOwnerDeviceToken(TOKEN);
  const calls = [];
  const fake = {
    status: () => ({ run: { state: 'idle' } }),
    train: (o) => (calls.push(['train', o]), { run: { state: 'starting' } }),
    exportNow: () => (calls.push(['export']), {}),
    setSettings: (b) => (calls.push(['settings', b]), {}),
    startBoard: () => (calls.push(['board-start']), {}),
    boardTarget: () => null,
    close() {},
  };
  t.after(() => setOwnerDeviceToken(''));
  const request = install(
    tensorflowProvider({
      root: tmp(),
      env: {},
      log: () => {},
      createManager: () => fake,
    }),
  );
  assert.equal((await request('/status', { headers: pc })).status, 200);
  assert.equal(
    (
      await request('/status', {
        headers: { ...pc, 'sec-fetch-site': 'cross-site' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/status', {
        headers: { ...pc, host: '192.168.1.5:4173' },
        remoteAddress: '192.168.1.9',
      })
    ).status,
    403,
    'a LAN visitor is refused',
  );
  const trained = await request('/train', {
    method: 'POST',
    headers: owner,
    remoteAddress: '100.64.0.10',
    body: { fresh: true },
  });
  assert.equal(trained.status, 200, trained.body);
  assert.equal(
    (await request('/export', { method: 'POST', headers: pc, body: {} }))
      .status,
    200,
  );
  assert.equal(
    (
      await request('/settings', {
        method: 'POST',
        headers: pc,
        body: { epochs: 2 },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/board-start', {
        method: 'POST',
        headers: owner,
        remoteAddress: '100.64.0.10',
        body: {},
      })
    ).status,
    200,
  );
  assert.deepEqual(calls, [
    ['train', { fresh: true }],
    ['export'],
    ['settings', { epochs: 2 }],
    ['board-start'],
  ]);
  const down = await request('/board/', { headers: pc });
  assert.equal(down.status, 503);
  assert.match(JSON.parse(down.body).error, /START TENSORBOARD/);
  assert.equal(
    (
      await request('/board/', {
        headers: { ...pc, 'sec-fetch-site': 'cross-site' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request('/nope', { method: 'POST', headers: pc, body: {} })).status,
    404,
  );
});

test('the board proxy passes a request through to TensorBoard and keeps the app cookies back', async (t) => {
  let seen = null;
  const board = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = {
        url: req.url,
        method: req.method,
        cookie: req.headers.cookie,
        body,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"runs":["world"]}');
    });
  });
  await new Promise((resolve) => board.listen(0, '127.0.0.1', resolve));
  t.after(() => board.close());
  const { port } = board.address();
  const answer = await new Promise((resolve, reject) => {
    const front = http.createServer((req, res) => {
      req.url = req.url.replace(/^\/api\/tensorflow/, '');
      proxyToBoard(req, res, { host: '127.0.0.1', port });
    });
    front.listen(0, '127.0.0.1', () => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port: front.address().port,
          method: 'POST',
          path: `${TENSORBOARD_PREFIX}/data/plugin/scalars/scalars_multirun`,
          headers: {
            cookie: 'session=secret',
            'content-type': 'application/x-www-form-urlencoded',
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            front.close();
            resolve({ status: res.statusCode, text });
          });
        },
      );
      r.on('error', reject);
      r.end('tag=train%2Floss&runs=world');
    });
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.text, '{"runs":["world"]}');
  assert.deepEqual(seen, {
    url: `${TENSORBOARD_PREFIX}/data/plugin/scalars/scalars_multirun`,
    method: 'POST',
    cookie: undefined,
    body: 'tag=train%2Floss&runs=world',
  });
});
