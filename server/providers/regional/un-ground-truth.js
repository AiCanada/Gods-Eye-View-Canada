import { readResponseJsonCapped } from '../common/http.js';
import { countryCodes } from './country-codes.js';
import {
  GROUND_TRUTH_LIMITS,
  groundTruthIndicator,
  rankedFindings,
} from './statcan-ground-truth.js';

/**
 * Country Ground Truth Assessment for every country that has no adapter of its
 * own: the same four methods, read from what the country itself reported to
 * the United Nations.
 *
 * Sources, all public and keyless, one request each per country per day:
 *  - UN Statistics Division, SDG indicator 16.1.1: the police-recorded count
 *    and rate of intentional homicide the country sent to the UN Office on
 *    Drugs and Crime, by sex and year since 1990, with the country's own
 *    footnotes and the source of every figure.
 *  - SDG indicator 16.3.1: what share of the victims of assault, robbery and
 *    sexual violence told the police (national victimization surveys).
 *  - World Health Organization, Global Health Estimates: the WHO's own
 *    estimate of the homicide death rate, with its uncertainty interval. It is
 *    made separately from the police count, which makes it the independent
 *    source method 4 needs.
 *
 *  1. Incidents left out of totals: the homicide total against its parts by
 *     sex; the share of victims who never reported, and so are in no police
 *     total; the country's own notes saying what its count leaves out ("homicide
 *     does not include robbery-homicide"). No count of unfounded reports is
 *     published.
 *  2. The "other" category: this source publishes one category, so there is no
 *     "other" to check, and the report says so.
 *  3. New categories and partial data: years missing inside the series, a
 *     series that stops years ago, figures stitched from different sources,
 *     figures that are estimates, and the country's notes on comparability.
 *  4. Incorrect numbers: the population each year's count and rate imply
 *     (it cannot jump from one year to the next), and the police rate against
 *     the WHO's estimate and its uncertainty interval for the same year.
 *
 * Homicide is the one offence every country counts in a comparable way, which
 * is why the UN collects it; a country's other offences are not here. Canada
 * and the United States have their own, fuller adapters.
 */

const UN_SOURCE =
  'United Nations SDG database (UN Office on Drugs and Crime, intentional homicide) and World Health Organization estimates';
const UN_URL = 'https://unstats.un.org/sdgs/dataportal';
const SDG_BASE = 'https://unstats.un.org/SDGAPI/v1/sdg/Indicator/Data';
const WHO_BASE = 'https://ghoapi.azureedge.net/api/VIOLENCE_HOMICIDERATE';
const UN_TTL_MS = 24 * 60 * 60 * 1000;
const UN_MAX_BYTES = 4 * 1024 * 1024;
const UN_CACHE_MAX = 300;
/** The UN series begins in 1990; a country whose figures begin later started late. */
const UN_SERIES_START = 1990;

const TOTAL_GAP_MIN_PCT = 0.5;
const LOW_REPORTING_PCT = 50;
const STALE_AFTER_YEARS = 3;
const LATE_START_AFTER = 2000;
const POPULATION_JUMP_PCT = 5;
const WHO_MATCH_YEARS = 2;

const EXCLUSION_NOTE =
  /\bexclud|\bnot includ|\bdoes not include\b|\bdo not include\b|\bnot counted\b|\bwithout\b.*\bcases\b|\bno incluye\b|\bno se incluye|\bn['’]inclu|\bne comprend pas\b|\bnicht enthalten\b|\bmay not (?:add|coincide|sum)|\bno coincidir\b/i;
const COMPARABILITY_NOTE =
  /not (?:directly |strictly )?comparable|should not be compared|break in (?:the )?series|change (?:in|of) (?:definition|methodology|counting|source|law)|new (?:definition|methodology|law|penal code|criminal code)|refers? to (?:the )?(?:financial|fiscal) year|financial year|fiscal year|estimate|provisional|preliminary|revised|partial|incomplete|only (?:includes|covers)|coverage/i;

const unCache = new Map();

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** One series of one sex as [{year, value, source, nature, footnotes}], oldest first. */
function sdgSeries(rows, series, sex = 'BOTHSEX') {
  const byYear = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.series !== series || row?.dimensions?.Sex !== sex) continue;
    const year = Number(row.timePeriodStart);
    const value = Number(row.value);
    if (!Number.isFinite(year) || !Number.isFinite(value)) continue;
    byYear.set(year, {
      year,
      value,
      source: String(row.source || '').trim(),
      nature: String(row.attributes?.Nature || '').trim(),
      footnotes: (row.footnotes || [])
        .map((note) => String(note || '').trim())
        .filter(Boolean),
    });
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/** Check 1a. The homicide total against its parts by sex, latest year that has all three. */
function checkUnTotalsBySex(rows) {
  const total = sdgSeries(rows, 'VC_IHR_PSRCN', 'BOTHSEX');
  const male = new Map(
    sdgSeries(rows, 'VC_IHR_PSRCN', 'MALE').map((p) => [p.year, p.value]),
  );
  const female = new Map(
    sdgSeries(rows, 'VC_IHR_PSRCN', 'FEMALE').map((p) => [p.year, p.value]),
  );
  const findings = [];
  let checked = 0;
  for (const point of [...total].reverse()) {
    if (!male.has(point.year) || !female.has(point.year) || point.value <= 0)
      continue;
    checked += 1;
    const sum = male.get(point.year) + female.get(point.year);
    const difference = point.value - sum;
    const differencePct = (Math.abs(difference) / point.value) * 100;
    if (differencePct >= TOTAL_GAP_MIN_PCT && Math.abs(difference) >= 2) {
      findings.push({
        category: 'Victims of intentional homicide',
        year: point.year,
        reportedTotal: point.value,
        sumOfListedParts: sum,
        difference,
        differencePct: round(differencePct),
        partsListed: 2,
        partsWithoutData: 0,
        reading:
          difference > 0
            ? 'the total holds victims counted as neither male nor female'
            : 'the male and female counts add up to more than the total reports',
      });
    }
    if (checked >= 5) break;
  }
  return { checked, ...rankedFindings(findings, (item) => item.year) };
}

const REPORTING_SERIES = Object.freeze({
  VC_PRR_PHYV: 'physical assault',
  VC_PRR_SEXV: 'sexual assault',
  VC_PRR_ROBB: 'robbery',
  VC_PRR_PHY_VIO: 'physical violence',
  VC_PRR_SEX_VIO: 'sexual violence',
});

/**
 * Check 1b. The share of victims who told the police, from the country's own
 * victimization survey. The rest are in no police total.
 */
function checkUnReportingToPolice(rows) {
  const findings = [];
  let checked = 0;
  for (const [series, crime] of Object.entries(REPORTING_SERIES)) {
    const latest = sdgSeries(rows, series).at(-1);
    if (!latest) continue;
    checked += 1;
    if (latest.value >= LOW_REPORTING_PCT) continue;
    findings.push({
      crime,
      year: latest.year,
      reportedToPolicePct: round(latest.value),
      neverReportedPct: round(100 - latest.value),
    });
  }
  return {
    checked,
    published: checked > 0,
    ...rankedFindings(findings, (item) => -item.reportedToPolicePct),
  };
}

/** The country's own footnotes that match, each said once with the years it is attached to. */
function collectUnNotes(rows, pattern) {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const raw of row?.footnotes || []) {
      const note = String(raw || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!note || !pattern.test(note)) continue;
      if (!grouped.has(note)) grouped.set(note, new Set());
      grouped.get(note).add(Number(row.timePeriodStart));
    }
  }
  return [...grouped.entries()].map(([note, years]) => {
    const list = [...years].filter(Number.isFinite).sort((a, b) => a - b);
    const when =
      list.length > 1 ? `${list[0]} to ${list.at(-1)}` : String(list[0] ?? '');
    return {
      tableNoteId: null,
      note: `${note.slice(0, 600)}${when ? ` (note on the ${when} figures)` : ''}`,
      categories: ['Intentional homicide'],
      years: list.length,
    };
  });
}

/** Check 3. What is missing from, or stitched into, the homicide series. */
function unSeriesNotes(counts, thisYear) {
  const notes = [];
  if (!counts.length) return notes;
  const years = counts.map((point) => point.year);
  const missing = [];
  for (let year = years[0]; year <= years.at(-1); year++)
    if (!years.includes(year)) missing.push(year);
  if (missing.length) {
    notes.push({
      weight: missing.length + 10,
      note: `${missing.length} of the ${years.at(-1) - years[0] + 1} years from ${years[0]} to ${years.at(-1)} have no figure: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` and ${missing.length - 12} more` : ''}. A trend drawn across them is drawn across nothing.`,
    });
  }
  const behind = thisYear - 1 - years.at(-1);
  if (behind >= STALE_AFTER_YEARS) {
    notes.push({
      weight: behind + 20,
      note: `The latest figure is for ${years.at(-1)}: nothing has been published for the ${behind} years since.`,
    });
  }
  // The same source named with a different collection year is the same source.
  const kind = (source) =>
    String(source || '')
      .toLowerCase()
      .replace(/\d+/g, '')
      .replace(/as collected .*|in response to .*|\(.*?\)/g, '')
      .replace(/[^a-z]+/g, ' ')
      .trim();
  const changes = [];
  for (let i = 1; i < counts.length; i++) {
    const before = kind(counts[i - 1].source);
    const after = kind(counts[i].source);
    if (before && after && before !== after) {
      changes.push(
        `${counts[i].year} (${counts[i - 1].source.slice(0, 60)} -> ${counts[i].source.slice(0, 60)})`,
      );
    }
  }
  if (changes.length) {
    notes.push({
      weight: changes.length + 5,
      note: `The UN took these figures from different sources over the years, changing ${changes.length === 1 ? 'once' : `${changes.length} times`}: ${changes.slice(0, 4).join('; ')}${changes.length > 4 ? `; and ${changes.length - 4} more` : ''}. Figures either side of a change may not be counted the same way.`,
    });
  }
  const notCountryData = counts.filter(
    (point) => point.nature && point.nature !== 'C',
  );
  if (notCountryData.length) {
    notes.push({
      weight: notCountryData.length + 5,
      note: `${notCountryData.length} of the ${counts.length} figures are not the country's own count but estimated, modelled or adjusted ones (${[...new Set(notCountryData.map((point) => point.year))].slice(0, 10).join(', ')}).`,
    });
  }
  return notes
    .sort((a, b) => b.weight - a.weight)
    .map(({ weight: _weight, ...note }) => ({
      tableNoteId: null,
      categories: [],
      ...note,
    }));
}

/** Check 3. A series that begins well after the UN's own series does. */
function checkUnLateStart(counts) {
  if (!counts.length || counts[0].year <= LATE_START_AFTER)
    return { checked: counts.length ? 1 : 0, found: 0, findings: [] };
  const first = counts[0];
  const latest = counts.at(-1);
  return {
    checked: 1,
    found: 1,
    findings: [
      {
        category: 'Intentional homicide',
        tableStartsIn: UN_SERIES_START,
        reachesRecentLevelIn: first.year,
        incidentsTheYearBefore: null,
        incidentsThatYear: first.value,
        latestYear: latest.year,
        latestIncidents: latest.value,
      },
    ],
  };
}

/**
 * Check 4a. Every year's count and rate imply a population (count / rate). A
 * population does not move POPULATION_JUMP_PCT in a year: where the implied one
 * does, that year's count and rate do not belong together.
 */
function checkUnArithmetic(counts, rates) {
  const rateByYear = new Map(rates.map((point) => [point.year, point.value]));
  const implied = counts
    .filter((point) => point.value >= 50 && rateByYear.get(point.year) > 0)
    .map((point) => ({
      year: point.year,
      count: point.value,
      rate: rateByYear.get(point.year),
      population: (point.value / rateByYear.get(point.year)) * 100000,
    }));
  const findings = [];
  let checked = 0;
  for (let i = 1; i < implied.length; i++) {
    const now = implied[i];
    const before = implied[i - 1];
    if (now.year - before.year !== 1) continue;
    checked += 1;
    const jump = (now.population / before.population - 1) * 100;
    // A rate published to one decimal cannot pin the population of a small count.
    const rounding = (0.05 / now.rate + 0.05 / before.rate) * 100;
    if (Math.abs(jump) <= POPULATION_JUMP_PCT + rounding) continue;
    findings.push({
      category: 'Intentional homicide',
      year: now.year,
      check: 'rate against count',
      note: `${now.count} victims at ${now.rate} per 100,000 implies ${Math.round(now.population / 1000) * 1000} people; ${before.year}'s figures imply ${Math.round(before.population / 1000) * 1000}: a ${round(Math.abs(jump))}% ${jump > 0 ? 'rise' : 'fall'} in population in one year, so that year's count and rate do not belong together`,
      offByPct: round(Math.abs(jump)),
    });
  }
  return { checked, ...rankedFindings(findings, (item) => item.offByPct) };
}

/**
 * Check 4b. The police-recorded rate against the WHO's estimate from death
 * registration and health statistics, for the same year or the nearest within
 * WHO_MATCH_YEARS. Outside the WHO's own uncertainty interval is a finding.
 */
function checkUnAgainstWho(rates, whoRows) {
  const who = (Array.isArray(whoRows) ? whoRows : [])
    .filter((row) => row?.Dim1 === 'SEX_BTSX' && finite(row.NumericValue))
    .sort((a, b) => b.TimeDim - a.TimeDim);
  if (!who.length || !rates.length)
    return { checked: 0, found: 0, findings: [], compared: null };
  let best = null;
  for (const estimate of who) {
    for (const point of rates) {
      const apart = Math.abs(point.year - estimate.TimeDim);
      if (apart > WHO_MATCH_YEARS) continue;
      if (
        !best ||
        apart < best.apart ||
        (apart === best.apart && estimate.TimeDim > best.estimate.TimeDim)
      )
        best = { estimate, point, apart };
    }
    if (best?.apart === 0) break;
  }
  if (!best) return { checked: 0, found: 0, findings: [], compared: null };
  const { estimate, point } = best;
  const low = finite(estimate.Low) ? estimate.Low : estimate.NumericValue;
  const high = finite(estimate.High) ? estimate.High : estimate.NumericValue;
  const position =
    point.value < low ? 'below' : point.value > high ? 'above' : 'inside';
  const compared = {
    policeYear: point.year,
    policeRate: point.value,
    whoYear: estimate.TimeDim,
    whoRate: round(estimate.NumericValue, 2),
    whoLow: round(low, 2),
    whoHigh: round(high, 2),
    position,
  };
  const findings =
    position === 'inside'
      ? []
      : [
          {
            category: 'Intentional homicide',
            year: point.year,
            check: 'police figure against the health-statistics estimate',
            note: `police recorded ${point.value} homicides per 100,000 in ${point.year}; the World Health Organization's own estimate of homicide deaths is ${compared.whoRate} (between ${compared.whoLow} and ${compared.whoHigh}) for ${estimate.TimeDim}: the police figure is ${position} the whole interval${position === 'below' ? `: the WHO estimate is ${round(estimate.NumericValue / point.value, 2)} times the police figure` : ''}`,
            offByPct: round(
              (Math.abs(point.value - estimate.NumericValue) /
                estimate.NumericValue) *
                100,
            ),
          },
        ];
  return { checked: 1, found: findings.length, findings, compared };
}

/**
 * All four methods over what one country reported to the UN. Pure.
 * @param {{country: {iso2: string, name: string}, homicide: object[], reporting?: object[], who?: object[], thisYear: number}} input
 */
function buildUnGroundTruth({
  country,
  homicide,
  reporting = [],
  who = [],
  thisYear,
}) {
  const counts = sdgSeries(homicide, 'VC_IHR_PSRCN');
  const rates = sdgSeries(homicide, 'VC_IHR_PSRC');
  if (!counts.length && !rates.length) {
    return {
      status: 'nodata',
      country: country.name,
      countryCode: country.iso2,
      source: UN_SOURCE,
      reason: `The United Nations database holds no police-recorded homicide figure that ${country.name} has reported.`,
    };
  }
  const series = counts.length ? counts : rates;
  const year = series.at(-1).year;
  const notes = (items) => rankedFindings(items, (item) => item.years || 0);
  const arithmetic = checkUnArithmetic(counts, rates);
  const againstWho = checkUnAgainstWho(rates, who);
  const comparability = [
    ...unSeriesNotes(series, thisYear),
    ...collectUnNotes(homicide, COMPARABILITY_NOTE).filter(
      (note) => !EXCLUSION_NOTE.test(note.note),
    ),
  ];
  const checks = {
    totalsAgainstParts: checkUnTotalsBySex(homicide),
    reportingToPolice: checkUnReportingToPolice(reporting),
    unfounded: { checked: 0, found: 0, findings: [], notPublished: true },
    exclusionNotes: notes(collectUnNotes(homicide, EXCLUSION_NOTE)),
    otherCategories: {
      checked: 0,
      found: 0,
      findings: [],
      notPublished: true,
      reason:
        'this source publishes one category (intentional homicide) and no "other"',
    },
    movedToOtherNotes: { found: 0, findings: [] },
    lateStarts: checkUnLateStart(series),
    comparabilityNotes: {
      found: comparability.length,
      findings: comparability,
    },
    arithmetic: {
      checked: arithmetic.checked + againstWho.checked,
      found: arithmetic.found + againstWho.found,
      findings: [...againstWho.findings, ...arithmetic.findings],
      independentSource: againstWho.compared,
    },
    corrections: { found: 0, findings: [], notPublished: true },
  };
  const indicator = groundTruthIndicator(checks);
  if (checks.reportingToPolice.found)
    indicator.incidentsLeftOutOfTotals = 'flagged';
  if (checks.arithmetic.found) indicator.incorrectNumbers = 'flagged';
  if (checks.reportingToPolice.found || checks.arithmetic.found)
    indicator.overall = 'flagged';
  return {
    status: 'ready',
    country: country.name,
    countryCode: country.iso2,
    source: UN_SOURCE,
    url: UN_URL,
    geography: country.name,
    year,
    tableCovers: `${series[0].year} to ${year}`,
    categoriesInTable: 1,
    scope:
      'Intentional homicide only: it is the one offence every country counts in a comparable way, and the one the United Nations collects from all of them.',
    indicator,
    checks,
    limits: [...GROUND_TRUTH_LIMITS],
    // For an adapter that lays another publisher's figures beside these
    // (Eurostat); never sent to the model.
    homicideCounts: counts.map(({ year: when, value }) => ({
      year: when,
      value,
    })),
  };
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'GodsEyeView/0.1' },
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok)
    throw new Error(`${new URL(url).hostname} returned ${response.status}`);
  return readResponseJsonCapped(response, UN_MAX_BYTES);
}

/**
 * The evidence for one country, read once a day. The homicide series is the
 * assessment; the reporting survey and the WHO estimate are each one check, and
 * the rest still stand without them.
 * @param {string} iso2
 */
async function fetchUnGroundTruth(iso2, { now = Date.now() } = {}) {
  const country = countryCodes(iso2);
  if (!country) return null;
  const cached = unCache.get(country.iso2);
  if (cached && now - cached.at < UN_TTL_MS) return cached.value;
  const optional = (promise) => promise.catch(() => null);
  const [homicide, reporting, who] = await Promise.all([
    getJson(
      `${SDG_BASE}?indicator=16.1.1&areaCode=${country.m49}&pageSize=3000`,
    ),
    optional(
      getJson(
        `${SDG_BASE}?indicator=16.3.1&areaCode=${country.m49}&pageSize=3000`,
      ),
    ),
    optional(
      getJson(
        `${WHO_BASE}?$filter=${encodeURIComponent(`SpatialDim eq '${country.iso3}' and Dim1 eq 'SEX_BTSX'`)}`,
      ),
    ),
  ]);
  const value = buildUnGroundTruth({
    country,
    homicide: homicide?.data || [],
    reporting: reporting?.data || [],
    who: who?.value || [],
    thisYear: new Date(now).getUTCFullYear(),
  });
  if (unCache.size >= UN_CACHE_MAX) unCache.delete(unCache.keys().next().value);
  unCache.set(country.iso2, { at: now, value });
  return value;
}

export {
  UN_SOURCE,
  buildUnGroundTruth,
  checkUnAgainstWho,
  checkUnArithmetic,
  checkUnReportingToPolice,
  checkUnTotalsBySex,
  collectUnNotes,
  fetchUnGroundTruth,
  sdgSeries,
  unSeriesNotes,
};
