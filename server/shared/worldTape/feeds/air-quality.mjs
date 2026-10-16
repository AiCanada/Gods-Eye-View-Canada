/**
 * PM2.5 at each AI World area. Open-Meteo air quality (CAMS). A blank
 * reading is skipped. Not a health warning.
 */
import { requireAreas, round } from './_util.mjs';

const AREA_CAP = 8;
const PERIOD_MS = 60 * 60 * 1000;

export function airQualityUrl(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'pm2_5',
  });
  return `https://air-quality-api.open-meteo.com/v1/air-quality?${params}`;
}

export function airRecord(area, body) {
  const pm25 = Number(body?.current?.pm2_5);
  if (!Number.isFinite(pm25)) return null;
  return {
    lat: round(area.lat, 4),
    lon: round(area.lon, 4),
    area: area.name,
    observedAt: body.current.time || null,
    pm25: round(pm25, 2),
  };
}

export default {
  id: 'air-quality',
  label: 'Air quality (PM2.5)',
  layers: [],
  kind: 'feed',
  class: 'open',
  licence:
    'CAMS global air quality via Open-Meteo. Attribution required. Not a health warning.',
  cadenceMs: PERIOD_MS,
  phase: 2,
  bytesPerDay: 0.05e6,
  async poll({ fetch, areas, state, signal }) {
    const list = requireAreas(areas, { max: AREA_CAP });
    const impl = fetch || globalThis.fetch;
    state.seen ??= new Map();
    const records = [];
    await Promise.all(
      list.map(async (area) => {
        try {
          const response = await impl(airQualityUrl(area.lat, area.lon), {
            signal,
            headers: { Accept: 'application/json' },
          });
          if (!response.ok) return;
          const record = airRecord(area, await response.json());
          if (!record) return;
          const sig = `${record.observedAt}|${record.pm25}`;
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
