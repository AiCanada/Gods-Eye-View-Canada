import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createApplication } from './application.js';

const phases = ['Scene', 'Controls', 'Data', 'Tools'];
function fixture(overrides = {}) {
  const events = [];
  const constructors = Object.fromEntries(
    phases.map((phase) => [
      `create${phase}`,
      ({ defer }) => {
        events.push(`start:${phase}`);
        defer(() => events.push(`stop:${phase}`));
        return { name: phase };
      },
    ]),
  );
  return { events, app: createApplication({ ...constructors, ...overrides }) };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('importing and constructing the package is inactive without browser globals', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    globalThis.fetch = () => { throw new Error('unexpected request'); };
    globalThis.setTimeout = () => { throw new Error('unexpected timer'); };
    const { createApplication } = await import('gods-eye-view/application');
    const fail = () => { throw new Error('unexpected construction'); };
    const app = createApplication({ createScene: fail, createControls: fail, createData: fail, createTools: fail });
    if (app.getState().status !== 'created') process.exit(1);
  `,
    ],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('constructors are validated before allocating anything', () => {
  assert.throws(() => createApplication({}), /Missing scene constructor/);
});

test('startup shares one promise and teardown keeps data alive for controls', async () => {
  const { app, events } = fixture({
    createTools({ scene, controls, data, defer }) {
      assert.equal(scene.name, 'Scene');
      assert.equal(controls.name, 'Controls');
      assert.equal(data.name, 'Data');
      defer(() => events.push('stop:Tools'));
      return { name: 'Tools' };
    },
  });
  const states = [];
  app.subscribe((state) => states.push(`${state.status}:${state.phase}`));
  const started = app.start();
  assert.equal(started, app.start());
  const components = await started;
  assert.ok(Object.isFrozen(components));
  assert.equal(components.tools.name, 'Tools');
  assert.equal(app.getState().status, 'ready');
  const stopped = app.destroy();
  assert.equal(stopped, app.destroy());
  await stopped;
  assert.deepEqual(events.slice(-4), [
    'stop:Tools',
    'stop:Controls',
    'stop:Data',
    'stop:Scene',
  ]);
  assert.deepEqual(app.getComponents(), {});
  assert.equal(states.at(-1), 'destroyed:null');
  await assert.rejects(app.start(), /destroyed/);
});

for (const phase of phases) {
  test(`failure during ${phase} releases partially acquired resources`, async () => {
    const { app, events } = fixture({
      [`create${phase}`]({ defer }) {
        defer(() => events.push('partial:released'));
        throw new Error('broken constructor');
      },
    });
    await assert.rejects(app.start(), /broken constructor/);
    assert.equal(
      events.filter((value) => value === 'partial:released').length,
      1,
    );
    assert.equal(app.getState().status, 'failed');
    assert.deepEqual(app.getComponents(), {});
    await app.destroy();
    assert.equal(
      events.filter((value) => value === 'partial:released').length,
      1,
    );
  });
}

test('destroy before startup prevents every constructor', async () => {
  const { app, events } = fixture();
  const started = app.start();
  const failed = assert.rejects(started, { name: 'AbortError' });
  await app.destroy();
  await failed;
  assert.deepEqual(events, []);
});

test('destroy aborts an in-flight constructor and cleans late acquisitions before resolving', async () => {
  const gate = deferred();
  const entered = deferred();
  let observedSignal;
  const { app, events } = fixture({
    async createScene({ signal, defer }) {
      observedSignal = signal;
      entered.resolve();
      await gate.promise;
      defer(() => events.push('late:released'));
      return {};
    },
  });
  const started = app.start();
  const failed = assert.rejects(started, { name: 'AbortError' });
  await entered.promise;
  let settled = false;
  const stopped = app.destroy().then(() => {
    settled = true;
  });
  assert.equal(observedSignal.aborted, true);
  await Promise.resolve();
  assert.equal(settled, false);
  gate.resolve();
  await stopped;
  await failed;
  assert.deepEqual(events, ['late:released']);
});

test('cleanup errors are reported after all remaining resources are attempted', async () => {
  const { app, events } = fixture({
    createTools({ defer }) {
      defer(() => events.push('tools:earlier'));
      defer(() => {
        throw new Error('dispose failed');
      });
      return {};
    },
  });
  await app.start();
  await assert.rejects(app.destroy(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, 'dispose failed');
    return true;
  });
  assert.deepEqual(events.slice(-4), [
    'tools:earlier',
    'stop:Controls',
    'stop:Data',
    'stop:Scene',
  ]);
  assert.equal(app.getState().status, 'failed');
});

test('subscribers can destroy during startup without allowing the next constructor', async () => {
  const { app, events } = fixture();
  app.subscribe((state) => {
    if (state.phase === 'controls') void app.destroy();
  });
  await assert.rejects(app.start(), { name: 'AbortError' });
  await app.destroy();
  assert.deepEqual(events, ['start:Scene', 'stop:Scene']);
});

test('destroy during ready notification rejects startup and tears everything down', async () => {
  const { app } = fixture();
  app.subscribe((state) => {
    if (state.status === 'ready') void app.destroy();
  });
  await assert.rejects(app.start(), { name: 'AbortError' });
  await app.destroy();
  assert.equal(app.getState().status, 'destroyed');
});

test('cleanup registration closes when a constructor settles', async () => {
  let register;
  const { app } = fixture({
    createScene({ defer }) {
      register = defer;
      return {};
    },
  });
  await app.start();
  assert.throws(() => register(() => {}), /during component construction/);
  await app.destroy();
});

test('different application instances do not share lifecycle state', async () => {
  const first = fixture();
  const second = fixture();
  await Promise.all([first.app.start(), second.app.start()]);
  await first.app.destroy();
  assert.equal(second.app.getState().status, 'ready');
  assert.equal(second.events.length, 4);
  await second.app.destroy();
});

test('the separate viewer export imports without constructing a browser viewer', async () => {
  const { createApplicationViewer } =
    await import('gods-eye-view/application/viewer');
  assert.equal(typeof createApplicationViewer, 'function');
  assert.throws(() => createApplicationViewer({}), /containers are required/);
});

test('the viewer zooms on the ctrl-modified wheel a trackpad pinch produces', async () => {
  const { globeZoomEventTypes } =
    await import('gods-eye-view/application/viewer');
  const cesium = {
    CameraEventType: {
      RIGHT_DRAG: 'right-drag',
      WHEEL: 'wheel',
      PINCH: 'pinch',
    },
    KeyboardEventModifier: { CTRL: 'ctrl' },
  };
  const types = globeZoomEventTypes(cesium);
  assert.deepEqual(
    types.slice(0, 3),
    ['right-drag', 'wheel', 'pinch'],
    "Cesium's defaults stay in front",
  );
  assert.deepEqual(types[3], { eventType: 'wheel', modifier: 'ctrl' });
  // The set is only useful if the viewer installs it.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./viewer.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /screenSpaceCameraController\.zoomEventTypes =\s*globeZoomEventTypes\(\)/,
  );
});

test('trackpad scroll and pinch are boosted; a mouse wheel is left alone', async () => {
  const { trackpadWheelGain, TRACKPAD_PINCH_GAIN, TRACKPAD_SCROLL_GAIN } =
    await import('gods-eye-view/application/viewer');
  assert.equal(trackpadWheelGain({ deltaMode: 0, deltaY: 100 }), 1);
  assert.equal(trackpadWheelGain({ deltaMode: 0, deltaY: -125 }), 1);
  assert.equal(trackpadWheelGain({ deltaMode: 1, deltaY: 3 }), 1);
  assert.equal(
    trackpadWheelGain({ deltaMode: 0, deltaY: 4 }),
    TRACKPAD_SCROLL_GAIN,
  );
  assert.equal(
    trackpadWheelGain({ deltaMode: 0, deltaY: 52.5 }),
    TRACKPAD_SCROLL_GAIN,
  );
  assert.equal(
    trackpadWheelGain({ deltaMode: 0, deltaY: 100, ctrlKey: true }),
    TRACKPAD_PINCH_GAIN,
  );
});

test('trackpad wheel events in one frame reach Cesium as one combined step', async () => {
  const { bindTrackpadZoom, TRACKPAD_SCROLL_GAIN } =
    await import('gods-eye-view/application/viewer');
  const listeners = [];
  const container = {
    addEventListener: (type, fn, options) =>
      listeners.push({ type, fn, options }),
    removeEventListener: (type, fn) => {
      const index = listeners.findIndex((entry) => entry.fn === fn);
      if (index !== -1) listeners.splice(index, 1);
    },
  };
  const dispatched = [];
  const canvas = { dispatchEvent: (event) => dispatched.push(event) };
  const frames = [];
  let destroyed = false;
  class FakeWheel {
    constructor(type, init) {
      Object.assign(this, { type }, init);
    }
  }
  bindTrackpadZoom({
    container,
    canvas,
    isDestroyed: () => destroyed,
    requestFrame: (fn) => frames.push(fn),
    WheelEventCtor: FakeWheel,
  });
  assert.equal(listeners[0].options.capture, true);
  const wheel = (deltaY, extra = {}) => {
    const event = {
      isTrusted: true,
      target: canvas,
      deltaMode: 0,
      deltaY,
      clientX: 10,
      clientY: 20,
      stopped: false,
      prevented: false,
      stopPropagation() {
        this.stopped = true;
      },
      preventDefault() {
        this.prevented = true;
      },
      ...extra,
    };
    listeners[0].fn(event);
    return event;
  };
  const first = wheel(4);
  wheel(6);
  const mouse = wheel(100);
  assert.equal(first.stopped && first.prevented, true);
  assert.equal(mouse.stopped, false, 'a mouse wheel passes straight through');
  assert.equal(frames.length, 1, 'one combined step per frame');
  frames[0]();
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].deltaY, 10 * TRACKPAD_SCROLL_GAIN);
  assert.equal(
    wheel(4, { isTrusted: false }).stopped,
    false,
    'the combined event is not caught again',
  );
  destroyed = true;
  wheel(4);
  assert.equal(listeners.length, 0, 'a destroyed viewer drops the listener');
});
