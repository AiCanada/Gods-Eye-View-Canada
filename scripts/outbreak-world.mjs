#!/usr/bin/env node
/**
 * Build a frozen world for world-model datasets (owner request 2026-10-13):
 * the epidemic model's places, routes and commuting, from the Outbreak
 * caches only (no network), written to
 * .gev-data/outbreak/worlds/<worldId>/ (docs/WORLD-MODEL-DATA.md).
 *
 *   node scripts/outbreak-world.mjs [--cache .gev-cache/outbreak]
 *     [--out .gev-data/outbreak/worlds] [--places 5000] [--no-rail]
 *     [--speed 60]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './project-root.mjs';
import {
  buildWorldSnapshot,
  writeWorldSnapshot,
} from '../server/shared/outbreakWorldStore.mjs';

export function parseArgs(argv, root = projectRoot(import.meta.url)) {
  const options = {
    cache: path.join(root, '.gev-cache', 'outbreak'),
    out: path.join(root, '.gev-data', 'outbreak', 'worlds'),
    places: 5000,
    rail: true,
    speed: 60,
  };
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    const next = () => argv[(k += 1)];
    if (arg === '--cache') options.cache = path.resolve(root, next());
    else if (arg === '--out') options.out = path.resolve(root, next());
    else if (arg === '--places')
      options.places = Math.max(1, Number(next()) | 0);
    else if (arg === '--no-rail') options.rail = false;
    else if (arg === '--speed')
      options.speed = Math.max(1, Number(next()) || 60);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const world = await buildWorldSnapshot({
    cacheDir: options.cache,
    places: options.places,
    rail: options.rail,
    railSpeedKmh: options.speed,
    log: (line) => console.log(`[world] ${line}`),
  });
  const { worldId, dir, kept } = writeWorldSnapshot(world, options.out);
  console.log(
    `[world] ${kept ? 'kept' : 'wrote'} ${worldId}: ${world.nodes.length} places, ${world.routes.length} routes, ${world.tracked.length} tracked, ${world.countries.length - 1} countries → ${dir}`,
  );
  return { worldId, dir };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(`[world] ${error.message}`);
    process.exitCode = 1;
  });
