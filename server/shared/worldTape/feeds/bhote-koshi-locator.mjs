/**
 * World tape snapshot: what the Bhote Koshi locator draws, from its bundled
 * data (the mapped flood path and the incident's overview places). No live
 * data and no request: checked once a day and recorded only when it changed.
 */
import { BHOTE_KOSHI_FLOOD_PATH } from '../../../../src/data/bhoteKoshiFloodPath.js';
import { INCIDENT_OVERVIEW_PLACES } from '../../../../src/data/bhoteKoshiIncidentPlaces.js';
import { DAY, haversineKm, hashOf, round } from './_util.mjs';

export default {
  id: 'bhote-koshi-locator',
  label: 'Bhote Koshi locator',
  layers: ['bhote-koshi-locator'],
  kind: 'static',
  class: 'nc',
  licence:
    'GeoPera river centreline (CC BY-NC 4.0; Planet Labs PBC / Vantor open data); incident places from the event pack',
  cadenceMs: DAY,
  phase: 2,
  bytesPerDay: 0.01e6,
  async poll({ state }) {
    const path = BHOTE_KOSHI_FLOOD_PATH.map(([lon, lat]) => [
      round(lon, 6),
      round(lat, 6),
    ]);
    let km = 0;
    for (let i = 1; i < path.length; i += 1)
      km += haversineKm(
        { lat: path[i - 1][1], lon: path[i - 1][0] },
        { lat: path[i][1], lon: path[i][0] },
      );
    const records = [
      ...INCIDENT_OVERVIEW_PLACES.map((place) => ({
        kind: 'place',
        id: place.id,
        label: place.title,
        lat: round(place.lat, 7),
        lon: round(place.lon, 7),
      })),
      { kind: 'flood-path', points: path.length, km: round(km, 2), path },
    ];
    const sig = hashOf(records);
    if (state.sig === sig) return {};
    state.sig = sig;
    return { records };
  },
};
