import test from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_FACTORS, cleanProfile } from './outbreakCore.mjs';
import {
  EPI_HUMAN_FACTORS,
  EPI_INTERVENTION_CHOICES,
  PATHOGEN_PRESETS,
  cleanEpiProfile,
  epiParameters,
  simulateEpidemic,
} from './outbreakEpi.mjs';
import {
  COMPARE_SETS,
  POLICIES,
  rdPoint,
  sampleScenario,
} from './outbreakEpiScenarios.mjs';
import { nonePolicy, policyFor, randomPolicy } from './outbreakEpiActions.mjs';

const POOL = [3, 7, 11, 19];
const options = { seed: 2026, originPool: POOL, days: 40 };
const many = Array.from({ length: 600 }, (_, k) => sampleScenario(k, options));

test('R_d points: in the unit cube, the same point for the same index and seed', () => {
  const a = rdPoint(5, 9);
  assert.deepEqual(a, rdPoint(5, 9));
  assert.notDeepEqual(a, rdPoint(6, 9));
  assert.notDeepEqual(a, rdPoint(5, 10));
  assert.ok(a.every((x) => x >= 0 && x < 1));
});

test('scenarios are prefix-stable and seeded: scenario k is the same whatever else is drawn', () => {
  assert.deepEqual(sampleScenario(123, options), many[123]);
  assert.deepEqual(
    sampleScenario(4, options),
    sampleScenario(4, { ...options }),
  );
  assert.notDeepEqual(
    sampleScenario(4, options),
    sampleScenario(4, { ...options, seed: 2027 }),
  );
});

test('every profile is one the box could send: the cleaners leave it as it is', () => {
  for (const s of many) {
    assert.deepEqual(
      { ...cleanProfile(s.profile), ...cleanEpiProfile(s.profile) },
      s.profile,
      `scenario ${s.index}`,
    );
    const params = epiParameters(s.profile);
    assert.ok(params.r0 > 0 && Number.isFinite(params.beta));
  }
});

test('the sweep covers the box: every preset, every menu choice and unset, every policy, comparisons', () => {
  const presets = new Set(many.map((s) => s.preset));
  for (const p of PATHOGEN_PRESETS) assert.ok(presets.has(p.id), p.id);
  assert.ok(presets.has('random'));
  for (const factor of [...HUMAN_FACTORS, ...EPI_HUMAN_FACTORS]) {
    const seen = new Set(many.map((s) => s.profile[factor.key] ?? null));
    assert.ok(seen.has(null), `${factor.key} unset`);
    for (const o of factor.options)
      assert.ok(seen.has(o.id), `${factor.key} ${o.id}`);
  }
  const ruled = many.filter((s) => s.policy !== 'none');
  for (const choice of EPI_INTERVENTION_CHOICES) {
    if (choice.key === 'compare') continue;
    const seen = new Set(ruled.map((s) => s.profile[choice.key] ?? null));
    for (const o of choice.options)
      assert.ok(seen.has(o.id), `${choice.key} ${o.id}`);
  }
  const policies = new Map(POLICIES.map((p) => [p, 0]));
  for (const s of many) policies.set(s.policy, policies.get(s.policy) + 1);
  for (const [p, count] of policies) assert.ok(count > 60, `${p}: ${count}`);
  const compared = ruled.filter((s) => s.compare);
  assert.ok(compared.length > 0.15 * ruled.length);
  assert.ok(compared.length < 0.35 * ruled.length);
  for (const s of compared) assert.ok(COMPARE_SETS.includes(s.compare));
  assert.ok(many.filter((s) => s.policy === 'none').every((s) => !s.compare));
});

test('origins come from the pool; starts fall on the hour within the year', () => {
  for (const s of many) {
    assert.ok(s.origins.length >= 1 && s.origins.length <= 3);
    for (const o of s.origins) assert.ok(POOL.includes(o));
    assert.equal(s.startMs % 3_600_000, 0);
    assert.equal(new Date(s.startMs).getUTCFullYear(), 2026);
    assert.equal(s.untilMs - s.startMs, 40 * 86_400_000);
    assert.ok(Number.isInteger(s.policySeed));
  }
});

test('a sampled scenario runs on a small world', () => {
  const nodes = [
    {
      id: 'A',
      code: 'A',
      name: 'A',
      lat: 10,
      lon: 10,
      population: 2e6,
      kind: 'airport',
      country: 'RU',
    },
    {
      id: 'B',
      code: 'B',
      name: 'B',
      lat: 12,
      lon: 14,
      population: 1e6,
      kind: 'airport',
      country: 'NG',
    },
  ];
  for (const s of many.slice(0, 12)) {
    const result = simulateEpidemic({
      nodes,
      origins: [0],
      links: [[], []],
      routes: [
        {
          from: 0,
          to: 1,
          timeOfDayMs: 6 * 3_600_000,
          lengthMs: 3 * 3_600_000,
          passengers: 500,
        },
      ],
      params: epiParameters(s.profile),
      startMs: s.startMs,
      untilMs: s.startMs + 5 * 86_400_000,
      runs: 2,
      seed: 1,
      budgetMs: Infinity,
      now: () => 0,
    });
    assert.ok(result.totals.length === 5);
  }
});

test('the random policy: seeded per run, the window in runs of days, a few switches, flags', () => {
  const p = randomPolicy({
    seed: 5,
    candidates: [1, 2, 3, 4, 5, 6],
    countries: ['RU', 'NG'],
    switchRate: 0.3,
    flagRate: 0.5,
  });
  const days = (run) =>
    Array.from({ length: 30 }, (_, d) =>
      p.control(run, d, { reachedList: [] }),
    );
  const a = days(0);
  const again = days(0);
  assert.deepEqual(
    a.map((c) => [c.window, [...c.switches], c.flags]),
    again.map((c) => [c.window, [...c.switches], c.flags]),
  );
  const b = days(1);
  assert.notDeepEqual(
    a.map((c) => [c.window, [...c.switches]]),
    b.map((c) => [c.window, [...c.switches]]),
  );
  assert.ok(a.every((c) => c.window === 0 || c.window === 0xffffff));
  assert.ok(
    new Set(a.map((c) => c.window)).size === 2,
    'the window opens and closes',
  );
  assert.ok(a.some((c) => c.switches.size > 0));
  const flagged = a.flatMap((c) => c.flags);
  assert.equal(
    new Set(flagged).size,
    flagged.length,
    'a country is flagged once',
  );
  assert.deepEqual(nonePolicy().control(), {
    window: 0,
    switches: new Map(),
    flags: [],
  });
  assert.equal(policyFor('rules'), null);
});
