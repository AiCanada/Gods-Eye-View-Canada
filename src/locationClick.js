/**
 * @module locationClick
 * @description A click on the map selects that place. A click on a contact,
 * camera, station or any other picked object belongs to that object's layer and
 * is ignored here, and so are drags and long presses.
 */
import * as Cesium from 'cesium';
import {
  bindTrackingClickGesture,
  isTrackingClickGesture,
} from './data/trackingClickGesture.js';
import { isPickedWorldPosition } from './data/scenePick.js';

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
 * @param {Cesium.Viewer} viewer
 * @param {{x:number, y:number}} position Canvas pixel.
 * @returns {?{lat:number, lon:number}}
 */
export function groundPointAt(viewer, position) {
  const scene = viewer?.scene;
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
      viewer.camera.pickEllipsoid(
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
 * @param {Cesium.Viewer} viewer
 * @returns {?{lat:number, lon:number}}
 */
export function viewCenterPoint(viewer) {
  const canvas = viewer?.scene?.canvas;
  const centre =
    canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0
      ? groundPointAt(
          viewer,
          new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
        )
      : null;
  if (centre) return centre;
  const carto = viewer?.camera?.positionCartographic;
  if (!carto) return null;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}

/**
 * Report clean clicks on the map, away from any layer's objects, as place
 * selections.
 * @param {Cesium.Viewer} viewer
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
  const handler = createHandler(viewer.scene.canvas);
  bindTrackingClickGesture(handler, (click, gesture) => {
    if (!click?.position || !isTrackingClickGesture(gesture) || !isEnabled())
      return;
    if (isOverlayHit(click.position.x, click.position.y)) return;
    let picked;
    try {
      picked = viewer.scene.pick(click.position);
    } catch {
      picked = undefined;
    }
    if (pickedLayerObject(picked)) return;
    const point = groundPointAt(viewer, click.position);
    if (point) onSelect(point);
  });
  return () => {
    if (!handler.isDestroyed?.()) handler.destroy?.();
  };
}
