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
/** The hours past the present the time menu offers. */
export const OUTBREAK_FUTURE_HOURS = Object.freeze([6, 12, 24, 36, 48]);
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
    hop: raw?.hop === 2 ? 2 : 1,
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
 * @returns {{atMs: number, hour: number, rings: object[], routes: object[], origins: object[], destinations: object[]}}
 */
export function outbreakSpread({
  locations = [],
  flights = [],
  speeds = {},
  surroundings = {},
  shown = {},
  forecast = [],
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
  const routes = [];
  const reached = new Map();
  for (const flight of flights) {
    if (flight.departMs > atMs) continue;
    const landed = flight.arriveMs <= atMs;
    routes.push({
      from: flight.from,
      to: flight.to,
      hop: flight.hop,
      landed,
      color: OUTBREAK_MODES.plane.color,
    });
    if (!landed) continue;
    const known = reached.get(flight.to.code);
    if (!known || flight.arriveMs < known.arriveMs)
      reached.set(flight.to.code, {
        ...flight.to,
        arriveMs: flight.arriveMs,
        hop: flight.hop,
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
    routes: on('plane') ? routes : [],
    origins: locations.map((l) => ({
      id: l.id,
      name: l.name,
      lat: l.lat,
      lon: l.lon,
    })),
    destinations: on('plane') ? destinations : [],
    forecast: (Array.isArray(forecast) ? forecast : [])
      .filter((f) => validPoint(f?.lat, f?.lon))
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

/**
 * What the model is given for a forecast: the outbreak now, from the scan and
 * the spread at the present hour, and the places it may name.
 */
export function outbreakForecastScene({
  locations,
  spread,
  speeds,
  flights,
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
    'Reason from the flights (reachedByPlane, flightRoutes), how far each way of travel has reached (reachNow), and the news in SCENE.outbreakNews.',
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
