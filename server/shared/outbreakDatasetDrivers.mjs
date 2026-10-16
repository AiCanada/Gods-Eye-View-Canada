/**
 * Recorded conditions for sim datasets (owner request 2026-10-13: the sim
 * and the live data together; docs/WORLD-MODEL-DATA.md, Recorded conditions
 * as sim drivers). The days the world tape binned onto a world
 * (bins/<worldId>/YYYY/MM/DD.<group>.npy) become the days scenarios start
 * on, and each scenario's drivers come from the summaries of its own days:
 * humidity sets the season, departures the travel, transit service the
 * commuting. Days with no bins keep the model's own values.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseNpy } from '../../src/outbreakEpiShard.mjs';
import {
  daySummary,
  driversFromSummaries,
} from '../../src/outbreakEpiDrivers.mjs';

const DAY_MS = 86_400_000;
/** The bin groups the drivers read. */
const GROUPS = ['weather', 'mobility', 'trains'];

const digits = (name) => /^\d+$/.test(name);

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The binned days of a world, as 00:00 UTC ms, oldest first. */
export function binnedDays(binsRoot, worldId) {
  const base = path.join(binsRoot, worldId);
  const days = [];
  for (const y of listDir(base).filter(digits))
    for (const m of listDir(path.join(base, y)).filter(digits))
      for (const file of listDir(path.join(base, y, m))) {
        const match = /^(\d{2})\.mobility\.npy$/.exec(file);
        if (!match) continue;
        const at = Date.parse(`${y}-${m}-${match[1]}T00:00:00Z`);
        if (Number.isFinite(at)) days.push(at);
      }
  return days.sort((a, b) => a - b);
}

/**
 * The licence classes the drivers' bins were built from on those days (the
 * binner's DD.classes.json); a day without that file counts as 'unclear'.
 * @param {string} binsRoot
 * @param {string} worldId
 * @param {number[]} days 00:00 UTC ms.
 * @returns {string[]}
 */
export function binnedClasses(binsRoot, worldId, days) {
  const seen = new Set();
  for (const dayMs of days) {
    const stamp = new Date(dayMs).toISOString().slice(0, 10).split('-');
    try {
      const classes = JSON.parse(
        fs.readFileSync(
          path.join(
            binsRoot,
            worldId,
            stamp[0],
            stamp[1],
            `${stamp[2]}.classes.json`,
          ),
          'utf8',
        ),
      );
      for (const group of GROUPS)
        for (const cls of classes?.[group] || []) seen.add(String(cls));
    } catch {
      seen.add('unclear');
    }
  }
  return [...seen].sort();
}

/**
 * The drivers source for one world.
 * @param {{binsRoot: string, world: {worldId: string, nodes: object[], tracked: Int32Array|number[]}, days?: number[]}} input
 *   `days`: the binned days to use (a dataset freezes them in its spec when
 *   it starts, so a resumed sweep draws the same dates); default: every
 *   binned day now.
 * @returns {{startDays: number[], driversFor: (startMs: number, days: number) => {drivers: object, recordedDays: number}}}
 */
export function createBinsDrivers({ binsRoot, world, days = null }) {
  const K = world.tracked.length;
  const startDays = Array.isArray(days)
    ? [...days].sort((a, b) => a - b)
    : binnedDays(binsRoot, world.worldId);
  const known = new Set(startDays);
  const summaries = new Map(); // day ms → daySummary | null
  const summaryOf = (dayMs) => {
    if (!known.has(dayMs)) return null;
    if (summaries.has(dayMs)) return summaries.get(dayMs);
    const stamp = new Date(dayMs).toISOString().slice(0, 10).split('-');
    const bins = {};
    for (const group of GROUPS) {
      try {
        const file = path.join(
          binsRoot,
          world.worldId,
          stamp[0],
          stamp[1],
          `${stamp[2]}.${group}.npy`,
        );
        const { data, shape } = parseNpy(new Uint8Array(fs.readFileSync(file)));
        // Bins of another place set (an older world) are not this world's.
        if (shape[1] === K) bins[group] = { data };
      } catch {
        /* the group was not binned that day */
      }
    }
    const summary = Object.keys(bins).length ? daySummary(bins, K) : null;
    summaries.set(dayMs, summary);
    return summary;
  };
  return {
    startDays,
    driversFor(startMs, days) {
      const day0 = Math.floor(startMs / DAY_MS) * DAY_MS;
      const list = Array.from({ length: days }, (_, d) =>
        summaryOf(day0 + d * DAY_MS),
      );
      return {
        drivers: driversFromSummaries({
          nodes: world.nodes,
          tracked: world.tracked,
          summaries: list,
        }),
        recordedDays: list.filter(Boolean).length,
      };
    },
  };
}
