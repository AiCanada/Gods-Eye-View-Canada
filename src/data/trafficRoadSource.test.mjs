// src/data/trafficRoadSource.test.mjs
// Where Street Traffic gets its roads (fork plan Step 0, 2026-09-14), ported
// onto upstream's split layer. Austin showed zero dots because every Overpass
// mirror refused or timed out while TomTom flow loaded fine. Roads come from
// OpenFreeMap road tiles; the fork's Overpass fallback is asked only when a
// whole tile pass fails, and only through the operator's OVERPASS_UPSTREAMS
// (the proxy answers 503 when none are configured, and the fallback then
// stays off). A total failure is reported through getStats(), and a failing
// view backs off instead of retrying on every camera nudge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUSTIN,
  TORONTO,
  createTrafficHarness,
} from './trafficTestHarness.mjs';
import { OVERPASS_ROAD_SOURCE } from '../layers/traffic/source.js';

const near = (a, b) =>
  Math.abs(a.lat - b.lat) < 0.05 && Math.abs(a.lon - b.lon) < 0.05;
const boxCenter = (box) => ({
  lat: (box.south + box.north) / 2,
  lon: (box.west + box.east) / 2,
});

test('road tiles come first, and Overpass is asked only when a whole tile pass fails', async (t) => {
  const h = createTrafficHarness(t);
  h.layer.enable(h.viewer);
  await h.load();
  let stats = h.layer.getStats();
  assert.ok(h.calls.tiles.length > 0, 'the tiles were asked');
  assert.equal(h.calls.overpass.length, 0, 'healthy tiles never touch Overpass');
  assert.equal(stats.roadSource, 'OpenStreetMap');
  assert.equal(stats.roadFallback, null);
  assert.equal(stats.roadsError, null);
  assert.ok(stats.count > 0);

  h.failing.tiles = true;
  h.park(TORONTO);
  h.camera.changed.raiseEvent();
  await h.load();
  stats = h.layer.getStats();
  assert.ok(h.calls.overpass.length >= 1, 'then Overpass');
  assert.ok(
    h.calls.overpass.every(({ box }) => near(boxCenter(box), TORONTO)),
    'for the new view only',
  );
  assert.equal(h.calls.overpass[0].url, '/api/overpass');
  assert.equal(stats.roadSource, OVERPASS_ROAD_SOURCE);
  assert.equal(stats.roadFallback, 'overpass');
  assert.equal(stats.roadsError, null);
  assert.ok(stats.count > 0, 'the fallback still draws traffic');
});

test('with the tiles and Overpass both down, getStats reports roadsError and nothing is loading', async (t) => {
  const h = createTrafficHarness(t);
  h.failing.tiles = true;
  h.failing.overpass = true;
  h.layer.enable(h.viewer);
  await h.load();
  const stats = h.layer.getStats();
  assert.ok(h.calls.overpass.length >= 1, 'the fallback was tried');
  assert.equal(stats.roadsError, 'unavailable');
  assert.equal(stats.count, 0);
  assert.match(stats.error, /^OpenFreeMap tiles unavailable/);
  assert.equal(stats.loading, false, 'a failed load does not read as still loading');
});

test('the fallback honours OVERPASS_UPSTREAMS: an unconfigured proxy (503) is asked once, then left alone', async (t) => {
  const h = createTrafficHarness(t);
  h.options.overpassConfigured = false;
  h.failing.tiles = true;
  h.layer.enable(h.viewer);
  await h.load();
  assert.equal(h.calls.overpass.length, 1);
  assert.equal(h.layer.getStats().roadsError, 'unavailable');
  assert.match(h.layer.getStats().error, /^OpenFreeMap tiles unavailable/);
  h.park(TORONTO);
  h.camera.changed.raiseEvent();
  await h.load();
  assert.equal(h.calls.overpass.length, 1, 'no further Overpass requests');
});

test('a view whose roads failed is retried with backoff while parked, never in a storm, and recovers', async (t) => {
  const h = createTrafficHarness(t);
  h.failing.tiles = true;
  h.failing.overpass = true;
  h.layer.enable(h.viewer);
  await h.load();
  const firstPass = h.calls.overpass.length;
  assert.ok(firstPass >= 1);

  // Eight camera nudges on the failed view over 3.2 s: only the retries that
  // fall due in that window (1.5 s, then 3 s later) may reach the sources.
  let before = h.calls.overpass.length;
  for (let i = 0; i < 8; i++) {
    h.camera.changed.raiseEvent();
    await h.tick(400);
  }
  assert.ok(
    h.calls.overpass.length - before <= 2,
    `no retry storm while both sources are down (${h.calls.overpass.length - before} loads)`,
  );
  before = h.calls.overpass.length;

  // Upstream's quick retries, then the fork's parked-view retry carries on
  // past the third attempt instead of giving up.
  for (let i = 0; i < 16; i++) await h.tick(30_000);
  assert.ok(
    h.calls.overpass.length >= before + 4,
    `the parked view was asked again more than three times (${h.calls.overpass.length - before})`,
  );

  h.failing.tiles = false;
  h.failing.overpass = false;
  await h.tick(60_000);
  await h.load();
  const stats = h.layer.getStats();
  assert.equal(stats.roadsError, null, 'a render clears the failure');
  assert.equal(stats.roadSource, 'OpenStreetMap');
  assert.ok(stats.count > 0);
});

test('a real move or a location switch is never held back by an old view’s backoff', async (t) => {
  const h = createTrafficHarness(t);
  h.failing.tiles = true;
  h.failing.overpass = true;
  h.layer.enable(h.viewer);
  await h.load();
  assert.equal(h.layer.getStats().roadsError, 'unavailable');

  const before = h.calls.overpass.length;
  h.park(TORONTO);
  h.camera.changed.raiseEvent();
  await h.load();
  assert.ok(h.calls.overpass.length > before, 'another place loads at once');

  h.layer.onLocationLeave({ from: TORONTO, to: AUSTIN, enabled: true });
  assert.equal(h.layer.getStats().roadsError, null, 'a switch starts clean');
  h.failing.tiles = false;
  h.park(AUSTIN);
  h.layer.onLocationArrive({
    from: TORONTO,
    to: AUSTIN,
    signal: new AbortController().signal,
  });
  await h.load();
  assert.ok(h.layer.getStats().count > 0, 'arrival loads without waiting out the old backoff');
});

test('a partial tile answer renders, reads degraded, is not a fallback, and the parked view asks again', async (t) => {
  const h = createTrafficHarness(t);
  let broken = null;
  h.failing.tile = ({ x, y }) => {
    broken ??= `${x}/${y}`;
    return `${x}/${y}` === broken;
  };
  h.layer.enable(h.viewer);
  await h.load();
  let stats = h.layer.getStats();
  assert.ok(new Set(h.calls.tiles.map(({ x, y }) => `${x}/${y}`)).size >= 2);
  assert.ok(stats.count > 0);
  assert.equal(h.calls.overpass.length, 0, 'a partial answer is not a fallback');
  assert.equal(stats.roadsError, 'partial');

  h.failing.tile = () => false;
  const before = h.calls.tiles.length;
  for (let i = 0; i < 4; i++) await h.tick(30_000);
  await h.load();
  assert.ok(
    h.calls.tiles
      .slice(before)
      .some(({ x, y }) => `${x}/${y}` === broken),
    'the tile that failed is requested again',
  );
  stats = h.layer.getStats();
  assert.equal(stats.roadsError, null, 'a complete load clears the degraded state');
  assert.ok(stats.count > 0);
});
