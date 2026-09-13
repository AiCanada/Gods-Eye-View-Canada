import test from 'node:test';
import assert from 'node:assert/strict';
import { capSourcesPerCountry } from '../../server/providers/cctv/catalog.js';

const cams = (country, count, prefix = country) =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, country }));

test('the camera cap applies per country, keeping catalogue order', () => {
  const sources = [...cams('CA', 5), ...cams('US', 3), ...cams('CA', 2, 'CA-late'), ...cams('', 4, 'none')];
  const { kept, dropped } = capSourcesPerCountry(sources, 4);
  assert.deepEqual(kept.filter((s) => s.country === 'CA').map((s) => s.id), ['CA-0', 'CA-1', 'CA-2', 'CA-3']);
  assert.equal(kept.filter((s) => s.country === 'US').length, 3, 'a smaller country is untouched');
  assert.equal(kept.filter((s) => s.country === '').length, 4, 'unclassified cameras form their own group');
  assert.equal(dropped.get('CA'), 3);
  assert.equal(dropped.has('US'), false);
});

test('a catalogue under the cap is returned whole', () => {
  const sources = cams('CA', 10);
  const { kept, dropped } = capSourcesPerCountry(sources, 3000);
  assert.equal(kept.length, 10);
  assert.equal(dropped.size, 0);
});
