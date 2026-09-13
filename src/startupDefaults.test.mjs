import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STARTUP_LOCATION_ID,
  applyStartupLayerDefaults,
} from './startupDefaults.js';
import { CITY_POIS } from './locations.js';
import {
  createDefaultLayerState,
  normalizeLayerState,
} from './data/layerState.js';

test('launch lands on the Saint John Danger Zone preset', () => {
  assert.equal(CITY_POIS[STARTUP_LOCATION_ID].name, 'Saint John Danger Zone');
});

test('a fresh launch turns CCTV and traffic on', () => {
  const state = normalizeLayerState(applyStartupLayerDefaults(createDefaultLayerState()));
  assert.deepEqual(state.enabledLayerIds, ['cctv', 'traffic']);
});

test('a saved Space Missions layer is switched off at launch, other saved layers stay', () => {
  const saved = { ...createDefaultLayerState(), enabledLayerIds: ['rocket-launches', 'cctv'] };
  const state = normalizeLayerState(applyStartupLayerDefaults(saved));
  assert.equal(state.enabledLayerIds.includes('rocket-launches'), false);
  assert.ok(state.enabledLayerIds.includes('cctv'));
  assert.ok(state.enabledLayerIds.includes('traffic'));
  assert.deepEqual(saved.enabledLayerIds, ['rocket-launches', 'cctv'], 'input is not mutated');
});
