// Country Ground Truth Assessment: the checks that read a country's own
// published crime table for the four ways a total can say less than what
// happened. The fixture is a small table that does each of them once.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStatCanGroundTruth,
  checkArithmetic,
  checkLateStarts,
  checkOtherCategories,
  checkTotalsAgainstParts,
  checkUnfounded,
  collectGroundTruthNotes,
  groundTruthIndicator,
  indexGroundTruthSeries,
} from '../../server/providers/regional/statcan-ground-truth.js';
import { fetchCountryGroundTruth } from '../../server/providers/regional/country-ground-truth.js';
import {
  slimCorrections,
  slimFootnotes,
} from '../../server/providers/regional/statcan-crime.js';
import {
  GROUND_TRUTH_ANSWER_TOKENS,
  GROUND_TRUTH_DETAIL_LIMITS,
  GROUND_TRUTH_MODEL_FINDINGS,
  buildGroundTruthQuestion,
  formatGroundTruthBody,
  groundTruthDetailLines,
  groundTruthForModel,
  groundTruthSectionHeadings,
} from '../askOverview.js';

const STAT = {
  incidents: 1,
  rate: 2,
  change: 3,
  unfounded: 15,
  percentUnfounded: 16,
};

const VIOLATIONS = [
  { memberId: 1, parentMemberId: null, memberNameEn: 'Total, all violations' },
  { memberId: 4, parentMemberId: 1, memberNameEn: 'Total violent violations' },
  {
    memberId: 17,
    parentMemberId: 4,
    memberNameEn: 'Total sexual violations against children',
  },
  { memberId: 20, parentMemberId: 4, memberNameEn: 'Total assaults' },
  { memberId: 63, parentMemberId: 4, memberNameEn: 'Other violent violations' },
  { memberId: 70, parentMemberId: 1, memberNameEn: 'Total drug violations' },
  {
    memberId: 71,
    parentMemberId: 70,
    memberNameEn: 'Opioid (other than heroin), possession',
  },
  { memberId: 72, parentMemberId: 70, memberNameEn: 'Cannabis, possession' },
];

const METADATA = {
  geography: {
    id: 1,
    members: [
      { memberId: 1, memberNameEn: 'Canada' },
      { memberId: 8, memberNameEn: 'Saint John, New Brunswick [13310]' },
    ],
  },
  violations: { id: 2, members: VIOLATIONS },
  statistics: {
    id: 3,
    members: [
      { memberId: 1, memberNameEn: 'Actual incidents' },
      { memberId: 2, memberNameEn: 'Rate per 100,000 population' },
      { memberId: 3, memberNameEn: 'Percentage change in rate' },
      { memberId: 15, memberNameEn: 'Unfounded incidents' },
      { memberId: 16, memberNameEn: 'Percent unfounded' },
    ],
  },
  footnotes: slimFootnotes({
    footnote: [
      {
        footnoteId: 73,
        footnotesEn:
          'Includes Criminal Code violations that specifically concern offences involving child and youth victims. Incidents of child pornography are not included in the category of sexual violations against children. Excludes incidents of sexual assault levels 1, 2 and 3 against children and youth which are counted within those three violation categories. Other sexual offences not involving assault or sexual violations against children are included with "other violent offences".',
        link: { dimensionPositionId: 2, memberId: 17 },
      },
      {
        footnoteId: 26,
        footnotesEn:
          'Sexual violations against children is a new crime category with only partial data available prior to 2008. As a result, numbers and rates should not be directly compared to data from previous years.',
        link: { dimensionPositionId: 2, memberId: 17 },
      },
      {
        footnoteId: 4,
        footnotesEn:
          'Part of the 2007 increase in Saint John can be attributed to changes in police reporting practices. Those years should not be compared.',
        link: { dimensionPositionId: 1, memberId: 8 },
      },
    ],
  }),
  corrections: slimCorrections({
    correction: [
      {
        correctionDate: '2019-08-01',
        correctionNoteEn:
          '<p>On August 1, 2019, the data for 2018 for “Total impaired driving” have been corrected.<br></p>',
      },
    ],
  }),
  startYear: '2015',
  endYear: '2025',
};

const YEARS = [
  2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
];
const POPULATION = 40_000_000;

function row(violation, statistic, values) {
  return {
    status: 'SUCCESS',
    object: {
      coordinate: `1.${violation}.${statistic}.0.0.0.0.0.0.0`,
      vectorDataPoint: values.map((value, index) => ({
        refPer: `${YEARS[YEARS.length - values.length + index]}-01-01`,
        value,
      })),
    },
  };
}

const rateOf = (incidents) =>
  Math.round((incidents / POPULATION) * 100000 * 100) / 100;

/** Counts, then a rate and a change that agree with them unless `lie` says otherwise. */
function rowsFor(violation, counts, { lie = null, unfounded = null } = {}) {
  const latest = counts[counts.length - 1];
  const before = counts[counts.length - 2];
  const rates = [rateOf(before), lie?.rate ?? rateOf(latest)];
  const change =
    lie?.change ??
    Math.round((rateOf(latest) / rateOf(before) - 1) * 10000) / 100;
  const rows = [
    row(violation, STAT.incidents, counts),
    row(violation, STAT.rate, rates),
    row(violation, STAT.change, [change]),
  ];
  if (unfounded) {
    rows.push(row(violation, STAT.unfounded, [unfounded]));
    rows.push(
      row(violation, STAT.percentUnfounded, [
        Math.round((unfounded / (unfounded + latest)) * 10000) / 100,
      ]),
    );
  }
  return rows;
}

const flat = (n) => YEARS.map(() => n);

const ROWS = [
  ...rowsFor(1, flat(100000)),
  // Reports 50,000; its listed parts add to 47,000.
  ...rowsFor(4, flat(50000)),
  // A new category: nothing, then partial, then its recent level from 2019.
  ...rowsFor(17, [0, 0, 40, 60, 3000, 3200, 3400, 3600, 3800, 4000, 4000], {
    unfounded: 1000,
  }),
  ...rowsFor(20, flat(20000), { lie: { rate: 80, change: 12 } }),
  // The catch-all: larger than every named category, and doubling.
  ...rowsFor(
    63,
    [
      10000, 10000, 10000, 10000, 10000, 11500, 13000, 15000, 17000, 19000,
      23000,
    ],
  ),
  ...rowsFor(70, flat(30000)),
  ...rowsFor(71, flat(12000)),
  ...rowsFor(72, flat(18000)),
];

const SERIES = indexGroundTruthSeries(ROWS);

test('method 1: a total that does not equal its listed parts is reported with the gap', () => {
  const result = checkTotalsAgainstParts(
    VIOLATIONS,
    SERIES,
    STAT.incidents,
    2025,
  );
  assert.equal(result.checked, 3);
  assert.deepEqual(
    result.findings.map((item) => [
      item.category,
      item.reportedTotal,
      item.sumOfListedParts,
      item.difference,
      item.differencePct,
    ]),
    [
      ['Total, all violations', 100000, 80000, 20000, 20],
      ['Total violent violations', 50000, 47000, 3000, 6],
    ],
  );
  assert.match(
    result.findings[0].reading,
    /appear in none of its listed parts/,
  );
  assert.equal(
    checkTotalsAgainstParts(
      VIOLATIONS,
      SERIES,
      STAT.incidents,
      2025,
    ).findings.some((item) => item.category === 'Total drug violations'),
    false,
    'a total that equals its parts is not a finding',
  );
});

test('method 1: incidents struck from the count as unfounded', () => {
  const result = checkUnfounded(VIOLATIONS, SERIES, STAT, 2025);
  assert.equal(result.checked, 1);
  assert.deepEqual(result.findings, [
    {
      category: 'Total sexual violations against children',
      year: 2025,
      struckAsUnfounded: 1000,
      percentUnfounded: 20,
      countedInTotals: 4000,
    },
  ]);
});

test('methods 1 to 3: the table’s own notes, only the sentences that carry the point, never another city’s', () => {
  const exclusions = collectGroundTruthNotes(
    METADATA,
    1,
    /\bexclud|\bnot included\b/i,
  );
  assert.equal(exclusions.found, 1);
  assert.equal(exclusions.findings[0].tableNoteId, 73);
  assert.deepEqual(exclusions.findings[0].categories, [
    'Total sexual violations against children',
  ]);
  assert.equal(
    exclusions.findings[0].note,
    'Incidents of child pornography are not included in the category of sexual violations against children. Excludes incidents of sexual assault levels 1, 2 and 3 against children and youth which are counted within those three violation categories.',
  );

  const moved = collectGroundTruthNotes(
    METADATA,
    1,
    /\b(?:are|is) included (?:with|in|under)\b/i,
  );
  assert.match(
    moved.findings[0].note,
    /^Other sexual offences .* are included with "other violent offences"\.$/,
  );

  const comparability = collectGroundTruthNotes(
    METADATA,
    1,
    /should not be (?:directly )?compared|partial data/i,
  );
  assert.equal(
    comparability.found,
    1,
    'the Saint John note is about one city, not the country',
  );
  assert.match(
    comparability.findings[0].note,
    /new crime category with only partial data available prior to 2008/,
  );
});

test('method 2: a catch-all that outweighs the named categories and outgrows its parent; "other than" is not a catch-all', () => {
  const result = checkOtherCategories(VIOLATIONS, SERIES, STAT.incidents, 2025);
  assert.equal(result.checked, 1, 'only "Other violent violations"');
  const [other] = result.findings;
  assert.equal(other.category, 'Other violent violations');
  assert.equal(other.shareOfParentPct, 46);
  assert.equal(other.changePctOverFiveYears, 100);
  assert.equal(other.parentChangePctOverFiveYears, 0);
  assert.deepEqual(other.reasons, [
    '46% of "Total violent violations"',
    'larger than every named category beside it',
    'up 100% in 5 years while its parent moved 0%',
    'up 21.1% in one year',
  ]);
});

test('method 3: a series that reaches its recent level only part-way through the table', () => {
  const result = checkLateStarts(VIOLATIONS, SERIES, STAT.incidents, 2015);
  assert.deepEqual(result.findings, [
    {
      category: 'Total sexual violations against children',
      tableStartsIn: 2015,
      reachesRecentLevelIn: 2019,
      incidentsTheYearBefore: 60,
      incidentsThatYear: 3000,
      latestYear: 2025,
      latestIncidents: 4000,
    },
  ]);
});

test('method 4: a published rate or change that its own counts do not support', () => {
  const result = checkArithmetic(VIOLATIONS, SERIES, STAT, 2025, 1);
  assert.equal(result.impliedPopulation, POPULATION);
  const byCheck = new Map(result.findings.map((item) => [item.check, item]));
  assert.deepEqual([...byCheck.keys()].sort(), [
    'percentage change against the two rates',
    'rate against incidents',
  ]);
  assert.ok(
    result.findings.every((item) => item.category === 'Total assaults'),
  );
  assert.equal(byCheck.get('rate against incidents').publishedRate, 80);
  assert.equal(byCheck.get('rate against incidents').rateTheIncidentsImply, 50);
  assert.equal(
    byCheck.get('percentage change against the two rates').publishedChangePct,
    12,
  );
  assert.ok(result.checked > 10, 'and says how many figures it recomputed');
});

test('the indicator: a level per method, the worst overall, and CLEAR never means true', () => {
  const evidence = buildStatCanGroundTruth({ metadata: METADATA, rows: ROWS });
  assert.equal(evidence.status, 'ready');
  assert.equal(evidence.year, 2025);
  assert.equal(evidence.geography, 'Canada');
  assert.deepEqual(
    [
      evidence.indicator.overall,
      evidence.indicator.incidentsLeftOutOfTotals,
      evidence.indicator.useOfOtherCategory,
      evidence.indicator.newCategoriesAndPartialData,
      evidence.indicator.incorrectNumbers,
    ],
    ['flagged', 'flagged', 'flagged', 'watch', 'flagged'],
  );
  assert.match(
    evidence.indicator.meaning.clear,
    /does not mean the numbers are true/,
  );
  assert.equal(evidence.checks.corrections.found, 1);
  assert.equal(
    evidence.checks.corrections.findings[0].note,
    'On August 1, 2019, the data for 2018 for “Total impaired driving” have been corrected.',
  );
  assert.ok(
    evidence.limits.some((line) =>
      /cannot be seen from inside the table/.test(line),
    ),
  );

  const nothing = {
    totalsAgainstParts: { found: 0, findings: [] },
    unfounded: { found: 0, findings: [] },
    exclusionNotes: { found: 0, findings: [] },
    otherCategories: { found: 0, findings: [] },
    movedToOtherNotes: { found: 0, findings: [] },
    lateStarts: { found: 0, findings: [] },
    comparabilityNotes: { found: 0, findings: [] },
    arithmetic: { found: 0, findings: [] },
    corrections: { found: 0, findings: [] },
  };
  assert.equal(groundTruthIndicator(nothing).overall, 'clear');
});

test('a country with no table connected says so and fetches nothing', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('an unconnected country must not fetch');
  });
  const result = await fetchCountryGroundTruth('zz', 'Nowhere');
  assert.equal(result.status, 'unsupported');
  assert.equal(result.country, 'Nowhere');
  assert.deepEqual(
    result.connected.map((entry) => entry.countryCode),
    ['CA', 'US', 'EU', '*'],
  );
  assert.equal(
    (await fetchCountryGroundTruth('__proto__')).status,
    'unsupported',
  );
});

test('the report: four numbered lines with their counts, List Details under each, and no grade', () => {
  const evidence = buildStatCanGroundTruth({ metadata: METADATA, rows: ROWS });
  assert.deepEqual(groundTruthSectionHeadings(evidence), [
    '1. Incidents left out of totals, 2 totals that don\'t equal their listed parts, 1 category with 10% or more of police reports struck as "unfounded", and 1 exclusion note',
    '2. Use of "other", 1 unusual "other" category, 1 larger than every named category beside it, and 1 note filing offences under "other"',
    '3. New categories and partial data, 1 series that starts late and 1 note ruling out comparison across years',
    '4. Incorrect numbers, 15 published figures recomputed from the counts with 2 disagreeing, and 1 correction issued',
  ]);

  const body = formatGroundTruthBody(evidence);
  const lines = body.split('\n');
  assert.equal(lines[0], 'Statistics Canada table 35-10-0177-01, Canada 2025');
  assert.match(lines[1], /^1\. Incidents left out of totals, /);
  assert.equal(lines[2], 'List Details:');
  assert.equal(
    lines[3],
    '- Total, all violations (2025): reports 100000, its 2 listed parts add to 80000, difference 20000 (20%); the total holds incidents that appear in none of its listed parts',
  );
  assert.ok(
    lines.includes(
      '- Total sexual violations against children (2025): 1000 reports struck as unfounded (20%), 4000 counted',
    ),
  );
  assert.ok(
    lines.includes(
      '- Total sexual violations against children: Incidents of child pornography are not included in the category of sexual violations against children. Excludes incidents of sexual assault levels 1, 2 and 3 against children and youth which are counted within those three violation categories.',
    ),
  );
  assert.ok(
    lines.some((line) =>
      /^- Other violent violations \(2025\): 23000 incidents; 46% of "Total violent violations"; larger than every named category beside it/.test(
        line,
      ),
    ),
  );
  assert.ok(
    lines.includes(
      '- Total sexual violations against children: table starts 2015, reaches its recent level in 2019 (60 the year before, 3000 that year, 4000 in 2025)',
    ),
  );
  assert.ok(
    lines.includes(
      '- Total assaults (2025): published rate 80, its incidents imply 50 (off by 37.5%)',
    ),
    'section 4 lists details because two figures disagree',
  );
  assert.equal(body.match(/^List Details:$/gm).length, 4);
  assert.doesNotMatch(
    body,
    /INDICATOR|FLAGGED|WATCH|CLEAR/,
    'no grade in the report',
  );

  const question = buildGroundTruthQuestion(evidence);
  assert.match(question, /Country Ground Truth Assessment for Canada/);
  assert.match(question, /using only SCENE\.groundTruth/);
  for (const heading of groundTruthSectionHeadings(evidence))
    assert.ok(question.includes(heading), 'the model copies the counted lines');
  assert.equal(question.match(/^List Details:/gm).length, 4);
  assert.match(question, /do not say why the agency does it/);
  assert.match(
    question,
    /no CLEAR, WATCH or FLAGGED levels, no indicator, no overall verdict/,
  );
});

test('section 4 lists details only when a recomputed figure disagrees', () => {
  const evidence = buildStatCanGroundTruth({ metadata: METADATA, rows: ROWS });
  const agreeing = {
    ...evidence,
    checks: {
      ...evidence.checks,
      arithmetic: { checked: 182, found: 0, findings: [] },
    },
  };
  assert.equal(
    groundTruthSectionHeadings(agreeing)[3],
    '4. Incorrect numbers, 182 published figures recomputed from the counts with 0 disagreeing, and 1 correction issued',
  );
  const body = formatGroundTruthBody(agreeing);
  assert.equal(body.match(/^List Details:$/gm).length, 3);
  assert.equal(
    body.split('\n').at(-1),
    groundTruthSectionHeadings(agreeing)[3],
    'the report ends with section 4: no details there, and no limits line',
  );
  assert.doesNotMatch(body, /^Limit:/m);
  const question = buildGroundTruthQuestion(agreeing);
  assert.doesNotMatch(question, /^Limit:/m);
  assert.match(question, /The answer ends with section 4/);
  assert.equal(question.match(/^List Details:/gm).length, 3);
  assert.match(question, /nothing disagreed, so write no List Details under 4/);
});

test('the panel lists every finding; the model is handed the strongest ten, the count, and no grade', () => {
  const many = Array.from({ length: 65 }, (_, index) => ({
    category: `Series ${index + 1}`,
    tableStartsIn: 1998,
    reachesRecentLevelIn: 2010,
    incidentsTheYearBefore: 1,
    incidentsThatYear: 50,
    latestYear: 2025,
    latestIncidents: 1000 - index,
  }));
  const evidence = {
    ...buildStatCanGroundTruth({ metadata: METADATA, rows: ROWS }),
  };
  evidence.checks = {
    ...evidence.checks,
    lateStarts: { checked: 177, found: 65, findings: many },
  };
  assert.equal(
    groundTruthDetailLines(evidence)[2].filter((line) =>
      /^- Series /.test(line),
    ).length,
    65,
  );
  assert.match(formatGroundTruthBody(evidence), /^- Series 65: /m);

  const forModel = groundTruthForModel(evidence);
  assert.equal(
    forModel.checks.lateStarts.findings.length,
    GROUND_TRUTH_MODEL_FINDINGS,
  );
  assert.equal(forModel.checks.lateStarts.found, 65);
  assert.equal(forModel.checks.lateStarts.listed, 10);
  assert.equal(forModel.checks.lateStarts.findings[0].category, 'Series 1');
  assert.equal('indicator' in forModel, false);
  assert.equal('limits' in forModel, false);
  assert.equal(
    evidence.checks.lateStarts.findings.length,
    65,
    'the evidence itself is untouched',
  );
  assert.ok(GROUND_TRUTH_ANSWER_TOKENS > 2048);

  const unsupported = formatGroundTruthBody({
    status: 'unsupported',
    country: 'Taiwan',
    connected: [
      { country: 'Canada', source: 'Statistics Canada table 35-10-0177-01' },
    ],
  });
  assert.match(
    unsupported,
    /^Taiwan is not in the United Nations' table of countries and areas/,
  );
  assert.match(unsupported, /no model was asked/);
});

test('section 1 lists only the top five of each of its checks; the counted line keeps the full count', () => {
  const evidence = buildStatCanGroundTruth({ metadata: METADATA, rows: ROWS });
  const gaps = Array.from({ length: 8 }, (_, index) => ({
    category: `Total ${index + 1}`,
    year: 2025,
    reportedTotal: 1000,
    sumOfListedParts: 900 - index,
    difference: 100 + index,
    differencePct: 10,
    partsListed: 3,
    partsWithoutData: 0,
    reading:
      'the total holds incidents that appear in none of its listed parts',
  }));
  const struck = Array.from({ length: 15 }, (_, index) => ({
    category: `Struck ${index + 1}`,
    year: 2025,
    struckAsUnfounded: 2000 - index,
    percentUnfounded: 12,
    countedInTotals: 9000,
  }));
  const notes = Array.from({ length: 7 }, (_, index) => ({
    tableNoteId: index,
    note: `Excludes thing ${index + 1}.`,
    categories: [`Category ${index + 1}`],
  }));
  evidence.checks = {
    ...evidence.checks,
    totalsAgainstParts: { checked: 35, found: 8, findings: gaps },
    unfounded: { checked: 276, found: 15, findings: struck },
    exclusionNotes: { found: 7, findings: notes },
  };
  assert.deepEqual(GROUND_TRUTH_DETAIL_LIMITS, {
    totalsAgainstParts: 5,
    coverage: 5,
    reportingToPolice: 5,
    unfounded: 5,
    exclusionNotes: 5,
  });
  assert.match(
    groundTruthSectionHeadings(evidence)[0],
    /^1\. Incidents left out of totals, 8 totals .*, 15 categories .*, and 7 exclusion notes$/,
  );
  const [one] = groundTruthDetailLines(evidence);
  assert.deepEqual(
    one.map((line) => line.match(/^- ((?:Total|Struck|Category) \d+)/)[1]),
    [
      'Total 1',
      'Total 2',
      'Total 3',
      'Total 4',
      'Total 5',
      'Struck 1',
      'Struck 2',
      'Struck 3',
      'Struck 4',
      'Struck 5',
      'Category 1',
      'Category 2',
      'Category 3',
      'Category 4',
      'Category 5',
    ],
  );
  const forModel = groundTruthForModel(evidence);
  for (const name of ['totalsAgainstParts', 'unfounded', 'exclusionNotes']) {
    assert.equal(forModel.checks[name].findings.length, 5);
    assert.equal(forModel.checks[name].listed, 5);
  }
  assert.equal(forModel.checks.unfounded.found, 15);
  assert.match(
    buildGroundTruthQuestion(evidence),
    /top five at most, and that is all to list: no "and N more" line in this section/,
  );
});
