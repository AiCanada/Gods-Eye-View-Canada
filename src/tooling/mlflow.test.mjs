// The AI World tab's MLFLOW sections on the server: the run tracker (queue,
// batches, artifacts), the manager (the MLflow server, jobs, serving,
// telemetry off), the routes, and no removal from the phone
// (server/shared/mlflowTrack.mjs, mlflowJobs.mjs, server/providers/mlflow.js).
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
  MLFLOW_UI_PREFIX,
  cleanModelName,
  cleanPrompt,
  createMlflowManager,
  sampleRequest,
  servedError,
} from '../../server/shared/mlflowJobs.mjs';
import { MlflowError, mlflowKey } from '../../server/shared/mlflowRest.mjs';
import {
  childParams,
  createRunTracker,
  eventMetrics,
  trackChild,
} from '../../server/shared/mlflowTrack.mjs';
import { killTree } from '../../server/shared/processTree.mjs';
import { isRemoval, mlflowProvider } from '../../server/providers/mlflow.js';
import { createTensorflowManager } from '../../server/shared/tensorflowJobs.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-mlflow-'));
const write = (root, rel, text = 'x') => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const noTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 0,
  clearInterval() {},
};

/** A REST client that records what it is sent; `down` makes it unreachable. */
function fakeRest() {
  const calls = [];
  let n = 0;
  const rest = {
    down: false,
    refuse: null,
    calls,
    async experimentId(name) {
      if (rest.down) throw new MlflowError('MLflow did not answer: down');
      calls.push(['experiment', name]);
      return 'e1';
    },
    async createRun({ experimentId, name, tags }) {
      if (rest.down) throw new MlflowError('MLflow did not answer: down');
      calls.push(['create', experimentId, name, tags]);
      n += 1;
      return {
        runId: `r${n}`,
        artifactUri: `mlflow-artifacts:/e1/r${n}/artifacts`,
      };
    },
    async logBatch(runId, batch) {
      if (rest.down) throw new MlflowError('MLflow did not answer: down');
      if (rest.refuse) {
        const reason = rest.refuse;
        rest.refuse = null;
        throw new MlflowError(reason, {
          status: 400,
          code: 'INVALID_PARAMETER_VALUE',
        });
      }
      calls.push(['batch', runId, batch]);
    },
    async uploadArtifact(uri, rel, bytes) {
      calls.push(['artifact', uri, rel, String(bytes)]);
    },
    async updateRun(runId, status) {
      calls.push(['end', runId, status]);
    },
  };
  return rest;
}

test('the small rules: names, prompts, served errors, child params and event metrics', () => {
  assert.equal(cleanModelName(' gev-world_2.v '), 'gev-world_2.v');
  for (const bad of ['', '-x', 'a b', 'x/y', 'é', 'x'.repeat(101)])
    assert.throws(() => cleanModelName(bad), /MODEL NAME/);
  assert.equal(cleanPrompt('  What moved?\u0007 '), 'What moved?');
  assert.throws(() => cleanPrompt('   '), /question/);
  assert.throws(() => cleanPrompt('x'.repeat(2001)), /2000/);
  assert.equal(
    servedError("Failed to predict data '{huge}'. Error: shape mismatch"),
    'shape mismatch',
  );
  assert.equal(servedError('plain'), 'plain');
  assert.equal(mlflowKey('domain/hazards/mae'), 'domain/hazards/mae');
  assert.equal(mlflowKey('a:b?c'), 'a_b_c');
  assert.deepEqual(
    childParams([
      '-3.13',
      '-m',
      'ml.gevtape.train',
      '--data',
      'D',
      '--model',
      'world',
      '--resume',
      '--epochs',
      '3',
    ]),
    { data: 'D', model: 'world', resume: 'true', epochs: '3' },
  );
  assert.deepEqual(
    eventMetrics({ event: 'progress', epoch: 2, step: 40, loss: 0.25 }),
    {
      'train/loss': 0.25,
      'train/epoch': 2,
    },
  );
  assert.deepEqual(
    eventMetrics({
      event: 'metrics',
      skill: { model: 0.1, persistence: 0.2 },
      domains: { hazards: { model: 0.05, persistence: 0.1 }, news: null },
    }),
    {
      'held-out/mae': 0.1,
      'held-out/persistence': 0.2,
      'held-out/skill': 0.5,
      'domain/hazards/mae': 0.05,
      'domain/hazards/persistence': 0.1,
    },
  );
  assert.deepEqual(
    eventMetrics({ event: 'posttrain', before: 0.3, after: 0.2, helped: true }),
    {
      'held-out/loss-before': 0.3,
      'held-out/loss-after': 0.2,
      'held-out/helped': 1,
    },
  );
  assert.equal(
    eventMetrics({ event: 'progress', loss: null }).loss,
    undefined,
    'a blank is no metric',
  );
  const world = sampleRequest({
    tags: {
      'gev.kind': 'world',
      'gev.channels': '["a.x","b.y","c.z"]',
      'gev.context': '12',
      'gev.horizon': '6',
      'gev.nStatic': '4',
    },
  });
  assert.deepEqual(
    [
      world.inputs.v.length,
      world.inputs.v[0].length,
      world.inputs.v[0][0].length,
      world.inputs.v[0][0][0].length,
    ],
    [1, 18, 4, 3],
  );
  assert.equal(world.inputs.s[0][0].length, 4);
  assert.deepEqual(
    sampleRequest({ tags: { 'gev.kind': 'llm' } }).dataframe_split.columns,
    ['prompt'],
  );
  assert.equal(
    isRemoval(
      'DELETE',
      '/api/mlflow/ui/ajax-api/2.0/mlflow/registered-models/alias',
    ),
    true,
  );
  assert.equal(
    isRemoval('POST', '/api/mlflow/ui/ajax-api/2.0/mlflow/runs/delete'),
    true,
  );
  assert.equal(
    isRemoval(
      'POST',
      '/api/mlflow/ui/ajax-api/2.0/mlflow/experiments/delete-tag',
    ),
    true,
  );
  assert.equal(
    isRemoval('POST', '/api/mlflow/ui/ajax-api/2.0/mlflow/runs/log-batch'),
    false,
  );
  assert.equal(isRemoval('GET', '/api/mlflow/ui/'), false);
});

test('a run waits for the server, then goes out in batches with its artifacts, and ends', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rest = fakeRest();
  let up = false;
  let woken = 0;
  const tracker = createRunTracker({
    rest: () => (up ? rest : null),
    wake: () => (woken += 1),
    timers: noTimers,
  });
  const run = tracker.startRun({
    experiment: 'ai-world/world',
    name: 'world 1',
    params: { epochs: '3' },
    tags: { 'gev.model': 'world' },
  });
  for (let step = 1; step <= 1100; step++)
    run.log({ 'train/loss': 1 / step }, step);
  run.tags({ 'gev.device': 'GPU x' });
  run.artifact(write(root, 'metrics.json', '{"skill":1}'), 'metrics.json');
  run.artifact(path.join(root, 'missing.json'), 'manifest.json');
  run.end('FINISHED');
  await tracker.flush();
  assert.ok(woken > 0, 'no server: it asks for one');
  assert.equal(rest.calls.length, 0);
  assert.equal(tracker.status().queued, 1102);
  up = true;
  await tracker.flush();
  const kinds = rest.calls.map((c) => c[0]);
  assert.deepEqual(kinds, [
    'experiment',
    'create',
    'batch',
    'batch',
    'artifact',
    'end',
  ]);
  const [first, second] = rest.calls
    .filter((c) => c[0] === 'batch')
    .map((c) => c[2]);
  assert.equal(first.params.length, 1);
  assert.equal(first.tags.length, 1);
  assert.equal(first.metrics.length, 998, 'at most 1000 entities a batch');
  assert.equal(second.metrics.length, 102);
  assert.equal(rest.calls[1][3]['gev.model'], 'world');
  assert.deepEqual(rest.calls.at(-2).slice(1), [
    'mlflow-artifacts:/e1/r1/artifacts',
    'metrics.json',
    '{"skill":1}',
  ]);
  assert.deepEqual(rest.calls.at(-1), ['end', 'r1', 'FINISHED']);
  const status = tracker.status();
  assert.equal(status.unsent, 0);
  assert.equal(status.logged, 1100);
  assert.equal(status.recent[0].runId, 'r1');
  assert.equal(status.recent[0].last['train/loss'], 1 / 1100);
});

test('the queue keeps its newest points past its cap, survives the server going away, and skips a refused batch', async () => {
  const rest = fakeRest();
  const tracker = createRunTracker({
    rest: () => rest,
    timers: noTimers,
    maxPending: 50,
  });
  rest.down = true;
  const run = tracker.startRun({ experiment: 'x', name: 'x' });
  for (let step = 1; step <= 80; step++) run.log({ loss: step }, step);
  await tracker.flush();
  assert.equal(tracker.status().dropped, 30);
  assert.equal(tracker.status().queued, 50);
  assert.match(tracker.status().error, /did not answer/);
  rest.down = false;
  await tracker.flush();
  const sent = rest.calls
    .filter((c) => c[0] === 'batch')
    .flatMap((c) => c[2].metrics);
  assert.deepEqual(
    [sent[0].step, sent.at(-1).step],
    [31, 80],
    'the newest points were kept',
  );
  rest.refuse = 'Invalid value';
  run.log({ loss: NaN, ok: 1 }, 81);
  await tracker.flush();
  assert.equal(tracker.status().queued, 0, 'a refused batch is not sent again');
  assert.equal(tracker.status().error, null);
  const off = createRunTracker({
    rest: () => rest,
    timers: noTimers,
    enabled: () => false,
  });
  const none = off.startRun({ experiment: 'x' });
  none.log({ loss: 1 });
  assert.equal(off.status().unsent, 0, 'TRACKING OFF keeps nothing');
});

test('a followed child: progress, held-out scores, a pause and its files', () => {
  const logs = [];
  const tags = [];
  const ends = [];
  const artifacts = [];
  const tracker = {
    startRun: (spec) => {
      logs.push(['start', spec]);
      return {
        log: (m, step) => logs.push([step, m]),
        tags: (v) => tags.push(v),
        artifact: (f, r) => artifacts.push(r),
        end: (s) => ends.push(s),
      };
    },
  };
  const t = trackChild(tracker, {
    experiment: 'ai-world/world',
    name: 'w',
    args: ['-m', 'ml.gevtape.train', '--epochs', '2'],
    tags: { 'gev.model': 'world' },
  });
  assert.deepEqual(logs[0][1].params, { epochs: '2' });
  t.event({ event: 'progress', epoch: 0, epochs: 2, device: 'GPU x' });
  t.event({ event: 'progress', epoch: 1, step: 10, loss: 0.4 });
  t.event({ event: 'metrics', skill: { model: 0.1, persistence: 0.2 } });
  t.event({ event: 'paused' });
  t.exit({ code: 0, files: [['/m/metrics.json', 'metrics.json']] });
  assert.deepEqual(logs.slice(1), [
    [0, { 'train/epoch': 0 }],
    [10, { 'train/loss': 0.4, 'train/epoch': 1 }],
    [
      10,
      {
        'held-out/mae': 0.1,
        'held-out/persistence': 0.2,
        'held-out/skill': 0.5,
      },
    ],
  ]);
  assert.deepEqual(tags, [
    { 'gev.device': 'GPU x' },
    { 'gev.ended': 'paused' },
  ]);
  assert.deepEqual(artifacts, ['metrics.json']);
  assert.deepEqual(ends, ['KILLED']);
  const failed = [];
  const f = trackChild(
    {
      startRun: () => ({
        log() {},
        tags() {},
        artifact() {},
        end: (s) => failed.push(s),
      }),
    },
    { experiment: 'x', name: 'x' },
  );
  f.event({ event: 'error', message: 'no bins' });
  f.exit({ code: 1 });
  assert.deepEqual(failed, ['FAILED']);
});

test('the TensorFlow jobs are tracked as MLflow runs', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const started = [];
  const tracker = {
    startRun: (spec) => {
      const run = { spec, logs: [], ended: null };
      started.push(run);
      return {
        log: (m) => run.logs.push(m),
        tags() {},
        artifact() {},
        end: (s) => (run.ended = s),
      };
    },
  };
  const children = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.stdin = { write() {} };
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    child.args = args;
    children.push(child);
    const module = args[args.indexOf('-m') + 1];
    setImmediate(() => {
      if (module === 'ml.gevtape.tf_probe') {
        child.stdout.emit(
          'data',
          `${JSON.stringify({ event: 'probe', tensorflow: '2.21.0', gpus: [] })}\n`,
        );
        child.emit('exit', 0, null);
      }
    });
    return child;
  };
  const manager = createTensorflowManager({
    root,
    dataRoot: path.join(root, 'd'),
    env: {},
    platform: 'linux',
    python: ['python3'],
    spawnImpl,
    tracker,
  });
  t.after(() => manager.close());
  manager.status();
  await settle();
  manager.train();
  await manager.started;
  const job = children.find((c) => c.args.includes('ml.gevtape.tf_train'));
  job.stdout.emit(
    'data',
    `${JSON.stringify({ event: 'progress', epoch: 1, epochs: 1, step: 5, loss: 0.3 })}\n`,
  );
  job.stdout.emit('data', `${JSON.stringify({ event: 'done' })}\n`);
  job.emit('exit', 0, null);
  await settle();
  assert.equal(started.length, 1);
  assert.equal(started[0].spec.experiment, 'ai-world/tensorflow-train');
  assert.equal(started[0].spec.tags['gev.framework'], 'tensorflow');
  assert.equal(started[0].spec.params.epochs, '10');
  assert.deepEqual(started[0].logs, [{ 'train/loss': 0.3, 'train/epoch': 1 }]);
  assert.equal(started[0].ended, 'FINISHED');
});

/** MLflow processes that answer as the real ones do. */
function fakeMlflow({ installed = true } = {}) {
  const children = [];
  const killed = [];
  const spawnImpl = (command, args, options = {}) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.stdin = { write() {} };
    child.command = command;
    child.args = args;
    child.env = options.env;
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    children.push(child);
    const module = args[args.indexOf('-m') + 1];
    setImmediate(() => {
      if (module === 'ml.gevtape.mlflow_probe') {
        child.stdout.emit(
          'data',
          `${JSON.stringify({ event: 'probe', python: '3.13.1', mlflow: installed ? '3.17.1' : null })}\n`,
        );
        child.emit('exit', 0, null);
      }
    });
    return child;
  };
  const serverUp = () =>
    children.some((c) => c.args.includes('server') && !c.gone);
  const registry = { models: [] };
  const posted = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const reply = (status, body) => ({
      ok: status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (u.pathname.endsWith('/health'))
      return reply(serverUp() ? 200 : 503, {});
    if (u.pathname === '/ping') return reply(200, {});
    if (u.pathname === '/invocations') {
      posted.push(JSON.parse(init.body));
      return reply(200, { predictions: [[[[0, 0, 0]]]] });
    }
    if (u.pathname.endsWith('/registered-models/search'))
      return reply(200, { registered_models: registry.models });
    if (u.pathname.endsWith('/model-versions/search'))
      return reply(200, {
        model_versions: [
          {
            version: '1',
            tags: [
              { key: 'gev.kind', value: 'world' },
              { key: 'gev.channels', value: '["a"]' },
            ],
          },
        ],
      });
    if (u.pathname.endsWith('/registered-models/alias')) {
      posted.push(['alias', JSON.parse(init.body)]);
      return reply(200, {});
    }
    return reply(404, { message: 'no' });
  };
  const kill = (child) => {
    killed.push(
      child.args.includes('server')
        ? 'server'
        : child.args.includes('serve')
          ? 'serve'
          : 'job',
    );
    child.gone = true;
    child.emit('exit', null, 'SIGTERM');
  };
  return { children, spawnImpl, fetchImpl, registry, posted, killed, kill };
}

function setup(t, options = {}) {
  const root = tmp();
  const dataRoot = path.join(root, '.gev-data');
  const fake = fakeMlflow(options);
  const manager = createMlflowManager({
    root,
    dataRoot,
    env: { KEEP: 'me' },
    platform: 'win32',
    python: ['py', '-3.13'],
    spawnImpl: fake.spawnImpl,
    fetchImpl: fake.fetchImpl,
    timers: noTimers,
    killTree: fake.kill,
  });
  t.after(() => {
    manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const of = (module) =>
    fake.children.filter((c) => c.args[c.args.indexOf('-m') + 1] === module);
  return { root, dataRoot, manager, ...fake, of };
}

test('the MLflow server: the local store, its prefix, telemetry off; STOP holds it until START', async (t) => {
  const { dataRoot, manager, of, killed } = setup(t);
  assert.equal(of('mlflow').length, 0, 'nothing runs until asked');
  manager.status();
  await settle();
  assert.equal(manager.status().installed.mlflow, '3.17.1');
  manager.startServer();
  await manager.serverStarted;
  const [server] = of('mlflow');
  const arg = (name) => server.args[server.args.indexOf(name) + 1];
  assert.equal(server.command, 'py');
  assert.deepEqual(server.args.slice(0, 4), [
    '-3.13',
    '-m',
    'mlflow',
    'server',
  ]);
  assert.equal(
    arg('--backend-store-uri'),
    `sqlite:///${path.join(dataRoot, 'mlflow', 'mlflow.db').replace(/\\/g, '/')}`,
  );
  assert.equal(
    arg('--artifacts-destination'),
    path.join(dataRoot, 'mlflow', 'artifacts'),
  );
  assert.equal(arg('--host'), '127.0.0.1');
  assert.equal(arg('--static-prefix'), MLFLOW_UI_PREFIX);
  assert.ok(server.args.includes('--serve-artifacts'));
  assert.equal(server.env.MLFLOW_DISABLE_TELEMETRY, 'true');
  assert.equal(server.env.DO_NOT_TRACK, 'true');
  assert.equal(server.env.KEEP, 'me');
  assert.equal(manager.status().server.state, 'running');
  assert.deepEqual(manager.uiTarget(), { host: '127.0.0.1', port: 5000 });
  manager.stopServer();
  assert.deepEqual(killed, ['server'], 'the whole tree');
  assert.equal(manager.status().server.state, 'off');
  assert.equal(manager.status().server.held, true);
  const run = manager.tracker.startRun({ experiment: 'x', name: 'x' });
  run.end('FINISHED');
  await settle();
  assert.equal(
    of('mlflow').length,
    1,
    'tracking does not start a server the owner stopped',
  );
  manager.startServer();
  await manager.serverStarted;
  assert.equal(of('mlflow').length, 2);
});

test('without MLflow the sections say how to install it and nothing starts', async (t) => {
  const { manager, of } = setup(t, { installed: false });
  manager.status();
  await settle();
  manager.startServer();
  await manager.serverStarted;
  assert.equal(of('mlflow').length, 0);
  assert.match(manager.status().server.error, /pip install mlflow/);
});

test('register, alias, evaluate, ask and serve: their arguments, one job at a time, the served test', async (t) => {
  const { dataRoot, manager, of, registry, posted, killed } = setup(t);
  write(dataRoot, 'ai-world/models/world/checkpoint.pt');
  write(dataRoot, 'llm/my-llm/model/adapter.json', '{}');
  manager.status();
  await settle();
  assert.deepEqual(
    manager.status().sources.map((s) => `${s.id}:${s.kind}:${s.defaultName}`),
    ['world:world:gev-world', 'llm:my-llm:llm:gev-llm-my-llm'],
  );
  assert.throws(
    () => manager.register({ source: 'nope' }),
    /Choose a trained model/,
  );
  assert.throws(
    () => manager.register({ source: 'world', alias: 'best' }),
    /champion or challenger/,
  );
  manager.register({ source: 'world', alias: 'champion' });
  assert.throws(() => manager.evaluate(), /running already/);
  await manager.started;
  const [job] = of('ml.gevtape.mlflow_register');
  const arg = (c, name) => c.args[c.args.indexOf(name) + 1];
  assert.equal(
    arg(job, '--tracking-uri'),
    `http://127.0.0.1:5000${MLFLOW_UI_PREFIX}`,
  );
  assert.equal(arg(job, '--kind'), 'world');
  assert.equal(
    arg(job, '--source'),
    path.join(dataRoot, 'ai-world', 'models', 'world'),
  );
  assert.equal(arg(job, '--name'), 'gev-world');
  assert.equal(arg(job, '--alias'), 'champion');
  assert.equal(job.env.MLFLOW_DISABLE_TELEMETRY, 'true');
  job.stdout.emit(
    'data',
    `${JSON.stringify({ event: 'registered', name: 'gev-world', version: '1', alias: 'champion', kind: 'world' })}\n`,
  );
  registry.models = [
    {
      name: 'gev-world',
      tags: [{ key: 'gev.kind', value: 'world' }],
      aliases: [{ alias: 'champion', version: '1' }],
    },
  ];
  job.emit('exit', 0, null);
  await settle();
  assert.equal(manager.status().run.state, 'done');
  assert.equal(manager.status().last.register.version, '1');
  assert.deepEqual(
    manager
      .status()
      .registry.models.map((m) => [
        m.name,
        m.kind,
        m.aliases.champion,
        m.versions[0].version,
      ]),
    [['gev-world', 'world', '1', '1']],
  );
  await manager.setAlias({
    name: 'gev-world',
    version: '1',
    alias: 'challenger',
  });
  assert.deepEqual(posted.at(-1), [
    'alias',
    { name: 'gev-world', alias: 'challenger', version: '1' },
  ]);
  manager.evaluate();
  await manager.started;
  const [evaluate] = of('ml.gevtape.mlflow_evaluate');
  evaluate.stdout.emit(
    'data',
    `${JSON.stringify({ event: 'evaluation', rows: [{ name: 'gev-world', version: '1', mae: 0.1, persistence: 0.2 }], best: { name: 'gev-world', version: '1' } })}\n`,
  );
  evaluate.emit('exit', 0, null);
  await settle();
  assert.equal(manager.status().last.evaluate.best.name, 'gev-world');
  assert.throws(
    () => manager.ask({ model: 'nope', prompt: 'x' }),
    /custom LLM/,
  );
  manager.ask({ model: 'my-llm', prompt: ' What moved? ' });
  await manager.started;
  const [ask] = of('ml.gevtape.llm_chat');
  assert.equal(arg(ask, '--prompt'), 'What moved?');
  assert.ok(ask.args.includes('--trace') && ask.args.includes('--json'));
  ask.stdout.emit(
    'data',
    `${JSON.stringify({ event: 'answer', answer: 'Shipping.', traceId: 'tr-1', experimentId: '7' })}\n`,
  );
  ask.emit('exit', 0, null);
  await settle();
  assert.deepEqual(
    [manager.status().last.ask.answer, manager.status().last.ask.traceId],
    ['Shipping.', 'tr-1'],
  );
  manager.startServing({ name: 'gev-world', version: '1' });
  await manager.servingStarted;
  const serve = of('mlflow').find((c) => c.args.includes('serve'));
  assert.deepEqual(
    serve.args.slice(serve.args.indexOf('-m'), serve.args.indexOf('-m') + 6),
    ['-m', 'mlflow', 'models', 'serve', '-m', 'models:/gev-world/1'],
  );
  assert.equal(
    serve.env.MLFLOW_TRACKING_URI,
    `http://127.0.0.1:5000${MLFLOW_UI_PREFIX}`,
  );
  assert.equal(serve.env.MLFLOW_EXPERIMENT_NAME, 'ai-world/llm-traces');
  assert.equal(manager.status().serving.state, 'running');
  await manager.testServing();
  assert.deepEqual(manager.status().serving.test.shape, [1, 1, 1, 3]);
  assert.ok(
    posted.some((p) => p.inputs?.v),
    'the test sends the model its own shape',
  );
  manager.stopServing();
  assert.ok(killed.includes('serve'));
  assert.equal(manager.status().serving.state, 'off');
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

const TOKEN = '9'.repeat(64);
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

test('the routes: the PC and the phone run everything; inside MLflow the phone cannot delete', async (t) => {
  setOwnerDeviceToken(TOKEN);
  t.after(() => setOwnerDeviceToken(''));
  const calls = [];
  let up = false;
  const fake = {
    tracker: {
      startRun: () => ({ log() {}, tags() {}, artifact() {}, end() {} }),
    },
    status: () => ({ ok: true }),
    register: (b) => (calls.push(['register', b]), {}),
    setAlias: async (b) => (calls.push(['alias', b]), {}),
    evaluate: () => (calls.push(['evaluate']), {}),
    ask: (b) => (calls.push(['ask', b]), {}),
    startServer: () => (calls.push(['server-start']), {}),
    uiTarget: () => (up ? { host: '127.0.0.1', port: 1 } : null),
    serveTarget: () => null,
    close() {},
  };
  const plugin = mlflowProvider({
    root: tmp(),
    env: {},
    log: () => {},
    createManager: () => fake,
  });
  const request = install(plugin);
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
      await request('/register', {
        method: 'POST',
        headers: owner,
        remoteAddress: '100.64.0.10',
        body: { source: 'world' },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/alias', {
        method: 'POST',
        headers: pc,
        body: { name: 'gev-world', version: '1', alias: 'champion' },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/evaluate', {
        method: 'POST',
        headers: owner,
        remoteAddress: '100.64.0.10',
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/ask', {
        method: 'POST',
        headers: pc,
        body: { model: 'm', prompt: 'p' },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/server-start', { method: 'POST', headers: pc, body: {} }))
      .status,
    200,
  );
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['register', 'alias', 'evaluate', 'ask', 'server-start'],
  );
  const down = await request('/ui/', { headers: pc });
  assert.equal(down.status, 503);
  assert.match(JSON.parse(down.body).error, /START MLFLOW/);
  up = true;
  const refused = await request('/ui/ajax-api/2.0/mlflow/runs/delete', {
    method: 'POST',
    headers: owner,
    remoteAddress: '100.64.0.10',
    body: {},
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers[OWNER_DEVICE_REMOVAL_HEADER], 'pc-only');
  const refusedDelete = await request(
    '/ui/ajax-api/2.0/mlflow/registered-models/alias',
    { method: 'DELETE', headers: owner, remoteAddress: '100.64.0.10' },
  );
  assert.equal(refusedDelete.status, 403);
  assert.equal(
    (
      await request('/serve/invocations', {
        method: 'POST',
        headers: pc,
        body: {},
      })
    ).status,
    503,
  );
  assert.equal(typeof plugin.tracker.startRun, 'function');
});

test('killTree ends the whole tree on Windows and the group elsewhere', () => {
  const ran = [];
  let killed = 0;
  killTree(
    { pid: 42, kill: () => (killed += 1) },
    { platform: 'win32', run: (...a) => ran.push(a) },
  );
  assert.deepEqual(ran[0].slice(0, 2), [
    'taskkill',
    ['/PID', '42', '/T', '/F'],
  ]);
  const groups = [];
  killTree(
    { pid: 43, kill: () => (killed += 1) },
    { platform: 'linux', signalGroup: (pid) => groups.push(pid) },
  );
  assert.deepEqual(groups, [43]);
  killTree(
    { kill: () => (killed += 1) },
    { platform: 'win32', run: () => assert.fail('no pid, no taskkill') },
  );
  assert.equal(killed, 3);
});
