import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AWARENESS_FLOOR,
  DIURNAL_DAY_END,
  DIURNAL_DAY_START,
  RT_KERNEL_DAYS_MAX,
  RT_MIN_INFECTIOUS,
  WILSON_Z,
  awarenessCaution,
  diurnalFactor,
  generationKernel,
  localOffsetHours,
  quantileInterval,
  renewalRt,
  wilsonInterval,
} from './outbreakEpiStats.mjs';

const close = (a, b, eps, message) =>
  assert.ok(
    Math.abs(a - b) < eps,
    message ?? `${a} is not within ${eps} of ${b}`,
  );

/** A tiny seeded generator so the sampling checks need nothing from the model. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('the constants are the ones the design names', () => {
  assert.equal(AWARENESS_FLOOR, 0.3);
  assert.equal(WILSON_Z, 1.96);
  assert.equal(DIURNAL_DAY_START, 7);
  assert.equal(DIURNAL_DAY_END, 19);
});

test('awareness caution: positional, fades to a floor, 1 without awareness', () => {
  assert.equal(awarenessCaution(0.02, 50, 0, 0), 0.5);
  close(awarenessCaution(0.02, 50, 10, 10), 1 / 1.65, 1e-12);
  assert.equal(awarenessCaution(0, 1e9), 1);
  assert.equal(awarenessCaution(0.1, 0), 1);
  // No fatigue days: the time since the first report does not matter.
  assert.equal(awarenessCaution(0.02, 50, 400, 0), 0.5);
  // Long after the first report caution has faded to the floor.
  close(
    awarenessCaution(0.02, 50, 10_000, 10),
    1 / (1 + 0.02 * 50 * AWARENESS_FLOOR),
    1e-9,
  );
  // A custom floor is honoured.
  close(awarenessCaution(0.02, 50, 10_000, 10, 0.5), 1 / 1.5, 1e-9);
  // Fading is monotone in the days since.
  let last = 0;
  for (const d of [0, 1, 5, 20, 100]) {
    const c = awarenessCaution(0.05, 40, d, 7);
    assert.ok(c > last);
    last = c;
  }
});

test('Wilson interval: the textbook value, the edges and the empty case', () => {
  assert.deepEqual(wilsonInterval(50, 100), [0.404, 0.596]);
  assert.equal(wilsonInterval(0, 7)[0], 0);
  assert.equal(wilsonInterval(7, 7)[1], 1);
  assert.equal(wilsonInterval(0, 400)[0], 0);
  assert.equal(wilsonInterval(400, 400)[1], 1);
  assert.deepEqual(wilsonInterval(3, 0), [0, 0]);
  assert.deepEqual(wilsonInterval(0, -1), [0, 0]);
  // The interval holds the point estimate and narrows with more runs.
  for (const [s, n] of [
    [1, 10],
    [37, 200],
    [199, 200],
    [250, 500],
  ]) {
    const [lo, hi] = wilsonInterval(s, n);
    assert.ok(lo <= s / n && s / n <= hi, `${s}/${n}`);
    assert.ok(lo >= 0 && hi <= 1);
  }
  const wide = wilsonInterval(10, 20);
  const narrow = wilsonInterval(100, 200);
  assert.ok(narrow[1] - narrow[0] < wide[1] - wide[0]);
  // A larger z widens it.
  const z3 = wilsonInterval(50, 100, 3);
  assert.ok(z3[0] < 0.404 && z3[1] > 0.596);
});

test('quantile interval: ranks round the quantile, clamped to the sample', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i);
  assert.deepEqual(quantileInterval(hundred, 0.5), [40, 60]);
  assert.deepEqual(quantileInterval([5], 0.5), [5, 5]);
  assert.equal(quantileInterval([], 0.5), null);
  // Extreme quantiles stay inside the sample.
  assert.deepEqual(quantileInterval(hundred, 0), [0, 0]);
  assert.deepEqual(quantileInterval(hundred, 1), [99, 99]);
  // With a run count larger than the values held, ranks use the count and
  // the answer is null once the upper rank is beyond the values.
  assert.equal(quantileInterval([1, 2, 3], 0.5, WILSON_Z, 100), null);
  assert.deepEqual(quantileInterval(hundred, 0.5, WILSON_Z, 100), [40, 60]);
  assert.deepEqual(
    quantileInterval(hundred.slice(0, 61), 0.5, WILSON_Z, 100),
    [40, 60],
  );
  assert.equal(
    quantileInterval(hundred.slice(0, 60), 0.5, WILSON_Z, 100),
    null,
  );
  // Brackets the population median of a uniform sample in about 95 % of trials.
  const rng = lcg(11);
  let hits = 0;
  const trials = 400;
  for (let t = 0; t < trials; t += 1) {
    const sample = Array.from({ length: 100 }, () => rng()).sort(
      (a, b) => a - b,
    );
    const [lo, hi] = quantileInterval(sample, 0.5);
    if (lo <= 0.5 && 0.5 <= hi) hits += 1;
  }
  assert.ok(
    hits / trials > 0.9,
    `bracketed the median in ${hits} of ${trials}`,
  );
});

test('the diurnal factor sums to 24 for any split and is flat at 0.5', () => {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  for (const split of [0.5, 0.6, 0.7, 0.85, 1]) {
    const sum = hours.reduce((s, h) => s + diurnalFactor(h, split), 0);
    close(sum, 24, 1e-12, `split ${split} sums to ${sum}`);
  }
  assert.ok(hours.every((h) => diurnalFactor(h, 0.5) === 1));
  assert.equal(diurnalFactor(7, 0.7), 1.4);
  assert.equal(diurnalFactor(18, 0.7), 1.4);
  close(diurnalFactor(6, 0.7), 0.6, 1e-12);
  close(diurnalFactor(19, 0.7), 0.6, 1e-12);
  assert.equal(diurnalFactor(12, 1), 2);
  assert.equal(diurnalFactor(0, 1), 0);
});

test('the local offset is 15 degrees an hour, clamped to real zones', () => {
  assert.equal(localOffsetHours(135), 9);
  assert.equal(localOffsetHours(-75), -5);
  assert.equal(localOffsetHours(0), 0);
  assert.equal(localOffsetHours(7.4), 0);
  assert.equal(localOffsetHours(7.6), 1);
  assert.equal(localOffsetHours(179.9), 12);
  assert.equal(localOffsetHours(-180), -12);
  assert.equal(localOffsetHours(NaN), 0);
  assert.equal(localOffsetHours(undefined), 0);
});

/**
 * Plain SEIR stage rates as the model's epiParameters gives them for latent
 * 3, incubation 3, infectious 5 and nobody asymptomatic: no presymptomatic
 * stage (its rate is the 0.02-day floor), nobody isolated.
 */
const PLAIN_SEIR = {
  sigma: 1 / 3,
  rho: 1 / 0.02,
  gammaSym: 1 / 5,
  gammaAsym: 1 / 5,
  asymShare: 0,
  asymRelative: 0.5,
  isolation: 0,
};

test('RT-1 the generation kernel: both forms sum to 1, its mean is latent + presymptomatic + infectious', () => {
  assert.equal(RT_MIN_INFECTIOUS, 10);
  assert.equal(RT_KERNEL_DAYS_MAX, 60);
  const kernel = generationKernel(PLAIN_SEIR);
  close(
    kernel.daily.reduce((s, w) => s + w, 0),
    1,
    1e-12,
  );
  close(
    kernel.hourly.reduce((s, w) => s + w, 0),
    1,
    1e-12,
  );
  close(kernel.meanDays, 3 + 0.02 + 5, 0.15);
  assert.ok(kernel.daily[0] > 0, 'same-day transmission is kept');
  // Cut at the day limit.
  assert.ok(kernel.hourly.length <= 24 * RT_KERNEL_DAYS_MAX);
  assert.ok(kernel.daily.length <= RT_KERNEL_DAYS_MAX + 2);
  // One case is infectious for about its infectious days.
  close(kernel.perCaseDays, 5, 0.1);
  // Isolating half the symptomatic about halves the infectiousness here
  // (the presymptomatic hours are not isolated).
  close(
    generationKernel({ ...PLAIN_SEIR, isolation: 0.5 }).perCaseDays,
    kernel.perCaseDays / 2,
    0.01,
  );
});

test('RT-2 the renewal ratio of a steadily growing series is 1 / Σ w_s 1.1^(−s)', () => {
  const { daily } = generationKernel(PLAIN_SEIR);
  const sMax = daily.length - 1;
  const days = sMax + 20;
  const incidence = Array.from({ length: days }, (_, d) => 100 * 1.1 ** d);
  const rt = renewalRt(incidence, daily);
  assert.equal(rt.length, days);
  assert.equal(rt[0], null);
  const expected = 1 / daily.reduce((s, w, k) => s + w * 1.1 ** -k, 0);
  for (let d = sMax; d < days; d += 1) close(rt[d], expected, 1e-9);
  // Nothing to divide by: null throughout.
  assert.ok(renewalRt(new Array(30).fill(0), daily).every((v) => v === null));
  // Below the denominator floor: null; a lower floor gives a value.
  const few = [1, 1, 1, 1];
  assert.ok(renewalRt(few, daily).every((v) => v === null));
  assert.ok(
    renewalRt(few, daily, { minDenominator: 0.01 })
      .slice(1)
      .every((v) => v > 0),
  );
});
