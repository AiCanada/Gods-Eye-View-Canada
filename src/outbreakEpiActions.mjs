/**
 * Policies for the world-model tape (owner request 2026-10-13): who decides
 * the interventions in a recorded run. The model's own triggers decide when
 * no policy is given ('rules'); 'random' explores — the window on and off in
 * runs of days, places switched on and off, countries flagged, and how hard:
 * the lockdown level, the ban share, the tests a day and the campaign's
 * doses a day, each held for runs of days — so a world model sees
 * interventions that its cases did not cause (without it, every lockdown
 * follows a rise in cases and the two cannot be told apart).
 * 'none' keeps every intervention off. A replay policy lives with the tape
 * (replayPolicy in outbreakEpiTape.mjs).
 *
 * Each policy draws from its own generator, seeded per run, never from the
 * run's stream. Pure: no DOM, no Node.
 */
import { streamWords, xoshiro128ss } from './outbreakEpi.mjs';

const ALL_HOURS = 0xffffff;

/**
 * The exploring policy.
 *
 * @param {object} options
 * @param {number} options.seed The policy's seed (the scenario's).
 * @param {number[]} options.candidates Node indices it may switch (the
 *   tracked places; reached places are added as the run goes).
 * @param {string[]} [options.countries] ISO codes it may flag.
 * @param {number} [options.windowFlip] Daily chance the window flips.
 * @param {number} [options.switchRate] Daily chance a candidate flips.
 * @param {number} [options.maxSwitches] Most switch changes a day.
 * @param {number} [options.flagRate] Daily chance a country is flagged.
 * @param {boolean} [options.magnitudes] Explore the magnitudes too (from
 *   their own generator, so the window, switches and flags are the same
 *   either way).
 * @param {number} [options.magnitudeFlip] Daily chance each magnitude is
 *   drawn again.
 */
export function randomPolicy({
  seed,
  candidates = [],
  countries = [],
  windowFlip = 0.15,
  switchRate = 0.02,
  maxSwitches = 64,
  flagRate = 0.05,
  magnitudes = true,
  magnitudeFlip = 0.1,
}) {
  let rng = xoshiro128ss(...streamWords([seed >>> 0, 0x5eed], 0));
  let mrng = rng;
  let open = false;
  let on = new Set();
  let flagged = new Set();
  // The scenario's own settings (from the tape's begin), which the tests and
  // the campaign are scaled from.
  let base = { tests: 0, vaccine: 0 };
  let level = {};
  const draw = {
    lockdown: () => mrng() * 0.9,
    travelBan: () => mrng(),
    // A quarter to twice the scenario's capacity; none to set without one.
    testsPer1000Day: () =>
      base.tests > 0 ? base.tests * 2 ** (mrng() * 3 - 2) : undefined,
    // None to twice the campaign's rate; none to set without a campaign.
    vaccinePer1000Day: () =>
      base.vaccine > 0 ? base.vaccine * 2 * mrng() : undefined,
  };
  return {
    begin(info) {
      base = {
        tests: info?.params?.testsPer1000Day || 0,
        vaccine: info?.vaccine?.perDay || 0,
      };
    },
    control(run, day, view) {
      if (day === 0) {
        rng = xoshiro128ss(...streamWords([seed >>> 0, 0x5eed], run));
        open = rng() < 0.5;
        on = new Set();
        flagged = new Set();
        if (magnitudes) {
          mrng = xoshiro128ss(...streamWords([seed >>> 0, 0x6d61], run));
          level = {};
          for (const name of Object.keys(draw)) level[name] = draw[name]();
        }
      } else if (magnitudes)
        for (const name of Object.keys(draw))
          if (mrng() < magnitudeFlip) level[name] = draw[name]();
      if (day > 0 && rng() < windowFlip) open = !open;
      const switches = new Map();
      const pool = [...candidates];
      if (view?.reachedList) for (const i of view.reachedList) pool.push(i);
      let changes = 0;
      for (const i of pool) {
        if (changes >= maxSwitches) break;
        if (rng() >= switchRate) continue;
        const next = on.has(i) ? 0 : 1;
        if (next) on.add(i);
        else on.delete(i);
        switches.set(i, next);
        changes += 1;
      }
      const flags = [];
      if (countries.length && rng() < flagRate) {
        const code = countries[Math.floor(rng() * countries.length)];
        if (code && !flagged.has(code)) {
          flagged.add(code);
          flags.push(code);
        }
      }
      const out = { window: open ? ALL_HOURS : 0, switches, flags };
      if (magnitudes)
        for (const [name, value] of Object.entries(level))
          if (Number.isFinite(value)) out[name] = value;
      return out;
    },
  };
}

/** The policy that keeps every intervention off: the window never opens. */
export function nonePolicy() {
  return {
    begin() {},
    control() {
      return { window: 0, switches: new Map(), flags: [] };
    },
  };
}

/**
 * The policy a scenario names, or null for the model's own rules.
 *
 * @param {string} name 'rules' | 'random' | 'none'
 */
export function policyFor(name, options) {
  if (name === 'random') return randomPolicy(options);
  if (name === 'none') return nonePolicy();
  return null;
}
