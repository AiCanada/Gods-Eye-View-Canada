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
  contagionLabel,
  contagionStyle,
  simulateAirTraffic,
  airportInfectedAfterHours,
  patternDestinations,
  PATTERN_DESTINATIONS,
  PATTERN_RANGE_KM,
  TRAFFIC_AIRPORTS_MAX,
  LONG_HAUL_RANGE_KM,
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
  assert.equal(options.length, 97);
  assert.match(options[0].label, /^Hour 1 · 04 09:00 UTC$/);
  assert.match(options[48].label, /^Present · hour 49/);
  assert.deepEqual(
    options.slice(49).map((o) => o.value),
    Array.from({ length: 48 }, (_, i) => 50 + i),
    'every hour to +48 h, for MAP FUTURE SPREAD',
  );
  assert.ok(options.slice(49).every((o) => o.future));
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

test('past the present, a place forecast within 48 h shows only from +24 h on', () => {
  const forecast = [
    { name: 'Ulan-Ude, Russia', lat: 51.83, lon: 107.6, within: 24 },
    { name: 'Chita, Russia', lat: 52.03, lon: 113.5, within: 48 },
  ];
  const at = (hour) =>
    outbreakSpread({
      locations: [],
      forecast,
      present: 49,
      startMs: START,
      hour,
    }).forecast.map((f) => f.name);
  assert.deepEqual(
    at(49),
    ['Ulan-Ude, Russia', 'Chita, Russia'],
    'the present shows both',
  );
  assert.deepEqual(at(60), ['Ulan-Ude, Russia'], '+11 h: the 24 h place only');
  assert.deepEqual(
    at(73),
    ['Ulan-Ude, Russia', 'Chita, Russia'],
    '+24 h: both',
  );
});

test('an airport that has had it an hour sends it out on every flight: its scanned routes daily, or normal traffic with no data', () => {
  const ikt = {
    code: 'UIII',
    kind: 'L',
    country: 'RU',
    lat: 52.268,
    lon: 104.389,
  };
  const ovb = {
    code: 'UNNT',
    kind: 'L',
    country: 'RU',
    lat: 55.012,
    lon: 82.651,
  };
  const svo = {
    code: 'UUEE',
    kind: 'L',
    country: 'RU',
    lat: 55.97,
    lon: 37.41,
  };
  const led = { code: 'ULLI', kind: 'L', country: 'RU', lat: 59.8, lon: 30.26 };
  const uud = {
    code: 'UIUU',
    kind: 'M',
    country: 'RU',
    lat: 51.81,
    lon: 107.44,
  };
  const table = [ikt, ovb, svo, led, uud];
  const byCode = new Map(table.map((a) => [a.code, a]));
  const scanned = [
    // Left an hour after the outbreak: carries it to Novosibirsk.
    cleanFlight({
      from: ikt,
      to: ovb,
      departMs: START + HOUR,
      arriveMs: START + 5 * HOUR,
    }),
    // Left Novosibirsk half an hour after it landed: a scanned flight
    // counts from the moment its airport has it.
    cleanFlight({
      from: ovb,
      to: svo,
      hop: 2,
      departMs: START + 5.5 * HOUR,
      arriveMs: START + 9.5 * HOUR,
    }),
  ];
  const { flights, airportsReached } = simulateAirTraffic({
    flights: scanned,
    outbreakAirports: ['UIII'],
    airport: (code) => byCode.get(code),
    airports: table,
    startMs: START,
    untilMs: START + 30 * HOUR,
  });
  const out = (code) => flights.filter((f) => f.from.code === code);
  // Irkutsk's scanned route again a day later, not where it was flown.
  assert.deepEqual(
    out('UIII').map((f) => [f.to.code, (f.departMs - START) / HOUR]),
    [['UNNT', 25]],
  );
  // Novosibirsk had it at hour 5: from hour 6 its scanned route, daily.
  assert.deepEqual(
    out('UNNT').map((f) => [f.to.code, (f.departMs - START) / HOUR]),
    [['UUEE', 29.5]],
  );
  // Sheremetyevo had it at 9.5 and the scan found no route out of it:
  // its normal traffic, from 10.5 on, every flight assumed.
  const svoOut = out('UUEE');
  assert.ok(svoOut.length > 0);
  assert.ok(svoOut.every((f) => f.departMs >= START + 10.5 * HOUR));
  assert.ok(svoOut.every((f) => f.assumed && f.hop === 3));
  assert.ok(svoOut.every((f) => f.source === 'Normal air traffic (assumed)'));
  assert.ok(airportsReached >= 3);
  // In the spread: the assumed flights carry it, and are marked so.
  const spread = outbreakSpread({
    locations: [],
    flights: [...scanned, ...flights.map((f) => cleanFlight(f))],
    airports: ['UIII'],
    startMs: START,
    hour: 30,
  });
  assert.ok(spread.destinations.some((d) => d.code === 'ULLI'));
  assert.equal(spread.routes[0].assumed, false, 'the scan’s own flights first');
});

test('normal traffic: a large airport flies to more and farther places than a medium one, the same country first', () => {
  const home = { code: 'AAAA', kind: 'L', country: 'RU', lat: 52, lon: 104 };
  const airports = [];
  for (let i = 0; i < 40; i += 1)
    airports.push({
      code: `B${String(i).padStart(3, '0')}`,
      kind: i % 3 ? 'M' : 'L',
      country: i % 2 ? 'RU' : 'CN',
      lat: 52 + (i % 7) - 3,
      lon: 104 + i * 1.5 - 30,
    });
  const large = patternDestinations(home, airports);
  const medium = patternDestinations({ ...home, kind: 'M' }, airports);
  assert.equal(large.length, PATTERN_DESTINATIONS.L);
  assert.equal(medium.length, PATTERN_DESTINATIONS.M);
  assert.ok(medium.every((a) => distanceKm(home, a) <= PATTERN_RANGE_KM.M));
  assert.equal(TRAFFIC_AIRPORTS_MAX, 888);
});

test('HOW CONTAGIOUS draws high thicker and darker, low thinner and lighter; the middle as before', () => {
  const low = contagionStyle(0);
  const mid = contagionStyle(50);
  const high = contagionStyle(100);
  assert.deepEqual([mid.width, mid.strength], [1, 1]);
  assert.ok(Math.abs(mid.fill - 0.12) < 1e-9, 'the fill the map always had');
  assert.ok(low.width < mid.width && mid.width < high.width);
  assert.ok(low.strength < mid.strength && mid.strength < high.strength);
  assert.ok(low.fill < high.fill);
  assert.deepEqual([0, 25, 50, 75, 100].map(contagionLabel), [
    'LOW',
    'MEDIUM-LOW',
    'MEDIUM',
    'MEDIUM-HIGH',
    'HIGH',
  ]);
  assert.equal(contagionStyle('nonsense').level, 50);
  assert.equal(
    outbreakSpread({ locations: [], startMs: START, hour: 1, contagion: 130 })
      .contagion,
    110,
  );
});

test('HOW CONTAGIOUS sets when an airport gets infected status: 10 h at low, 1 h at high', () => {
  assert.deepEqual([0, 50, 100].map(airportInfectedAfterHours), [10, 5.5, 1]);
  const ikt = {
    code: 'UIII',
    kind: 'L',
    country: 'RU',
    lat: 52.268,
    lon: 104.389,
  };
  const uud = {
    code: 'UIUU',
    kind: 'M',
    country: 'RU',
    lat: 51.81,
    lon: 107.44,
  };
  const byCode = new Map([ikt, uud].map((a) => [a.code, a]));
  const first = (infectedAfterHours) =>
    (simulateAirTraffic({
      outbreakAirports: ['UIII'],
      airport: (code) => byCode.get(code),
      airports: [ikt, uud],
      startMs: START,
      untilMs: START + 48 * HOUR,
      infectedAfterHours,
    }).flights.find((f) => f.from.code === 'UIII').departMs -
      START) /
    HOUR;
  assert.ok(first(1) >= 1 && first(1) < 25);
  assert.ok(first(10) >= 10, 'low: nothing leaves before 10 h');
  assert.ok(first(10) >= first(1));
});

test('a large airport also flies long-haul, to the nearest large airport of each other continent', () => {
  const home = {
    code: 'UIII',
    kind: 'L',
    country: 'RU',
    continent: 'AS',
    lat: 52.27,
    lon: 104.39,
  };
  const airports = [
    {
      code: 'UIUU',
      kind: 'M',
      country: 'RU',
      continent: 'AS',
      lat: 51.81,
      lon: 107.44,
    },
    {
      code: 'HECA',
      kind: 'L',
      country: 'EG',
      continent: 'AF',
      lat: 30.12,
      lon: 31.41,
    },
    {
      code: 'FAOR',
      kind: 'L',
      country: 'ZA',
      continent: 'AF',
      lat: -26.14,
      lon: 28.25,
    },
    {
      code: 'PANC',
      kind: 'L',
      country: 'US',
      continent: 'NA',
      lat: 61.17,
      lon: -149.99,
    },
    {
      code: 'SVMI',
      kind: 'L',
      country: 'VE',
      continent: 'SA',
      lat: 10.6,
      lon: -66.99,
    },
    {
      code: 'YSSY',
      kind: 'L',
      country: 'AU',
      continent: 'OC',
      lat: -33.95,
      lon: 151.18,
    },
    {
      code: 'EGLL',
      kind: 'L',
      country: 'GB',
      continent: 'EU',
      lat: 51.47,
      lon: -0.45,
    },
  ];
  const codes = patternDestinations(home, airports).map((a) => a.code);
  for (const code of ['HECA', 'PANC', 'SVMI', 'YSSY', 'EGLL'])
    assert.ok(codes.includes(code), code);
  assert.equal(codes.includes('FAOR'), false, 'one per continent, the nearest');
  assert.ok(distanceKm(home, airports[4]) <= LONG_HAUL_RANGE_KM);
  // A medium airport stays regional.
  const medium = patternDestinations({ ...home, kind: 'M' }, airports).map(
    (a) => a.code,
  );
  assert.deepEqual(medium, ['UIUU']);
});

test('past HIGH the slider runs to ZERO HOUR: an airport counts as infected the moment it lands', () => {
  assert.deepEqual([100, 105, 110].map(airportInfectedAfterHours), [1, 0.5, 0]);
  assert.deepEqual([100, 105, 110].map(contagionLabel), [
    'HIGH',
    'UNDER AN HOUR',
    'ZERO HOUR',
  ]);
  const drawn = ({ width, strength, fill }) => ({ width, strength, fill });
  assert.deepEqual(
    drawn(contagionStyle(110)),
    drawn(contagionStyle(100)),
    'drawn as HIGH',
  );
  const ikt = {
    code: 'UIII',
    kind: 'L',
    country: 'RU',
    lat: 52.268,
    lon: 104.389,
  };
  const uud = {
    code: 'UIUU',
    kind: 'M',
    country: 'RU',
    lat: 51.81,
    lon: 107.44,
  };
  const byCode = new Map([ikt, uud].map((a) => [a.code, a]));
  const run = (infectedAfterHours) =>
    simulateAirTraffic({
      outbreakAirports: ['UIII'],
      airport: (code) => byCode.get(code),
      airports: [ikt, uud],
      startMs: START,
      untilMs: START + 48 * HOUR,
      infectedAfterHours,
    });
  assert.equal(run(0).infectedAfterHours, 0, 'zero is kept, not read as unset');
  assert.ok(run(0).flights.every((f) => f.departMs >= START));
  assert.equal(run(undefined).infectedAfterHours, 1);
});
