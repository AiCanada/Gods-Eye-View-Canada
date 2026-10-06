/**
 * OUTBREAK LOCATIONS & PREDICTED SPREAD: the model behind the left-hand box
 * and its map layer. No DOM and no network: the defaults, the four ways of
 * travel and their colours, how far each could have carried the outbreak by
 * a chosen hour, the circles drawn for that, and the words sent to and read
 * back from a language model all live here.
 *
 * The prediction is deliberately simple (owner's spec, 2026-10-06):
 *  - Plane (red): every flight that left an outbreak airport since the scan
 *    began, and every connecting or onward flight out of those destinations,
 *    marks its destination. From a destination it carries on by road for at
 *    most PLANE_ROAD_KM.
 *  - Train (orange): the area's average train speed, only where a railway
 *    station is near the outbreak.
 *  - Boat (yellow): 38 km/h, only where water traffic is within 100 km.
 * Where OpenStreetMap could not be asked, train and boat both count: a
 * reach drawn and unticked is better than one missed.
 *  - Road (blue): 100 km/h.
 * Each distance is speed × hours since the scan began, drawn as a circle
 * round the place it starts from. The circles are a reach, not a forecast of
 * cases.
 */

export const OUTBREAK_LAYER_ID = 'outbreak';
/** The box sends the model to the layer on this window event. */
export const OUTBREAK_MODEL_EVENT = 'gev:outbreak-model';
/** The layer says when it is switched on or off, so the box's tick follows. */
export const OUTBREAK_SHOWN_EVENT = 'gev:outbreak-shown';
/** The layer asks the box for the model once it is listening. */
export const OUTBREAK_REQUEST_EVENT = 'gev:outbreak-request';
/** This browser's own choices: locations, speeds, ticks and the last scan. */
export const OUTBREAK_STORAGE_KEY = 'gev-outbreak-v1';

/** The two outbreak locations the box starts with; either can be removed. */
export const OUTBREAK_DEFAULT_LOCATIONS = Object.freeze([
  Object.freeze({
    id: 'irkutsk',
    name: 'Irkutsk, Russia',
    kind: 'City',
    lat: 52.287,
    lon: 104.305,
  }),
  Object.freeze({
    id: 'shelekhov',
    name: 'Shelekhov, Russia',
    kind: 'Town',
    lat: 52.2108,
    lon: 104.0989,
  }),
]);

/** How many days back the travel history is scanned from. */
export const OUTBREAK_SCAN_DAYS_DEFAULT = 2;
export const OUTBREAK_SCAN_DAY_OPTIONS = Object.freeze([1, 2, 3, 5, 7]);
/** By road from a destination reached by plane, at most this far. */
export const PLANE_ROAD_KM = 100;
/** A boat only carries it where water traffic is this close. */
export const BOAT_REACH_KM = 100;
/** A train only carries it where a station is this close. */
export const RAIL_REACH_KM = 30;
/** No circle is drawn larger than this: half the globe is already all of it. */
export const SPREAD_MAX_RADIUS_KM = 10_000;
/** Cruise speed and ground time used when a flight has no times of its own. */
export const FLIGHT_SPEED_KMH = 800;
export const FLIGHT_GROUND_HOURS = 0.5;
/** A connecting flight leaves this long after the first one lands. */
export const CONNECTION_HOURS = 2;
/** Airports this close to an outbreak location are its airports. */
export const OUTBREAK_AIRPORT_KM = 60;
/** Connecting flights are followed out of this many destinations at most. */
export const CONNECTING_AIRPORTS_MAX = 12;

/** The four ways of travel, in drawing order (widest first). */
export const OUTBREAK_MODES = Object.freeze({
  road: Object.freeze({
    id: 'road',
    label: 'Road',
    colorName: 'Blue',
    color: '#2f7bff',
    speedKmh: 100,
  }),
  train: Object.freeze({
    id: 'train',
    label: 'Train',
    colorName: 'Orange',
    color: '#ff8c1a',
    speedKmh: 60,
  }),
  boat: Object.freeze({
    id: 'boat',
    label: 'Boat',
    colorName: 'Yellow',
    color: '#ffd21a',
    speedKmh: 38,
  }),
  plane: Object.freeze({
    id: 'plane',
    label: 'Plane',
    colorName: 'Red',
    color: '#ff2a2a',
    speedKmh: 100,
  }),
});
export const OUTBREAK_MODE_IDS = Object.freeze([
  'road',
  'train',
  'boat',
  'plane',
]);
export const OUTBREAK_SPEED_MAX_KMH = 1000;

const EARTH_RADIUS_KM = 6371.0088;
const HOUR_MS = 3_600_000;
const NAME_MAX = 80;
const LOCATIONS_MAX = 40;

function finite(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanLine(value, max = NAME_MAX) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** A latitude/longitude pair, or null. */
export function validPoint(lat, lon) {
  const la = finite(lat);
  const lo = finite(lon);
  return la !== null && lo !== null && Math.abs(la) <= 90 && Math.abs(lo) <= 180
    ? { lat: la, lon: lo }
    : null;
}

/** Great-circle distance in km. */
export function distanceKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The point `km` away from (lat, lon) on bearing `deg`. */
export function destinationPoint(lat, lon, km, deg) {
  const toRad = Math.PI / 180;
  const d = km / EARTH_RADIUS_KM;
  const b = deg * toRad;
  const la1 = lat * toRad;
  const lo1 = lon * toRad;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b),
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2),
    );
  let lonDeg = ((lo2 / toRad + 540) % 360) - 180;
  if (lonDeg === -180) lonDeg = 180;
  return { lat: la2 / toRad, lon: lonDeg };
}

/** The ring round a point, closed (the last point is the first). */
export function circlePoints(lat, lon, radiusKm, steps = 96) {
  const n = Math.max(8, Math.floor(steps));
  const points = [];
  for (let i = 0; i <= n; i += 1)
    points.push(destinationPoint(lat, lon, radiusKm, (i * 360) / n));
  return points;
}

/** Whether a circle takes in a pole: such a ring is drawn without its fill. */
export function circleTakesPole(lat, radiusKm) {
  const reachDeg = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  return Math.abs(lat) + reachDeg >= 89;
}

/** A speed the box accepts: 1 to 1000 km/h, else the mode's default. */
export function cleanSpeed(mode, value) {
  const n = finite(value);
  return n !== null && n > 0 && n <= OUTBREAK_SPEED_MAX_KMH
    ? Math.round(n * 10) / 10
    : (OUTBREAK_MODES[mode]?.speedKmh ?? 0);
}

/** One outbreak location as stored, or null when it is not one. */
export function cleanLocation(raw) {
  const point = validPoint(raw?.lat, raw?.lon);
  const name = cleanLine(raw?.name);
  if (!point || !name) return null;
  const id =
    cleanLine(raw?.id, 60) ||
    `${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}-${point.lat.toFixed(2)}-${point.lon.toFixed(2)}`;
  const kind = cleanLine(raw?.kind, 30);
  const source = cleanLine(raw?.source, 40);
  return {
    id,
    name,
    ...point,
    ...(kind ? { kind } : {}),
    ...(source ? { source } : {}),
  };
}

/** The stored list, cleaned; the defaults when nothing is stored. */
export function cleanLocations(list) {
  if (!Array.isArray(list))
    return OUTBREAK_DEFAULT_LOCATIONS.map((l) => ({ ...l }));
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const location = cleanLocation(raw);
    if (!location || seen.has(location.id)) continue;
    seen.add(location.id);
    out.push(location);
    if (out.length >= LOCATIONS_MAX) break;
  }
  return out;
}

/** When the scan begins: midnight-free, exactly `days` before `nowMs`. */
export function scanStartMs(nowMs, days = OUTBREAK_SCAN_DAYS_DEFAULT) {
  const d = OUTBREAK_SCAN_DAY_OPTIONS.includes(Number(days))
    ? Number(days)
    : OUTBREAK_SCAN_DAYS_DEFAULT;
  return nowMs - d * 24 * HOUR_MS;
}

/** Whole hours from the scan's start to now: the "present" hour. */
export function presentHour(startMs, nowMs) {
  return Math.max(1, Math.ceil((nowMs - startMs) / HOUR_MS));
}

/** The time dropdown: hour 1 to the present, the present last. */
/**
 * HOW CONTAGIOUS, 0 (low) to 100 (high). It changes how the spread is drawn,
 * not how far it reaches: high is thicker and darker, low thinner and
 * lighter, in PLAY and MAP FUTURE SPREAD alike.
 */
export const OUTBREAK_CONTAGION_DEFAULT = 50;

/** A slider value the box keeps: a whole number 0 to 100. */
export function cleanContagion(value) {
  const n = finite(value);
  return n === null
    ? OUTBREAK_CONTAGION_DEFAULT
    : Math.max(0, Math.min(OUTBREAK_CONTAGION_MAX, Math.round(n)));
}

/**
 * The slider runs past HIGH (100) to ZERO HOUR (110, owner ruling
 * 2026-10-06): under an hour, down to the moment the outbreak lands.
 */
export const OUTBREAK_CONTAGION_HIGH = 100;
export const OUTBREAK_CONTAGION_MAX = 110;

/** The words beside the slider. */
export function contagionLabel(value) {
  const level = cleanContagion(value);
  if (level >= OUTBREAK_CONTAGION_MAX) return 'ZERO HOUR';
  if (level > OUTBREAK_CONTAGION_HIGH) return 'UNDER AN HOUR';
  if (level >= 90) return 'HIGH';
  if (level >= 65) return 'MEDIUM-HIGH';
  if (level > 35) return 'MEDIUM';
  if (level > 10) return 'MEDIUM-LOW';
  return 'LOW';
}

/**
 * How the map draws a level: a width multiplier for every line, a strength
 * (0 to 1) every line's opacity is scaled by, and the circles' fill opacity.
 * The middle of the slider draws as the map did before it existed.
 */
export function contagionStyle(value) {
  // Past HIGH the map draws as HIGH: ZERO HOUR changes the airports only.
  const t = Math.min(cleanContagion(value), OUTBREAK_CONTAGION_HIGH) / 100;
  return {
    level: cleanContagion(value),
    width: 0.4 + 1.2 * t,
    strength: 0.4 + 1.2 * t,
    fill: 0.03 + 0.18 * t,
  };
}

/** The hours past the present the time menu offers: every hour to +48 h,
 * so MAP FUTURE SPREAD can step through them. */
export const OUTBREAK_FUTURE_HOURS = Object.freeze(
  Array.from({ length: 48 }, (_, i) => i + 1),
);
/** FUTURE SPREAD LOCATIONS asks for these two windows, in this order. */
export const OUTBREAK_FORECAST_WINDOWS = Object.freeze([24, 48]);
/** Every outbreak question may answer at the route's ceiling: a reasoning
 * model spends part of its budget thinking, and a long route list or
 * forecast must not end mid-line. */
export const OUTBREAK_ANSWER_TOKENS = 8192;

export function outbreakHourOptions(startMs, nowMs) {
  const last = presentHour(startMs, nowMs);
  const options = [];
  for (let hour = 1; hour <= last; hour += 1) {
    const at = new Date(startMs + hour * HOUR_MS);
    const clock = `${String(at.getUTCDate()).padStart(2, '0')} ${String(at.getUTCHours()).padStart(2, '0')}:00 UTC`;
    options.push({
      value: hour,
      label:
        hour === last
          ? `Present · hour ${hour} · ${clock}`
          : `Hour ${hour} · ${clock}`,
    });
  }
  // Into the future: the same reach carried on from the present.
  for (const ahead of OUTBREAK_FUTURE_HOURS) {
    const hour = last + ahead;
    const at = new Date(startMs + hour * HOUR_MS);
    const clock = `${String(at.getUTCDate()).padStart(2, '0')} ${String(at.getUTCHours()).padStart(2, '0')}:00 UTC`;
    options.push({
      value: hour,
      future: true,
      label: `Future · +${ahead} h · ${clock}`,
    });
  }
  return options;
}

/** Hours a flight takes when its times are not known. */
export function flightHours(from, to) {
  return distanceKm(from, to) / FLIGHT_SPEED_KMH + FLIGHT_GROUND_HOURS;
}

/**
 * One flight as the model keeps it, or null. `departMs`/`arriveMs` come from
 * flight history; a route without times (a schedule) gets them from
 * `fallbackDepartMs` and the distance.
 */
export function cleanFlight(raw, fallbackDepartMs) {
  const from = validPoint(raw?.from?.lat, raw?.from?.lon);
  const to = validPoint(raw?.to?.lat, raw?.to?.lon);
  if (!from || !to) return null;
  const fromCode = cleanLine(raw?.from?.code, 8).toUpperCase();
  const toCode = cleanLine(raw?.to?.code, 8).toUpperCase();
  if (!fromCode || !toCode || fromCode === toCode) return null;
  let departMs = finite(raw?.departMs);
  let arriveMs = finite(raw?.arriveMs);
  const timed = departMs !== null && arriveMs !== null && arriveMs > departMs;
  if (!timed) {
    departMs = finite(fallbackDepartMs);
    if (departMs === null) return null;
    arriveMs = departMs + flightHours(from, to) * HOUR_MS;
  }
  return {
    from: { code: fromCode, name: cleanLine(raw?.from?.name), ...from },
    to: { code: toCode, name: cleanLine(raw?.to?.name), ...to },
    departMs,
    arriveMs,
    // 3: a flight the scan did not find, assumed (simulateAirTraffic).
    hop: raw?.hop === 2 ? 2 : raw?.hop === 3 ? 3 : 1,
    ...(raw?.assumed === true ? { assumed: true } : {}),
    callsign: cleanLine(raw?.callsign, 12),
    source: timed
      ? cleanLine(raw?.source, 40) || 'Flight history'
      : cleanLine(raw?.source, 40) || 'Schedule',
  };
}

/**
 * Schedule routes (no times) as flights: the first hop leaves at the scan's
 * start, a connecting hop CONNECTION_HOURS after its first hop lands.
 *
 * @param {{from: object, to: object, hop?: number}[]} routes
 * @param {number} startMs
 */
export function timeScheduleRoutes(routes, startMs, source = 'Schedule') {
  const firstArrival = new Map();
  const flights = [];
  for (const route of routes.filter((r) => r?.hop !== 2)) {
    const flight = cleanFlight({ ...route, hop: 1, source }, startMs);
    if (!flight) continue;
    flights.push(flight);
    const known = firstArrival.get(flight.to.code);
    if (known === undefined || flight.arriveMs < known)
      firstArrival.set(flight.to.code, flight.arriveMs);
  }
  for (const route of routes.filter((r) => r?.hop === 2)) {
    const landed = firstArrival.get(
      cleanLine(route?.from?.code, 8).toUpperCase(),
    );
    if (landed === undefined) continue;
    const flight = cleanFlight(
      { ...route, hop: 2, source },
      landed + CONNECTION_HOURS * HOUR_MS,
    );
    if (flight) flights.push(flight);
  }
  return flights;
}

function clampRadius(km) {
  return Math.max(0, Math.min(SPREAD_MAX_RADIUS_KM, km));
}

/**
 * How far the outbreak could have reached by `hour` hours after `startMs`.
 *
 * @param {object} input
 * @param {object[]} input.locations Outbreak locations ({id, name, lat, lon}).
 * @param {object[]} input.flights Flights from cleanFlight.
 * @param {object} input.speeds km/h by mode (train, boat, road).
 * @param {object} input.surroundings By location id: {rail: ?boolean, water: ?boolean}.
 * @param {object} input.shown By mode: false hides that mode.
 * @param {number} input.startMs When the scan begins.
 * @param {number} input.hour Hours after the start.
 * @param {string[]} [input.airports] The airports at the outbreak locations;
 *   without them, where the scan's first flights left from.
 * @param {?number} input.present The present hour. Past it, a place
 *   forecast within 48 h shows only from 24 h after the present on.
 * @returns {{atMs: number, hour: number, rings: object[], routes: object[], origins: object[], destinations: object[]}}
 */
export function outbreakSpread({
  locations = [],
  flights = [],
  speeds = {},
  surroundings = {},
  shown = {},
  forecast = [],
  present = null,
  contagion = OUTBREAK_CONTAGION_DEFAULT,
  airports = [],
  startMs,
  hour,
}) {
  const h = Math.max(0, finite(hour) ?? 0);
  const atMs = startMs + h * HOUR_MS;
  const on = (mode) => shown?.[mode] !== false;
  const rings = [];
  const speed = (mode) => cleanSpeed(mode, speeds?.[mode]);
  for (const location of locations) {
    const around = surroundings?.[location.id] || {};
    const reach = (mode) =>
      rings.push({
        mode,
        color: OUTBREAK_MODES[mode].color,
        lat: location.lat,
        lon: location.lon,
        radiusKm: clampRadius(speed(mode) * h),
        from: location.name,
      });
    if (on('road')) reach('road');
    // Unknown (the scan could not ask) counts as there: better drawn than missed.
    if (on('train') && around.rail !== false) reach('train');
    if (on('boat') && around.water !== false) reach('boat');
  }
  // A flight carries the outbreak only when the airport it leaves already
  // has it: an outbreak airport (where the first hops leave from), or one
  // reached by an earlier flight that landed before this one left. Taken in
  // departure order, every landing that could count is known by then.
  const outbreakAirports = new Set(
    airports.length
      ? airports
      : flights.filter((f) => f.hop === 1 && !f.future).map((f) => f.from.code),
  );
  const routes = new Map();
  const reached = new Map();
  const ordered = [...flights].sort((a, b) => a.departMs - b.departMs);
  for (const flight of ordered) {
    if (flight.departMs > atMs) continue;
    const infected =
      outbreakAirports.has(flight.from.code) ||
      reached.get(flight.from.code)?.arriveMs <= flight.departMs;
    if (!infected) continue;
    const landed = flight.arriveMs <= atMs;
    // One line per route: a daily flight is flown many times.
    const key = `${flight.from.code}>${flight.to.code}|${flight.hop}`;
    const known = routes.get(key);
    routes.set(key, {
      from: flight.from,
      to: flight.to,
      hop: flight.hop,
      landed: landed || Boolean(known?.landed),
      future: Boolean(flight.future) && (known ? known.future : true),
      assumed: Boolean(flight.assumed) && (known ? known.assumed : true),
      longHaul: distanceKm(flight.from, flight.to) >= LONG_HAUL_KM,
      firstDepartMs: known ? known.firstDepartMs : flight.departMs,
      color: OUTBREAK_MODES.plane.color,
    });
    if (!landed) continue;
    const there = reached.get(flight.to.code);
    if (!there || flight.arriveMs < there.arriveMs)
      reached.set(flight.to.code, {
        ...flight.to,
        arriveMs: flight.arriveMs,
        hop: flight.hop,
        future: Boolean(flight.future),
      });
  }
  const destinations = [...reached.values()].sort(
    (a, b) => a.arriveMs - b.arriveMs,
  );
  if (on('plane')) {
    for (const place of destinations) {
      const hoursOnGround = (atMs - place.arriveMs) / HOUR_MS;
      rings.push({
        mode: 'plane',
        color: OUTBREAK_MODES.plane.color,
        lat: place.lat,
        lon: place.lon,
        radiusKm: clampRadius(
          Math.min(PLANE_ROAD_KM, speed('road') * hoursOnGround),
        ),
        from: place.name || place.code,
      });
    }
  }
  return {
    atMs,
    hour: h,
    rings: rings.filter((ring) => ring.radiusKm > 0),
    // The scan's own flights first, then long-haul ones (so other continents
    // always show), then the rest by when they first left:
    // the map draws only so many lines.
    routes: on('plane')
      ? [...routes.values()].sort(
          (a, b) =>
            Number(a.assumed) - Number(b.assumed) ||
            Number(b.longHaul) - Number(a.longHaul) ||
            a.firstDepartMs - b.firstDepartMs,
        )
      : [],
    origins: locations.map((l) => ({
      id: l.id,
      name: l.name,
      lat: l.lat,
      lon: l.lon,
    })),
    destinations: on('plane') ? destinations : [],
    contagion: cleanContagion(contagion),
    forecast: (Array.isArray(forecast) ? forecast : [])
      .filter((f) => validPoint(f?.lat, f?.lon))
      .filter(
        (f) =>
          !(Number.isFinite(present) && h > present) ||
          f.within !== 48 ||
          h >= present + 24,
      )
      .map((f) => ({
        name: cleanLine(f.name),
        lat: f.lat,
        lon: f.lon,
        within: f.within === 48 ? 48 : 24,
      })),
  };
}

/** One line per mode for the box: how far each has reached. */
/** How high the camera flies over the outbreak: the region round it in view. */
export const OUTBREAK_VIEW_HEIGHT_M = 2_000_000;

/**
 * Where SCAN TRAVEL flies the map: over the middle of the outbreak
 * locations, high enough to see all of them and the region round them.
 * Null with no location.
 */
export function outbreakViewTarget(locations) {
  const points = (Array.isArray(locations) ? locations : [])
    .map((l) => validPoint(l?.lat, l?.lon))
    .filter(Boolean);
  if (!points.length) return null;
  // The middle on the sphere, so locations either side of 180° meet.
  const toRad = Math.PI / 180;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += Math.cos(p.lat * toRad) * Math.cos(p.lon * toRad);
    y += Math.cos(p.lat * toRad) * Math.sin(p.lon * toRad);
    z += Math.sin(p.lat * toRad);
  }
  const middle = {
    lat: Math.atan2(z, Math.hypot(x, y)) / toRad,
    lon: Math.atan2(y, x) / toRad,
  };
  const widestKm = Math.max(...points.map((p) => distanceKm(middle, p)));
  return {
    ...middle,
    heightM: Math.min(
      12_000_000,
      Math.max(OUTBREAK_VIEW_HEIGHT_M, widestKm * 3000),
    ),
  };
}

export function spreadSummary(spread, speeds = {}) {
  const widest = (mode) =>
    spread.rings
      .filter((ring) => ring.mode === mode)
      .reduce((max, ring) => Math.max(max, ring.radiusKm), 0);
  const lines = [];
  for (const mode of OUTBREAK_MODE_IDS) {
    const spec = OUTBREAK_MODES[mode];
    if (mode === 'plane') {
      lines.push(
        `${spec.label} (${spec.colorName}): ${spread.destinations.length} destination${spread.destinations.length === 1 ? '' : 's'} reached · up to ${Math.round(widest('plane'))} km by road from each`,
      );
      continue;
    }
    const km = widest(mode);
    lines.push(
      km > 0
        ? `${spec.label} (${spec.colorName}, ${cleanSpeed(mode, speeds[mode])} km/h): ${Math.round(km)} km`
        : `${spec.label} (${spec.colorName}): not near this outbreak`,
    );
  }
  return lines;
}

/* ---------------------------------------------------------------------------
 * Language model: what is asked, and what is read back.
 * ------------------------------------------------------------------------- */

/** Codes such as UIII or IKT from a model's answer: "UIII>UUEE" lines. */
export function parseRouteLines(text) {
  const routes = [];
  const seen = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(
      /\b([A-Z0-9]{3,4})\s*(?:>|->|→|–|—|-)\s*([A-Z0-9]{3,4})\b/,
    );
    if (!match) continue;
    const [, from, to] = match;
    if (from === to) continue;
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ from, to });
  }
  return routes;
}

/**
 * The question for the scheduled routes out of the outbreak airports. The
 * candidate airports travel in the SCENE (the ask route's rule: never a place
 * the SCENE does not hold).
 */
export function outbreakRoutesQuestion(airports, { connecting = false } = {}) {
  const codes = airports.map((a) => a.code).join(', ');
  return [
    connecting
      ? `For each airport in ${codes}, list the airports in SCENE.outbreakRoutes.candidates that it has scheduled passenger flights to (onward or connecting flights).`
      : `List the airports in SCENE.outbreakRoutes.candidates that have scheduled nonstop passenger flights from ${codes}.`,
    'Use your knowledge of current airline schedules. Only use codes from the candidate list.',
    'Answer with one route per line and nothing else, written FROM>TO with the four-letter codes, for example UIII>UUEE.',
    'If you know of none, answer exactly: NONE.',
  ].join(' ');
}

/** The question for the global media search; the articles travel in the SCENE. */
export function outbreakMediaQuestion(locations, keywords = '') {
  const names = locations.map((l) => l.name).join('; ');
  const topic = cleanLine(keywords, 80);
  return [
    `An outbreak${topic ? ` (${topic})` : ''} is reported at: ${names}.`,
    'SCENE.outbreakNews holds recent news articles found by a global media search.',
    'From those articles only, list every other place reported to have cases, suspected cases, quarantine or contact tracing linked to this outbreak.',
    'Answer with one place per line and nothing else, written: PLACE, COUNTRY | what the article says | link.',
    'Do not repeat the outbreak locations above. If the articles name no other place, answer exactly: NONE.',
  ].join(' ');
}

/** The instructions for the Grok Bot / OpenAI DOTS social media swarm. */
export function outbreakSocialInstructions(locations, keywords = '') {
  const names = locations.map((l) => l.name).join('; ');
  const topic = cleanLine(keywords, 80);
  return [
    `Find public posts from the last 7 days about a disease outbreak${topic ? ` (${topic})` : ''} at ${names},`,
    'and especially about new places with cases, suspected cases, quarantine or travellers from there falling ill.',
    'In each line, the place is the town or city with the new report.',
  ]
    .join(' ')
    .slice(0, 1000);
}

/**
 * Places from a model's answer: "PLACE, COUNTRY | evidence | link" lines
 * (media search) or "time · place · what happened · link" lines (a swarm
 * bot). Outbreak locations already listed are left out.
 */
export function parsePlaceLines(text, known = []) {
  const knownNames = new Set(
    known.map((l) => cleanLine(l.name).toLowerCase().split(',')[0].trim()),
  );
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s\-*•\d.)]+/, '').trim();
    if (!line || /^none\b/i.test(line) || /^nothing found/i.test(line))
      continue;
    let place = '';
    let evidence = '';
    let link = '';
    if (line.includes('|')) {
      [place = '', evidence = '', link = ''] = line
        .split('|')
        .map((s) => s.trim());
    } else if (line.includes('·')) {
      const parts = line.split('·').map((s) => s.trim());
      if (parts.length < 3) continue;
      place = parts[1];
      evidence = parts[2];
      link = parts.slice(3).join(' ');
    } else continue;
    place = cleanLine(place);
    if (!place || place.length < 2) continue;
    const head = place.toLowerCase().split(',')[0].trim();
    if (knownNames.has(head) || seen.has(head)) continue;
    seen.add(head);
    const url = (link.match(/https?:\/\/\S+/) || [''])[0].slice(0, 500);
    out.push({ place, evidence: cleanLine(evidence, 200), link: url });
  }
  return out.slice(0, 30);
}

/** An airport row for the SCENE: compact, one string each. */
export function candidateLine(airport) {
  return [airport.code, airport.iata, airport.name, airport.country]
    .filter(Boolean)
    .join(' ');
}

/* ---------------------------------------------------------------------------
 * FUTURE SPREAD LOCATIONS: two requests, the next 24 h then the 24 h after.
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Air traffic after an airport has the outbreak (owner rule, 2026-10-06).
 *  - Until it has infected status (airportInfectedAfterHours: 10 h at low
 *    contagion, 1 h at high), only the flights the scan found (history or
 *    schedule) carry it on.
 *  - From then on, every flight that leaves it does: each route the scan
 *    found out of it, flown daily at its time of day; and, where the scan
 *    found no route out of it (no data), its normal traffic, assumed: a
 *    large airport's PATTERN_DESTINATIONS.L likeliest destinations and a
 *    medium one's PATTERN_DESTINATIONS.M, each once a day.
 * Each airport reached starts its own departures the same way, to the end
 * of the window, up to TRAFFIC_AIRPORTS_MAX airports.
 * ------------------------------------------------------------------------- */

/**
 * How long an airport takes to get infected status after the outbreak lands
 * there, by HOW CONTAGIOUS (owner ruling, 2026-10-06): 10 h at low, 1 h at
 * high, in a straight line between. Until then only the flights the scan
 * found carry it on; from then on every flight that leaves it does.
 */
export const AIRPORT_INFECTED_AFTER_HOURS = Object.freeze({
  low: 10,
  high: 1,
  zeroHour: 0,
});
export function airportInfectedAfterHours(contagion) {
  const level = cleanContagion(contagion);
  const { low, high, zeroHour } = AIRPORT_INFECTED_AFTER_HOURS;
  // Past HIGH: from an hour down to ZERO HOUR, the moment it lands.
  if (level > OUTBREAK_CONTAGION_HIGH) {
    const t =
      (level - OUTBREAK_CONTAGION_HIGH) /
      (OUTBREAK_CONTAGION_MAX - OUTBREAK_CONTAGION_HIGH);
    return Math.round((high - (high - zeroHour) * t) * 10) / 10;
  }
  const t = level / OUTBREAK_CONTAGION_HIGH;
  return Math.round((low - (low - high) * t) * 10) / 10;
}
export const TRAFFIC_AIRPORTS_MAX = 888;
/** A backstop well past what 888 airports fly in the window. */
export const TRAFFIC_FLIGHTS_MAX = 60_000;
/** Hours past the present the traffic is worked out to. */
export const FUTURE_FLIGHT_HOURS = 48;
/** How many destinations normal traffic flies to, by airport size. */
export const PATTERN_DESTINATIONS = Object.freeze({ L: 14, M: 5 });
/** How far normal traffic flies, by airport size. */
export const PATTERN_RANGE_KM = Object.freeze({ L: 9000, M: 2500 });
/** Long-haul from a large airport: one route to each other continent. */
export const LONG_HAUL_RANGE_KM = 14_000;
const CONTINENTS = Object.freeze(['AF', 'AS', 'EU', 'NA', 'SA', 'OC']);
/** A flight this long is long-haul: drawn ahead of shorter assumed ones. */
export const LONG_HAUL_KM = 3000;
const DAY_MS = 24 * HOUR_MS;

/** A number 0..n-1 that is always the same for the same text. */
function stableIndex(text, n) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n;
}

/**
 * Normal traffic out of an airport the scan has no routes for: the
 * scheduled airports it most likely flies to. Bigger and nearer airports
 * score higher, and one in the same country three times higher; a medium
 * airport flies shorter distances and to fewer places than a large one.
 *
 * @param {{code: string, kind: string, country?: string, lat: number, lon: number}} airport
 * @param {object[]} airports Scheduled airports (kind 'L' or 'M').
 */
export function patternDestinations(airport, airports) {
  const kind = airport?.kind === 'L' ? 'L' : 'M';
  const range = PATTERN_RANGE_KM[kind];
  const scored = [];
  for (const other of airports) {
    if (!other || other.code === airport.code) continue;
    if (other.kind !== 'L' && other.kind !== 'M') continue;
    const km = distanceKm(airport, other);
    if (km < 80 || km > range) continue;
    const weight =
      (other.kind === 'L' ? 10 : 1) *
      (other.country && other.country === airport.country ? 3 : 1);
    scored.push({ other, score: weight / (km + 200) ** 1.2 });
  }
  const picked = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, PATTERN_DESTINATIONS[kind])
    .map((item) => item.other);
  if (kind !== 'L' || !airport.continent) return picked;
  // A large airport also flies long-haul: to the nearest large airport of
  // each other continent within LONG_HAUL_RANGE_KM, so the spread reaches
  // Africa, the Americas, Europe and Oceania too.
  const chosen = new Set(picked.map((a) => a.code));
  for (const continent of CONTINENTS) {
    if (continent === airport.continent) continue;
    if (picked.some((a) => a.continent === continent)) continue;
    let best = null;
    let bestKm = Infinity;
    for (const other of airports) {
      if (other?.kind !== 'L' || other.continent !== continent) continue;
      if (chosen.has(other.code)) continue;
      const km = distanceKm(airport, other);
      if (km <= LONG_HAUL_RANGE_KM && km < bestKm) {
        best = other;
        bestKm = km;
      }
    }
    if (best) {
      picked.push(best);
      chosen.add(best.code);
    }
  }
  return picked;
}

/** The first time at or after `fromMs` that falls at `timeOfDayMs`. */
function nextAt(fromMs, timeOfDayMs) {
  const dayStart = fromMs - (((fromMs % DAY_MS) + DAY_MS) % DAY_MS);
  let at = dayStart + timeOfDayMs;
  if (at < fromMs) at += DAY_MS;
  return at;
}

/**
 * The flights that carry the outbreak beyond the scan: every departure from
 * an airport that has had infected status `infectedAfterHours`, from then to
 * `untilMs`. The scan's own flights are not repeated where they were flown.
 *
 * @param {object} input
 * @param {object[]} input.flights The scan's flights (cleanFlight).
 * @param {string[]} input.outbreakAirports Airports at the outbreak locations.
 * @param {(code: string) => ?object} input.airport An airport by code.
 * @param {object[]} input.airports Scheduled airports, for normal traffic.
 * @param {number} input.startMs When the outbreak airports had it.
 * @param {number} input.untilMs The end of the window.
 * @param {number} [input.infectedAfterHours] Hours from the outbreak
 *   landing to infected status (1 to 10).
 * @returns {{flights: object[], airportsReached: number, capped: boolean}}
 */
export function simulateAirTraffic({
  flights = [],
  outbreakAirports = [],
  airport,
  airports = [],
  startMs,
  untilMs,
  infectedAfterHours = 1,
}) {
  const asked = Number(infectedAfterHours);
  const delayHours = Math.max(
    AIRPORT_INFECTED_AFTER_HOURS.zeroHour,
    Math.min(
      AIRPORT_INFECTED_AFTER_HOURS.low,
      Number.isFinite(asked) ? asked : 1,
    ),
  );
  const known = new Map(); // from code -> flights the scan found out of it
  const flown = new Set(); // route|half-hour of a flight the scan found
  for (const f of flights) {
    if (!f?.from?.code || !f?.to?.code || f.future) continue;
    if (!known.has(f.from.code)) known.set(f.from.code, []);
    known.get(f.from.code).push(f);
    flown.add(
      `${f.from.code}>${f.to.code}|${Math.round(f.departMs / 1_800_000)}`,
    );
  }
  const infectedAt = new Map();
  const queue = [];
  const infect = (code, at) => {
    if (!(at <= untilMs)) return;
    const was = infectedAt.get(code);
    if (was !== undefined && was <= at) return;
    infectedAt.set(code, at);
    queue.push({ code, at });
  };
  for (const code of outbreakAirports) infect(code, startMs);
  const out = [];
  const done = new Set();
  let capped = false;
  while (queue.length) {
    queue.sort((a, b) => a.at - b.at);
    const { code, at } = queue.shift();
    if (done.has(code) || infectedAt.get(code) !== at) continue;
    done.add(code);
    const here = airport(code);
    if (!here) continue;
    // The scan's own flights out of it count from the moment it has it.
    for (const f of known.get(code) || [])
      if (
        f.departMs >= at &&
        (infectedAt.has(f.to.code) || infectedAt.size < TRAFFIC_AIRPORTS_MAX)
      )
        infect(f.to.code, f.arriveMs);
    // From an hour later, every departure: the scan's routes flown daily,
    // or, with no data, its normal traffic.
    const allFrom = at + delayHours * HOUR_MS;
    const routes = new Map();
    for (const f of known.get(code) || []) {
      const timeOfDay = ((f.departMs % DAY_MS) + DAY_MS) % DAY_MS;
      const key = `${f.to.code}|${Math.round(timeOfDay / 1_800_000)}`;
      if (!routes.has(key))
        routes.set(key, {
          to: f.to,
          timeOfDay,
          lengthMs: f.arriveMs - f.departMs,
          source: 'Daily schedule (assumed)',
        });
    }
    if (!routes.size) {
      for (const to of patternDestinations(here, airports)) {
        routes.set(to.code, {
          to,
          // Spread through the day, the same for the same route every time.
          timeOfDay: stableIndex(`${code}>${to.code}`, 48) * 1_800_000,
          lengthMs: flightHours(here, to) * HOUR_MS,
          source: 'Normal air traffic (assumed)',
        });
      }
    }
    for (const route of routes.values()) {
      if (!(route.lengthMs > 0)) continue;
      for (
        let departMs = nextAt(allFrom, route.timeOfDay);
        departMs <= untilMs;
        departMs += DAY_MS
      ) {
        if (
          flown.has(
            `${code}>${route.to.code}|${Math.round(departMs / 1_800_000)}`,
          )
        )
          continue;
        // At the cap, no new airport is reached: a flight to one is left out.
        if (
          !infectedAt.has(route.to.code) &&
          infectedAt.size >= TRAFFIC_AIRPORTS_MAX
        ) {
          capped = true;
          break;
        }
        if (out.length >= TRAFFIC_FLIGHTS_MAX) {
          capped = true;
          break;
        }
        const arriveMs = departMs + route.lengthMs;
        out.push({
          from: { code, name: here.name || '', lat: here.lat, lon: here.lon },
          to: {
            code: route.to.code,
            name: route.to.name || '',
            continent: route.to.continent || '',
            lat: route.to.lat,
            lon: route.to.lon,
          },
          departMs,
          arriveMs,
          hop: 3,
          assumed: true,
          source: route.source,
        });
        infect(route.to.code, arriveMs);
      }
    }
  }
  return {
    flights: out,
    airportsReached: infectedAt.size,
    capped,
    infectedAfterHours: delayHours,
  };
}

/**
 * What the model is given for a forecast: the outbreak now, from the scan and
 * the spread at the present hour, and the places it may name.
 */
export function outbreakForecastScene({
  locations,
  spread,
  speeds,
  flights,
  futureFlights = [],
  candidates,
  articles,
  within24 = [],
}) {
  return {
    outbreakForecast: {
      outbreakLocations: locations.map((l) => l.name),
      reachedByPlane: spread.destinations.map(
        (d) =>
          `${d.code} ${d.name || ''} · landed ${new Date(d.arriveMs).toISOString().slice(0, 16)}Z${d.hop === 2 ? ' · connecting' : ''}`,
      ),
      flightRoutes: flights
        .slice(0, 150)
        .map(
          (f) =>
            `${f.from.code}>${f.to.code}${f.hop === 2 ? ' connecting' : ''}`,
        ),
      scheduledNext48h: futureFlights
        .slice(0, 200)
        .map(
          (f) =>
            `${f.from.code}>${f.to.code} leaves ${new Date(f.departMs).toISOString().slice(0, 16)}Z`,
        ),
      reachNow: spreadSummary(spread, speeds),
      candidates: candidates.map(candidateLine),
      ...(within24.length
        ? { predictedWithin24h: within24.map((f) => f.place) }
        : {}),
    },
    outbreakNews: articles.slice(0, 60),
  };
}

/** The question for one forecast window. */
export function outbreakForecastQuestion(within, keywords = '') {
  const topic = cleanLine(keywords, 80);
  return [
    `Predict where the outbreak${topic ? ` (${topic})` : ''} in SCENE.outbreakForecast.outbreakLocations is most likely to be reported next,`,
    within === 48
      ? 'in the period 24 to 48 hours from now. SCENE.outbreakForecast.predictedWithin24h lists the places already predicted for the first 24 hours: do not repeat them; carry the spread on from them.'
      : 'within the next 24 hours.',
    'Reason from the flights (reachedByPlane, flightRoutes, and scheduledNext48h: the flights expected to leave the airports in the next 48 hours, taken to fly daily), how far each way of travel has reached (reachNow), and the news in SCENE.outbreakNews.',
    'Name only places from SCENE.outbreakForecast.candidates or places named in SCENE.outbreakNews, and none of the outbreak locations.',
    'Answer with at most 12 lines, most likely first, and nothing else, each written: PLACE, COUNTRY | AIRPORT CODE or - | HIGH, MEDIUM or LOW | why, in a few words.',
    'If nothing supports a prediction, answer exactly: NONE.',
  ].join(' ');
}

/** The forecast lines of an answer, with the window they were asked for. */
export function parseForecastLines(text, within, known = []) {
  const knownNames = new Set(
    known.map((l) => cleanLine(l.name).toLowerCase().split(',')[0].trim()),
  );
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s\-*•\d.)]+/, '').trim();
    if (!line.includes('|')) continue;
    const [place = '', code = '', likelihood = '', reason = ''] = line
      .split('|')
      .map((part) => part.trim());
    const name = cleanLine(place);
    const head = name.toLowerCase().split(',')[0].trim();
    if (!name || head.length < 2 || knownNames.has(head) || seen.has(head))
      continue;
    seen.add(head);
    const airport = code.toUpperCase().match(/\b[A-Z0-9]{3,4}\b/)?.[0] || '';
    const level = likelihood.toUpperCase().match(/HIGH|MEDIUM|LOW/)?.[0] || '';
    out.push({
      place: name,
      code: airport,
      likelihood: level,
      reason: cleanLine(reason, 160),
      within: within === 48 ? 48 : 24,
    });
    if (out.length >= 12) break;
  }
  return out;
}
