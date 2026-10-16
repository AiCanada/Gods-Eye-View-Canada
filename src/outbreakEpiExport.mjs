/**
 * EPIDEMIC MODEL EXPORT: the result of simulateEpidemic (outbreakEpi.mjs) as
 * RFC 4180 CSV tables (places and daily totals) and as a JSON document with
 * the request that produced it. Pure: no DOM, no network, no imports; the
 * panel turns the strings into downloads.
 */

/** Columns of the places table, one row per place in result order. */
export const PLACES_CSV_HEADER =
  'id,code,name,kind,lat,lon,population,origin,pArrive,pArriveLo,pArriveHi,etaP5,etaP50,etaP95,pReported,reportP50,pOverwhelmed,overflowP50,casesP50,casesP95,deathsP50,hospitalPeakP50,icuPeakP50,pRestricted,restrictP50,importedP50,pImportedFirst,pGround,pLocal,vaccinatedP50,reinfectedP50,localBy50,establishedBy50,localOffsetHours';

/** Columns of the totals table, one row per day. */
export const TOTALS_CSV_HEADER =
  'day,p5,p50,p95,newP5,newP50,newP95,reportedP5,reportedP50,reportedP95,deathsP5,deathsP50,deathsP95,hospitalP5,hospitalP50,hospitalP95,icuP50,admittedP50,bedsShortP50,restrictedPeopleP50,restrictedPlacesP50,vaccinatedP50,countriesClosedP50,importedP50,reinfectedP50,distancingP50,rtP5,rtP50,rtP95,strain2P50,strain2ShareP50,counterfactualP50,avertedP50';

const CRLF = '\r\n';

/**
 * One CSV field (RFC 4180): nothing for null, undefined and non-finite
 * numbers; numbers and booleans as String() gives them; strings quoted when
 * they hold a comma, a quote or a line break, inner quotes doubled.
 */
export function csvField(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function placeRow(place) {
  const ci = Array.isArray(place.pArriveCi) ? place.pArriveCi : [];
  const values = PLACES_CSV_HEADER.split(',').map((column) => {
    if (column === 'pArriveLo') return ci[0];
    if (column === 'pArriveHi') return ci[1];
    return place[column];
  });
  return values.map(csvField).join(',');
}

/** The places table: header, then one row per place in `result.places` order. */
export function epidemicPlacesCsv(result) {
  const places = Array.isArray(result?.places) ? result.places : [];
  return [PLACES_CSV_HEADER, ...places.map(placeRow)].join(CRLF);
}

/** The totals table: header, then one row per day of `result.totals`. */
export function epidemicTotalsCsv(result) {
  const totals = Array.isArray(result?.totals) ? result.totals : [];
  const columns = TOTALS_CSV_HEADER.split(',');
  const rows = totals.map((total, d) =>
    columns
      .map((column) =>
        column === 'day' ? (total?.day ?? d + 1) : total?.[column],
      )
      .map(csvField)
      .join(','),
  );
  return [TOTALS_CSV_HEADER, ...rows].join(CRLF);
}

const REQUEST_KEYS = [
  'startMs',
  'untilMs',
  'runs',
  'seed',
  'locations',
  'outbreakAirports',
  'flightCount',
  // The scan's flights (airport codes and times): with them a saved run can
  // be run again as a scenario (scripts/outbreak-dataset.mjs --from-export).
  'flights',
  'profile',
  // Rail travel (owner ruling 2026-10-12).
  'speedKmh',
  'rail',
];

/**
 * The JSON document to save: when it was exported, the request that made it
 * (only its known fields, only those set) and the result. Shallow copies;
 * neither input is changed, and the document round-trips through JSON.
 */
export function epidemicExport(result, request, { now = Date.now } = {}) {
  const picked = {};
  for (const key of REQUEST_KEYS) {
    const value = request?.[key];
    if (value !== undefined) picked[key] = value;
  }
  return {
    exportedAt: new Date(now()).toISOString(),
    request: picked,
    result: { ...(result || {}) },
  };
}
