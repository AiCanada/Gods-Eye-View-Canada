import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  airportTable,
  outbreakFlightHistory,
  outbreakNewsQuery,
  parseAirportsCsv,
  readSurroundings,
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
    assert.deepEqual(near.map((a) => [a.code, a.km]), [['UIII', 6]]);
    assert.deepEqual(Object.keys(await table.lookup(['SVO', 'UNNT', 'ZZZZ'])), ['SVO', 'UNNT']);
    assert.equal((await table.candidates({ lat: 52.287, lon: 104.305 })).length, 3);
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
          { estDepartureAirport: 'UIII', estArrivalAirport: 'UNNT', firstSeen: 1000, lastSeen: 5000, callsign: 'S7 1 ' },
        ]);
      if (params.get('airport') === 'UNNT')
        return Response.json([
          { estDepartureAirport: 'UNNT', estArrivalAirport: 'UUEE', firstSeen: 9000, lastSeen: 20000, callsign: 'SBI2' },
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
      flights.map((f) => [f.from.code, f.to.code, f.hop, f.departMs, f.callsign]),
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
  assert.match(surroundingsQuery({ lat: 52.28, lon: 104.3 }), /around:30000,52.28,104.3\)\["railway"="station"\]/);
  assert.match(surroundingsQuery({ lat: 52.28, lon: 104.3 }), /around:100000,52.28,104.3\)\["amenity"="ferry_terminal"\]/);
  assert.deepEqual(
    readSurroundings([
      { tags: { railway: 'station' } },
      { tags: { railway: 'rail', maxspeed: '80' } },
      { tags: { railway: 'rail', maxspeed: '120' } },
      { tags: { railway: 'rail', maxspeed: 'RU:rail' } },
      { tags: { amenity: 'ferry_terminal' } },
    ]),
    { rail: true, stations: 1, trainKmh: 100, railSpeedSamples: 2, water: true, waterPlaces: 1 },
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
