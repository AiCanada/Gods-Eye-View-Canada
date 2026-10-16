/**
 * Sea surface temperature around each AI World area, from the app's own
 * SST meta route. Numbers only: no image is stored.
 */
import { DAY, requireAreas, round } from './_util.mjs';

const AREA_CAP = 8;
const BOX = 0.5;

export function sstRecord(area, meta) {
  const range = meta?.sstRange;
  const min = Number(range?.min);
  const max = Number(range?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return {
    lat: round(area.lat, 4),
    lon: round(area.lon, 4),
    area: area.name,
    date: meta.startDate || meta.endDate || null,
    minC: min,
    maxC: max,
    value: round((min + max) / 2, 2),
    fronts: Number(meta?.fronts?.cells) || 0,
  };
}

export default {
  id: 'sea-surface-temperature',
  label: 'Sea surface temperature',
  layers: [],
  kind: 'feed',
  class: 'open',
  licence: 'NASA OceanColor MODIS Aqua Level-3 SST (U.S. public domain)',
  cadenceMs: DAY,
  phase: 2,
  bytesPerDay: 0.05e6,
  async poll({ fetch, areas, state, now, signal }) {
    const list = requireAreas(areas, { max: AREA_CAP });
    state.seen ??= new Map();
    const records = [];
    for (const area of list) {
      const west = area.lon - BOX;
      const south = area.lat - BOX;
      const east = area.lon + BOX;
      const north = area.lat + BOX;
      const url = `/api/sst/l3/meta?period=day&bbox=${west},${south},${east},${north}`;
      let meta;
      try {
        const response = await fetch(url, { signal, cache: 'no-store' });
        if (!response.ok) continue;
        meta = await response.json();
      } catch {
        continue;
      }
      const record = sstRecord(area, meta);
      if (!record) continue;
      const sig = `${record.date}|${record.value}`;
      if (state.seen.get(area.key) === sig) continue;
      state.seen.set(area.key, sig);
      records.push(record);
    }
    return { records, at: now() };
  },
};
