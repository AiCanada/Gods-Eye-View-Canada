/**
 * World tape feed: AIS vessel positions from AISStream, through the layer's
 * own source (services.vessels → /api/vessels, the server's one websocket
 * and its retained rows). Polled every minute (the layer's own pace); each
 * vessel is sampled at most once a minute, and only when it has reported a
 * new position. Military vessels (AIS ship type 35) are left out: military
 * travel is not training data.
 */
import { normalizeVesselType } from '../../../../src/data/vesselLabels.js';
import { supplyClass } from '../../../../src/supplyClass.mjs';
import { HOUR, MINUTE, round, text } from './_util.mjs';

const KNOT_MPS = 0.514444;

export default {
  id: 'ais-live-vessels',
  label: 'Vessels (AIS)',
  layers: ['ais-live-vessels'],
  kind: 'feed',
  class: 'unclear',
  licence:
    'AISStream.io (free beta, no formal terms of use); AIS is a public broadcast',
  cadenceMs: MINUTE,
  phase: 2,
  bytesPerDay: 700e6,
  async poll({ services, state, now, signal }) {
    const snapshot = await services.vessels.getSnapshot(
      { maxRows: 1_000_000 },
      { signal },
    );
    state.seen ??= new Map(); // mmsi → { observed, at }
    const t = now();
    const records = [];
    for (const r of snapshot.records || []) {
      if (
        !r?.id ||
        !Number.isFinite(r.latitude) ||
        !Number.isFinite(r.longitude) ||
        /military/i.test(normalizeVesselType(r.type))
      )
        continue;
      const observed = r.observedAtMs ?? null;
      const previous = state.seen.get(r.id);
      if (
        previous &&
        (t - previous.at < MINUTE ||
          (observed !== null && previous.observed === observed))
      )
        continue;
      state.seen.delete(r.id);
      state.seen.set(r.id, { observed, at: t });
      const supply = supplyClass(r);
      records.push({
        mmsi: r.id,
        name: text(r.name, 80),
        type: text(r.type, 60),
        lat: round(r.latitude, 5),
        lon: round(r.longitude, 5),
        sog: Number.isFinite(r.speedMps)
          ? round(r.speedMps / KNOT_MPS, 1)
          : null,
        cog: round(r.courseDeg, 0),
        heading: round(r.headingDeg, 0),
        ...(supply ? { supply } : {}),
        observed,
        ...(text(r.imo) ? { imo: text(r.imo) } : {}),
        ...(text(r.destination)
          ? { destination: text(r.destination, 80) }
          : {}),
      });
    }
    // A vessel quiet for six hours starts afresh.
    for (const [mmsi, entry] of state.seen) {
      if (t - entry.at <= 6 * HOUR) break;
      state.seen.delete(mmsi);
    }
    while (state.seen.size > 200_000)
      state.seen.delete(state.seen.keys().next().value);
    return { records };
  },
};
