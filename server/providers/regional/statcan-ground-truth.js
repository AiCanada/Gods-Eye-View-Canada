import {
  STATCAN_PRODUCT_ID,
  STATCAN_TABLE_LABEL,
  STATCAN_TABLE_URL,
  cubeCoordinate,
  findMemberByName,
  loadTableMetadata,
  postWds,
} from './statcan-crime.js';

/**
 * Country Ground Truth Assessment, Canada: what a country's own published
 * crime table shows about how its totals are built.
 *
 * Four ways a published total can say less than what happened, each checked
 * against the table itself (Statistics Canada 35-10-0177-01, national row):
 *
 *  1. Incidents left out of a total: a total that does not equal its listed
 *     parts, incidents struck from the count as "unfounded", and the table's
 *     own notes saying what a category excludes or counts somewhere else.
 *  2. The "other" categories: how much of each parent total sits in a
 *     catch-all, whether it is larger than every named category beside it, and
 *     whether it is growing faster than its parent.
 *  3. New categories and partial data: notes saying a series cannot be
 *     compared across years, and series that only reach their recent level
 *     part-way through the table.
 *  4. Wrong numbers: published rates and percentage changes recomputed from
 *     the published counts, and the corrections the agency has had to issue.
 *
 * Nothing here is an opinion and nothing is estimated: every finding is a
 * number or a note from the table, or arithmetic on them. What the checks
 * cannot see is stated with the findings (GROUND_TRUTH_LIMITS): a number that
 * is wrong but consistent with itself is invisible from inside the table.
 */

const GROUND_TRUTH_TTL_MS = 24 * 60 * 60 * 1000;
/** WDS refuses a request for much more than this many series (416). */
const WDS_COORDINATES_PER_REQUEST = 100;
const WDS_PARALLEL_REQUESTS = 4;

/** A total and its listed parts may differ by rounding, not by this much. */
const TOTAL_GAP_MIN_PCT = 0.5;
const TOTAL_GAP_FLAG_PCT = 5;
const UNFOUNDED_WATCH_PCT = 10;
const UNFOUNDED_FLAG_PCT = 20;
/** Percentages of a handful of incidents swing on nothing. */
const MIN_INCIDENTS = 500;
const OTHER_SHARE_PCT = 25;
const OTHER_OUTGROWTH_POINTS = 25;
const OTHER_YEARLY_CHANGE_PCT = 15;
const OTHER_TREND_YEARS = 5;
/** A series "reaches its recent level" at a tenth of its last five years' median. */
const LATE_START_FRACTION = 0.1;
const LATE_START_MIN_LATEST = 100;
const ARITHMETIC_MIN_INCIDENTS = 2000;
const ARITHMETIC_MIN_RATE = 5;
const ARITHMETIC_POPULATION_TOLERANCE_PCT = 2;
const ARITHMETIC_CHANGE_TOLERANCE_POINTS = 0.5;

const EXCLUSION_NOTE =
  /\bexclud|\bnot included\b|\bnot counted\b|\bare counted within\b|\bdoes not include\b|\bdo not include\b/i;
const MOVED_TO_OTHER_NOTE = /\b(?:are|is) included (?:with|in|under)\b/i;
const COMPARABILITY_NOTE =
  /should not be (?:directly )?compared|not (?:directly |strictly )?comparable|partial data|new (?:crime )?(?:category|violation|offence)|comparisons? .{0,60}(?:caution|not possible)|break in (?:the )?series/i;

const GROUND_TRUTH_LIMITS = Object.freeze([
  'These checks read only the country’s own published table. A number that is wrong but consistent with the numbers around it cannot be seen from inside the table; that needs an independent source, such as a victimization survey, hospital or coroner records, or court records.',
  'The table counts incidents reported to and recorded by police. Incidents never reported, or reported and never recorded, are in no category here.',
  'A finding says what a practice does to a total. It does not say why the practice exists.',
]);

let groundTruthCache = { at: 0, value: null };

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * WDS rows to `violationId.statisticId` -> [{year, value}] (oldest first).
 * A value the agency marks unavailable stays null.
 * @param {object[]} rows
 * @returns {Map<string, Array<{year: number, value: number|null}>>}
 */
function indexGroundTruthSeries(rows) {
  const series = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.status && row.status !== 'SUCCESS') continue;
    const object = row?.object || row;
    const [, violation, statistic] = String(object?.coordinate || '')
      .split('.')
      .map(Number);
    if (!Number.isFinite(violation) || !Number.isFinite(statistic)) continue;
    const points = (
      Array.isArray(object?.vectorDataPoint) ? object.vectorDataPoint : []
    )
      .map((point) => ({
        year: Number(String(point?.refPer || '').slice(0, 4)),
        value:
          point?.value === null || point?.value === undefined
            ? null
            : Number(point.value),
      }))
      .filter((point) => Number.isFinite(point.year))
      .sort((a, b) => a.year - b.year);
    series.set(`${violation}.${statistic}`, points);
  }
  return series;
}

function valueIn(series, violationId, statisticId, year) {
  const point = (series.get(`${violationId}.${statisticId}`) || []).find(
    (entry) => entry.year === year,
  );
  return finite(point?.value) ? point.value : null;
}

/**
 * Every finding, strongest first. Nothing is dropped here: the panel lists
 * them all, and trims only what it hands the model.
 */
function ranked(findings, score) {
  const sorted = [...findings].sort((a, b) => score(b) - score(a));
  return { found: sorted.length, findings: sorted };
}

function childrenByParent(members) {
  const byParent = new Map();
  for (const member of members || []) {
    if (member.parentMemberId === null || member.parentMemberId === undefined)
      continue;
    if (!byParent.has(member.parentMemberId))
      byParent.set(member.parentMemberId, []);
    byParent.get(member.parentMemberId).push(member);
  }
  return byParent;
}

/**
 * Check 1a. A total against the sum of the parts the table lists under it.
 * @returns {{found: number, checked: number, findings: object[]}}
 */
function checkTotalsAgainstParts(members, series, statId, year) {
  const findings = [];
  let checked = 0;
  for (const [parentId, children] of childrenByParent(members)) {
    const parent = (members || []).find(
      (member) => member.memberId === parentId,
    );
    const total = parent ? valueIn(series, parentId, statId, year) : null;
    if (!parent || !finite(total) || total < MIN_INCIDENTS) continue;
    let sum = 0;
    let withoutData = 0;
    for (const child of children) {
      const value = valueIn(series, child.memberId, statId, year);
      if (finite(value)) sum += value;
      else withoutData += 1;
    }
    checked += 1;
    const difference = total - sum;
    const differencePct = (Math.abs(difference) / total) * 100;
    if (differencePct < TOTAL_GAP_MIN_PCT) continue;
    findings.push({
      category: parent.memberNameEn,
      year,
      reportedTotal: total,
      sumOfListedParts: sum,
      difference,
      differencePct: round(differencePct),
      partsListed: children.length,
      partsWithoutData: withoutData,
      reading:
        difference > 0
          ? 'the total holds incidents that appear in none of its listed parts'
          : 'the listed parts add up to more than the total reports',
    });
  }
  return { checked, ...ranked(findings, (item) => Math.abs(item.difference)) };
}

/**
 * Check 1b. Incidents struck from the count as unfounded: reported to police,
 * then judged not to have happened, and so in no total.
 */
function checkUnfounded(members, series, stats, year) {
  const findings = [];
  let checked = 0;
  for (const member of members || []) {
    const percent = valueIn(
      series,
      member.memberId,
      stats.percentUnfounded,
      year,
    );
    const unfounded = valueIn(series, member.memberId, stats.unfounded, year);
    const counted = valueIn(series, member.memberId, stats.incidents, year);
    if (!finite(percent) || !finite(unfounded)) continue;
    checked += 1;
    if (percent < UNFOUNDED_WATCH_PCT || unfounded < MIN_INCIDENTS / 5)
      continue;
    findings.push({
      category: member.memberNameEn,
      year,
      struckAsUnfounded: unfounded,
      percentUnfounded: round(percent),
      countedInTotals: counted,
    });
  }
  return { checked, ...ranked(findings, (item) => item.struckAsUnfounded) };
}

/** The sentences of a note that carry the point, not the whole note. */
function matchingSentences(text, pattern) {
  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+(?=[A-Z"“(])/)
    .filter((sentence) => pattern.test(sentence));
  return sentences.join(' ').trim();
}

/**
 * Checks 1c, 2b and 3a. The table's own notes, grouped so a note attached to
 * thirty categories is said once. Only notes about the violations, the
 * statistics, the national row or the whole table: a note about one city's
 * police service says nothing about the country's totals.
 */
function collectGroundTruthNotes(metadata, nationalGeoId, pattern) {
  const violationName = new Map(
    (metadata?.violations?.members || []).map((member) => [
      member.memberId,
      member.memberNameEn,
    ]),
  );
  const geographyDim = metadata?.geography?.id;
  const violationsDim = metadata?.violations?.id;
  const grouped = new Map();
  for (const note of metadata?.footnotes || []) {
    if (note.dimension === geographyDim && note.memberId !== nationalGeoId)
      continue;
    const excerpt = matchingSentences(note.text, pattern);
    if (!excerpt) continue;
    const key = note.id ?? excerpt;
    if (!grouped.has(key))
      grouped.set(key, { tableNoteId: note.id, note: excerpt, categories: [] });
    const name =
      note.dimension === violationsDim
        ? violationName.get(note.memberId)
        : null;
    if (name && !grouped.get(key).categories.includes(name))
      grouped.get(key).categories.push(name);
  }
  return ranked([...grouped.values()], (item) => item.categories.length);
}

const isOtherCategory = (name) =>
  /\bother\b/i.test(name) && !/\bother than\b/i.test(name);

/**
 * Check 2a. The catch-all categories: their share of the parent total, whether
 * they outweigh every named category beside them, and whether they are growing
 * faster than the parent they sit in.
 */
function checkOtherCategories(members, series, statId, year) {
  const byParent = childrenByParent(members);
  const findings = [];
  let checked = 0;
  for (const member of members || []) {
    if (!isOtherCategory(member.memberNameEn)) continue;
    const parent = (members || []).find(
      (entry) => entry.memberId === member.parentMemberId,
    );
    const count = valueIn(series, member.memberId, statId, year);
    const parentCount = parent
      ? valueIn(series, parent.memberId, statId, year)
      : null;
    if (!parent || !finite(count) || !finite(parentCount) || parentCount <= 0)
      continue;
    checked += 1;
    const sharePct = (count / parentCount) * 100;
    const reasons = [];
    if (sharePct >= OTHER_SHARE_PCT)
      reasons.push(`${round(sharePct)}% of "${parent.memberNameEn}"`);
    const named = (byParent.get(parent.memberId) || []).filter(
      (sibling) =>
        sibling.memberId !== member.memberId &&
        !isOtherCategory(sibling.memberNameEn),
    );
    const largestNamed = Math.max(
      0,
      ...named.map(
        (sibling) => valueIn(series, sibling.memberId, statId, year) ?? 0,
      ),
    );
    const largerThanEveryNamed =
      named.length > 0 && count > largestNamed && count >= MIN_INCIDENTS;
    if (largerThanEveryNamed)
      reasons.push('larger than every named category beside it');
    const before = valueIn(
      series,
      member.memberId,
      statId,
      year - OTHER_TREND_YEARS,
    );
    const parentBefore = valueIn(
      series,
      parent.memberId,
      statId,
      year - OTHER_TREND_YEARS,
    );
    let changePct = null;
    let parentChangePct = null;
    if (
      finite(before) &&
      before > 0 &&
      finite(parentBefore) &&
      parentBefore > 0
    ) {
      changePct = (count / before - 1) * 100;
      parentChangePct = (parentCount / parentBefore - 1) * 100;
      if (
        count >= MIN_INCIDENTS &&
        changePct - parentChangePct >= OTHER_OUTGROWTH_POINTS
      ) {
        reasons.push(
          `up ${round(changePct)}% in ${OTHER_TREND_YEARS} years while its parent moved ${round(parentChangePct)}%`,
        );
      }
    }
    const lastYear = valueIn(series, member.memberId, statId, year - 1);
    if (finite(lastYear) && lastYear > 0 && count >= MIN_INCIDENTS) {
      const yearly = (count / lastYear - 1) * 100;
      if (Math.abs(yearly) >= OTHER_YEARLY_CHANGE_PCT)
        reasons.push(
          `${yearly > 0 ? 'up' : 'down'} ${round(Math.abs(yearly))}% in one year`,
        );
    }
    if (!reasons.length) continue;
    findings.push({
      category: member.memberNameEn,
      parent: parent.memberNameEn,
      year,
      incidents: count,
      shareOfParentPct: round(sharePct),
      changePctOverFiveYears: finite(changePct) ? round(changePct) : null,
      parentChangePctOverFiveYears: finite(parentChangePct)
        ? round(parentChangePct)
        : null,
      largerThanEveryNamedCategory: largerThanEveryNamed,
      reasons,
    });
  }
  return {
    checked,
    ...ranked(findings, (item) => item.incidents * item.reasons.length),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Check 3b. A series that reaches a tenth of its recent level only part-way
 * through the table: a new category, or one with partial data before then.
 * Earlier years cannot be compared with later ones, whatever the note says.
 */
function checkLateStarts(members, series, statId, startYear) {
  const findings = [];
  let checked = 0;
  for (const member of members || []) {
    const points = (series.get(`${member.memberId}.${statId}`) || []).filter(
      (point) => finite(point.value),
    );
    if (points.length < 6) continue;
    const latest = points[points.length - 1];
    const recent = median(points.slice(-5).map((point) => point.value));
    if (!finite(recent) || recent < LATE_START_MIN_LATEST) continue;
    checked += 1;
    const reached = points.find(
      (point) => point.value >= recent * LATE_START_FRACTION,
    );
    if (!reached || reached.year <= startYear + 1) continue;
    findings.push({
      category: member.memberNameEn,
      tableStartsIn: startYear,
      reachesRecentLevelIn: reached.year,
      incidentsTheYearBefore:
        points.find((point) => point.year === reached.year - 1)?.value ?? null,
      incidentsThatYear: reached.value,
      latestYear: latest.year,
      latestIncidents: latest.value,
    });
  }
  return { checked, ...ranked(findings, (item) => item.latestIncidents) };
}

/**
 * Check 4. The published rate and percentage change, recomputed from the
 * published counts. Every rate implies a population (incidents / rate); within
 * one year and one geography that population is the same whatever the crime.
 */
function checkArithmetic(members, series, stats, year, totalId) {
  const findings = [];
  let checked = 0;
  const totalIncidents = valueIn(series, totalId, stats.incidents, year);
  const totalRate = valueIn(series, totalId, stats.rate, year);
  const population =
    finite(totalIncidents) && finite(totalRate) && totalRate > 0
      ? (totalIncidents / totalRate) * 100000
      : null;
  for (const member of members || []) {
    const incidents = valueIn(series, member.memberId, stats.incidents, year);
    const rate = valueIn(series, member.memberId, stats.rate, year);
    if (
      !finite(incidents) ||
      !finite(rate) ||
      incidents < ARITHMETIC_MIN_INCIDENTS ||
      rate < ARITHMETIC_MIN_RATE
    )
      continue;
    if (finite(population) && member.memberId !== totalId) {
      checked += 1;
      const implied = (incidents / rate) * 100000;
      const offPct = (Math.abs(implied - population) / population) * 100;
      if (offPct > ARITHMETIC_POPULATION_TOLERANCE_PCT) {
        findings.push({
          category: member.memberNameEn,
          year,
          check: 'rate against incidents',
          publishedRate: rate,
          rateTheIncidentsImply: round((incidents / population) * 100000, 2),
          offByPct: round(offPct),
        });
      }
    }
    const published = valueIn(series, member.memberId, stats.change, year);
    const rateBefore = valueIn(series, member.memberId, stats.rate, year - 1);
    if (
      finite(published) &&
      finite(rateBefore) &&
      rateBefore >= ARITHMETIC_MIN_RATE
    ) {
      checked += 1;
      const computed = (rate / rateBefore - 1) * 100;
      if (Math.abs(computed - published) > ARITHMETIC_CHANGE_TOLERANCE_POINTS) {
        findings.push({
          category: member.memberNameEn,
          year,
          check: 'percentage change against the two rates',
          publishedChangePct: published,
          changeTheRatesImplyPct: round(computed, 2),
          offByPoints: round(Math.abs(computed - published), 2),
        });
      }
    }
  }
  return {
    checked,
    impliedPopulation: finite(population) ? Math.round(population) : null,
    ...ranked(findings, (item) => item.offByPct ?? item.offByPoints ?? 0),
  };
}

const LEVEL_RANK = Object.freeze({ clear: 0, watch: 1, flagged: 2 });
const worst = (...levels) =>
  levels.reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), 'clear');

/**
 * The indicator: one level per method and the worst of them overall. CLEAR is
 * "these checks found nothing", never "the numbers are true".
 */
function groundTruthIndicator(checks) {
  const totalsGap = Math.max(
    0,
    ...checks.totalsAgainstParts.findings.map((item) => item.differencePct),
  );
  const unfounded = Math.max(
    0,
    ...checks.unfounded.findings.map((item) => item.percentUnfounded),
  );
  const incidentsLeftOut = worst(
    totalsGap >= TOTAL_GAP_FLAG_PCT
      ? 'flagged'
      : checks.totalsAgainstParts.found
        ? 'watch'
        : 'clear',
    unfounded >= UNFOUNDED_FLAG_PCT
      ? 'flagged'
      : checks.unfounded.found
        ? 'watch'
        : 'clear',
    checks.exclusionNotes.found ? 'watch' : 'clear',
    // A country whose totals are a sum of what agencies chose to send.
    checks.coverage?.found ? 'watch' : 'clear',
  );
  const otherCategory = worst(
    checks.otherCategories.findings.some((item) => item.reasons.length >= 2)
      ? 'flagged'
      : checks.otherCategories.found
        ? 'watch'
        : 'clear',
    checks.movedToOtherNotes.found ? 'watch' : 'clear',
  );
  const comparability = worst(
    checks.lateStarts.found >= 10
      ? 'flagged'
      : checks.lateStarts.found
        ? 'watch'
        : 'clear',
    checks.comparabilityNotes.found >= 10
      ? 'flagged'
      : checks.comparabilityNotes.found
        ? 'watch'
        : 'clear',
  );
  const incorrectNumbers = worst(
    checks.arithmetic.found ? 'flagged' : 'clear',
    checks.corrections.found ? 'watch' : 'clear',
  );
  return {
    overall: worst(
      incidentsLeftOut,
      otherCategory,
      comparability,
      incorrectNumbers,
    ),
    incidentsLeftOutOfTotals: incidentsLeftOut,
    useOfOtherCategory: otherCategory,
    newCategoriesAndPartialData: comparability,
    incorrectNumbers,
    meaning: {
      clear:
        'these checks found nothing; it does not mean the numbers are true',
      watch: 'the table does this, and says so in its own notes or numbers',
      flagged:
        'the table does this to a degree that changes what a total means',
    },
  };
}

/**
 * All four methods over one country's table. Pure: metadata and rows in,
 * evidence out.
 * @param {{metadata: object, rows: object[], country?: string}} input
 */
function buildStatCanGroundTruth({ metadata, rows, country = 'Canada' }) {
  const members = metadata?.violations?.members || [];
  const statistic = (name) =>
    findMemberByName(metadata?.statistics?.members, name)?.memberId ?? null;
  const stats = {
    incidents: statistic('Actual incidents'),
    rate: statistic('Rate per 100,000 population'),
    change: statistic('Percentage change in rate'),
    unfounded: statistic('Unfounded incidents'),
    percentUnfounded: statistic('Percent unfounded'),
  };
  const national = findMemberByName(metadata?.geography?.members, country);
  const total = findMemberByName(members, 'Total, all violations');
  const series = indexGroundTruthSeries(rows);
  const years = [...series.entries()]
    .filter(([key]) => key.endsWith(`.${stats.incidents}`))
    .flatMap(([, points]) =>
      points.filter((point) => finite(point.value)).map((point) => point.year),
    );
  if (!years.length || !national) return null;
  const year = Math.max(...years);
  const startYear = Number(metadata?.startYear) || Math.min(...years);

  const checks = {
    totalsAgainstParts: checkTotalsAgainstParts(
      members,
      series,
      stats.incidents,
      year,
    ),
    unfounded: checkUnfounded(members, series, stats, year),
    exclusionNotes: collectGroundTruthNotes(
      metadata,
      national.memberId,
      EXCLUSION_NOTE,
    ),
    otherCategories: checkOtherCategories(
      members,
      series,
      stats.incidents,
      year,
    ),
    movedToOtherNotes: collectGroundTruthNotes(
      metadata,
      national.memberId,
      MOVED_TO_OTHER_NOTE,
    ),
    lateStarts: checkLateStarts(members, series, stats.incidents, startYear),
    comparabilityNotes: collectGroundTruthNotes(
      metadata,
      national.memberId,
      COMPARABILITY_NOTE,
    ),
    arithmetic: checkArithmetic(members, series, stats, year, total?.memberId),
    corrections: {
      found: (metadata?.corrections || []).length,
      findings: [...(metadata?.corrections || [])].sort((a, b) =>
        String(b.date).localeCompare(String(a.date)),
      ),
    },
  };
  return {
    status: 'ready',
    country,
    countryCode: 'CA',
    source: STATCAN_TABLE_LABEL,
    url: STATCAN_TABLE_URL,
    geography: national.memberNameEn,
    year,
    tableCovers: `${startYear} to ${year}`,
    categoriesInTable: members.length,
    indicator: groundTruthIndicator(checks),
    checks,
    limits: [...GROUND_TRUTH_LIMITS],
  };
}

async function inBatches(items, size, parallel, run) {
  const batches = [];
  for (let start = 0; start < items.length; start += size)
    batches.push(items.slice(start, start + size));
  const results = new Array(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const index = next++;
      results[index] = await run(batches[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(parallel, batches.length) }, worker),
  );
  return results.flat();
}

/** The national row of the table: every category, the series each check reads. */
async function fetchStatCanGroundTruthRows(metadata) {
  const national = findMemberByName(metadata.geography.members, 'Canada');
  const statistic = (name) =>
    findMemberByName(metadata.statistics.members, name);
  const history = Math.max(
    2,
    Number(metadata.endYear) - Number(metadata.startYear) + 1 || 30,
  );
  const wanted = [
    [statistic('Actual incidents'), history],
    [statistic('Rate per 100,000 population'), 2],
    [statistic('Percentage change in rate'), 1],
    [statistic('Unfounded incidents'), 1],
    [statistic('Percent unfounded'), 1],
  ].filter(([member]) => member);
  if (!national || !wanted.length) return [];
  const coordinates = [];
  for (const violation of metadata.violations.members) {
    for (const [member, latestN] of wanted) {
      coordinates.push({
        productId: STATCAN_PRODUCT_ID,
        coordinate: cubeCoordinate(
          national.memberId,
          violation.memberId,
          member.memberId,
        ),
        latestN,
      });
    }
  }
  return inBatches(
    coordinates,
    WDS_COORDINATES_PER_REQUEST,
    WDS_PARALLEL_REQUESTS,
    (batch) =>
      postWds('getDataFromCubePidCoordAndLatestNPeriods', batch, 30000),
  );
}

/**
 * The evidence for Canada. Computed once a day: the table is annual.
 */
async function fetchStatCanGroundTruth({ now = Date.now() } = {}) {
  if (groundTruthCache.value && now - groundTruthCache.at < GROUND_TRUTH_TTL_MS)
    return groundTruthCache.value;
  const metadata = await loadTableMetadata();
  const rows = await fetchStatCanGroundTruthRows(metadata);
  const value = buildStatCanGroundTruth({ metadata, rows });
  if (!value) throw new Error('The statistics table returned no national data');
  groundTruthCache = { at: now, value };
  return value;
}

export {
  GROUND_TRUTH_LIMITS,
  buildStatCanGroundTruth,
  checkArithmetic,
  checkLateStarts,
  checkOtherCategories,
  checkTotalsAgainstParts,
  checkUnfounded,
  collectGroundTruthNotes,
  fetchStatCanGroundTruth,
  groundTruthIndicator,
  indexGroundTruthSeries,
  ranked as rankedFindings,
};
