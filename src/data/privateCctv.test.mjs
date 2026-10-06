import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVATE_CAMERAS_CHANGED_EVENT,
  PRIVATE_CCTV_LAYER_ID,
  createPrivateCctvLayer,
  privateCamerasShown,
} from './privateCctv.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';

function fixture({
  cameras = 1,
  origin = 'programmatic',
  camerasOn = false,
} = {}) {
  const timers = [];
  const dispatched = [];
  const windowRef = {
    setTimeout: (fn) => {
      timers.push(fn);
      return 1;
    },
    setInterval: (fn) => {
      timers.push(fn);
      return 2;
    },
    clearTimeout() {},
    clearInterval() {},
    dispatchEvent: (event) => {
      dispatched.push([event.type, event.detail]);
      return true;
    },
  };
  const calls = [];
  const entry = { visibilityIntentOrigin: origin };
  const dataManager = {
    layers: new Map([[PRIVATE_CCTV_LAYER_ID, entry]]),
    isEnabled: (id) => (id === 'cctv' ? camerasOn : false),
    setEnabled: async (...args) => {
      calls.push(args);
      return true;
    },
  };
  const sources = Array.from({ length: cameras }, (_, i) => ({
    id: `p${i}`,
    sourceKind: 'private',
  }));
  const layer = createPrivateCctvLayer({
    windowRef,
    fetchImpl: async () =>
      new Response(JSON.stringify({ sources }), { status: 200 }),
  });
  return { layer, dataManager, entry, timers, dispatched, calls };
}

test('Private CCTV Cams holds the choice the Cameras layer reads, and says when it changes', () => {
  const { layer, dataManager, dispatched } = fixture();
  assert.equal(
    privateCamerasShown(),
    true,
    'no layer in charge: shown as before',
  );
  layer.attachDataManager(dataManager);
  assert.equal(privateCamerasShown(), false, 'the layer starts off');
  layer.init();
  layer.enable();
  assert.equal(privateCamerasShown(), true);
  layer.disable();
  assert.equal(privateCamerasShown(), false);
  assert.deepEqual(dispatched, [
    [PRIVATE_CAMERAS_CHANGED_EVENT, { shown: false }],
    [PRIVATE_CAMERAS_CHANGED_EVENT, { shown: true }],
    [PRIVATE_CAMERAS_CHANGED_EVENT, { shown: false }],
  ]);
  layer.destroy();
  assert.equal(privateCamerasShown(), true, 'destroy hands the choice back');
});

test('it comes on by itself once this machine has a private camera, unless its owner switched it off', async () => {
  const run = async (options) => {
    const f = fixture(options);
    f.layer.attachDataManager(f.dataManager);
    await f.timers[0]();
    f.layer.destroy();
    return f.calls;
  };
  assert.deepEqual(await run({ cameras: 2 }), [[PRIVATE_CCTV_LAYER_ID, true]]);
  assert.deepEqual(
    await run({ cameras: 0 }),
    [],
    'no private camera: stays off',
  );
  assert.deepEqual(
    await run({ cameras: 2, origin: 'user' }),
    [],
    'switched off by its owner: stays off',
  );
});

test('ticked by its owner with Cameras off, it turns Cameras on; on by itself, it does not', () => {
  const owner = fixture({ origin: 'user' });
  owner.layer.attachDataManager(owner.dataManager);
  owner.layer.enable();
  assert.deepEqual(owner.calls, [['cctv', true, { origin: 'user' }]]);
  owner.layer.destroy();

  const auto = fixture({ origin: 'programmatic' });
  auto.layer.attachDataManager(auto.dataManager);
  auto.layer.enable();
  assert.deepEqual(auto.calls, []);
  auto.layer.destroy();
});

test('Private CCTV Cams has its own share-link token', () => {
  const row = LAYER_STATE_REGISTRY.find(
    (entry) => entry.id === PRIVATE_CCTV_LAYER_ID,
  );
  assert.deepEqual(
    { ...row },
    { id: 'private-cctv', token: '3', disposition: 'enabled-only' },
  );
});
