/**
 * Scenarios for world-model datasets (owner request 2026-10-13): a seeded,
 * prefix-stable sweep over everything the Outbreak box can set — pathogen
 * presets and their numbers, the human and intervention menus (unset is a
 * choice of its own: an unset menu is not its middle option), origins,
 * season, the comparison arm and the policy that runs the interventions.
 *
 * Scenario k depends only on (seed, k), so the first 10,000 scenarios of a
 * 50,000 sweep are the 10,000 of a smaller one, and a dataset can grow.
 * Every profile goes through the box's own cleaners (cleanProfile and
 * cleanEpiProfile), so nothing reaches the model that the box could not
 * send. Pure: no DOM, no Node.
 */
import {
  DENSITY_BANDS,
  HUMAN_FACTORS,
  TRANSMISSION_MODES,
  cleanProfile,
} from './outbreakCore.mjs';
import {
  EPI_HUMAN_FACTORS,
  EPI_INTERVENTION_CHOICES,
  EPI_NUMBER_FIELDS,
  PATHOGEN_PRESETS,
  cleanEpiProfile,
  mulberry32,
  presetValues,
} from './outbreakEpi.mjs';

export const SAMPLER_SCHEMA = 'gev-outbreak-sampler/1';
/** How the interventions are run: the model's triggers, exploration, none. */
export const POLICIES = Object.freeze(['rules', 'random', 'none']);
/** The comparison sets an arm B can take away. */
export const COMPARE_SETS = Object.freeze([
  'all',
  'travel',
  'distancing',
  'vaccination',
]);

const DIMS = 128;

/** The R_d constant: the root of x^(d+1) = x + 1 (Roberts 2018). */
function rdPhi(d) {
  let x = 2;
  for (let k = 0; k < 64; k += 1) x = (1 + x) ** (1 / (d + 1));
  return x;
}
const PHI = rdPhi(DIMS);
const ALPHA = Float64Array.from(
  { length: DIMS },
  (_, k) => (1 / PHI) ** (k + 1) % 1,
);

/**
 * Point k of the R_d quasi-random sequence in [0, 1)^DIMS, shifted by a
 * rotation drawn from `seed` (Cranley–Patterson): low discrepancy, and
 * point k never depends on how many points are drawn.
 */
export function rdPoint(k, seed) {
  const rot = mulberry32(seed >>> 0);
  const out = new Float64Array(DIMS);
  for (let j = 0; j < DIMS; j += 1) {
    const x = rot() + (k + 1) * ALPHA[j];
    out[j] = x - Math.floor(x);
  }
  return out;
}

/** A reader over one point: each call takes the next coordinate. */
function coordinates(point) {
  let j = 0;
  return () => {
    if (j >= point.length) throw new Error('sampler: out of dimensions');
    return point[j++];
  };
}

const pick = (u, list) =>
  list[Math.min(list.length - 1, Math.floor(u * list.length))];
const lerp = (u, lo, hi) => lo + u * (hi - lo);
const logLerp = (u, lo, hi) => Math.exp(lerp(u, Math.log(lo), Math.log(hi)));
const field = (key) => EPI_NUMBER_FIELDS[key];

/** A number field drawn over its own range (log scale when it spans much). */
function draw(u, key, { log = false, lo, hi } = {}) {
  const [min, max] = field(key);
  const a = lo ?? min;
  const b = hi ?? max;
  return log && a > 0 ? logLerp(u, a, b) : lerp(u, a, b);
}

/** A menu's choice, or unset (null) as a choice of its own. */
function menu(u, options) {
  const ids = [null, ...options.map((o) => o.id)];
  return pick(u, ids);
}

/**
 * Scenario k of a sweep.
 *
 * @param {number} k The scenario's index.
 * @param {object} options
 * @param {number} options.seed The sweep's seed (32-bit).
 * @param {number[]} options.originPool Node indices origins are drawn from
 *   (the world's tracked places, so an origin is always recorded).
 * @param {number[]} [options.originWeights] Weights for the pool.
 * @param {number} [options.days] The window, in days.
 * @param {number} [options.year] The calendar year of the start dates.
 * @param {number[]} [options.startDays] Days (00:00 UTC, ms) the start is
 *   drawn from instead of the year: the days the world tape recorded, so the
 *   run meets the conditions recorded then (the same coordinate is used, so
 *   everything else about the scenario is unchanged).
 * @param {number} [options.compareShare] Share of scenarios with an arm B.
 * @param {number[]} [options.policyMix] Weights for POLICIES.
 */
export function sampleScenario(
  k,
  {
    seed,
    originPool,
    originWeights = null,
    days = 40,
    year = 2026,
    startDays = null,
    compareShare = 0.25,
    policyMix = [0.5, 0.3, 0.2],
  },
) {
  const u = coordinates(rdPoint(k, seed));
  // The pathogen: one of the presets with its numbers jittered, or (one
  // time in twelve) a novel one drawn across the whole box.
  const presetIds = PATHOGEN_PRESETS.map((p) => p.id);
  const which = pick(u(), [...presetIds, 'random']);
  const raw = which === 'random' ? {} : presetValues(which);
  const jitter = (value, spread, uu) =>
    value * Math.exp(lerp(uu, -spread, spread));
  if (which === 'random') {
    raw.transmission = pick(
      u(),
      TRANSMISSION_MODES.map((m) => m.id),
    );
    raw.r0 = logLerp(u(), 0.5, 12);
    raw.incubationDays = logLerp(u(), 1, 21);
    raw.latentDays = raw.incubationDays * lerp(u(), 0.3, 0.9);
    raw.infectiousDays = logLerp(u(), 2, 21);
    raw.asymptomaticPct = lerp(u(), 0, 80);
    raw.hospitalPct = logLerp(u(), 0.1, 40);
    raw.fatalityPct = Math.min(raw.hospitalPct, logLerp(u(), 0.01, 30));
    raw.hospitalDays = lerp(u(), 3, 20);
    raw.icuPct = lerp(u(), 0, 40);
    raw.superspreading = pick(u(), ['low', 'medium', 'high']);
    raw.mutation = pick(u(), ['low', 'medium', 'high']);
    raw.waningDays = u() < 0.5 ? 0 : logLerp(u(), 60, 1500);
  } else {
    raw.r0 = jitter(raw.r0 ?? 2.5, 0.4, u());
    if (raw.incubationDays)
      raw.incubationDays = jitter(raw.incubationDays, 0.3, u());
    else u();
    if (raw.latentDays)
      raw.latentDays = Math.min(
        raw.incubationDays ?? 60,
        jitter(raw.latentDays, 0.3, u()),
      );
    else u();
    if (raw.infectiousDays)
      raw.infectiousDays = jitter(raw.infectiousDays, 0.3, u());
    else u();
    if (raw.hospitalPct) raw.hospitalPct = jitter(raw.hospitalPct, 0.5, u());
    else u();
    if (raw.fatalityPct) raw.fatalityPct = jitter(raw.fatalityPct, 0.5, u());
    else u();
  }
  raw.initialCases = Math.round(logLerp(u(), 1, 10_000));
  // The box's human factors (pathogen side) and the epidemic menus.
  for (const factor of HUMAN_FACTORS) {
    const value = menu(u(), factor.options);
    if (value !== null) raw[factor.key] = value;
  }
  for (const factor of EPI_HUMAN_FACTORS) {
    const value = menu(u(), factor.options);
    if (value !== null) raw[factor.key] = value;
  }
  // Behaviour numbers, each set half the time.
  const maybe = (key, value) => {
    if (u() < 0.5) raw[key] = value;
  };
  maybe('commuteDaySplit', draw(u(), 'commuteDaySplit'));
  maybe(
    'travelDomesticPct',
    draw(u(), 'travelDomesticPct', { lo: 10, hi: 200 }),
  );
  maybe('travelIntlPct', draw(u(), 'travelIntlPct', { lo: 5, hi: 200 }));
  maybe('fatigueDays', draw(u(), 'fatigueDays'));
  maybe('vaccinatedPct', draw(u(), 'vaccinatedPct', { hi: 60 }));
  if (raw.variants === 'two-strain') {
    raw.strain2Day = Math.round(
      draw(u(), 'strain2Day', { hi: Math.max(1, days - 5) }),
    );
    raw.strain2Cases = Math.round(
      draw(u(), 'strain2Cases', { log: true, hi: 1000 }),
    );
    raw.strain2Pct = Math.round(draw(u(), 'strain2Pct', { lo: 60, hi: 250 }));
    raw.strain2SeverityPct = Math.round(
      draw(u(), 'strain2SeverityPct', { lo: 50, hi: 300 }),
    );
    raw.crossImmunityPct = Math.round(draw(u(), 'crossImmunityPct'));
  } else for (let j = 0; j < 5; j += 1) u();
  // The policy, then the interventions it runs.
  const total = policyMix.reduce((s, w) => s + w, 0) || 1;
  let up = u() * total;
  let policy = POLICIES[POLICIES.length - 1];
  for (let j = 0; j < POLICIES.length; j += 1) {
    up -= policyMix[j] ?? 0;
    if (up < 0) {
      policy = POLICIES[j];
      break;
    }
  }
  if (policy !== 'none') {
    for (const choice of EPI_INTERVENTION_CHOICES) {
      if (choice.key === 'compare') {
        u();
        continue;
      }
      const value = menu(u(), choice.options);
      if (value !== null) raw[choice.key] = value;
    }
    // The random policy decides switches day by day: a per-place mode.
    if (
      policy === 'random' &&
      (!raw.triggerMode || raw.triggerMode === 'everywhere')
    )
      raw.triggerMode = u() < 0.5 ? 'reported' : 'hospital';
    else u();
    raw.travelBanPct = Math.round(draw(u(), 'travelBanPct'));
    raw.quarantineDays = Math.round(draw(u(), 'quarantineDays'));
    raw.lockdownPct = Math.round(draw(u(), 'lockdownPct'));
    raw.interventionHour = Math.round(lerp(u(), 0, 24 * Math.max(1, days - 1)));
    raw.interventionDays = Math.round(
      draw(u(), 'interventionDays', { hi: days }),
    );
    raw.triggerPer100k =
      Math.round(
        draw(u(), 'triggerPer100k', { lo: 1, hi: 300, log: true }) * 10,
      ) / 10;
    raw.triggerBedShare = Math.round(draw(u(), 'triggerBedShare', { lo: 20 }));
    raw.minLockDays = Math.round(draw(u(), 'minLockDays'));
    raw.fatigueHalfDays = Math.round(draw(u(), 'fatigueHalfDays'));
    raw.borderTrigger = Math.round(
      draw(u(), 'borderTrigger', { log: true, hi: 10_000 }),
    );
    maybe(
      'testsPer1000Day',
      Math.round(
        draw(u(), 'testsPer1000Day', { lo: 0.05, hi: 10, log: true }) * 100,
      ) / 100,
    );
    if (u() < 0.4) {
      raw.vaccineStartDay = Math.round(
        draw(u(), 'vaccineStartDay', { hi: Math.max(0, days - 1) }),
      );
      raw.vaccinePer1000Day =
        Math.round(draw(u(), 'vaccinePer1000Day', { lo: 0.5, hi: 30 }) * 10) /
        10;
      raw.vaccineCoverageMaxPct = Math.round(
        draw(u(), 'vaccineCoverageMaxPct', { lo: 20 }),
      );
      raw.vaccineEfficacyPct = Math.round(
        draw(u(), 'vaccineEfficacyPct', { lo: 30 }),
      );
    } else for (let j = 0; j < 4; j += 1) u();
  } else for (let j = 0; j < EPI_INTERVENTION_CHOICES.length + 16; j += 1) u();
  // The comparison arm, a share of the time and only with measures to take.
  const compare =
    policy !== 'none' && u() < compareShare
      ? pick(u(), COMPARE_SETS)
      : (u(), null);
  // Origins: one to three tracked places, weighted.
  const count = 1 + Math.floor(u() * 3);
  const origins = [];
  const weights = originWeights ?? originPool.map(() => 1);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  for (let j = 0; j < count; j += 1) {
    let x = u() * totalWeight;
    let chosen = originPool[originPool.length - 1];
    for (let m = 0; m < originPool.length; m += 1) {
      x -= weights[m];
      if (x < 0) {
        chosen = originPool[m];
        break;
      }
    }
    if (!origins.includes(chosen)) origins.push(chosen);
  }
  for (let j = count; j < 3; j += 1) u();
  // Season: a day of the year, on the hour (or a recorded day).
  const when = u();
  const startMs = startDays?.length
    ? startDays[
        Math.min(startDays.length - 1, Math.floor(when * startDays.length))
      ]
    : Date.UTC(year, 0, 1) + Math.floor(when * 365) * 86_400_000;
  const profile = { ...cleanProfile(raw), ...cleanEpiProfile(raw) };
  return {
    schema: SAMPLER_SCHEMA,
    index: k,
    seed: seed >>> 0,
    preset: which,
    policy,
    compare,
    profile,
    origins,
    startMs,
    untilMs: startMs + days * 86_400_000,
    policySeed: Math.floor(u() * 4294967296) >>> 0,
  };
}

/**
 * Scenario k of a sweep around one downloaded box run (`base`, from
 * server/shared/outbreakExportScenario.mjs): the run's pathogen, places,
 * window and flights every time; only who runs the interventions (the
 * policy, from `policyMix`) and the random stream change.
 *
 * @param {number} k The scenario's index.
 * @param {{profile: object, origins: number[], startMs: number, untilMs: number}} base
 * @param {{seed: number, policyMix?: number[]}} options
 */
export function exportScenario(k, base, { seed, policyMix = [0.5, 0.3, 0.2] }) {
  const u = coordinates(rdPoint(k, seed));
  const total = policyMix.reduce((s, w) => s + w, 0) || 1;
  let up = u() * total;
  let policy = POLICIES[POLICIES.length - 1];
  for (let j = 0; j < POLICIES.length; j += 1) {
    up -= policyMix[j] ?? 0;
    if (up < 0) {
      policy = POLICIES[j];
      break;
    }
  }
  return {
    schema: SAMPLER_SCHEMA,
    index: k,
    seed: seed >>> 0,
    preset: 'export',
    policy,
    compare: null,
    profile: base.profile,
    origins: [...base.origins],
    startMs: base.startMs,
    untilMs: base.untilMs,
    policySeed: Math.floor(u() * 4294967296) >>> 0,
  };
}

/** The densities the box knows, for reference in dataset cards. */
export const DENSITY_IDS = Object.freeze(DENSITY_BANDS.map((b) => b.id));
