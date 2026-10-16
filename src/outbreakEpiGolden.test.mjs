// Golden master for the epidemic model: the full result of a fixed matrix of
// seeded scenarios, hashed. Any change to what the model computes changes a
// hash, so a refactor that must leave the model alone (the world-model taps,
// owner request 2026-10-13) is checked against these.
//
// The hashes hold for one V8 build: Math.exp, log and ** may differ between
// engines, so on another V8 the comparison is skipped (the relative tests in
// outbreakEpi.test.mjs run everywhere). To re-pin after an intended change:
//   GEV_WRITE_OUTBREAK_GOLDEN=1 node --test src/outbreakEpiGolden.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  SCENARIOS,
  hashOf,
  runScenario,
} from './testSupport/outbreakEpiMatrix.mjs';

const GOLDEN = new URL('./testSupport/outbreakEpiGolden.json', import.meta.url);

if (process.env.GEV_WRITE_OUTBREAK_GOLDEN === '1') {
  test('golden master: write the hashes', () => {
    const hashes = {};
    for (const name of Object.keys(SCENARIOS))
      hashes[name] = hashOf(runScenario(name));
    writeFileSync(
      GOLDEN,
      `${JSON.stringify(
        { node: process.version, v8: process.versions.v8, hashes },
        null,
        2,
      )}\n`,
    );
  });
} else {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const sameEngine = golden.v8 === process.versions.v8;
  test('golden master: every scenario of the matrix is pinned', () => {
    assert.deepEqual(
      Object.keys(golden.hashes).sort(),
      Object.keys(SCENARIOS).sort(),
    );
  });
  for (const name of Object.keys(SCENARIOS))
    test(
      `golden master: ${name}`,
      {
        skip: sameEngine
          ? false
          : `hashes pinned on V8 ${golden.v8}, this is ${process.versions.v8}`,
      },
      () => {
        assert.equal(hashOf(runScenario(name)), golden.hashes[name]);
      },
    );
}
