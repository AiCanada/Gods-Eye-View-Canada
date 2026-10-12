/**
 * OUTBREAK LOCATIONS & PREDICTED SPREAD on the map. The left-hand box of the
 * same name works the model out (src/outbreakCore.mjs) and sends it here on
 * OUTBREAK_MODEL_EVENT; this layer draws it:
 *  - every outbreak location, a white-ringed dot;
 *  - each way of travel's reach, a coloured circle round where it starts,
 *    filled faintly with two fainter rings inside it so it reads as
 *    radiating outward (a circle that takes in a pole keeps only its rings);
 *    the boat reach (yellow) is one outline only, with nothing inside it,
 *    round the newest location that has one (owner ruling, 2026-10-11);
 *  - every flight, a red great-circle line (dashed while in the air, and
 *    for a connecting flight), and a red dot where it landed;
 *  - the EPIDEMIC MODEL (src/outbreakEpi.mjs), when run: a teal dot at each
 *    place, stronger the likelier it has the outbreak by the hour shown (by
 *    its by-day table where the model sent one) and bigger the more people
 *    it infects, ringed purple where local restrictions are likely, named
 *    "first case imported" where a flight most likely brought it, a hollow
 *    blue ring where beds ran short in most runs by then, and purple
 *    dashed commuting lines between places it has likely reached;
 *  - the spread by road and by train along the main roads and rail lines
 *    (outbreakNetwork.mjs): faint blue roads and faint orange rail lines,
 *    turning red as the spread reaches them. Each network is drawn once, in
 *    bands of distance along it; a step of the hour only shows or hides
 *    bands, so PLAY stays smooth. Rail is drawn only where the spread has
 *    reached it (owner 2026-10-12, "no grey on rail lines"): no backdrop of
 *    the world's rail, and a band lights only once the reach passes its end.
 * Listed under Other layers; ticking "Display spread on map" in the box
 * switches it on or off, and it says so back on OUTBREAK_SHOWN_EVENT.
 */
import * as Cesium from 'cesium';
import {
  _shadersPolylineCommon,
  _shadersPolylineMaterialAppearanceVS,
} from 'cesium';
import {
  OUTBREAK_FORECAST_BOUNDS,
  OUTBREAK_LAYER_ID,
  OUTBREAK_MODEL_EVENT,
  OUTBREAK_REQUEST_EVENT,
  OUTBREAK_SHOWN_EVENT,
  circlePoints,
  circleTakesPole,
  cleanForecastWithin,
  contagionStyle,
  forecastWindowLabel,
} from '../outbreakCore.mjs';
import { arrivedBy } from '../outbreakEpi.mjs';
import {
  NETWORK_WAITING_KM,
  bandEndKm,
  hourBandEnd,
} from '../outbreakNetwork.mjs';

const ORIGIN_COLOR = '#e040fb';
/**
 * FUTURE SPREAD LOCATIONS, one colour a window: pink for the next 24 h,
 * violet to 48 h, then cooler blues out to 30 days (never the boat yellow).
 */
const FORECAST_COLORS = Object.freeze({
  24: '#ff4fd8',
  48: '#b388ff',
  72: '#8c9eff',
  168: '#5c9dff',
  336: '#40c4ff',
  720: '#64ffda',
});

/** The colour of a forecast place's window (24 h when unknown; a 5 or
 * 21 day reach takes the colour of the 7 or 30 day window it falls in). */
export function forecastColor(within) {
  const hours = cleanForecastWithin(within);
  const bound =
    OUTBREAK_FORECAST_BOUNDS.find((b) => b >= hours) ??
    OUTBREAK_FORECAST_BOUNDS.at(-1);
  return FORECAST_COLORS[bound] || FORECAST_COLORS[48];
}
/** A flight after the present (a daily route, assumed): a lighter red. */
const FUTURE_FLIGHT_COLOR = '#ff8a8a';
/** A flight's line goes this long after it lands (owner ruling, 2026-10-09). */
const ROUTE_LINGER_MS = 2000;
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
/** EPIDEMIC MODEL: dot colour, commuting lines, and how many lines. */
const EPIDEMIC_COLOR = '#19e6b0';
const COMMUTE_COLOR = '#9b5cff';
const COMMUTES_DRAWN_MAX = 120;
/** Below this chance of arrival by the hour shown, a place is not drawn. */
const EPIDEMIC_SHOW_MIN = 0.05;
/** A place's dot is never fainter than this once it may have the outbreak. */
const EPIDEMIC_ALPHA_MIN = 0.35;
/**
 * A place's chance of restrictions (pRestricted) or of a flight bringing its
 * first case (pImportedFirst) counts from this share of runs.
 */
const EPIDEMIC_LIKELY = 0.5;
/** The label suffix of a place whose first case most likely flew in. */
const IMPORTED_FIRST_SUFFIX = ' · first case imported';
/**
 * EPIDEMIC MODEL: a hollow ring round a place where beds ran short in most
 * runs by the hour shown. The panel's hospital-curve blue
 * (EPIDEMIC_CURVE_COLORS.hospital), and larger than every dot (13 px origin,
 * at most 12 px epidemic dot), so it never hides the dot or its ring.
 */
export const BEDS_SHORT_COLOR = '#4a9bff';
export const BEDS_SHORT_PX = 20;

/**
 * Roads and rail lines are drawn at the circles' height. At 300 m the ground
 * hid them wherever it is higher (most of North America west of the
 * Mississippi, the Rockies, Irkutsk itself), so the roads showed gaps.
 */
const NETWORK_HEIGHT_M = RING_HEIGHT_M;
/**
 * Colours stay by way of travel (owner ruling, 2026-10-09): red is air and
 * the road after it; a road the spread has reached lights up blue, a rail
 * line orange. Not reached yet: faint grey for the roads near the outbreak;
 * rail not drawn at all (owner 2026-10-12, "no grey on rail lines").
 */
const NETWORK_REACHED = Object.freeze({
  road: '#a3121b',
  rail: '#ff8c1a',
  // The roads after a landing: green (owner ruling 2026-10-12, matched to
  // the owner's reference photo).
  air: '#95de97',
  // The rail round a landing airport: the rail orange.
  'air-rail': '#ff8c1a',
});
const NETWORK_WAITING = '#9aa4b2';
/** Road and rail lines, in pixels. */
const NETWORK_LINE_PX = 2.5;
/**
 * Rail lines sit a little above the roads and a pixel wider (owner report,
 * 2026-10-12): the dark red road reach runs ahead of the train's, and where
 * a rail line runs beside a road the road hid it.
 */
const NETWORK_RAIL_LIFT_M = 30;
const NETWORK_RAIL_EXTRA_PX = 1;

/** Timed by the hour from each landing: the roads and rail after a flight. */
export function isAirNetwork(mode) {
  return mode === 'air' || mode === 'air-rail';
}

/** A rail network: round an outbreak location or round a landing airport. */
export function isRailNetwork(mode) {
  return mode === 'rail' || mode === 'air-rail';
}

/** The colour a network's pieces light up in, by its mode. */
export function networkLitColor(mode) {
  return NETWORK_REACHED[mode] || NETWORK_REACHED.road;
}

/**
 * How a network is drawn: rail above the roads, a pixel wider, in its own
 * collection drawn after theirs, so the roads never hide it.
 */
export function networkStyle(mode) {
  const rail = isRailNetwork(mode);
  return {
    heightM: NETWORK_HEIGHT_M + (rail ? NETWORK_RAIL_LIFT_M : 0),
    widthPx: NETWORK_LINE_PX + (rail ? NETWORK_RAIL_EXTRA_PX : 0),
    collection: rail ? 'rail' : 'road',
  };
}
/** A piece the spread never reaches: grey for good. */
const NEVER_LIT = 1e9;
/** How long the lit edge slides to a new reach: most of a PLAY step (900 ms). */
const NETWORK_SLIDE_MS = 800;
/**
 * Cesium's own polyline vertex shader, passing each piece's lit-at value
 * (its per-piece `lit` attribute) on to the material.
 */
const NETWORK_LIT_VS = `#define CLIP_POLYLINE
${_shadersPolylineCommon}
${_shadersPolylineMaterialAppearanceVS
  .replace(
    'out float v_polylineAngle;',
    'out float v_polylineAngle;\nout float v_lit;',
  )
  .replace(
    'v_polylineAngle = angle;',
    'v_polylineAngle = angle;\n    v_lit = czm_batchTable_lit(batchId);',
  )}`;
/**
 * Each piece's colour: lit once the reach shown passes its value; grey while
 * waiting near the outbreak (below waitLimit) or if never reached; else not
 * drawn.
 */
const NETWORK_LIT_MATERIAL = `
in float v_lit;
czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  bool never = v_lit > 1.0e8;
  vec4 c;
  if (!never && v_lit <= threshold) c = litColor;
  else if (never || v_lit < waitLimit) c = waitColor;
  else discard;
  if (c.a <= 0.0) discard;
  material.diffuse = c.rgb;
  material.alpha = c.a;
  return material;
}`;

/**
 * Each piece of a network with the reach it lights at: its own, its last
 * point reached, never before the spread gets there (owner report
 * 2026-10-12: rail lit at the start of a run), so a band's pieces light one
 * by one, not all at once (owner report 2026-10-12: the spread paused on the
 * map). A network kept from before that has no `lit`: each band lights at
 * its end.
 * @param {object} network As buildTransportNetwork answers.
 * @param {boolean} timed By the hour (the roads and rail after a landing).
 * @returns {Array<[number[], number]>} [flat lon/lat, reach] per piece.
 */
export function networkPieces(network, timed) {
  const out = [];
  const lit = network?.lit || {};
  const bands = Object.keys(network?.bands || {})
    .map(Number)
    .sort((a, b) => a - b);
  for (const band of bands) {
    const end = timed ? hourBandEnd(band) : bandEndKm(band);
    network.bands[band].forEach((flat, i) => {
      const at = Number(lit[band]?.[i]);
      out.push([flat, Number.isFinite(at) && at <= end ? at : end]);
    });
  }
  return out;
}

/**
 * The lit edge of a network sliding to a new reach: a step forward moves it
 * frame by frame over NETWORK_SLIDE_MS, most of a PLAY step, so the spread
 * moves along the lines instead of jumping (owner report 2026-10-12: the
 * spread paused on the map). It only ever trails the hour shown, never
 * leads it. A step back, a first reach, or no animation frames: set at once.
 * @param {{raf?: Function, now?: Function, ms?: number, onFrame?: Function}} [o]
 */
export function thresholdSlider({
  raf = (fn) => globalThis.requestAnimationFrame?.(fn),
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  ms = NETWORK_SLIDE_MS,
  onFrame = () => {},
} = {}) {
  const slides = new Map();
  let frame = null;
  const step = () => {
    frame = null;
    const t = now();
    for (const [uniforms, s] of [...slides]) {
      const f = Math.min(1, (t - s.at) / ms);
      uniforms.threshold = s.from + f * (s.to - s.from);
      if (f >= 1) slides.delete(uniforms);
    }
    if (slides.size) frame = raf(step) ?? null;
    onFrame();
  };
  return {
    slide(uniforms, to) {
      const from = Number(uniforms.threshold);
      if (!(from >= 0) || !(to > from)) {
        slides.delete(uniforms);
        uniforms.threshold = to;
        return;
      }
      slides.set(uniforms, { from, to, at: now() });
      if (frame === null) {
        frame = raf(step) ?? null;
        // No animation frames here (a test, a server): set at once.
        if (frame === null) {
          slides.delete(uniforms);
          uniforms.threshold = to;
        }
      }
    },
    stop(uniforms) {
      slides.delete(uniforms);
    },
    clear() {
      slides.clear();
    },
  };
}

/**
 * EPIDEMIC MODEL: how strong a place's dot is at the hour shown. The model's
 * by-day table (place.byDay, [pAny, pTen, meanCases] per day, where it sent
 * one) gives the chance the place has any case by the day shown; without it
 * the chance of arrival by the hour (share) stands in. Never fainter than
 * EPIDEMIC_ALPHA_MIN. Every field is optional.
 * @param {object} place A place of the epidemic model.
 * @param {number} hour Hours after the model's start.
 * @param {number} share Chance of arrival by the hour shown (0..1).
 * @returns {number} The dot's alpha (EPIDEMIC_ALPHA_MIN..1).
 */
export function epidemicDotAlpha(place, hour, share) {
  const byDay = place?.byDay;
  let chance = share;
  if (Array.isArray(byDay) && byDay.length) {
    const day = Math.min(
      byDay.length - 1,
      Math.max(0, Math.floor((Number(hour) || 0) / 24)),
    );
    const pAny = byDay[day]?.[0];
    if (Number.isFinite(pAny)) chance = pAny;
  }
  return Math.min(1, Math.max(EPIDEMIC_ALPHA_MIN, Number(chance) || 0));
}

/** EPIDEMIC MODEL: likely under local restrictions (pRestricted, optional). */
export function epidemicRestricted(place) {
  return Number(place?.pRestricted) >= EPIDEMIC_LIKELY;
}

/** EPIDEMIC MODEL: the first case most likely flew in (pImportedFirst, optional). */
export function epidemicImportedFirst(place) {
  return Number(place?.pImportedFirst) >= EPIDEMIC_LIKELY;
}

/** EPIDEMIC MODEL: beds short here in most runs by `hour` (overflowP50, optional). */
export function epidemicBedsShort(place, hour) {
  const at = place?.overflowP50;
  return typeof at === 'number' && Number.isFinite(at) && Number(hour) >= at;
}

/** A landing airport's red dot, by how many infected flights have landed. */
export function landingDotPx(landings = 1) {
  const n = Math.max(1, Number(landings) || 1);
  return Math.min(16, Math.round(7 + 2 * Math.log2(n)));
}

/* The last model the box sent: kept so the layer draws it when switched on. */
let latest = null;
/* The last epidemic model the box sent, or null. */
let latestEpidemic = null;
/* The last roads and rail lines the box sent: [{key, locationId, mode, network}]. */
let latestNetworks = [];

/** @returns {object} The layer module. */
export function createOutbreakLayer({
  windowRef = typeof window === 'undefined' ? null : window,
  now = () => Date.now(),
} = {}) {
  /** Route key -> when it was first seen landed (wall clock). */
  const landedAt = new Map();
  let lingerTimer = null;
  let lingerAt = Infinity;
  /** Redraw once the next landed line is due to go. */
  const lingerRedraw = (inMs) => {
    const due = now() + inMs;
    if (lingerTimer !== null && lingerAt <= due) return;
    if (lingerTimer !== null) clearTimeout(lingerTimer);
    lingerAt = due;
    lingerTimer = setTimeout(
      () => {
        lingerTimer = null;
        lingerAt = Infinity;
        draw();
      },
      Math.max(0, inMs) + 20,
    );
  };
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
    // Only one yellow (boat) ring at a time (owner ruling, 2026-10-11): the
    // newest location's. Rings come in locations order, so it is the last.
    const boatShown = latest.rings.findLast((c) => c.mode === 'boat');
    for (const circle of latest.rings) {
      if (circle.mode === 'boat' && circle !== boatShown) continue;
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
      // The boat ring is an outline only: no inner rings, no colour inside.
      const plain = circle.mode === 'plane' || circle.mode === 'boat';
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
    // A flight's line goes ROUTE_LINGER_MS after it lands (owner ruling,
    // 2026-10-09): in the air it shows; landed, its red dot and the road
    // after it stay. Stepping back before the landing brings it back.
    const nowMs = now();
    const flying = [];
    const present = new Set();
    let nextExpiry = Infinity;
    for (const route of latest.routes) {
      const key = `${route.from.code}>${route.to.code}|${route.hop}`;
      present.add(key);
      if (!route.landed) {
        landedAt.delete(key);
        flying.push(route);
        continue;
      }
      if (!landedAt.has(key)) landedAt.set(key, nowMs);
      const left = landedAt.get(key) + ROUTE_LINGER_MS - nowMs;
      if (left <= 0) continue;
      nextExpiry = Math.min(nextExpiry, left);
      flying.push(route);
    }
    for (const key of [...landedAt.keys()])
      if (!present.has(key)) landedAt.delete(key);
    if (Number.isFinite(nextExpiry)) lingerRedraw(nextExpiry);
    // Normal traffic out of 300 airports is thousands of routes: the first
    // ROUTES_DRAWN_MAX are drawn (the scan's own flights come first).
    for (const route of flying.slice(0, ROUTES_DRAWN_MAX)) {
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
    // `mark`: anything else the dot's look or name depends on, so a change
    // of it redraws the dot.
    const dot = (
      id,
      name,
      place,
      size,
      css,
      outline,
      alpha = 1,
      mark = '',
    ) => ({
      id,
      sig: `${place.lat},${place.lon}|${css}|${size}|${alpha}|${mark}`,
      // Where the horizon test looks: the dot on the ground.
      ground: Cesium.Cartesian3.fromDegrees(place.lon, place.lat),
      make: () => ({
        name,
        position: Cesium.Cartesian3.fromDegrees(place.lon, place.lat),
        point: {
          pixelSize: size,
          color: color(css, alpha),
          outlineColor: outline,
          outlineWidth: size > 10 ? 2 : 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          // Never hidden by a hill or a building; the horizon test below
          // hides the ones the Earth itself is in front of.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    });
    // A little bigger with each doubling of the infected flights that have
    // landed there (owner ruling, 2026-10-09): 1 flight 7 px, up to 16 px.
    for (const place of latest.destinations)
      out.push(
        dot(
          `outbreak-destination|${place.code}`,
          `REACHED BY PLANE · ${place.name || place.code} · ${place.landings || 1} infected flight${(place.landings || 1) === 1 ? '' : 's'} landed`,
          place,
          landingDotPx(place.landings),
          '#ff2a2a',
          Cesium.Color.BLACK,
        ),
      );
    for (const place of latest.forecast || []) {
      const css = forecastColor(place.within);
      out.push(
        dot(
          `outbreak-forecast|${place.within}|${place.name}`,
          `FUTURE SPREAD · WITHIN ${forecastWindowLabel(place.within)} · ${place.name}`,
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
    // EPIDEMIC MODEL: the chance each place has it by the hour shown.
    if (latestEpidemic?.places?.length && Number.isFinite(latest.atMs)) {
      const hour = (latest.atMs - latestEpidemic.startMs) / 3_600_000;
      const likely = new Map();
      // Every place at risk is on the map (owner ruling, 2026-10-09): a
      // solid dot once it may have it by the hour shown, stronger the
      // likelier; a faint ringed dot while it is still ahead.
      for (const place of latestEpidemic.places) {
        // In steps of 5 %, so an hour's step redraws only what changed; any
        // chance at all is at least one step.
        const raw = arrivedBy(place, hour);
        const share = raw > 0 ? Math.max(0.05, Math.round(raw * 20) / 20) : 0;
        if (share >= EPIDEMIC_SHOW_MIN)
          likely.set(`${place.lat},${place.lon}`, share);
        const label = `EPIDEMIC MODEL · ${place.code ? `${place.code} ` : ''}${place.name}`;
        // Beds short here in most runs by the hour shown (overflowP50,
        // optional): a hollow blue ring, origins included, where beds run
        // short first.
        if (share > 0 && epidemicBedsShort(place, hour))
          out.push(
            dot(
              `outbreak-beds|${place.id}`,
              `${label} · beds short from day ${1 + Math.floor(place.overflowP50 / 24)} in most runs`,
              place,
              BEDS_SHORT_PX,
              BEDS_SHORT_COLOR,
              color(BEDS_SHORT_COLOR, 1),
              0,
              `beds|${place.overflowP50}`,
            ),
          );
        if (place.origin) continue;
        // The model's newer fields are optional: a place without them draws
        // as before. Most likely brought in by a flight: said in the name.
        const imported = epidemicImportedFirst(place);
        const suffix = imported ? IMPORTED_FIRST_SUFFIX : '';
        if (share > 0) {
          const size =
            6 +
            Math.round(
              6 * Math.min(1, Math.log10((place.casesP50 || 0) + 1) / 6),
            );
          // Likely under local restrictions by the model: a purple ring.
          const restricted = epidemicRestricted(place);
          out.push(
            dot(
              `outbreak-epidemic|${place.id}`,
              `${label} · ${Math.round(share * 100)} % by now · ${Math.round(place.pArrive * 100)} % in the window${suffix}`,
              place,
              size,
              EPIDEMIC_COLOR,
              restricted ? color(COMMUTE_COLOR, 1) : Cesium.Color.BLACK,
              epidemicDotAlpha(place, hour, share),
              `${share}|${restricted ? 'restricted' : ''}|${imported ? 'imported' : ''}`,
            ),
          );
        } else {
          out.push(
            dot(
              `outbreak-epidemic|${place.id}`,
              `${label} · ahead · ${Math.round(place.pArrive * 100)} % in the window${suffix}`,
              place,
              5,
              EPIDEMIC_COLOR,
              color(EPIDEMIC_COLOR, 0.9),
              0.12,
              imported ? 'imported' : '',
            ),
          );
        }
      }
      for (const commute of (latestEpidemic.commutes || []).slice(
        0,
        COMMUTES_DRAWN_MAX,
      )) {
        const a = likely.get(`${commute.from.lat},${commute.from.lon}`);
        const b = likely.get(`${commute.to.lat},${commute.to.lon}`);
        if (!(a >= 0.1 || b >= 0.1)) continue;
        out.push({
          id: `outbreak-commute|${commute.from.lat},${commute.from.lon}>${commute.to.lat},${commute.to.lon}`,
          sig: `${look.level}`,
          make: () => ({
            name: `COMMUTING · ${commute.from.name} ↔ ${commute.to.name} · ${commute.perDay.toLocaleString('en-US')} a day`,
            polyline: {
              positions: [
                Cesium.Cartesian3.fromDegrees(
                  commute.from.lon,
                  commute.from.lat,
                  RING_HEIGHT_M,
                ),
                Cesium.Cartesian3.fromDegrees(
                  commute.to.lon,
                  commute.to.lat,
                  RING_HEIGHT_M,
                ),
              ],
              arcType: Cesium.ArcType.GEODESIC,
              width: 1.5 * look.width,
              material: new Cesium.PolylineDashMaterialProperty({
                color: color(COMMUTE_COLOR, line(0.8)),
                dashLength: 8,
              }),
            },
          }),
        });
      }
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
  /*
   * Roads and rail lines are lit on the graphics card (owner request,
   * 2026-10-09): each network is one primitive, every piece carrying the
   * distance (or, for the roads after a landing, the hour) it lights at. A
   * small material colours each piece from the reach shown, so a step of the
   * hour changes one number, not thousands of lines.
   * key -> {item, primitive, material, bands, threshold}.
   */
  let _networkRoot = null;
  // Rail on its own, added after the roads: always drawn on top of them.
  let _railRoot = null;
  const rootFor = (mode) =>
    networkStyle(mode).collection === 'rail' ? _railRoot : _networkRoot;
  const builtNetworks = new Map();
  const buildNetwork = (item) => {
    const air = isAirNetwork(item.mode);
    const style = networkStyle(item.mode);
    const bands = Object.keys(item.network.bands || {})
      .map(Number)
      .sort((a, b) => a - b);
    const built = {
      item,
      primitive: null,
      material: null,
      bands,
      threshold: -1,
    };
    // The lines themselves only where there is a map to draw them on.
    if (!_viewer?.scene?.primitives) return built;
    const instances = [];
    const add = (flat, lit) => {
      const withHeights = [];
      for (let i = 0; i + 1 < flat.length; i += 2)
        withHeights.push(flat[i], flat[i + 1], style.heightM);
      if (withHeights.length < 6) return;
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolylineGeometry({
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(withHeights),
            width: style.widthPx,
            vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
            arcType: Cesium.ArcType.NONE,
          }),
          attributes: {
            lit: new Cesium.GeometryInstanceAttribute({
              componentDatatype: Cesium.ComponentDatatype.FLOAT,
              componentsPerAttribute: 1,
              value: [lit],
            }),
          },
        }),
      );
    };
    for (const [flat, lit] of networkPieces(item.network, air)) add(flat, lit);
    // Never reached: grey for good (not for the roads after a landing, and
    // never on rail: owner 2026-10-12, "no grey on rail lines").
    const rail = isRailNetwork(item.mode);
    if (!air && !rail)
      for (const flat of item.network.unreached || []) add(flat, NEVER_LIT);
    if (!instances.length) return built;
    const material = new Cesium.Material({
      fabric: {
        uniforms: {
          threshold: -1,
          waitLimit: air || rail ? -1 : NETWORK_WAITING_KM,
          litColor: color(networkLitColor(item.mode), 0.95),
          waitColor: color(NETWORK_WAITING, air || rail ? 0 : 0.5),
        },
        source: NETWORK_LIT_MATERIAL,
      },
      translucent: true,
    });
    const primitive = new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineMaterialAppearance({
        material,
        translucent: true,
        vertexShaderSource: NETWORK_LIT_VS,
      }),
      asynchronous: true,
      releaseGeometryInstances: true,
      allowPicking: false,
    });
    primitive.show = false;
    rootFor(item.mode)?.add(primitive);
    return { ...built, primitive, material };
  };
  /** Build new networks, drop gone ones, and set each one's reach. */
  const drawNetworks = () => {
    if (!_networkRoot) return;
    const wantedKeys = new Set(latestNetworks.map((item) => item.key));
    for (const [key, built] of [...builtNetworks]) {
      const current = latestNetworks.find((item) => item.key === key);
      if (wantedKeys.has(key) && current?.network === built.item.network)
        continue;
      if (built.primitive) rootFor(built.item.mode)?.remove(built.primitive);
      if (built.material) slides.stop(built.material.uniforms);
      builtNetworks.delete(key);
    }
    let changed = false;
    for (const item of latestNetworks) {
      if (!builtNetworks.has(item.key)) {
        builtNetworks.set(item.key, buildNetwork(item));
        changed = true;
      }
      const built = builtNetworks.get(item.key);
      // The roads after a landing go by the hour shown; the rest by the
      // reach along them from their outbreak location.
      const air = isAirNetwork(item.mode);
      const airLit =
        item.mode === 'air-rail' ? latest?.airRails : latest?.airRoads;
      const reach = !_enabled
        ? null
        : air
          ? airLit
            ? latest.hour
            : null
          : (latest?.reaches || []).find(
              (r) =>
                r.locationId === item.locationId && r.network === item.mode,
            )?.km;
      const show = Number.isFinite(reach);
      if (built.shown !== show) {
        built.shown = show;
        if (built.primitive) built.primitive.show = show;
        changed = true;
      }
      // A road network lights nothing until its reach is under way.
      const threshold = air || reach > 0 ? reach : -1;
      if (!show || threshold === built.threshold) continue;
      built.threshold = threshold;
      if (built.material) slideThreshold(built, threshold);
      changed = true;
    }
    if (changed) _viewer?.scene?.requestRender?.();
  };
  // A step forward slides the lit edge there (thresholdSlider).
  const slides = thresholdSlider({
    onFrame: () => _viewer?.scene?.requestRender?.(),
  });
  const slideThreshold = (built, to) =>
    slides.slide(built.material.uniforms, to);

  let serial = 0;
  const draw = () => {
    drawNetworks();
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
    if ('epidemic' in detail) latestEpidemic = detail.epidemic || null;
    if (Array.isArray(detail.networks)) latestNetworks = detail.networks;
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
      builtNetworks.clear();
      slides.clear();
      _networkRoot = new Cesium.PrimitiveCollection();
      viewer?.scene?.primitives?.add?.(_networkRoot);
      _railRoot = new Cesium.PrimitiveCollection();
      viewer?.scene?.primitives?.add?.(_railRoot);
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
      if (lingerTimer !== null) clearTimeout(lingerTimer);
      lingerTimer = null;
      landedAt.clear();
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
      try {
        if (_networkRoot)
          (viewer || _viewer)?.scene?.primitives?.remove?.(_networkRoot);
        if (_railRoot)
          (viewer || _viewer)?.scene?.primitives?.remove?.(_railRoot);
      } catch {
        /* viewer already gone */
      }
      _networkRoot = null;
      _railRoot = null;
      builtNetworks.clear();
      slides.clear();
      removeHorizonListener?.();
      removeHorizonListener = null;
      _viewer = null;
      _enabled = false;
    },

    /** For tests: each network drawn, with how many bands are red. */
    networkState() {
      return [...builtNetworks].map(([key, built]) => {
        const end = isAirNetwork(built.item.mode) ? hourBandEnd : bandEndKm;
        return {
          key,
          shown: Boolean(built.shown),
          bands: built.bands.length,
          red: built.shown
            ? built.bands.filter((b) => end(b) <= built.threshold).length
            : 0,
        };
      });
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
