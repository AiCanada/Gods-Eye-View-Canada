// Location switch and world jump for Street Traffic (fork behaviour ported
// onto the split layer): leaving pauses camera-driven loading and drops the
// old view, arrival reloads the destination, a world jump pauses like a
// switch but keeps every cache, and a lost arrival cannot leave traffic dead.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTrafficLayer, tileCacheKeysAwayFrom } from './index.js';
import { FETCH_PAUSE_MAX_MS } from './locationSwitch.js';

const AUSTIN = { lat: 30.267, lon: -97.744 };
const NEAR_AUSTIN = { lat: 30.3122, lon: -97.744 };
const TORONTO = { lat: 43.6532, lon: -79.3832 };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function roads(bounds) {
  return {
    ok: true,
    json: async () => ({
      roadMode: 'osm',
      roads: [
        {
          type: 'primary',
          oneway: 0,
          coordinates: [
            [bounds.west, bounds.south],
            [bounds.west + 0.005, bounds.south + 0.005],
          ],
        },
      ],
    }),
  };
}

function setup(t, requestRoads = async (bounds) => roads(bounds)) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const holds = new Set();
  const calls = { roads: [], flowResets: 0 };
  const camera = {
    positionCartographic: Cesium.Cartographic.fromDegrees(
      AUSTIN.lon,
      AUSTIN.lat,
      3200,
    ),
    get positionWC() {
      return Cesium.Cartesian3.fromRadians(
        this.positionCartographic.longitude,
        this.positionCartographic.latitude,
        this.positionCartographic.height,
      );
    },
    changed: new Cesium.Event(),
    moveEnd: new Cesium.Event(),
    percentageChanged: 0.5,
    computeViewRectangle() {
      const { longitude, latitude } = this.positionCartographic;
      return new Cesium.Rectangle(
        longitude - 0.0002,
        latitude - 0.0002,
        longitude + 0.0002,
        latitude + 0.0002,
      );
    },
    pickEllipsoid: () => null,
  };
  const viewer = {
    camera,
    scene: {
      canvas: { width: 100, height: 100 },
      globe: { show: true, tilesLoaded: true, getHeight: () => 0 },
      preRender: new Cesium.Event(),
      primitives: { add: (value) => value, remove: () => true },
    },
  };
  const layer = createTrafficLayer({
    services: {
      credits: {},
      render: {
        holdContinuousRender: (id) => holds.add(id),
        releaseContinuousRender: (id) => holds.delete(id),
      },
    },
    source: {
      requestRoads: (bounds, options) => {
        calls.roads.push({ bounds, signal: options?.signal });
        return requestRoads(bounds, options);
      },
      getStatus: async () => ({ hasKey: false }),
      fetchFlowForBounds: async () => [],
      getFlowSessionStats: () => ({ tilesFetched: 0 }),
      resetFlowTileCache() {
        calls.flowResets += 1;
      },
    },
  });
  layer.init(viewer);
  t.after(() => layer.destroy(viewer));
  const park = ({ lat, lon }, height = 3200) => {
    camera.positionCartographic = Cesium.Cartographic.fromDegrees(
      lon,
      lat,
      height,
    );
  };
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  const load = async () => {
    for (let i = 0; i < 6; i++) await tick(400);
  };
  return { layer, viewer, camera, park, tick, load, calls, holds };
}

test('the layer exposes the switch hooks and the world-jump methods', (t) => {
  const { layer } = setup(t);
  for (const name of [
    'onLocationLeave',
    'onLocationArrive',
    'beginWorldJump',
    'endWorldJump',
  ])
    assert.equal(typeof layer[name], 'function', name);
});

test('tile-cache eviction keeps boxes near the destination and releases the rest', () => {
  const austinBox = `${AUSTIN.lat - 0.02},${AUSTIN.lon - 0.02},${AUSTIN.lat + 0.02},${AUSTIN.lon + 0.02}`;
  const torontoBox = `${TORONTO.lat - 0.02},${TORONTO.lon - 0.02},${TORONTO.lat + 0.02},${TORONTO.lon + 0.02}`;
  // z14 tile over Austin as a footprint coverage key.
  const n = 2 ** 14;
  const x = Math.floor(((AUSTIN.lon + 180) / 360) * n);
  const latRad = (AUSTIN.lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      n,
  );
  const coverage = `14/${x}/${y}`;
  assert.deepEqual(
    tileCacheKeysAwayFrom([austinBox, torontoBox, coverage, 'junk'], NEAR_AUSTIN, 25),
    [torontoBox, 'junk'],
  );
  assert.deepEqual(tileCacheKeysAwayFrom([austinBox], null, 25), [austinBox]);
});

test('leaving mid-load cancels the old view, ignores mid-flight camera moves and reloads on arrival', async (t) => {
  const pending = [];
  const h = setup(t, (bounds, { signal } = {}) => {
    const result = deferred();
    pending.push({ ...result, bounds, signal });
    return result.promise;
  });
  h.layer.enable(h.viewer);
  await h.tick(400);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].signal.aborted, false);

  h.layer.onLocationLeave({ from: AUSTIN, to: TORONTO, enabled: true });
  assert.equal(pending[0].signal.aborted, true, 'the old view road fetch is aborted');
  assert.equal(h.layer.getStats().loading, false);
  assert.equal(h.holds.has('traffic'), false, 'no continuous render while nothing animates');

  h.park(TORONTO);
  h.camera.changed.raiseEvent();
  h.camera.moveEnd.raiseEvent();
  await h.tick(400);
  assert.equal(pending.length, 1, 'camera moves mid-flight arm no fetch');

  pending[0].resolve(roads(pending[0].bounds));
  await h.tick(0);
  assert.equal(h.layer.getStats().count, 0, 'a late reply for the old view renders nothing');

  h.layer.onLocationArrive({ from: AUSTIN, to: TORONTO, signal: new AbortController().signal });
  assert.equal(h.holds.has('traffic'), true);
  await h.tick(0);
  assert.equal(pending.length, 2, 'the arrival loads the destination at once');
  assert.ok(pending[1].bounds.south > 40, 'the new request covers the destination');
});

test('leaving releases parsed roads away from the destination and decoded flow tiles', async (t) => {
  const h = setup(t);
  h.layer.enable(h.viewer);
  await h.load();
  assert.ok(h.layer.getStats().count > 0);
  const resets = h.calls.flowResets;

  h.layer.onLocationLeave({ from: AUSTIN, to: TORONTO, enabled: true });
  assert.equal(h.layer.getStats().count, 0, 'the old view dots are removed');
  assert.equal(h.calls.flowResets, resets + 1, 'decoded flow tiles were released');
  h.park(TORONTO);
  h.layer.onLocationArrive({ from: AUSTIN, to: TORONTO });
  await h.load();
  assert.ok(h.layer.getStats().count > 0);
});

test('a world jump pauses loading like a switch but keeps every cache', async (t) => {
  const h = setup(t);
  h.layer.enable(h.viewer);
  await h.load();
  const requests = h.calls.roads.length;
  const resets = h.calls.flowResets;

  h.layer.beginWorldJump();
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.holds.has('traffic'), false);
  h.camera.changed.raiseEvent();
  await h.tick(400);
  assert.equal(h.calls.roads.length, requests, 'camera moves mid-jump arm no fetch');

  h.layer.endWorldJump();
  assert.equal(h.holds.has('traffic'), true);
  await h.load();
  assert.equal(h.calls.flowResets, resets, 'decoded tiles are kept');
  assert.ok(h.layer.getStats().count > 0);
});

test('loading resumes only after every pause owner is done, and a superseded arrival changes nothing', async (t) => {
  const h = setup(t);
  h.layer.enable(h.viewer);
  await h.load();
  h.layer.beginWorldJump();
  h.layer.onLocationLeave({ from: AUSTIN, to: TORONTO, enabled: true });
  h.layer.onLocationLeave({ from: AUSTIN, to: TORONTO, enabled: true });
  h.park(TORONTO);
  const requests = h.calls.roads.length;

  h.layer.endWorldJump();
  h.camera.changed.raiseEvent();
  await h.tick(400);
  assert.equal(h.calls.roads.length, requests, 'the location switch still owns the pause');

  const superseded = new AbortController();
  superseded.abort();
  h.layer.onLocationArrive({ signal: superseded.signal });
  h.camera.changed.raiseEvent();
  await h.tick(400);
  assert.equal(h.calls.roads.length, requests, 'an aborted arrival belongs to a superseded switch');

  h.layer.onLocationArrive({ signal: new AbortController().signal });
  await h.load();
  assert.ok(h.calls.roads.length > requests);
  assert.ok(h.layer.getStats().count > 0);
});

test('a flight that never reports arrival cannot leave traffic paused', async (t) => {
  const h = setup(t);
  h.layer.enable(h.viewer);
  await h.load();
  assert.doesNotThrow(() => h.layer.onLocationLeave());
  assert.doesNotThrow(() => h.layer.onLocationLeave(null));
  const requests = h.calls.roads.length;
  h.camera.changed.raiseEvent();
  await h.tick(400);
  assert.equal(h.calls.roads.length, requests);

  await h.tick(FETCH_PAUSE_MAX_MS);
  assert.equal(h.holds.has('traffic'), true);
  await h.load();
  assert.ok(h.calls.roads.length > requests, 'the watchdog resumed loading');
  assert.ok(h.layer.getStats().count > 0);
});

test('a switch while traffic is off still releases memory and never blocks the next enable', async (t) => {
  const h = setup(t);
  h.layer.enable(h.viewer);
  await h.load();
  h.layer.disable(h.viewer);
  const resets = h.calls.flowResets;
  h.layer.onLocationLeave({ from: AUSTIN, to: TORONTO, enabled: false });
  assert.equal(h.calls.flowResets, resets + 1);
  h.layer.beginWorldJump();
  h.park(TORONTO);
  h.layer.enable(h.viewer);
  await h.load();
  assert.ok(h.layer.getStats().count > 0, 'enable is never blocked by a switch it missed');
});
