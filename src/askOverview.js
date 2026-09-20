/**
 * Ask-panel prompts: Overview (what is on screen and why) and Risk Assessment
 * (on-screen activity plus extra sources when they correlate). Pure — no DOM,
 * no network.
 */

export const RISK_NEWS_RADIUS_KM = 100;
export const RISK_NEWS_LOOKBACK_DAYS = 30;
export const RISK_NEWS_TOPICS = Object.freeze([
  'danger',
  'crime',
  'violence',
  'protest',
  'unrest',
]);

const CANADA_SOURCES = Object.freeze([
  {
    name: 'Canada Crime Report — Crime Severity Index',
    url: 'https://canadacrimereport.com/crime-severity-index',
  },
  {
    name: 'Statistics Canada table 35-10-0177-01',
    url: 'https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=3510017701',
  },
  {
    name: 'Al Jazeera',
    url: 'https://www.aljazeera.com/',
  },
]);

const USA_SOURCES = Object.freeze([
  {
    name: 'USA.gov crime statistics',
    url: 'https://www.usa.gov/crime-statistics',
  },
  {
    name: 'Al Jazeera',
    url: 'https://www.aljazeera.com/',
  },
]);

const INTERNATIONAL_SOURCES = Object.freeze([
  {
    name: 'Al Jazeera',
    url: 'https://www.aljazeera.com/',
  },
]);

const CANADA_LABEL = /\bcanada\b|\bcanadian\b/;
const USA_LABEL =
  /\bunited states\b|\bu\.s\.a\.?\b|\bu\.s\.\b|\busa\b|\bamerica\b/;

/**
 * Classify the selected view as Canada, the United States, or international.
 * Country codes and place labels win; coordinates are a last resort.
 *
 * @param {{
 *   country?: string|null,
 *   countryCode?: string|null,
 *   placeLabels?: string[],
 *   selectedLocation?: string|null,
 *   latitude?: number,
 *   longitude?: number,
 * }} input
 * @returns {'canada'|'usa'|'international'}
 */
export function classifyOverviewRegion(input = {}) {
  const code = String(input.countryCode || '')
    .trim()
    .toUpperCase();
  if (code === 'CA') return 'canada';
  if (code === 'US') return 'usa';

  const text = [
    input.country,
    input.selectedLocation,
    ...(Array.isArray(input.placeLabels) ? input.placeLabels : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const canada = CANADA_LABEL.test(text);
  const usa = USA_LABEL.test(text) || /\bcalifornia\b/.test(text);
  if (canada && !usa) return 'canada';
  if (usa && !canada) return 'usa';

  return regionFromCoordinates(input.latitude, input.longitude);
}

function regionFromCoordinates(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'international';
  if (lat >= 18.91 && lat <= 22.24 && lon >= -160.3 && lon <= -154.8)
    return 'usa';
  if (lat >= 51.2 && lat <= 71.5 && lon >= -168 && lon <= -130) return 'usa';
  if (lat >= 49 && lat <= 83 && lon >= -141 && lon <= -52) return 'canada';
  if (lat >= 45 && lat <= 49 && lon >= -80 && lon <= -64) return 'canada';
  if (lat >= 43.5 && lat <= 48 && lon >= -67.2 && lon <= -59.7) return 'canada';
  if (lat >= 24.5 && lat <= 49.4 && lon >= -124.8 && lon <= -66.9) return 'usa';
  return 'international';
}

/**
 * The country of the view, from evidence rather than from latitude bands.
 * Toronto, Hamilton, London, Windsor and Niagara all lie south of the 45th
 * parallel, inside the box that otherwise reads "United States", so a selected
 * location named only "Toronto" was classified as the USA: Risk Assessment
 * searched US sources for it and Country Ground Truth found no table.
 *
 * The reverse geocoder's answer wins. When it has none (offline, rate limited,
 * open water), a nearest city from the built-in Canadian gazetteer says
 * Canada. Otherwise null, and the caller falls back to labels and coordinates.
 *
 * @param {{
 *   place?: {countryCode?: string|null, country?: string|null}|null,
 *   closestCity?: {name?: string, source?: string}|null,
 * }} input
 * @returns {{countryCode: string, country: string|null}|null}
 */
export function resolveOverviewCountry(input = {}) {
  const code = String(input.place?.countryCode || '')
    .trim()
    .toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) {
    const name = String(input.place?.country || '').trim();
    return { countryCode: code, country: name ? name : null };
  }
  if (input.closestCity?.source === 'gazetteer')
    return { countryCode: 'CA', country: 'Canada' };
  return null;
}

/** Official sources the risk paragraph must review for a region. */
export function overviewRiskSources(region) {
  if (region === 'canada') return CANADA_SOURCES;
  if (region === 'usa') return USA_SOURCES;
  return INTERNATIONAL_SOURCES;
}

function cleanLocationName(value) {
  return String(value || '')
    .replace(/^📍\s*/u, '')
    .replace(/^location:\s*/i, '')
    .replace(/^landmark:\s*/i, '')
    .trim();
}

function isBlankLocation(value) {
  const text = cleanLocationName(value);
  return !text || text === '--' || /^searched location$/i.test(text);
}

/**
 * Human-readable name for the selected place.
 * @param {{selectedLocation?: string|null, placeLabels?: string[], latitude?: number, longitude?: number}} input
 * @returns {string}
 */
export function overviewLocationName(input = {}) {
  const selected = cleanLocationName(input.selectedLocation);
  if (!isBlankLocation(selected)) return selected;
  const labels = Array.isArray(input.placeLabels) ? input.placeLabels : [];
  const named = labels
    .map(cleanLocationName)
    .find((label) => !isBlankLocation(label));
  if (named) return named;
  const lat = Number(input.latitude);
  const lon = Number(input.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  }
  return 'the current view';
}

function newsQueryFor(locationName) {
  const place = String(locationName || '')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const topics = RISK_NEWS_TOPICS.join(' OR ');
  return place ? `"${place}" (${topics})` : `(${topics})`;
}

function cityFromLabel(value) {
  const cleaned = cleanLocationName(value)
    .replace(/\s+danger zone\s*$/i, '')
    .replace(/\s+dz\s*$/i, '')
    .trim();
  if (isBlankLocation(cleaned) || /^-?\d+(\.\d+)?,\s*-?\d+/.test(cleaned)) {
    return '';
  }
  if (!cleaned.includes(',')) return cleaned;
  const parts = cleaned
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

/**
 * City name used for crime-stat search. Closest city / locality wins over a
 * POI or Danger Zone label.
 * @param {{
 *   closestCity?: string|null,
 *   locality?: string|null,
 *   selectedCity?: string|null,
 *   selectedLocation?: string|null,
 * }} input
 * @returns {string}
 */
export function crimeSearchCityName(input = {}) {
  for (const value of [
    input.closestCity,
    input.locality,
    input.selectedCity,
    input.selectedLocation,
  ]) {
    const city = cityFromLabel(value);
    if (city) return city;
  }
  return '';
}

/**
 * Structured risk brief attached to SCENE JSON and used to write the question.
 * @param {{
 *   selectedLocation?: string|null,
 *   selectedCity?: string|null,
 *   closestCity?: string|null,
 *   locality?: string|null,
 *   placeLabels?: string[],
 *   country?: string|null,
 *   countryCode?: string|null,
 *   view?: {latitude?: number, longitude?: number}|null,
 * }} input
 */
export function buildOverviewRiskBrief(input = {}) {
  const latitude = Number(input.view?.latitude);
  const longitude = Number(input.view?.longitude);
  const locationName = overviewLocationName({
    selectedLocation: input.selectedLocation,
    placeLabels: input.placeLabels,
    latitude,
    longitude,
  });
  const searchCity =
    crimeSearchCityName({
      closestCity: input.closestCity,
      locality: input.locality,
      selectedCity: input.selectedCity,
      selectedLocation: input.selectedLocation,
    }) || locationName;
  const region = classifyOverviewRegion({
    country: input.country,
    countryCode: input.countryCode,
    placeLabels: input.placeLabels,
    selectedLocation: input.selectedLocation || searchCity,
    latitude,
    longitude,
  });
  const officialSources = overviewRiskSources(region);
  return {
    region,
    locationName,
    searchCity,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    country:
      region === 'canada'
        ? 'Canada'
        : region === 'usa'
          ? 'United States'
          : input.country || null,
    countryCode:
      region === 'canada'
        ? 'CA'
        : region === 'usa'
          ? 'US'
          : input.countryCode || null,
    officialSources: officialSources.map((source) => ({ ...source })),
    newsQuery: newsQueryFor(searchCity),
    newsRadiusKm: RISK_NEWS_RADIUS_KM,
    newsLookbackDays: RISK_NEWS_LOOKBACK_DAYS,
    newsTopics: [...RISK_NEWS_TOPICS],
  };
}

function locationLine(brief) {
  const coords =
    Number.isFinite(Number(brief?.latitude)) &&
    Number.isFinite(Number(brief?.longitude))
      ? `${Number(brief.latitude).toFixed(4)}, ${Number(brief.longitude).toFixed(4)}`
      : null;
  const name = String(brief?.locationName || 'the current view');
  return coords ? `${name} (${coords})` : name;
}

function regionLabel(brief) {
  if (brief?.region === 'canada') return 'Canada';
  if (brief?.region === 'usa') return 'the United States';
  return 'an international location';
}

const ACTIVITY_BANDS = Object.freeze({
  default: Object.freeze({ mid: 10, high: 50 }),
  traffic: Object.freeze({ mid: 20, high: 80 }),
  flights: Object.freeze({ mid: 8, high: 25 }),
  'ais-live-vessels': Object.freeze({ mid: 8, high: 25 }),
  cctv: Object.freeze({ mid: 20, high: 120 }),
  firms: Object.freeze({ mid: 5, high: 25 }),
  earthquakes: Object.freeze({ mid: 3, high: 10 }),
  bikeshare: Object.freeze({ mid: 15, high: 60 }),
  military: Object.freeze({ mid: 5, high: 20 }),
});

const LEVEL_RANK = Object.freeze({ none: 0, low: 1, mid: 2, high: 3 });

/**
 * Classify a layer's on-screen count as none, low, mid, or high.
 * @param {number} count
 * @param {string} [layerId]
 * @returns {'none'|'low'|'mid'|'high'}
 */
export function activityLevelForCount(count, layerId = '') {
  const n = Math.max(0, Number(count) || 0);
  if (n <= 0) return 'none';
  const bands = ACTIVITY_BANDS[layerId] || ACTIVITY_BANDS.default;
  if (n >= bands.high) return 'high';
  if (n >= bands.mid) return 'mid';
  return 'low';
}

/**
 * Per-layer and overall activity for the enabled layers on screen.
 * @param {Array<{id?: string, name?: string, count?: number, stats?: {count?: number}, enabled?: boolean}>} layers
 * @returns {{overall: 'none'|'low'|'mid'|'high', layers: Array<{id: string, name: string, count: number, level: string}>}}
 */
export function buildLayerActivity(layers = []) {
  const items = [];
  let overall = 'none';
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (layer && layer.enabled === false) continue;
    const id = String(layer?.id || '');
    const name = String(layer?.name || id);
    if (!id && !name) continue;
    const count = Number(layer?.stats?.count ?? layer?.count) || 0;
    const level = activityLevelForCount(count, id);
    items.push({ id, name, count, level });
    if ((LEVEL_RANK[level] || 0) > (LEVEL_RANK[overall] || 0)) overall = level;
  }
  return { overall, layers: items };
}

/**
 * Overview: what is on screen, activity low/mid/high, and how that changes risk.
 * @param {ReturnType<typeof buildOverviewRiskBrief>} brief
 * @returns {string}
 */
export function buildOverviewQuestion(brief) {
  return [
    'Describe what is displayed on screen, rate on-screen activity as low, mid, or high, and say how that activity raises or lowers operational risk.',
    '',
    `Location: ${locationLine(brief)}`,
    `Region profile: ${regionLabel(brief)}`,
    '',
    'Use only the SCENE JSON, especially SCENE.layerActivity (per-layer count and level, plus overall).',
    'First: what is on screen (place, camera, enabled layers) and why that activity is here.',
    'Then: overall activity low, mid, or high. For each active layer, how more or less of it changes risk — more cars raise accident risk, more aircraft raise congestion risk, more vessels raise collision risk, more fires raise wildfire risk; empty or low counts lower those same risks.',
    'Do not use crime indexes, government crime tables, or news headlines; those belong to the separate Risk Assessment button, which does not have to run first.',
    'No markdown, no headings, no bullet characters. Do not invent counts or layers.',
  ].join('\n');
}

/**
 * Risk assessment: independent of Overview. Gov crime-stat outliers plus correlated extras.
 * @param {ReturnType<typeof buildOverviewRiskBrief>} brief
 * @returns {string}
 */
export function buildRiskAssessmentQuestion(brief) {
  const sources = (brief?.officialSources || [])
    .map((source) => `- ${source.name}: ${source.url}`)
    .join('\n');
  return [
    'Give a custom risk assessment for this location. Overview is not required first.',
    'Search the named government sources for crime-stat outliers for this selected area — rates or indexes that are unusually high or low versus the surrounding region or the national picture.',
    ...(brief?.region === 'canada'
      ? [
          'For Canada, use Statistics Canada table 35-10-0177-01: select Geography for the crime-search city and scan Violations. Outliers from that table are in SCENE.riskAssessment.govCrimeHeadlines.',
        ]
      : []),
    'Tie on-screen activity (SCENE.layerActivity) to extra risk data only when the correlation is high.',
    '',
    `Location: ${locationLine(brief)}`,
    `Crime-search city: ${brief?.searchCity || locationLine(brief)}`,
    `Region profile: ${regionLabel(brief)}`,
    '',
    'Official sources for this location:',
    sources,
    `- Government crime-stat items are in SCENE.riskAssessment.govCrimeHeadlines. Use only numbers that appear there. If that list is empty or has no outlier, say no government crime-stat outlier was supplied for this area.`,
    `- Local reporting from the last ${RISK_NEWS_LOOKBACK_DAYS} days within about ${RISK_NEWS_RADIUS_KM} km about ${RISK_NEWS_TOPICS.join(', ')} is in SCENE.riskAssessment.localHeadlines; if empty, say no recent local headlines were supplied.`,
    '',
    '- Al Jazeera coverage is in SCENE.riskAssessment.alJazeera (status, lookbackDays, articles). State in one sentence whether https://www.aljazeera.com/ has reported on this location in the past 90 days: if status is "ready", say that it has and name what the listed items cover; if status is "empty", say that it has not; if status is "unavailable" or the field is missing, say the Al Jazeera search could not be completed. Use only the listed items and never infer coverage that is not listed.',
    'State every comparison with Canada as a multiple, in the form "N times the Canada rate" (for example "2.3 times the Canada rate", or "0.5 times the Canada rate" when it is lower), using the multiple given in the item. Do not restate it as a percentage or as "higher than" / "lower than".',
    'Write one short prose paragraph. Mention extra sources only when they correlate with on-screen activity or when a government crime-stat outlier is actually supplied.',
    'No markdown, no headings, no bullet characters. Do not invent incidents or statistics.',
  ].join('\n');
}

/** Findings of each check the model is handed, strongest first. */
export const GROUND_TRUTH_MODEL_FINDINGS = 10;
/**
 * Checks whose List Details show only their strongest findings, in the panel's
 * entry and in the model's answer alike. The numbered line above them still
 * carries the full count.
 */
export const GROUND_TRUTH_DETAIL_LIMITS = Object.freeze({
  totalsAgainstParts: 5,
  coverage: 5,
  reportingToPolice: 5,
  unfounded: 5,
  exclusionNotes: 5,
});
/** Room a listed Ground Truth answer needs (see llmAnswerTokens on the server). */
export const GROUND_TRUTH_ANSWER_TOKENS = 6000;

const found = (check) => Number(check?.found) || 0;
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** "police covering 96.4% of the population reported in 2025 (8 years under 90%, lowest 77% in 2021)", or ''. */
function coveragePhrase(coverage) {
  const latest = coverage?.latest;
  if (!latest) return '';
  const lowest = coverage.findings?.[0];
  const low = found(coverage);
  return `police covering ${latest.coveragePct}% of the population reported in ${latest.year}${low ? ` (${plural(low, 'year', 'years')} under 90%, lowest ${lowest.coveragePct}% in ${lowest.year})` : ''}`;
}

/** "5 kinds of crime where under half of victims told the police (lowest 4% for sexual assault in 2024)", or ''. */
function reportingPhrase(reporting) {
  if (!reporting?.published) return '';
  const low = found(reporting);
  const lowest = reporting.findings?.[0];
  return low
    ? `${plural(low, 'kind of crime', 'kinds of crime')} where under half of victims told the police (lowest ${lowest.reportedToPolicePct}% for ${lowest.crime} in ${lowest.year})`
    : 'no kind of crime where under half of victims told the police';
}

/** How the police figure sits against the independent estimate, or ''. */
function independentPhrase(arithmetic) {
  const compared = arithmetic?.independentSource;
  if (!compared) return '';
  return `, the police homicide rate ${compared.position} the World Health Organization's estimate for ${compared.whoYear}`;
}

/** What the source says of reports police struck out, or that it says nothing. */
function unfoundedPhrase(unfounded) {
  if (unfounded?.notPublished)
    return 'no count published of police reports struck as "unfounded"';
  return `${plural(found(unfounded), 'category', 'categories')} with 10% or more of police reports struck as "unfounded"`;
}

/**
 * The four section lines of a Ground Truth report, counted from the evidence.
 * The panel prints them and the model is told to copy them, so a count is
 * never something a model arrived at.
 * @param {object} evidence
 * @returns {string[]}
 */
export function groundTruthSectionHeadings(evidence) {
  const checks = evidence?.checks || {};
  const others = found(checks.otherCategories);
  const larger = (checks.otherCategories?.findings || []).filter(
    (item) => item?.largerThanEveryNamedCategory,
  ).length;
  const moved = found(checks.movedToOtherNotes);
  return [
    `1. Incidents left out of totals, ${[plural(found(checks.totalsAgainstParts), "total that doesn't equal its listed parts", "totals that don't equal their listed parts"), coveragePhrase(checks.coverage), reportingPhrase(checks.reportingToPolice), unfoundedPhrase(checks.unfounded)].filter(Boolean).join(', ')}, and ${plural(found(checks.exclusionNotes), 'exclusion note', 'exclusion notes')}`,
    checks.otherCategories?.notPublished
      ? `2. Use of "other", nothing to check: ${checks.otherCategories.reason || 'this source publishes no "other" category'}`
      : `2. Use of "other", ${plural(others, 'unusual "other" category', 'unusual "other" categories')}${larger ? `, ${larger} larger than every named category beside ${larger === 1 ? 'it' : 'them'}` : ''}${moved ? `, and ${plural(moved, 'note', 'notes')} filing offences under "other"` : ''}`,
    `3. New categories and partial data, ${plural(found(checks.lateStarts), 'series that starts late', 'series that start late')} and ${plural(found(checks.comparabilityNotes), 'note', 'notes')} ruling out comparison across years`,
    `4. Incorrect numbers, ${Number(checks.arithmetic?.checked) || 0} published figures recomputed from the counts with ${found(checks.arithmetic)} disagreeing${independentPhrase(checks.arithmetic)}, and ${checks.corrections?.notPublished ? 'no list of corrections published' : `${plural(found(checks.corrections), 'correction', 'corrections')} issued`}`,
  ];
}

const noteLine = (note) =>
  `- ${note?.categories?.length ? `${note.categories.slice(0, 3).join('; ')}${note.categories.length > 3 ? ` and ${note.categories.length - 3} more` : ''}: ` : ''}${note?.note || ''}`;

/**
 * The findings as one line each, by section: the top five of each section 1
 * check (GROUND_TRUTH_DETAIL_LIMITS), every finding of the rest. Section 4 has
 * details only when a recomputed figure disagrees with the published one.
 * @param {object} evidence
 * @returns {string[][]} Four arrays of lines.
 */
export function groundTruthDetailLines(evidence) {
  const checks = evidence?.checks || {};
  const limited = (name) => {
    const findings = Array.isArray(checks[name]?.findings)
      ? checks[name].findings
      : [];
    return Object.hasOwn(GROUND_TRUTH_DETAIL_LIMITS, name)
      ? findings.slice(0, GROUND_TRUTH_DETAIL_LIMITS[name])
      : findings;
  };
  const list = (check) =>
    Array.isArray(check?.findings) ? check.findings : [];
  return [
    [
      ...limited('totalsAgainstParts').map(
        (item) =>
          `- ${item.category} (${item.year}): reports ${item.reportedTotal}, its ${item.partsListed} listed parts add to ${item.sumOfListedParts}, difference ${item.difference} (${item.differencePct}%); ${item.reading}`,
      ),
      ...[
        // The latest year first, then the years with the least coverage.
        ...(checks.coverage?.latest ? [checks.coverage.latest] : []),
        ...limited('coverage').filter(
          (item) => item.year !== checks.coverage?.latest?.year,
        ),
      ]
        .slice(0, GROUND_TRUTH_DETAIL_LIMITS.coverage)
        .map(
          (item) =>
            `- ${item.year}: police covering ${item.coveragePct}% of the population reported; ${item.populationNotCovered} people lived where no report was made, and nothing there is in any total. ${item.violentCrimesReported} violent crimes were reported; at the same rate the rest would add about ${item.atTheSameRateTheRestWouldAdd} (arithmetic on the published figures, not a count)`,
        ),
      ...limited('reportingToPolice').map(
        (item) =>
          `- ${item.crime} (${item.year}): ${item.reportedToPolicePct}% of victims told the police; the other ${item.neverReportedPct}% are in no police total (the country's victimization survey)`,
      ),
      ...limited('unfounded').map(
        (item) =>
          `- ${item.category} (${item.year}): ${item.struckAsUnfounded} reports struck as unfounded (${item.percentUnfounded}%), ${item.countedInTotals ?? 'n/a'} counted`,
      ),
      ...limited('exclusionNotes').map(noteLine),
    ],
    [
      ...list(checks.otherCategories).map(
        (item) =>
          `- ${item.category} (${item.year}): ${item.incidents} ${item.unit === 'arrests' ? 'arrests' : 'incidents'}; ${(item.reasons || []).join('; ')}`,
      ),
      ...list(checks.movedToOtherNotes).map(noteLine),
    ],
    [
      ...list(checks.lateStarts).map(
        (item) =>
          `- ${item.category}: table starts ${item.tableStartsIn}, reaches its recent level in ${item.reachesRecentLevelIn} (${item.incidentsTheYearBefore ?? 'no figure'} the year before, ${item.incidentsThatYear} that year, ${item.latestIncidents} in ${item.latestYear})`,
      ),
      ...list(checks.comparabilityNotes).map(noteLine),
    ],
    list(checks.arithmetic).map((item) =>
      item.note
        ? `- ${item.category} (${item.year}): ${item.note}`
        : item.check === 'rate against incidents'
          ? `- ${item.category} (${item.year}): published rate ${item.publishedRate}, its incidents imply ${item.rateTheIncidentsImply} (off by ${item.offByPct}%)`
          : `- ${item.category} (${item.year}): published change ${item.publishedChangePct}%, its two rates imply ${item.changeTheRatesImplyPct}% (off by ${item.offByPoints} points)`,
    ),
  ];
}

/**
 * The evidence as the model gets it: the strongest findings of each check,
 * with `found` still saying how many there were. The panel has already listed
 * every one of them; a model asked to recite 65 series runs out of answer.
 * @param {object} evidence
 * @param {number} [limit]
 */
export function groundTruthForModel(
  evidence,
  limit = GROUND_TRUTH_MODEL_FINDINGS,
) {
  const checks = {};
  for (const [name, check] of Object.entries(evidence?.checks || {})) {
    const findings = Array.isArray(check?.findings) ? check.findings : [];
    const most = Object.hasOwn(GROUND_TRUTH_DETAIL_LIMITS, name)
      ? Math.min(limit, GROUND_TRUTH_DETAIL_LIMITS[name])
      : limit;
    checks[name] = {
      ...check,
      findings: findings.slice(0, most),
      listed: Math.min(findings.length, most),
    };
  }
  // The levels and the limits stay out of what the model sees: the report is
  // the counts and the details, with no grade and no caveat line.
  const {
    indicator: _indicator,
    limits: _limits,
    homicideCounts: _homicideCounts,
    ...rest
  } = evidence || {};
  return { ...rest, checks };
}

/**
 * Country Ground Truth Assessment: what a country's own statistics table shows
 * about how its totals are built. The evidence (SCENE.groundTruth) is computed
 * by the server from the table; the model lays it out and explains it, and
 * adds nothing.
 * @param {{country?: string|null, source?: string|null, year?: number|null}} evidence
 * @returns {string}
 */
export function buildGroundTruthQuestion(evidence) {
  const country = String(evidence?.country || 'this country');
  const [one, two, three, four] = groundTruthSectionHeadings(evidence);
  const disagreeing = found(evidence?.checks?.arithmetic);
  return [
    `Give a Country Ground Truth Assessment for ${country}, using only SCENE.groundTruth, which holds checks computed from ${evidence?.source || 'the country’s own published statistics table'}${evidence?.year ? ` (latest year ${evidence.year})` : ''}.`,
    '',
    'Write the answer in exactly this layout, with nothing before it. Copy the four numbered lines word for word; their counts are already correct.',
    '',
    one,
    'List Details:',
    '(one line per finding, each starting with "- ": first the items of checks.totalsAgainstParts, then the items of checks.coverage when it is present (its "latest" year first, then its findings: the share of the population whose police reported, how many people lived where no report was made, and the labelled at-the-same-rate arithmetic), then the items of checks.reportingToPolice when it is present (the share of victims of each kind of crime who told the police, and the share who are therefore in no police total), then the items of checks.unfounded (when it says notPublished, one line saying the source publishes no count of unfounded reports), then the items of checks.exclusionNotes; each of these holds its top five at most, and that is all to list: no "and N more" line in this section; for an exclusion say which total it understates)',
    two,
    'List Details:',
    '(one line per finding: every item of checks.otherCategories with its incidents and its reasons, then every item of checks.movedToOtherNotes; when checks.otherCategories says notPublished, write no List Details under 2)',
    three,
    'List Details:',
    '(one line per finding: every item of checks.lateStarts with the year it reaches its recent level, then every item of checks.comparabilityNotes with the comparison it rules out)',
    four,
    disagreeing
      ? 'List Details:\n(one line per item of checks.arithmetic: the published figure and the figure its own counts imply, or, for a comparison with an independent source, both figures and the interval)'
      : '(nothing disagreed, so write no List Details under 4)',
    '',
    'The lines in brackets are instructions: replace them, do not copy them. A check gives its strongest findings in "findings", says in "listed" how many that is and in "found" how many there were; list every finding given, and in sections 2 and 3 where found is larger than listed end that group with a line "- and N more, listed in GROUND TRUTH CHECKS below".',
    'Quote numbers exactly as given. Say what each practice does to the totals; do not say why the agency does it, because the table cannot show intent. Do not grade or rate the country: no CLEAR, WATCH or FLAGGED levels, no indicator, no overall verdict. The answer ends with section 4: no closing summary, caveat or limits line after it.',
    'Plain text only: no markdown, no bold, no tables. Do not invent categories, numbers, notes or incidents.',
  ].join('\n');
}

/**
 * Operator-visible report of one Ground Truth press, in the same layout the
 * model is asked for, with every finding listed. It costs no model request.
 * @param {object} evidence
 * @returns {string}
 */
export function formatGroundTruthBody(evidence = {}) {
  if (evidence?.status === 'excluded' || evidence?.status === 'nodata') {
    return `${evidence.reason || 'There is nothing to assess for this country.'} No model was asked.`;
  }
  if (evidence?.status === 'unsupported') {
    const connected = (evidence.connected || [])
      .map((entry) => `${entry.country} (${entry.source})`)
      .join(', ');
    return [
      evidence.country
        ? `${evidence.country} is not in the United Nations' table of countries and areas, so no source lists it: there is nothing to check and no model was asked.`
        : 'Could not tell which country this view is in, so there is nothing to check and no model was asked.',
      connected ? `Sources: ${connected}.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const headings = groundTruthSectionHeadings(evidence);
  const details = groundTruthDetailLines(evidence);
  const lines = [
    `${evidence.source || 'National statistics table'}, ${evidence.geography || evidence.country || ''} ${evidence.year || ''}`.trim(),
    ...(evidence.scope ? [evidence.scope] : []),
  ];
  headings.forEach((heading, index) => {
    lines.push(heading);
    // 4. Incorrect numbers: details only when something disagreed.
    if (details[index].length) lines.push('List Details:', ...details[index]);
  });
  return lines.join('\n');
}

function articleLine(article) {
  const title = String(article?.title || '').trim() || 'Untitled';
  const domain = String(article?.domain || '').trim();
  return domain ? `- ${title} (${domain})` : `- ${title}`;
}

/**
 * Operator-visible search hits for one Risk Assessment press.
 * @param {{govCrimeHeadlines?: object[], localHeadlines?: object[]}} headlines
 * @returns {string}
 */
export function formatRiskSearchBody(headlines = {}) {
  const gov = Array.isArray(headlines.govCrimeHeadlines)
    ? headlines.govCrimeHeadlines
    : [];
  const local = Array.isArray(headlines.localHeadlines)
    ? headlines.localHeadlines
    : [];
  const lines = [];
  if (gov.length) {
    lines.push(`Government crime-stat hits (${gov.length}):`);
    for (const article of gov) lines.push(articleLine(article));
  } else {
    lines.push('No government crime-stat hits for this area.');
  }
  const alJazeera = headlines.alJazeera;
  const ajDays = Number(alJazeera?.lookbackDays) || 90;
  if (alJazeera?.status === 'ready' && alJazeera.articles?.length) {
    lines.push(
      `Al Jazeera, past ${ajDays} days (${alJazeera.articles.length}):`,
    );
    for (const article of alJazeera.articles) lines.push(articleLine(article));
  } else if (alJazeera?.status === 'empty') {
    lines.push(
      `Al Jazeera: nothing on this location in the past ${ajDays} days.`,
    );
  } else {
    lines.push('Al Jazeera: search could not be completed.');
  }
  if (local.length) {
    lines.push(`Local headlines (${local.length}):`);
    for (const article of local) lines.push(articleLine(article));
  } else {
    lines.push('No recent local headlines within 100 km / 30 days.');
  }
  return lines.join('\n');
}

/**
 * One labeled log block. Newest blocks are prepended by the panel.
 * @param {string} kind
 * @param {string} body
 * @param {{locationName?: string|null, at?: string|Date}} [meta]
 * @returns {string}
 */
export function formatAskLogEntry(kind, body, meta = {}) {
  const stamp = meta.at ? new Date(meta.at) : new Date();
  const time = Number.isNaN(stamp.getTime())
    ? ''
    : stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const place = String(meta.locationName || '').trim();
  const title = [kind, place, time].filter(Boolean).join(' · ');
  const text = String(body || '').trim();
  return text ? `${title}\n${text}` : title;
}

/**
 * Keep a running log: new text sits on top of whatever was already there.
 * @param {string} existing
 * @param {string} next
 * @returns {string}
 */
export function prependOutputLog(existing, next) {
  const incoming = String(next || '').trim();
  if (!incoming) return String(existing || '').trim();
  const prior = String(existing || '').trim();
  return prior ? `${incoming}\n\n${prior}` : incoming;
}
