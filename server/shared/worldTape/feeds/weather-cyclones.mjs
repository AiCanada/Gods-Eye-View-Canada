/**
 * World tape feed: NHC/CPHC tropical cyclone advisories, through the layer's
 * own source (services.cyclones → /api/cyclones, 5-minute cache). Each storm
 * once per advisory, and again when that advisory's position or forecast
 * geometry is revised.
 */
import { DAY, MINUTE, forget, noteChange, round } from './_util.mjs';

export default {
  id: 'weather-cyclones',
  label: 'Tropical cyclones (NHC/CPHC)',
  layers: ['weather-cyclones'],
  kind: 'feed',
  class: 'open',
  licence:
    'NOAA/NWS National Hurricane Center and Central Pacific Hurricane Center advisories (U.S. government data; NWS disclaimer)',
  cadenceMs: 5 * MINUTE,
  phase: 1,
  bytesPerDay: 0.1e6,
  async poll({ services, state, now, signal }) {
    const snapshot = await services.cyclones.getSnapshot({ signal });
    if (snapshot.unavailable)
      throw new Error(snapshot.reason || 'Cyclone advisories unavailable');
    state.seen ??= new Map();
    const t = now();
    const records = [];
    for (const storm of snapshot.storms || []) {
      const sig = [
        storm.advisoryNumber,
        storm.positionAt,
        storm.geometryStatus,
        storm.geometryAdvisoryNumber,
      ].join('|');
      if (!noteChange(state.seen, storm.id, sig, t)) continue;
      records.push({
        id: storm.id,
        name: storm.name,
        basin: storm.basin,
        classification: storm.classification,
        lat: round(storm.position?.latitude, 4),
        lon: round(storm.position?.longitude, 4),
        windKt: storm.windKt,
        pressure: storm.pressureHpa,
        advisory: storm.advisoryNumber,
        issued: storm.issuedAt,
        positionAt: storm.positionAt,
        movement: storm.movement ?? null,
        geometry: storm.geometryStatus,
        forecast: (storm.forecastPoints || []).map((point) => [
          point.tauHours,
          round(point.position?.latitude, 4),
          round(point.position?.longitude, 4),
          point.windKt,
        ]),
      });
    }
    forget(state.seen, t, 14 * DAY, 1000);
    return { records };
  },
};
