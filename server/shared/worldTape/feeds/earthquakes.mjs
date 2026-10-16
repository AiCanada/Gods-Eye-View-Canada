/**
 * World tape feed: USGS earthquakes, M2.5+ over the last day, through the
 * layer's own source (src/layers/earthquakes/source.js). Every event once,
 * and again when USGS revises it.
 */
export default {
  id: 'earthquakes',
  label: 'Earthquakes',
  layers: ['earthquakes'],
  kind: 'feed',
  class: 'open',
  licence: 'USGS earthquake catalog (U.S. public domain)',
  cadenceMs: 5 * 60_000,
  phase: 1,
  bytesPerDay: 0.3e6,
  async poll({ services, state, now, signal }) {
    const rows = await services.earthquakes.getSnapshot({ signal });
    state.seen ??= new Map();
    const records = [];
    for (const row of rows) {
      const id = row.usgsId || row.stableId;
      const sig = `${row.mag}|${row.lat}|${row.lon}|${row.depthKm}|${row.time}`;
      if (state.seen.get(id)?.sig === sig) continue;
      state.seen.set(id, { sig, at: now() });
      records.push({
        id,
        lat: row.lat,
        lon: row.lon,
        depth: row.depthKm,
        mag: row.mag,
        place: row.place,
        time: row.time,
      });
    }
    // Forget events not seen for two days.
    for (const [id, entry] of state.seen)
      if (now() - entry.at > 2 * 86_400_000) state.seen.delete(id);
    return { records };
  },
};
