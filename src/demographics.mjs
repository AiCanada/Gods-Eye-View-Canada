/**
 * Population demographics for the world models (owner request 2026-10-13:
 * "based on population demographics"): each country's age structure and
 * urban share from the World Bank's World Development Indicators (CC BY
 * 4.0), as static features of every place, beside its GeoNames population.
 * Pure: the fetch and the cache are in server/shared/demographicsStore.mjs.
 */

/** The indicators, and the field each becomes. */
export const DEMOGRAPHIC_INDICATORS = Object.freeze({
  'SP.POP.0014.TO.ZS': 'age0to14',
  'SP.POP.1564.TO.ZS': 'age15to64',
  'SP.POP.65UP.TO.ZS': 'age65up',
  'SP.URB.TOTL.IN.ZS': 'urban',
});
export const DEMOGRAPHIC_FIELDS = Object.freeze(
  Object.values(DEMOGRAPHIC_INDICATORS),
);

/**
 * One indicator's World Bank answer (format=json, mrnev=1) as
 * { ISO2: { value, year } }; aggregates and empty rows are left out.
 */
export function readWorldBankIndicator(payload) {
  const rows = Array.isArray(payload) ? payload[1] : null;
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = row?.country?.id;
    const value = Number(row?.value);
    if (!/^[A-Z]{2}$/.test(code || '') || row?.value === null) continue;
    if (
      !Number.isFinite(value) ||
      !/^[A-Z]{3}$/.test(row?.countryiso3code || '')
    )
      continue;
    out[code] = { value, year: Number(row.date) || null };
  }
  return out;
}

/** The indicators, merged by country: { ISO2: { age0to14, …, years } }. */
export function mergeIndicators(byIndicator) {
  const out = {};
  for (const [indicator, field] of Object.entries(DEMOGRAPHIC_INDICATORS))
    for (const [code, { value, year }] of Object.entries(
      byIndicator[indicator] || {},
    )) {
      out[code] ??= { years: {} };
      out[code][field] = value;
      out[code].years[field] = year;
    }
  return out;
}

/**
 * Static features per place: log10 population, then each demographic field
 * as a share (0–1) from its country, NaN where unknown.
 * Returns { data: Float32Array, shape: [n, 1 + fields], channels }.
 */
export function placeDemographics(nodes, byCountry) {
  const channels = ['log10Population', ...DEMOGRAPHIC_FIELDS];
  const C = channels.length;
  const data = new Float32Array(nodes.length * C).fill(NaN);
  nodes.forEach((node, i) => {
    const o = i * C;
    data[o] = Math.log10(Math.max(1, node.population || 1));
    const row = byCountry[node.country || ''];
    if (!row) return;
    DEMOGRAPHIC_FIELDS.forEach((field, j) => {
      if (Number.isFinite(row[field])) data[o + 1 + j] = row[field] / 100;
    });
  });
  return { data, shape: [nodes.length, C], channels };
}
