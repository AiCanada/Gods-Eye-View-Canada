import { registerWorldOverlayPaintLane } from '../overlays/worldOverlay.js';
import { forEachTrafficDot } from './traffic.js';
import { forEachProjectedMarker } from './cctvTrafficProjection.js';

/**
 * Street traffic and its ID tags drawn OVER the CCTV camera views.
 *
 * The thumbnails are painted on the 2D overlay canvas, which composites above
 * the WebGL scene, and detection's `VEH-0000` tags are painted in the overlay's
 * lowest lane, so both a vehicle and its tag vanished under a card. They are
 * repainted here, after the cards.
 *
 * A thumbnail is a window onto the map: the card stands over the area its
 * camera looks at, and the vehicles shown on it are the ones driving behind it
 * on the map at that moment, exactly as they show through the open monitor
 * plane. Projecting vehicles through the camera's recorded pose was tried and
 * dropped: most poses are estimates, so the dots landed in places that matched
 * neither the picture nor the map and read as random.
 *
 * Markers on an open monitor picture (cctvTrafficProjection.js) get the same
 * ID tags.
 *
 * Every dot on a camera view carries its identifier. A vehicle whose tag has no
 * room on a thumbnail (it would cover another tag or fall outside the picture)
 * is left off rather than drawn as an anonymous dot.
 */

/** Painted ahead of the `tracked` lane: after every thumbnail and every selected card. */
const LANE = 'tracked';
const LANE_ID = 'cctv-thumbnail-traffic';
const CCTV_SOURCE = 'cctv';
const MIN_RADIUS = 2;
const MAX_RADIUS = 5;
const OUTLINE = 'rgba(0, 0, 0, 0.85)';
const TAG_FONT = '9px "JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace';
const TAG_BG = 'rgba(8, 18, 26, 0.82)';
const TAG_TEXT = 'rgba(170, 242, 255, 0.98)';
const BRACKET = 'rgba(200, 245, 255, 0.95)';
/**
 * ID tags across every camera view in one frame. A vehicle is only ever drawn
 * WITH its tag, so this is also the most vehicles the camera views can carry.
 */
export const CCTV_VIEW_MAX_TAGS = 1000;

/** @type {Array<object>} Pooled picture records. */
const _pictures = [];
const _cssByColor = new WeakMap();
const _diag = { cards: 0, drawn: 0, tags: 0 };
function cssFor(color) {
  if (!color || typeof color !== 'object') return '#ffffff';
  let css = _cssByColor.get(color);
  if (!css) {
    css = typeof color.toCssColorString === 'function' ? color.toCssColorString() : '#ffffff';
    _cssByColor.set(color, css);
  }
  return css;
}

/** The tag detection gives a traffic slot. */
export function vehicleTag(index) {
  return `VEH-${String(Math.max(0, Math.floor(Number(index) || 0))).padStart(4, '0')}`;
}

/**
 * The picture area of each CCTV card painted this frame, in canvas units.
 * @param {object} frame Custom paint frame (paintRects / paintRectCount).
 * @returns {number} How many pictures were found.
 */
export function collectThumbnailPictures(frame) {
  let count = 0;
  const rects = frame?.paintRects;
  const total = Math.min(frame?.paintRectCount || 0, rects?.length || 0);
  for (let i = 0; i < total; i += 1) {
    const rect = rects[i];
    const entry = rect?.entry;
    if (!entry || rect.sourceId !== CCTV_SOURCE || entry.variant !== 'thumbnail') continue;
    const layout = entry._overlayLayout || {};
    const padX = Number.isFinite(layout.padX) ? layout.padX : 4;
    const padY = Number.isFinite(layout.padY) ? layout.padY : 4;
    const thumbW = layout.thumbW || Number(entry.thumbnailWidth) || 96;
    const thumbH = layout.thumbH || Number(entry.thumbnailHeight) || 54;
    const scale = rect.w / (thumbW + padX * 2) || 1;
    // A card scrolled off the canvas has nothing to draw on.
    if (rect.x > (frame.width || Infinity) || rect.y > (frame.height || Infinity)
      || rect.x + rect.w < 0 || rect.y + rect.h < 0) continue;
    const picture = _pictures[count] || (_pictures[count] = {});
    picture.x = rect.x + padX * scale;
    picture.y = rect.y + padY * scale;
    picture.w = thumbW * scale;
    picture.h = thumbH * scale;
    // A card turned along its road: vehicles are tested and placed in its own
    // unturned frame, then drawn back in the turned one.
    picture.rot = Number.isFinite(rect.rotation) ? rect.rotation : 0;
    picture.px = rect.anchorX;
    picture.py = rect.anchorY;
    picture.cos = Math.cos(picture.rot);
    picture.sin = Math.sin(picture.rot);
    picture.placed = picture.placed || [];
    picture.placed.length = 0;
    count += 1;
  }
  return count;
}

function drawVehicle(ctx, sx, sy, point) {
  const radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, (Number(point?.pixelSize) || 5) / 2));
  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, Math.PI * 2);
  ctx.fillStyle = cssFor(point?.color);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
}

/**
 * A road camera's picture is sky above and road below. A vehicle passing behind
 * the TOP of a card would be painted into that sky, so its height inside the
 * picture is squeezed into the road band: it keeps its left-right position and
 * its order, and never floats above the horizon.
 */
export const THUMBNAIL_ROAD_BAND_TOP = 0.45;
const TAG_HALF = 6;
const TAG_BOX_H = 11;

/**
 * Where a vehicle's tag box goes: beside the vehicle, kept inside `bounds` and
 * clear of the tags already placed there.
 * @returns {{text: string, bx: number, by: number, boxW: number}|null} Null when there is no room.
 */
function placeTag(ctx, sx, sy, index, bounds, placed) {
  const text = vehicleTag(index);
  ctx.font = TAG_FONT;
  const textW = Math.ceil(ctx.measureText?.(text)?.width || text.length * 5.5);
  const boxW = textW + 6;
  let bx = sx + TAG_HALF + 3;
  let by = sy - TAG_BOX_H - 2;
  if (bounds) {
    if (boxW > bounds.w) return null;
    if (bx + boxW > bounds.x + bounds.w) bx = sx - TAG_HALF - 3 - boxW;
    if (bx < bounds.x) bx = bounds.x;
    if (by < bounds.y) by = sy + TAG_HALF + 2;
    if (by + TAG_BOX_H > bounds.y + bounds.h) by = bounds.y + bounds.h - TAG_BOX_H;
  }
  if (placed) {
    for (let i = 0; i < placed.length; i += 1) {
      const o = placed[i];
      if (bx < o.bx + o.boxW && bx + boxW > o.bx && by < o.by + TAG_BOX_H && by + TAG_BOX_H > o.by) return null;
    }
  }
  return { text, bx, by, boxW };
}

/** Corner brackets around the vehicle plus its `VEH-0000` tag box. */
function paintTag(ctx, sx, sy, tag) {
  const arm = 3;
  ctx.strokeStyle = BRACKET;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const cx = sx + dx * TAG_HALF;
    const cy = sy + dy * TAG_HALF;
    ctx.moveTo(cx - dx * arm, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy - dy * arm);
  }
  ctx.stroke();
  ctx.fillStyle = TAG_BG;
  ctx.fillRect(tag.bx, tag.by, tag.boxW, TAG_BOX_H);
  ctx.fillStyle = BRACKET;
  ctx.fillRect(tag.bx, tag.by, 1.5, TAG_BOX_H);
  ctx.fillStyle = TAG_TEXT;
  ctx.font = TAG_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(tag.text, tag.bx + 4, tag.by + TAG_BOX_H / 2 + 0.5);
}

/**
 * Repaint vehicles and their ID tags over the CCTV camera views.
 * @param {object} frame Custom paint frame from the overlay host.
 * @param {(visit: (point: object, index: number) => void) => void} [forEachDot] Test seam.
 * @param {(visit: (position: object, index: number) => void) => void} [forEachMarker] Test seam.
 * @returns {number} Vehicles painted on thumbnails.
 */
export function paintTrafficOverThumbnails(
  frame,
  forEachDot = forEachTrafficDot,
  forEachMarker = forEachProjectedMarker,
) {
  _diag.cards = 0;
  _diag.drawn = 0;
  _diag.tags = 0;
  const ctx = frame?.ctx;
  const vp = frame?.viewProjectionMatrix;
  if (!ctx || !vp) return 0;
  const { width, height, occluder } = frame;
  const toScreen = (position, out) => {
    const { x: px, y: py, z: pz } = position;
    const clipW = vp[3] * px + vp[7] * py + vp[11] * pz + vp[15];
    if (clipW <= 0) return false;
    const invW = 1 / clipW;
    out.sx = ((vp[0] * px + vp[4] * py + vp[8] * pz + vp[12]) * invW * 0.5 + 0.5) * width;
    out.sy = (0.5 - (vp[1] * px + vp[5] * py + vp[9] * pz + vp[13]) * invW * 0.5) * height;
    return true;
  };
  const screen = { sx: 0, sy: 0 };

  // ID tags for the markers on an open monitor picture.
  // Every marker on an open monitor picture is tagged: no anonymous dots.
  let tagsLeft = CCTV_VIEW_MAX_TAGS;
  forEachMarker((position, index) => {
    if (tagsLeft <= 0 || !toScreen(position, screen)) return;
    paintTag(ctx, screen.sx, screen.sy, placeTag(ctx, screen.sx, screen.sy, index, null, null));
    tagsLeft -= 1;
  });
  _diag.tags += CCTV_VIEW_MAX_TAGS - tagsLeft;

  const cards = collectThumbnailPictures(frame);
  _diag.cards = cards;
  if (cards === 0) return 0;

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i < cards; i += 1) {
    const p = _pictures[i];
    // A turned picture can reach its own diagonal from the pivot in any direction.
    const reach = p.rot ? Math.hypot(p.w, p.h) + Math.hypot(p.px - (p.x + p.w / 2), p.py - (p.y + p.h / 2)) : 0;
    const loX = p.rot ? p.px - reach : p.x;
    const loY = p.rot ? p.py - reach : p.y;
    const hiX = p.rot ? p.px + reach : p.x + p.w;
    const hiY = p.rot ? p.py + reach : p.y + p.h;
    if (loX < minX) minX = loX;
    if (loY < minY) minY = loY;
    if (hiX > maxX) maxX = hiX;
    if (hiY > maxY) maxY = hiY;
  }

  let drawn = 0;
  forEachDot((point, index) => {
    if (!point || point.show === false) return;
    if (!toScreen(point.position, screen)) return;
    const { sx, sy } = screen;
    if (sx < minX || sx > maxX || sy < minY || sy > maxY) return;
    for (let i = 0; i < cards; i += 1) {
      const p = _pictures[i];
      let lx = sx;
      let ly = sy;
      if (p.rot) {
        const dx = sx - p.px;
        const dy = sy - p.py;
        lx = p.px + dx * p.cos + dy * p.sin;
        ly = p.py - dx * p.sin + dy * p.cos;
      }
      if (lx < p.x || lx > p.x + p.w || ly < p.y || ly > p.y + p.h) continue;
      if (tagsLeft <= 0) return;
      if (occluder?.isPointVisible && !occluder.isPointVisible(point.position)) return;
      const roadY = p.y + p.h * (THUMBNAIL_ROAD_BAND_TOP
        + (1 - THUMBNAIL_ROAD_BAND_TOP) * ((ly - p.y) / p.h));
      let drawX = lx;
      let drawY = roadY;
      if (p.rot) {
        const dx = lx - p.px;
        const dy = roadY - p.py;
        drawX = p.px + dx * p.cos - dy * p.sin;
        drawY = p.py + dx * p.sin + dy * p.cos;
      }
      // No room for the identifier means no dot either. A turned picture has no
      // upright box to keep the tag inside, so only overlap is checked there.
      const tag = placeTag(ctx, drawX, drawY, index, p.rot ? null : p, p.placed);
      if (!tag) return;
      p.placed.push(tag);
      drawVehicle(ctx, drawX, drawY, point);
      paintTag(ctx, drawX, drawY, tag);
      drawn += 1;
      tagsLeft -= 1;
      _diag.tags += 1;
      return;
    }
  });
  _diag.drawn = drawn;
  return drawn;
}

let _lane = null;

/** Turn the camera-view traffic pass on or off with the CCTV layer. */
export function setCctvThumbnailTrafficActive(active) {
  if (!_lane && active) {
    _lane = registerWorldOverlayPaintLane(LANE, (frame) => paintTrafficOverThumbnails(frame), {
      id: LANE_ID,
      active: true,
    });
    return;
  }
  _lane?.setActive(active === true);
}

/** Live counters for QA: cards seen, vehicles and tags painted last frame. */
export function getCctvThumbnailTrafficDiagnostics() {
  return { ..._diag, registered: Boolean(_lane) };
}
