import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTBREAK_DEFAULT_LOCATIONS,
  OUTBREAK_MODES,
  PLANE_ROAD_KM,
  circlePoints,
  circleTakesPole,
  cleanFlight,
  cleanLocations,
  cleanSpeed,
  distanceKm,
  outbreakHourOptions,
  outbreakSpread,
  outbreakViewTarget,
  parsePlaceLines,
  parseRouteLines,
  presentHour,
  scanStartMs,
  spreadSummary,
  timeScheduleRoutes,
  outbreakForecastQuestion,
  parseForecastLines,
} from './outbreakCore.mjs';

const HOUR = 3_600_000;
const START = Date.UTC(2026, 9, 4, 8);
const irkutsk = OUTBREAK_DEFAULT_LOCATIONS[0];

test('the box starts with Irkutsk and Shelekhov; the four ways of travel have the owner’s colours and speeds', () => {
  assert.deepEqual(
    OUTBREAK_DEFAULT_LOCATIONS.map((l) => l.name),
    ['Irkutsk, Russia', 'Shelekhov, Russia'],
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.values(OUTBREAK_MODES).map((m) => [
        m.id,
        [m.colorName, m.speedKmh],
      ]),
    ),
    {
      road: ['Blue', 100],
      train: ['Orange', 60],
      boat: ['Yellow', 38],
      plane: ['Red', 100],
    },
  );
  assert.equal(PLANE_ROAD_KM, 100);
  assert.equal(
    cleanLocations(undefined).length,
    2,
    'nothing stored: the defaults',
  );
  assert.deepEqual(cleanLocations([]), [], 'all removed: stays empty');
  assert.equal(cleanSpeed('train', 'fast'), 60);
  assert.equal(cleanSpeed('train', 92.44), 92.4);
});

test('the time menu runs from hour 1 to the present, then into the future', () => {
  const now = START + 48 * HOUR + 20 * 60_000;
  assert.equal(scanStartMs(now, 2), now - 48 * HOUR);
  assert.equal(presentHour(START, now), 49);
  const options = outbreakHourOptions(START, now);
  assert.equal(options.length, 54);
  assert.match(options[0].label, /^Hour 1 · 04 09:00 UTC$/);
  assert.match(options[48].label, /^Present · hour 49/);
  assert.deepEqual(
    options.slice(49).map((o) => [o.value, o.future]),
    [
      [55, true],
      [61, true],
      [73, true],
      [85, true],
      [97, true],
    ],
  );
  assert.match(options.at(-1).label, /^Future · \+48 h/);
});

test('each way of travel reaches speed × hours; boat only near water, train only near a station, both when unknown', () => {
  const spread = outbreakSpread({
    locations: [irkutsk],
    surroundings: { irkutsk: { rail: true, water: true } },
    speeds: { train: 80 },
    startMs: START,
    hour: 3,
  });
  const reach = Object.fromEntries(
    spread.rings.map((r) => [r.mode, r.radiusKm]),
  );
  assert.deepEqual(reach, { road: 300, train: 240, boat: 114 });
  const dry = outbreakSpread({
    locations: [irkutsk],
    surroundings: { irkutsk: { rail: false, water: false } },
    startMs: START,
    hour: 3,
  });
  assert.deepEqual(
    dry.rings.map((r) => r.mode),
    ['road'],
  );
  const hidden = outbreakSpread({
    locations: [irkutsk],
    shown: { road: false },
    startMs: START,
    hour: 3,
  });
  assert.deepEqual(
    hidden.rings.map((r) => r.mode),
    ['train', 'boat'],
    'unknown rail and water count',
  );
});

test('a flight marks its destination once it lands, which then spreads at most 100 km by road', () => {
  const flight = cleanFlight({
    from: { code: 'UIII', lat: 52.268, lon: 104.389 },
    to: { code: 'UUEE', name: 'Sheremetyevo', lat: 55.97, lon: 37.41 },
    departMs: START + HOUR,
    arriveMs: START + 7 * HOUR,
  });
  const at = (hour) =>
    outbreakSpread({ locations: [], flights: [flight], startMs: START, hour });
  assert.equal(at(0.5).routes.length, 0, 'not left yet');
  assert.deepEqual(
    [at(3).routes[0].landed, at(3).destinations.length],
    [false, 0],
    'in the air',
  );
  assert.equal(at(7.5).rings[0].radiusKm, 50);
  assert.equal(at(30).rings[0].radiusKm, PLANE_ROAD_KM);
  assert.match(
    spreadSummary(at(30)).join('\n'),
    /Plane \(Red\): 1 destination reached/,
  );
});

test('schedule routes are timed: first hops leave at the start, connections two hours after landing', () => {
  const ikt = { code: 'UIII', lat: 52.268, lon: 104.389 };
  const ovb = { code: 'UNNT', lat: 55.012, lon: 82.651 };
  const svo = { code: 'UUEE', lat: 55.97, lon: 37.41 };
  const flights = timeScheduleRoutes(
    [
      { from: ikt, to: ovb, hop: 1 },
      { from: ovb, to: svo, hop: 2 },
      { from: svo, to: ikt, hop: 2 }, // its first hop was never flown
    ],
    START,
  );
  assert.equal(flights.length, 2);
  assert.equal(flights[0].departMs, START);
  const flown = distanceKm(ikt, ovb) / 800 + 0.5;
  assert.ok(Math.abs(flights[0].arriveMs - (START + flown * HOUR)) < 1);
  assert.equal(flights[1].departMs, flights[0].arriveMs + 2 * HOUR);
  assert.equal(flights[1].hop, 2);
});

test('a circle closes on itself, and one that takes in a pole is known', () => {
  const ring = circlePoints(52, 104, 500, 32);
  assert.equal(ring.length, 33);
  assert.deepEqual(ring[0], ring.at(-1));
  for (const point of ring)
    assert.ok(Math.abs(distanceKm({ lat: 52, lon: 104 }, point) - 500) < 0.5);
  assert.equal(circleTakesPole(52, 500), false);
  assert.equal(circleTakesPole(52, 4800), true);
});

test('route and place answers are read line by line; known outbreak places are left out', () => {
  assert.deepEqual(
    parseRouteLines('UIII>UUEE\nUIII -> UNNT\nNONE\nUIII>UIII'),
    [
      { from: 'UIII', to: 'UUEE' },
      { from: 'UIII', to: 'UNNT' },
    ],
  );
  const media = parsePlaceLines(
    'Ulan-Ude, Russia | two suspected cases after a trip | https://example.org/a\nIrkutsk, Russia | the first cases | https://example.org/b\nNONE',
    OUTBREAK_DEFAULT_LOCATIONS,
  );
  assert.deepEqual(media, [
    {
      place: 'Ulan-Ude, Russia',
      evidence: 'two suspected cases after a trip',
      link: 'https://example.org/a',
    },
  ]);
  const bot = parsePlaceLines(
    '2026-10-05 · Bratsk · quarantine at the hospital · https://x.com/p/1',
  );
  assert.equal(bot[0].place, 'Bratsk');
  assert.equal(bot[0].link, 'https://x.com/p/1');
});

test('the scan flies the map over the middle of the outbreak, the region in view', () => {
  const target = outbreakViewTarget(OUTBREAK_DEFAULT_LOCATIONS);
  assert.ok(Math.abs(target.lat - 52.249) < 0.01);
  assert.ok(Math.abs(target.lon - 104.202) < 0.01);
  assert.equal(target.heightM, 2_000_000);
  const far = outbreakViewTarget([
    { lat: 52.287, lon: 104.305 },
    { lat: 55.75, lon: 37.62 },
  ]);
  assert.ok(far.heightM > 2_000_000, 'far apart: higher, so both are seen');
  const dateline = outbreakViewTarget([
    { lat: 60, lon: 179 },
    { lat: 60, lon: -179 },
  ]);
  assert.ok(Math.abs(Math.abs(dateline.lon) - 180) < 0.01);
  assert.equal(outbreakViewTarget([]), null);
});

test('FUTURE SPREAD LOCATIONS asks for the next 24 h, then the 24 h after, and reads the places back', () => {
  assert.match(outbreakForecastQuestion(24), /within the next 24 hours/);
  assert.match(outbreakForecastQuestion(48), /24 to 48 hours from now/);
  const rows = parseForecastLines(
    [
      '1. Ulan-Ude, Russia | UIUU | HIGH | road and rail from Irkutsk',
      'Irkutsk, Russia | UIII | HIGH | the outbreak itself',
      'Bratsk, Russia | - | medium | flights',
      'NONE',
    ].join('\n'),
    48,
    OUTBREAK_DEFAULT_LOCATIONS,
  );
  assert.deepEqual(rows, [
    {
      place: 'Ulan-Ude, Russia',
      code: 'UIUU',
      likelihood: 'HIGH',
      reason: 'road and rail from Irkutsk',
      within: 48,
    },
    {
      place: 'Bratsk, Russia',
      code: '',
      likelihood: 'MEDIUM',
      reason: 'flights',
      within: 48,
    },
  ]);
});
