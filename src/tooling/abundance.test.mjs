// GLOBAL ABUNDANCE MAP (owner request 2026-10-22): the indicators, the
// score, the colours, the ranking and the grid links (src/abundanceCore.mjs);
// the units from the Natural Earth packs and the name matching
// (src/abundanceUnits.mjs); the figures fetched, cached, joined and handed
// down (server/shared/abundanceData.mjs); and the routes
// (server/providers/abundance.js). Hermetic: fixture packs in a temp root,
// a fake fetch, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ABUNDANCE_INDICATOR_IDS,
  ABUNDANCE_INDICATORS,
  ABUNDANCE_NO_DATA_COLOR,
  abundanceLinks,
  cleanIndicatorIds,
  cleanLevel,
  cleanWeights,
  coverageOf,
  csvNumber,
  expandTable,
  formatFigure,
  indicatorById,
  indicatorMeasure,
  indicatorRanks,
  indicatorStats,
  oecdKey,
  packTable,
  parseAbundanceCsv,
  parseCsvRows,
  rankUnits,
  scoreColor,
  scoreUnits,
} from '../abundanceCore.mjs';
import {
  cityUnits,
  compoundParts,
  listUnits,
  countryEntries,
  countryUnits,
  createCountryCodes,
  createUnitMatcher,
  regionEntries,
  regionUnits,
  softAdminName,
} from '../abundanceUnits.mjs';
import {
  ABUNDANCE_RETRY_MS,
  abundanceSources,
  collapsedYears,
  createAbundanceStore,
  latestAndPast,
  mergeSeries,
  readOecdCsv,
  readOwidCsv,
  readWorldBankSeries,
} from '../../server/shared/abundanceData.mjs';
import { abundanceProvider } from '../../server/providers/abundance.js';
import {
  OWNER_DEVICE_AUTHORITY_HEADER,
  OWNER_DEVICE_HEADER,
  OWNER_DEVICE_REMOVAL_HEADER,
  setOwnerDeviceToken,
} from '../keySetupCore.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-abundance-'));

// --- fixture packs ------------------------------------------------------------------

/** A ring as the packs encode it: integers in 10^-3 degrees, deltas after the first. */
function enc(ring, decimals = 3) {
  const f = 10 ** decimals;
  const out = [];
  let px = 0;
  let py = 0;
  for (const [lon, lat] of ring) {
    const x = Math.round(lon * f);
    const y = Math.round(lat * f);
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out;
}
const square = (x, y, w = 10) =>
  enc([
    [x, y],
    [x + w, y],
    [x + w, y + w],
    [x, y + w],
  ]);

const COUNTRIES = {
  meta: { decimals: 3 },
  features: [
    {
      name: 'Testland',
      alt: ['Republic of Testland'],
      country: 'Testland',
      iso: 'TST',
      iso2: 'TS',
      type: 'Country',
      polygons: [[square(0, 0)]],
    },
    {
      name: 'Farland',
      country: 'Farland',
      iso: 'FAR',
      iso2: 'FA',
      type: 'Country',
      polygons: [[square(100, 0)]],
    },
    {
      name: 'Noland',
      country: 'Noland',
      iso: 'NOL',
      iso2: '-99',
      type: 'Country',
      polygons: [[square(-50, -50)]],
    },
    {
      name: 'Testshire',
      country: 'Testland',
      iso: 'TSH',
      iso2: 'TS',
      type: 'Constituent country',
      polygons: [[square(0, 0, 5)]],
    },
  ],
};

const ADMIN1 = {
  meta: { decimals: 3 },
  features: [
    {
      name: 'North Testland',
      country: 'Testland',
      iso2: 'TS',
      iso: 'TS-N',
      type: 'Province',
      label: [5, 8],
      polygons: [[square(0, 5, 10)]],
    },
    {
      name: 'South Testland',
      country: 'Testland',
      iso2: 'TS',
      iso: 'TS-S',
      type: 'Province',
      polygons: [[square(0, 0, 5)]],
    },
    {
      name: 'Isleton',
      nameEn: 'Isle Town',
      country: 'Testland',
      iso2: 'TS',
      iso: null,
      type: 'District',
      group: 'Testland East',
      polygons: [[square(6, 0, 4)]],
    },
    {
      name: 'Far West',
      country: 'Farland',
      iso2: 'FA',
      iso: 'FA-X',
      type: 'State',
      polygons: [[square(100, 0, 5)]],
    },
    {
      name: 'Far East',
      country: 'Farland',
      iso2: 'FA',
      iso: 'FA-X',
      type: 'State',
      polygons: [[square(105, 0, 5)]],
    },
    {
      name: 'Nowhere Region',
      country: 'Noland',
      iso2: null,
      iso: null,
      type: 'Region',
      polygons: [[square(-50, -50)]],
    },
  ],
};

const PLACES = {
  meta: {},
  features: [
    {
      id: 1,
      name: 'Testville',
      country: 'Testland',
      iso: 'TST',
      iso2: 'TS',
      adm1: 'North Testland',
      lon: 5,
      lat: 8,
      pop: 500000,
      rank: 1,
    },
    {
      id: 2,
      name: 'Southport',
      alt: ['South Port'],
      country: 'Testland',
      iso: 'TST',
      iso2: 'TS',
      adm1: 'South Testland',
      lon: 2,
      lat: 2,
      pop: 20000,
      rank: 6,
    },
    {
      id: 3,
      name: 'Farcity',
      country: 'Farland',
      iso: 'FAR',
      iso2: 'FA',
      adm1: 'Far West',
      lon: 102,
      lat: 2,
      pop: 1000000,
      capital: true,
      rank: 1,
    },
    {
      id: 4,
      name: 'Nowhere',
      country: 'Noland',
      iso: 'NOL',
      lon: -45,
      lat: -45,
      pop: 100,
      rank: 9,
    },
  ],
};

function writePacks(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'countries.json'), JSON.stringify(COUNTRIES));
  fs.writeFileSync(
    path.join(dir, 'states_provinces.json'),
    JSON.stringify(ADMIN1),
  );
  fs.writeFileSync(path.join(dir, 'places.json'), JSON.stringify(PLACES));
}

// --- fake sources -------------------------------------------------------------------

const WB = {
  'NY.GDP.PCAP.PP.CD': { TS: [2024, 50000], FA: [2024, 20000] },
  'SP.DYN.LE00.IN': { TS: [2024, 82], FA: [2023, 70] },
  'SH.DYN.MORT': { TS: [2024, 4], FA: [2024, 30] },
  'NY.GNP.PCAP.PP.CD': { TS: [2024, 48000], FA: [2024, 19000] },
  'FP.CPI.TOTL.ZG': { TS: [2025, 2.5], FA: [2025, 10] },
  'PA.NUS.PRVT.PP': { TS: [2024, 1.2], FA: [2024, 0.5] },
  'PA.NUS.FCRF': { TS: [2024, 1], FA: [2024, 1] },
  'SE.SEC.ENRR': { TS: [2023, 100], FA: [2023, 60] },
  'IT.NET.USER.ZS': { TS: [2024, 95], FA: [2024, 40] },
  'EG.ELC.ACCS.ZS': { TS: [2024, 100], FA: [2024, 60] },
  'SH.H2O.BASW.ZS': { TS: [2024, 99], FA: [2024, 70] },
  'VC.IHR.PSRC.P5': { TS: [2023, 1.5], FA: [2023, 20] },
  'SL.UEM.TOTL.ZS': { TS: [2025, 5], FA: [2025, 12] },
};
const ISO3 = { TS: 'TST', FA: 'FAR' };

const WB_PAST = { 'NY.GDP.PCAP.PP.CD': { TS: [2019, 40000] } };
/**
 * Points only the by-years answer holds: the World Bank answered forest
 * area's latest values one value deep (2026-10-23), here with none at all.
 */
const WB_BY_YEARS = {
  'AG.LND.FRST.ZS': {
    TS: [
      [2024, 40],
      [2019, 38],
    ],
  },
};

function worldBankJson(code, { byYears = false } = {}) {
  const rows = [
    ...Object.entries(WB[code] || {}),
    ...Object.entries(WB_PAST[code] || {}),
    ...(byYears
      ? Object.entries(WB_BY_YEARS[code] || {}).flatMap(([iso2, points]) =>
          points.map((point) => [iso2, point]),
        )
      : []),
  ].map(([iso2, [year, value]]) => ({
    indicator: { id: code, value: code },
    country: { id: iso2, value: iso2 },
    countryiso3code: ISO3[iso2],
    date: String(year),
    value,
  }));
  // An aggregate row, as the World Bank sends them.
  rows.push({
    indicator: { id: code, value: code },
    country: { id: 'ZH', value: 'Africa Eastern and Southern' },
    countryiso3code: 'AFE',
    date: '2024',
    value: 1,
  });
  return [{ page: 1, pages: 1, per_page: 20000, total: rows.length }, rows];
}

const OWID = {
  'prison-population-rate': [
    'entity,code,year,prison_population_rate',
    'Testland,TST,2020,100',
    'Testland,TST,2024,110',
    'Farland,FAR,2023,400',
    'World,OWID_WRL,2024,140',
  ].join('\n'),
  'happiness-cantril-ladder': [
    'entity,code,year,cantril_ladder_score',
    'Testland,TST,2024,7.1',
    'Farland,FAR,2024,4.2',
  ].join('\n'),
};

const REGIONAL_HEADER =
  'STRUCTURE,STRUCTURE_ID,ACTION,FREQ,TERRITORIAL_LEVEL,REF_AREA,"Reference area",TERRITORIAL_TYPE,MEASURE,TIME_PERIOD,OBS_VALUE,COUNTRY,Country';
const regionalRow = (level, area, name, iso3, year, value) =>
  `DATAFLOW,x,I,A,${level},${area},"${name}",_Z,GDP,${year},${value},${iso3},${iso3}`;
const OECD = {
  'DF_GDP,2.4': [
    REGIONAL_HEADER,
    regionalRow('TL2', 'TS1', 'North Testland', 'TST', 2023, 60000),
    regionalRow('TL2', 'TS1', 'North Testland', 'TST', 2018, 50000),
    regionalRow('TL3', 'TS101', 'North Testland', 'TST', 2022, 1),
    regionalRow('TL2', 'TS2', 'Southern Testland', 'TST', 2023, 30000),
    regionalRow('TL3', 'TS201', 'Isle Town', 'TST', 2021, 45000),
    regionalRow('TL2', 'FA1', 'Far West', 'FAR', 2023, 25000),
    regionalRow('TL2', 'FA9', 'Farland, not regionalised', 'FAR', 2023, 9),
  ].join('\n'),
  'DF_LIFE_EXP,2.4': [
    REGIONAL_HEADER,
    regionalRow('TL2', 'TS1', 'North Testland', 'TST', 2022, 84),
    regionalRow('TL2', 'TS9', 'Testland East', 'TST', 2023, 80),
    regionalRow('TL3', 'TS901', 'Isleton and Farport', 'TST', 2023, 79),
    // A large region whose name lists places is no unit's own figure.
    regionalRow('TL2', 'TS8', 'South Testland and Farshore', 'TST', 2023, 70),
    // A zero where every real figure is above zero is no figure (the OECD's way of writing none).
    regionalRow('TL2', 'TS2', 'Southern Testland', 'TST', 2024, 0),
  ].join('\n'),
  // Where a zero is a real figure (no infant died that year), it stands.
  'DF_STATUS,2.5': [
    REGIONAL_HEADER,
    regionalRow('TL2', 'TS1', 'North Testland', 'TST', 2023, 0),
  ].join('\n'),
  'DF_ECONOMY,1.1': [
    'STRUCTURE,STRUCTURE_ID,ACTION,REF_AREA,"Reference area",FREQ,MEASURE,TERRITORIAL_LEVEL,TIME_PERIOD,OBS_VALUE',
    'DATAFLOW,x,I,TS001F,Testville,A,GDP,FUA,2022,70000',
    'DATAFLOW,x,I,FAR01F,Farcity,A,GDP,FUA,2022,40000',
    'DATAFLOW,x,I,FAR02F,"Far, Away",A,GDP,FUA,2022,1',
  ].join('\n'),
  'DF_LABOUR,1.1': [
    'STRUCTURE,STRUCTURE_ID,ACTION,REF_AREA,"Reference area",FREQ,MEASURE,TERRITORIAL_LEVEL,TIME_PERIOD,OBS_VALUE',
    'DATAFLOW,x,I,TS001F,Testville,A,UNE_RATE,FUA,2024,4',
    // An urban area named after two places is one city, found by its first name,
    // else by the places it names.
    'DATAFLOW,x,I,TS002F,Southport and Beyond,A,UNE_RATE,FUA,2024,6',
    'DATAFLOW,x,I,FAR03F,Farshire West and Farcity,A,UNE_RATE,FUA,2024,7',
  ].join('\n'),
};

/** A fetch that answers from the tables above; DF_SAFETY fails on purpose. */
function fakeFetch(log = []) {
  const response = (status, body, json = false) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (json ? body : JSON.parse(body)),
    text: async () => (json ? JSON.stringify(body) : body),
  });
  return async (url, init = {}) => {
    log.push(url);
    const wb = /indicator\/([A-Z0-9.]+)\?/.exec(url);
    if (wb)
      return response(
        200,
        worldBankJson(wb[1], { byYears: /[?&]date=/.test(url) }),
        true,
      );
    const owid = /grapher\/([a-z-]+)\.csv/.exec(url);
    if (owid) return response(200, OWID[owid[1]] || '');
    const oecd = /OECD\.CFE\.EDS,[^,]+@(DF_[A-Z_]+),([0-9.]+)\//.exec(url);
    if (oecd) {
      const key = `${oecd[1]},${oecd[2]}`;
      // The OECD answers a labelled CSV asked in no particular language
      // (Node's fetch sends `accept-language: *`) with HTTP 500.
      const language = Object.entries(init.headers || {}).find(
        ([name]) => name.toLowerCase() === 'accept-language',
      )?.[1];
      if (!language || language === '*')
        return response(500, 'Internal server error');
      if (oecd[1] === 'DF_SAFETY') return response(500, 'down');
      return response(200, OECD[key] || REGIONAL_HEADER);
    }
    return response(404, 'nope');
  };
}

const unit = (table, id) => expandTable(table).find((u) => u.id === id);

// --- the core -------------------------------------------------------------------------

test('the indicators: the owner list, each with a country source, a direction and a measure per level', () => {
  assert.deepEqual(ABUNDANCE_INDICATOR_IDS, [
    'gdp',
    'life',
    'health',
    'income',
    'inflation',
    'cost',
    'education',
    'infrastructure',
    'prison',
    'utilities',
    'water',
    'happiness',
    'safety',
    'work',
    'air',
    'green',
  ]);
  for (const i of ABUNDANCE_INDICATORS) {
    assert.ok(['high', 'low'].includes(i.better), i.id);
    assert.ok(i.country?.kind, `${i.id} has a country source`);
    assert.ok(i.country.measure, `${i.id} names its measure`);
  }
  assert.equal(indicatorById('gdp').label, 'GDP PER PERSON');
  assert.equal(indicatorById('nope'), null);
  assert.deepEqual(cleanIndicatorIds(['work', 'gdp', 'gdp', 'x']), ['gdp', 'work']);
  assert.equal(cleanLevel('region'), 'region');
  assert.equal(cleanLevel('planet'), 'country');
  assert.equal(
    oecdKey(indicatorById('gdp').region, 'region'),
    'A.TL2+TL3...GDP._T.V.USD_PPP_PS',
  );
  assert.equal(oecdKey(indicatorById('gdp').city, 'city'), '.A.GDP.USD_PPP_PS.FUA');
  assert.equal(
    indicatorMeasure(indicatorById('health'), 'region'),
    'INFANTS DYING BEFORE AGE 1, PER 1,000 BIRTHS',
  );
  // A level without its own source reads the country's measure.
  assert.equal(
    indicatorMeasure(indicatorById('inflation'), 'city'),
    'CONSUMER PRICES, % A YEAR',
  );
});

test('places 0–100 follow each indicator its own way; ties share; the score is the mean place', () => {
  const units = [
    { id: 'a', values: { gdp: { v: 10 }, inflation: { v: 2 } } },
    { id: 'b', values: { gdp: { v: 20 }, inflation: { v: 8 } } },
    { id: 'c', values: { gdp: { v: 30 }, inflation: { v: 8 } } },
    { id: 'd', values: { gdp: { v: 30 } } },
    { id: 'e', values: {} },
  ];
  const gdp = indicatorRanks(units, indicatorById('gdp'));
  assert.equal(gdp.get('a'), 0);
  assert.equal(Math.round(gdp.get('b')), 33);
  assert.equal(gdp.get('c'), gdp.get('d'));
  assert.equal(Math.round(gdp.get('c')), 83);
  assert.equal(gdp.has('e'), false);
  // Inflation: the lowest is the most abundant.
  const inflation = indicatorRanks(units, indicatorById('inflation'));
  assert.equal(inflation.get('a'), 100);
  assert.equal(inflation.get('b'), 25);
  assert.equal(inflation.get('c'), 25);
  assert.equal(indicatorRanks([units[0]], indicatorById('gdp')).get('a'), 50);
  const scores = scoreUnits(units, ['gdp', 'inflation', 'nope']);
  assert.equal(scores.get('a').score, 50);
  assert.deepEqual(scores.get('a').ranks, { gdp: 0, inflation: 100 });
  assert.equal(scores.get('a').of, 2);
  assert.equal(scores.get('d').counted, 1);
  assert.equal(scores.get('e').score, null);
  const ranked = rankUnits(units, scores);
  assert.deepEqual(
    ranked.map((r) => r.id),
    ['d', 'c', 'a', 'b'],
  );
  assert.deepEqual(coverageOf([{ values: { gdp: { v: 1, from: 'own', year: 2020 } } }, { values: { gdp: { v: 2, from: 'country', year: 2024 } } }, { values: { gdp: { v: 3, from: 'area', year: 2021 } } }], ['gdp', 'work']), {
    gdp: { own: 1, area: 1, inherited: 1, year: 2024 },
    work: { own: 0, area: 0, inherited: 0, year: null },
  });
  // Weights: a heavier indicator pulls the score its way; the stats behind the legend.
  const weighed = scoreUnits(units, ['gdp', 'inflation'], ABUNDANCE_INDICATORS, { inflation: 3 });
  assert.equal(Math.round(weighed.get('b').score), 27);
  assert.equal(Math.round(scoreUnits(units, ['gdp', 'inflation']).get('b').score), 29);
  assert.deepEqual(cleanWeights({ gdp: 2, inflation: '0.7', work: 9, nope: 2, life: 1 }), { gdp: 2, inflation: 0.5, work: 3 });
  assert.deepEqual(cleanWeights(null), {});
  assert.deepEqual(indicatorStats(units, indicatorById('gdp')), { min: 10, median: 25, max: 30, n: 4 });
  assert.deepEqual(indicatorStats(units, indicatorById('inflation')), { min: 2, median: 8, max: 8, n: 3 });
  assert.equal(indicatorStats([], indicatorById('gdp')), null);
});

test('the colours run red to amber to green; no figure is grey', () => {
  assert.equal(scoreColor(0), '#ff2a2a');
  assert.equal(scoreColor(50), '#ffd21a');
  assert.equal(scoreColor(100), '#19e6b0');
  assert.equal(scoreColor(25), '#ff7e22');
  assert.equal(scoreColor(null), ABUNDANCE_NO_DATA_COLOR);
  assert.equal(scoreColor(140), '#19e6b0');
});

test('the grid links every scarce place to its nearest abundant one, scarcest first', () => {
  const units = [
    { id: 'rich1', lat: 0, lon: 0, values: {} },
    { id: 'rich2', lat: 0, lon: 50, values: {} },
    { id: 'mid', lat: 10, lon: 10, values: {} },
    { id: 'poor1', lat: 1, lon: 40, values: {} },
    { id: 'poor2', lat: 1, lon: 1, values: {} },
    { id: 'poorest', lat: 0, lon: 60, values: {} },
    { id: 'lost', values: {} },
  ];
  const scores = new Map([
    ['rich1', { score: 90 }],
    ['rich2', { score: 80 }],
    ['mid', { score: 50 }],
    ['poor1', { score: 20 }],
    ['poor2', { score: 10 }],
    ['poorest', { score: 0 }],
    ['lost', { score: 0 }],
  ]);
  const links = abundanceLinks(units, scores);
  assert.deepEqual(
    links.map((l) => [l.from, l.to, l.gap]),
    [
      ['rich2', 'poorest', 80],
      ['rich1', 'poor2', 80],
      ['rich2', 'poor1', 60],
    ],
  );
  assert.ok(links[1].km > 100 && links[1].km < 200);
  assert.deepEqual(abundanceLinks(units, scores, { max: 1 }).length, 1);
  assert.deepEqual(abundanceLinks(units, new Map()), []);
});

test('figures are written with their decimals; tables pack and unpack; CSV rows parse', () => {
  assert.equal(formatFigure(indicatorById('gdp'), 54321.6), '54,322');
  assert.equal(formatFigure(indicatorById('life'), 82.07), '82.1');
  assert.equal(formatFigure(indicatorById('cost'), -1.2345), '-1.23');
  assert.equal(formatFigure(indicatorById('water'), -0.2), '0', 'a negative that rounds to nothing');
  assert.equal(formatFigure(indicatorById('work'), -0.04), '0.0');
  assert.equal(formatFigure(indicatorById('gdp'), 'x'), '');
  const units = [
    { id: 'a', name: 'A', values: { gdp: { v: 1, year: 2020, from: 'own' }, work: { v: 2, year: null, from: 'country' }, life: { v: 80, year: 2024, from: 'area', d: 1.5, y0: 2019 } } },
    { id: 'b', name: 'B', values: { life: { v: 70, year: 2023, from: 'own' } } },
  ];
  const packed = packTable(units);
  assert.deepEqual(packed.units, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  assert.deepEqual(packed.figures.gdp, { v: [1, null], year: [2020, null], from: [0, 0] });
  assert.deepEqual(packed.figures.work.from, [3, 0]);
  assert.deepEqual(packed.figures.life, { v: [80, 70], year: [2024, 2023], from: [4, 0], d: [1.5, null], y0: [2019, null] });
  assert.equal(packed.figures.gdp.d, undefined, 'no change column without a change');
  assert.deepEqual(expandTable(packed), units);
  assert.deepEqual(parseCsvRows('a,"b, c"\n"say ""hi""",2\r\n\n'), [
    ['a', 'b, c'],
    ['say "hi"', '2'],
  ]);
  assert.equal(csvNumber(' 1,234 '), 1234);
  assert.equal(csvNumber('$5'), 5);
  assert.equal(csvNumber('n/a'), null);
  assert.equal(csvNumber(''), null);
});

test("the owner's CSV: ids or names, a year, indicator columns by id or label, the rest listed back", () => {
  const parsed = parseAbundanceCsv(
    'id,YEAR,gdp,Happiness,colour\nTST,2024,"55,555",8,red\nFAR,,,4,\n,,1,,\n',
  );
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.ignored, ['colour']);
  assert.deepEqual(parsed.rows, [
    { id: 'TST', name: null, country: null, year: 2024, values: { gdp: 55555, happiness: 8 } },
    { id: 'FAR', name: null, country: null, year: null, values: { happiness: 4 } },
  ]);
  const byName = parseAbundanceCsv('name,country,WORK\nSouth Testland,TS,3');
  assert.deepEqual(byName.rows[0], { id: null, name: 'South Testland', country: 'TS', year: null, values: { work: 3 } });
  assert.match(parseAbundanceCsv('a,b\n1,2').error, /indicator column/);
  assert.match(parseAbundanceCsv('gdp\n1').error, /id column or a name column/);
  assert.match(parseAbundanceCsv('').error, /header and a row/);
});

// --- the units ------------------------------------------------------------------------

test('units from the packs: countries by ADM0_A3, states by ISO 3166-2 (shared codes numbered), cities by Natural Earth id', () => {
  const countries = countryUnits(COUNTRIES);
  assert.deepEqual(
    countries.map((u) => [u.id, u.iso2]),
    [
      ['TST', 'TS'],
      ['FAR', 'FA'],
      ['NOL', null],
    ],
  );
  // The centroid of the square (0,0)-(10,10).
  assert.deepEqual([countries[0].lon, countries[0].lat], [5, 5]);
  assert.equal(countryEntries(COUNTRIES)[0].feature.name, 'Testland');
  const regions = regionUnits(ADMIN1);
  assert.deepEqual(
    regions.map((u) => u.id),
    ['TS-N', 'TS-S', 'TS:isleton', 'FA-X', 'FA-X#2', 'XX:nowhere region'],
  );
  // A label point wins over the centroid.
  assert.deepEqual([regions[0].lon, regions[0].lat], [5, 8]);
  assert.deepEqual([regions[1].lon, regions[1].lat], [2.5, 2.5]);
  assert.equal(regionEntries(ADMIN1)[2].unit.nameEn, 'Isle Town');
  const cities = cityUnits(PLACES);
  assert.deepEqual(
    cities.map((u) => [u.id, u.iso2, u.adm1, u.pop]),
    [
      ['1', 'TS', 'North Testland', 500000],
      ['2', 'TS', 'South Testland', 20000],
      ['3', 'FA', 'Far West', 1000000],
      ['4', null, null, 100],
    ],
  );
  assert.equal(cities[2].capital, true);
});

test('names match exactly, softly (generic words and directions), by unique prefix, and through the alias table', () => {
  assert.equal(softAdminName('Aichi Prefecture'), 'aichi');
  assert.equal(softAdminName('Southern Testland'), 'south testland');
  assert.equal(softAdminName('South East Sulawesi Province'), 'southeast sulawesi');
  assert.equal(softAdminName('North Sumatera Province'), 'north sumatra');
  assert.equal(softAdminName('Testland, not regionalised'), 'testland');
  const matcher = createUnitMatcher(regionUnits(ADMIN1));
  assert.equal(matcher.find('TS', 'North Testland').id, 'TS-N');
  assert.equal(matcher.find('TS', 'north testland').id, 'TS-N');
  assert.equal(matcher.find('TS', 'Southern Testland').id, 'TS-S');
  assert.equal(matcher.find('TS', 'Isle Town').id, 'TS:isleton');
  assert.equal(matcher.find('TS', 'Province of Isleton').id, 'TS:isleton');
  assert.equal(matcher.find('FA', 'Far West').id, 'FA-X');
  // A prefix that fits two units settles nothing.
  assert.equal(matcher.find('FA', 'Far'), null);
  assert.equal(matcher.find('TS', 'Far West'), null);
  assert.equal(matcher.find('ZZ', 'North Testland'), null);
  // A larger region names the units inside it, through the aliases too.
  assert.deepEqual(matcher.findGroup('TS', 'Testland East').map((u) => u.id), ['TS:isleton']);
  assert.deepEqual(matcher.findGroup('TS', 'Nowhere'), []);
  const gb = createUnitMatcher([
    { id: 'GB-ABD', name: 'Aberdeenshire', iso2: 'GB', group: 'Scotland' },
    { id: 'GB-ESS', name: 'Essex', iso2: 'GB', group: 'East of England' },
    { id: 'GB-NFK', name: 'Norfolk', iso2: 'GB', group: 'East of England' },
  ]);
  assert.deepEqual(gb.findGroup('GB', 'Scotland').map((u) => u.id), ['GB-ABD']);
  assert.deepEqual(gb.findGroup('GB', 'East of England').map((u) => u.id), ['GB-ESS', 'GB-NFK']);
  assert.deepEqual(compoundParts('Hartlepool and Stockton-on-Tees'), ['Hartlepool', 'Stockton-on-Tees']);
  assert.deepEqual(compoundParts('Tyne & Wear'), ['Tyne', 'Wear']);
  assert.deepEqual(compoundParts('Durham'), []);
  assert.deepEqual(compoundParts('Armagh City, Banbridge and Craigavon'), ['Armagh City', 'Banbridge', 'Craigavon']);
  assert.deepEqual(compoundParts('Perth and Kinross, and Stirling'), ['Perth', 'Kinross', 'Stirling']);
  assert.deepEqual(compoundParts('Düsseldorf, Kreisfreie Stadt'), [], 'a comma alone lists nothing');
  // A list name: the prefix rule gives it to its first place alone; listUnits names each place, by name only.
  const lists = createUnitMatcher([
    { id: 'GB-HPL', name: 'Hartlepool', iso2: 'GB' },
    { id: 'GB-STT', name: 'Stockton-on-Tees', iso2: 'GB' },
    { id: 'GB-PKN', name: 'Perthshire and Kinross', alt: ['Perth and Kinross'], iso2: 'GB' },
    { id: 'GB-STG', name: 'Stirling', iso2: 'GB' },
    { id: 'GB-KEC', name: 'Kensington and Chelsea', iso2: 'GB' },
    { id: 'GB-HMF', name: 'Hammersmith and Fulham', iso2: 'GB' },
    { id: 'GB-NEL', name: 'North East Lincolnshire', iso2: 'GB' },
  ]);
  assert.equal(lists.find('GB', 'Hartlepool and Stockton-on-Tees').id, 'GB-HPL');
  assert.equal(lists.find('GB', 'Hartlepool and Stockton-on-Tees', { prefix: false }), null);
  const listed = (name) => listUnits(lists, 'GB', name).map((u) => u.id);
  assert.deepEqual(listed('Hartlepool and Stockton-on-Tees'), ['GB-HPL', 'GB-STT']);
  assert.deepEqual(listed('Perth and Kinross, and Stirling'), ['GB-PKN', 'GB-STG']);
  assert.deepEqual(listed('Kensington & Chelsea and Hammersmith & Fulham'), ['GB-KEC', 'GB-HMF']);
  assert.deepEqual(listed('Outer London - East and North East'), [], 'no part by prefix');
  assert.deepEqual(listed('Hartlepool'), []);
  const us = createUnitMatcher([
    { id: 'US-DC', name: 'District of Columbia', iso2: 'US' },
    { id: 'US-WA', name: 'Washington', iso2: 'US' },
  ]);
  assert.equal(us.find('US', 'Washington D.C.').id, 'US-DC');
  assert.equal(us.find('US', 'Washington').id, 'US-WA');
  const codes = createCountryCodes(countryUnits(COUNTRIES));
  assert.equal(codes.fromIso2('TS').id, 'TST');
  assert.equal(codes.fromIso2('ts').id, 'TST');
  assert.equal(codes.fromIso3('FAR').iso2, 'FA');
  assert.equal(codes.fromIso3('XKX'), null);
  assert.equal(codes.fromOecdArea('TS001F').id, 'TST');
  assert.equal(codes.fromOecdArea('FAR01F').id, 'FAR');
  assert.equal(codes.fromOecdArea('TSX1').id, 'TST');
  assert.equal(codes.fromOecdArea('99'), null);
});

// --- the store ------------------------------------------------------------------------

test('the sources: one per World Bank series, Our World in Data slug and OECD query; OWID and OECD CSVs read', () => {
  const sources = abundanceSources();
  const kinds = sources.reduce((m, s) => ((m[s.kind] = (m[s.kind] || 0) + 1), m), {});
  assert.deepEqual(kinds, { worldbank: 15, owid: 2, oecd: 11 });
  const cost = sources.filter((s) => s.indicators.includes('cost'));
  assert.deepEqual(
    cost.map((s) => s.id),
    ['wb:PA.NUS.PRVT.PP', 'wb:PA.NUS.FCRF'],
  );
  assert.ok(sources.every((s) => s.url.startsWith('https://')));
  assert.deepEqual(readOwidCsv(OWID['prison-population-rate'], 'prison_population_rate'), {
    TST: [{ year: 2024, value: 110 }, { year: 2020, value: 100 }],
    FAR: [{ year: 2023, value: 400 }],
  });
  assert.deepEqual(readWorldBankSeries(worldBankJson('NY.GDP.PCAP.PP.CD')), {
    TS: [{ year: 2024, value: 50000 }, { year: 2019, value: 40000 }],
    FA: [{ year: 2024, value: 20000 }],
    ZH: [{ year: 2024, value: 1 }],
  });
  // The latest point and the one five or more years older; the oldest when that is three or more.
  assert.deepEqual(latestAndPast([{ year: 2019, value: 1 }, { year: 2024, value: 3 }, { year: 2021, value: 2 }]), { value: 3, year: 2024, past: { value: 1, year: 2019 } });
  assert.deepEqual(latestAndPast([{ year: 2024, value: 3 }, { year: 2021, value: 2 }]), { value: 3, year: 2024, past: { value: 2, year: 2021 } });
  assert.deepEqual(latestAndPast([{ year: 2024, value: 3 }, { year: 2023, value: 2 }]), { value: 3, year: 2024, past: null });
  assert.equal(latestAndPast([]), null);
  // A one-deep answer joined with the by-years one: each year once, the first answer's figure kept, six at most.
  assert.deepEqual(
    mergeSeries(
      { TS: [{ year: 2025, value: 2 }] },
      {
        TS: [2025, 2024, 2023, 2022, 2021, 2020, 2019].map((year) => ({ year, value: year - 2000 })),
        FA: [{ year: 2020, value: 1 }],
      },
    ),
    {
      TS: [
        { year: 2025, value: 2 },
        { year: 2024, value: 24 },
        { year: 2023, value: 23 },
        { year: 2022, value: 22 },
        { year: 2021, value: 21 },
        { year: 2020, value: 20 },
      ],
      FA: [{ year: 2020, value: 1 }],
    },
  );
  assert.deepEqual(mergeSeries(null, undefined), {});
  // A year whose figures collapse marks a broken release (the OECD's urban PM2.5 release 1.5 wrote near-zero values for every city in 2023).
  const yearRows = (y, value, n = 25) => Array.from({ length: n }, (_, k) => ({ area: `A${k}`, year: y, value: value + k / 100 }));
  assert.deepEqual(collapsedYears([...yearRows(2021, 30), ...yearRows(2022, 28), ...yearRows(2023, 0.05), ...yearRows(2024, 26)]), [2023]);
  assert.deepEqual(collapsedYears([...yearRows(2021, 30), ...yearRows(2022, 15), ...yearRows(2023, 9)]), [], 'a real fall is no collapse');
  assert.deepEqual(collapsedYears([...yearRows(2021, 30), ...yearRows(2023, 0.05, 5)]), [], 'too few areas to judge');
  // Exact zeros are the OECD's no figure, not a collapse: a year of them, or half a year of them.
  const zeros = (y, n) => Array.from({ length: n }, (_, k) => ({ area: `Z${k}`, year: y, value: 0 }));
  assert.deepEqual(collapsedYears([...yearRows(2021, 30), ...yearRows(2022, 28), ...zeros(2023, 40)]), []);
  assert.deepEqual(collapsedYears([...yearRows(2021, 30), ...yearRows(2022, 28), ...zeros(2022, 40)]), []);
  assert.deepEqual(collapsedYears([]), []);
  const rows = readOecdCsv(OECD['DF_GDP,2.4']);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[3], {
    area: 'TS2',
    name: 'Southern Testland',
    iso3: 'TST',
    level: 'TL2',
    value: 30000,
    year: 2023,
  });
  assert.equal(readOecdCsv(OECD['DF_ECONOMY,1.1'])[2].name, 'Far, Away');
  assert.equal(readOecdCsv(OECD['DF_ECONOMY,1.1'])[0].iso3, null);
  assert.deepEqual(readOecdCsv(''), []);
});

test('the store fetches, caches, joins countries, hands figures down to states and cities, and backs off a failed source', async (t) => {
  const root = tmp();
  const packsDir = path.join(root, 'packs');
  writePacks(packsDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let clock = 1_000_000;
  const store = createAbundanceStore({
    root,
    packsDir,
    fetchImpl: fakeFetch(calls),
    now: () => clock,
    oecdPauseMs: 0,
    retryPauseMs: 0,
  });
  const before = store.status();
  assert.equal(before.stale, true);
  assert.equal(before.refreshedAt, null);
  assert.equal(before.sources.length, 28);

  await store.refresh({ force: true });
  const status = store.status();
  // Every source once, the failed OECD one twice in each of two passes, and
  // each World Bank answer one value deep (all but GDP here) asked again by years.
  assert.equal(calls.length, 28 + 3 + 14);
  const byYears = calls.filter((url) => /[?&]date=/.test(url));
  assert.equal(byYears.length, 14);
  const year = new Date(clock).getUTCFullYear();
  assert.ok(
    byYears.includes(
      `https://api.worldbank.org/v2/country/all/indicator/AG.LND.FRST.ZS?format=json&per_page=20000&date=${year - 15}:${year}`,
    ),
  );
  assert.ok(!byYears.some((url) => url.includes('NY.GDP.PCAP.PP.CD')), 'an answer with history is not asked again');
  assert.equal(status.refreshing, null);
  assert.equal(status.refreshedAt, clock);
  const safety = status.sources.find((s) => s.id.includes('DF_SAFETY'));
  assert.equal(safety.error, 'HTTP 500');
  assert.equal(safety.rows, 0);
  assert.equal(status.sources.find((s) => s.id === 'wb:NY.GDP.PCAP.PP.CD').rows, 3);
  assert.equal(status.stale, true, 'one source has no answer');
  assert.ok(
    fs.existsSync(path.join(root, '.gev-cache', 'abundance', 'wb_NY.GDP.PCAP.PP.CD.v2.json')),
  );

  // Countries: every World Bank and OWID figure, the price level as a ratio.
  const country = store.data('country');
  assert.equal(country.count, 3);
  const testland = unit(country, 'TST');
  assert.deepEqual(testland.values.gdp, { v: 50000, year: 2024, from: 'own', d: 10000, y0: 2019 });
  assert.deepEqual(testland.values.cost, { v: 1.2, year: 2024, from: 'own' });
  assert.deepEqual(testland.values.prison, { v: 110, year: 2024, from: 'own', d: 10, y0: 2020 });
  assert.deepEqual(testland.values.green, { v: 40, year: 2024, from: 'own', d: 2, y0: 2019 }, 'from the by-years answer');
  assert.equal(testland.values.happiness.v, 7.1);
  assert.equal(Object.keys(unit(country, 'NOL').values).length, 0);
  assert.deepEqual(country.coverage.gdp, { own: 2, area: 0, inherited: 0, year: 2024 });
  assert.equal(country.imported, null);

  // States: their own OECD figures (TL2 first, TL3 where TL2 has none, soft names), the rest from the country.
  const region = store.data('region');
  assert.equal(region.count, 6);
  const north = unit(region, 'TS-N');
  assert.deepEqual(north.values.gdp, { v: 60000, year: 2023, from: 'own', d: 10000, y0: 2018 });
  assert.deepEqual(north.values.life, { v: 84, year: 2022, from: 'own' });
  assert.deepEqual(north.values.health, { v: 0, year: 2023, from: 'own' }, 'a real zero stands');
  assert.deepEqual(north.values.inflation, { v: 2.5, year: 2025, from: 'country' });
  // A larger region's figure goes to the units inside it that have none; a compound name names each part.
  assert.deepEqual(unit(region, 'TS:isleton').values.life, { v: 79, year: 2023, from: 'own' }, 'the part of a compound TL3 name');
  assert.deepEqual(unit(region, 'TS-S').values.life, { v: 82, year: 2024, from: 'country' });
  assert.deepEqual(region.coverage.life, { own: 2, area: 0, inherited: 3, year: 2024 });
  assert.equal(unit(region, 'TS-S').values.gdp.v, 30000);
  assert.equal(unit(region, 'TS:isleton').values.gdp.v, 45000);
  assert.equal(unit(region, 'FA-X').values.gdp.v, 25000);
  assert.equal(unit(region, 'FA-X#2').values.gdp.from, 'country');
  assert.equal(Object.keys(unit(region, 'XX:nowhere region').values).length, 0);
  assert.deepEqual(region.coverage.gdp, { own: 4, area: 0, inherited: 1, year: 2024 });

  // Cities: their own urban-area figures, then the state's, then the country's.
  const city = store.data('city');
  const testville = unit(city, '1');
  assert.deepEqual(testville.values.gdp, { v: 70000, year: 2022, from: 'own' });
  // The world's places carry their country's places among the others, for the AI World tab.
  const features = store.worldFeatures({ worldId: 'w1', nodes: [{ country: 'TS' }, { country: 'FA' }, { country: 'ZZ' }] });
  assert.deepEqual(features.shape, [3, ABUNDANCE_INDICATOR_IDS.length + 1]);
  assert.equal(features.channels[0], 'abundance_gdp');
  assert.equal(features.channels.at(-1), 'abundance');
  assert.equal(features.data[0], 1, 'Testland first on GDP');
  assert.equal(features.data[features.shape[1]], 0, 'Farland last');
  assert.ok(Number.isNaN(features.data[2 * features.shape[1]]), 'no country, no figure');
  assert.ok(features.data[features.shape[1] - 1] > 0.5, 'the mean of its places');
  const written = store.writeWorldFeatures({ worldId: 'w1', nodes: [{ country: 'TS' }] }, path.join(root, 'demo'));
  assert.ok(fs.existsSync(written));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'demo', 'abundance-w1.json'), 'utf8')).channels.length, ABUNDANCE_INDICATOR_IDS.length + 1);
  assert.deepEqual(testville.values.work, { v: 4, year: 2024, from: 'own' });
  assert.deepEqual(testville.values.life, { v: 84, year: 2022, from: 'region' });
  assert.deepEqual(testville.values.inflation, { v: 2.5, year: 2025, from: 'country' });
  assert.deepEqual(unit(city, '2').values.gdp, { v: 30000, year: 2023, from: 'region' });
  assert.deepEqual(unit(city, '2').values.work, { v: 6, year: 2024, from: 'own' }, 'Southport and Beyond is Southport');
  assert.deepEqual(unit(city, '3').values.work, { v: 7, year: 2024, from: 'own' }, 'Farshire West and Farcity names Farcity');
  assert.equal(unit(city, '3').values.gdp.v, 40000);
  assert.equal(Object.keys(unit(city, '4').values).length, 0);

  // A failed source is not asked again before the retry wait; a stale one is after it.
  const beforeData = calls.length;
  store.data('country');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, beforeData, 'no refresh within the retry wait');
  clock += ABUNDANCE_RETRY_MS + 1;
  store.data('country');
  for (let i = 0; i < 50 && calls.length < beforeData + 4; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, beforeData + 4, 'only the failed source again (two passes of two tries)');

  // The owner's CSV goes on top, by id for countries and by name and country for states.
  const imported = store.importCsv({
    level: 'country',
    csv: 'id,year,gdp,HAPPINESS,colour\nTST,2026,55555,8,red\nXXX,2026,1,1,\n',
  });
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.imported, {
    rows: 2,
    matched: 1,
    ignored: ['colour'],
    error: null,
    at: imported.imported.at,
  });
  assert.deepEqual(unit(store.data('country'), 'TST').values.gdp, { v: 55555, year: 2026, from: 'csv' });
  assert.equal(unit(store.data('region'), 'TS-S').values.inflation.from, 'country');
  assert.deepEqual(unit(store.data('region'), 'FA-X#2').values.gdp, { v: 20000, year: 2024, from: 'country' });
  store.importCsv({ level: 'region', csv: 'name,country,work\nFar East,Farland,9\nIsle Town,TS,1\n' });
  assert.equal(unit(store.data('region'), 'FA-X#2').values.work.v, 9);
  assert.equal(unit(store.data('region'), 'TS:isleton').values.work.from, 'csv');
  assert.equal(unit(store.data('city'), '2').values.gdp.v, 30000, 'the state own figure still comes first');
  assert.deepEqual(unit(store.data('city'), '2').values.happiness, { v: 8, year: 2026, from: 'country' }, 'a city follows its country CSV figure through the state');
  assert.ok(fs.existsSync(path.join(root, '.gev-data', 'abundance', 'region.csv')));
  assert.match(store.importCsv({ level: 'country', csv: 'a,b\n1,2' }).error, /indicator column/);
  store.clearImport({ level: 'country' });
  assert.equal(unit(store.data('country'), 'TST').values.gdp.v, 50000);
  assert.equal(fs.existsSync(path.join(root, '.gev-data', 'abundance', 'country.csv')), false);

  // A second store on the same root reads the cache: no fetch.
  const again = createAbundanceStore({
    root,
    packsDir,
    fetchImpl: async () => {
      throw new Error('no network');
    },
    now: () => clock,
    oecdPauseMs: 0,
    retryPauseMs: 0,
  });
  assert.equal(unit(again.data('country'), 'FAR').values.gdp.v, 20000);
  assert.equal(again.status().sources.find((s) => s.id === 'wb:NY.GDP.PCAP.PP.CD').fetchedAt, 1_000_000);
  // An answer cached for another URL (another release, key or query) is not this source's answer.
  const gdpCache = path.join(root, '.gev-cache', 'abundance', 'wb_NY.GDP.PCAP.PP.CD.v2.json');
  const cached = JSON.parse(fs.readFileSync(gdpCache, 'utf8'));
  fs.writeFileSync(gdpCache, JSON.stringify({ ...cached, url: cached.url.replace('mrnev=6', 'mrnev=1') }));
  const third = createAbundanceStore({
    root,
    packsDir,
    fetchImpl: async () => {
      throw new Error('no network');
    },
    now: () => clock,
  });
  assert.equal(third.status().sources.find((s) => s.id === 'wb:NY.GDP.PCAP.PP.CD').fetchedAt, null);
  assert.equal(third.status().sources.find((s) => s.id === 'wb:SP.DYN.LE00.IN').fetchedAt, 1_000_000);
  store.close();
  again.close();
  third.close();
});

test('a release whose figures collapse in a year is refused, and the last good answer stays in use', async (t) => {
  const root = tmp();
  const packsDir = path.join(root, 'packs');
  writePacks(packsDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Green space for 25 urban areas, Testville among them; the broken release writes near zero for 2022.
  const greenCsv = (broken) =>
    [
      'STRUCTURE,STRUCTURE_ID,ACTION,REF_AREA,"Reference area",FREQ,MEASURE,TERRITORIAL_LEVEL,TIME_PERIOD,OBS_VALUE',
      ...Array.from({ length: 25 }, (_, k) => k).flatMap((k) =>
        [2021, 2022, 2023].map((y) => {
          const name = k === 1 ? 'Testville' : `Green Town ${k}`;
          const value = broken && y === 2022 ? 0.01 : 100 + k + (y - 2021) * 10;
          return `DATAFLOW,x,I,TS${String(k).padStart(3, '0')}F,${name},A,GREEN_AREA,FUA,${y},${value}`;
        }),
      ),
    ].join('\n');
  let broken = false;
  const response = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  });
  const store = createAbundanceStore({
    root,
    packsDir,
    fetchImpl: async (url) => (url.includes('DF_GREEN_AREA') ? response(200, greenCsv(broken)) : response(404, 'nope')),
    now: () => 2_000_000,
    oecdPauseMs: 0,
    retryPauseMs: 0,
  });
  const greenOf = () => store.status().sources.find((s) => s.id.includes('DF_GREEN_AREA'));
  await store.refresh({ force: true });
  assert.equal(greenOf().error, null);
  assert.deepEqual(unit(store.data('city'), '1').values.green, { v: 121, year: 2023, from: 'own' });
  broken = true;
  await store.refresh({ force: true });
  assert.equal(greenOf().error, 'broken release: the 2022 figures are near zero');
  assert.deepEqual(unit(store.data('city'), '1').values.green, { v: 121, year: 2023, from: 'own' }, 'the last good answer');
  store.close();
});

// --- the routes -----------------------------------------------------------------------

/** The provider's middleware with a fake server. */
function install(plugin) {
  let handler;
  plugin.configureServer({
    httpServer: null,
    middlewares: { use: (_mount, fn) => (handler = fn) },
  });
  return async (
    url,
    { method = 'GET', headers = {}, remoteAddress = '127.0.0.1', body } = {},
  ) => {
    const chunks =
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = new EventEmitter();
    Object.assign(req, { url, method, headers, socket: { remoteAddress } });
    req[Symbol.asyncIterator] = async function* () {
      yield* chunks;
    };
    setImmediate(() => {
      for (const c of chunks) req.emit('data', c);
      req.emit('end');
    });
    const res = {
      headersSent: false,
      writeHead(status, h) {
        Object.assign(this, { status, headers: h, headersSent: true });
      },
      setHeader() {},
      end(chunk) {
        this.body = String(chunk ?? '');
      },
      destroy() {},
    };
    await handler(req, res);
    return res;
  };
}

const TOKEN = '7'.repeat(64);
const MIRROR = 'http://100.64.0.1:4173';
const pc = {
  host: 'localhost:4173',
  origin: 'http://localhost:4173',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
};
const owner = {
  host: '100.64.0.1:4173',
  origin: MIRROR,
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
  [OWNER_DEVICE_HEADER]: TOKEN,
  [OWNER_DEVICE_AUTHORITY_HEADER]: MIRROR,
};

test('the routes: status and data read, refresh and a CSV from the PC and the owner phone, but the phone never clears one', async (t) => {
  setOwnerDeviceToken(TOKEN);
  t.after(() => setOwnerDeviceToken(''));
  const seen = [];
  const store = {
    status: () => ({ sources: [], levels: {}, refreshing: null }),
    data: (level) => (seen.push(['data', level]), { level, units: [], figures: {} }),
    refresh: (o) => (seen.push(['refresh', o]), Promise.resolve({})),
    importCsv: (b) => (seen.push(['import', b.level]), b.csv === 'bad' ? { error: 'No indicator column was found.' } : { ok: true }),
    clearImport: (b) => (seen.push(['clear', b.level]), { ok: true }),
    close: () => seen.push(['close']),
  };
  const request = install(abundanceProvider({ root: tmp(), env: {}, createStore: () => store, log: () => {} }));
  let res = await request('/status', { headers: pc });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).sources, []);
  res = await request('/data?level=city', { headers: pc });
  assert.equal(JSON.parse(res.body).level, 'city');
  res = await request('/refresh', { method: 'POST', headers: pc, body: { force: true } });
  assert.equal(res.status, 200);
  res = await request('/import', { method: 'POST', headers: pc, body: { level: 'region', csv: 'bad' } });
  assert.equal(res.status, 400);
  res = await request('/import', { method: 'POST', headers: owner, remoteAddress: '100.64.0.9', body: { level: 'region', csv: 'id,gdp\nTST,1' } });
  assert.equal(res.status, 200, 'the phone may load a CSV');
  const refused = await request('/import', { method: 'DELETE', headers: owner, remoteAddress: '100.64.0.9', body: { level: 'region' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers[OWNER_DEVICE_REMOVAL_HEADER], 'pc-only');
  res = await request('/import', { method: 'DELETE', headers: pc, body: { level: 'region' } });
  assert.equal(res.status, 200);
  res = await request('/nothing', { headers: pc });
  assert.equal(res.status, 404);
  res = await request('/status', { headers: { host: 'evil.example' }, remoteAddress: '203.0.113.9' });
  assert.equal(res.status, 403);
  assert.deepEqual(seen, [
    ['data', 'city'],
    ['refresh', { force: true }],
    ['import', 'region'],
    ['import', 'region'],
    ['clear', 'region'],
  ]);
});
