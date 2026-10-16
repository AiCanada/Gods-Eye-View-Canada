/**
 * World tape feed: every aircraft in the worldwide flights snapshot, through
 * the layer's own source (services.aircraft → /api/flights), so the OpenSky
 * proxy's cache and credit governor apply. With an area selected, the
 * request carries its point, which the proxy uses only for its adsb.lol
 * regional fallback when OpenSky is stale or down.
 *
 * Cadence: one snapshot every 5 minutes, the governor's own slowest tier.
 * The global /states/all costs 4 credits of OpenSky's ~4,000 a day, so the
 * recorder alone spends at most 288 calls (1,152 credits) a day and leaves
 * the live layer most of the budget. Anonymous OpenSky (the proxy reports
 * `X-OpenSky-Auth-Mode-Used: anon`) has only ~400 credits a day, so there a
 * snapshot holds the feed back for an hour: at most 24 calls (96 credits).
 * The same upstream snapshot is recorded once, and a stale one (the proxy's
 * last copy while OpenSky rate-limits) holds the feed back for 15 minutes.
 * OpenSky rows carry the auth mode the proxy used (`auth`).
 *
 * Military aircraft are left out (militaryHexes): the app's military list
 * screens every row first, and with no list to screen with the poll is held
 * (an error, so the hour does not read as observed).
 */
import {
  HOUR,
  MINUTE,
  militaryHexes,
  noteFlightHexes,
  round,
  validAreas,
} from './_util.mjs';

const STALE_HOLD_MS = 15 * MINUTE;
const ANONYMOUS_HOLD_MS = HOUR;
/** The OpenSky auth modes worth recording on a row. */
const AUTH_MODES = new Set(['anon', 'basic', 'oauth']);

export default {
  id: 'flights',
  label: 'Flights (worldwide)',
  layers: ['flights'],
  kind: 'feed',
  // The feed mixes OpenSky (non-commercial) and adsb.lol (ODbL); records
  // from adsb.lol carry their own open class.
  class: 'nc',
  licence:
    'OpenSky Network (non-commercial research/education licence); adsb.lol regional fallback (ODbL 1.0)',
  cadenceMs: 5 * MINUTE,
  phase: 1,
  bytesPerDay: 75e6,
  async poll({ services, areas, state, now, signal }) {
    const t = now();
    if (state.holdUntil > t) return {};
    const military = await militaryHexes(services, { now, signal });
    if (!military)
      throw new Error('HELD: NO MILITARY LIST TO SCREEN AIRCRAFT WITH');
    const anchor = validAreas(areas)[0];
    const snapshot = await services.aircraft.getSnapshot(
      anchor ? { latitude: anchor.lat, longitude: anchor.lon } : {},
      { signal },
    );
    const auth = AUTH_MODES.has(snapshot.authModeUsed)
      ? snapshot.authModeUsed
      : null;
    if (auth === 'anon') state.holdUntil = t + ANONYMOUS_HOLD_MS;
    if (snapshot.stale === true) {
      state.holdUntil = Math.max(state.holdUntil || 0, t + STALE_HOLD_MS);
      return {};
    }
    const adsbLol = /adsb\.lol/i.test(String(snapshot.source || ''));
    const key = `${adsbLol ? 'adsb.lol' : 'opensky'}|${snapshot.observedAtMs}`;
    if (snapshot.observedAtMs != null && state.lastSnapshot === key) return {};
    state.lastSnapshot = key;
    const records = [];
    for (const r of snapshot.records || []) {
      if (
        !r?.id ||
        !Number.isFinite(r.latitude) ||
        !Number.isFinite(r.longitude) ||
        military.has(String(r.id).toLowerCase())
      )
        continue;
      records.push({
        hex: r.id,
        callsign: r.callsign || null,
        lat: round(r.latitude, 5),
        lon: round(r.longitude, 5),
        alt: round(r.baroAltitudeM ?? r.ellipsoidAltitudeM, 0),
        speed: round(r.speedMps, 1),
        track: round(r.courseDeg, 0),
        vrate: round(r.verticalRateMps, 1),
        ground: r.onGround === true,
        source: adsbLol ? 'adsb.lol' : 'opensky',
        ...(auth && !adsbLol ? { auth } : {}),
        seen: r.positionTimeMs ?? r.contactTimeMs ?? null,
        ...(r.originCountry ? { country: r.originCountry } : {}),
        ...(adsbLol ? { class: 'open', licence: 'adsb.lol (ODbL 1.0)' } : {}),
      });
    }
    noteFlightHexes(
      records.map((record) => record.hex),
      t,
    );
    return { records };
  },
};
