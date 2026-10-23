/**
 * The places the GLOBAL ABUNDANCE MAP scores, from the bundled Natural
 * Earth packs (src/data/local_data/natural_earth/): countries (admin-0),
 * states and provinces (admin-1) and populated places. Each unit carries a
 * stable id, shared by the server that attaches figures to it
 * (server/shared/abundanceData.mjs) and the globe that draws its shape
 * (src/abundanceShapes.js): a country's ADM0_A3 code, a state's ISO 3166-2
 * code, a city's Natural Earth id. Pure: packs in, units out, plus the
 * name matching that joins a source's place names to them.
 */
import { decodeRing, normalizeAdminName } from './data/adminBoundaries.js';

/** Area-weighted centroid of an open ring (planar; fine at unit scale). */
function ringCentroid(ring) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j];
    const [x1, y1] = ring[i];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (!a) return { lon: ring[0]?.[0] ?? 0, lat: ring[0]?.[1] ?? 0 };
  return { lon: cx / (3 * a), lat: cy / (3 * a) };
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** A feature's point: its label point, else the centroid of its largest part. */
function featurePoint(feature, decimals) {
  if (Array.isArray(feature.label) && feature.label.length === 2)
    return { lon: feature.label[0], lat: feature.label[1] };
  const ring = feature.polygons?.[0]?.[0];
  if (!ring) return { lon: null, lat: null };
  const { lon, lat } = ringCentroid(decodeRing(ring, feature.d ?? decimals));
  return { lon: round3(lon), lat: round3(lat) };
}

/**
 * The countries: every admin-0 unit of type Country (the United Kingdom's
 * constituent countries are left to it). Id: the ADM0_A3 code. The
 * entries carry the pack feature beside the unit, for the globe's shapes.
 */
export function countryEntries(pack) {
  const decimals = pack?.meta?.decimals ?? 3;
  const out = [];
  for (const feature of pack?.features || []) {
    if (feature.type !== 'Country' || !feature.iso) continue;
    const { lon, lat } = featurePoint(feature, decimals);
    out.push({
      feature,
      decimals: feature.d ?? decimals,
      unit: {
        id: feature.iso,
        name: feature.name,
        alt: feature.alt || [],
        country: feature.name,
        iso2: /^[A-Z]{2}$/.test(feature.iso2 || '') ? feature.iso2 : null,
        lat,
        lon,
      },
    });
  }
  return out;
}

export function countryUnits(pack) {
  return countryEntries(pack).map((e) => e.unit);
}

/**
 * The states and provinces: every admin-1 unit. Id: its ISO 3166-2 code,
 * else its country and name; a code two units share gets a number. The
 * entries carry the pack feature beside the unit, for the globe's shapes.
 */
export function regionEntries(pack) {
  const decimals = pack?.meta?.decimals ?? 3;
  const seen = new Map();
  const out = [];
  for (const feature of pack?.features || []) {
    const iso2 = /^[A-Z]{2}$/.test(feature.iso2 || '') ? feature.iso2 : null;
    const base =
      feature.iso || `${iso2 || 'XX'}:${normalizeAdminName(feature.name)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const { lon, lat } = featurePoint(feature, decimals);
    out.push({
      feature,
      decimals: feature.d ?? decimals,
      unit: {
        id: n === 1 ? base : `${base}#${n}`,
        name: feature.name,
        nameEn: feature.nameEn || null,
        alt: feature.alt || [],
        country: feature.country,
        iso2,
        postal: feature.postal || null,
        lat,
        lon,
      },
    });
  }
  return out;
}

export function regionUnits(pack) {
  return regionEntries(pack).map((e) => e.unit);
}

/** The cities: every populated place. Id: its Natural Earth id, as text. */
export function cityUnits(pack) {
  const out = [];
  for (const f of pack?.features || []) {
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
    out.push({
      id: String(f.id),
      name: f.name,
      alt: f.alt || [],
      country: f.country,
      iso2: /^[A-Z]{2}$/.test(f.iso2 || '') ? f.iso2 : null,
      adm1: f.adm1 || null,
      lat: f.lat,
      lon: f.lon,
      pop: Number.isFinite(f.pop) ? f.pop : 0,
      ...(f.capital ? { capital: true } : {}),
    });
  }
  return out;
}

/**
 * A place name the way sources write it against the way the packs do:
 * folded (normalizeAdminName), then with the generic words gone (Region,
 * Province, Prefecture, Oblast, County, of, the …), direction words made
 * one ("north east" → "northeast", "Western" → "west"), and a few spellings
 * settled ("Sumatera" → "Sumatra").
 */
export function softAdminName(name) {
  let key = normalizeAdminName(name);
  key = key
    .replace(/\b(north|south)\s+(east|west)\b/g, '$1$2')
    .replace(/\b(northern|southern|eastern|western)\b/g, (w) => w.slice(0, -3))
    .replace(/\bsumatera\b/g, 'sumatra')
    .replace(/\bkalimantan\b/g, 'borneo')
    .replace(
      /\b(region|regions|province|provinces|provincia|prefecture|oblast|district|state|county|department|departamento|territory|metropolitan|autonomous|republic|krai|okrug|city|ciudad|area|federal|special|capital|of|the|de|du|des|la|le|el|and|y|et|not|regionalised|regionalized|unregionalised)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return key;
}

/**
 * Names a source uses that the packs write differently, by country, the
 * source's name folded to the pack's. Kept short: the soft match above
 * settles most; these are the ones it cannot.
 */
export const UNIT_NAME_ALIASES = Object.freeze({
  CA: { 'yukon territory': 'yukon' },
  CL: { magallanes: 'magallanes y antartica chilena' },
  CO: {
    'cauca valley': 'valle del cauca',
    'san andres': 'san andres y providencia',
  },
  DK: {
    'capital region of denmark': 'hovedstaden',
    'central jutland': 'midtjylland',
    'north jutland': 'nordjylland',
    'southern denmark': 'syddanmark',
    zealand: 'sjaelland',
  },
  ID: { 'dki jakarta': 'jakarta raya', jakarta: 'jakarta raya' },
  IN: {
    'national capital territory of delhi': 'delhi',
    'nct of delhi': 'delhi',
    'daman and diu': 'dadra and nagar haveli and daman and diu',
  },
  MX: {
    'mexico d c': 'distrito federal',
    'mexico city': 'distrito federal',
    'ciudad de mexico': 'distrito federal',
    'estado de mexico': 'mexico',
  },
  PL: {
    silesia: 'silesian',
    'lower silesia': 'lower silesian',
    podlachia: 'podlaskie',
    'warmia masuria': 'warmian masurian',
    'kuyavia pomerania': 'kuyavian pomeranian',
    'west pomerania': 'west pomeranian',
    pomerania: 'pomeranian',
    lublin: 'lubelskie',
    lodz: 'lodzkie',
    masovia: 'masovian',
    'lesser poland': 'lesser poland',
    subcarpathia: 'subcarpathian',
    'holy cross': 'swietokrzyskie',
    opole: 'opolskie',
    lubusz: 'lubusz',
  },
  RU: {
    'ulianov oblast': 'ulyanovsk oblast',
    'republic of bashkorstostan': 'bashkortostan',
    'karachay cherkhess republic': 'karachay cherkess republic',
    'khanty mansi autonomous okrug yugra': 'khanty mansi autonomous okrug',
  },
  US: { 'washington d c': 'district of columbia' },
});

/** The 2-letter codes the OECD writes that are not ISO 3166-1 alpha-2. */
export const OECD_ISO2_FIXES = Object.freeze({
  EL: 'GR',
  UK: 'GB',
  KO: 'KR',
  ME: 'MX',
});

/** Codes a source writes for a country that the packs write otherwise. */
export const ISO3_FIXES = Object.freeze({
  XKX: 'KOS',
  OWID_KOS: 'KOS',
  SSD: 'SDS',
  PSE: 'PSX',
  ESH: 'SAH',
});

/**
 * Finds a pack unit from a source's country and place name: the alias
 * table, the exact folded name, the soft name, then a soft name that is the
 * start of exactly one unit's (or the other way round), five letters or
 * more. Units are indexed once per country.
 */
export function createUnitMatcher(units) {
  const byCountry = new Map();
  for (const u of units) {
    const iso2 = u.iso2 || 'XX';
    let index = byCountry.get(iso2);
    if (!index) {
      index = { exact: new Map(), soft: new Map(), softKeys: [] };
      byCountry.set(iso2, index);
    }
    const names = [u.name, u.nameEn, ...(u.alt || [])].filter(Boolean);
    for (const name of names) {
      const exact = normalizeAdminName(name);
      if (exact && !index.exact.has(exact)) index.exact.set(exact, u);
      const soft = softAdminName(name);
      if (soft && !index.soft.has(soft)) {
        index.soft.set(soft, u);
        index.softKeys.push(soft);
      }
    }
  }
  const prefixOnce = (index, soft) => {
    if (soft.length < 5) return null;
    let found = null;
    for (const key of index.softKeys) {
      if (key === soft) continue;
      if (!key.startsWith(`${soft} `) && !soft.startsWith(`${key} `)) continue;
      const unit = index.soft.get(key);
      if (found && found !== unit) return null;
      found = unit;
    }
    return found;
  };
  return {
    /** @returns {object|null} */
    find(iso2, name) {
      const index = byCountry.get(iso2 || 'XX');
      if (!index) return null;
      const exact = normalizeAdminName(name);
      if (!exact) return null;
      const alias = UNIT_NAME_ALIASES[iso2]?.[exact];
      if (alias) {
        const hit =
          index.exact.get(normalizeAdminName(alias)) ||
          index.soft.get(softAdminName(alias));
        if (hit) return hit;
      }
      if (index.exact.has(exact)) return index.exact.get(exact);
      const soft = softAdminName(name);
      if (!soft) return null;
      const aliasSoft = UNIT_NAME_ALIASES[iso2]?.[soft];
      if (aliasSoft) {
        const hit =
          index.exact.get(normalizeAdminName(aliasSoft)) ||
          index.soft.get(softAdminName(aliasSoft));
        if (hit) return hit;
      }
      if (index.soft.has(soft)) return index.soft.get(soft);
      return prefixOnce(index, soft);
    },
    countries() {
      return [...byCountry.keys()];
    },
  };
}

/** ISO 3166-1 alpha-2 from a code a source writes: alpha-2 (with the OECD's own), alpha-3 through the countries. */
export function createCountryCodes(countries) {
  const byIso3 = new Map();
  const byIso2 = new Map();
  for (const c of countries) {
    byIso3.set(c.id, c);
    if (c.iso2) byIso2.set(c.iso2, c);
  }
  return {
    fromIso3(code) {
      const key = String(code || '').toUpperCase();
      return byIso3.get(ISO3_FIXES[key] || key) || null;
    },
    fromIso2(code) {
      const key = String(code || '').toUpperCase();
      return byIso2.get(OECD_ISO2_FIXES[key] || key) || null;
    },
    /** The country of an OECD area code: its leading letters, 2 or 3. */
    fromOecdArea(area) {
      const letters = /^([A-Z]{2,3})/.exec(String(area || '').toUpperCase());
      if (!letters) return null;
      const code = letters[1];
      return code.length === 3
        ? this.fromIso3(code) || this.fromIso2(code.slice(0, 2))
        : this.fromIso2(code);
    },
  };
}
