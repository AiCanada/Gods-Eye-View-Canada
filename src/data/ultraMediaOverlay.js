/**
 * The Ultra cell's saved photos and videos on the map (owner ruling,
 * 2026-10-08): up to three photos stacked to the left of the cell and up to
 * three videos stacked to its right, each the size of the cell's live card
 * to start with. These are page elements pinned to the cell's spot on the
 * screen, not pictures drawn into the globe, so a video plays as a video and
 * each tile can be handled:
 *  - drag its top-right corner to resize it;
 *  - double-click it to make it bigger, and again to make it smaller;
 *  - click it once to show it in the CCTV viewer on the right
 *    (ULTRA_MEDIA_VIEW_EVENT).
 * Each tile's size is kept per photo or video in this browser.
 */
import { ultraMediaUrl } from '../deviceFeedsCore.mjs';

/** At most this many photos, and this many videos, on the map at once. */
export const ULTRA_MEDIA_ON_MAP_MAX = 3;
/** A tile starts at the size of the cell's live card on the map. */
export const ULTRA_MEDIA_TILE_W = 96;
export const ULTRA_MEDIA_TILE_H = 54;
export const ULTRA_MEDIA_SCALE_MIN = 0.6;
export const ULTRA_MEDIA_SCALE_MAX = 6;
/** Double-click: up to this size, and back down to the start. */
export const ULTRA_MEDIA_SCALE_BIG = 2.5;
export const ULTRA_MEDIA_SCALES_KEY = 'ultra-media-scales';
/** One click shows a photo or video in the CCTV viewer: detail { name, kind }. */
export const ULTRA_MEDIA_VIEW_EVENT = 'gev:ultra-media-view';
/** How long a click waits to see whether it becomes a double-click. */
const CLICK_WAIT_MS = 260;

/** A usable size, or 1. */
export function clampMediaScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(ULTRA_MEDIA_SCALE_MAX, Math.max(ULTRA_MEDIA_SCALE_MIN, n));
}

/** Double-click: a tile at its start size gets big; a bigger one goes back. */
export function toggledMediaScale(scale) {
  return clampMediaScale(scale) < (1 + ULTRA_MEDIA_SCALE_BIG) / 2
    ? ULTRA_MEDIA_SCALE_BIG
    : 1;
}

/**
 * The size after dragging the top-right corner from (startX, startY) to
 * (x, y): right and up grow it, left and down shrink it.
 */
export function draggedMediaScale({ startScale, startX, startY, x, y }) {
  const base = clampMediaScale(startScale);
  const width = ULTRA_MEDIA_TILE_W * base;
  const height = ULTRA_MEDIA_TILE_H * base;
  const growth =
    ((width + (x - startX)) / width + (height - (y - startY)) / height) / 2;
  const raw = base * growth;
  // Dragged past nothing (a negative size) is the smallest size, not a reset.
  if (!Number.isFinite(raw)) return base;
  return Math.min(ULTRA_MEDIA_SCALE_MAX, Math.max(ULTRA_MEDIA_SCALE_MIN, raw));
}

/**
 * Up to ULTRA_MEDIA_ON_MAP_MAX names from the ticked list, starting at
 * `start` and wrapping round: the ones on the map now.
 */
export function mediaWindow(names, start = 0, max = ULTRA_MEDIA_ON_MAP_MAX) {
  const list = Array.isArray(names) ? names : [];
  if (!list.length) return [];
  const first =
    ((Math.floor(Number(start) || 0) % list.length) + list.length) %
    list.length;
  const out = [];
  for (let i = 0; i < Math.min(max, list.length); i += 1)
    out.push(list[(first + i) % list.length]);
  return out;
}

function readScales(storage) {
  try {
    const value = JSON.parse(storage?.getItem(ULTRA_MEDIA_SCALES_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

/**
 * The tiles. `place({x, y, visible})` puts them beside the cell's spot on the
 * screen each frame; `setMedia({photos, videos})` says which are on the map.
 */
export function createUltraMediaOverlay({
  container,
  documentRef = typeof document === 'undefined' ? null : document,
  windowRef = typeof window === 'undefined' ? null : window,
  storage = (() => {
    try {
      return windowRef?.localStorage || null;
    } catch {
      return null;
    }
  })(),
} = {}) {
  if (!container || !documentRef?.createElement) {
    return { setMedia() {}, place() {}, destroy() {}, tiles: () => [] };
  }
  const scales = readScales(storage);
  const saveScales = () => {
    try {
      storage?.setItem(ULTRA_MEDIA_SCALES_KEY, JSON.stringify(scales));
    } catch {
      /* The size lasts this visit only. */
    }
  };
  const root = documentRef.createElement('div');
  root.className = 'ultra-media-overlay';
  root.hidden = true;
  const columns = {
    photo: documentRef.createElement('div'),
    clip: documentRef.createElement('div'),
  };
  columns.photo.className = 'ultra-media-column ultra-media-photos';
  columns.clip.className = 'ultra-media-column ultra-media-videos';
  root.appendChild(columns.photo);
  root.appendChild(columns.clip);
  container.appendChild(root);
  /** name -> {tile, media, kind} */
  const tiles = new Map();

  const sizeTile = (entry) => {
    const scale = clampMediaScale(scales[entry.name]);
    entry.media.style.width = `${Math.round(ULTRA_MEDIA_TILE_W * scale)}px`;
    entry.media.style.height = `${Math.round(ULTRA_MEDIA_TILE_H * scale)}px`;
  };

  const makeTile = (name, kind) => {
    const tile = documentRef.createElement('div');
    tile.className = `ultra-media-tile ultra-media-${kind}`;
    tile.dataset.name = name;
    const title = documentRef.createElement('div');
    title.className = 'ultra-media-title';
    const media = documentRef.createElement(kind === 'clip' ? 'video' : 'img');
    media.className = 'ultra-media-picture';
    if (kind === 'clip') {
      media.muted = true;
      media.loop = true;
      media.autoplay = true;
      media.playsInline = true;
      media.preload = 'auto';
      media.setAttribute?.('muted', '');
      media.setAttribute?.('playsinline', '');
    } else {
      media.alt = 'Ultra cell photo';
      media.draggable = false;
    }
    media.src = ultraMediaUrl(name);
    const grip = documentRef.createElement('div');
    grip.className = 'ultra-media-resize';
    grip.title = 'Drag to resize';
    tile.appendChild(title);
    tile.appendChild(media);
    tile.appendChild(grip);
    const entry = { name, kind, tile, media, title, grip };
    sizeTile(entry);
    if (kind === 'clip') media.play?.()?.catch?.(() => {});

    // Top-right corner: drag to resize.
    let press = null;
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      press = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startScale: clampMediaScale(scales[name]),
      };
      try {
        grip.setPointerCapture?.(event.pointerId);
      } catch {
        /* It still works while the pointer stays over it. */
      }
    });
    grip.addEventListener('pointermove', (event) => {
      if (!press || event.pointerId !== press.id) return;
      event.preventDefault();
      scales[name] = draggedMediaScale({
        ...press,
        x: event.clientX,
        y: event.clientY,
      });
      sizeTile(entry);
    });
    const endPress = (event) => {
      if (!press || event.pointerId !== press.id) return;
      press = null;
      saveScales();
    };
    grip.addEventListener('pointerup', endPress);
    grip.addEventListener('pointercancel', endPress);

    // Double-click: bigger, then smaller. One click: the CCTV viewer.
    let clickTimer = null;
    tile.addEventListener('click', (event) => {
      if (event.target === grip) return;
      if (clickTimer !== null) return;
      clickTimer = windowRef?.setTimeout?.(() => {
        clickTimer = null;
        try {
          windowRef?.dispatchEvent?.(
            new CustomEvent(ULTRA_MEDIA_VIEW_EVENT, { detail: { name, kind } }),
          );
        } catch {
          /* No CustomEvent: nothing to show it in. */
        }
      }, CLICK_WAIT_MS);
    });
    tile.addEventListener('dblclick', (event) => {
      event.preventDefault();
      if (clickTimer !== null) windowRef?.clearTimeout?.(clickTimer);
      clickTimer = null;
      scales[name] = toggledMediaScale(scales[name]);
      sizeTile(entry);
      saveScales();
    });
    return entry;
  };

  const drop = (entry) => {
    if (entry.kind === 'clip') {
      try {
        entry.media.pause?.();
        entry.media.removeAttribute?.('src');
        entry.media.load?.();
      } catch {
        /* already gone */
      }
    }
    entry.tile.remove?.();
  };

  return {
    /** Which photos and videos are on the map, with their place in the list. */
    setMedia({
      photos = [],
      videos = [],
      photoTotal = 0,
      videoTotal = 0,
      photoStart = 0,
      videoStart = 0,
    } = {}) {
      const wanted = new Map();
      photos.slice(0, ULTRA_MEDIA_ON_MAP_MAX).forEach((name, i) =>
        wanted.set(name, {
          kind: 'photo',
          label: `PHOTO ${((photoStart + i) % Math.max(1, photoTotal)) + 1}/${photoTotal || photos.length}`,
        }),
      );
      videos.slice(0, ULTRA_MEDIA_ON_MAP_MAX).forEach((name, i) =>
        wanted.set(name, {
          kind: 'clip',
          label: `VIDEO ${((videoStart + i) % Math.max(1, videoTotal)) + 1}/${videoTotal || videos.length}`,
        }),
      );
      for (const [name, entry] of [...tiles]) {
        if (wanted.has(name)) continue;
        drop(entry);
        tiles.delete(name);
      }
      for (const kind of ['photo', 'clip']) {
        const order = [...wanted].filter(([, v]) => v.kind === kind);
        for (const [name, { label }] of order) {
          let entry = tiles.get(name);
          if (!entry) {
            entry = makeTile(name, kind);
            tiles.set(name, entry);
          }
          entry.title.textContent = label;
          // Newest at the bottom, next to the cell; the column grows upward.
          columns[kind].appendChild(entry.tile);
        }
      }
      root.hidden = tiles.size === 0;
    },
    /** Beside the cell: photos to its left, videos to its right. */
    place({ x, y, visible }) {
      const show = Boolean(visible) && tiles.size > 0;
      root.hidden = !show;
      if (!show) return;
      root.style.left = `${Math.round(x)}px`;
      root.style.top = `${Math.round(y)}px`;
    },
    tiles: () => [...tiles.values()],
    destroy() {
      for (const entry of tiles.values()) drop(entry);
      tiles.clear();
      root.remove?.();
    },
  };
}
