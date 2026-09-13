import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CITY_MATCH_MAX_KM_OUTSIDE,
  cityIdByName,
  kmOutsideViewBounds,
} from './cctvCityMatch.js';
import { CITY_POIS } from '../locations.js';

test('a same-named place far away is not the preset city', () => {
  assert.equal(cityIdByName('Hwy 1 Austin', 49.95, -98.93), null, 'Austin, Manitoba is not Austin, Texas');
  assert.equal(cityIdByName('Austin', 30.2672, -97.7431), 'austin');
  assert.equal(cityIdByName('Vancouver Island', 48.4284, -123.3656), null, 'Victoria is on Vancouver Island, not in Vancouver');
  assert.equal(cityIdByName('Vancouver Island', 49.1659, -123.9401), null, 'Nanaimo is not Vancouver either');
  assert.equal(cityIdByName('Vancouver', 49.2827, -123.1207), 'vancouver');
});

test('highway cameras filed under Fort McMurray only group there when they are near it', () => {
  assert.equal(cityIdByName('Ft McMurray / N Central', 56.7292, -111.3885), 'fortmcmurray');
  assert.equal(cityIdByName('Ft McMurray / N Central', 57.6, -111.6), null, 'Hwy 63 far north of town');
});

test('suburban cameras and partial names near the city still group', () => {
  assert.equal(cityIdByName('Halifax', 44.80, -63.65), 'halifax', 'Bedford, just outside the bounds');
  assert.equal(cityIdByName('Gatineau side', 45.47, -75.70), 'ottawa');
  assert.equal(cityIdByName('Montréal side', 45.51, -73.55), 'montreal');
  assert.equal(cityIdByName('Hwy 1, west of Winnipeg', 49.88, -97.40), 'winnipeg');
});

test('without coordinates the name alone decides, as before', () => {
  assert.equal(cityIdByName('Montréal side'), 'montreal');
  assert.equal(cityIdByName('Tokyo'), 'tokyo');
  assert.equal(cityIdByName(''), null);
  assert.equal(cityIdByName('Nowhere Junction', 45, -66), null);
});

test('distance to view bounds is zero inside and grows outside', () => {
  assert.equal(kmOutsideViewBounds(CITY_POIS.toronto, 43.65, -79.38), 0);
  const km = kmOutsideViewBounds(CITY_POIS.toronto, 43.86 + 0.1, -79.38);
  assert.ok(km > 11 && km < 12, `0.1° north of the bounds is about 11 km (${km.toFixed(1)})`);
});

test('in the real Canadian camera catalogue no camera groups under a city it is far from', () => {
  const cameras = JSON.parse(
    fs.readFileSync(new URL('../../config/cctv_sources.canada.json', import.meta.url), 'utf8'),
  );
  const counts = {};
  for (const camera of cameras) {
    const id = cityIdByName(camera.city, Number(camera.lat), Number(camera.lon));
    if (!id) continue;
    counts[id] = (counts[id] || 0) + 1;
    const km = kmOutsideViewBounds(CITY_POIS[id], Number(camera.lat), Number(camera.lon));
    assert.ok(km <= CITY_MATCH_MAX_KM_OUTSIDE, `${camera.id} (${camera.city}) is ${km.toFixed(0)} km from ${id}`);
  }
  assert.equal(counts.austin, undefined, 'no Canadian camera groups under Austin, Texas');
  assert.ok(!cameras.some((camera) => camera.city === 'Vancouver Island'
    && cityIdByName(camera.city, Number(camera.lat), Number(camera.lon)) === 'vancouver'));
  // The pack grows between rebuilds, so check that real city cameras still
  // group rather than pinning exact counts.
  assert.ok(counts.calgary >= 69, `Calgary keeps its cameras (${counts.calgary})`);
  assert.ok(counts.halifax >= 15, `Halifax keeps its cameras (${counts.halifax})`);
});
