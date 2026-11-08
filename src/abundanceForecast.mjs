/**
 * ABUNDANCE FORECAST: a Monte Carlo of every place's abundance 0 to 100
 * years ahead (owner request 2026-11-07: "For Global abundance create monte
 * Carlo simulator for future abundance (0-100 years), use fine grain detail
 * and display on map", then "try for more advanced future abundance
 * predictions").
 *
 * Each figure walks forward a year at a time from its own history, pulled
 * toward a moving frontier: money (GDP, income) toward the richest places'
 * level in today's dollars, which itself grows at the scenario's long-run
 * rate; deaths, crime, dirty air and prison rates toward the best places'
 * figures above a floor; shares of people (electricity, water, the
 * internet, schooling), life span, happiness and forest toward the best
 * places' figures below a ceiling; inflation, unemployment and the price
 * level back to their own usual level. What a place did beyond that
 * (its residual trend) fades over decades. The swings are a world shock, a
 * country shock, a place shock and the figure's own, each indicator loading
 * on them its own way (GDP with income, unemployment against them), and
 * crises are regimes: a world or a local crisis that lasts a year or two,
 * cuts money and what depends on it, and is followed by a partial recovery.
 * A short history is shrunk toward the level's typical one, and the
 * server's hindcast (a replay from ten years ago) shifts each indicator's
 * trend by what the decade's trend paths missed and scales its swing so
 * the 8-of-10 band holds.
 *
 * The score at a future year is measured two ways: against today's figures
 * (100 is the best any place has today, so the map can turn greener as the
 * world grows) and among the other places in that year (the share of
 * people in places behind it, every place weighed by its population), and
 * the world's people are summed up: their weighted score and the shares
 * living in abundant and scarce places.
 * The draws are counted, never kept: every random number is a hash of
 * (series or place, run, year), so the detail of one place, simulated on
 * its own, matches the map that simulated every place at once.
 *
 * Pure: the server reads seriesStats and runs the hindcast, the tab's
 * worker runs simulate and detailFor (src/abundanceForecast.worker.js), and
 * the tab reads the rest (src/abundancePanel.js). The labels are marked
 * with msgl() and shown through tl().
 */
import {
  ABUNDANCE_INDICATORS,
  cleanIndicatorIds,
  cleanWeight,
  indicatorRanks,
} from './abundanceCore.mjs';
import { msgl } from './i18n/marker.js';

/** The horizon: the map goes this many years ahead, one at a time. */
export const FORECAST_YEARS = 100;
/** How many runs a simulation may make. */
export const FORECAST_RUNS = Object.freeze([100, 250, 500, 1000, 2000]);
/** The runs by level until the owner picks: a country level is small, the others carry thousands of places. */
export const FORECAST_DEFAULT_RUNS = Object.freeze({
  country: 500,
  region: 100,
  city: 100,
});
/** What the map shows for a future year. */
export const FORECAST_VIEWS = Object.freeze([
  'p50',
  'p10',
  'p90',
  'up',
  'down',
  'change',
]);
export const FORECAST_VIEW_LABELS = Object.freeze({
  p50: msgl('TYPICAL OUTCOME'),
  p10: msgl('IF IT GOES BADLY'),
  p90: msgl('IF IT GOES WELL'),
  up: msgl('CHANCE OF ABUNDANCE'),
  down: msgl('CHANCE OF SCARCITY'),
  change: msgl('CHANGE FROM TODAY'),
});
/** What a future score is measured against: today's figures, or the other places in that year. */
export const FORECAST_SCALES = Object.freeze(['today', 'others']);
export const FORECAST_SCALE_LABELS = Object.freeze({
  today: msgl('AGAINST TODAY'),
  others: msgl('AMONG THE OTHERS'),
});
/** The worlds the runs may assume. */
export const FORECAST_SCENARIOS = Object.freeze([
  'baseline',
  'optimistic',
  'pessimistic',
  'volatile',
]);
export const FORECAST_SCENARIO_LABELS = Object.freeze({
  baseline: msgl('BASELINE'),
  optimistic: msgl('OPTIMISTIC'),
  pessimistic: msgl('PESSIMISTIC'),
  volatile: msgl('VOLATILE'),
});
/** How far the hindcast may scale an indicator's pull toward the frontier (`beta`). */
export const PULL_MIN = 0.5;
export const PULL_MAX = 2;
/** An indicator's pull factor from a hindcast's `pulls`, bounded; 1 without one. */
export function pullOf(pulls, id) {
  const pull = pulls?.[id];
  return Number.isFinite(pull) ? clamp(pull, PULL_MIN, PULL_MAX) : 1;
}
/**
 * A scenario: the frontier's long-run growth of money a year (real), how
 * much faster or slower the other frontiers move (`pace`), how often crises
 * come and how deep they cut, against the baseline.
 */
export const SCENARIO_PARAMS = Object.freeze({
  baseline: { growth: 0.015, pace: 1, crisisRate: 1, crisisDepth: 1 },
  optimistic: { growth: 0.025, pace: 1.5, crisisRate: 0.5, crisisDepth: 1 },
  pessimistic: { growth: 0.005, pace: 0.5, crisisRate: 2, crisisDepth: 1 },
  volatile: { growth: 0.015, pace: 1, crisisRate: 2, crisisDepth: 1.5 },
});
/** The chances count a run abundant at or over this score, scarce at or under that: the grid's thresholds. */
export const ABUNDANT_SCORE = 75;
export const SCARCE_SCORE = 25;
/**
 * The US dollar lost about this much of its value a year over 1996–2026
 * (the US GDP deflator), and the money figures are in current dollars, so
 * their growth is projected in today's dollars by taking it off.
 */
export const DOLLAR_INFLATION = 0.025;
/** A history's own trend and swing count this many steps against the level's typical ones. */
export const PRIOR_STEPS = 4;
/** The trend weighs a step this many years back half as much as the latest. */
export const TREND_HALF_LIFE_YEARS = 12;
/**
 * A crisis regime: the chance a normal year turns to crisis, the chance a
 * crisis year stays one, the cut it makes to money each crisis year (a
 * share, uniform between min and min + span), and the recovery years that
 * follow, each giving back `rebound`. World crises hit every place; a local
 * one hits one place's own figures.
 */
export const WORLD_REGIME = Object.freeze({
  enter: 0.06,
  persist: 0.35,
  cutMin: 0.03,
  cutSpan: 0.03,
  rebound: 0.012,
  recovery: 3,
});
export const LOCAL_REGIME = Object.freeze({
  enter: 0.03,
  persist: 0.3,
  cutMin: 0.02,
  cutSpan: 0.04,
  rebound: 0.01,
  recovery: 3,
});
/** A share already at its ceiling is there to stay. */
const SATURATED = 0.995;
const PLACE_BINS = 4096;
const RANK_BINS = 512;
const SCORE_BINS = 200;
/**
 * A level with this many places or more ranks among the others every other
 * year, the years between read from their neighbours: the ranks cost about
 * as much as the walk, and a year's ranks move little.
 */
export const RANK_STRIDE_UNITS = 1000;
/** A residual trend stays within this, a year. */
const RESIDUAL_MAX = 0.06;
/** A level's typical residual trend stays within this, a year, so one odd level cannot move every place. */
const TYPICAL_RESIDUAL_MAX = 0.02;
/**
 * The hindcast's trend shift stays within this many of the indicator's
 * typical swings a year (2 % a year for money), so one decade cannot move
 * every place far.
 */
export const SHIFT_SWINGS = 0.4;
/**
 * The hindcast's swing scale stays between a half and this. A source that
 * interpolates between its surveys (water, forest) shows almost no swing
 * from year to year, and the band must still come to hold its revisions.
 */
export const SCALE_MAX = 10;

/**
 * How each indicator moves. `family`: `growth` walks in log space, `floor`
 * in the log distance above a floor, `ceiling` in logit space below a
 * ceiling, each pulled toward a frontier (`frontier.q`: the quantile of
 * today's places that is the frontier; `frontier.drift`: how the frontier
 * moves a year, `'growth'` for the scenario's long-run growth) at `beta` of
 * the gap a year, with the place's residual trend fading over `halfLife`
 * years; `revert` returns to its usual level at `theta` a year, in log
 * space unless `level`. `deflate` takes the dollar's inflation off a money
 * trend; `exposure` is how a crisis that cuts money by a share moves this
 * figure (in its own space); `shares` how much of a year's swing is the
 * world's, the country's and the place's (the rest the figure's own) and
 * `sign` which way good times move it; `prior` the trend `g` and swing `s`
 * (and level `m`) assumed where a level has too few histories to say.
 */
export const FORECAST_PROCESSES = Object.freeze({
  gdp: {
    family: 'growth',
    deflate: DOLLAR_INFLATION,
    exposure: 1,
    sign: 1,
    shares: { world: 0.2, country: 0.25, place: 0.3 },
    frontier: { q: 0.9, drift: 'growth' },
    beta: 0.015,
    halfLife: 30,
    prior: { g: 0.045, s: 0.05 },
  },
  income: {
    family: 'growth',
    deflate: DOLLAR_INFLATION,
    exposure: 1,
    sign: 1,
    shares: { world: 0.2, country: 0.25, place: 0.3 },
    frontier: { q: 0.9, drift: 'growth' },
    beta: 0.015,
    halfLife: 30,
    prior: { g: 0.045, s: 0.05 },
  },
  health: {
    family: 'floor',
    floor: 1,
    exposure: -0.5,
    sign: -1,
    shares: { world: 0.02, country: 0.05, place: 0.08 },
    frontier: { q: 0.1, drift: -0.01 },
    beta: 0.02,
    halfLife: 40,
    prior: { g: -0.03, s: 0.06 },
  },
  safety: {
    family: 'floor',
    floor: 0.1,
    exposure: -0.5,
    sign: -1,
    shares: { world: 0.02, country: 0.03, place: 0.05 },
    frontier: { q: 0.1, drift: -0.005 },
    beta: 0.01,
    halfLife: 40,
    prior: { g: -0.01, s: 0.15 },
  },
  air: {
    family: 'floor',
    floor: 2,
    exposure: 0,
    sign: -1,
    shares: { world: 0.05, country: 0.05, place: 0.05 },
    frontier: { q: 0.1, drift: -0.005 },
    beta: 0.01,
    halfLife: 40,
    prior: { g: -0.01, s: 0.08 },
  },
  prison: {
    family: 'floor',
    floor: 5,
    exposure: 0,
    sign: -1,
    shares: { world: 0, country: 0, place: 0.05 },
    frontier: { q: 0.1, drift: 0 },
    beta: 0.005,
    halfLife: 40,
    prior: { g: 0, s: 0.06 },
  },
  life: {
    family: 'ceiling',
    cap: 100,
    exposure: 2,
    sign: 1,
    shares: { world: 0.03, country: 0.05, place: 0.05 },
    frontier: { q: 0.9, drift: 0.01 },
    beta: 0.02,
    halfLife: 40,
    prior: { g: 0.02, s: 0.03 },
  },
  education: {
    family: 'ceiling',
    cap: 160,
    exposure: 0,
    sign: 1,
    shares: { world: 0.02, country: 0.04, place: 0.06 },
    frontier: { q: 0.9, drift: 0.01 },
    beta: 0.02,
    halfLife: 40,
    prior: { g: 0.02, s: 0.08 },
    // Secondary enrolment is gross (over 100 % in places); the OECD's
    // regional figure is the share of adults with tertiary education.
    region: { cap: 100 },
  },
  infrastructure: {
    family: 'ceiling',
    cap: 100,
    exposure: 0,
    sign: 1,
    shares: { world: 0.02, country: 0.04, place: 0.06 },
    frontier: { q: 0.9, drift: 0.02 },
    beta: 0.03,
    halfLife: 40,
    prior: { g: 0.15, s: 0.2 },
  },
  utilities: {
    family: 'ceiling',
    cap: 100,
    exposure: 0,
    sign: 1,
    shares: { world: 0.02, country: 0.04, place: 0.06 },
    frontier: { q: 0.9, drift: 0.01 },
    beta: 0.03,
    halfLife: 40,
    prior: { g: 0.1, s: 0.15 },
  },
  water: {
    family: 'ceiling',
    cap: 100,
    exposure: 0,
    sign: 1,
    shares: { world: 0.02, country: 0.04, place: 0.06 },
    frontier: { q: 0.9, drift: 0.01 },
    beta: 0.02,
    halfLife: 40,
    prior: { g: 0.05, s: 0.1 },
  },
  green: {
    family: 'ceiling',
    cap: 100,
    exposure: 0,
    sign: 1,
    shares: { world: 0, country: 0, place: 0.02 },
    frontier: { q: 0.9, drift: 0 },
    beta: 0.002,
    halfLife: 40,
    prior: { g: 0, s: 0.03 },
    // A country's forest is a share of its land; an urban area's green
    // space is square metres per person, with no ceiling.
    city: {
      family: 'growth',
      deflate: 0,
      frontier: { q: 0.9, drift: 0 },
      beta: 0.005,
      shares: { world: 0, country: 0, place: 0.05 },
      prior: { g: 0, s: 0.05 },
    },
  },
  happiness: {
    family: 'ceiling',
    cap: 10,
    exposure: 0.5,
    sign: 1,
    shares: { world: 0.05, country: 0.08, place: 0.1 },
    frontier: { q: 0.9, drift: 0 },
    beta: 0.01,
    halfLife: 40,
    prior: { g: 0, s: 0.05 },
  },
  work: {
    family: 'revert',
    theta: 0.25,
    exposure: -8,
    sign: -1,
    shares: { world: 0.2, country: 0.2, place: 0.25 },
    prior: { g: 0, s: 0.12, m: Math.log(6) },
  },
  cost: {
    family: 'revert',
    theta: 0.1,
    exposure: 0,
    sign: 1,
    shares: { world: 0.05, country: 0.1, place: 0.1 },
    prior: { g: 0, s: 0.06, m: Math.log(0.7) },
  },
  inflation: {
    family: 'revert',
    level: true,
    theta: 0.35,
    exposure: 0,
    sign: 1,
    shares: { world: 0.1, country: 0.1, place: 0.05 },
    prior: { g: 0, s: 2.5, m: 3 },
  },
});

/** The family's words for the MODEL lines. */
export const FORECAST_FAMILY_LABELS = Object.freeze({
  growth: msgl('CATCHING UP WITH THE FRONTIER ({frontier})'),
  floor: msgl('TOWARD THE FRONTIER ({frontier}), FLOOR {floor}'),
  ceiling: msgl('TOWARD THE FRONTIER ({frontier}), CEILING {cap}'),
  revert: msgl('RETURNS TO ITS USUAL {level}'),
});

/** A year ahead within the horizon; 0 (today) for anything else. */
export function cleanYear(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(FORECAST_YEARS, Math.max(0, n));
}

/** A known number of runs; null (the level's default) for anything else. */
export function cleanRuns(value) {
  const n = Math.round(Number(value));
  return FORECAST_RUNS.includes(n) ? n : null;
}

/** The runs a level simulates: the owner's number, else the level's default. */
export function runsFor(level, chosen) {
  return cleanRuns(chosen) || FORECAST_DEFAULT_RUNS[level] || 100;
}

/** A known view; the typical outcome for anything else. */
export function cleanForecastView(value) {
  return FORECAST_VIEWS.includes(value) ? value : 'p50';
}

/** A known scale; against today for anything else. */
export function cleanScale(value) {
  return FORECAST_SCALES.includes(value) ? value : 'today';
}

/** A known scenario; the baseline for anything else. */
export function cleanScenario(value) {
  return FORECAST_SCENARIOS.includes(value) ? value : 'baseline';
}

/**
 * The process of an indicator's figure as measured at a level: the
 * indicator's, with the level's own differences where its source measures
 * something else (a city's green space, a region's tertiary education).
 */
export function processFor(indicatorId, measuredAt = 'country') {
  const process = FORECAST_PROCESSES[indicatorId];
  if (!process) return null;
  const own = process[measuredAt];
  return own ? { ...process, ...own } : process;
}

/**
 * The level a figure was measured at: a place's own (or CSV) figure at its
 * level, one from its state or larger region at the region level, one from
 * its country at the country level (src/abundancePanel's measure rule).
 */
export function measuredAtOf(level, from) {
  if (from === 'own' || from === 'csv' || !from) return level;
  return from === 'region' || from === 'area' ? 'region' : 'country';
}

// --- the spaces each figure moves in ----------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const logit = (p) => Math.log(p / (1 - p));
const logistic = (x) => 1 / (1 + Math.exp(-x));

/** A figure in the space its indicator walks in. */
export function toX(process, value) {
  const v = Number(value);
  switch (process.family) {
    case 'growth':
      return Math.log(Math.max(v, 1e-6));
    case 'floor':
      return Math.log(Math.max(v - process.floor, 0.02 * process.floor));
    case 'ceiling':
      return logit(clamp(v / process.cap, 0.001, SATURATED));
    default:
      return process.level ? v : Math.log(Math.max(v, 0.05));
  }
}

/** The figure a point in that space stands for. */
export function fromX(process, x) {
  switch (process.family) {
    case 'growth':
      return Math.exp(x);
    case 'floor':
      return process.floor + Math.exp(x);
    case 'ceiling':
      return process.cap * logistic(x);
    default:
      return process.level ? x : Math.exp(x);
  }
}

/**
 * A series' own trend and swing, for the server to send with each figure:
 * `g` the mean change a year in the indicator's space, the latest steps
 * weighing most (a step TREND_HALF_LIFE_YEARS back counts half), `s` the
 * swing of a year's change (the residuals' standard deviation about the
 * span's plain rise, a gap of several years counted as its square root),
 * `n` the steps between points, `m` the mean level. Points in any order;
 * one per year. Null without a point, and g, s null (n 0) with a single
 * point.
 * @param {{id: string}} indicator
 * @param {Array<{year: number, value: number}>} points
 * @param {string} [measuredAt] the level the points were measured at
 */
export function seriesStats(indicator, points, measuredAt = 'country') {
  const process = processFor(indicator?.id, measuredAt);
  if (!process) return null;
  const byYear = new Map();
  for (const p of points || []) {
    if (!Number.isFinite(p?.value) || !Number.isFinite(p?.year)) continue;
    if (!byYear.has(p.year)) byYear.set(p.year, toX(process, p.value));
  }
  const xs = [...byYear].sort((a, b) => a[0] - b[0]);
  if (!xs.length) return null;
  const round = (v) => Math.round(v * 1e6) / 1e6;
  const m = xs.reduce((sum, [, x]) => sum + x, 0) / xs.length;
  if (xs.length < 2) return { g: null, s: null, n: 0, m: round(m) };
  const latest = xs[xs.length - 1][0];
  let span = 0;
  let rise = 0;
  let weighedSpan = 0;
  let weighedRise = 0;
  const steps = [];
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i][0] - xs[i - 1][0];
    const d = xs[i][1] - xs[i - 1][1];
    const weight = Math.pow(0.5, (latest - xs[i][0]) / TREND_HALF_LIFE_YEARS);
    span += gap;
    rise += d;
    weighedSpan += weight * gap;
    weighedRise += weight * d;
    steps.push([d, gap]);
  }
  const plain = rise / span;
  const g = weighedRise / weighedSpan;
  let squares = 0;
  for (const [d, gap] of steps) {
    const r = (d - plain * gap) / Math.sqrt(gap);
    squares += r * r;
  }
  const s = steps.length >= 2 ? Math.sqrt(squares / (steps.length - 1)) : null;
  return {
    g: round(g),
    s: s === null ? null : round(s),
    n: steps.length,
    m: round(m),
  };
}

/** The median of a list of numbers; null with none. */
function median(list) {
  const sorted = list.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2;
}

/** A quantile of a list of numbers (linear between the two nearest); null with none. */
export function quantile(list, q) {
  const sorted = list.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/**
 * What a level's histories typically show for an indicator (the medians
 * over its distinct series), else the process's own assumptions; a history
 * is shrunk toward these. The typical swing never falls below the
 * process's assumed one: a source that interpolates between its surveys
 * shows no swing from year to year, which says nothing about the next
 * decade's.
 * @param {object} process
 * @param {Array<{g?: number, s?: number, m?: number, n?: number}>} figures distinct series
 */
export function priorFor(process, figures) {
  const prior = { ...process.prior };
  const withTrend = figures.filter((f) => f.n >= 1 && Number.isFinite(f.g));
  const withSwing = figures.filter((f) => f.n >= 2 && Number.isFinite(f.s));
  const withLevel = figures.filter((f) => Number.isFinite(f.m));
  if (withTrend.length >= 5) prior.g = median(withTrend.map((f) => f.g));
  if (withSwing.length >= 5) {
    const s = median(withSwing.map((f) => f.s));
    if (s > 0) prior.s = Math.max(s, process.prior.s);
  }
  if (withLevel.length >= 5 && process.family === 'revert')
    prior.m = median(withLevel.map((f) => f.m));
  return prior;
}

/** The frontier's move a year for a process under a scenario. */
export function frontierDrift(process, scenario) {
  const params = SCENARIO_PARAMS[cleanScenario(scenario)];
  const drift = process.frontier?.drift;
  if (drift === 'growth') return params.growth;
  return (Number(drift) || 0) * params.pace;
}

/**
 * One series' parameters. The swing is its history's shrunk toward the
 * prior (PRIOR_STEPS steps' worth), kept between a quarter and four times
 * the typical one, scaled by the indicator's hindcast. A walking family
 * gets the frontier, its drift and pull, and the residual trend: what the
 * history's trend (deflated for money) did beyond what the frontier's pull
 * predicted, shrunk toward the level's typical residual and bounded. A
 * returning family gets its usual level, shrunk the same way. Every family
 * gets the hindcast's trend shift for the indicator, bounded.
 * @param {object} process
 * @param {{v: number, g?: number, s?: number, n?: number, m?: number}} figure
 * @param {{g: number, s: number, m?: number, residual?: number}} prior
 * @param {{frontier?: number, scenario?: string, scale?: number, shift?: number, pull?: number}} [context] the frontier at year 0 in the walking space, the scenario, the hindcast's swing scale, trend shift and pull factor
 */
export function seriesParams(process, figure, prior, context = {}) {
  const n = Number.isFinite(figure?.n) ? Math.max(0, figure.n) : 0;
  const weigh = (own, typical) =>
    (n * own + PRIOR_STEPS * typical) / (n + PRIOR_STEPS);
  const v0 = Number(figure.v);
  const x0 = toX(process, v0);
  // The history's own trend, unshrunk: the residual below is shrunk once.
  const g = n >= 1 && Number.isFinite(figure.g) ? figure.g : prior.g;
  let sigma =
    n >= 2 && Number.isFinite(figure.s)
      ? Math.sqrt(weigh(figure.s * figure.s, prior.s * prior.s))
      : prior.s;
  sigma = clamp(sigma, 0.25 * prior.s, 4 * prior.s);
  const scale = Number.isFinite(context.scale)
    ? clamp(context.scale, 0.5, SCALE_MAX)
    : 1;
  sigma *= scale;
  const shiftMax = SHIFT_SWINGS * prior.s;
  const shift = Number.isFinite(context.shift)
    ? clamp(context.shift, -shiftMax, shiftMax)
    : 0;
  const m =
    Number.isFinite(figure.m) && n >= 1 ? weigh(figure.m, prior.m) : prior.m;
  const out = {
    v0,
    x0,
    sigma,
    n,
    theta: 0,
    xbar: 0,
    frontier: 0,
    muF: 0,
    beta: 0,
    residual: 0,
    shift,
    decay: 1,
    exposure: process.exposure ?? 0,
    saturated: false,
  };
  if (process.family === 'revert') {
    out.theta = process.theta;
    out.xbar = m;
    return out;
  }
  out.frontier = Number.isFinite(context.frontier) ? context.frontier : x0;
  out.muF = frontierDrift(process, context.scenario);
  out.beta =
    (process.beta || 0) *
    (Number.isFinite(context.pull)
      ? clamp(context.pull, PULL_MIN, PULL_MAX)
      : 1);
  out.decay = process.halfLife ? Math.pow(0.5, 1 / process.halfLife) : 1;
  const own = process.family === 'growth' ? g - (process.deflate || 0) : g;
  const predicted = out.muF + out.beta * (out.frontier - x0);
  const typical = Number.isFinite(prior.residual) ? prior.residual : 0;
  const residual = n >= 1 ? weigh(own - predicted, typical) : typical;
  out.residual = clamp(residual, -RESIDUAL_MAX, RESIDUAL_MAX);
  if (process.family === 'ceiling' && v0 >= SATURATED * process.cap) {
    out.saturated = true;
    out.sigma = 0;
    out.residual = 0;
    out.shift = 0;
    out.beta = 0;
    out.muF = 0;
    out.exposure = 0;
  }
  return out;
}

/**
 * The series a figure belongs to: a place's own figure is its own series;
 * one handed down is the series of the place it came from, shared by every
 * place that took it, so a province's cities move with their province.
 */
export function seriesKey(unit, indicatorId, figure) {
  return `${indicatorId}|${placeKey(unit, figure)}`;
}

/** The place a figure's series belongs to: the unit, its state, its larger region, or its country. */
export function placeKey(unit, figure) {
  const from = figure?.from || 'own';
  if (from === 'own' || from === 'csv') return `u:${unit.id}`;
  if (from === 'country') return `c:${unit.iso2 ?? unit.country}`;
  if (from === 'region')
    return `r:${unit.iso2 ?? unit.country}/${unit.adm1 ?? ''}`;
  return `a:${unit.iso2 ?? unit.country}:${figure.v}:${figure.year ?? ''}`;
}

/** FNV-1a of a string, for a series' or a place's own stream of draws. */
export function stringSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A counted draw: the same (seed, run, year) always gives the same 32 bits. */
export function draw(seed, run, year) {
  let h = (seed + Math.imul(run, 0x9e3779b1) + Math.imul(year, 0x85ebca77)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Acklam's inverse of the standard normal distribution, 0 < p < 1. */
export function inverseNormal(p) {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
      q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

let normals = null;
/** The standard normal by sixteen bits of a draw: table[i] = Φ⁻¹((i + ½) / 65536). */
export function normalTable() {
  if (normals) return normals;
  normals = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) normals[i] = inverseNormal((i + 0.5) / 65536);
  return normals;
}

// --- crises as regimes -----------------------------------------------------------------------

/** A regime under a scenario: crises as often and as deep as it says. */
export function regimeFor(base, scenario) {
  const params = SCENARIO_PARAMS[cleanScenario(scenario)];
  return {
    ...base,
    enter: Math.min(0.5, base.enter * params.crisisRate),
    cutMin: base.cutMin * params.crisisDepth,
    cutSpan: base.cutSpan * params.crisisDepth,
    rebound: base.rebound * params.crisisDepth,
  };
}

/**
 * The mean impulse a year of a regime, from its stationary shares of normal,
 * crisis and recovery years: a cut (below zero) net of the rebounds. The
 * trends were measured over years that had their crises, so a series gets
 * this back as drift and its mean path stays the trend's.
 */
export function regimeMeanImpulse(r) {
  const normal = 1 / (1 + r.enter / (1 - r.persist) + r.recovery * r.enter);
  const crisis = (r.enter * normal) / (1 - r.persist);
  const recovery = r.recovery * r.enter * normal;
  return -crisis * (r.cutMin + r.cutSpan / 2) + recovery * r.rebound;
}

/**
 * One year of a regime: from the state (0 normal, 1 crisis, 2 and up a
 * recovery with state − 1 years left including this one) and a draw's two
 * halves, the next state and the year's impulse (a cut below zero in a
 * crisis year, the rebound in a recovery year). Written into `out` as
 * [state, impulse].
 */
export function regimeStep(state, h, r, out) {
  const u = (h >>> 16) / 65536;
  const u2 = (h & 0xffff) / 65536;
  if (state === 0) {
    if (u < r.enter) {
      out[0] = 1;
      out[1] = -(r.cutMin + r.cutSpan * u2);
    } else {
      out[0] = 0;
      out[1] = 0;
    }
    return out;
  }
  if (state === 1) {
    if (u < r.persist) {
      out[0] = 1;
      out[1] = -(r.cutMin + r.cutSpan * u2);
    } else {
      out[0] = r.recovery >= 2 ? r.recovery : 0;
      out[1] = r.recovery >= 1 ? r.rebound : 0;
    }
    return out;
  }
  out[0] = state - 1 >= 2 ? state - 1 : 0;
  out[1] = r.rebound;
  return out;
}

// --- places against today ----------------------------------------------------------------

/**
 * Today's figures of one indicator as a lookup from a figure to the place
 * among them, 0 to 100: an exact figure gets its place (ties share their
 * mean), one between two figures a place between theirs, one past the ends
 * 0 or 100; reversed where lower is better. Null with no figure. In the
 * figures' own units, as the ranking is: a level mixes a place's own
 * measure with the one it took from above.
 * @param {number[]} values today's figures
 * @param {'high'|'low'} better
 */
export function placeTable(values, better, bins = PLACE_BINS) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return null;
  const lo = sorted[0];
  const hi = sorted[n - 1];
  const table = new Float32Array(bins + 1);
  const flip = better === 'low';
  if (n === 1 || hi === lo) {
    table.fill(50);
    return { lo, hi, bins, scale: 0, table, n };
  }
  // The place of each sorted figure: a tie block's mean place.
  const placeOf = new Float64Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && sorted[j + 1] === sorted[i]) j += 1;
    const place = ((i + (j - i) / 2) / (n - 1)) * 100;
    for (let k = i; k <= j; k++) placeOf[k] = place;
    i = j + 1;
  }
  let i = 0;
  for (let q = 0; q <= bins; q++) {
    const x = q === bins ? hi : lo + ((hi - lo) * q) / bins;
    while (i < n && sorted[i] < x) i += 1;
    let place;
    if (i < n && sorted[i] === x) place = placeOf[i];
    else if (i === 0) place = 0;
    else if (i === n) place = 100;
    else {
      const a = sorted[i - 1];
      const b = sorted[i];
      const t = (x - a) / (b - a);
      place = placeOf[i - 1] + (placeOf[i] - placeOf[i - 1]) * t;
    }
    table[q] = flip ? 100 - place : place;
  }
  return { lo, hi, bins, scale: bins / (hi - lo), table, n };
}

/** The place of a figure, from its table. */
export function placeAt(table, value) {
  if (!table) return NaN;
  if (value <= table.lo) return table.table[0];
  if (value >= table.hi) return table.table[table.bins];
  const f = (value - table.lo) * table.scale;
  const i = f | 0;
  return table.table[i] + (table.table[i + 1] - table.table[i]) * (f - i);
}

/** The walking spaces as the hot loops read them: exp, a floor plus exp, a ceiling times the logistic, the level itself. */
const KIND = Object.freeze({
  growth: 0,
  floor: 1,
  ceiling: 2,
  log: 3,
  level: 4,
});
function kindOf(process) {
  if (process.family === 'revert') return process.level ? KIND.level : KIND.log;
  return KIND[process.family];
}
/** fromX by kind and bound, inlined by the engine. */
function valueOf(kind, bound, x) {
  switch (kind) {
    case 0:
    case 3:
      return Math.exp(x);
    case 1:
      return bound + Math.exp(x);
    case 2:
      return bound / (1 + Math.exp(-x));
    default:
      return x;
  }
}

/**
 * Every unit's weight in the world's figures and the ranks among the
 * others: its people (`people`, the server's population for it). A unit
 * with none weighs nothing where others have people (it is still forecast
 * and ranked), and every unit weighs 1 when none is known.
 * @param {Array<{people?: number}>} units
 * @returns {Float64Array}
 */
export function peopleOf(units) {
  const list = Array.isArray(units) ? units : [];
  const known = list.some((u) => Number(u?.people) > 0);
  return Float64Array.from(list, (u) => {
    const p = Number(u?.people);
    return Number.isFinite(p) && p > 0 ? p : known ? 0 : 1;
  });
}

/**
 * A population's growth a year halves every this many years (the
 * demographic transition: the world's 0.9 % a year of 2026 would be near
 * nothing by the 2080s, as the UN expects).
 */
export const PEOPLE_GROWTH_HALF_LIFE = 20;
/** A population grows or shrinks by at most this share a year. */
export const PEOPLE_GROWTH_MAX = 0.03;

/**
 * Every unit's population growth a year (`peopleGrowth`: the server's, from
 * its country's thirty years of population), bounded; 0 where unknown.
 * @param {Array<{peopleGrowth?: number}>} units
 * @returns {Float64Array}
 */
export function peopleGrowthOf(units) {
  const list = Array.isArray(units) ? units : [];
  return Float64Array.from(list, (u) => {
    const g = Number(u?.peopleGrowth);
    return Number.isFinite(g)
      ? clamp(g, -PEOPLE_GROWTH_MAX, PEOPLE_GROWTH_MAX)
      : 0;
  });
}

/**
 * The years of growth a population has had by year t when its rate halves
 * every PEOPLE_GROWTH_HALF_LIFE years: t at first, then toward 29.
 */
export function peopleYears(t) {
  const h = PEOPLE_GROWTH_HALF_LIFE;
  return (h / Math.LN2) * (1 - Math.pow(0.5, t / h));
}

/** Every unit's people at year t of a plan: today's, grown or shrunk at its slowing rate. */
export function peopleAt(plan, t) {
  const years = peopleYears(cleanYear(t));
  return Float64Array.from(
    plan.people,
    (p, k) => p * Math.exp(plan.growth[k] * years),
  );
}

// --- the plan: series, units and their terms -------------------------------------------

/**
 * Everything a simulation needs, from a level's units with their figures:
 * the distinct series with their parameters, the places and countries
 * whose shocks they share, each unit's terms (its own series and the shared
 * tail it inherits), the members of each indicator with their people (for
 * the ranks among the others and the world's figures), the place tables
 * and today's exact scores.
 * @param {Array<{id: string, values: object}>} units
 * @param {string[]} indicatorIds the ticked indicators
 * @param {object} weights
 * @param {{level?: string, scenario?: string, scales?: object, shifts?: object, pulls?: object, indicators?: object[]}} [options] `scales`, `shifts`, `pulls`: the hindcast's swing scale, trend shift and pull factor per indicator
 */
export function buildPlan(
  units,
  indicatorIds,
  weights = {},
  {
    level = 'country',
    scenario = 'baseline',
    scales = {},
    shifts = {},
    pulls = {},
    indicators = ABUNDANCE_INDICATORS,
  } = {},
) {
  scenario = cleanScenario(scenario);
  const chosen = cleanIndicatorIds(indicatorIds)
    .map((id) => indicators.find((i) => i.id === id))
    .filter((i) => i && FORECAST_PROCESSES[i.id]);
  const list = Array.isArray(units) ? units : [];
  const people = peopleOf(list);
  const growth = peopleGrowthOf(list);
  const weighted = list.some((u) => Number(u?.people) > 0);
  const seriesIndex = new Map();
  const seriesList = [];
  const terms = [];
  for (const u of list) {
    const own = [];
    const tail = [];
    for (const indicator of chosen) {
      const f = u?.values?.[indicator.id];
      if (!f || !Number.isFinite(Number(f.v))) continue;
      const key = seriesKey(u, indicator.id, f);
      let s = seriesIndex.get(key);
      if (s === undefined) {
        s = seriesList.length;
        seriesIndex.set(key, s);
        const measuredAt = measuredAtOf(level, f.from);
        seriesList.push({
          key,
          id: indicator.id,
          measuredAt,
          place: placeKey(u, f),
          country: `c:${u.iso2 ?? u.country}`,
          figure: { v: Number(f.v), g: f.g, s: f.s, n: f.n, m: f.m },
        });
      }
      const w = cleanWeight(weights?.[indicator.id] ?? 1);
      (f.from === 'own' || f.from === 'csv' ? own : tail).push([s, w]);
    }
    terms.push({ id: u.id, own, tail });
  }
  // Priors from the distinct series of each indicator as measured at a
  // level (a city's own green space and its country's forest share are two
  // measures), with the frontier and the typical residual trend.
  const measureKey = (id, measuredAt) => `${id}|${measuredAt}`;
  const byMeasure = new Map();
  for (const s of seriesList) {
    const key = measureKey(s.id, s.measuredAt);
    if (!byMeasure.has(key)) byMeasure.set(key, []);
    byMeasure.get(key).push(s);
  }
  const priors = {};
  const frontiers = {};
  for (const [key, members] of byMeasure) {
    const [id, measuredAt] = key.split('|');
    const process = processFor(id, measuredAt);
    const prior = priorFor(
      process,
      members.map((s) => s.figure),
    );
    let frontier = null;
    if (process.family !== 'revert') {
      const xs = members.map((s) => toX(process, s.figure.v));
      frontier = quantile(xs, process.frontier?.q ?? 0.9);
      // The typical residual: what the level's histories did beyond the
      // frontier's pull, bounded so one odd level cannot move every place.
      const muF = frontierDrift(process, scenario);
      const beta = (process.beta || 0) * pullOf(pulls, id);
      const residuals = members
        .filter((s) => s.figure.n >= 1 && Number.isFinite(s.figure.g))
        .map((s) => {
          const own =
            process.family === 'growth'
              ? s.figure.g - (process.deflate || 0)
              : s.figure.g;
          const x0 = toX(process, s.figure.v);
          return own - (muF + beta * (frontier - x0));
        });
      prior.residual =
        residuals.length >= 5
          ? clamp(
              median(residuals),
              -TYPICAL_RESIDUAL_MAX,
              TYPICAL_RESIDUAL_MAX,
            )
          : 0;
    }
    priors[key] = prior;
    frontiers[key] = frontier;
  }
  const S = seriesList.length;
  const placeIndex = new Map();
  const countryIndex = new Map();
  const placeSeeds = [];
  const countrySeeds = [];
  const series = {
    count: S,
    keys: seriesList.map((s) => s.key),
    ids: seriesList.map((s) => s.id),
    process: seriesList.map((s) => processFor(s.id, s.measuredAt)),
    indicator: new Int32Array(S),
    seed: new Uint32Array(S),
    place: new Int32Array(S),
    country: new Int32Array(S),
    kind: new Int8Array(S),
    bound: new Float64Array(S),
    x0: new Float64Array(S),
    frontier: new Float64Array(S),
    muF: new Float64Array(S),
    beta: new Float64Array(S),
    residual: new Float64Array(S),
    shift: new Float64Array(S),
    decay: new Float64Array(S),
    sigma: new Float64Array(S),
    theta: new Float64Array(S),
    xbar: new Float64Array(S),
    exposure: new Float64Array(S),
    loadWorld: new Float64Array(S),
    loadCountry: new Float64Array(S),
    loadPlace: new Float64Array(S),
    loadOwn: new Float64Array(S),
    comp: new Float64Array(S),
    fixed: new Float64Array(S).fill(-1),
    params: new Array(S),
  };
  const indicatorAt = new Map(chosen.map((i, k) => [i.id, k]));
  const world = regimeFor(WORLD_REGIME, scenario);
  const local = regimeFor(LOCAL_REGIME, scenario);
  const expectedImpulse = regimeMeanImpulse(world) + regimeMeanImpulse(local);
  seriesList.forEach((entry, s) => {
    const process = series.process[s];
    const key = measureKey(entry.id, entry.measuredAt);
    const p = seriesParams(process, entry.figure, priors[key], {
      frontier: frontiers[key],
      scenario,
      scale: scales?.[entry.id],
      shift: shifts?.[entry.id],
      pull: pulls?.[entry.id],
    });
    series.params[s] = p;
    series.indicator[s] = indicatorAt.get(entry.id);
    series.seed[s] = stringSeed(entry.key);
    series.kind[s] = kindOf(process);
    series.bound[s] = process.floor ?? process.cap ?? 0;
    series.x0[s] = p.x0;
    series.frontier[s] = p.frontier;
    series.muF[s] = p.muF;
    series.beta[s] = p.beta;
    series.residual[s] = p.residual;
    series.shift[s] = p.shift;
    series.decay[s] = p.decay;
    series.sigma[s] = p.sigma;
    series.theta[s] = p.theta;
    series.xbar[s] = p.xbar;
    series.exposure[s] = p.exposure;
    // The shocks a series shares: a country-level series' place is its
    // country, so the country's share folds into the place's.
    const national = entry.measuredAt === 'country';
    const placeName = national ? entry.country : entry.place;
    let place = placeIndex.get(placeName);
    if (place === undefined) {
      place = placeSeeds.length;
      placeIndex.set(placeName, place);
      placeSeeds.push(stringSeed(placeName));
    }
    let country = countryIndex.get(entry.country);
    if (country === undefined) {
      country = countrySeeds.length;
      countryIndex.set(entry.country, country);
      countrySeeds.push(stringSeed(entry.country));
    }
    series.place[s] = place;
    series.country[s] = country;
    const shares = process.shares || { world: 0, country: 0, place: 0 };
    const sign = process.sign || 1;
    const shareWorld = clamp(shares.world || 0, 0, 1);
    const shareCountry = national ? 0 : clamp(shares.country || 0, 0, 1);
    const sharePlace = clamp(
      (shares.place || 0) + (national ? shares.country || 0 : 0),
      0,
      1,
    );
    const shareOwn = Math.max(0, 1 - shareWorld - shareCountry - sharePlace);
    series.loadWorld[s] = p.sigma * sign * Math.sqrt(shareWorld);
    series.loadCountry[s] = p.sigma * sign * Math.sqrt(shareCountry);
    series.loadPlace[s] = p.sigma * sign * Math.sqrt(sharePlace);
    series.loadOwn[s] = p.sigma * Math.sqrt(shareOwn);
    // A crisis cuts; the trends already carry past cuts, so the expected
    // cut is given back as drift and the mean path is the trend's.
    series.comp[s] = -p.exposure * expectedImpulse;
  });
  // Today's places, from the units (a figure handed down counts for each
  // place that took it, as the ranking does): one table per indicator and
  // walking space, over the figures carried into that space, so a series
  // looks its place up from its own point with no transform (a space is
  // monotone, so the place of the point is the place of the figure).
  const tableIndex = new Map();
  const tables = [];
  const tableFor = (indicator, process) => {
    const key = `${indicator.id}|${process.family}|${process.floor ?? ''}|${process.cap ?? ''}|${process.level ? 1 : 0}`;
    let at = tableIndex.get(key);
    if (at !== undefined) return at;
    const xs = [];
    for (const u of list) {
      const f = u?.values?.[indicator.id];
      if (f && Number.isFinite(Number(f.v))) xs.push(toX(process, Number(f.v)));
    }
    at = tables.length;
    tableIndex.set(key, at);
    tables.push(placeTable(xs, indicator.better));
    return at;
  };
  series.table = new Int32Array(S);
  seriesList.forEach((entry, s) => {
    series.table[s] = tableFor(chosen[series.indicator[s]], series.process[s]);
  });
  // Today's exact scores (the ranking's own places), a saturated share's
  // place kept as it is, each indicator's members for the ranks among the
  // others, and the shared tails.
  const ranks = chosen.map((indicator) => indicatorRanks(list, indicator));
  const members = chosen.map((indicator) => ({
    units: [],
    series: [],
    weight: cleanWeight(weights?.[indicator.id] ?? 1),
    better: indicator.better,
    // Ranked in the walking space when every member walks in the same one
    // (no transform), in the figures' units otherwise.
    space: null,
    mixed: false,
  }));
  const unitList = [];
  const groupIndex = new Map();
  const groups = [];
  list.forEach((u, k) => {
    const { own, tail } = terms[k];
    let sum = 0;
    let weight = 0;
    chosen.forEach((indicator, j) => {
      const r = ranks[j].get(u.id);
      if (r === undefined) return;
      const w = cleanWeight(weights?.[indicator.id] ?? 1);
      sum += r * w;
      weight += w;
      const f = u.values[indicator.id];
      const s = seriesIndex.get(seriesKey(u, indicator.id, f));
      if (series.params[s].saturated) series.fixed[s] = r;
      members[j].units.push(k);
      members[j].series.push(s);
      const space = series.table[s];
      if (members[j].space === null) members[j].space = space;
      else if (members[j].space !== space) members[j].mixed = true;
    });
    let group = -1;
    if (tail.length) {
      const key = tail.map(([s, w]) => `${s}:${w}`).join(',');
      group = groupIndex.get(key);
      if (group === undefined) {
        group = groups.length;
        groupIndex.set(key, group);
        groups.push({
          series: Int32Array.from(tail.map(([s]) => s)),
          weights: Float64Array.from(tail.map(([, w]) => w)),
        });
      }
    }
    unitList.push({
      id: u.id,
      own: Int32Array.from(own.map(([s]) => s)),
      weights: Float64Array.from(own.map(([, w]) => w)),
      group,
      total: weight,
      today: weight > 0 ? sum / weight : NaN,
    });
  });
  return {
    level,
    scenario,
    indicatorIds: chosen.map((i) => i.id),
    weights: { ...weights },
    scales: { ...scales },
    shifts: { ...shifts },
    pulls: { ...pulls },
    priors,
    frontiers,
    series,
    places: { count: placeSeeds.length, seed: Uint32Array.from(placeSeeds) },
    countries: {
      count: countrySeeds.length,
      seed: Uint32Array.from(countrySeeds),
    },
    regimes: { world, local },
    tables,
    people,
    growth,
    weighted,
    members: members.map((m) => ({
      units: Int32Array.from(m.units),
      series: Int32Array.from(m.series),
      weight: m.weight,
      better: m.better,
      mixed: m.mixed,
    })),
    groups,
    units: unitList,
    byId: new Map(unitList.map((u, k) => [u.id, k])),
  };
}

/** A series' place for a point of its walk: a saturated share's own, else the point's place among today's (in the series' own space). */
function placeOfPoint(plan, s, x) {
  const { series, tables } = plan;
  const fixed = series.fixed[s];
  if (fixed >= 0) return fixed;
  return placeAt(tables[series.table[s]], x);
}

/**
 * The world's shared draws for every run and year: a normal swing, and the
 * world regime's impulse (a cut in a crisis year, a rebound after, 0
 * otherwise), from one chain per run.
 */
function worldFactors(plan, runs, years, seed, crises) {
  const T1 = years + 1;
  const normal = normalTable();
  const swing = new Float32Array(runs * T1);
  const impulse = new Float32Array(runs * T1);
  const regime = plan.regimes.world;
  const step = [0, 0];
  for (let k = 0; k < runs; k++) {
    let state = 0;
    for (let t = 1; t <= years; t++) {
      swing[k * T1 + t] = normal[draw(seed ^ 0x6a09e667, k, t) >>> 16];
      if (!crises) continue;
      regimeStep(state, draw(seed ^ 0xbb67ae85, k, t), regime, step);
      state = step[0];
      impulse[k * T1 + t] = step[1];
    }
  }
  return { swing, impulse, T1 };
}

/** The series' drift in year t at point x: the frontier's move and pull, or the return to the usual level, plus the fading residual (the hindcast's trend shift in it). */
function driftOf(series, s, x, t, residualNow) {
  if (series.theta[s] !== 0)
    return series.theta[s] * (series.xbar[s] - x) + residualNow;
  return (
    series.muF[s] +
    series.beta[s] * (series.frontier[s] + series.muF[s] * t - x) +
    residualNow
  );
}

/** The quantiles, mean and chances of one unit-year from its runs' score histogram. */
function summarise(hist, runs, sum, ups, downs, out, at) {
  const want = [0.1, 0.5, 0.9].map((q) => q * runs);
  const found = [NaN, NaN, NaN];
  let cum = 0;
  for (let b = 0; b <= SCORE_BINS; b++) {
    cum += hist[b];
    for (let q = 0; q < 3; q++)
      if (Number.isNaN(found[q]) && cum >= want[q]) found[q] = b / 2;
  }
  out.p10[at] = found[0];
  out.p50[at] = found[1];
  out.p90[at] = found[2];
  out.mean[at] = sum / runs;
  out.up[at] = Math.round((100 * ups) / runs);
  out.down[at] = Math.round((100 * downs) / runs);
}

/** A score's histogram bin. */
const binOf = (score) => {
  const bin = (score * 2 + 0.5) | 0;
  return bin < 0 ? 0 : bin > SCORE_BINS ? SCORE_BINS : bin;
};

/** Six typed arrays for U units over T1 years: the three percentiles, the mean, the two chances. */
function emptySummary(U, T1) {
  return {
    p10: new Float32Array(U * T1).fill(NaN),
    p50: new Float32Array(U * T1).fill(NaN),
    p90: new Float32Array(U * T1).fill(NaN),
    mean: new Float32Array(U * T1).fill(NaN),
    up: new Uint8Array(U * T1),
    down: new Uint8Array(U * T1),
  };
}

/** Year 0 of a summary: today's exact score, held for certain. */
function writeToday(out, at, today) {
  out.p10[at] = today;
  out.p50[at] = today;
  out.p90[at] = today;
  out.mean[at] = today;
  out.up[at] = today >= ABUNDANT_SCORE ? 100 : 0;
  out.down[at] = today <= SCARCE_SCORE ? 100 : 0;
}

/**
 * Simulate the plan: every series walks `years` years on `runs` runs, and
 * every unit's score on each run is summed up per year as its 10th, 50th
 * and 90th percentiles, its mean and the chances it is abundant or scarce,
 * measured against today (`p10`…`down`) and, unless `among` is false, among
 * the other places in that year (`rp10`…`rdown`, every place weighed by its
 * people; the ranks cost about as much as the walk, so a level of
 * RANK_STRIDE_UNITS places or more ranks every other year and reads the
 * years between from their neighbours, `rankEvery` saying how often; the
 * option `rankEvery` sets it), with the world's
 * figures by year (`world`: the people-weighted score's percentiles and
 * mean, the mean shares of people in abundant and scarce places). Year 0 is
 * today's exact score. `onProgress(year, years)` after each year.
 * @returns {{years: number, runs: number, seed: number, crises: boolean, scenario: string, ids: string[], today: Float32Array, world: object, weighted: boolean, p10: Float32Array, p50: Float32Array, p90: Float32Array, mean: Float32Array, up: Uint8Array, down: Uint8Array, rp10: Float32Array, rp50: Float32Array, rp90: Float32Array, rmean: Float32Array, rup: Uint8Array, rdown: Uint8Array, ms?: number}}
 */
export function simulate(plan, options = {}) {
  const runs = cleanRuns(options.runs) || FORECAST_RUNS[0];
  const seed = Number(options.seed) >>> 0 || 1;
  const crises = options.crises !== false;
  const withAmong = options.among !== false;
  const years = Math.max(
    1,
    Math.min(FORECAST_YEARS, Math.round(options.years) || FORECAST_YEARS),
  );
  const T1 = years + 1;
  const { series, units, groups, members, places, countries, tables } = plan;
  const S = series.count;
  const U = units.length;
  const P = places.count;
  const C = countries.count;
  const normal = normalTable();
  const factors = worldFactors(plan, runs, years, seed, crises);
  const local = plan.regimes.local;
  const x = new Float64Array(S * runs);
  for (let s = 0; s < S; s++) x.fill(series.x0[s], s * runs, (s + 1) * runs);
  // Each series' residual trend with the hindcast's trend shift in it; the
  // two fade together.
  const residual = Float64Array.from(
    series.residual,
    (r, s) => r + series.shift[s],
  );
  const countrySwing = new Float32Array(C * runs);
  const placeSwing = new Float32Array(P * runs);
  const placeState = new Uint8Array(P * runs);
  const placeImpulse = new Float32Array(P * runs);
  const step = [0, 0];
  const today = new Float32Array(U).fill(NaN);
  const against = emptySummary(U, T1);
  const among = withAmong ? emptySummary(U, T1) : null;
  // The ranks every `rankEvery` years (and the last), the years between
  // read from their neighbours: every year by default under
  // RANK_STRIDE_UNITS places, every other year from there.
  const rankEvery = !among
    ? 1
    : Math.max(1, Math.round(options.rankEvery)) ||
      (U >= RANK_STRIDE_UNITS ? 2 : 1);
  const ranked = new Uint8Array(T1);
  ranked[0] = 1;
  // The world's figures: every unit weighed by its people, against today;
  // the people of a year are today's grown at their slowing rates.
  const { people, growth } = plan;
  const peopleNow = Float64Array.from(people);
  const worldSum = new Float64Array(runs);
  const worldUp = new Float64Array(runs);
  const worldDown = new Float64Array(runs);
  const world = {
    p10: new Float32Array(T1).fill(NaN),
    p50: new Float32Array(T1).fill(NaN),
    p90: new Float32Array(T1).fill(NaN),
    mean: new Float32Array(T1).fill(NaN),
    up: new Float32Array(T1).fill(NaN),
    down: new Float32Array(T1).fill(NaN),
  };
  let W = 0;
  let todaySum = 0;
  let todayUp = 0;
  let todayDown = 0;
  units.forEach((u, k) => {
    if (!(u.total > 0)) return;
    today[k] = u.today;
    writeToday(against, k * T1, u.today);
    if (among) writeToday(among, k * T1, u.today);
    const w = people[k];
    W += w;
    todaySum += w * u.today;
    if (u.today >= ABUNDANT_SCORE) todayUp += w;
    if (u.today <= SCARCE_SCORE) todayDown += w;
  });
  if (W > 0) {
    const score = todaySum / W;
    world.p10[0] = score;
    world.p50[0] = score;
    world.p90[0] = score;
    world.mean[0] = score;
    world.up[0] = (100 * todayUp) / W;
    world.down[0] = (100 * todayDown) / W;
  }
  /** Every series' place this year on every run, looked up once. */
  const placeNow = new Float32Array(S * runs);
  const tails = groups.map(() => new Float64Array(runs));
  const hist = new Uint32Array(SCORE_BINS + 1);
  const relative = new Float64Array(withAmong ? U * runs : 0);
  const most = members.reduce((m, g) => Math.max(m, g.units.length), 0);
  const points = new Float64Array(withAmong ? most * runs : 0);
  const counts = new Float64Array(RANK_BINS + 1);
  const { swing: worldSwing, impulse: worldImpulse, T1: stride } = factors;
  const profile = options.profile
    ? { places: 0, series: 0, against: 0, among: 0 }
    : null;
  let mark = profile ? performance.now() : 0;
  const lap = (name) => {
    if (!profile) return;
    const nowMs = performance.now();
    profile[name] += nowMs - mark;
    mark = nowMs;
  };
  for (let t = 1; t <= years; t++) {
    // The countries' and places' swings this year, and the local regimes.
    for (let c = 0; c < C; c++) {
      const sd = countries.seed[c];
      for (let k = 0; k < runs; k++)
        countrySwing[c * runs + k] = normal[draw(sd, k, t) >>> 16];
    }
    for (let p = 0; p < P; p++) {
      const sd = places.seed[p];
      const sdRegime = sd ^ 0x9e3779b9;
      for (let k = 0; k < runs; k++) {
        const at = p * runs + k;
        placeSwing[at] = normal[draw(sd, k, t) >>> 16];
        if (!crises) continue;
        regimeStep(placeState[at], draw(sdRegime, k, t), local, step);
        placeState[at] = step[0];
        placeImpulse[at] = step[1];
      }
    }
    lap('places');
    // Every series steps once per run (detailFor repeats this arithmetic
    // for one place, and its test holds the two to the same numbers).
    for (let s = 0; s < S; s++) {
      residual[s] *= series.decay[s];
      const residualNow = residual[s];
      const row = s * runs;
      const seedS = series.seed[s];
      const comp = series.comp[s];
      const lw = series.loadWorld[s];
      const lc = series.loadCountry[s];
      const lp = series.loadPlace[s];
      const lo = series.loadOwn[s];
      const exposure = series.exposure[s];
      const theta = series.theta[s];
      const xbar = series.xbar[s];
      const muF = series.muF[s];
      const beta = series.beta[s];
      const target = series.frontier[s] + muF * t;
      const cRow = series.country[s] * runs;
      const pRow = series.place[s] * runs;
      for (let k = 0; k < runs; k++) {
        const xv = x[row + k];
        const drift =
          (theta !== 0 ? theta * (xbar - xv) : muF + beta * (target - xv)) +
          residualNow;
        x[row + k] =
          xv +
          drift +
          comp +
          lw * worldSwing[k * stride + t] +
          lc * countrySwing[cRow + k] +
          lp * placeSwing[pRow + k] +
          lo * normal[draw(seedS, k, t) >>> 16] +
          exposure * (worldImpulse[k * stride + t] + placeImpulse[pRow + k]);
      }
    }
    lap('series');
    // Every series' place this year, then the shared tails, then every
    // unit's score against today.
    for (let s = 0; s < S; s++) {
      const row = s * runs;
      const fixed = series.fixed[s];
      if (fixed >= 0) {
        placeNow.fill(fixed, row, row + runs);
        continue;
      }
      const table = tables[series.table[s]];
      const { lo, hi, bins, scale } = table;
      const cells = table.table;
      for (let k = 0; k < runs; k++) {
        const xv = x[row + k];
        if (xv <= lo) placeNow[row + k] = cells[0];
        else if (xv >= hi) placeNow[row + k] = cells[bins];
        else {
          const f = (xv - lo) * scale;
          const i = f | 0;
          placeNow[row + k] = cells[i] + (cells[i + 1] - cells[i]) * (f - i);
        }
      }
    }
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const tail = tails[gi];
      tail.fill(0);
      for (let j = 0; j < g.series.length; j++) {
        const row = g.series[j] * runs;
        const w = g.weights[j];
        for (let k = 0; k < runs; k++) tail[k] += w * placeNow[row + k];
      }
    }
    worldSum.fill(0);
    worldUp.fill(0);
    worldDown.fill(0);
    const grown = peopleYears(t);
    W = 0;
    for (let k = 0; k < U; k++) {
      peopleNow[k] = people[k] * Math.exp(growth[k] * grown);
      if (units[k].total > 0) W += peopleNow[k];
    }
    for (let k = 0; k < U; k++) {
      const u = units[k];
      if (!(u.total > 0)) continue;
      hist.fill(0);
      let sum = 0;
      let ups = 0;
      let downs = 0;
      const tail = u.group >= 0 ? tails[u.group] : null;
      const own = u.own;
      const weights = u.weights;
      const total = u.total;
      const w = peopleNow[k];
      for (let r = 0; r < runs; r++) {
        let score = tail ? tail[r] : 0;
        for (let j = 0; j < own.length; j++)
          score += weights[j] * placeNow[own[j] * runs + r];
        score /= total;
        hist[binOf(score)] += 1;
        sum += score;
        worldSum[r] += w * score;
        if (score >= ABUNDANT_SCORE) {
          ups += 1;
          worldUp[r] += w;
        }
        if (score <= SCARCE_SCORE) {
          downs += 1;
          worldDown[r] += w;
        }
      }
      summarise(hist, runs, sum, ups, downs, against, k * T1 + t);
    }
    // The world this year: on each run its people's mean score and the
    // shares of them in abundant and scarce places; over the runs, the
    // score's percentiles and the mean shares.
    if (W > 0) {
      let sum = 0;
      let up = 0;
      let down = 0;
      for (let r = 0; r < runs; r++) {
        worldSum[r] /= W;
        sum += worldSum[r];
        up += worldUp[r];
        down += worldDown[r];
      }
      const [q10, q50, q90] = quantilesOf(worldSum);
      world.p10[t] = q10;
      world.p50[t] = q50;
      world.p90[t] = q90;
      world.mean[t] = sum / runs;
      world.up[t] = (100 * up) / (runs * W);
      world.down[t] = (100 * down) / (runs * W);
    }
    lap('against');
    if (among && (t % rankEvery === 0 || t === years)) {
      ranked[t] = 1;
      // Among the others: on each run, each indicator's members ranked by
      // their figures that year (RANK_BINS bins over the year's range), each
      // weighed by its people, the weighted mean of a unit's ranks its
      // score. Members of one walking
      // space are ranked by their points (the space is monotone); a mixed
      // indicator by the figures themselves. Plain loops: a closure over
      // the state here would slow every loop that reads it.
      relative.fill(0);
      for (let gi = 0; gi < members.length; gi++) {
        const g = members[gi];
        const n = g.units.length;
        const gUnits = g.units;
        const gSeries = g.series;
        if (n < 2) {
          for (let j = 0; j < n; j++)
            for (let k = 0; k < runs; k++)
              relative[gUnits[j] * runs + k] += g.weight * 50;
          continue;
        }
        // The points to rank: the walk's own, or the figures of a mixed
        // indicator, copied once.
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = 0; j < n; j++) {
          const s = gSeries[j];
          const row = s * runs;
          const kind = series.kind[s];
          const bound = series.bound[s];
          const to = j * runs;
          if (g.mixed)
            for (let k = 0; k < runs; k++)
              points[to + k] = valueOf(kind, bound, x[row + k]);
          else for (let k = 0; k < runs; k++) points[to + k] = x[row + k];
          for (let k = 0; k < runs; k++) {
            const v = points[to + k];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        const span = hi - lo;
        const scale = span > 0 ? RANK_BINS / span : 0;
        const flip = g.better === 'low';
        const weight = g.weight;
        let total = 0;
        for (let j = 0; j < n; j++) total += peopleNow[gUnits[j]];
        for (let k = 0; k < runs; k++) {
          counts.fill(0);
          for (let j = 0; j < n; j++)
            counts[((points[j * runs + k] - lo) * scale) | 0] +=
              peopleNow[gUnits[j]];
          // Each bin's people become the people below it.
          let below = 0;
          for (let b = 0; b <= RANK_BINS; b++) {
            const here = counts[b];
            counts[b] = below;
            below += here;
          }
          // A member's rank: the share of people in places behind it, its
          // own bin's counted half (so the people average 50).
          for (let j = 0; j < n; j++) {
            const b = ((points[j * runs + k] - lo) * scale) | 0;
            const inBin = (b < RANK_BINS ? counts[b + 1] : below) - counts[b];
            const rank =
              total > 0 ? ((counts[b] + inBin / 2) / total) * 100 : 50;
            relative[gUnits[j] * runs + k] +=
              weight * (flip ? 100 - rank : rank);
          }
        }
      }
      for (let k = 0; k < U; k++) {
        const u = units[k];
        if (!(u.total > 0)) continue;
        hist.fill(0);
        let sum = 0;
        let ups = 0;
        let downs = 0;
        const total = u.total;
        for (let r = 0; r < runs; r++) {
          const score = relative[k * runs + r] / total;
          hist[binOf(score)] += 1;
          sum += score;
          if (score >= ABUNDANT_SCORE) ups += 1;
          if (score <= SCARCE_SCORE) downs += 1;
        }
        summarise(hist, runs, sum, ups, downs, among, k * T1 + t);
      }
      lap('among');
    }
    options.onProgress?.(t, years);
  }
  // The years between ranked years: each figure between its neighbours'.
  if (among && rankEvery > 1) {
    const keys = ['p10', 'p50', 'p90', 'mean', 'up', 'down'];
    let before = 0;
    for (let t = 1; t < T1; t++) {
      if (ranked[t]) {
        before = t;
        continue;
      }
      let after = t + 1;
      while (after < T1 && !ranked[after]) after++;
      const share = (t - before) / (after - before);
      for (let k = 0; k < U; k++) {
        if (!(units[k].total > 0)) continue;
        const row = k * T1;
        for (const key of keys) {
          const column = among[key];
          const a = column[row + before];
          const b = column[row + after];
          const value = a + (b - a) * share;
          column[row + t] =
            key === 'up' || key === 'down' ? Math.round(value) : value;
        }
      }
    }
  }
  return {
    years,
    runs,
    seed,
    crises,
    scenario: plan.scenario,
    ids: units.map((u) => u.id),
    today,
    world,
    weighted: Boolean(plan.weighted),
    rankEvery: among ? rankEvery : null,
    ...against,
    ...(among
      ? {
          rp10: among.p10,
          rp50: among.p50,
          rp90: among.p90,
          rmean: among.mean,
          rup: among.up,
          rdown: among.down,
        }
      : {}),
    ...(profile ? { profile } : {}),
  };
}

/** The sorted quantiles of a typed array's copy: the 10th, 50th and 90th. */
function quantilesOf(values) {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  const at = (q) =>
    sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  return [at(0.1), at(0.5), at(0.9)];
}

/**
 * One unit simulated on its own, with the same draws the map used: for each
 * of its indicators the figure's 10th, 50th and 90th percentiles and the
 * places they stand at, year by year, and its score's summary against
 * today, the same as the map's row for it (the rank among the others needs
 * every place, so it is the map's alone). Null for an unknown unit or one
 * without figures.
 * @returns {{id: string, years: number, runs: number, indicators: Object<string, {from: string, p10: Float32Array, p50: Float32Array, p90: Float32Array, placeLow: Float32Array, placeMid: Float32Array, placeHigh: Float32Array}>, score: {p10: Float32Array, p50: Float32Array, p90: Float32Array, mean: Float32Array, up: Uint8Array, down: Uint8Array}}|null}
 */
export function detailFor(plan, unitId, options = {}) {
  const k0 = plan.byId.get(String(unitId));
  if (k0 === undefined) return null;
  const u = plan.units[k0];
  if (!(u.total > 0)) return null;
  const runs = cleanRuns(options.runs) || FORECAST_RUNS[0];
  const seed = Number(options.seed) >>> 0 || 1;
  const crises = options.crises !== false;
  const years = Math.max(
    1,
    Math.min(FORECAST_YEARS, Math.round(options.years) || FORECAST_YEARS),
  );
  const T1 = years + 1;
  const { series, groups, places, countries } = plan;
  const normal = normalTable();
  const world = worldFactors(plan, runs, years, seed, crises);
  const local = plan.regimes.local;
  const mine = [];
  for (let j = 0; j < u.own.length; j++)
    mine.push([u.own[j], u.weights[j], true]);
  if (u.group >= 0) {
    const g = groups[u.group];
    for (let j = 0; j < g.series.length; j++)
      mine.push([g.series[j], g.weights[j], false]);
  }
  // The local regimes and swings of the places these series belong to,
  // replayed over the years as the map did.
  const placeRows = new Map();
  const step = [0, 0];
  for (const [s] of mine) {
    const p = series.place[s];
    if (placeRows.has(p)) continue;
    const swing = new Float32Array(runs * T1);
    const impulse = new Float32Array(runs * T1);
    const sd = places.seed[p];
    const sdRegime = sd ^ 0x9e3779b9;
    for (let k = 0; k < runs; k++) {
      let state = 0;
      for (let t = 1; t <= years; t++) {
        swing[k * T1 + t] = normal[draw(sd, k, t) >>> 16];
        if (!crises) continue;
        regimeStep(state, draw(sdRegime, k, t), local, step);
        state = step[0];
        impulse[k * T1 + t] = step[1];
      }
    }
    placeRows.set(p, { swing, impulse });
  }
  const countryRows = new Map();
  for (const [s] of mine) {
    const c = series.country[s];
    if (countryRows.has(c)) continue;
    const swing = new Float32Array(runs * T1);
    const sd = countries.seed[c];
    for (let k = 0; k < runs; k++)
      for (let t = 1; t <= years; t++)
        swing[k * T1 + t] = normal[draw(sd, k, t) >>> 16];
    countryRows.set(c, swing);
  }
  const place = (s, xv) => placeOfPoint(plan, s, xv);
  const scores = new Float64Array(runs * T1);
  const indicators = {};
  for (const [s, w, own] of mine) {
    const process = series.process[s];
    const paths = new Float64Array(runs * T1);
    for (let k = 0; k < runs; k++) paths[k * T1] = series.x0[s];
    let residualNow = series.residual[s] + series.shift[s];
    const pr = placeRows.get(series.place[s]);
    const cs = countryRows.get(series.country[s]);
    for (let t = 1; t <= years; t++) {
      residualNow *= series.decay[s];
      for (let k = 0; k < runs; k++) {
        const at = k * T1 + t;
        const xv = paths[at - 1];
        paths[at] =
          xv +
          driftOf(series, s, xv, t, residualNow) +
          series.comp[s] +
          series.loadWorld[s] * world.swing[at] +
          series.loadCountry[s] * cs[at] +
          series.loadPlace[s] * pr.swing[at] +
          series.loadOwn[s] * normal[draw(series.seed[s], k, t) >>> 16] +
          series.exposure[s] * (world.impulse[at] + pr.impulse[at]);
      }
    }
    const entry = {
      from: own ? 'own' : 'shared',
      p10: new Float32Array(T1),
      p50: new Float32Array(T1),
      p90: new Float32Array(T1),
      placeLow: new Float32Array(T1),
      placeMid: new Float32Array(T1),
      placeHigh: new Float32Array(T1),
    };
    const column = new Float64Array(runs);
    for (let t = 0; t <= years; t++) {
      for (let k = 0; k < runs; k++) {
        const xv = paths[k * T1 + t];
        column[k] = xv;
        scores[k * T1 + t] += w * place(s, xv);
      }
      const [q10, q50, q90] = quantilesOf(column);
      entry.p10[t] = fromX(process, q10);
      entry.p50[t] = fromX(process, q50);
      entry.p90[t] = fromX(process, q90);
      const a = place(s, q10);
      const b = place(s, q90);
      entry.placeLow[t] = Math.min(a, b);
      entry.placeHigh[t] = Math.max(a, b);
      entry.placeMid[t] = place(s, q50);
    }
    indicators[series.ids[s]] = entry;
  }
  const score = {
    p10: new Float32Array(T1),
    p50: new Float32Array(T1),
    p90: new Float32Array(T1),
    mean: new Float32Array(T1),
    up: new Uint8Array(T1),
    down: new Uint8Array(T1),
  };
  const hist = new Uint32Array(SCORE_BINS + 1);
  writeToday(score, 0, u.today);
  for (let t = 1; t <= years; t++) {
    hist.fill(0);
    let sum = 0;
    let ups = 0;
    let downs = 0;
    for (let k = 0; k < runs; k++) {
      const value = scores[k * T1 + t] / u.total;
      hist[binOf(value)] += 1;
      sum += value;
      if (value >= ABUNDANT_SCORE) ups += 1;
      if (value <= SCARCE_SCORE) downs += 1;
    }
    summarise(hist, runs, sum, ups, downs, score, t);
  }
  return { id: u.id, years, runs, seed, crises, indicators, score };
}

/**
 * What one series' model says, in the figure's own units: the change a
 * typical first year brings (the frontier's pull, the residual trend and
 * the hindcast's trend shift) and the usual swing around it, the family
 * with its frontier, floor, ceiling or usual level, how many steps of
 * history spoke, and the hindcast's swing scale and trend shift (the
 * shift's part of the change too, `trendShift`) where there are any.
 */
export function seriesSummary(plan, s) {
  const id = plan.series.ids[s];
  const process = plan.series.process[s];
  const p = plan.series.params[s];
  const v0 = p.v0;
  const shiftNow = process.family === 'revert' ? p.shift : p.shift * p.decay;
  const drift =
    (process.family === 'revert'
      ? p.theta * (p.xbar - p.x0)
      : p.muF + p.beta * (p.frontier - p.x0) + p.residual * p.decay) + shiftNow;
  const trend = fromX(process, p.x0 + drift) - v0;
  const spread =
    (fromX(process, p.x0 + p.sigma) - fromX(process, p.x0 - p.sigma)) / 2;
  const out = {
    id,
    family: process.family,
    v0,
    trend,
    spread,
    n: p.n,
    saturated: p.saturated,
    residual: p.residual,
  };
  if (process.family === 'floor') out.floor = process.floor;
  if (process.family === 'ceiling') out.cap = process.cap;
  if (process.family === 'revert') out.level = fromX(process, p.xbar);
  else out.frontier = fromX(process, p.frontier);
  const scale = plan.scales?.[id];
  if (Number.isFinite(scale) && scale !== 1) out.scale = scale;
  if (p.shift) {
    out.shift = p.shift;
    out.trendShift = fromX(process, p.x0 + shiftNow) - v0;
  }
  const pull = plan.pulls?.[id];
  if (Number.isFinite(pull) && pull !== 1 && p.beta) out.pull = pull;
  return out;
}

/** The series a unit's figure for an indicator rides on, in a plan; -1 with none. */
export function seriesOf(plan, unitId, indicatorId) {
  const k = plan.byId.get(String(unitId));
  if (k === undefined) return -1;
  const u = plan.units[k];
  for (let j = 0; j < u.own.length; j++)
    if (plan.series.ids[u.own[j]] === indicatorId) return u.own[j];
  if (u.group >= 0)
    for (const s of plan.groups[u.group].series)
      if (plan.series.ids[s] === indicatorId) return s;
  return -1;
}

/**
 * The level's typical model, one line per indicator: a series at the
 * median of today's figures measured at the level itself, with no history
 * of its own, so the priors and the frontier speak.
 */
export function typicalModel(plan) {
  return plan.indicatorIds
    .map((indicatorId) => {
      const values = [];
      const measuredAt = plan.level;
      plan.series.ids.forEach((id, s) => {
        if (id === indicatorId) values.push(plan.series.params[s].v0);
      });
      const v0 = median(values);
      if (v0 === null) return null;
      const process = processFor(indicatorId, measuredAt);
      const key = `${indicatorId}|${measuredAt}`;
      const prior = plan.priors[key] || priorFor(process, []);
      const p = seriesParams(process, { v: v0, n: 0 }, prior, {
        frontier: plan.frontiers[key],
        scenario: plan.scenario,
        scale: plan.scales?.[indicatorId],
        shift: plan.shifts?.[indicatorId],
        pull: plan.pulls?.[indicatorId],
      });
      return seriesSummary(
        {
          series: { ids: [indicatorId], process: [process], params: [p] },
          scales: plan.scales,
          pulls: plan.pulls,
        },
        0,
      );
    })
    .filter(Boolean);
}

/**
 * The world's row at a year, against today: every place weighed by its
 * people (each once when none are known, `weighted` false), the weighted
 * score's percentiles and mean over the runs, the mean shares of people in
 * abundant (`up`) and scarce (`down`) places in percent, and today's three
 * figures; null without a result.
 */
export function worldAt(result, year) {
  const world = result?.world;
  if (!world) return null;
  const t = cleanYear(year);
  if (!Number.isFinite(world.p50[t])) return null;
  return {
    p10: world.p10[t],
    p50: world.p50[t],
    p90: world.p90[t],
    mean: world.mean[t],
    up: world.up[t],
    down: world.down[t],
    today: world.p50[0],
    upToday: world.up[0],
    downToday: world.down[0],
    weighted: Boolean(result.weighted),
  };
}

/** A result's row for a unit at a year on a scale (against today, or among the others), or null. */
export function forecastAt(result, index, year, scale = 'today') {
  if (!result || !Number.isInteger(index) || index < 0) return null;
  const T1 = result.years + 1;
  const t = cleanYear(year);
  const at = index * T1 + t;
  if (at >= result.p50.length || Number.isNaN(result.p50[at])) return null;
  const r = cleanScale(scale) === 'others' && result.rp50 ? 'r' : '';
  return {
    p10: result[`${r}p10`][at],
    p50: result[`${r}p50`][at],
    p90: result[`${r}p90`][at],
    mean: result[`${r}mean`][at],
    up: result[`${r}up`][at],
    down: result[`${r}down`][at],
    today: result.today[index],
  };
}

/**
 * The value a view colours the map by, for a unit's row: a score (p50, p10,
 * p90), a chance in percent (up, down), or the change from today in points.
 */
export function viewValue(row, view) {
  if (!row) return null;
  switch (cleanForecastView(view)) {
    case 'p10':
      return row.p10;
    case 'p90':
      return row.p90;
    case 'up':
      return row.up;
    case 'down':
      return row.down;
    case 'change':
      return row.p50 - row.today;
    default:
      return row.p50;
  }
}

/** A view's value on the 0–100 ramp: a scarcity chance reversed, a change centred on 50. */
export function viewRampScore(value, view) {
  if (!Number.isFinite(value)) return null;
  switch (cleanForecastView(view)) {
    case 'down':
      return 100 - value;
    case 'change':
      return 50 + value;
    default:
      return value;
  }
}

// --- the hindcast ------------------------------------------------------------------------

/** The hindcast replays the model from this many years before the newest figures. */
export const HINDCAST_YEARS = 10;
const HINDCAST_RUNS = 100;
/** The hindcast tests an indicator with at least this many figures, and its trend shift counts this many more as having missed nothing. */
const HINDCAST_CASES = 10;
/** The 10th to 90th percentile band is 2 × 1.2816 standard deviations wide when the swing is normal. */
const BAND_SIGMAS = 1.2816;
/** The trend a year added to a trend path to measure how far a year's trend moves it. */
const TREND_PROBE = 0.01;

/**
 * A series' trend path: its walk with no swings and no crises (the mean
 * path, since a crisis's expected cut is given back as drift), in the
 * walking space, from today over `years`; `extra` adds to its trend a
 * year, fading as the residual does (the hindcast probes the response).
 */
export function trendPath(plan, s, years, extra = 0) {
  const { series } = plan;
  const out = new Float64Array(years + 1);
  let x = series.x0[s];
  let residual = series.residual[s] + series.shift[s] + extra;
  out[0] = x;
  for (let t = 1; t <= years; t++) {
    residual *= series.decay[s];
    x += driftOf(series, s, x, t, residual);
    out[t] = x;
  }
  return out;
}

/**
 * The hindcast: the model replayed over windows of the past (`windows`:
 * each the level's units as their figures stood at `from` (`past`) and
 * HINDCAST_YEARS later (`present`, today's for the newest window), for
 * each indicator alone, and the later figures measured against the
 * earlier yardstick (money in the earlier dollars, as the walk projected
 * it). A figure counts only where then and later it came from the same
 * kind of source (a place's own figure both times, or its country's both
 * times), five to thirteen years apart. First the trends: each window's
 * distinct series' trend path is run to the later figure and its miss, in
 * the walking space, divided by how far one unit of trend a year would
 * have moved that path (`trendPath` probed); the median of those over the
 * windows, shrunk as if HINDCAST_CASES more figures had missed nothing and
 * kept within SHIFT_SWINGS typical swings, is the indicator's trend shift.
 * Then the swings: each window's replay with the shift (HINDCAST_RUNS
 * runs) gives each figure a band, and from the pooled standardised errors
 * comes the swing scale that would have made the 8-of-10 band hold about
 * 8 of 10 (the 80th percentile of the errors over the normal's), kept
 * between a half and SCALE_MAX; then the replay again with both, for the
 * share of figures the band held (a share at its ceiling holds when the
 * later figure is still within the ceiling's zone). `{ from, to, windows:
 * [{ from, to, tested, held }], indicators: { id: { tested, held, scale,
 * shift, pull } }, tested, held }`, `from` the earliest window's and `to`
 * the latest's, `held` in percent, `shift` in the walking space a year and
 * `pull` the factor on the pull toward the frontier (pullFit); an indicator
 * with fewer than HINDCAST_CASES figures to test over the windows is left
 * out, and one with no scale, shift or pull to speak of keeps 1, 0 and 1.
 * @param {Array<{past: object[], present: object[], from: number, to: number}>} windows
 * @param {{level: string, scenario?: string, seed?: number}} options
 */
export function hindcast(windows, { level, scenario, seed = 11 } = {}) {
  const list = (Array.isArray(windows) ? windows : [])
    .filter(
      (w) =>
        Array.isArray(w?.past) &&
        Array.isArray(w?.present) &&
        Number.isFinite(w?.from) &&
        Number.isFinite(w?.to),
    )
    .sort((a, b) => b.from - a.from);
  const out = {
    from: list.length ? Math.min(...list.map((w) => w.from)) : null,
    to: list.length ? Math.max(...list.map((w) => w.to)) : null,
    windows: list.map((w) => ({ from: w.from, to: w.to, tested: 0, held: 0 })),
    indicators: {},
    tested: 0,
    held: 0,
  };
  const laterById = list.map((w) => new Map(w.present.map((u) => [u.id, u])));
  for (const indicator of ABUNDANCE_INDICATORS) {
    if (!FORECAST_PROCESSES[indicator.id]) continue;
    const id = indicator.id;
    // The cases per window: a place with a figure then and later, from the
    // same kind of source, five to thirteen years apart.
    const cases = list.map((w, i) => {
      const found = [];
      for (const p of w.past) {
        const was = p.values?.[id];
        const now = laterById[i].get(p.id)?.values?.[id];
        if (
          !was ||
          !now ||
          !Number.isFinite(was.year) ||
          !Number.isFinite(now.year)
        )
          continue;
        if ((was.from || 'own') !== (now.from || 'own')) continue;
        const horizon = now.year - was.year;
        if (horizon < 5 || horizon > HINDCAST_YEARS + 3) continue;
        found.push({ unitId: p.id, horizon, actual: Number(now.v) });
      }
      return found;
    });
    if (cases.reduce((sum, found) => sum + found.length, 0) < HINDCAST_CASES)
      continue;
    const planFor = (w, shift, scale, pull) =>
      buildPlan(
        w.past,
        [id],
        {},
        {
          level,
          scenario,
          scales: scale === 1 ? {} : { [id]: scale },
          shifts: shift === 0 ? {} : { [id]: shift },
          pulls: pull === 1 ? {} : { [id]: pull },
        },
      );
    /** The later figure in the walking space of the series the place rode on, in the earlier dollars for money. */
    const pointOf = (plan, s, c) => {
      const process = plan.series.process[s];
      const value =
        process.family === 'growth' && process.deflate
          ? c.actual / Math.exp(process.deflate * c.horizon)
          : c.actual;
      return toX(process, value);
    };
    // The trends: each window's distinct series' miss per unit of trend a
    // year, beside the pull on the series (beta × its gap to the frontier,
    // in the walking space a year) for the pull's calibration.
    const bare = list.map((w) => planFor(w, 0, 1, 1));
    const ratios = [];
    const pulled = [];
    const typical = [];
    list.forEach((w, i) => {
      const plan = bare[i];
      if (!plan.tables.length) return;
      for (const key of Object.keys(plan.priors))
        if (key.startsWith(`${id}|`)) typical.push(plan.priors[key].s);
      const seen = new Set();
      for (const c of cases[i]) {
        const s = seriesOf(plan, c.unitId, id);
        if (s < 0 || seen.has(s) || plan.series.params[s].saturated) continue;
        seen.add(s);
        const path = trendPath(plan, s, c.horizon);
        const probed = trendPath(plan, s, c.horizon, TREND_PROBE);
        const response = (probed[c.horizon] - path[c.horizon]) / TREND_PROBE;
        const point = pointOf(plan, s, c);
        if (!(response > 0.5) || !Number.isFinite(point)) continue;
        ratios.push((point - path[c.horizon]) / response);
        pulled.push(
          plan.series.beta[s] * (plan.series.frontier[s] - plan.series.x0[s]),
        );
      }
    });
    let shift = 0;
    let pull = 1;
    if (ratios.length >= HINDCAST_CASES && typical.length) {
      const n = ratios.length;
      const bound = SHIFT_SWINGS * median(typical);
      let raw = median(ratios);
      // The pull: how the misses grow with the pull on the series; the
      // shift is then the typical series' miss at the typical pull.
      const fit = pullFit(ratios, pulled);
      if (fit) {
        pull = fit.pull;
        raw -= (pull - 1) * fit.at;
      }
      raw = (raw * n) / (n + HINDCAST_CASES);
      shift = Math.round(clamp(raw, -bound, bound) * 1e4) / 1e4;
    }
    // The swings: the band each window's replay with the shift and the
    // pull gives each figure, the errors and the counts pooled over the
    // windows.
    const measure = (scale) => {
      const errors = [];
      const parts = [];
      let tested = 0;
      let held = 0;
      list.forEach((w, i) => {
        const part = { tested: 0, held: 0 };
        parts.push(part);
        const plan =
          scale === 1 && shift === 0 && pull === 1
            ? bare[i]
            : planFor(w, shift, scale, pull);
        if (!plan.tables.length) return;
        const result = simulate(plan, {
          runs: HINDCAST_RUNS,
          years: HINDCAST_YEARS + 3,
          seed,
          crises: true,
          among: false,
        });
        for (const c of cases[i]) {
          const k = plan.byId.get(c.unitId);
          const row = forecastAt(result, k, c.horizon);
          if (!row) continue;
          const s = seriesOf(plan, c.unitId, id);
          if (s < 0) continue;
          part.tested += 1;
          // A share at its ceiling is held there (its band is a point, and
          // every figure within the ceiling's zone is one point in the
          // walking space): it holds when the later figure is still in it.
          if (plan.series.params[s].saturated) {
            const process = plan.series.process[s];
            if (c.actual >= SATURATED * process.cap) part.held += 1;
            continue;
          }
          const actual = placeAt(
            plan.tables[plan.series.table[s]],
            pointOf(plan, s, c),
          );
          if (actual >= row.p10 && actual <= row.p90) part.held += 1;
          const halfWidth = (row.p90 - row.p10) / (2 * BAND_SIGMAS);
          if (halfWidth > 0.25)
            errors.push(Math.abs(actual - row.p50) / halfWidth);
        }
        tested += part.tested;
        held += part.held;
      });
      return { tested, held, errors, parts };
    };
    const first = measure(1);
    if (first.tested < HINDCAST_CASES) continue;
    let scale = 1;
    if (first.errors.length >= HINDCAST_CASES) {
      const q = quantile(first.errors, 0.8);
      if (Number.isFinite(q) && q > 0) scale = clamp(q, 0.5, SCALE_MAX);
    }
    scale = Math.round(scale * 100) / 100;
    const second = scale === 1 ? first : measure(scale);
    out.indicators[id] = {
      tested: second.tested,
      held: Math.round((100 * second.held) / second.tested),
      scale,
      shift,
      pull,
    };
    out.tested += second.tested;
    out.held += second.held;
    second.parts.forEach((part, i) => {
      out.windows[i].tested += part.tested;
      out.windows[i].held += part.held;
    });
  }
  out.held = out.tested ? Math.round((100 * out.held) / out.tested) : 0;
  for (const w of out.windows)
    w.held = w.tested ? Math.round((100 * w.held) / w.tested) : 0;
  return out;
}

/** The swing scales a hindcast gives, per indicator, for buildPlan's `scales`. */
export function hindcastScales(report) {
  const out = {};
  for (const [id, entry] of Object.entries(report?.indicators || {}))
    if (Number.isFinite(entry?.scale) && entry.scale !== 1)
      out[id] = entry.scale;
  return out;
}

/** The trend shifts a hindcast gives, per indicator, for buildPlan's `shifts`. */
export function hindcastShifts(report) {
  const out = {};
  for (const [id, entry] of Object.entries(report?.indicators || {}))
    if (Number.isFinite(entry?.shift) && entry.shift !== 0)
      out[id] = entry.shift;
  return out;
}

/**
 * The pull's calibration from a hindcast's trend misses: do the places far
 * from the frontier catch up as fast as the pull assumes? The series are
 * split in two by the pull on them (beta × the gap, signed, in the walking
 * space a year); the slope of the misses over the pull between the two
 * halves' medians (the far half's typical miss less the near half's, over
 * the pulls' difference), shrunk as if HINDCAST_CASES more series had
 * missed nothing, gives the factor 1 + slope, kept within [PULL_MIN,
 * PULL_MAX] and to two decimals, and `at`, the typical pull, for the shift
 * to be read there. Null with fewer than 2 × HINDCAST_CASES series, with no
 * spread of pulls to speak of, or when the factor does not make the typical
 * absolute miss at least 2 % smaller than the shift alone would.
 * @param {number[]} ratios each series' miss per unit of trend a year
 * @param {number[]} pulls the pull on each, beta × (frontier − x0)
 * @returns {{pull: number, at: number}|null}
 */
export function pullFit(ratios, pulls) {
  const n = ratios?.length ?? 0;
  if (n < 2 * HINDCAST_CASES || pulls?.length !== n) return null;
  const order = ratios.map((_, k) => k).sort((a, b) => pulls[a] - pulls[b]);
  const half = Math.floor(n / 2);
  const low = order.slice(0, half);
  const high = order.slice(n - half);
  const pullLow = median(low.map((k) => pulls[k]));
  const pullHigh = median(high.map((k) => pulls[k]));
  if (!(Math.abs(pullHigh - pullLow) > 1e-6)) return null;
  const slope =
    ((median(high.map((k) => ratios[k])) - median(low.map((k) => ratios[k]))) /
      (pullHigh - pullLow)) *
    (n / (n + HINDCAST_CASES));
  const pull = Math.round(clamp(1 + slope, PULL_MIN, PULL_MAX) * 100) / 100;
  if (pull === 1) return null;
  const at = median(pulls);
  const center = median(ratios);
  const before = median(ratios.map((r) => Math.abs(r - center)));
  const after = median(
    ratios.map((r, k) => Math.abs(r - center - (pull - 1) * (pulls[k] - at))),
  );
  if (!(after < 0.98 * before)) return null;
  return { pull, at };
}

/** The pull factors a hindcast gives, per indicator, for buildPlan's `pulls`. */
export function hindcastPulls(report) {
  const out = {};
  for (const [id, entry] of Object.entries(report?.indicators || {}))
    if (Number.isFinite(entry?.pull) && entry.pull !== 1) out[id] = entry.pull;
  return out;
}

// --- the worker's protocol -------------------------------------------------------------------

/** The typed arrays of a result or a detail, for a transfer between threads. */
export function transferables(payload) {
  const buffers = [];
  const walk = (node) => {
    if (ArrayBuffer.isView(node)) buffers.push(node.buffer);
    else if (node && typeof node === 'object')
      for (const value of Object.values(node)) walk(value);
  };
  walk(payload);
  return [...new Set(buffers)];
}

/**
 * Answer a message as the worker does (src/abundanceForecast.worker.js),
 * and as the tab does inline where no worker runs: `run` builds the plan
 * from the units sent and simulates it, posting `progress` each year and
 * `done` with the result; `detail` answers for a unit of the last plan
 * (`stale` when the plan has moved on); `model` the level's typical lines.
 * `post(message, transfer)`.
 */
export function createForecastHandler() {
  let plan = null;
  let planId = null;
  let settings = null;
  let request = null;
  return (message, post) => {
    const { id, type } = message || {};
    if (type === 'run') {
      request = {
        units: message.units,
        indicators: message.indicators,
        weights: message.weights,
        options: {
          level: message.level,
          scales: message.scales,
          shifts: message.shifts,
          pulls: message.pulls,
        },
      };
      plan = buildPlan(request.units, request.indicators, request.weights, {
        ...request.options,
        scenario: message.scenario,
      });
      planId = message.planId ?? null;
      settings = {
        runs: message.runs,
        seed: message.seed,
        crises: message.crises,
      };
      const started = Date.now();
      const result = simulate(plan, {
        ...settings,
        among: message.among !== false,
        onProgress: (year, years) =>
          post({ type: 'progress', id, planId, year, years }),
      });
      result.ms = Date.now() - started;
      const done = { type: 'done', id, planId, result };
      post(done, transferables(result));
      return;
    }
    if (type === 'detail') {
      if (!plan || message.planId !== planId) {
        post({ type: 'detail', id, planId: message.planId, stale: true });
        return;
      }
      const detail = detailFor(plan, message.unitId, settings);
      const model = detail
        ? plan.indicatorIds
            .map((indicatorId) => seriesOf(plan, message.unitId, indicatorId))
            .filter((s) => s >= 0)
            .map((s) => seriesSummary(plan, s))
        : [];
      const answer = {
        type: 'detail',
        id,
        planId,
        unitId: message.unitId,
        detail,
        model,
      };
      post(answer, transferables(detail));
      return;
    }
    if (type === 'model') {
      if (!plan || message.planId !== planId) {
        post({ type: 'model', id, planId: message.planId, stale: true });
        return;
      }
      post({ type: 'model', id, planId, model: typicalModel(plan) });
      return;
    }
    // The world's line under another scenario, from the last run's units
    // and settings at the runs asked (never more than the run's), without
    // the ranks among the others: the line by scenario under the world's.
    if (type === 'compare') {
      if (!plan || message.planId !== planId) {
        post({ type: 'compare', id, planId: message.planId, stale: true });
        return;
      }
      const started = Date.now();
      const other = buildPlan(
        request.units,
        request.indicators,
        request.weights,
        { ...request.options, scenario: message.scenario },
      );
      const asked = Math.round(Number(message.runs));
      const runs = asked > 0 ? Math.min(settings.runs, asked) : settings.runs;
      const result = simulate(other, { ...settings, runs, among: false });
      const answer = {
        type: 'compare',
        id,
        planId,
        scenario: other.scenario,
        runs,
        world: result.world,
        weighted: result.weighted,
        ms: Date.now() - started,
      };
      post(answer, transferables(result.world));
    }
  };
}
