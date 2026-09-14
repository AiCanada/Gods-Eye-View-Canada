// src/data/trafficLocationSwitch.test.mjs
// Location-switch hooks for the traffic layer. Selecting a place in another
// region must stop the old view's requests and dots, release parsed roads away
// from the destination, and reload on arrival, all without disabling the
// layer. Inter-city world jumps pause the same way but keep every cache.
// Roads come from the road tile proxy (trafficTestHarness serves a grid tile);
// a "road pass" is one load's set of tile requests, which share one signal.
import test from 'node:test';
import assert from 'node:assert/strict';
import trafficLayer, { tileCacheKeysAwayFrom } from './traffic.js';
import {
  AUSTIN,
  DEBOUNCE_MS,
  NEAR_AUSTIN,
  PAUSE_WATCHDOG_MS,
  TORONTO,
  loadCurrentView,
  settle,
  trafficHolds,
  withTraffic,
} from './trafficTestHarness.mjs';

test('the layer exposes the switch hooks and the world-jump methods the shell calls', () => {
  for (const name of ['onLocationLeave', 'onLocationArrive', 'beginWorldJump', 'endWorldJump']) {
    assert.equal(typeof trafficLayer[name], 'function', `${name} must exist`);
  }
  // update() is a no-op, so a manager refresh after arrival would do nothing.
  assert.notEqual(trafficLayer.refreshOnLocationArrive, true);
  // Before init nothing is enabled: every hook is a quiet no-op.
  assert.doesNotThrow(() => trafficLayer.onLocationLeave());
  assert.doesNotThrow(() => trafficLayer.onLocationArrive());
  assert.doesNotThrow(() => trafficLayer.beginWorldJump());
  assert.doesNotThrow(() => trafficLayer.endWorldJump());
});

test('tile-cache eviction keeps boxes near the destination and releases the rest', () => {
  const key = ({ lat, lon }) =>
    [lat - 0.025, lon - 0.025, lat + 0.025, lon + 0.025].map((v) => v.toFixed(4)).join(',');
  const near = key(NEAR_AUSTIN); // ~5 km
  const edge = key({ lat: 30.45, lon: AUSTIN.lon }); // ~20 km
  const outside = key({ lat: 30.52, lon: AUSTIN.lon }); // ~28 km
  const far = key(TORONTO);
  assert.deepEqual(tileCacheKeysAwayFrom([near, edge, outside, far], AUSTIN, 25), [outside, far]);
  assert.deepEqual(
    tileCacheKeysAwayFrom([near, far], null, 25),
    [near, far],
    'an unknown destination releases everything',
  );
  assert.deepEqual(tileCacheKeysAwayFrom(['garbage', near], AUSTIN, 25), ['garbage']);
});

test('leaving mid-load cancels the old view, ignores mid-flight camera moves and reloads on arrival', async () => {
  await withTraffic(async (h, cam) => {
    h.hold('tiles');
    h.hold('flow');
    const staleLoad = h.fire(DEBOUNCE_MS);
    await settle();
    assert.equal(h.roadPasses(), 1);
    const roadRequests = [...h.calls.tiles];
    const warmUp = h.calls.flow.at(-1);
    assert.ok(warmUp, 'live mode warms flow tiles beside the road fetch');
    assert.ok(roadRequests.every((request) => !request.signal.aborted));
    assert.equal(warmUp.signal.aborted, false);

    trafficLayer.onLocationLeave({
      from: AUSTIN,
      to: TORONTO,
      signal: new AbortController().signal,
      enabled: true,
    });
    assert.ok(roadRequests.every((request) => request.signal.aborted), 'the old view road fetch is aborted');
    assert.equal(warmUp.signal.aborted, true, 'the flow warm-up can be cancelled');
    assert.equal(h.pending(DEBOUNCE_MS).length, 0);
    assert.equal(h.intervals.size, 0, 'the load kick stops for the flight');
    assert.equal(trafficLayer.getStats().loading, false);
    assert.equal(trafficHolds(), false, 'no continuous render while nothing animates');

    cam.park(TORONTO, 60000);
    cam.changed.raise();
    cam.park(TORONTO);
    cam.changed.raise();
    assert.equal(h.pending(DEBOUNCE_MS).length, 0, 'camera moves mid-flight arm no fetch');

    h.release('tiles');
    await staleLoad;
    await settle();
    assert.equal(trafficLayer.getStats().count, 0, 'a late reply for the old view renders nothing');
    assert.equal(trafficLayer.getStats().roadsError, null, 'a cancelled load is not a road failure');

    h.release('flow');
    trafficLayer.onLocationArrive({ from: AUSTIN, to: TORONTO, signal: new AbortController().signal });
    assert.equal(trafficHolds(), true);
    assert.equal(h.intervals.size, 1, 'arrival re-arms the load kick');
    await loadCurrentView(h);
    assert.equal(h.roadPasses(), 2);
    assert.ok(h.lastPassCovers(TORONTO), 'the arrival loads the destination');
    assert.equal(h.calls.overpass.length, 0, 'Overpass is not asked while road tiles answer');
    assert.ok(trafficLayer.getStats().count > 0);
  });
});

test('leaving releases parsed roads away from the destination and keeps nearby ones', async () => {
  await withTraffic(async (h, cam) => {
    await loadCurrentView(h);
    assert.equal(h.roadPasses(), 1);
    assert.ok(trafficLayer.getStats().count > 0);
    const flowAfterFirstLoad = h.calls.flow.length;
    assert.ok(flowAfterFirstLoad > 0);

    // Nearby destination: the Austin roads survive, decoded flow tiles do not.
    trafficLayer.onLocationLeave({ from: AUSTIN, to: NEAR_AUSTIN, enabled: true });
    assert.equal(trafficLayer.getStats().count, 0, 'the old view dots are removed');
    trafficLayer.onLocationArrive({ from: AUSTIN, to: NEAR_AUSTIN });
    await loadCurrentView(h);
    assert.equal(h.roadPasses(), 1, 'roads within the keep radius render from the client cache');
    assert.equal(trafficLayer.getStats().roadSource, 'cache');
    assert.ok(h.calls.flow.length > flowAfterFirstLoad, 'decoded flow tiles were released');
    assert.ok(trafficLayer.getStats().count > 0);

    // Far destination: the Austin roads and decoded road tiles go.
    trafficLayer.onLocationLeave({ from: AUSTIN, to: TORONTO, enabled: true });
    cam.park(TORONTO);
    trafficLayer.onLocationArrive({ from: AUSTIN, to: TORONTO });
    await loadCurrentView(h);
    assert.equal(h.roadPasses(), 2);
    trafficLayer.onLocationLeave({ from: TORONTO, to: AUSTIN, enabled: true });
    cam.park(AUSTIN);
    trafficLayer.onLocationArrive({ from: TORONTO, to: AUSTIN });
    await loadCurrentView(h);
    assert.equal(h.roadPasses(), 3, 'the Austin roads were released on the way to Toronto');
    assert.ok(trafficLayer.getStats().count > 0);
  });
});

test('a world jump pauses loading like a switch but keeps every cache', async () => {
  await withTraffic(async (h, cam) => {
    await loadCurrentView(h);
    const flowBefore = h.calls.flow.length;

    trafficLayer.beginWorldJump();
    assert.equal(trafficLayer.getStats().count, 0);
    assert.equal(trafficHolds(), false);
    cam.changed.raise();
    assert.equal(h.pending(DEBOUNCE_MS).length, 0, 'camera moves mid-jump arm no fetch');

    trafficLayer.endWorldJump();
    assert.equal(trafficHolds(), true);
    await loadCurrentView(h);
    assert.equal(h.roadPasses(), 1, 'parsed roads are kept');
    assert.equal(h.calls.flow.length, flowBefore, 'decoded flow tiles are kept');
    assert.ok(trafficLayer.getStats().count > 0);
  });
});

test('loading resumes only after every pause owner is done, and a superseded arrival changes nothing', async () => {
  await withTraffic(async (h, cam) => {
    await loadCurrentView(h);
    trafficLayer.beginWorldJump();
    trafficLayer.onLocationLeave({ from: AUSTIN, to: TORONTO, enabled: true });
    trafficLayer.onLocationLeave({ from: AUSTIN, to: TORONTO, enabled: true });
    cam.park(TORONTO);

    trafficLayer.endWorldJump();
    cam.changed.raise();
    assert.equal(h.pending(DEBOUNCE_MS).length, 0, 'the location switch still owns the pause');

    const superseded = new AbortController();
    superseded.abort();
    trafficLayer.onLocationArrive({ from: AUSTIN, to: TORONTO, signal: superseded.signal });
    cam.changed.raise();
    assert.equal(h.pending(DEBOUNCE_MS).length, 0, 'an aborted arrival belongs to a superseded switch');

    trafficLayer.onLocationArrive({ from: AUSTIN, to: TORONTO, signal: new AbortController().signal });
    assert.equal(h.pending(DEBOUNCE_MS).length, 1);
    assert.equal(h.pending(PAUSE_WATCHDOG_MS).length, 0, 'the watchdog is cleared once loading resumes');
    await loadCurrentView(h);
    assert.ok(trafficLayer.getStats().count > 0);
  });
});

test('a flight that never reports arrival cannot leave traffic paused', async () => {
  await withTraffic(async (h, cam) => {
    await loadCurrentView(h);
    assert.doesNotThrow(() => trafficLayer.onLocationLeave());
    assert.doesNotThrow(() => trafficLayer.onLocationLeave(null));
    assert.equal(h.pending(PAUSE_WATCHDOG_MS).length, 1, 'one watchdog, however many leaves');
    cam.changed.raise();
    assert.equal(h.pending(DEBOUNCE_MS).length, 0);

    h.fire(PAUSE_WATCHDOG_MS);
    assert.equal(trafficHolds(), true);
    await loadCurrentView(h);
    assert.equal(h.roadPasses(), 2, 'a leave without a destination releases every parsed road');
    assert.ok(trafficLayer.getStats().count > 0);
  });
});

test('a switch while traffic is off still releases memory and never blocks the next enable', async () => {
  await withTraffic(async (h, cam) => {
    await loadCurrentView(h);
    trafficLayer.disable(cam.viewer);
    trafficLayer.onLocationLeave({ from: AUSTIN, to: TORONTO, enabled: false });
    assert.equal(h.pending(PAUSE_WATCHDOG_MS).length, 0, 'a disabled layer has nothing to pause');

    trafficLayer.enable(cam.viewer);
    await loadCurrentView(h);
    assert.equal(h.roadPasses(), 2, 'the Austin roads were released while the layer was off');
    assert.ok(trafficLayer.getStats().count > 0);
  });
});
