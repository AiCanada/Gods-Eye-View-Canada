/**
 * Resizing the CCTV panel's live picture.
 *
 * A small handle on the picture's corner changes the whole panel's width; the
 * 16:9 picture grows with it. One click steps through four widths (S, M, L,
 * XL, then back to S); dragging sizes it freely; arrow keys on the focused
 * handle step the width too (Shift for bigger steps). In the right-hand Context
 * rail the panel is anchored on its right edge, so the handle sits bottom-left
 * and dragging left widens it; anywhere else it sits bottom-right. The width is
 * a per-browser preference kept in localStorage.
 */

export const CCTV_PANEL_WIDTH_MIN = 260;
export const CCTV_PANEL_WIDTH_MAX = 960;
export const CCTV_PANEL_WIDTH_STORAGE_KEY = 'gev.cctv.panelWidth';
/** One-click widths, smallest first. */
export const CCTV_PANEL_WIDTH_STEPS = Object.freeze([300, 380, 520, 700]);
const CLICK_TRAVEL_PX = 4;

/** A width that fits between the minimum, the maximum and the viewport, or null. */
export function clampPanelWidth(width, viewportWidth = Number.POSITIVE_INFINITY) {
  const number = Number(width);
  if (!Number.isFinite(number)) return null;
  const max = Math.max(CCTV_PANEL_WIDTH_MIN, Math.min(CCTV_PANEL_WIDTH_MAX, Number(viewportWidth) - 32));
  return Math.round(Math.min(max, Math.max(CCTV_PANEL_WIDTH_MIN, number)));
}

/** The width after dragging the handle from startX to x. */
export function draggedPanelWidth({ startWidth, startX, x, anchor = 'left', viewportWidth }) {
  const delta = anchor === 'right' ? startX - x : x - startX;
  return clampPanelWidth(Number(startWidth) + delta, viewportWidth);
}

/** The next one-click width after the current one, wrapping from the widest to the narrowest. */
export function nextPanelWidthStep(currentWidth, viewportWidth = Number.POSITIVE_INFINITY) {
  const current = Number(currentWidth) || 0;
  const next = CCTV_PANEL_WIDTH_STEPS.find((step) => step > current + 8);
  const width = clampPanelWidth(next ?? CCTV_PANEL_WIDTH_STEPS[0], viewportWidth);
  // On a narrow screen the wider steps collapse onto the same width: wrap round.
  return width !== null && width <= current + 8 ? clampPanelWidth(CCTV_PANEL_WIDTH_STEPS[0], viewportWidth) : width;
}

function readSaved(storage) {
  try {
    const saved = storage?.getItem(CCTV_PANEL_WIDTH_STORAGE_KEY);
    return saved === null || saved === undefined ? null : Number(saved);
  } catch {
    return null;
  }
}

function writeSaved(storage, width) {
  try {
    if (width) storage?.setItem(CCTV_PANEL_WIDTH_STORAGE_KEY, String(width));
    else storage?.removeItem(CCTV_PANEL_WIDTH_STORAGE_KEY);
  } catch {
    // Blocked storage: the width lasts until reload.
  }
}

/**
 * Add the handle to the picture and wire it.
 * @param {{panel: HTMLElement, wrap: HTMLElement, listen: Function, doc?: Document, win?: Window, storage?: Storage}} options
 * @returns {HTMLElement|null} The handle.
 */
export function bindCctvPanelResize({ panel, wrap, listen, doc = globalThis.document, win = globalThis.window, storage = globalThis.localStorage } = {}) {
  if (!panel || !wrap || typeof listen !== 'function' || !doc) return null;
  let handle = wrap.querySelector('.cctv-frame-resize');
  if (!handle) {
    handle = doc.createElement('div');
    handle.className = 'cctv-frame-resize';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'Resize the camera view: click to step the size, drag, or use the arrow keys');
    handle.title = 'Click to change size · drag to resize';
    handle.tabIndex = 0;
    wrap.append(handle);
  }
  const viewport = () => win?.innerWidth ?? Number.POSITIVE_INFINITY;
  const anchor = () => (panel.closest?.('#right-context-rail') ? 'right' : 'left');
  const apply = (width) => {
    if (width) {
      panel.style.setProperty('--cctv-user-width', `${width}px`);
      panel.dataset.userWidth = String(width);
    } else {
      panel.style.removeProperty('--cctv-user-width');
      delete panel.dataset.userWidth;
    }
  };

  const saved = clampPanelWidth(readSaved(storage), viewport());
  if (saved) apply(saved);

  let press = null;
  listen(handle, 'pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    press = { pointerId: event.pointerId, startX: event.clientX, startWidth: panel.getBoundingClientRect().width, anchor: anchor(), dragged: false };
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch {
      // Uncaptured pointers still resize while over the handle.
    }
    panel.classList.add('cctv-resizing');
  });
  listen(handle, 'pointermove', (event) => {
    if (!press) return;
    event.preventDefault();
    if (!press.dragged && Math.abs(event.clientX - press.startX) < CLICK_TRAVEL_PX) return;
    press.dragged = true;
    apply(draggedPanelWidth({ ...press, x: event.clientX, viewportWidth: viewport() }));
  });
  const end = (event) => {
    if (!press || (event.pointerId !== undefined && event.pointerId !== press.pointerId)) return;
    try {
      handle.releasePointerCapture?.(press.pointerId);
    } catch {
      // Already released.
    }
    if (!press.dragged && event.type === 'pointerup') apply(nextPanelWidthStep(press.startWidth, viewport()));
    press = null;
    panel.classList.remove('cctv-resizing');
    writeSaved(storage, Number(panel.dataset.userWidth) || null);
  };
  listen(handle, 'pointerup', end);
  listen(handle, 'pointercancel', end);
  listen(handle, 'keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const next = nextPanelWidthStep(panel.getBoundingClientRect().width, viewport());
      apply(next);
      writeSaved(storage, next);
      return;
    }
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const grow = anchor() === 'right' ? -direction : direction;
    const next = clampPanelWidth(panel.getBoundingClientRect().width + grow * (event.shiftKey ? 60 : 20), viewport());
    apply(next);
    writeSaved(storage, next);
  });
  return handle;
}
