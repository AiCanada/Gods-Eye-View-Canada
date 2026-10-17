/**
 * Corner resizing for every dashboard box on desktop (owner requests
 * 2026-10-16: the Artificial Intelligence World Training Sim tab "should be
 * resizable with bottom right hand corner", then "add same resize options to
 * all tabs on desktop").
 *
 * Each box in the left stack gets a grip at its bottom-right corner; each box
 * in the right rail, which is anchored to the right edge of the screen, gets
 * the mirror grip at its bottom-left, so dragging outward always grows the
 * box onto the map. A drag sets the box's width and height, the arrow keys
 * step them (Shift for bigger steps), and a double-click puts the box's own
 * size back. A size is kept on screen and remembered per box in this
 * browser (`gev:panel-size:<panel id>`, a per-viewer convenience).
 *
 * The grip writes `--panel-user-width` / `--panel-user-height` on the box
 * with the classes `panel-user-wide` / `panel-user-sized`; the rules in
 * src/ui/styles/panel-resize.css apply them, on desktop widths only, so phone
 * layouts keep their sizes. A floating CCTV or Street Level window keeps its
 * own edge resizing (panelPositionControls.js) and shows no grip.
 */
import { tl } from '../i18n/index.js';

export const PANEL_SIZE_KEY_PREFIX = 'gev:panel-size:';
/** The smallest a box goes by its grip. */
export const PANEL_SIZE_MIN = Object.freeze({ width: 240, height: 160 });
/** Boxes with a larger floor (their rows need the room). */
export const PANEL_SIZE_MIN_BY_ID = Object.freeze({
  'ai-world-panel': Object.freeze({ width: 360, height: 240 }),
});
/** One arrow-key step, in pixels (Shift: four). */
export const PANEL_SIZE_STEP = 20;
/** The rails whose boxes get a grip, and the side each box grows from. */
export const PANEL_RESIZE_RAILS = Object.freeze([
  Object.freeze({ id: 'left-panel-stack', edge: 'right' }),
  Object.freeze({ id: 'right-context-rail', edge: 'left' }),
]);
const SCREEN_MARGIN = 8;

function sizePart(value, min, max) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return null;
  return Math.round(Math.max(min, Math.min(Math.max(min, Number(max)), n)));
}

/** The floor for one box. */
export function panelSizeMin(panelId) {
  return PANEL_SIZE_MIN_BY_ID[panelId] || PANEL_SIZE_MIN;
}

/**
 * A size kept inside the room on screen and above the floor. A part never
 * set stays null (the box keeps its own size there).
 * @param {{width?: number|null, height?: number|null}|null} size
 * @param {{width: number, height: number}} room
 * @param {{width: number, height: number}} [min]
 */
export function clampPanelSize(size, room, min = PANEL_SIZE_MIN) {
  return {
    width: sizePart(size?.width, min.width, room?.width),
    height: sizePart(size?.height, min.height, room?.height),
  };
}

/** A stored size, or null when there is none worth using. */
export function parseStoredPanelSize(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const value = JSON.parse(raw);
    const width = Number(value?.width);
    const height = Number(value?.height);
    const size = {
      width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
      height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    };
    return size.width === null && size.height === null ? null : size;
  } catch {
    return null;
  }
}

/**
 * The size a pointer drag asks for: the free edge follows the pointer (to
 * the right for a left-stack box, to the left for a right-rail box).
 */
export function draggedPanelSize(start, dx, dy, edge = 'right') {
  return {
    width: start.width + (edge === 'left' ? -dx : dx),
    height: start.height + dy,
  };
}

/** The size an arrow key asks for; the horizontal keys move the free edge. */
export function keyedPanelSize(
  key,
  current,
  { big = false, edge = 'right' } = {},
) {
  const step = PANEL_SIZE_STEP * (big ? 4 : 1);
  const width = Number(current?.width) || 0;
  const height = Number(current?.height) || 0;
  const grow = edge === 'left' ? -1 : 1;
  if (key === 'ArrowRight') return { width: width + grow * step, height };
  if (key === 'ArrowLeft') return { width: width - grow * step, height };
  if (key === 'ArrowDown') return { width, height: height + step };
  if (key === 'ArrowUp') return { width, height: height - step };
  return null;
}

/** The room from a box's fixed corner to the screen's edges. */
export function panelRoom(rect, viewport, edge = 'right') {
  return {
    width:
      edge === 'left'
        ? rect.right - SCREEN_MARGIN
        : viewport.width - rect.left - SCREEN_MARGIN,
    height: viewport.height - rect.top - SCREEN_MARGIN,
  };
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * Give every box in the rails its grip, now and as boxes join a rail.
 * @param {{document?: Document, storage?: Storage|null, signal?: AbortSignal}} [options]
 * @returns {{destroy: () => void, grips: Map<string, HTMLElement>}|null}
 */
export function installPanelCornerResize({
  document: doc = globalThis.document,
  storage = defaultStorage(),
  signal,
} = {}) {
  if (!doc?.getElementById || signal?.aborted) return null;
  const win = doc.defaultView || globalThis;
  const grips = new Map();
  // The size each box was given, before the screen clamped it: a window
  // made larger again gets it back.
  const wanted = new Map();
  const removers = [];
  let drag = null;

  const listen = (target, type, fn, options) => {
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(type, fn, options);
    removers.push(() => target.removeEventListener(type, fn, options));
  };
  const viewport = () => ({
    width: Number(win.innerWidth) || 1280,
    height: Number(win.innerHeight) || 800,
  });
  const keyOf = (panel) => `${PANEL_SIZE_KEY_PREFIX}${panel.id}`;

  const apply = (panel, edge, size, { save = false } = {}) => {
    const style = panel.style;
    if (!style) return;
    // A closed box is only its tab: its size is kept to the window and fitted
    // again where the box opens (watchOpening).
    const room = panel.classList.contains('collapsed')
      ? { width: viewport().width - 16, height: viewport().height - 16 }
      : panelRoom(panel.getBoundingClientRect(), viewport(), edge);
    const fitted = clampPanelSize(size, room, panelSizeMin(panel.id));
    if (fitted.width === null) style.removeProperty('--panel-user-width');
    else style.setProperty('--panel-user-width', `${fitted.width}px`);
    if (fitted.height === null) style.removeProperty('--panel-user-height');
    else style.setProperty('--panel-user-height', `${fitted.height}px`);
    panel.classList.toggle('panel-user-wide', fitted.width !== null);
    panel.classList.toggle('panel-user-sized', fitted.height !== null);
    panel.dataset.userSize =
      fitted.width === null && fitted.height === null ? '' : 'set';
    if (!save) return;
    if (fitted.width === null && fitted.height === null)
      wanted.delete(panel.id);
    else wanted.set(panel.id, fitted);
    try {
      if (fitted.width === null && fitted.height === null)
        storage?.removeItem?.(keyOf(panel));
      else storage?.setItem?.(keyOf(panel), JSON.stringify(fitted));
    } catch {
      /* storage unavailable: the size lasts this visit */
    }
  };

  const stored = (panel) => {
    try {
      return parseStoredPanelSize(storage?.getItem?.(keyOf(panel)));
    } catch {
      return null;
    }
  };

  const current = (panel) => {
    const rect = panel.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };

  const reset = (panel, edge) => {
    drag = null;
    wanted.delete(panel.id);
    panel.classList.remove('panel-resizing-corner');
    apply(panel, edge, null);
    try {
      storage?.removeItem?.(keyOf(panel));
    } catch {
      /* nothing stored */
    }
  };

  // A box opening gets its size fitted to where it opened.
  const opened = new Map();
  const edgeOf = new Map();
  const openingObserver =
    typeof win.MutationObserver === 'function'
      ? new win.MutationObserver((records) => {
          for (const { target: panel } of records) {
            const open = !panel.classList.contains('collapsed');
            if (opened.get(panel.id) === open) continue;
            opened.set(panel.id, open);
            const size = wanted.get(panel.id);
            if (open && size && drag?.panel !== panel)
              apply(panel, edgeOf.get(panel.id) || 'right', size);
          }
        })
      : null;

  const attach = (panel, edge) => {
    if (!panel?.id || grips.has(panel.id) || !panel.dataset?.panelId) return;
    edgeOf.set(panel.id, edge);
    opened.set(panel.id, !panel.classList.contains('collapsed'));
    openingObserver?.observe(panel, {
      attributes: true,
      attributeFilter: ['class'],
    });
    const grip = doc.createElement('button');
    grip.type = 'button';
    grip.className = `panel-corner-resize panel-corner-resize-${edge === 'left' ? 'left' : 'right'}`;
    grip.dataset.resizeFor = panel.id;
    grip.tabIndex = 0;
    const name =
      panel.querySelector?.('.panel-title')?.textContent?.trim() || tl('box');
    // The fork's grip: its words follow the fork locales (tl()).
    grip.setAttribute(
      'aria-label',
      tl(
        'Resize {name}: drag the corner or use the arrow keys; double-click for its own size',
        { name },
      ),
    );
    grip.title = tl('Drag to resize · double-click for the default size');
    panel.appendChild(grip);
    grips.set(panel.id, grip);
    const size = stored(panel);
    if (size) {
      wanted.set(panel.id, size);
      apply(panel, edge, size);
    }

    listen(grip, 'pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      drag = {
        panel,
        edge,
        x: event.clientX,
        y: event.clientY,
        start: current(panel),
      };
      try {
        grip.setPointerCapture?.(event.pointerId);
      } catch {
        /* capture is a nicety */
      }
      panel.classList.add('panel-resizing-corner');
    });
    listen(grip, 'pointermove', (event) => {
      if (drag?.panel !== panel) return;
      apply(
        panel,
        edge,
        draggedPanelSize(
          drag.start,
          event.clientX - drag.x,
          event.clientY - drag.y,
          edge,
        ),
      );
    });
    const end = () => {
      if (drag?.panel !== panel) return;
      drag = null;
      panel.classList.remove('panel-resizing-corner');
      const read = (name) =>
        parseFloat(panel.style.getPropertyValue(name) || '');
      apply(
        panel,
        edge,
        {
          width: read('--panel-user-width'),
          height: read('--panel-user-height'),
        },
        { save: true },
      );
    };
    listen(grip, 'pointerup', end);
    listen(grip, 'pointercancel', end);
    listen(grip, 'lostpointercapture', end);
    listen(grip, 'click', (event) => event.stopPropagation?.());
    listen(grip, 'keydown', (event) => {
      const next = keyedPanelSize(event.key, current(panel), {
        big: event.shiftKey,
        edge,
      });
      if (!next) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      apply(panel, edge, next, { save: true });
    });
    listen(grip, 'dblclick', (event) => {
      event.stopPropagation?.();
      reset(panel, edge);
    });
  };

  const scan = () => {
    for (const rail of PANEL_RESIZE_RAILS) {
      const host = doc.getElementById(rail.id);
      for (const panel of host?.children || [])
        if (panel.dataset?.panelId) attach(panel, rail.edge);
    }
  };
  scan();

  // Boxes that join a rail later (a box moved between rails keeps its grip;
  // its side follows the rail it is in now).
  const observers = [];
  if (typeof win.MutationObserver === 'function') {
    for (const rail of PANEL_RESIZE_RAILS) {
      const host = doc.getElementById(rail.id);
      if (!host) continue;
      const observer = new win.MutationObserver(() => {
        for (const panel of host.children)
          if (panel.dataset?.panelId) {
            const grip = grips.get(panel.id);
            if (grip) {
              edgeOf.set(panel.id, rail.edge);
              grip.classList.toggle(
                'panel-corner-resize-left',
                rail.edge === 'left',
              );
              grip.classList.toggle(
                'panel-corner-resize-right',
                rail.edge !== 'left',
              );
            } else attach(panel, rail.edge);
          }
      });
      observer.observe(host, { childList: true });
      observers.push(observer);
    }
  }

  // A smaller window keeps every sized box on screen.
  listen(win, 'resize', () => {
    for (const rail of PANEL_RESIZE_RAILS) {
      const host = doc.getElementById(rail.id);
      for (const panel of host?.children || []) {
        const size = wanted.get(panel.id);
        if (grips.has(panel.id) && size) apply(panel, rail.edge, size);
      }
    }
  });

  const destroy = () => {
    for (const remove of removers.splice(0)) remove();
    for (const observer of observers.splice(0)) observer.disconnect();
    openingObserver?.disconnect();
    for (const grip of grips.values()) grip.remove?.();
    grips.clear();
  };
  signal?.addEventListener?.('abort', destroy, { once: true });
  return { destroy, grips };
}
