import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTBREAK_DEFAULT_LOCATIONS,
  OUTBREAK_MODES,
  PLANE_ROAD_KM,
  SPREAD_MAX_RADIUS_KM,
  planeRoadKm,
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
  cleanProfile,
  HUMAN_FACTORS,
  DENSITY_BANDS,
  densityRange,
  suggestedContagion,
  profileText,
  outbreakMediaQuestion,
  outbreakSocialInstructions,
  airportInfectedAfterHours,
  patternDestinations,
  PATTERN_DESTINATIONS,
  PATTERN_RANGE_KM,
  TRAFFIC_AIRPORTS_MAX,
  packTraffic,
  unpackTraffic,
  LONG_HAUL_RANGE_KM,
  outbreakForecastQuestion,
  outbreakForecastScene,
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
      road: ['Dark red', 100],
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
  // 49 hours to the present, 48 hourly, then every 6 h to +30 days.
  assert.equal(options.length, 49 + 48 + 112);
  assert.match(options[0].label, /^Hour 1 · 04 09:00 UTC$/);
  assert.match(options[48].label, /^Present · hour 49/);
  assert.deepEqual(
    options.slice(49, 97).map((o) => o.value),
    Array.from({ length: 48 }, (_, i) => 50 + i),
    'every hour to +48 h, for MAP FUTURE SPREAD',
  );
  assert.ok(options.slice(49).every((o) => o.future));
  assert.match(options[96].label, /^Future · \+48 h/);
  assert.match(options[97].label, /^Future · \+2 d 6 h/);
  assert.equal(options.at(-1).value, 49 + 30 * 24);
  assert.match(options.at(-1).label, /^Future · \+30 d · /);
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

test('a flight marks its destination once it lands; it spreads 100 km at road speed, then on at a quarter of it', () => {
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
  // Landed: its dot, and no circle round it (the roads out of it light up).
  assert.equal(at(7.5).destinations.length, 1);
  assert.equal(at(30).rings.length, 0);
  // How far by road after landing: 100 km in the first hour at 100 km/h,
  // then 25 km/h with no stop.
  assert.equal(planeRoadKm(100, 0.5), 50);
  assert.equal(planeRoadKm(100, 1), PLANE_ROAD_KM);
  assert.equal(planeRoadKm(100, 23), PLANE_ROAD_KM + 25 * 22);
  assert.equal(planeRoadKm(60, 4), 100 + 15 * (4 - 100 / 60));
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
  assert.equal(TRAFFIC_AIRPORTS_MAX, Infinity, 'no cap on airports reached');
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

test('PATHOGEN CHARACTERISTICS: optional fields, a suggested HOW CONTAGIOUS, and words for the model', () => {
  assert.deepEqual(cleanProfile({}), {});
  assert.deepEqual(
    cleanProfile({
      transmission: 'teleport',
      r0: 'x',
      asymptomatic: 'maybe',
      incubationDays: -2,
      mutation: 'wild',
    }),
    {},
    'nothing invalid is kept',
  );
  assert.equal(suggestedContagion({}), null, 'nothing set: no suggestion');
  const worst = suggestedContagion({
    transmission: 'airborne',
    r0: 3,
    asymptomatic: 'yes',
    incubationDays: 9,
    mutation: 'high',
  });
  assert.equal(worst.level, 110, 'reaches ZERO HOUR');
  assert.deepEqual(
    worst.parts.map((p) => p.delta),
    [25, 18, 15, 10, 10],
  );
  const mild = suggestedContagion({
    transmission: 'vector',
    r0: 1.1,
    asymptomatic: 'no',
  });
  assert.equal(mild.level, 15);
  assert.equal(suggestedContagion({ transmission: 'contact' }).level, 50);
  assert.equal(profileText({}), '');
  const words = profileText({
    transmission: 'airborne',
    r0: 3,
    incubationDays: 5,
  });
  assert.match(words, /^Pathogen characteristics: transmission airborne/);
  assert.match(words, /R0 3/);
  assert.match(words, /incubation period 5 days/);
  // It travels with the forecast, the media search and the bots.
  const profile = { transmission: 'airborne', r0: 3 };
  assert.match(
    outbreakForecastQuestion(24, '', profile),
    /Pathogen characteristics: transmission airborne/,
  );
  assert.match(
    outbreakMediaQuestion(OUTBREAK_DEFAULT_LOCATIONS, '', profile),
    /R0 3/,
  );
  assert.match(
    outbreakSocialInstructions(OUTBREAK_DEFAULT_LOCATIONS, '', profile),
    /R0 3/,
  );
  assert.doesNotMatch(outbreakForecastQuestion(24), /Pathogen characteristics/);
});

test('HUMAN BEHAVIOR & DEMOGRAPHICS: optional, they move the suggestion and go to the model', () => {
  assert.deepEqual(
    HUMAN_FACTORS.map((f) => f.key),
    [
      'density',
      'densityNew',
      'travel',
      'compliance',
      'vulnerability',
      'season',
      'immunity',
    ],
  );
  assert.deepEqual(cleanProfile({ density: 'moon', immunity: '' }), {});
  const fast = suggestedContagion({
    density: '5m-10m',
    travel: 'high',
    compliance: 'low',
    vulnerability: 'high',
    season: 'winter',
    immunity: 'novel',
  });
  assert.equal(fast.level, 110, '50 + 15 + 10 + 12 + 10 + 10 + 15');
  const slow = suggestedContagion({
    density: '0-10k',
    compliance: 'high',
    immunity: 'strong',
  });
  assert.equal(slow.level, 10, '50 - 10 - 15 - 15');
  // With the pathogen, both count.
  assert.equal(
    suggestedContagion({ transmission: 'airborne', compliance: 'high' }).level,
    60,
  );
  const words = profileText({
    r0: 2,
    density: '5m-10m',
    densityNew: '0-10k',
    immunity: 'novel',
  });
  assert.match(
    words,
    /^Pathogen characteristics: basic reproduction number R0 2./,
  );
  assert.match(
    words,
    /Human behavior and demographics: near patient zero, 5 million – 10 million people \(megacity\); at the new infected locations, 0 – 10,000 people \(rural \/ village\); a novel virus: no natural immunity\./,
  );
  assert.equal(
    suggestedContagion({ density: '5m-10m', densityNew: '5m-10m' }).level,
    75,
    '50 + 15 near patient zero + 8 at the new infected locations, to the nearest 5',
  );
  assert.match(
    outbreakForecastQuestion(24, '', { season: 'winter' }),
    /cold, dry winter air/,
  );
});

test('population density runs in bands of people, from a village to a megacity', () => {
  assert.equal(DENSITY_BANDS.length, 9);
  assert.equal(DENSITY_BANDS[0].low, 0);
  assert.equal(DENSITY_BANDS.at(-1).high, 10_000_000);
  for (let i = 1; i < DENSITY_BANDS.length; i += 1)
    assert.equal(DENSITY_BANDS[i].low, DENSITY_BANDS[i - 1].high, 'no gaps');
  assert.deepEqual(
    [DENSITY_BANDS[0], DENSITY_BANDS[5], DENSITY_BANDS.at(-1)].map(
      densityRange,
    ),
    [
      '0 – 10,000 people',
      '500,000 – 1 million people',
      '5 million – 10 million people',
    ],
  );
  const near = HUMAN_FACTORS.find((f) => f.key === 'density').options;
  const later = HUMAN_FACTORS.find((f) => f.key === 'densityNew').options;
  assert.deepEqual(
    near.map((o) => o.delta),
    [-10, -7, -4, 0, 3, 6, 9, 12, 15],
  );
  assert.deepEqual(
    later.map((o) => o.delta),
    [-5, -3, -2, 0, 2, 3, 5, 6, 8],
  );
  assert.equal(near[5].label, '500,000 – 1 million people · Large city');
  assert.deepEqual(
    cleanProfile({ density: 'dense' }),
    {},
    'the old choices are gone',
  );
});

test('the epidemic model reaches the forecast and the suggested level', () => {
  assert.doesNotMatch(outbreakForecastQuestion(24), /epidemicModel/);
  assert.match(
    outbreakForecastQuestion(24, '', {}, { epidemic: true }),
    /SCENE\.outbreakForecast\.epidemicModel/,
  );
  const scene = outbreakForecastScene({
    locations: [{ name: 'Irkutsk' }],
    spread: { destinations: [], rings: [] },
    speeds: {},
    flights: [],
    candidates: [],
    articles: [],
    epidemic: ['R0 2 · R now 1.8', 'UUEE Sheremetyevo: 80 %'],
  });
  assert.deepEqual(scene.outbreakForecast.epidemicModel, [
    'R0 2 · R now 1.8',
    'UUEE Sheremetyevo: 80 %',
  ]);
  const without = outbreakForecastScene({
    locations: [],
    spread: { destinations: [], rings: [] },
    speeds: {},
    flights: [],
    candidates: [],
    articles: [],
  });
  assert.equal('epidemicModel' in without.outbreakForecast, false);
  const base = suggestedContagion({ r0: 2 }).level;
  const crowded = suggestedContagion({
    r0: 2,
    superspreading: 'high',
    gathering: 'major',
    asymptomaticPct: 50,
  });
  assert.equal(crowded.level, Math.min(110, base + 25));
  assert.ok(crowded.parts.some((part) => part.label === 'gathering major'));
  assert.ok(suggestedContagion({ r0: 2, healthcare: 'high' }).level < base);
});

test('the assumed traffic travels packed and comes back as the same flights', () => {
  const startMs = Date.UTC(2026, 9, 7);
  const a = {
    code: 'UIII',
    name: 'Irkutsk',
    lat: 52.27,
    lon: 104.39,
    continent: 'AS',
  };
  const b = {
    code: 'UUEE',
    name: 'Sheremetyevo',
    lat: 55.97,
    lon: 37.41,
    continent: 'EU',
  };
  const flights = [
    {
      from: a,
      to: b,
      departMs: startMs + 90 * 60_000,
      arriveMs: startMs + 450 * 60_000,
      hop: 3,
      assumed: true,
      source: 'Normal air traffic (assumed)',
    },
    {
      from: b,
      to: a,
      departMs: startMs + 600 * 60_000,
      arriveMs: startMs + 960 * 60_000,
      hop: 3,
      assumed: true,
      source: 'Daily schedule (assumed)',
    },
  ];
  const packed = packTraffic(
    { flights, airportsReached: 2, capped: false, infectedAfterHours: 1 },
    startMs,
  );
  assert.equal(packed.airports.length, 2, 'each airport once');
  assert.equal(packed.flights.length, 10, 'five numbers a flight');
  assert.deepEqual(unpackTraffic(packed), flights);
  assert.equal(packed.airportsReached, 2);
  // An unpacked answer is read as it is.
  assert.deepEqual(unpackTraffic({ flights }), flights);
});

test('with the main roads and rail lines known, road and train follow them instead of a circle', () => {
  const location = { id: 'irk', name: 'Irkutsk', lat: 52.29, lon: 104.3 };
  const spread = outbreakSpread({
    locations: [location],
    surroundings: { irk: { rail: true, water: false } },
    networks: { irk: { road: true, rail: true } },
    startMs: START,
    hour: 3,
  });
  assert.deepEqual(
    spread.reaches.map((r) => [r.mode, r.network, r.locationId, r.km]),
    [
      ['road', 'road', 'irk', 300],
      ['train', 'rail', 'irk', 180],
    ],
  );
  assert.equal(
    spread.rings.some((r) => r.mode === 'road' || r.mode === 'train'),
    false,
  );
  assert.match(
    spreadSummary(spread).join('\n'),
    /Road \(100 km\/h\): 300 km along the main roads, dark red once reached/,
  );
  assert.match(
    spreadSummary(spread).join('\n'),
    /Train \(60 km\/h\): 180 km along the rail lines/,
  );
  // Not known: the circle as before.
  const circle = outbreakSpread({
    locations: [location],
    startMs: START,
    hour: 3,
  });
  assert.equal(circle.reaches.length, 0);
  assert.ok(circle.rings.some((r) => r.mode === 'road' && r.radiusKm === 300));
  assert.equal(OUTBREAK_MODES.boat.label, 'Boat or vehicle');
});

test('with the roads after landing known, no red circle round each landing airport', () => {
  const flight = cleanFlight({
    from: { code: 'UIII', lat: 52.268, lon: 104.389 },
    to: { code: 'UUEE', name: 'Sheremetyevo', lat: 55.97, lon: 37.41 },
    departMs: START + HOUR,
    arriveMs: START + 7 * HOUR,
  });
  const at = (airRoads) =>
    outbreakSpread({
      locations: [],
      flights: [flight],
      startMs: START,
      hour: 30,
      airRoads,
    });
  // No circle either way: before the roads load, only the dot.
  assert.equal(at(false).rings.filter((r) => r.mode === 'plane').length, 0);
  const roads = at(true);
  assert.equal(roads.rings.filter((r) => r.mode === 'plane').length, 0);
  assert.equal(roads.airRoads, true);
  assert.equal(roads.destinations.length, 1, 'the landing dot stays');
  assert.match(
    spreadSummary(roads).join('\n'),
    /roads out of each light up light red/,
  );
});

test('each landing airport counts the infected flights that have landed there by the hour', () => {
  const flight = (departH, code = 'UUEE') =>
    cleanFlight({
      from: { code: 'UIII', lat: 52.268, lon: 104.389 },
      to: { code, lat: 55.97, lon: 37.41 },
      departMs: START + departH * HOUR,
      arriveMs: START + (departH + 6) * HOUR,
    });
  const flights = [flight(1), flight(25), flight(49), flight(2, 'UNNT')];
  const at = (hour) =>
    Object.fromEntries(
      outbreakSpread({
        locations: [],
        flights,
        airports: ['UIII'],
        startMs: START,
        hour,
      }).destinations.map((d) => [d.code, d.landings]),
    );
  assert.deepEqual(at(10), { UUEE: 1, UNNT: 1 });
  assert.deepEqual(at(60), { UUEE: 3, UNNT: 1 });
});
