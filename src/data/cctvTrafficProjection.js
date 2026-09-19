import * as Cesium from 'cesium';
import { forEachTrafficDot } from './traffic.js';

/**
 * Street traffic drawn ON the open CCTV picture.
 *
 * Draw order was never the problem: the monitor plane already skips the depth
 * write and traffic is stacked above it. The problem is geometry. The picture
 * is the far cap of the camera's frustum, lifted clear of terrain, while the
 * vehicles it is looking at sit on the road in front of and below it, so from
 * almost every viewpoint no vehicle lines up with the picture at all.
 *
 * So each vehicle the camera can see is projected through the camera's own
 * mount point onto the picture: the ray mount -> vehicle is intersected with
 * the monitor plane and a marker is placed at the hit. That is exactly where
 * the vehicle would appear in the camera's image, it is correct from any
 * viewer angle, and it works the same for still and video feeds because it
 * never touches the texture.
 */

/** Hard ceiling on how far a projected vehicle may be from the mount. */
export const CCTV_TRAFFIC_MAX_RANGE_M = 1500;
/** Upper bound on markers across all open pictures. */
export const CCTV_TRAFFIC_MAX_POINTS = 1000;
/** Markers stand this far off the picture, toward the mount. */
const PLANE_STANDOFF_M = 0.4;
/** Traffic dots float this far above the road so they clear the mesh; the
 * camera sees the vehicle ON the road, so project from street level. */
const DOT_HEIGHT_ABOVE_ROAD_M = 3;
/** Fraction of the half-frame a vehicle may reach before it counts as off-picture. */
const EDGE_INSET = 0.94;
/** Above this fraction of the half-height is sky for a road camera. */
const SKY_BAND_START = 0.55;
const MIN_PIXEL_SIZE = 3;
const MAX_PIXEL_SIZE = 14;

/**
 * Resolve a monitor plane into the vectors the projection needs.
 * @param {{mount: Cesium.Cartesian3, center: Cesium.Cartesian3, orientation: Cesium.Quaternion, halfW: number, halfH: number}} spec
 *   Plane as cctv.js builds it: local +X viewer-right, +Y frame-up, +Z back toward the mount.
 * @returns {object|null} Frame, or null when the spec is unusable.
 */
export function monitorPlaneFrame(spec) {
  if (!spec?.mount || !spec.center || !spec.orientation) return null;
  if (!(spec.halfW > 0) || !(spec.halfH > 0)) return null;
  const rotation = Cesium.Matrix3.fromQuaternion(spec.orientation, new Cesium.Matrix3());
  const right = Cesium.Matrix3.getColumn(rotation, 0, new Cesium.Cartesian3());
  const up = Cesium.Matrix3.getColumn(rotation, 1, new Cesium.Cartesian3());
  const towardMount = Cesium.Matrix3.getColumn(rotation, 2, new Cesium.Cartesian3());
  const axis = Cesium.Cartesian3.negate(towardMount, new Cesium.Cartesian3());
  const toPlane = Cesium.Cartesian3.subtract(spec.center, spec.mount, new Cesium.Cartesian3());
  const planeDistance = Cesium.Cartesian3.dot(toPlane, axis);
  if (!(planeDistance > 0)) return null;
  return {
    mount: Cesium.Cartesian3.clone(spec.mount),
    center: Cesium.Cartesian3.clone(spec.center),
    right,
    up,
    towardMount,
    axis,
    planeDistance,
    // Only vehicles inside the coverage the camera claims (its frustum range)
    // are drawn. Anything farther is past the picture itself: it collapses onto
    // the horizon line and reads as stray dots on streets the camera cannot see.
    // (The frame corners are farther from the mount than the axis distance,
    // hence the slack; depth along the axis is capped at the picture below.)
    maxRange: Math.min(CCTV_TRAFFIC_MAX_RANGE_M, planeDistance * 1.3),
    // Local up at the mount, scaled to the dot's lift above the road.
    roadDrop: Cesium.Cartesian3.magnitude(spec.mount) > 1
      ? Cesium.Cartesian3.multiplyByScalar(
        Cesium.Cartesian3.normalize(spec.mount, new Cesium.Cartesian3()),
        DOT_HEIGHT_ABOVE_ROAD_M,
        new Cesium.Cartesian3(),
      )
      : null,
    halfW: spec.halfW,
    halfH: spec.halfH,
  };
}

const _toPoint = new Cesium.Cartesian3();
const _local = new Cesium.Cartesian3();

/**
 * Where a world point appears on the monitor plane, seen from the mount.
 * @param {object} frame From monitorPlaneFrame().
 * @param {Cesium.Cartesian3} point World position of the vehicle.
 * @param {{position: Cesium.Cartesian3, scale: number}} result Written on a hit.
 * @returns {object|null} `result`, or null when the camera cannot see the point.
 */
export function projectOntoMonitorPlane(frame, point, result) {
  if (!frame || !point) return null;
  Cesium.Cartesian3.subtract(point, frame.mount, _toPoint);
  if (frame.roadDrop) Cesium.Cartesian3.subtract(_toPoint, frame.roadDrop, _toPoint);
  const range = Cesium.Cartesian3.magnitude(_toPoint);
  if (!(range > 1) || range > frame.maxRange) return null;
  // Depth along the view axis; behind the lens there is nothing to draw.
  const depth = Cesium.Cartesian3.dot(_toPoint, frame.axis);
  if (!(depth > 1) || depth > frame.planeDistance) return null;
  const t = frame.planeDistance / depth;
  Cesium.Cartesian3.multiplyByScalar(_toPoint, t, result.position);
  Cesium.Cartesian3.add(result.position, frame.mount, result.position);
  Cesium.Cartesian3.subtract(result.position, frame.center, _local);
  const localX = Cesium.Cartesian3.dot(_local, frame.right);
  const localY = Cesium.Cartesian3.dot(_local, frame.up);
  // A small inset keeps half-visible vehicles off the frame edge, and nothing
  // on the road can sit in the top band of a downward-looking camera: a hit
  // there is a pose error, not a vehicle.
  if (Math.abs(localX) > frame.halfW * EDGE_INSET || Math.abs(localY) > frame.halfH * EDGE_INSET) return null;
  if (localY > frame.halfH * SKY_BAND_START) return null;
  // Normalised picture coordinates: -1..1, +u viewer-right, +v up.
  result.u = localX / frame.halfW;
  result.v = localY / frame.halfH;
  // In front of the picture, never coplanar with it.
  Cesium.Cartesian3.multiplyByScalar(frame.towardMount, PLANE_STANDOFF_M, _local);
  Cesium.Cartesian3.add(result.position, _local, result.position);
  // A vehicle nearer than the picture looks larger in the camera, a farther
  // one smaller; t is exactly that ratio.
  result.scale = Math.min(2.5, Math.max(0.5, t));
  return result;
}

/** @type {Map<string, object>} Open pictures by camera id. */
const _frames = new Map();
let _viewer = null;
let _collection = null;
/** @type {Array<object>} */
let _pool = [];
let _removeListener = null;
const _hit = { position: new Cesium.Cartesian3(), scale: 1, u: 0, v: 0 };
/** Traffic slot index behind each pooled marker, for its ID tag. */
const _markerTags = [];
let _markersShown = 0;
const _diag = { updates: 0, visited: 0, used: 0 };

function sceneUsable(viewer) {
  const scene = viewer?.scene;
  return Boolean(scene?.primitives?.add && scene.preRender?.addEventListener && !viewer.isDestroyed?.());
}

function ensureCollection() {
  if (_collection && !_collection.isDestroyed?.()) return _collection;
  _pool = [];
  _collection = new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT });
  _viewer.scene.primitives.add(_collection);
  return _collection;
}

/**
 * Re-project the live traffic onto every open picture. Runs once per rendered
 * frame while at least one picture is open; pure vector math, no scene queries.
 * @param {(visit: (point: object) => void) => void} [forEachDot] Test seam.
 * @returns {number} Markers shown.
 */
export function updateProjectedTraffic(forEachDot = forEachTrafficDot) {
  if (!_collection || _collection.isDestroyed?.()) return 0;
  let used = 0;
  let visited = 0;
  if (_frames.size > 0) {
    for (const frame of _frames.values()) {
      forEachDot((point, index) => {
        visited += 1;
        if (used >= CCTV_TRAFFIC_MAX_POINTS || !point || point.show === false) return;
        if (!projectOntoMonitorPlane(frame, point.position, _hit)) return;
        let marker = _pool[used];
        if (!marker) {
          marker = _collection.add({
            outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
            outlineWidth: 1,
            // The picture stands in the open over the street; its markers must
            // never be swallowed by the coarse far-LOD mesh behind it.
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          });
          _pool[used] = marker;
        }
        marker.position = _hit.position;
        if (point.color) marker.color = point.color;
        const size = (Number(point.pixelSize) || 5) * _hit.scale;
        marker.pixelSize = Math.min(MAX_PIXEL_SIZE, Math.max(MIN_PIXEL_SIZE, size));
        marker.show = true;
        _markerTags[used] = index;
        used += 1;
      });
    }
  }
  for (let i = used; i < _pool.length; i += 1) _pool[i].show = false;
  _collection.show = used > 0;
  _markersShown = used;
  _diag.updates += 1;
  _diag.visited = visited;
  _diag.used = used;
  return used;
}

/**
 * Tell the projector that a camera's picture opened, moved, or closed.
 * @param {object} viewer Cesium viewer.
 * @param {string} cameraId
 * @param {object|null} spec Plane spec (see monitorPlaneFrame), or null to close.
 * @returns {void}
 */
export function setCctvTrafficPlane(viewer, cameraId, spec) {
  if (!cameraId) return;
  const frame = spec ? monitorPlaneFrame(spec) : null;
  if (frame) _frames.set(String(cameraId), frame);
  else _frames.delete(String(cameraId));

  if (_frames.size === 0) {
    _removeListener?.();
    _removeListener = null;
    if (_collection && !_collection.isDestroyed?.()) {
      for (const marker of _pool) marker.show = false;
      _collection.show = false;
    }
    return;
  }
  if (!sceneUsable(viewer)) return;
  if (_viewer !== viewer) {
    _removeListener?.();
    _removeListener = null;
    _collection = null;
    _viewer = viewer;
  }
  ensureCollection();
  if (!_removeListener) {
    _removeListener = _viewer.scene.preRender.addEventListener(() => updateProjectedTraffic());
  }
}

/**
 * Visit the markers currently drawn on open pictures, with the traffic slot
 * each one stands for (the overlay paints their ID tags).
 * @param {(position: Cesium.Cartesian3, index: number) => void} visit
 */
export function forEachProjectedMarker(visit) {
  if (_frames.size === 0) return;
  for (let i = 0; i < _markersShown && i < _pool.length; i += 1) {
    if (_pool[i]?.show) visit(_pool[i].position, _markerTags[i]);
  }
}

/** Live counters for QA: open pictures, dots visited and markers drawn last frame. */
export function getCctvTrafficProjectionDiagnostics() {
  return { planes: _frames.size, listening: Boolean(_removeListener), pool: _pool.length, ..._diag };
}

/** Drop every open picture (layer teardown). */
export function clearCctvTrafficPlanes() {
  for (const id of [..._frames.keys()]) setCctvTrafficPlane(_viewer, id, null);
}

/** Test seam: install a stub collection without a WebGL scene. */
export function _setCctvTrafficCollectionForTest(collection) {
  _collection = collection;
  _pool = [];
}
