/**
 * Corner resizing for the LOCATION tray.
 *
 * The tray opens above the dock with its bottom-left corner pinned there, so a
 * drag on any of its four corners changes its width and height; the left
 * corners also move its left edge. A taller tray shows more rows of location
 * pills, so resizing it is the quick way to see every option at once. The size
 * is a per-browser preference kept in localStorage.
 */

export const LOCATION_PANEL_STORAGE_KEY = 'gev.locations.panelSize';
export const LOCATION_PANEL_LIMITS = Object.freeze({
  minWidth: 320,
  maxWidth: 1400,
  minHeight: 120,
  maxHeight: 640,
});
/** Tray height that is not pill rows: padding, the landmark row, the search row's slack. */
const ROW_OVERHEAD_PX = 84;
const ROW_HEIGHT_PX = 34;
const MIN_ROWS = 2;
const MAX_ROWS = 12;
const CORNERS = Object.freeze(['nw', 'ne', 'sw', 'se']);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * The tray's size after a corner has been dragged by (dx, dy).
 * East corners follow the pointer; west corners grow as they move left and
 * carry the left edge with them. North corners grow upward; south corners grow
 * downward (the tray stays pinned to the dock, so it extends upward either way).
 * @param {{width: number, height: number, shiftX: number}} start
 * @param {'nw'|'ne'|'sw'|'se'} corner
 * @returns {{width: number, height: number, shiftX: number}}
 */
export function resizedLocationPanel(
  start,
  corner,
  dx,
  dy,
  limits = LOCATION_PANEL_LIMITS,
) {
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';
  const width = clamp(
    start.width + (west ? -dx : dx),
    limits.minWidth,
    limits.maxWidth,
  );
  const height = clamp(
    start.height + (north ? -dy : dy),
    limits.minHeight,
    limits.maxHeight,
  );
  // Only the width actually gained moves the left edge, so a clamped drag does
  // not slide the tray sideways.
  const shiftX = west ? start.shiftX - (width - start.width) : start.shiftX;
  return {
    width: Math.round(width),
    height: Math.round(height),
    shiftX: Math.round(shiftX),
  };
}

/** How many rows of location pills fit in a tray this tall. */
export function locationPillRows(height) {
  return clamp(
    Math.floor((Number(height) - ROW_OVERHEAD_PX) / ROW_HEIGHT_PX),
    MIN_ROWS,
    MAX_ROWS,
  );
}

export function loadLocationPanelSize(
  storage = globalThis.localStorage,
  limits = LOCATION_PANEL_LIMITS,
) {
  try {
    const saved = JSON.parse(
      storage?.getItem(LOCATION_PANEL_STORAGE_KEY) || 'null',
    );
    if (
      !saved ||
      !Number.isFinite(saved.width) ||
      !Number.isFinite(saved.height)
    )
      return null;
    return {
      width: clamp(saved.width, limits.minWidth, limits.maxWidth),
      height: clamp(saved.height, limits.minHeight, limits.maxHeight),
      shiftX: Number.isFinite(saved.shiftX) ? saved.shiftX : 0,
    };
  } catch {
    return null;
  }
}

function saveLocationPanelSize(size, storage = globalThis.localStorage) {
  try {
    storage?.setItem(LOCATION_PANEL_STORAGE_KEY, JSON.stringify(size));
  } catch {
    // Private mode or a full store: the size still holds for this session.
  }
}

function applySize(popover, pills, size) {
  // Never larger than the window it lives in, whatever was saved on a bigger
  // screen. (Done here, not in CSS: the credit-attribution layout model
  // refuses stylesheet rules that size the dock tray.)
  const viewW = Number(globalThis.innerWidth) || Infinity;
  const viewH = Number(globalThis.innerHeight) || Infinity;
  popover.style.width = `${Math.min(size.width, viewW - 24)}px`;
  popover.style.height = `${Math.min(size.height, viewH - 140)}px`;
  popover.style.marginLeft = `${size.shiftX}px`;
  popover.classList.add('location-popover-resized');
  pills?.style.setProperty(
    '--location-pill-rows',
    String(locationPillRows(size.height)),
  );
}

/**
 * Add the four corner grips to the tray and restore the saved size.
 * @param {{popover: HTMLElement, pills?: HTMLElement, doc?: Document, storage?: Storage}} input
 * @returns {() => void} Remover.
 */
export function bindLocationPanelResize({
  popover,
  pills = null,
  doc = globalThis.document,
  storage = globalThis.localStorage,
} = {}) {
  if (!popover || typeof popover.appendChild !== 'function') return () => {};
  const removers = [];
  let size = loadLocationPanelSize(storage);
  if (size) applySize(popover, pills, size);

  for (const corner of CORNERS) {
    const grip = doc.createElement('span');
    grip.className = `location-resize-grip location-resize-grip-${corner}`;
    grip.dataset.corner = corner;
    grip.setAttribute('aria-hidden', 'true');
    grip.title = 'Drag to resize · double-click to reset';
    let drag = null;

    const onDown = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      const rect = popover.getBoundingClientRect();
      drag = {
        x: event.clientX,
        y: event.clientY,
        start: {
          width: rect.width,
          height: rect.height,
          shiftX: size?.shiftX || 0,
        },
      };
      grip.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };
    const onMove = (event) => {
      if (!drag) return;
      size = resizedLocationPanel(
        drag.start,
        corner,
        event.clientX - drag.x,
        event.clientY - drag.y,
      );
      applySize(popover, pills, size);
    };
    const onUp = (event) => {
      if (!drag) return;
      drag = null;
      grip.releasePointerCapture?.(event.pointerId);
      if (size) saveLocationPanelSize(size, storage);
    };
    const onReset = () => {
      size = null;
      popover.style.width = '';
      popover.style.height = '';
      popover.style.marginLeft = '';
      popover.classList.remove('location-popover-resized');
      pills?.style.removeProperty('--location-pill-rows');
      try {
        storage?.removeItem(LOCATION_PANEL_STORAGE_KEY);
      } catch {
        // Nothing saved to clear.
      }
    };
    grip.addEventListener('pointerdown', onDown);
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
    grip.addEventListener('dblclick', onReset);
    removers.push(() => {
      grip.removeEventListener('pointerdown', onDown);
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      grip.removeEventListener('dblclick', onReset);
      grip.remove();
    });
    popover.appendChild(grip);
  }
  return () => {
    for (const remove of removers.splice(0)) remove();
  };
}
