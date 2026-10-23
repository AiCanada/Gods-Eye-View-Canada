/**
 * GLOBAL ABUNDANCE MAP (owner request 2026-10-22: "Global abundance grid,
 * idea to replace resource scarcity with algorithmic orchestration … display
 * Global abundance on MAP … use GDP per person, Life Span, Health, Income,
 * Inflation, Expense/Cost, Education, Infrastructure, % in Prison, Utils,
 * Happiness, etc. … by country/state/province/city, all or just selected
 * indicators").
 *
 * The indicators that measure abundance, where each one's figures come from
 * at each level, the score that puts the chosen ones together, the colours,
 * the ranking and the grid links. Pure: the server builds the figures with
 * it (server/shared/abundanceData.mjs) and the tab draws with it
 * (src/abundancePanel.js, src/abundanceOverlay.js). The labels are marked
 * with msgl() and shown through tl().
 */
import { msgl } from './i18n/marker.js';

/** The levels the map draws, finest last. */
export const ABUNDANCE_LEVELS = Object.freeze(['country', 'region', 'city']);

/** The tab tells the globe what to draw (the level, every unit's score and colour, the links). */
export const ABUNDANCE_VIEW_EVENT = 'abundance:view';
/** The tab tells the globe which unit is selected and what its card says. */
export const ABUNDANCE_CARD_EVENT = 'abundance:card';
/** The globe tells the tab what the pointer rests on (hover) or clicked. */
export const ABUNDANCE_PICK_EVENT = 'abundance:pick';

export const ABUNDANCE_LEVEL_LABELS = Object.freeze({
  country: msgl('COUNTRIES'),
  region: msgl('STATES AND PROVINCES'),
  city: msgl('CITIES'),
});

/** The World Bank's World Development Indicators (CC BY 4.0), by country. */
const worldBank = (code, measure) => ({ kind: 'worldbank', code, measure });
/** Our World in Data's grapher CSV (CC BY 4.0), by country. */
const owid = (slug, column, measure) => ({
  kind: 'owid',
  slug,
  column,
  measure,
});
/** A price level: one World Bank series over another. */
const ratio = (of, by, measure) => ({ kind: 'ratio', of, by, measure });
/**
 * The OECD regional database (OECD terms: free re-use with attribution),
 * SDMX CSV. `key` is the dataflow's key with `{level}` where the territorial
 * level goes: TL2 (states, provinces, large regions) and TL3 (small regions)
 * for the state level, FUA (functional urban areas) for the city level.
 */
const oecd = (flow, version, key, measure) => ({
  kind: 'oecd',
  flow,
  version,
  key,
  measure,
});

/**
 * The indicators, in the owner's order. `better` says which way abundance
 * lies; `decimals` how a value is written; `positive` that every real
 * figure is above zero, so a zero is no figure (the OECD writes 0 for a
 * region it has none for: tertiary education in half its small regions).
 * Each level names its own source
 * and measure; a level without one takes the figure of the unit above it
 * (a state its country's, a city its state's or country's) and says so.
 */
export const ABUNDANCE_INDICATORS = Object.freeze([
  {
    id: 'gdp',
    label: msgl('GDP PER PERSON'),
    better: 'high',
    positive: true,
    decimals: 0,
    unit: '$',
    country: worldBank(
      'NY.GDP.PCAP.PP.CD',
      msgl('GDP PER PERSON, PPP, INTERNATIONAL $'),
    ),
    region: oecd(
      'DSD_REG_ECO@DF_GDP',
      '2.4',
      'A.{level}...GDP._T.V.USD_PPP_PS',
      msgl('GDP PER PERSON, PPP, US $'),
    ),
    city: oecd(
      'DSD_FUA_ECO@DF_ECONOMY',
      '1.1',
      '.A.GDP.USD_PPP_PS.{level}',
      msgl('GDP PER PERSON OF THE URBAN AREA, PPP, US $'),
    ),
  },
  {
    id: 'life',
    label: msgl('LIFE SPAN'),
    better: 'high',
    positive: true,
    decimals: 1,
    unit: msgl('YEARS'),
    country: worldBank('SP.DYN.LE00.IN', msgl('LIFE EXPECTANCY AT BIRTH')),
    region: oecd(
      'DSD_REG_DEMO@DF_LIFE_EXP',
      '2.4',
      'A.{level}...LFEXP.Y0._T.Y',
      msgl('LIFE EXPECTANCY AT BIRTH'),
    ),
  },
  {
    id: 'health',
    label: msgl('HEALTH'),
    better: 'low',
    decimals: 1,
    country: worldBank(
      'SH.DYN.MORT',
      msgl('CHILDREN DYING BEFORE AGE 5, PER 1,000 BIRTHS'),
    ),
    region: oecd(
      'DSD_REG_HEALTH@DF_STATUS',
      '2.5',
      'A.{level}...MORT_INFANT.Y_LT1._T.DT_10P3BR_L',
      msgl('INFANTS DYING BEFORE AGE 1, PER 1,000 BIRTHS'),
    ),
  },
  {
    id: 'income',
    label: msgl('INCOME'),
    better: 'high',
    positive: true,
    decimals: 0,
    unit: '$',
    country: worldBank(
      'NY.GNP.PCAP.PP.CD',
      msgl('NATIONAL INCOME PER PERSON, PPP, INTERNATIONAL $'),
    ),
    region: oecd(
      'DSD_REG_ECO@DF_INC',
      '2.4',
      'A.{level}...B6N._T.V.USD_PPP_PS',
      msgl('DISPOSABLE INCOME PER PERSON, PPP, US $'),
    ),
  },
  {
    id: 'inflation',
    label: msgl('INFLATION'),
    better: 'low',
    decimals: 1,
    unit: '%',
    country: worldBank('FP.CPI.TOTL.ZG', msgl('CONSUMER PRICES, % A YEAR')),
  },
  {
    id: 'cost',
    label: msgl('COST OF LIVING'),
    better: 'low',
    decimals: 2,
    country: ratio(
      'PA.NUS.PRVT.PP',
      'PA.NUS.FCRF',
      msgl('PRICE LEVEL AGAINST THE USA (1 = THE SAME PRICES)'),
    ),
  },
  {
    id: 'education',
    label: msgl('EDUCATION'),
    better: 'high',
    positive: true,
    decimals: 0,
    unit: '%',
    country: worldBank(
      'SE.SEC.ENRR',
      msgl('SECONDARY SCHOOL ENROLMENT, % GROSS'),
    ),
    region: oecd(
      'DSD_REG_EDU@DF_ATTAIN',
      '2.5',
      'A.{level}...NEAC_SHARE_EA.Y25T64._T.ISCED11_5T8.MEAN.PT_POP_SEX_AGE',
      msgl('ADULTS 25–64 WITH TERTIARY EDUCATION, %'),
    ),
  },
  {
    id: 'infrastructure',
    label: msgl('INFRASTRUCTURE'),
    better: 'high',
    decimals: 0,
    unit: '%',
    country: worldBank('IT.NET.USER.ZS', msgl('PEOPLE USING THE INTERNET, %')),
  },
  {
    id: 'prison',
    label: msgl('SHARE IN PRISON'),
    better: 'low',
    decimals: 0,
    country: owid(
      'prison-population-rate',
      'prison_population_rate',
      msgl('PRISONERS PER 100,000 PEOPLE'),
    ),
  },
  {
    id: 'utilities',
    label: msgl('UTILITIES'),
    better: 'high',
    decimals: 0,
    unit: '%',
    country: worldBank('EG.ELC.ACCS.ZS', msgl('PEOPLE WITH ELECTRICITY, %')),
  },
  {
    id: 'water',
    label: msgl('WATER'),
    better: 'high',
    decimals: 0,
    unit: '%',
    country: worldBank(
      'SH.H2O.BASW.ZS',
      msgl('PEOPLE WITH BASIC DRINKING WATER, %'),
    ),
  },
  {
    id: 'happiness',
    label: msgl('HAPPINESS'),
    better: 'high',
    decimals: 2,
    country: owid(
      'happiness-cantril-ladder',
      'cantril_ladder_score',
      msgl('LIFE SATISFACTION, 0 TO 10 (WORLD HAPPINESS REPORT)'),
    ),
  },
  {
    id: 'safety',
    label: msgl('SAFETY'),
    better: 'low',
    decimals: 1,
    country: worldBank('VC.IHR.PSRC.P5', msgl('HOMICIDES PER 100,000 PEOPLE')),
    region: oecd(
      'DSD_REG_SOC@DF_SAFETY',
      '2.4',
      'A.{level}...HOMIC._T._T.CS_10P5PS',
      msgl('HOMICIDES PER 100,000 PEOPLE'),
    ),
  },
  {
    id: 'work',
    label: msgl('WORK'),
    better: 'low',
    decimals: 1,
    unit: '%',
    country: worldBank(
      'SL.UEM.TOTL.ZS',
      msgl('UNEMPLOYMENT, % OF THE LABOUR FORCE'),
    ),
    region: oecd(
      'DSD_REG_LAB@DF_RATES',
      '2.4',
      'A.{level}...UNE_RATE.Y15T64._T.PT_LF_SUB',
      msgl('UNEMPLOYMENT, % OF THE LABOUR FORCE AGED 15–64'),
    ),
    city: oecd(
      'DSD_FUA_LAB@DF_LABOUR',
      '1.1',
      '.A.UNE_RATE.PT_LF_SUB.Y15T64.{level}',
      msgl('UNEMPLOYMENT IN THE URBAN AREA, % OF THE LABOUR FORCE AGED 15–64'),
    ),
  },
  {
    id: 'air',
    label: msgl('AIR'),
    better: 'low',
    positive: true,
    decimals: 1,
    unit: 'µg/m³',
    country: worldBank(
      'EN.ATM.PM25.MC.M3',
      msgl('FINE PARTICLES (PM2.5) BREATHED OVER A YEAR'),
    ),
    // Release 1.2 (2021-2023), not 1.5: the OECD's 1.5 release of
    // 2026-10-09 is corrupt. Every 2023 value is near zero, for every urban
    // area and all four pollutants, and its 2021 and 2022 values are 1 to 5
    // times 1.2's for the same city and year (Halifax 32.2 against 7.0,
    // Edmonton 65.4 against 12.5, London 30.3 against 10.9). Release 1.2
    // has no DESIGNATION dimension: seven key positions.
    city: oecd(
      'DSD_FUA_ENV@DF_POLLUTION',
      '1.2',
      '.A.PM25_POP_EXP.MCG_M3._Z._Z.{level}',
      msgl('FINE PARTICLES (PM2.5) BREATHED IN THE URBAN AREA OVER A YEAR'),
    ),
  },
  {
    id: 'green',
    label: msgl('GREEN SPACE'),
    better: 'high',
    decimals: 0,
    country: worldBank('AG.LND.FRST.ZS', msgl('FOREST, % OF THE LAND')),
    city: oecd(
      'DSD_FUA_ENV@DF_GREEN_AREA',
      '1.2',
      '.A.GREEN_AREA.M2_PS._Z._Z.{level}',
      msgl('GREEN SPACE IN THE URBAN CENTRE, M² PER PERSON'),
    ),
  },
]);

export const ABUNDANCE_INDICATOR_IDS = Object.freeze(
  ABUNDANCE_INDICATORS.map((i) => i.id),
);

/** The indicator with this id, or null. */
export function indicatorById(id) {
  return ABUNDANCE_INDICATORS.find((i) => i.id === id) || null;
}

/** Known indicator ids only, in the catalogue's order, each once. */
export function cleanIndicatorIds(ids) {
  const wanted = new Set(Array.isArray(ids) ? ids.map(String) : []);
  return ABUNDANCE_INDICATOR_IDS.filter((id) => wanted.has(id));
}

/** A known level, else the country level. */
export function cleanLevel(level) {
  return ABUNDANCE_LEVELS.includes(level) ? level : 'country';
}

/** Where a unit's figure came from: its own source, the owner's CSV, or the unit above. */
export const FIGURE_FROM = Object.freeze([
  'own',
  'csv',
  'region',
  'country',
  'area',
]);

/** The weight a ticked indicator carries in the score: ×0.5 to ×3, by halves; 1 by default. */
export const WEIGHT_MIN = 0.5;
export const WEIGHT_MAX = 3;
export const WEIGHT_STEP = 0.5;

/** A weight within range, rounded to the step; 1 for anything else. */
export function cleanWeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  const stepped = Math.round(n / WEIGHT_STEP) * WEIGHT_STEP;
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, stepped));
}

/** Known indicators' weights other than 1, as { id: weight }. */
export function cleanWeights(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of ABUNDANCE_INDICATOR_IDS) {
    if (!(id in raw)) continue;
    const w = cleanWeight(raw[id]);
    if (w !== 1) out[id] = w;
  }
  return out;
}

/**
 * The SDMX key of an OECD source for one level: TL2 and TL3 regions for the
 * state level, functional urban areas for cities.
 */
export function oecdKey(source, level) {
  return String(source.key).replace(
    '{level}',
    level === 'city' ? 'FUA' : 'TL2+TL3',
  );
}

/** The measure text of an indicator at a level, else its country's. */
export function indicatorMeasure(indicator, level) {
  return (
    indicator?.[level]?.measure ||
    indicator?.country?.measure ||
    indicator?.label ||
    ''
  );
}

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Each unit's place among the others for one indicator, 0 (the least
 * abundant) to 100 (the most), the way abundance lies for that indicator:
 * the highest inflation scores 0, the highest income 100. Ties share their
 * mean place. One unit alone scores 50.
 * @param {Array<{id: string, values?: object}>} units
 * @param {{id: string, better: 'high'|'low'}} indicator
 * @returns {Map<string, number>}
 */
export function indicatorRanks(units, indicator) {
  const rows = [];
  for (const u of units || []) {
    const v = Number(u?.values?.[indicator.id]?.v);
    if (Number.isFinite(v)) rows.push([u.id, v]);
  }
  rows.sort((a, b) => a[1] - b[1]);
  const n = rows.length;
  const ranks = new Map();
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && rows[j + 1][1] === rows[i][1]) j += 1;
    const place = n === 1 ? 50 : ((i + (j - i) / 2) / (n - 1)) * 100;
    const rank = indicator.better === 'low' ? 100 - place : place;
    for (let k = i; k <= j; k++) ranks.set(rows[k][0], rank);
    i = j + 1;
  }
  return ranks;
}

/**
 * The abundance score of every unit: the mean place over the chosen
 * indicators it has a figure for (null with none), with each place kept.
 * @returns {Map<string, {score: number|null, ranks: object, counted: number, of: number}>}
 */
export function scoreUnits(
  units,
  indicatorIds,
  indicators = ABUNDANCE_INDICATORS,
  weights = {},
) {
  const wanted = new Set(cleanIndicatorIds(indicatorIds));
  const chosen = indicators.filter((i) => wanted.has(i.id));
  const byIndicator = chosen.map((i) => [
    i.id,
    indicatorRanks(units, i),
    cleanWeight(weights?.[i.id] ?? 1),
  ]);
  const out = new Map();
  for (const u of units || []) {
    let sum = 0;
    let weight = 0;
    let counted = 0;
    const ranks = {};
    for (const [id, map, w] of byIndicator) {
      const r = map.get(u.id);
      if (r === undefined) continue;
      ranks[id] = r;
      sum += r * w;
      weight += w;
      counted += 1;
    }
    out.set(u.id, {
      score: counted && weight > 0 ? sum / weight : null,
      ranks,
      counted,
      of: chosen.length,
    });
  }
  return out;
}

/**
 * The lowest, median and highest figure of one indicator among the units,
 * for the legend; null with none.
 * @returns {{min: number, median: number, max: number, n: number}|null}
 */
export function indicatorStats(units, indicator) {
  const values = [];
  for (const u of units || []) {
    const v = Number(u?.values?.[indicator?.id]?.v);
    if (Number.isFinite(v)) values.push(v);
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const mid = (values.length - 1) / 2;
  const median =
    values.length % 2
      ? values[mid]
      : (values[Math.floor(mid)] + values[Math.ceil(mid)]) / 2;
  return {
    min: values[0],
    median,
    max: values[values.length - 1],
    n: values.length,
  };
}

/** The colour ramp: scarce (red) through amber to abundant (green). */
export const ABUNDANCE_RAMP = Object.freeze([
  Object.freeze([0, '#ff2a2a']),
  Object.freeze([50, '#ffd21a']),
  Object.freeze([100, '#19e6b0']),
]);
/** A unit with no figure for any chosen indicator. */
export const ABUNDANCE_NO_DATA_COLOR = '#5a6670';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(Math.max(0, Math.min(255, c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The colour of a score, interpolated along the ramp; grey with none. */
export function scoreColor(score) {
  if (score === null || score === undefined || score === '')
    return ABUNDANCE_NO_DATA_COLOR;
  const s = Number(score);
  if (!Number.isFinite(s)) return ABUNDANCE_NO_DATA_COLOR;
  const x = Math.max(0, Math.min(100, s));
  for (let i = 1; i < ABUNDANCE_RAMP.length; i++) {
    const [at0, c0] = ABUNDANCE_RAMP[i - 1];
    const [at1, c1] = ABUNDANCE_RAMP[i];
    if (x > at1) continue;
    const t = at1 === at0 ? 0 : (x - at0) / (at1 - at0);
    const a = hexToRgb(c0);
    const b = hexToRgb(c1);
    return rgbToHex(a.map((v, k) => v + (b[k] - v) * t));
  }
  return ABUNDANCE_RAMP[ABUNDANCE_RAMP.length - 1][1];
}

/** The units with a score, most abundant first. */
export function rankUnits(units, scores) {
  return (units || [])
    .map((u) => ({ id: u.id, name: u.name, score: scores.get(u.id)?.score }))
    .filter((r) => Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score || String(a.name).localeCompare(b.name));
}

/**
 * The abundance grid, a first model of the owner's orchestration layer:
 * every scarce place (a score at or under `deficit`) is linked to the
 * nearest abundant one (at or over `surplus`), the scarcest first, up to
 * `max` links. Each link says how far and how wide the gap is.
 * @returns {Array<{from: string, to: string, km: number, gap: number}>}
 */
export function abundanceLinks(
  units,
  scores,
  { max = 60, surplus = 75, deficit = 25 } = {},
) {
  const placed = (u) => Number.isFinite(u?.lat) && Number.isFinite(u?.lon);
  const rich = [];
  const poor = [];
  for (const u of units || []) {
    const s = scores.get(u.id)?.score;
    if (!Number.isFinite(s) || !placed(u)) continue;
    if (s >= surplus) rich.push(u);
    else if (s <= deficit) poor.push(u);
  }
  if (!rich.length || !poor.length) return [];
  poor.sort((a, b) => scores.get(a.id).score - scores.get(b.id).score);
  const links = [];
  for (const p of poor.slice(0, Math.max(0, max))) {
    let best = null;
    let bestKm = Infinity;
    for (const r of rich) {
      const km = distanceKm(p.lat, p.lon, r.lat, r.lon);
      if (km < bestKm) {
        bestKm = km;
        best = r;
      }
    }
    links.push({
      from: best.id,
      to: p.id,
      km: Math.round(bestKm),
      gap: Math.round(scores.get(best.id).score - scores.get(p.id).score),
    });
  }
  return links;
}

/**
 * How many units have a figure of their own for each indicator, how many
 * take the unit above's, and the newest year among them.
 */
export function coverageOf(units, indicatorIds = ABUNDANCE_INDICATOR_IDS) {
  const out = {};
  for (const id of cleanIndicatorIds(indicatorIds)) {
    let own = 0;
    let area = 0;
    let inherited = 0;
    let year = null;
    for (const u of units || []) {
      const f = u?.values?.[id];
      if (!f || !Number.isFinite(Number(f.v))) continue;
      if (f.from === 'own' || f.from === 'csv') own += 1;
      else if (f.from === 'area') area += 1;
      else inherited += 1;
      if (Number.isFinite(f.year) && (year === null || f.year > year))
        year = f.year;
    }
    out[id] = { own, area, inherited, year };
  }
  return out;
}

/** A figure written for the screen, English digits: 12,345 or 7.2. */
export function formatFigure(indicator, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '';
  const decimals = Number.isFinite(indicator?.decimals)
    ? indicator.decimals
    : 1;
  const [whole, fraction] = Math.abs(v).toFixed(decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // A small negative that rounds to nothing is no negative: 0, never -0.
  const zero = /^0+$/.test(whole) && /^0*$/.test(fraction || '');
  return `${v < 0 && !zero ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/**
 * The table the server sends, made into units with values: the figures
 * travel as one array per indicator, in the units' order, to keep the
 * payload small.
 * @param {{units: object[], figures: object}} table
 */
export function expandTable(table) {
  const units = Array.isArray(table?.units) ? table.units : [];
  const figures = table?.figures || {};
  return units.map((u, k) => {
    const values = {};
    for (const [id, column] of Object.entries(figures)) {
      const v = column?.v?.[k];
      if (v === null || v === undefined || !Number.isFinite(Number(v)))
        continue;
      values[id] = {
        v: Number(v),
        year: column.year?.[k] ?? null,
        from: FIGURE_FROM[column.from?.[k]] || 'own',
      };
      const d = column.d?.[k];
      if (d !== null && d !== undefined && Number.isFinite(Number(d))) {
        values[id].d = Number(d);
        values[id].y0 = column.y0?.[k] ?? null;
      }
    }
    return { ...u, values };
  });
}

/** The reverse of expandTable: units with values into the columnar table. */
export function packTable(units) {
  const figures = {};
  const list = (units || []).map((u) => {
    const { values, ...rest } = u;
    return rest;
  });
  for (const id of ABUNDANCE_INDICATOR_IDS) {
    const v = [];
    const year = [];
    const from = [];
    const d = [];
    const y0 = [];
    let any = false;
    let trend = false;
    for (const u of units || []) {
      const f = u?.values?.[id];
      if (f && Number.isFinite(Number(f.v))) {
        any = true;
        v.push(Number(f.v));
        year.push(Number.isFinite(f.year) ? f.year : null);
        from.push(Math.max(0, FIGURE_FROM.indexOf(f.from)));
        if (Number.isFinite(f.d)) {
          trend = true;
          d.push(f.d);
          y0.push(Number.isFinite(f.y0) ? f.y0 : null);
        } else {
          d.push(null);
          y0.push(null);
        }
      } else {
        v.push(null);
        year.push(null);
        from.push(0);
        d.push(null);
        y0.push(null);
      }
    }
    if (any) figures[id] = trend ? { v, year, from, d, y0 } : { v, year, from };
  }
  return { units: list, figures };
}

/** RFC 4180 rows (quotes, doubled quotes, CRLF). */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const HEADER_WORDS = Object.freeze({
  id: 'id',
  code: 'id',
  iso: 'id',
  iso3: 'id',
  'iso 3166-2': 'id',
  name: 'name',
  place: 'name',
  region: 'name',
  city: 'name',
  state: 'name',
  province: 'name',
  country: 'country',
  iso2: 'country',
  year: 'year',
});

/** A number from a CSV cell: commas, spaces, $, % and blanks allowed. */
export function csvNumber(cell) {
  const text = String(cell ?? '')
    .trim()
    .replace(/[\s,$%€£]/g, '');
  if (text === '' || text === '-' || /^(n\/?a|null|none)$/i.test(text))
    return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * The owner's own figures from a CSV file: a header naming the place (`id`
 * for a unit id: ISO3 for a country, ISO 3166-2 for a state or province,
 * the Natural Earth id for a city; or `name` with `country`), an optional
 * `year`, then one column per indicator, by id (`gdp`) or by its label (`GDP
 * PER PERSON`), in any case. Columns it does not know are listed back.
 * @returns {{rows: Array<{id: string|null, name: string|null, country: string|null, year: number|null, values: object}>, ignored: string[], error?: string}}
 */
export function parseAbundanceCsv(text, indicators = ABUNDANCE_INDICATORS) {
  const rows = parseCsvRows(text);
  if (rows.length < 2)
    return {
      rows: [],
      ignored: [],
      error: 'The CSV needs a header and a row.',
    };
  const header = rows[0].map((h) => String(h).trim());
  const columns = [];
  const ignored = [];
  for (const [k, raw] of header.entries()) {
    const key = raw.toLowerCase();
    const upper = raw.toUpperCase();
    const indicator = indicators.find(
      (i) => i.id === key || String(i.label).toUpperCase() === upper,
    );
    if (indicator) columns.push({ k, field: 'value', id: indicator.id });
    else if (HEADER_WORDS[key]) columns.push({ k, field: HEADER_WORDS[key] });
    else ignored.push(raw);
  }
  if (!columns.some((c) => c.field === 'value'))
    return { rows: [], ignored, error: 'No indicator column was found.' };
  if (!columns.some((c) => c.field === 'id' || c.field === 'name'))
    return {
      rows: [],
      ignored,
      error: 'The CSV needs an id column or a name column.',
    };
  const out = [];
  for (const cells of rows.slice(1)) {
    const row = { id: null, name: null, country: null, year: null, values: {} };
    for (const column of columns) {
      const cell = cells[column.k];
      if (column.field === 'value') {
        const n = csvNumber(cell);
        if (n !== null) row.values[column.id] = n;
      } else if (column.field === 'year') {
        const n = csvNumber(cell);
        if (n !== null) row.year = Math.round(n);
      } else {
        const text = String(cell ?? '').trim();
        if (text && !row[column.field]) row[column.field] = text;
      }
    }
    if ((row.id || row.name) && Object.keys(row.values).length) out.push(row);
  }
  return { rows: out, ignored };
}
