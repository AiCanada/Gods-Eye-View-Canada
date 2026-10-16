import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEMOGRAPHIC_FIELDS,
  mergeIndicators,
  placeDemographics,
  readWorldBankIndicator,
} from './demographics.mjs';
import {
  loadDemographics,
  writeDemographics,
} from '../server/shared/demographicsStore.mjs';
import { parseNpy } from './outbreakEpiShard.mjs';

const page = (rows) => [{ page: 1 }, rows];
const row = (id, iso3, value, date = '2024') => ({
  country: { id, value: id },
  countryiso3code: iso3,
  value,
  date,
});

test('World Bank rows: countries kept, aggregates and blanks left out, merged by country', () => {
  const ages = readWorldBankIndicator(
    page([row('CA', 'CAN', 15.4), row('ZH', '', 40), row('FR', 'FRA', null)]),
  );
  assert.deepEqual(ages, { CA: { value: 15.4, year: 2024 } });
  const merged = mergeIndicators({
    'SP.POP.0014.TO.ZS': ages,
    'SP.URB.TOTL.IN.ZS': { CA: { value: 81.8, year: 2023 } },
  });
  assert.deepEqual(merged.CA, {
    age0to14: 15.4,
    urban: 81.8,
    years: { age0to14: 2024, urban: 2023 },
  });
});

test('each place: log10 population and its country’s shares; NaN where the country is unknown', () => {
  const { data, shape, channels } = placeDemographics(
    [
      { population: 1000, country: 'CA' },
      { population: 0, country: '' },
    ],
    { CA: { age0to14: 15, age65up: 20 } },
  );
  assert.deepEqual(shape, [2, 1 + DEMOGRAPHIC_FIELDS.length]);
  assert.equal(channels[0], 'log10Population');
  assert.equal(data[0], 3);
  assert.equal(data[1], Math.fround(0.15));
  assert.ok(Number.isNaN(data[2]), 'no 15–64 figure');
  assert.equal(data[3], Math.fround(0.2));
  assert.ok(Number.isNaN(data[shape[1] + 1]));
});

test('the store: fetched once, kept thirty days, the stale copy when the World Bank is down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-demo-'));
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, json: async () => page([row('CA', 'CAN', 10)]) };
    };
    const first = await loadDemographics({ cacheDir: dir, fetchImpl });
    assert.equal(calls, 4, 'one request per indicator');
    assert.equal(first.byCountry.CA.age0to14, 10);
    await loadDemographics({ cacheDir: dir, fetchImpl });
    assert.equal(calls, 4, 'kept');
    const down = async () => {
      throw new Error('offline');
    };
    const later = Date.now() + 40 * 86_400_000;
    const stale = await loadDemographics({
      cacheDir: dir,
      fetchImpl: down,
      now: () => later,
    });
    assert.equal(stale.byCountry.CA.age0to14, 10);
    const file = writeDemographics(
      first,
      { worldId: 'w1', nodes: [{ population: 100, country: 'CA' }] },
      path.join(dir, 'out'),
    );
    assert.deepEqual(
      parseNpy(new Uint8Array(fs.readFileSync(file))).shape,
      [1, 5],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
