/**
 * The epidemic model's world: its places, the scan's flights, every daily
 * air route and, once the world rail is built, the rail routes between the
 * towns on it. Moved out of the Outbreak route (server/providers/outbreak.js,
 * answerEpidemic) unchanged, so the route and the world-model dataset tools
 * (scripts/outbreak-world.mjs, owner request 2026-10-13) build the same
 * world from the same tables.
 */
import { RAIL_REACH_KM, distanceKm } from '../../src/outbreakCore.mjs';
import {
  RAIL_TRAVEL,
  buildEpidemicNodes,
  flightPassengers,
  railCountryVolumes,
  seedFromText,
  worldAirRoutes,
} from '../../src/outbreakEpi.mjs';
import { continentOf } from '../../src/outbreakRailWorld.mjs';

/** An airport as the routes and the model show it. */
export function airportView(row, from) {
  return {
    code: row.code,
    iata: row.iata,
    name: row.name,
    city: row.city,
    country: row.country,
    continent: row.continent || '',
    lat: row.lat,
    lon: row.lon,
    ...(from ? { km: Math.round(distanceKm(from, row)) } : {}),
  };
}

/**
 * Every scheduled airport and its normal daily routes (owner ruling
 * 2026-10-09: every airport), from the airport table's index.
 */
export function scheduledWorld(index) {
  const airports = index.allScheduled.map((row) => ({
    ...airportView(row),
    code: row.code,
    kind: row.kind,
  }));
  const byFrom = new Map();
  for (const route of worldAirRoutes(airports, index.scheduled)) {
    if (!byFrom.has(route.from)) byFrom.set(route.from, []);
    byFrom.get(route.from).push(route);
  }
  return { airports, byFrom };
}

/**
 * Build the places and routes.
 *
 * @param {object} input
 * @param {object[]} input.airports Every scheduled airport, then the scan's
 *   extra ones (airport views).
 * @param {Map<string, object[]>} input.byFrom Normal daily routes by origin
 *   airport code.
 * @param {object[]} input.scheduled The scheduled large and medium airports.
 * @param {object[]} input.cityRows GeoNames towns (or none).
 * @param {object[]} input.locations Outbreak locations.
 * @param {object} input.profile The cleaned profile.
 * @param {object[]} input.scanFlights The scan's flights (airport views).
 * @param {number} input.startMs
 * @param {number} input.untilMs
 * @param {object|null} input.rail With the world rail on: `{ on, build,
 *   graph, speedKmh, passengerKm(), meta(), task(job), unpack(packed),
 *   cache, cacheMax }`; `build` null until it is built.
 */
export async function assembleEpidemicNetwork({
  airports,
  byFrom,
  scheduled,
  cityRows,
  locations,
  profile,
  scanFlights,
  startMs,
  untilMs,
  rail = null,
}) {
  const railBuild = rail?.on ? rail.build || null : null;
  // Towns on the world rail are places too, however far from an airport
  // (owner ruling 2026-10-12).
  const railGraph = railBuild ? rail.graph : null;
  const { nodes, origins } = buildEpidemicNodes({
    airports,
    cities: cityRows,
    locations,
    profile,
    railNear: railGraph
      ? (lat, lon) =>
          Boolean(railGraph.index.nearest({ lat, lon }, RAIL_REACH_KM))
      : null,
  });
  const at = new Map(nodes.map((node, i) => [node.id, i]));
  const flights = [];
  const flown = [];
  const routes = [];
  const flows = new Map();
  const scanDays = Math.max(1, (untilMs - startMs) / 86_400_000);
  const flow = (fromCode, toCode, perDay) => {
    if (!flows.has(fromCode)) flows.set(fromCode, new Map());
    const out = flows.get(fromCode);
    out.set(toCode, (out.get(toCode) || 0) + perDay);
  };
  // The scan's flights, each flown once on its own day.
  for (const f of scanFlights) {
    const from = at.get(f.from.code);
    const to = at.get(f.to.code);
    if (from === undefined || to === undefined) continue;
    const passengers = flightPassengers(distanceKm(f.from, f.to), 1);
    flights.push({
      from,
      to,
      departMs: f.departMs,
      arriveMs: f.arriveMs,
      passengers,
    });
    flown.push(`${from}>${to}|${Math.round(f.departMs / 1_800_000)}`);
    flow(f.from.code, f.to.code, passengers / scanDays);
  }
  // Daily routes: the scan's, then every other airport's normal traffic.
  const scanned = new Set(scanFlights.map((f) => f.from.code));
  const daily = [
    ...worldAirRoutes([], scheduled, scanFlights),
    ...[...byFrom]
      .filter(([code]) => !scanned.has(code))
      .flatMap(([, list]) => list),
  ];
  for (const r of daily) {
    const from = at.get(r.from);
    const to = at.get(r.to);
    if (from === undefined || to === undefined) continue;
    routes.push({ ...r, from, to });
    flow(r.from, r.to, r.passengers);
  }
  // Rail travel between the places on the world rail (RAIL_TRAVEL, owner
  // ruling 2026-10-12), worked out in a worker and kept by the places.
  // Until the world rail is built the model runs as before and says so.
  let railSource = rail?.on ? (railBuild ? '' : 'pending') : 'off';
  let railStats = null;
  let railEstimated = [];
  if (railBuild) {
    try {
      const table = await rail.passengerKm();
      const { pkm, estimated } = railCountryVolumes(
        table.pkm,
        rail.meta()?.byCountry || {},
        (code) => continentOf(code),
      );
      railEstimated = estimated;
      const railKey = seedFromText(
        JSON.stringify([
          railBuild.builtAt,
          rail.speedKmh,
          pkm,
          nodes.map((node) => [node.id, node.population, node.lat, node.lon]),
        ]),
      );
      let packed = rail.cache?.get(railKey);
      if (!packed || packed.places !== nodes.length) {
        packed = await rail.task({
          kind: 'routes',
          nodes: {
            id: nodes.map((node) => node.id),
            lat: Float64Array.from(nodes, (node) => node.lat),
            lon: Float64Array.from(nodes, (node) => node.lon),
            population: Float64Array.from(
              nodes,
              (node) => node.population || 0,
            ),
            country: nodes.map((node) => node.country || ''),
          },
          countryPkm: pkm,
          speedKmh: rail.speedKmh,
          reachKm: RAIL_REACH_KM,
        });
        packed.places = nodes.length;
        if (rail.cache) {
          rail.cache.set(railKey, packed);
          while (rail.cache.size > (rail.cacheMax ?? Infinity))
            rail.cache.delete(rail.cache.keys().next().value);
        }
      }
      for (const r of rail.unpack(packed.routes)) {
        if (!(r.from < nodes.length && r.to < nodes.length)) continue;
        routes.push(r);
        flow(nodes[r.from].id, nodes[r.to].id, r.passengers);
      }
      railStats = packed.stats;
      railSource = `${RAIL_TRAVEL.volumeSource}${estimated.length ? ` (estimated from the continent's median passenger-km per km of line for ${estimated.length} countries)` : ''}; ${RAIL_TRAVEL.shapeSource}; ${RAIL_TRAVEL.networkSource}`;
    } catch (error) {
      railSource = `failed: ${error.message || 'the rail routes did not build'}`;
    }
  }
  return {
    nodes,
    origins,
    at,
    flights,
    flown,
    routes,
    flows,
    railSource,
    railStats,
    railEstimated,
  };
}
