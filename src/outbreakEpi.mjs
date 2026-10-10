/**
 * EPIDEMIC MODEL: a stochastic metapopulation simulation on top of the
 * outbreak box's reach model (owner request, 2026-10-09). The reach model
 * (outbreakCore.mjs) says how far the outbreak COULD have travelled; this one
 * says how LIKELY each place is to have it, WHEN, and roughly HOW MANY.
 * No DOM and no network: the server runs it (POST /api/outbreak/epidemic).
 *
 * Built on established practice:
 *  - Metapopulation SEIR with presymptomatic and asymptomatic compartments,
 *    places coupled by air passengers and commuting (GLEAM: Balcan et al.
 *    2009, Colizza et al. 2006).
 *  - Hourly stochastic steps (binomial / Poisson draws, tau-leaping), so small
 *    introductions can die out as they do in reality.
 *  - Superspreading: each infectious person's infectiousness is drawn from a
 *    gamma distribution with dispersion k, giving negative-binomial offspring
 *    (Lloyd-Smith et al. 2005).
 *  - Monte Carlo ensemble with a seeded generator: probability of arrival and
 *    a 5–95 % arrival window per place, repeatable from its seed.
 *  - Effective distance D = 1 − ln P(m|n) over the air network (Brockmann &
 *    Helbing 2013): a fast deterministic ranking of where it goes next.
 *  - Growth rate and doubling time from R0 and the stage durations
 *    (Wallinga & Lipsitch 2007).
 *  - Gravity-model commuting with exponential distance decay (Balcan et al.
 *    2009 fit: exponents 0.46 and 0.64, 82 km), damped across borders.
 *  - Hemisphere-aware seasonal forcing; vector-borne transmission only where
 *    the estimated temperature suits the vector (Mordecai et al. 2017).
 *  - Exit/entry screening that mostly misses travellers still incubating
 *    (Gostic et al. 2015), quarantine, travel restriction, lockdown and
 *    contact tracing, from a chosen hour.
 * Everything here is a model for exploring scenarios, not a prediction of
 * real cases.
 */
import {
  DENSITY_BANDS,
  INCUBATION_DAYS_MAX,
  LONG_HAUL_KM,
  OUTBREAK_AIRPORT_KM,
  R0_MAX,
  TRANSMISSION_MODES,
  distanceKm,
  flightHours,
  patternDestinations,
  stableIndex,
  validPoint,
} from './outbreakCore.mjs';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DT = 1 / 24; // one hour, in days

/* ---------------------------------------------------------------------------
 * Random numbers: one seeded generator and the draws the model needs.
 * ------------------------------------------------------------------------- */

/** A small, fast seeded generator (mulberry32): the same seed, the same run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from any text (FNV-1a). */
export function seedFromText(text) {
  let h = 2166136261;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function normal(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Poisson draw: exact below 30, normal approximation above. */
export function poisson(mean, rng) {
  if (!(mean > 0)) return 0;
  if (mean < 30) {
    const limit = Math.exp(-mean);
    let k = 0;
    let p = rng();
    while (p > limit) {
      k += 1;
      p *= rng();
    }
    return k;
  }
  return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal(rng)));
}

/** Binomial draw: exact for small n, Poisson or normal approximation else. */
export function binomial(n, p, rng) {
  const count = Math.floor(n);
  if (!(count > 0) || !(p > 0)) return 0;
  if (p >= 1) return count;
  if (count < 25) {
    let k = 0;
    for (let i = 0; i < count; i += 1) if (rng() < p) k += 1;
    return k;
  }
  const mean = count * p;
  if (mean < 15) return Math.min(count, poisson(mean, rng));
  const rest = count * (1 - p);
  if (rest < 15) return count - Math.min(count, poisson(rest, rng));
  const draw = Math.round(mean + Math.sqrt(mean * (1 - p)) * normal(rng));
  return Math.max(0, Math.min(count, draw));
}

/** Gamma draw (Marsaglia & Tsang), mean shape × scale. */
export function gamma(shape, scale, rng) {
  if (!(shape > 0) || !(scale > 0)) return 0;
  if (shape < 1)
    return gamma(shape + 1, scale, rng) * rng() ** (1 / Math.max(shape, 1e-9));
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v)))
      return d * v * scale;
  }
}

/* ---------------------------------------------------------------------------
 * Inputs: presets, the extra pathogen and human fields, and interventions.
 * ------------------------------------------------------------------------- */

/**
 * Pathogen presets: typical published values, for illustration only. Each
 * fills the fields; every field stays editable.
 */
export const PATHOGEN_PRESETS = Object.freeze([
  // The box's own scenario (owner ruling, 2026-10-09): a new outbreak in
  // Irkutsk and Shelekhov with little known yet, so typical values for a
  // newly emerged respiratory virus are guessed.
  Object.freeze({
    id: 'novel',
    label: 'Novel outbreak (Irkutsk default, guessed)',
    note: 'Limited data: typical values for a newly emerged respiratory virus',
    values: Object.freeze({
      transmission: 'droplets',
      r0: 2.5,
      incubationDays: 5,
      latentDays: 3,
      infectiousDays: 7,
      asymptomaticPct: 30,
      asymRelative: 0.5,
      superspreading: 'medium',
      hospitalPct: 5,
      fatalityPct: 1,
      mutation: 'medium',
    }),
  }),
  Object.freeze({
    id: 'flu',
    label: 'Seasonal influenza',
    note: 'R0 ~1.3, incubation ~2 d (Biggerstaff 2014; Lessler 2009)',
    values: Object.freeze({
      transmission: 'droplets',
      r0: 1.3,
      incubationDays: 2,
      latentDays: 1,
      infectiousDays: 5,
      asymptomaticPct: 30,
      asymRelative: 0.5,
      superspreading: 'low',
      hospitalPct: 1,
      fatalityPct: 0.1,
      mutation: 'medium',
    }),
  }),
  Object.freeze({
    id: 'covid2020',
    label: 'COVID-19 (2020)',
    note: 'R0 ~2.8, incubation ~5.5 d, k ~0.1 (Lauer 2020; Endo 2020)',
    values: Object.freeze({
      transmission: 'airborne',
      r0: 2.8,
      incubationDays: 5.5,
      latentDays: 3,
      infectiousDays: 7,
      asymptomaticPct: 35,
      asymRelative: 0.5,
      superspreading: 'high',
      hospitalPct: 5,
      fatalityPct: 1,
      mutation: 'medium',
    }),
  }),
  Object.freeze({
    id: 'omicron',
    label: 'COVID-19 Omicron',
    note: 'R0 ~8, incubation ~3 d (Liu & Rocklöv 2022; Jansen 2021)',
    values: Object.freeze({
      transmission: 'airborne',
      r0: 8,
      incubationDays: 3,
      latentDays: 2,
      infectiousDays: 6,
      asymptomaticPct: 30,
      asymRelative: 0.6,
      superspreading: 'medium',
      hospitalPct: 1,
      fatalityPct: 0.15,
      mutation: 'high',
    }),
  }),
  Object.freeze({
    id: 'measles',
    label: 'Measles',
    note: 'R0 12–18, incubation ~11 d (Guerra 2017)',
    values: Object.freeze({
      transmission: 'airborne',
      r0: 15,
      incubationDays: 11,
      latentDays: 9,
      infectiousDays: 8,
      asymptomaticPct: 1,
      asymRelative: 0.5,
      superspreading: 'medium',
      hospitalPct: 20,
      fatalityPct: 0.3,
      mutation: 'low',
    }),
  }),
  Object.freeze({
    id: 'sars2003',
    label: 'SARS (2003)',
    note: 'R0 ~2.5, little presymptomatic spread, k ~0.16 (Lipsitch 2003)',
    values: Object.freeze({
      transmission: 'droplets',
      r0: 2.5,
      incubationDays: 5,
      latentDays: 5,
      infectiousDays: 10,
      asymptomaticPct: 10,
      asymRelative: 0.2,
      superspreading: 'high',
      hospitalPct: 70,
      fatalityPct: 10,
      mutation: 'low',
    }),
  }),
  Object.freeze({
    id: 'mers',
    label: 'MERS',
    note: 'R0 <1 between people, camel reservoir (Cauchemez 2016)',
    values: Object.freeze({
      transmission: 'droplets',
      r0: 0.7,
      incubationDays: 5,
      latentDays: 5,
      infectiousDays: 8,
      asymptomaticPct: 20,
      asymRelative: 0.3,
      superspreading: 'high',
      hospitalPct: 60,
      fatalityPct: 35,
      mutation: 'low',
      reservoir: 'yes',
    }),
  }),
  Object.freeze({
    id: 'ebola',
    label: 'Ebola',
    note: 'R0 ~1.8, incubation ~9 d (WHO Ebola Response Team 2014)',
    values: Object.freeze({
      transmission: 'contact',
      r0: 1.8,
      incubationDays: 9,
      latentDays: 9,
      infectiousDays: 9,
      asymptomaticPct: 5,
      asymRelative: 0.1,
      superspreading: 'high',
      hospitalPct: 80,
      fatalityPct: 45,
      mutation: 'low',
    }),
  }),
  Object.freeze({
    id: 'mpox',
    label: 'Mpox (2022)',
    note: 'R0 ~1.4, incubation ~8 d (Miura 2022)',
    values: Object.freeze({
      transmission: 'contact',
      r0: 1.4,
      incubationDays: 8,
      latentDays: 7,
      infectiousDays: 21,
      asymptomaticPct: 10,
      asymRelative: 0.5,
      superspreading: 'high',
      hospitalPct: 6,
      fatalityPct: 0.1,
      mutation: 'low',
    }),
  }),
  Object.freeze({
    id: 'dengue',
    label: 'Dengue (mosquito)',
    note: 'R0 1–5, mostly asymptomatic (Bhatt 2013; Mordecai 2017)',
    values: Object.freeze({
      transmission: 'vector',
      r0: 3,
      incubationDays: 6,
      latentDays: 5,
      infectiousDays: 5,
      asymptomaticPct: 75,
      asymRelative: 0.8,
      superspreading: 'medium',
      hospitalPct: 2,
      fatalityPct: 0.1,
      mutation: 'low',
    }),
  }),
  Object.freeze({
    id: 'h5n1',
    label: 'H5N1 human-adapted (hypothetical)',
    note: 'A scenario, not a measured virus: R0 2, bird reservoir',
    values: Object.freeze({
      transmission: 'droplets',
      r0: 2,
      incubationDays: 3,
      latentDays: 2,
      infectiousDays: 6,
      asymptomaticPct: 20,
      asymRelative: 0.5,
      superspreading: 'medium',
      hospitalPct: 30,
      fatalityPct: 10,
      mutation: 'high',
      reservoir: 'yes',
    }),
  }),
]);

/**
 * The box's starting profile, mirroring its default outbreak (Irkutsk, a
 * city of about 620,000, and Shelekhov, a town of about 47,000, in
 * October) as a new outbreak with limited data. Guessed where nothing is
 * known:
 *  - the pathogen: the Novel outbreak preset;
 *  - density near patient zero: Irkutsk's 500,000–1 million band; the next
 *    places (Ulan-Ude, Krasnoyarsk, Novosibirsk) are of the same order;
 *  - medium travel: a regional hub with some international flights;
 *  - cold weather: a Siberian autumn turning to winter;
 *  - no immunity, as it is new;
 *  - a mixed-age population, average households, medium healthcare,
 *    compliance, vulnerability and transit crowding, and a moderate public
 *    response as cases are reported;
 *  - no gathering, holiday, reservoir or interventions yet;
 *  - 50 cases at the start: a cluster just noticed.
 * Every field stays editable.
 */
export const OUTBREAK_DEFAULT_PROFILE = Object.freeze({
  ...presetValues('novel'),
  density: '500k-1m',
  densityNew: '500k-1m',
  travel: 'medium',
  compliance: 'medium',
  vulnerability: 'medium',
  season: 'winter',
  immunity: 'novel',
  age: 'mixed',
  household: 'average',
  healthcare: 'medium',
  response: 'moderate',
  gathering: 'none',
  holiday: 'normal',
  transit: 'medium',
  reservoir: 'no',
  exitScreening: 'off',
  entryScreening: 'off',
  tracing: 'none',
  initialCases: 50,
});

/** Numeric epidemic fields: [min, max, decimals]. */
export const EPI_NUMBER_FIELDS = Object.freeze({
  latentDays: Object.freeze([0.1, INCUBATION_DAYS_MAX, 1]),
  infectiousDays: Object.freeze([0.5, 60, 1]),
  asymptomaticPct: Object.freeze([0, 95, 0]),
  asymRelative: Object.freeze([0, 1.5, 2]),
  hospitalPct: Object.freeze([0, 100, 1]),
  fatalityPct: Object.freeze([0, 100, 2]),
  initialCases: Object.freeze([1, 100_000, 0]),
  travelBanPct: Object.freeze([0, 100, 0]),
  quarantineDays: Object.freeze([0, 21, 0]),
  lockdownPct: Object.freeze([0, 90, 0]),
  interventionHour: Object.freeze([0, 24 * 30, 0]),
});

/** Superspreading: the dispersion k of each person's offspring. */
export const SUPERSPREADING = Object.freeze([
  Object.freeze({ id: 'low', label: 'Low (k 1, flu-like)', k: 1 }),
  Object.freeze({ id: 'medium', label: 'Medium (k 0.4)', k: 0.4 }),
  Object.freeze({ id: 'high', label: 'High (k 0.1, SARS-like)', k: 0.1 }),
]);
const DEFAULT_K = 1;

/**
 * The extra human factors the epidemic model uses. `contact` scales
 * transmission, `severity` scales hospital and fatality shares, `isolate`
 * is the share of symptomatic people isolated, `travel` scales passengers.
 */
export const EPI_HUMAN_FACTORS = Object.freeze([
  Object.freeze({
    key: 'age',
    label: 'Age structure',
    options: Object.freeze([
      { id: 'young', label: 'Young', contact: 1.1, severity: 0.5 },
      { id: 'mixed', label: 'Mixed', contact: 1, severity: 1 },
      { id: 'older', label: 'Older', contact: 0.9, severity: 2 },
    ]),
  }),
  Object.freeze({
    key: 'household',
    label: 'Household size',
    options: Object.freeze([
      { id: 'small', label: 'Small (1–2)', contact: 0.95 },
      { id: 'average', label: 'Average (3–4)', contact: 1 },
      { id: 'large', label: 'Large (5+)', contact: 1.1 },
    ]),
  }),
  Object.freeze({
    key: 'healthcare',
    label: 'Healthcare & surveillance',
    // detect: share of symptomatic cases ever reported; reportDays: from
    // symptoms to the report; beds: hospital beds per 1,000 people.
    options: Object.freeze([
      {
        id: 'low',
        label: 'Low (overwhelmed)',
        isolate: 0,
        contact: 1.05,
        detect: 0.1,
        reportDays: 7,
        beds: 1,
      },
      {
        id: 'medium',
        label: 'Medium',
        isolate: 0.1,
        detect: 0.3,
        reportDays: 4,
        beds: 2.5,
      },
      {
        id: 'high',
        label: 'High',
        isolate: 0.25,
        detect: 0.6,
        reportDays: 2,
        beds: 4,
      },
    ]),
  }),
  Object.freeze({
    key: 'response',
    label: 'Public response to reported cases',
    // awareness: how sharply contacts fall as reported cases rise, per
    // reported case per 100,000 people (Funk et al. 2009).
    options: Object.freeze([
      { id: 'none', label: 'None', awareness: 0 },
      { id: 'moderate', label: 'Moderate', awareness: 0.02 },
      { id: 'strong', label: 'Strong (fear, staying home)', awareness: 0.1 },
    ]),
  }),
  Object.freeze({
    key: 'gathering',
    label: 'Mass gathering',
    options: Object.freeze([
      { id: 'none', label: 'None', boost: 1, days: 0, travel: 1 },
      {
        id: 'regional',
        label: 'Regional event',
        boost: 1.2,
        days: 3,
        travel: 1.1,
      },
      { id: 'major', label: 'Major event', boost: 1.5, days: 5, travel: 1.3 },
    ]),
  }),
  Object.freeze({
    key: 'holiday',
    label: 'Holiday travel',
    options: Object.freeze([
      { id: 'normal', label: 'Normal', travel: 1 },
      { id: 'holiday', label: 'Holiday peak (+30 %)', travel: 1.3 },
    ]),
  }),
  Object.freeze({
    key: 'transit',
    label: 'Public transit crowding',
    options: Object.freeze([
      { id: 'low', label: 'Low', contact: 0.95 },
      { id: 'medium', label: 'Medium', contact: 1 },
      { id: 'high', label: 'High', contact: 1.1 },
    ]),
  }),
  Object.freeze({
    key: 'reservoir',
    label: 'Animal reservoir',
    options: Object.freeze([
      { id: 'no', label: 'No' },
      { id: 'yes', label: 'Yes (keeps spilling over at patient zero)' },
    ]),
  }),
]);

/** Interventions with choices; the rest are numbers (EPI_NUMBER_FIELDS). */
export const EPI_INTERVENTION_CHOICES = Object.freeze([
  Object.freeze({
    key: 'exitScreening',
    label: 'Exit screening',
    options: Object.freeze([
      { id: 'off', label: 'Off' },
      { id: 'on', label: 'On' },
    ]),
  }),
  Object.freeze({
    key: 'entryScreening',
    label: 'Entry screening',
    options: Object.freeze([
      { id: 'off', label: 'Off' },
      { id: 'on', label: 'On' },
    ]),
  }),
  Object.freeze({
    key: 'tracing',
    label: 'Contact tracing',
    options: Object.freeze([
      { id: 'none', label: 'None', isolate: 0, presym: 0 },
      { id: 'low', label: 'Low', isolate: 0.05, presym: 0.03 },
      { id: 'medium', label: 'Medium', isolate: 0.15, presym: 0.08 },
      { id: 'high', label: 'High', isolate: 0.3, presym: 0.15 },
    ]),
  }),
]);

/** What the existing outbreak human factors do inside the model. */
const BASE_FACTOR_EFFECTS = Object.freeze({
  travel: { low: { travel: 0.7 }, medium: {}, high: { travel: 1.3 } },
  compliance: {
    high: { contact: 0.85 },
    medium: {},
    low: { contact: 1.1 },
  },
  vulnerability: {
    low: { contact: 0.95 },
    medium: {},
    high: { contact: 1.08 },
  },
  immunity: {
    novel: { susceptible: 1 },
    partial: { susceptible: 0.7 },
    strong: { susceptible: 0.4 },
  },
  season: {
    warm: { origin: 0.95 },
    mild: {},
    winter: { origin: 1.1 },
    rain: { origin: 1.05 },
  },
});

/** Seasonal swing of transmission, by how it travels. */
const SEASON_AMPLITUDE = Object.freeze({
  airborne: 0.25,
  droplets: 0.25,
  contact: 0.05,
  fomites: 0.1,
  vector: 0,
});

const MUTATION_PER_DAY = Object.freeze({ low: 0, medium: 0.005, high: 0.01 });

/** Screening: share caught of symptomatic, and of presymptomatic, travellers. */
export const SCREENING_CATCH = Object.freeze({ symptomatic: 0.7, presym: 0.1 });

/** The epidemic fields as kept: only valid ones that are set. */
export function cleanEpiProfile(raw) {
  const out = {};
  if (PATHOGEN_PRESETS.some((p) => p.id === raw?.preset))
    out.preset = raw.preset;
  for (const [key, [min, max, places]] of Object.entries(EPI_NUMBER_FIELDS)) {
    const value = raw?.[key];
    if (value === '' || value === null || value === undefined) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) continue;
    const f = 10 ** places;
    out[key] = Math.round(n * f) / f;
  }
  if (SUPERSPREADING.some((s) => s.id === raw?.superspreading))
    out.superspreading = raw.superspreading;
  for (const factor of [...EPI_HUMAN_FACTORS, ...EPI_INTERVENTION_CHOICES])
    if (factor.options.some((o) => o.id === raw?.[factor.key]))
      out[factor.key] = raw[factor.key];
  return out;
}

/** A preset's values, ready to merge over a profile; {} for an unknown id. */
export function presetValues(id) {
  const preset = PATHOGEN_PRESETS.find((p) => p.id === id);
  return preset ? { preset: preset.id, ...preset.values } : {};
}

function option(list, key, id) {
  return list.find((f) => f.key === key)?.options.find((o) => o.id === id);
}

function densityContact(id) {
  const band = DENSITY_BANDS.find((b) => b.id === id);
  return band ? 1 + band.delta / 100 : 1;
}

/** The middle of a density band, in people; null when unset. */
export function densityPeople(id) {
  const band = DENSITY_BANDS.find((b) => b.id === id);
  return band ? Math.round((band.low + band.high) / 2) || 5_000 : null;
}

/**
 * Everything the simulation needs from the profile (the outbreak box's
 * pathogen and human fields plus the epidemic ones), with defaults.
 */
export function epiParameters(profile = {}) {
  const p = profile || {};
  const num = (value, fallback) => {
    const n = Number(value);
    return value !== undefined && value !== '' && Number.isFinite(n)
      ? n
      : fallback;
  };
  const r0 = Math.min(R0_MAX, Math.max(0.05, num(p.r0, 2.5)));
  const incubationDays = Math.max(0.2, num(p.incubationDays, 5));
  const latentDays = Math.min(
    incubationDays,
    Math.max(0.1, num(p.latentDays, Math.max(0.5, incubationDays * 0.6))),
  );
  const presymDays = Math.max(0, incubationDays - latentDays);
  const infectiousDays = Math.max(
    presymDays + 0.5,
    num(p.infectiousDays, Math.max(presymDays + 0.5, 6)),
  );
  const symDays = Math.max(0.5, infectiousDays - presymDays);
  let asymShare = 0.3;
  if (p.asymptomatic === 'yes') asymShare = 0.4;
  if (p.asymptomatic === 'no') asymShare = 0.05;
  if (p.asymptomaticPct !== undefined)
    asymShare = Math.min(0.95, Math.max(0, num(p.asymptomaticPct, 30) / 100));
  const asymRelative = Math.min(1.5, Math.max(0, num(p.asymRelative, 0.5)));
  const k =
    SUPERSPREADING.find((s) => s.id === p.superspreading)?.k ?? DEFAULT_K;

  let contact = 1;
  let severity = 1;
  let travel = 1;
  let susceptible = 1;
  let originContact = densityContact(p.density);
  // What moves R away from R0, for the box to show.
  const rFactors = [];
  const note = (label, factor) => {
    if (Number.isFinite(factor) && Math.abs(factor - 1) > 1e-9)
      rFactors.push({ label, factor: Math.round(factor * 100) / 100 });
  };
  for (const [key, table] of Object.entries(BASE_FACTOR_EFFECTS)) {
    const effect = table[p[key]];
    if (!effect) continue;
    note(`${key} ${p[key]}`, (effect.contact ?? 1) * (effect.susceptible ?? 1));
    contact *= effect.contact ?? 1;
    travel *= effect.travel ?? 1;
    if (effect.susceptible !== undefined) susceptible = effect.susceptible;
    originContact *= effect.origin ?? 1;
  }
  for (const key of ['age', 'household', 'transit']) {
    const o = option(EPI_HUMAN_FACTORS, key, p[key]);
    if (o) note(`${key} ${o.id}`, o.contact ?? 1);
    contact *= o?.contact ?? 1;
    severity *= o?.severity ?? 1;
  }
  const holiday = option(EPI_HUMAN_FACTORS, 'holiday', p.holiday);
  travel *= holiday?.travel ?? 1;
  const gather = option(EPI_HUMAN_FACTORS, 'gathering', p.gathering) || {
    boost: 1,
    days: 0,
    travel: 1,
  };
  const hospitalShare = Math.min(1, (num(p.hospitalPct, 3) / 100) * severity);
  const fatalityShare = Math.min(
    hospitalShare || 1,
    (num(p.fatalityPct, 0.5) / 100) * severity,
  );
  // Published R0 values already include the usual care and isolation, so
  // with Healthcare unset nobody more is isolated and R is that R0. Set, it
  // moves R from there: an overwhelmed system mixes the sick more, a strong
  // one isolates more of them.
  const healthcare = option(EPI_HUMAN_FACTORS, 'healthcare', p.healthcare);
  contact *= healthcare?.contact ?? 1;
  const isolation = Math.min(0.9, healthcare?.isolate ?? 0);
  const tracing = option(EPI_INTERVENTION_CHOICES, 'tracing', p.tracing);
  const transmission = TRANSMISSION_MODES.some((m) => m.id === p.transmission)
    ? p.transmission
    : 'droplets';
  // R0 is the natural one: β is set so that, with nobody isolated, each case
  // infects R0 others in a fully susceptible place.
  const meanWeight = 1 - asymShare + asymShare * asymRelative;
  const beta = r0 / (infectiousDays * Math.max(1e-6, meanWeight));
  const params = {
    r0,
    transmission,
    incubationDays,
    latentDays,
    presymDays,
    symDays,
    infectiousDays,
    asymShare,
    asymRelative,
    k,
    beta,
    sigma: 1 / latentDays,
    rho: 1 / Math.max(presymDays, 0.02),
    gammaSym: 1 / symDays,
    gammaAsym: 1 / infectiousDays,
    contact,
    originContact,
    newContact: densityContact(p.densityNew),
    susceptibleShare: susceptible,
    travel,
    // Most people with symptoms stay home; the very ill never fly.
    symptomaticTravel: 0.15 * (1 - hospitalShare),
    isolation,
    hospitalShare,
    fatalityShare,
    // Reporting: the share of symptomatic cases reported, and how long after
    // symptoms; unset is a middling system.
    ascertainment: healthcare?.detect ?? 0.25,
    reportDays: healthcare?.reportDays ?? 4,
    // Hospital beds free for this outbreak: about 30 % of all beds.
    bedsPer1000: (healthcare?.beds ?? 2.5) * 0.3,
    // Contacts fall as reported cases rise: 1 / (1 + awareness × per 100k).
    awareness:
      option(EPI_HUMAN_FACTORS, 'response', p.response)?.awareness ?? 0,
    seasonAmplitude: SEASON_AMPLITUDE[transmission] ?? 0.2,
    vector: transmission === 'vector',
    reservoirPerDay: p.reservoir === 'yes' ? 1 : 0,
    mutationPerDay: MUTATION_PER_DAY[p.mutation] ?? 0,
    gathering: {
      boost: gather.boost,
      days: gather.days,
      travel: gather.travel,
    },
    initialCases: Math.max(1, Math.round(num(p.initialCases, 100))),
    interventions: {
      startHour: Math.max(0, num(p.interventionHour, 24)),
      travelBan: Math.min(1, Math.max(0, num(p.travelBanPct, 0) / 100)),
      exitScreening: p.exitScreening === 'on',
      entryScreening: p.entryScreening === 'on',
      quarantineDays: Math.max(0, num(p.quarantineDays, 0)),
      lockdown: Math.min(0.9, Math.max(0, num(p.lockdownPct, 0) / 100)),
      tracingIsolate: tracing?.isolate ?? 0,
      tracingPresym: tracing?.presym ?? 0,
    },
  };
  params.rEffective = reproductionNumber(params, false);
  if (healthcare) {
    // Healthcare: its contact change and the share of the sick it isolates.
    note(
      `healthcare ${healthcare.id}`,
      reproductionNumber(params) /
        reproductionNumber({
          ...params,
          isolation: 0,
          contact: params.contact / (healthcare.contact ?? 1),
        }),
    );
  }
  params.rFactors = rFactors;
  params.rEffectiveControlled = reproductionNumber(params, true);
  return params;
}

/**
 * Reproduction number in a place of average contact: R0 less isolation,
 * immunity and the human factors; with `controlled`, the interventions too.
 */
export function reproductionNumber(params, controlled = false) {
  const i = params.interventions;
  const iso = Math.min(
    0.95,
    params.isolation + (controlled ? i.tracingIsolate : 0),
  );
  const presymCut = controlled ? i.tracingPresym : 0;
  const lockdown = controlled ? 1 - i.lockdown : 1;
  return (
    params.beta *
    params.contact *
    lockdown *
    params.susceptibleShare *
    ((1 - params.asymShare) *
      (params.presymDays * (1 - presymCut) + params.symDays * (1 - iso)) +
      params.asymShare * params.asymRelative * params.infectiousDays)
  );
}

/**
 * Early growth rate r per day (Euler–Lotka over the stage chain), solved by
 * bisection; negative when it dies out.
 */
export function growthRate(params, controlled = false) {
  const i = params.interventions;
  const iso = Math.min(
    0.95,
    params.isolation + (controlled ? i.tracingIsolate : 0),
  );
  const presymCut = controlled ? i.tracingPresym : 0;
  const scale =
    params.beta *
    params.contact *
    (controlled ? 1 - i.lockdown : 1) *
    params.susceptibleShare;
  const { sigma, rho, gammaSym, gammaAsym, asymShare: a } = params;
  const f = (r) => {
    const toInfectious = sigma / (sigma + r);
    const presym = (1 - presymCut) / (rho + r);
    const sym = (rho / (rho + r)) * ((1 - iso) / (gammaSym + r));
    const asym = params.asymRelative / (gammaAsym + r);
    return scale * toInfectious * ((1 - a) * (presym + sym) + a * asym) - 1;
  };
  const lowest = -Math.min(sigma, rho, gammaSym, gammaAsym) + 1e-6;
  let lo = lowest;
  let hi = 20;
  if (f(hi) > 0) return hi;
  if (f(lo) < 0) return lo;
  for (let n = 0; n < 100; n += 1) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Days for cases to double; null when it is not growing. */
export function doublingTime(params, controlled = false) {
  const r = growthRate(params, controlled);
  return r > 1e-6 ? Math.LN2 / r : null;
}

/**
 * Chance one imported case starts a chain that does not die out, with
 * negative-binomial offspring (mean R, dispersion k): 1 − q, where q is the
 * smallest root of q = (1 + R(1 − q)/k)^−k. k = Infinity is Poisson.
 */
export function establishmentProbability(R, k = DEFAULT_K) {
  if (!(R > 1)) return 0;
  const g = Number.isFinite(k)
    ? (s) => (1 + (R * (1 - s)) / k) ** -k
    : (s) => Math.exp(R * (s - 1));
  let q = 0;
  for (let n = 0; n < 10_000; n += 1) {
    const next = g(q);
    if (Math.abs(next - q) < 1e-12) break;
    q = next;
  }
  return 1 - q;
}

function dayOfYear(ms) {
  const d = new Date(ms);
  return (ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS;
}

/**
 * Seasonal multiplier on transmission: winter peak (mid-January north,
 * mid-July south), flat in the tropics, full swing from 35° of latitude.
 */
export function seasonalFactor(lat, dateMs, amplitude) {
  const w = Math.min(1, Math.max(0, (Math.abs(lat) - 15) / 20));
  if (!(amplitude > 0) || w === 0) return 1;
  const peak = lat >= 0 ? 15 : 196;
  return (
    1 +
    amplitude * w * Math.cos((2 * Math.PI * (dayOfYear(dateMs) - peak)) / 365)
  );
}

/**
 * A rough monthly mean temperature (°C) from latitude and date alone: warm
 * and steady near the equator, colder and swinging more toward the poles.
 */
export function estimatedTempC(lat, dateMs) {
  const abs = Math.abs(lat);
  const base = 27 - 0.45 * Math.max(0, abs - 12);
  const swing = 0.22 * abs;
  const warmest = lat >= 0 ? 196 : 15;
  return (
    base + swing * Math.cos((2 * Math.PI * (dayOfYear(dateMs) - warmest)) / 365)
  );
}

/** Mosquito-borne spread only between about 18 and 34 °C (Mordecai 2017). */
export function vectorSuitable(lat, dateMs) {
  const t = estimatedTempC(lat, dateMs);
  return t >= 18 && t <= 34;
}

/* ---------------------------------------------------------------------------
 * The network: places, passengers and commuting.
 * ------------------------------------------------------------------------- */

/** Seats on a flight of this length, at 80 % full. */
export function flightPassengers(km, frequency = 1) {
  return Math.round((km >= LONG_HAUL_KM ? 300 : 180) * 0.8 * frequency);
}

/** Daily flights on an assumed route, by the two airports' sizes and its length. */
export function routeFrequency(fromKind, toKind, km = 0) {
  // An assumed long-haul route (one to each other continent) is a few
  // flights a week, not a busy daily shuttle.
  if (km >= 6000) return 0.5;
  if (km >= LONG_HAUL_KM) return 1;
  if (fromKind === 'L' && toKind === 'L') return 4;
  if (fromKind === 'L' || toKind === 'L') return 2;
  return 1;
}

/**
 * The world's air network as daily routes (owner ruling, 2026-10-09: every
 * airport). Each airport with scheduled service flies its normal traffic,
 * the same routes at the same times of day the reach model assumes
 * (patternDestinations, stableIndex); an airport the scan found real flights
 * out of flies those instead, daily at their times.
 *
 * @param {object[]} airports Every airport with scheduled service.
 * @param {object[]} scheduled Scheduled large and medium airports (the
 *   destinations normal traffic flies to).
 * @param {object[]} [scanFlights] The scan's flights ({from, to, departMs,
 *   arriveMs} with airport objects).
 * @returns {{from: string, to: string, timeOfDayMs: number, lengthMs: number,
 *   passengers: number}[]} By airport code.
 */
export function worldAirRoutes(airports, scheduled, scanFlights = []) {
  const kindOf = new Map(
    [...airports, ...scheduled].map((a) => [a.code, a.kind]),
  );
  const routes = new Map();
  const add = (from, to, timeOfDayMs, lengthMs, passengers) => {
    const key = `${from}>${to}|${Math.round(timeOfDayMs / 1_800_000)}`;
    if (!routes.has(key) && lengthMs > 0)
      routes.set(key, { from, to, timeOfDayMs, lengthMs, passengers });
  };
  const scanned = new Set();
  for (const f of scanFlights) {
    if (!f?.from?.code || !f?.to?.code) continue;
    scanned.add(f.from.code);
    add(
      f.from.code,
      f.to.code,
      ((f.departMs % DAY_MS) + DAY_MS) % DAY_MS,
      f.arriveMs - f.departMs,
      flightPassengers(distanceKm(f.from, f.to), 1),
    );
  }
  for (const airport of airports) {
    if (!airport?.code || scanned.has(airport.code)) continue;
    for (const to of patternDestinations(airport, scheduled)) {
      const km = distanceKm(airport, to);
      add(
        airport.code,
        to.code,
        stableIndex(`${airport.code}>${to.code}`, 48) * 1_800_000,
        flightHours(airport, to) * HOUR_MS,
        flightPassengers(
          km,
          routeFrequency(kindOf.get(airport.code), to.kind, km),
        ),
      );
    }
  }
  return [...routes.values()];
}

/**
 * Effective distance from the outbreak airports (Brockmann & Helbing 2013):
 * D = 1 − ln P(m|n) summed along the shortest path, where P(m|n) is the share
 * of n's passengers that fly to m.
 *
 * @param {Map<string, Map<string, number>>} flows Passengers per day, by route.
 * @param {string[]} sources
 * @returns {Map<string, number>}
 */
export function effectiveDistances(flows, sources) {
  const dist = new Map();
  const queue = [];
  for (const code of sources) {
    dist.set(code, 0);
    queue.push([0, code]);
  }
  const done = new Set();
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, code] = queue.shift();
    if (done.has(code)) continue;
    done.add(code);
    const out = flows.get(code);
    if (!out) continue;
    let total = 0;
    for (const w of out.values()) total += w;
    if (!(total > 0)) continue;
    for (const [to, w] of out) {
      if (!(w > 0)) continue;
      const next = d + 1 - Math.log(w / total);
      if (next < (dist.get(to) ?? Infinity)) {
        dist.set(to, next);
        queue.push([next, to]);
      }
    }
  }
  return dist;
}

/** Commuting model constants (Balcan et al. 2009). */
export const COMMUTING = Object.freeze({
  maxKm: 300,
  alpha: 0.46,
  gamma: 0.64,
  decayKm: 82,
  crossBorder: 0.3,
  outShare: 0.1,
  neighbours: 12,
  /** Grid cells, in degrees, for finding neighbours among many places. */
  cellDeg: 0.5,
  /** Places weighed from each cell next to a place's own, biggest first. */
  localPerCell: 24,
  /** And from each farther cell in reach: only its biggest few. */
  farPerCell: 3,
});

/**
 * Commuting links: for each place, the share of its residents who spend the
 * day in each nearby place. Gravity weights P_i^α P_j^γ e^(−d/82 km); the
 * total out-commuting share approaches 10 % as the neighbours get bigger.
 *
 * With every city and town in the model (about 200,000 places) a place does
 * not weigh every other within reach: the strongest links are to big places,
 * so it weighs the biggest few of each half-degree cell in reach, and more of
 * the cells right round it, keeping its 12 strongest.
 *
 * @param {{lat: number, lon: number, population: number, country?: string}[]} nodes
 * @returns {{j: number, share: number}[][]} By node index.
 */
export function gravityLinks(nodes, options = {}) {
  const c = { ...COMMUTING, ...options };
  const cell = c.cellDeg;
  const cols = Math.round(360 / cell);
  const rowOf = (lat) => Math.floor((lat + 90) / cell);
  const colOf = (lon) => Math.floor((lon + 180) / cell);
  const keyOf = (row, col) => row * cols + (((col % cols) + cols) % cols);
  const grid = new Map();
  nodes.forEach((node, i) => {
    const key = keyOf(rowOf(node.lat), colOf(node.lon));
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });
  for (const list of grid.values())
    list.sort((a, b) => nodes[b].population - nodes[a].population);
  const latCells = Math.ceil(c.maxKm / 111.2 / cell);
  // Worked out once: powers of the populations, and where each place is.
  const n = nodes.length;
  const popA = new Float64Array(n);
  const popG = new Float64Array(n);
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const pop = Math.max(1, nodes[i].population || 1);
    popA[i] = pop ** c.alpha;
    popG[i] = pop ** c.gamma;
    lat[i] = nodes[i].lat;
    lon[i] = nodes[i].lon;
  }
  // A reference neighbour: a town of 100,000 at the decay distance.
  const referenceG = 100_000 ** c.gamma * Math.exp(-1);
  const KM_PER_DEG = 111.2;
  const keepJ = new Int32Array(c.neighbours);
  const keepW = new Float64Array(c.neighbours);
  return nodes.map((node, i) => {
    const row = rowOf(lat[i]);
    const col = colOf(lon[i]);
    const shrink = Math.max(0.05, Math.cos((lat[i] * Math.PI) / 180));
    const lonCells = Math.min(cols / 2, Math.ceil(latCells / shrink));
    const nearCols = Math.ceil(1 / shrink);
    let kept = 0;
    for (let dy = -latCells; dy <= latCells; dy += 1) {
      // A row of cells wholly beyond reach is skipped.
      if ((Math.abs(dy) - 1) * cell * KM_PER_DEG > c.maxKm) continue;
      for (let dx = -lonCells; dx <= lonCells; dx += 1) {
        if ((Math.abs(dx) - 1) * cell * KM_PER_DEG * shrink > c.maxKm) continue;
        const list = grid.get(keyOf(row + dy, col + dx));
        if (!list) continue;
        const take = Math.min(
          list.length,
          Math.abs(dy) <= 1 && Math.abs(dx) <= nearCols
            ? c.localPerCell
            : c.farPerCell,
        );
        for (let k = 0; k < take; k += 1) {
          const j = list[k];
          if (j === i) continue;
          // Flat-earth distance: within 300 km it is close enough.
          let dLon = lon[j] - lon[i];
          if (dLon > 180) dLon -= 360;
          if (dLon < -180) dLon += 360;
          const ky = (lat[j] - lat[i]) * KM_PER_DEG;
          const kx = dLon * KM_PER_DEG * shrink;
          const km = Math.sqrt(kx * kx + ky * ky);
          if (km > c.maxKm) continue;
          const other = nodes[j];
          const border =
            node.country && other.country && node.country !== other.country
              ? c.crossBorder
              : 1;
          const w = popA[i] * popG[j] * Math.exp(-km / c.decayKm) * border;
          if (!(w > 0)) continue;
          // Keep the strongest few, in order, without a big list to sort.
          if (kept < keepJ.length) kept += 1;
          else if (w <= keepW[kept - 1]) continue;
          let at = kept - 1;
          while (at > 0 && keepW[at - 1] < w) {
            keepW[at] = keepW[at - 1];
            keepJ[at] = keepJ[at - 1];
            at -= 1;
          }
          keepW[at] = w;
          keepJ[at] = j;
        }
      }
    }
    let sum = 0;
    for (let k = 0; k < kept; k += 1) sum += keepW[k];
    if (!(sum > 0)) return [];
    const out = (c.outShare * sum) / (sum + popA[i] * referenceG);
    const links = [];
    for (let k = 0; k < kept; k += 1)
      links.push({ j: keepJ[k], share: (out * keepW[k]) / sum });
    return links;
  });
}

/** A city or town as the model keeps it. */
function cityPoint(city) {
  return {
    id: city.id,
    name: city.name,
    lat: city.lat,
    lon: city.lon,
    country: city.country || '',
    population: city.population,
  };
}

/** Typical catchment where no city data is known, by airport size. */
export const FALLBACK_CATCHMENT = Object.freeze({ L: 2_000_000, M: 300_000 });

/**
 * The places the model runs over:
 *  - each airport, with the people of the cities nearest to it within
 *    OUTBREAK_AIRPORT_KM (each city counted once);
 *  - every city farther than that from any airport but within the
 *    commuting distance of a place in the model, with no cap (owner ruling,
 *    2026-10-09; it was 2,000). A city beyond commuting distance of every
 *    airport and outbreak cannot be reached, so it is not a place at all;
 *  - each outbreak location, folded into the nearest place within
 *    OUTBREAK_AIRPORT_KM, or a place of its own sized by its density band.
 *
 * @returns {{nodes: object[], origins: number[], fallback: boolean}}
 */
export function buildEpidemicNodes({
  airports = [],
  cities = [],
  locations = [],
  profile = {},
}) {
  const nodes = [];
  const fallback = !cities.length;
  const airportNodes = airports
    .filter((a) => a?.code && validPoint(a.lat, a.lon))
    .map((a) => ({
      id: a.code,
      code: a.code,
      name: a.name || a.code,
      lat: a.lat,
      lon: a.lon,
      country: a.country || '',
      kind: 'airport',
      size: a.kind === 'L' ? 'L' : 'M',
      population: 0,
    }));
  nodes.push(...airportNodes);
  // Every city goes to its nearest airport within reach, or stays a city.
  const cell = 1;
  const grid = new Map();
  airportNodes.forEach((node, i) => {
    const key = `${Math.floor(node.lat / cell)}:${Math.floor(node.lon / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });
  const nearestAirport = (point, km) => {
    let best = -1;
    let bestKm = km;
    const gy = Math.floor(point.lat / cell);
    const gx = Math.floor(point.lon / cell);
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -2; dx <= 2; dx += 1)
        for (const i of grid.get(`${gy + dy}:${gx + dx}`) || []) {
          const d = distanceKm(point, airportNodes[i]);
          if (d <= bestKm) {
            best = i;
            bestKm = d;
          }
        }
    return best;
  };
  const loose = [];
  for (const raw of cities) {
    if (!validPoint(raw?.lat, raw?.lon) || !(raw.population > 0)) continue;
    const city = cityPoint(raw);
    const i = nearestAirport(city, OUTBREAK_AIRPORT_KM);
    if (i >= 0) airportNodes[i].population += city.population;
    else loose.push(city);
  }
  for (const node of airportNodes)
    if (!(node.population > 0)) node.population = FALLBACK_CATCHMENT[node.size];
  // Loose cities near the network commute into it.
  const anchors = [
    ...airportNodes,
    ...locations.filter((l) => validPoint(l?.lat, l?.lon)),
  ];
  // Anchors by 3° cell: a city looks only in its own and the next cells.
  const anchorCells = new Map();
  for (const a of anchors) {
    const key = `${Math.floor(a.lat / 3)}:${Math.floor(a.lon / 3)}`;
    if (!anchorCells.has(key)) anchorCells.set(key, []);
    anchorCells.get(key).push(a);
  }
  const nearNetwork = loose.filter((city) => {
    const cy = Math.floor(city.lat / 3);
    const cx = Math.floor(city.lon / 3);
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -2; dx <= 2; dx += 1) {
        let x = cx + dx;
        if (x < -60) x += 120;
        if (x >= 60) x -= 120;
        for (const a of anchorCells.get(`${cy + dy}:${x}`) || [])
          if (distanceKm(a, city) <= COMMUTING.maxKm) return true;
      }
    return false;
  });
  nearNetwork
    .sort((a, b) => b.population - a.population)
    .forEach((city) =>
      nodes.push({
        id: `g${city.id}`,
        code: '',
        name: city.name,
        lat: city.lat,
        lon: city.lon,
        country: city.country,
        kind: 'city',
        population: city.population,
      }),
    );
  // Outbreak locations: patient zero's place.
  const origins = [];
  for (const location of locations) {
    const point = validPoint(location?.lat, location?.lon);
    if (!point) continue;
    let best = -1;
    let bestKm = OUTBREAK_AIRPORT_KM;
    nodes.forEach((node, i) => {
      const d = distanceKm(point, node);
      if (d <= bestKm) {
        best = i;
        bestKm = d;
      }
    });
    if (best < 0) {
      nodes.push({
        id: `o:${location.id || nodes.length}`,
        code: '',
        name: location.name || 'Outbreak',
        lat: point.lat,
        lon: point.lon,
        country: '',
        kind: 'origin',
        population: densityPeople(profile?.density) ?? 100_000,
      });
      best = nodes.length - 1;
    }
    if (!origins.includes(best)) origins.push(best);
  }
  return { nodes, origins, fallback };
}

/* ---------------------------------------------------------------------------
 * The simulation.
 * ------------------------------------------------------------------------- */

/** Commuting into places with no cases yet is drawn this many hours at a time. */
export const COMMUTE_STEP_H = 6;
export const EPIDEMIC_RUNS_DEFAULT = 200;
export const EPIDEMIC_RUNS_MAX = 500;
/**
 * Stop starting new runs past this (owner ruling, 2026-10-09: 58 s). The
 * worker's hard stop is 15 s later (73 s), still inside the page's 90 s wait.
 */
export const EPIDEMIC_BUDGET_MS = 58_000;
/** Arrival-time percentiles kept per place: 0, 5, …, 100. */
export const ARRIVAL_PERCENTILES = Object.freeze(
  Array.from({ length: 21 }, (_, i) => i * 5),
);
/*
 * Places at risk: every place any run reaches, likeliest first, with no
 * limit on how many or how unlikely (owner ruling, 2026-10-09).
 */

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const at = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[at];
}

/**
 * Run the ensemble.
 *
 * @param {object} input
 * @param {object[]} input.nodes From buildEpidemicNodes.
 * @param {number[]} input.origins Node indices where it starts.
 * @param {{from: number, to: number, departMs: number, arriveMs: number, passengers: number}[]} input.flights
 *   Flights between node indices.
 * @param {object} input.params From epiParameters.
 * @param {number} input.startMs When the outbreak starts (the scan's start).
 * @param {number} input.untilMs The end of the window.
 * @param {number} [input.runs]
 * @param {number} [input.seed]
 * @param {number} [input.budgetMs] Stop early, with the runs done, past this.
 * @param {() => number} [input.now]
 * @param {{j: number, share: number}[][]} [input.links] Commuting; worked out
 *   from the nodes when not given.
 */
export function simulateEpidemic({
  nodes,
  origins,
  flights = [],
  routes = [],
  flown = [],
  params,
  startMs,
  untilMs,
  runs = EPIDEMIC_RUNS_DEFAULT,
  seed = 1,
  budgetMs = EPIDEMIC_BUDGET_MS,
  now = Date.now,
  links = gravityLinks(nodes),
}) {
  const n = nodes.length;
  const hours = Math.max(1, Math.ceil((untilMs - startMs) / HOUR_MS));
  const runCount = Math.max(
    1,
    Math.min(EPIDEMIC_RUNS_MAX, Math.round(Number(runs) || 1)),
  );
  const rng = mulberry32(seed);
  const iv = params.interventions;
  const isOrigin = new Uint8Array(n);
  for (const i of origins) isOrigin[i] = 1;
  const valid = (i) => i >= 0 && i < n;

  // Fixed per place: population, contact, out-commuting, hospital beds.
  const N = new Float64Array(n);
  const contactAt = new Float64Array(n);
  const outShare = new Float64Array(n);
  const beds = new Float64Array(n);
  // Who commutes into each place, and what share of them: [place, share].
  const inbound = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i += 1) {
    N[i] = Math.max(1, Math.round(nodes[i].population || 1));
    contactAt[i] =
      params.contact * (isOrigin[i] ? params.originContact : params.newContact);
    beds[i] = (N[i] * (params.bedsPer1000 ?? 0.75)) / 1000;
    for (const link of links[i] || []) {
      outShare[i] += link.share;
      inbound[link.j].push(i, link.share);
    }
  }
  // Seasonality and the vector gate, per place and day.
  const days = Math.ceil(hours / 24) + 1;
  const season = new Float64Array(n * days);
  for (let i = 0; i < n; i += 1)
    for (let d = 0; d < days; d += 1) {
      const at = startMs + d * DAY_MS;
      season[i * days + d] =
        params.vector && !vectorSuitable(nodes[i].lat, at)
          ? 0
          : seasonalFactor(nodes[i].lat, at, params.seasonAmplitude);
    }
  // Dated flights by departure hour; daily routes by hour of the day.
  const byHour = Array.from({ length: hours }, () => []);
  for (const f of flights) {
    const h = Math.floor((f.departMs - startMs) / HOUR_MS);
    if (h < 0 || h >= hours || !valid(f.from) || !valid(f.to)) continue;
    const landH = Math.max(h, Math.floor((f.arriveMs - startMs) / HOUR_MS));
    byHour[h].push({ from: f.from, to: f.to, passengers: f.passengers, landH });
  }
  const byHourOfDay = Array.from({ length: 24 }, () => []);
  for (const r of routes) {
    if (!valid(r.from) || !valid(r.to) || !(r.lengthMs > 0)) continue;
    const tod = ((Number(r.timeOfDayMs) % DAY_MS) + DAY_MS) % DAY_MS;
    byHourOfDay[Math.floor(tod / HOUR_MS)].push({ ...r, tod });
  }
  // A daily route is not flown again where the scan found that flight.
  const flownKeys = new Set(flown);

  const arrivals = Array.from({ length: n }, () => []);
  const reportsFirst = Array.from({ length: n }, () => []);
  const cases = Array.from({ length: n }, () => []);
  const overwhelmedRuns = new Int32Array(n);
  const dailyTotals = [];
  const S = new Float64Array(n);
  const E = new Float64Array(n);
  const P = new Float64Array(n);
  const Is = new Float64Array(n);
  const Ia = new Float64Array(n);
  const Wp = new Float64Array(n);
  const Ws = new Float64Array(n);
  const Wa = new Float64Array(n);
  const cum = new Float64Array(n);
  const reported = new Float64Array(n);
  const firstReport = new Float64Array(n);
  const overwhelmed = new Uint8Array(n);
  const arrived = new Float64Array(n);
  const lambda = new Float64Array(n);
  const force = new Float64Array(n);
  const stamp = new Int32Array(n);
  const started = now();
  const reportDelayH = Math.max(1, Math.round((params.reportDays ?? 4) * 24));
  const awareness = params.awareness ?? 0;
  let done = 0;
  let partial = false;

  // Infectiousness of newly infectious people: gamma(k) each, so the sum of
  // m of them is gamma(m·k, 1/k); k = Infinity is exactly m.
  const weightOf = (m) =>
    m <= 0
      ? 0
      : Number.isFinite(params.k)
        ? gamma(m * params.k, 1 / params.k, rng)
        : m;
  const take = (count, from) => Math.min(from, count);
  // Only the places with someone infected are worked each hour: with every
  // city in the model there are tens of thousands of places, most untouched.
  const active = [];
  const isActive = new Uint8Array(n);
  const activate = (i) => {
    if (isActive[i]) return;
    isActive[i] = 1;
    active.push(i);
  };

  for (let run = 0; run < runCount; run += 1) {
    if (run > 0 && now() - started > budgetMs) {
      partial = true;
      break;
    }
    for (let i = 0; i < n; i += 1) {
      S[i] = Math.round(N[i] * params.susceptibleShare);
      E[i] = P[i] = Is[i] = Ia[i] = 0;
      Wp[i] = Ws[i] = Wa[i] = 0;
      cum[i] = 0;
      reported[i] = 0;
      firstReport[i] = Infinity;
      overwhelmed[i] = 0;
      arrived[i] = Infinity;
    }
    active.length = 0;
    isActive.fill(0);
    lambda.fill(0);
    let totalInfected = 0;
    let totalReported = 0;
    const seedEach = Math.max(
      1,
      Math.round(params.initialCases / origins.length),
    );
    for (const i of origins) {
      const m = Math.min(seedEach, S[i]);
      S[i] -= m;
      E[i] += m;
      cum[i] += m;
      arrived[i] = 0;
      totalInfected += m;
      activate(i);
    }
    const landing = new Map(); // hour -> [{to, e, p, s, a, wp, ws, wa}]
    const reports = new Map(); // hour -> [[place, count]]
    let deaths = 0;
    const totals = [];
    for (let h = 0; h < hours; h += 1) {
      const day = Math.floor(h / 24);
      const control = h >= iv.startHour;
      const iso = Math.min(
        0.95,
        params.isolation + (control ? iv.tracingIsolate : 0),
      );
      const presymKeep = 1 - (control ? iv.tracingPresym : 0);
      const lockdown = control ? 1 - iv.lockdown : 1;
      const drift = 1 + params.mutationPerDay * (h / 24);
      const gatherOn = day < params.gathering.days;
      // 1. Landings and reports due this hour.
      for (const t of landing.get(h) || []) {
        E[t.to] += t.e;
        P[t.to] += t.p;
        Is[t.to] += t.s;
        Ia[t.to] += t.a;
        Wp[t.to] += t.wp;
        Ws[t.to] += t.ws;
        Wa[t.to] += t.wa;
        if (t.e + t.p + t.s + t.a > 0) {
          activate(t.to);
          if (arrived[t.to] === Infinity) arrived[t.to] = h;
        }
      }
      landing.delete(h);
      for (const [i, count] of reports.get(h) || []) {
        reported[i] += count;
        totalReported += count;
        if (firstReport[i] === Infinity) firstReport[i] = h;
      }
      reports.delete(h);
      // 2. Force of infection where someone is infectious. People pull back
      //    as reported cases rise where they live.
      let kept = 0;
      for (const i of active) {
        if (E[i] + P[i] + Is[i] + Ia[i] > 0) active[kept++] = i;
        else {
          isActive[i] = 0;
          lambda[i] = 0;
        }
      }
      active.length = kept;
      const infectedNodes = active.slice();
      for (const i of infectedNodes) {
        lambda[i] = 0;
        const pressure =
          Wp[i] * presymKeep + Ws[i] * (1 - iso) + Wa[i] * params.asymRelative;
        if (pressure <= 0) continue;
        const boost = gatherOn && isOrigin[i] ? params.gathering.boost : 1;
        const caution =
          awareness > 0 ? 1 / (1 + (awareness * reported[i] * 1e5) / N[i]) : 1;
        lambda[i] =
          (params.beta *
            contactAt[i] *
            lockdown *
            drift *
            boost *
            caution *
            season[i * days + day] *
            pressure) /
          N[i];
      }
      // 3. New infections, in infected places and the places that commute
      //    into them; then the stages move on.
      //    Infected places every hour: at home, and on their residents'
      //    trips to other infected places. Places nobody has it in yet,
      //    from the infected places their people commute to, every
      //    COMMUTE_STEP_H hours with that long's exposure at once: with every
      //    town in the model, a big city has thousands commuting in.
      const mark = run * hours + h + 1;
      const commuteHour = h % COMMUTE_STEP_H === 0;
      const touched = [];
      for (const j of infectedNodes) {
        stamp[j] = mark;
        let own = (1 - outShare[j]) * lambda[j];
        for (const link of links[j] || []) own += link.share * lambda[link.j];
        force[j] = own;
        touched.push(j);
      }
      if (commuteHour)
        for (const j of infectedNodes) {
          if (!(lambda[j] > 0)) continue;
          const list = inbound[j];
          for (let k = 0; k < list.length; k += 2) {
            const i = list[k];
            if (stamp[i] === mark) {
              if (force[i] < 0) force[i] -= list[k + 1] * lambda[j];
              continue;
            }
            stamp[i] = mark;
            // Negative marks "not infected": exposure over the longer step.
            force[i] = -list[k + 1] * lambda[j];
            touched.push(i);
          }
        }
      for (const i of touched) {
        const step = force[i] < 0 ? DT * COMMUTE_STEP_H : DT;
        const pull = Math.abs(force[i]);
        force[i] = 0;
        const fresh =
          pull > 0 && S[i] > 0
            ? binomial(S[i], 1 - Math.exp(-pull * step), rng)
            : 0;
        if (fresh > 0) {
          S[i] -= fresh;
          E[i] += fresh;
          cum[i] += fresh;
          totalInfected += fresh;
          activate(i);
          if (arrived[i] === Infinity) arrived[i] = h;
        }
      }
      for (const i of infectedNodes) {
        // E → infectious, split asymptomatic / presymptomatic.
        const out = binomial(E[i], 1 - Math.exp(-params.sigma * DT), rng);
        if (out > 0) {
          E[i] -= out;
          const asym = binomial(out, params.asymShare, rng);
          const sym = out - asym;
          Ia[i] += asym;
          Wa[i] += weightOf(asym);
          P[i] += sym;
          Wp[i] += weightOf(sym);
        }
        // Presymptomatic → symptomatic, keeping each person's weight. Some
        // are tested and reported, a few days later.
        const onset = binomial(P[i], 1 - Math.exp(-params.rho * DT), rng);
        if (onset > 0) {
          const w = (Wp[i] * onset) / P[i];
          P[i] -= onset;
          Wp[i] -= w;
          Is[i] += onset;
          Ws[i] += w;
          const found = binomial(onset, params.ascertainment ?? 0.25, rng);
          if (found > 0) {
            const at = h + reportDelayH;
            const list = reports.get(at) || [];
            list.push([i, found]);
            reports.set(at, list);
          }
        }
        const healS = binomial(Is[i], 1 - Math.exp(-params.gammaSym * DT), rng);
        if (healS > 0) {
          // Past the hospital beds, the share who die doubles for those
          // who cannot get one.
          const inHospital = Is[i] * params.hospitalShare;
          const overflow =
            inHospital > beds[i] && inHospital > 0
              ? (inHospital - beds[i]) / inHospital
              : 0;
          if (overflow > 0) overwhelmed[i] = 1;
          deaths += binomial(
            healS,
            Math.min(1, params.fatalityShare * (1 + overflow)),
            rng,
          );
          Ws[i] -= (Ws[i] * healS) / Is[i];
          Is[i] -= healS;
        }
        const healA = binomial(
          Ia[i],
          1 - Math.exp(-params.gammaAsym * DT),
          rng,
        );
        if (healA > 0) {
          Wa[i] -= (Wa[i] * healA) / Ia[i];
          Ia[i] -= healA;
        }
        if (P[i] <= 0) Wp[i] = 0;
        if (Is[i] <= 0) Ws[i] = 0;
        if (Ia[i] <= 0) Wa[i] = 0;
      }
      // Animal reservoir: fresh spillover at patient zero's place.
      if (params.reservoirPerDay > 0)
        for (const i of origins) {
          const spill = Math.min(
            S[i],
            poisson(params.reservoirPerDay * DT, rng),
          );
          if (spill > 0) {
            S[i] -= spill;
            E[i] += spill;
            cum[i] += spill;
            totalInfected += spill;
            activate(i);
          }
        }
      // 4. Flights leaving this hour: infected travellers board, some are
      //    caught by screening, the rest land later.
      const board = (from, to, passengers, landH) => {
        if (E[from] + P[from] + Is[from] + Ia[from] <= 0) return;
        let pax =
          passengers *
          params.travel *
          (gatherOn && isOrigin[from] ? params.gathering.travel : 1);
        if (control && iv.travelBan > 0) pax *= 1 - iv.travelBan;
        pax = Math.round(pax);
        if (pax <= 0) return;
        const share = (count) => count / N[from];
        let e = take(binomial(pax, share(E[from]), rng), E[from]);
        const p = take(binomial(pax, share(P[from]), rng), P[from]);
        const s = take(
          binomial(pax, share(Is[from]) * params.symptomaticTravel, rng),
          Is[from],
        );
        let a = take(binomial(pax, share(Ia[from]), rng), Ia[from]);
        if (e + p + s + a <= 0) return;
        const wp = P[from] > 0 ? (Wp[from] * p) / P[from] : 0;
        const ws = Is[from] > 0 ? (Ws[from] * s) / Is[from] : 0;
        const wa = Ia[from] > 0 ? (Wa[from] * a) / Ia[from] : 0;
        E[from] -= e;
        P[from] -= p;
        Wp[from] -= wp;
        Is[from] -= s;
        Ws[from] -= ws;
        Ia[from] -= a;
        Wa[from] -= wa;
        let keepP = p;
        let keepS = s;
        // Screening at departure and on arrival: those caught are isolated.
        const screen = (on) => {
          if (!control || !on) return;
          keepS -= binomial(keepS, SCREENING_CATCH.symptomatic, rng);
          keepP -= binomial(keepP, SCREENING_CATCH.presym, rng);
        };
        screen(iv.exitScreening);
        screen(iv.entryScreening);
        // Quarantine on arrival catches those who fall ill or test positive
        // within it: most of a 14-day one, little of a 2-day one.
        if (control && iv.quarantineDays > 0) {
          const catchShare = Math.min(
            0.95,
            1 - Math.exp((-1.2 * iv.quarantineDays) / params.incubationDays),
          );
          e -= binomial(e, catchShare, rng);
          keepP -= binomial(keepP, catchShare, rng);
          keepS -= binomial(keepS, catchShare, rng);
          a -= binomial(a, catchShare, rng);
        }
        if (e + keepP + keepS + a <= 0) return;
        const list = landing.get(landH) || [];
        list.push({
          to,
          e,
          p: keepP,
          s: keepS,
          a,
          wp: p > 0 ? (wp * keepP) / p : 0,
          ws: s > 0 ? (ws * keepS) / s : 0,
          wa,
        });
        landing.set(landH, list);
      };
      for (const f of byHour[h]) board(f.from, f.to, f.passengers, f.landH);
      const hourMs = startMs + h * HOUR_MS;
      const hourOfDay = Math.floor(
        (((hourMs % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS,
      );
      for (const r of byHourOfDay[hourOfDay]) {
        const departMs = hourMs - (hourMs % HOUR_MS) + (r.tod % HOUR_MS);
        if (
          flownKeys.size &&
          flownKeys.has(`${r.from}>${r.to}|${Math.round(departMs / 1_800_000)}`)
        )
          continue;
        board(
          r.from,
          r.to,
          r.passengers,
          Math.floor((departMs + r.lengthMs - startMs) / HOUR_MS),
        );
      }
      if (h % 24 === 23 || h === hours - 1)
        totals.push([totalInfected, totalReported, deaths]);
    }
    for (let i = 0; i < n; i += 1) {
      if (arrived[i] !== Infinity) arrivals[i].push(arrived[i]);
      if (firstReport[i] !== Infinity) reportsFirst[i].push(firstReport[i]);
      if (overwhelmed[i]) overwhelmedRuns[i] += 1;
      cases[i].push(cum[i]);
    }
    dailyTotals.push(totals);
    done += 1;
  }

  // Percentiles over all runs: a run where it never came is "later than the
  // window" (null).
  const percentiles = (list) => {
    const sorted = list.sort((a, b) => a - b);
    return ARRIVAL_PERCENTILES.map((p) => {
      const rank = Math.floor((p / 100) * (done - 1));
      return rank < sorted.length ? sorted[rank] : null;
    });
  };
  const places = [];
  for (let i = 0; i < n; i += 1) {
    const pArrive = arrivals[i].length / done;
    if (!(pArrive > 0)) continue;
    const pct = percentiles(arrivals[i]);
    const reportPct = percentiles(reportsFirst[i]);
    const c = cases[i].sort((a, b) => a - b);
    const node = nodes[i];
    places.push({
      id: node.id,
      code: node.code || '',
      name: node.name || node.code || '',
      kind: node.kind,
      lat: node.lat,
      lon: node.lon,
      population: N[i],
      origin: Boolean(isOrigin[i]),
      pArrive: Math.round(pArrive * 1000) / 1000,
      arrivalHours: pct,
      // When it arrives in the runs that bring it at all: the timing even
      // of a place few runs reach (arrivedBy).
      arrivalGiven: ARRIVAL_PERCENTILES.map(
        (p) =>
          arrivals[i][
            Math.round((p / 100) * Math.max(0, arrivals[i].length - 1))
          ],
      ),
      etaP5: pct[1],
      etaP50: pct[10],
      etaP95: pct[19],
      pReported: Math.round((reportsFirst[i].length / done) * 1000) / 1000,
      reportP5: reportPct[1],
      reportP50: reportPct[10],
      reportP95: reportPct[19],
      pOverwhelmed: Math.round((overwhelmedRuns[i] / done) * 1000) / 1000,
      casesP50: Math.round(quantile(c, 50)),
      casesP95: Math.round(quantile(c, 95)),
    });
  }
  places.sort(
    (a, b) =>
      b.pArrive - a.pArrive || (a.etaP50 ?? Infinity) - (b.etaP50 ?? Infinity),
  );
  const dayCount = dailyTotals[0]?.length || 0;
  const band = (d, k) => {
    const v = dailyTotals.map((t) => t[d][k]).sort((a, b) => a - b);
    return [5, 50, 95].map((p) => Math.round(quantile(v, p)));
  };
  const totals = Array.from({ length: dayCount }, (_, d) => {
    const [p5, p50, p95] = band(d, 0);
    const [reportedP5, reportedP50, reportedP95] = band(d, 1);
    const [deathsP5, deathsP50, deathsP95] = band(d, 2);
    return {
      day: d + 1,
      p5,
      p50,
      p95,
      reportedP5,
      reportedP50,
      reportedP95,
      deathsP5,
      deathsP50,
      deathsP95,
    };
  });
  // Commuting lines worth drawing: between places it likely reached.
  const likely = new Map(
    places.filter((p) => p.pArrive >= 0.1).map((p) => [p.id, p]),
  );
  const commutes = [];
  for (let i = 0; i < n; i += 1) {
    if (!likely.has(nodes[i].id)) continue;
    for (const link of links[i] || []) {
      if (!likely.has(nodes[link.j].id) || link.j < i) continue;
      commutes.push({
        from: { lat: nodes[i].lat, lon: nodes[i].lon, name: nodes[i].name },
        to: {
          lat: nodes[link.j].lat,
          lon: nodes[link.j].lon,
          name: nodes[link.j].name,
        },
        perDay: Math.round(link.share * N[i]),
      });
    }
  }
  commutes.sort((a, b) => b.perDay - a.perDay);
  const last = totals.at(-1);
  return {
    startMs,
    untilMs,
    hours,
    runs: done,
    runsAsked: runCount,
    partial,
    seed,
    places,
    commutes: commutes.slice(0, 120),
    totals,
    summary: {
      r0: params.r0,
      rEffective: round2(params.rEffective),
      rFactors: params.rFactors || [],
      rControlled: round2(params.rEffectiveControlled),
      doublingDays: roundOrNull(doublingTime(params, false)),
      doublingControlledDays: roundOrNull(doublingTime(params, true)),
      establishment: round2(
        establishmentProbability(params.rEffective, params.k),
      ),
      k: Number.isFinite(params.k) ? params.k : null,
      infectedP50: last?.p50 ?? 0,
      infectedP95: last?.p95 ?? 0,
      reportedP50: last?.reportedP50 ?? 0,
      reportedP95: last?.reportedP95 ?? 0,
      deathsP50: last?.deathsP50 ?? 0,
      deathsP95: last?.deathsP95 ?? 0,
      hospitalP50: Math.round(
        (last?.p50 ?? 0) * (1 - params.asymShare) * params.hospitalShare,
      ),
      ascertainment: params.ascertainment ?? 0.25,
      reportDays: params.reportDays ?? 4,
      placesOverwhelmed: places.filter((p) => p.pOverwhelmed >= 0.5).length,
    },
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function roundOrNull(n) {
  return n === null ? null : Math.round(n * 10) / 10;
}

/**
 * P(arrived by `hour`): the share of runs whose arrival is at or before it.
 * From the arrival times in the runs that bring it at all (arrivalGiven),
 * read between its percentiles, times the chance it comes; else from the
 * percentiles over all runs.
 */
export function arrivedBy(place, hour) {
  const given = place?.arrivalGiven;
  if (Array.isArray(given) && given.length && given[0] !== undefined) {
    if (!(hour >= given[0])) return 0;
    const last = given.length - 1;
    if (hour >= given[last]) return place.pArrive ?? 1;
    let i = 0;
    while (i < last && given[i + 1] <= hour) i += 1;
    const span = given[i + 1] - given[i];
    const within = span > 0 ? (hour - given[i]) / span : 1;
    // From one step in at the earliest arrival to all of it at the latest.
    return ((place.pArrive ?? 1) * (i + within + 1)) / (last + 1);
  }
  const pct = place?.arrivalHours;
  if (!Array.isArray(pct)) return 0;
  let share = 0;
  pct.forEach((h, i) => {
    if (h !== null && h <= hour) share = ARRIVAL_PERCENTILES[i] / 100;
  });
  return Math.min(share, place.pArrive ?? 1);
}

/**
 * When it arrives, in words: the median and its 5–95 % window where most
 * runs bring it, else how soon the earliest 5 % do.
 */
function arrivalWords(place, at) {
  if (place.etaP50 !== null && place.etaP50 !== undefined)
    return ` · median arrival ${at(place.etaP50)} (5–95 %: ${at(place.etaP5)} to ${at(place.etaP95)})`;
  if (place.etaP5 !== null && place.etaP5 !== undefined)
    return ` · earliest 5 % of runs by ${at(place.etaP5)}`;
  return '';
}

/** When it is first reported there, in words, if it is in most runs. */
function reportWords(place, at) {
  if (place.reportP50 !== null && place.reportP50 !== undefined)
    return ` · first reported ${at(place.reportP50)}`;
  if (place.pReported > 0)
    return ` · reported in ${Math.round(place.pReported * 100)} % of runs`;
  return '';
}

function count(n) {
  return Math.round(n || 0).toLocaleString('en-US');
}

/** The epidemic result in a few lines, for the box and the language model. */
export function epidemicLines(
  result,
  { startMs = result?.startMs, max = 10 } = {},
) {
  if (!result?.places) return [];
  const s = result.summary || {};
  const at = (h) =>
    h === null || h === undefined
      ? 'after the window'
      : `${new Date(startMs + h * HOUR_MS)
          .toISOString()
          .slice(5, 16)
          .replace('T', ' ')} UTC`;
  const lines = [
    `R0 ${s.r0} · R now ${s.rEffective}${s.rFactors?.length ? ` (${s.rFactors.map((f) => `${f.label} ×${f.factor}`).join(', ')})` : ''}${s.rControlled !== s.rEffective ? ` · with interventions ${s.rControlled}` : ''} · doubling ${s.doublingDays ?? '—'} d · one import takes hold ${Math.round((s.establishment || 0) * 100)} %`,
    `Infected by the end (median, 95th): ${count(s.infectedP50)} · ${count(s.infectedP95)} · ${result.runs} runs, seed ${result.seed}${result.partial ? ' (time limit: fewer runs)' : ''}`,
  ];
  if (s.reportedP50 !== undefined)
    lines.push(
      `Reported: ${count(s.reportedP50)} (${Math.round((s.ascertainment || 0) * 100)} % of cases with symptoms, ~${s.reportDays} d late) · deaths ${count(s.deathsP50)} (95th ${count(s.deathsP95)})${s.placesOverwhelmed ? ` · hospitals overwhelmed in ${s.placesOverwhelmed} place${s.placesOverwhelmed === 1 ? '' : 's'}` : ''}`,
    );
  for (const place of result.places.filter((p) => !p.origin).slice(0, max))
    lines.push(
      `${place.code ? `${place.code} ` : ''}${place.name}: ${Math.round(place.pArrive * 100)} %${arrivalWords(place, at)}${reportWords(place, at)}`,
    );
  return lines;
}
