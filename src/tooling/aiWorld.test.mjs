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
  deleteListed,
  deletePreview,
  listForDelete,
} from '../../server/shared/aiWorldDelete.mjs';
import {
  cleanPostTrain,
  createAiWorldManager,
  createChild,
  defaultPython,
  newestCompleteTapeDay,
  unbinnedTapeDays,
} from '../../server/shared/aiWorldJobs.mjs';
import { matchInfer } from '../../server/shared/aiWorldInfer.mjs';
import { aiWorldProvider } from '../../server/providers/aiWorld.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-ai-world-'));
const write = (root, rel, text = 'x') => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

/** A fake feed that records one record a poll. */
const pingFeed = {
  id: 'pings',
  label: 'Pings',
  layers: [],
  kind: 'feed',
  class: 'open',
  licence: 'test',
  cadenceMs: 20,
  phase: 1,
  bytesPerDay: 1e6,
  async poll() {
    return { records: [{ ping: 1 }] };
  },
};

/** A child process that speaks the trainer protocol. */
function fakeSpawn(events) {
  const children = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = {
      write(line) {
        const message = JSON.parse(line);
        child.received.push(message);
        if (message.cmd === 'pause' || message.cmd === 'stop')
          setImmediate(() => {
            child.stdout.emit(
              'data',
              `${JSON.stringify({ event: message.cmd === 'pause' ? 'paused' : 'done' })}\n`,
            );
            child.emit('exit', 0, null);
          });
      },
    };
    child.received = [];
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    child.command = command;
    child.args = args;
    children.push(child);
    setImmediate(() => {
      for (const event of events)
        child.stdout.emit('data', `${JSON.stringify(event)}\n`);
    });
    return child;
  };
  return { spawnImpl, children };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('delete: the preview lists groups, files and bytes; the delete removes exactly them and nothing else', () => {
  const root = tmp();
  try {
    const data = path.join(root, '.gev-data');
    write(data, 'tape/flights/2026/10/13/18.ndjson.gz', 'aaaa');
    write(data, 'tape/transit/2026/10/13/18.ndjson.gz', 'bb');
    write(data, 'outbreak/datasets/d1/index.jsonl', 'ccc');
    write(data, 'ai-world/models/world/checkpoint.pt', 'dddd');
    write(data, 'ai-world/state.json', '{}');
    const outside = write(root, 'keep.txt', 'not mine');
    const preview = deletePreview(data, 'all');
    assert.deepEqual(
      preview.groups
        .map((g) => `${g.kind}:${g.id}:${g.files}:${g.bytes}`)
        .sort(),
      [
        'datasets:d1:1:3',
        'models:world:1:4',
        'tape:flights:1:4',
        'tape:transit:1:2',
      ],
    );
    assert.equal(preview.totalFiles, 4);
    assert.equal(preview.totalBytes, 13);
    assert.equal(preview.files, undefined, 'the preview carries no file list');
    // Only the tape.
    const tape = listForDelete(data, 'tape');
    assert.equal(tape.groups.length, 2);
    // A stale token is refused and nothing goes.
    assert.throws(
      () => deleteListed(data, 'all', 'nope'),
      (e) => e.status === 409,
    );
    write(data, 'tape/flights/2026/10/13/19.ndjson.gz', 'new');
    assert.throws(
      () => deleteListed(data, 'all', preview.token),
      (e) => e.status === 409,
    );
    // Preview again, then delete exactly that.
    const fresh = deletePreview(data, 'all');
    const done = deleteListed(data, 'all', fresh.token);
    assert.equal(done.files, 5);
    assert.equal(
      fs.existsSync(path.join(data, 'tape')),
      false,
      'empty folders go',
    );
    assert.ok(
      fs.existsSync(path.join(data, 'ai-world', 'state.json')),
      'the job state stays',
    );
    assert.ok(fs.existsSync(outside), 'nothing outside .gev-data');
    assert.throws(() => listForDelete(data, 'everything'), /Unknown scope/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the manager: initialize records the ticked feeds, pause and continue, stop, and delete only when stopped', async () => {
  const root = tmp();
  try {
    const { spawnImpl } = fakeSpawn([]);
    const manager = createAiWorldManager({
      root,
      feeds: new Map([['pings', pingFeed]]),
      spawnImpl,
      gpu: () => 'Test GPU',
      python: ['python'],
    });
    assert.equal(manager.status().state, 'idle');
    assert.ok(manager.catalog().items.some((i) => i.id === 'pings'));
    const estimate = manager.estimate({ selection: ['pings'], capGb: 10 });
    assert.equal(estimate.bytesPerDay, 1e6);
    assert.equal(estimate.gpu, 'Test GPU');
    assert.ok(estimate.daysToCap > 9000);
    manager.initialize({ selection: ['pings', 'flights'], capGb: 10 });
    assert.equal(manager.status().state, 'running');
    assert.throws(
      () => manager.initialize({}),
      (e) => e.status === 409,
    );
    await wait(120);
    const ping = manager.status().feeds.find((f) => f.id === 'pings');
    assert.equal(ping.state, 'recording');
    assert.ok(ping.records >= 1);
    assert.throws(
      () => manager.deleteListed('all', 'x'),
      (e) => e.status === 409,
    );
    manager.pause();
    assert.equal(manager.status().state, 'paused');
    assert.equal(
      manager.status().feeds.find((f) => f.id === 'pings').state,
      'paused',
    );
    manager.continue();
    assert.equal(manager.status().state, 'running');
    manager.stop();
    assert.equal(manager.status().state, 'stopped');
    assert.ok(manager.status().gaps.length >= 1, 'the pause is a gap');
    const preview = manager.deletePreview('tape');
    assert.ok(preview.groups.some((g) => g.id === 'pings'));
    assert.ok(
      preview.groups.some((g) => g.id === 'gaps.jsonl'),
      'the gaps are tape too',
    );
    assert.equal(
      manager.deleteListed('tape', preview.token).deleted.files,
      preview.totalFiles,
    );
    const state = JSON.parse(
      fs.readFileSync(
        path.join(root, '.gev-data', 'ai-world', 'state.json'),
        'utf8',
      ),
    );
    assert.equal(state.state, 'stopped');
    assert.deepEqual(state.selection, ['pings', 'flights']);
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the manager restores a running job after a restart and writes the downtime as a gap', async () => {
  const root = tmp();
  try {
    const file = write(
      root,
      '.gev-data/ai-world/state.json',
      JSON.stringify({
        state: 'running',
        since: 1,
        selection: ['pings'],
        lastSeenAt: Date.now() - 60_000,
      }),
    );
    const manager = createAiWorldManager({
      root,
      feeds: new Map([['pings', pingFeed]]),
      spawnImpl: fakeSpawn([]).spawnImpl,
      gpu: () => null,
    });
    assert.equal(manager.restore(), 'running');
    assert.equal(manager.status().state, 'running');
    const gap = manager.status().gaps.at(-1);
    assert.equal(gap.reason, 'restart');
    assert.ok(gap.to - gap.from >= 60_000);
    manager.close();
    assert.ok(fs.existsSync(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the child-process protocol: events in, commands out, pause by checkpoint', async () => {
  const { spawnImpl, children } = fakeSpawn([
    { event: 'progress', epoch: 1, epochs: 3, loss: 0.5 },
  ]);
  const events = [];
  let exit = null;
  const child = createChild({
    command: 'python',
    args: ['-m', 'ml.gevtape.train'],
    spawnImpl,
    onEvent: (e) => events.push(e),
    onExit: (e) => {
      exit = e;
    },
  });
  await wait(10);
  assert.deepEqual(events[0], {
    event: 'progress',
    epoch: 1,
    epochs: 3,
    loss: 0.5,
  });
  child.send({ cmd: 'pause' });
  await wait(10);
  assert.deepEqual(children[0].received, [{ cmd: 'pause' }]);
  assert.equal(events.at(-1).event, 'paused');
  assert.equal(exit.code, 0);
  assert.deepEqual(defaultPython({}, 'win32'), ['py', '-3.13']);
  assert.deepEqual(defaultPython({ GEV_PYTHON: 'python3 -X utf8' }, 'linux'), [
    'python3',
    '-X',
    'utf8',
  ]);
});

/** The provider's middleware with a fake server. */
function install(plugin) {
  let handler;
  plugin.configureServer({
    httpServer: null,
    config: { server: { port: 4173 } },
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

test('the routes: status for this machine, refused cross-site; the owner phone runs everything but DELETE', async (t) => {
  const root = tmp();
  setOwnerDeviceToken(TOKEN);
  t.after(() => {
    setOwnerDeviceToken('');
    fs.rmSync(root, { recursive: true, force: true });
  });
  write(root, '.gev-data/tape/pings/2026/10/13/18.ndjson.gz', 'abc');
  let manager;
  const request = install(
    aiWorldProvider({
      root,
      env: {},
      log: () => {},
      createManager: (options) =>
        (manager = createAiWorldManager({
          ...options,
          feeds: new Map([['pings', pingFeed]]),
          spawnImpl: fakeSpawn([]).spawnImpl,
          gpu: () => null,
        })),
    }),
  );
  const status = await request('/status', { headers: pc });
  assert.equal(status.status, 200, status.body);
  assert.equal(JSON.parse(status.body).state, 'idle');
  const crossSite = await request('/status', {
    headers: { ...pc, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  const lan = await request('/status', {
    headers: { ...pc, host: '192.168.1.5:4173' },
    remoteAddress: '192.168.1.9',
  });
  assert.equal(lan.status, 403);
  const preview = JSON.parse(
    (
      await request('/delete-preview?scope=tape', {
        headers: owner,
        remoteAddress: '100.64.0.10',
      })
    ).body,
  );
  assert.equal(preview.totalFiles, 1, 'the phone may see the preview');
  const refused = await request('/delete', {
    method: 'DELETE',
    headers: owner,
    remoteAddress: '100.64.0.10',
    body: { scope: 'tape', token: preview.token },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers[OWNER_DEVICE_REMOVAL_HEADER], 'pc-only');
  assert.equal(refused.body, '{"removal":"pc-only"}');
  assert.ok(
    fs.existsSync(path.join(root, '.gev-data', 'tape', 'pings')),
    'nothing was deleted',
  );
  const started = await request('/initialize', {
    method: 'POST',
    headers: owner,
    remoteAddress: '100.64.0.10',
    body: { selection: ['pings'], capGb: 5 },
  });
  assert.equal(started.status, 200, started.body);
  assert.equal(JSON.parse(started.body).state, 'running');
  const again = await request('/initialize', {
    method: 'POST',
    headers: pc,
    body: {},
  });
  assert.equal(again.status, 409);
  assert.equal(
    (await request('/stop', { method: 'POST', headers: pc, body: {} })).status,
    200,
  );
  const pcDelete = await request('/delete', {
    method: 'DELETE',
    headers: pc,
    body: {
      scope: 'tape',
      token: deletePreview(path.join(root, '.gev-data'), 'tape').token,
    },
  });
  assert.equal(pcDelete.status, 200, pcDelete.body);
  assert.ok(JSON.parse(pcDelete.body).deleted.files >= 1);
  const bad = await request('/predict?domain=nowhere', { headers: pc });
  assert.equal(bad.status, 400);
  const learning = JSON.parse(
    (await request('/predict?domain=weather&horizon=12', { headers: pc })).body,
  );
  assert.equal(learning.horizonHours, 12);
  assert.ok(learning.learning, 'no model yet: learning, never invented output');
  manager.close();
});

test('areas: the tab adds and removes them, the feeds get them, the phone cannot remove one', async (t) => {
  const root = tmp();
  setOwnerDeviceToken(TOKEN);
  t.after(() => {
    setOwnerDeviceToken('');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const seen = [];
  const areaFeed = {
    ...pingFeed,
    id: 'around',
    async poll({ areas }) {
      seen.push(areas);
      return { records: [] };
    },
  };
  let manager;
  const request = install(
    aiWorldProvider({
      root,
      env: {},
      log: () => {},
      createManager: (options) =>
        (manager = createAiWorldManager({
          ...options,
          feeds: new Map([['around', areaFeed]]),
          spawnImpl: fakeSpawn([]).spawnImpl,
          gpu: () => null,
        })),
    }),
  );
  const added = await request('/areas', {
    method: 'POST',
    headers: owner,
    remoteAddress: '100.64.0.10',
    body: { lat: 43.65321, lon: -79.38318, name: '  Toronto\u0007 ' },
  });
  assert.equal(added.status, 200, 'the phone may add an area');
  assert.deepEqual(JSON.parse(added.body).areas, [
    { key: '43.6532,-79.3832', name: 'Toronto', lat: 43.65321, lon: -79.38318 },
  ]);
  // The same point again changes nothing; a point that is not one is refused.
  await request('/areas', {
    method: 'POST',
    headers: pc,
    body: { lat: 43.65321, lon: -79.38318 },
  });
  const bad = await request('/areas', {
    method: 'POST',
    headers: pc,
    body: { lat: 95, lon: 0 },
  });
  assert.equal(bad.status, 400);
  const second = JSON.parse(
    (
      await request('/areas', {
        method: 'POST',
        headers: pc,
        body: { lat: 51.5, lon: -0.12 },
      })
    ).body,
  );
  assert.equal(second.areas.length, 2);
  assert.equal(second.areas[1].name, '51.500, -0.120', 'no name: the point');
  assert.deepEqual(
    JSON.parse((await request('/status', { headers: pc })).body).areas,
    second.areas,
    'the status carries the list',
  );

  // The feeds poll with them.
  manager.initialize({ selection: ['around'] });
  await wait(60);
  assert.deepEqual(
    seen.at(-1).map((a) => a.key),
    ['43.6532,-79.3832', '51.5000,-0.1200'],
  );

  // Removing is the PC's alone (owner ruling 2026-10-11).
  const refused = await request('/areas', {
    method: 'DELETE',
    headers: owner,
    remoteAddress: '100.64.0.10',
    body: { key: '43.6532,-79.3832' },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers[OWNER_DEVICE_REMOVAL_HEADER], 'pc-only');
  assert.equal(manager.areas().areas.length, 2, 'the list stays as it was');
  const removed = await request('/areas', {
    method: 'DELETE',
    headers: pc,
    body: { key: '43.6532,-79.3832' },
  });
  assert.equal(removed.status, 200, removed.body);
  assert.deepEqual(
    JSON.parse(removed.body).areas.map((a) => a.key),
    ['51.5000,-0.1200'],
  );
  const file = JSON.parse(
    fs.readFileSync(
      path.join(root, '.gev-data', 'ai-world', 'areas.json'),
      'utf8',
    ),
  );
  assert.equal(file.length, 1, 'kept across restarts');
  manager.close();
});

test('YOUR DEVICES records every personal feed', async () => {
  const root = tmp();
  try {
    const polled = new Set();
    const feed = (id, cls) => ({
      ...pingFeed,
      id,
      class: cls,
      bytesPerDay: 10,
      async poll() {
        polled.add(id);
        return { records: [{ id }] };
      },
    });
    const manager = createAiWorldManager({
      root,
      feeds: new Map(
        [
          feed('device-feeds', 'personal'),
          feed('private-cctv', 'personal'),
          feed('pings', 'open'),
        ].map((f) => [f.id, f]),
      ),
      spawnImpl: fakeSpawn([]).spawnImpl,
      gpu: () => null,
    });
    assert.deepEqual(
      manager
        .estimate({ selection: ['devices'] })
        .feeds.map((f) => f.id)
        .sort(),
      ['device-feeds', 'private-cctv'],
    );
    manager.initialize({ selection: ['devices'] });
    await wait(80);
    assert.deepEqual([...polled].sort(), ['device-feeds', 'private-cctv']);
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the YOUR DEVICES row shows its personal feeds together', async () => {
  const root = tmp();
  try {
    const feed = (id, cls, poll) => ({ ...pingFeed, id, class: cls, poll });
    const manager = createAiWorldManager({
      root,
      feeds: new Map(
        [
          feed('device-feeds', 'personal', async () => ({
            records: [{ fix: 1 }],
          })),
          feed('local-adsb', 'personal', async () => {
            throw new Error('LOCAL_RECEIVER_FEEDS is not set');
          }),
          feed('pings', 'open', async () => ({ records: [{ ping: 1 }] })),
        ].map((f) => [f.id, f]),
      ),
      spawnImpl: fakeSpawn([]).spawnImpl,
      gpu: () => null,
    });
    const devices = () =>
      manager.status().feeds.find((f) => f.id === 'devices');
    assert.equal(devices().state, 'off');
    manager.initialize({ selection: ['devices'] });
    await wait(80);
    const row = devices();
    assert.equal(row.state, 'recording', 'one of them records');
    assert.ok(row.records >= 1);
    assert.ok(row.lastAt > 0);
    assert.equal(row.error, 'LOCAL_RECEIVER_FEEDS is not set');
    assert.equal(
      manager.status().stages.recorder.feeds,
      1,
      'the row is not counted twice',
    );
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the outbreak model is calibrated on real epidemics once both exist', async () => {
  const root = tmp();
  try {
    const data = path.join(root, '.gev-data');
    const { spawnImpl, children } = fakeSpawn([]);
    const manager = createAiWorldManager({
      root,
      feeds: new Map([['pings', pingFeed]]),
      spawnImpl,
      gpu: () => null,
      python: ['py', '-3.13'],
    });
    manager.initialize({ selection: ['pings'] });
    assert.equal(children.length, 0, 'no outbreak model, no real data');
    manager.stop();
    write(data, 'ai-world/models/outbreak/checkpoint.pt', 'base');
    write(data, 'real/owid-oxcgrt/obs.npy', 'real');
    manager.initialize({ selection: ['pings'] });
    // The predictor starts too: there is an outbreak model to serve.
    assert.deepEqual(
      children.map((c) => c.args[2]),
      ['ml.gevtape.calibrate', 'ml.gevtape.serve'],
    );
    const [child] = children;
    assert.equal(child.command, 'py');
    assert.deepEqual(child.args, [
      '-3.13',
      '-m',
      'ml.gevtape.calibrate',
      '--data',
      data,
      '--model-dir',
      path.join(data, 'ai-world', 'models', 'outbreak'),
      '--out',
      path.join(data, 'ai-world', 'models', 'outbreak-real'),
    ]);
    assert.equal(manager.status().stages.trainer.model, 'outbreak-real');
    assert.deepEqual(
      manager.status().stages.predictor.domains,
      ['outbreak'],
      'calibration draws nothing of its own',
    );
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the measured LINKS report reaches the status, its top rows only, and is read again when it changes', () => {
  const root = tmp();
  try {
    const data = path.join(root, '.gev-data');
    const manager = createAiWorldManager({
      root,
      feeds: new Map([['pings', pingFeed]]),
      spawnImpl: fakeSpawn([]).spawnImpl,
      gpu: () => null,
    });
    assert.equal(manager.status().links, null, 'no report yet');
    const row = (i) => ({
      channel: 'hazards.quakes',
      asset: 'crude',
      lagHours: i,
      r: 0.3,
      n: 100,
      q: 0.01,
      rTest: 0.25,
      nTest: 40,
      holds: true,
    });
    write(
      data,
      'ai-world/models/links/links.json',
      JSON.stringify({
        generatedAt: 5,
        hours: 480,
        tested: 30,
        results: Array.from({ length: 30 }, (_, i) => row(i)),
        studyPairs: [{ id: 'farmland', best: row(3) }],
      }),
    );
    const links = manager.status().links;
    assert.equal(links.hours, 480);
    assert.equal(links.top.length, 12);
    assert.equal(links.studyPairs[0].best.lagHours, 3);
    const file = path.join(data, 'ai-world/models/links/links.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        hours: 20,
        reason: 'fewer than 48 paired hours for every pair',
      }),
    );
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(
      manager.status().links.reason,
      'fewer than 48 paired hours for every pair',
    );
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POST-TRAIN: an adapter from the adapter folders and a checkpoint inside .gev-data, queued with the rest', () => {
  const root = tmp();
  try {
    const data = path.join(root, '.gev-data');
    write(root, 'ml/adapters/kit_world.py', '# adapter');
    const model = write(data, 'mine/world.pt', 'weights');
    const refused = (raw, pattern) =>
      assert.throws(
        () => cleanPostTrain(raw, { root, dataRoot: data }),
        (error) => error.status === 400 && pattern.test(error.message),
      );
    refused({ adapter: 'os:system', checkpoint: model }, /No os\.py/);
    refused({ adapter: '../x:Y', checkpoint: model }, /module:Class/);
    refused(
      { adapter: 'kit_world:KitWorldAdapter', checkpoint: '../../etc/passwd' },
      /inside \.gev-data/,
    );
    refused(
      { adapter: 'kit_world:KitWorldAdapter', checkpoint: 'mine/none.pt' },
      /No model/,
    );
    assert.deepEqual(
      cleanPostTrain(
        {
          adapter: 'kit_world:KitWorldAdapter',
          checkpoint: 'mine/world.pt',
          daily: true,
        },
        { root, dataRoot: data },
      ),
      { adapter: 'kit_world:KitWorldAdapter', checkpoint: model, daily: true },
    );
    const { spawnImpl, children } = fakeSpawn([]);
    const manager = createAiWorldManager({
      root,
      feeds: new Map([['pings', pingFeed]]),
      spawnImpl,
      gpu: () => null,
      python: ['py', '-3.13'],
    });
    assert.throws(
      () =>
        manager.setPostTrain({
          adapter: 'kit_world:KitWorldAdapter',
          checkpoint: 'mine/world.pt',
          run: true,
        }),
      (error) => error.status === 409,
      'post-training runs with the rest of the work',
    );
    assert.deepEqual(manager.status().posttrain, {
      adapter: 'kit_world:KitWorldAdapter',
      checkpoint: path.join('mine', 'world.pt'),
      daily: false,
      last: null,
    });
    manager.initialize({ selection: ['pings'] });
    manager.setPostTrain({
      adapter: 'kit_world:KitWorldAdapter',
      checkpoint: 'mine/world.pt',
      daily: true,
      run: true,
    });
    const child = children.find((c) => c.args.includes('ml.gevtape.posttrain'));
    assert.ok(child, 'queued');
    assert.deepEqual(
      child.args.slice(
        child.args.indexOf('--adapter'),
        child.args.indexOf('--adapter') + 4,
      ),
      ['--adapter', 'kit_world:KitWorldAdapter', '--checkpoint', model],
    );
    assert.equal(
      child.args[child.args.indexOf('--out') + 1],
      path.join(data, 'ai-world', 'models', 'posttrain'),
    );
    write(
      data,
      'ai-world/models/posttrain/metrics.json',
      JSON.stringify({
        heldOutLossBefore: 0.5,
        heldOutLossAfter: 0.4,
        helped: true,
        trainedThrough: '2026-10-15',
      }),
    );
    assert.deepEqual(manager.status().posttrain.last, {
      before: 0.5,
      after: 0.4,
      helped: true,
      trainedThrough: '2026-10-15',
      updatedAt: null,
    });
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('military ids are stripped, a finished day is the one before today, and infer does not invent', async () => {
  assert.equal(
    newestCompleteTapeDay(
      ['2026/10/14', '2026/10/13', '2026/10/12'],
      Date.UTC(2026, 9, 14),
    ),
    '2026/10/13',
  );
  assert.equal(
    newestCompleteTapeDay(['2026/10/14'], Date.UTC(2026, 9, 14)),
    null,
  );
  const root = tmp();
  try {
    const manager = createAiWorldManager({
      root,
      feeds: new Map([
        ['pings', pingFeed],
        ['military', { ...pingFeed, id: 'military' }],
      ]),
      spawnImpl: fakeSpawn([]).spawnImpl,
      gpu: () => null,
    });
    manager.setSelection(['pings', 'military', 'military-awareness']);
    assert.deepEqual(manager.status().selection, ['pings']);
    const empty = matchInfer({ kind: 'topic', query: '', records: [] });
    assert.deepEqual(empty.matched, []);
    assert.equal(empty.note, 'NO MATCH');
    const military = matchInfer({
      kind: 'item',
      query: 'abc123',
      records: [{ feed: 'military', hex: 'abc123', lat: 1, lon: 2 }],
    });
    assert.deepEqual(military.matched, []);
    const flight = matchInfer({
      kind: 'item',
      query: 'abc123',
      records: [{ feed: 'flights', hex: 'abc123', lat: 43.6, lon: -79.3 }],
    });
    assert.equal(flight.matched.length, 1);
    assert.equal(flight.matched[0].feed, 'flights');
    const gold = matchInfer({
      kind: 'item',
      query: 'gold',
      records: [
        { feed: 'markets', series: 'gold', label: 'Gold', value: 2400 },
      ],
    });
    assert.equal(gold.matched.length, 1);
    assert.equal(gold.matched[0].label, 'Gold');
    assert.equal(gold.note, null);
    const tanker = matchInfer({
      kind: 'topic',
      query: 'tankers',
      records: [{ feed: 'ais-live-vessels', supply: 'tankers', name: 'Ship' }],
    });
    assert.equal(tanker.matched.length, 1);
    assert.equal(tanker.note, null);
    const learning = await manager.infer({
      kind: 'item',
      query: 'abc123',
      lat: 43.6,
      lon: -79.3,
    });
    assert.equal(learning.note, 'NO MATCH');
    assert.deepEqual(learning.points, []);
    assert.deepEqual(learning.tracks, []);
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Timers whose intervals the test fires by hand. */
function fakeTimers() {
  const intervals = [];
  return {
    timers: {
      setTimeout,
      clearTimeout,
      setInterval: (fn, ms) => {
        intervals.push({ fn, ms });
        return {};
      },
      clearInterval() {},
    },
    /** One scheduler tick (the 15-minute pass). */
    tick: () => {
      for (const { fn, ms } of intervals) if (ms === 15 * 60_000) fn();
    },
  };
}

test('the job bins every finished day it has not binned, oldest first and one at a time, then trains once three days exist', () => {
  assert.deepEqual(
    unbinnedTapeDays(
      ['2026/09/14', '2026-09-13', '2026/10/16', '2026/09/15', 'x'],
      ['2026-09-14'],
      Date.UTC(2026, 9, 16, 12),
      new Set(['2026/09/15']),
    ),
    ['2026/09/13'],
    'binned, today, skipped and malformed days are left out',
  );
  const root = tmp();
  try {
    const data = path.join(root, '.gev-data');
    write(
      data,
      'outbreak/worlds/w1/world.json',
      JSON.stringify({ worldId: 'w1', builtAt: 1 }),
    );
    for (const day of ['2026/09/13', '2026/09/14', '2026/09/15'])
      write(data, `tape/earthquakes/${day}/00.ndjson.gz`, 'x');
    write(data, 'bins/w1/2026/09/14.mobility.npy', 'b');
    const { spawnImpl, children } = fakeSpawn([]);
    const { timers } = fakeTimers();
    const manager = createAiWorldManager({
      root,
      feeds: new Map([['pings', pingFeed]]),
      spawnImpl,
      timers,
      gpu: () => null,
      python: ['python'],
    });
    const bins = () =>
      children.filter((c) => String(c.args[0]).endsWith('world-tape-bin.mjs'));
    const trains = () =>
      children.filter((c) => c.args.includes('ml.gevtape.train'));
    manager.initialize({ selection: ['pings'], capGb: 10 });
    assert.equal(bins().length, 1, 'one bin child at a time');
    assert.deepEqual(bins()[0].args.slice(1), ['--day', '2026-09-13']);
    assert.equal(
      manager.status().stages.trainer.note,
      'BINNING 2026-09-13 · 1 DAY LEFT',
    );
    assert.equal(manager.status().learning.daysBinned, 1);
    write(data, 'bins/w1/2026/09/13.mobility.npy', 'b');
    bins()[0].emit('exit', 0, null);
    assert.equal(bins().length, 2, 'the next unbinned day follows');
    assert.deepEqual(bins()[1].args.slice(1), ['--day', '2026-09-15']);
    assert.equal(
      manager.status().stages.trainer.note,
      'BINNING 2026-09-15 · LAST DAY',
    );
    assert.equal(trains().length, 0, 'no training while a day is left');
    write(data, 'bins/w1/2026/09/15.mobility.npy', 'b');
    bins()[1].emit('exit', 0, null);
    assert.equal(bins().length, 2, 'nothing left to bin');
    assert.equal(manager.status().learning.daysBinned, 3);
    assert.equal(trains().length, 1, 'three binned days: the world trains');
    assert.ok(trains()[0].args.includes('world'));
    assert.equal(manager.status().stages.trainer.state, 'running');
    assert.equal(manager.status().stages.trainer.note, null);
    manager.stop();
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the world model waits for three binned days and says so; a trainer that failed is not launched again until a new day is binned', () => {
  const root = tmp();
  try {
    const data = path.join(root, '.gev-data');
    write(
      data,
      'outbreak/worlds/w1/world.json',
      JSON.stringify({ worldId: 'w1', builtAt: 1 }),
    );
    write(data, 'bins/w1/2026/10/01.mobility.npy', 'b');
    const { spawnImpl, children } = fakeSpawn([]);
    const { timers, tick } = fakeTimers();
    const manager = createAiWorldManager({
      root,
      feeds: new Map([['pings', pingFeed]]),
      spawnImpl,
      timers,
      gpu: () => null,
      python: ['python'],
    });
    const trains = () =>
      children.filter((c) => c.args.includes('ml.gevtape.train'));
    manager.initialize({ selection: ['pings'], capGb: 10 });
    tick();
    assert.equal(trains().length, 0, 'one binned day: no trainer launched');
    // The links report runs on any bins; once it is done the line settles.
    const links = children.find((c) => c.args.includes('ml.gevtape.links'));
    assert.ok(links, 'the links report still runs');
    links.stdout.emit('data', '{"event":"done"}\n');
    links.emit('exit', 0, null);
    let trainer = manager.status().stages.trainer;
    assert.equal(trainer.state, 'waiting');
    assert.equal(trainer.note, 'NEEDS 3 BINNED DAYS · 1 SO FAR');
    write(data, 'bins/w1/2026/10/02.mobility.npy', 'b');
    write(data, 'bins/w1/2026/10/03.mobility.npy', 'b');
    tick();
    assert.equal(trains().length, 1, 'three binned days: launched');
    trains()[0].stderr.emit('data', 'DataError: not enough bins\n');
    trains()[0].emit('exit', 1, null);
    trainer = manager.status().stages.trainer;
    assert.equal(trainer.state, 'error');
    assert.equal(trainer.error, 'DataError: not enough bins');
    assert.equal(trainer.note, 'TRIED AGAIN WHEN A NEW DAY IS BINNED');
    tick();
    tick();
    assert.equal(trains().length, 1, 'not launched again on the same bins');
    write(data, 'bins/w1/2026/10/04.mobility.npy', 'b');
    tick();
    assert.equal(trains().length, 2, 'a new binned day: tried again');
    manager.stop();
    manager.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
