import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanProfile } from './outbreakCore.mjs';
import {
  OUTBREAK_DEFAULT_PROFILE,
  PATHOGEN_PRESETS,
  arrivedBy,
  binomial,
  buildEpidemicNodes,
  cleanEpiProfile,
  doublingTime,
  effectiveDistances,
  epiParameters,
  epidemicLines,
  establishmentProbability,
  gamma,
  gravityLinks,
  growthRate,
  mulberry32,
  poisson,
  presetValues,
  reproductionNumber,
  seasonalFactor,
  simulateEpidemic,
  vectorSuitable,
  worldAirRoutes,
} from './outbreakEpi.mjs';

const START = Date.UTC(2026, 0, 10);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

test('the draws have the right means and stay in range', () => {
  const rng = mulberry32(7);
  const b = Array.from({ length: 4000 }, () => binomial(200, 0.3, rng));
  assert.ok(Math.abs(mean(b) - 60) < 1.5);
  assert.ok(b.every((x) => x >= 0 && x <= 200));
  const small = Array.from({ length: 4000 }, () => binomial(1e6, 2e-6, rng));
  assert.ok(Math.abs(mean(small) - 2) < 0.15);
  const p = Array.from({ length: 4000 }, () => poisson(4, rng));
  assert.ok(Math.abs(mean(p) - 4) < 0.15);
  const g = Array.from({ length: 4000 }, () => gamma(0.2, 5, rng));
  assert.ok(Math.abs(mean(g) - 1) < 0.15, 'gamma(0.2, 5) has mean 1');
  assert.equal(binomial(0, 0.5, rng), 0);
  assert.equal(binomial(10, 1, rng), 10);
  // The same seed, the same numbers.
  const a1 = mulberry32(42);
  const a2 = mulberry32(42);
  assert.deepEqual(
    Array.from({ length: 5 }, () => a1()),
    Array.from({ length: 5 }, () => a2()),
  );
});

test('the profile: only valid fields are kept; a preset fills them', () => {
  assert.deepEqual(
    cleanEpiProfile({
      preset: 'covid2020',
      latentDays: '3',
      asymptomaticPct: 120,
      superspreading: 'high',
      age: 'older',
      tracing: 'medium',
      travelBanPct: '',
      quarantineDays: 14,
      bogus: 1,
    }),
    {
      preset: 'covid2020',
      latentDays: 3,
      superspreading: 'high',
      age: 'older',
      tracing: 'medium',
      quarantineDays: 14,
    },
  );
  assert.equal(presetValues('measles').r0, 15);
  assert.deepEqual(presetValues('nope'), {});
  for (const preset of PATHOGEN_PRESETS) {
    const params = epiParameters(preset.values);
    assert.ok(params.beta > 0, preset.id);
    assert.ok(params.latentDays <= params.incubationDays, preset.id);
  }
});

test('R0 is the natural one: with nobody isolated, β gives back R0', () => {
  const params = epiParameters({
    r0: 3,
    incubationDays: 5,
    latentDays: 3,
    infectiousDays: 6,
    asymptomaticPct: 40,
    asymRelative: 0.5,
  });
  const natural = reproductionNumber({ ...params, isolation: 0 });
  assert.ok(Math.abs(natural - 3) < 1e-9);
  // Isolation, tracing and lockdown bring it down.
  const controlled = epiParameters({
    r0: 3,
    lockdownPct: 50,
    tracing: 'high',
  });
  assert.ok(controlled.rEffectiveControlled < controlled.rEffective / 1.9);
});

test('growth rate matches the SEIR closed form; doubling time follows', () => {
  // No presymptomatic stage, nobody asymptomatic or isolated: plain SEIR.
  const params = {
    ...epiParameters({
      r0: 2.5,
      incubationDays: 4,
      latentDays: 4,
      infectiousDays: 5,
      asymptomaticPct: 0,
    }),
    isolation: 0,
  };
  const sigma = 1 / 4;
  const g = 1 / 5;
  const expected =
    (-(sigma + g) + Math.sqrt((sigma - g) ** 2 + 4 * sigma * g * 2.5)) / 2;
  assert.ok(Math.abs(growthRate(params) - expected) / expected < 0.03);
  assert.ok(Math.abs(doublingTime(params) - Math.LN2 / expected) < 0.2);
  assert.equal(doublingTime(epiParameters({ r0: 0.7 })), null);
});

test('establishment: k = 1 gives 1 − 1/R; superspreading makes it rarer', () => {
  assert.ok(Math.abs(establishmentProbability(2.5, 1) - (1 - 1 / 2.5)) < 1e-6);
  const poissonCase = establishmentProbability(2.5, Infinity);
  const spread = establishmentProbability(2.5, 0.1);
  assert.ok(poissonCase > establishmentProbability(2.5, 1));
  assert.ok(spread < 0.25, 'most single imports fizzle with k 0.1');
  assert.equal(establishmentProbability(0.9, 1), 0);
});

test('seasons and the vector gate follow the hemisphere and the tropics', () => {
  const jan = Date.UTC(2026, 0, 15);
  const jul = Date.UTC(2026, 6, 15);
  assert.ok(seasonalFactor(50, jan, 0.25) > 1.2);
  assert.ok(seasonalFactor(50, jul, 0.25) < 0.8);
  assert.ok(seasonalFactor(-40, jul, 0.25) > 1.2);
  assert.equal(seasonalFactor(5, jan, 0.25), 1);
  assert.equal(
    vectorSuitable(52, jan),
    false,
    'no mosquitoes in Irkutsk in January',
  );
  assert.equal(vectorSuitable(10, jan), true);
  assert.equal(vectorSuitable(40, jul), true);
});

test('effective distance ranks the busiest route first', () => {
  const flows = new Map([
    [
      'A',
      new Map([
        ['B', 900],
        ['C', 100],
      ]),
    ],
    ['B', new Map([['D', 100]])],
    ['C', new Map([['D', 100]])],
  ]);
  const d = effectiveDistances(flows, ['A']);
  assert.equal(d.get('A'), 0);
  assert.ok(d.get('B') < d.get('C'));
  assert.ok(Math.abs(d.get('B') - (1 - Math.log(0.9))) < 1e-9);
  assert.ok(Math.abs(d.get('D') - (d.get('B') + 1)) < 1e-9, 'via B');
});

test('commuting: near and big neighbours take more; borders damp it', () => {
  const nodes = [
    { lat: 45, lon: 0, population: 1_000_000, country: 'FR' },
    { lat: 45.3, lon: 0, population: 500_000, country: 'FR' },
    { lat: 46.5, lon: 0, population: 500_000, country: 'FR' },
    { lat: 45, lon: 0.4, population: 500_000, country: 'ES' },
    { lat: 60, lon: 0, population: 500_000, country: 'FR' },
  ];
  const links = gravityLinks(nodes);
  const share = (i, j) => links[i].find((l) => l.j === j)?.share ?? 0;
  assert.ok(share(0, 1) > share(0, 2), 'nearer');
  assert.ok(share(0, 1) > share(0, 3), 'the border');
  assert.equal(share(0, 4), 0, 'too far');
  const out = links[0].reduce((s, l) => s + l.share, 0);
  assert.ok(out > 0 && out < 0.1);
});

test('the places: cities fold into their airport; loose ones stay; patient zero is placed', () => {
  const { nodes, origins, fallback } = buildEpidemicNodes({
    airports: [
      {
        code: 'UIII',
        name: 'Irkutsk',
        lat: 52.268,
        lon: 104.389,
        kind: 'M',
        country: 'RU',
      },
      { code: 'ZZZZ', name: 'Far', lat: 10, lon: 10, kind: 'L', country: 'NG' },
    ],
    cities: [
      {
        id: 1,
        name: 'Irkutsk',
        lat: 52.297,
        lon: 104.296,
        country: 'RU',
        population: 600_000,
      },
      {
        id: 2,
        name: 'Shelekhov',
        lat: 52.21,
        lon: 104.1,
        country: 'RU',
        population: 47_000,
      },
      {
        id: 3,
        name: 'Usolye-Sibirskoye',
        lat: 52.75,
        lon: 103.65,
        country: 'RU',
        population: 75_000,
      },
      {
        id: 4,
        name: 'Nowhere',
        lat: -40,
        lon: -100,
        country: 'XX',
        population: 50_000,
      },
    ],
    locations: [
      { id: 'irkutsk', name: 'Irkutsk, Russia', lat: 52.287, lon: 104.305 },
    ],
  });
  assert.equal(fallback, false);
  const irk = nodes.find((n) => n.id === 'UIII');
  assert.equal(irk.population, 647_000);
  assert.equal(
    nodes.find((n) => n.id === 'ZZZZ').population,
    2_000_000,
    'no city data: by size',
  );
  assert.ok(
    nodes.some((n) => n.id === 'g3'),
    'Usolye (over 60 km) commutes in',
  );
  assert.ok(!nodes.some((n) => n.id === 'g4'), 'far from everything: left out');
  assert.deepEqual(origins, [nodes.indexOf(irk)]);
});

/** A small world: patient zero's city, its airport hub, and two cities flown to. */
function world({ flightsPerDay = 6, days = 6 } = {}) {
  const nodes = [
    {
      id: 'A',
      code: 'AAA',
      name: 'Origin',
      lat: 30,
      lon: 100,
      population: 2_000_000,
      kind: 'airport',
    },
    {
      id: 'B',
      code: 'BBB',
      name: 'Busy',
      lat: 35,
      lon: 110,
      population: 3_000_000,
      kind: 'airport',
    },
    {
      id: 'C',
      code: 'CCC',
      name: 'Quiet',
      lat: 20,
      lon: 80,
      population: 1_000_000,
      kind: 'airport',
    },
  ];
  const flights = [];
  for (let d = 0; d < days; d += 1)
    for (let k = 0; k < flightsPerDay; k += 1) {
      const departMs = START + d * DAY + k * (DAY / flightsPerDay);
      flights.push({
        from: 0,
        to: 1,
        departMs,
        arriveMs: departMs + 3 * HOUR,
        passengers: 300,
      });
      if (k === 0)
        flights.push({
          from: 0,
          to: 2,
          departMs,
          arriveMs: departMs + 4 * HOUR,
          passengers: 150,
        });
    }
  return { nodes, flights };
}

test('the ensemble: busier routes arrive likelier and sooner; same seed, same result', () => {
  const { nodes, flights } = world();
  const params = epiParameters({
    ...presetValues('covid2020'),
    initialCases: 300,
  });
  const run = (extra = {}) =>
    simulateEpidemic({
      nodes,
      origins: [0],
      flights,
      params,
      startMs: START,
      untilMs: START + 6 * DAY,
      runs: 60,
      seed: 99,
      links: nodes.map(() => []),
      ...extra,
    });
  const first = run();
  const again = run();
  assert.deepEqual(first, again, 'repeatable from its seed');
  const busy = first.places.find((p) => p.id === 'B');
  const quiet = first.places.find((p) => p.id === 'C');
  assert.ok(busy.pArrive >= quiet.pArrive);
  assert.ok(busy.etaP50 <= (quiet.etaP50 ?? Infinity));
  assert.ok(first.places.find((p) => p.id === 'A').origin);
  assert.equal(first.runs, 60);
  assert.ok(first.totals.at(-1).p50 > 300);
  assert.ok(arrivedBy(busy, first.hours) > 0.5);
  assert.equal(arrivedBy(busy, -1), 0);
  assert.ok(epidemicLines(first).some((line) => line.startsWith('BBB Busy')));

  // A 95 % travel restriction from hour 0 makes arrival rarer or later.
  const banned = simulateEpidemic({
    nodes,
    origins: [0],
    flights,
    params: epiParameters({
      ...presetValues('covid2020'),
      initialCases: 300,
      travelBanPct: 95,
      interventionHour: 0,
    }),
    startMs: START,
    untilMs: START + 6 * DAY,
    runs: 60,
    seed: 99,
    links: nodes.map(() => []),
  });
  const bannedBusy = banned.places.find((p) => p.id === 'B');
  assert.ok(
    !bannedBusy ||
      bannedBusy.pArrive < busy.pArrive ||
      (bannedBusy.etaP50 ?? Infinity) > busy.etaP50,
  );
});

test('one place, a long run: the final size matches 1 − z = e^(−R0 z)', () => {
  const nodes = [
    { id: 'X', name: 'X', lat: 0, lon: 0, population: 200_000, kind: 'city' },
  ];
  const params = {
    ...epiParameters({
      r0: 2,
      incubationDays: 3,
      latentDays: 3,
      infectiousDays: 5,
      asymptomaticPct: 0,
      initialCases: 200,
    }),
    isolation: 0,
    k: Infinity,
    seasonAmplitude: 0,
  };
  const result = simulateEpidemic({
    nodes,
    origins: [0],
    params,
    startMs: START,
    untilMs: START + 200 * DAY,
    runs: 1,
    seed: 3,
    links: [[]],
  });
  const z = result.places[0].casesP50 / 200_000;
  assert.ok(Math.abs(z - 0.797) < 0.02, `final size ${z}`);
});

test('the time limit stops early with the runs done', () => {
  const { nodes, flights } = world();
  let clock = 0;
  const result = simulateEpidemic({
    nodes,
    origins: [0],
    flights,
    params: epiParameters({ r0: 2 }),
    startMs: START,
    untilMs: START + 2 * DAY,
    runs: 50,
    budgetMs: 10,
    now: () => (clock += 6),
    links: nodes.map(() => []),
  });
  assert.equal(result.partial, true);
  assert.ok(result.runs >= 1 && result.runs < 50);
});

test('the default profile mirrors the Irkutsk outbreak as new: every field valid, nothing dropped', () => {
  const kept = {
    ...cleanProfile(OUTBREAK_DEFAULT_PROFILE),
    ...cleanEpiProfile(OUTBREAK_DEFAULT_PROFILE),
  };
  assert.deepEqual(kept, { ...OUTBREAK_DEFAULT_PROFILE });
  assert.equal(OUTBREAK_DEFAULT_PROFILE.preset, 'novel');
  assert.equal(OUTBREAK_DEFAULT_PROFILE.immunity, 'novel');
  assert.equal(OUTBREAK_DEFAULT_PROFILE.density, '500k-1m');
  const params = epiParameters(OUTBREAK_DEFAULT_PROFILE);
  assert.ok(params.rEffective > 2 && params.rEffective < 3);
  assert.ok(doublingTime(params) > 2 && doublingTime(params) < 8);
  assert.equal(params.initialCases, 50);
});

test('the box says what moves R from R0, and the parts multiply back to it', () => {
  const params = epiParameters({
    ...OUTBREAK_DEFAULT_PROFILE,
    r0: 1.3,
    immunity: 'partial',
    compliance: 'high',
  });
  const labels = params.rFactors.map((f) => f.label);
  assert.deepEqual(labels, [
    'compliance high',
    'immunity partial',
    'healthcare medium',
  ]);
  const product = params.rFactors.reduce((r, f) => r * f.factor, 1.3);
  assert.ok(Math.abs(product - params.rEffective) < 0.01);
  assert.deepEqual(
    epiParameters({ r0: 2 }).rFactors,
    [],
    'nothing set: R is R0',
  );
});

/** One busy city and one it flies to daily; no commuting. */
function pair(extra = {}) {
  return {
    nodes: [
      {
        id: 'A',
        code: 'AAA',
        name: 'A',
        lat: 10,
        lon: 10,
        population: 1_000_000,
        kind: 'airport',
      },
      {
        id: 'B',
        code: 'BBB',
        name: 'B',
        lat: 12,
        lon: 14,
        population: 1_000_000,
        kind: 'airport',
      },
    ],
    origins: [0],
    links: [[], []],
    startMs: START,
    seed: 4,
    ...extra,
  };
}

test('daily routes fly every day to the end of a long window, except where the scan already flew', () => {
  const params = epiParameters({
    ...presetValues('covid2020'),
    initialCases: 2000,
  });
  const route = {
    from: 0,
    to: 1,
    timeOfDayMs: 6 * HOUR,
    lengthMs: 2 * HOUR,
    passengers: 500,
  };
  const late = simulateEpidemic({
    ...pair(),
    params,
    routes: [route],
    untilMs: START + 30 * DAY,
    runs: 20,
  });
  const b = late.places.find((p) => p.id === 'B');
  assert.ok(b.pArrive > 0.9, 'the route keeps flying');
  assert.equal(late.totals.length, 30, 'one point a day for 30 days');
  // Every departure in the window marked as already flown: nothing flies.
  const flown = [];
  for (let d = 0; d < 30; d += 1)
    flown.push(`0>1|${Math.round((START + d * DAY + 6 * HOUR) / 1_800_000)}`);
  const none = simulateEpidemic({
    ...pair(),
    params,
    routes: [route],
    flown,
    untilMs: START + 30 * DAY,
    runs: 20,
  });
  assert.equal(
    none.places.some((p) => p.id === 'B'),
    false,
  );
});

test('reported cases are fewer and later than infections; a strong response and full hospitals change the curve', () => {
  const run = (profile, until = 40) =>
    simulateEpidemic({
      ...pair(),
      params: epiParameters({
        ...presetValues('covid2020'),
        initialCases: 500,
        ...profile,
      }),
      untilMs: START + until * DAY,
      runs: 10,
    });
  const base = run({ healthcare: 'medium' });
  const s = base.summary;
  assert.ok(
    s.reportedP50 > 0 && s.reportedP50 < s.infectedP50 * 0.4,
    'about 30 % of the symptomatic',
  );
  const a = base.places.find((p) => p.id === 'A');
  assert.ok(
    a.reportP50 >= 4 * 24,
    'the first report comes days after the first cases',
  );
  assert.equal(s.reportDays, 4);
  // People pulling back as reports rise: fewer infected.
  const careful = run({ healthcare: 'medium', response: 'strong' });
  assert.ok(careful.summary.infectedP50 < s.infectedP50 * 0.8);
  // A severe disease swamps hospitals: more deaths than its fatality share.
  const severe = run(
    { healthcare: 'low', hospitalPct: 40, fatalityPct: 5, r0: 4 },
    60,
  );
  const sym = severe.summary.infectedP50 * (1 - 0.35);
  assert.ok(severe.summary.deathsP50 > sym * 0.05, 'beds run out: more die');
  assert.ok(severe.summary.placesOverwhelmed >= 1);
  assert.ok(
    severe.totals.every(
      (t, i) => i === 0 || t.deathsP50 >= severe.totals[i - 1].deathsP50,
    ),
  );
});

test('a place few runs reach still has its timing: its chance grows from its first arrival to all of it', () => {
  const rare = {
    pArrive: 0.03,
    arrivalHours: [100, ...Array(20).fill(null)],
    arrivalGiven: Array.from({ length: 21 }, (_, i) => 100 + i * 5),
  };
  assert.equal(arrivedBy(rare, 50), 0);
  assert.ok(arrivedBy(rare, 100) > 0, 'there from its first arrival');
  assert.ok(Math.abs(arrivedBy(rare, 150) - (0.03 * 11) / 21) < 1e-9);
  assert.equal(arrivedBy(rare, 500), 0.03);
  let last = 0;
  for (let h = 90; h <= 210; h += 1) {
    const share = arrivedBy(rare, h);
    assert.ok(share >= last, 'never falls');
    last = share;
  }
});

test('the world air network: every scheduled airport flies its normal routes; a scanned one flies its real flights instead', () => {
  const airports = [
    {
      code: 'AAAA',
      kind: 'L',
      country: 'RU',
      continent: 'AS',
      lat: 52,
      lon: 104,
    },
    {
      code: 'BBBB',
      kind: 'L',
      country: 'RU',
      continent: 'AS',
      lat: 55,
      lon: 83,
    },
    {
      code: 'CCCC',
      kind: 'M',
      country: 'RU',
      continent: 'AS',
      lat: 56,
      lon: 93,
    },
    {
      code: 'DDDD',
      kind: 'S',
      country: 'RU',
      continent: 'AS',
      lat: 51.8,
      lon: 107.4,
    },
  ];
  const scheduled = airports.filter((a) => a.kind !== 'S');
  const routes = worldAirRoutes(airports, scheduled);
  const from = (code) => routes.filter((r) => r.from === code);
  for (const a of airports)
    assert.ok(from(a.code).length > 0, a.code + ' flies');
  assert.ok(routes.every((r) => r.lengthMs > 0 && r.passengers > 0));
  assert.deepEqual(
    worldAirRoutes(airports, scheduled),
    routes,
    'the same every time',
  );
  const departMs = START + 5 * HOUR;
  const scan = [
    {
      from: airports[0],
      to: airports[1],
      departMs,
      arriveMs: departMs + 3 * HOUR,
    },
  ];
  const withScan = worldAirRoutes(airports, scheduled, scan);
  assert.deepEqual(
    withScan
      .filter((r) => r.from === 'AAAA')
      .map((r) => [r.to, r.timeOfDayMs, r.lengthMs]),
    [['BBBB', 5 * HOUR, 3 * HOUR]],
  );
});
