import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EPI_NUMBER_FIELDS,
  OUTBREAK_DEFAULT_PROFILE,
  PATHOGEN_PRESETS,
  epiParameters,
  presetValues,
} from './outbreakEpi.mjs';
import {
  TORNADO_FACTORS,
  TORNADO_KEYS,
  sensitivityTornado,
} from './outbreakEpiSensitivity.mjs';

const ROW_KEYS = [
  'key',
  'low',
  'high',
  'rLow',
  'rHigh',
  'doublingLow',
  'doublingHigh',
  'swing',
  'doublingSwing',
];

test('the tornado constants', () => {
  assert.deepEqual([...TORNADO_FACTORS], [2 / 3, 1.5]);
  assert.ok(Object.isFrozen(TORNADO_FACTORS));
  assert.deepEqual(
    [...TORNADO_KEYS],
    [
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
    ],
  );
});

test('the default profile: one row per key, the exact shape, sorted by swing', () => {
  const rows = sensitivityTornado(OUTBREAK_DEFAULT_PROFILE);
  assert.equal(rows.length, TORNADO_KEYS.length);
  assert.deepEqual(rows.map((r) => r.key).sort(), [...TORNADO_KEYS].sort());
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), ROW_KEYS);
    assert.ok(Number.isFinite(row.low) && Number.isFinite(row.high));
    assert.ok(row.low < row.high, row.key);
    assert.ok(Number.isFinite(row.rLow) && Number.isFinite(row.rHigh));
    assert.ok(row.doublingLow === null || Number.isFinite(row.doublingLow));
    assert.ok(row.doublingHigh === null || Number.isFinite(row.doublingHigh));
    assert.equal(row.swing, Math.round(row.swing * 100) / 100);
    assert.equal(row.doublingSwing, Math.round(row.doublingSwing * 100) / 100);
  }
  for (let i = 1; i < rows.length; i += 1)
    assert.ok(
      Math.abs(rows[i - 1].swing) >= Math.abs(rows[i].swing),
      `${rows[i - 1].key} before ${rows[i].key}`,
    );
  // JSON-safe for the server answer.
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows);
});

test('the r0 row: × 2/3 and × 1.5 give R high over R low of exactly 2.25', () => {
  const rows = sensitivityTornado(OUTBREAK_DEFAULT_PROFILE);
  const r0 = rows.find((r) => r.key === 'r0');
  const base = epiParameters(OUTBREAK_DEFAULT_PROFILE).r0;
  assert.ok(Math.abs(r0.low - base * (2 / 3)) < 1e-12);
  assert.ok(Math.abs(r0.high - base * 1.5) < 1e-12);
  // On the unrounded values, recomputed the way the module does.
  const low = epiParameters({ ...OUTBREAK_DEFAULT_PROFILE, r0: r0.low });
  const high = epiParameters({ ...OUTBREAK_DEFAULT_PROFILE, r0: r0.high });
  assert.ok(
    Math.abs(high.rEffectiveControlled / low.rEffectiveControlled - 2.25) <
      1e-9,
  );
  assert.equal(r0.rLow, Math.round(low.rEffectiveControlled * 100) / 100);
  assert.equal(r0.rHigh, Math.round(high.rEffectiveControlled * 100) / 100);
  assert.ok(r0.swing > 0);
  assert.ok(r0.doublingLow > r0.doublingHigh, 'a higher R0 doubles faster');
});

test('latent days move the doubling time, not R without isolation', () => {
  // The default profile isolates 10 % of the sick (healthcare medium), so a
  // longer latent stage shortens the symptomatic stage a little and R moves
  // slightly; the doubling time moves a lot more.
  const latent = sensitivityTornado(OUTBREAK_DEFAULT_PROFILE).find(
    (r) => r.key === 'latentDays',
  );
  assert.ok(latent.doublingHigh > latent.doublingLow);
  assert.ok(Math.abs(latent.swing) < 0.1);
  // With nobody isolated R is independent of the latent stage exactly.
  const { healthcare: _, ...noCare } = OUTBREAK_DEFAULT_PROFILE;
  const pure = sensitivityTornado(noCare).find((r) => r.key === 'latentDays');
  assert.equal(pure.swing, 0);
  assert.equal(pure.rLow, pure.rHigh);
  assert.ok(pure.doublingHigh > pure.doublingLow);
  assert.ok(pure.doublingSwing > 0);
});

test('the interventions: off and full, and the travel ban sorts last', () => {
  const rows = sensitivityTornado(OUTBREAK_DEFAULT_PROFILE);
  const lockdown = rows.find((r) => r.key === 'lockdownPct');
  assert.deepEqual([lockdown.low, lockdown.high], [0, 90]);
  assert.ok(lockdown.swing < 0, 'lockdown lowers R with interventions');
  assert.ok(lockdown.rHigh < lockdown.rLow);
  const vaccinated = rows.find((r) => r.key === 'vaccinatedPct');
  assert.deepEqual([vaccinated.low, vaccinated.high], [0, 100]);
  const ban = rows.find((r) => r.key === 'travelBanPct');
  assert.deepEqual([ban.low, ban.high], [0, 100]);
  assert.equal(ban.swing, 0);
  assert.equal(ban.doublingSwing, 0);
  assert.equal(rows.at(-1).key, 'travelBanPct');
  // Lockdown moves R with interventions more than any pathogen value does
  // on the default profile.
  assert.equal(rows[0].key, 'lockdownPct');
});

test('multiplicative rows stay inside the numeric field ranges', () => {
  const hot = sensitivityTornado({ ...OUTBREAK_DEFAULT_PROFILE, r0: 15 });
  const r0 = hot.find((r) => r.key === 'r0');
  assert.equal(r0.high, 20);
  assert.ok(Math.abs(r0.low - 10) < 1e-12);
  const rows = sensitivityTornado({
    ...OUTBREAK_DEFAULT_PROFILE,
    infectiousDays: 50,
    asymptomaticPct: 90,
    asymRelative: 1.4,
    hospitalPct: 90,
    fatalityPct: 90,
  });
  for (const row of rows) {
    const range = EPI_NUMBER_FIELDS[row.key];
    if (!range) continue;
    assert.ok(row.low >= range[0] && row.high <= range[1], row.key);
  }
  // A tiny R0 is held above the model's floor.
  const cold = sensitivityTornado({ ...OUTBREAK_DEFAULT_PROFILE, r0: 0.1 });
  assert.equal(cold.find((r) => r.key === 'r0').low, 0.1);
});

test('every preset and an empty profile give rows; it is fast', () => {
  for (const preset of PATHOGEN_PRESETS) {
    const rows = sensitivityTornado({
      ...OUTBREAK_DEFAULT_PROFILE,
      ...presetValues(preset.id),
    });
    assert.equal(rows.length, TORNADO_KEYS.length, preset.id);
    assert.ok(
      rows.every((r) => r.low < r.high),
      preset.id,
    );
  }
  const bare = sensitivityTornado({});
  assert.equal(bare.length, TORNADO_KEYS.length);
  assert.equal(bare.find((r) => r.key === 'hospitalPct').high, 4.5);
  assert.equal(bare.find((r) => r.key === 'fatalityPct').high, 0.75);
  assert.equal(sensitivityTornado(undefined).length, TORNADO_KEYS.length);
  // Warm, then time the best of five calls (one scheduler hiccup must not
  // fail it): each is about twenty epiParameters evaluations.
  sensitivityTornado(OUTBREAK_DEFAULT_PROFILE);
  let took = Infinity;
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    sensitivityTornado(OUTBREAK_DEFAULT_PROFILE);
    took = Math.min(took, performance.now() - started);
  }
  assert.ok(took < 20, `best of 5 took ${took.toFixed(1)} ms`);
});

test('the input profile is not changed', () => {
  const profile = { ...OUTBREAK_DEFAULT_PROFILE, lockdownPct: 30 };
  const before = JSON.stringify(profile);
  sensitivityTornado(profile);
  assert.equal(JSON.stringify(profile), before);
});
