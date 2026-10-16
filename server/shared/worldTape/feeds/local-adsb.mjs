/**
 * World tape feed: aircraft heard by the owner's own receiver, from the
 * decoder feeds the server reads (/api/local-receivers/aircraft, configured
 * in LOCAL_RECEIVER_FEEDS; a USB receiver opened in the browser stays in the
 * browser). Every 10 seconds (the layer polls every second); an aircraft is
 * recorded when it has a new position. Military aircraft are left out,
 * as in the flights feed (militaryHexes).
 */
import { HOUR, militaryHexes, round, text } from './_util.mjs';

const FT = 0.3048;
const KNOT_MPS = 0.514444;

export default {
  id: 'local-adsb',
  label: 'Local ADS-B receiver',
  layers: ['local-adsb'],
  kind: 'feed',
  class: 'personal',
  licence:
    "The owner's own receiver (ADS-B is an unauthenticated public broadcast)",
  cadenceMs: 10_000,
  phase: 2,
  bytesPerDay: 15e6,
  async poll({ fetch, services, state, now, signal }) {
    if (typeof fetch !== 'function')
      throw new Error('Local ADS-B needs the app API');
    const military = await militaryHexes(services, { now, signal });
    if (!military)
      throw new Error('HELD: NO MILITARY LIST TO SCREEN AIRCRAFT WITH');
    const response = await fetch('/api/local-receivers/aircraft', {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok)
      throw new Error(`Local receivers HTTP ${response.status}`);
    const body = await response.json();
    if (body?.configured === false)
      throw new Error('NO LOCAL RECEIVER: LOCAL_RECEIVER_FEEDS IS NOT SET');
    state.seen ??= new Map(); // icao|band → last position time recorded
    const t = now();
    const records = [];
    for (const r of Array.isArray(body?.records) ? body.records : []) {
      if (
        !r?.icao ||
        !Number.isFinite(r.lat) ||
        !Number.isFinite(r.lon) ||
        military.has(String(r.icao).toLowerCase())
      )
        continue;
      const key = `${r.icao}|${r.band}`;
      const positionAt = r.lastPositionAt ?? null;
      const previous = state.seen.get(key);
      if (previous && positionAt !== null && previous.positionAt === positionAt)
        continue;
      state.seen.delete(key);
      state.seen.set(key, { positionAt, at: t });
      records.push({
        hex: r.icao,
        callsign: text(r.callsign, 12),
        lat: round(r.lat, 5),
        lon: round(r.lon, 5),
        alt: Number.isFinite(r.altitudeFt) ? round(r.altitudeFt * FT, 0) : null,
        speed: Number.isFinite(r.groundSpeedKt)
          ? round(r.groundSpeedKt * KNOT_MPS, 1)
          : null,
        track: round(r.trackDeg, 0),
        vrate: Number.isFinite(r.verticalRateFpm)
          ? round((r.verticalRateFpm * FT) / 60, 1)
          : null,
        ground: r.onGround === true,
        band: r.band ?? null,
        rssi: round(r.rssiDbfs, 1),
        seen: positionAt,
      });
    }
    for (const [key, entry] of state.seen) {
      if (t - entry.at <= HOUR) break;
      state.seen.delete(key);
    }
    return { records };
  },
};
