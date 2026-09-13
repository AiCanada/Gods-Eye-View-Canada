import test from 'node:test';
import assert from 'node:assert/strict';
import { headingFrom, listSitesToEntries } from '../../tools/camera-pack/ibi511-list.mjs';

test('only a bare direction label is a view bearing', () => {
  assert.equal(headingFrom('North'), 0);
  assert.equal(headingFrom('Looking West'), 270);
  assert.equal(headingFrom('Road W'), 270);
  assert.equal(headingFrom('Eastbound'), 90);
  assert.equal(headingFrom('SE'), 135);
  assert.equal(headingFrom('Toronto Bound'), null, 'a destination is not a compass point');
  assert.equal(headingFrom('Looking Down'), null);
  assert.equal(headingFrom('Looking West and North'), null);
  assert.equal(headingFrom('East side of HWY'), null, 'where the pole stands, not where it looks');
  assert.equal(headingFrom('Stoney Trail / Peigan Trail SE'), null, 'a quadrant inside a street name');
  assert.equal(headingFrom(null), null);
});

const OPTS = {
  host: '511on.ca', idPrefix: 'on511', cityId: 'on', provider: 'Ontario 511',
  operator: 'Ontario 511 — MTO', regionFallback: 'Ontario',
  bounds: { latMin: 41.5, latMax: 57, lonMin: -95.5, lonMax: -74 },
};

const site = (over) => ({
  id: 1, location: 'Hwy 401 at 4th Line', roadway: 'Highway 401', region: 'Eastern', direction: 'Unknown',
  latLng: { geography: { wellKnownText: 'POINT (-74.9 45.1)' } },
  images: [],
  ...over,
});

test('every view of a site becomes its own entry at the site point, switched-off views included', () => {
  const { entries, skipped } = listSitesToEntries([
    site({
      images: [
        { id: 481, sortOrder: 1, description: 'Looking East', imageUrl: '/map/Cctv/481' },
        { id: 482, sortOrder: 2, description: 'Looking Down', imageUrl: '/map/Cctv/482' },
        { id: 483, sortOrder: 3, description: 'N/A', imageUrl: '/map/Cctv/483', disabled: true },
      ],
    }),
  ], OPTS);
  assert.deepEqual(entries.map((e) => e.id), ['on511-481', 'on511-482', 'on511-483'], 'an offline camera usually returns, so it stays');
  assert.equal(entries[0].url, 'https://511on.ca/map/Cctv/481');
  assert.equal(entries[0].name, 'Hwy 401 at 4th Line (Looking East)');
  assert.equal(entries[0].headingDeg, 90);
  assert.equal(entries[1].headingDeg, null);
  assert.equal(entries[1].headingConfidence, 'unknown');
  assert.deepEqual([entries[0].lat, entries[0].lon], [45.1, -74.9]);
  assert.equal(entries[0].city, 'Eastern');
  assert.equal(entries[0].license, 'Ontario 511 — MTO: Highway 401');
  assert.equal(entries[2].name, 'Hwy 401 at 4th Line (view 3)');
  assert.deepEqual(skipped, {});
});

test('a lone view takes the site direction; placeholder labels get a view number', () => {
  const lone = listSitesToEntries([
    site({ direction: 'Northbound', images: [{ id: 7, description: 'C134', imageUrl: '/map/Cctv/7' }] }),
  ], OPTS).entries[0];
  assert.equal(lone.name, 'Hwy 401 at 4th Line');
  assert.equal(lone.headingDeg, 0);

  const pair = listSitesToEntries([
    site({ images: [{ id: 8, sortOrder: 1, description: 'N/A', imageUrl: '/map/Cctv/8' }, { id: 9, sortOrder: 2, imageUrl: '/map/Cctv/9' }] }),
  ], OPTS).entries;
  assert.deepEqual(pair.map((e) => e.name), ['Hwy 401 at 4th Line (view 1)', 'Hwy 401 at 4th Line (view 2)']);
});

test('sites with no point, outside the bounds, or a non-still image are skipped', () => {
  const { entries, skipped } = listSitesToEntries([
    site({ latLng: null, images: [{ id: 1, imageUrl: '/map/Cctv/1' }] }),
    site({ latLng: { geography: { wellKnownText: 'POINT (-66.06 45.27)' } }, images: [{ id: 2, imageUrl: '/map/Cctv/2' }] }),
    site({ images: [{ id: 3, imageUrl: 'https://elsewhere.example/x.jpg' }] }),
  ], OPTS);
  assert.equal(entries.length, 0);
  assert.deepEqual(skipped, { 'no coordinates': 1, 'outside the province': 1, 'no still': 1 });
});
