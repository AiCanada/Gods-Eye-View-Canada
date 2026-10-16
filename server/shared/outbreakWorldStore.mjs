/**
 * Frozen world snapshots for world-model datasets (owner request
 * 2026-10-13): the epidemic model's places, routes and commuting, built once
 * from the Outbreak caches with no outbreak location, written in the format
 * of docs/WORLD-MODEL-DATA.md and read back for every scenario. One world,
 * many scenarios: node identity is the same in every episode.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gravityLinks } from '../../src/outbreakEpi.mjs';
import { RAIL_TRAVEL } from '../../src/outbreakEpi.mjs';
import {
  railVertexIndex,
  unpackRailGraph,
} from '../../src/outbreakNetwork.mjs';
import { RAIL_WORLD_VERSION } from '../../src/outbreakRailWorld.mjs';
import { npyBytes, parseNpy } from '../../src/outbreakEpiShard.mjs';
import { trackedPlaces, worldCountries } from '../../src/outbreakEpiTape.mjs';
import { runRailWorldTask } from '../providers/outbreakRailWorldTasks.mjs';
import { unpackRailRoutes } from '../providers/outbreakRailWorldTasks.mjs';
import { airportTable, cityTable } from '../providers/outbreak.js';
import {
  assembleEpidemicNetwork,
  scheduledWorld,
} from './outbreakEpidemicWorld.mjs';

export const WORLD_SCHEMA = 'gev-outbreak-world/1';
const KINDS = ['airport', 'city', 'origin'];
const SIZES = ['', 'M', 'L'];

/** A fetch that never reaches the network: snapshots are built offline. */
const offline = async () => {
  throw new Error('offline: the world snapshot reads the caches only');
};

/** The newest built world rail in `cacheDir/net-built`, or null. */
export function loadRailBuild(cacheDir) {
  const builtDir = path.join(cacheDir, 'net-built');
  let names = [];
  try {
    names = fs.readdirSync(builtDir);
  } catch {
    return null;
  }
  const prefix = `rail-world-v${RAIL_WORLD_VERSION}-`;
  const list = names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(builtDir, list[i]), 'utf8'),
      );
      const file = path.join(builtDir, list[i].replace(/\.json$/, '.bin'));
      if (meta?.version !== RAIL_WORLD_VERSION || !fs.existsSync(file))
        continue;
      const graph = unpackRailGraph(fs.readFileSync(file));
      return {
        file,
        meta,
        build: { file, builtAt: meta.builtAt },
        loaded: { file, graph, index: railVertexIndex(graph) },
      };
    } catch {
      /* the next older build */
    }
  }
  return null;
}

/** Commuting links as CSR arrays (and back). */
export function packLinkArrays(links) {
  const n = links.length;
  const offsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1)
    offsets[i + 1] = offsets[i] + (links[i]?.length || 0);
  const j = new Int32Array(offsets[n]);
  const share = new Float64Array(offsets[n]);
  for (let i = 0; i < n; i += 1)
    (links[i] || []).forEach((link, k) => {
      j[offsets[i] + k] = link.j;
      share[offsets[i] + k] = link.share;
    });
  return { offsets, j, share };
}
export function unpackLinkArrays({ offsets, j, share }) {
  const n = offsets.length - 1;
  const links = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const list = [];
    for (let k = offsets[i]; k < offsets[i + 1]; k += 1)
      list.push({ j: j[k], share: share[k] });
    links[i] = list;
  }
  return links;
}

/**
 * Build the world from the Outbreak caches (no network): every scheduled
 * airport, the GeoNames towns near an airport or on the world rail, the
 * daily air routes, the rail routes when the world rail is built, and the
 * gravity commuting.
 *
 * @param {object} options
 * @param {string} options.cacheDir `.gev-cache/outbreak`.
 * @param {number} [options.places] Tracked places.
 * @param {boolean} [options.rail] Use the world rail when built.
 * @param {number} [options.railSpeedKmh]
 * @param {(line: string) => void} [options.log]
 */
export async function buildWorldSnapshot({
  cacheDir,
  places = 5000,
  rail = true,
  railSpeedKmh = RAIL_TRAVEL.speedKmh,
  log = () => {},
}) {
  const t0 = Date.now();
  // now: 0 keeps any cached table "fresh": a snapshot never fetches.
  const table = airportTable({ cacheDir, fetchImpl: offline, now: () => 0 });
  const index = await table.index();
  const cityRows = await cityTable({
    cacheDir,
    fetchImpl: offline,
    now: () => 0,
  })
    .load()
    .catch(() => []);
  const globe = scheduledWorld(index);
  const railBuild = rail ? loadRailBuild(cacheDir) : null;
  const pkmFile = path.join(cacheDir, 'worldbank-rail-pkm.json');
  log(
    `tables: ${globe.airports.length} airports, ${cityRows.length} towns, rail ${railBuild ? railBuild.meta.builtAt : 'not built'}`,
  );
  const network = await assembleEpidemicNetwork({
    airports: globe.airports,
    byFrom: globe.byFrom,
    scheduled: index.scheduled,
    cityRows,
    locations: [],
    profile: {},
    scanFlights: [],
    startMs: 0,
    untilMs: 86_400_000,
    rail: {
      on: rail,
      build: railBuild ? railBuild.build : null,
      graph: railBuild ? railBuild.loaded : null,
      speedKmh: railSpeedKmh,
      passengerKm: async () => {
        try {
          return JSON.parse(fs.readFileSync(pkmFile, 'utf8'));
        } catch {
          return { pkm: {}, years: {} };
        }
      },
      meta: () => railBuild?.meta ?? null,
      task: async (job) => runRailWorldTask(railBuild.file, job),
      unpack: unpackRailRoutes,
      cache: null,
    },
  });
  log(
    `network: ${network.nodes.length} places, ${network.routes.length} routes (${network.railSource || 'rail'})`,
  );
  const links = gravityLinks(network.nodes);
  log(`commuting links worked out (${Math.round((Date.now() - t0) / 1000)} s)`);
  const { countries, countryOfNode } = worldCountries(network.nodes);
  const tracked = trackedPlaces(network.nodes, places);
  const sources = [];
  for (const name of [
    'airports-v2.json',
    'cities500-v1.json',
    'worldbank-rail-pkm.json',
  ]) {
    const file = path.join(cacheDir, name);
    try {
      const bytes = fs.readFileSync(file);
      sources.push({
        file: name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } catch {
      sources.push({ file: name, missing: true });
    }
  }
  if (railBuild) {
    const bytes = fs.readFileSync(railBuild.file);
    sources.push({
      file: path.relative(cacheDir, railBuild.file).replace(/\\/g, '/'),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return {
    nodes: network.nodes,
    routes: network.routes,
    flights: network.flights,
    flown: network.flown,
    links,
    tracked,
    countries,
    countryOfNode,
    meta: {
      railSource: network.railSource,
      railStats: network.railStats,
      railEstimated: network.railEstimated,
      rail: railBuild
        ? {
            builtAt: railBuild.meta.builtAt,
            version: RAIL_WORLD_VERSION,
            speedKmh: railSpeedKmh,
          }
        : null,
      sources,
      buildMs: Date.now() - t0,
    },
  };
}

/** The arrays of a world, by file name (everything hashed into worldId). */
function worldFiles(world) {
  const { nodes, routes, links, tracked, countries, countryOfNode } = world;
  const n = nodes.length;
  const trackedAt = new Int32Array(n).fill(-1);
  tracked.forEach((i, k) => {
    trackedAt[i] = k;
  });
  const nodeArray = new Float64Array(n * 8);
  nodes.forEach((node, i) => {
    const o = i * 8;
    nodeArray[o] = node.lat;
    nodeArray[o + 1] = node.lon;
    nodeArray[o + 2] = node.population || 0;
    nodeArray[o + 3] = Math.max(0, KINDS.indexOf(node.kind));
    nodeArray[o + 4] = Math.max(0, SIZES.indexOf(node.size || ''));
    nodeArray[o + 5] = countryOfNode[i];
    nodeArray[o + 6] = Number.isFinite(node.utcOffsetHours)
      ? node.utcOffsetHours
      : NaN;
    nodeArray[o + 7] = trackedAt[i];
  });
  const routeArray = new Float64Array(routes.length * 7);
  routes.forEach((r, k) => {
    const o = k * 7;
    routeArray[o] = r.from;
    routeArray[o + 1] = r.to;
    routeArray[o + 2] = r.timeOfDayMs;
    routeArray[o + 3] = r.lengthMs;
    routeArray[o + 4] = r.passengers;
    routeArray[o + 5] = r.mode === 'rail' ? 1 : 0;
    routeArray[o + 6] = Number.isFinite(r.km) ? r.km : NaN;
  });
  const packed = packLinkArrays(links);
  const utf8 = (value) => Buffer.from(JSON.stringify(value));
  return {
    'nodes.npy': npyBytes(nodeArray, [n, 8]),
    'node_ids.json': utf8({
      id: nodes.map((node) => node.id),
      code: nodes.map((node) => node.code || ''),
      name: nodes.map((node) => node.name || ''),
    }),
    'routes.npy': npyBytes(routeArray, [routes.length, 7]),
    'links_offsets.npy': npyBytes(packed.offsets, [n + 1]),
    'links_j.npy': npyBytes(packed.j, [packed.j.length]),
    'links_share.npy': npyBytes(packed.share, [packed.share.length]),
    'tracked.npy': npyBytes(Int32Array.from(tracked), [tracked.length]),
    'countries.json': utf8(countries),
  };
}

/**
 * Write a world under `root/<worldId>/`; worldId is the first 16 hex digits
 * of a sha256 over its files. An existing world with that id is kept.
 */
export function writeWorldSnapshot(world, root) {
  const files = worldFiles(world);
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) {
    hash.update(name);
    hash.update(files[name]);
  }
  const worldId = hash.digest('hex').slice(0, 16);
  const dir = path.join(root, worldId);
  if (fs.existsSync(path.join(dir, 'world.json')))
    return { worldId, dir, kept: true };
  // Written in place, world.json last: a folder without it is unfinished
  // (a rename of a fresh folder can fail on Windows while it is scanned).
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), bytes);
  const meta = {
    schema: WORLD_SCHEMA,
    worldId,
    builtAt: new Date().toISOString(),
    node: process.version,
    v8: process.versions.v8,
    counts: {
      nodes: world.nodes.length,
      routes: world.routes.length,
      railRoutes: world.routes.filter((r) => r.mode === 'rail').length,
      links: world.links.reduce((s, l) => s + (l?.length || 0), 0),
      tracked: world.tracked.length,
      countries: world.countries.length,
    },
    countries: world.countries,
    tracked: world.tracked.length,
    ...world.meta,
    classes: ['open'],
    licences: [
      'OurAirports airport table (public domain)',
      'GeoNames cities500 (CC BY 4.0): attribution required',
      'World Bank WDI IS.RRS.PASG.KM (CC BY 4.0): attribution required',
      'OpenStreetMap rail via OpenMapTiles and OpenFreeMap (ODbL 1.0): the rail routes are a derived database; share-alike if published',
    ],
  };
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(meta, null, 2));
  return { worldId, dir, kept: false };
}

/** Read a world back as the engine's inputs. */
export function loadWorldSnapshot(dir) {
  const read = (name) =>
    parseNpy(new Uint8Array(fs.readFileSync(path.join(dir, name))));
  const meta = JSON.parse(
    fs.readFileSync(path.join(dir, 'world.json'), 'utf8'),
  );
  const ids = JSON.parse(
    fs.readFileSync(path.join(dir, 'node_ids.json'), 'utf8'),
  );
  const countries = JSON.parse(
    fs.readFileSync(path.join(dir, 'countries.json'), 'utf8'),
  );
  const nodeArray = read('nodes.npy').data;
  const n = ids.id.length;
  const nodes = new Array(n);
  const countryOfNode = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i * 8;
    const node = {
      id: ids.id[i],
      code: ids.code[i],
      name: ids.name[i],
      lat: nodeArray[o],
      lon: nodeArray[o + 1],
      population: nodeArray[o + 2],
      kind: KINDS[nodeArray[o + 3]] || 'city',
      country: countries[nodeArray[o + 5]] || '',
    };
    const size = SIZES[nodeArray[o + 4]];
    if (size) node.size = size;
    if (Number.isFinite(nodeArray[o + 6]))
      node.utcOffsetHours = nodeArray[o + 6];
    nodes[i] = node;
    countryOfNode[i] = nodeArray[o + 5];
  }
  const routeArray = read('routes.npy').data;
  const routes = [];
  for (let o = 0; o < routeArray.length; o += 7) {
    const route = {
      from: routeArray[o],
      to: routeArray[o + 1],
      timeOfDayMs: routeArray[o + 2],
      lengthMs: routeArray[o + 3],
      passengers: routeArray[o + 4],
    };
    if (routeArray[o + 5] === 1) route.mode = 'rail';
    if (Number.isFinite(routeArray[o + 6])) route.km = routeArray[o + 6];
    routes.push(route);
  }
  const links = unpackLinkArrays({
    offsets: read('links_offsets.npy').data,
    j: read('links_j.npy').data,
    share: read('links_share.npy').data,
  });
  return {
    dir,
    meta,
    worldId: meta.worldId,
    nodes,
    routes,
    links,
    tracked: read('tracked.npy').data,
    countries,
    countryOfNode,
  };
}

/** The newest world under `root`, or null. */
export function latestWorld(root) {
  let best = null;
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(root, name, 'world.json'), 'utf8'),
      );
      if (!best || meta.builtAt > best.meta.builtAt)
        best = { dir: path.join(root, name), meta };
    } catch {
      /* not a world */
    }
  }
  return best;
}
