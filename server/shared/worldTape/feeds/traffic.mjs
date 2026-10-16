/**
 * World tape feed: TomTom flow around each area, through the layer's own
 * source (services.traffic → /api/tomtom, the proxy's 120 s tile cache and
 * daily tile budget). Without a TomTom key the layer is a simulation and no
 * real traffic exists, so nothing is recorded and the feed says why. The
 * recorder takes at most half the day's tile budget, leaving the rest to the
 * live layer, and asks every 30 minutes (at most 16 tiles an area).
 */
import {
  MINUTE,
  boxAround,
  haversineKm,
  requireAreas,
  round,
} from './_util.mjs';

const ZOOMS = [12, 11, 10, 9];
const DEFAULT_RADIUS_KM = 10;
const MAX_RADIUS_KM = 25;
/** The share of TomTom's daily tile budget the recorder may use. */
export const TRAFFIC_BUDGET_SHARE = 0.5;
const CONGESTED_LEVEL = 0.5;

function lineKm(coords) {
  let km = 0;
  for (let i = 1; i < coords.length; i += 1)
    km += haversineKm(
      { lat: coords[i - 1][1], lon: coords[i - 1][0] },
      { lat: coords[i][1], lon: coords[i][0] },
    );
  return km;
}

async function readFlow(traffic, box, signal) {
  for (const zoom of ZOOMS) {
    try {
      const flow = traffic.fetchFlowDetail
        ? await traffic.fetchFlowDetail(box, { zoom, signal })
        : {
            segments: await traffic.fetchFlowForBounds(box, { zoom, signal }),
            partial: false,
          };
      return { ...flow, zoom };
    } catch (error) {
      if (error?.code !== 'TILE_VIEW_TOO_WIDE') throw error;
    }
  }
  throw new Error('Area too large for traffic tiles');
}

export default {
  id: 'traffic',
  label: 'Road traffic (TomTom flow)',
  layers: ['traffic'],
  kind: 'feed',
  class: 'restricted',
  licence:
    'TomTom Traffic flow (TomTom terms; storage and derived use not licensed: local only)',
  cadenceMs: 30 * MINUTE,
  phase: 2,
  bytesPerDay: 20e6,
  async poll({ services, areas, signal }) {
    const status = await services.traffic.getStatus({ signal });
    if (!status.hasKey) throw new Error('NO TOMTOM KEY: SIMULATED ONLY');
    if (
      Number.isFinite(status.budget) &&
      status.budget > 0 &&
      Number.isFinite(status.dailyCount) &&
      status.dailyCount >= status.budget * TRAFFIC_BUDGET_SHARE
    )
      throw new Error('TOMTOM DAILY TILE SHARE USED: LEFT FOR THE LIVE LAYER');
    const list = requireAreas(areas, { max: 8 });
    const records = [];
    let answered = 0;
    let failure = null;
    for (const area of list) {
      const radius = Math.min(
        MAX_RADIUS_KM,
        area.radiusKm ?? DEFAULT_RADIUS_KM,
      );
      try {
        const flow = await readFlow(
          services.traffic,
          boxAround(area, radius),
          signal,
        );
        answered += 1;
        let measuredKm = 0;
        let weighted = 0;
        let congestedKm = 0;
        let closedKm = 0;
        for (const segment of flow.segments || []) {
          if (!Array.isArray(segment?.coords) || segment.coords.length < 2)
            continue;
          const km = lineKm(segment.coords);
          if (segment.closure) closedKm += km;
          if (Number.isFinite(segment.trafficLevel)) {
            measuredKm += km;
            weighted += segment.trafficLevel * km;
            if (segment.trafficLevel < CONGESTED_LEVEL) congestedKm += km;
          }
          records.push({
            area: area.name,
            kind: 'segment',
            category: segment.roadCategory ?? null,
            subcategory: segment.roadSubcategory ?? null,
            level: round(segment.trafficLevel, 3),
            closure: segment.closure === true,
            km: round(km, 3),
            coords: segment.coords.map(([lon, lat]) => [
              round(lon, 5),
              round(lat, 5),
            ]),
          });
        }
        records.push({
          area: area.name,
          kind: 'area',
          lat: area.lat,
          lon: area.lon,
          radiusKm: radius,
          zoom: flow.zoom,
          partial: flow.partial === true,
          measuredKm: round(measuredKm, 2),
          congestedKm: round(congestedKm, 2),
          closedKm: round(closedKm, 2),
          speedShare: measuredKm > 0 ? round(weighted / measuredKm, 3) : null,
        });
      } catch (error) {
        failure ??= error;
      }
    }
    if (!answered && failure) throw failure;
    return { records };
  },
};
