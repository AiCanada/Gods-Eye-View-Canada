// src/data/trafficRoadSource.test.mjs
// Where Street Traffic gets its roads (plan Step 0, 2026-09-14). Austin showed
// zero dots because every Overpass mirror refused (406) or timed out, while
// TomTom flow loaded fine. Roads now come from OpenFreeMap road tiles through
// the local proxy; Overpass is asked only when those tiles fail, a total
// failure is reported through getStats(), and a failing view backs off
// instead of retrying every load-kick tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import trafficLayer from './traffic.js';
import { layerFeedState } from './manager.js';
import {
  AUSTIN,
  DEBOUNCE_MS,
  TORONTO,
  loadCurrentView,
  settle,
  withTraffic,
} from './trafficTestHarness.mjs';

/** Move the parked camera somewhere and let the debounced load run. */
async function moveTo(h, cam, place) {
  cam.park(place);
  cam.changed.raise();
  await loadCurrentView(h);
}

test('road tiles come first, and Overpass is asked only when every tile fails', async () => {
  await withTraffic(async (h, cam) => {
    await loadCurrentView(h);
    let stats = trafficLayer.getStats();
    assert.equal(h.roadPasses(), 1);
    assert.equal(h.calls.overpass.length, 0, 'healthy tiles never touch Overpass');
    assert.equal(stats.roadSource, 'tiles');
    assert.equal(stats.roadsError, null);
    assert.ok(stats.roadTilesFetched > 0);
    assert.ok(stats.count > 0);
    assert.match(trafficLayer.source, /^OpenFreeMap © OpenMapTiles Data from OpenStreetMap$/);

    h.failing.tiles = true;
    await moveTo(h, cam, TORONTO);
    stats = trafficLayer.getStats();
    assert.equal(h.roadPasses(), 2, 'the tiles were tried first');
    assert.equal(h.calls.overpass.length, 1, 'then Overpass, once');
    const box = h.calls.overpass[0].box;
    assert.ok(Math.abs(box.lat - TORONTO.lat) < 0.01 && Math.abs(box.lon - TORONTO.lon) < 0.01);
    assert.equal(stats.roadSource, 'overpass');
    assert.equal(stats.roadsError, null);
    assert.ok(stats.count > 0, 'the fallback still draws traffic');
  });
});

test('with the tiles and Overpass both down, getStats reports roadsError and the chip says why', async () => {
  await withTraffic(async (h) => {
    h.failing.tiles = true;
    h.failing.overpass = true;
    await loadCurrentView(h);
    const stats = trafficLayer.getStats();
    assert.equal(stats.roadsError, 'unavailable');
    assert.equal(stats.count, 0);
    assert.equal(stats.error, 'ROADS UNAVAILABLE — road tiles and Overpass unreachable');
    assert.equal(stats.loadingLabel, stats.error);
    assert.equal(layerFeedState(stats), 'unavailable');
    assert.equal(stats.loading, false, 'a failed load does not read as still loading');
  });
});

test('a view whose roads failed is not retried until its backoff passes, and recovers after', async (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  await withTraffic(async (h, cam) => {
    h.failing.tiles = true;
    h.failing.overpass = true;
    await loadCurrentView(h);
    assert.equal(h.roadPasses(), 1);

    // The enable kick and a small camera nudge both land inside the backoff.
    h.tick();
    cam.changed.raise();
    assert.equal(h.pending(DEBOUNCE_MS).length, 0, 'no retry storm while both sources are down');

    clock += 5_001;
    h.tick();
    assert.equal(h.pending(DEBOUNCE_MS).length, 1, 'the first backoff is 5 s');
    await loadCurrentView(h);
    assert.equal(h.roadPasses(), 2);
    assert.equal(h.calls.overpass.length, 2);

    clock += 5_001;
    h.tick();
    assert.equal(h.pending(DEBOUNCE_MS).length, 0, 'the second backoff doubles to 10 s');
    clock += 5_000;
    h.tick();
    assert.equal(h.pending(DEBOUNCE_MS).length, 1);

    h.failing.tiles = false;
    h.failing.overpass = false;
    await loadCurrentView(h);
    const stats = trafficLayer.getStats();
    assert.equal(stats.roadsError, null, 'a render clears the failure');
    assert.equal(stats.roadSource, 'tiles');
    assert.ok(stats.count > 0);
  });
});

test('a real move or a location switch is never held back by an old view’s backoff', async (t) => {
  const clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  await withTraffic(async (h, cam) => {
    h.failing.tiles = true;
    h.failing.overpass = true;
    await loadCurrentView(h);
    assert.equal(trafficLayer.getStats().roadsError, 'unavailable');

    cam.park(TORONTO);
    cam.changed.raise();
    assert.equal(h.pending(DEBOUNCE_MS).length, 1, 'another place loads at once');
    await loadCurrentView(h);

    trafficLayer.onLocationLeave({ from: TORONTO, to: AUSTIN, enabled: true });
    assert.equal(trafficLayer.getStats().roadsError, null, 'a switch starts clean');
    cam.park(AUSTIN);
    trafficLayer.onLocationArrive({ from: TORONTO, to: AUSTIN, signal: new AbortController().signal });
    assert.equal(h.pending(DEBOUNCE_MS).length, 1, 'arrival loads without waiting out the old backoff');
    h.failing.tiles = false;
    await loadCurrentView(h);
    assert.ok(trafficLayer.getStats().count > 0);
  });
});

test('a partial tile answer renders and reads degraded, and the parked view asks for its missing tile again after a backoff', async (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  await withTraffic(async (h) => {
    let broken = null;
    h.failing.tile = ({ x, y }) => {
      broken ??= `${x}/${y}`;
      return `${x}/${y}` === broken;
    };
    await loadCurrentView(h);
    assert.ok(h.calls.tiles.length >= 2, 'the test view must straddle a tile edge');
    let stats = trafficLayer.getStats();
    assert.ok(stats.count > 0);
    assert.equal(stats.roadSource, 'tiles');
    assert.equal(h.calls.overpass.length, 0, 'a partial answer is not a fallback');
    assert.equal(stats.roadsError, 'partial');
    assert.equal(stats.error, 'ROADS PARTIAL — some road tiles failed, retrying');
    assert.equal(layerFeedState(stats), 'degraded');

    // The camera stays parked: no camera.changed, only the load kick.
    h.failing.tile = () => false;
    const before = h.calls.tiles.length;
    h.tick();
    assert.equal(h.pending(DEBOUNCE_MS).length, 0, 'the retry waits out its backoff');
    clock += 5_001;
    h.tick();
    assert.equal(h.pending(DEBOUNCE_MS).length, 1, 'then the parked view loads again');
    await loadCurrentView(h);
    assert.deepEqual(
      h.calls.tiles.slice(before).map(({ x, y }) => `${x}/${y}`),
      [broken],
      'only the tile that failed is requested again',
    );
    stats = trafficLayer.getStats();
    assert.equal(stats.roadsError, null, 'a complete load clears the degraded state');
    assert.ok(stats.count > 0);
    await settle();
  });
});

test('a full pass that fails after the major roads rendered reads degraded and is retried with backoff while parked', async (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  await withTraffic(async (h, cam) => {
    // Below FAST_FETCH_ALTITUDE a load runs the major pass, then the full pass.
    cam.park(AUSTIN, 3000);
    cam.changed.raise();
    h.failing.tile = ({ z }) => z === 14;
    h.failing.overpass = true;
    await loadCurrentView(h);
    let stats = trafficLayer.getStats();
    assert.equal(h.roadPasses(), 2, 'the major and the full pass both ran');
    assert.equal(h.calls.overpass.length, 1, 'the failed full pass tried the fallback');
    assert.ok(stats.count > 0, 'the major roads stay on screen');
    assert.equal(stats.roadsError, 'partial');
    assert.equal(layerFeedState(stats), 'degraded');
    assert.equal(stats.loading, false);

    h.tick();
    cam.changed.raise();
    assert.equal(h.pending(DEBOUNCE_MS).length, 0, 'no retry inside the backoff');
    clock += 5_001;
    h.tick();
    assert.equal(h.pending(DEBOUNCE_MS).length, 1, 'the parked view is asked again');
    await loadCurrentView(h);
    assert.equal(trafficLayer.getStats().roadsError, 'partial', 'still failing');
    assert.equal(h.calls.overpass.length, 2);

    clock += 5_001;
    h.tick();
    assert.equal(h.pending(DEBOUNCE_MS).length, 0, 'the second backoff doubles to 10 s');
    clock += 5_000;
    h.tick();
    assert.equal(h.pending(DEBOUNCE_MS).length, 1);
    h.failing.tile = () => false;
    h.failing.overpass = false;
    await loadCurrentView(h);
    stats = trafficLayer.getStats();
    assert.equal(stats.roadsError, null, 'the complete load clears it');
    assert.equal(stats.roadSource, 'tiles');
    assert.ok(stats.count > 0);
  });
});
