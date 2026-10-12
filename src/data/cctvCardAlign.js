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
 * On a phone the same steps go by finger. A long press starts, as the
 * browser turns it into a right-click. While aligning:
 *   - drag it with one finger to move it;
 *   - put a second finger down and twist to rotate it;
 *   - long-press it again to save;
 *   - tap anywhere off it to cancel;
 *   - tap with three fingers to forget the saved alignment.
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
/** A finger held still on the thumbnail this long saves it. */
const TOUCH_LONG_PRESS_MS = 500;
/** A finger drifts while it is held; more than this is a drag. */
const TOUCH_SLOP_PX = 10;
/** A tap is down and up within this long. */
const TOUCH_TAP_MS = 350;
/** A twist turns the thumbnail once the fingers have turned this far. */
const TWIST_MIN_DEG = 0.5;

/** Compass bearing from one point to another, degrees clockwise from north. Pure. */
export function bearingBetween(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** A bearing turned by some degrees, kept in [0, 360) to one decimal. Pure. */
export function turnedBearing(bearingDeg, deltaDeg) {
  const next = ((((Number(bearingDeg) || 0) + deltaDeg) % 360) + 360) % 360;
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
  /** Fingers down on the globe while a thumbnail is being aligned. */
  const touches = new Map();
  let longPress = null;
  let twist = null;
  let threeTap = null;
  let offTap = null;
  /** Until then the browser's long-press right-click is not a right-click. */
  let quietMenuUntil = 0;
  const now = () =>
    typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
  const isTouch = (event) => event.pointerType === 'touch';
  const fingerAngle = () => {
    const [a, b] = [...touches.values()];
    return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  };
  const endLongPress = () => {
    if (longPress?.timer != null) clearTimeout(longPress.timer);
    longPress = null;
  };

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
      bearing = hit
        ? screenUpBearing(hit.rect.anchorX, hit.rect.anchorY)
        : null;
      if (!Number.isFinite(bearing)) bearing = 0;
    }
    update({ bearingDeg: turnedBearing(bearing, deltaDeg) });
  };

  const onDown = (event) => {
    if (!isEnabled()) return;
    const { x, y } = local(event);
    if (isTouch(event) && onTouchDown(event, x, y)) return;
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
    drag = {
      pointerId: event.pointerId,
      startX: x,
      startY: y,
      offsetX: hit.rect.anchorX - x,
      offsetY: hit.rect.anchorY - y,
      moved: false,
    };
    try {
      container.setPointerCapture?.(event.pointerId);
    } catch {
      // Still works while the pointer stays over the globe.
    }
    onDragStart?.();
    if (isTouch(event)) {
      // Held still on the thumbnail: save, as the second right-click does.
      const id = hit.entryId;
      longPress = {
        pointerId: event.pointerId,
        timer: setTimeout(() => {
          longPress = null;
          if (!isEnabled() || touches.size !== 1) return;
          quietMenuUntil = now() + 1500;
          if (getSession()?.id === id) save();
        }, TOUCH_LONG_PRESS_MS),
      };
    }
  };
  /**
   * The extra fingers of a touch gesture. Returns true when this press is
   * taken here and the one-finger path must not see it.
   */
  const onTouchDown = (event, x, y) => {
    // The first finger of a new gesture: forget fingers whose lift was lost.
    if (event.isPrimary === true) touches.clear();
    if (!getSession()) {
      touches.clear();
      return false;
    }
    const finger = { x, y, startX: x, startY: y, taken: false };
    touches.set(event.pointerId, finger);
    if (touches.size === 1) {
      offTap = hitSession(x, y)
        ? null
        : { pointerId: event.pointerId, x, y, at: now() };
      threeTap = null;
      return false;
    }
    offTap = null;
    endLongPress();
    if (touches.size === 3) {
      twist = null;
      threeTap = { at: now(), moved: false };
    } else if (touches.size === 2 && drag) {
      // Second finger while the first holds the thumbnail: twist to turn.
      const first = touches.get(drag.pointerId) || finger;
      twist = { angle: fingerAngle(), hit: hitSession(first.x, first.y) };
    }
    if (drag || twist || threeTap) {
      finger.taken = true;
      swallow(event);
    }
    // A second finger on the globe stays the globe's (a pinch), and never
    // starts a thumbnail drag of its own.
    return true;
  };
  const onTouchMove = (event) => {
    const finger = touches.get(event.pointerId);
    if (!finger) return false;
    const { x, y } = local(event);
    finger.x = x;
    finger.y = y;
    const travel = Math.hypot(x - finger.startX, y - finger.startY);
    if (travel > TOUCH_SLOP_PX) {
      if (longPress?.pointerId === event.pointerId) endLongPress();
      if (threeTap) threeTap.moved = true;
      if (offTap?.pointerId === event.pointerId) offTap = null;
    }
    if (twist && touches.size === 2) {
      swallow(event);
      const angle = fingerAngle();
      let delta = angle - twist.angle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      if (Math.abs(delta) >= TWIST_MIN_DEG) {
        // Screen y points down, so a clockwise twist is a growing angle,
        // and a growing bearing turns the thumbnail clockwise too.
        turn(delta, twist.hit);
        twist.angle = angle;
      }
      return true;
    }
    if (finger.taken || threeTap) {
      swallow(event);
      return true;
    }
    return false;
  };
  const onTouchUp = (event) => {
    const finger = touches.get(event.pointerId);
    if (!finger) return false;
    const { x, y } = local(event);
    touches.delete(event.pointerId);
    if (longPress?.pointerId === event.pointerId) endLongPress();
    if (touches.size < 2) twist = null;
    let taken = finger.taken;
    if (taken) swallow(event);
    if (threeTap) {
      swallow(event);
      taken = true;
      if (!touches.size) {
        const tapped =
          !threeTap.moved && now() - threeTap.at <= TOUCH_TAP_MS * 2;
        threeTap = null;
        if (tapped && getSession() && event.type !== 'pointercancel') reset();
      }
    }
    const tap = offTap;
    if (tap?.pointerId === event.pointerId) {
      offTap = null;
      if (
        event.type === 'pointerup' &&
        !touches.size &&
        now() - tap.at <= TOUCH_TAP_MS &&
        Math.hypot(x - tap.x, y - tap.y) <= TOUCH_SLOP_PX &&
        getSession() &&
        !hitSession(x, y)
      )
        cancel();
    }
    return taken;
  };
  const onMove = (event) => {
    if (isTouch(event) && onTouchMove(event)) return;
    if (!drag || event.pointerId !== drag.pointerId) return;
    swallow(event);
    // Two fingers are turning it; the first one does not also move it.
    if (twist) return;
    const { x, y } = local(event);
    if (
      !drag.moved &&
      Math.hypot(x - drag.startX, y - drag.startY) < CLICK_TRAVEL_PX
    )
      return;
    drag.moved = true;
    const ground = pickGround(x + drag.offsetX, y + drag.offsetY);
    if (ground) update({ lat: ground.lat, lon: ground.lon });
  };
  const onUp = (event) => {
    if (
      isTouch(event) &&
      onTouchUp(event) &&
      event.pointerId !== drag?.pointerId
    )
      return;
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
    // The browser's long-press menu while a finger aligns, or just after a
    // long press saved: the finger has already said what it meant.
    if (longPress || twist || threeTap || now() < quietMenuUntil) {
      if (getSession() || now() < quietMenuUntil) swallow(event);
      rightDown = null;
      return;
    }
    const { x, y } = local(event);
    const press = rightDown;
    rightDown = null;
    if (press && Math.hypot(x - press.x, y - press.y) >= CLICK_TRAVEL_PX)
      return;
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
    const step = event.shiftKey
      ? CCTV_ALIGN_COARSE_STEP_DEG
      : CCTV_ALIGN_STEP_DEG;
    const direction = (event.deltaY || event.deltaX) > 0 ? 1 : -1;
    turn(direction * step, hit);
  };
  const onKey = (event) => {
    if (!isEnabled() || !getSession()) return;
    const tag = event.target?.tagName;
    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      event.target?.isContentEditable
    )
      return;
    const step = event.shiftKey
      ? CCTV_ALIGN_COARSE_STEP_DEG
      : CCTV_ALIGN_STEP_DEG;
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
  container.addEventListener('wheel', onWheel, {
    capture: true,
    passive: false,
  });
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
    endLongPress();
    touches.clear();
    twist = null;
    threeTap = null;
    offTap = null;
    if (drag) {
      drag = null;
      onDragEnd?.();
    }
  };
}
