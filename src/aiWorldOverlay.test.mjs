import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_WORLD_MARKETS_SOURCE_ID,
  cleanChoice,
  initAiWorldOverlay,
  marketCards,
  marketLabel,
  MARKET_MOVE_COLORS,
  pointStyle,
} from './aiWorldOverlay.js';

/** The world-overlay host stand-in: what each source last published. */
function fakeHost() {
  const host = {
    entries: new Map(),
    visible: new Map(),
    setEntries: (id, entries, options) =>
      host.entries.set(id, { entries, options }),
    setVisible: (id, on) => host.visible.set(id, on),
    clearSource: (id) => host.entries.delete(id),
  };
  return host;
}

/** A Cesium stand-in: collections that keep what they were given. */
function fakeCesium() {
  class Collection {
    constructor() {
      this.items = [];
    }
    add(item) {
      this.items.push(item);
      return item;
    }
    removeAll() {
      this.items = [];
    }
  }
  const color = (css) => ({ css, withAlpha: (a) => ({ css, a }) });
  return {
    PointPrimitiveCollection: class extends Collection {},
    PolylineCollection: class extends Collection {},
    Color: { fromCssColorString: color },
    Cartesian3: {
      fromDegrees: (lon, lat) => ({ lon, lat }),
      fromDegreesArray: (list) => list,
    },
    Material: { fromType: (type, uniforms) => ({ type, uniforms }) },
  };
}

function fakeWorld() {
  const listeners = new Map();
  const added = [];
  let renders = 0;
  const viewer = {
    scene: {
      primitives: {
        add: (p) => (added.push(p), p),
        remove: (p) => added.splice(added.indexOf(p), 1),
      },
      requestRender: () => (renders += 1),
    },
  };
  const documentRef = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const timers = {
    pending: [],
    setTimeout(fn) {
      this.pending.push(fn);
      return fn;
    },
    clearTimeout(fn) {
      this.pending = this.pending.filter((f) => f !== fn);
    },
    setInterval: () => 1,
    clearInterval() {},
  };
  return {
    viewer,
    documentRef,
    listeners,
    added,
    timers,
    renders: () => renders,
  };
}

test('the choice is cleaned; a place’s size and strength follow its value', () => {
  assert.deepEqual(
    cleanChoice({
      domains: ['weather', 'military', 'weather'],
      horizonHours: 500,
    }),
    {
      domains: ['weather'],
      horizonHours: 168,
    },
  );
  assert.deepEqual(cleanChoice(null), { domains: [], horizonHours: 24 });
  assert.equal(pointStyle(0, 10).pixelSize, 4);
  assert.equal(pointStyle(10, 10).pixelSize, 14);
  assert.equal(pointStyle(-10, 10).pixelSize, 14);
  assert.equal(pointStyle(-10, 10).negative, true);
  assert.ok(pointStyle(10, 10).alpha > pointStyle(1, 10).alpha);
});

test('the overlay draws each chosen domain, nothing while it learns, and leaves no trace when it goes', async () => {
  const w = fakeWorld();
  const asked = [];
  const answers = {
    weather: {
      domain: 'weather',
      points: [
        { lat: 1, lon: 2, value: 5 },
        { lat: 3, lon: 4, value: 10 },
        { lat: 5, lon: 6, value: -10 },
        { lat: 7, lon: 8, value: null },
      ],
      tracks: [],
    },
    tracks: {
      domain: 'tracks',
      points: [],
      tracks: [
        {
          id: 'a1',
          path: [
            [1, 2, 0],
            [1.5, 2.5, 1],
          ],
        },
      ],
    },
    outbreak: {
      domain: 'outbreak',
      learning: { daysRecorded: 0, needed: 7 },
      points: [{ lat: 9, lon: 9, value: 1 }],
    },
  };
  const overlay = initAiWorldOverlay({
    dataManager: { viewer: w.viewer },
    documentRef: w.documentRef,
    cesium: fakeCesium(),
    timers: w.timers,
    fetchImpl: async (url) => {
      asked.push(url);
      const domain = new URL(url, 'http://x').searchParams.get('domain');
      return { ok: true, json: async () => answers[domain] };
    },
  });
  assert.equal(w.added.length, 2, 'its own two collections');
  w.listeners.get('ai-world:predictions')({
    detail: { domains: ['weather', 'tracks', 'outbreak'], horizonHours: 12 },
  });
  await w.timers.pending.shift()();
  assert.ok(asked.every((u) => u.includes('horizon=12')));
  const [points, lines] = w.added;
  assert.equal(
    points.items.length,
    3,
    'the finite weather places; a blank and the learning outbreak draw nothing',
  );
  const down = points.items.find(
    (item) => item.pixelSize === 14 && item.color.a < 0.8,
  );
  assert.ok(down, 'a fall is drawn dimmer at the same magnitude');
  assert.equal(lines.items.length, 1, 'one ghost track');
  assert.ok(w.renders() >= 1);
  overlay.destroy();
  assert.equal(w.added.length, 0);
  assert.equal(w.listeners.size, 0);
});

test('price moves are drawn where each benchmark is set: a dot and a card per hub, green up, red down, biggest move first', async () => {
  const w = fakeWorld();
  const host = fakeHost();
  const overlay = initAiWorldOverlay({
    dataManager: { viewer: w.viewer },
    documentRef: w.documentRef,
    cesium: fakeCesium(),
    timers: w.timers,
    overlayHost: host,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        domain: 'markets',
        points: [
          {
            series: 'sp500',
            label: 'S&P 500',
            hub: 'New York',
            lat: 40.7,
            lon: -74,
            value: 0.4,
          },
          {
            series: 'us10y',
            label: 'US 10-year yield',
            hub: 'New York',
            lat: 40.7,
            lon: -74,
            value: -1.25,
          },
          {
            series: 'tsx',
            label: 'S&P/TSX Composite',
            hub: 'Toronto',
            lat: 43.65,
            lon: -79.38,
            value: 0,
          },
          {
            series: 'gold',
            label: 'Gold',
            hub: 'London',
            lat: 51.5,
            lon: -0.09,
            value: null,
          },
        ],
        assets: [],
      }),
    }),
  });
  w.listeners.get('ai-world:predictions')({ detail: { domains: ['markets'] } });
  await w.timers.pending.shift()();
  const [points] = w.added;
  assert.equal(
    points.items.length,
    2,
    'one dot per hub; a blank price draws none',
  );
  const published = host.entries.get(AI_WORLD_MARKETS_SOURCE_ID);
  assert.equal(host.visible.get(AI_WORLD_MARKETS_SOURCE_ID), true);
  const [ny, toronto] = published.entries;
  assert.equal(ny.title, 'New York');
  assert.deepEqual(ny.details, ['US 10-year yield ▼ 1.25%', 'S&P 500 ▲ 0.40%']);
  assert.equal(
    ny.accent,
    MARKET_MOVE_COLORS.down,
    'the biggest move sets the colour',
  );
  assert.ok(ny.priority > toronto.priority);
  assert.equal(toronto.accent, MARKET_MOVE_COLORS.flat);
  assert.equal(ny.dot, undefined, 'only overlay fields are published');
  // Nothing to draw any more: the cards go too.
  w.listeners.get('ai-world:predictions')({ detail: { domains: [] } });
  await w.timers.pending.shift()();
  assert.equal(host.entries.has(AI_WORLD_MARKETS_SOURCE_ID), false);
  assert.equal(host.visible.get(AI_WORLD_MARKETS_SOURCE_ID), false);
  overlay.destroy();
  assert.equal(marketLabel({ series: 'x', value: '' }), '');
  assert.deepEqual(
    marketCards([{ lat: 1, lon: 2, value: 'x' }], () => ({})),
    [],
  );
});

test('no viewer, no overlay', () => {
  assert.equal(initAiWorldOverlay({ dataManager: {}, documentRef: {} }), null);
});

test('the default timers are callable the way a browser allows (no "Illegal invocation")', () => {
  // A browser's timer functions refuse any `this` but the window (or none).
  const names = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
  const real = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
  const calls = [];
  for (const name of names)
    globalThis[name] = function strict(...args) {
      if (this !== undefined && this !== globalThis)
        throw new TypeError('Illegal invocation');
      calls.push(name);
      return name.startsWith('set') ? 1 : undefined;
    };
  try {
    const w = fakeWorld();
    const overlay = initAiWorldOverlay({
      dataManager: { viewer: w.viewer },
      documentRef: w.documentRef,
      cesium: fakeCesium(),
      fetchImpl: async () => ({ ok: false }),
    });
    w.listeners.get('ai-world:predictions')({
      detail: { domains: ['weather'], horizonHours: 6 },
    });
    overlay.destroy();
    assert.deepEqual(calls.sort(), [
      'clearInterval',
      'clearTimeout',
      'clearTimeout',
      'setInterval',
      'setTimeout',
    ]);
  } finally {
    Object.assign(globalThis, real);
  }
});
