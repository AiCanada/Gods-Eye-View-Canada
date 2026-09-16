import test from 'node:test';
import assert from 'node:assert/strict';
import { cctvRegionKey } from '../../server/providers/cctv/catalog.js';

// The region cap is gone: the catalogue keeps every camera and each selected
// area loads at most 1,000 (see cctvArea.test.mjs and cctvLoadCap.test.mjs).
// cctvRegionKey still classifies every camera for the /sources `region` field.

test('Canadian cameras belong to their province or territory', () => {
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'on' }), 'CA-ON');
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'bc' }), 'CA-BC');
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'yt' }), 'CA-YT');
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'saint-john' }), 'CA-NB', 'a city inside a province');
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'pei' }), 'CA-PE');
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'pe' }), 'CA-PE');
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'mystery' }), 'CA', 'an unknown province falls back to the country');
});

test('US cameras belong to their state', () => {
  assert.equal(cctvRegionKey({ country: 'US', cityId: 'austin' }), 'US-TX');
  assert.equal(cctvRegionKey({ country: 'US', cityId: 'ca-d4' }), 'US-CA', 'Caltrans districts are Californian');
  assert.equal(cctvRegionKey({ country: 'US', cityId: 'ny' }), 'US-NY');
  assert.equal(cctvRegionKey({ country: 'US', region: 'wa', cityId: 'seattle' }), 'US-WA', 'a declared region wins');
  assert.equal(cctvRegionKey({ country: 'US', region: 'US-OR' }), 'US-OR');
});

test('every other country is one region; no country is its own group', () => {
  assert.equal(cctvRegionKey({ country: 'GB', cityId: 'london' }), 'GB');
  assert.equal(cctvRegionKey({ country: 'PM', cityId: 'pm' }), 'PM');
  assert.equal(cctvRegionKey({ country: 'FR', region: 'ON' }), 'FR', 'a region code means nothing outside Canada and the US');
  assert.equal(cctvRegionKey({}), '');
});

test('spelled-out provinces, states and country names find their region', () => {
  assert.equal(cctvRegionKey({ country: 'CA', region: 'Ontario' }), 'CA-ON');
  assert.equal(cctvRegionKey({ country: 'Canada', region: 'Québec' }), 'CA-QC');
  assert.equal(cctvRegionKey({ country: 'CAN', cityId: 'british-columbia' }), 'CA-BC');
  assert.equal(cctvRegionKey({ country: 'USA', region: 'Texas' }), 'US-TX');
  assert.equal(cctvRegionKey({ country: 'united states', region: 'New York' }), 'US-NY');
  assert.equal(cctvRegionKey({ country: 'US', region: 'Washington DC' }), 'US-DC');
  assert.equal(cctvRegionKey({ country: 'UK', cityId: 'london' }), 'GB');
  assert.equal(cctvRegionKey({ country: 'Deutschland' }), '', 'a country that is not a code cannot be placed');
});

test('US territories, DC and other spellings resolve the same, however a camera is labelled', () => {
  assert.equal(cctvRegionKey({ country: 'PR' }), 'PR');
  assert.equal(cctvRegionKey({ country: 'USA', region: 'Puerto Rico' }), 'PR');
  assert.equal(cctvRegionKey({ country: 'US', region: 'US-PR' }), 'PR');
  assert.equal(cctvRegionKey({ country: 'US', region: 'GU' }), 'GU');
  assert.equal(cctvRegionKey({ country: 'US', cityId: 'washington' }), 'US-DC', 'Washington the city is DC');
  assert.equal(cctvRegionKey({ country: 'US', region: 'Washington, D.C.' }), 'US-DC');
  assert.equal(cctvRegionKey({ country: 'US', region: 'Washington' }), 'US-WA', 'the state name is the state');
  assert.equal(cctvRegionKey({ country: 'CA', region: 'P.E.I.' }), 'CA-PE');
  assert.equal(cctvRegionKey({ country: 'CA', region: 'Colombie-Britannique' }), 'CA-BC');
});

test('a region key is stable when fed back in', () => {
  for (const source of [
    { country: 'US', region: 'Texas' },
    { country: 'US', region: 'US-PR' },
    { country: 'CA', cityId: 'mystery' },
    { country: 'GB' },
    {},
  ]) {
    const key = cctvRegionKey(source);
    assert.equal(cctvRegionKey({ ...source, region: key }), key, JSON.stringify(source));
  }
});
