import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RENDER_RECOVERY_BASE_DELAY_MS,
  RENDER_RECOVERY_MAX_DELAY_MS,
  RENDER_RECOVERY_MAX_RESTARTS,
  RENDER_RECOVERY_WINDOW_MS,
  describeRenderError,
  installRenderRecovery,
  planRenderRecovery,
} from './renderRecovery.js';

test('frame errors are survived with a growing pause, and a persistent one runs out of restarts', () => {
  let history = [];
  const delays = [];
  for (let i = 0; i < RENDER_RECOVERY_MAX_RESTARTS; i++) {
    const plan = planRenderRecovery(history, 1000 + i);
    assert.equal(plan.restart, true);
    delays.push(plan.delayMs);
    history = plan.history;
  }
  assert.equal(delays[0], RENDER_RECOVERY_BASE_DELAY_MS);
  assert.ok(delays.every((delay, i) => i === 0 || delay >= delays[i - 1]));
  assert.ok(delays.every((delay) => delay <= RENDER_RECOVERY_MAX_DELAY_MS));
  assert.equal(planRenderRecovery(history, 2000).restart, false);
  // Once the window has passed the budget is whole again.
  const later = planRenderRecovery(history, 2000 + RENDER_RECOVERY_WINDOW_MS);
  assert.equal(later.restart, true);
  assert.equal(later.delayMs, RENDER_RECOVERY_BASE_DELAY_MS);
});

test('whatever a frame threw is described briefly', () => {
  assert.equal(describeRenderError(new TypeError('bad thing')), 'TypeError: bad thing');
  assert.equal(describeRenderError({ statusCode: 404, constructor: { name: 'RequestErrorEvent' } }), 'RequestErrorEvent: status 404');
  assert.equal(describeRenderError(null), 'unknown error');
  assert.ok(describeRenderError('x'.repeat(1000)).length <= 300);
});

function fakeViewer() {
  const listeners = [];
  const viewer = {
    useDefaultRenderLoop: true,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    panels: [],
    renders: 0,
    cesiumWidget: {
      showErrorPanel: (title, _message, error) => viewer.panels.push({ title, error }),
    },
    scene: {
      requestRender: () => {
        viewer.renders += 1;
      },
      renderError: {
        addEventListener: (listener) => {
          listeners.push(listener);
          return () => listeners.splice(listeners.indexOf(listener), 1);
        },
      },
    },
    fail(error) {
      // What the widget does when a frame throws: raise the event, stop the loop.
      for (const listener of [...listeners]) listener(viewer.scene, error);
      viewer.useDefaultRenderLoop = false;
    },
    listeners,
  };
  return viewer;
}

test('one failed frame restarts the loop; a frame that keeps failing finally shows the modal', () => {
  const viewer = fakeViewer();
  let clock = 0;
  const timers = [];
  const logs = [];
  const uninstall = installRenderRecovery(viewer, {
    now: () => clock,
    setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
    clearTimer: () => {},
    log: (message) => logs.push(message),
  });

  viewer.fail(new Error('sky box texture failed'));
  assert.equal(viewer.useDefaultRenderLoop, false);
  assert.equal(timers.length, 1);
  timers[0].fn();
  assert.equal(viewer.useDefaultRenderLoop, true);
  assert.equal(viewer.renders, 1);
  assert.equal(viewer.panels.length, 0, 'no modal for an error that was survived');

  for (let i = 1; i < RENDER_RECOVERY_MAX_RESTARTS; i++) {
    clock += 10;
    viewer.fail(new Error('again'));
    timers[timers.length - 1].fn();
  }
  assert.equal(viewer.panels.length, 0);
  clock += 10;
  viewer.fail(new Error('permanent'));
  assert.equal(viewer.panels.length, 1);
  assert.equal(viewer.panels[0].error.message, 'permanent');
  assert.equal(viewer.useDefaultRenderLoop, false, 'rendering stays stopped, as it always did');
  assert.match(logs.at(-1), /persists, rendering stopped: Error: permanent/);

  uninstall();
  assert.equal(viewer.listeners.length, 0);
});

test('a destroyed viewer is never restarted, and a viewer without the event is left alone', () => {
  const viewer = fakeViewer();
  const timers = [];
  installRenderRecovery(viewer, { setTimer: (fn) => timers.push(fn), clearTimer: () => {}, log: () => {} });
  viewer.fail(new Error('x'));
  viewer.destroyed = true;
  timers[0]();
  assert.equal(viewer.useDefaultRenderLoop, false);
  assert.equal(typeof installRenderRecovery({}), 'function');
});

test('the viewer hands the render-error modal to the recovery', () => {
  const source = readFileSync(new URL('./viewer.js', import.meta.url), 'utf8');
  // Constructor-only in Cesium: without it the widget shows its modal on the first error.
  assert.match(source, /showRenderLoopErrors: false/);
  assert.match(source, /installRenderRecovery\(viewer\)/);
});
