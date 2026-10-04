// src/data/trafficRoadParseSlices.test.mjs
// Parsing a city's roads froze the page for three seconds and more: each road
// cost a synchronous `scene.sampleHeight` GPU read-back, all in one task. The
// fork sliced that work with the thread handed back between slices. Upstream's
// split layer moved the per-road height probes out of the parse into
// `prepareRoadSurfaces` (src/layers/traffic/surface.js), which runs them in
// frame-budgeted slices and stops at an abort. These are the fork's guarantees
// pinned on that code path: the same probes as one pass, never one long task,
// and an overtaken load stops probing.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { prepareRoadSurfaces } from '../layers/traffic/surface.js';

/** The fork's ROAD_PARSE_SLICE_MS, used as the slice budget here. */
const SLICE_MS = 100;
/** What one fake height probe costs on the fake clock. */
const PROBE_MS = 30;

/** Ten roads, each with several height stations, at distinct coordinates. */
function makeRoads(offset) {
  const roads = [];
  for (let r = 0; r < 10; r++) {
    const coords = [];
    for (let i = 0; i < 5; i++)
      coords.push([-97.74 + offset + i * 0.001, 30.26 + r * 0.002]);
    roads.push({
      coords,
      waypoints: coords.map(() => new Cesium.Cartesian3()),
      segmentDist: coords.slice(1).map(() => 0),
    });
  }
  return roads;
}

/**
 * A scene whose height probe costs PROBE_MS on a clock the test owns, and a
 * counter of the slices the work was cut into (each 0 ms hand-back starts a
 * new one).
 */
function installSlowScene(t) {
  let clock = 1000;
  const state = { probes: 0, perSlice: [0], onSlice: null };
  t.mock.method(performance, 'now', () => clock);
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (!delay) {
      state.perSlice.push(0);
      state.onSlice?.(state);
    }
    return realSetTimeout(callback, delay, ...args);
  });
  const tileset = { show: true, tilesLoaded: true };
  const scene = {
    globe: { show: false },
    primitives: { length: 1, get: () => tileset },
    sampleHeightSupported: true,
    sampleHeight: () => {
      clock += PROBE_MS;
      state.probes += 1;
      state.perSlice[state.perSlice.length - 1] += 1;
      return 120;
    },
  };
  return { scene, state };
}

test('road heights are probed in slices, the thread handed back between each, with the same probes as one pass', async (t) => {
  const once = installSlowScene(t);
  await prepareRoadSurfaces(makeRoads(0), once.scene, null, [], null, {
    frameBudgetMs: Infinity,
  });
  const unslicedProbes = once.state.probes;
  assert.equal(once.state.perSlice.length, 1, 'an unbounded budget is one pass');
  assert.ok(unslicedProbes > 6, 'the fixture must need several slices');
  t.mock.restoreAll();

  const sliced = installSlowScene(t);
  const prepared = await prepareRoadSurfaces(
    makeRoads(0),
    sliced.scene,
    null,
    [],
    null,
    { frameBudgetMs: SLICE_MS },
  );
  assert.equal(sliced.state.probes, unslicedProbes, 'every station is still probed, once');
  assert.ok(sliced.state.perSlice.length > 2, 'the work handed the thread back to the map');
  const most = Math.max(...sliced.state.perSlice);
  assert.ok(
    most <= Math.ceil(SLICE_MS / PROBE_MS),
    `no slice may run past its budget (${most} probes in one slice)`,
  );
  assert.equal(prepared.ready.length, 10, 'and every road is ready to draw');
});

test('work overtaken while the thread is handed back stops probing', async (t) => {
  const { scene, state } = installSlowScene(t);
  const abort = new AbortController();
  let probesAtAbort = null;
  state.onSlice = () => {
    if (probesAtAbort !== null) return;
    probesAtAbort = state.probes;
    abort.abort();
  };
  await assert.rejects(
    prepareRoadSurfaces(makeRoads(1), scene, null, [], abort.signal, {
      frameBudgetMs: SLICE_MS,
    }),
    { name: 'AbortError' },
  );
  assert.ok(probesAtAbort > 0);
  assert.equal(state.probes, probesAtAbort, 'not one more probe after the abort');
});
