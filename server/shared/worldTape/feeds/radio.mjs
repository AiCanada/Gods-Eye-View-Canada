/**
 * World tape feed: the Radio Browser station directory (metadata only: no
 * audio and no stream address is ever recorded), through the layer's own
 * source (services.radio → /api/radio/stations, which refreshes every 45
 * minutes). Each station once, and again when its metadata changes.
 */
import {
  DAY,
  MINUTE,
  forget,
  hashOf,
  noteChange,
  round,
  text,
} from './_util.mjs';

export default {
  id: 'radio',
  label: 'Radio stations (metadata)',
  layers: ['radio'],
  kind: 'feed',
  class: 'open',
  licence:
    'Radio Browser directory (PDDL 1.0); station metadata only, never audio',
  cadenceMs: 45 * MINUTE,
  phase: 1,
  bytesPerDay: 0.5e6,
  async poll({ services, state, now, signal }) {
    const directory = await services.radio.getDirectory({ signal });
    if (!Array.isArray(directory?.stations))
      throw new Error('Malformed radio directory');
    state.seen ??= new Map();
    const t = now();
    const records = [];
    for (const station of directory.stations) {
      const id = text(station?.id);
      if (!id) continue;
      const record = {
        id,
        name: text(station.name),
        country: text(station.country),
        state: text(station.state),
        lat: round(station.lat, 4),
        lon: round(station.lon, 4),
        tags: Array.isArray(station.tags) ? station.tags.slice(0, 20) : [],
        languages: Array.isArray(station.languages)
          ? station.languages.slice(0, 10)
          : [],
        codec: text(station.codec),
        bitrate: Number.isFinite(station.bitrate) ? station.bitrate : null,
      };
      if (noteChange(state.seen, id, hashOf(record), t)) records.push(record);
    }
    forget(state.seen, t, 30 * DAY, 200_000);
    return { records };
  },
};
