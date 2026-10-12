import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOutbreakLayer,
  forecastColor,
  isAirNetwork,
  networkLitColor,
  networkStyle,
} from './outbreak.js';
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

test('one yellow ring at a time: only the newest location’s boat reach, an outline with nothing inside', () => {
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
  const circle = (mode, color, from, lat, lon) => ({
    mode,
    color,
    lat,
    lon,
    radiusKm: 300,
    from,
  });
  const model = (rings) =>
    new CustomEvent(OUTBREAK_MODEL_EVENT, {
      detail: {
        spread: { rings, routes: [], origins: [], destinations: [] },
      },
    });
  const ids = () => source.entities.values.map((e) => e.id.split('#')[0]);
  windowRef.dispatchEvent(
    model([
      circle('road', '#2f7bff', 'Irkutsk', 52.3, 104.3),
      circle('boat', '#ffd21a', 'Irkutsk', 52.3, 104.3),
      circle('boat', '#ffd21a', 'Shelekhov', 52.2, 104.1),
    ]),
  );
  assert.deepEqual(
    ids()
      .filter((id) => id.includes('|boat|'))
      .sort(),
    ['outbreak-ring|boat|Shelekhov|52.200,104.100'],
    'one boat ring, the newest location’s; no inner rings, no fill',
  );
  assert.deepEqual(
    ids()
      .filter((id) => id.includes('|road|'))
      .sort(),
    [
      'outbreak-fill|road|Irkutsk|52.300,104.300',
      'outbreak-ring|road|Irkutsk|52.300,104.300',
      'outbreak-ring|road|Irkutsk|52.300,104.300|0',
      'outbreak-ring|road|Irkutsk|52.300,104.300|1',
    ],
    'other ways of travel keep their inner rings and fill',
  );
  // The newest location goes: the other one's boat ring takes its place.
  windowRef.dispatchEvent(
    model([circle('boat', '#ffd21a', 'Irkutsk', 52.3, 104.3)]),
  );
  assert.deepEqual(
    ids().filter((id) => id.includes('|boat|')),
    ['outbreak-ring|boat|Irkutsk|52.300,104.300'],
  );
  layer.destroy(viewer);
});

test('future spread places: the dot says its window in days past 48 h, and each window has its own colour', () => {
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
  const place = (within, name) => ({ within, name, lat: 52, lon: 104 });
  windowRef.dispatchEvent(
    new CustomEvent(OUTBREAK_MODEL_EVENT, {
      detail: {
        spread: {
          rings: [],
          routes: [],
          origins: [],
          destinations: [],
          forecast: [
            place(24, 'Ulan-Ude'),
            place(48, 'Chita'),
            place(168, 'Novosibirsk'),
            place(720, 'Moscow'),
          ],
        },
      },
    }),
  );
  const names = source.entities.values
    .filter((e) => e.id.startsWith('outbreak-forecast|'))
    .map((e) => e.name)
    .sort();
  assert.deepEqual(names, [
    'FUTURE SPREAD · WITHIN 24 H · Ulan-Ude',
    'FUTURE SPREAD · WITHIN 30 D · Moscow',
    'FUTURE SPREAD · WITHIN 48 H · Chita',
    'FUTURE SPREAD · WITHIN 7 D · Novosibirsk',
  ]);
  layer.destroy(viewer);
});

test('forecastColor: one colour a window, none of them the boat yellow', () => {
  const colors = [24, 48, 72, 168, 336, 720].map(forecastColor);
  assert.deepEqual(colors, [
    '#ff4fd8',
    '#b388ff',
    '#8c9eff',
    '#5c9dff',
    '#40c4ff',
    '#64ffda',
  ]);
  assert.equal(new Set(colors).size, 6);
  assert.equal(colors.includes('#ffd21a'), false);
  assert.equal(forecastColor(undefined), '#ff4fd8', 'unknown counts as 24 h');
  assert.equal(
    forecastColor(100),
    '#5c9dff',
    '100 h falls in the 7 day window',
  );
  assert.equal(
    forecastColor(504),
    '#64ffda',
    '21 days falls in the 30 day window',
  );
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

test('the roads after landing light up green by the hour shown', () => {
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

test('the rail after landing lights up orange by the hour shown, on top of the roads', () => {
  const windowRef = fakeWindow();
  const layer = createOutbreakLayer({ windowRef });
  const viewer = {
    dataSources: { add() {}, remove() {} },
    scene: { requestRender() {} },
  };
  layer.attachDataManager({ setEnabled: async () => true });
  layer.init(viewer);
  layer.enable();
  const rails = {
    bandsBy: 'hour',
    bands: {
      10: [[2.55, 49.01, 2.55, 49.9]],
      11: [[2.55, 49.9, 2.55, 50.8]],
      18: [[2.55, 50.8, 2.55, 51.7]],
    },
    unreached: [],
  };
  const roads = { bandsBy: 'hour', bands: { 10: [[2.5, 49, 3, 49]] } };
  const send = (hour, { airRoads = true, airRails = true } = {}) =>
    windowRef.dispatchEvent(
      new CustomEvent(OUTBREAK_MODEL_EVENT, {
        detail: {
          spread: {
            hour,
            airRoads,
            airRails,
            rings: [],
            reaches: [],
            routes: [],
            origins: [],
            destinations: [],
          },
          networks: [
            { key: 'air', locationId: '', mode: 'air', network: roads },
            {
              key: 'air-rail',
              locationId: '',
              mode: 'air-rail',
              network: rails,
            },
          ],
        },
      }),
    );
  const rail = () => layer.networkState().find((n) => n.key === 'air-rail');
  send(9);
  assert.deepEqual(rail(), {
    key: 'air-rail',
    shown: true,
    bands: 3,
    red: 0,
  });
  // Red bands: those whose hour band starts by the hour shown.
  send(11.5);
  assert.equal(rail().red, 2);
  send(18);
  assert.equal(rail().red, 3);
  // Known only for the roads: the rail stays off, the roads stay on.
  send(18, { airRails: false });
  assert.equal(rail().shown, false);
  assert.equal(layer.networkState().find((n) => n.key === 'air').shown, true);
  layer.destroy(viewer);
  // The rail orange, as round an outbreak location; the roads unchanged.
  assert.equal(networkLitColor('air-rail'), '#ff8c1a');
  assert.equal(networkLitColor('air-rail'), networkLitColor('rail'));
  assert.equal(networkLitColor('air'), '#95de97');
  assert.equal(networkLitColor('road'), '#a3121b');
  assert.equal(isAirNetwork('air-rail'), true);
  assert.equal(isAirNetwork('rail'), false);
  // Rail above the roads, a pixel wider, in its own collection drawn last.
  const road = networkStyle('road');
  for (const mode of ['rail', 'air-rail']) {
    const style = networkStyle(mode);
    assert.equal(style.collection, 'rail');
    assert.equal(style.heightM, road.heightM + 30);
    assert.equal(style.widthPx, road.widthPx + 1);
  }
  assert.deepEqual(networkStyle('air'), road);
  assert.equal(road.widthPx, 2.5);
  assert.equal(road.collection, 'road');
});

test('the rail collection is added to the scene after the roads, and both go on destroy', () => {
  const added = [];
  const removed = [];
  const layer = createOutbreakLayer({ windowRef: fakeWindow() });
  const viewer = {
    dataSources: { add() {}, remove() {} },
    scene: {
      requestRender() {},
      primitives: {
        add: (p) => added.push(p),
        remove: (p) => removed.push(p),
      },
    },
  };
  layer.init(viewer);
  // The world rail (owner ruling 2026-10-12) between the roads and the
  // reached rail, so the lit rail stays on top.
  assert.equal(added.length, 3, 'roads, the world rail, then rail');
  layer.destroy(viewer);
  assert.deepEqual(removed, added);
});

test('a landing airport’s red dot grows a little with each doubling of infected flights landed', async () => {
  const { landingDotPx } = await import('./outbreak.js');
  assert.deepEqual(
    [1, 2, 4, 8, 16, 100, 10000].map(landingDotPx),
    [7, 9, 11, 13, 15, 16, 16],
  );
});

/* The EPIDEMIC MODEL's newer per-place fields (pRestricted, pImportedFirst,
 * byDay, overflowP50, localOffsetHours) are optional: a layer fixture with
 * none of them draws exactly as before; one with them draws the visuals. */
function epidemicLayer() {
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
  const send = (places, hour) =>
    windowRef.dispatchEvent(
      new CustomEvent(OUTBREAK_MODEL_EVENT, {
        detail: {
          spread: {
            atMs: startMs + hour * 3_600_000,
            rings: [],
            routes: [],
            origins: [],
            destinations: [],
          },
          epidemic: { startMs, places, commutes: [] },
        },
      }),
    );
  const dots = () =>
    source.entities.values.filter((e) => e.id.startsWith('outbreak-epidemic|'));
  const dot = () => {
    assert.equal(dots().length, 1);
    const entity = dots()[0];
    return {
      name: entity.name,
      size: entity.point.pixelSize.getValue(),
      alpha: entity.point.color.getValue().alpha,
      outline: entity.point.outlineColor.getValue().toCssHexString(),
    };
  };
  return { layer, viewer, send, dot, dots };
}

/** Arrives at hour 10 in every run that reaches it (90 % of runs). */
function sheremetyevo(extra = {}) {
  return {
    id: 'UUEE',
    code: 'UUEE',
    name: 'Sheremetyevo',
    lat: 55.97,
    lon: 37.41,
    pArrive: 0.9,
    arrivalHours: Array.from({ length: 21 }, (_, i) => (i < 19 ? 10 : null)),
    casesP50: 400,
    ...extra,
  };
}

test('the epidemic model: a place likely under restrictions wears a purple ring; without the field, black', () => {
  const { layer, viewer, send, dot } = epidemicLayer();
  send([sheremetyevo()], 12);
  assert.equal(dot().outline, '#000000', 'no field: as before');
  send([sheremetyevo({ pRestricted: 0.8 })], 12);
  assert.equal(dot().outline, '#9b5cff', 'the commuting purple, solid');
  send([sheremetyevo({ pRestricted: 0.49 })], 12);
  assert.equal(dot().outline, '#000000', 'under half the runs: no ring');
  send([sheremetyevo({ pRestricted: 0.5 })], 12);
  assert.equal(dot().outline, '#9b5cff', 'half the runs counts');
  // Still ahead: the faint ringed dot keeps its own teal ring.
  send([sheremetyevo({ pRestricted: 0.8 })], 5);
  assert.equal(dot().outline, '#19e6b0e6', 'teal at 0.9, as before');
  assert.equal(dot().size, 5);
  layer.destroy(viewer);
});

test('the epidemic model: a place whose first case most likely flew in says so; without the field, not', () => {
  const { layer, viewer, send, dot } = epidemicLayer();
  send([sheremetyevo()], 12);
  assert.match(dot().name, /UUEE Sheremetyevo · 90 % by now/);
  assert.doesNotMatch(dot().name, /first case imported/);
  assert.match(dot().name, /% in the window$/, 'as before: nothing appended');
  send([sheremetyevo({ pImportedFirst: 0.9 })], 12);
  assert.match(
    dot().name,
    /^EPIDEMIC MODEL · UUEE Sheremetyevo · 90 % by now · 90 % in the window · first case imported$/,
  );
  send([sheremetyevo({ pImportedFirst: 0.9 })], 5);
  assert.match(
    dot().name,
    /· ahead · 90 % in the window · first case imported$/,
    'ahead too: the share is of the runs that reach it',
  );
  send([sheremetyevo({ pImportedFirst: 0.4 })], 12);
  assert.doesNotMatch(dot().name, /first case imported/);
  layer.destroy(viewer);
});

test('the epidemic model: with a by-day table the dot is as strong as the chance of any case that day; without it, the chance of arrival', () => {
  const { layer, viewer, send, dot } = epidemicLayer();
  // Without byDay: max(0.35, share) as before (share 0.9 at hour 12).
  send([sheremetyevo()], 12);
  assert.equal(dot().alpha, 0.9);
  const byDay = [
    [0.2, 0.1, 3],
    [0.6, 0.3, 40],
    [0.95, 0.8, 400],
  ];
  const place = sheremetyevo({ byDay });
  send([place], 12); // day 0: pAny 0.2 is under the floor
  assert.equal(dot().alpha, 0.35);
  assert.match(dot().name, /90 % by now/, 'the share still names the chance');
  send([place], 30); // day 1
  assert.equal(dot().alpha, 0.6);
  send([place], 47.5); // still day 1
  assert.equal(dot().alpha, 0.6);
  send([place], 48); // day 2
  assert.equal(dot().alpha, 0.95);
  send([place], 24 * 9); // past the table: its last day
  assert.equal(dot().alpha, 0.95);
  // A short table under the floor never hides the dot; an empty one is ignored.
  send([sheremetyevo({ byDay: [] })], 12);
  assert.equal(dot().alpha, 0.9);
  send([sheremetyevo({ byDay: [[0, 0, 0]] })], 12);
  assert.equal(dot().alpha, 0.35);
  // The share still decides whether the place shows at all.
  send([sheremetyevo({ byDay, arrivalHours: Array(21).fill(null) })], 30);
  assert.equal(dot().alpha, 0.12, 'ahead: faint, whatever the table says');
  layer.destroy(viewer);
});

test('the epidemic model: the other new fields ride along without changing the dot', () => {
  const { layer, viewer, send, dot } = epidemicLayer();
  send([sheremetyevo()], 12);
  const before = dot();
  send(
    [
      sheremetyevo({
        overflowP50: 30,
        localOffsetHours: 3,
        pRestricted: 0,
        pImportedFirst: 0,
        byDay: undefined,
      }),
    ],
    12,
  );
  assert.deepEqual(dot(), before);
  layer.destroy(viewer);
});

test('epidemicDotAlpha, epidemicRestricted and epidemicImportedFirst on their own', async () => {
  const { epidemicDotAlpha, epidemicRestricted, epidemicImportedFirst } =
    await import('./outbreak.js');
  assert.equal(epidemicDotAlpha({}, 12, 0.9), 0.9);
  assert.equal(epidemicDotAlpha({}, 12, 0.1), 0.35);
  assert.equal(epidemicDotAlpha(undefined, 12, 0.5), 0.5);
  assert.equal(epidemicDotAlpha({ byDay: [[0.7, 0.2, 9]] }, 0, 0.1), 0.7);
  assert.equal(epidemicDotAlpha({ byDay: [[0.7, 0.2, 9]] }, 500, 0.1), 0.7);
  assert.equal(
    epidemicDotAlpha({ byDay: [[0.7]] }, -5, 0.1),
    0.7,
    'before the start: day 0',
  );
  assert.equal(
    epidemicDotAlpha(
      {
        byDay: [
          [0.2, 0.1, 1],
          [1, 1, 1],
        ],
      },
      25,
      0.1,
    ),
    1,
  );
  assert.equal(
    epidemicDotAlpha({ byDay: [[null]] }, 0, 0.8),
    0.8,
    'no number: the share',
  );
  assert.equal(epidemicDotAlpha({ byDay: 'no' }, 0, 0.8), 0.8);
  assert.equal(epidemicDotAlpha({ byDay: [[1.5]] }, 0, 0.8), 1, 'never over 1');
  assert.deepEqual(
    [
      undefined,
      {},
      { pRestricted: 0.3 },
      { pRestricted: 0.5 },
      { pRestricted: 1 },
    ].map(epidemicRestricted),
    [false, false, false, true, true],
  );
  assert.deepEqual(
    [undefined, {}, { pImportedFirst: 0.49 }, { pImportedFirst: 0.9 }].map(
      epidemicImportedFirst,
    ),
    [false, false, false, true],
  );
});

/* EPIDEMIC MODEL: where beds ran short in most runs (overflowP50, optional),
 * a hollow blue ring round the place once the hour shown has passed it. */
function bedsHalos(viewerSource) {
  return viewerSource().filter((e) => e.id.startsWith('outbreak-beds|'));
}

test('the epidemic model: a hollow blue ring where beds ran short in most runs, from that hour', () => {
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
  const send = (places, hour) =>
    windowRef.dispatchEvent(
      new CustomEvent(OUTBREAK_MODEL_EVENT, {
        detail: {
          spread: {
            atMs: startMs + hour * 3_600_000,
            rings: [],
            routes: [],
            origins: [],
            destinations: [],
          },
          epidemic: { startMs, places, commutes: [] },
        },
      }),
    );
  const all = () => source.entities.values;
  const epidemicDot = () => {
    const found = all().filter((e) =>
      e.id.startsWith('outbreak-epidemic|UUEE#'),
    );
    assert.equal(found.length, 1);
    const entity = found[0];
    return {
      name: entity.name,
      size: entity.point.pixelSize.getValue(),
      color: entity.point.color.getValue().toCssHexString(),
      outline: entity.point.outlineColor.getValue().toCssHexString(),
      outlineWidth: entity.point.outlineWidth.getValue(),
    };
  };
  // L2-1: without the field, no ring; the dot as it is today.
  send([sheremetyevo()], 60);
  assert.equal(bedsHalos(all).length, 0);
  const plain = epidemicDot();
  send([sheremetyevo({ overflowP50: 48 })], 60);
  const halos = bedsHalos(all);
  assert.equal(halos.length, 1);
  const halo = halos[0];
  assert.match(halo.id, /^outbreak-beds\|UUEE#/);
  assert.equal(halo.point.pixelSize.getValue(), 20);
  assert.equal(halo.point.color.getValue().alpha, 0, 'hollow');
  const outline = halo.point.outlineColor.getValue();
  assert.equal(outline.toCssHexString(), '#4a9bff');
  assert.equal(outline.alpha, 1);
  assert.equal(halo.point.outlineWidth.getValue(), 2);
  assert.equal(
    halo.name,
    'EPIDEMIC MODEL · UUEE Sheremetyevo · beds short from day 3 in most runs',
  );
  assert.deepEqual(epidemicDot(), plain, 'the dot itself is unchanged');
  // Before beds ran short: no ring.
  send([sheremetyevo({ overflowP50: 48 })], 30);
  assert.equal(bedsHalos(all).length, 0);
  // L2-2: an origin, where beds run short first, gets it too.
  send(
    [
      sheremetyevo({
        origin: true,
        pArrive: 1,
        arrivalHours: Array(21).fill(0),
        overflowP50: 0,
      }),
    ],
    1,
  );
  assert.equal(bedsHalos(all).length, 1);
  assert.match(bedsHalos(all)[0].id, /^outbreak-beds\|UUEE#/);
  assert.match(bedsHalos(all)[0].name, /· beds short from day 1 in most runs$/);
  assert.equal(
    all().filter((e) => e.id.startsWith('outbreak-epidemic|')).length,
    0,
    'an origin still has no epidemic dot',
  );
  layer.destroy(viewer);
});

test('epidemicBedsShort on its own', async () => {
  const { epidemicBedsShort, BEDS_SHORT_COLOR, BEDS_SHORT_PX } =
    await import('./outbreak.js');
  assert.equal(BEDS_SHORT_COLOR, '#4a9bff');
  assert.equal(BEDS_SHORT_PX, 20);
  assert.equal(epidemicBedsShort({ overflowP50: 10 }, 10), true);
  assert.equal(epidemicBedsShort({ overflowP50: 10 }, 9), false);
  assert.equal(epidemicBedsShort({ overflowP50: null }, 99), false);
  assert.equal(epidemicBedsShort({}, 99), false);
  assert.equal(epidemicBedsShort(null, 1), false);
  assert.equal(epidemicBedsShort({ overflowP50: Infinity }, 99), false);
  assert.equal(epidemicBedsShort({ overflowP50: '10' }, 99), false);
});

test('every rail line on the globe: the world rail layer asks for the tiles in view, six at a time, once each', async () => {
  const { railWorldZoom, railWorldTilesInView, RAIL_WORLD_ALPHA } =
    await import('./outbreak.js');
  assert.equal(RAIL_WORLD_ALPHA, 0.35);
  assert.deepEqual(
    [20e6, 4e6, 1.5e6, 6e5, 1e5].map(railWorldZoom),
    [2, 3, 4, 5, 6],
  );
  assert.equal(railWorldTilesInView(null, 2).length, 16, 'the whole world');
  // Over the antimeridian: both sides, nothing between.
  const across = railWorldTilesInView(
    { west: 170, south: 50, east: -170, north: 60 },
    3,
  );
  assert.deepEqual([...new Set(across.map((t) => t.x))].sort(), [0, 7]);
  const windowRef = fakeWindow();
  const asked = [];
  let open = 0;
  let most = 0;
  const release = [];
  const fetchImpl = (url) => {
    asked.push(url);
    open += 1;
    most = Math.max(most, open);
    return new Promise((resolve) => {
      release.push(() => {
        open -= 1;
        resolve({
          ok: true,
          json: async () => ({ lines: [[0, 0, 1, 1]] }),
        });
      });
    });
  };
  const layer = createOutbreakLayer({ windowRef, fetchImpl });
  const viewer = {
    dataSources: { add() {}, remove() {} },
    camera: {
      positionCartographic: { height: 20e6 },
      computeViewRectangle: () => undefined,
    },
    scene: { requestRender() {} },
  };
  layer.attachDataManager({ setEnabled: async () => true });
  layer.init(viewer);
  layer.enable();
  const send = (railWorld) =>
    windowRef.dispatchEvent(
      new CustomEvent(OUTBREAK_MODEL_EVENT, {
        detail: {
          spread: {
            hour: 1,
            rings: [],
            reaches: [],
            routes: [],
            origins: [],
            destinations: [],
          },
          networks: [],
          railWorld,
        },
      }),
    );
  // Not built yet: nothing asked.
  send(null);
  assert.equal(asked.length, 0);
  send({ builtAt: 1 });
  assert.equal(layer.railWorldState().zoom, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(asked.length, 6, 'six at once');
  while (release.length) {
    release.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(asked.length, 16, 'the 16 world tiles at zoom 2');
  assert.equal(new Set(asked).size, 16, 'each once');
  assert.ok(most <= 6);
  assert.ok(
    asked.every((u) => u.startsWith('/api/outbreak/rail-world/tile/2/')),
  );
  assert.equal(layer.railWorldState().tiles, 16);
  // The same build again asks for nothing more.
  send({ builtAt: 1 });
  assert.equal(asked.length, 16);
  layer.destroy(viewer);
});
