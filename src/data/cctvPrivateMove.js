/**
 * Move a private (home or business) camera by dragging its icon on the map.
 *
 * Press on a private camera's icon and drag: the icon follows the pointer over
 * the globe, and on release the camera is pinned to that spot (saved to the
 * private store on this machine). A press that does not move is an ordinary
 * click and selects the camera. Public cameras are never draggable.
 *
 * Listeners sit in the capture phase on the globe canvas's container so a press
 * on a private icon is claimed before Cesium's own handlers: the globe does not
 * pan while an icon is being moved. A press that another capture listener has
 * already claimed (the card size badge) is left alone.
 */

/** A press that moves less than this is a click, not a move. */
const MOVE_TRAVEL_PX = 5;

/** True for the ids the private camera routes publish. */
export function isPrivateCameraId(id) {
  return typeof id === 'string' && id.startsWith('private-');
}

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas The globe canvas.
 * @param {(x: number, y: number) => string|null} options.pickCameraId Camera id under a canvas point.
 * @param {(x: number, y: number) => ({lat: number, lon: number}|null)} options.globePoint Globe position under a canvas point.
 * @param {() => boolean} [options.isEnabled]
 * @param {(id: string, point: {lat: number, lon: number}) => void} options.onPreview Move the icon while dragging.
 * @param {(id: string, point: {lat: number, lon: number}) => void} options.onCommit Pin and save on release.
 * @param {(id: string) => void} options.onSelect A plain click on the icon.
 * @param {() => void} [options.onPressStart]
 * @param {() => void} [options.onPressEnd]
 * @returns {() => void} Removes every listener.
 */
export function bindPrivateCameraMove({
  canvas,
  pickCameraId,
  globePoint,
  isEnabled = () => true,
  onPreview,
  onCommit,
  onSelect,
  onPressStart,
  onPressEnd,
} = {}) {
  const container = canvas?.parentElement;
  if (!canvas || !container || typeof pickCameraId !== 'function' || typeof globePoint !== 'function') return () => {};
  let press = null;

  const local = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const onDown = (event) => {
    if (press || event.button !== 0 || event.defaultPrevented || !isEnabled()) return;
    const { x, y } = local(event);
    const id = pickCameraId(x, y);
    if (!isPrivateCameraId(id)) return;
    event.preventDefault();
    event.stopPropagation();
    press = { id, pointerId: event.pointerId, startX: x, startY: y, moved: false, last: null };
    try {
      container.setPointerCapture?.(event.pointerId);
    } catch {
      // Uncaptured pointers still move the icon while they stay over the globe.
    }
    canvas.style.cursor = 'grabbing';
    onPressStart?.();
  };
  const onMove = (event) => {
    if (!press || event.pointerId !== press.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const { x, y } = local(event);
    if (!press.moved && Math.hypot(x - press.startX, y - press.startY) < MOVE_TRAVEL_PX) return;
    press.moved = true;
    const point = globePoint(x, y);
    if (!point) return;
    press.last = point;
    onPreview?.(press.id, point);
  };
  const onUp = (event) => {
    if (!press || event.pointerId !== press.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      container.releasePointerCapture?.(press.pointerId);
    } catch {
      // Already released.
    }
    const finished = press;
    press = null;
    canvas.style.cursor = '';
    onPressEnd?.();
    if (!finished.moved) onSelect?.(finished.id);
    else if (event.type === 'pointerup' && finished.last) onCommit?.(finished.id, finished.last);
    else if (finished.last) onCommit?.(finished.id, null);
  };

  container.addEventListener('pointerdown', onDown, true);
  container.addEventListener('pointermove', onMove, true);
  container.addEventListener('pointerup', onUp, true);
  container.addEventListener('pointercancel', onUp, true);
  return () => {
    container.removeEventListener('pointerdown', onDown, true);
    container.removeEventListener('pointermove', onMove, true);
    container.removeEventListener('pointerup', onUp, true);
    container.removeEventListener('pointercancel', onUp, true);
    if (press) {
      press = null;
      canvas.style.cursor = '';
      onPressEnd?.();
    }
  };
}
