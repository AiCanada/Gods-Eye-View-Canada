/**
 * Recorded conditions as drivers of the epidemic model (owner request
 * 2026-10-13: the sim and the live data together). From the world tape's
 * daily bins on the tracked places:
 *  - season: the absolute humidity a place had, as a transmission factor
 *    (Shaman & Kohn 2009, PNAS 106:3243; Shaman et al. 2010, PLoS Biol
 *    8:e1000316: R0(t) = exp(a·q(t) + log(R0max − R0min)) + R0min, a = −180),
 *    taken relative to its value at a reference humidity, so 1 is the
 *    model's own season and a dry day spreads more;
 *  - travel: the departures recorded at a place against its own typical
 *    day (aircraft for air, rail vehicles for rail), so a quiet airport flies
 *    fewer people;
 *  - commute: the transit vehicles in service at a place against its own
 *    typical day, scaling its residents' commuting (a strike or a holiday
 *    keeps people at home).
 * Days or places with nothing recorded keep the model's own value. Places
 * that are not tracked take the nearest tracked place's. Pure.
 */
import { BIN_GROUPS, placeIndex } from './worldTapeBin.mjs';

export const HUMIDITY_A = -180; // per kg/kg (Shaman et al. 2010)
export const R0_MAX = 2.2;
export const R0_MIN = 1.3;
export const Q_REFERENCE = 0.008; // kg/kg: a temperate spring day
const SEASON_RANGE = [0.5, 1.6];
const TRAVEL_RANGE = [0, 3];

/** R0 at specific humidity q (kg/kg), Shaman et al. 2010. */
export function humidityR0(q) {
  return Math.exp(HUMIDITY_A * q + Math.log(R0_MAX - R0_MIN)) + R0_MIN;
}

const clamp = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));
const mean = (xs) => {
  const finite = xs.filter(Number.isFinite);
  return finite.length
    ? finite.reduce((s, x) => s + x, 0) / finite.length
    : NaN;
};
const median = (xs) => {
  const finite = xs
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  return finite.length ? finite[Math.floor(finite.length / 2)] : NaN;
};

/**
 * What the drivers read of one day of bins, per tracked place: mean
 * humidity, aircraft departures, rail vehicles and transit vehicles (NaN
 * where nothing was recorded). Small enough to keep for every recorded day.
 * @param {Record<string, {data: Float32Array}>} bins One day's bins.
 * @param {number} K The tracked places.
 * @returns {{q: Float64Array, air: Float64Array, rail: Float64Array, transit: Float64Array}}
 */
export function daySummary(bins, K) {
  const W = BIN_GROUPS.weather;
  const M = BIN_GROUPS.mobility;
  const R = BIN_GROUPS.trains;
  const out = {
    q: new Float64Array(K).fill(NaN),
    air: new Float64Array(K).fill(NaN),
    rail: new Float64Array(K).fill(NaN),
    transit: new Float64Array(K).fill(NaN),
  };
  for (let k = 0; k < K; k += 1) {
    const hourly = (group, names, c) => {
      const data = bins[group]?.data;
      if (!data) return [];
      return Array.from(
        { length: 24 },
        (_, h) => data[(h * K + k) * names.length + c],
      );
    };
    out.q[k] = mean(hourly('weather', W, W.indexOf('humidity')));
    const departures = hourly('mobility', M, M.indexOf('aircraftDepartures'));
    out.air[k] = departures.some(Number.isFinite)
      ? departures.filter(Number.isFinite).reduce((s, x) => s + x, 0)
      : NaN;
    out.rail[k] = mean(hourly('trains', R, R.indexOf('railVehicles')));
    out.transit[k] = mean(hourly('mobility', M, M.indexOf('transitVehicles')));
  }
  return out;
}

/**
 * Drivers for one scenario from its days' summaries (daySummary).
 *
 * @param {object} input
 * @param {object[]} input.nodes The world's nodes.
 * @param {Int32Array|number[]} input.tracked Tracked node indices (the bins' places).
 * @param {Array<ReturnType<typeof daySummary>|null>} input.summaries One per
 *   day of the scenario (0 = its first day), null where nothing was binned.
 */
export function driversFromSummaries({ nodes, tracked, summaries }) {
  const K = tracked.length;
  const days = summaries.length;
  const places = Array.from(tracked, (i) => nodes[i]);
  const index = placeIndex(places);
  const at = new Int32Array(nodes.length).fill(-1);
  tracked.forEach((i, k) => {
    at[i] = k;
  });
  const nearest = (i) => {
    if (at[i] >= 0) return at[i];
    const k = index.nearest(nodes[i], 300);
    at[i] = k >= 0 ? k : -2;
    return k;
  };
  const series = (key) =>
    summaries.map((day) => day?.[key] || new Float64Array(K).fill(NaN));
  const q = series('q');
  const air = series('air');
  const rail = series('rail');
  const transit = series('transit');
  const typical = (rows) =>
    Float64Array.from({ length: K }, (_, k) => median(rows.map((r) => r[k])));
  const airTypical = typical(air);
  const railTypical = typical(rail);
  const transitTypical = typical(transit);
  const reference = humidityR0(Q_REFERENCE);
  return {
    season(i, d, formula) {
      const k = nearest(i);
      const value = k >= 0 && d < days ? q[d][k] : NaN;
      if (!Number.isFinite(value)) return formula;
      return clamp(humidityR0(value) / reference, SEASON_RANGE);
    },
    travel(i, d, mode) {
      const k = nearest(i);
      if (k < 0 || d >= days) return 1;
      const today = mode === 'rail' ? rail[d][k] : air[d][k];
      const usual = mode === 'rail' ? railTypical[k] : airTypical[k];
      if (!Number.isFinite(today) || !(usual > 0)) return 1;
      return clamp(today / usual, TRAVEL_RANGE);
    },
    commute(i, d) {
      const k = nearest(i);
      if (k < 0 || d >= days) return 1;
      const today = transit[d][k];
      if (!Number.isFinite(today) || !(transitTypical[k] > 0)) return 1;
      return clamp(today / transitTypical[k], TRAVEL_RANGE);
    },
  };
}

/**
 * Drivers for one scenario, straight from its days' bins.
 *
 * @param {object} input
 * @param {object[]} input.nodes The world's nodes.
 * @param {Int32Array|number[]} input.tracked Tracked node indices (the bins' places).
 * @param {(dayIndex: number) => Record<string, {data: Float32Array}>|null} input.binsFor
 *   The bins of day `dayIndex` of the scenario (0 = its first day), or null.
 * @param {number} input.days The scenario's days.
 */
export function driversFromBins({ nodes, tracked, binsFor, days }) {
  const K = tracked.length;
  const summaries = Array.from({ length: days }, (_, d) => {
    const bins = binsFor(d);
    return bins ? daySummary(bins, K) : null;
  });
  return driversFromSummaries({ nodes, tracked, summaries });
}
