import { readResponseJsonCapped } from '../common/http.js';
import {
  GROUND_TRUTH_LIMITS,
  checkLateStarts,
  checkTotalsAgainstParts,
  groundTruthIndicator,
  rankedFindings,
} from './statcan-ground-truth.js';

/**
 * Country Ground Truth Assessment, United States: the same four methods, read
 * from the FBI's Crime Data Explorer (the Uniform Crime Reporting Program's
 * national figures, monthly since 1985).
 *
 *  1. Incidents left out of totals. The American figure is a sum of what police
 *     agencies chose to send: each month the explorer publishes what share of
 *     the population those agencies cover. Where the rest live, nothing is
 *     counted (77% in 2021, when the FBI stopped accepting the old format and
 *     New York and Los Angeles were absent). Totals are also checked against
 *     their parts. The count of reports police struck as unfounded is not
 *     published at all, which is said, not skipped.
 *  2. The "other" category. Arrests are published by offence; "All Other
 *     Offenses" is one of the rows.
 *  3. New categories and partial data. Years whose coverage differs from the
 *     year before are counts of different populations; the 2013 rape definition
 *     is visible in the series itself; a category the table lists and holds
 *     nothing in is reported.
 *  4. Incorrect numbers. Every published annual rate recomputed from the
 *     published counts and the published population.
 *
 * The explorer carries no footnotes, so the notes here are the Program's own
 * documented rules (the Hierarchy Rule, unfounded reports, the 2013 definition,
 * the 2021 transition, the definition of "All Other Offenses"), each marked as
 * such. Everything else is a number from the explorer or arithmetic on one.
 */

const FBI_SOURCE = 'FBI Crime Data Explorer (Uniform Crime Reporting Program)';
const FBI_URL = 'https://cde.ucr.cjis.gov/';
/** The explorer's own public backend; api.usa.gov serves the same routes to a key. */
const FBI_PUBLIC_BASE = 'https://cde.ucr.cjis.gov/LATEST';
const FBI_KEYED_BASE = 'https://api.usa.gov/crime/fbi/cde';
const FBI_TTL_MS = 24 * 60 * 60 * 1000;
const FBI_REQUEST_GAP_MS = 500;
const FBI_MAX_BYTES = 2 * 1024 * 1024;
const FBI_FIRST_YEAR = 1985;

const COVERAGE_LOW_PCT = 90;
const COVERAGE_FLAG_PCT = 80;
const COVERAGE_SWING_POINTS = 5;
const OTHER_SHARE_PCT = 25;
const OTHER_OUTGROWTH_POINTS = 5;
const OTHER_TREND_YEARS = 5;
const RATE_TOLERANCE_PCT = 2;
const DEFINITION_JUMP_PCT = 10;

/** Offence ids of the explorer's summarized national route, as a tree. */
const FBI_OFFENCES = Object.freeze([
  {
    memberId: 1,
    parentMemberId: null,
    key: 'violent-crime',
    memberNameEn: 'Violent crime',
  },
  { memberId: 2, parentMemberId: 1, key: 'homicide', memberNameEn: 'Homicide' },
  { memberId: 3, parentMemberId: 1, key: 'rape', memberNameEn: 'Rape' },
  { memberId: 4, parentMemberId: 1, key: 'robbery', memberNameEn: 'Robbery' },
  {
    memberId: 5,
    parentMemberId: 1,
    key: 'aggravated-assault',
    memberNameEn: 'Aggravated assault',
  },
  {
    memberId: 6,
    parentMemberId: null,
    key: 'property-crime',
    memberNameEn: 'Property crime',
  },
  { memberId: 7, parentMemberId: 6, key: 'burglary', memberNameEn: 'Burglary' },
  {
    memberId: 8,
    parentMemberId: 6,
    key: 'larceny',
    memberNameEn: 'Larceny-theft',
  },
  {
    memberId: 9,
    parentMemberId: 6,
    key: 'motor-vehicle-theft',
    memberNameEn: 'Motor vehicle theft',
  },
  { memberId: 10, parentMemberId: 6, key: 'arson', memberNameEn: 'Arson' },
]);
const INCIDENTS = 1;

const METHOD = '(FBI Uniform Crime Reporting Program, documented method)';
const EXCLUSION_METHOD_NOTES = Object.freeze([
  {
    note: `The Hierarchy Rule: when several offences happen in one incident, only the most serious is counted and the others are in no total ${METHOD}.`,
    categories: ['Violent crime', 'Property crime'],
  },
  {
    note: `A report police judge false or baseless is "unfounded" and is subtracted from the agency's count before it is sent; the explorer publishes no count of unfounded reports ${METHOD}.`,
    categories: [],
  },
]);
const OTHER_METHOD_NOTES = Object.freeze([
  {
    note: `"All Other Offenses" is every violation of state or local law not named in another category, traffic excepted ${METHOD}.`,
    categories: ['All Other Offenses'],
  },
]);
const TRANSITION_NOTE = `On 1 January 2021 the FBI stopped accepting the summary format; agencies not yet reporting incident by incident, the New York and Los Angeles police among them, could not report that year ${METHOD}.`;

let fbiCache = { at: 0, value: null };

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Monthly values ("MM-YYYY" -> number) summed and averaged by year. A year is
 * complete with twelve months present.
 * @returns {Map<number, {sum: number, mean: number, months: number}>}
 */
function yearlyFromMonthly(monthly) {
  const years = new Map();
  for (const [key, value] of Object.entries(monthly || {})) {
    const match = /^(\d{2})-(\d{4})$/.exec(key);
    if (!match || !finite(value)) continue;
    const year = Number(match[2]);
    const entry = years.get(year) || { sum: 0, months: 0 };
    entry.sum += value;
    entry.months += 1;
    years.set(year, entry);
  }
  for (const entry of years.values()) entry.mean = entry.sum / entry.months;
  return years;
}

const complete = (years, year) =>
  years.get(year)?.months === 12 ? years.get(year) : null;

/**
 * Check 1 (United States). What share of the population the reporting agencies
 * cover, year by year. The latest year is always given; every year under
 * COVERAGE_LOW_PCT is a finding, lowest first.
 */
function checkFbiCoverage(summary, latestYear) {
  const coverage = yearlyFromMonthly(
    summary?.tooltips?.['Percent of Population Coverage']?.['United States'],
  );
  const population = yearlyFromMonthly(
    summary?.populations?.population?.['United States'],
  );
  const participated = yearlyFromMonthly(
    summary?.populations?.participated_population?.['United States'],
  );
  const offences = yearlyFromMonthly(
    summary?.offenses?.actuals?.['United States Offenses'],
  );
  const describe = (year) => {
    const share = complete(coverage, year);
    const people = complete(population, year);
    const covered = complete(participated, year);
    const reported = complete(offences, year);
    if (!share || !people || !covered || !reported) return null;
    const notCovered = Math.max(0, Math.round(people.mean - covered.mean));
    return {
      year,
      coveragePct: round(share.mean),
      populationNotCovered: notCovered,
      violentCrimesReported: reported.sum,
      // Arithmetic on the published figures, not a count of anything.
      atTheSameRateTheRestWouldAdd:
        covered.mean > 0
          ? Math.round((reported.sum * notCovered) / covered.mean)
          : null,
    };
  };
  const all = [...coverage.keys()]
    .sort((a, b) => a - b)
    .map(describe)
    .filter(Boolean);
  const low = all.filter((item) => item.coveragePct < COVERAGE_LOW_PCT);
  const latest = all.find((item) => item.year === latestYear) || null;
  return {
    checked: all.length,
    latest,
    ...rankedFindings(low, (item) => -item.coveragePct),
  };
}

/** Check 3 (United States). Neighbouring years that count different populations. */
function coverageSwingNotes(summary) {
  const coverage = yearlyFromMonthly(
    summary?.tooltips?.['Percent of Population Coverage']?.['United States'],
  );
  const notes = [];
  for (const year of [...coverage.keys()].sort((a, b) => a - b)) {
    const now = complete(coverage, year);
    const before = complete(coverage, year - 1);
    if (!now || !before) continue;
    const swing = now.mean - before.mean;
    if (Math.abs(swing) < COVERAGE_SWING_POINTS) continue;
    notes.push({
      swing: Math.abs(swing),
      note: `${year} counts police covering ${round(now.mean)}% of the population, ${year - 1} ${round(before.mean)}%: the two years are counts of different populations and their totals cannot be compared.`,
      categories: [],
    });
  }
  return notes;
}

/** Check 3 (United States). The 2013 rape definition, as the series itself shows it. */
function definitionChangeNotes(yearlyByKey) {
  const rape = yearlyByKey.get('rape');
  const before = rape && complete(rape, 2012);
  const after = rape && complete(rape, 2013);
  const later = rape && complete(rape, 2017);
  if (!before || !after || before.sum <= 0) return [];
  const jump = (after.sum / before.sum - 1) * 100;
  if (jump < DEFINITION_JUMP_PCT) return [];
  return [
    {
      swing: jump,
      note: `In 2013 the FBI replaced its 1927 definition of rape with a broader one, adopted by agencies over several years: ${before.sum} in 2012, ${after.sum} in 2013${later ? `, ${later.sum} in 2017` : ''}. Counts before and after are not counts of the same thing ${METHOD}.`,
      categories: ['Rape'],
    },
  ];
}

/**
 * Check 2 (United States). The catch-all rows of the arrest table: their share
 * of all arrests, whether they outweigh every named offence, whether they
 * outgrow the total.
 * @param {Record<string, number>} latest Arrests by offence, latest year.
 * @param {Record<string, number>} earlier The same, OTHER_TREND_YEARS before.
 */
function checkFbiOtherArrests(latest, earlier, year) {
  const rows = Object.entries(latest || {}).filter(([, count]) =>
    finite(count),
  );
  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  const totalBefore = Object.values(earlier || {})
    .filter(finite)
    .reduce((sum, count) => sum + count, 0);
  const isOther = (name) => /\bother\b/i.test(name);
  const largestNamed = Math.max(
    0,
    ...rows.filter(([name]) => !isOther(name)).map(([, count]) => count),
  );
  const findings = [];
  let checked = 0;
  for (const [name, count] of rows) {
    if (!isOther(name) || total <= 0) continue;
    checked += 1;
    const share = (count / total) * 100;
    const reasons = [];
    if (share >= OTHER_SHARE_PCT)
      reasons.push(`${round(share)}% of all arrests`);
    const larger = count > largestNamed;
    if (larger) reasons.push('larger than every named category beside it');
    const before = earlier?.[name];
    let change = null;
    let totalChange = null;
    let shareBefore = null;
    if (finite(before) && before > 0 && totalBefore > 0) {
      change = (count / before - 1) * 100;
      totalChange = (total / totalBefore - 1) * 100;
      shareBefore = (before / totalBefore) * 100;
      if (change - totalChange >= OTHER_OUTGROWTH_POINTS) {
        reasons.push(
          `${round(shareBefore)}% of all arrests ${OTHER_TREND_YEARS} years earlier, ${round(share)}% now (it moved ${round(change)}% while all arrests moved ${round(totalChange)}%)`,
        );
      }
    }
    if (!reasons.length) continue;
    findings.push({
      category: name,
      parent: 'All arrests',
      year,
      unit: 'arrests',
      incidents: count,
      shareOfParentPct: round(share),
      changePctOverFiveYears: finite(change) ? round(change) : null,
      parentChangePctOverFiveYears: finite(totalChange)
        ? round(totalChange)
        : null,
      largerThanEveryNamedCategory: larger,
      reasons,
    });
  }
  return { checked, ...rankedFindings(findings, (item) => item.incidents) };
}

/** Check 3 (United States). A category the arrest table lists and holds nothing in. */
function emptyCategoryNotes(latest, year) {
  const rows = Object.entries(latest || {});
  return rows
    .filter(([, count]) => count === 0)
    .map(([name]) => {
      const twin = rows.find(
        ([other, count]) =>
          other !== name && other.startsWith(`${name} (`) && count > 0,
      );
      return {
        swing: 0,
        note: twin
          ? `The arrest table lists "${name}" and holds 0 arrests in it for ${year}, while "${twin[0]}" holds ${twin[1]}: the category in use is not the one the table names as current.`
          : `The arrest table lists "${name}" and holds 0 arrests in it for ${year}.`,
        categories: [name],
      };
    });
}

/**
 * Check 4 (United States). Each published annual rate (the twelve monthly
 * rates summed) against the published count over the published population of
 * the agencies that reported, and clearances against offences.
 */
function checkFbiArithmetic(summaries, year) {
  const findings = [];
  let checked = 0;
  for (const offence of FBI_OFFENCES) {
    const summary = summaries[offence.key];
    const counts = complete(
      yearlyFromMonthly(summary?.offenses?.actuals?.['United States Offenses']),
      year,
    );
    const rates = complete(
      yearlyFromMonthly(summary?.offenses?.rates?.['United States Offenses']),
      year,
    );
    const covered = complete(
      yearlyFromMonthly(
        summary?.populations?.participated_population?.['United States'],
      ),
      year,
    );
    if (counts && rates && covered && covered.mean > 0 && rates.sum > 0) {
      checked += 1;
      const implied = (counts.sum / covered.mean) * 100000;
      const off = (Math.abs(implied - rates.sum) / rates.sum) * 100;
      if (off > RATE_TOLERANCE_PCT) {
        findings.push({
          category: offence.memberNameEn,
          year,
          check: 'rate against incidents',
          publishedRate: round(rates.sum, 2),
          rateTheIncidentsImply: round(implied, 2),
          offByPct: round(off),
        });
      }
    }
    const cleared = complete(
      yearlyFromMonthly(
        summary?.offenses?.actuals?.['United States Clearances'],
      ),
      year,
    );
    if (counts && cleared) {
      checked += 1;
      if (cleared.sum > counts.sum) {
        findings.push({
          category: offence.memberNameEn,
          year,
          check: 'clearances against offences',
          note: `${cleared.sum} cleared, ${counts.sum} reported: more cases closed than were ever counted`,
          offByPct: round((cleared.sum / counts.sum - 1) * 100),
        });
      }
    }
  }
  return {
    checked,
    rateBase:
      'rates are per 100,000 of the population whose police reported, not of the whole population',
    ...rankedFindings(findings, (item) => item.offByPct ?? 0),
  };
}

/**
 * All four methods over the explorer's national figures. Pure.
 * @param {{
 *   summaries: Record<string, object>,
 *   arrests?: {latest?: Record<string, number>, earlier?: Record<string, number>, year?: number}|null,
 * }} input
 */
function buildFbiGroundTruth({ summaries, arrests = null }) {
  const violent = summaries?.['violent-crime'];
  const violentYears = yearlyFromMonthly(
    violent?.offenses?.actuals?.['United States Offenses'],
  );
  const fullYears = [...violentYears.keys()].filter((year) =>
    complete(violentYears, year),
  );
  if (!fullYears.length) return null;
  const year = Math.max(...fullYears);
  const startYear = Math.min(...fullYears);

  const yearlyByKey = new Map();
  const series = new Map();
  for (const offence of FBI_OFFENCES) {
    const years = yearlyFromMonthly(
      summaries[offence.key]?.offenses?.actuals?.['United States Offenses'],
    );
    yearlyByKey.set(offence.key, years);
    series.set(
      `${offence.memberId}.${INCIDENTS}`,
      [...years.entries()]
        .filter(([, entry]) => entry.months === 12)
        .sort((a, b) => a[0] - b[0])
        .map(([when, entry]) => ({ year: when, value: entry.sum })),
    );
  }

  const arrestYear = arrests?.year || year;
  const notes = (items) =>
    rankedFindings(
      items.map(({ swing: _swing, ...note }) => ({
        tableNoteId: null,
        ...note,
      })),
      () => 0,
    );
  const comparability = [
    ...coverageSwingNotes(violent).sort((a, b) => b.swing - a.swing),
    { swing: 0, note: TRANSITION_NOTE, categories: [] },
    ...definitionChangeNotes(yearlyByKey),
    ...emptyCategoryNotes(arrests?.latest, arrestYear),
  ];

  const checks = {
    totalsAgainstParts: checkTotalsAgainstParts(
      FBI_OFFENCES,
      series,
      INCIDENTS,
      year,
    ),
    coverage: checkFbiCoverage(violent, year),
    unfounded: {
      checked: 0,
      found: 0,
      findings: [],
      notPublished: true,
    },
    exclusionNotes: notes(EXCLUSION_METHOD_NOTES.map((note) => ({ ...note }))),
    otherCategories: arrests?.latest
      ? checkFbiOtherArrests(arrests.latest, arrests.earlier, arrestYear)
      : { checked: 0, found: 0, findings: [] },
    movedToOtherNotes: notes(OTHER_METHOD_NOTES.map((note) => ({ ...note }))),
    lateStarts: checkLateStarts(FBI_OFFENCES, series, INCIDENTS, startYear),
    comparabilityNotes: notes(comparability),
    arithmetic: checkFbiArithmetic(summaries, year),
    corrections: { found: 0, findings: [], notPublished: true },
  };
  const indicator = groundTruthIndicator(checks);
  const lowest = checks.coverage.findings[0]?.coveragePct;
  if (finite(lowest) && lowest < COVERAGE_FLAG_PCT) {
    indicator.incidentsLeftOutOfTotals = 'flagged';
    indicator.overall = 'flagged';
  }
  return {
    status: 'ready',
    country: 'United States',
    countryCode: 'US',
    source: FBI_SOURCE,
    url: FBI_URL,
    geography: 'United States',
    year,
    tableCovers: `${startYear} to ${year}`,
    categoriesInTable:
      FBI_OFFENCES.length + Object.keys(arrests?.latest || {}).length,
    indicator,
    checks,
    limits: [...GROUND_TRUTH_LIMITS],
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The explorer's route for one path: keyed through api.usa.gov when a key is set. */
function fbiUrl(pathAndQuery, env = process.env) {
  const key = String(env.DATA_GOV_API_KEY || '').trim();
  const base = String(env.FBI_CDE_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (base) return `${base}/${pathAndQuery}`;
  if (key)
    return `${FBI_KEYED_BASE}/${pathAndQuery}&API_KEY=${encodeURIComponent(key)}`;
  return `${FBI_PUBLIC_BASE}/${pathAndQuery}`;
}

async function getFbiJson(pathAndQuery) {
  const response = await fetch(fbiUrl(pathAndQuery), {
    headers: { Accept: 'application/json', 'User-Agent': 'GodsEyeView/0.1' },
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok)
    throw new Error(`FBI Crime Data Explorer returned ${response.status}`);
  return readResponseJsonCapped(response, FBI_MAX_BYTES);
}

/**
 * The evidence for the United States: twelve requests, one after another,
 * once a day.
 */
async function fetchFbiGroundTruth({ now = Date.now() } = {}) {
  if (fbiCache.value && now - fbiCache.at < FBI_TTL_MS) return fbiCache.value;
  const thisYear = new Date(now).getUTCFullYear();
  const summaries = {};
  for (const offence of FBI_OFFENCES) {
    summaries[offence.key] = await getFbiJson(
      `summarized/national/${offence.key}?from=01-${FBI_FIRST_YEAR}&to=12-${thisYear}`,
    );
    await sleep(FBI_REQUEST_GAP_MS);
  }
  const probe = buildFbiGroundTruth({ summaries });
  if (!probe)
    throw new Error('The FBI Crime Data Explorer returned no national data');
  const arrestsFor = async (year) =>
    (
      await getFbiJson(
        `arrest/national/all?from=01-${year}&to=12-${year}&type=totals`,
      )
    )?.['Offense Name'] || null;
  const arrestTotal = (rows) =>
    Object.values(rows || {}).reduce(
      (sum, count) => sum + (Number(count) || 0),
      0,
    );
  let arrests = null;
  try {
    // The arrest table can trail the offence table by a year.
    let arrestYear = probe.year;
    let latest = await arrestsFor(arrestYear);
    if (!arrestTotal(latest)) {
      arrestYear -= 1;
      await sleep(FBI_REQUEST_GAP_MS);
      latest = await arrestsFor(arrestYear);
    }
    await sleep(FBI_REQUEST_GAP_MS);
    const earlier = await arrestsFor(arrestYear - OTHER_TREND_YEARS);
    arrests = arrestTotal(latest)
      ? { latest, earlier, year: arrestYear }
      : null;
  } catch {
    // The arrest table is one check of four: without it the rest still stand.
    arrests = null;
  }
  const value = buildFbiGroundTruth({ summaries, arrests });
  fbiCache = { at: now, value };
  return value;
}

export {
  FBI_OFFENCES,
  FBI_SOURCE,
  buildFbiGroundTruth,
  checkFbiArithmetic,
  checkFbiCoverage,
  checkFbiOtherArrests,
  fbiUrl,
  fetchFbiGroundTruth,
  yearlyFromMonthly,
};
