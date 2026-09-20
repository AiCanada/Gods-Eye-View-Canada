import { STATCAN_TABLE_LABEL } from './statcan-crime.js';
import { fetchStatCanGroundTruth } from './statcan-ground-truth.js';
import { FBI_SOURCE, fetchFbiGroundTruth } from './fbi-ground-truth.js';
import { UN_SOURCE, fetchUnGroundTruth } from './un-ground-truth.js';
import {
  EUROSTAT_SOURCE,
  fetchEurostatGroundTruth,
  inEurostat,
} from './eurostat-ground-truth.js';
import { countryCodes } from './country-codes.js';

/**
 * Country Ground Truth Assessment: the evidence for one country. Each module
 * reads its source and answers in the same shape (the four methods, each a list
 * of findings with how many were found), so the panel and the model treat every
 * country alike.
 *
 * Canada and the United States have their own adapters, reading the national
 * statistics agency's full table. The European countries are read from
 * Eurostat's table of offences by category, laid over their UN figures
 * (eurostat-ground-truth.js). Every other country is read from what it reported
 * to the United Nations (un-ground-truth.js). Ukraine is left out at the
 * operator's instruction.
 */
const NATIONAL_ADAPTERS = Object.freeze({
  CA: Object.freeze({
    country: 'Canada',
    source: STATCAN_TABLE_LABEL,
    fetch: fetchStatCanGroundTruth,
  }),
  US: Object.freeze({
    country: 'United States',
    source: FBI_SOURCE,
    fetch: fetchFbiGroundTruth,
  }),
});

/** Countries the assessment is never run for, and why the panel says so. */
const EXCLUDED_COUNTRIES = Object.freeze({
  UA: 'Ukraine is left out of Country Ground Truth Assessment by the operator.',
});

const GROUND_TRUTH_COUNTRIES = Object.freeze({
  ...NATIONAL_ADAPTERS,
  '*': Object.freeze({ country: 'Every other country', source: UN_SOURCE }),
});

const connectedList = () => [
  ...Object.entries(NATIONAL_ADAPTERS).map(([code, entry]) => ({
    countryCode: code,
    country: entry.country,
    source: entry.source,
  })),
  { countryCode: 'EU', country: 'European countries', source: EUROSTAT_SOURCE },
  { countryCode: '*', country: 'Every other country', source: UN_SOURCE },
];

/**
 * The evidence for one country. Each source is read once a day.
 * @param {string} countryCode ISO 3166-1 alpha-2.
 * @param {string} [countryName] Echoed back when there is nothing to assess.
 */
async function fetchCountryGroundTruth(countryCode, countryName = '') {
  const code = String(countryCode || '')
    .trim()
    .toUpperCase();
  const named = String(countryName || '').slice(0, 80);
  if (Object.hasOwn(EXCLUDED_COUNTRIES, code)) {
    return {
      status: 'excluded',
      country: countryCodes(code)?.name || named || code,
      countryCode: code,
      reason: EXCLUDED_COUNTRIES[code],
    };
  }
  if (Object.hasOwn(NATIONAL_ADAPTERS, code))
    return NATIONAL_ADAPTERS[code].fetch();
  const evidence = inEurostat(code)
    ? await fetchEurostatGroundTruth(code)
    : countryCodes(code)
      ? await fetchUnGroundTruth(code)
      : null;
  if (evidence) return evidence;
  return {
    status: 'unsupported',
    country: named || code || null,
    countryCode: code || null,
    connected: connectedList(),
  };
}

export { EXCLUDED_COUNTRIES, GROUND_TRUTH_COUNTRIES, fetchCountryGroundTruth };
