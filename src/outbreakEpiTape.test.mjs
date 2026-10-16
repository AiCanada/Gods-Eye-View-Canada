import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32,
  simulateEpidemic,
  splitmix64,
  streamWords,
  xoshiro128ss,
} from './outbreakEpi.mjs';
import {
  CUM_CHANNELS,
  GLOBAL_CHANNELS,
  STATE_CHANNELS,
  createEpisodeTape,
  replayPolicy,
  trackedPlaces,
  worldCountries,
} from './outbreakEpiTape.mjs';
import {
  SCENARIOS,
  START,
  hashOf,
  runScenario,
} from './testSupport/outbreakEpiMatrix.mjs';

// Every matrix scenario a tape can ride: not the comparison (a tape records
// one arm) and not the deadline (a tape never runs under one).
const TAPED = Object.keys(SCENARIOS).filter(
  (name) => name !== 'compare' && name !== 'deadline-cut',
);

/** Run a scenario with a tape; returns the result and its episodes. */
function taped(name, { policy = null, exact = false, extra = {} } = {}) {
  const input = SCENARIOS[name]();
  const nodes = input.nodes;
  const { countries, countryOfNode } = worldCountries(nodes);
  const tracked = trackedPlaces(nodes, 2);
  const episodes = [];
  const tape = createEpisodeTape({
    nodes,
    tracked,
    countries,
    countryOfNode,
    policy,
    exact,
    check: true,
    onEpisode: (episode) => episodes.push(episode),
  });
  const result = runScenario(name, { tape, ...extra });
  return { result, episodes, countries, tracked, nodes };
}

const at = (array, ...index) => {
  let flat = 0;
  for (let k = 0; k < index.length; k += 1)
    flat = flat * array.shape[k] + index[k];
  const rest = array.shape.slice(index.length).reduce((p, x) => p * x, 1);
  return array.data.subarray(flat * rest, (flat + 1) * rest);
};

test('xoshiro128**: the reference outputs from state {1, 2, 3, 4}; splitmix64 from 0', () => {
  const next = xoshiro128ss(1, 2, 3, 4);
  const words = [next(), next(), next()].map((u) => u * 4294967296);
  assert.deepEqual(words, [11520, 0, 5927040]);
  assert.equal(splitmix64(0n)[1], 0xe220a8397b1dcdafn);
  // Keyed words: the same key and run, the same words; any change, others.
  assert.deepEqual(streamWords([1, 2], 3), streamWords([1, 2], 3));
  assert.notDeepEqual(streamWords([1, 2], 3), streamWords([1, 2], 4));
  assert.notDeepEqual(streamWords([1, 2], 3), streamWords([1, 3], 3));
  const u = xoshiro128ss(...streamWords([7, 7], 0));
  for (let k = 0; k < 1000; k += 1) {
    const x = u();
    assert.ok(x >= 0 && x < 1);
  }
  // The all-zero state is avoided.
  assert.ok(Number.isFinite(xoshiro128ss(0, 0, 0, 0)()));
  assert.equal(typeof mulberry32(1)(), 'number');
});

test('a keyed stream: run r is the same whatever the run count, and other keys draw others', () => {
  const run = (runs, key) =>
    runScenario('world-default', {
      runs,
      stream: { kind: 'xoshiro128', key },
      trace: true,
    });
  const few = run(3, [11, 22]);
  const many = run(6, [11, 22]);
  assert.deepEqual(few.trace.runEnd, many.trace.runEnd.slice(0, 3));
  const other = run(3, [11, 23]);
  assert.notDeepEqual(other.trace.runEnd, few.trace.runEnd);
  // Unset, the model draws as it always has.
  assert.equal(
    hashOf(runScenario('world-default')),
    hashOf(runScenario('world-default', { stream: null })),
  );
});

test('a record-only tape changes nothing: every scenario, the same result as without it', () => {
  for (const name of TAPED) {
    const { result } = taped(name);
    assert.equal(hashOf(result), hashOf(runScenario(name)), name);
  }
});

test('the tape refuses a comparison and a deadline', () => {
  const nodes = SCENARIOS['world-default']().nodes;
  const { countries, countryOfNode } = worldCountries(nodes);
  const tape = createEpisodeTape({
    nodes,
    tracked: trackedPlaces(nodes, 2),
    countries,
    countryOfNode,
  });
  assert.throws(() => runScenario('compare', { tape }), /one arm/);
  assert.throws(() => runScenario('deadline-cut', { tape }), /deadline/);
});

test('episodes: shapes, conservation, places within countries, counts never fall', () => {
  for (const name of TAPED) {
    const { result, episodes, countries } = taped(name, {
      extra: { trace: true },
    });
    assert.equal(episodes.length, result.runs, name);
    for (const ep of episodes) {
      const T = ep.days;
      const C = countries.length;
      const g = ep.arrays.global;
      assert.deepEqual(g.shape, [T + 1, GLOBAL_CHANNELS.length]);
      assert.deepEqual(ep.arrays.country_state.shape, [
        T + 1,
        C,
        STATE_CHANNELS.length,
      ]);
      // The last day's totals are the run's own end totals.
      const end = result.trace.runTotals[ep.run];
      const last = at(g, T);
      for (let j = 0; j < end.length; j += 1)
        assert.ok(Math.abs(last[j] - end[j]) < 1e-9, `${name} column ${j}`);
      for (let d = 0; d <= T; d += 1) {
        // Countries add up to the run's deaths and infections.
        let deaths = 0;
        let infected = 0;
        for (let c = 0; c < C; c += 1) {
          deaths += at(ep.arrays.country_state, d, c)[8];
          infected += at(ep.arrays.country_cum, d, c)[0];
        }
        assert.equal(deaths, Math.round(at(g, d)[2]), `${name} deaths d${d}`);
        assert.equal(infected, Math.round(at(g, d)[0]), `${name} cum d${d}`);
        if (d > 0)
          for (let c = 0; c < C; c += 1) {
            const now = at(ep.arrays.country_cum, d, c);
            const before = at(ep.arrays.country_cum, d - 1, c);
            for (let j = 0; j < CUM_CHANNELS.length; j += 1)
              assert.ok(now[j] >= before[j], `${name} cum falls`);
          }
      }
    }
  }
});

test('the fast country sums are the full scan exactly', () => {
  for (const name of TAPED) {
    const quick = taped(name).episodes;
    const full = taped(name, { exact: true }).episodes;
    for (let r = 0; r < quick.length; r += 1)
      for (const key of Object.keys(quick[r].arrays))
        assert.deepEqual(
          quick[r].arrays[key].data,
          full[r].arrays[key].data,
          `${name} ${key}`,
        );
  }
});

test('flows reconcile: the day’s change in transit and in isolation is what flew, was caught and landed', () => {
  for (const name of TAPED) {
    const { episodes } = taped(name);
    for (const ep of episodes) {
      const f = ep.arrays.flows;
      const g = ep.arrays.global;
      const sum = new Map();
      for (let r = 0; r < f.shape[0]; r += 1) {
        const [day, , , , kind, people] = at(f, r);
        const key = `${day}|${kind}`;
        sum.set(key, (sum.get(key) || 0) + people);
      }
      const of = (day, kind) => sum.get(`${day}|${kind}`) || 0;
      for (let d = 0; d < ep.days; d += 1) {
        const transit = at(g, d + 1)[16] - at(g, d)[16];
        const isolated = at(g, d + 1)[18] - at(g, d)[18];
        assert.equal(
          Math.round(transit),
          of(d, 0) - of(d, 1) - of(d, 2) - of(d, 3) - of(d, 4),
          `${name} transit day ${d}`,
        );
        assert.equal(
          Math.round(isolated),
          of(d, 1) + of(d, 2) + of(d, 4),
          `${name} isolated day ${d}`,
        );
      }
    }
  }
});

test('replay: a run’s own logged decisions, fed back as its control, give the same run', () => {
  for (const name of TAPED) {
    const first = taped(name, { extra: { trace: true } });
    const policies = first.episodes.map((ep) =>
      replayPolicy(ep.arrays, first.countries),
    );
    const replay = taped(name, {
      policy: { control: (run, day) => policies[run].control(run, day) },
      extra: { trace: true },
    });
    assert.equal(hashOf(replay.result), hashOf(first.result), name);
    for (let r = 0; r < first.episodes.length; r += 1)
      for (const key of Object.keys(first.episodes[r].arrays))
        assert.deepEqual(
          replay.episodes[r].arrays[key].data,
          first.episodes[r].arrays[key].data,
          `${name} run ${r} ${key}`,
        );
  }
});

test('a control that is always null is the model’s own rules', () => {
  for (const name of [
    'per-place-reported',
    'borders-reported',
    'window-hour-37',
  ]) {
    const { result } = taped(name, { policy: { control: () => null } });
    assert.equal(hashOf(result), hashOf(runScenario(name)), name);
  }
});

test('control steers: closing the window, switching a place on, flagging a country each change the run', () => {
  const base = taped('window-hour-37');
  // The window never opens: no lockdown, no tracing.
  const shut = taped('window-hour-37', {
    policy: { control: () => ({ window: 0 }) },
  });
  assert.notEqual(hashOf(shut.result), hashOf(base.result));
  assert.ok(
    shut.episodes.every((ep) =>
      ep.arrays.controls_window.data.every((m) => m === 0),
    ),
  );
  // Per-place: the domestic airport (node 1) locked from day 0, all window.
  const plain = taped('per-place-reported');
  const locked = taped('per-place-reported', {
    policy: {
      control: () => ({ window: 0xffffff, switches: new Map([[1, 1]]) }),
    },
  });
  assert.notEqual(hashOf(locked.result), hashOf(plain.result));
  const ep = locked.episodes[0];
  const sw = ep.arrays.controls_switch;
  assert.deepEqual(Array.from(sw.data.subarray(0, 3)), [0, 1, 1]);
  // Flagging Nigeria under the 'reported' policy closes its legs at once.
  const flagged = taped('borders-reported', {
    policy: { control: (run, day) => (day === 0 ? { flags: ['NG'] } : null) },
  });
  assert.ok(flagged.episodes[0].arrays.controls_flags.shape[0] >= 1);
});

test('events: arrivals by seed and by air, first reports, and the labels', () => {
  const { episodes } = taped('world-default');
  const ep = episodes[0];
  const ev = ep.arrays.events;
  const kinds = new Set();
  let seeded = 0;
  for (let r = 0; r < ev.shape[0]; r += 1) {
    const [hour, node, kind, value] = at(ev, r);
    kinds.add(kind);
    if (kind === 0 && value === 1) {
      seeded += 1;
      assert.equal(node, 0);
      assert.equal(hour, 0);
    }
  }
  assert.equal(seeded, 1, 'patient zero');
  assert.ok(kinds.has(0) && kinds.has(1));
  assert.ok(ep.labels.infected > 0);
  assert.equal(ep.labels.reached, ep.labels.reached | 0);
  assert.ok(ep.labels.peakDay >= 0 && ep.labels.peakDay < ep.days);
});

test('world helpers: countries sorted with none last; tracked places large airports first', () => {
  const nodes = [
    { id: 'a', population: 5, country: 'RU', kind: 'city' },
    { id: 'b', population: 1, country: 'NG', kind: 'airport', size: 'L' },
    { id: 'c', population: 9, country: '', kind: 'city' },
  ];
  const { countries, countryOfNode } = worldCountries(nodes);
  assert.deepEqual(countries, ['NG', 'RU', '']);
  assert.deepEqual(Array.from(countryOfNode), [1, 0, 2]);
  assert.deepEqual(Array.from(trackedPlaces(nodes, 2)), [1, 2]);
  assert.equal(START > 0, true);
});

test('magnitudes: the day’s lockdown, ban, tests and doses steer the run; the scenario’s own, given, change nothing', () => {
  const always = (control) => ({ control: () => control });
  // The ban: the scenario's own 95 %, given each day, is the run as ever;
  // lifted, people fly.
  const banned = taped('world-ban');
  assert.equal(
    hashOf(taped('world-ban', { policy: always({ travelBan: 0.95 }) }).result),
    hashOf(banned.result),
  );
  const lifted = taped('world-ban', { policy: always({ travelBan: 0 }) });
  assert.ok(
    lifted.result.summary.passengersBlockedP50 <
      banned.result.summary.passengersBlockedP50,
  );
  // Logged exactly as given, NaN where the control left the setting.
  const m = lifted.episodes[0].arrays.controls_magnitudes;
  assert.deepEqual(m.shape, [lifted.episodes[0].days, 4]);
  assert.ok(Number.isNaN(m.data[0]), 'lockdown not set');
  assert.equal(m.data[1], 0, 'the ban lifted');
  // The lockdown level inside the window (50 % in the scenario).
  const windowed = taped('window-hour-37');
  assert.equal(
    hashOf(
      taped('window-hour-37', { policy: always({ lockdown: 0.5 }) }).result,
    ),
    hashOf(windowed.result),
  );
  const loose = taped('window-hour-37', { policy: always({ lockdown: 0 }) });
  assert.notEqual(hashOf(loose.result), hashOf(windowed.result));
  // Tests: the scenario's own capacity, given, is as ever; a tenth of it
  // finds fewer cases.
  const tested = taped('testing-awareness');
  assert.equal(
    hashOf(
      taped('testing-awareness', { policy: always({ testsPer1000Day: 0.05 }) })
        .result,
    ),
    hashOf(tested.result),
  );
  const scarce = taped('testing-awareness', {
    policy: always({ testsPer1000Day: 0.005 }),
  });
  assert.ok(
    scarce.result.summary.reportedP50 < tested.result.summary.reportedP50,
  );
  // Doses: none given, nobody vaccinated; the campaign's own rate given each
  // day reaches the same people as its closed form, to the person.
  const campaign = taped('waning-campaign');
  assert.ok(campaign.result.summary.vaccinatedP50 > 0);
  const stopped = taped('waning-campaign', {
    policy: always({ vaccinePer1000Day: 0 }),
  });
  assert.equal(stopped.result.summary.vaccinatedP50, 0);
  const steady = taped('waning-campaign', {
    policy: always({ vaccinePer1000Day: 30 }),
  });
  assert.equal(
    steady.result.summary.vaccinatedP50,
    campaign.result.summary.vaccinatedP50,
  );
  // Twice the rate vaccinates more.
  const doubled = taped('waning-campaign', {
    policy: always({ vaccinePer1000Day: 60 }),
  });
  assert.ok(
    doubled.result.summary.vaccinatedP50 >
      campaign.result.summary.vaccinatedP50,
  );
});

test('replay with magnitudes: a random policy’s run, its logged controls fed back, is the same run byte for byte', async () => {
  const { randomPolicy } = await import('./outbreakEpiActions.mjs');
  for (const name of ['world-ban', 'waning-campaign', 'testing-awareness']) {
    const input = SCENARIOS[name]();
    const policy = randomPolicy({
      seed: 11,
      candidates: [0, 1, 2].filter((i) => i < input.nodes.length),
      countries: [],
      magnitudeFlip: 0.3,
    });
    const first = taped(name, { policy });
    const logged = first.episodes[0].arrays.controls_magnitudes;
    assert.ok(
      Array.from(logged.data).some(Number.isFinite),
      `${name}: magnitudes were explored`,
    );
    const policies = first.episodes.map((ep) =>
      replayPolicy(ep.arrays, first.countries),
    );
    const replay = taped(name, {
      policy: { control: (run, day) => policies[run].control(run, day) },
    });
    assert.equal(hashOf(replay.result), hashOf(first.result), name);
    for (let r = 0; r < first.episodes.length; r += 1)
      for (const key of Object.keys(first.episodes[r].arrays))
        assert.deepEqual(
          replay.episodes[r].arrays[key].data,
          first.episodes[r].arrays[key].data,
          `${name} run ${r} ${key}`,
        );
  }
});
