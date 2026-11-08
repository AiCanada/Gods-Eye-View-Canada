/**
 * God's Eye View Canada: the GLOBAL ABUNDANCE MAP box's state in a share
 * link (owner request 2026-11-07): the level, whether it colours the map,
 * the years ahead, what the map shows for a future year, the scale and the
 * scenario. Two spellings of one state: the long link's `ab` parameter
 * (`ab=c.1.25.m.t.b`: level, SHOW ON MAP, years ahead, view, scale,
 * scenario, dotted) and three bytes in the short code's
 * FORK_ABUNDANCE_FIELD (src/share/viewCodec.js). Pure; the vocabularies
 * are spelled here so the share codec never loads the forecast module, and
 * a test holds them to the forecast's own lists.
 */

export const ABUNDANCE_SHARE_PARAM = 'ab';
/** One letter each, the letter the long form writes. */
export const ABUNDANCE_SHARE_LEVELS = Object.freeze({
  c: 'country',
  r: 'region',
  y: 'city',
});
export const ABUNDANCE_SHARE_VIEWS = Object.freeze({
  m: 'p50',
  b: 'p10',
  w: 'p90',
  u: 'up',
  d: 'down',
  c: 'change',
});
export const ABUNDANCE_SHARE_SCALES = Object.freeze({
  t: 'today',
  o: 'others',
});
export const ABUNDANCE_SHARE_SCENARIOS = Object.freeze({
  b: 'baseline',
  o: 'optimistic',
  p: 'pessimistic',
  v: 'volatile',
});
export const ABUNDANCE_SHARE_MAX_YEAR = 100;

const letterOf = (table, value) =>
  Object.keys(table).find((letter) => table[letter] === value) ?? null;
const indexOf = (table, value) => Object.values(table).indexOf(value);

/**
 * A box state from anything: null unless it names a known level; the rest
 * defaults (SHOW ON MAP on, today, the typical outcome, against today, the
 * baseline) where it is missing or unknown.
 * @returns {{level: string, show: boolean, year: number, view: string, scale: string, scenario: string}|null}
 */
export function normalizeAbundanceShare(input) {
  if (!input || typeof input !== 'object') return null;
  const levels = Object.values(ABUNDANCE_SHARE_LEVELS);
  if (!levels.includes(input.level)) return null;
  const pick = (table, value, fallback) =>
    Object.values(table).includes(value) ? value : fallback;
  const year = Number(input.year);
  return {
    level: input.level,
    show: input.show !== false,
    year:
      Number.isInteger(year) && year >= 0 && year <= ABUNDANCE_SHARE_MAX_YEAR
        ? year
        : 0,
    view: pick(ABUNDANCE_SHARE_VIEWS, input.view, 'p50'),
    scale: pick(ABUNDANCE_SHARE_SCALES, input.scale, 'today'),
    scenario: pick(ABUNDANCE_SHARE_SCENARIOS, input.scenario, 'baseline'),
  };
}

/** The long form's `ab` value for a state (`c.1.25.m.t.b`), or null for none. */
export function encodeAbundanceShareParam(input) {
  const state = normalizeAbundanceShare(input);
  if (!state) return null;
  return [
    letterOf(ABUNDANCE_SHARE_LEVELS, state.level),
    state.show ? '1' : '0',
    String(state.year),
    letterOf(ABUNDANCE_SHARE_VIEWS, state.view),
    letterOf(ABUNDANCE_SHARE_SCALES, state.scale),
    letterOf(ABUNDANCE_SHARE_SCENARIOS, state.scenario),
  ].join('.');
}

/** The state an `ab` value spells; null for anything but six valid dotted parts. */
export function decodeAbundanceShareParam(text) {
  if (typeof text !== 'string') return null;
  const parts = text.split('.');
  if (parts.length !== 6) return null;
  const [level, show, year, view, scale, scenario] = parts;
  if (!(show === '0' || show === '1')) return null;
  if (
    !/^(0|[1-9]\d{0,2})$/.test(year) ||
    Number(year) > ABUNDANCE_SHARE_MAX_YEAR
  )
    return null;
  if (
    !(level in ABUNDANCE_SHARE_LEVELS) ||
    !(view in ABUNDANCE_SHARE_VIEWS) ||
    !(scale in ABUNDANCE_SHARE_SCALES) ||
    !(scenario in ABUNDANCE_SHARE_SCENARIOS)
  )
    return null;
  return {
    level: ABUNDANCE_SHARE_LEVELS[level],
    show: show === '1',
    year: Number(year),
    view: ABUNDANCE_SHARE_VIEWS[view],
    scale: ABUNDANCE_SHARE_SCALES[scale],
    scenario: ABUNDANCE_SHARE_SCENARIOS[scenario],
  };
}

/**
 * The short form's three bytes for a state: the level (2 bits), SHOW ON MAP
 * (1), the scale (1) and the scenario (2) in the first, the view in the
 * second, the years ahead in the third. Null for none.
 */
export function encodeAbundanceShareBytes(input) {
  const state = normalizeAbundanceShare(input);
  if (!state) return null;
  const first =
    indexOf(ABUNDANCE_SHARE_LEVELS, state.level) +
    (state.show ? 4 : 0) +
    indexOf(ABUNDANCE_SHARE_SCALES, state.scale) * 8 +
    indexOf(ABUNDANCE_SHARE_SCENARIOS, state.scenario) * 16;
  return [first, indexOf(ABUNDANCE_SHARE_VIEWS, state.view), state.year];
}

/** The state three bytes spell; null for any other length or an unknown value. */
export function decodeAbundanceShareBytes(bytes) {
  const list = bytes ? Array.from(bytes) : [];
  if (list.length !== 3 || !list.every((b) => Number.isInteger(b) && b >= 0))
    return null;
  const [first, viewIndex, year] = list;
  const level = Object.values(ABUNDANCE_SHARE_LEVELS)[first % 4];
  const scale = Object.values(ABUNDANCE_SHARE_SCALES)[
    Math.floor(first / 8) % 2
  ];
  const scenario = Object.values(ABUNDANCE_SHARE_SCENARIOS)[
    Math.floor(first / 16) % 4
  ];
  const view = Object.values(ABUNDANCE_SHARE_VIEWS)[viewIndex];
  if (!level || !view || first > 63 || year > ABUNDANCE_SHARE_MAX_YEAR)
    return null;
  return {
    level,
    show: Math.floor(first / 4) % 2 === 1,
    year,
    view,
    scale,
    scenario,
  };
}
