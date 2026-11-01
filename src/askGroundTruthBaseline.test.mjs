// Country Ground Truth Assessment against the United States: the counts per
// method, the index (findings per 100 figures checked, the United States at
// 100), the fifth section's lines, and what the model is handed to copy. The
// fixtures are the counts the four adapters answered on 2026-10-30.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUND_TRUTH_METHODS,
  compareGroundTruthAgainstBaseline,
  groundTruthBaselineDetailLines,
  groundTruthBaselineHeading,
  groundTruthFindingCounts,
} from './askGroundTruthBaseline.js';
import {
  buildGroundTruthQuestion,
  formatGroundTruthBody,
  groundTruthForModel,
} from './askOverview.js';

/** A check as the adapters answer it: how many figures, how many findings. */
const check = (found, checked, finding = (i) => ({ category: `c${i}` })) => ({
  found,
  checked,
  findings: Array.from({ length: found }, (_, i) => finding(i)),
});
const notes = (found) => ({
  found,
  findings: Array.from({ length: found }, (_, i) => ({
    note: `note ${i}`,
    categories: [],
  })),
});
const notPublished = () => ({
  checked: 0,
  found: 0,
  findings: [],
  notPublished: true,
});

/** The United States, as the explorer answered. */
const UNITED_STATES = Object.freeze({
  status: 'ready',
  country: 'United States',
  countryCode: 'US',
  source: 'FBI Crime Data Explorer (Uniform Crime Reporting Program)',
  geography: 'United States',
  year: 2025,
  indicator: { overall: 'flagged' },
  checks: {
    totalsAgainstParts: check(0, 2),
    coverage: {
      ...check(8, 41, (i) => ({
        year: 2021 - i,
        coveragePct: 65 + i,
        populationNotCovered: 1,
        violentCrimesReported: 1,
        atTheSameRateTheRestWouldAdd: 1,
      })),
      latest: {
        year: 2025,
        coveragePct: 96.6,
        populationNotCovered: 11837813,
        violentCrimesReported: 1098778,
        atTheSameRateTheRestWouldAdd: 39017,
      },
    },
    unfounded: notPublished(),
    exclusionNotes: notes(2),
    otherCategories: check(1, 1, () => ({
      category: 'All Other Offenses',
      year: 2025,
      unit: 'arrests',
      incidents: 1,
      reasons: ['a'],
      largerThanEveryNamedCategory: true,
    })),
    movedToOtherNotes: notes(1),
    lateStarts: check(0, 10),
    comparabilityNotes: notes(8),
    arithmetic: check(0, 20),
    corrections: { found: 0, findings: [], notPublished: true },
  },
});

/** Canada, as Statistics Canada's table answered the same day. */
const CANADA = Object.freeze({
  status: 'ready',
  country: 'Canada',
  countryCode: 'CA',
  source: 'Statistics Canada table 35-10-0177-01',
  geography: 'Canada',
  year: 2025,
  indicator: { overall: 'flagged' },
  checks: {
    totalsAgainstParts: check(2, 35, (i) => ({
      category: `Total ${i}`,
      year: 2025,
      reportedTotal: 1000,
      partsListed: 3,
      sumOfListedParts: 990,
      difference: 10,
      differencePct: 1,
      reading: 'the total holds incidents that appear in none of its parts',
    })),
    unfounded: check(15, 276, (i) => ({
      category: `Violation ${i}`,
      year: 2025,
      struckAsUnfounded: 100,
      percentUnfounded: 12,
      countedInTotals: 700,
    })),
    exclusionNotes: notes(5),
    otherCategories: check(11, 27, (i) => ({
      category: `Other ${i}`,
      year: 2025,
      incidents: 600,
      reasons: ['r'],
    })),
    movedToOtherNotes: notes(1),
    lateStarts: check(65, 177, (i) => ({
      category: `Series ${i}`,
      tableStartsIn: 1998,
      reachesRecentLevelIn: 2010,
      incidentsTheYearBefore: 0,
      incidentsThatYear: 50,
      latestYear: 2025,
      latestIncidents: 500,
    })),
    comparabilityNotes: notes(20),
    arithmetic: check(0, 182),
    corrections: notes(1),
  },
});

/** A country read from the United Nations: one offence, and nothing found. */
const BRITAIN = Object.freeze({
  status: 'ready',
  country: 'United Kingdom',
  countryCode: 'GB',
  source: 'United Nations SDG database',
  geography: 'United Kingdom',
  year: 2020,
  checks: {
    totalsAgainstParts: check(0, 5),
    reportingToPolice: { ...check(0, 0), published: false },
    unfounded: notPublished(),
    exclusionNotes: notes(0),
    otherCategories: { ...notPublished(), reason: 'one category' },
    movedToOtherNotes: notes(0),
    lateStarts: check(0, 1),
    comparabilityNotes: notes(2),
    arithmetic: check(0, 20),
    corrections: { found: 0, findings: [], notPublished: true },
  },
});

/** Mexico: every homicide total off its parts by sex, every victim survey low. */
const MEXICO = Object.freeze({
  status: 'ready',
  country: 'Mexico',
  countryCode: 'MX',
  source: 'United Nations SDG database',
  geography: 'Mexico',
  year: 2024,
  checks: {
    totalsAgainstParts: check(5, 5),
    reportingToPolice: { ...check(5, 5), published: true },
    unfounded: notPublished(),
    exclusionNotes: notes(1),
    otherCategories: { ...notPublished(), reason: 'one category' },
    movedToOtherNotes: notes(0),
    lateStarts: check(0, 1),
    comparabilityNotes: notes(1),
    arithmetic: check(0, 24),
    corrections: { found: 0, findings: [], notPublished: true },
  },
});

test('each method sums the checks that examine figures and keeps the notes beside them', () => {
  assert.equal(GROUND_TRUTH_METHODS.length, 4);
  const us = groundTruthFindingCounts(UNITED_STATES);
  assert.deepEqual(
    us.methods.map((m) => [
      m.number,
      m.findings,
      m.figuresChecked,
      m.notes,
      m.rate,
    ]),
    [
      [1, 8, 43, 2, 18.6],
      [2, 1, 1, 1, 100],
      [3, 0, 10, 8, 0],
      [4, 0, 20, 0, 0],
    ],
  );
  assert.deepEqual(
    [us.country, us.findings, us.figuresChecked, us.notes, us.rate],
    ['United States', 9, 74, 11, 12.2],
  );
  const ca = groundTruthFindingCounts(CANADA);
  assert.deepEqual(
    ca.methods.map((m) => [m.findings, m.figuresChecked, m.notes, m.rate]),
    [
      [17, 311, 5, 5.5],
      [11, 27, 1, 40.7],
      [65, 177, 20, 36.7],
      [0, 182, 1, 0],
    ],
  );
  assert.deepEqual(
    [ca.findings, ca.figuresChecked, ca.notes, ca.rate],
    [93, 697, 27, 13.3],
  );
  // A check the source does not publish counts for nothing.
  assert.equal(groundTruthFindingCounts(BRITAIN).methods[1].rate, null);
});

test('the index: findings per 100 figures checked, the United States at 100, from the printed rates', () => {
  const compared = compareGroundTruthAgainstBaseline(CANADA, UNITED_STATES);
  assert.equal(compared.status, 'compared');
  assert.equal(compared.index, 109, '13.3 against 12.2');
  assert.deepEqual(
    compared.methods.map((m) => [m.number, m.index, m.reason]),
    [
      [1, 30, null],
      [2, 41, null],
      [3, null, 'baselineFoundNothing'],
      [4, 100, null],
    ],
  );
  assert.deepEqual(
    [
      compared.baseline.country,
      compared.baseline.findings,
      compared.baseline.figuresChecked,
      compared.baseline.rate,
    ],
    ['United States', 9, 74, 12.2],
  );
  assert.equal(compared.baselineIndex, 100);
  assert.equal(compared.baselineCountryCode, 'US');
  assert.equal('methods' in compared.country, false, 'counts, not nesting');
  // A thin table that found nothing reads 0, not ten times more truthful.
  const thin = compareGroundTruthAgainstBaseline(BRITAIN, UNITED_STATES);
  assert.equal(thin.index, 0);
  assert.deepEqual(
    thin.methods.map((m) => [m.index, m.reason]),
    [
      [0, null],
      [null, 'nothingChecked'],
      [100, null],
      [100, null],
    ],
  );
  // Ten findings in thirty-five figures: 28.6 per 100, 234 against 12.2.
  assert.equal(
    compareGroundTruthAgainstBaseline(MEXICO, UNITED_STATES).index,
    234,
  );
});

test('the United States is its own baseline; a baseline that could not be read leaves the country alone', () => {
  const own = compareGroundTruthAgainstBaseline(UNITED_STATES, null);
  assert.equal(own.status, 'baseline');
  assert.equal(own.index, 100);
  assert.deepEqual(
    own.methods.map((m) => m.index),
    [100, 100, 100, 100],
  );
  assert.deepEqual(own.baseline, own.country);

  const alone = compareGroundTruthAgainstBaseline(CANADA, {
    status: 'unavailable',
    error: 'HTTP 503',
  });
  assert.equal(alone.status, 'unavailable');
  assert.equal(alone.baseline, null);
  assert.equal(alone.index, null);
  assert.equal(alone.error, 'HTTP 503');
  assert.equal(alone.country.findings, 93);
  assert.equal(alone.methods[0].baseline, null);
  assert.equal(
    compareGroundTruthAgainstBaseline(CANADA, null).status,
    'unavailable',
  );

  assert.equal(
    compareGroundTruthAgainstBaseline({ status: 'nodata' }, UNITED_STATES),
    null,
  );
  assert.equal(
    compareGroundTruthAgainstBaseline({ status: 'unsupported' }, null),
    null,
  );
  assert.equal(compareGroundTruthAgainstBaseline(null, null), null);
});

test('the fifth section: its line and its List Details, counted from the comparison', () => {
  const compared = compareGroundTruthAgainstBaseline(CANADA, UNITED_STATES);
  assert.equal(
    groundTruthBaselineHeading(compared),
    '5. Against the United States at 100, Canada 109: 13.3 findings per 100 figures checked, the United States 12.2 (93 findings in 697 figures checked; the United States 9 in 74); 27 notes counted, not indexed (the United States 11)',
  );
  assert.deepEqual(groundTruthBaselineDetailLines(compared), [
    '- 1. Incidents left out of totals: Canada 17 findings in 311 figures checked (5.5 per 100), the United States 8 in 43 (18.6 per 100), index 30',
    '- 2. Use of "other": Canada 11 findings in 27 figures checked (40.7 per 100), the United States 1 in 1 (100 per 100), index 41',
    '- 3. New categories and partial data: Canada 65 findings in 177 figures checked (36.7 per 100), the United States 0 in 10 (0 per 100), no index: the United States’ checks found nothing here',
    '- 4. Incorrect numbers: Canada 0 findings in 182 figures checked (0 per 100), the United States 0 in 20 (0 per 100), index 100',
    '- Notes counted, not indexed: Canada 5 exclusion notes, 1 note filing offences under "other", 20 notes ruling out comparison across years and 1 correction; the United States 2 exclusion notes, 1 note, 8 notes and 0 corrections',
  ]);

  const own = compareGroundTruthAgainstBaseline(UNITED_STATES, null);
  assert.equal(
    groundTruthBaselineHeading(own),
    '5. Against the United States at 100: the United States is the baseline, 12.2 findings per 100 figures checked (9 findings in 74 figures checked); 11 notes counted, not indexed',
  );
  assert.deepEqual(groundTruthBaselineDetailLines(own), []);

  const alone = compareGroundTruthAgainstBaseline(CANADA, {
    status: 'unavailable',
    error: 'HTTP 503',
  });
  assert.equal(
    groundTruthBaselineHeading(alone),
    '5. Against the United States at 100: the United States’ table could not be read this time (HTTP 503), so there is no baseline to compare with; 93 findings in 697 figures checked here, 27 notes counted, not indexed',
  );
  assert.deepEqual(groundTruthBaselineDetailLines(alone), []);

  const thin = compareGroundTruthAgainstBaseline(BRITAIN, UNITED_STATES);
  assert.equal(
    groundTruthBaselineHeading(thin),
    '5. Against the United States at 100, United Kingdom 0: 0 findings per 100 figures checked, the United States 12.2 (0 findings in 26 figures checked; the United States 9 in 74); 2 notes counted, not indexed (the United States 11)',
  );
  assert.equal(
    groundTruthBaselineDetailLines(thin)[1],
    '- 2. Use of "other": United Kingdom 0 findings in 0 figures checked, the United States 1 in 1, no index: a side with no figure checked has no rate',
  );

  // The builder writes the screen's language through `say`.
  const say = {
    tl: (text, values) =>
      `[${text.replace(/\{(\w+)\}/g, (_, key) => values?.[key] ?? '')}]`,
    tln: (count, one, other) => `${count}×${count === 1 ? one : other}`,
    digits: (text) => String(text).replace('.', ','),
  };
  assert.match(
    groundTruthBaselineHeading(compared, say),
    /^\[5\. Against the United States at 100, Canada 109: 13,3 findings per 100 figures checked, the United States 12,2 \(93×\{count\} findings in 697×\{count\} figures checked;/,
  );
});

test('the report and the question carry section 5 only when the panel compared', () => {
  assert.doesNotMatch(formatGroundTruthBody(CANADA), /^5\. /m);
  const compared = {
    ...CANADA,
    againstBaseline: compareGroundTruthAgainstBaseline(CANADA, UNITED_STATES),
  };
  const body = formatGroundTruthBody(compared).split('\n');
  const five = body.findIndex((line) =>
    line.startsWith('5. Against the United States at 100, Canada 109'),
  );
  assert.ok(five > 0, 'after the four sections');
  assert.equal(body[five + 1], 'List Details:');
  assert.match(
    body[five + 2],
    /^- 1\. Incidents left out of totals: Canada 17/,
  );
  assert.match(
    body.at(-1),
    /^- Notes counted, not indexed: Canada 5 exclusion notes/,
  );

  const question = buildGroundTruthQuestion(compared);
  assert.match(question, /Copy the five numbered lines word for word/);
  assert.ok(question.includes(body[five]), 'the model copies the fifth line');
  assert.ok(question.includes(body.at(-1)), 'and its details');
  assert.equal(question.match(/^List Details:/gm).length, 4);
  assert.match(question, /section 5 is given in full/);
  assert.match(question, /is not a grade/);
  assert.match(question, /The answer ends with section 5/);
  assert.doesNotMatch(question, /The answer ends with section 4/);

  const without = buildGroundTruthQuestion(CANADA);
  assert.match(without, /Copy the four numbered lines word for word/);
  assert.match(without, /The answer ends with section 4/);
  assert.equal(without.match(/^List Details:/gm).length, 3);

  const forModel = groundTruthForModel(compared);
  assert.equal(forModel.againstBaseline.index, 109);
  assert.equal(forModel.againstBaseline.methods.length, 4);
  assert.equal('indicator' in forModel, false, 'still no grade');
});
