// The GLOBAL ABUNDANCE MAP's forecast (src/abundanceForecast.mjs): the
// spaces each figure walks in, a history's trend and swing, the frontier
// and the shrinkage toward the level's typical figures, today's places as
// a lookup, the counted draws, the crisis regimes, the simulation of a
// level on both scales and the detail of one place (the same numbers), the
// scenarios, the hindcast and the worker's protocol. Hermetic: fixture
// units, no worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABUNDANT_SCORE,
  DOLLAR_INFLATION,
  FORECAST_DEFAULT_RUNS,
  FORECAST_PROCESSES,
  FORECAST_RUNS,
  FORECAST_SCALES,
  FORECAST_SCENARIOS,
  FORECAST_VIEWS,
  FORECAST_YEARS,
  HINDCAST_YEARS,
  LOCAL_REGIME,
  PRIOR_STEPS,
  SCARCE_SCORE,
  SCALE_MAX,
  SCENARIO_PARAMS,
  SHIFT_SWINGS,
  WORLD_REGIME,
  buildPlan,
  cleanForecastView,
  cleanRuns,
  cleanScale,
  cleanScenario,
  cleanYear,
  createForecastHandler,
  detailFor,
  draw,
  forecastAt,
  frontierDrift,
  fromX,
  hindcast,
  hindcastScales,
  hindcastShifts,
  inverseNormal,
  measuredAtOf,
  normalTable,
  peopleOf,
  placeAt,
  placeKey,
  placeTable,
  priorFor,
  processFor,
  quantile,
  regimeFor,
  regimeMeanImpulse,
  regimeStep,
  runsFor,
  seriesKey,
  seriesOf,
  seriesParams,
  seriesStats,
  seriesSummary,
  simulate,
  stringSeed,
  toX,
  transferables,
  trendPath,
  typicalModel,
  viewRampScore,
  viewValue,
  worldAt,
} from './abundanceForecast.mjs';
import { ABUNDANCE_INDICATOR_IDS, indicatorById, scoreUnits } from './abundanceCore.mjs';

const T1 = FORECAST_YEARS + 1;
const points = (list) => list.map(([year, value]) => ({ year, value }));
const close = (a, b, eps = 1e-9, what = '') => assert.ok(Math.abs(a - b) < eps, `${what} ${a} ≈ ${b}`);

/** A history of one point a year from `from` to `to`, growing by `rate` a year in the walking space, with a wobble; `bend` adds to the rate from `bendFrom` on (a decade that broke the trend). */
function grown(id, start, rate, from = 2000, measuredAt = 'country', wobble = 0, to = 2024, bend = 0, bendFrom = 2014) {
  const process = processFor(id, measuredAt);
  const out = [];
  let x = toX(process, start);
  for (let year = from; year <= to; year++) {
    out.push({ year, value: fromX(process, x) });
    x += rate + (year >= bendFrom ? bend : 0) + wobble * Math.sin(year * 1.7);
  }
  return out;
}

/** A figure with its history, as the server sends it; `upTo` keeps the points to a year (the hindcast's past). */
function figure(id, history, from = 'own', measuredAt = 'country', upTo = null) {
  const kept = upTo ? history.filter((p) => p.year <= upTo) : history;
  const latest = kept.reduce((a, b) => (b.year > a.year ? b : a));
  const stats = seriesStats(indicatorById(id), kept, measuredAt);
  const out = { v: latest.value, year: latest.year, from, n: stats.n, m: stats.m };
  if (stats.g !== null) out.g = stats.g;
  if (stats.s !== null) out.s = stats.s;
  return out;
}

/** Six countries with GDP (growth), WORK (a return to the usual level) and WATER (a ceiling, one at it), as of a year, with their people. */
function countries(upTo = null) {
  const gdp = [60000, 45000, 30000, 20000, 8000, 2000];
  const work = [3, 5, 6, 8, 12, 20];
  const water = [100, 99, 95, 90, 70, 40];
  const growth = [0.03, 0.04, 0.05, 0.06, 0.07, 0.02];
  const people = [5e6, 60e6, 300e6, 1.4e9, 200e6, 20e6];
  return gdp
    .map((v, k) => ({
      id: `C${k}`,
      name: `Country ${k}`,
      iso2: `C${k}`,
      country: `Country ${k}`,
      lat: k * 10,
      lon: k * 10,
      people: people[k],
      values: {
        gdp: figure('gdp', grown('gdp', v / Math.exp(growth[k] * 24), growth[k], 2000, 'country', 0.03), 'own', 'country', upTo),
        work: figure('work', grown('work', work[k], 0, 2000, 'country', 0.1), 'own', 'country', upTo),
        water: figure(
          'water',
          water[k] === 100 ? points([[2024, 100], [2019, 100], [2014, 100]]) : grown('water', water[k] - 5, 0.05, 2000, 'country', 0.02),
          'own',
          'country',
          upTo,
        ),
      },
    }))
    .concat([{ id: 'NONE', name: 'Noland', iso2: 'NO', country: 'Noland', lat: 0, lon: 0, values: {} }]);
}

test('the horizon, the runs, the views, the scales, the scenarios and the processes', () => {
  assert.equal(FORECAST_YEARS, 100);
  assert.deepEqual(FORECAST_RUNS, [100, 250, 500, 1000, 2000]);
  assert.equal(cleanYear('25'), 25);
  assert.equal(cleanYear(250), 100);
  assert.equal(cleanYear(-3), 0);
  assert.equal(cleanYear('x'), 0);
  assert.equal(cleanRuns(500), 500);
  assert.equal(cleanRuns(300), null);
  assert.equal(runsFor('country', null), FORECAST_DEFAULT_RUNS.country);
  assert.equal(runsFor('city', 2000), 2000);
  assert.equal(runsFor('planet', null), 100);
  assert.deepEqual(FORECAST_VIEWS, ['p50', 'p10', 'p90', 'up', 'down', 'change']);
  assert.equal(cleanForecastView('up'), 'up');
  assert.equal(cleanForecastView('nope'), 'p50');
  assert.deepEqual(FORECAST_SCALES, ['today', 'others']);
  assert.equal(cleanScale('others'), 'others');
  assert.equal(cleanScale('x'), 'today');
  assert.deepEqual(FORECAST_SCENARIOS, ['baseline', 'optimistic', 'pessimistic', 'volatile']);
  assert.equal(cleanScenario('volatile'), 'volatile');
  assert.equal(cleanScenario(''), 'baseline');
  assert.equal(SCENARIO_PARAMS.optimistic.growth, 0.025);
  // Every indicator has a process, of a known family, with a prior and shares that leave the figure some swing of its own.
  for (const id of ABUNDANCE_INDICATOR_IDS) {
    const p = FORECAST_PROCESSES[id];
    assert.ok(['growth', 'floor', 'ceiling', 'revert'].includes(p.family), id);
    assert.ok(Number.isFinite(p.prior.s) && p.prior.s > 0, `${id} has a swing prior`);
    const shares = p.shares.world + p.shares.country + p.shares.place;
    assert.ok(shares >= 0 && shares < 1, `${id} shares ${shares}`);
    if (p.family !== 'revert') {
      assert.ok(p.frontier && p.frontier.q > 0 && p.frontier.q < 1, `${id} frontier`);
      assert.ok(p.beta >= 0, `${id} pull`);
    }
  }
  // A level's own measure where the source measures something else.
  assert.equal(processFor('green', 'country').family, 'ceiling');
  assert.equal(processFor('green', 'city').family, 'growth');
  assert.equal(processFor('education', 'region').cap, 100);
  assert.equal(processFor('education', 'country').cap, 160);
  assert.equal(processFor('nope', 'country'), null);
  assert.equal(measuredAtOf('city', 'own'), 'city');
  assert.equal(measuredAtOf('city', 'csv'), 'city');
  assert.equal(measuredAtOf('city', 'region'), 'region');
  assert.equal(measuredAtOf('city', 'area'), 'region');
  assert.equal(measuredAtOf('region', 'country'), 'country');
  // The frontier's move a year: the scenario's growth for money, the pace for the rest.
  assert.equal(frontierDrift(processFor('gdp'), 'baseline'), 0.015);
  assert.equal(frontierDrift(processFor('gdp'), 'pessimistic'), 0.005);
  close(frontierDrift(processFor('health'), 'optimistic'), -0.015);
  assert.equal(frontierDrift(processFor('work'), 'baseline'), 0);
});

test('each family walks in its own space and comes back: logs, a log above a floor, a logit below a ceiling, a level', () => {
  const gdp = processFor('gdp');
  close(fromX(gdp, toX(gdp, 12345)), 12345);
  close(toX(gdp, Math.E), 1);
  const health = processFor('health');
  close(fromX(health, toX(health, 7.5)), 7.5);
  close(toX(health, 0), Math.log(0.02), 1e-9);
  const water = processFor('water');
  close(fromX(water, toX(water, 42)), 42);
  close(fromX(water, toX(water, 100)), 99.5, 1e-9);
  const inflation = processFor('inflation');
  assert.equal(toX(inflation, -1.5), -1.5);
  assert.equal(fromX(inflation, 4), 4);
  const work = processFor('work');
  close(fromX(work, toX(work, 5.5)), 5.5);
  close(toX(work, 0), Math.log(0.05));
});

test('a history gives its trend (the latest steps weighing most), swing, steps and mean; gaps and repeated years are handled', () => {
  // GDP growing 5 % a year (in logs) for 24 steps: the trend is 0.05, the swing 0.
  const steady = seriesStats(indicatorById('gdp'), grown('gdp', 10000, 0.05));
  assert.equal(steady.n, 24);
  close(steady.g, 0.05, 1e-6);
  assert.equal(steady.s, 0);
  close(steady.m, Math.log(10000) + 0.05 * 12, 1e-6);
  // A wobble gives a swing; the trend is near the rise over the span.
  const wobbly = seriesStats(indicatorById('gdp'), grown('gdp', 10000, 0.05, 2000, 'country', 0.03));
  assert.ok(wobbly.s > 0.02 && wobbly.s < 0.05, `swing ${wobbly.s}`);
  assert.ok(Math.abs(wobbly.g - 0.05) < 0.015, `trend ${wobbly.g}`);
  // A trend that turned: the latest years weigh most (a step twelve years back counts half).
  const turned = seriesStats(indicatorById('gdp'), [...grown('gdp', 10000, 0.08, 2000, 'country', 0, 2012), ...grown('gdp', fromX(processFor('gdp'), Math.log(10000) + 0.08 * 13), 0.01, 2013, 'country', 0, 2024)]);
  assert.ok(turned.g < 0.045 && turned.g > 0.01, `the recent 1 % weighs more than the old 8 %: ${turned.g}`);
  // Two points five years apart: one step, the trend over the gap, no swing.
  const two = seriesStats(indicatorById('gdp'), points([[2024, 50000], [2019, 40000]]));
  assert.deepEqual(two, { g: Math.round((Math.log(1.25) / 5) * 1e6) / 1e6, s: null, n: 1, m: Math.round(((Math.log(50000) + Math.log(40000)) / 2) * 1e6) / 1e6 });
  // One point: a mean, no trend; none: nothing; a repeated year counts once; an unknown indicator has no process.
  assert.deepEqual(seriesStats(indicatorById('inflation'), points([[2025, 2.5]])), { g: null, s: null, n: 0, m: 2.5 });
  assert.equal(seriesStats(indicatorById('gdp'), []), null);
  assert.equal(seriesStats(indicatorById('gdp'), points([[2024, 1], [2024, 2], [2023, 1]])).n, 1);
  assert.equal(seriesStats({ id: 'nope' }, points([[2024, 1]])), null);
  // A gap of four years between steps: the swing counts the gap's square root.
  const gapped = seriesStats(indicatorById('inflation'), points([[2020, 2], [2024, 6], [2025, 7]]));
  assert.equal(gapped.n, 2);
  assert.equal(gapped.g, 1);
  assert.equal(gapped.s, 0, 'both steps are 1 a year');
  // The level's own measure: a city's green space walks in logs, a country's forest in logits.
  const city = seriesStats(indicatorById('green'), points([[2021, 101], [2022, 111], [2023, 121]]), 'city');
  assert.equal(city.n, 2);
  assert.ok(city.g > 0.08 && city.g < 0.1);
  const country = seriesStats(indicatorById('green'), points([[2021, 30], [2022, 31]]), 'country');
  close(country.g, toX(processFor('green'), 31) - toX(processFor('green'), 30), 1e-6);
  // A quantile between two values.
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([5], 0.9), 5);
  assert.equal(quantile([], 0.5), null);
});

test('the level speaks through the priors, and a series is shrunk toward them, pulled toward the frontier, its own residual fading', () => {
  const gdp = processFor('gdp');
  assert.deepEqual(priorFor(gdp, []), gdp.prior, 'no histories: the process assumptions');
  assert.deepEqual(priorFor(gdp, [{ n: 10, g: 0.09, s: 0.2 }]), gdp.prior, 'too few to say');
  const five = [0.01, 0.02, 0.03, 0.04, 0.09].map((g, k) => ({ n: 10, g, s: 0.1 + k / 100, m: 10 }));
  const prior = priorFor(gdp, five);
  assert.equal(prior.g, 0.03, 'the median trend');
  close(prior.s, 0.12, 1e-12, 'the median swing');
  const smooth = five.map((f) => ({ ...f, s: 0.004 }));
  assert.equal(priorFor(gdp, smooth).s, gdp.prior.s, 'interpolated histories show no swing: the assumed one is the floor');
  const inflation = processFor('inflation');
  const levels = [2, 3, 4, 5, 20].map((m) => ({ n: 3, g: 0, s: 1, m }));
  assert.equal(priorFor(inflation, levels).m, 4, 'the median level for a returning indicator');
  assert.equal(priorFor(gdp, levels).m, undefined, 'no level for a walking one');
  // A series below the frontier: the frontier's move and pull, plus what its history did beyond that, shrunk and bounded.
  const frontier = Math.log(60000);
  const p = seriesParams(gdp, { v: 10000, g: 0.065, s: 0.1, n: 4, m: 9 }, { g: 0.045, s: 0.05, residual: 0 }, { frontier, scenario: 'baseline' });
  assert.equal(p.frontier, frontier);
  assert.equal(p.muF, 0.015);
  assert.equal(p.beta, gdp.beta);
  const predicted = 0.015 + gdp.beta * (frontier - Math.log(10000));
  const own = 0.065 - DOLLAR_INFLATION;
  close(p.residual, (4 * (own - predicted)) / (4 + PRIOR_STEPS), 1e-12, 'the residual shrunk toward 0');
  close(p.sigma, Math.sqrt((4 * 0.01 + PRIOR_STEPS * 0.0025) / (4 + PRIOR_STEPS)), 1e-12);
  assert.equal(p.decay, Math.pow(0.5, 1 / gdp.halfLife));
  assert.equal(p.n, 4);
  assert.equal(p.theta, 0);
  // A scenario moves the frontier; the hindcast's scale widens the swing; a wild history is bounded.
  assert.equal(seriesParams(gdp, { v: 10000 }, gdp.prior, { frontier, scenario: 'optimistic' }).muF, 0.025);
  close(seriesParams(gdp, { v: 10000 }, { g: 0.045, s: 0.05 }, { frontier, scale: 1.5 }).sigma, 0.075, 1e-12);
  close(seriesParams(gdp, { v: 10000 }, { g: 0.045, s: 0.05 }, { frontier, scale: 12 }).sigma, SCALE_MAX * 0.05, 1e-12, 'ten times at most');
  assert.equal(SCALE_MAX, 10);
  const bare = seriesParams(gdp, { v: 10000 }, { g: 0.045, s: 0.05, residual: 0.004 }, { frontier });
  assert.equal(bare.sigma, 0.05);
  assert.equal(bare.residual, 0.004, 'no history: the level’s typical residual');
  const wild = seriesParams(gdp, { v: 10000, g: 0.9, s: 5, n: 30 }, { g: 0.045, s: 0.05 }, { frontier });
  assert.equal(wild.sigma, 0.2, 'four times the typical swing at most');
  assert.equal(wild.residual, 0.06, 'the residual bounded');
  // The hindcast's trend shift rides on every family, within SHIFT_SWINGS typical swings a year.
  assert.equal(p.shift, 0, 'no hindcast, no shift');
  assert.equal(seriesParams(gdp, { v: 10000 }, gdp.prior, { frontier, shift: 0.008 }).shift, 0.008);
  close(seriesParams(gdp, { v: 10000 }, gdp.prior, { frontier, shift: 0.05 }).shift, SHIFT_SWINGS * 0.05, 1e-12, 'two per cent a year at most for money');
  close(seriesParams(gdp, { v: 10000 }, gdp.prior, { frontier, shift: -0.05 }).shift, -SHIFT_SWINGS * 0.05, 1e-12);
  // A share at its ceiling stays there, shift or no shift; a returning indicator keeps its usual level, shrunk, and takes a shift within its own typical swing.
  const full = seriesParams(processFor('water'), { v: 100, g: 0.3, s: 0.1, n: 5 }, processFor('water').prior, { frontier: 3, shift: 0.01 });
  assert.equal(full.saturated, true);
  assert.equal(full.sigma, 0);
  assert.equal(full.beta, 0);
  assert.equal(full.exposure, 0);
  assert.equal(full.shift, 0);
  const revert = seriesParams(processFor('inflation'), { v: 9, g: 0, s: 2, n: 8, m: 5 }, { g: 0, s: 2.5, m: 3 });
  assert.equal(revert.theta, 0.35);
  close(revert.xbar, (8 * 5 + PRIOR_STEPS * 3) / (8 + PRIOR_STEPS), 1e-12, 'the usual level, shrunk');
  assert.equal(revert.decay, 1);
  assert.equal(revert.beta, 0);
  assert.equal(revert.shift, 0);
  close(seriesParams(processFor('inflation'), { v: 9, n: 0 }, { g: 0, s: 2.5, m: 3 }, { shift: 3 }).shift, SHIFT_SWINGS * 2.5, 1e-12, 'a point a year at most for inflation');
});

test('a figure handed down rides the series of the place it came from; the draws are counted', () => {
  const city = { id: '7', iso2: 'CA', country: 'Canada', adm1: 'Ontario' };
  assert.equal(seriesKey(city, 'gdp', { from: 'own' }), 'gdp|u:7');
  assert.equal(seriesKey(city, 'gdp', { from: 'csv' }), 'gdp|u:7');
  assert.equal(seriesKey(city, 'inflation', { from: 'country' }), 'inflation|c:CA');
  assert.equal(seriesKey(city, 'life', { from: 'region' }), 'life|r:CA/Ontario');
  assert.equal(seriesKey(city, 'life', { from: 'area', v: 80, year: 2023 }), 'life|a:CA:80:2023');
  assert.equal(seriesKey({ id: 'CAN', country: 'Canada' }, 'gdp', { from: 'country' }), 'gdp|c:Canada');
  assert.equal(placeKey(city, { from: 'region' }), 'r:CA/Ontario');
  assert.equal(stringSeed('gdp|u:7'), stringSeed('gdp|u:7'));
  assert.notEqual(stringSeed('gdp|u:7'), stringSeed('gdp|u:8'));
  assert.equal(draw(1, 2, 3), draw(1, 2, 3));
  assert.notEqual(draw(1, 2, 3), draw(1, 2, 4));
  assert.notEqual(draw(1, 2, 3), draw(1, 3, 3));
  assert.notEqual(draw(2, 2, 3), draw(1, 2, 3));
  // Sixteen bits of a draw index the normal table: mean 0, spread 1, symmetric.
  const table = normalTable();
  assert.equal(table.length, 65536);
  let sum = 0;
  let squares = 0;
  for (const z of table) {
    sum += z;
    squares += z * z;
  }
  assert.ok(Math.abs(sum / table.length) < 1e-4);
  assert.ok(Math.abs(squares / table.length - 1) < 1e-3);
  assert.ok(Math.abs(table[32767] + table[32768]) < 1e-6);
  assert.ok(Math.abs(inverseNormal(0.5)) < 1e-12);
  assert.ok(Math.abs(inverseNormal(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(inverseNormal(0.001) + 3.090232) < 1e-5);
  // Many draws' high halves spread evenly over the table.
  const buckets = new Uint32Array(16);
  for (let k = 0; k < 20000; k++) buckets[draw(99, k, 7) >>> 28] += 1;
  for (const count of buckets) assert.ok(count > 1000 && count < 1500, `bucket ${count}`);
});

test('crises are regimes: a crisis year or two, then a partial recovery, as often and as deep as the scenario says', () => {
  const world = regimeFor(WORLD_REGIME, 'baseline');
  assert.deepEqual(world, WORLD_REGIME);
  const volatile = regimeFor(WORLD_REGIME, 'volatile');
  assert.equal(volatile.enter, WORLD_REGIME.enter * 2);
  assert.equal(volatile.cutMin, WORLD_REGIME.cutMin * 1.5);
  assert.equal(regimeFor(LOCAL_REGIME, 'optimistic').enter, LOCAL_REGIME.enter / 2);
  // The mean impulse a year is a cut net of the rebounds, from the chain's stationary shares.
  const mean = regimeMeanImpulse(world);
  assert.ok(mean < 0 && mean > -0.01, `${mean}`);
  assert.ok(regimeMeanImpulse(volatile) < mean, 'more and deeper crises cut more');
  assert.equal(regimeMeanImpulse({ ...world, enter: 0 }), 0);
  // One year of the chain: from normal, a draw under `enter` starts a crisis with a cut; a crisis persists or
  // turns to recovery with a rebound; recovery counts down to normal.
  const out = [0, 0];
  const high = 0xffff0000;
  const low = 0x00000000;
  assert.deepEqual(regimeStep(0, high, world, out), [0, 0]);
  assert.deepEqual(regimeStep(0, low, world, out), [1, -world.cutMin]);
  assert.deepEqual(regimeStep(0, 0x0000ffff, world, out).map((v, i) => (i ? Math.round(v * 1e4) / 1e4 : v)), [1, -Math.round((world.cutMin + world.cutSpan * (65535 / 65536)) * 1e4) / 1e4]);
  assert.deepEqual(regimeStep(1, low, world, out), [1, -world.cutMin], 'a crisis that persists');
  assert.deepEqual(regimeStep(1, high, world, out), [3, world.rebound], 'the first recovery year, two more to come');
  assert.deepEqual(regimeStep(3, high, world, out), [2, world.rebound]);
  assert.deepEqual(regimeStep(2, high, world, out), [0, world.rebound], 'the last recovery year');
  assert.deepEqual(regimeStep(1, high, { ...world, recovery: 0 }, out), [0, 0], 'no recovery years: straight back to normal');
  // Over many runs the chain's share of crisis years is the stationary one.
  let crisisYears = 0;
  let years = 0;
  for (let k = 0; k < 2000; k++) {
    let state = 0;
    for (let t = 1; t <= 100; t++) {
      regimeStep(state, draw(5, k, t), world, out);
      state = out[0];
      years += 1;
      if (state === 1) crisisYears += 1;
    }
  }
  const normal = 1 / (1 + world.enter / (1 - world.persist) + world.recovery * world.enter);
  const expected = (world.enter * normal) / (1 - world.persist);
  assert.ok(Math.abs(crisisYears / years - expected) < 0.01, `crisis years ${crisisYears / years} vs ${expected}`);
});

test('today’s figures become a lookup from a figure to its place: exact, between, past the ends, ties, reversed', () => {
  const table = placeTable([10, 20, 20, 30, 50], 'high');
  assert.equal(table.n, 5);
  assert.equal(placeAt(table, 10), 0);
  assert.equal(placeAt(table, 50), 100);
  assert.equal(placeAt(table, 30), 75);
  assert.ok(Math.abs(placeAt(table, 20) - 37.5) < 0.05, 'a tie shares its mean place');
  assert.ok(Math.abs(placeAt(table, 40) - 87.5) < 0.1, 'halfway between two figures, halfway between their places');
  assert.ok(Math.abs(placeAt(table, 25) - 56.25) < 0.1);
  assert.equal(placeAt(table, 5), 0, 'below the lowest');
  assert.equal(placeAt(table, 500), 100, 'above the highest');
  const low = placeTable([10, 20, 20, 30, 50], 'low');
  assert.equal(placeAt(low, 10), 100);
  assert.equal(placeAt(low, 50), 0);
  assert.ok(Math.abs(placeAt(low, 40) - 12.5) < 0.1);
  assert.equal(placeAt(placeTable([7], 'high'), 7), 50, 'one figure alone sits in the middle');
  assert.equal(placeAt(placeTable([3, 3, 3], 'high'), 3), 50);
  assert.equal(placeTable([], 'high'), null);
  assert.ok(Number.isNaN(placeAt(null, 1)));
});

test('a plan: distinct series, each place’s own and shared terms, the frontier, today’s exact scores, and the simulation on both scales', () => {
  const units = countries();
  const plan = buildPlan(units, ['gdp', 'work', 'water'], { gdp: 2 }, { level: 'country' });
  assert.equal(plan.level, 'country');
  assert.equal(plan.scenario, 'baseline');
  assert.deepEqual(plan.indicatorIds, ['gdp', 'water', 'work'], 'the catalogue’s order');
  assert.equal(plan.series.count, 18, 'six countries, three own series each');
  assert.equal(plan.groups.length, 0, 'nothing shared at the country level');
  assert.equal(plan.places.count, 6);
  assert.equal(plan.countries.count, 6);
  assert.equal(plan.tables.length, 3, 'one place table per indicator and space');
  assert.equal(plan.units.length, 7);
  assert.ok(Number.isNaN(plan.units[6].today), 'no figures, no score');
  // Every unit's people, for the ranks among the others and the world: the server's figure, the median where none.
  assert.deepEqual(Array.from(plan.people), [5e6, 60e6, 300e6, 1.4e9, 200e6, 20e6, 130e6]);
  assert.equal(plan.weighted, true);
  assert.equal(plan.members[0].total, 1985e6, 'the six scored countries’ people');
  assert.deepEqual(Array.from(peopleOf([{ people: 10 }, { people: 30 }, {}, { people: 0 }, { people: 20 }])), [10, 30, 20, 20, 20]);
  assert.deepEqual(Array.from(peopleOf([{}, { people: -1 }])), [1, 1], 'none known: each once');
  assert.equal(buildPlan([{ id: 'a', values: {} }], ['gdp']).weighted, false);
  const scores = scoreUnits(units, ['gdp', 'work', 'water'], undefined, { gdp: 2 });
  plan.units.slice(0, 6).forEach((u) => assert.equal(u.today, scores.get(u.id).score, `today is the ranking’s score for ${u.id}`));
  // The frontier: the 90th percentile of today's GDP in logs, the 10th of a floor family.
  close(plan.frontiers['gdp|country'], quantile(units.slice(0, 6).map((u) => Math.log(u.values.gdp.v)), 0.9), 1e-9);
  const gdp0 = seriesOf(plan, 'C0', 'gdp');
  assert.equal(plan.series.frontier[gdp0], plan.frontiers['gdp|country']);
  // A country-level series carries its country's shock as its place's: the country share folds into the place's.
  assert.equal(plan.series.loadCountry[gdp0], 0);
  assert.ok(plan.series.loadPlace[gdp0] > 0 && plan.series.loadWorld[gdp0] > 0 && plan.series.loadOwn[gdp0] > 0);
  const sigma = plan.series.sigma[gdp0];
  close(plan.series.loadWorld[gdp0] ** 2 + plan.series.loadPlace[gdp0] ** 2 + plan.series.loadOwn[gdp0] ** 2, sigma * sigma, 1e-12, 'the shares sum to the swing');
  // The country at 100 % water is saturated: its place is fixed.
  const water0 = seriesOf(plan, 'C0', 'water');
  assert.ok(water0 >= 0);
  assert.equal(plan.series.params[water0].saturated, true);
  assert.equal(plan.series.fixed[water0], scores.get('C0').ranks.water);
  assert.equal(seriesOf(plan, 'C0', 'nope'), -1);
  assert.equal(seriesOf(plan, 'ZZ', 'gdp'), -1);
  // A crisis's expected cut is given back as drift to the exposed series.
  assert.ok(plan.series.comp[gdp0] > 0);
  assert.equal(plan.series.comp[water0], 0);
  // The hindcast's trend shift: every series of the indicator carries it (a saturated share none), its trend
  // path moves by it, fading and pulled back, and the summary reads its part of the first year.
  const shiftMax = SHIFT_SWINGS * plan.priors['gdp|country'].s;
  assert.ok(shiftMax > 0.005, `the level's typical swing allows a shift of 0.005 (${shiftMax})`);
  const shifted = buildPlan(units, ['gdp', 'work', 'water'], { gdp: 2 }, { level: 'country', shifts: { gdp: 0.005, water: 0.01, work: -0.01 } });
  assert.deepEqual(shifted.shifts, { gdp: 0.005, water: 0.01, work: -0.01 });
  assert.equal(shifted.series.shift[seriesOf(shifted, 'C0', 'gdp')], 0.005);
  assert.equal(shifted.series.shift[seriesOf(shifted, 'C0', 'water')], 0, 'saturated: no shift');
  assert.equal(shifted.series.shift[seriesOf(shifted, 'C0', 'work')], -0.01);
  const flat = trendPath(plan, gdp0, 10);
  const lifted = trendPath(shifted, seriesOf(shifted, 'C0', 'gdp'), 10);
  assert.equal(flat.length, 11);
  assert.equal(flat[0], lifted[0], 'the same start');
  const gain = lifted[10] - flat[10];
  assert.ok(gain > 0.04 && gain < 0.05, `ten years of a half-per-cent shift, fading and pulled back: ${gain}`);
  assert.ok(trendPath(shifted, seriesOf(shifted, 'C0', 'work'), 10)[10] < trendPath(plan, seriesOf(plan, 'C0', 'work'), 10)[10], 'a returning series moves with a negative shift');
  const summaryShift = seriesSummary(shifted, seriesOf(shifted, 'C0', 'gdp'));
  assert.equal(summaryShift.shift, 0.005);
  const v = units[0].values.gdp.v;
  close(summaryShift.trendShift, Math.exp(Math.log(v) + 0.005 * Math.pow(0.5, 1 / 30)) - v, 1e-6, 'the shift’s part of the first year, in dollars');
  assert.equal(seriesSummary(shifted, seriesOf(shifted, 'C0', 'water')).shift, undefined);
  assert.equal(typicalModel(shifted)[0].shift, 0.005);
  assert.equal(seriesSummary(plan, gdp0).shift, undefined, 'no hindcast, no shift on the line');

  const years = [];
  const result = simulate(plan, { runs: 100, seed: 3, crises: true, onProgress: (t) => years.push(t) });
  assert.equal(years.length, FORECAST_YEARS);
  assert.equal(result.runs, 100);
  assert.equal(result.seed, 3);
  assert.equal(result.scenario, 'baseline');
  assert.deepEqual(result.ids, units.map((u) => u.id));
  assert.equal(result.p50.length, 7 * T1);
  assert.equal(result.rp50.length, 7 * T1);
  // Year 0 is today exactly on both scales; later years are summaries within 0–100, ordered.
  for (let k = 0; k < 6; k++) {
    const row0 = forecastAt(result, k, 0);
    assert.equal(row0.p50, plan.units[k].today);
    assert.equal(row0.p10, row0.p90);
    assert.equal(forecastAt(result, k, 0, 'others').p50, plan.units[k].today);
    for (const t of [1, 10, 50, 100])
      for (const scale of ['today', 'others']) {
        const row = forecastAt(result, k, t, scale);
        assert.ok(row.p10 <= row.p50 && row.p50 <= row.p90, `${k}@${t} ${scale} ordered`);
        assert.ok(row.p10 >= 0 && row.p90 <= 100);
        assert.ok(row.up >= 0 && row.up <= 100 && row.down >= 0 && row.down <= 100);
        assert.ok(Math.abs(row.mean - row.p50) < 25);
      }
  }
  assert.equal(forecastAt(result, 6, 10), null, 'no figures, no row');
  assert.equal(forecastAt(result, 99, 10), null);
  assert.equal(forecastAt(null, 0, 0), null);
  // Among the others the people average 50 every year (a place's rank is the share of people in places
  // behind it, its own bin counted half); against today the world grows.
  const W = plan.members[0].total;
  for (const t of [1, 25, 50, 100]) {
    let among = 0;
    let against = 0;
    for (let k = 0; k < 6; k++) {
      among += plan.people[k] * forecastAt(result, k, t, 'others').mean;
      against += forecastAt(result, k, t).mean;
    }
    close(among / W, 50, 0.01, `the people’s ranks average 50 at ${t}`);
    if (t >= 25) assert.ok(against / 6 > 50, `the world grows against today’s yardstick at ${t}: ${against / 6}`);
  }
  // The world by its people: today's exact figures, then its band and the shares in abundant and scarce places.
  const scored = [0, 1, 2, 3, 4, 5];
  const todayOf = (k) => plan.units[k].today;
  const world0 = worldAt(result, 0);
  close(world0.p50, scored.reduce((sum, k) => sum + plan.people[k] * todayOf(k), 0) / W, 1e-3, 'today’s people-weighted score');
  assert.equal(world0.p10, world0.p90);
  close(world0.up, (scored.reduce((sum, k) => sum + (todayOf(k) >= ABUNDANT_SCORE ? plan.people[k] : 0), 0) / W) * 100, 1e-3);
  close(world0.down, (scored.reduce((sum, k) => sum + (todayOf(k) <= SCARCE_SCORE ? plan.people[k] : 0), 0) / W) * 100, 1e-3);
  assert.equal(world0.weighted, true);
  assert.equal(world0.today, world0.p50);
  for (const t of [1, 50, 100]) {
    const w = worldAt(result, t);
    assert.ok(w.p10 <= w.p50 && w.p50 <= w.p90, `the world’s band is ordered at ${t}`);
    assert.ok(w.p10 >= 0 && w.p90 <= 100);
    assert.ok(w.up >= 0 && w.down >= 0 && w.up + w.down <= 100 + 1e-6);
    assert.equal(w.today, world0.p50);
    assert.equal(w.upToday, world0.up);
  }
  assert.ok(worldAt(result, 50).p50 > world0.p50, 'the world’s people gain against today’s yardstick');
  assert.equal(worldAt(null, 0), null);
  // The band widens with the years (before the rich places pass today’s best and their band closes at 100); the poorest, far below the frontier, climbs toward it.
  const spread = (k, t) => forecastAt(result, k, t).p90 - forecastAt(result, k, t).p10;
  assert.ok(spread(2, 20) > spread(2, 2), `${spread(2, 20)} > ${spread(2, 2)}`);
  assert.ok(forecastAt(result, 5, 50).p50 > forecastAt(result, 5, 0).p50, 'Country 5 catches up');
  // The same seed gives the same numbers; another seed, other numbers; no crises, a narrower bad case; no
  // ranks among the others when not asked.
  const again = simulate(plan, { runs: 100, seed: 3, crises: true });
  assert.deepEqual(Array.from(again.p50), Array.from(result.p50));
  assert.deepEqual(Array.from(again.rp50), Array.from(result.rp50));
  const other = simulate(plan, { runs: 100, seed: 4, crises: true });
  assert.notDeepEqual(Array.from(other.p50), Array.from(result.p50));
  const calm = simulate(plan, { runs: 100, seed: 3, crises: false, among: false });
  assert.equal(calm.rp50, undefined);
  assert.equal(forecastAt(calm, 1, 30, 'others').p50, forecastAt(calm, 1, 30).p50, 'without the ranks, the row against today stands in');
  let calmer = 0;
  for (let k = 0; k < 6; k++) if (forecastAt(calm, k, 50).p10 >= forecastAt(result, k, 50).p10) calmer += 1;
  assert.ok(calmer >= 4, `without crises the bad case is no worse for most places (${calmer} of 6)`);
  // Fewer years when asked (the hindcast's replay).
  const short = simulate(plan, { runs: 100, seed: 3, years: 12 });
  assert.equal(short.years, 12);
  assert.equal(short.p50.length, 7 * 13);
  // Views on a row.
  const row = forecastAt(result, 1, 30);
  assert.equal(viewValue(row, 'p50'), row.p50);
  assert.equal(viewValue(row, 'p10'), row.p10);
  assert.equal(viewValue(row, 'p90'), row.p90);
  assert.equal(viewValue(row, 'up'), row.up);
  assert.equal(viewValue(row, 'down'), row.down);
  assert.equal(viewValue(row, 'change'), row.p50 - row.today);
  assert.equal(viewValue(null, 'p50'), null);
  assert.equal(viewRampScore(30, 'down'), 70);
  assert.equal(viewRampScore(-20, 'change'), 30);
  assert.equal(viewRampScore(64, 'p50'), 64);
  assert.equal(viewRampScore(NaN, 'p50'), null);
  assert.equal(ABUNDANT_SCORE, 75);
  assert.equal(SCARCE_SCORE, 25);
});

test('scenarios: an optimistic world lifts the typical outcome, a pessimistic one lowers it, a volatile one widens the band', () => {
  const units = countries();
  const at50 = (scenario) => {
    const plan = buildPlan(units, ['gdp', 'work', 'water'], {}, { level: 'country', scenario });
    const result = simulate(plan, { runs: 100, seed: 2, among: false });
    let p10 = 0;
    let p50 = 0;
    let p90 = 0;
    for (let k = 0; k < 6; k++) {
      const row = forecastAt(result, k, 50);
      p10 += row.p10 / 6;
      p50 += row.p50 / 6;
      p90 += row.p90 / 6;
    }
    return { p10, p50, p90 };
  };
  const base = at50('baseline');
  const up = at50('optimistic');
  const down = at50('pessimistic');
  const wild = at50('volatile');
  assert.ok(up.p50 > base.p50, `optimistic ${up.p50} > baseline ${base.p50}`);
  assert.ok(down.p50 < base.p50, `pessimistic ${down.p50} < baseline ${base.p50}`);
  assert.ok(wild.p90 - wild.p10 > base.p90 - base.p10, 'volatile is wider');
  assert.ok(wild.p10 < base.p10, 'volatile’s bad case is worse');
});

test('shared series and shocks: a province’s cities move with their province and country, and a city’s detail matches the map’s row', () => {
  const country = countries()[2];
  const cities = [0, 1, 2, 3].map((k) => ({
    id: `city${k}`,
    name: `City ${k}`,
    iso2: 'C2',
    country: 'Country 2',
    adm1: k < 2 ? 'North' : 'South',
    lat: k,
    lon: k,
    values: {
      gdp: k === 0 ? figure('gdp', grown('gdp', 40000, 0.03, 2010, 'city', 0.02), 'own', 'city') : { ...country.values.gdp, from: 'region' },
      work: { ...country.values.work, from: 'country' },
      water: { ...country.values.water, from: 'country' },
    },
  }));
  const plan = buildPlan(cities, ['gdp', 'work', 'water'], {}, { level: 'city', shifts: { gdp: 0.003, work: 0.002 } });
  assert.equal(plan.series.count, 5, 'one own GDP, the two provinces’ GDP, the country’s WORK and WATER');
  assert.equal(plan.groups.length, 3, 'three tails: the own-GDP city’s, the North’s and the South’s');
  assert.equal(plan.places.count, 4, 'the own city, the two provinces, the country');
  assert.equal(plan.countries.count, 1);
  assert.equal(plan.units[0].own.length, 1);
  assert.equal(plan.units[1].own.length, 0);
  assert.equal(plan.units[2].group, plan.units[3].group, 'the two South cities share a tail');
  assert.notEqual(plan.units[1].group, plan.units[2].group);
  // A city's own series loads on its country's shock as well as its own place's.
  const own = seriesOf(plan, 'city0', 'gdp');
  assert.ok(plan.series.loadCountry[own] > 0 && plan.series.loadPlace[own] > 0);
  const result = simulate(plan, { runs: 100, seed: 5 });
  // No people known: every place counts once in the world's line.
  assert.equal(result.weighted, false);
  assert.equal(worldAt(result, 0).weighted, false);
  close(worldAt(result, 0).p50, plan.units.reduce((sum, u) => sum + u.today, 0) / 4, 1e-3, 'the plain mean of today’s scores');
  // Cities with the same shared figures and no own ones have the same future, on both scales.
  for (let t = 0; t <= 100; t += 25) {
    assert.equal(forecastAt(result, 2, t).p50, forecastAt(result, 3, t).p50);
    assert.equal(forecastAt(result, 2, t, 'others').p50, forecastAt(result, 3, t, 'others').p50);
  }
  const century = (k) => Array.from({ length: T1 }, (_, t) => forecastAt(result, k, t).p50);
  assert.notDeepEqual(century(1), century(2), 'the two provinces walk apart');
  // The detail of a place, simulated on its own, is the map's row for it against today.
  for (const id of ['city0', 'city2']) {
    const k = plan.byId.get(id);
    const detail = detailFor(plan, id, { runs: 100, seed: 5 });
    assert.equal(detail.id, id);
    assert.deepEqual(Object.keys(detail.indicators).sort(), ['gdp', 'water', 'work']);
    assert.equal(detail.indicators.gdp.from, id === 'city0' ? 'own' : 'shared');
    for (let t = 0; t <= 100; t++) {
      const row = forecastAt(result, k, t);
      assert.equal(detail.score.p10[t], row.p10, `${id} p10 @${t}`);
      assert.equal(detail.score.p50[t], row.p50, `${id} p50 @${t}`);
      assert.equal(detail.score.p90[t], row.p90, `${id} p90 @${t}`);
      assert.equal(detail.score.up[t], row.up);
      assert.equal(detail.score.down[t], row.down);
      assert.ok(Math.abs(detail.score.mean[t] - row.mean) < 1e-4);
      const gdp = detail.indicators.gdp;
      assert.ok(gdp.p10[t] <= gdp.p50[t] && gdp.p50[t] <= gdp.p90[t]);
      assert.ok(gdp.placeLow[t] <= gdp.placeMid[t] && gdp.placeMid[t] <= gdp.placeHigh[t]);
    }
    assert.ok(Math.abs(detail.indicators.gdp.p50[0] - cities[k].values.gdp.v) < 1e-2, 'year 0 is the figure itself');
  }
  assert.equal(detailFor(plan, 'nope', { runs: 100 }), null);
  // What the model says of a series, in the figure's own units, with its frontier.
  const summary = seriesSummary(plan, own);
  assert.equal(summary.id, 'gdp');
  assert.equal(summary.family, 'growth');
  assert.ok(Number.isFinite(summary.frontier) && summary.frontier > 0);
  assert.ok(summary.spread > 0);
  assert.equal(summary.n, 14);
  assert.equal(summary.scale, undefined);
  const work = seriesSummary(plan, seriesOf(plan, 'city1', 'work'));
  assert.equal(work.family, 'revert');
  assert.ok(Number.isFinite(work.level));
  assert.equal(work.frontier, undefined);
  const water = seriesSummary(plan, seriesOf(plan, 'city1', 'water'));
  assert.equal(water.cap, 100);
  // The level's typical model, one line per indicator; a hindcast's scale shows on the lines.
  const typical = typicalModel(plan);
  assert.deepEqual(typical.map((m) => [m.id, m.family, m.n]), [['gdp', 'growth', 0], ['water', 'ceiling', 0], ['work', 'revert', 0]]);
  const scaled = buildPlan(cities, ['gdp'], {}, { level: 'city', scales: { gdp: 1.4 } });
  assert.equal(seriesSummary(scaled, 0).scale, 1.4);
  assert.equal(typicalModel(scaled)[0].scale, 1.4);
  close(scaled.series.sigma[0], plan.series.sigma[seriesOf(plan, 'city0', 'gdp')] * 1.4, 1e-9);
});

test('the hindcast replays the model from ten years ago, shifts each trend by what its paths missed, scales each swing so the 8-of-10 band holds, and reports it', () => {
  assert.equal(HINDCAST_YEARS, 10);
  const present = countries();
  const past = countries(2014);
  assert.equal(past[0].values.gdp.year, 2014);
  assert.equal(past[0].values.gdp.n, 14);
  const report = hindcast(past, present, { level: 'country', from: 2014, to: 2024 });
  assert.equal(report.from, 2014);
  assert.equal(report.to, 2024);
  assert.equal(report.tested, 0, 'six countries are too few to test an indicator (ten needed)');
  assert.deepEqual(report.indicators, {});
  assert.deepEqual(hindcastScales(report), {});
  // Twenty places with histories: enough to test. The band holds most of them and the scales stay in range.
  const many = (upTo, bend = 0) =>
    Array.from({ length: 20 }, (_, k) => ({
      id: `P${k}`,
      name: `Place ${k}`,
      iso2: `P${k}`,
      country: `Place ${k}`,
      lat: k,
      lon: k,
      values: {
        gdp: figure('gdp', grown('gdp', 5000 * (k + 1), 0.02 + k / 1000, 2000, 'country', 0.03 + (k % 3) / 100, 2024, bend), 'own', 'country', upTo),
        work: figure('work', grown('work', 3 + k / 2, 0, 2000, 'country', 0.1, 2024, bend), 'own', 'country', upTo),
        // Water: the even places at the ceiling (99.6 % ten years ago, 100 % today: within the ceiling's zone), the odd ones climbing toward it.
        water:
          k % 2 === 0
            ? figure('water', points([[2024, 100], [2019, 99.8], [2014, 99.6], [2009, 99.5], [2004, 99.5]]), 'own', 'country', upTo)
            : figure('water', grown('water', 70 + k, 0.05, 2000, 'country', 0.02), 'own', 'country', upTo),
      },
    }));
  const wide = hindcast(many(2014), many(), { level: 'country', from: 2014, to: 2024 });
  assert.deepEqual(Object.keys(wide.indicators).sort(), ['gdp', 'water', 'work']);
  assert.equal(wide.indicators.gdp.tested, 20);
  assert.ok(wide.tested === 60);
  // A share at its ceiling is held when today's figure is still within the ceiling's zone, missed when it slipped out.
  assert.ok(wide.indicators.water.held >= 80, `the ceiling's zone holds and the climbers stay in band: ${wide.indicators.water.held} %`);
  const slipped = many();
  slipped.forEach((u, k) => {
    if (k % 2 === 0) u.values.water.v = 98.5;
  });
  const slip = hindcast(many(2014), slipped, { level: 'country', from: 2014, to: 2024 });
  assert.ok(slip.indicators.water.held <= wide.indicators.water.held - 45, `ten of twenty slipped out of the zone: ${slip.indicators.water.held} %`);
  for (const entry of Object.values(wide.indicators)) {
    assert.ok(entry.scale >= 0.5 && entry.scale <= SCALE_MAX, `scale ${entry.scale}`);
    assert.ok(entry.held >= 0 && entry.held <= 100);
    assert.ok(Number.isFinite(entry.shift), 'a trend shift per indicator');
  }
  assert.ok(wide.held >= 50, `the scaled band holds most figures: ${wide.held} %`);
  const scales = hindcastScales(wide);
  for (const [id, scale] of Object.entries(scales)) assert.equal(scale, wide.indicators[id].scale);
  assert.deepEqual(hindcastScales(null), {});
  const shifts = hindcastShifts(wide);
  for (const [id, shift] of Object.entries(shifts)) assert.equal(shift, wide.indicators[id].shift);
  assert.deepEqual(hindcastShifts(null), {});
  // A decade that bent every trend: the shift follows the bend, stays within the bound, and the trend paths
  // (run from the past to today's figures, money in the past's dollars) miss less with it.
  const missOf = (past, present, id, withShifts = {}) => {
    const plan = buildPlan(past, [id], {}, { level: 'country', shifts: withShifts });
    const byId = new Map(present.map((u) => [u.id, u]));
    const errors = past
      .map((u) => {
        const s = seriesOf(plan, u.id, id);
        const now = byId.get(u.id).values[id];
        const h = now.year - u.values[id].year;
        const process = plan.series.process[s];
        const value = process.family === 'growth' && process.deflate ? now.v / Math.exp(process.deflate * h) : now.v;
        return toX(process, value) - trendPath(plan, s, h)[h];
      })
      .sort((a, b) => a - b);
    return errors[errors.length >> 1];
  };
  for (const bend of [0.03, -0.03]) {
    const past = many(2014, bend);
    const present = many(null, bend);
    const report = hindcast(past, present, { level: 'country', from: 2014, to: 2024 });
    for (const id of ['gdp', 'work']) {
      const { shift } = report.indicators[id];
      assert.equal(Math.sign(shift), Math.sign(bend), `${id}: the shift ${shift} follows the bend ${bend}`);
      const bound = SHIFT_SWINGS * buildPlan(past, [id], {}, { level: 'country' }).priors[`${id}|country`].s;
      assert.ok(Math.abs(shift) <= bound + 1e-9, `${id}: the shift ${shift} stays within ${bound}`);
      const before = missOf(past, present, id);
      const after = missOf(past, present, id, { [id]: shift });
      assert.ok(Math.abs(after) < Math.abs(before), `${id}: the trend paths miss less with the shift (${before} → ${after})`);
    }
  }
});

test('the handler answers run, detail and model messages as the worker does, and posts the typed arrays for transfer', () => {
  const handle = createForecastHandler();
  const posts = [];
  const post = (message, transfer) => posts.push({ message, transfer });
  const units = countries();
  handle(
    { type: 'run', id: 1, planId: 'p1', level: 'country', scenario: 'optimistic', scales: { gdp: 1.2 }, shifts: { gdp: -0.004 }, units, indicators: ['gdp', 'work'], weights: {}, runs: 100, seed: 2, crises: true, among: true },
    post,
  );
  assert.equal(posts.length, FORECAST_YEARS + 1);
  assert.deepEqual(posts[0].message, { type: 'progress', id: 1, planId: 'p1', year: 1, years: FORECAST_YEARS });
  const done = posts.at(-1);
  assert.equal(done.message.type, 'done');
  assert.equal(done.message.planId, 'p1');
  assert.equal(done.message.result.ids.length, 7);
  assert.equal(done.message.result.scenario, 'optimistic');
  assert.ok(done.message.result.rp50, 'ranked among the others when asked');
  assert.ok(Number.isFinite(done.message.result.ms));
  assert.ok(done.transfer.includes(done.message.result.p50.buffer));
  assert.equal(new Set(done.transfer).size, done.transfer.length, 'each buffer once');
  posts.length = 0;
  handle({ type: 'detail', id: 2, planId: 'p1', unitId: 'C3' }, post);
  assert.equal(posts[0].message.type, 'detail');
  assert.equal(posts[0].message.unitId, 'C3');
  assert.equal(posts[0].message.detail.id, 'C3');
  assert.deepEqual(posts[0].message.model.map((m) => m.id), ['gdp', 'work']);
  assert.equal(posts[0].message.model[0].scale, 1.2, 'the hindcast’s scale rides with the line');
  assert.equal(posts[0].message.model[0].shift, -0.004, 'and its trend shift');
  assert.deepEqual(Object.keys(posts[0].message.detail.indicators), ['gdp', 'work']);
  assert.ok(posts[0].transfer.includes(posts[0].message.detail.score.p50.buffer));
  handle({ type: 'detail', id: 3, planId: 'p1', unitId: 'NONE' }, post);
  assert.equal(posts[1].message.detail, null);
  assert.deepEqual(posts[1].message.model, []);
  handle({ type: 'detail', id: 4, planId: 'old', unitId: 'C3' }, post);
  assert.deepEqual(posts[2].message, { type: 'detail', id: 4, planId: 'old', stale: true });
  handle({ type: 'model', id: 5, planId: 'p1' }, post);
  assert.deepEqual(posts[3].message.model.map((m) => m.id), ['gdp', 'work']);
  handle({ type: 'model', id: 6, planId: 'old' }, post);
  assert.equal(posts[4].message.stale, true);
  handle({ type: 'nope', id: 7 }, post);
  assert.equal(posts.length, 5);
  // A run without the ranks among the others.
  handle({ type: 'run', id: 8, planId: 'p2', level: 'country', units, indicators: ['gdp'], weights: {}, runs: 100, seed: 2, among: false }, post);
  assert.equal(posts.at(-1).message.result.rp50, undefined);
  assert.deepEqual(transferables({ a: new Float32Array(2), b: { c: new Uint8Array(1) }, d: 'x' }).length, 2);
});
