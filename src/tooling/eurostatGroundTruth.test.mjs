// Country Ground Truth Assessment for the European countries: Eurostat's table
// of offences by category, laid over the country's UN figures. The fixture is
// a small JSON-stat table that does each thing once.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EUROSTAT_GEO,
  buildEurostatGroundTruth,
  checkEurostatAgainstUn,
  checkEurostatArithmetic,
  checkEurostatLateStarts,
  checkEurostatParts,
  eurostatSeriesNotes,
  inEurostat,
  parseEurostatTable,
} from '../../server/providers/regional/eurostat-ground-truth.js';
import { fetchCountryGroundTruth } from '../../server/providers/regional/country-ground-truth.js';
import { buildUnGroundTruth } from '../../server/providers/regional/un-ground-truth.js';
import {
  formatGroundTruthBody,
  groundTruthForModel,
  groundTruthSectionHeadings,
} from '../askOverview.js';

const YEARS = [
  2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020,
];
const POPULATION = 10_000_000;
const LABELS = {
  ICCS0101: 'Intentional homicide',
  ICCS020221: 'Kidnapping',
  ICCS0301: 'Sexual violence',
  ICCS03011: 'Rape',
  ICCS03012: 'Sexual assault',
  ICCS0501: 'Burglary',
  ICCS05012: 'Burglary of private residential premises',
  ICCS0502: 'Theft',
  ICCS0701: 'Fraud',
  ICCS0703: 'Corruption',
};

/** Counts per category by year; a rate follows from the count unless `rateLie` says otherwise. */
const COUNTS = {
  ICCS0101: () => 100,
  // Stops in 2015.
  ICCS020221: (year) => (year <= 2015 ? 400 : null),
  // 9,000 reported; rape and sexual assault add to 8,500.
  ICCS0301: () => 9000,
  ICCS03011: () => 3500,
  ICCS03012: () => 5000,
  ICCS0501: () => 40000,
  // A part larger than its whole.
  ICCS05012: (year) => (year === 2020 ? 41000 : 30000),
  // Counted differently from 2014: up 150% in one year. 2011 is missing.
  ICCS0502: (year) => (year === 2011 ? null : year >= 2014 ? 250000 : 100000),
  // A new category: first figure in 2016.
  ICCS0701: (year) => (year >= 2016 ? 50000 : null),
  // Listed, never filled.
  ICCS0703: () => null,
};
const RATE_LIE = { ICCS0501: 1.25 };

/** The fixture as Eurostat's JSON-stat: dimensions freq, iccs, unit, geo, time. */
function table() {
  const codes = Object.keys(LABELS);
  const units = ['NR', 'P_HTHAB'];
  const index = (list) => Object.fromEntries(list.map((code, i) => [code, i]));
  const value = {};
  codes.forEach((code, c) =>
    units.forEach((unit, u) =>
      YEARS.forEach((year, t) => {
        const count = COUNTS[code](year);
        if (count === null) return;
        const key = (c * units.length + u) * YEARS.length + t;
        value[key] =
          unit === 'NR'
            ? count
            : Math.round(
                ((RATE_LIE[code] && year === 2020 ? RATE_LIE[code] : 1) *
                  count *
                  100000 *
                  100) /
                  POPULATION,
              ) / 100;
      }),
    ),
  );
  return {
    id: ['freq', 'iccs', 'unit', 'geo', 'time'],
    size: [1, codes.length, units.length, 1, YEARS.length],
    dimension: {
      freq: { category: { index: { A: 0 } } },
      iccs: { category: { index: index(codes), label: LABELS } },
      unit: { category: { index: index(units) } },
      geo: { category: { index: { XX: 0 } } },
      time: { category: { index: index(YEARS.map(String)) } },
    },
    value,
  };
}

test('which countries Eurostat holds: Greece is EL, Kosovo is there, the United Kingdom and Ukraine are not', () => {
  assert.equal(EUROSTAT_GEO.GR, 'EL');
  assert.equal(EUROSTAT_GEO.FR, 'FR');
  assert.equal(inEurostat('xk'), true);
  assert.equal(
    inEurostat('GB'),
    false,
    'split into three jurisdictions and stopped in 2018: read from the UN',
  );
  assert.equal(inEurostat('UA'), false);
  assert.equal(inEurostat('US'), false);
  assert.equal(inEurostat('__proto__'), false);
  assert.equal(Object.keys(EUROSTAT_GEO).length, 38);
});

test('the JSON-stat table becomes categories of counts and rates by year', () => {
  const parsed = parseEurostatTable(table());
  assert.equal(parsed.listed.length, 10);
  assert.equal(parsed.categories.get('ICCS0101').counts.get(2020), 100);
  assert.equal(parsed.categories.get('ICCS0101').rates.get(2020), 1);
  assert.equal(parsed.categories.get('ICCS020221').counts.has(2016), false);
  assert.equal(
    parsed.categories.has('ICCS0703'),
    false,
    'a category with no figure is listed but holds nothing',
  );
  assert.deepEqual(parseEurostatTable(null).listed, []);
});

test('method 1: a whole against its parts, and a part that exceeds its whole', () => {
  const { categories } = parseEurostatTable(table());
  const result = checkEurostatParts(categories, 2020);
  assert.equal(result.checked, 2);
  assert.deepEqual(
    result.findings.map((item) => [
      item.category,
      item.reportedTotal,
      item.sumOfListedParts,
      item.difference,
    ]),
    [
      ['Burglary', 40000, 41000, -1000],
      ['Sexual violence', 9000, 8500, 500],
    ],
  );
  assert.match(
    result.findings[0].reading,
    /parts add up to more than the total/,
  );
  assert.equal(
    checkEurostatParts(categories, 2019).found,
    1,
    'a part smaller than its whole is no finding',
  );
});

test('method 3: categories that begin late, stop, are empty, skip years or lurch', () => {
  const parsed = parseEurostatTable(table());
  const late = checkEurostatLateStarts(parsed.categories, 2008);
  assert.deepEqual(
    late.findings.map((item) => [item.category, item.reachesRecentLevelIn]),
    [['Fraud', 2016]],
  );
  const notes = eurostatSeriesNotes(parsed, 2020).map(
    (note) => `${note.categories[0] || ''}|${note.note}`,
  );
  assert.match(
    notes[0],
    /^\|1 of the table's 10 categories hold no figure at all for this country: Corruption\.$/,
  );
  assert.ok(
    notes.includes(
      'Kidnapping|The figures stop in 2015 (400 that year): nothing has been published for the 5 years since.',
    ),
  );
  assert.ok(
    notes.includes(
      'Theft|1 of the years from 2008 to 2020 have no figure: 2011.',
    ),
  );
  assert.ok(
    notes.some((note) =>
      /^Theft\|100000 in 2013, 250000 in 2014: up 150% in one year\./.test(
        note,
      ),
    ),
  );
});

test('method 4: a rate its count does not support, and one country telling two publishers two numbers', () => {
  const { categories } = parseEurostatTable(table());
  const arithmetic = checkEurostatArithmetic(categories, 2020);
  assert.equal(arithmetic.impliedPopulation, POPULATION);
  assert.deepEqual(
    arithmetic.findings.map((item) => [
      item.category,
      item.publishedRate,
      item.rateTheIncidentsImply,
    ]),
    [['Burglary', 500, 400]],
  );
  const against = checkEurostatAgainstUn(categories, [
    { year: 2019, value: 100 },
    { year: 2020, value: 130 },
  ]);
  assert.equal(against.checked, 2);
  assert.deepEqual(
    against.findings.map((item) => item.year),
    [2020],
  );
  assert.match(
    against.findings[0].note,
    /^100 in Eurostat's table, 130 in the United Nations series for the same country and year: 23\.1% apart\. The two publishers may not define or count a homicide the same way$/,
  );
  assert.equal(checkEurostatAgainstUn(categories, []).checked, 0);
});

test('the report: Eurostat’s categories with the country’s UN checks beside them', () => {
  const sdg = (series, sex, year, value) => ({
    series,
    timePeriodStart: year,
    value: String(value),
    source: 'National Police',
    footnotes: ['"Homicide" does not include deaths in custody.'],
    attributes: { Nature: 'C' },
    dimensions: { Sex: sex },
  });
  const un = buildUnGroundTruth({
    country: { iso2: 'XX', name: 'Testland' },
    homicide: YEARS.flatMap((year) => [
      sdg('VC_IHR_PSRCN', 'BOTHSEX', year, 100),
      sdg('VC_IHR_PSRC', 'BOTHSEX', year, 1),
    ]),
    reporting: [sdg('VC_PRR_ROBB', 'BOTHSEX', 2020, 30)],
    who: [
      {
        Dim1: 'SEX_BTSX',
        TimeDim: 2020,
        NumericValue: 1.6,
        Low: 1.4,
        High: 1.9,
      },
    ],
    thisYear: 2021,
  });
  const evidence = buildEurostatGroundTruth({
    country: { iso2: 'XX', name: 'Testland' },
    table: table(),
    un,
    unHomicide: un.homicideCounts,
  });
  assert.deepEqual(
    [
      evidence.status,
      evidence.year,
      evidence.tableCovers,
      evidence.categoriesInTable,
    ],
    ['ready', 2020, '2008 to 2020', 10],
  );
  const [one, two, , four] = groundTruthSectionHeadings(evidence);
  assert.equal(
    one,
    '1. Incidents left out of totals, 2 totals that don\'t equal their listed parts, 1 kind of crime where under half of victims told the police (lowest 30% for robbery in 2020), no count published of police reports struck as "unfounded", and 1 exclusion note',
  );
  assert.equal(
    two,
    '2. Use of "other", nothing to check: this table has 10 named categories and no "other"',
  );
  assert.match(
    four,
    /with 2 disagreeing, the police homicide rate below the World Health Organization's estimate for 2020, and no list of corrections published$/,
  );
  const body = formatGroundTruthBody(evidence);
  assert.match(
    body,
    /^9 of Eurostat's 10 offence categories hold figures for Testland\./m,
  );
  assert.match(
    body,
    /^- Burglary \(2020\): published rate 500, its incidents imply 400 \(off by 20%\)$/m,
  );
  assert.match(
    body,
    /^- Intentional homicide: "Homicide" does not include deaths in custody\./m,
  );
  assert.equal(
    'homicideCounts' in groundTruthForModel(un),
    false,
    'the raw series is never sent to the model',
  );

  const alone = buildEurostatGroundTruth({
    country: { iso2: 'XK', name: 'Kosovo' },
    table: table(),
  });
  assert.equal(
    alone.checks.reportingToPolice.published,
    false,
    'a place the UN does not list is read from Eurostat alone',
  );
  assert.equal(
    buildEurostatGroundTruth({
      country: { iso2: 'XX', name: 'Testland' },
      table: {},
    }),
    null,
  );
});

test('a European country asks Eurostat as well as the UN; if Eurostat fails it is still assessed', async (t) => {
  const requested = [];
  let eurostatUp = true;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href.includes('eurostat')) {
      return eurostatUp
        ? new Response(JSON.stringify(table()), { status: 200 })
        : new Response('down', { status: 503 });
    }
    const body = href.includes('indicator=16.1.1')
      ? {
          data: [
            {
              series: 'VC_IHR_PSRCN',
              timePeriodStart: 2020,
              value: '100',
              source: 'Police',
              footnotes: [''],
              attributes: { Nature: 'C' },
              dimensions: { Sex: 'BOTHSEX' },
            },
          ],
        }
      : href.includes('indicator=16.3.1')
        ? { data: [] }
        : { value: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const greece = await fetchCountryGroundTruth('gr', 'Greece');
  assert.equal(greece.country, 'Greece');
  assert.match(greece.source, /^Eurostat/);
  assert.ok(
    requested.some(
      (href) => href.includes('crim_off_cat') && href.includes('geo=EL'),
    ),
    'Greece is asked for as EL',
  );
  assert.equal(
    requested.filter((href) => href.includes('unstats.un.org')).length,
    2,
  );

  eurostatUp = false;
  const norway = await fetchCountryGroundTruth('no', 'Norway');
  assert.equal(norway.status, 'ready');
  assert.match(
    norway.source,
    /^United Nations/,
    'read from the UN alone, as any other country',
  );

  const britain = await fetchCountryGroundTruth('gb', 'United Kingdom');
  assert.match(britain.source, /^United Nations/);
  assert.equal(
    requested.some(
      (href) => href.includes('geo=GB') || href.includes('geo=UK'),
    ),
    false,
  );
});
