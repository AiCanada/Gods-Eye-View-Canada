import { readResponseJsonCapped } from '../common/http.js';
import { countryCodes } from './country-codes.js';
import {
  GROUND_TRUTH_LIMITS,
  groundTruthIndicator,
  rankedFindings,
} from './statcan-ground-truth.js';
import { fetchUnGroundTruth } from './un-ground-truth.js';

/**
 * Country Ground Truth Assessment for the European countries: Eurostat's table
 * of police-recorded offences by category (crim_off_cat: 25 categories of the
 * International Classification of Crime, counts and rates, yearly since 2008),
 * laid over what the same country reported to the United Nations and the World
 * Health Organization's estimate (un-ground-truth.js). One more keyless request
 * per country per day.
 *
 *  1. Incidents left out of totals: a category against the parts Eurostat lists
 *     under it (sexual violence is rape plus sexual assault; a part can never
 *     exceed its whole), with the UN checks beside it (the homicide total by
 *     sex, the share of victims who told the police, the country's own notes).
 *  2. The "other" category: the table has 25 named categories and no "other",
 *     and the report says so.
 *  3. New categories and partial data: categories that begin years after the
 *     table does, categories whose figures stop, categories with no figure at
 *     all, years missing inside a series, and a count that moves by two fifths
 *     or more in one year.
 *  4. Incorrect numbers: every category's rate implies a population, which is
 *     the same whatever the crime; the homicide count sent to Eurostat against
 *     the one sent to the UN for the same year; and the police homicide rate
 *     against the WHO's estimate.
 *
 * The United Kingdom is read from the UN instead: Eurostat lists England and
 * Wales, Scotland and Northern Ireland separately and stops in 2018.
 */

const EUROSTAT_SOURCE =
  'Eurostat, police-recorded offences by category (crim_off_cat), with United Nations and World Health Organization figures';
const EUROSTAT_URL =
  'https://ec.europa.eu/eurostat/databrowser/view/crim_off_cat/default/table';
const EUROSTAT_BASE =
  'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/crim_off_cat';
const EUROSTAT_TTL_MS = 24 * 60 * 60 * 1000;
const EUROSTAT_MAX_BYTES = 2 * 1024 * 1024;

/** ISO alpha-2 -> Eurostat geo code, for the countries the table holds. */
const EUROSTAT_GEO = Object.freeze(
  Object.fromEntries(
    [
      'BE',
      'BG',
      'CZ',
      'DK',
      'DE',
      'EE',
      'IE',
      'ES',
      'FR',
      'HR',
      'IT',
      'CY',
      'LV',
      'LT',
      'LU',
      'HU',
      'MT',
      'NL',
      'AT',
      'PL',
      'PT',
      'RO',
      'SI',
      'SK',
      'FI',
      'SE',
      'IS',
      'LI',
      'NO',
      'CH',
      'BA',
      'ME',
      'MK',
      'AL',
      'RS',
      'TR',
      'XK',
    ]
      .map((code) => [code, code])
      // Eurostat writes Greece as EL.
      .concat([['GR', 'EL']]),
  ),
);

/** Names Eurostat uses for the places the UN's table does not list. */
const EUROSTAT_ONLY_NAMES = Object.freeze({ XK: 'Kosovo' });

/**
 * Parts Eurostat lists under a category. `whole: true` means the parts are the
 * whole of it (their sum is the total); otherwise a part is only one piece, and
 * the one thing it cannot do is exceed its parent.
 */
const EUROSTAT_PARTS = Object.freeze([
  { parent: 'ICCS0301', parts: ['ICCS03011', 'ICCS03012'], whole: true },
  { parent: 'ICCS0302', parts: ['ICCS030221'], whole: false },
  { parent: 'ICCS0501', parts: ['ICCS05012'], whole: false },
  { parent: 'ICCS0502', parts: ['ICCS05021'], whole: false },
  { parent: 'ICCS0703', parts: ['ICCS07031'], whole: false },
]);

const TOTAL_GAP_MIN_PCT = 0.5;
const MIN_COUNT = 200;
const JUMP_PCT = 40;
const ARITHMETIC_MIN_COUNT = 2000;
const ARITHMETIC_MIN_RATE = 5;
const ARITHMETIC_TOLERANCE_PCT = 2;
const CROSS_SOURCE_TOLERANCE_PCT = 2;

const eurostatCache = new Map();

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * A JSON-stat answer for one country as category -> {name, counts, rates},
 * each a Map of year -> value. Values the table does not hold are absent.
 */
function parseEurostatTable(table) {
  const ids = Array.isArray(table?.id) ? table.id : [];
  const size = Array.isArray(table?.size) ? table.size : [];
  const codes = ids.map((id) =>
    Object.entries(table.dimension?.[id]?.category?.index || {})
      .sort((a, b) => a[1] - b[1])
      .map(([code]) => code),
  );
  const strides = size.map((_, i) =>
    size.slice(i + 1).reduce((a, b) => a * b, 1),
  );
  const at = (name) => ids.indexOf(name);
  const labels = table?.dimension?.iccs?.category?.label || {};
  const categories = new Map();
  for (const [key, raw] of Object.entries(table?.value || {})) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    let rest = Number(key);
    const position = strides.map((stride) => {
      const index = Math.floor(rest / stride);
      rest %= stride;
      return index;
    });
    const code = codes[at('iccs')]?.[position[at('iccs')]];
    const unit = codes[at('unit')]?.[position[at('unit')]];
    const year = Number(codes[at('time')]?.[position[at('time')]]);
    if (!code || !Number.isFinite(year)) continue;
    if (!categories.has(code)) {
      categories.set(code, {
        code,
        name: labels[code] || code,
        counts: new Map(),
        rates: new Map(),
      });
    }
    if (unit === 'NR') categories.get(code).counts.set(year, value);
    else if (unit === 'P_HTHAB') categories.get(code).rates.set(year, value);
  }
  const listed = codes[at('iccs')] || [];
  const years = (codes[at('time')] || []).map(Number).filter(Number.isFinite);
  return { categories, listed, labels, years };
}

/** Check 1. A category against the parts listed under it. */
function checkEurostatParts(categories, year) {
  const findings = [];
  let checked = 0;
  for (const { parent, parts, whole } of EUROSTAT_PARTS) {
    const total = categories.get(parent)?.counts.get(year);
    const values = parts.map((code) => categories.get(code)?.counts.get(year));
    if (!finite(total) || total <= 0 || !values.every(finite)) continue;
    checked += 1;
    const sum = values.reduce((a, b) => a + b, 0);
    const difference = total - sum;
    const differencePct = (Math.abs(difference) / total) * 100;
    const broken = whole ? differencePct >= TOTAL_GAP_MIN_PCT : difference < 0;
    if (!broken) continue;
    findings.push({
      category: categories.get(parent).name,
      year,
      reportedTotal: total,
      sumOfListedParts: sum,
      difference,
      differencePct: round(differencePct),
      partsListed: parts.length,
      partsWithoutData: 0,
      reading:
        difference > 0
          ? 'the total holds offences that appear in none of its listed parts'
          : 'the listed parts add up to more than the total reports',
    });
  }
  return {
    checked,
    ...rankedFindings(findings, (item) => Math.abs(item.difference)),
  };
}

/** Check 3a. Categories that begin after the table does. */
function checkEurostatLateStarts(categories, tableStart) {
  const findings = [];
  let checked = 0;
  for (const category of categories.values()) {
    const years = [...category.counts.keys()].sort((a, b) => a - b);
    if (!years.length) continue;
    checked += 1;
    if (years[0] <= tableStart + 1) continue;
    const latestYear = years.at(-1);
    findings.push({
      category: category.name,
      tableStartsIn: tableStart,
      reachesRecentLevelIn: years[0],
      incidentsTheYearBefore: null,
      incidentsThatYear: category.counts.get(years[0]),
      latestYear,
      latestIncidents: category.counts.get(latestYear),
    });
  }
  return {
    checked,
    ...rankedFindings(findings, (item) => item.latestIncidents),
  };
}

/** Check 3b. What is missing from the table, and counts that move too far in a year. */
function eurostatSeriesNotes(parsed, year) {
  const { categories, listed, labels } = parsed;
  const notes = [];
  const absent = listed.filter((code) => !categories.get(code)?.counts.size);
  if (absent.length) {
    notes.push({
      weight: 1000 + absent.length,
      note: `${absent.length} of the table's ${listed.length} categories hold no figure at all for this country: ${absent
        .map((code) => labels[code] || code)
        .slice(0, 8)
        .join(
          '; ',
        )}${absent.length > 8 ? `; and ${absent.length - 8} more` : ''}.`,
      categories: [],
    });
  }
  for (const category of categories.values()) {
    const years = [...category.counts.keys()].sort((a, b) => a - b);
    if (!years.length) continue;
    const last = years.at(-1);
    if (last < year - 1) {
      notes.push({
        weight: 500 + (year - last),
        note: `The figures stop in ${last} (${category.counts.get(last)} that year): nothing has been published for the ${year - last} years since.`,
        categories: [category.name],
      });
    }
    const missing = [];
    for (let y = years[0]; y <= last; y++)
      if (!category.counts.has(y)) missing.push(y);
    if (missing.length) {
      notes.push({
        weight: 300 + missing.length,
        note: `${missing.length} of the years from ${years[0]} to ${last} have no figure: ${missing.slice(0, 10).join(', ')}.`,
        categories: [category.name],
      });
    }
    // A category that lurches every year says it once: its largest move, and
    // how many others there were.
    const jumps = [];
    for (let i = 1; i < years.length; i++) {
      if (years[i] - years[i - 1] !== 1) continue;
      const before = category.counts.get(years[i - 1]);
      const now = category.counts.get(years[i]);
      if (!(before >= MIN_COUNT) || !(now >= MIN_COUNT)) continue;
      const change = (now / before - 1) * 100;
      if (Math.abs(change) < JUMP_PCT) continue;
      jumps.push({ before, now, change, from: years[i - 1], to: years[i] });
    }
    if (jumps.length) {
      const largest = jumps.reduce((a, b) =>
        Math.abs(b.change) > Math.abs(a.change) ? b : a,
      );
      const others = jumps.length - 1;
      notes.push({
        weight: Math.min(299, Math.abs(largest.change)),
        note: `${largest.before} in ${largest.from}, ${largest.now} in ${largest.to}: ${largest.change > 0 ? 'up' : 'down'} ${round(Math.abs(largest.change))}% in one year${others ? `, and ${others} other ${others === 1 ? 'year' : 'years'} moved by ${JUMP_PCT}% or more` : ''}. Figures either side of a move this size may not be counted the same way.`,
        categories: [category.name],
      });
    }
  }
  return notes
    .sort((a, b) => b.weight - a.weight)
    .map(({ weight: _weight, ...note }) => ({ tableNoteId: null, ...note }));
}

/**
 * Check 4a. Every category's count and rate imply a population; in one year and
 * one country it is the same whatever the crime.
 */
function checkEurostatArithmetic(categories, year) {
  const usable = [...categories.values()]
    .map((category) => ({
      category,
      count: category.counts.get(year),
      rate: category.rates.get(year),
    }))
    .filter(
      (item) =>
        item.count >= ARITHMETIC_MIN_COUNT && item.rate >= ARITHMETIC_MIN_RATE,
    );
  if (usable.length < 2)
    return { checked: 0, found: 0, findings: [], impliedPopulation: null };
  const reference = usable.reduce((a, b) => (b.count > a.count ? b : a));
  const population = (reference.count / reference.rate) * 100000;
  const findings = [];
  let checked = 0;
  for (const item of usable) {
    if (item === reference) continue;
    checked += 1;
    const implied = (item.count / item.rate) * 100000;
    const off = (Math.abs(implied - population) / population) * 100;
    if (off <= ARITHMETIC_TOLERANCE_PCT) continue;
    findings.push({
      category: item.category.name,
      year,
      check: 'rate against incidents',
      publishedRate: item.rate,
      rateTheIncidentsImply: round((item.count / population) * 100000, 2),
      offByPct: round(off),
    });
  }
  return {
    checked,
    impliedPopulation: Math.round(population),
    ...rankedFindings(findings, (item) => item.offByPct),
  };
}

/** Check 4b. The homicide count sent to Eurostat against the one sent to the UN. */
function checkEurostatAgainstUn(categories, unHomicide) {
  const eurostat = categories.get('ICCS0101')?.counts;
  if (!eurostat?.size || !Array.isArray(unHomicide) || !unHomicide.length) {
    return { checked: 0, found: 0, findings: [] };
  }
  const apart = [];
  let checked = 0;
  for (const point of [...unHomicide].sort((a, b) => b.year - a.year)) {
    const here = eurostat.get(point.year);
    if (!finite(here) || !(point.value > 0)) continue;
    checked += 1;
    const off = (Math.abs(here - point.value) / point.value) * 100;
    if (off > CROSS_SOURCE_TOLERANCE_PCT && Math.abs(here - point.value) >= 5) {
      apart.push({ year: point.year, here, there: point.value, off });
    }
    if (checked >= 5) break;
  }
  if (!apart.length) return { checked, found: 0, findings: [] };
  // Said once, for the latest year: a country whose two figures differ every
  // year is one finding, not five. It is a fact about the two publications, not
  // proof that either is wrong: the two may not define or count a homicide the
  // same way (offences against victims, attempts, deaths in custody).
  const [latest] = apart;
  const others = apart.length - 1;
  return {
    checked,
    found: 1,
    findings: [
      {
        category: 'Intentional homicide',
        year: latest.year,
        check: 'one country, two publishers',
        note: `${latest.here} in Eurostat's table, ${latest.there} in the United Nations series for the same country and year: ${round(latest.off)}% apart${others ? `, and apart in ${others} of the ${checked - 1} years before it too` : ''}. The two publishers may not define or count a homicide the same way`,
        offByPct: round(latest.off),
      },
    ],
  };
}

const emptyCheck = () => ({ checked: 0, found: 0, findings: [] });

/**
 * All four methods. Pure: the Eurostat answer and the country's UN evidence
 * (null for a place the UN does not list) in, evidence out.
 * @param {{country: {iso2: string, name: string}, table: object, un?: object|null, unHomicide?: Array<{year: number, value: number}>}} input
 */
function buildEurostatGroundTruth({
  country,
  table,
  un = null,
  unHomicide = [],
}) {
  const parsed = parseEurostatTable(table);
  const { categories, listed, years: tableYears } = parsed;
  const withCounts = [...categories.values()].filter(
    (category) => category.counts.size,
  );
  if (!withCounts.length) return null;
  // The latest year most categories have a figure for.
  const held = new Map();
  for (const category of withCounts)
    for (const y of category.counts.keys()) held.set(y, (held.get(y) || 0) + 1);
  const most = Math.max(...held.values());
  const year = Math.max(
    ...[...held.entries()].filter(([, n]) => n >= most / 2).map(([y]) => y),
  );
  const tableStart = tableYears.length
    ? Math.min(...tableYears)
    : Math.min(...held.keys());
  const unChecks = un?.status === 'ready' ? un.checks : null;

  const parts = checkEurostatParts(categories, year);
  const bySex = unChecks?.totalsAgainstParts || emptyCheck();
  const ownArithmetic = checkEurostatArithmetic(categories, year);
  const crossSource = checkEurostatAgainstUn(categories, unHomicide);
  const unArithmetic = unChecks?.arithmetic || emptyCheck();
  const seriesNotes = eurostatSeriesNotes(parsed, year);
  const unNotes = unChecks?.comparabilityNotes?.findings || [];

  const checks = {
    totalsAgainstParts: {
      checked: parts.checked + bySex.checked,
      found: parts.found + bySex.found,
      findings: [...parts.findings, ...bySex.findings],
    },
    reportingToPolice: unChecks?.reportingToPolice || {
      ...emptyCheck(),
      published: false,
    },
    unfounded: { ...emptyCheck(), notPublished: true },
    exclusionNotes: unChecks?.exclusionNotes || { found: 0, findings: [] },
    otherCategories: {
      ...emptyCheck(),
      notPublished: true,
      reason: `this table has ${listed.length} named categories and no "other"`,
    },
    movedToOtherNotes: { found: 0, findings: [] },
    lateStarts: checkEurostatLateStarts(categories, tableStart),
    comparabilityNotes: {
      found: seriesNotes.length + unNotes.length,
      findings: [...seriesNotes, ...unNotes],
    },
    arithmetic: {
      checked:
        ownArithmetic.checked + crossSource.checked + unArithmetic.checked,
      found: ownArithmetic.found + crossSource.found + unArithmetic.found,
      findings: [
        ...crossSource.findings,
        ...(unArithmetic.findings || []),
        ...ownArithmetic.findings,
      ],
      independentSource: unArithmetic.independentSource || null,
      impliedPopulation: ownArithmetic.impliedPopulation,
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
    source: EUROSTAT_SOURCE,
    url: EUROSTAT_URL,
    geography: country.name,
    year,
    tableCovers: `${tableStart} to ${year}`,
    categoriesInTable: listed.length,
    scope: `${withCounts.length} of Eurostat's ${listed.length} offence categories hold figures for ${country.name}. ${unChecks ? 'The victim-reporting, country-note and World Health Organization checks are read from what the country reported to the United Nations.' : 'The United Nations does not list this place, so there is no victim-reporting survey, country note or World Health Organization estimate to set beside them.'}`,
    indicator,
    checks,
    limits: [...GROUND_TRUTH_LIMITS],
  };
}

/** Whether Eurostat's table holds this country. */
const inEurostat = (iso2) =>
  Object.hasOwn(EUROSTAT_GEO, String(iso2 || '').toUpperCase());

/**
 * The evidence for one European country, read once a day. Without Eurostat's
 * answer the country is still assessed from the UN, as every other country is.
 * @param {string} iso2
 */
async function fetchEurostatGroundTruth(iso2, { now = Date.now() } = {}) {
  const code = String(iso2 || '')
    .trim()
    .toUpperCase();
  if (!inEurostat(code)) return null;
  const cached = eurostatCache.get(code);
  if (cached && now - cached.at < EUROSTAT_TTL_MS) return cached.value;
  const known = countryCodes(code);
  const country =
    known ||
    (EUROSTAT_ONLY_NAMES[code]
      ? { iso2: code, name: EUROSTAT_ONLY_NAMES[code] }
      : null);
  if (!country) return null;
  const un = known
    ? await fetchUnGroundTruth(code, { now }).catch(() => null)
    : null;
  let table = null;
  try {
    const response = await fetch(
      `${EUROSTAT_BASE}?format=JSON&lang=EN&geo=${EUROSTAT_GEO[code]}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'GodsEyeView/0.1',
        },
        signal: AbortSignal.timeout(45000),
      },
    );
    if (response.ok)
      table = await readResponseJsonCapped(response, EUROSTAT_MAX_BYTES);
  } catch {
    table = null;
  }
  const value =
    (table &&
      buildEurostatGroundTruth({
        country,
        table,
        un,
        unHomicide: un?.homicideCounts || [],
      })) ||
    un;
  if (value) eurostatCache.set(code, { at: now, value });
  return value;
}

export {
  EUROSTAT_GEO,
  EUROSTAT_SOURCE,
  buildEurostatGroundTruth,
  checkEurostatAgainstUn,
  checkEurostatArithmetic,
  checkEurostatLateStarts,
  checkEurostatParts,
  eurostatSeriesNotes,
  fetchEurostatGroundTruth,
  inEurostat,
  parseEurostatTable,
};
