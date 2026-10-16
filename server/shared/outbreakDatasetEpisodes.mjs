/**
 * One shard of a world-model dataset (owner request 2026-10-13): each
 * scenario of the shard sampled, run with a tape (and its comparison arm on
 * the same random stream), and written as WebDataset samples. Used by the
 * dataset worker threads and by tests in-process.
 */
import path from 'node:path';
import {
  counterfactualParams,
  epiParameters,
  simulateEpidemic,
} from '../../src/outbreakEpi.mjs';
import { policyFor } from '../../src/outbreakEpiActions.mjs';
import {
  exportScenario,
  sampleScenario,
} from '../../src/outbreakEpiScenarios.mjs';
import { episodeMembers } from '../../src/outbreakEpiShard.mjs';
import { createEpisodeTape } from '../../src/outbreakEpiTape.mjs';
import { createShardWriter } from './outbreakDatasetWriter.mjs';
import { createBinsDrivers } from './outbreakDatasetDrivers.mjs';
import { exportBase, readExport } from './outbreakExportScenario.mjs';

export const SHARD_DIGITS = 6;
export const shardName = (shard) =>
  `shard-${String(shard).padStart(SHARD_DIGITS, '0')}.tar.gz`;
export const episodeKey = (scenario, run, arm) =>
  `s${String(scenario).padStart(6, '0')}-r${String(run).padStart(2, '0')}-${arm}`;

// Per thread: each world's recorded conditions, its day summaries cached.
const binsSources = new Map();
function binsSourceFor(world, drivers) {
  const key = `${drivers.binsRoot}|${world.worldId}|${(drivers.startDays || []).join(',')}`;
  if (!binsSources.has(key))
    binsSources.set(
      key,
      createBinsDrivers({
        binsRoot: drivers.binsRoot,
        world,
        days: drivers.startDays,
      }),
    );
  return binsSources.get(key);
}

// Per thread: a downloaded run's scenario on each world, checked against
// the sha256 the sweep recorded when it started.
const exportBases = new Map();
function exportBaseFor(world, fromExport) {
  const key = `${fromExport.file}|${fromExport.sha256}|${world.worldId}`;
  if (!exportBases.has(key)) {
    const { doc, sha256 } = readExport(fromExport.file);
    if (sha256 !== fromExport.sha256)
      throw new Error(
        `${fromExport.file} changed since the sweep started (sha256 ${sha256.slice(0, 12)}…, expected ${fromExport.sha256.slice(0, 12)}…)`,
      );
    exportBases.set(key, exportBase(doc, world));
  }
  return exportBases.get(key);
}

/** The scenarios of a shard: a fixed slice, whatever the scheduling. */
export function shardScenarios(shard, perShard, total) {
  const from = shard * perShard;
  const to = Math.min(total, from + perShard);
  return Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
}

/**
 * Write one shard. Returns its index lines and sizes.
 *
 * @param {object} world loadWorldSnapshot()
 * @param {object} spec The dataset spec (seed, runs, days, scenarios,
 *   perShard, compareShare, policyMix, originWeights; drivers: {binsRoot,
 *   startDays} to start on recorded days under recorded conditions).
 */
export async function writeShard(world, spec, shard, shardsDir) {
  const binned = spec.drivers ? binsSourceFor(world, spec.drivers) : null;
  if (binned && !binned.startDays.length)
    throw new Error(
      `No binned days for world ${world.worldId}: run npm run world-tape:bin first.`,
    );
  const base = spec.fromExport ? exportBaseFor(world, spec.fromExport) : null;
  const file = path.join(shardsDir, shardName(shard));
  const writer = createShardWriter(file);
  const lines = [];
  const started = Date.now();
  let episodes = 0;
  try {
    const pool = Array.from(world.tracked);
    for (const k of shardScenarios(shard, spec.perShard, spec.scenarios)) {
      const scenario = base
        ? exportScenario(k, base, {
            seed: spec.seed,
            policyMix: spec.policyMix,
          })
        : sampleScenario(k, {
            seed: spec.seed,
            originPool: pool,
            originWeights:
              spec.originWeights ??
              pool.map((i) =>
                Math.sqrt(Math.max(1, world.nodes[i].population)),
              ),
            days: spec.days,
            year: spec.year,
            startDays: binned?.startDays ?? null,
            compareShare: spec.compareShare,
            policyMix: spec.policyMix,
          });
      // Recorded conditions for its days, the same for both arms.
      const recorded = binned
        ? binned.driversFor(scenario.startMs, spec.days)
        : null;
      const params = epiParameters(scenario.profile);
      const arms = [['A', params]];
      if (scenario.compare)
        arms.push(['B', counterfactualParams(params, scenario.compare)]);
      for (const [arm, armParams] of arms) {
        const collected = [];
        const tape = createEpisodeTape({
          nodes: world.nodes,
          tracked: world.tracked,
          countries: world.countries,
          countryOfNode: world.countryOfNode,
          policy: policyFor(scenario.policy, {
            seed: scenario.policySeed,
            candidates: pool.slice(0, 256),
            countries: world.countries.filter(Boolean),
          }),
          onEpisode: (episode) => collected.push(episode),
        });
        simulateEpidemic({
          nodes: world.nodes,
          origins: scenario.origins,
          routes: world.routes,
          // A downloaded run brings the flights its scan found.
          flights: base ? base.flights : [],
          flown: base ? base.flown : [],
          links: world.links,
          params: armParams,
          startMs: scenario.startMs,
          untilMs: scenario.untilMs,
          runs: spec.runs,
          seed: 1,
          stream: { kind: 'xoshiro128', key: [spec.seed >>> 0, k >>> 0] },
          budgetMs: Infinity,
          now: () => 0,
          tape,
          ...(recorded ? { drivers: recorded.drivers } : {}),
        });
        for (const episode of collected) {
          const key = episodeKey(k, episode.run, arm);
          const extra = {
            scenario: k,
            arm,
            pair: episodeKey(k, episode.run, 'A').slice(0, -2),
            worldId: world.worldId,
            preset: scenario.preset,
            policy: scenario.policy,
            compare: arm === 'B' ? scenario.compare : null,
            profile: scenario.profile,
            origins: scenario.origins,
            startMs: scenario.startMs,
            untilMs: scenario.untilMs,
            streamKey: [spec.seed >>> 0, k >>> 0],
            policySeed: scenario.policySeed,
            ...(base
              ? {
                  fromExport: {
                    sha256: spec.fromExport.sha256,
                    flights: base.flights.length,
                  },
                }
              : {}),
            ...(recorded
              ? {
                  drivers: {
                    from: 'bins',
                    kinds: ['season', 'travel', 'commute'],
                    recordedDays: recorded.recordedDays,
                  },
                }
              : {}),
          };
          for (const [name, bytes] of episodeMembers(key, episode, extra))
            await writer.add(name, bytes);
          lines.push({
            key,
            shard,
            scenario: k,
            run: episode.run,
            arm,
            pair: extra.pair,
            worldId: world.worldId,
            preset: scenario.preset,
            policy: scenario.policy,
            compare: extra.compare,
            labels: episode.labels,
            ...(recorded ? { recordedDays: recorded.recordedDays } : {}),
          });
          episodes += 1;
        }
      }
    }
    const bytes = await writer.finish();
    return {
      shard,
      file,
      bytes,
      rawBytes: writer.rawBytes,
      episodes,
      lines,
      ms: Date.now() - started,
    };
  } catch (error) {
    writer.abort();
    throw error;
  }
}
