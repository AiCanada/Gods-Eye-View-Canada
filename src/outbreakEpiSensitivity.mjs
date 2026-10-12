/**
 * EPIDEMIC MODEL SENSITIVITY: a one-at-a-time tornado over the closed forms
 * of outbreakEpi.mjs. Each parameter is moved down and up on its own (× 2/3
 * and × 1.5 for the pathogen values, off and full for the interventions) and
 * the reproduction number with interventions and the doubling time are read
 * back; rows are sorted by how far R swings (Saltelli et al. 2008, OAT).
 * Analytic only: no simulation runs, so the server can answer in a few
 * milliseconds beside the ensemble. No DOM and no network.
 */
import {
  EPI_NUMBER_FIELDS,
  doublingTime,
  epiParameters,
} from './outbreakEpi.mjs';

/** The down and up multipliers of the pathogen rows. */
export const TORNADO_FACTORS = Object.freeze([2 / 3, 1.5]);

/** The rows, in the order they are tried. */
export const TORNADO_KEYS = Object.freeze([
  'r0',
  'latentDays',
  'infectiousDays',
  'asymptomaticPct',
  'asymRelative',
  'hospitalPct',
  'fatalityPct',
  'lockdownPct',
  'vaccinatedPct',
  'travelBanPct',
]);

/** R0 is not a numeric epidemic field; the model clamps it to this range. */
const R0_RANGE = Object.freeze([0.1, 20]);
/** The interventions: off and the most the model allows. */
const SWITCH_RANGE = Object.freeze({
  lockdownPct: Object.freeze([0, 90]),
  vaccinatedPct: Object.freeze([0, 100]),
  travelBanPct: Object.freeze([0, 100]),
});

const round2 = (n) => Math.round(n * 100) / 100;
const roundOrNull = (n) => (n === null ? null : Math.round(n * 10) / 10);
const num = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n)
    ? n
    : fallback;
};

function baseValue(key, profile, base) {
  switch (key) {
    case 'r0':
      return base.r0;
    case 'latentDays':
      return base.latentDays;
    case 'infectiousDays':
      return base.infectiousDays;
    case 'asymptomaticPct':
      return base.asymShare * 100;
    case 'asymRelative':
      return base.asymRelative;
    case 'hospitalPct':
      return num(profile.hospitalPct, 3);
    case 'fatalityPct':
      return num(profile.fatalityPct, 0.5);
    default:
      return num(profile[key], 0);
  }
}

function bounds(key, value) {
  if (SWITCH_RANGE[key]) return SWITCH_RANGE[key];
  const [min, max] = key === 'r0' ? R0_RANGE : (EPI_NUMBER_FIELDS[key] ?? []);
  const [down, up] = TORNADO_FACTORS;
  const clamp = (n) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  return [clamp(value * down), clamp(value * up)];
}

/**
 * The tornado rows for a profile: `{ key, low, high, rLow, rHigh,
 * doublingLow, doublingHigh, swing, doublingSwing }`, sorted by |swing|
 * (R with interventions, high − low) descending, ties by |doublingSwing|.
 */
export function sensitivityTornado(profile) {
  const p = profile || {};
  const base = epiParameters(p);
  const rows = TORNADO_KEYS.map((key) => {
    const [low, high] = bounds(key, baseValue(key, p, base));
    const pLow = epiParameters({ ...p, [key]: low });
    const pHigh = epiParameters({ ...p, [key]: high });
    const doublingLow = roundOrNull(doublingTime(pLow, true));
    const doublingHigh = roundOrNull(doublingTime(pHigh, true));
    const swing = pHigh.rEffectiveControlled - pLow.rEffectiveControlled;
    const doublingSwing = (doublingHigh ?? 0) - (doublingLow ?? 0);
    return {
      row: {
        key,
        low,
        high,
        rLow: round2(pLow.rEffectiveControlled),
        rHigh: round2(pHigh.rEffectiveControlled),
        doublingLow,
        doublingHigh,
        swing: round2(swing),
        doublingSwing: round2(doublingSwing),
      },
      swing,
      doublingSwing,
    };
  });
  rows.sort(
    (a, b) =>
      Math.abs(b.swing) - Math.abs(a.swing) ||
      Math.abs(b.doublingSwing) - Math.abs(a.doublingSwing),
  );
  return rows.map((r) => r.row);
}
