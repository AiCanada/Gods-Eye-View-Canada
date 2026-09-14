import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  bindMapLocationClicks,
  groundPointAt,
  pickedLayerObject,
  viewCenterPoint,
} from './locationClick.js';

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
