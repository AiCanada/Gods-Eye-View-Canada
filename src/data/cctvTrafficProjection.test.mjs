import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  CCTV_TRAFFIC_MAX_POINTS,
  CCTV_TRAFFIC_MAX_RANGE_M,
  _setCctvTrafficCollectionForTest,
  monitorPlaneFrame,
  projectOntoMonitorPlane,
  setCctvTrafficPlane,
  updateProjectedTraffic,
} from './cctvTrafficProjection.js';

// A camera at the origin looking down +X, picture 100 m away, 40 m x 22.5 m.
// Plane axes as cctv.js builds them: +X viewer-right, +Y frame-up, +Z toward the mount.
function spec() {
  const right = new Cesium.Cartesian3(0, -1, 0);
  const up = new Cesium.Cartesian3(0, 0, 1);
  const towardMount = new Cesium.Cartesian3(-1, 0, 0);
  const rotation = new Cesium.Matrix3(
    right.x, up.x, towardMount.x,
    right.y, up.y, towardMount.y,
    right.z, up.z, towardMount.z,
  );
  return {
    mount: new Cesium.Cartesian3(0, 0, 0),
    center: new Cesium.Cartesian3(100, 0, 0),
    orientation: Cesium.Quaternion.fromRotationMatrix(rotation),
    halfW: 20,
    halfH: 11.25,
  };
}
const hit = () => ({ position: new Cesium.Cartesian3(), scale: 1 });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('a vehicle the camera can see lands on the picture where the camera would show it', () => {
  const frame = monitorPlaneFrame(spec());
  // 50 m out, 5 m to the left (+Y here), 4 m below the lens: doubles on a plane twice as far.
  const out = projectOntoMonitorPlane(frame, new Cesium.Cartesian3(50, 5, -4), hit());
  assert.ok(out);
  assert.ok(near(out.position.y, 10) && near(out.position.z, -8));
  assert.ok(out.position.x < 100 && out.position.x > 99, 'stands just in front of the picture, toward the mount');
  assert.equal(out.scale, 2, 'nearer than the picture reads larger');
  const mid = projectOntoMonitorPlane(frame, new Cesium.Cartesian3(80, 4, -4), hit());
  assert.ok(mid && near(mid.position.y, 5) && near(mid.position.z, -5));
  assert.equal(mid.scale, 1.25);
  assert.ok(near(mid.u, -0.25) && near(mid.v, -5 / 11.25), 'normalised picture coordinates');
});

test('vehicles outside the field of view, behind the lens, or out of range are not drawn', () => {
  const frame = monitorPlaneFrame(spec());
  assert.equal(projectOntoMonitorPlane(frame, new Cesium.Cartesian3(50, 30, 0), hit()), null, 'wide of the frame');
  assert.equal(projectOntoMonitorPlane(frame, new Cesium.Cartesian3(50, 0, -20), hit()), null, 'below the frame');
  assert.equal(projectOntoMonitorPlane(frame, new Cesium.Cartesian3(-50, 0, 0), hit()), null, 'behind the camera');
  assert.equal(projectOntoMonitorPlane(frame, new Cesium.Cartesian3(160, 0, 0), hit()), null, 'past the coverage the camera claims');
  assert.equal(projectOntoMonitorPlane(frame, new Cesium.Cartesian3(110, 0, -2), hit()), null, 'beyond the picture itself: a stray');
  assert.equal(projectOntoMonitorPlane(frame, new Cesium.Cartesian3(50, 9.8, 0), hit()), null, 'on the frame edge');
  assert.equal(projectOntoMonitorPlane(frame, new Cesium.Cartesian3(50, 0, 4), hit()), null, 'in the sky band of a road camera');
  assert.ok(frame.maxRange <= CCTV_TRAFFIC_MAX_RANGE_M);
  assert.equal(monitorPlaneFrame({ ...spec(), halfW: 0 }), null);
  assert.equal(monitorPlaneFrame({ ...spec(), center: new Cesium.Cartesian3(-100, 0, 0) }), null, 'a picture behind the mount is unusable');
});

function stubCollection() {
  const markers = [];
  return { markers, show: false, add(options) { const m = { ...options, show: false }; markers.push(m); return m; } };
}

test('open pictures get pooled markers; closing the picture hides them all', () => {
  const collection = stubCollection();
  setCctvTrafficPlane({}, 'cam-1', spec()); // stub viewer: frame registered, no scene needed
  _setCctvTrafficCollectionForTest(collection);
  const red = Cesium.Color.RED;
  const dots = [
    { position: new Cesium.Cartesian3(50, 5, -4), color: red, pixelSize: 6, show: true },
    { position: new Cesium.Cartesian3(50, 30, 0), color: red, pixelSize: 6, show: true }, // out of frame
    { position: new Cesium.Cartesian3(60, 0, -3), color: red, pixelSize: 6, show: false }, // hidden by the traffic LOD
  ];
  const forEach = (visit) => dots.forEach(visit);
  assert.equal(updateProjectedTraffic(forEach), 1);
  assert.equal(collection.show, true);
  assert.equal(collection.markers[0].color, red);
  assert.equal(collection.markers[0].pixelSize, 12, 'sized by apparent distance');
  assert.equal(collection.markers[0].disableDepthTestDistance, Number.POSITIVE_INFINITY);

  // Fewer vehicles next frame: the spare marker is hidden, not destroyed.
  dots[0].show = false;
  assert.equal(updateProjectedTraffic(forEach), 0);
  assert.equal(collection.markers[0].show, false);
  assert.equal(collection.show, false);

  const crowd = Array.from({ length: CCTV_TRAFFIC_MAX_POINTS + 50 }, () => dots[0]);
  dots[0].show = true;
  assert.equal(updateProjectedTraffic((visit) => crowd.forEach(visit)), CCTV_TRAFFIC_MAX_POINTS, 'bounded');

  setCctvTrafficPlane({}, 'cam-1', null);
  assert.ok(collection.markers.every((m) => m.show === false));
  assert.equal(updateProjectedTraffic(forEach), 0, 'no open picture, nothing drawn');
});
