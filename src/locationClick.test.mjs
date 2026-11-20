import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  bindMapLocationClicks,
  groundPointAt,
  isUnpickableDrawItem,
  pickedLayerObject,
  viewCenterPoint,
} from './locationClick.js';
import { bindRenderer } from './render/rendererOf.js';

const TORONTO = Cesium.Cartesian3.fromDegrees(-79.38, 43.65, 80);

function fakeViewer({ pickPosition = TORONTO, ellipsoid, picked } = {}) {
  return {
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      pickPositionSupported: true,
      pickPosition: () => pickPosition,
      pick: () => picked,
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    camera: {
      pickEllipsoid: () => ellipsoid,
      positionCartographic: Cesium.Cartographic.fromDegrees(-75.69, 45.42, 5000),
    },
  };
}

function fakeHandler() {
  return {
    actions: new Map(),
    destroyed: false,
    setInputAction(fn, type) { this.actions.set(type, fn); },
    isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; },
  };
}

const near = (value, expected) => Math.abs(value - expected) < 1e-6;

test('only picked objects with an id belong to a layer; map tiles do not', () => {
  assert.equal(pickedLayerObject(undefined), false);
  assert.equal(pickedLayerObject(null), false);
  assert.equal(pickedLayerObject({ primitive: {}, content: {} }), false, 'a photoreal tile feature');
  assert.equal(pickedLayerObject({ id: 'flight-abc' }), true);
  assert.equal(pickedLayerObject({ id: {}, primitive: {} }), true);
});

test('the ground under a click comes from the rendered surface, then the ellipsoid', () => {
  const surface = groundPointAt(fakeViewer(), { x: 1, y: 1 });
  assert.ok(near(surface.lat, 43.65) && near(surface.lon, -79.38));
  const fallback = groundPointAt(
    fakeViewer({ pickPosition: new Cesium.Cartesian3(1, 2, 3), ellipsoid: TORONTO }),
    { x: 1, y: 1 },
  );
  assert.ok(near(fallback.lat, 43.65), 'a degenerate depth pick falls back to the ellipsoid');
  assert.equal(groundPointAt(fakeViewer({ pickPosition: null }), { x: 1, y: 1 }), null, 'sky');
  const centre = viewCenterPoint(fakeViewer({ pickPosition: null }));
  assert.ok(near(centre.lat, 45.42) && near(centre.lon, -75.69), 'sky mid-view falls back to the camera subpoint');
});

test('a clean click on the map selects that place; drags, layer objects and disabled clicks do not', () => {
  const handler = fakeHandler();
  const viewer = fakeViewer();
  const selected = [];
  let enabled = true;
  let overlayHit = false;
  const unbind = bindMapLocationClicks(viewer, (point) => selected.push(point), {
    createHandler: () => handler,
    isEnabled: () => enabled,
    isOverlayHit: () => overlayHit,
  });
  const T = Cesium.ScreenSpaceEventType;
  const click = (from, to = from) => {
    handler.actions.get(T.LEFT_DOWN)({ position: from });
    handler.actions.get(T.LEFT_UP)({ position: to });
    handler.actions.get(T.LEFT_CLICK)({ position: to });
  };

  click({ x: 10, y: 10 });
  assert.equal(selected.length, 1);
  assert.ok(near(selected[0].lat, 43.65));
  click({ x: 10, y: 10 }, { x: 60, y: 10 });
  assert.equal(selected.length, 1, 'a drag is not a selection');
  viewer.scene.pick = () => ({ id: 'vessel-1' });
  click({ x: 10, y: 10 });
  assert.equal(selected.length, 1, 'a click on a contact belongs to its layer');
  viewer.scene.pick = () => undefined;
  enabled = false;
  click({ x: 10, y: 10 });
  assert.equal(selected.length, 1, 'ignored while disabled');
  enabled = true;
  overlayHit = true;
  click({ x: 10, y: 10 });
  assert.equal(selected.length, 1, 'a click on a painted card belongs to the card, not the map behind it');
  overlayHit = false;
  click({ x: 10, y: 10 });
  assert.equal(selected.length, 2);

  unbind();
  assert.equal(handler.destroyed, true);
});

// The renderer's draw port gives unpickable items (a density glow, a route's
// stop dots) a pick id too, so Cesium's own pick reports them; the query port
// looks under such an item.
test('a click on an unpickable draw-set item over the map still selects the place', () => {
  const handler = fakeHandler();
  const viewer = fakeViewer();
  let answer = { set: '', id: '', surface: true };
  const picks = [];
  const unbindRenderer = bindRenderer(viewer, {
    query: { pick: (x, y) => { picks.push([x, y]); return answer; } },
  });
  const selected = [];
  const unbind = bindMapLocationClicks(viewer, (point) => selected.push(point), {
    createHandler: () => handler,
  });
  const T = Cesium.ScreenSpaceEventType;
  const click = (at) => {
    handler.actions.get(T.LEFT_DOWN)({ position: at });
    handler.actions.get(T.LEFT_UP)({ position: at });
    handler.actions.get(T.LEFT_CLICK)({ position: at });
  };
  const glow = { id: { set: 'wildlife-sightings:density', id: 'cell-1' }, primitive: {} };

  assert.equal(isUnpickableDrawItem(viewer, glow, { x: 4, y: 5 }), true);
  assert.equal(isUnpickableDrawItem(viewer, { id: 'vessel-1' }, { x: 4, y: 5 }), false, 'not a draw-set item');
  assert.equal(isUnpickableDrawItem(viewer, undefined, { x: 4, y: 5 }), false);

  viewer.scene.pick = () => glow;
  click({ x: 10, y: 12 });
  assert.equal(selected.length, 1, 'the glow takes no picks: the map under it is selected');
  assert.deepEqual(picks.at(-1), [10, 12]);

  // A pickable item under the unpickable one is that layer's.
  answer = { set: 'rail:stops', id: 'stop-9', surface: false };
  click({ x: 10, y: 12 });
  assert.equal(selected.length, 1);
  // Nothing at all there (the sky): left to the layer, as before.
  answer = null;
  click({ x: 10, y: 12 });
  assert.equal(selected.length, 1);

  unbind();
  unbindRenderer();
});
