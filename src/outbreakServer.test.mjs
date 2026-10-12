import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import {
  epiParameters,
  gravityLinks,
  simulateEpidemic,
} from './outbreakEpi.mjs';
import { distanceKm } from './outbreakCore.mjs';
import { TORNADO_KEYS } from './outbreakEpiSensitivity.mjs';
import {
  buildRailGraph,
  buildTransportNetwork,
  hourBandOf,
  networkTiles,
  packRailGraph,
  railVertexIndex,
  tileOf,
} from './outbreakNetwork.mjs';
import { runRailWorldTask } from '../server/providers/outbreakRailWorldTasks.mjs';
import {
  airportTable,
  AIR_RAILS_MAX_TILES,
  chooseAirRailTiles,
  cityTable,
  networkAnswerBytes,
  outbreakFlightHistory,
  outbreakNewsQuery,
  outbreakProxy,
  packLinks,
  parseGeonamesCities,
  parseAirportsCsv,
  readSurroundings,
  readZipEntry,
  runEpidemicInWorker,
  splitCsvLine,
  surroundingsQuery,
  transportNetwork,
  unpackLinks,
  scanExtraAirports,
} from '../server/providers/outbreak.js';

const CSV = [
  '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"',
  '1,"UIII","large_airport","Irkutsk International Airport",52.268,104.389,1675,"AS","RU","RU-IRK","Irkutsk","yes","UIII","IKT","UIII","","","",""',
  '2,"UUEE","large_airport","Sheremetyevo International Airport",55.972,37.415,630,"EU","RU","RU-MOS","Moscow","yes","UUEE","SVO","UUEE","","","",""',
  '3,"UNNT","large_airport","Tolmachevo Airport",55.012,82.651,365,"AS","RU","RU-NVS","Novosibirsk","yes","UNNT","OVB","UNNT","","","",""',
  '4,"RU-0001","small_airport","Field, ""North""",52.3,104.3,0,"AS","RU","RU-IRK","","no","","","","","","",""',
  '5,"XX","heliport","Pad",52.3,104.3,0,"AS","RU","RU-IRK","","no","","","","","","",""',
].join('\n');

test('the airport table reads OurAirports’ quoted CSV and keeps only airports with a four-letter code', () => {
  assert.deepEqual(splitCsvLine('1,"a, b","c ""d"""'), ['1', 'a, b', 'c "d"']);
  const rows = parseAirportsCsv(CSV);
  assert.deepEqual(
    rows.map((r) => [r.code, r.iata, r.kind, r.scheduled]),
    [
      ['UIII', 'IKT', 'L', true],
      ['UUEE', 'SVO', 'L', true],
      ['UNNT', 'OVB', 'L', true],
    ],
  );
});

test('near, candidates and lookup answer from one load, kept on disk', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-outbreak-'));
  try {
    let fetched = 0;
    const fetchImpl = async () => {
      fetched += 1;
      return new Response(CSV, { status: 200 });
    };
    const table = airportTable({ cacheDir: dir, fetchImpl });
    const near = await table.near({ lat: 52.287, lon: 104.305 });
    assert.deepEqual(
      near.map((a) => [a.code, a.km]),
      [['UIII', 6]],
    );
    assert.deepEqual(Object.keys(await table.lookup(['SVO', 'UNNT', 'ZZZZ'])), [
      'SVO',
      'UNNT',
    ]);
    assert.equal(
      (await table.candidates({ lat: 52.287, lon: 104.305 })).length,
      3,
    );
    const again = airportTable({ cacheDir: dir, fetchImpl });
    await again.load();
    assert.equal(fetched, 1, 'the second table read the disk copy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flight history follows the departures, then the connecting flights out of where they landed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-outbreak-'));
  try {
    const table = airportTable({
      cacheDir: dir,
      fetchImpl: async () => new Response(CSV, { status: 200 }),
    });
    const asked = [];
    const fetchImpl = async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer T');
      const params = new URL(url).searchParams;
      asked.push(params.get('airport'));
      if (params.get('airport') === 'UIII')
        return Response.json([
          {
            estDepartureAirport: 'UIII',
            estArrivalAirport: 'UNNT',
            firstSeen: 1000,
            lastSeen: 5000,
            callsign: 'S7 1 ',
          },
        ]);
      if (params.get('airport') === 'UNNT')
        return Response.json([
          {
            estDepartureAirport: 'UNNT',
            estArrivalAirport: 'UUEE',
            firstSeen: 9000,
            lastSeen: 20000,
            callsign: 'SBI2',
          },
        ]);
      return new Response('', { status: 404 });
    };
    const flights = await outbreakFlightHistory({
      airports: ['UIII'],
      beginS: 0,
      endS: 100_000,
      token: 'T',
      table,
      fetchImpl,
    });
    assert.deepEqual(
      flights.map((f) => [
        f.from.code,
        f.to.code,
        f.hop,
        f.departMs,
        f.callsign,
      ]),
      [
        ['UIII', 'UNNT', 1, 1_000_000, 'S7 1'],
        ['UNNT', 'UUEE', 2, 9_000_000, 'SBI2'],
      ],
    );
    assert.ok(asked.includes('UNNT'), 'connecting flights were asked for');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rail, the area’s train speed and water traffic are read from OpenStreetMap', () => {
  assert.match(
    surroundingsQuery({ lat: 52.28, lon: 104.3 }),
    /around:30000,52.28,104.3\)\["railway"="station"\]/,
  );
  assert.match(
    surroundingsQuery({ lat: 52.28, lon: 104.3 }),
    /around:100000,52.28,104.3\)\["amenity"="ferry_terminal"\]/,
  );
  assert.deepEqual(
    readSurroundings([
      { tags: { railway: 'station' } },
      { tags: { railway: 'rail', maxspeed: '80' } },
      { tags: { railway: 'rail', maxspeed: '120' } },
      { tags: { railway: 'rail', maxspeed: 'RU:rail' } },
      { tags: { amenity: 'ferry_terminal' } },
    ]),
    {
      rail: true,
      stations: 1,
      trainKmh: 100,
      railSpeedSamples: 2,
      water: true,
      waterPlaces: 1,
    },
  );
  assert.deepEqual(readSurroundings([]).rail, false);
});

test('the media search asks for the places with the outbreak words', () => {
  assert.equal(
    outbreakNewsQuery(['Irkutsk, Russia', 'Shelekhov, Russia'], ''),
    '(Irkutsk OR Shelekhov) (outbreak OR epidemic OR virus OR infection OR quarantine)',
  );
  assert.equal(
    outbreakNewsQuery(['Ulan-Ude, Russia'], 'avian flu'),
    'Ulan-Ude ("avian flu" OR outbreak OR epidemic OR quarantine)',
  );
  assert.equal(outbreakNewsQuery([], ''), '');
});

/** A one-file zip, deflated, the way GeoNames ships its dumps. */
function zipOf(name, text) {
  const data = deflateRawSync(Buffer.from(text));
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(Buffer.byteLength(text), 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(Buffer.byteLength(text), 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, end]);
}

const CITIES = [
  [
    '2023469',
    'Irkutsk',
    'Irkutsk',
    '',
    '52.29778',
    '104.29639',
    'P',
    'PPLA',
    'RU',
    '',
    '20',
    '',
    '',
    '',
    '586695',
  ],
  [
    '2016422',
    'Shelekhov',
    'Shelekhov',
    '',
    '52.21',
    '104.1',
    'P',
    'PPL',
    'RU',
    '',
    '20',
    '',
    '',
    '',
    '47000',
  ],
  [
    '524901',
    'Moscow',
    'Moscow',
    '',
    '55.75222',
    '37.61556',
    'P',
    'PPLC',
    'RU',
    '',
    '48',
    '',
    '',
    '',
    '10381222',
  ],
  ['1', 'Bad', 'Bad', '', 'x', '0', 'P', 'PPL', 'RU', '', '', '', '', '', '5'],
]
  .map((f) => f.join('\t'))
  .join('\n');

test('GeoNames cities come out of their zip, and are kept on disk', async () => {
  assert.equal(readZipEntry(zipOf('cities15000.txt', 'hi'), 'other.txt'), null);
  assert.equal(readZipEntry(Buffer.from('not a zip'), 'x'), null);
  const rows = parseGeonamesCities(CITIES);
  assert.deepEqual(
    rows.map((c) => [c.id, c.name, c.country, c.population]),
    [
      [2023469, 'Irkutsk', 'RU', 586695],
      [2016422, 'Shelekhov', 'RU', 47000],
      [524901, 'Moscow', 'RU', 10381222],
    ],
  );
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-outbreak-'));
  try {
    let fetched = 0;
    const fetchImpl = async () => {
      fetched += 1;
      return new Response(zipOf('cities500.txt', CITIES), { status: 200 });
    };
    assert.equal(
      (await cityTable({ cacheDir: dir, fetchImpl }).load()).length,
      3,
    );
    const again = await cityTable({ cacheDir: dir, fetchImpl }).load();
    assert.deepEqual(again, rows);
    assert.equal(fetched, 1, 'the second table read the disk copy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** POST a JSON body to the proxy's /api/outbreak route, the page's way. */
async function postTo(proxy, route, body) {
  const uses = [];
  proxy.configureServer({
    config: {},
    middlewares: { use: (...args) => uses.push(args) },
  });
  const handler = uses.find((args) => args[0] === '/api/outbreak')[1];
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: 'POST',
    url: route,
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(status) {
        this.status = status;
        this.headersSent = true;
      },
      end(text) {
        resolve({ status: this.status, json: JSON.parse(text) });
      },
    };
    handler(req, res);
  });
}

test('EPIDEMIC MODEL: the route builds the places and flights and runs the ensemble once per question', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-outbreak-'));
  try {
    const table = airportTable({
      cacheDir: dir,
      fetchImpl: async () => new Response(CSV, { status: 200 }),
    });
    const ran = [];
    const proxy = outbreakProxy({
      table,
      cities: { load: async () => parseGeonamesCities(CITIES) },
      runEpidemic: async (input) => {
        ran.push(input);
        return simulateEpidemic({ ...input, runs: 5 });
      },
    });
    const startMs = Date.UTC(2026, 9, 1);
    const body = {
      startMs,
      untilMs: startMs + 3 * 86_400_000,
      outbreakAirports: ['UIII'],
      locations: [
        { id: 'irkutsk', name: 'Irkutsk, Russia', lat: 52.287, lon: 104.305 },
      ],
      flights: [
        {
          from: 'UIII',
          to: 'UUEE',
          departMs: startMs + 3_600_000,
          arriveMs: startMs + 7 * 3_600_000,
        },
      ],
      profile: { preset: 'covid2020', r0: 2.8, initialCases: 50, bogus: 'x' },
    };
    assert.equal(
      (await postTo(proxy, '/epidemic', { ...body, locations: [] })).status,
      400,
    );
    assert.equal(
      (await postTo(proxy, '/epidemic', { ...body, untilMs: startMs })).status,
      400,
    );
    const answer = await postTo(proxy, '/epidemic', body);
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    const input = ran[0];
    const irk = input.nodes[input.origins[0]];
    assert.equal(irk.id, 'UIII', 'patient zero folds into Irkutsk airport');
    assert.equal(irk.population, 586695 + 47000);
    assert.equal(input.nodes.find((n) => n.id === 'UUEE').population, 10381222);
    assert.ok(
      input.flights.some(
        (f) => input.nodes[f.from].id === 'UIII' && f.passengers > 0,
      ),
    );
    assert.equal(input.params.r0, 2.8);
    // The assumed traffic flies as daily routes; the scan's flight once.
    assert.ok(input.routes.length > 0);
    assert.ok(input.routes.every((r) => r.lengthMs > 0 && r.passengers > 0));
    assert.equal(input.flown.length, 1);
    assert.match(answer.json.populationSource, /GeoNames/);
    assert.ok(answer.json.effectiveDistance.some((e) => e.code === 'UUEE'));
    assert.equal(answer.json.runs, 5);
    // The same question again: the kept answer, no second run.
    await postTo(proxy, '/epidemic', body);
    assert.equal(ran.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ensemble runs in a worker thread and comes back whole', async () => {
  const startMs = Date.UTC(2026, 9, 1);
  const result = await runEpidemicInWorker({
    nodes: [
      { id: 'X', name: 'X', lat: 0, lon: 0, population: 10_000, kind: 'city' },
    ],
    origins: [0],
    flights: [],
    params: epiParameters({ r0: 2, initialCases: 5 }),
    startMs,
    untilMs: startMs + 86_400_000,
    runs: 3,
    seed: 1,
  });
  assert.equal(result.runs, 3);
  assert.equal(result.places[0].id, 'X');
});

test('SV-1 a worker past its deadline hands back run 0 cut short, not an error', async () => {
  const startMs = Date.UTC(2026, 9, 1);
  const result = await runEpidemicInWorker({
    nodes: [
      { id: 'X', name: 'X', lat: 0, lon: 0, population: 10_000, kind: 'city' },
    ],
    origins: [0],
    flights: [],
    params: epiParameters({ r0: 2, initialCases: 5 }),
    startMs,
    untilMs: startMs + 2 * 86_400_000,
    runs: 3,
    seed: 1,
    deadlineMs: Date.now() - 1,
  });
  assert.deepEqual(result.stoppedAt, { run: 0, hour: 6 });
  assert.equal(result.runs, 1);
  assert.equal(result.partial, true);
});

/** The route fixture's question, with a profile of the test's own. */
function routeBody(profile) {
  const startMs = Date.UTC(2026, 9, 1);
  return {
    startMs,
    untilMs: startMs + 3 * 86_400_000,
    outbreakAirports: ['UIII'],
    locations: [
      { id: 'irkutsk', name: 'Irkutsk, Russia', lat: 52.287, lon: 104.305 },
    ],
    flights: [],
    profile: { preset: 'covid2020', initialCases: 50, ...profile },
  };
}

async function withRecordingProxy(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-outbreak-'));
  try {
    const table = airportTable({
      cacheDir: dir,
      fetchImpl: async () => new Response(CSV, { status: 200 }),
    });
    const ran = [];
    const proxy = outbreakProxy({
      table,
      cities: { load: async () => parseGeonamesCities(CITIES) },
      runEpidemic: async (input) => {
        ran.push(input);
        return simulateEpidemic({ ...input, runs: 2 });
      },
    });
    await run(proxy, ran);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SV-3 turning the comparison on keeps the seed, and is kept apart', async () => {
  await withRecordingProxy(async (proxy, ran) => {
    const off = await postTo(
      proxy,
      '/epidemic',
      routeBody({ compare: 'none' }),
    );
    assert.equal(off.status, 200, JSON.stringify(off.json));
    const on = await postTo(proxy, '/epidemic', routeBody({ compare: 'all' }));
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(ran.length, 2, 'two cache entries, two runs');
    assert.equal(ran[0].params.compare, 'none');
    assert.equal(ran[1].params.compare, 'all');
    assert.equal(ran[0].seed, ran[1].seed);
    assert.ok(on.json.counterfactual);
    assert.equal(off.json.counterfactual, undefined);
  });
});

test('SV-4 the second strain’s airport code resolves to the table code', async () => {
  await withRecordingProxy(async (proxy, ran) => {
    const iata = await postTo(
      proxy,
      '/epidemic',
      routeBody({ variants: 'two-strain', strain2Place: 'SVO' }),
    );
    assert.equal(iata.status, 200, JSON.stringify(iata.json));
    assert.equal(ran[0].params.strain2.place, 'UUEE');
    const unknown = await postTo(
      proxy,
      '/epidemic',
      routeBody({ variants: 'two-strain', strain2Place: 'ZZZZ' }),
    );
    assert.equal(unknown.status, 200, JSON.stringify(unknown.json));
    assert.equal(ran[1].params.strain2.place, 'ZZZZ', 'passed on as typed');
  });
});

test('the second identical POST during an in-flight run does not spawn a second worker', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-outbreak-'));
  try {
    const table = airportTable({
      cacheDir: dir,
      fetchImpl: async () => new Response(CSV, { status: 200 }),
    });
    const ran = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const begun = new Promise((resolve) => {
      started = resolve;
    });
    // One list of towns, as the real table keeps: the links are kept by it.
    const towns = parseGeonamesCities(CITIES);
    const proxy = outbreakProxy({
      table,
      cities: { load: async () => towns },
      runEpidemic: async (input, { onLinks } = {}) => {
        ran.push(input);
        started();
        await gate;
        // A worker computes the links when none are given and hands them
        // back packed; given packed links it reads them instead.
        const links = input.links
          ? unpackLinks(input.links)
          : gravityLinks(input.nodes);
        if (!input.links) onLinks(packLinks(links));
        return simulateEpidemic({ ...input, runs: 2, links });
      },
    });
    const startMs = Date.UTC(2026, 9, 1);
    const body = {
      startMs,
      untilMs: startMs + 2 * 86_400_000,
      outbreakAirports: ['UIII'],
      locations: [
        { id: 'irkutsk', name: 'Irkutsk, Russia', lat: 52.287, lon: 104.305 },
      ],
      flights: [
        {
          from: 'UIII',
          to: 'UUEE',
          departMs: startMs + 3_600_000,
          arriveMs: startMs + 7 * 3_600_000,
        },
      ],
      profile: { preset: 'covid2020', r0: 2.8, initialCases: 50 },
    };
    const first = postTo(proxy, '/epidemic', body);
    await begun;
    const second = postTo(proxy, '/epidemic', body);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ran.length, 1, 'the second question waits on the first run');
    release();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.status, 200, JSON.stringify(one.json));
    assert.equal(two.status, 200);
    assert.deepEqual(two.json, one.json);
    assert.equal(ran.length, 1);
    assert.equal(ran[0].links, undefined, 'the first run works the links out');
    // The analytic tornado rides with the answer, one row per key.
    const { sensitivity } = one.json;
    assert.deepEqual(
      [...sensitivity.map((row) => row.key)].sort(),
      [...TORNADO_KEYS].sort(),
    );
    assert.deepEqual(Object.keys(sensitivity[0]), [
      'key',
      'low',
      'high',
      'rLow',
      'rHigh',
      'doublingLow',
      'doublingHigh',
      'swing',
      'doublingSwing',
    ]);
    // The scan's flights are part of the derived seed, and the same places
    // reuse the kept links, handed to the run packed.
    const later = {
      ...body,
      flights: [{ ...body.flights[0], departMs: startMs + 2 * 3_600_000 }],
    };
    assert.equal((await postTo(proxy, '/epidemic', later)).status, 200);
    assert.equal(ran.length, 2);
    assert.notEqual(ran[1].seed, ran[0].seed);
    assert.ok(ran[1].links.offsets instanceof Int32Array);
    assert.ok(ran[1].links.j instanceof Int32Array);
    assert.ok(ran[1].links.share instanceof Float64Array);
    assert.equal(ran[1].links.offsets.length, ran[1].nodes.length + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a patient zero of its own keys the kept links by its population and position', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-outbreak-'));
  try {
    const table = airportTable({
      cacheDir: dir,
      fetchImpl: async () => new Response(CSV, { status: 200 }),
    });
    const ran = [];
    const towns = parseGeonamesCities(CITIES);
    const proxy = outbreakProxy({
      table,
      cities: { load: async () => towns },
      runEpidemic: async (input, { onLinks } = {}) => {
        ran.push(input);
        const links = input.links
          ? unpackLinks(input.links)
          : gravityLinks(input.nodes);
        if (!input.links) onLinks(packLinks(links));
        return simulateEpidemic({ ...input, runs: 2, links });
      },
    });
    const startMs = Date.UTC(2026, 9, 1);
    // Far from every airport and town: patient zero gets a place of its
    // own, sized by the density band.
    const body = (density, lat = 60.5) => ({
      startMs,
      untilMs: startMs + 2 * 86_400_000,
      seed: 7,
      locations: [{ id: 'remote', name: 'Remote', lat, lon: 120.5 }],
      profile: { preset: 'covid2020', initialCases: 50, density },
    });
    const post = async (b) => {
      const res = await postTo(proxy, '/epidemic', b);
      assert.equal(res.status, 200, JSON.stringify(res.json));
    };
    await post(body('0-10k'));
    await post(body('500k-1m'));
    await post(body('500k-1m', 61.5));
    await post(body('500k-1m', 61.5));
    assert.equal(
      ran.length,
      3,
      'the repeated question is answered from the cache',
    );
    assert.ok(
      ran.some((input) => input.nodes.some((n) => n.kind === 'origin')),
    );
    assert.equal(ran[0].links, undefined);
    assert.equal(
      ran[1].links,
      undefined,
      'a new density works the links out again',
    );
    assert.equal(
      ran[2].links,
      undefined,
      'a moved patient zero works them out again',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commuting links pack into flat arrays and back, and round-trip through the worker', async () => {
  const links = [
    [
      { j: 1, share: 0.05 },
      { j: 2, share: 0.025 },
    ],
    [],
    [{ j: 0, share: 0.1 }],
  ];
  const packed = packLinks(links);
  assert.ok(packed.offsets instanceof Int32Array);
  assert.ok(packed.j instanceof Int32Array);
  assert.ok(packed.share instanceof Float64Array);
  assert.deepEqual([...packed.offsets], [0, 2, 2, 3]);
  assert.deepEqual([...packed.j], [1, 2, 0]);
  assert.deepEqual([...packed.share], [0.05, 0.025, 0.1]);
  assert.deepEqual(unpackLinks(packed), links);
  assert.deepEqual(unpackLinks(packLinks([])), []);
  // Three towns a few kilometres apart commute; the worker works the links
  // out once and hands them back packed, then reads them given either way.
  const startMs = Date.UTC(2026, 9, 1);
  const input = {
    nodes: [
      { id: 'X', name: 'X', lat: 0, lon: 0, population: 50_000, kind: 'city' },
      {
        id: 'Y',
        name: 'Y',
        lat: 0.1,
        lon: 0,
        population: 80_000,
        kind: 'city',
      },
      {
        id: 'Z',
        name: 'Z',
        lat: 0,
        lon: 0.1,
        population: 20_000,
        kind: 'city',
      },
    ],
    origins: [0],
    flights: [],
    params: epiParameters({ r0: 3, initialCases: 200 }),
    startMs,
    untilMs: startMs + 2 * 86_400_000,
    runs: 3,
    seed: 7,
  };
  let computed = null;
  const plain = await runEpidemicInWorker(input, {
    onLinks: (given) => {
      computed = given;
    },
  });
  assert.ok(computed, 'the worker hands the links it worked out back');
  assert.ok(computed.offsets instanceof Int32Array);
  assert.equal(computed.offsets.length, 4);
  assert.ok(computed.offsets[3] > 0, 'nearby towns are linked');
  assert.deepEqual(computed, packLinks(gravityLinks(input.nodes)));
  const copy = {
    offsets: computed.offsets.slice(),
    j: computed.j.slice(),
    share: computed.share.slice(),
  };
  let again = null;
  const fromPacked = await runEpidemicInWorker(
    { ...input, links: copy },
    { onLinks: (given) => (again = given) },
  );
  assert.equal(again, null, 'given links are not handed back');
  assert.equal(copy.offsets.length, 0, 'the given arrays were transferred');
  const fromObjects = await runEpidemicInWorker({
    ...input,
    links: unpackLinks(computed),
  });
  assert.deepEqual(fromPacked.places, plain.places);
  assert.deepEqual(fromObjects.places, plain.places);
  assert.deepEqual(fromPacked.totals, plain.totals);
});

test('the road and rail networks: lines from the tile store, joined and measured from the location', async () => {
  const asked = [];
  const networkStore = {
    async lines(tile) {
      asked.push(`${tile.z}/${tile.x}/${tile.y}`);
      // One road and one rail line through Irkutsk, in every tile.
      return {
        major: [
          [
            [104.0, 52.29],
            [104.3, 52.29],
            [104.6, 52.29],
          ],
        ],
        primary: [],
        rail: [
          [
            [104.0, 52.27],
            [104.6, 52.27],
          ],
        ],
      };
    },
  };
  const kept = new Map();
  const proxy = outbreakProxy({
    networkStore,
    // Built in the worker, as in the app; kept in memory here, not on disk.
    builtNetworks: {
      read: (key) => kept.get(key) || null,
      write: (key, value) => kept.set(key, value),
    },
  });
  const get = (query) => {
    const uses = [];
    proxy.configureServer({
      config: {},
      middlewares: { use: (...args) => uses.push(args) },
    });
    const handler = uses.find((args) => args[0] === '/api/outbreak')[1];
    return new Promise((resolve) => {
      handler(
        {
          method: 'GET',
          url: `/network?${query}`,
          headers: { host: 'localhost:5173', 'sec-fetch-site': 'same-origin' },
          socket: { remoteAddress: '127.0.0.1' },
        },
        {
          writeHead(status) {
            this.status = status;
          },
          end(text) {
            resolve({ status: this.status, json: JSON.parse(text) });
          },
        },
      );
    });
  };
  const road = await get('lat=52.287&lon=104.305&mode=road');
  assert.equal(road.status, 200, JSON.stringify(road.json));
  assert.equal(road.json.mode, 'road');
  assert.equal(road.json.failedTiles, 0);
  assert.ok(road.json.network.startKm < 1);
  assert.ok(Object.keys(road.json.network.bands).length >= 2);
  const rail = await get('lat=52.287&lon=104.305&mode=rail');
  assert.equal(rail.json.mode, 'rail');
  const before = asked.length;
  await get('lat=52.287&lon=104.305&mode=road');
  assert.equal(asked.length, before, 'kept: no tiles asked again');
  assert.equal((await get('mode=road')).status, 400);
  // Roads farther with each level: coarser tiles, a wider reach.
  const wide = await get('lat=52.287&lon=104.305&mode=road&level=3');
  assert.deepEqual(
    [wide.json.level, wide.json.lastLevel, wide.json.radiusKm],
    [3, true, 8000],
  );
  assert.ok(
    asked.some((t) => t.startsWith('5/')) &&
      asked.some((t) => t.startsWith('6/')),
  );
  assert.ok(kept.has('road-p3-L3-52.29_104.31'));
  // Rail stays the first level.
  assert.equal(
    (await get('lat=52.287&lon=104.305&mode=rail&level=3')).json.level,
    1,
  );
});

// Owner report, 2026-10-12: Saint John NB had no rail lit. The coarse tiles
// carry main lines only; its nearest is 98 km off, its own line is only in
// the finer tiles.
test('the rail round a location: finer tiles stand in near it when the coarse ones have no rail within reach', async () => {
  const point = { lat: 45.2733, lon: -66.0633 };
  const home10 = tileOf(point.lat, point.lon, 10);
  // A main line 250 km north, well past the finer tiles' 100 km.
  const far = { lat: point.lat + 250 / 111.2, lon: point.lon };
  const far8 = tileOf(far.lat, far.lon, 8);
  const farLine = Array.from({ length: 11 }, (_, i) => [
    far.lon - 0.5 + i * 0.1,
    far.lat,
  ]);
  // The local line, 11 km, only in the finer tiles.
  const localLine = Array.from({ length: 11 }, (_, i) => [
    point.lon,
    point.lat - 0.05 + i * 0.01,
  ]);
  // A coarse line 40 km south, 20 km long: past the 30 km a network starts
  // within, and in a coarse tile the finer ones replace (they carry no line
  // there here), so it is left out, not counted.
  const south = { lat: point.lat - 40 / 111.2, lon: point.lon };
  const south8 = tileOf(south.lat, south.lon, 8);
  const coarseSouth = [
    [
      [south.lon - 10 / 78.6, south.lat],
      [south.lon + 10 / 78.6, south.lat],
    ],
  ];
  const make = (withFine) => {
    const asked = [];
    return {
      asked,
      async lines(tile) {
        asked.push(tile);
        const empty = { motorway: [], major: [], primary: [], rail: [] };
        if (tile.z === 8 && tile.x === far8.x && tile.y === far8.y)
          return { ...empty, rail: [farLine] };
        if (tile.z === 8 && tile.x === south8.x && tile.y === south8.y)
          return { ...empty, rail: coarseSouth };
        if (
          withFine &&
          tile.z === 10 &&
          tile.x === home10.x &&
          tile.y === home10.y
        )
          return { ...empty, rail: [localLine] };
        return empty;
      },
    };
  };
  const store = make(true);
  const result = await transportNetwork(point, 'rail', store);
  assert.ok(result.network, 'rail found');
  assert.ok(result.network.startKm < 1, `${result.network.startKm} km`);
  // The main line, 250 km off, is past the 200 km a rail gap is crossed.
  assert.equal(result.network.unreached.length, 1);
  const coarse = store.asked.filter((t) => t.z === 8).length;
  const fine = store.asked.filter((t) => t.z === 10);
  assert.ok(fine.length > 0 && fine.length % 16 === 0, `${fine.length}`);
  assert.equal(result.tiles, coarse + fine.length);
  // Every fine tile lies inside a coarse one within 100 km.
  const inner = new Set(
    networkTiles(point, 100, 8).map((t) => `${t.x}/${t.y}`),
  );
  for (const t of fine)
    assert.ok(inner.has(`${t.x >> 2}/${t.y >> 2}`), `${t.x}/${t.y}`);
  // The main line and the 11 km local line; not the coarse line south, nor
  // the gaps between.
  const lineKm = (line) =>
    line
      .slice(1)
      .reduce(
        (sum, [x, y], i) =>
          sum +
          distanceKm({ lat: line[i][1], lon: line[i][0] }, { lat: y, lon: x }),
        0,
      );
  const expected = lineKm(farLine) + lineKm(localLine);
  assert.ok(
    Math.abs(result.network.lengthKm - expected) <= 1,
    `${result.network.lengthKm} km, not ${expected}`,
  );

  // No finer rail either: no network, as before.
  const none = await transportNetwork(point, 'rail', make(false));
  assert.equal(none.network, null);

  // Rail near in the coarse tiles: no finer tiles asked.
  const near = make(true);
  const paris = { lat: 48.8566, lon: 2.3522 };
  const parisHome = tileOf(paris.lat, paris.lon, 8);
  near.lines = async (tile) => {
    near.asked.push(tile);
    const empty = { motorway: [], major: [], primary: [], rail: [] };
    return tile.x === parisHome.x && tile.y === parisHome.y
      ? {
          ...empty,
          rail: [
            [
              [paris.lon, paris.lat],
              [paris.lon + 0.2, paris.lat],
            ],
          ],
        }
      : empty;
  };
  const coarseOnly = await transportNetwork(paris, 'rail', near);
  assert.ok(coarseOnly.network);
  assert.ok(near.asked.every((t) => t.z === 8));
});

test('the roads after landing: one network round every landing airport, lit by the hour each is reached', async () => {
  const asked = [];
  const networkStore = {
    async lines(tile) {
      asked.push(`${tile.z}/${tile.x}/${tile.y}`);
      // A trunk road west–east past both airports.
      return {
        motorway: [],
        major: [
          [
            [36, 55.9],
            [37.4, 55.97],
            [38.5, 56],
          ],
        ],
        primary: [],
        rail: [],
      };
    },
  };
  const proxy = outbreakProxy({
    networkStore,
    buildNetwork: async (lines, at, options) =>
      buildTransportNetwork(lines, at, options),
  });
  const uses = [];
  proxy.configureServer({
    config: {},
    middlewares: { use: (...args) => uses.push(args) },
  });
  const handler = uses.find((args) => args[0] === '/api/outbreak')[1];
  const post = (body) =>
    new Promise((resolve) => {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      Object.assign(req, {
        method: 'POST',
        url: '/air-roads',
        headers: {
          host: 'localhost:5173',
          origin: 'http://localhost:5173',
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        socket: { remoteAddress: '127.0.0.1' },
      });
      handler(req, {
        writeHead(status) {
          this.status = status;
        },
        end(text) {
          resolve({ status: this.status, json: JSON.parse(text) });
        },
      });
    });
  assert.equal((await post({ destinations: [] })).status, 400);
  const answer = await post({
    destinations: [{ code: 'UUEE', lat: 55.97, lon: 37.41, hour: 12 }],
    speedKmh: 100,
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.equal(answer.json.network.bandsBy, 'hour');
  const bands = Object.keys(answer.json.network.bands).map(Number);
  assert.ok(Math.min(...bands) >= 12, 'nothing lit before the landing');
  assert.ok(
    asked.every((t) => t.startsWith('5/')),
    'coarse tiles',
  );
  // The same landings again: kept, no tiles asked again.
  const before = asked.length;
  await post({
    destinations: [{ code: 'UUEE', lat: 55.97, lon: 37.41, hour: 12 }],
    speedKmh: 100,
  });
  assert.equal(asked.length, before);
});

test('round North American landings the roads after landing take in primary roads too', async () => {
  const asked = [];
  const networkStore = {
    async lines(tile) {
      asked.push(tile.z);
      // Coarse tiles: a trunk road; finer tiles: a primary road joining it.
      return tile.z === 7
        ? {
            motorway: [],
            major: [],
            primary: [
              [
                [-94.6, 39.1],
                [-94.6, 39.6],
              ],
            ],
            rail: [],
          }
        : {
            motorway: [],
            major: [
              [
                [-95.2, 39.1],
                [-94.6, 39.1],
                [-94, 39.1],
              ],
            ],
            primary: [],
            rail: [],
          };
    },
  };
  const proxy = outbreakProxy({
    networkStore,
    buildNetwork: async (lines, at, options) =>
      buildTransportNetwork(lines, at, options),
  });
  const uses = [];
  proxy.configureServer({
    config: {},
    middlewares: { use: (...args) => uses.push(args) },
  });
  const handler = uses.find((args) => args[0] === '/api/outbreak')[1];
  const answer = await new Promise((resolve) => {
    const req = Readable.from([
      Buffer.from(
        JSON.stringify({
          destinations: [{ code: 'KMCI', lat: 39.3, lon: -94.7, hour: 20 }],
        }),
      ),
    ]);
    Object.assign(req, {
      method: 'POST',
      url: '/air-roads',
      headers: {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
      },
      socket: { remoteAddress: '127.0.0.1' },
    });
    handler(req, {
      writeHead(status) {
        this.status = status;
      },
      end(text) {
        resolve({ status: this.status, json: JSON.parse(text) });
      },
    });
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.ok(asked.includes(7), 'finer tiles for primary roads');
  assert.ok(asked.includes(5));
  // The primary road north out of the city is lit with the trunk road.
  const flat = Object.values(answer.json.network.bands).flat();
  assert.ok(
    flat.some((f) => f.some((v, i) => i % 2 === 1 && v > 39.4)),
    'the primary road is drawn',
  );
});

test('the rail after landing: rail lines only, fine tiles, lit from the hour each landing reaches them at train speed', async () => {
  // A rail line due north from Paris CDG for 600 km (a meridian, so km
  // along it are km from the airport), and roads that must not come back.
  const cdg = { lat: 49.01, lon: 2.55 };
  const northKm = 600;
  // A point every 5 km, as real rail lines have: the hours between two
  // points are blended straight.
  const railLine = Array.from({ length: northKm / 5 + 1 }, (_, i) => [
    cdg.lon,
    cdg.lat + (i * 5) / 111.2,
  ]);
  const home = tileOf(cdg.lat, cdg.lon, 8);
  const asked = [];
  const networkStore = {
    async lines(tile) {
      asked.push(tile);
      // The rail once (from the airport's own tile), roads everywhere.
      const own = tile.x === home.x && tile.y === home.y;
      return {
        motorway: [
          [
            [1.9, 48.8],
            [1.9, 49.2],
          ],
        ],
        major: [
          [
            [1.8, 48.8],
            [1.8, 49.2],
          ],
        ],
        primary: [
          [
            [1.7, 48.8],
            [1.7, 49.2],
          ],
        ],
        rail: own ? [railLine] : [],
      };
    },
  };
  const post = (body, raw = null) => {
    // A proxy each time: the traffic rate limit is per proxy.
    const proxy = outbreakProxy({
      networkStore,
      buildNetwork: async (lines, at, options) =>
        buildTransportNetwork(lines, at, options),
    });
    const uses = [];
    proxy.configureServer({
      config: {},
      middlewares: { use: (...args) => uses.push(args) },
    });
    const handler = uses.find((args) => args[0] === '/api/outbreak')[1];
    return new Promise((resolve) => {
      const req = Readable.from([Buffer.from(raw ?? JSON.stringify(body))]);
      Object.assign(req, {
        method: 'POST',
        url: '/air-rails',
        headers: {
          host: 'localhost:5173',
          origin: 'http://localhost:5173',
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        socket: { remoteAddress: '127.0.0.1' },
      });
      handler(req, {
        writeHead(status) {
          this.status = status;
        },
        end(text) {
          resolve({ status: this.status, json: JSON.parse(text) });
        },
      });
    });
  };
  // A malformed body, or no landings: 400.
  assert.equal((await post(null, '{not json')).status, 400);
  assert.equal((await post({ destinations: [] })).status, 400);

  const one = await post({
    destinations: [{ code: 'LFPG', ...cdg, hour: 10 }],
    speedKmh: 60,
  });
  assert.equal(one.status, 200, JSON.stringify(one.json));
  assert.equal(one.json.failedTiles, 0);
  assert.equal(one.json.skippedLandings, 0);
  assert.equal(one.json.landings, 1);
  assert.equal(one.json.radiusKm, 200);
  assert.ok(asked.length > 0 && asked.every((t) => t.z === 8), 'z8 tiles');
  const network = one.json.network;
  assert.equal(network.bandsBy, 'hour');
  // Only the rail: its length, and no road's coordinates.
  assert.ok(
    Math.abs(network.lengthKm - northKm) <= northKm * 0.01,
    `${network.lengthKm} km`,
  );
  const pieces = Object.entries(network.bands).flatMap(([band, list]) =>
    list.map((flat) => [Number(band), flat]),
  );
  assert.ok(pieces.length >= 2);
  for (const [, flat] of pieces)
    for (let i = 0; i < flat.length; i += 2)
      assert.ok(flat[i] > 2.4, `a road point drawn: ${flat[i]}`);
  assert.deepEqual(network.unreached, []);
  // Each piece in the band of the hour its far end is reached (2026-10-12):
  // 100 km at train speed, then a quarter of it, from the landing hour.
  const hoursFor = (d) => (d <= 100 ? d / 60 : 100 / 60 + (d - 100) / 15);
  for (const [band, flat] of pieces) {
    const d = (Math.max(flat[1], flat[flat.length - 1]) - cdg.lat) * 111.2;
    const near = [d - 1, d + 1].map((x) =>
      hourBandOf(10 + hoursFor(Math.max(0, x))),
    );
    assert.ok(
      band >= near[0] && band <= near[1],
      `piece ${d.toFixed(1)} km along in band ${band}, not ${near}`,
    );
  }
  assert.equal(Math.min(...pieces.map(([b]) => b)), 10, 'from the landing');
  // 50 km along at 60 km/h: hour 10 + 50/60.
  assert.equal(hourBandOf(10 + hoursFor(50)), 10);

  // Two landings: the stretch near the later one is lit by whichever
  // landing reaches it first.
  const farEnd = { lat: railLine.at(-1)[1], lon: cdg.lon };
  const nearEndBand = (answer) => {
    let best = null;
    for (const [b, list] of Object.entries(answer.json.network.bands))
      for (const flat of list)
        for (let i = 1; i < flat.length; i += 2)
          if (farEnd.lat - flat[i] < 0.05)
            best = best === null ? Number(b) : Math.min(best, Number(b));
    return best;
  };
  // Pieces after a landing keep to one hour band (2026-10-12; they were
  // 100 km long, lit from their first point reached, so the last 100 km
  // showed from hour 38.3, hours before CDG's spread got there).
  const later = await post({
    destinations: [
      { code: 'B', ...farEnd, hour: 20 },
      { code: 'LFPG', ...cdg, hour: 10 },
    ],
    speedKmh: 60,
  });
  assert.equal(later.status, 200, JSON.stringify(later.json));
  assert.equal(nearEndBand(later), 20, 'lit from the later landing');
  const tooLate = await post({
    destinations: [
      { code: 'LFPG', ...cdg, hour: 10 },
      { code: 'B', ...farEnd, hour: 40 },
    ],
    speedKmh: 60,
  });
  // From CDG at hour 10 the far end, about 600 km on, is reached at
  // 10 + 100/60 + 500/15 = hour 45: the landing there at hour 40 is first.
  assert.equal(nearEndBand(tooLate), 40, 'lit from the far landing');

  // No rail within reach of the landing: no network, still 200.
  const none = await post({
    destinations: [{ code: 'X', lat: 48.2, lon: 2.55, hour: 5 }],
    speedKmh: 60,
  });
  assert.equal(none.status, 200, JSON.stringify(none.json));
  assert.equal(none.json.network, null);

  // More landings than fit: at most AIR_RAILS_MAX_TILES tiles. (Changed
  // 2026-10-12: the earliest landings no longer take every tile;
  // chooseAirRailTiles shares them out by region, so the kept landings are
  // not simply the earliest. Then the budget went from 400 to 7,000 tiles,
  // so it takes 2,400 landings, not 200, for the 60 km round each to
  // overrun it.) Landings 2 degrees apart north to south, 6 east to west.
  asked.length = 0;
  const many = [];
  for (let i = 0; i < 2400; i += 1) {
    const lat = -70 + (i % 71) * 2;
    const lon = -177 + Math.floor(i / 71) * 6;
    // None within reach of CDG's rail.
    if (Math.abs(lat - 49) < 5 && Math.abs(lon - 2.5) < 7) continue;
    many.push({ code: `L${i}`, lat, lon, hour: i });
  }
  const wanted = new Set(
    many.flatMap((d) => networkTiles(d, 60, 8).map((t) => `${t.x}/${t.y}`)),
  );
  assert.ok(wanted.size > AIR_RAILS_MAX_TILES, `${wanted.size} tiles wanted`);
  const big = await post({ destinations: [...many].reverse(), speedKmh: 60 });
  assert.equal(big.status, 200, JSON.stringify(big.json));
  assert.ok(asked.length <= AIR_RAILS_MAX_TILES, `${asked.length} tiles`);
  assert.equal(big.json.tiles, asked.length);
  assert.ok(big.json.skippedLandings > 0);
  assert.equal(big.json.landings + big.json.skippedLandings, many.length);
  // Only CDG's tile carries rail, and none of these is near it.
  assert.equal(big.json.network, null);
  assert.equal(big.json.seededLandings, 0);
  // A kept landing's own tile is asked; a left-out one's is not.
  const askedKeys = new Set(asked.map((t) => `${t.x}/${t.y}`));
  const tileKey = (d) => {
    const t = tileOf(d.lat, d.lon, 8);
    return `${t.x}/${t.y}`;
  };
  assert.equal(
    many.filter((d) => askedKeys.has(tileKey(d))).length,
    big.json.landings,
  );
  // The first landing in each 30 degree cell is always kept.
  const firstInCell = new Map();
  for (const d of many) {
    const cell = `${Math.floor(d.lat / 30)},${Math.floor(d.lon / 30)}`;
    if (!firstInCell.has(cell)) firstInCell.set(cell, d);
  }
  for (const d of firstInCell.values())
    assert.ok(askedKeys.has(tileKey(d)), `kept ${d.code}`);
});

// Owner report, 2026-10-12: "rail lines in Europe, USA, Canada, Mexico not
// showing as infected". With the outbreak starting in Asia, the earliest
// landings (all in Asia) took the whole 400-tile budget.
const ASIA_FIRST = [
  ['IKT', 52.27, 104.39],
  ['UUD', 51.81, 107.44],
  ['ULN', 47.84, 106.77],
  ['KJA', 56.17, 92.49],
  ['PEK', 40.08, 116.58],
  ['OVB', 55.01, 82.65],
  ['VVO', 43.4, 132.15],
  ['PVG', 31.14, 121.81],
  ['ICN', 37.46, 126.44],
  ['SVX', 56.74, 60.8],
  ['SVO', 55.97, 37.41],
  ['ALA', 43.35, 77.04],
  ['CTU', 30.58, 103.95],
  ['HKG', 22.31, 113.92],
  ['NRT', 35.77, 140.39],
  ['TAS', 41.26, 69.28],
  ['LED', 59.8, 30.26],
  ['CAN', 23.39, 113.3],
  ['BKK', 13.69, 100.75],
  ['IST', 41.26, 28.74],
  ['DEL', 28.56, 77.1],
  ['DXB', 25.25, 55.36],
  ['KHV', 48.53, 135.19],
  ['IKT', 52.27, 104.39],
  ['HRB', 45.62, 126.25],
  ['SHE', 41.64, 123.48],
  ['XIY', 34.45, 108.75],
  ['KMG', 25.1, 102.93],
  ['CKG', 29.72, 106.64],
  ['WUH', 30.78, 114.21],
];
const WEST_LATER = [
  ['CDG', 49.01, 2.55],
  ['ORD', 41.98, -87.9],
  ['YYZ', 43.68, -79.63],
  ['MEX', 19.44, -99.07],
];
const asiaThenWest = () =>
  [...ASIA_FIRST, ...WEST_LATER].map(([code, lat, lon], i) => ({
    code,
    lat,
    lon,
    hour: i,
  }));

test('the rail after landing: 30 landings in Asia before Paris, Chicago, Toronto and Mexico City still leave all four their tiles', () => {
  const landings = asiaThenWest();
  // Over budget: about 20 tiles a landing, 34 landings.
  const all = new Set(
    landings.flatMap((d) =>
      networkTiles(d, 200, 8).map((t) => `${t.x}/${t.y}`),
    ),
  );
  assert.ok(all.size > 400, `${all.size} tiles wanted`);
  // The sharing out, at the old 400-tile budget: still over it here.
  const chosen = chooseAirRailTiles(landings, { maxTiles: 400 });
  assert.ok(chosen.tiles.length <= 400, `${chosen.tiles.length} tiles`);
  const keys = new Set(chosen.tiles.map((t) => `${t.x}/${t.y}`));
  const codes = chosen.sources.map((d) => d.code);
  for (const [code, lat, lon] of WEST_LATER) {
    assert.ok(codes.includes(code), `${code} kept`);
    // Every tile within the 60 km a landing starts the rail from.
    for (const t of networkTiles({ lat, lon }, 60, 8))
      assert.ok(keys.has(`${t.x}/${t.y}`), `${code} tile ${t.x}/${t.y}`);
  }
  // Kept in landing order; every kept landing has its own tile; the same
  // airport landed at again costs nothing and is kept.
  const hours = chosen.sources.map((d) => d.hour);
  assert.deepEqual(
    hours,
    [...hours].sort((a, b) => a - b),
  );
  for (const d of chosen.sources) {
    const t = tileOf(d.lat, d.lon, 8);
    assert.ok(keys.has(`${t.x}/${t.y}`), `${d.code} own tile`);
  }
  assert.equal(codes.filter((c) => c === 'IKT').length, 2);
  assert.equal(chosen.skipped, landings.length - chosen.sources.length);
  // No tile twice.
  assert.equal(keys.size, chosen.tiles.length);
});

test('the rail after landing: Paris, Chicago, Toronto and Mexico City lit after 30 landings in Asia, with its own rate limit', async () => {
  const landings = asiaThenWest();
  // A 100 km rail line north from each airport, in the airport's own tile.
  const homes = new Map();
  for (const d of landings) {
    const t = tileOf(d.lat, d.lon, 8);
    homes.set(`${t.x}/${t.y}`, [
      Array.from({ length: 21 }, (_, i) => [d.lon, d.lat + (i * 5) / 111.2]),
    ]);
  }
  const asked = [];
  const networkStore = {
    async lines(tile) {
      asked.push(tile);
      return {
        motorway: [],
        major: [],
        primary: [],
        rail: homes.get(`${tile.x}/${tile.y}`) || [],
      };
    },
  };
  const proxy = outbreakProxy({
    networkStore,
    buildNetwork: async (lines, at, options) =>
      buildTransportNetwork(lines, at, options),
  });
  const uses = [];
  proxy.configureServer({
    config: {},
    middlewares: { use: (...args) => uses.push(args) },
  });
  const handler = uses.find((args) => args[0] === '/api/outbreak')[1];
  const post = (url, body) =>
    new Promise((resolve) => {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      Object.assign(req, {
        method: 'POST',
        url,
        headers: {
          host: 'localhost:5173',
          origin: 'http://localhost:5173',
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        socket: { remoteAddress: '127.0.0.1' },
      });
      handler(req, {
        writeHead(status) {
          this.status = status;
        },
        end(text) {
          resolve({ status: this.status, json: JSON.parse(text) });
        },
      });
    });
  // The roads after landing use up their rate limit first: the rail after
  // landing has its own and still answers.
  for (let i = 0; i < 10; i += 1)
    await post('/air-roads', { destinations: [landings[0]], speedKmh: 100 });
  const roadsAgain = await post('/air-roads', {
    destinations: [landings[0]],
    speedKmh: 100,
  });
  assert.equal(roadsAgain.status, 429);
  asked.length = 0;
  const answer = await post('/air-rails', {
    destinations: landings,
    speedKmh: 60,
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.ok(asked.length <= AIR_RAILS_MAX_TILES, `${asked.length} tiles`);
  assert.equal(answer.json.tiles, asked.length);
  assert.ok(answer.json.landings >= 30, `${answer.json.landings} kept`);
  // Within the 7,000-tile budget, every landing is kept.
  assert.equal(answer.json.skippedLandings, 0);
  assert.equal(answer.json.seededLandings, answer.json.landings);
  const pieces = Object.entries(answer.json.network.bands).flatMap(
    ([band, list]) => list.map((flat) => [Number(band), flat]),
  );
  for (const [code, lat, lon] of WEST_LATER) {
    const hour = landings.find((d) => d.code === code).hour;
    const lit = pieces.filter(([, flat]) =>
      flat.some(
        (v, i) =>
          i % 2 === 0 &&
          Math.abs(v - lon) < 0.01 &&
          flat[i + 1] >= lat - 0.01 &&
          flat[i + 1] <= lat + 1,
      ),
    );
    assert.ok(lit.length > 0, `${code} rail lit`);
    assert.equal(Math.min(...lit.map(([b]) => b)), hourBandOf(hour), code);
  }
});

test('scan airports join the world list once, by their resolved code', () => {
  const known = [{ code: 'CYYZ' }, { code: 'EGLL' }];
  const table = {
    YYZ: 'CYYZ',
    CYYZ: 'CYYZ',
    LHR: 'EGLL',
    YVR: 'CYVR',
    CYVR: 'CYVR',
    XXX: null,
  };
  const view = (code) => (table[code] ? { code: table[code] } : null);
  const extra = scanExtraAirports(
    known,
    ['YYZ', 'CYYZ', 'LHR', 'YVR', 'CYVR', 'XXX'],
    view,
  );
  assert.deepEqual(
    extra.map((a) => a.code),
    ['CYVR'],
  );
  assert.deepEqual(
    known.map((a) => a.code),
    ['CYYZ', 'EGLL'],
    'the world list is not changed',
  );
});

/* ---- EVERY RAIL LINE ON THE GLOBE (owner ruling 2026-10-12) ---- */

/**
 * A built world rail for the proxy: one line from Irkutsk 1,000 km west
 * past Krasnoyarsk, kept on disk as the job keeps it, answered by the real
 * tasks (in this thread, not a worker).
 */
function worldRailFixture(dir, { ready = true } = {}) {
  const line = Array.from({ length: 101 }, (_, i) => [
    104.3 - i * 0.12,
    52.27 + i * 0.037,
  ]);
  const graph = buildRailGraph([line], { countryAt: () => 'RU' });
  const file = path.join(dir, 'rail-world-v1-test.bin');
  writeFileSync(file, packRailGraph(graph, { builtAt: 77 }));
  const index = railVertexIndex(graph);
  const started = [];
  const tasks = [];
  return {
    started,
    tasks,
    lengthKm: graph.lengthKm,
    start: (points) => started.push(...points),
    ready: () => ready,
    build: () => (ready ? { file, builtAt: 77 } : null),
    status: () => ({
      state: ready ? 'ready' : 'sweeping',
      tilesTotal: 10,
      tilesDone: ready ? 10 : 4,
      tilesCached: 4,
      tilesFetched: 6,
      tilesFailed: 0,
      railKm: ready ? graph.lengthKm : 0,
      byContinent: {
        AF: 0,
        AS: ready ? graph.lengthKm : 0,
        EU: 0,
        NA: 0,
        SA: 0,
        OC: 0,
      },
      builtAt: ready ? 77 : null,
      version: 1,
    }),
    near: (point, km) => Boolean(index.nearest(point, km)),
    graph: () => ({ graph, index }),
    meta: () => ({ byCountry: graph.byCountry, builtAt: 77 }),
    passengerKm: async () => ({ pkm: { RU: 103447 } }),
    task: async (task) => {
      tasks.push(task.kind);
      return runRailWorldTask(file, task);
    },
    noteTile() {},
  };
}

/** GET a route of the proxy, the page's way. */
function getFrom(proxy, url) {
  const uses = [];
  proxy.configureServer({
    config: {},
    middlewares: { use: (...args) => uses.push(args) },
  });
  const handler = uses.find((args) => args[0] === '/api/outbreak')[1];
  return new Promise((resolve) => {
    handler(
      {
        method: 'GET',
        url,
        headers: { host: 'localhost:5173', 'sec-fetch-site': 'same-origin' },
        socket: { remoteAddress: '127.0.0.1' },
      },
      {
        writeHead(status) {
          this.status = status;
        },
        end(text) {
          resolve({ status: this.status, json: JSON.parse(text) });
        },
      },
    );
  });
}

test('world rail: the status, no map tiles of it, and the rail round a location along the whole network', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-rail-world-'));
  try {
    const asked = [];
    const networkStore = {
      async lines(tile) {
        asked.push(tile.z);
        return { motorway: [], major: [], primary: [], rail: [] };
      },
    };
    const kept = new Map();
    const world = worldRailFixture(dir);
    const proxy = outbreakProxy({
      networkStore,
      builtNetworks: {
        read: (key) => kept.get(key) || null,
        write: (key, value) => kept.set(key, value),
      },
      railWorld: world,
    });
    const status = await getFrom(proxy, '/rail-world/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.state, 'ready');
    assert.equal(status.json.version, 2);
    for (const key of [
      'tilesTotal',
      'tilesDone',
      'tilesCached',
      'tilesFetched',
      'tilesFailed',
      'railKm',
      'byContinent',
      'builtAt',
    ])
      assert.ok(key in status.json, key);
    // Without the job, the page is told it is off.
    assert.equal(
      (await getFrom(outbreakProxy({ networkStore }), '/rail-world/status'))
        .json.state,
      'off',
    );
    // No tiles of the whole world's rail for the map (owner 2026-10-12,
    // "no grey on rail lines"): only the rail the spread reaches is drawn.
    const tile = tileOf(54, 98, 3);
    const layer = await getFrom(
      proxy,
      `/rail-world/tile/3/${tile.x}/${tile.y}`,
    );
    assert.equal(layer.status, 404);
    // The rail round Irkutsk: the whole line, past the old 500 km.
    const rail = await getFrom(
      proxy,
      '/network?lat=52.287&lon=104.305&mode=rail',
    );
    assert.equal(rail.status, 200, JSON.stringify(rail.json));
    assert.equal(rail.json.world, true);
    assert.equal(rail.json.radiusKm, null);
    assert.equal(rail.json.lastLevel, true);
    assert.ok(rail.json.network.startKm < 3);
    assert.ok(
      rail.json.network.reachedKm > 800,
      `${rail.json.network.reachedKm} km`,
    );
    assert.ok(rail.json.network.byContinent.AS > 800);
    assert.deepEqual(rail.json.network.unreached, []);
    // Only the finer tiles near it were asked for: no 500 km of coarse ones.
    assert.ok(asked.length > 0 && asked.every((z) => z === 10));
    assert.ok(kept.has('rail5-world-v2-77-p3-52.29_104.31'));
    assert.ok(world.started.length > 0, 'the request started the job');
    // Roads are as before.
    const road = await getFrom(
      proxy,
      '/network?lat=52.287&lon=104.305&mode=road',
    );
    assert.equal(road.json.world, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('world rail: not built yet, the rail within 500 km answers as before', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-rail-world-'));
  try {
    const networkStore = {
      async lines() {
        return {
          motorway: [],
          major: [],
          primary: [],
          rail: [
            [
              [104.0, 52.27],
              [104.6, 52.27],
            ],
          ],
        };
      },
    };
    const kept = new Map();
    const world = worldRailFixture(dir, { ready: false });
    const proxy = outbreakProxy({
      networkStore,
      buildNetwork: async (lines, at, options) =>
        buildTransportNetwork(lines, at, options),
      builtNetworks: {
        read: (key) => kept.get(key) || null,
        write: (key, value) => kept.set(key, value),
      },
      railWorld: world,
    });
    const rail = await getFrom(
      proxy,
      '/network?lat=52.287&lon=104.305&mode=rail',
    );
    assert.equal(rail.status, 200);
    assert.equal(rail.json.world, undefined);
    assert.equal(rail.json.radiusKm, 500);
    assert.ok(kept.has('rail2-p3-L1-52.29_104.31'));
    assert.equal(world.tasks.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('world rail: world tiles still missing near a source count as failed, so the answer is not kept; a new build prunes the older answers (2026-10-12)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-rail-world-'));
  try {
    const networkStore = {
      async lines() {
        return { motorway: [], major: [], primary: [], rail: [] };
      },
    };
    const kept = new Map();
    const pruned = [];
    const world = worldRailFixture(dir);
    let missing = 3;
    const near = [];
    world.missingNear = (points, km) => {
      near.push(km);
      return missing;
    };
    const proxy = outbreakProxy({
      networkStore,
      builtNetworks: {
        read: (key) => kept.get(key) || null,
        write: (key, value) => kept.set(key, value),
        prune: (prefix, keep) => pruned.push([prefix, keep]),
      },
      railWorld: world,
    });
    const url = '/network?lat=52.287&lon=104.305&mode=rail';
    const first = await getFrom(proxy, url);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.worldMissingTiles, 3);
    assert.ok(first.json.failedTiles >= 3);
    assert.equal(near[0], 500, 'within the old 500 km');
    assert.equal(kept.size, 0, 'not kept while world tiles are missing');
    assert.deepEqual(pruned, [['rail5-world-', 'rail5-world-v2-77-p3-']]);
    missing = 0;
    const second = await getFrom(proxy, url);
    assert.equal(second.json.failedTiles, 0);
    assert.equal(second.json.worldMissingTiles, 0);
    assert.equal(kept.size, 1);
    assert.equal(pruned.length, 1, 'pruned once for each build');
    // After landing, the same.
    missing = 2;
    const air = await postTo(proxy, '/air-rails', {
      speedKmh: 60,
      destinations: [{ code: 'UIII', lat: 52.268, lon: 104.389, hour: 5 }],
    });
    assert.equal(air.status, 200, JSON.stringify(air.json));
    assert.equal(air.json.worldMissingTiles, 2);
    assert.equal(air.json.failedTiles, 2);
    // The bytes of a kept answer, by its points.
    assert.equal(
      networkAnswerBytes({ network: { bands: { 0: [[1, 2, 3, 4]] } } }),
      1024 + 32,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('world rail after landing: every landing seeds the whole network, none left out; the old budget only for the finer lines', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-rail-world-'));
  try {
    const asked = [];
    const networkStore = {
      async lines(tile) {
        asked.push(tile.z);
        return { motorway: [], major: [], primary: [], rail: [] };
      },
    };
    const world = worldRailFixture(dir);
    const proxy = outbreakProxy({ networkStore, railWorld: world });
    const answer = await postTo(proxy, '/air-rails', {
      speedKmh: 60,
      destinations: [
        { code: 'UIII', lat: 52.268, lon: 104.389, hour: 5 },
        // Far from any rail: the finer lines round it are asked for.
        { code: 'XXXX', lat: 10, lon: 10, hour: 9 },
      ],
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    assert.equal(answer.json.world, true);
    assert.equal(answer.json.skippedLandings, 0);
    assert.equal(answer.json.landings, 2);
    assert.equal(answer.json.seededLandings, 1);
    assert.equal(answer.json.fineLandings, 1);
    assert.ok(asked.length > 0 && asked.every((z) => z === 10));
    assert.equal(answer.json.network.bandsBy, 'hour');
    // The far end, 1,000 km on at the road rule's pace, is lit too.
    assert.ok(answer.json.network.lastHour > 20);
    assert.ok(world.tasks.includes('air'));
    // The tile budget of the old way is unchanged.
    assert.equal(AIR_RAILS_MAX_TILES, 7000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('world rail in the epidemic model: towns on the rail become places and trains join them; rail off is the model as before', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-rail-world-'));
  try {
    const table = airportTable({
      cacheDir: dir,
      fetchImpl: async () => new Response(CSV, { status: 200 }),
    });
    // Irkutsk, and Krasnoyarsk on the line 850 km west: past commuting
    // reach of every airport, on the rail.
    const towns = [
      {
        id: 1,
        name: 'Irkutsk',
        lat: 52.297,
        lon: 104.296,
        country: 'RU',
        population: 586695,
      },
      {
        id: 2,
        name: 'Krasnoyarsk',
        lat: 55.95,
        lon: 92.3,
        country: 'RU',
        population: 1_000_000,
      },
    ];
    const ran = [];
    const world = worldRailFixture(dir);
    const proxy = outbreakProxy({
      table,
      cities: { load: async () => towns },
      runEpidemic: async (input) => {
        ran.push(input);
        return simulateEpidemic({ ...input, runs: 3 });
      },
      railWorld: world,
    });
    const body = { ...routeBody({}), speedKmh: 80 };
    const on = await postTo(proxy, '/epidemic', body);
    assert.equal(on.status, 200, JSON.stringify(on.json));
    const input = ran[0];
    const krasnoyarsk = input.nodes.findIndex((n) => n.name === 'Krasnoyarsk');
    assert.ok(krasnoyarsk >= 0, 'a town on the rail is a place');
    const trains = input.routes.filter((r) => r.mode === 'rail');
    assert.ok(trains.length > 0);
    assert.ok(
      trains.some((r) => r.from === krasnoyarsk || r.to === krasnoyarsk),
    );
    // At the box's train speed.
    const one = trains[0];
    assert.ok(Math.abs(one.lengthMs - (one.km / 80) * 3_600_000) <= 1);
    assert.equal(on.json.network.railRoutes, trains.length);
    assert.match(on.json.railSource, /World Bank/);
    assert.ok(on.json.railStats.passengerKmPerDay > 0);
    // Train off: no rail, the places as before.
    const off = await postTo(proxy, '/epidemic', { ...body, rail: false });
    assert.equal(off.status, 200);
    const input2 = ran[1];
    assert.equal(input2.routes.filter((r) => r.mode === 'rail').length, 0);
    assert.equal(
      input2.nodes.findIndex((n) => n.name === 'Krasnoyarsk'),
      -1,
    );
    assert.equal(off.json.railSource, 'off');
    assert.equal(input2.seed, input.seed, 'the same draws either way');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('world rail in the epidemic model: not built yet, it runs as before and says rail is pending', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-rail-world-'));
  try {
    const table = airportTable({
      cacheDir: dir,
      fetchImpl: async () => new Response(CSV, { status: 200 }),
    });
    const ran = [];
    const proxy = outbreakProxy({
      table,
      cities: { load: async () => parseGeonamesCities(CITIES) },
      runEpidemic: async (input) => {
        ran.push(input);
        return simulateEpidemic({ ...input, runs: 2 });
      },
      railWorld: worldRailFixture(dir, { ready: false }),
    });
    const answer = await postTo(proxy, '/epidemic', routeBody({}));
    assert.equal(answer.status, 200);
    assert.equal(answer.json.railSource, 'pending');
    assert.equal(ran[0].routes.filter((r) => r.mode === 'rail').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
