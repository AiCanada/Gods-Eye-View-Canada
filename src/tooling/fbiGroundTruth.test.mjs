// Country Ground Truth Assessment, United States: the same four methods read
// from the FBI Crime Data Explorer's national figures. The fixture is a small
// explorer that does each thing once: a year most agencies skipped, a catch-all
// arrest row that outweighs every named one, a definition that changed, a rate
// its own counts do not support.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FBI_OFFENCES,
  buildFbiGroundTruth,
  checkFbiArithmetic,
  checkFbiCoverage,
  checkFbiOtherArrests,
  fbiUrl,
  yearlyFromMonthly,
} from '../../server/providers/regional/fbi-ground-truth.js';
import { fetchCountryGroundTruth } from '../../server/providers/regional/country-ground-truth.js';
import {
  buildGroundTruthQuestion,
  formatGroundTruthBody,
  groundTruthForModel,
  groundTruthSectionHeadings,
} from '../askOverview.js';

const YEARS = [
  2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023,
  2024,
];
const POPULATION = 300_000_000;
/** Share of the population whose police reported, by year. */
const COVERAGE = { 2021: 75, default: 96 };
const coverageOf = (year) => COVERAGE[year] ?? COVERAGE.default;

const months = (year, value) =>
  Object.fromEntries(
    Array.from({ length: 12 }, (_, month) => [
      `${String(month + 1).padStart(2, '0')}-${year}`,
      typeof value === 'function' ? value(month) : value,
    ]),
  );
const across = (perYear) =>
  Object.assign({}, ...YEARS.map((year) => months(year, perYear(year))));

/** One offence's response: `annual(year)` incidents, spread evenly over the months. */
function summary(annual, { rateLie = null, cleared = 0.4 } = {}) {
  const covered = (year) => (POPULATION * coverageOf(year)) / 100;
  return {
    offenses: {
      actuals: {
        'United States Offenses': across((year) => annual(year) / 12),
        'United States Clearances': across(
          (year) => (annual(year) * cleared) / 12,
        ),
      },
      rates: {
        'United States Offenses': across(
          (year) =>
            ((rateLie?.[year] ?? 1) * (annual(year) / 12) * 100000) /
            covered(year),
        ),
      },
    },
    tooltips: {
      'Percent of Population Coverage': { 'United States': across(coverageOf) },
    },
    populations: {
      population: { 'United States': across(() => POPULATION) },
      participated_population: { 'United States': across(covered) },
    },
  };
}

const reported = (full) => (year) => (full * coverageOf(year)) / 100;
const SUMMARIES = {
  'violent-crime': summary(reported(1_200_000)),
  homicide: summary(reported(12_000)),
  // The 2013 definition: a third more from that year on.
  rape: summary((year) => reported(year >= 2013 ? 120_000 : 90_000)(year)),
  robbery: summary(reported(300_000), { rateLie: { 2024: 1.5 } }),
  'aggravated-assault': summary(reported(600_000), { cleared: 1.2 }),
  'property-crime': summary(reported(6_000_000)),
  burglary: summary(reported(1_000_000)),
  larceny: summary(reported(4_000_000)),
  'motor-vehicle-theft': summary(reported(900_000)),
  arson: summary(reported(100_000)),
};
// Violent crime as published has to equal its parts in every year but the one
// the test breaks: rebuild it from them.
SUMMARIES['violent-crime'] = summary((year) =>
  ['homicide', 'rape', 'robbery', 'aggravated-assault'].reduce(
    (sum, key) =>
      sum +
      yearlyFromMonthly(
        SUMMARIES[key].offenses.actuals['United States Offenses'],
      ).get(year).sum,
    0,
  ),
);

const ARRESTS = {
  year: 2024,
  latest: {
    'All Other Offenses': 2_400_000,
    'Simple Assault': 1_000_000,
    Larceny: 600_000,
    Rape: 0,
    'Rape (Legacy)': 18_000,
    Runaway: 0,
  },
  earlier: {
    'All Other Offenses': 2_900_000,
    'Simple Assault': 1_600_000,
    Larceny: 1_300_000,
    Rape: 0,
    'Rape (Legacy)': 22_000,
    Runaway: 0,
  },
};

test('monthly figures become years; a year is complete with twelve months', () => {
  const years = yearlyFromMonthly({
    '01-2024': 10,
    '02-2024': 20,
    '01-2025': 5,
    'bad-key': 9,
    '03-2024': null,
  });
  assert.deepEqual([...years.keys()], [2024, 2025]);
  assert.deepEqual(years.get(2024), { sum: 30, months: 2, mean: 15 });
});

test('method 1: where police did not report, nothing is counted', () => {
  const coverage = checkFbiCoverage(SUMMARIES['violent-crime'], 2024);
  assert.equal(coverage.checked, YEARS.length);
  assert.equal(coverage.found, 1, 'one year under 90%');
  assert.deepEqual(coverage.latest, {
    year: 2024,
    coveragePct: 96,
    populationNotCovered: 12_000_000,
    violentCrimesReported: coverage.latest.violentCrimesReported,
    atTheSameRateTheRestWouldAdd: Math.round(
      (coverage.latest.violentCrimesReported * 4) / 96,
    ),
  });
  const [worst] = coverage.findings;
  assert.deepEqual(
    [worst.year, worst.coveragePct, worst.populationNotCovered],
    [2021, 75, 75_000_000],
  );
  assert.equal(
    worst.atTheSameRateTheRestWouldAdd,
    Math.round(worst.violentCrimesReported / 3),
  );
});

test('method 2: the catch-all arrest row', () => {
  const result = checkFbiOtherArrests(ARRESTS.latest, ARRESTS.earlier, 2024);
  assert.equal(result.checked, 1);
  const [other] = result.findings;
  assert.deepEqual(
    [
      other.category,
      other.unit,
      other.incidents,
      other.shareOfParentPct,
      other.largerThanEveryNamedCategory,
    ],
    ['All Other Offenses', 'arrests', 2_400_000, 59.7, true],
  );
  assert.equal(other.reasons.length, 3);
  assert.match(
    other.reasons[2],
    /^49\.8% of all arrests 5 years earlier, 59\.7% now/,
  );
  assert.deepEqual(
    checkFbiOtherArrests({ Larceny: 10 }, null, 2024).findings,
    [],
  );
});

test('method 4: a published rate its own counts do not support, and more cleared than counted', () => {
  const result = checkFbiArithmetic(SUMMARIES, 2024);
  assert.equal(result.checked, 20, 'ten rates and ten clearance checks');
  assert.match(result.rateBase, /population whose police reported/);
  const byCategory = Object.fromEntries(
    result.findings.map((item) => [item.category, item]),
  );
  assert.deepEqual(Object.keys(byCategory).sort(), [
    'Aggravated assault',
    'Robbery',
  ]);
  assert.equal(byCategory.Robbery.check, 'rate against incidents');
  assert.equal(byCategory.Robbery.offByPct, 33.3);
  assert.equal(
    byCategory['Aggravated assault'].check,
    'clearances against offences',
  );
  assert.match(
    byCategory['Aggravated assault'].note,
    /more cases closed than were ever counted/,
  );
});

test('the evidence has the shape every country answers in, and says what the source does not publish', () => {
  const evidence = buildFbiGroundTruth({
    summaries: SUMMARIES,
    arrests: ARRESTS,
  });
  assert.deepEqual(
    [
      evidence.status,
      evidence.countryCode,
      evidence.country,
      evidence.year,
      evidence.tableCovers,
    ],
    ['ready', 'US', 'United States', 2024, '2011 to 2024'],
  );
  assert.equal(evidence.checks.totalsAgainstParts.checked, 2);
  assert.equal(
    evidence.checks.totalsAgainstParts.found,
    0,
    'violent and property crime equal their parts',
  );
  assert.equal(evidence.checks.unfounded.notPublished, true);
  assert.equal(evidence.checks.corrections.notPublished, true);
  assert.equal(evidence.checks.exclusionNotes.found, 2);
  assert.ok(
    evidence.checks.exclusionNotes.findings.every((note) =>
      /documented method/.test(note.note),
    ),
  );
  const notes = evidence.checks.comparabilityNotes.findings.map(
    (note) => note.note,
  );
  assert.ok(
    notes.some((note) =>
      /^2021 counts police covering 75% of the population, 2020 96%/.test(note),
    ),
  );
  assert.ok(
    notes.some((note) =>
      /^2022 counts police covering 96% of the population, 2021 75%/.test(note),
    ),
  );
  assert.ok(
    notes.some((note) =>
      /replaced its 1927 definition of rape.*86400 in 2012, 115200 in 2013/.test(
        note,
      ),
    ),
  );
  assert.ok(
    notes.some((note) =>
      /lists "Rape" and holds 0 arrests in it for 2024, while "Rape \(Legacy\)" holds 18000/.test(
        note,
      ),
    ),
  );
  assert.equal(evidence.indicator.overall, 'flagged');
  assert.equal(
    evidence.indicator.incidentsLeftOutOfTotals,
    'flagged',
    'a year under 80% coverage',
  );
  assert.equal(buildFbiGroundTruth({ summaries: {} }), null);

  const withoutArrests = buildFbiGroundTruth({ summaries: SUMMARIES });
  assert.equal(
    withoutArrests.checks.otherCategories.found,
    0,
    'the arrest table is one check of four',
  );
});

test('the report: the same four lines, worded for what this source publishes', () => {
  const evidence = buildFbiGroundTruth({
    summaries: SUMMARIES,
    arrests: ARRESTS,
  });
  const [one, two, three, four] = groundTruthSectionHeadings(evidence);
  assert.equal(
    one,
    '1. Incidents left out of totals, 0 totals that don\'t equal their listed parts, police covering 96% of the population reported in 2024 (1 year under 90%, lowest 75% in 2021), no count published of police reports struck as "unfounded", and 2 exclusion notes',
  );
  assert.equal(
    two,
    '2. Use of "other", 1 unusual "other" category, 1 larger than every named category beside it, and 1 note filing offences under "other"',
  );
  assert.match(
    three,
    /^3\. New categories and partial data, 0 series that start late and \d+ notes ruling out comparison across years$/,
  );
  assert.equal(
    four,
    '4. Incorrect numbers, 20 published figures recomputed from the counts with 2 disagreeing, and no list of corrections published',
  );

  const lines = formatGroundTruthBody(evidence).split('\n');
  assert.equal(
    lines[0],
    'FBI Crime Data Explorer (Uniform Crime Reporting Program), United States 2024',
  );
  const first = lines.findIndex((line) =>
    line.startsWith('- 2024: police covering 96%'),
  );
  const worst = lines.findIndex((line) =>
    line.startsWith('- 2021: police covering 75%'),
  );
  assert.ok(
    first > 0 && worst === first + 1,
    'the latest year first, then the least covered',
  );
  assert.match(
    lines[worst],
    /75000000 people lived where no report was made.*\(arithmetic on the published figures, not a count\)$/,
  );
  assert.ok(
    lines.some((line) =>
      /^- All Other Offenses \(2024\): 2400000 arrests; 59\.7% of all arrests/.test(
        line,
      ),
    ),
  );
  assert.ok(
    lines.some((line) =>
      /^- Aggravated assault \(2024\): .* more cases closed than were ever counted$/.test(
        line,
      ),
    ),
  );
  assert.doesNotMatch(lines.join('\n'), /INDICATOR|FLAGGED|^Limit:/m);

  const question = buildGroundTruthQuestion(evidence);
  assert.match(question, /Country Ground Truth Assessment for United States/);
  assert.match(question, /checks\.coverage when it is present/);
  assert.equal(
    groundTruthForModel(evidence).checks.coverage.latest.year,
    2024,
    'the model is handed the latest year too',
  );
});

test('the United States is connected; the route to the explorer is keyed only when a key is set', async (t) => {
  assert.equal(
    fbiUrl('summarized/national/rape?from=01-1985&to=12-2026', {}),
    'https://cde.ucr.cjis.gov/LATEST/summarized/national/rape?from=01-1985&to=12-2026',
  );
  assert.equal(
    fbiUrl('summarized/national/rape?from=01-1985&to=12-2026', {
      DATA_GOV_API_KEY: 'abc 123',
    }),
    'https://api.usa.gov/crime/fbi/cde/summarized/national/rape?from=01-1985&to=12-2026&API_KEY=abc%20123',
  );
  assert.equal(
    FBI_OFFENCES.filter((offence) => offence.parentMemberId === 1).length,
    4,
  );

  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    const key = String(url).match(/summarized\/national\/([a-z-]+)\?/)?.[1];
    const body = key
      ? SUMMARIES[key]
      : {
          'Offense Name': /from=01-2024/.test(String(url))
            ? ARRESTS.latest
            : ARRESTS.earlier,
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = fetchCountryGroundTruth('us');
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(600);
  }
  const evidence = await pending;
  assert.equal(evidence.countryCode, 'US');
  assert.equal(evidence.checks.otherCategories.found, 1);
  assert.equal(requested.length, 12, 'ten offences and two arrest years');
  assert.ok(
    requested.every((url) =>
      url.startsWith('https://cde.ucr.cjis.gov/LATEST/'),
    ),
  );
  const unsupported = await fetchCountryGroundTruth('ZZ', 'Nowhere');
  assert.deepEqual(
    unsupported.connected.map((entry) => entry.countryCode),
    ['CA', 'US', 'EU', '*'],
  );
});
