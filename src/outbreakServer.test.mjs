import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import { epiParameters, simulateEpidemic } from './outbreakEpi.mjs';
import { buildTransportNetwork } from './outbreakNetwork.mjs';
import {
  airportTable,
  cityTable,
  outbreakFlightHistory,
  outbreakNewsQuery,
  outbreakProxy,
  parseGeonamesCities,
  parseAirportsCsv,
  readSurroundings,
  readZipEntry,
  runEpidemicInWorker,
  splitCsvLine,
  surroundingsQuery,
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
  assert.ok(kept.has('road-L3-52.29_104.31'));
  // Rail stays the first level.
  assert.equal(
    (await get('lat=52.287&lon=104.305&mode=rail&level=3')).json.level,
    1,
  );
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
