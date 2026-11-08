// God's Eye View Canada: the GLOBAL ABUNDANCE MAP box's state in a share
// link (src/share/abundanceShare.js): the long form's `ab` and the short
// form's three bytes, strict on the way in, every state round-tripping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABUNDANCE_SHARE_LEVELS,
  ABUNDANCE_SHARE_SCALES,
  ABUNDANCE_SHARE_SCENARIOS,
  ABUNDANCE_SHARE_VIEWS,
  decodeAbundanceShareBytes,
  decodeAbundanceShareParam,
  encodeAbundanceShareBytes,
  encodeAbundanceShareParam,
  normalizeAbundanceShare,
} from './abundanceShare.js';
import { ABUNDANCE_LEVELS } from '../abundanceCore.mjs';
import {
  FORECAST_SCALES,
  FORECAST_SCENARIOS,
  FORECAST_VIEWS,
} from '../abundanceForecast.mjs';

const DEFAULTS = {
  level: 'country',
  show: true,
  year: 0,
  view: 'p50',
  scale: 'today',
  scenario: 'baseline',
};

test('the share vocabularies are the box’s own lists, in their order', () => {
  assert.deepEqual(Object.values(ABUNDANCE_SHARE_LEVELS), [...ABUNDANCE_LEVELS]);
  assert.deepEqual(Object.values(ABUNDANCE_SHARE_VIEWS), [...FORECAST_VIEWS]);
  assert.deepEqual(Object.values(ABUNDANCE_SHARE_SCALES), [...FORECAST_SCALES]);
  assert.deepEqual(Object.values(ABUNDANCE_SHARE_SCENARIOS), [
    ...FORECAST_SCENARIOS,
  ]);
});

test('a state normalizes to a known level or nothing, the rest defaulting', () => {
  assert.deepEqual(normalizeAbundanceShare({ level: 'region' }), {
    ...DEFAULTS,
    level: 'region',
  });
  const full = {
    level: 'city',
    show: false,
    year: 25,
    view: 'up',
    scale: 'others',
    scenario: 'volatile',
  };
  assert.deepEqual(normalizeAbundanceShare(full), full);
  assert.deepEqual(
    normalizeAbundanceShare({
      level: 'country',
      show: 'yes',
      year: 101,
      view: 'x',
      scale: 'y',
      scenario: 'z',
    }),
    DEFAULTS,
  );
  assert.deepEqual(normalizeAbundanceShare({ level: 'country', year: 3.5 }), DEFAULTS);
  assert.equal(normalizeAbundanceShare({ level: 'planet' }), null);
  assert.equal(normalizeAbundanceShare({}), null);
  assert.equal(normalizeAbundanceShare(null), null);
  assert.equal(normalizeAbundanceShare('country'), null);
});

test('the long form: six dotted parts, strict on the way in', () => {
  const state = {
    level: 'city',
    show: false,
    year: 25,
    view: 'up',
    scale: 'others',
    scenario: 'volatile',
  };
  assert.equal(encodeAbundanceShareParam(state), 'y.0.25.u.o.v');
  assert.deepEqual(decodeAbundanceShareParam('y.0.25.u.o.v'), state);
  assert.equal(encodeAbundanceShareParam({ level: 'country' }), 'c.1.0.m.t.b');
  assert.equal(encodeAbundanceShareParam(null), null);
  assert.equal(encodeAbundanceShareParam({ level: 'moon' }), null);
  for (const bad of [
    '',
    'c.1.0.m.t',
    'c.1.0.m.t.b.x',
    'q.1.0.m.t.b',
    'c.2.0.m.t.b',
    'c.1.101.m.t.b',
    'c.1.-1.m.t.b',
    'c.1.01.m.t.b',
    'c.1.1.5.m.t.b',
    'c.1.0.z.t.b',
    'c.1.0.m.x.b',
    'c.1.0.m.t.q',
    42,
    null,
  ])
    assert.equal(decodeAbundanceShareParam(bad), null, String(bad));
});

test('the short form: three bytes, and every state round-trips both ways', () => {
  assert.deepEqual(encodeAbundanceShareBytes({ level: 'country' }), [4, 0, 0]);
  assert.deepEqual(
    encodeAbundanceShareBytes({
      level: 'city',
      show: false,
      year: 100,
      view: 'change',
      scale: 'others',
      scenario: 'volatile',
    }),
    [2 + 8 + 48, 5, 100],
  );
  for (const level of ABUNDANCE_LEVELS)
    for (const show of [true, false])
      for (const view of FORECAST_VIEWS)
        for (const scale of FORECAST_SCALES)
          for (const scenario of FORECAST_SCENARIOS)
            for (const year of [0, 1, 37, 100]) {
              const state = { level, show, year, view, scale, scenario };
              assert.deepEqual(
                decodeAbundanceShareBytes(encodeAbundanceShareBytes(state)),
                state,
              );
              assert.deepEqual(
                decodeAbundanceShareParam(encodeAbundanceShareParam(state)),
                state,
              );
            }
  assert.deepEqual(
    decodeAbundanceShareBytes(Uint8Array.from([4, 0, 0])),
    DEFAULTS,
  );
  for (const bad of [
    [],
    [4, 0],
    [4, 0, 0, 0],
    [3, 0, 0],
    [64, 0, 0],
    [4, 6, 0],
    [4, 0, 101],
    [-1, 0, 0],
    [4.5, 0, 0],
    null,
  ])
    assert.equal(decodeAbundanceShareBytes(bad), null, JSON.stringify(bad));
  assert.equal(encodeAbundanceShareBytes(null), null);
});
