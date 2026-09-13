import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capSourcesPerRegion,
  cctvRegionCapSettings,
  cctvRegionKey,
  regionCapRequested,
} from '../../server/providers/cctv/catalog.js';

test('Canadian cameras count against their province or territory', () => {
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'on' }), 'CA-ON');
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'bc' }), 'CA-BC');
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'yt' }), 'CA-YT');
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'saint-john' }), 'CA-NB', 'a city inside a province');
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'pei' }), 'CA-PE');
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'pe' }), 'CA-PE');
  assert.equal(cctvRegionKey({ country: 'CA', cityId: 'mystery' }), 'CA', 'unknown province counts against the country');
});

test('US cameras count against their state', () => {
  assert.equal(cctvRegionKey({ country: 'US', cityId: 'austin' }), 'US-TX');
  assert.equal(cctvRegionKey({ country: 'US', cityId: 'ca-d4' }), 'US-CA', 'Caltrans districts are Californian');
  assert.equal(cctvRegionKey({ country: 'US', cityId: 'ny' }), 'US-NY');
  assert.equal(cctvRegionKey({ country: 'US', region: 'wa', cityId: 'seattle' }), 'US-WA', 'a declared region wins');
  assert.equal(cctvRegionKey({ country: 'US', region: 'US-OR' }), 'US-OR');
});

test('every other country counts as one region; no country is its own group', () => {
  assert.equal(cctvRegionKey({ country: 'GB', cityId: 'london' }), 'GB');
  assert.equal(cctvRegionKey({ country: 'PM', cityId: 'pm' }), 'PM');
  assert.equal(cctvRegionKey({ country: 'FR', region: 'ON' }), 'FR', 'a region code means nothing outside Canada and the US');
  assert.equal(cctvRegionKey({}), '');
});

test('the cap applies per region in catalogue order, leaving smaller regions alone', () => {
  const cams = (country, cityId, count) =>
    Array.from({ length: count }, (_, i) => ({ id: `${country}-${cityId}-${i}`, country, cityId }));
  const sources = [
    ...cams('CA', 'on', 4), ...cams('CA', 'bc', 2), ...cams('US', 'austin', 3), ...cams('US', 'ca-d7', 1),
    ...cams('GB', 'london', 5), ...cams('CA', 'on', 1),
  ];
  const { kept, dropped } = capSourcesPerRegion(sources, 3);
  assert.deepEqual(kept.filter((s) => s.cityId === 'on').map((s) => s.id), ['CA-on-0', 'CA-on-1', 'CA-on-2']);
  assert.equal(kept.filter((s) => s.cityId === 'bc').length, 2);
  assert.equal(kept.filter((s) => s.country === 'US').length, 4, 'Texas and California are capped separately');
  assert.equal(kept.filter((s) => s.country === 'GB').length, 3);
  assert.deepEqual(Object.fromEntries(dropped), { 'CA-ON': 2, GB: 2 });
});

test('region-cap settings and the viewer toggle', () => {
  assert.deepEqual(cctvRegionCapSettings({}), { limit: 2500, enabledByDefault: true });
  assert.deepEqual(cctvRegionCapSettings({ CCTV_REGION_CAP: '1200', CCTV_REGION_CAP_DEFAULT: 'off' }), { limit: 1200, enabledByDefault: false });
  assert.equal(cctvRegionCapSettings({ CCTV_REGION_CAP: '999999' }).limit, 5000, 'never above the per-country ceiling');
  assert.equal(cctvRegionCapSettings({ CCTV_REGION_CAP: 'lots' }).limit, 2500);
  assert.equal(regionCapRequested('0', true), false);
  assert.equal(regionCapRequested('off', true), false);
  assert.equal(regionCapRequested('1', false), true);
  assert.equal(regionCapRequested(null, true), true, 'no choice uses the default');
  assert.equal(regionCapRequested('maybe', false), false);
});
