/**
 * @module locationClick
 * @description A click on the map selects that place. A click on a contact,
 * camera, station or any other picked object belongs to that object's layer and
 * is ignored here, and so are drags and long presses.
 */
import * as Cesium from 'cesium';
import { isTrackingClickGesture } from './data/trackingClickGesture.js';
import { isPointerFree } from './data/inputOwnership.js';
import { isPickedWorldPosition } from './data/scenePick.js';
import { viewerBehind } from './render/cesium/viewers.js';
import { findQuery } from './render/rendererOf.js';

/**
 * Measure each press's travel and duration ahead of a scene click on this
 * module's own handler. Upstream moved this accounting into the input
 * dispatcher (src/input/dispatcher.js) and dropped the shared helper; map
 * location clicks still bind their own handler (see the exception list in
 * src/data/inputOwnership.test.mjs), so the accounting lives here.
 * Travel is summed segment by segment, so an orbit nudge that returns to its
 * starting pixel cannot pass as a zero-distance click.
 * @param {Cesium.ScreenSpaceEventHandler|Object} handler
 * @param {(click: Object, gesture: {travelPx: number, durationMs: number}) => void} onClick
 * @param {{now?: () => number, eventTypes?: Object}} [options]
 */
function bindClickGesture(handler, onClick, options = {}) {
  const now = options.now || (() => performance.now());
  const eventTypes = options.eventTypes || Cesium.ScreenSpaceEventType;
  let pressActive = false;
  let pressStartedAt = 0;
  let previousPosition = null;
  let travelPx = 0;
  let completedGesture = null;

  const appendTravel = (position) => {
    if (
      !pressActive ||
      !Number.isFinite(position?.x) ||
      !Number.isFinite(position?.y)
    )
      return;
    if (previousPosition) {
      travelPx += Math.hypot(
        position.x - previousPosition.x,
        position.y - previousPosition.y,
      );
    }
    previousPosition = { x: position.x, y: position.y };
  };

  const finishPress = (position) => {
    if (!pressActive) return;
    appendTravel(position);
    completedGesture = {
      travelPx,
      durationMs: Math.max(0, now() - pressStartedAt),
    };
    pressActive = false;
    previousPosition = null;
  };

  handler.setInputAction((event) => {
    pressActive = true;
    pressStartedAt = now();
    previousPosition = null;
    travelPx = 0;
    completedGesture = null;
    appendTravel(event?.position);
  }, eventTypes.LEFT_DOWN);

  handler.setInputAction((event) => {
    appendTravel(event?.endPosition ?? event?.position);
  }, eventTypes.MOUSE_MOVE);

  handler.setInputAction((event) => {
    finishPress(event?.position);
  }, eventTypes.LEFT_UP);

  handler.setInputAction((click) => {
    if (pressActive) finishPress(click?.position);
    const gesture = completedGesture || { travelPx: 0, durationMs: 0 };
    completedGesture = null;
    // A tool owns the pointer: a draw vertex is a vertex, not a place pick.
    if (!isPointerFree()) return;
    onClick(click, gesture);
  }, eventTypes.LEFT_CLICK);
}

/**
 * Whether a scene pick hit an object a layer owns rather than the map itself.
 * Entities, billboards and points carry an `id`; photoreal tiles and globe
 * imagery do not.
 * @param {unknown} picked Result of `scene.pick`.
 * @returns {boolean}
 */
export function pickedLayerObject(picked) {
  return (
    picked !== undefined &&
    picked !== null &&
    picked.id !== undefined &&
    picked.id !== null
  );
}

/**
 * Whether a raw scene pick is a draw-set item that takes no picks, with only
 * the map under it. The renderer's draw port gives every item a pick id, the
 * unpickable ones too (a density glow, a route's stop dots), so Cesium's own
 * pick reports them; the query port looks under such an item and answers
 * with the map, or with the pickable item that is really there.
 * @param {object} host The scene object the layers are handed.
 * @param {unknown} picked Result of `scene.pick`.
 * @param {{x: number, y: number}} position Canvas CSS pixels.
 * @returns {boolean}
 */
export function isUnpickableDrawItem(host, picked, position) {
  const id = picked?.id;
  if (typeof id?.set !== 'string' || typeof id.id !== 'string' || !position)
    return false;
  try {
    return findQuery(host)?.pick(position.x, position.y)?.surface === true;
  } catch {
    return false;
  }
}

function toPoint(cartesian) {
  if (!isPickedWorldPosition(cartesian)) return null;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  if (!carto) return null;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}

/**
 * The ground under a screen position: the rendered surface when the depth
 * buffer has it, else the ellipsoid. Null over empty sky.
 * @param {object} viewer The scene host (or a Cesium viewer).
 * @param {{x:number, y:number}} position Canvas pixel.
 * @returns {?{lat:number, lon:number}}
 */
export function groundPointAt(viewer, position) {
  const cesiumViewer = viewerBehind(viewer);
  const scene = cesiumViewer?.scene;
  if (!scene || !position) return null;
  let point = null;
  if (scene.pickPositionSupported) {
    try {
      point = toPoint(scene.pickPosition(position));
    } catch {
      point = null;
    }
  }
  if (point) return point;
  try {
    return toPoint(
      cesiumViewer.camera.pickEllipsoid(
        position,
        scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
      ),
    );
  } catch {
    return null;
  }
}

/**
 * The place in the middle of the view, or under the camera when the middle of
 * the screen is sky.
 * @param {object} viewer The scene host (or a Cesium viewer).
 * @returns {?{lat:number, lon:number}}
 */
export function viewCenterPoint(viewer) {
  const cesiumViewer = viewerBehind(viewer);
  const canvas = cesiumViewer?.scene?.canvas;
  const centre =
    canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0
      ? groundPointAt(
          cesiumViewer,
          new Cesium.Cartesian2(
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
          ),
        )
      : null;
  if (centre) return centre;
  const carto = cesiumViewer?.camera?.positionCartographic;
  if (!carto) return null;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}

/**
 * Report clean clicks on the map, away from any layer's objects, as place
 * selections.
 * @param {object} viewer The scene host (or a Cesium viewer); the handler
 *   binds on the canvas of the Cesium viewer behind it.
 * @param {(point: {lat:number, lon:number}) => void} onSelect
 * @param {{isEnabled?: () => boolean, isOverlayHit?: (x: number, y: number) => boolean, createHandler?: (canvas: HTMLCanvasElement) => object}} [options]
 *   `isEnabled` is checked on every click, for example to ignore clicks while
 *   the cockpit owns the camera. `isOverlayHit` reports a painted card under
 *   the pointer: cards are drawn on a pointer-transparent overlay, so the scene
 *   pick sees the ground behind them, but the click belongs to the card.
 * @returns {() => void} Unbinds the handler.
 */
export function bindMapLocationClicks(
  viewer,
  onSelect,
  {
    isEnabled = () => true,
    isOverlayHit = () => false,
    createHandler = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
  } = {},
) {
  const cesiumViewer = viewerBehind(viewer);
  // No Cesium scene behind the host (a renderer without one): nothing to bind.
  const canvas = cesiumViewer?.scene?.canvas;
  if (!canvas) return () => {};
  const handler = createHandler(canvas);
  bindClickGesture(handler, (click, gesture) => {
    if (!click?.position || !isTrackingClickGesture(gesture) || !isEnabled())
      return;
    if (isOverlayHit(click.position.x, click.position.y)) return;
    let picked;
    try {
      picked = cesiumViewer.scene.pick(click.position);
    } catch {
      picked = undefined;
    }
    if (
      pickedLayerObject(picked) &&
      !isUnpickableDrawItem(viewer, picked, click.position)
    )
      return;
    const point = groundPointAt(cesiumViewer, click.position);
    if (point) onSelect(point);
  });
  return () => {
    if (!handler.isDestroyed?.()) handler.destroy?.();
  };
}
