// src/data/trafficRoadParseSlices.test.mjs
// Parsing a city's roads froze the page for three seconds and more: each road
// costs one `scene.sampleHeight`, a synchronous GPU read-back, and they all ran
// in one task. The parse now runs in slices with the thread handed back
// between them: the same roads and the same probes, never in one long task,
// and a load overtaken while a slice waits stops probing.
import test from 'node:test';
import assert from 'node:assert/strict';
import trafficLayer from './traffic.js';
import { DEBOUNCE_MS, settle, withTraffic } from './trafficTestHarness.mjs';

/** traffic.js ROAD_PARSE_SLICE_MS. */
const SLICE_MS = 100;
/** What one fake height probe costs on the fake clock. */
const PROBE_MS = 30;

/**
 * A scene whose height probe costs PROBE_MS on a clock the test owns. With
 * `frames`, the page looks like a browser's (it has frames to protect), so
 * the parse hands the thread back through the harness's captured 0 ms timers.
 */
function installSlowScene(viewer, { frames = true } = {}) {
  const saved = { now: performance.now, raf: globalThis.requestAnimationFrame };
  let clock = 1000;
  const state = { probes: 0, perSlice: [0] };
  performance.now = () => clock;
  viewer.scene.sampleHeightSupported = true;
  viewer.scene.sampleHeight = () => {
    clock += PROBE_MS;
    state.probes += 1;
    state.perSlice[state.perSlice.length - 1] += 1;
    return 120;
  };
  if (frames) globalThis.requestAnimationFrame = () => 0;
  return {
    state,
    /** Run the debounced load, giving the thread back whenever it is asked for. */
    async run(h, { onFrame = null } = {}) {
      let done = false;
      Promise.resolve(h.fire(DEBOUNCE_MS)).then(() => { done = true; });
      for (let guard = 0; !done && guard < 10_000; guard++) {
        await settle();
        if (h.pending(0).length === 0) continue;
        state.perSlice.push(0);
        onFrame?.(state);
        h.fire(0);
      }
      await settle();
      return done;
    },
    restore() {
      performance.now = saved.now;
      if (saved.raf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = saved.raf;
    },
  };
}

test('roads are parsed in slices, the thread handed back between each, with the same probes as one pass', async () => {
  let unslicedProbes = 0;
  await withTraffic(async (h, cam) => {
    const scene = installSlowScene(cam.viewer, { frames: false });
    try {
      assert.equal(await scene.run(h), true);
      unslicedProbes = scene.state.probes;
      assert.equal(scene.state.perSlice.length, 1, 'no frames to protect outside a browser: one pass');
      assert.ok(trafficLayer.getStats().count > 0);
    } finally {
      scene.restore();
    }
  });
  assert.ok(unslicedProbes > 6, 'the fixture must hold enough roads to need several slices');

  await withTraffic(async (h, cam) => {
    const scene = installSlowScene(cam.viewer);
    try {
      assert.equal(await scene.run(h), true);
      assert.equal(scene.state.probes, unslicedProbes, 'every road is still probed, once');
      assert.ok(scene.state.perSlice.length > 2, 'the parse handed the thread back to the map');
      const most = Math.max(...scene.state.perSlice);
      assert.ok(
        most <= Math.ceil(SLICE_MS / PROBE_MS),
        `no slice may run past its budget (${most} probes in one slice)`,
      );
      assert.ok(trafficLayer.getStats().count > 0, 'and the traffic is drawn');
      assert.equal(trafficLayer.getStats().roadsError, null);
    } finally {
      scene.restore();
    }
  });
});

test('a parse overtaken while the thread is handed back stops probing and draws nothing', async () => {
  await withTraffic(async (h, cam) => {
    const scene = installSlowScene(cam.viewer);
    try {
      let probesAtSwitchOff = null;
      await scene.run(h, {
        onFrame: (state) => {
          if (probesAtSwitchOff !== null) return;
          probesAtSwitchOff = state.probes;
          trafficLayer.disable(cam.viewer);
        },
      });
      assert.ok(probesAtSwitchOff > 0);
      assert.equal(scene.state.probes, probesAtSwitchOff, 'not one more probe for a layer that was switched off');
      assert.equal(trafficLayer.getStats().count, 0);
    } finally {
      scene.restore();
    }
  });
});
