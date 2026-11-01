/**
 * Country Ground Truth Assessment against the United States (owner request
 * 2026-10-30: "Use USA as a base line of 100 and update Country ground truth
 * tab to also compare against USA"). The same four methods; the United
 * States' table, read through its own adapter (fbi-ground-truth.js), is the
 * baseline every country is set against.
 *
 * What is set side by side is the rate of findings among the figures each
 * check examined: a total against its listed parts, a year's police coverage,
 * a kind of crime's reporting share, a category's unfounded share, an "other"
 * row, a series' start, a published rate or change recomputed. Every such
 * check says how many figures it looked at (`checked`) and how many showed
 * something (`found`); the rate is findings per 100 figures checked, and the
 * index is that rate scaled so the United States' rate reads 100. A raw count
 * of findings would reward the thin table: a country that reports one offence
 * to the United Nations cannot show the sixty-five late-starting series that
 * Canada's table of three hundred categories can, and would read as ten times
 * more truthful for it.
 *
 * The notes (what a table says it excludes, files under "other" or cannot
 * compare across years, and the corrections the agency issued) have no count
 * of figures behind them, so they are counted beside the index and never
 * inside it.
 *
 * Pure: evidence in, numbers and lines out. The panel prints the lines in its
 * own entry, draws the two pies (askGroundTruthPies.js) and hands the model
 * the same numbers to copy; a count is never something a model arrived at.
 */
import { english, msgl } from './i18n/marker.js';

/** The baseline: the United States, read from the FBI Crime Data Explorer. */
export const GROUND_TRUTH_BASELINE_CODE = 'US';
export const GROUND_TRUTH_BASELINE_NAME = 'United States';
/** What the baseline's own rate reads as. */
export const GROUND_TRUTH_BASELINE_INDEX = 100;

/**
 * The four methods, as the report numbers them, and the checks each sums.
 * `figures` are the checks that examine published figures and say how many
 * (`checked`); `notes` are the table's own notes and corrections, counted but
 * never indexed.
 */
export const GROUND_TRUTH_METHODS = Object.freeze([
  Object.freeze({
    key: 'incidentsLeftOutOfTotals',
    number: 1,
    label: msgl('Incidents left out of totals'),
    figures: Object.freeze([
      'totalsAgainstParts',
      'coverage',
      'reportingToPolice',
      'unfounded',
    ]),
    notes: Object.freeze(['exclusionNotes']),
  }),
  Object.freeze({
    key: 'useOfOtherCategory',
    number: 2,
    label: msgl('Use of "other"'),
    figures: Object.freeze(['otherCategories']),
    notes: Object.freeze(['movedToOtherNotes']),
  }),
  Object.freeze({
    key: 'newCategoriesAndPartialData',
    number: 3,
    label: msgl('New categories and partial data'),
    figures: Object.freeze(['lateStarts']),
    notes: Object.freeze(['comparabilityNotes']),
  }),
  Object.freeze({
    key: 'incorrectNumbers',
    number: 4,
    label: msgl('Incorrect numbers'),
    figures: Object.freeze(['arithmetic']),
    notes: Object.freeze(['corrections']),
  }),
]);

const whole = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
};
const tenth = (value) => Math.round(value * 10) / 10;

/** Findings per 100 figures checked, to a tenth; null where nothing was checked. */
const rateOf = (findings, figuresChecked) =>
  figuresChecked > 0 ? tenth((findings / figuresChecked) * 100) : null;

/** One method's counts for one country. */
function methodCounts(checks, method) {
  let findings = 0;
  let figuresChecked = 0;
  let notes = 0;
  for (const name of method.figures) {
    const check = checks[name];
    if (!check) continue;
    findings += whole(check.found);
    figuresChecked += whole(check.checked);
  }
  for (const name of method.notes) notes += whole(checks[name]?.found);
  return {
    key: method.key,
    number: method.number,
    label: method.label,
    findings,
    figuresChecked,
    notes,
    rate: rateOf(findings, figuresChecked),
  };
}

/**
 * One country's counts: per method and in all. `findings` are the findings
 * among the figures checked; the notes stand beside them.
 * @param {object} evidence A country's evidence (status 'ready').
 */
export function groundTruthFindingCounts(evidence) {
  const checks = evidence?.checks || {};
  const methods = GROUND_TRUTH_METHODS.map((method) =>
    methodCounts(checks, method),
  );
  const sum = (field) =>
    methods.reduce((total, method) => total + method[field], 0);
  const findings = sum('findings');
  const figuresChecked = sum('figuresChecked');
  return {
    country: String(evidence?.country || ''),
    countryCode: String(evidence?.countryCode || '').toUpperCase(),
    source: evidence?.source || null,
    year: evidence?.year ?? null,
    findings,
    figuresChecked,
    notes: sum('notes'),
    rate: rateOf(findings, figuresChecked),
    methods,
  };
}

/**
 * One rate against the baseline's, both already to a tenth, so the index
 * follows from the two rates the report prints. Nothing found on either side
 * reads as the baseline itself; nothing found on the baseline's side alone
 * leaves nothing to scale by.
 */
function scale(rate, baseRate) {
  if (rate === null) return { index: null, reason: 'nothingChecked' };
  if (baseRate === null)
    return { index: null, reason: 'baselineNothingChecked' };
  if (baseRate === 0) {
    return rate === 0
      ? { index: GROUND_TRUTH_BASELINE_INDEX, reason: null }
      : { index: null, reason: 'baselineFoundNothing' };
  }
  return {
    index: Math.round((rate / baseRate) * GROUND_TRUTH_BASELINE_INDEX),
    reason: null,
  };
}

const side = ({ findings, figuresChecked, notes, rate }) => ({
  findings,
  figuresChecked,
  notes,
  rate,
});
const whole_ = ({ methods: _methods, ...rest }) => rest;

const HOW =
  'findings per 100 figures checked, the United States’ rate = 100; notes counted beside the index, never inside it';

/**
 * The selected country against the baseline.
 * @param {object} evidence The country's evidence; only a 'ready' one compares.
 * @param {object|null} baseline The United States' evidence, an
 *   `{status: 'unavailable', error}` record when its table could not be read,
 *   or null when the country is the United States itself.
 * @returns {object|null} null when there is no evidence to compare.
 */
export function compareGroundTruthAgainstBaseline(evidence, baseline) {
  if (evidence?.status !== 'ready') return null;
  const country = groundTruthFindingCounts(evidence);
  const shared = {
    baselineCountry: GROUND_TRUTH_BASELINE_NAME,
    baselineCountryCode: GROUND_TRUTH_BASELINE_CODE,
    baselineIndex: GROUND_TRUTH_BASELINE_INDEX,
    how: HOW,
  };
  if (country.countryCode === GROUND_TRUTH_BASELINE_CODE) {
    return {
      status: 'baseline',
      ...shared,
      index: GROUND_TRUTH_BASELINE_INDEX,
      reason: null,
      country: whole_(country),
      baseline: whole_(country),
      methods: country.methods.map((method) => ({
        key: method.key,
        number: method.number,
        label: method.label,
        country: side(method),
        baseline: side(method),
        index: method.rate === null ? null : GROUND_TRUTH_BASELINE_INDEX,
        reason: method.rate === null ? 'nothingChecked' : null,
      })),
    };
  }
  if (baseline?.status !== 'ready') {
    return {
      status: 'unavailable',
      ...shared,
      error: String(baseline?.error || baseline?.reason || ''),
      index: null,
      reason: 'unavailable',
      country: whole_(country),
      baseline: null,
      methods: country.methods.map((method) => ({
        key: method.key,
        number: method.number,
        label: method.label,
        country: side(method),
        baseline: null,
        index: null,
        reason: 'unavailable',
      })),
    };
  }
  const base = groundTruthFindingCounts(baseline);
  return {
    status: 'compared',
    ...shared,
    ...scale(country.rate, base.rate),
    country: whole_(country),
    baseline: whole_(base),
    methods: country.methods.map((method, at) => ({
      key: method.key,
      number: method.number,
      label: method.label,
      country: side(method),
      baseline: side(base.methods[at]),
      ...scale(method.rate, base.methods[at].rate),
    })),
  };
}

/** A rate as the report prints it, in the locale's marks. */
const rateText = (rate, say) =>
  rate === null ? say.tl('n/a') : say.digits(String(rate));

const findingsText = (count, say) =>
  say.tln(count, '{count} finding', '{count} findings');
const checkedText = (count, say) =>
  say.tln(count, '{count} figure checked', '{count} figures checked');
const notesText = (count, say) =>
  say.tln(count, '{count} note', '{count} notes');

/**
 * The fifth section line of a Ground Truth report, counted from the
 * comparison. The panel prints it and the model copies it.
 * @param {object} compared From compareGroundTruthAgainstBaseline().
 * @returns {string}
 */
export function groundTruthBaselineHeading(compared, say = english) {
  const own = compared.country;
  const values = {
    country: own.country,
    findings: findingsText(own.findings, say),
    checked: checkedText(own.figuresChecked, say),
    notes: notesText(own.notes, say),
    rate: rateText(own.rate, say),
  };
  if (compared.status === 'unavailable') {
    return say.tl(
      '5. Against the United States at 100: the United States’ table could not be read this time ({error}), so there is no baseline to compare with; {findings} in {checked} here, {notes} counted, not indexed',
      { ...values, error: compared.error || say.tl('no answer') },
    );
  }
  if (compared.status === 'baseline') {
    return say.tl(
      '5. Against the United States at 100: the United States is the baseline, {rate} findings per 100 figures checked ({findings} in {checked}); {notes} counted, not indexed',
      values,
    );
  }
  const base = compared.baseline;
  const both = {
    ...values,
    baseFindings: base.findings,
    baseChecked: base.figuresChecked,
    baseNotes: base.notes,
    baseRate: rateText(base.rate, say),
  };
  if (compared.index !== null) {
    return say.tl(
      '5. Against the United States at 100, {country} {index}: {rate} findings per 100 figures checked, the United States {baseRate} ({findings} in {checked}; the United States {baseFindings} in {baseChecked}); {notes} counted, not indexed (the United States {baseNotes})',
      { ...both, index: compared.index },
    );
  }
  if (compared.reason === 'nothingChecked') {
    return say.tl(
      '5. Against the United States at 100, {country} has no index: no figure was checked here (the United States {baseRate} findings per 100 figures checked, {baseFindings} in {baseChecked}); {notes} counted, not indexed (the United States {baseNotes})',
      both,
    );
  }
  return say.tl(
    '5. Against the United States at 100, {country} has no index: the United States’ checks found nothing in the {baseChecked} figures they examined, so there is nothing to scale by ({findings} in {checked} here); {notes} counted, not indexed (the United States {baseNotes})',
    both,
  );
}

/**
 * The List Details of section 5: one line per method, both countries' counts
 * and the method's index, then the notes counted beside the index. Empty
 * unless the two countries were compared.
 * @param {object} compared From compareGroundTruthAgainstBaseline().
 * @returns {string[]}
 */
export function groundTruthBaselineDetailLines(compared, say = english) {
  if (compared?.status !== 'compared') return [];
  const name = compared.country.country;
  const lines = compared.methods.map((method) => {
    const values = {
      number: method.number,
      method: say.tl(method.label),
      country: name,
      findings: findingsText(method.country.findings, say),
      checked: checkedText(method.country.figuresChecked, say),
      rate: rateText(method.country.rate, say),
      baseFindings: method.baseline.findings,
      baseChecked: method.baseline.figuresChecked,
      baseRate: rateText(method.baseline.rate, say),
      index: method.index,
    };
    if (method.index !== null) {
      return say.tl(
        '- {number}. {method}: {country} {findings} in {checked} ({rate} per 100), the United States {baseFindings} in {baseChecked} ({baseRate} per 100), index {index}',
        values,
      );
    }
    if (method.reason === 'baselineFoundNothing') {
      return say.tl(
        '- {number}. {method}: {country} {findings} in {checked} ({rate} per 100), the United States {baseFindings} in {baseChecked} (0 per 100), no index: the United States’ checks found nothing here',
        values,
      );
    }
    return say.tl(
      '- {number}. {method}: {country} {findings} in {checked}, the United States {baseFindings} in {baseChecked}, no index: a side with no figure checked has no rate',
      values,
    );
  });
  const notes = (counts) => ({
    exclusion: say.tln(
      counts[0].notes,
      '{count} exclusion note',
      '{count} exclusion notes',
    ),
    moved: notesText(counts[1].notes, say),
    comparability: notesText(counts[2].notes, say),
    corrections: say.tln(
      counts[3].notes,
      '{count} correction',
      '{count} corrections',
    ),
  });
  const own = notes(compared.methods.map((method) => method.country));
  const base = notes(compared.methods.map((method) => method.baseline));
  lines.push(
    say.tl(
      '- Notes counted, not indexed: {country} {exclusion}, {moved} filing offences under "other", {comparability} ruling out comparison across years and {corrections}; the United States {baseExclusion}, {baseMoved}, {baseComparability} and {baseCorrections}',
      {
        country: name,
        ...own,
        baseExclusion: base.exclusion,
        baseMoved: base.moved,
        baseComparability: base.comparability,
        baseCorrections: base.corrections,
      },
    ),
  );
  return lines;
}
