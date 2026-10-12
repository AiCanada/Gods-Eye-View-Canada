/**
 * EPIDEMIC MODEL STATISTICS: the small pure functions the epidemic model
 * (outbreakEpi.mjs) leans on for awareness, daytime commuting, local time and
 * the Monte-Carlo intervals it reports. No DOM, no network, no imports: the
 * model re-exports what its consumers need.
 *
 *  - Awareness with fatigue: contacts fall as the signal (reports or deaths
 *    per 100,000) rises, and the fall fades towards a floor over a half-life
 *    (Weitz et al. 2020; Funk et al. 2009).
 *  - Diurnal commuting: the day's commuting is split between daytime and
 *    night so a day still sums to 24 factor-hours (Balcan et al. 2009).
 *  - Local time from longitude: 15° per hour, clamped to real zones.
 *  - Wilson score interval for a share of runs (Wilson 1927) and the
 *    order-statistic interval round a quantile of a sorted sample.
 *  - Rt from the runs: the model's own generation-interval kernel, read off
 *    its hourly stage chain, and the renewal ratio of each day's new
 *    infections to the infectiousness of those before (Cori et al. 2013;
 *    Gostic et al. 2020; Wallinga & Lipsitch 2007). The kernel takes the
 *    base isolation and no tracing; seeds and spillover have no infectors.
 */

/** The floor of awareness fatigue: caution never fades below this share. */
export const AWARENESS_FLOOR = 0.3;
/** z for the 95 % intervals the model reports. */
export const WILSON_Z = 1.96;
/** Daytime, in local hours: [DIURNAL_DAY_START, DIURNAL_DAY_END). */
export const DIURNAL_DAY_START = 7;
export const DIURNAL_DAY_END = 19;
/** Rt is null on a day whose renewal denominator is below this. */
export const RT_MIN_INFECTIOUS = 10;
/** The generation kernel is cut after this many days. */
export const RT_KERNEL_DAYS_MAX = 60;
/** One hour, in days: the model's step. */
const DT = 1 / 24;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Contact multiplier from awareness of a signal (reports or deaths per
 * 100,000): 1 / (1 + awareness × signal × f), where f fades from 1 towards
 * `floor` with half-life `fatigueDays` over `sinceDays`; no fatigue when
 * `fatigueDays` is 0. Awareness 0 gives 1 whatever the signal.
 */
export function awarenessCaution(
  awareness,
  signal,
  sinceDays = 0,
  fatigueDays = 0,
  floor = AWARENESS_FLOOR,
) {
  if (!(awareness > 0) || !(signal > 0)) return 1;
  const f =
    fatigueDays > 0
      ? floor + (1 - floor) * 2 ** (-Math.max(0, sinceDays) / fatigueDays)
      : 1;
  return 1 / (1 + awareness * signal * f);
}

/**
 * Wilson score interval for `successes` of `n` runs: [lo, hi] to 3 dp, or
 * [0, 0] when there are no runs.
 */
export function wilsonInterval(successes, n, z = WILSON_Z) {
  if (!(n > 0)) return [0, 0];
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return [
    round3(Math.max(0, centre - half)),
    round3(Math.min(1, centre + half)),
  ];
}

/**
 * The order-statistic interval round quantile `q` of a sorted sample:
 * [sorted[lo], sorted[hi]] with the ranks nq ∓ z √(nq(1 − q)), clamped to
 * the sample. `count` is the number of runs when `sorted` holds only the
 * runs with a value (the ranks then use it, and the answer is null when the
 * upper rank is beyond the values held). Null for an empty sample.
 */
export function quantileInterval(sorted, q, z = WILSON_Z, count) {
  const n = Number.isFinite(count) ? count : sorted.length;
  if (!(n > 0) || !sorted.length) return null;
  const spread = z * Math.sqrt(n * q * (1 - q));
  const lo = clamp(Math.floor(n * q - spread), 0, n - 1);
  const hi = clamp(Math.ceil(n * q + spread), 0, n - 1);
  if (hi >= sorted.length) return null;
  return [sorted[lo], sorted[hi]];
}

/**
 * The commuting factor at a local hour: 2 × split in daytime, 2 × (1 − split)
 * at night, so the 24 hours sum to 24 for any split in [0.5, 1]; 0.5 is flat.
 */
export function diurnalFactor(localHour, split) {
  const day = localHour >= DIURNAL_DAY_START && localHour < DIURNAL_DAY_END;
  return day ? 2 * split : 2 * (1 - split);
}

/**
 * Whole hours from UTC guessed from longitude (15° an hour), clamped to the
 * real range −12…+14; 0 for an unknown longitude. An hour off in many
 * countries, more in China, India and Spain.
 */
export function localOffsetHours(lon) {
  if (!Number.isFinite(lon)) return 0;
  return clamp(Math.round(lon / 15), -12, 14);
}

/**
 * The model's generation-interval kernel for one person infected during
 * hour 0, from its hourly stage chain (E → P → Is, or E → Ia, with the
 * exits 1 − e^(−rate × DT) in the loop's order): `hourly[j − 1]` is the
 * share of their infectiousness at the hazard of hour j; `daily[s]` the
 * share s days later for an infection at a uniform hour of its day (day 0
 * kept: same-day transmission); `meanDays` the mean (1 dp) and
 * `perCaseDays` the infectiousness-days of one case. Base isolation only,
 * no tracing; cut after RT_KERNEL_DAYS_MAX days.
 */
export function generationKernel(params) {
  const qs = Math.exp(-params.sigma * DT);
  const qr = Math.exp(-params.rho * DT);
  const qg = Math.exp(-params.gammaSym * DT);
  const qa = Math.exp(-params.gammaAsym * DT);
  const a = params.asymShare;
  const iso = Math.min(0.95, params.isolation ?? 0);
  const asymRelative = params.asymRelative;
  let E = 1;
  let P = 0;
  let Is = 0;
  let Ia = 0;
  const transitions = () => {
    const out = E * (1 - qs);
    E -= out;
    Ia += a * out;
    P += (1 - a) * out;
    const on = P * (1 - qr);
    P -= on;
    Is += on;
    Is *= qg;
    Ia *= qa;
  };
  transitions();
  const k = [];
  for (
    let j = 1;
    j <= 24 * RT_KERNEL_DAYS_MAX && E + P + Is + Ia >= 1e-9;
    j += 1
  ) {
    k.push(P + (1 - iso) * Is + asymRelative * Ia);
    transitions();
  }
  let total = 0;
  for (const v of k) total += v;
  const hourly = new Float64Array(k.length);
  if (total > 0) for (let j = 0; j < k.length; j += 1) hourly[j] = k[j] / total;
  const sMax = Math.floor((23 + k.length) / 24);
  const daily = new Array(sMax + 1).fill(0);
  for (let u = 0; u < 24; u += 1)
    for (let j = 1; j <= k.length; j += 1)
      daily[Math.floor((u + j) / 24)] += hourly[j - 1] / 24;
  let mean = 0;
  for (let j = 1; j <= k.length; j += 1) mean += j * hourly[j - 1];
  return {
    hourly,
    daily,
    meanDays: Math.round(mean * DT * 10) / 10,
    perCaseDays: DT * total,
  };
}

/**
 * Rt for one run by the renewal equation: R_d = I_d / Σ_s w_s I_(d−s) over
 * the daily kernel w, or null on day 0 (the seeds have no infectors) and on
 * any day whose denominator is below `minDenominator`.
 */
export function renewalRt(
  incidence,
  daily,
  { minDenominator = RT_MIN_INFECTIOUS } = {},
) {
  const sMax = daily.length - 1;
  return Array.from(incidence, (I, d) => {
    if (d < 1) return null;
    let lambda = 0;
    for (let s = 0; s <= Math.min(d, sMax); s += 1)
      lambda += daily[s] * incidence[d - s];
    return lambda >= minDenominator ? I / lambda : null;
  });
}
