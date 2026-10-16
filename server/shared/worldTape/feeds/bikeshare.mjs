/**
 * World tape feed: station availability for every registered GBFS system
 * (services.bikeshare → /api/gbfs, the proxy's host allowlist and size
 * limits). A snapshot every 5 minutes (the layer polls every minute);
 * station positions are reread hourly.
 */
import {
  parseStationInformation,
  parseStationStatus,
} from '../../../../src/sources/gbfsStations.js';
import { HOUR, MINUTE, round } from './_util.mjs';

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
  bytesPerDay: 50e6,
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
          info = {
            at: t,
            stations: parseStationInformation(
              await getStations(system.stationInformationUrl, { signal }),
            ),
          };
          state.info.set(system.id, info);
        }
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
