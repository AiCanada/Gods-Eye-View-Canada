/**
 * Resizing the map's camera cards — every camera, public and private.
 *
 * Each card carries a small size badge (S / M / L / XL) in its bottom-right
 * corner. One click on the badge steps every card to the next size, wrapping
 * from XL back to S. Dragging the badge sizes the cards freely. The size is a
 * per-browser preference kept in localStorage.
 *
 * The listeners sit in the capture phase on the globe canvas's container, so a
 * press that lands on a badge is claimed before Cesium's own handlers see it:
 * the globe does not pan, and the camera under the card is not selected.
 */

import { CCTV_CARD_SIZE_STEPS } from './cctvCards.js';

export const CCTV_CARD_SCALE_MIN = 0.6;
export const CCTV_CARD_SCALE_MAX = 3;
export const CCTV_CARD_SCALE_STORAGE_KEY = 'gev.cctv.cardScale';
/** How close to a card's bottom-right corner, in CSS px, a press lands on the size badge. */
export const CCTV_CARD_CORNER_GRAB_PX = 20;
/** A press that moves less than this is a click, not a drag. */
const CLICK_TRAVEL_PX = 5;

/** A usable card scale, or 1 for anything that is not a number. */
export function clampCardScale(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  return Math.min(CCTV_CARD_SCALE_MAX, Math.max(CCTV_CARD_SCALE_MIN, number));
}

/** The next size after this one on a click: S → M → L → XL → S. */
export function nextCardSizeStep(scale) {
  const current = clampCardScale(scale);
  const next = CCTV_CARD_SIZE_STEPS.find((step) => step.scale > current + 0.01);
  return (next || CCTV_CARD_SIZE_STEPS[0]).scale;
}

/** The saved scale, or 1 when nothing is saved or storage is unavailable. */
export function loadCardScale(storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(CCTV_CARD_SCALE_STORAGE_KEY);
    return saved === null || saved === undefined ? 1 : clampCardScale(saved);
  } catch {
    return 1;
  }
}

/** Remember a scale for this browser. Blocked storage keeps it for the session only. */
export function saveCardScale(scale, storage = globalThis.localStorage) {
  try {
    storage?.setItem(CCTV_CARD_SCALE_STORAGE_KEY, String(Math.round(clampCardScale(scale) * 100) / 100));
  } catch {
    // Private window or blocked storage: the size lasts until reload.
  }
}

/** True when (x, y) sits on the card rectangle's bottom-right size badge. */
export function isCardResizeCorner(rect, x, y, grabPx = CCTV_CARD_CORNER_GRAB_PX) {
  return cardResizeCorner(rect, x, y, grabPx) === 'se';
}

/** The other three corners take a smaller grab so most of the card still selects its camera. */
export const CCTV_CARD_PLAIN_CORNER_GRAB_PX = 14;

/**
 * Which corner of the card (x, y) is on: 'se' is the size badge (click steps the
 * size, drag resizes); 'nw', 'ne' and 'sw' resize by drag only.
 * @returns {'nw'|'ne'|'sw'|'se'|null}
 */
export function cardResizeCorner(rect, x, y, grabPx = CCTV_CARD_CORNER_GRAB_PX) {
  if (!rect || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  if (x >= right - grabPx && x <= right + 4 && y >= bottom - grabPx && y <= bottom + 4) return 'se';
  const plain = Math.min(grabPx, CCTV_CARD_PLAIN_CORNER_GRAB_PX);
  const west = x >= rect.x - 4 && x <= rect.x + plain;
  const east = x >= right - plain && x <= right + 4;
  const north = y >= rect.y - 4 && y <= rect.y + plain;
  const south = y >= bottom - plain && y <= bottom + 4;
  if (north && west) return 'nw';
  if (north && east) return 'ne';
  if (south && west) return 'sw';
  return null;
}

/**
 * The scale after dragging the badge from (startX, startY) to (x, y): the card
 * grows by however far the pointer moved relative to its size, averaged over
 * width and height so a diagonal drag feels natural.
 */
export function draggedCardScale({ startScale, rect, startX, startY, x, y, corner = 'se' }) {
  const width = Math.max(1, Number(rect?.w) || 1);
  const height = Math.max(1, Number(rect?.h) || 1);
  // Pulling a corner AWAY from the card grows it, whichever corner it is.
  const dx = (x - startX) * (corner === 'nw' || corner === 'sw' ? -1 : 1);
  const dy = (y - startY) * (corner === 'nw' || corner === 'ne' ? -1 : 1);
  const growth = ((width + dx) / width + (height + dy) / height) / 2;
  return clampCardScale((Number(startScale) || 1) * growth);
}

/**
 * Wire badge clicks and drags onto the globe canvas.
 * @returns {() => void} Removes every listener and ends any press in progress.
 */
export function bindCctvCardResize({
  canvas,
  hitTest,
  isEnabled = () => true,
  getScale,
  setScale,
  onDragStart,
  onDragEnd,
  storage = globalThis.localStorage,
} = {}) {
  const container = canvas?.parentElement;
  if (!canvas || !container || typeof hitTest !== 'function') return () => {};
  let press = null;
  let cursorOwned = false;

  const local = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const cornerAt = (x, y) => {
    const hit = hitTest(x, y);
    // A turned card reports the pointer in its own unturned frame.
    const corner = hit?.rect
      ? cardResizeCorner(hit.rect, hit.localX ?? x, hit.localY ?? y)
      : null;
    return corner ? { hit, corner } : null;
  };
  const badgeAt = (x, y) => {
    const found = cornerAt(x, y);
    return found?.corner === 'se' ? found.hit : null;
  };
  const CORNER_CURSOR = { se: 'pointer', nw: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
  const setCursor = (corner) => {
    const next = corner || false;
    if (next === cursorOwned) return;
    cursorOwned = next;
    canvas.style.cursor = next ? CORNER_CURSOR[next] : '';
  };

  const onDown = (event) => {
    if (press || event.button !== 0 || !isEnabled()) return;
    const { x, y } = local(event);
    const found = cornerAt(x, y);
    if (!found) return;
    const { hit, corner } = found;
    event.preventDefault();
    event.stopPropagation();
    press = { pointerId: event.pointerId, startX: x, startY: y, startScale: getScale(), rect: { w: hit.rect.w, h: hit.rect.h }, corner, dragged: false };
    try {
      container.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer that cannot be captured still works while it stays over the globe.
    }
    onDragStart?.();
  };
  const onMove = (event) => {
    const { x, y } = local(event);
    if (press) {
      event.preventDefault();
      event.stopPropagation();
      if (!press.dragged && Math.hypot(x - press.startX, y - press.startY) < CLICK_TRAVEL_PX) return;
      press.dragged = true;
      const next = draggedCardScale({ ...press, x, y });
      if (Math.abs(next - getScale()) >= 0.01) setScale(next);
      return;
    }
    setCursor(isEnabled() ? cornerAt(x, y)?.corner || null : null);
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
    // One click steps to the next size; a drag keeps the size it reached.
    // (Only the badge steps; a plain corner that was merely clicked changes nothing.)
    if (!press.dragged && press.corner === 'se') setScale(nextCardSizeStep(press.startScale));
    press = null;
    saveCardScale(getScale(), storage);
    onDragEnd?.();
  };
  const swallowClick = (event) => {
    if (!isEnabled()) return;
    const { x, y } = local(event);
    if (!badgeAt(x, y)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  container.addEventListener('pointerdown', onDown, true);
  container.addEventListener('pointermove', onMove, true);
  container.addEventListener('pointerup', onUp, true);
  container.addEventListener('pointercancel', onUp, true);
  container.addEventListener('dblclick', swallowClick, true);
  return () => {
    container.removeEventListener('pointerdown', onDown, true);
    container.removeEventListener('pointermove', onMove, true);
    container.removeEventListener('pointerup', onUp, true);
    container.removeEventListener('pointercancel', onUp, true);
    container.removeEventListener('dblclick', swallowClick, true);
    if (press) {
      press = null;
      onDragEnd?.();
    }
    setCursor(false);
  };
}
