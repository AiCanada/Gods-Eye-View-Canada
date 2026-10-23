/**
 * The GLOBAL ABUNDANCE MAP on the globe (owner request 2026-10-22: "display
 * Global abundance on MAP … by country/state/province/city"). The tab says
 * what to draw (the `abundance:view` event: the level, each unit's score
 * and colour, the grid links, the selected unit's card); this loads that
 * level's shapes (src/abundanceShapes.js), colours countries and states or
 * provinces as ground polygons and cities as points, draws the grid links
 * as arcs, and tells the tab what the pointer rests on or clicks (the
 * `abundance:pick` event). It draws through its own primitives on the
 * viewer, not a map layer, its card through the shared world-overlay host
 * (never Cesium labels), and removes everything when the tab goes.
 */
import * as Cesium from 'cesium';
import {
  ABUNDANCE_CARD_EVENT,
  ABUNDANCE_NO_DATA_COLOR,
  ABUNDANCE_PICK_EVENT,
  ABUNDANCE_VIEW_EVENT,
  cleanLevel,
} from './abundanceCore.mjs';
import { loadAbundanceShapes } from './abundanceShapes.js';
import { isPointerFree } from './data/inputOwnership.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from './overlays/worldOverlay.js';

export { ABUNDANCE_CARD_EVENT, ABUNDANCE_PICK_EVENT, ABUNDANCE_VIEW_EVENT };
/** The world-overlay source the selected unit's card is published under. */
export const ABUNDANCE_CARD_SOURCE_ID = 'abundance';
const FILL_ALPHA = 0.55;
const SELECTED_ALPHA = 0.9;
const NO_DATA_ALPHA = 0.22;
const LINK_COLOR = '#d7f3ff';
const HOVER_THROTTLE_MS = 120;
const READY_POLL_MS = 250;

const OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/** The event's detail, cleaned: a level, the units by id, the links with both ends placed. */
export function cleanView(detail) {
  const units = new Map();
  for (const u of Array.isArray(detail?.units) ? detail.units : []) {
    if (typeof u?.id !== 'string' && typeof u?.id !== 'number') continue;
    units.set(String(u.id), {
      score: Number.isFinite(Number(u.score)) ? Number(u.score) : null,
      color:
        typeof u.color === 'string' && /^#[0-9a-f]{6}$/i.test(u.color)
          ? u.color
          : ABUNDANCE_NO_DATA_COLOR,
    });
  }
  const placed = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon);
  const links = (Array.isArray(detail?.links) ? detail.links : []).filter(
    (l) => placed(l?.from) && placed(l?.to),
  );
  return {
    level: cleanLevel(detail?.level),
    show: detail?.show !== false,
    units,
    links,
    ...cleanCard(detail),
  };
}

/** The selected unit and its card from an event's detail. */
export function cleanCard(detail) {
  const placed = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon);
  const card =
    detail?.card && placed(detail.card) && typeof detail.card.title === 'string'
      ? {
          id: String(detail.card.id ?? ''),
          lat: detail.card.lat,
          lon: detail.card.lon,
          title: detail.card.title,
          details: Array.isArray(detail.card.details)
            ? detail.card.details.map(String)
            : [],
          accent:
            typeof detail.card.accent === 'string' ? detail.card.accent : null,
        }
      : null;
  return {
    selected:
      typeof detail?.selected === 'string' ||
      typeof detail?.selected === 'number'
        ? String(detail.selected)
        : null,
    card,
  };
}

/** A city's dot: 3 px for a village, 12 px for a megacity. */
export function pointSize(pop) {
  const p = Number(pop);
  if (!Number.isFinite(p) || p <= 0) return 3;
  return Math.max(3, Math.min(12, 3 + 1.6 * Math.max(0, Math.log10(p) - 3)));
}

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/**
 * A great-circle arc from a to b in [lon, lat, height] steps, lifted in the
 * middle in proportion to its length, so a link reads as a route and not a
 * line through the ground.
 */
export function arcPositions(a, b, steps = 24) {
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lon);
  const φ2 = toRad(b.lat);
  const λ2 = toRad(b.lon);
  const x1 = Math.cos(φ1) * Math.cos(λ1);
  const y1 = Math.cos(φ1) * Math.sin(λ1);
  const z1 = Math.sin(φ1);
  const x2 = Math.cos(φ2) * Math.cos(λ2);
  const y2 = Math.cos(φ2) * Math.sin(λ2);
  const z2 = Math.sin(φ2);
  const dot = Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2));
  const omega = Math.acos(dot);
  const km = omega * 6371;
  const rise = Math.min(1_500_000, Math.max(20_000, km * 1000 * 0.12));
  const out = [];
  const n = Math.max(2, Math.round(steps));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let x;
    let y;
    let z;
    if (omega < 1e-9) {
      x = x1;
      y = y1;
      z = z1;
    } else {
      const s1 = Math.sin((1 - t) * omega) / Math.sin(omega);
      const s2 = Math.sin(t * omega) / Math.sin(omega);
      x = s1 * x1 + s2 * x2;
      y = s1 * y1 + s2 * y2;
      z = s1 * z1 + s2 * z2;
    }
    const lat = toDeg(Math.atan2(z, Math.hypot(x, y)));
    const lon = toDeg(Math.atan2(y, x));
    out.push([lon, lat, Math.sin(Math.PI * t) * rise]);
  }
  return out;
}

/** The unit id a pick names, from the part id the shapes were drawn under. */
export function pickedUnitId(picked) {
  const raw = picked?.id ?? picked?.primitive?.id;
  const id =
    typeof raw === 'string' || typeof raw === 'number'
      ? String(raw)
      : typeof raw?.id === 'string' || typeof raw?.id === 'number'
        ? String(raw.id)
        : null;
  return id ? id.split('|')[0] : null;
}

/**
 * @param {object} options
 * @param {{viewer: object}} options.dataManager
 * @param {AbortSignal} [options.signal]
 */
export function initAbundanceOverlay({
  dataManager,
  signal,
  documentRef = globalThis.document,
  cesium = Cesium,
  loadShapes = loadAbundanceShapes,
  overlayHost = OVERLAY_HOST,
  pointerFree = isPointerFree,
  // Wrapped: a browser's timer functions throw "Illegal invocation" when
  // called as methods of another object.
  timers = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
  },
  now = () => Date.now(),
  hoverThrottleMs = HOVER_THROTTLE_MS,
} = {}) {
  const viewer = dataManager?.viewer;
  const scene = viewer?.scene;
  if (!scene?.primitives || !documentRef) return null;
  const lines = scene.primitives.add(new cesium.PolylineCollection());
  let view = cleanView(null);
  /** The level drawn: { level, kind, fill?, points?, parts: Map(id → [partId]), byId: Map(id → point) }. */
  let built = null;
  let loading = null;
  let generation = 0;
  let readyTimer = null;
  let cardShown = false;
  let hoverId = null;
  let lastHoverAt = 0;
  let disposed = false;

  const cssColor = (hex, alpha) =>
    cesium.Color.fromCssColorString(hex).withAlpha(alpha);

  const colorOf = (id) => {
    const unit = view.units.get(id);
    if (!unit) return cssColor(ABUNDANCE_NO_DATA_COLOR, NO_DATA_ALPHA);
    const alpha =
      view.selected === id || hoverId === id ? SELECTED_ALPHA : FILL_ALPHA;
    return cssColor(
      unit.score === null ? ABUNDANCE_NO_DATA_COLOR : unit.color,
      unit.score === null ? NO_DATA_ALPHA : alpha,
    );
  };

  const stopReadyPoll = () => {
    if (readyTimer !== null) timers.clearInterval(readyTimer);
    readyTimer = null;
  };

  /** Recolour what is drawn from the view; a polygon fill only once it is ready. */
  const applyColors = () => {
    if (!built) return;
    if (built.points) {
      built.points.show = view.show;
      for (const [id, point] of built.byId) point.color = colorOf(id);
    }
    if (built.fill) {
      built.fill.show = view.show;
      if (!built.fill.ready) {
        if (readyTimer === null)
          readyTimer = timers.setInterval(() => {
            if (disposed || !built?.fill) return stopReadyPoll();
            if (!built.fill.ready) return;
            stopReadyPoll();
            applyColors();
          }, READY_POLL_MS);
        return;
      }
      for (const [id, partIds] of built.parts) {
        const color = colorOf(id);
        for (const partId of partIds) {
          const attributes = built.fill.getGeometryInstanceAttributes(partId);
          if (attributes)
            attributes.color = cesium.ColorGeometryInstanceAttribute.toValue(
              color,
              attributes.color,
            );
        }
      }
    }
    scene.requestRender?.();
  };

  const removeBuilt = () => {
    stopReadyPoll();
    if (!built) return;
    if (built.fill) scene.primitives.remove?.(built.fill);
    if (built.points) scene.primitives.remove?.(built.points);
    built = null;
  };

  const buildPolygons = (data) => {
    const instances = [];
    const parts = new Map();
    for (const shape of data.shapes) {
      const ids = [];
      shape.polygons.forEach((poly, k) => {
        const [outer, ...holes] = poly;
        if (!outer || outer.length < 3) return;
        const partId = `${shape.id}|${k}`;
        ids.push(partId);
        instances.push(
          new cesium.GeometryInstance({
            id: partId,
            geometry: new cesium.PolygonGeometry({
              polygonHierarchy: new cesium.PolygonHierarchy(
                cesium.Cartesian3.fromDegreesArray(outer.flat()),
                holes
                  .filter((h) => h.length >= 3)
                  .map(
                    (h) =>
                      new cesium.PolygonHierarchy(
                        cesium.Cartesian3.fromDegreesArray(h.flat()),
                      ),
                  ),
              ),
              vertexFormat: cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: cesium.ColorGeometryInstanceAttribute.fromColor(
                colorOf(shape.id),
              ),
            },
          }),
        );
      });
      if (ids.length) parts.set(shape.id, ids);
    }
    const onGround =
      typeof cesium.GroundPrimitive?.isSupported === 'function' &&
      cesium.GroundPrimitive.isSupported(scene);
    const Fill = onGround ? cesium.GroundPrimitive : cesium.Primitive;
    const fill = scene.primitives.add(
      new Fill({
        geometryInstances: instances,
        appearance: new cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: true,
        }),
        asynchronous: true,
        allowPicking: true,
        ...(onGround
          ? { classificationType: cesium.ClassificationType.BOTH }
          : {}),
      }),
    );
    fill.show = view.show;
    built = {
      level: data.level,
      kind: 'polygons',
      fill,
      parts,
      byId: new Map(),
    };
  };

  const buildPoints = (data) => {
    const points = scene.primitives.add(new cesium.PointPrimitiveCollection());
    const byId = new Map();
    for (const shape of data.shapes) {
      if (!Number.isFinite(shape.lat) || !Number.isFinite(shape.lon)) continue;
      byId.set(
        shape.id,
        points.add({
          id: shape.id,
          position: cesium.Cartesian3.fromDegrees(shape.lon, shape.lat, 0),
          pixelSize: pointSize(shape.pop),
          color: colorOf(shape.id),
          outlineColor: cssColor('#000000', 0.5),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        }),
      );
    }
    points.show = view.show;
    built = {
      level: data.level,
      kind: 'points',
      points,
      parts: new Map(),
      byId,
    };
  };

  /** The level's shapes drawn once; a later level while they load wins. */
  const ensureLevel = () => {
    if (built?.level === view.level) return Promise.resolve();
    const mine = (generation += 1);
    removeBuilt();
    loading = Promise.resolve(loadShapes(view.level))
      .then((data) => {
        if (disposed || mine !== generation || !data) return;
        if (data.kind === 'points') buildPoints(data);
        else buildPolygons(data);
        applyColors();
        drawLinks();
      })
      .catch(() => {
        /* A failed pack load is retried on the next view. */
      })
      .finally(() => {
        if (mine === generation) loading = null;
      });
    return loading;
  };

  const drawLinks = () => {
    lines.removeAll();
    if (!view.show) return;
    const color = cssColor(LINK_COLOR, 0.7);
    for (const link of view.links)
      lines.add({
        positions: cesium.Cartesian3.fromDegreesArrayHeights(
          arcPositions(link.from, link.to).flat(),
        ),
        width: 2,
        material: cesium.Material.fromType('Color', { color }),
      });
    scene.requestRender?.();
  };

  const publishCard = () => {
    const card = view.show ? view.card : null;
    if (card) {
      overlayHost.setVisible(ABUNDANCE_CARD_SOURCE_ID, true);
      overlayHost.setEntries(
        ABUNDANCE_CARD_SOURCE_ID,
        [
          {
            id: `unit:${card.id}`,
            position: cesium.Cartesian3.fromDegrees(card.lon, card.lat, 0),
            variant: 'card',
            cardStyle: 'tactical',
            collisionGroup: 'ambient-card',
            edgeFade: 'keyhole',
            horizonCull: true,
            terrainOcclusion: false,
            interactive: false,
            gapPx: 10,
            leaderOffsetPx: 6,
            verticalOnly: true,
            viewportMargin: 4,
            title: card.title,
            details: card.details,
            accent: card.accent || LINK_COLOR,
            priority: 1_000_000,
            maxDistance: Number.POSITIVE_INFINITY,
          },
        ],
        { cohortLimit: 1, collisionCapacity: 1, moving: false },
      );
      cardShown = true;
    } else if (cardShown) {
      overlayHost.clearSource(ABUNDANCE_CARD_SOURCE_ID);
      overlayHost.setVisible(ABUNDANCE_CARD_SOURCE_ID, false);
      cardShown = false;
    }
  };

  const onView = (event) => {
    view = cleanView(event?.detail);
    publishCard();
    if (built?.level === view.level) {
      applyColors();
      drawLinks();
    } else void ensureLevel();
  };

  /** Recolour one unit from the view (a selection or hover change). */
  const recolor = (id) => {
    if (!id || !built) return;
    if (built.kind === 'polygons') {
      if (!built.fill?.ready || !built.parts.has(id)) return;
      for (const partId of built.parts.get(id)) {
        const attributes = built.fill.getGeometryInstanceAttributes(partId);
        if (attributes)
          attributes.color = cesium.ColorGeometryInstanceAttribute.toValue(
            colorOf(id),
            attributes.color,
          );
      }
    } else {
      const point = built.byId.get(id);
      if (point) point.color = colorOf(id);
    }
  };

  const onCard = (event) => {
    const before = view.selected;
    view = { ...view, ...cleanCard(event?.detail) };
    publishCard();
    recolor(before);
    recolor(view.selected);
    scene.requestRender?.();
  };

  const tell = (id, hover) => {
    documentRef.dispatchEvent?.(
      new CustomEvent(ABUNDANCE_PICK_EVENT, {
        detail: { id, level: view.level, hover },
      }),
    );
  };

  const pickAt = (position) => {
    if (!built || !position) return null;
    let picked = null;
    try {
      picked = scene.pick(position);
    } catch {
      picked = null;
    }
    const id = pickedUnitId(picked);
    return id && (built.parts.has(id) || built.byId.has(id)) ? id : null;
  };

  const onMove = (movement) => {
    if (!view.show || !built) return;
    const t = now();
    if (t - lastHoverAt < hoverThrottleMs) return;
    lastHoverAt = t;
    const id = pickAt(movement?.endPosition);
    if (id === hoverId) return;
    const before = hoverId;
    hoverId = id;
    recolor(before);
    recolor(id);
    scene.requestRender?.();
    tell(id, true);
  };

  const onClick = (click) => {
    if (!view.show || !built || !pointerFree()) return;
    const id = pickAt(click?.position);
    if (id) tell(id, false);
  };

  let handler = null;
  if (scene.canvas && typeof cesium.ScreenSpaceEventHandler === 'function') {
    handler = new cesium.ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction(onMove, cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(onClick, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  documentRef.addEventListener(ABUNDANCE_VIEW_EVENT, onView);
  documentRef.addEventListener(ABUNDANCE_CARD_EVENT, onCard);

  const destroy = () => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    documentRef.removeEventListener(ABUNDANCE_VIEW_EVENT, onView);
    documentRef.removeEventListener(ABUNDANCE_CARD_EVENT, onCard);
    handler?.destroy?.();
    removeBuilt();
    lines.removeAll();
    scene.primitives.remove?.(lines);
    view = cleanView(null);
    publishCard();
    scene.requestRender?.();
  };
  signal?.addEventListener?.('abort', destroy, { once: true });
  return {
    destroy,
    get view() {
      return view;
    },
    get level() {
      return built?.level ?? null;
    },
    /** Test seam: the load in flight, if any. */
    get loading() {
      return loading;
    },
  };
}
