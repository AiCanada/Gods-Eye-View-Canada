/**
 * The world rail network's work, run in worker threads
 * (outbreakRailWorld.js, railWorldTaskInWorker) so the dev server keeps
 * answering (owner ruling 2026-10-12: every rail line on the globe, in the
 * outbreak sim):
 *
 *  - build: every tile's rail extract into one world network
 *    (buildRailGraph), written packed beside a tmp name and renamed;
 *  - network: the rail reach from one outbreak location, along the whole
 *    world network, with the finer lines near it laid over;
 *  - air: the rail lit from every landing, by the hour;
 *  - routes: the epidemic model's daily rail routes between its places.
 *
 * Each answer has the shape the fallback (buildTransportNetwork) gives, so
 * the page reads both alike.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  NETWORK_BAND_KM,
  NETWORK_JOIN_KM,
  buildRailGraph,
  mergeRailOverlay,
  packRailGraph,
  railComponents,
  railDistances,
  railGraphPieces,
  railPlaceLinks,
  railTimedReach,
  railVertexIndex,
  tileBounds,
  unpackRailGraph,
} from '../../src/outbreakNetwork.mjs';
import {
  CONTINENTS,
  RAIL_WORLD_ZOOM,
  clipLinesToBox,
  continentOf,
  countryLookup,
  countryShapes,
  landJoinOk,
  railExtractLines,
  railWorldTiles,
} from '../../src/outbreakRailWorld.mjs';
import { railRoutes } from '../../src/outbreakEpi.mjs';

/** The km of line reached, by continent (where both ends are reached). */
function reachedByContinent(graph, value) {
  const out = Object.fromEntries(CONTINENTS.map((c) => [c, 0]));
  const { pathOffsets, pathVerts, lat, lon, country, countries } = graph;
  const km = (a, b) => {
    const toRad = Math.PI / 180;
    const dLat = (lat[b] - lat[a]) * toRad;
    const dLon = (lon[b] - lon[a]) * toRad;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat[a] * toRad) *
        Math.cos(lat[b] * toRad) *
        Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  for (let p = 0; p + 1 < pathOffsets.length; p += 1)
    for (let i = pathOffsets[p] + 1; i < pathOffsets[p + 1]; i += 1) {
      const a = pathVerts[i - 1];
      const b = pathVerts[i];
      if (!Number.isFinite(value[a]) || !Number.isFinite(value[b])) continue;
      const continent = continentOf(countries?.[country[a]] || '', lon[a]);
      if (continent in out) out[continent] += km(a, b);
    }
  for (const c of Object.keys(out)) out[c] = Math.round(out[c]);
  return out;
}

function loadGraph(file) {
  return unpackRailGraph(fs.readFileSync(file));
}

function buildWorld(file, task) {
  const countries = JSON.parse(fs.readFileSync(task.countriesFile, 'utf8'));
  // Each point's country by outline where a tile is shared, and no join
  // over open sea (2026-10-12).
  const shapes = countryShapes(countries);
  const countryAt = countryLookup(railWorldTiles(countries), { shapes });
  const lines = [];
  for (const name of task.tiles) {
    try {
      const extract = JSON.parse(
        fs.readFileSync(path.join(task.extractDir, `${name}.json`), 'utf8'),
      );
      // Cut at the tile's own edges, so no stretch is counted twice.
      const [x, y] = name.split('_').map(Number);
      const own = railExtractLines(extract);
      const cut =
        Number.isInteger(x) && Number.isInteger(y)
          ? clipLinesToBox(own, tileBounds(RAIL_WORLD_ZOOM, x, y))
          : own;
      for (const line of cut) lines.push(line);
    } catch {
      /* A tile that went missing is left out of this build. */
    }
  }
  const graph = buildRailGraph(lines, {
    joinKm: NETWORK_JOIN_KM.rail,
    countryAt,
    joinOk: landJoinOk((lat, lon) => shapes.onLand(lat, lon)),
  });
  // Km by continent, Russia split at the Urals by each line's own place.
  const all = new Float64Array(graph.lon.length).fill(0);
  const byContinent = reachedByContinent(graph, all);
  const meta = {
    version: task.version,
    builtAt: task.builtAt,
    tiles: task.tiles.length,
    lengthKm: graph.lengthKm,
    joinedKm: graph.joinedKm,
    // The closest joins refused as mostly over open sea (2026-10-12).
    refusedJoins: graph.refusedJoins,
    vertices: graph.lon.length,
    byCountry: graph.byCountry,
    byContinent,
  };
  const bytes = packRailGraph(graph, meta);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
  return meta;
}

/** From one outbreak location: km along the rail, the whole world over. */
function reachFrom(file, task) {
  const world = loadGraph(file);
  const worldIndex = railVertexIndex(world);
  const graph = task.overlay?.length
    ? mergeRailOverlay(world, task.overlay, { index: worldIndex })
    : world;
  const index = graph === world ? worldIndex : railVertexIndex(graph);
  const hit = index.nearest(task.point, task.startKm);
  if (!hit) return { network: null };
  const dist = railDistances(graph, [{ vertex: hit[0], startKm: hit[1] }]);
  // Rail is never drawn grey (owner 2026-10-12: "no grey on rail lines"),
  // so rail this place cannot reach by train is not sent.
  const { bands, lit, reachedKm } = railGraphPieces(graph, dist);
  return {
    network: {
      bandKm: NETWORK_BAND_KM,
      startKm: Math.round(hit[1] * 10) / 10,
      bands,
      lit,
      unreached: [],
      reachedKm: Math.round(reachedKm),
      lengthKm: Math.round(graph.lengthKm || 0),
      overlayKm: Math.round(graph.overlayKm || 0),
      world: true,
      byContinent: reachedByContinent(graph, dist),
    },
  };
}

/** From every landing, by the hour each stretch is first reached. */
function reachAfterLandings(file, task) {
  const world = loadGraph(file);
  const worldIndex = railVertexIndex(world);
  const graph = task.overlay?.length
    ? mergeRailOverlay(world, task.overlay, { index: worldIndex })
    : world;
  const index = graph === world ? worldIndex : railVertexIndex(graph);
  const seeds = [];
  for (const source of task.sources) {
    const hit = index.nearest(source, task.startKm);
    if (hit) seeds.push({ vertex: hit[0], startKm: hit[1], hour: source.hour });
  }
  if (!seeds.length) return { network: null, seeded: 0 };
  const { time, dist } = railTimedReach(graph, seeds, task.timing);
  const { bands, lit, reachedKm } = railGraphPieces(graph, time, {
    dist,
    timed: true,
  });
  return {
    network: {
      bandsBy: 'hour',
      bands,
      lit,
      unreached: [],
      lastHour: Math.round(reachedKm * 10) / 10,
      lengthKm: Math.round(graph.lengthKm || 0),
      seeded: seeds.length,
      world: true,
      byContinent: reachedByContinent(graph, time),
    },
    seeded: seeds.length,
  };
}

/** The epidemic model's daily rail routes (railRoutes), packed. */
function routesBetween(file, task) {
  const graph = loadGraph(file);
  const index = railVertexIndex(graph);
  const comp = railComponents(graph);
  const { lat, lon, population, country, id } = task.nodes;
  const n = lat.length;
  const nodes = new Array(n);
  const vertexOf = new Int32Array(n).fill(-1);
  const componentOf = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    nodes[i] = {
      id: id[i],
      lat: lat[i],
      lon: lon[i],
      population: population[i],
      country: country[i],
    };
    const hit = index.nearest(nodes[i], task.reachKm);
    if (hit) {
      vertexOf[i] = hit[0];
      componentOf[i] = comp[hit[0]];
    }
  }
  const { routes, stats } = railRoutes(
    nodes,
    {
      vertexOf,
      componentOf,
      placeLinks: (seeds) => railPlaceLinks(graph, seeds),
    },
    task.countryPkm,
    { speedKmh: task.speedKmh },
  );
  const m = routes.length;
  const packed = {
    from: new Int32Array(m),
    to: new Int32Array(m),
    timeOfDayMs: new Float64Array(m),
    lengthMs: new Float64Array(m),
    passengers: new Float64Array(m),
    km: new Float64Array(m),
  };
  routes.forEach((r, k) => {
    packed.from[k] = r.from;
    packed.to[k] = r.to;
    packed.timeOfDayMs[k] = r.timeOfDayMs;
    packed.lengthMs[k] = r.lengthMs;
    packed.passengers[k] = r.passengers;
    packed.km[k] = r.km;
  });
  return { routes: packed, stats };
}

/** One task: `build`, `network`, `air` or `routes`. */
export function runRailWorldTask(file, task) {
  if (task?.kind === 'build') return buildWorld(file, task);
  if (task?.kind === 'network') return reachFrom(file, task);
  if (task?.kind === 'air') return reachAfterLandings(file, task);
  if (task?.kind === 'routes') return routesBetween(file, task);
  throw new Error(`Unknown world rail task: ${task?.kind}`);
}

/** The packed routes back as the model's route objects (mode 'rail'). */
export function unpackRailRoutes(packed) {
  const out = [];
  const m = packed?.from?.length || 0;
  for (let k = 0; k < m; k += 1)
    out.push({
      from: packed.from[k],
      to: packed.to[k],
      timeOfDayMs: packed.timeOfDayMs[k],
      lengthMs: packed.lengthMs[k],
      passengers: packed.passengers[k],
      km: packed.km[k],
      mode: 'rail',
    });
  return out;
}
