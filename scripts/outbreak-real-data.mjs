#!/usr/bin/env node
/**
 * Real epidemics and policy for the world models (owner request
 * 2026-10-13): downloads Our World in Data's COVID-19 data and the OxCGRT
 * national policy indicators (both CC BY 4.0) into .gev-cache/outbreak/real/
 * (kept), and writes the aligned country arrays to
 * .gev-data/real/owid-oxcgrt/ (src/outbreakRealTape.mjs).
 *
 *   node scripts/outbreak-real-data.mjs [--offline] [--from 2020-01-01]
 *     [--to 2022-12-31]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './project-root.mjs';
import { npyBytes } from '../src/outbreakEpiShard.mjs';
import {
  REAL_ACTIONS,
  REAL_OBS,
  REAL_SCHEMA,
  isoTable,
  owidSeries,
  oxcgrtSeries,
  parseCsv,
  realArrays,
} from '../src/outbreakRealTape.mjs';

export const SOURCES = Object.freeze({
  owid: [
    'https://catalog.ourworldindata.org/garden/covid/latest/compact/compact.csv',
    'https://covid.ourworldindata.org/data/owid-covid-data.csv',
  ],
  oxcgrt: [
    'https://raw.githubusercontent.com/OxCGRT/covid-policy-dataset/main/data/OxCGRT_compact_national_v1.csv',
  ],
});

export function parseArgs(argv, root = projectRoot(import.meta.url)) {
  const options = {
    root,
    cache: path.join(root, '.gev-cache', 'outbreak', 'real'),
    out: path.join(root, '.gev-data', 'real', 'owid-oxcgrt'),
    offline: false,
    from: '2020-01-01',
    to: '2022-12-31',
  };
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    const next = () => argv[(k += 1)];
    if (arg === '--offline') options.offline = true;
    else if (arg === '--from') options.from = next();
    else if (arg === '--to') options.to = next();
    else if (arg === '--out') options.out = path.resolve(root, next());
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

/** A source's text: the kept copy offline, else the first URL that answers. */
export async function fetchSource(
  name,
  { cache, offline, fetchImpl = globalThis.fetch },
) {
  const file = path.join(cache, `${name}.csv`);
  if (offline) return fs.readFileSync(file, 'utf8');
  let lastError = null;
  for (const url of SOURCES[name]) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      fs.mkdirSync(cache, { recursive: true });
      fs.writeFileSync(file, text);
      return text;
    } catch (error) {
      lastError = error;
    }
  }
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  throw new Error(`${name}: ${lastError?.message || 'no source answered'}`);
}

/** Build and write the arrays; returns the metadata written. */
export function writeReal({ owidText, oxcgrtText, iso, from, to, out }) {
  const owid = owidSeries(parseCsv(owidText), iso);
  const oxcgrt = oxcgrtSeries(parseCsv(oxcgrtText), iso);
  const countries = [
    ...new Set([...Object.keys(owid), ...Object.keys(oxcgrt)]),
  ].sort();
  const arrays = realArrays({ owid, oxcgrt, countries, from, to });
  fs.mkdirSync(out, { recursive: true });
  for (const name of [
    'obs',
    'actions',
    'obs_mask',
    'actions_mask',
    'population',
  ])
    fs.writeFileSync(
      path.join(out, `${name}.npy`),
      npyBytes(arrays[name].data, arrays[name].shape),
    );
  const meta = {
    schema: REAL_SCHEMA,
    from,
    to,
    days: arrays.dates.length,
    countries,
    channels: { obs: REAL_OBS, actions: REAL_ACTIONS },
    actionMapping:
      'lockdown = mean of OxCGRT C1–C7 as shares of their scales; travelBan = C8/4; testing = H2/3; tracing = H3/2; vaccination = H7/5',
    domain: 'real',
    class: 'open',
    licences: [
      'Our World in Data COVID-19 data (CC BY 4.0): attribution required',
      'Oxford COVID-19 Government Response Tracker (CC BY 4.0): Hale et al. 2021, Nature Human Behaviour',
    ],
  };
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const naturalEarth = JSON.parse(
    fs.readFileSync(
      path.join(
        options.root,
        'src',
        'data',
        'local_data',
        'natural_earth',
        'countries.json',
      ),
      'utf8',
    ),
  );
  const [owidText, oxcgrtText] = await Promise.all([
    fetchSource('owid', options),
    fetchSource('oxcgrt', options),
  ]);
  const meta = writeReal({
    owidText,
    oxcgrtText,
    iso: isoTable(naturalEarth),
    from: options.from,
    to: options.to,
    out: options.out,
  });
  console.log(
    `[real] ${meta.countries.length} countries × ${meta.days} days → ${options.out}`,
  );
  return meta;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(`[real] ${error.message}`);
    process.exitCode = 1;
  });
