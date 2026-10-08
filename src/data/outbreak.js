/**
 * OUTBREAK LOCATIONS & PREDICTED SPREAD on the map. The left-hand box of the
 * same name works the model out (src/outbreakCore.mjs) and sends it here on
 * OUTBREAK_MODEL_EVENT; this layer draws it:
 *  - every outbreak location, a white-ringed dot;
 *  - each way of travel's reach, a coloured circle round where it starts,
 *    filled faintly with two fainter rings inside it so it reads as
 *    radiating outward (a circle that takes in a pole keeps only its rings);
 *  - every flight, a red great-circle line (dashed while in the air, and
 *    for a connecting flight), and a red dot where it landed.
 * Listed under Other layers; ticking "Display spread on map" in the box
 * switches it on or off, and it says so back on OUTBREAK_SHOWN_EVENT.
 */
import * as Cesium from 'cesium';
import {
  OUTBREAK_LAYER_ID,
  OUTBREAK_MODEL_EVENT,
  OUTBREAK_REQUEST_EVENT,
  OUTBREAK_SHOWN_EVENT,
  circlePoints,
  circleTakesPole,
  contagionStyle,
} from '../outbreakCore.mjs';

const ORIGIN_COLOR = '#e040fb';
/** FUTURE SPREAD LOCATIONS: within 24 h, and within 48 h. */
const FORECAST_24_COLOR = '#ff4fd8';
const FORECAST_48_COLOR = '#b388ff';
/** A flight after the present (a daily route, assumed): a lighter red. */
const FUTURE_FLIGHT_COLOR = '#ff8a8a';
/** At most this many flight lines are drawn. */
const ROUTES_DRAWN_MAX = 500;
/**
 * Dots are drawn over hills and buildings (no depth test), so the layer hides
 * every dot that is over the horizon itself: each frame the camera has moved,
 * Cesium's ellipsoidal occluder says which dots the Earth's curve stands
 * between the camera and. A fixed distance cannot do this: from a low camera
 * the horizon is barely 100 km off, from orbit it is thousands, and with the
 * spread reaching airports worldwide dots showed through the globe.
 */
const HORIZON_RECHECK_M = 1;
/** The dashed ring round a future spread location. */
const FORECAST_RING_KM = 50;
/**
 * Circles are drawn at this height, not draped on the ground: a ring
 * thousands of km wide draped over the 3D map can freeze the page. It clears
 * the high ground the circles usually cross and still reads as on the map.
 */
const RING_HEIGHT_M = 5000;
/** Filled circles above this size are drawn as rings only. */
const FILL_MAX_KM = 800;
/**
 * Lines are built off the main thread, so they are ready a moment after the
 * redraw that asked for them; with on-demand rendering nothing would show
 * them until the map moved. A few more redraws follow each change.
 */
const SETTLE_RENDERS_MS = [250, 750, 1500, 3000];

/* The last model the box sent: kept so the layer draws it when switched on. */
let latest = null;

/** @returns {object} The layer module. */
export function createOutbreakLayer({
  windowRef = typeof window === 'undefined' ? null : window,
} = {}) {
  let _viewer = null;
  let _dataManager = null;
  let _dataSource = null;
  let _enabled = false;
  let _lastUpdate = null;

  const color = (css, alpha) =>
    Cesium.Color.fromCssColorString(css).withAlpha(alpha);
  const ring = (points) =>
    points.map((p) =>
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat, RING_HEIGHT_M),
    );

  let _settleTimers = [];
  const settle = () => {
    for (const timer of _settleTimers) clearTimeout(timer);
    _viewer?.scene?.requestRender?.();
    _settleTimers = SETTLE_RENDERS_MS.map((ms) =>
      setTimeout(() => {
        if (_viewer && !_viewer.isDestroyed?.())
          _viewer.scene?.requestRender?.();
      }, ms),
    );
  };

  /*
   * Every entity the model asks for, each with a signature of what it looks
   * like. A change of hour redraws only the entities whose signature
   * changed: the circles grow, the flights and dots mostly stay. Clearing
   * and rebuilding everything on every step (a scan can hold 120 flights)
   * stalled the map partway through PLAY.
   */
  const wanted = () => {
    const out = [];
    if (!_enabled || !latest) return out;
    // HOW CONTAGIOUS: thicker and darker when high, thinner and lighter when low.
    const look = contagionStyle(latest.contagion);
    const line = (alpha) => Math.min(1, alpha * look.strength);
    for (const circle of latest.rings) {
      const key = `${circle.mode}|${circle.from}|${circle.lat.toFixed(3)},${circle.lon.toFixed(3)}`;
      const km = Math.round(circle.radiusKm);
      const sig = `${km}|${circle.color}|${look.level}`;
      out.push({
        id: `outbreak-ring|${key}`,
        sig,
        make: () => ({
          name: `${circle.mode.toUpperCase()} REACH · ${circle.from} · ${km} km`,
          polyline: {
            positions: ring(
              circlePoints(circle.lat, circle.lon, circle.radiusKm, 96),
            ),
            width: (circle.mode === 'plane' ? 2 : 3) * look.width,
            material: color(circle.color, line(0.95)),
            arcType: Cesium.ArcType.GEODESIC,
          },
        }),
      });
      // A plane circle (up to 888 airports, 100 km each) is one ring: the
      // inner rings and fill are for the reach out of the outbreak itself.
      const plain = circle.mode === 'plane';
      for (const [j, share] of (plain ? [] : [0.33, 0.66]).entries()) {
        out.push({
          id: `outbreak-ring|${key}|${j}`,
          sig,
          make: () => ({
            polyline: {
              positions: ring(
                circlePoints(
                  circle.lat,
                  circle.lon,
                  circle.radiusKm * share,
                  64,
                ),
              ),
              width: Math.max(1, look.width),
              material: color(circle.color, line(0.35 + 0.2 * j)),
              arcType: Cesium.ArcType.GEODESIC,
            },
          }),
        });
      }
      if (
        !plain &&
        circle.radiusKm <= FILL_MAX_KM &&
        !circleTakesPole(circle.lat, circle.radiusKm)
      ) {
        out.push({
          id: `outbreak-fill|${key}`,
          sig,
          make: () => ({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                ring(
                  circlePoints(circle.lat, circle.lon, circle.radiusKm, 64),
                ).slice(0, -1),
              ),
              material: color(circle.color, look.fill),
              height: RING_HEIGHT_M,
            },
          }),
        });
      }
    }
    // Normal traffic out of 300 airports is thousands of routes: the first
    // ROUTES_DRAWN_MAX are drawn (the scan's own flights come first).
    for (const route of latest.routes.slice(0, ROUTES_DRAWN_MAX)) {
      const dashed = !route.landed || route.hop === 2 || route.future;
      // A future (daily, assumed) flight: lighter, with longer dashes.
      const css = route.future ? FUTURE_FLIGHT_COLOR : route.color;
      out.push({
        id: `outbreak-route|${route.from.code}>${route.to.code}|${route.hop}`,
        sig: `${dashed ? 'dashed' : 'solid'}|${css}|${look.level}`,
        make: () => ({
          name: `${route.future ? 'FUTURE FLIGHT' : 'FLIGHT'} · ${route.from.code} → ${route.to.code}${route.landed ? '' : ' · in the air'}`,
          polyline: {
            positions: [
              Cesium.Cartesian3.fromDegrees(
                route.from.lon,
                route.from.lat,
                1500,
              ),
              Cesium.Cartesian3.fromDegrees(route.to.lon, route.to.lat, 1500),
            ],
            arcType: Cesium.ArcType.GEODESIC,
            width: (route.hop === 2 ? 1.5 : 2.5) * look.width,
            material: dashed
              ? new Cesium.PolylineDashMaterialProperty({
                  color: color(css, line(0.85)),
                  dashLength: route.future ? 24 : 14,
                })
              : color(css, line(0.85)),
          },
        }),
      });
    }
    const dot = (id, name, place, size, css, outline) => ({
      id,
      sig: `${place.lat},${place.lon}|${css}`,
      // Where the horizon test looks: the dot on the ground.
      ground: Cesium.Cartesian3.fromDegrees(place.lon, place.lat),
      make: () => ({
        name,
        position: Cesium.Cartesian3.fromDegrees(place.lon, place.lat),
        point: {
          pixelSize: size,
          color: color(css, 1),
          outlineColor: outline,
          outlineWidth: size > 10 ? 2 : 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          // Never hidden by a hill or a building; the horizon test below
          // hides the ones the Earth itself is in front of.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    });
    for (const place of latest.destinations)
      out.push(
        dot(
          `outbreak-destination|${place.code}`,
          `REACHED BY PLANE · ${place.name || place.code}`,
          place,
          8,
          '#ff2a2a',
          Cesium.Color.BLACK,
        ),
      );
    for (const place of latest.forecast || []) {
      const css = place.within === 24 ? FORECAST_24_COLOR : FORECAST_48_COLOR;
      out.push(
        dot(
          `outbreak-forecast|${place.within}|${place.name}`,
          `FUTURE SPREAD · WITHIN ${place.within} H · ${place.name}`,
          place,
          11,
          css,
          Cesium.Color.WHITE,
        ),
      );
      out.push({
        id: `outbreak-forecast-ring|${place.within}|${place.name}`,
        sig: `${place.lat},${place.lon}|${css}`,
        make: () => ({
          polyline: {
            positions: ring(
              circlePoints(place.lat, place.lon, FORECAST_RING_KM, 48),
            ),
            width: 2,
            material: new Cesium.PolylineDashMaterialProperty({
              color: color(css, 0.95),
              dashLength: 10,
            }),
            arcType: Cesium.ArcType.GEODESIC,
          },
        }),
      });
    }
    for (const origin of latest.origins)
      out.push(
        dot(
          `outbreak-origin|${origin.id}`,
          `OUTBREAK · ${origin.name}`,
          origin,
          13,
          ORIGIN_COLOR,
          Cesium.Color.WHITE,
        ),
      );
    return out;
  };

  /*
   * What is on the map: key -> {id, sig}. A changed entity is removed and
   * added again under a NEW id. Cesium's EntityCollection treats a remove and
   * an add of the same id within one batch as no change at all, so the map
   * kept the old circle: going back an hour only partly reset it, and PLAY
   * stopped growing the circles after a few hours.
   */
  const drawn = new Map();
  /** Dot entity id -> {entity, ground}: what the horizon test checks. */
  const horizonDots = new Map();
  let lastCamera = null;
  let horizonDirty = true;
  let removeHorizonListener = null;

  /** Hide the dots over the horizon, show the rest; only when the camera moved. */
  const updateHorizon = () => {
    const camera = _viewer?.camera?.positionWC;
    if (!_enabled || !camera || !horizonDots.size) return;
    if (
      !horizonDirty &&
      lastCamera &&
      Cesium.Cartesian3.distance(camera, lastCamera) < HORIZON_RECHECK_M
    )
      return;
    lastCamera = Cesium.Cartesian3.clone(camera, lastCamera || undefined);
    horizonDirty = false;
    const occluder = new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      camera,
    );
    for (const { entity, ground } of horizonDots.values()) {
      const visible = occluder.isPointVisible(ground);
      if (entity.show !== visible) entity.show = visible;
    }
  };
  let serial = 0;
  const draw = () => {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    const next = wanted();
    const keep = new Set(next.map((item) => item.id));
    let changed = false;
    entities.suspendEvents();
    try {
      for (const [key, shown] of [...drawn]) {
        if (keep.has(key)) continue;
        entities.removeById(shown.id);
        horizonDots.delete(shown.id);
        drawn.delete(key);
        changed = true;
      }
      for (const item of next) {
        const shown = drawn.get(item.id);
        if (shown?.sig === item.sig) continue;
        if (shown) {
          entities.removeById(shown.id);
          horizonDots.delete(shown.id);
        }
        serial += 1;
        const id = `${item.id}#${serial}`;
        const entity = entities.add({ id, ...item.make() });
        if (item.ground) horizonDots.set(id, { entity, ground: item.ground });
        drawn.set(item.id, { id, sig: item.sig });
        changed = true;
      }
    } finally {
      entities.resumeEvents();
      if (changed) {
        horizonDirty = true;
        updateHorizon();
        settle();
      }
    }
  };

  const onModel = (event) => {
    const detail = event?.detail || {};
    if (detail.spread) {
      latest = detail.spread;
      _lastUpdate = Date.now();
    }
    if (typeof detail.show === 'boolean' && detail.show !== _enabled) {
      Promise.resolve(
        _dataManager?.setEnabled?.(OUTBREAK_LAYER_ID, detail.show, {
          origin: 'user',
        }),
      ).catch(() => {});
    }
    draw();
  };

  const announce = (shown) => {
    try {
      windowRef?.dispatchEvent?.(
        new CustomEvent(OUTBREAK_SHOWN_EVENT, { detail: { shown } }),
      );
    } catch {
      /* No CustomEvent here. */
    }
  };

  const layer = {
    id: OUTBREAK_LAYER_ID,
    name: 'Outbreak Locations & Predicted Spread',
    icon: '☣',
    source: 'OpenSky · OpenStreetMap · GDELT · LLM',
    updateInterval: 0,

    attachDataManager(dataManager) {
      _dataManager = dataManager;
      // The app starts a layer only when it is first switched on, so the
      // layer listens from here: the box's SCAN TRAVEL switches it on.
      windowRef?.removeEventListener?.(OUTBREAK_MODEL_EVENT, onModel);
      windowRef?.addEventListener?.(OUTBREAK_MODEL_EVENT, onModel);
      try {
        windowRef?.dispatchEvent?.(new CustomEvent(OUTBREAK_REQUEST_EVENT));
      } catch {
        /* No CustomEvent here: the box's next change reaches it. */
      }
    },

    init(viewer) {
      _viewer = viewer;
      _enabled = false;
      drawn.clear();
      horizonDots.clear();
      _dataSource = new Cesium.CustomDataSource(OUTBREAK_LAYER_ID);
      viewer?.dataSources?.add?.(_dataSource);
      removeHorizonListener?.();
      removeHorizonListener =
        viewer?.scene?.preRender?.addEventListener?.(updateHorizon) || null;
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      draw();
      announce(true);
    },

    disable() {
      // Startup switches layers off that were never on: that is not the
      // owner unticking it, so the box's tick is left alone.
      const was = _enabled;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      draw();
      if (was) announce(false);
    },

    async update() {
      draw();
      return true;
    },

    destroy(viewer) {
      for (const timer of _settleTimers) clearTimeout(timer);
      _settleTimers = [];
      windowRef?.removeEventListener?.(OUTBREAK_MODEL_EVENT, onModel);
      try {
        if (_dataSource)
          (viewer || _viewer)?.dataSources?.remove?.(_dataSource, true);
      } catch {
        /* viewer already gone */
      }
      _dataSource = null;
      drawn.clear();
      horizonDots.clear();
      removeHorizonListener?.();
      removeHorizonListener = null;
      _viewer = null;
      _enabled = false;
    },

    getStats() {
      return {
        count: latest ? latest.origins.length + latest.destinations.length : 0,
        lastUpdate: _lastUpdate,
        error: null,
      };
    },
  };
  return layer;
}
