/**
 * Hand alignment of a CCTV map thumbnail.
 *
 * Right-click a thumbnail to start. While it is being aligned:
 *   - drag it (left button) to move it over the map;
 *   - turn the wheel over it to rotate it (hold Shift for coarse steps), or use
 *     the left/right arrow keys;
 *   - right-click it again (or press Enter) to save;
 *   - Escape cancels; Delete forgets the saved alignment and puts the thumbnail
 *     back where the program places it, upright.
 *
 * What is saved is tied to the MAP, not the screen: the ground point under the
 * middle of the picture, and the compass bearing "up the picture" points to.
 * So the thumbnail stays lined up with its road as the view orbits and zooms,
 * and looks the same on the next run. This module owns only the gesture; the
 * CCTV layer supplies the picking, the drawing and the saving.
 */

/** Rotation per wheel notch / arrow press, and the coarse (Shift) step. */
export const CCTV_ALIGN_STEP_DEG = 2;
export const CCTV_ALIGN_COARSE_STEP_DEG = 15;
/** Pointer travel under this is a click, not a drag. */
const CLICK_TRAVEL_PX = 4;

/** Compass bearing from one point to another, degrees clockwise from north. Pure. */
export function bearingBetween(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** A bearing turned by some degrees, kept in [0, 360) to one decimal. Pure. */
export function turnedBearing(bearingDeg, deltaDeg) {
  const next = (((Number(bearingDeg) || 0) + deltaDeg) % 360 + 360) % 360;
  return Math.round(next * 10) / 10;
}

/**
 * Bind the align gesture.
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas The globe canvas (listeners go on its parent, capturing).
 * @param {(x: number, y: number) => ({entryId: string, rect: {anchorX: number, anchorY: number}}|null)} options.hitTest
 * @param {() => boolean} [options.isEnabled]
 * @param {() => ({id: string, draft: {lat: number, lon: number, bearingDeg: number|null}}|null)} options.getSession
 *   The thumbnail being aligned, or null.
 * @param {(id: string, anchor: {x: number, y: number}) => boolean} options.begin Start aligning; false refuses.
 * @param {(x: number, y: number) => ({lat: number, lon: number}|null)} options.pickGround
 * @param {(anchorX: number, anchorY: number) => number|null} options.screenUpBearing
 *   The compass bearing that points straight up the screen at that point.
 * @param {(patch: {lat?: number, lon?: number, bearingDeg?: number|null}) => void} options.update
 * @param {() => void} options.save
 * @param {() => void} options.cancel
 * @param {() => void} options.reset Forget the saved alignment.
 * @param {() => void} [options.onDragStart]
 * @param {() => void} [options.onDragEnd]
 * @returns {() => void} Unbind.
 */
export function bindCctvCardAlign({
  canvas,
  hitTest,
  isEnabled = () => true,
  getSession,
  begin,
  pickGround,
  screenUpBearing,
  update,
  save,
  cancel,
  reset,
  onDragStart,
  onDragEnd,
} = {}) {
  const container = canvas?.parentElement;
  if (!canvas || !container || typeof hitTest !== 'function') return () => {};
  let drag = null;
  let rightDown = null;

  const local = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const hitSession = (x, y) => {
    const session = getSession();
    if (!session) return null;
    const hit = hitTest(x, y);
    return hit?.entryId === session.id ? hit : null;
  };
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const turn = (deltaDeg, hit) => {
    const session = getSession();
    if (!session) return;
    let bearing = session.draft.bearingDeg;
    if (!Number.isFinite(bearing)) {
      // Upright so far: start from whatever "up the screen" is on the map here.
      bearing = hit ? screenUpBearing(hit.rect.anchorX, hit.rect.anchorY) : null;
      if (!Number.isFinite(bearing)) bearing = 0;
    }
    update({ bearingDeg: turnedBearing(bearing, deltaDeg) });
  };

  const onDown = (event) => {
    if (!isEnabled()) return;
    const { x, y } = local(event);
    if (event.button === 2) {
      // Remembered so a right-DRAG (the globe's zoom) is never taken for a right-click.
      rightDown = { x, y, onCard: Boolean(hitTest(x, y)) };
      if (rightDown.onCard) swallow(event);
      return;
    }
    if (event.button !== 0 || drag) return;
    const hit = hitSession(x, y);
    if (!hit) return;
    swallow(event);
    drag = { pointerId: event.pointerId, startX: x, startY: y, offsetX: hit.rect.anchorX - x, offsetY: hit.rect.anchorY - y, moved: false };
    try {
      container.setPointerCapture?.(event.pointerId);
    } catch {
      // Still works while the pointer stays over the globe.
    }
    onDragStart?.();
  };
  const onMove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    swallow(event);
    const { x, y } = local(event);
    if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) < CLICK_TRAVEL_PX) return;
    drag.moved = true;
    const ground = pickGround(x + drag.offsetX, y + drag.offsetY);
    if (ground) update({ lat: ground.lat, lon: ground.lon });
  };
  const onUp = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    swallow(event);
    try {
      container.releasePointerCapture?.(drag.pointerId);
    } catch {
      // Already released.
    }
    drag = null;
    onDragEnd?.();
  };
  const onContextMenu = (event) => {
    if (!isEnabled()) return;
    const { x, y } = local(event);
    const press = rightDown;
    rightDown = null;
    if (press && Math.hypot(x - press.x, y - press.y) >= CLICK_TRAVEL_PX) return;
    const hit = hitTest(x, y);
    if (!hit) return;
    swallow(event);
    const session = getSession();
    if (session) {
      // The second right-click, on the same thumbnail, saves.
      if (hit.entryId === session.id) save();
      return;
    }
    begin(hit.entryId, { x: hit.rect.anchorX, y: hit.rect.anchorY });
  };
  const onWheel = (event) => {
    if (!isEnabled()) return;
    const { x, y } = local(event);
    const hit = hitSession(x, y);
    if (!hit) return;
    swallow(event);
    const step = event.shiftKey ? CCTV_ALIGN_COARSE_STEP_DEG : CCTV_ALIGN_STEP_DEG;
    const direction = (event.deltaY || event.deltaX) > 0 ? 1 : -1;
    turn(direction * step, hit);
  };
  const onKey = (event) => {
    if (!isEnabled() || !getSession()) return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;
    const step = event.shiftKey ? CCTV_ALIGN_COARSE_STEP_DEG : CCTV_ALIGN_STEP_DEG;
    if (event.key === 'Escape') cancel();
    else if (event.key === 'Enter') save();
    else if (event.key === 'Delete' || event.key === 'Backspace') reset();
    else if (event.key === 'ArrowLeft') turn(-step, null);
    else if (event.key === 'ArrowRight') turn(step, null);
    else return;
    swallow(event);
  };
  const swallowClick = (event) => {
    if (!isEnabled()) return;
    const { x, y } = local(event);
    if (hitSession(x, y)) swallow(event);
  };

  container.addEventListener('pointerdown', onDown, true);
  container.addEventListener('pointermove', onMove, true);
  container.addEventListener('pointerup', onUp, true);
  container.addEventListener('pointercancel', onUp, true);
  container.addEventListener('contextmenu', onContextMenu, true);
  container.addEventListener('wheel', onWheel, { capture: true, passive: false });
  container.addEventListener('click', swallowClick, true);
  container.addEventListener('dblclick', swallowClick, true);
  const keyTarget = typeof window !== 'undefined' ? window : null;
  keyTarget?.addEventListener('keydown', onKey, true);
  return () => {
    container.removeEventListener('pointerdown', onDown, true);
    container.removeEventListener('pointermove', onMove, true);
    container.removeEventListener('pointerup', onUp, true);
    container.removeEventListener('pointercancel', onUp, true);
    container.removeEventListener('contextmenu', onContextMenu, true);
    container.removeEventListener('wheel', onWheel, { capture: true });
    container.removeEventListener('click', swallowClick, true);
    container.removeEventListener('dblclick', swallowClick, true);
    keyTarget?.removeEventListener('keydown', onKey, true);
    if (drag) {
      drag = null;
      onDragEnd?.();
    }
  };
}
