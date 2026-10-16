/**
 * World tape feed: CelesTrak two-line element sets for every group the
 * Satellites layer reads (services.satellites → /api/celestrak/<group>, whose
 * cache is six hours), every six hours. An element set is recorded once,
 * when it first appears.
 */
import { parseTleText, tleCatalogNumber } from '../../../../src/sources/tle.js';
import { DAY, HOUR, forget, noteChange } from './_util.mjs';

const GROUPS = [
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
];

/** A TLE line 1 epoch (YYDDD.DDDDDDDD) in ms, or null. */
export function tleEpochMs(line1) {
  const yy = Number.parseInt(String(line1).slice(18, 20), 10);
  const day = Number.parseFloat(String(line1).slice(20, 32));
  if (!Number.isInteger(yy) || !Number.isFinite(day)) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return Math.round(Date.UTC(year, 0, 1) + (day - 1) * DAY);
}

export default {
  id: 'satellites',
  label: 'Satellites (CelesTrak elements)',
  layers: ['satellites'],
  kind: 'feed',
  class: 'open',
  licence:
    'CelesTrak (U.S.-government-origin data; citation requested: CelesTrak, Dr. T.S. Kelso)',
  cadenceMs: 6 * HOUR,
  phase: 1,
  bytesPerDay: 2e6,
  async poll({ services, state, now, signal }) {
    state.seen ??= new Map();
    const t = now();
    const records = [];
    let answered = 0;
    let failure = null;
    for (const group of GROUPS) {
      let result;
      try {
        result = await services.satellites.readGroup(group, { signal });
      } catch (error) {
        failure ??= error;
        continue;
      }
      if (!result?.ok) {
        failure ??= new Error(`CelesTrak ${group} HTTP ${result?.status}`);
        continue;
      }
      answered += 1;
      for (const entry of parseTleText(result.text)) {
        const norad = tleCatalogNumber(entry.line1);
        const key = `${group}|${norad ?? entry.name}`;
        if (!noteChange(state.seen, key, `${entry.line1}|${entry.line2}`, t))
          continue;
        records.push({
          group,
          name: entry.name,
          norad,
          tle1: entry.line1,
          tle2: entry.line2,
          epoch: tleEpochMs(entry.line1),
          ...(result.stale ? { stale: true } : {}),
        });
      }
    }
    if (!answered && failure) throw failure;
    forget(state.seen, t, 7 * DAY, 200_000);
    return { records };
  },
};
