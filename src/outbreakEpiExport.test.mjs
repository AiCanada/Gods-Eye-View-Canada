import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLACES_CSV_HEADER,
  TOTALS_CSV_HEADER,
  csvField,
  epidemicExport,
  epidemicPlacesCsv,
  epidemicTotalsCsv,
} from './outbreakEpiExport.mjs';

/** A tiny RFC 4180 reader: CRLF records, quoted fields, doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else field += c;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

const place = (over = {}) => ({
  id: 'p1',
  code: 'UUEE',
  name: 'Sheremetyevo',
  kind: 'airport',
  lat: 55.97,
  lon: 37.41,
  population: 10_381_222,
  origin: false,
  pArrive: 0.9,
  pArriveCi: [0.85, 0.94],
  etaP5: 12,
  etaP50: 30,
  etaP95: 70,
  pReported: 0.4,
  reportP50: 90,
  pOverwhelmed: 0,
  overflowP50: null,
  casesP50: 120,
  casesP95: 400,
  deathsP50: 2,
  hospitalPeakP50: 5,
  icuPeakP50: 1,
  pRestricted: 0.25,
  restrictP50: null,
  importedP50: 3,
  pImportedFirst: 0.8,
  pGround: 0.1,
  pLocal: 0.6,
  vaccinatedP50: 0,
  reinfectedP50: 0,
  localBy50: 100,
  establishedBy50: 140,
  localOffsetHours: 2,
  ...over,
});

test('csvField follows RFC 4180 and never writes NaN or Infinity', () => {
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(NaN), '');
  assert.equal(csvField(Infinity), '');
  assert.equal(csvField(-Infinity), '');
  assert.equal(csvField(0), '0');
  assert.equal(csvField(-1.5), '-1.5');
  assert.equal(csvField(true), 'true');
  assert.equal(csvField(false), 'false');
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('Rio, "Norte"'), '"Rio, ""Norte"""');
  assert.equal(csvField('a\nb'), '"a\nb"');
  assert.equal(csvField('a\r\nb'), '"a\r\nb"');
  assert.equal(csvField(''), '');
});

test('the places table: exact header, a row per place, round trip', () => {
  const result = {
    places: [
      place(),
      place({
        id: 'p2',
        code: 'SBGL',
        name: 'Rio, "Norte"',
        origin: true,
        etaP50: null,
        etaP95: Infinity,
        pArrive: NaN,
        pArriveCi: undefined,
        localBy50: null,
        establishedBy50: null,
      }),
    ],
  };
  const csv = epidemicPlacesCsv(result);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], PLACES_CSV_HEADER);
  assert.equal(lines.length, result.places.length + 1);
  assert.ok(!/NaN|Infinity/.test(csv));
  const rows = parseCsv(csv);
  const header = rows[0];
  assert.equal(header.length, 34);
  const byName = (row) => Object.fromEntries(header.map((h, i) => [h, row[i]]));
  for (const row of rows) assert.equal(row.length, header.length);
  const first = byName(rows[1]);
  assert.equal(first.id, 'p1');
  assert.equal(first.name, 'Sheremetyevo');
  assert.equal(first.pArriveLo, '0.85');
  assert.equal(first.pArriveHi, '0.94');
  assert.equal(first.origin, 'false');
  assert.equal(first.overflowP50, '');
  assert.equal(first.localOffsetHours, '2');
  const second = byName(rows[2]);
  assert.equal(second.name, 'Rio, "Norte"');
  assert.equal(second.origin, 'true');
  assert.equal(second.etaP50, '');
  assert.equal(second.etaP95, '');
  assert.equal(second.pArrive, '');
  assert.equal(second.pArriveLo, '');
  assert.equal(second.pArriveHi, '');
  // Column order follows the header exactly.
  assert.equal(header[0], 'id');
  assert.equal(header[8], 'pArrive');
  assert.equal(header.at(-1), 'localOffsetHours');
});

test('a result with no places or totals gives just the header', () => {
  assert.equal(epidemicPlacesCsv({}), PLACES_CSV_HEADER);
  assert.equal(epidemicPlacesCsv(null), PLACES_CSV_HEADER);
  assert.equal(epidemicTotalsCsv({ totals: [] }), TOTALS_CSV_HEADER);
  assert.equal(epidemicTotalsCsv(undefined), TOTALS_CSV_HEADER);
});

test('the totals table: a row per day with the day first', () => {
  const result = {
    totals: [
      { day: 1, p5: 50, p50: 60, p95: 80, reportedP50: 0, deathsP50: 0 },
      {
        day: 2,
        p5: 70,
        p50: 90,
        p95: 130,
        reportedP50: 6,
        deathsP50: 1,
        hospitalP50: 5,
        icuP50: 1,
        distancingP50: 0.25,
      },
      { p5: 90, p50: 120, p95: 200 },
    ],
  };
  const csv = epidemicTotalsCsv(result);
  const rows = parseCsv(csv);
  assert.equal(rows[0].join(','), TOTALS_CSV_HEADER);
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(row.length, rows[0].length);
  assert.equal(rows[1][0], '1');
  assert.equal(rows[2][0], '2');
  // A day without its number takes its index.
  assert.equal(rows[3][0], '3');
  const col = (name) => rows[0].indexOf(name);
  assert.equal(rows[2][col('hospitalP50')], '5');
  assert.equal(rows[2][col('distancingP50')], '0.25');
  // Fields a legacy result lacks are empty, not "undefined".
  assert.equal(rows[1][col('hospitalP50')], '');
  assert.equal(rows[1][col('newP50')], '');
  assert.ok(!csv.includes('undefined'));
});

test('epidemicExport: JSON round trip, the request kept, inputs untouched', () => {
  const result = {
    startMs: 1,
    untilMs: 2,
    hours: 24,
    runs: 5,
    places: [place()],
    totals: [{ day: 1, p50: 3 }],
    summary: { r0: 2.5, overflowDayP50: null },
  };
  const profile = { preset: 'covid2020', r0: 2.5, hospitalDays: 8 };
  const request = {
    startMs: 1,
    untilMs: 2,
    runs: 5,
    seed: 42,
    locations: [{ id: 'irkutsk', lat: 52.287, lon: 104.305 }],
    outbreakAirports: ['UIII'],
    flightCount: 12,
    flights: [
      { from: 'UIII', to: 'UUEE', departMs: 3_600_000, arriveMs: 25_200_000 },
    ],
    profile,
    links: [[{ j: 1, share: 0.1 }]],
    budgetMs: 1000,
  };
  const before = JSON.parse(JSON.stringify({ result, request }));
  const doc = epidemicExport(result, request, {
    now: () => Date.UTC(2026, 0, 10, 12),
  });
  assert.equal(doc.exportedAt, '2026-01-10T12:00:00.000Z');
  assert.deepEqual(Object.keys(doc), ['exportedAt', 'request', 'result']);
  assert.deepEqual(doc.request, {
    startMs: 1,
    untilMs: 2,
    runs: 5,
    seed: 42,
    locations: request.locations,
    outbreakAirports: ['UIII'],
    flightCount: 12,
    flights: request.flights,
    profile,
  });
  assert.deepEqual(doc.request.profile, profile);
  assert.deepEqual(doc.result, result);
  assert.notEqual(doc.result, result);
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
  // Neither input was changed.
  assert.deepEqual(JSON.parse(JSON.stringify({ result, request })), before);
  // Request fields that are not set are left out, so the JSON round trip holds.
  const sparse = epidemicExport({}, { runs: 3, seed: undefined });
  assert.deepEqual(sparse.request, { runs: 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(sparse)), sparse);
  assert.ok(!Number.isNaN(Date.parse(sparse.exportedAt)));
  assert.deepEqual(epidemicExport(null, null).request, {});
});

test('the totals table: the phase-2 columns come last and fill from a two-strain result', () => {
  const columns = TOTALS_CSV_HEADER.split(',');
  assert.deepEqual(columns.slice(-7), [
    'rtP5',
    'rtP50',
    'rtP95',
    'strain2P50',
    'strain2ShareP50',
    'counterfactualP50',
    'avertedP50',
  ]);
  assert.equal(columns.indexOf('distancingP50'), columns.length - 8);
  const rows = parseCsv(
    epidemicTotalsCsv({
      totals: [
        { day: 1, p50: 10, strain2P50: 2, strain2ShareP50: 0.25 },
        { day: 2, p50: 20, strain2P50: 9, strain2ShareP50: null },
      ],
    }),
  );
  const col = (name) => rows[0].indexOf(name);
  assert.equal(rows[1][col('strain2P50')], '2');
  assert.equal(rows[1][col('strain2ShareP50')], '0.25');
  assert.equal(rows[2][col('strain2ShareP50')], '');
  assert.equal(rows[1][col('rtP50')], '');
  for (const row of rows) assert.equal(row.length, columns.length);
});

test('the places table has no row limit: every place gets a row', () => {
  const places = Array.from({ length: 1200 }, (_, i) =>
    place({ id: `p${i}`, code: '', name: `Place ${i}`, origin: i === 0 }),
  );
  const rows = parseCsv(epidemicPlacesCsv({ places }));
  assert.equal(rows.length, 1201);
  assert.deepEqual(rows[0], PLACES_CSV_HEADER.split(','));
  assert.equal(rows[1][0], 'p0');
  assert.equal(rows[1200][0], 'p1199');
  assert.equal(rows[1200][2], 'Place 1199');
});
