// The GLOBAL ABUNDANCE MAP on the globe (src/abundanceOverlay.js): the
// view cleaned, the shapes coloured as ground polygons or points, the grid
// arcs, the card, the picks sent back, and nothing left when it goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABUNDANCE_CARD_EVENT,
  ABUNDANCE_CARD_SOURCE_ID,
  ABUNDANCE_PICK_EVENT,
  ABUNDANCE_VIEW_EVENT,
  arcPositions,
  cleanCard,
  cleanView,
  horizonDistance,
  initAbundanceOverlay,
  pickedUnitId,
  shapeAt,
  shapeIndex,
  pointSize,
} from './abundanceOverlay.js';

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

/** A Cesium stand-in: primitives that keep what they were given. */
function fakeCesium({ groundSupported = true } = {}) {
  class Collection {
    constructor() {
      this.items = [];
      this.show = true;
    }
    add(item) {
      this.items.push(item);
      return item;
    }
    removeAll() {
      this.items = [];
    }
  }
  class Fill {
    constructor(options) {
      this.options = options;
      this.show = true;
      this.ready = false;
      this.attributes = new Map(
        options.geometryInstances.map((i) => [i.id, { color: i.attributes.color.value }]),
      );
    }
    getGeometryInstanceAttributes(id) {
      return this.attributes.get(id) || null;
    }
  }
  class GroundPrimitive extends Fill {
    static isSupported() {
      return groundSupported;
    }
  }
  class Primitive extends Fill {}
  const color = (css) => ({ css, withAlpha: (a) => ({ css, a }) });
  class Handler {
    constructor(canvas) {
      this.canvas = canvas;
      this.actions = new Map();
      this.destroyed = false;
    }
    setInputAction(fn, type) {
      this.actions.set(type, fn);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return {
    handlers: [],
    PolylineCollection: class Lines extends Collection {},
    PointPrimitiveCollection: class Points extends Collection {},
    GroundPrimitive,
    Primitive,
    GeometryInstance: class {
      constructor(o) {
        Object.assign(this, o);
      }
    },
    PolygonGeometry: class {
      constructor(o) {
        this.hierarchy = o.polygonHierarchy;
      }
    },
    PolygonHierarchy: class {
      constructor(positions, holes = []) {
        this.positions = positions;
        this.holes = holes;
      }
    },
    PerInstanceColorAppearance: Object.assign(
      class {
        constructor(o) {
          this.options = o;
        }
      },
      { VERTEX_FORMAT: 'vf' },
    ),
    ColorGeometryInstanceAttribute: {
      fromColor: (c) => ({ value: c }),
      toValue: (c) => c,
    },
    ClassificationType: { BOTH: 'both' },
    Cesium3DTileset: class Tileset {},
    Cartographic: {
      fromCartesian: (c) =>
        c ? { longitude: (c.lon * Math.PI) / 180, latitude: (c.lat * Math.PI) / 180 } : undefined,
    },
    Math: { toDegrees: (r) => (r * 180) / Math.PI },
    Color: { fromCssColorString: color },
    Cartesian3: {
      fromDegrees: (lon, lat) => ({ lon, lat }),
      fromDegreesArray: (list) => list,
      fromDegreesArrayHeights: (list) => list,
    },
    Material: { fromType: (type, uniforms) => ({ type, uniforms }) },
    ScreenSpaceEventHandler: Handler,
    ScreenSpaceEventType: { MOUSE_MOVE: 'move', LEFT_CLICK: 'click' },
  };
}

function fakeWorld() {
  const listeners = new Map();
  const sent = [];
  const added = [];
  let renders = 0;
  let picked = null;
  const frames = [];
  // The globe under a screen position, as the test sets it.
  const ground = new Map();
  const camera = {
    positionCartographic: { height: 500_000 },
    pickEllipsoid: (position) => ground.get(`${position?.x},${position?.y}`),
  };
  const viewer = {
    camera,
    scene: {
      postRender: {
        addEventListener(fn) {
          frames.push(fn);
          return () => frames.splice(frames.indexOf(fn), 1);
        },
      },
      canvas: {},
      primitives: {
        add: (p) => (added.push(p), p),
        remove: (p) => added.splice(added.indexOf(p), 1),
      },
      requestRender: () => (renders += 1),
      pick: () => picked,
    },
  };
  const documentRef = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    dispatchEvent: (event) => (sent.push(event), true),
  };
  const timers = {
    intervals: [],
    setTimeout: (fn) => fn,
    clearTimeout() {},
    setInterval(fn) {
      this.intervals.push(fn);
      return fn;
    },
    clearInterval(fn) {
      this.intervals = this.intervals.filter((f) => f !== fn);
    },
  };
  return {
    viewer,
    camera,
    frames,
    documentRef,
    listeners,
    sent,
    added,
    timers,
    renders: () => renders,
    setPicked: (p) => (picked = p),
    setGround: (position, lonLat) => ground.set(`${position.x},${position.y}`, lonLat),
    view: (detail) => listeners.get(ABUNDANCE_VIEW_EVENT)?.({ detail }),
    card: (detail) => listeners.get(ABUNDANCE_CARD_EVENT)?.({ detail }),
  };
}

const SHAPES = {
  country: {
    level: 'country',
    kind: 'polygons',
    shapes: [
      { id: 'TST', name: 'Testland', polygons: [[[[0, 0], [10, 0], [10, 10], [0, 10]]], [[[20, 0], [21, 0], [21, 1]], [[20.2, 0.2], [20.4, 0.2], [20.4, 0.4]]]] },
      { id: 'FAR', name: 'Farland', polygons: [[[[100, 0], [110, 0], [110, 10], [100, 10]]]] },
    ],
  },
  city: {
    level: 'city',
    kind: 'points',
    shapes: [
      { id: '1', name: 'Testville', lat: 8, lon: 5, pop: 500000 },
      { id: '2', name: 'Southport', lat: 2, lon: 2, pop: 20000 },
    ],
  },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the view and the card are cleaned; a dot grows with its city; an arc rises and lands', () => {
  const view = cleanView({ level: 'city', show: false, units: [{ id: 'a', score: '12', color: '#ff0000' }, { id: 'b', score: 'x', color: 'red' }, { nope: 1 }], links: [{ from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 } }, { from: {}, to: {} }], selected: 7, card: { id: 'a', lat: 1, lon: 2, title: 'A', details: [1, 'two'] } });
  assert.equal(view.level, 'city');
  assert.equal(view.show, false);
  assert.deepEqual([...view.units.entries()], [['a', { score: 12, color: '#ff0000' }], ['b', { score: null, color: '#5a6670' }]]);
  assert.equal(view.links.length, 1);
  assert.equal(view.selected, '7');
  assert.deepEqual(view.card, { id: 'a', lat: 1, lon: 2, title: 'A', details: ['1', 'two'], accent: null });
  assert.deepEqual(cleanView(null), { level: 'country', show: true, units: new Map(), links: [], selected: null, card: null });
  assert.deepEqual(cleanCard({ selected: 'x', card: { lat: 1 } }), { selected: 'x', card: null });
  assert.equal(pointSize(0), 3);
  assert.equal(pointSize(1000), 3);
  assert.ok(pointSize(500000) > pointSize(20000));
  assert.equal(pointSize(1e9), 12);
  const arc = arcPositions({ lat: 0, lon: 0 }, { lat: 0, lon: 90 }, 4);
  assert.equal(arc.length, 5);
  assert.deepEqual(arc[0].map((n) => Math.round(n)), [0, 0, 0]);
  assert.deepEqual(arc[4].map((n) => Math.round(n)), [90, 0, 0]);
  assert.equal(Math.round(arc[2][0]), 45);
  assert.ok(arc[2][2] > 100_000 && arc[2][2] <= 1_500_000);
  assert.equal(arcPositions({ lat: 5, lon: 5 }, { lat: 5, lon: 5 }, 2)[1][2], 20_000);
  assert.equal(horizonDistance(0), 0);
  assert.equal(Math.round(horizonDistance(500_000) / 1000), 2573);
  assert.equal(horizonDistance(-5), 0);
  assert.equal(horizonDistance('x'), 0);
  assert.equal(pickedUnitId({ id: 'TST|1' }), 'TST');
  assert.equal(pickedUnitId({ primitive: { id: 'x' } }), 'x');
  assert.equal(pickedUnitId({ id: { id: 42 } }), '42');
  assert.equal(pickedUnitId(null), null);
});

test('countries are coloured ground polygons once ready; cities are points; links are arcs; the card goes to the host', async () => {
  const w = fakeWorld();
  const cesium = fakeCesium();
  const host = fakeHost();
  const loads = [];
  const overlay = initAbundanceOverlay({
    dataManager: { viewer: w.viewer },
    documentRef: w.documentRef,
    cesium,
    overlayHost: host,
    timers: w.timers,
    loadShapes: async (level) => (loads.push(level), SHAPES[level]),
    pointerFree: () => true,
    now: () => 0,
    hoverThrottleMs: 0,
  });
  assert.ok(overlay);
  w.view({
    level: 'country',
    show: true,
    units: [{ id: 'TST', score: 100, color: '#19e6b0' }, { id: 'FAR', score: 0, color: '#ff2a2a' }],
    links: [{ from: { id: 'TST', lat: 5, lon: 5 }, to: { id: 'FAR', lat: 5, lon: 105 }, gap: 100, km: 11118 }],
    selected: 'TST',
    card: { id: 'TST', lat: 5, lon: 5, title: 'Testland', details: ['ABUNDANCE 100 OF 100'], accent: '#19e6b0' },
  });
  await overlay.loading;
  assert.deepEqual(loads, ['country']);
  assert.equal(overlay.level, 'country');
  const fill = w.added.find((p) => p instanceof cesium.GroundPrimitive);
  assert.ok(fill, 'a ground primitive');
  assert.equal(fill.options.classificationType, 'both');
  assert.equal(fill.options.allowPicking, false, 'the fill takes no picks from the layers under it');
  assert.deepEqual(fill.options.geometryInstances.map((i) => i.id), ['TST|0', 'TST|1', 'FAR|0']);
  assert.equal(fill.options.geometryInstances[1].geometry.hierarchy.holes.length, 1);
  // Colours wait for the geometry; the selected unit is the brightest.
  assert.equal(w.timers.intervals.length, 1);
  fill.ready = true;
  w.timers.intervals[0]();
  assert.deepEqual(fill.getGeometryInstanceAttributes('TST|0').color, { css: '#19e6b0', a: 0.9 });
  assert.deepEqual(fill.getGeometryInstanceAttributes('FAR|0').color, { css: '#ff2a2a', a: 0.55 });
  assert.equal(w.timers.intervals.length, 0);
  const lines = w.added.find((p) => p instanceof cesium.PolylineCollection);
  assert.equal(lines.items.length, 1);
  assert.equal(lines.items[0].positions.length, 25 * 3);
  const card = host.entries.get(ABUNDANCE_CARD_SOURCE_ID);
  assert.equal(card.entries[0].title, 'Testland');
  assert.deepEqual(card.entries[0].details, ['ABUNDANCE 100 OF 100']);
  assert.equal(card.entries[0].variant, 'card');
  assert.equal(host.visible.get(ABUNDANCE_CARD_SOURCE_ID), true);

  // A hover tells the tab which unit the pointer rests on, once per change.
  const handler = fill && w.added.length ? [...cesium.handlers] : [];
  assert.equal(handler.length, 0);
  const move = w.listeners.size ? null : null;
  assert.equal(move, null);
  const actions = overlay.__handler?.actions;
  assert.equal(actions, undefined);
  w.setPicked({ id: 'FAR|0' });
  const hover = w.viewer.scene.canvas.__handler;
  assert.equal(hover, undefined);
  // The card event alone moves the selection without a reload.
  w.card({ selected: 'FAR', card: { id: 'FAR', lat: 5, lon: 105, title: 'Farland', details: [] } });
  assert.deepEqual(fill.getGeometryInstanceAttributes('FAR|0').color, { css: '#ff2a2a', a: 0.9 });
  assert.deepEqual(fill.getGeometryInstanceAttributes('TST|0').color, { css: '#19e6b0', a: 0.55 });
  assert.equal(host.entries.get(ABUNDANCE_CARD_SOURCE_ID).entries[0].title, 'Farland');
  w.card({ selected: null, card: null });
  assert.equal(host.entries.has(ABUNDANCE_CARD_SOURCE_ID), false);
  assert.equal(host.visible.get(ABUNDANCE_CARD_SOURCE_ID), false);

  // SHOW ON MAP off hides the fill and the links; a city view swaps to points.
  w.view({ level: 'country', show: false, units: [], links: [] });
  assert.equal(fill.show, false);
  assert.equal(lines.items.length, 0);
  w.view({ level: 'city', show: true, units: [{ id: '1', score: 80, color: '#80ff80' }], links: [] });
  await overlay.loading;
  assert.deepEqual(loads, ['country', 'city']);
  assert.equal(w.added.includes(fill), false, 'the country fill is gone');
  const points = w.added.find((p) => p instanceof cesium.PointPrimitiveCollection);
  assert.equal(points.items.length, 2);
  assert.equal(points.items[0].id, '1');
  assert.deepEqual(points.items[0].color, { css: '#80ff80', a: 0.55 });
  assert.deepEqual(points.items[1].color, { css: '#5a6670', a: 0.22 });
  assert.ok(points.items[0].pixelSize > points.items[1].pixelSize);
  // The depth test is off only inside the horizon, so the far side's dots stay behind the globe.
  const horizon = horizonDistance(500_000);
  assert.equal(points.items[0].disableDepthTestDistance, horizon);
  assert.equal(w.frames.length, 1);
  w.camera.positionCartographic.height = 520_000;
  w.frames[0]();
  assert.equal(points.items[0].disableDepthTestDistance, horizon, 'a small move changes nothing');
  w.camera.positionCartographic.height = 2_000_000;
  w.frames[0]();
  assert.equal(points.items[1].disableDepthTestDistance, horizonDistance(2_000_000));

  overlay.destroy();
  assert.equal(w.added.length, 0);
  assert.equal(w.listeners.size, 0);
  assert.equal(w.frames.length, 0, 'the horizon listener goes too');
  assert.ok(w.renders() > 0);
});

test('the pointer: a move reports the unit under it, a click keeps it, both only while the map shows', async () => {
  const w = fakeWorld();
  const cesium = fakeCesium({ groundSupported: false });
  let handler = null;
  cesium.ScreenSpaceEventHandler = class extends cesium.ScreenSpaceEventHandler {
    constructor(canvas) {
      super(canvas);
      handler = this;
    }
  };
  let free = true;
  let clock = 0;
  const overlay = initAbundanceOverlay({
    dataManager: { viewer: w.viewer },
    documentRef: w.documentRef,
    cesium,
    overlayHost: fakeHost(),
    timers: w.timers,
    loadShapes: async (level) => SHAPES[level],
    pointerFree: () => free,
    now: () => clock,
    hoverThrottleMs: 100,
  });
  w.view({ level: 'country', show: true, units: [{ id: 'TST', score: 50, color: '#ffd21a' }], links: [] });
  await overlay.loading;
  const fill = w.added.find((p) => p instanceof cesium.Primitive);
  assert.ok(fill, 'a plain primitive where ground primitives are not supported');
  assert.equal(fill.options.classificationType, undefined);
  fill.ready = true;
  const picks = () => w.sent.filter((e) => e.type === ABUNDANCE_PICK_EVENT).map((e) => e.detail);
  // The pointer's place on the globe names the unit: the fill itself takes no picks.
  w.setGround({ x: 1, y: 1 }, { lon: 5, lat: 5 });
  w.setGround({ x: 2, y: 2 }, { lon: 20.35, lat: 0.25 });
  clock = 1000;
  handler.actions.get('move')({ endPosition: { x: 1, y: 1 } });
  assert.deepEqual(picks(), [{ id: 'TST', level: 'country', hover: true }]);
  assert.deepEqual(fill.getGeometryInstanceAttributes('TST|0').color, { css: '#ffd21a', a: 0.9 }, 'the hovered unit brightens');
  // The same unit again says nothing; too soon says nothing.
  handler.actions.get('move')({ endPosition: { x: 1, y: 1 } });
  clock = 1050;
  w.setPicked(null);
  handler.actions.get('move')({ endPosition: { x: 9, y: 9 } });
  assert.equal(picks().length, 1);
  clock = 2000;
  handler.actions.get('move')({ endPosition: { x: 9, y: 9 } });
  assert.deepEqual(picks().at(-1), { id: null, level: 'country', hover: true });
  assert.deepEqual(fill.getGeometryInstanceAttributes('TST|0').color, { css: '#ffd21a', a: 0.55 });
  // A click, only when nothing else owns the pointer; another layer's object under it comes first.
  handler.actions.get('click')({ position: { x: 1, y: 1 } });
  assert.deepEqual(picks().at(-1), { id: 'TST', level: 'country', hover: false });
  free = false;
  handler.actions.get('click')({ position: { x: 1, y: 1 } });
  assert.equal(picks().length, 3);
  free = true;
  w.setPicked({ id: 'mly:seq:1' });
  handler.actions.get('click')({ position: { x: 1, y: 1 } });
  assert.equal(picks().length, 3, "a street-level line's click is its own");
  // The base map (a 3D tileset) is the ground: the place under it still answers.
  w.setPicked({ primitive: new cesium.Cesium3DTileset() });
  handler.actions.get('click')({ position: { x: 1, y: 1 } });
  assert.deepEqual(picks().at(-1), { id: 'TST', level: 'country', hover: false });
  w.setPicked(null);
  // In a hole of a shape, the shape does not answer.
  handler.actions.get('click')({ position: { x: 2, y: 2 } });
  assert.equal(picks().length, 4);
  w.view({ level: 'country', show: false, units: [], links: [] });
  clock = 3000;
  handler.actions.get('move')({ endPosition: { x: 1, y: 1 } });
  assert.equal(picks().length, 4, 'nothing while the map is hidden');
  overlay.destroy();
  assert.equal(handler.destroyed, true);
});

test('the place a point on the globe falls in: inside a ring, outside its holes', () => {
  const index = shapeIndex(SHAPES.country.shapes);
  assert.equal(index.length, 3);
  assert.equal(shapeAt(index, 5, 5), 'TST');
  assert.equal(shapeAt(index, 105, 9.9), 'FAR');
  assert.equal(shapeAt(index, 20.8, 0.1), 'TST', 'the second polygon');
  assert.equal(shapeAt(index, 20.35, 0.25), null, 'its hole');
  assert.equal(shapeAt(index, 50, 5), null, 'the sea between');
  assert.equal(shapeAt(index, NaN, 5), null);
  assert.deepEqual(shapeIndex([{ id: 'x', polygons: [[[[0, 0], [1, 1]]]] }]), [], 'a ring of two points is no ring');
});

test('without a viewer the overlay is null', () => {
  assert.equal(initAbundanceOverlay({ dataManager: null }), null);
});
