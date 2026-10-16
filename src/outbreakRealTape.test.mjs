import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REAL_ACTIONS,
  REAL_OBS,
  isoTable,
  owidSeries,
  oxcgrtSeries,
  parseCsv,
  realArrays,
} from './outbreakRealTape.mjs';
import { parseNpy } from './outbreakEpiShard.mjs';
import { writeReal } from '../scripts/outbreak-real-data.mjs';

const ISO = { CAN: 'CA', FRA: 'FR' };
const OWID = [
  'iso_code,date,new_cases,new_deaths,hosp_patients,icu_patients,new_tests,people_vaccinated,population',
  'CAN,2020-03-01,10,1,,,500,,38000000',
  'CAN,2020-03-02,12,0,4,1,,,38000000',
  'OWID_WRL,2020-03-01,1000,10,,,,,8000000000',
  'FRA,2020-03-02,"30",2,,,,,"67,000,000"',
].join('\n');
const OXCGRT = [
  'CountryCode,Jurisdiction,Date,C1M_combined_numeric,C2M_combined_numeric,C3M_combined_numeric,C4M_combined_numeric,C5M_combined_numeric,C6M_combined_numeric,C7M_combined_numeric,C8EV_combined_numeric,H2_combined_numeric,H3_combined_numeric,H7_combined_numeric',
  'CAN,NAT_TOTAL,20200301,3,3,2,4,2,3,2,4,3,2,5',
  'CAN,STATE_TOTAL,20200301,0,0,0,0,0,0,0,0,0,0,0',
  'CAN,NAT_TOTAL,20200302,0,0,0,0,0,0,0,2,,1,0',
].join('\r\n');

test('CSV: quotes, commas and line ends as RFC 4180 has them', () => {
  const rows = parseCsv('a,b\n"x, y","say ""hi"""\r\n1,\n');
  assert.deepEqual(rows, [
    { a: 'x, y', b: 'say "hi"' },
    { a: '1', b: '' },
  ]);
});

test('OWID: countries by ISO2, aggregates left out, blanks unobserved', () => {
  const owid = owidSeries(parseCsv(OWID), ISO);
  assert.deepEqual(Object.keys(owid).sort(), ['CA', 'FR']);
  assert.deepEqual(owid.CA.days['2020-03-02'].slice(0, 4), [12, 0, 4, 1]);
  assert.ok(Number.isNaN(owid.CA.days['2020-03-01'][2]));
  assert.equal(owid.CA.population, 38000000);
});

test('OxCGRT: the national rows only, as shares of each scale; lockdown the mean of C1–C7', () => {
  const ox = oxcgrtSeries(parseCsv(OXCGRT), ISO);
  assert.deepEqual(ox.CA['2020-03-01'], [1, 1, 1, 1, 1]);
  const day2 = ox.CA['2020-03-02'];
  assert.equal(day2[0], 0);
  assert.equal(day2[1], 0.5);
  assert.ok(Number.isNaN(day2[2]), 'testing blank');
  assert.equal(day2[3], 0.5);
});

test('aligned arrays with masks; written as npy with the licences', () => {
  const owid = owidSeries(parseCsv(OWID), ISO);
  const oxcgrt = oxcgrtSeries(parseCsv(OXCGRT), ISO);
  const arrays = realArrays({
    owid,
    oxcgrt,
    countries: ['CA', 'FR'],
    from: '2020-03-01',
    to: '2020-03-03',
  });
  assert.deepEqual(arrays.obs.shape, [3, 2, REAL_OBS.length]);
  assert.deepEqual(arrays.actions.shape, [3, 2, REAL_ACTIONS.length]);
  assert.equal(arrays.obs.data[0], 10);
  assert.equal(arrays.obs_mask.data[2], 0, 'no hospital figure on day 0');
  assert.equal(
    arrays.actions_mask.data[(2 * 2 + 0) * 5],
    0,
    'day 2 unobserved',
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-real-'));
  try {
    const meta = writeReal({
      owidText: OWID,
      oxcgrtText: OXCGRT,
      iso: ISO,
      from: '2020-03-01',
      to: '2020-03-02',
      out: dir,
    });
    assert.deepEqual(meta.countries, ['CA', 'FR']);
    assert.equal(meta.class, 'open');
    assert.ok(meta.licences.some((l) => /CC BY 4\.0/.test(l)));
    assert.deepEqual(
      parseNpy(new Uint8Array(fs.readFileSync(path.join(dir, 'obs.npy'))))
        .shape,
      [2, 2, REAL_OBS.length],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(
    isoTable({
      features: [
        { iso: 'CAN', iso2: 'CA' },
        { iso: '-99', iso2: '' },
      ],
    }),
    { CAN: 'CA' },
  );
});
