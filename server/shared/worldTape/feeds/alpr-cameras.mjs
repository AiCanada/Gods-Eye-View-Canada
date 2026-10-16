/**
 * World tape snapshot: licence-plate-reader cameras mapped in OpenStreetMap
 * around each area (US and Canada), through the layer's own source
 * (services.alpr, the hourly OSM extract's tiles, at most 16 a view). No live
 * data: once a day, recorded when an area's cameras changed.
 */
import { DAY, boxAround, hashOf, requireAreas, round, text } from './_util.mjs';

const DEFAULT_RADIUS_KM = 25;
/** The source answers views of at most 3° a side. */
const MAX_RADIUS_KM = 150;

export default {
  id: 'alpr-cameras',
  label: 'Plate-reader cameras (OpenStreetMap)',
  layers: ['alpr-cameras'],
  kind: 'static',
  class: 'open',
  licence:
    'OpenStreetMap contributors (ODbL 1.0), from the hourly extract at tiles.dontgetflocked.com',
  cadenceMs: DAY,
  phase: 1,
  bytesPerDay: 0.2e6,
  async poll({ services, areas, state, signal }) {
    const list = requireAreas(areas, { max: 16 });
    state.sig ??= new Map(); // area key → content signature
    const records = [];
    let answered = 0;
    let failure = null;
    for (const area of list) {
      const radius = Math.min(
        MAX_RADIUS_KM,
        area.radiusKm ?? DEFAULT_RADIUS_KM,
      );
      let result;
      try {
        result = await services.alpr.fetch(boxAround(area, radius), signal);
      } catch (error) {
        failure ??= error;
        continue;
      }
      answered += 1;
      if (result?.noCoverage || result?.zoomIn) continue;
      const rows = (result?.records || [])
        .filter(
          (c) => Number.isFinite(c?.latitude) && Number.isFinite(c?.longitude),
        )
        .map((camera) => ({
          area: area.name,
          id: String(camera.id),
          lat: round(camera.latitude, 6),
          lon: round(camera.longitude, 6),
          operator: text(camera.operator, 120),
          manufacturer: text(camera.manufacturer, 120),
          cameraType: text(camera.cameraType, 60),
          zone: text(camera.zone, 60),
          direction: camera.directionDeg ?? null,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const sig = hashOf(rows);
      if (state.sig.get(area.key) === sig) continue;
      state.sig.set(area.key, sig);
      records.push(...rows);
    }
    if (!answered && failure) throw failure;
    return { records };
  },
};
