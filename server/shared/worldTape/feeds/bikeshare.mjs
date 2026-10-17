/**
 * World tape feed: station availability for every registered GBFS system
 * (services.bikeshare → /api/gbfs, the proxy's host allowlist and size
 * limits). A snapshot every 5 minutes (the layer polls every minute);
 * station positions are reread hourly.
 *
 * The tape shares /api/gbfs with the page's own bike-share layer, and the
 * proxy allows 120 requests a minute per client (upstream #690). The
 * registry has 52 systems since the 2026-10-17 merge, so a poll that also
 * rereads positions makes about 104 requests: the tape keeps itself to half
 * the proxy's rate and leaves the rest to the page.
 */
import {
  parseStationInformation,
  parseStationStatus,
} from '../../../../src/sources/gbfsStations.js';
import { HOUR, MINUTE, round } from './_util.mjs';

/** Requests the tape sends to /api/gbfs in any one minute, at most. */
const TAPE_GBFS_PER_MINUTE = 60;

/** Wait (wall clock) until one more request fits this minute's share. */
async function pace(state, signal) {
  const sent = (state.sent ??= []);
  for (;;) {
    const t = Date.now();
    while (sent.length && t - sent[0] >= MINUTE) sent.shift();
    if (sent.length < TAPE_GBFS_PER_MINUTE) {
      sent.push(t);
      return;
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, MINUTE - (t - sent[0]) + 5);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('aborted'));
        },
        { once: true },
      );
    });
  }
}

export default {
  id: 'bikeshare',
  label: 'Bike-share stations (GBFS)',
  layers: ['bikeshare'],
  kind: 'feed',
  class: 'open',
  licence:
    'GBFS feeds per operator (Lyft, BCycle and others; attribution to each operator and its license_url)',
  cadenceMs: 5 * MINUTE,
  phase: 1,
  // 50 MB a day for the 19 systems before the merge, scaled to 52.
  bytesPerDay: 140e6,
  async poll({ services, state, now, signal }) {
    const { systems, getStations } = services.bikeshare;
    state.info ??= new Map(); // system id → { at, stations }
    const t = now();
    const records = [];
    let answered = 0;
    let failure = null;
    for (const system of systems || []) {
      try {
        let info = state.info.get(system.id);
        if (!info || t - info.at > HOUR) {
          await pace(state, signal);
          info = {
            at: t,
            stations: parseStationInformation(
              await getStations(system.stationInformationUrl, { signal }),
            ),
          };
          state.info.set(system.id, info);
        }
        await pace(state, signal);
        const status = parseStationStatus(
          await getStations(system.stationStatusUrl, { signal }),
        );
        answered += 1;
        for (const [stationId, live] of status) {
          const station = info.stations.get(stationId);
          if (!station) continue;
          records.push({
            system: system.id,
            station: stationId,
            lat: round(station.lat, 6),
            lon: round(station.lon, 6),
            bikes: live.bikesAvailable,
            docks: live.docksAvailable,
            capacity: station.capacity,
            renting: live.isRenting,
            returning: live.isReturning,
            reported: Number.isFinite(live.lastReported)
              ? live.lastReported * 1000
              : null,
          });
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (!answered && failure) throw failure;
    return { records };
  },
};
