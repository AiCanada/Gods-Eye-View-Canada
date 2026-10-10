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

test('the epidemic model: a place shows once it likely has the outbreak by the hour shown', () => {
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
  const startMs = Date.UTC(2026, 9, 1);
  // Arrives at hour 10 in every run that reaches it (90 % of runs).
  const arrivalHours = Array.from({ length: 21 }, (_, i) =>
    i < 19 ? 10 : null,
  );
  const place = {
    id: 'UUEE',
    code: 'UUEE',
    name: 'Sheremetyevo',
    lat: 55.97,
    lon: 37.41,
    pArrive: 0.9,
    arrivalHours,
    casesP50: 400,
  };
  const at = (hour) =>
    new CustomEvent(OUTBREAK_MODEL_EVENT, {
      detail: {
        spread: {
          atMs: startMs + hour * 3_600_000,
          rings: [],
          routes: [],
          origins: [],
          destinations: [],
        },
        epidemic: {
          startMs,
          places: [place],
          commutes: [],
        },
      },
    });
  const shown = () =>
    source.entities.values.filter((e) => e.id.startsWith('outbreak-epidemic|'));
  windowRef.dispatchEvent(at(5));
  assert.equal(shown().length, 1, 'at risk, so on the map');
  assert.match(shown()[0].name, /· ahead · 90 % in the window$/);
  windowRef.dispatchEvent(at(12));
  assert.equal(shown().length, 1);
  assert.match(shown()[0].name, /UUEE Sheremetyevo · 90 % by now/);
  // The model switched off in the box: the dots go.
  windowRef.dispatchEvent(
    new CustomEvent(OUTBREAK_MODEL_EVENT, {
      detail: {
        spread: {
          atMs: startMs + 12 * 3_600_000,
          rings: [],
          routes: [],
          origins: [],
          destinations: [],
        },
        epidemic: null,
      },
    }),
  );
  assert.equal(shown().length, 0);
  layer.destroy(viewer);
});

test('roads and rail lines: drawn faint, turning red band by band as the reach passes them', () => {
  const windowRef = fakeWindow();
  const layer = createOutbreakLayer({ windowRef });
  const viewer = {
    dataSources: { add() {}, remove() {} },
    scene: { requestRender() {} },
  };
  layer.attachDataManager({ setEnabled: async () => true });
  layer.init(viewer);
  layer.enable();
  const network = {
    bandKm: 10,
    bands: {
      0: [[104.3, 52.29, 104.35, 52.29]],
      1: [[104.35, 52.29, 104.45, 52.29]],
      5: [[104.6, 52.29, 104.7, 52.29]],
    },
    unreached: [[110, 50, 110.1, 50]],
  };
  const send = (km, mode = 'road') =>
    windowRef.dispatchEvent(
      new CustomEvent(OUTBREAK_MODEL_EVENT, {
        detail: {
          spread: {
            rings: [],
            routes: [],
            origins: [],
            destinations: [],
            reaches:
              km === null
                ? []
                : [{ mode, network: 'road', locationId: 'irk', km }],
          },
          networks: [
            { key: 'irk|road', locationId: 'irk', mode: 'road', network },
          ],
        },
      }),
    );
  send(5);
  assert.deepEqual(layer.networkState(), [
    { key: 'irk|road', shown: true, bands: 3, red: 1 },
  ]);
  send(15);
  assert.equal(layer.networkState()[0].red, 2);
  send(60);
  assert.equal(layer.networkState()[0].red, 3);
  send(null); // Road unticked: the network goes too.
  assert.equal(layer.networkState()[0].shown, false);
  layer.destroy(viewer);
  assert.deepEqual(layer.networkState(), []);
});

test('a red flight line goes 2 s after it lands; in the air it stays', async () => {
  const windowRef = fakeWindow();
  let clock = 1_000_000;
  const layer = createOutbreakLayer({ windowRef, now: () => clock });
  let source = null;
  const viewer = {
    dataSources: { add: (ds) => (source = ds), remove() {} },
    scene: { requestRender() {} },
  };
  layer.attachDataManager({ setEnabled: async () => true });
  layer.init(viewer);
  layer.enable();
  const route = (landed) => ({
    from: { code: 'UIII', lat: 52.27, lon: 104.39 },
    to: { code: 'UUEE', lat: 55.97, lon: 37.41 },
    hop: 1,
    landed,
    color: '#ff2a2a',
  });
  const send = (landed) =>
    windowRef.dispatchEvent(
      new CustomEvent(OUTBREAK_MODEL_EVENT, {
        detail: {
          spread: {
            rings: [],
            routes: [route(landed)],
            origins: [],
            destinations: [],
          },
        },
      }),
    );
  const lines = () =>
    source.entities.values.filter((e) => e.id.startsWith('outbreak-route|'));
  send(false);
  assert.equal(lines().length, 1, 'in the air');
  clock += 10_000;
  send(false);
  assert.equal(lines().length, 1, 'still in the air');
  send(true);
  assert.equal(lines().length, 1, 'just landed: still shown');
  clock += 2_100;
  await layer.update();
  assert.equal(lines().length, 0, 'gone 2 s after landing');
  send(false); // The hour set back before the landing: back.
  assert.equal(lines().length, 1);
  layer.destroy(viewer);
});

test('the roads after landing light up light red by the hour shown', () => {
  const windowRef = fakeWindow();
  const layer = createOutbreakLayer({ windowRef });
  const viewer = {
    dataSources: { add() {}, remove() {} },
    scene: { requestRender() {} },
  };
  layer.attachDataManager({ setEnabled: async () => true });
  layer.init(viewer);
  layer.enable();
  const network = {
    bandsBy: 'hour',
    bands: {
      7: [[37, 56, 37.5, 56]],
      9: [[37.5, 56, 38, 56]],
      60: [[38, 56, 39, 56]],
    },
    unreached: [],
  };
  const send = (hour, airRoads = true) =>
    windowRef.dispatchEvent(
      new CustomEvent(OUTBREAK_MODEL_EVENT, {
        detail: {
          spread: {
            hour,
            airRoads,
            rings: [],
            reaches: [],
            routes: [],
            origins: [],
            destinations: [],
          },
          networks: [{ key: 'air', locationId: '', mode: 'air', network }],
        },
      }),
    );
  send(5);
  assert.deepEqual(layer.networkState(), [
    { key: 'air', shown: true, bands: 3, red: 0 },
  ]);
  send(8);
  assert.equal(layer.networkState()[0].red, 1);
  send(130);
  assert.equal(layer.networkState()[0].red, 3);
  send(130, false); // Plane unticked: gone.
  assert.equal(layer.networkState()[0].shown, false);
  layer.destroy(viewer);
});

test('a landing airport’s red dot grows a little with each doubling of infected flights landed', async () => {
  const { landingDotPx } = await import('./outbreak.js');
  assert.deepEqual(
    [1, 2, 4, 8, 16, 100, 10000].map(landingDotPx),
    [7, 9, 11, 13, 15, 16, 16],
  );
});
