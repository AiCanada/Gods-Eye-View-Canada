/**
 * The World Bank demographics table (src/demographics.mjs), fetched from
 * the same API the Outbreak rail volumes use and kept thirty days in
 * .gev-cache/outbreak/worldbank-demographics.json; written for the world
 * models to .gev-data/demographics/ (owner request 2026-10-13).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DEMOGRAPHIC_INDICATORS,
  mergeIndicators,
  placeDemographics,
  readWorldBankIndicator,
} from '../../src/demographics.mjs';
import { npyBytes } from '../../src/outbreakEpiShard.mjs';

const URL_FOR = (indicator) =>
  `https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&per_page=20000&mrnev=1`;
const CACHE_MS = 30 * 24 * 3_600_000;
const TIMEOUT_MS = 30_000;

/** The table: from the cache while fresh, else the World Bank, else stale. */
export async function loadDemographics({
  cacheDir,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  const file = path.join(cacheDir, 'worldbank-demographics.json');
  let kept = null;
  try {
    kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (now() - fs.statSync(file).mtimeMs < CACHE_MS) return kept;
  } catch {
    kept = null;
  }
  try {
    const byIndicator = {};
    for (const indicator of Object.keys(DEMOGRAPHIC_INDICATORS)) {
      const response = await fetchImpl(URL_FOR(indicator), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`World Bank HTTP ${response.status}`);
      byIndicator[indicator] = readWorldBankIndicator(await response.json());
    }
    const table = {
      source: 'World Bank WDI (CC BY 4.0)',
      indicators: DEMOGRAPHIC_INDICATORS,
      byCountry: mergeIndicators(byIndicator),
      fetchedAt: now(),
    };
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(table));
    return table;
  } catch (error) {
    if (kept) return kept;
    throw error;
  }
}

/** Write the table and a world's per-place features under `outDir`. */
export function writeDemographics(table, world, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'worldbank.json'),
    JSON.stringify(table, null, 2),
  );
  if (!world) return null;
  const { data, shape, channels } = placeDemographics(
    world.nodes,
    table.byCountry,
  );
  const file = path.join(outDir, `places-${world.worldId}.npy`);
  fs.writeFileSync(file, npyBytes(data, shape));
  fs.writeFileSync(
    path.join(outDir, `places-${world.worldId}.json`),
    JSON.stringify({ worldId: world.worldId, channels, licence: table.source }),
  );
  return file;
}
