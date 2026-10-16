/**
 * Observed weather at each AI World area. Open-Meteo, the same call the
 * cockpit uses. This is the reading at the place, not the GFS forecast grid.
 */
import { requireAreas, round } from './_util.mjs';

const AREA_CAP = 8;
const PERIOD_MS = 3 * 60 * 60 * 1000;

async function readWeather(services, lat, lon, signal) {
  if (typeof services?.observedWeather?.getCurrent === 'function')
    return services.observedWeather.getCurrent(lat, lon, { signal });
  const { fetchRegionalWeather } =
    await import('../../../providers/regional/weather.js');
  return fetchRegionalWeather({ latitude: lat, longitude: lon });
}

export function weatherRecord(area, reading) {
  const temperature = Number(reading?.temperatureC);
  if (!Number.isFinite(temperature)) return null;
  return {
    lat: round(area.lat, 4),
    lon: round(area.lon, 4),
    area: area.name,
    observedAt: reading.observedAt || null,
    value: round(temperature, 2),
    precipitationMm: reading.precipitationMm ?? null,
    cloudCoverPct: reading.cloudCoverPct ?? null,
    windKph: reading.windKph ?? null,
    windDirectionDeg: reading.windDirectionDeg ?? null,
  };
}

export default {
  id: 'observed-weather',
  label: 'Observed weather',
  layers: [],
  kind: 'feed',
  class: 'nc',
  licence: 'Open-Meteo (CC BY 4.0)',
  cadenceMs: PERIOD_MS,
  phase: 2,
  bytesPerDay: 0.05e6,
  async poll({ services, areas, state, signal }) {
    const list = requireAreas(areas, { max: AREA_CAP });
    state.seen ??= new Map();
    const records = [];
    for (const area of list) {
      let reading;
      try {
        reading = await readWeather(services, area.lat, area.lon, signal);
      } catch {
        continue;
      }
      const record = weatherRecord(area, reading);
      if (!record) continue;
      const sig = `${record.observedAt}|${record.value}`;
      if (state.seen.get(area.key) === sig) continue;
      state.seen.set(area.key, sig);
      records.push(record);
    }
    return { records };
  },
};
