/**
 * World tape feed: aircraft type and registration by ICAO address from
 * adsbdb, through the flights source's own enrichment route
 * (services.aircraft.getEnrichment → /api/adsbdb/type/<hex>, which caches
 * every answer for 24 hours on disk, misses included). Types only: route
 * data may not be copied without its authors' permission. The hexes come
 * from what the flights feed recorded; when it is not recording, from one
 * snapshot of the flights source. adsbdb publishes no quota, so the recorder
 * asks one at a time, at most 60 new aircraft every 30 minutes, each at most
 * once a day.
 */
import { DAY, MINUTE, flightHexesBetween, text } from './_util.mjs';

const LOOKUPS_PER_POLL = 60;
const HEX = /^[0-9a-f]{6}$/;

export default {
  id: 'flight-enrichment',
  label: 'Aircraft types (adsbdb)',
  layers: ['flights'],
  kind: 'feed',
  class: 'restricted',
  licence:
    'adsbdb (no published licence or quota; aircraft data from PlaneBase): types and registrations only, local use',
  cadenceMs: 30 * MINUTE,
  phase: 2,
  bytesPerDay: 0.5e6,
  async poll({ services, state, now, signal }) {
    const t = now();
    state.asked ??= new Map(); // hex → ms asked
    // What the flights feed recorded in the last hour.
    let hexes = flightHexesBetween(t - 60 * MINUTE, t);
    if (!hexes.length) {
      const snapshot = await services.aircraft.getSnapshot({}, { signal });
      hexes = (snapshot.records || []).map((record) => record.id);
    }
    const records = [];
    let asked = 0;
    for (const raw of hexes) {
      if (asked >= LOOKUPS_PER_POLL) break;
      const hex = String(raw || '').toLowerCase();
      if (!HEX.test(hex)) continue;
      const previous = state.asked.get(hex);
      if (previous !== undefined && t - previous < DAY) continue;
      state.asked.delete(hex);
      state.asked.set(hex, t);
      asked += 1;
      let answer;
      try {
        answer = await services.aircraft.getEnrichment(
          { kind: 'type', id: hex },
          { signal },
        );
      } catch {
        continue;
      }
      records.push({
        hex,
        found: answer?.found === true,
        typeCode: text(answer?.typeCode, 8),
        typeName: text(answer?.typeName, 120),
        registration: text(answer?.registration, 16),
      });
    }
    for (const [hex, at] of state.asked) {
      if (t - at <= DAY) break;
      state.asked.delete(hex);
    }
    return { records };
  },
};
