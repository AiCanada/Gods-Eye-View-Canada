import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  createTapeStore,
  tapeDay,
} from '../../server/shared/worldTapeStore.mjs';
import { createRecorder } from '../../server/shared/worldTapeRecorder.mjs';
import {
  WORLD_TAPE_FEEDS,
  buildCatalog,
  feedMap,
} from '../../server/shared/worldTape/catalog.mjs';

const T0 = Date.UTC(2026, 9, 13, 18, 5);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-tape-'));

function readRecords(file) {
  return gunzipSync(fs.readFileSync(file))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('the store: records as gzip members by hour, a manifest line per write, files beside them', () => {
  const root = tmp();
  try {
    let t = T0;
    const store = createTapeStore({ root, now: () => t });
    const meta = { class: 'open', licence: 'test' };
    assert.equal(
      store.append('quakes', [{ id: 'a' }, { id: 'b' }], meta).ok,
      true,
    );
    t += 60_000;
    store.append('quakes', [{ id: 'c' }], meta);
    const { day, hour } = tapeDay(T0);
    assert.equal(day, '2026/10/13');
    assert.equal(hour, '18');
    const file = path.join(root, 'quakes', day, `${hour}.ndjson.gz`);
    const records = readRecords(file);
    assert.deepEqual(
      records.map((r) => r.id),
      ['a', 'b', 'c'],
    );
    assert.deepEqual(Object.keys(records[0]).slice(0, 4), [
      't',
      'feed',
      'class',
      'licence',
    ]);
    assert.equal(records[2].t, T0 + 60_000);
    const manifest = fs
      .readFileSync(path.join(root, 'quakes', day, 'manifest.jsonl'), 'utf8')
      .trim()
      .split('\n');
    assert.equal(manifest.length, 2);
    const written = store.writeFile(
      'cctv',
      'cam 1.jpg',
      Buffer.from([1, 2, 3]),
      { camera: 'cam 1' },
      meta,
    );
    assert.equal(written.ok, true);
    assert.ok(fs.existsSync(path.join(root, written.file)));
    const usage = store.usage();
    assert.equal(usage.byFeed.quakes.records, 3);
    assert.ok(usage.usedBytes > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the store: a file written `at` another hour goes there with its record and manifest line', () => {
  const root = tmp();
  try {
    const store = createTapeStore({ root, now: () => T0 });
    const meta = { class: 'open', licence: 'test' };
    const at = Date.UTC(2026, 8, 1, 6, 30);
    const written = store.writeFile(
      'wind',
      'grid.i16',
      Buffer.from([1, 2]),
      { var: 'u10' },
      meta,
      { at },
    );
    assert.equal(written.ok, true);
    assert.equal(written.file, 'wind/2026/09/01/06/grid.i16');
    assert.deepEqual(
      [...fs.readFileSync(path.join(root, written.file))],
      [1, 2],
    );
    const dir = path.join(root, 'wind', '2026', '09', '01');
    const [record] = readRecords(path.join(dir, '06.ndjson.gz'));
    assert.equal(record.t, at);
    assert.equal(record.file, written.file);
    assert.equal(record.var, 'u10');
    assert.equal(record.class, 'open');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8'),
    );
    assert.equal(manifest.t, at);
    assert.equal(manifest.hour, '06');
    assert.deepEqual([...store.observedHours('wind', '2026/09/01')], [6]);
    // Without `at`, now: the file and its record share the hour.
    const now = store.writeFile('wind', 'grid.i16', Buffer.from([3]), {}, meta);
    const { day, hour } = tapeDay(T0);
    assert.equal(now.file, `wind/${day}/${hour}/grid.i16`);
    assert.equal(
      readRecords(path.join(root, 'wind', day, `${hour}.ndjson.gz`))[0].t,
      T0,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the store stops at the cap or a quota and deletes nothing', () => {
  const root = tmp();
  try {
    const store = createTapeStore({
      root,
      now: () => T0,
      capBytes: 1,
      quotas: {},
    });
    const refused = store.append('flights', [{ x: 1 }], { class: 'nc' });
    assert.deepEqual(refused, { ok: false, reason: 'cap' });
    const quota = createTapeStore({
      root,
      now: () => T0,
      capBytes: 1e9,
      quotas: { flights: 10 },
    });
    assert.equal(quota.append('flights', [{ x: 1 }]).reason, 'quota');
    assert.equal(fs.existsSync(path.join(root, 'flights')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the recorder: polls at the cadence, backs off on errors, pauses with a gap, stops at the quota', async () => {
  const root = tmp();
  try {
    let t = T0;
    const store = createTapeStore({ root, now: () => t });
    const timers = [];
    const fakeTimers = {
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        if (timer) timer.cleared = true;
      },
    };
    let calls = 0;
    let fail = false;
    const adapters = new Map([
      [
        'pings',
        {
          id: 'pings',
          class: 'open',
          licence: 'test',
          cadenceMs: 1000,
          async poll({ state }) {
            calls += 1;
            if (fail) throw new Error('upstream down');
            state.n = (state.n || 0) + 1;
            return { records: [{ n: state.n }] };
          },
        },
      ],
    ]);
    const recorder = createRecorder({
      store,
      adapters,
      now: () => t,
      timers: fakeTimers,
    });
    recorder.setFeeds(['pings', 'not-a-feed']);
    recorder.start();
    const next = async () => {
      const timer = timers.filter((x) => !x.cleared).pop();
      timer.cleared = true;
      await timer.fn();
      return timer;
    };
    await next();
    assert.equal(calls, 1);
    assert.equal(timers.at(-1).ms, 1000, 'the next poll at the cadence');
    fail = true;
    t += 1000;
    await next();
    assert.equal(recorder.status()[0].state, 'error');
    assert.equal(timers.at(-1).ms, 2000, 'backs off');
    fail = false;
    t += 2000;
    await next();
    assert.equal(recorder.status()[0].state, 'recording');
    assert.equal(recorder.status()[0].records, 2);
    // Pause, then resume: the pause is a gap.
    recorder.pause();
    assert.equal(recorder.status()[0].state, 'paused');
    t += 60_000;
    recorder.resume();
    const gaps = store.gaps();
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].reason, 'paused');
    assert.equal(gaps[0].to - gaps[0].from, 60_000);
    // The cap: the feed stops and says so.
    store.setCap(1);
    await next();
    assert.equal(recorder.status()[0].state, 'quota');
    assert.match(recorder.status()[0].error, /CAP/);
    recorder.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the catalog: every feed carries its licence class, and the extras are listed', () => {
  const catalog = buildCatalog();
  const ids = catalog.map((item) => item.id);
  assert.ok(ids.includes('earthquakes') && ids.includes('outbreak-sim'));
  for (const item of catalog) {
    assert.ok(
      ['open', 'nc', 'restricted', 'unclear', 'personal', 'static'].includes(
        item.class,
      ),
      item.id,
    );
    assert.ok(item.licence, item.id);
  }
  for (const feed of WORLD_TAPE_FEEDS) {
    assert.equal(typeof feed.poll, 'function', feed.id);
    assert.ok(feed.cadenceMs > 0, feed.id);
  }
  assert.equal(feedMap().get('transit').id, 'transit');
});

test('the reference feeds: earthquakes once per revision, transit from every region', async () => {
  const quakes = feedMap().get('earthquakes');
  const rows = [
    {
      usgsId: 'us1',
      lat: 1,
      lon: 2,
      depthKm: 10,
      mag: 4.1,
      place: 'Somewhere',
      time: 5,
    },
  ];
  const services = {
    earthquakes: { getSnapshot: async () => rows },
    transit: {
      getFeeds: async () => [{ id: 'mbta' }, { id: 'hsl' }],
      requestSnapshot: async (id) => ({
        ok: true,
        json: async () => ({
          vehicles:
            id === 'mbta'
              ? [{ id: 'v1', lat: 42, lon: -71 }]
              : [{ id: 'v2', lat: 60, lon: 25 }, { id: 'bad' }],
        }),
      }),
    },
  };
  const state = {};
  const now = () => T0;
  assert.equal((await quakes.poll({ services, state, now })).records.length, 1);
  assert.equal(
    (await quakes.poll({ services, state, now })).records.length,
    0,
    'not twice',
  );
  rows[0] = { ...rows[0], mag: 4.3 };
  assert.equal(
    (await quakes.poll({ services, state, now })).records.length,
    1,
    'a revision',
  );
  const transit = await feedMap()
    .get('transit')
    .poll({ services, state: {}, now });
  assert.deepEqual(
    transit.records.map((r) => [r.region, r.id]),
    [
      ['mbta', 'v1'],
      ['hsl', 'v2'],
    ],
  );
});

test('the recorder: PAUSE, STOP and an untick cut a poll in flight short, and that is no failure', async () => {
  const root = tmp();
  try {
    const store = createTapeStore({ root, now: () => T0 });
    const signals = [];
    const slow = {
      id: 'slow',
      class: 'open',
      licence: 'test',
      cadenceMs: 10,
      poll: ({ signal }) =>
        new Promise((resolve, reject) => {
          signals.push(signal);
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    };
    const recorder = createRecorder({
      store,
      adapters: new Map([['slow', slow]]),
    });
    recorder.setFeeds(['slow']);
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(signals.length, 1, 'one poll in flight');
    recorder.pause();
    assert.equal(signals[0].aborted, true, 'PAUSE cuts it short');
    await new Promise((resolve) => setImmediate(resolve));
    let status = recorder.status().find((f) => f.id === 'slow');
    assert.equal(status.state, 'paused');
    assert.equal(status.error, null, 'not counted as a failure');
    assert.equal(store.observedHours('slow', '2026/10/13').size, 0);
    // CONTINUE polls again at once.
    recorder.resume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(signals.length, 2);
    recorder.setFeeds([]);
    assert.equal(signals[1].aborted, true, 'an untick cuts it short');
    recorder.setFeeds(['slow']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(signals.length, 3);
    recorder.stop();
    assert.equal(signals[2].aborted, true, 'STOP cuts it short');
    await new Promise((resolve) => setImmediate(resolve));
    status = recorder.status().find((f) => f.id === 'slow');
    assert.equal(status.error, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
