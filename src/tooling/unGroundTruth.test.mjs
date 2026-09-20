// Country Ground Truth Assessment for every country without an adapter of its
// own: the four methods read from what a country reported to the United
// Nations, with the World Health Organization's estimate as the independent
// source. Ukraine is left out; an unknown code is not a country.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUnGroundTruth,
  checkUnAgainstWho,
  checkUnArithmetic,
  checkUnReportingToPolice,
  checkUnTotalsBySex,
  collectUnNotes,
  sdgSeries,
  unSeriesNotes,
} from '../../server/providers/regional/un-ground-truth.js';
import {
  COUNTRY_COUNT,
  countryCodes,
} from '../../server/providers/regional/country-codes.js';
import { fetchCountryGroundTruth } from '../../server/providers/regional/country-ground-truth.js';
import {
  buildGroundTruthQuestion,
  formatGroundTruthBody,
  groundTruthSectionHeadings,
} from '../askOverview.js';

const POPULATION = 50_000_000;
const point = (series, sex, year, value, extra = {}) => ({
  series,
  timePeriodStart: year,
  value: String(value),
  source: extra.source || 'National Police',
  footnotes: extra.footnotes || [''],
  attributes: { Nature: extra.nature || 'C' },
  dimensions: { Sex: sex },
});

/** A country that: leaves victims out of its parts, skips years, changes source, and publishes a rate its count does not support. */
function homicideRows() {
  const rows = [];
  const years = [
    2005, 2006, 2007, 2008, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018,
    2019, 2020, 2021,
  ];
  for (const year of years) {
    const count = 5000;
    const extra = {
      source: year >= 2015 ? 'Ministry of Interior' : 'National Police',
      nature: year === 2011 ? 'E' : 'C',
      footnotes: [
        year >= 2019
          ? 'In national statistics "homicide" does not include "robbery-homicide".'
          : '',
        year === 2015
          ? 'New penal code in force: figures are not comparable with earlier years.'
          : '',
      ],
    };
    rows.push(point('VC_IHR_PSRCN', 'BOTHSEX', year, count, extra));
    rows.push(point('VC_IHR_PSRCN', 'MALE', year, 3900, extra));
    rows.push(point('VC_IHR_PSRCN', 'FEMALE', year, 1000, extra));
    // 2018's rate is published a quarter too low for its count.
    const rate = ((year === 2018 ? 0.75 : 1) * count * 100000) / POPULATION;
    rows.push(point('VC_IHR_PSRC', 'BOTHSEX', year, rate, extra));
  }
  return rows;
}

const REPORTING = [
  point('VC_PRR_SEXV', 'BOTHSEX', 2020, 9.5),
  point('VC_PRR_SEXV', 'BOTHSEX', 2021, 4),
  point('VC_PRR_ROBB', 'BOTHSEX', 2021, 22),
  point('VC_PRR_PHYV', 'BOTHSEX', 2021, 61),
  point('VC_PRR_ROBB', 'FEMALE', 2021, 1),
];

const who = (year, value, low, high) => ({
  Dim1: 'SEX_BTSX',
  TimeDim: year,
  NumericValue: value,
  Low: low,
  High: high,
});
const WHO = [
  who(2019, 14.2, 12.5, 16),
  who(2021, 14.4, 12.8, 16.1),
  { Dim1: 'SEX_MLE', TimeDim: 2021, NumericValue: 99 },
];

test('the UN’s own code table: alpha-2 to alpha-3 and M49', () => {
  assert.ok(COUNTRY_COUNT >= 245);
  assert.deepEqual(countryCodes('fr'), {
    iso2: 'FR',
    iso3: 'FRA',
    m49: 250,
    name: 'France',
  });
  assert.deepEqual(countryCodes('JP'), {
    iso2: 'JP',
    iso3: 'JPN',
    m49: 392,
    name: 'Japan',
  });
  assert.equal(countryCodes('UA').iso3, 'UKR');
  assert.equal(countryCodes('ZZ'), null);
  assert.equal(countryCodes('__proto__'), null);
});

test('method 1: a total that does not equal its parts by sex', () => {
  const rows = homicideRows();
  assert.equal(sdgSeries(rows, 'VC_IHR_PSRCN').length, 15);
  const result = checkUnTotalsBySex(rows);
  assert.equal(result.checked, 5, 'the five latest years');
  const [latest] = result.findings;
  assert.deepEqual(
    [
      latest.year,
      latest.reportedTotal,
      latest.sumOfListedParts,
      latest.difference,
      latest.differencePct,
    ],
    [2021, 5000, 4900, 100, 2],
  );
  assert.match(latest.reading, /neither male nor female/);
});

test('method 1: victims who never told the police are in no police total', () => {
  const result = checkUnReportingToPolice(REPORTING);
  assert.equal(result.checked, 3);
  assert.equal(result.published, true);
  assert.deepEqual(
    result.findings.map((item) => [
      item.crime,
      item.year,
      item.reportedToPolicePct,
      item.neverReportedPct,
    ]),
    [
      ['sexual assault', 2021, 4, 96],
      ['robbery', 2021, 22, 78],
    ],
    'lowest first; assault at 61% is not a finding',
  );
  assert.equal(checkUnReportingToPolice([]).published, false);
});

test('methods 1 and 3: the notes attached to the figures, each said once with its years', () => {
  const exclusions = collectUnNotes(homicideRows(), /does not include/i);
  assert.equal(exclusions.length, 1);
  assert.equal(
    exclusions[0].note,
    'In national statistics "homicide" does not include "robbery-homicide". (note on the 2019 to 2021 figures)',
  );
  const series = unSeriesNotes(
    sdgSeries(homicideRows(), 'VC_IHR_PSRCN'),
    2026,
  ).map((note) => note.note);
  assert.ok(
    series.some((note) =>
      /^The latest figure is for 2021: nothing has been published for the 4 years since\.$/.test(
        note,
      ),
    ),
  );
  assert.ok(
    series.some((note) =>
      /^2 of the 17 years from 2005 to 2021 have no figure: 2009, 2010\./.test(
        note,
      ),
    ),
  );
  assert.ok(
    series.some((note) =>
      /different sources over the years, changing once: 2015 \(National Police -> Ministry of Interior\)/.test(
        note,
      ),
    ),
  );
  assert.ok(
    series.some((note) =>
      /^1 of the 15 figures are not the country's own count.*\(2011\)/.test(
        note,
      ),
    ),
  );
  const sameSource = [
    {
      year: 2019,
      value: 1,
      source: 'UN-CTS as collected in 2020',
      nature: 'C',
    },
    {
      year: 2020,
      value: 1,
      source: 'UN-CTS as collected in 2022',
      nature: 'C',
    },
  ];
  assert.deepEqual(
    unSeriesNotes(sameSource, 2021),
    [],
    'a later collection round is the same source',
  );
});

test('method 4: a count and a rate that do not belong together, and the police figure against the WHO', () => {
  const rows = homicideRows();
  const arithmetic = checkUnArithmetic(
    sdgSeries(rows, 'VC_IHR_PSRCN'),
    sdgSeries(rows, 'VC_IHR_PSRC'),
  );
  assert.equal(
    arithmetic.checked,
    13,
    'neighbouring years only: the gap is not a pair',
  );
  assert.deepEqual(
    arithmetic.findings.map((item) => item.year).sort(),
    [2018, 2019],
  );
  assert.match(arithmetic.findings[0].note, /do not belong together$/);

  const against = checkUnAgainstWho(sdgSeries(rows, 'VC_IHR_PSRC'), WHO);
  assert.deepEqual(against.compared, {
    policeYear: 2021,
    policeRate: 10,
    whoYear: 2021,
    whoRate: 14.4,
    whoLow: 12.8,
    whoHigh: 16.1,
    position: 'below',
  });
  assert.match(
    against.findings[0].note,
    /below the whole interval: the WHO estimate is 1\.44 times the police figure$/,
  );
  assert.equal(
    checkUnAgainstWho(sdgSeries(rows, 'VC_IHR_PSRC'), [who(2021, 10.2, 9, 11)])
      .found,
    0,
    'inside the interval is not a finding',
  );
  assert.equal(
    checkUnAgainstWho(sdgSeries(rows, 'VC_IHR_PSRC'), [who(2000, 10, 9, 11)])
      .compared,
    null,
    'too many years apart to compare',
  );
});

test('the report for a country read from the UN', () => {
  const evidence = buildUnGroundTruth({
    country: { iso2: 'XX', name: 'Testland' },
    homicide: homicideRows(),
    reporting: REPORTING,
    who: WHO,
    thisYear: 2026,
  });
  assert.deepEqual(
    [evidence.status, evidence.year, evidence.tableCovers],
    ['ready', 2021, '2005 to 2021'],
  );
  const [one, two, three, four] = groundTruthSectionHeadings(evidence);
  assert.equal(
    one,
    '1. Incidents left out of totals, 5 totals that don\'t equal their listed parts, 2 kinds of crime where under half of victims told the police (lowest 4% for sexual assault in 2021), no count published of police reports struck as "unfounded", and 1 exclusion note',
  );
  assert.equal(
    two,
    '2. Use of "other", nothing to check: this source publishes one category (intentional homicide) and no "other"',
  );
  assert.match(
    three,
    /^3\. New categories and partial data, 1 series that starts late and 5 notes ruling out comparison across years$/,
  );
  assert.equal(
    four,
    "4. Incorrect numbers, 14 published figures recomputed from the counts with 3 disagreeing, the police homicide rate below the World Health Organization's estimate for 2021, and no list of corrections published",
  );
  const body = formatGroundTruthBody(evidence);
  const lines = body.split('\n');
  assert.match(lines[1], /^Intentional homicide only:/);
  assert.ok(
    lines.includes(
      "- sexual assault (2021): 4% of victims told the police; the other 96% are in no police total (the country's victimization survey)",
    ),
  );
  assert.ok(
    lines.some((line) =>
      /^- Intentional homicide: In national statistics "homicide" does not include "robbery-homicide"\./.test(
        line,
      ),
    ),
  );
  assert.equal(
    lines[lines.indexOf(two) + 1].startsWith('3. '),
    true,
    'no List Details under a section with nothing to check',
  );
  assert.match(
    buildGroundTruthQuestion(evidence),
    /checks\.reportingToPolice when it is present/,
  );

  const empty = buildUnGroundTruth({
    country: { iso2: 'XX', name: 'Testland' },
    homicide: [],
    thisYear: 2026,
  });
  assert.equal(empty.status, 'nodata');
  assert.match(
    formatGroundTruthBody(empty),
    /holds no police-recorded homicide figure that Testland has reported\. No model was asked\.$/,
  );
});

test('every country but Ukraine: own adapters for Canada and the US, the UN for the rest', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    const body = /indicator=16\.1\.1/.test(url)
      ? { data: homicideRows() }
      : /indicator=16\.3\.1/.test(url)
        ? { data: REPORTING }
        : { value: WHO };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const ukraine = await fetchCountryGroundTruth('ua', 'Ukraine');
  assert.equal(ukraine.status, 'excluded');
  assert.equal(ukraine.country, 'Ukraine');
  assert.equal(
    requested.length,
    0,
    'nothing is fetched for a country that is left out',
  );
  assert.match(
    formatGroundTruthBody(ukraine),
    /^Ukraine is left out of Country Ground Truth Assessment by the operator\. No model was asked\.$/,
  );

  const japan = await fetchCountryGroundTruth('jp', 'Japan');
  assert.deepEqual(
    [japan.status, japan.country, japan.countryCode],
    ['ready', 'Japan', 'JP'],
  );
  assert.equal(requested.length, 3);
  assert.ok(requested[0].includes('indicator=16.1.1&areaCode=392'));
  assert.ok(requested[1].includes('indicator=16.3.1&areaCode=392'));
  assert.ok(decodeURIComponent(requested[2]).includes("SpatialDim eq 'JPN'"));
  await fetchCountryGroundTruth('JP');
  assert.equal(requested.length, 3, 'answered from memory for a day');

  const unknown = await fetchCountryGroundTruth('zz', 'Nowhere');
  assert.equal(unknown.status, 'unsupported');
  assert.deepEqual(
    unknown.connected.map((entry) => entry.countryCode),
    ['CA', 'US', 'EU', '*'],
  );
  assert.equal(requested.length, 3);
});
