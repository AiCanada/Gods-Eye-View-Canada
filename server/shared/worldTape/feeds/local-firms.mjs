/**
 * World tape feed: NASA FIRMS active-fire detections (VIIRS NOAA-20, NOAA-21,
 * Suomi-NPP and MODIS), through the layer's own source (services.fires →
 * /api/firms). The proxy refreshes every 30 minutes (the shared MAP_KEY
 * quota), so the recorder asks no more often. Detections arrive in granules
 * (one satellite, one acquisition minute); each granule is recorded once,
 * and again whole if it is ever revised. Without a FIRMS key the layer is
 * empty, which the feed reports instead of recording nothing.
 */
import { acquisitionMsUtc } from '../../../../src/data/firmsCsv.js';
import { DAY, MINUTE, forget, noteChange, round } from './_util.mjs';

export default {
  id: 'local-firms',
  label: 'Active fires (NASA FIRMS)',
  layers: ['local-firms'],
  kind: 'feed',
  class: 'open',
  licence:
    "NASA FIRMS (U.S. public domain / CC0; acknowledgement of NASA's FIRMS requested)",
  cadenceMs: 30 * MINUTE,
  phase: 1,
  bytesPerDay: 5e6,
  async poll({ services, state, now, signal }) {
    const snapshot = await services.fires.getSnapshot({ signal });
    if (snapshot?.keyRequired) throw new Error('NO FIRMS MAP KEY: LAYER EMPTY');
    state.granules ??= new Map(); // granule key → { sig, at: acquisition ms }
    const granules = new Map();
    for (const fire of snapshot.fires || []) {
      if (!Number.isFinite(fire?.lat) || !Number.isFinite(fire?.lon)) continue;
      const key = [
        fire.satellite,
        fire.instrument,
        fire.acqDate,
        fire.acqTime,
      ].join('|');
      if (!granules.has(key)) granules.set(key, []);
      granules.get(key).push(fire);
    }
    const records = [];
    for (const [key, fires] of granules) {
      const acq = acquisitionMsUtc(fires[0].acqDate, fires[0].acqTime);
      const sig = `${fires.length}|${fires.reduce((sum, f) => sum + (f.frp || 0), 0).toFixed(1)}`;
      if (
        !noteChange(
          state.granules,
          key,
          sig,
          Number.isFinite(acq) ? acq : now(),
        )
      )
        continue;
      for (const fire of fires)
        records.push({
          lat: round(fire.lat, 5),
          lon: round(fire.lon, 5),
          frp: fire.frp ?? null,
          confidence: fire.confidence ?? null,
          satellite: fire.satellite || null,
          instrument: fire.instrument || null,
          acq: Number.isFinite(acq) ? acq : null,
          daynight: fire.daynight || null,
          brightness: fire.brightness ?? null,
        });
    }
    // The feed holds the trailing 24 hours; granules acquired before that
    // cannot come back.
    forget(state.granules, now(), 2 * DAY, 50_000);
    return { records };
  },
};
