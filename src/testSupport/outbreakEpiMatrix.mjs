// The scenario matrix behind the epidemic model's golden master
// (outbreakEpiGolden.test.mjs) and the world-model tape tests: small seeded
// runs that between them reach every mechanism of the model.
import { createHash } from 'node:crypto';
import {
  epiParameters,
  presetValues,
  simulateEpidemic,
} from '../outbreakEpi.mjs';

export const START = Date.UTC(2026, 0, 10);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function airport(id, lat, lon, population, country = '', extra = {}) {
  return {
    id,
    code: id,
    name: id,
    lat,
    lon,
    population,
    kind: 'airport',
    country,
    ...extra,
  };
}

function city(id, lat, lon, population, country = '') {
  return { id, name: id, lat, lon, population, kind: 'city', country };
}

function daily(from, to, tod, lengthHours, passengers = 500, extra = {}) {
  return {
    from,
    to,
    timeOfDayMs: tod * HOUR,
    lengthMs: lengthHours * HOUR,
    passengers,
    ...extra,
  };
}

/** Patient zero's hub flies to a busy and a quiet airport (dated flights). */
function world(days = 6) {
  const nodes = [
    airport('A', 30, 100, 2_000_000),
    airport('B', 35, 110, 3_000_000),
    airport('C', 20, 80, 1_000_000),
  ];
  const flights = [];
  for (let d = 0; d < days; d += 1)
    for (let k = 0; k < 6; k += 1) {
      const departMs = START + d * DAY + k * 4 * HOUR;
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
  return { nodes, origins: [0], flights, links: nodes.map(() => []) };
}

/** Russia (the origin and a domestic airport) and Nigeria, flown daily. */
function borders() {
  const nodes = [
    airport('A', 55, 37, 1_000_000, 'RU'),
    airport('B', 60, 30, 1_000_000, 'RU'),
    airport('C', 6, 3, 1_000_000, 'NG'),
  ];
  return {
    nodes,
    origins: [0],
    routes: [daily(0, 1, 6, 2), daily(0, 2, 6, 2)],
    links: nodes.map(() => []),
  };
}

const covid = (extra = {}) =>
  epiParameters({ ...presetValues('covid2020'), ...extra });

/**
 * The matrix. Each entry is the full simulateEpidemic input bar the clock:
 * every run uses `now: () => 0` and no budget, so nothing depends on speed.
 */
export const SCENARIOS = {
  'world-default': () => ({
    ...world(),
    params: covid({ initialCases: 300 }),
    untilMs: START + 6 * DAY,
    runs: 20,
    seed: 99,
  }),
  'world-ban': () => ({
    ...world(),
    params: covid({ initialCases: 300, travelBanPct: 95, interventionHour: 0 }),
    untilMs: START + 6 * DAY,
    runs: 20,
    seed: 99,
  }),
  'one-place-long': () => ({
    nodes: [city('X', 0, 0, 200_000)],
    origins: [0],
    links: [[]],
    params: epiParameters({
      r0: 2,
      incubationDays: 3,
      latentDays: 3,
      infectiousDays: 5,
      asymptomaticPct: 0,
      initialCases: 200,
    }),
    untilMs: START + 60 * DAY,
    runs: 5,
    seed: 3,
  }),
  'borders-origin': () => ({
    ...borders(),
    params: covid({
      initialCases: 2000,
      travelBanPct: 100,
      interventionHour: 0,
      borderPolicy: 'origin',
    }),
    untilMs: START + 12 * DAY,
    runs: 10,
    seed: 18,
  }),
  'borders-reported': () => ({
    ...borders(),
    params: covid({
      initialCases: 2000,
      travelBanPct: 100,
      interventionHour: 0,
      borderPolicy: 'reported',
      borderTrigger: 1,
    }),
    untilMs: START + 12 * DAY,
    runs: 10,
    seed: 18,
  }),
  'borders-all': () => ({
    ...borders(),
    params: covid({
      initialCases: 2000,
      travelBanPct: 80,
      interventionHour: 0,
      borderPolicy: 'all',
      exitScreening: 'on',
      entryScreening: 'on',
      importDetection: 'medium',
      quarantineDays: 7,
    }),
    untilMs: START + 12 * DAY,
    runs: 10,
    seed: 18,
  }),
  'per-place-reported': () => ({
    ...borders(),
    params: covid({
      initialCases: 2000,
      triggerMode: 'reported',
      triggerPer100k: 20,
      lockdownPct: 60,
      minLockDays: 7,
      fatigueHalfDays: 30,
      interventionDays: 15,
    }),
    untilMs: START + 20 * DAY,
    runs: 10,
    seed: 7,
  }),
  'per-place-hospital': () => ({
    ...borders(),
    params: covid({
      initialCases: 5000,
      triggerMode: 'hospital',
      triggerBedShare: 50,
      lockdownPct: 70,
      lockdownScope: 'community',
    }),
    untilMs: START + 20 * DAY,
    runs: 10,
    seed: 8,
  }),
  'window-hour-37': () => ({
    ...world(),
    params: covid({
      initialCases: 300,
      lockdownPct: 50,
      interventionHour: 37,
      interventionDays: 3,
      tracing: 'medium',
    }),
    untilMs: START + 6 * DAY,
    runs: 10,
    seed: 37,
  }),
  'two-strain': () => ({
    ...world(),
    params: covid({
      initialCases: 300,
      variants: 'two-strain',
      strain2Day: 2,
      strain2Cases: 50,
      strain2Pct: 150,
      crossImmunityPct: 40,
    }),
    untilMs: START + 6 * DAY,
    runs: 10,
    seed: 5,
  }),
  compare: () => ({
    ...borders(),
    params: covid({
      initialCases: 2000,
      travelBanPct: 60,
      lockdownPct: 50,
      interventionHour: 24,
      compare: 'all',
    }),
    untilMs: START + 12 * DAY,
    runs: 12,
    seed: 11,
  }),
  'legacy-no-hospital': () => ({
    ...world(),
    params: epiParameters({
      r0: 2.5,
      incubationDays: 5,
      initialCases: 200,
      fatalityPct: 1,
    }),
    untilMs: START + 6 * DAY,
    runs: 10,
    seed: 12,
  }),
  'waning-campaign': () => ({
    // Protection arrives VACCINE_PROTECT_DAYS after the dose, so 30 days.
    ...world(30),
    params: covid({
      initialCases: 300,
      waningDays: 10,
      vaccineStartDay: 0,
      vaccinePer1000Day: 30,
      vaccineEfficacyPct: 80,
      vaccinePriority: 'origin-first',
    }),
    untilMs: START + 30 * DAY,
    runs: 6,
    seed: 13,
  }),
  'testing-awareness': () => ({
    ...borders(),
    params: covid({
      initialCases: 3000,
      testsPer1000Day: 0.05,
      response: 'moderate',
      responseSignal: 'both',
      responseReach: 'mixed',
      fatigueDays: 30,
    }),
    untilMs: START + 12 * DAY,
    runs: 10,
    seed: 14,
  }),
  'deadline-cut': () => {
    let clock = 0;
    return {
      nodes: [city('X', 0, 0, 100_000)],
      origins: [0],
      links: [[]],
      params: epiParameters({ r0: 2 }),
      untilMs: START + 10 * DAY,
      runs: 3,
      now: () => (clock += 1),
      deadlineMs: 21,
    };
  },
  transfers: () => {
    const nodes = [
      airport('A', 10, 10, 1_000_000, 'RU'),
      airport('H', 20, 20, 1, 'RU', { size: 'L' }),
      airport('B', 30, 30, 1_000_000, 'RU'),
    ];
    return {
      nodes,
      origins: [0],
      links: nodes.map(() => []),
      routes: [daily(0, 1, 6, 2), daily(1, 2, 12, 3)],
      params: {
        ...covid({ initialCases: 100000, transfers: 'some' }),
        transferShare: 1,
      },
      untilMs: START + 6 * DAY,
      runs: 10,
      seed: 20,
    };
  },
  'daytime-mixing': () => ({
    // Three towns 30 km apart: commuting links are worked out from them.
    nodes: [
      city('P', 50, 10, 400_000, 'DE'),
      city('Q', 50.27, 10, 250_000, 'DE'),
      city('R', 50, 10.42, 150_000, 'DE'),
    ],
    origins: [0],
    params: covid({
      initialCases: 500,
      mixing: 'daytime',
      commuteDaySplit: 0.8,
    }),
    untilMs: START + 10 * DAY,
    runs: 10,
    seed: 15,
  }),
  'rail-long': () => {
    const nodes = [
      airport('A', 10, 10, 1_000_000, 'RU'),
      airport('B', 11, 11, 1_000_000, 'RU'),
    ];
    return {
      nodes,
      origins: [0],
      links: nodes.map(() => []),
      routes: [daily(0, 1, 7, 3, 2000, { mode: 'rail', km: 180 })],
      params: covid({ initialCases: 100000 }),
      untilMs: START + 6 * DAY,
      runs: 10,
      seed: 31,
    };
  },
  // A half-hour train: lands in the hour it boards.
  'rail-short': () => {
    const nodes = [
      airport('A', 10, 10, 1_000_000, 'RU'),
      airport('B', 10.2, 10.2, 1_000_000, 'RU'),
    ];
    return {
      nodes,
      origins: [0],
      links: nodes.map(() => []),
      routes: [daily(0, 1, 7, 0.5, 2000, { mode: 'rail', km: 30 })],
      params: covid({ initialCases: 100000 }),
      untilMs: START + 6 * DAY,
      runs: 10,
      seed: 32,
    };
  },
  // A 1.5 h flight with the window starting 50 minutes past the hour.
  'offhour-air': () => {
    const nodes = [
      airport('A', 10, 10, 1_000_000, 'RU'),
      airport('B', 15, 15, 1_000_000, 'RU'),
    ];
    return {
      nodes,
      origins: [0],
      links: nodes.map(() => []),
      routes: [daily(0, 1, 6, 1.5, 2000)],
      params: covid({ initialCases: 100000 }),
      startMs: START + 50 * 60_000,
      untilMs: START + 50 * 60_000 + 6 * DAY,
      runs: 10,
      seed: 33,
    };
  },
};

/** JSON with every object's keys sorted, so only values count. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function runScenario(name, extra = {}) {
  const input = SCENARIOS[name]();
  return simulateEpidemic({
    startMs: START,
    budgetMs: Infinity,
    now: () => 0,
    ...input,
    ...extra,
  });
}

export function hashOf(result) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(result)))
    .digest('hex');
}
