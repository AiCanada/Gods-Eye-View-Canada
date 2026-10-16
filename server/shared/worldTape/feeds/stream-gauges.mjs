/**
 * Nearest USGS stream gauge discharge for an AI World area in the United
 * States. Alaska and Hawaii are included. Anywhere else is not requested.
 * No discharge is not stored as zero.
 */
import { distanceKm } from '../../../../src/worldTapeBin.mjs';
import { boxAround, requireAreas, round } from './_util.mjs';

const AREA_CAP = 8;
const PERIOD_MS = 30 * 60 * 1000;
const REACH_KM = 50;

const US_BOXES = Object.freeze([
  { south: 24.4, north: 49.4, west: -125, east: -66.9 },
  { south: 51, north: 71.5, west: -170, east: -129 },
  { south: 18.9, north: 22.3, west: -160.3, east: -154.7 },
]);

export function isUsPoint(lat, lon) {
  return US_BOXES.some(
    (box) =>
      lat >= box.south &&
      lat <= box.north &&
      lon >= box.west &&
      lon <= box.east,
  );
}

export function gaugeUrl(area) {
  const box = boxAround(area, REACH_KM);
  const params = new URLSearchParams({
    format: 'json',
    bBox: `${box.west},${box.south},${box.east},${box.north}`,
    parameterCd: '00060',
    siteStatus: 'active',
  });
  return `https://waterservices.usgs.gov/nwis/iv/?${params}`;
}

function seriesPoint(series) {
  const geo = series?.sourceInfo?.geoLocation?.geogLocation;
  const lat = Number(geo?.latitude);
  const lon = Number(geo?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function latestValue(series) {
  const rows = series?.values?.[0]?.value;
  if (!Array.isArray(rows)) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const value = Number(rows[i]?.value);
    if (Number.isFinite(value) && value >= 0) {
      return { dischargeCfs: value, observedAt: rows[i].dateTime || null };
    }
  }
  return null;
}

/** The nearest gauge in a USGS instantaneous-values body, or null. */
export function gaugeRecord(area, body, distanceKm) {
  let best = null;
  let bestKm = REACH_KM;
  for (const series of body?.value?.timeSeries || []) {
    const point = seriesPoint(series);
    const reading = latestValue(series);
    if (!point || !reading) continue;
    const km = distanceKm(area, point);
    if (km > bestKm) continue;
    const site =
      series.sourceInfo?.siteCode?.[0]?.value || series.sourceInfo?.siteCode;
    bestKm = km;
    best = {
      lat: round(point.lat, 4),
      lon: round(point.lon, 4),
      area: area.name,
      site: site ? String(site) : '',
      name: series.sourceInfo?.siteName || '',
      observedAt: reading.observedAt,
      dischargeCfs: round(reading.dischargeCfs, 2),
      km: round(km, 1),
    };
  }
  return best;
}

export default {
  id: 'stream-gauges',
  label: 'US stream gauges',
  layers: [],
  kind: 'feed',
  class: 'open',
  licence: 'USGS NWIS instantaneous discharge (US public domain).',
  cadenceMs: PERIOD_MS,
  phase: 2,
  bytesPerDay: 0.05e6,
  async poll({ fetch, areas, state, signal }) {
    const list = requireAreas(areas, { max: AREA_CAP }).filter((area) =>
      isUsPoint(area.lat, area.lon),
    );
    if (!list.length) return { records: [] };
    const impl = fetch || globalThis.fetch;
    state.seen ??= new Map();
    const records = [];
    await Promise.all(
      list.map(async (area) => {
        try {
          const response = await impl(gaugeUrl(area), {
            signal,
            headers: { Accept: 'application/json' },
          });
          if (!response.ok) return;
          const record = gaugeRecord(area, await response.json(), distanceKm);
          if (!record) return;
          const sig = `${record.site}|${record.observedAt}|${record.dischargeCfs}`;
          if (state.seen.get(area.key) === sig) return;
          state.seen.set(area.key, sig);
          records.push(record);
        } catch {
          /* this area is skipped */
        }
      }),
    );
    return { records };
  },
};
