import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areaOverlapsBox,
  buildCctvGrid,
  clampCctvAreaRadiusKm,
  parseCctvAreaPoint,
  queryCctvArea,
} from '../../server/providers/cctv/area.js';
import { CCTV_LOAD_CAP_HARD_LIMIT } from '../../server/providers/cctv/constants.js';
import { haversineKm } from '../../server/providers/common/geo.js';

const snapshotOf = (sources) => ({ sources, grid: buildCctvGrid(sources) });

/** `count` cameras spread on rings around a centre, out to `maxKm`. */
function ring(prefix, center, count, maxKm) {
  return Array.from({ length: count }, (_, i) => {
    const km = ((i + 1) / count) * maxKm;
    const bearing = (i * 137.5 * Math.PI) / 180;
    const dLat = (km * Math.cos(bearing)) / 111.195;
    const dLon = (km * Math.sin(bearing)) / (111.195 * Math.cos((center.lat * Math.PI) / 180));
    return { id: `${prefix}-${String(i).padStart(5, '0')}`, lat: center.lat + dLat, lon: center.lon + dLon };
  });
}

const ATLANTA = { lat: 33.749, lon: -84.388 };
const SAVANNAH = { lat: 32.0809, lon: -81.0912 };
const TORONTO = { lat: 43.6532, lon: -79.3832 };

test('a point needs both real coordinates; blank is not zero', () => {
  assert.deepEqual(parseCctvAreaPoint('30.2672', '-97.7431'), { lat: 30.2672, lon: -97.7431 });
  assert.equal(parseCctvAreaPoint(null, null), null);
  assert.equal(parseCctvAreaPoint('', '-97'), null);
  assert.equal(parseCctvAreaPoint('91', '0'), null);
  assert.equal(parseCctvAreaPoint('abc', '1'), null);
  assert.deepEqual(parseCctvAreaPoint('0', '0'), { lat: 0, lon: 0 }, 'an explicit 0,0 is a point');
});

test('the radius defaults to 50 km and stays between 0.5 and 50', () => {
  assert.equal(clampCctvAreaRadiusKm(null), 50);
  assert.equal(clampCctvAreaRadiusKm(''), 50);
  assert.equal(clampCctvAreaRadiusKm('500'), 50);
  assert.equal(clampCctvAreaRadiusKm('0.1'), 0.5);
  assert.equal(clampCctvAreaRadiusKm('12'), 12);
});

test('cameras come back nearest first, ties by id, with distances', () => {
  const sources = [
    { id: 'b', lat: 33.76, lon: -84.388 },
    { id: 'a', lat: 33.76, lon: -84.388 },
    { id: 'near', lat: 33.7495, lon: -84.388 },
    { id: 'far', lat: 34.1, lon: -84.388 },
    { id: 'outside', lat: 35.5, lon: -84.388 },
    { id: 'nowhere', lat: NaN, lon: NaN },
  ];
  const { matches, area } = queryCctvArea(snapshotOf(sources), { ...ATLANTA });
  assert.deepEqual(matches.map((m) => m.source.id), ['near', 'a', 'b', 'far']);
  assert.ok(matches.every((m, i) => i === 0 || m.distKm >= matches[i - 1].distKm));
  assert.equal(area.inArea, 4);
  assert.equal(area.loaded, 4);
  assert.equal(area.dropped, 0);
  assert.equal(area.capped, false);
  assert.equal(area.reachKm, 50, 'an uncapped area reaches its whole radius');
  assert.equal(area.total, 6, 'total counts the whole catalogue');
});

test('a 3,000-camera Atlanta area loads the nearest 1,000 and drops 2,000', () => {
  const sources = ring('atl', ATLANTA, 3000, 49);
  const { matches, area } = queryCctvArea(snapshotOf(sources), { ...ATLANTA, radiusKm: 50 });
  assert.equal(matches.length, 1000);
  assert.equal(area.loaded, 1000);
  assert.equal(area.dropped, 2000);
  assert.equal(area.capped, true);
  const farthestLoaded = matches[matches.length - 1].distKm;
  assert.equal(area.reachKm, Math.round(farthestLoaded * 1000) / 1000);
  const loaded = new Set(matches.map((m) => m.source.id));
  for (const source of sources) {
    if (loaded.has(source.id)) continue;
    assert.ok(haversineKm(ATLANTA.lat, ATLANTA.lon, source.lat, source.lon) >= farthestLoaded, 'every dropped camera is farther than every loaded one');
  }
});

test('the 1,000 cap can be lowered but never raised', () => {
  const sources = ring('atl', ATLANTA, 2600, 40);
  const snapshot = snapshotOf(sources);
  assert.equal(CCTV_LOAD_CAP_HARD_LIMIT, 1000);
  assert.equal(queryCctvArea(snapshot, { ...ATLANTA, limit: 999999 }).matches.length, 1000);
  assert.equal(queryCctvArea(snapshot, { ...ATLANTA, limit: '1001' }).area.limit, 1000);
  assert.equal(queryCctvArea(snapshot, { ...ATLANTA, limit: 10 }).matches.length, 10);
  assert.equal(queryCctvArea(snapshot, { ...ATLANTA, limit: -5 }).area.limit, 1000);
});

test('Savannah and Toronto get their own cameras, not Atlanta\'s', () => {
  const sources = [
    ...ring('atl', ATLANTA, 300, 45),
    ...ring('sav', SAVANNAH, 40, 30),
    ...ring('tor', TORONTO, 80, 48),
  ];
  const snapshot = snapshotOf(sources);
  const ids = (center) => queryCctvArea(snapshot, center).matches.map((m) => m.source.id.slice(0, 3));
  assert.deepEqual([...new Set(ids(SAVANNAH))], ['sav']);
  assert.equal(ids(SAVANNAH).length, 40);
  assert.deepEqual([...new Set(ids(TORONTO))], ['tor']);
  assert.equal(ids(TORONTO).length, 80);
});

test('an area across the antimeridian finds cameras on both sides', () => {
  const sources = [
    { id: 'east', lat: -17.8, lon: 179.9 },
    { id: 'west', lat: -17.8, lon: -179.9 },
    { id: 'away', lat: -17.8, lon: 178 },
  ];
  const { matches } = queryCctvArea(snapshotOf(sources), { lat: -17.8, lon: 180, radiusKm: 30 });
  assert.deepEqual(matches.map((m) => m.source.id).sort(), ['east', 'west']);
});

test('cameras just past a grid edge are still found', () => {
  // 0.5° cells: a camera at 34.0001 sits in the next cell up from a point at 33.99.
  const sources = [{ id: 'edge', lat: 34.0001, lon: -84.5001 }, { id: 'cell', lat: 33.99, lon: -84.49 }];
  const { matches } = queryCctvArea(snapshotOf(sources), { lat: 33.99, lon: -84.49, radiusKm: 2 });
  assert.deepEqual(matches.map((m) => m.source.id), ['cell', 'edge']);
});

test('area overlap with a coverage box', () => {
  const austinBox = { south: 29.9, north: 30.75, west: -98.15, east: -97.35 };
  assert.equal(areaOverlapsBox({ lat: 30.2672, lon: -97.7431, radiusKm: 50 }, austinBox), true);
  assert.equal(areaOverlapsBox({ lat: 29.76, lon: -95.37, radiusKm: 50 }, austinBox), false, 'Houston');
  assert.equal(areaOverlapsBox({ lat: 29.6, lon: -97.9, radiusKm: 50 }, austinBox), true, 'within 50 km of the box edge');
  assert.equal(areaOverlapsBox({ lat: 29.6, lon: -97.9, radiusKm: 5 }, austinBox), false);
});
