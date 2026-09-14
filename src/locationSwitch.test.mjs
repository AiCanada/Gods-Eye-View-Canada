import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocationSwitch,
  isLocationPoint,
  releaseServerLocationMemory,
} from './locationSwitch.js';

const TORONTO = { lat: 43.65, lon: -79.38 };
const OTTAWA = { lat: 45.42, lon: -75.69 };
const MONTREAL = { lat: 45.5, lon: -73.57 };
const AUSTIN = { lat: 30.27, lon: -97.74 };
const OCEAN = { lat: 40, lon: -40 };

const REGIONS = new Map([
  [TORONTO, 'CA-ON'],
  [OTTAWA, 'CA-ON'],
  [MONTREAL, 'CA-QC'],
  [AUSTIN, 'US-TX'],
  [OCEAN, ''],
]);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** A switch whose region lookups answer from REGIONS, recording leave/arrive calls. */
function harness({ lookup, arrivalTimeoutMs } = {}) {
  const calls = [];
  const timers = [];
  const control = createLocationSwitch({
    lookupRegion: lookup || (async (point) => ({ key: REGIONS.get(point) ?? '' })),
    leave: ({ from, to }) => calls.push(['leave', from?.key ?? null, to.key]),
    arrive: ({ from, to }) => calls.push(['arrive', from?.key ?? null, to.key]),
    onError: (error) => calls.push(['error', String(error?.message || error)]),
    arrivalTimeoutMs,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  return { control, calls, timers };
}

test('points must be finite coordinates on the globe', () => {
  assert.equal(isLocationPoint(TORONTO), true);
  assert.equal(isLocationPoint({ lat: 91, lon: 0 }), false);
  assert.equal(isLocationPoint({ lat: Number.NaN, lon: 0 }), false);
  assert.equal(isLocationPoint(null), false);
});

test('the first known region is adopted without switching anything', async () => {
  const { control, calls } = harness();
  assert.deepEqual(await control.seed(TORONTO), { key: 'CA-ON', region: null, country: null, ...TORONTO });
  assert.deepEqual(calls, []);
  const fresh = harness();
  const result = await fresh.control.select(MONTREAL);
  assert.equal(result.reason, 'first-region');
  assert.equal(fresh.control.getCurrent().key, 'CA-QC');
  assert.deepEqual(fresh.calls, []);
});

test('a place in the same province keeps every feed running', async () => {
  const { control, calls } = harness();
  await control.seed(TORONTO);
  const result = await control.select(OTTAWA);
  assert.equal(result.reason, 'same-region');
  assert.deepEqual(calls, []);
});

test('another province leaves at once and loads the new place when the camera arrives', async () => {
  const { control, calls } = harness();
  await control.seed(TORONTO);
  const arrival = deferred();
  const switching = control.select(MONTREAL, { arrival: arrival.promise });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [['leave', 'CA-ON', 'CA-QC']], 'old feeds stop during the flight');
  assert.deepEqual(control.getPending(), { from: control.getCurrent(), to: { key: 'CA-QC', region: null, country: null, ...MONTREAL } });
  arrival.resolve();
  const result = await switching;
  assert.equal(result.switched, true);
  assert.deepEqual(calls, [['leave', 'CA-ON', 'CA-QC'], ['arrive', 'CA-ON', 'CA-QC']]);
  assert.equal(control.getCurrent().key, 'CA-QC');
  assert.equal(control.getPending(), null);
});

test('a map click, with the camera already there, switches straight through', async () => {
  const { control, calls } = harness();
  await control.seed(MONTREAL);
  assert.equal((await control.select(AUSTIN)).switched, true);
  assert.deepEqual(calls, [['leave', 'CA-QC', 'US-TX'], ['arrive', 'CA-QC', 'US-TX']]);
});

test('a point that cannot be placed, or a failed lookup, never drops a feed', async () => {
  const { control, calls } = harness();
  await control.seed(TORONTO);
  assert.equal((await control.select(OCEAN)).reason, 'unplaced');
  const failing = harness({ lookup: async () => { throw new Error('offline'); } });
  await failing.control.select(TORONTO);
  assert.deepEqual(calls, []);
  assert.deepEqual(failing.calls, [['error', 'offline']]);
  assert.equal(control.getCurrent().key, 'CA-ON');
});

test('a newer selection supersedes an older one still waiting for its region', async () => {
  const slow = deferred();
  const { control, calls } = harness({
    lookup: async (point) => {
      if (point === MONTREAL) await slow.promise;
      return { key: REGIONS.get(point) };
    },
  });
  await control.seed(TORONTO);
  const older = control.select(MONTREAL);
  const newer = await control.select(AUSTIN);
  slow.resolve();
  assert.equal((await older).reason, 'superseded');
  assert.equal(newer.switched, true);
  assert.deepEqual(calls, [['leave', 'CA-ON', 'US-TX'], ['arrive', 'CA-ON', 'US-TX']]);
});

test('a new destination in yet another region replaces a switch in flight', async () => {
  const { control, calls } = harness();
  await control.seed(TORONTO);
  const firstArrival = deferred();
  const first = control.select(MONTREAL, { arrival: firstArrival.promise });
  await new Promise((r) => setImmediate(r));
  const second = await control.select(AUSTIN);
  firstArrival.resolve();
  assert.equal((await first).reason, 'superseded');
  assert.equal(second.switched, true);
  assert.deepEqual(calls, [
    ['leave', 'CA-ON', 'CA-QC'],
    ['leave', 'CA-ON', 'US-TX'],
    ['arrive', 'CA-ON', 'US-TX'],
  ], 'the abandoned destination never loads');
  assert.equal(control.getCurrent().key, 'US-TX');
});

test('a destination in the region already being switched to lets that switch finish', async () => {
  const { control, calls } = harness();
  await control.seed(TORONTO);
  const arrival = deferred();
  const switching = control.select(MONTREAL, { arrival: arrival.promise });
  await new Promise((r) => setImmediate(r));
  assert.equal((await control.select({ lat: 45.51, lon: -73.56 }, {})).reason, 'unplaced', 'unknown test point');
  arrival.resolve();
  assert.equal((await switching).switched, true);
  assert.deepEqual(calls.map((c) => c[0]), ['leave', 'arrive']);
});

test('a camera that never reports arrival still loads the new place after the timeout', async () => {
  const { control, calls, timers } = harness({ arrivalTimeoutMs: 1234 });
  await control.seed(TORONTO);
  const switching = control.select(AUSTIN, { arrival: new Promise(() => {}) });
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.at(-1).ms, 1234);
  timers.at(-1).fn();
  assert.equal((await switching).switched, true);
  assert.deepEqual(calls.at(-1), ['arrive', 'CA-ON', 'US-TX']);
});

test('a newer switch aborts one still loading after arrival, so its late work is skipped', async () => {
  const slowArrive = deferred();
  const calls = [];
  const signals = [];
  const control = createLocationSwitch({
    lookupRegion: async (point) => ({ key: REGIONS.get(point) }),
    leave: ({ from, to }) => calls.push(['leave', from?.key ?? null, to.key]),
    arrive: async ({ to, signal }) => {
      calls.push(['arrive-start', to.key]);
      signals.push(signal);
      if (to.key === 'CA-QC') await slowArrive.promise;
      if (!signal.aborted) calls.push(['arrive-done', to.key]);
    },
    onError: () => {},
  });
  await control.seed(TORONTO);
  const first = control.select(MONTREAL);
  await new Promise((r) => setImmediate(r));
  const second = await control.select(AUSTIN);
  slowArrive.resolve();
  assert.equal((await first).reason, 'superseded');
  assert.equal(signals[0].aborted, true, 'the older arrival is told it was superseded');
  assert.equal(second.switched, true);
  assert.deepEqual(calls, [
    ['leave', 'CA-ON', 'CA-QC'],
    ['arrive-start', 'CA-QC'],
    ['leave', 'CA-QC', 'US-TX'],
    ['arrive-start', 'US-TX'],
    ['arrive-done', 'US-TX'],
  ]);
});

test('a selection waits for the starting region still being looked up', async () => {
  const slowSeed = deferred();
  const { control, calls } = harness({
    lookup: async (point) => {
      if (point === TORONTO) await slowSeed.promise;
      return { key: REGIONS.get(point) };
    },
  });
  const seeding = control.seed(TORONTO);
  const switching = control.select(MONTREAL);
  slowSeed.resolve();
  await seeding;
  assert.equal((await switching).switched, true);
  assert.deepEqual(calls, [['leave', 'CA-ON', 'CA-QC'], ['arrive', 'CA-ON', 'CA-QC']]);
});

test('after a starting region that could not be told, the first selection still switches', async () => {
  let fail = true;
  const { control, calls } = harness({
    lookup: async (point) => {
      if (fail && point === TORONTO) throw new Error('503');
      return { key: REGIONS.get(point) };
    },
  });
  assert.equal(await control.seed(TORONTO), null);
  const result = await control.select(MONTREAL);
  assert.equal(result.switched, true);
  assert.deepEqual(calls.filter((c) => c[0] !== 'error'), [['leave', null, 'CA-QC'], ['arrive', null, 'CA-QC']]);
  assert.equal(control.getCurrent().key, 'CA-QC');

  const retry = harness({ lookup: async (point) => { if (fail) { fail = false; throw new Error('503'); } return { key: REGIONS.get(point) }; } });
  fail = true;
  assert.equal(await retry.control.seed(TORONTO), null);
  assert.equal((await retry.control.seed(TORONTO)).key, 'CA-ON', 'a failed seed can be tried again');
});

test('selection details travel with the destination to the layers', async () => {
  const seen = [];
  const control = createLocationSwitch({
    lookupRegion: async (point) => ({ key: REGIONS.get(point) }),
    leave: ({ to }) => seen.push(to),
    onError: () => {},
  });
  await control.seed(TORONTO);
  await control.select(MONTREAL, { details: { selectCamera: true, key: 'ignored' } });
  assert.equal(seen[0].selectCamera, true);
  assert.equal(seen[0].key, 'CA-QC', 'details never override the looked-up region');
});

test('the server is asked to release memory far from the new place, and a failure is ignored', async () => {
  const requests = [];
  const report = await releaseServerLocationMemory({ lat: 45.5, lon: -73.57 }, {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ released: { terrain: 3 } }) };
    },
  });
  assert.deepEqual(report, { released: { terrain: 3 } });
  assert.equal(requests[0].url, '/api/location-switch/release');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), { latitude: 45.5, longitude: -73.57 });
  assert.equal(await releaseServerLocationMemory({ lat: 1, lon: 2 }, { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await releaseServerLocationMemory({ lat: 1, lon: 2 }, { fetchImpl: async () => { throw new Error('offline'); } }), null);
  let called = false;
  assert.equal(await releaseServerLocationMemory(null, { fetchImpl: async () => { called = true; } }), null);
  assert.equal(called, false);
});

test('destroy abandons a switch in flight', async () => {
  const { control, calls } = harness();
  await control.seed(TORONTO);
  const switching = control.select(AUSTIN, { arrival: new Promise(() => {}) });
  await new Promise((r) => setImmediate(r));
  control.destroy();
  assert.equal((await switching).reason, 'superseded');
  assert.deepEqual(calls, [['leave', 'CA-ON', 'US-TX']]);
});
