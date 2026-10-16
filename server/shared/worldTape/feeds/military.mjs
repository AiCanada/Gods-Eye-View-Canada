/**
 * World tape feed: military aircraft from adsb.lol, through the layer's own
 * source (services.military → /api/military, the proxy's 12 s cache and its
 * rate-limit cooldown). A snapshot every 30 seconds, half the layer's own
 * 15-second pace; the proxy's stale copy during a cooldown is not recorded.
 */
import { round } from './_util.mjs';

export default {
  id: 'military',
  label: 'Military aircraft',
  layers: ['military'],
  kind: 'feed',
  class: 'open',
  licence: 'adsb.lol (ODbL 1.0)',
  cadenceMs: 30_000,
  phase: 1,
  bytesPerDay: 30e6,
  async poll({ services, state, signal }) {
    const snapshot = await services.military.getSnapshot({}, { signal });
    if (snapshot.stale === true) return {};
    // The proxy's cached body reports the same observation time (within the
    // second its age header is rounded to): recorded once.
    const at = snapshot.observedAtMs;
    if (
      Number.isFinite(at) &&
      Number.isFinite(state.lastAt) &&
      Math.abs(at - state.lastAt) < 2000
    )
      return {};
    state.lastAt = at;
    const records = [];
    for (const r of snapshot.records || []) {
      if (
        !r?.id ||
        !Number.isFinite(r.latitude) ||
        !Number.isFinite(r.longitude)
      )
        continue;
      records.push({
        hex: r.id,
        callsign: r.callsign || null,
        type: r.typeCode || null,
        reg: r.registration || null,
        lat: round(r.latitude, 5),
        lon: round(r.longitude, 5),
        alt: round(r.baroAltitudeM ?? r.ellipsoidAltitudeM, 0),
        speed: round(r.speedMps, 1),
        track: round(r.courseDeg, 0),
        vrate: round(r.verticalRateMps, 1),
        ground: r.onGround === true,
        seen: r.positionTimeMs ?? null,
      });
    }
    return { records };
  },
};
