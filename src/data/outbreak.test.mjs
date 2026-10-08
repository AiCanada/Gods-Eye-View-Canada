import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbreakLayer } from './outbreak.js';
import {
  OUTBREAK_LAYER_ID,
  OUTBREAK_MODEL_EVENT,
  OUTBREAK_REQUEST_EVENT,
} from '../outbreakCore.mjs';
import { LAYER_STATE_REGISTRY } from './layerState.js';

function fakeWindow() {
  const listeners = new Map();
  const dispatched = [];
  return {
    dispatched,
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
    removeEventListener(type, fn) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((item) => item !== fn),
      );
    },
    dispatchEvent(event) {
      dispatched.push(event.type);
      for (const fn of listeners.get(event.type) || []) fn(event);
      return true;
    },
  };
}

test('the layer listens before it is first switched on, so SCAN TRAVEL can switch it on', async () => {
  const windowRef = fakeWindow();
  const calls = [];
  const layer = createOutbreakLayer({ windowRef });
  layer.attachDataManager({
    setEnabled: async (...args) => {
      calls.push(args);
      return true;
    },
  });
  assert.deepEqual(
    windowRef.dispatched,
    [OUTBREAK_REQUEST_EVENT],
    'it asks the box for the model once listening',
  );
  windowRef.dispatchEvent(
    new CustomEvent(OUTBREAK_MODEL_EVENT, {
      detail: {
        show: true,
        spread: { rings: [], routes: [], origins: [], destinations: [] },
      },
    }),
  );
  await Promise.resolve();
  assert.deepEqual(calls, [[OUTBREAK_LAYER_ID, true, { origin: 'user' }]]);
  layer.destroy();
});

test('Outbreak has its own share-link token', () => {
  const row = LAYER_STATE_REGISTRY.find(
    (entry) => entry.id === OUTBREAK_LAYER_ID,
  );
  assert.deepEqual(
    { ...row },
    { id: 'outbreak', token: '4', disposition: 'enabled-only' },
  );
});

test('a new hour reaches the map: changed circles go out and come back under new ids', async () => {
  const windowRef = fakeWindow();
  const layer = createOutbreakLayer({ windowRef });
  let source = null;
  const viewer = {
    dataSources: { add: (ds) => (source = ds), remove() {} },
    scene: { requestRender() {} },
  };
  layer.attachDataManager({ setEnabled: async () => true });
  layer.init(viewer);
  layer.enable();
  const changes = [];
  source.entities.collectionChanged.addEventListener((_, added, removed) =>
    changes.push({
      added: added.map((e) => e.id.split('#')[0]),
      removed: removed.map((e) => e.id.split('#')[0]),
    }),
  );
  const model = (km) =>
    new CustomEvent(OUTBREAK_MODEL_EVENT, {
      detail: {
        spread: {
          rings: km
            ? [
                {
                  mode: 'road',
                  color: '#2f7bff',
                  lat: 52.3,
                  lon: 104.3,
                  radiusKm: km,
                  from: 'Irkutsk',
                },
              ]
            : [],
          routes: [],
          origins: [{ id: 'irkutsk', name: 'Irkutsk', lat: 52.3, lon: 104.3 }],
          destinations: [],
        },
      },
    });
  windowRef.dispatchEvent(model(1000));
  windowRef.dispatchEvent(model(300)); // the hour set back
  const ring = 'outbreak-ring|road|Irkutsk|52.300,104.300';
  assert.ok(changes.at(-1).removed.includes(ring), 'the 1000 km circle went');
  assert.ok(changes.at(-1).added.includes(ring), 'the 300 km circle came');
  assert.equal(
    changes.at(-1).added.includes('outbreak-origin|irkutsk'),
    false,
    'what did not change stays as it was',
  );
  assert.equal(
    source.entities.values.filter((e) => e.id.startsWith(`${ring}#`)).length,
    1,
  );
  windowRef.dispatchEvent(model(1000));
  windowRef.dispatchEvent(model(0)); // no reach: the circle is gone
  assert.equal(
    source.entities.values.some((e) => e.id.startsWith('outbreak-ring|')),
    false,
  );
  layer.destroy(viewer);
});

test('a dot over the horizon is hidden, whatever the distance; a dot in view shows', async () => {
  const Cesium = await import('cesium');
  const windowRef = fakeWindow();
  const layer = createOutbreakLayer({ windowRef });
  let source = null;
  const preRender = new Cesium.Event();
  // A low camera over Saint John: the horizon is a few dozen km away.
  const camera = {
    positionWC: Cesium.Cartesian3.fromDegrees(-66.06, 45.27, 2000),
  };
  const viewer = {
    dataSources: { add: (ds) => (source = ds), remove() {} },
    scene: { requestRender() {}, preRender },
    camera,
  };
  layer.attachDataManager({ setEnabled: async () => true });
  layer.init(viewer);
  layer.enable();
  windowRef.dispatchEvent(
    new CustomEvent(OUTBREAK_MODEL_EVENT, {
      detail: {
        spread: {
          rings: [],
          routes: [],
          origins: [
            { id: 'here', name: 'Saint John', lat: 45.27, lon: -66.06 },
            { id: 'near', name: 'Moncton', lat: 46.09, lon: -64.77 },
            { id: 'over', name: 'Quebec City', lat: 46.81, lon: -71.21 },
            { id: 'far', name: 'Irkutsk', lat: 52.29, lon: 104.3 },
          ],
          destinations: [],
        },
      },
    }),
  );
  const shown = (id) =>
    source.entities.values.find((e) =>
      e.id.startsWith(`outbreak-origin|${id}#`),
    ).show;
  assert.equal(shown('here'), true);
  assert.equal(shown('far'), false, 'the far side of the globe');
  // From 2 km up the horizon is about 160 km off.
  assert.equal(shown('near'), true, '130 km off: still in view');
  assert.equal(shown('over'), false, '430 km off: over the horizon');
  // Fly over Irkutsk: the next frame swaps them.
  camera.positionWC = Cesium.Cartesian3.fromDegrees(104.3, 52.29, 2_000_000);
  preRender.raiseEvent();
  assert.equal(shown('far'), true);
  assert.equal(shown('here'), false);
  layer.destroy(viewer);
  assert.equal(preRender.numberOfListeners, 0, 'destroy stops the check');
});
