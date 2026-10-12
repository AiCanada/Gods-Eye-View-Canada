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
 *  - A hospital pathway: admission after a delay, ward and intensive-care
 *    stays, and a death risk at discharge that rises where the beds have
 *    run out (Ferguson et al. 2020, Report 9; Lipsitch & Dean 2020).
 *  - A recovered compartment with optional waning back to susceptible
 *    (SIRS: Kissler et al. 2020; Keeling & Rohani 2008), applied lazily to
 *    the places the loop touches, with reinfections counted.
 *  - Prior vaccination as a closed-form factor on R: coverage × efficacy of
 *    the population starts immune (Bubar et al. 2021); a campaign protects
 *    a share a day up to a cap, two weeks after the dose, origins first if
 *    chosen.
 *  - Household and community contacts split, so a lockdown that reaches
 *    only outside the home leaves household spread, which even rises a
 *    little (Ferguson et al. 2020, Report 9; Madewell et al. 2020).
 *  - Gamma-distributed susceptibility: the most susceptible go first, which
 *    lowers the herd-immunity line 1 − R^(−1/(1 + CV²)) (Gomes et al. 2022).
 *  - A fitter variant taking over along a logistic curve (Davies et al.
 *    2021; Campbell et al. 2021).
 *  - Restrictions with an end date, or triggered place by place where
 *    reported incidence or the hospital load passes a threshold and
 *    released below half of it (Flaxman et al. 2020), with compliance
 *    fading towards a floor (Petherick et al. 2021) and a cost ledger:
 *    person-days restricted, passengers kept off, travellers caught,
 *    bed-days short.
 *  - Awareness of reports or deaths, nearby or everywhere, that tires with
 *    time (Weitz et al. 2020; Funk et al. 2009).
 *  - A testing capacity: reports past the day's tests are lost (Grassly et
 *    al. 2020).
 *  - Countries: domestic and international flights at their own share of
 *    normal, a border policy saying which legs the ban, screening and
 *    quarantine reach (Chinazzi et al. 2020; Russell et al. 2021), and each
 *    place's cases split into imported and local, with what brought it first.
 *  - Detection of arriving cases at the gate, isolated and reported (Gostic
 *    et al. 2015).
 *  - Hub transfers: a share of those landing at a large airport fly on after
 *    a layover, picked by passengers (Poletto et al. 2012).
 *  - Local departure clocks from longitude, and commuting split between
 *    daytime and night at the destination's local hour (Balcan et al. 2009).
 *  - Two-way daytime mixing: commuters bring their infectiousness to where
 *    they work, over the daytime population there (Balcan et al. 2009).
 *  - One random substream per run, so run r is the same whatever the run
 *    count or the time limit, and run 0 is the seed itself.
 *  - An optional second strain, seeded on a chosen day and place, with its
 *    own transmissibility, severity and cross-immunity: one shared pool of
 *    new infections split by the two pulls, and escape from first-strain
 *    immunity; status-based, so the strain-2 recovered are immune to both
 *    (Gog & Grenfell 2002; Davies et al. 2021; Kerr et al. 2021 Covasim).
 *  - A deadline read every few simulated hours: past it, run 0 is kept cut
 *    short and a later run is dropped, so a slow run still gives a result.
 *  - An optional comparison against the same scenario with a set of
 *    measures taken away, run r of both arms on the same random substream
 *    (common random numbers), so the paired difference is what the measures
 *    did (Glasserman 2003 §4.1; Kleijnen 2015).
 *  - Rt in the runs: each day's new infections over the infectiousness of
 *    those before, weighted by the model's own generation kernel (Cori et
 *    al. 2013; Gostic et al. 2020; Wallinga & Lipsitch 2007).
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
import {
  AWARENESS_FLOOR,
  RT_KERNEL_DAYS_MAX,
  RT_MIN_INFECTIOUS,
  awarenessCaution,
  diurnalFactor,
  generationKernel,
  localOffsetHours,
  quantileInterval,
  renewalRt,
  wilsonInterval,
} from './outbreakEpiStats.mjs';
import { numberHeap } from './outbreakNetwork.mjs';

// The statistics the model's consumers read through this module.
export {
  AWARENESS_FLOOR,
  RT_KERNEL_DAYS_MAX,
  RT_MIN_INFECTIOUS,
  awarenessCaution,
  diurnalFactor,
  generationKernel,
  localOffsetHours,
  quantileInterval,
  renewalRt,
  wilsonInterval,
};

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
      hospitalDays: 8,
      icuPct: 25,
      waningDays: 0,
      vaccinatedPct: 0,
      vaccineEfficacyPct: 0,
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
      hospitalDays: 5,
      icuPct: 10,
      waningDays: 270,
      vaccinatedPct: 30,
      vaccineEfficacyPct: 50,
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
      hospitalDays: 8,
      icuPct: 25,
      waningDays: 365,
      vaccinatedPct: 0,
      vaccineEfficacyPct: 0,
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
      hospitalDays: 5,
      icuPct: 10,
      waningDays: 180,
      vaccinatedPct: 60,
      vaccineEfficacyPct: 40,
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
      hospitalDays: 5,
      icuPct: 10,
      waningDays: 0,
      vaccinatedPct: 85,
      vaccineEfficacyPct: 95,
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
      hospitalDays: 20,
      icuPct: 25,
      waningDays: 0,
      vaccinatedPct: 0,
      vaccineEfficacyPct: 0,
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
      hospitalDays: 15,
      icuPct: 40,
      waningDays: 0,
      vaccinatedPct: 0,
      vaccineEfficacyPct: 0,
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
      hospitalDays: 10,
      icuPct: 50,
      waningDays: 0,
      vaccinatedPct: 0,
      vaccineEfficacyPct: 0,
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
      hospitalDays: 10,
      icuPct: 5,
      waningDays: 0,
      vaccinatedPct: 5,
      vaccineEfficacyPct: 70,
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
      hospitalDays: 5,
      icuPct: 10,
      waningDays: 0,
      vaccinatedPct: 0,
      vaccineEfficacyPct: 0,
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
      hospitalDays: 14,
      icuPct: 60,
      waningDays: 0,
      vaccinatedPct: 0,
      vaccineEfficacyPct: 0,
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

/**
 * Numeric epidemic fields: [min, max, decimals]. A blank one is its neutral
 * value: `hospitalDays` blank runs the legacy death path; the campaign runs
 * only with `vaccineStartDay` set and `vaccinePer1000Day` above 0.
 */
export const EPI_NUMBER_FIELDS = Object.freeze({
  latentDays: Object.freeze([0.1, INCUBATION_DAYS_MAX, 1]),
  infectiousDays: Object.freeze([0.5, 60, 1]),
  asymptomaticPct: Object.freeze([0, 95, 0]),
  asymRelative: Object.freeze([0, 1.5, 2]),
  hospitalPct: Object.freeze([0, 100, 1]),
  fatalityPct: Object.freeze([0, 100, 2]),
  // The hospital pathway: mean ward stay, the ICU share of admissions and
  // the days from leaving the infectious stage to admission.
  hospitalDays: Object.freeze([1, 60, 0]),
  icuPct: Object.freeze([0, 100, 0]),
  admitDelayDays: Object.freeze([0, 14, 1]),
  // Immunity: mean days until it is lost (0: lifelong); prior vaccination.
  waningDays: Object.freeze([0, 3650, 0]),
  vaccinatedPct: Object.freeze([0, 100, 0]),
  vaccineEfficacyPct: Object.freeze([0, 100, 0]),
  // The campaign: start day, doses per 1,000 a day and the coverage cap.
  vaccineStartDay: Object.freeze([0, 40, 0]),
  vaccinePer1000Day: Object.freeze([0, 50, 1]),
  vaccineCoverageMaxPct: Object.freeze([0, 95, 0]),
  // Movement: share of daily commuting in daytime; flights as % of normal.
  commuteDaySplit: Object.freeze([0.5, 1, 2]),
  travelDomesticPct: Object.freeze([0, 300, 0]),
  travelIntlPct: Object.freeze([0, 300, 0]),
  // Surveillance: tests per 1,000 a day (0: unlimited); awareness half-life.
  testsPer1000Day: Object.freeze([0, 50, 2]),
  fatigueDays: Object.freeze([0, 180, 0]),
  // A second strain (variants 'two-strain'): the day it is seeded (from the
  // window start), its seed cases, its transmissibility and severity as %
  // of the first, and the % of first-strain immunity that also protects.
  strain2Day: Object.freeze([0, 40, 0]),
  strain2Cases: Object.freeze([1, 100_000, 0]),
  strain2Pct: Object.freeze([10, 300, 0]),
  strain2SeverityPct: Object.freeze([10, 500, 0]),
  crossImmunityPct: Object.freeze([0, 100, 0]),
  initialCases: Object.freeze([1, 100_000, 0]),
  travelBanPct: Object.freeze([0, 100, 0]),
  quarantineDays: Object.freeze([0, 21, 0]),
  lockdownPct: Object.freeze([0, 90, 0]),
  interventionHour: Object.freeze([0, 24 * 30, 0]),
  // The intervention window and the per-place triggers: its length in days
  // (0: no end), the 7-day reported incidence or the share of free beds
  // full that switches a place on, the shortest restriction, the
  // compliance half-life and the reported cases that flag a country.
  interventionDays: Object.freeze([0, 40, 0]),
  triggerPer100k: Object.freeze([0, 500, 1]),
  triggerBedShare: Object.freeze([0, 100, 0]),
  minLockDays: Object.freeze([1, 28, 0]),
  fatigueHalfDays: Object.freeze([0, 180, 0]),
  borderTrigger: Object.freeze([1, 100_000, 0]),
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
    // hh: the share of contacts made at home (Ferguson et al. 2020, Report
    // 9; Madewell et al. 2020), what a lockdown outside the home leaves.
    options: Object.freeze([
      { id: 'small', label: 'Small (1–2)', contact: 0.95, hh: 0.2 },
      { id: 'average', label: 'Average (3–4)', contact: 1, hh: 0.3 },
      { id: 'large', label: 'Large (5+)', contact: 1.1, hh: 0.4 },
    ]),
  }),
  Object.freeze({
    key: 'healthcare',
    label: 'Healthcare & surveillance',
    // detect: share of symptomatic cases ever reported; reportDays: from
    // symptoms to the report; beds: hospital beds per 1,000 people; icu:
    // intensive-care beds per 1,000 (OECD/WHO: India 0.02, UK 0.07,
    // Germany 0.29).
    options: Object.freeze([
      {
        id: 'low',
        label: 'Low (overwhelmed)',
        isolate: 0,
        contact: 1.05,
        detect: 0.1,
        reportDays: 7,
        beds: 1,
        icu: 0.02,
      },
      {
        id: 'medium',
        label: 'Medium',
        isolate: 0.1,
        detect: 0.3,
        reportDays: 4,
        beds: 2.5,
        icu: 0.1,
      },
      {
        id: 'high',
        label: 'High',
        isolate: 0.25,
        detect: 0.6,
        reportDays: 2,
        beds: 4,
        icu: 0.3,
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
  // The first option of each menu below is the neutral one: the model runs
  // as it did before the menu existed.
  Object.freeze({
    key: 'heterogeneity',
    label: 'Susceptibility variation',
    // cv: coefficient of variation of susceptibility (Gomes et al. 2022).
    options: Object.freeze([
      { id: 'none', label: 'None (everyone alike)', cv: 0 },
      { id: 'moderate', label: 'Moderate (CV 1)', cv: 1 },
      { id: 'high', label: 'High (CV 2)', cv: 2 },
    ]),
  }),
  Object.freeze({
    key: 'lockdownScope',
    label: 'Lockdown reach',
    options: Object.freeze([
      { id: 'all', label: 'Everyone (household too)' },
      { id: 'community', label: 'Outside the home only' },
    ]),
  }),
  Object.freeze({
    key: 'mixing',
    label: 'Commuting mixing',
    options: Object.freeze([
      { id: 'home', label: 'Home only (one way)' },
      { id: 'daytime', label: 'Daytime two-way' },
    ]),
  }),
  Object.freeze({
    key: 'clock',
    label: 'Departure clock',
    options: Object.freeze([
      { id: 'utc', label: 'UTC hours' },
      { id: 'local', label: 'Local hours' },
    ]),
  }),
  Object.freeze({
    key: 'transfers',
    label: 'Airport transfers',
    // transferShare: passengers landing at a large airport who fly on;
    // layoverHours: how long they wait there.
    options: Object.freeze([
      { id: 'none', label: 'None', transferShare: 0, layoverHours: 0 },
      {
        id: 'some',
        label: 'Some connecting passengers',
        transferShare: 0.15,
        layoverHours: 3,
      },
      {
        id: 'hub-heavy',
        label: 'Hub heavy',
        transferShare: 0.3,
        layoverHours: 2,
      },
    ]),
  }),
  Object.freeze({
    key: 'responseSignal',
    label: 'Response signal',
    options: Object.freeze([
      { id: 'reported', label: 'Reported cases' },
      { id: 'deaths', label: 'Deaths' },
      { id: 'both', label: 'Both' },
    ]),
  }),
  Object.freeze({
    key: 'responseReach',
    label: 'Response reach',
    options: Object.freeze([
      { id: 'local', label: 'Own place' },
      { id: 'mixed', label: 'Mixed' },
      { id: 'global', label: 'Everywhere' },
    ]),
  }),
  Object.freeze({
    key: 'variants',
    label: 'Variant emergence',
    options: Object.freeze([
      { id: 'drift', label: 'Steady drift' },
      { id: 'takeover', label: 'A fitter strain takes over' },
      { id: 'two-strain', label: 'Second strain (set below)' },
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
  Object.freeze({
    key: 'triggerMode',
    label: 'Local trigger',
    options: Object.freeze([
      { id: 'everywhere', label: 'Everywhere at the start hour' },
      { id: 'reported', label: 'Reported cases per 100,000' },
      { id: 'hospital', label: 'Hospital load' },
    ]),
  }),
  Object.freeze({
    key: 'borderPolicy',
    label: 'Border policy',
    options: Object.freeze([
      { id: 'none', label: 'Every flight' },
      { id: 'origin', label: 'Flights out of the outbreak countries' },
      {
        id: 'reported',
        label: 'Flights out of countries reaching the trigger',
      },
      { id: 'all', label: 'Every international flight' },
    ]),
  }),
  Object.freeze({
    key: 'importDetection',
    label: 'Detection of arriving cases',
    // importDetect: share of symptomatic arrivals found and reported.
    options: Object.freeze([
      { id: 'off', label: 'Off', importDetect: 0 },
      { id: 'low', label: 'Low', importDetect: 0.2 },
      { id: 'medium', label: 'Medium', importDetect: 0.5 },
      { id: 'high', label: 'High', importDetect: 0.8 },
    ]),
  }),
  Object.freeze({
    key: 'vaccinePriority',
    label: 'Vaccination priority',
    options: Object.freeze([
      { id: 'everywhere', label: 'Everywhere' },
      { id: 'origin-first', label: 'Outbreak places first' },
    ]),
  }),
  // A second arm without a set of measures (COUNTERFACTUAL_SETS), paired
  // run by run with the main one.
  Object.freeze({
    key: 'compare',
    label: 'Compare against',
    options: Object.freeze([
      { id: 'none', label: 'Nothing' },
      { id: 'all', label: 'No interventions' },
      { id: 'travel', label: 'No travel measures' },
      { id: 'distancing', label: 'No lockdown or tracing' },
      { id: 'vaccination', label: 'No vaccination campaign' },
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

/** Mean intensive-care stay, in days (Ferguson et al. 2020, Report 9). */
export const ICU_DAYS = 10;
/** Days from a vaccine dose to protection. */
export const VACCINE_PROTECT_DAYS = 14;
/** Days the campaign starts later away from the outbreak under origin-first. */
export const ORIGIN_FIRST_DELAY_DAYS = 14;
/** Household contacts rise by this share under a full lockdown (CovidSim). */
export const HOUSEHOLD_LOCKDOWN_BUMP = 0.25;
/** Compliance with restrictions never fades below this share. */
export const COMPLIANCE_FLOOR = 0.4;
/** A fitter variant takes over along a logistic curve: midpoint and scale. */
export const TAKEOVER_MID_DAYS = 30;
export const TAKEOVER_SCALE_DAYS = 5;
/** Its fitness advantage over the first strain, by the mutation setting. */
export const TAKEOVER_ADVANTAGE = Object.freeze({
  low: 0,
  medium: 0.4,
  high: 0.7,
});
/** Reported incidence is an exponential window of this many days. */
export const INCIDENCE_WINDOW_DAYS = 7;
/** A triggered restriction is released below this share of its trigger. */
export const TRIGGER_RELEASE_RATIO = 0.5;
/** No more than this share of a landing batch flies on from a hub. */
export const TRANSFER_SHARE_MAX = 0.5;

/**
 * How much more transmissible the outbreak is on `day` when a fitter strain
 * with advantage `adv` takes over: 1 + adv / (1 + e^(−(day − mid) / scale)),
 * from almost 1 to 1 + adv (Davies et al. 2021; Campbell et al. 2021).
 */
export function takeoverMultiplier(day, adv) {
  if (!(adv > 0)) return 1;
  return (
    1 + adv / (1 + Math.exp(-(day - TAKEOVER_MID_DAYS) / TAKEOVER_SCALE_DAYS))
  );
}

/**
 * Text epidemic fields and their pattern: the second strain's airport code
 * (3-4 letters or digits), kept trimmed and upper-cased.
 */
export const EPI_CODE_FIELDS = Object.freeze({
  strain2Place: /^[A-Za-z0-9]{3,4}$/,
});

/** The second strain's values when its fields are blank. */
export const STRAIN2_DEFAULTS = Object.freeze({
  day: 14,
  cases: 10,
  rel: 1.5,
  severity: 1,
  cross: 0.5,
});

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
  for (const [key, re] of Object.entries(EPI_CODE_FIELDS))
    if (typeof raw?.[key] === 'string' && re.test(raw[key].trim()))
      out[key] = raw[key].trim().toUpperCase();
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
  const isSet = (value) =>
    value !== undefined &&
    value !== null &&
    value !== '' &&
    Number.isFinite(Number(value));
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const oneOf = (value, ids) => (ids.includes(value) ? value : ids[0]);
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
  // Prior vaccination: coverage × efficacy of the population starts immune
  // (Bubar et al. 2021). Efficacy blank is 70 % with a campaign, none
  // without; the same efficacy serves the campaign.
  const vaccinated = clamp(num(p.vaccinatedPct, 0) / 100, 0, 1);
  const campaign = isSet(p.vaccineStartDay) && num(p.vaccinePer1000Day, 0) > 0;
  const vaccineEfficacy = isSet(p.vaccineEfficacyPct)
    ? clamp(num(p.vaccineEfficacyPct, 0) / 100, 0, 1)
    : campaign
      ? 0.7
      : 0;
  note(
    `vaccinated ${num(p.vaccinatedPct, 0)} %`,
    1 - vaccinated * vaccineEfficacy,
  );
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
  // Contacts made at home, what a lockdown outside the home leaves; none
  // when it spreads by vectors or surfaces rather than between people.
  const household = option(EPI_HUMAN_FACTORS, 'household', p.household);
  const householdShare =
    transmission === 'vector' || transmission === 'fomites'
      ? 0
      : (household?.hh ?? 0);
  const transfers = option(EPI_HUMAN_FACTORS, 'transfers', p.transfers);
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
    susceptibleShare: susceptible * (1 - vaccinated * vaccineEfficacy),
    travel,
    // Flights as a share of normal, domestic and international.
    travelDomestic: Math.max(0, num(p.travelDomesticPct, 100) / 100),
    travelIntl: Math.max(0, num(p.travelIntlPct, 100) / 100),
    // Most people with symptoms stay home; the very ill never fly.
    symptomaticTravel: 0.15 * (1 - hospitalShare),
    isolation,
    hospitalShare,
    fatalityShare,
    // The hospital pathway: mean ward stay (blank: the legacy death path
    // with no occupancy), the ICU share of admissions, the admission lag
    // and intensive-care beds per 1,000 (raw; 30 % of them are free).
    hospitalDays: isSet(p.hospitalDays)
      ? Math.max(1, num(p.hospitalDays, 1))
      : null,
    icuShare: clamp(num(p.icuPct, 0) / 100, 0, 1),
    admitDelayDays: Math.max(0, num(p.admitDelayDays, 0)),
    icuPer1000: healthcare?.icu ?? 0.1,
    // Immunity lost after this many days on average; 0 is lifelong.
    waningDays: Math.max(0, num(p.waningDays, 0)),
    // Susceptibility variation (its coefficient of variation) and the mix
    // of household and community contacts a lockdown reaches.
    heterogeneityCv:
      option(EPI_HUMAN_FACTORS, 'heterogeneity', p.heterogeneity)?.cv ?? 0,
    householdShare,
    lockdownScope: oneOf(p.lockdownScope, ['all', 'community']),
    // Commuting: one-way or two-way daytime mixing, the daytime share of
    // the day's commuting, and whether routes leave by UTC or local hours.
    mixing: oneOf(p.mixing, ['home', 'daytime']),
    clock: oneOf(p.clock, ['utc', 'local']),
    commuteDaySplit: clamp(num(p.commuteDaySplit, 0.5), 0.5, 1),
    // Arriving symptomatic cases found; passengers flying on from a hub.
    importDetect:
      option(EPI_INTERVENTION_CHOICES, 'importDetection', p.importDetection)
        ?.importDetect ?? 0,
    transferShare: Math.min(TRANSFER_SHARE_MAX, transfers?.transferShare ?? 0),
    layoverHours: transfers?.layoverHours ?? 0,
    // Tests per 1,000 a day (0: unlimited).
    testsPer1000Day: Math.max(0, num(p.testsPer1000Day, 0)),
    // Steady drift or a fitter strain taking over, with its advantage.
    variants: oneOf(p.variants, ['drift', 'takeover', 'two-strain']),
    // The second strain, only under 'two-strain' (null otherwise): its seed
    // day (whole days) and cases, where (an airport code; blank: the
    // outbreak places), transmissibility and severity relative to the first,
    // and the share of first-strain immunity that also protects against it.
    strain2:
      p.variants === 'two-strain'
        ? {
            day: Math.max(
              0,
              Math.round(num(p.strain2Day, STRAIN2_DEFAULTS.day)),
            ),
            cases: Math.max(
              1,
              Math.round(num(p.strain2Cases, STRAIN2_DEFAULTS.cases)),
            ),
            place:
              typeof p.strain2Place === 'string'
                ? p.strain2Place.trim().toUpperCase()
                : '',
            rel: clamp(
              num(p.strain2Pct, 100 * STRAIN2_DEFAULTS.rel) / 100,
              0.1,
              3,
            ),
            severity: clamp(
              num(p.strain2SeverityPct, 100 * STRAIN2_DEFAULTS.severity) / 100,
              0.1,
              5,
            ),
            cross: clamp(
              num(p.crossImmunityPct, 100 * STRAIN2_DEFAULTS.cross) / 100,
              0,
              1,
            ),
          }
        : null,
    takeoverAdvantage: TAKEOVER_ADVANTAGE[p.mutation] ?? 0,
    // What the public reacts to, how far it looks, and how fast it tires.
    responseSignal: oneOf(p.responseSignal, ['reported', 'deaths', 'both']),
    responseReach: oneOf(p.responseReach, ['local', 'mixed', 'global']),
    fatigueDays: Math.max(0, num(p.fatigueDays, 0)),
    // Vaccination: prior coverage, efficacy, and the campaign if any.
    vaccinated,
    vaccineEfficacy,
    vaccine: campaign
      ? {
          startDay: Math.max(0, num(p.vaccineStartDay, 0)),
          perDay: num(p.vaccinePer1000Day, 0),
          coverageMax: clamp(num(p.vaccineCoverageMaxPct, 70) / 100, 0, 0.95),
          priority: oneOf(p.vaccinePriority, ['everywhere', 'origin-first']),
        }
      : null,
    vaccineProtectDays: VACCINE_PROTECT_DAYS,
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
    // The comparison arm: which measures it takes away ('none': no arm).
    compare: oneOf(p.compare, [
      'none',
      'all',
      'travel',
      'distancing',
      'vaccination',
    ]),
    interventions: {
      startHour: Math.max(0, num(p.interventionHour, 24)),
      travelBan: Math.min(1, Math.max(0, num(p.travelBanPct, 0) / 100)),
      exitScreening: p.exitScreening === 'on',
      entryScreening: p.entryScreening === 'on',
      quarantineDays: Math.max(0, num(p.quarantineDays, 0)),
      lockdown: Math.min(0.9, Math.max(0, num(p.lockdownPct, 0) / 100)),
      tracingIsolate: tracing?.isolate ?? 0,
      tracingPresym: tracing?.presym ?? 0,
      // The window's length in days (0: no end) and the per-place trigger:
      // everywhere at the start hour, or where reported incidence or the
      // hospital load reaches its threshold, kept at least minLockDays.
      interventionDays: Math.max(0, num(p.interventionDays, 0)),
      triggerMode: oneOf(p.triggerMode, ['everywhere', 'reported', 'hospital']),
      triggerPer100k: Math.max(0, num(p.triggerPer100k, 0)),
      triggerBedShare: clamp(num(p.triggerBedShare, 80) / 100, 0, 1),
      minLockDays: clamp(num(p.minLockDays, 14), 1, 28),
      // Compliance half-life in days (0: constant).
      fatigueHalfDays: Math.max(0, num(p.fatigueHalfDays, 0)),
      // Which flights the ban, screening and quarantine apply to, and the
      // reported cases that flag a country under 'reported'.
      borderPolicy: oneOf(p.borderPolicy, [
        'none',
        'origin',
        'reported',
        'all',
      ]),
      borderTrigger: Math.max(1, num(p.borderTrigger, 10)),
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
  // The second strain meeting the starting immunity at day 0: the immune it
  // escapes count as susceptible.
  if (params.strain2) {
    const sigmaS = params.susceptibleShare;
    params.rStrain2 = round2(
      params.strain2.rel *
        reproductionNumber(
          {
            ...params,
            susceptibleShare:
              sigmaS + (1 - params.strain2.cross) * (1 - sigmaS),
          },
          false,
        ),
    );
  }
  return params;
}

/**
 * Contacts left under a lockdown of share L (0 to 0.9). Reaching everyone,
 * 1 − L; reaching only outside the home, household contacts stay and even
 * rise a little while community contacts fall (Ferguson et al. 2020,
 * Report 9: household large, L 0.9 → 0.55). No household share, or scope
 * 'all', is exactly 1 − L.
 */
function lockdownMix(params, L) {
  if (params.lockdownScope !== 'community') return 1 - L;
  const hh = params.householdShare ?? 0;
  return hh * (1 + HOUSEHOLD_LOCKDOWN_BUMP * L) + (1 - hh) * (1 - L);
}

/**
 * Herd-immunity line: the share that must be immune for R to fall to 1
 * when susceptibility varies with coefficient of variation cv, 1 −
 * R^(−1/(1 + cv²)); 1 − 1/R when everyone is alike (Gomes et al. 2022).
 */
function herdImmunityShare(R, cv = 0) {
  if (!(R > 1)) return 0;
  return Math.max(0, 1 - R ** (-1 / (1 + cv * cv)));
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
  const lockdown = lockdownMix(params, controlled ? i.lockdown : 0);
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
 * What each comparison arm takes away: edits to the interventions and to the
 * top-level parameters. Testing capacity, prior coverage, the awareness
 * response, the triggers, the border policy and the flights as a share of
 * normal stay in every set: they describe the scenario, not a measure.
 */
export const COUNTERFACTUAL_SETS = Object.freeze({
  all: Object.freeze({
    interventions: Object.freeze({
      travelBan: 0,
      exitScreening: false,
      entryScreening: false,
      quarantineDays: 0,
      lockdown: 0,
      tracingIsolate: 0,
      tracingPresym: 0,
    }),
    params: Object.freeze({ importDetect: 0, vaccine: null }),
  }),
  travel: Object.freeze({
    interventions: Object.freeze({
      travelBan: 0,
      exitScreening: false,
      entryScreening: false,
      quarantineDays: 0,
    }),
    params: Object.freeze({ importDetect: 0 }),
  }),
  distancing: Object.freeze({
    interventions: Object.freeze({
      lockdown: 0,
      tracingIsolate: 0,
      tracingPresym: 0,
    }),
    params: Object.freeze({}),
  }),
  vaccination: Object.freeze({
    interventions: Object.freeze({}),
    params: Object.freeze({ vaccine: null }),
  }),
});

/**
 * The parameters of a comparison arm: a new object with the set's measures
 * taken away and R with interventions worked out again. Pure, no draw; a set
 * that edits nothing gives parameters equal in value, so both arms make the
 * same draws. An unknown set gives the parameters back.
 */
export function counterfactualParams(params, set) {
  if (!Object.hasOwn(COUNTERFACTUAL_SETS, set)) return params;
  const edits = COUNTERFACTUAL_SETS[set];
  const out = {
    ...params,
    ...edits.params,
    interventions: { ...params.interventions, ...edits.interventions },
  };
  out.rEffectiveControlled = reproductionNumber(out, true);
  return out;
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
    lockdownMix(params, controlled ? i.lockdown : 0) *
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
  // A route the scan found is tagged fromScan: its hour of day is real UTC,
  // so the model never shifts it to the local clock and the scan's flown
  // keys still suppress its own repeats.
  const add = (from, to, timeOfDayMs, lengthMs, passengers, fromScan) => {
    const key = `${from}>${to}|${Math.round(timeOfDayMs / 1_800_000)}`;
    if (!routes.has(key) && lengthMs > 0)
      routes.set(key, {
        from,
        to,
        timeOfDayMs,
        lengthMs,
        passengers,
        ...(fromScan ? { fromScan: true } : {}),
      });
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
      true,
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
  // A binary heap, not a list sorted on every step: with rail (owner ruling
  // 2026-10-12) the flows reach tens of thousands of places.
  const dist = new Map();
  const ids = new Map();
  const codes = [];
  const idOf = (code) => {
    let id = ids.get(code);
    if (id === undefined) {
      id = codes.push(code) - 1;
      ids.set(code, id);
    }
    return id;
  };
  const queue = numberHeap();
  for (const code of sources) {
    dist.set(code, 0);
    queue.push(0, idOf(code));
  }
  const done = new Set();
  while (queue.size) {
    const code = codes[queue.pop()];
    const d = queue.lastKey;
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
        queue.push(next, idOf(to));
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

/**
 * RAIL TRAVEL (owner ruling 2026-10-12: every rail line on the globe, in the
 * outbreak sim): travellers by train between the places the world rail
 * network joins (outbreakNetwork.mjs, buildRailGraph). Scenario rates, not
 * a forecast:
 *  - How many: each country's rail passenger-km a year (World Bank WDI
 *    IS.RRS.PASG.KM, "Railways, passengers carried (million passenger-km)",
 *    latest year, CC BY 4.0). A country with no figure takes its
 *    continent's median passenger-km per km of line, times its own km of
 *    line, and is marked estimated.
 *  - Between which places: Zipf's P1P2/D (Zipf 1946, "The P1P2/D hypothesis:
 *    on the intercity movement of persons", American Sociological Review
 *    11:677-686, fitted on rail passengers): T_ij ∝ P_i P_j / D_ij, with D
 *    the distance along the rail, not the straight line, damped across
 *    borders by the commuting model's own factor (COMMUTING.crossBorder).
 *  - Scaled per country of origin so its trips' passenger-km a day,
 *    Σ T_ij D_ij, equal its passenger-km a year over 365.
 *  - Trains run 06:00 to 22:00 local time, each route in one hourly slot,
 *    at the panel's train speed.
 */
export const RAIL_TRAVEL = Object.freeze({
  volumeSource:
    'World Bank WDI IS.RRS.PASG.KM, railways, passengers carried (million passenger-km), latest year (CC BY 4.0)',
  shapeSource:
    'Zipf 1946, The P1P2/D hypothesis (American Sociological Review 11:677-686)',
  networkSource:
    'OpenStreetMap rail lines (ODbL), as OpenMapTiles vector tiles from OpenFreeMap',
  zipfExponent: 1,
  crossBorder: COMMUTING.crossBorder,
  /**
   * The finest cells, in degrees: every pair of places is counted once, at
   * the coarsest cells that still keep the two apart (well-separated cells,
   * as in Greengard & Rokhlin 1987), so every rail place sends and receives
   * its whole share with a route list the size of the cells, not of every
   * pair of places. Each cell's trips leave from and arrive at its biggest
   * rail place; the commuting links carry them on locally.
   */
  cellDeg: 1,
  /** Cells grow by doubling up to this size; past it every pair is direct. */
  topCellDeg: 64,
  /** A pair closer than this along the rail counts as this far (D > 0). */
  minKm: 1,
  firstHour: 6,
  hours: 16,
  speedKmh: 60,
});

/**
 * Each country's rail passenger-km a year (million), from the World Bank's
 * table where it has a figure, else estimated from its continent's median
 * passenger-km per km of line times its own km of line.
 *
 * @param {Object<string, number>} reported Million passenger-km by ISO2.
 * @param {Object<string, number>} routeKm Km of rail line by ISO2.
 * @param {(iso2: string) => string} continentOf
 * @returns {{pkm: Object<string, number>, estimated: string[]}}
 */
export function railCountryVolumes(reported = {}, routeKm = {}, continentOf) {
  const pkm = {};
  const perKm = new Map();
  for (const [code, value] of Object.entries(reported)) {
    if (!(value > 0)) continue;
    pkm[code] = value;
    const km = routeKm[code];
    const continent = continentOf(code);
    if (km > 0 && continent) {
      if (!perKm.has(continent)) perKm.set(continent, []);
      perKm.get(continent).push(value / km);
    }
  }
  const median = new Map();
  for (const [continent, list] of perKm) {
    list.sort((a, b) => a - b);
    const mid = list.length >> 1;
    median.set(
      continent,
      list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2,
    );
  }
  const estimated = [];
  for (const [code, km] of Object.entries(routeKm)) {
    if (!code || pkm[code] > 0 || !(km > 0)) continue;
    const rate = median.get(continentOf(code));
    if (!(rate > 0)) continue;
    pkm[code] = rate * km;
    estimated.push(code);
  }
  return { pkm, estimated: estimated.sort() };
}

/**
 * The daily rail routes between the places on the world rail network.
 *
 * @param {{lat: number, lon: number, population: number, country?: string,
 *   id: string}[]} nodes The model's places.
 * @param {{vertexOf: ArrayLike<number>, componentOf?: ArrayLike<number>,
 *   placeLinks: (seeds: Int32Array) => {offsets: Int32Array, targets:
 *   Int32Array, km: Float64Array}}} rail Each place's point on the network
 *   (-1 where none is within RAIL_REACH_KM), the separate network it is on,
 *   and the rail links between given points (railPlaceLinks).
 * @param {Object<string, number>} countryPkm Million passenger-km a year,
 *   by ISO2 (railCountryVolumes).
 * @returns {{routes: object[], stats: object}} Routes in the daily routes'
 *   shape ({from, to, timeOfDayMs, lengthMs, passengers}) with mode 'rail';
 *   passengers a day may be fractions.
 */
export function railRoutes(nodes, rail, countryPkm = {}, options = {}) {
  const c = { ...RAIL_TRAVEL, ...options };
  const speed = Math.max(1, Number(c.speedKmh) || RAIL_TRAVEL.speedKmh);
  const stats = {
    places: 0,
    cells: 0,
    pairs: 0,
    pairMass: 0,
    routes: 0,
    passengersPerDay: 0,
    passengerKmPerDay: 0,
  };
  const empty = { routes: [], stats };
  if (!rail?.vertexOf || typeof rail.placeLinks !== 'function') return empty;
  const cell = c.cellDeg;
  const cols0 = Math.round(360 / cell);
  // The finest cells: places by cell, country and separate network.
  const units = [];
  const unitAt = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    const v = rail.vertexOf[i];
    if (!(v >= 0)) continue;
    const node = nodes[i];
    const pop = Math.max(0, Number(node.population) || 0);
    if (!(pop > 0)) continue;
    stats.places += 1;
    const cy = Math.floor((node.lat + 90) / cell);
    const cx = ((Math.floor((node.lon + 180) / cell) % cols0) + cols0) % cols0;
    const country = node.country || '';
    const comp = rail.componentOf ? rail.componentOf[i] : 0;
    const key = `${cy}:${cx}:${country}:${comp}`;
    let u = unitAt.get(key);
    if (u === undefined) {
      u = units.length;
      unitAt.set(key, u);
      units.push({ cy, cx, country, comp, mass: 0, rep: i, repPop: -1 });
    }
    const unit = units[u];
    unit.mass += pop;
    if (pop > unit.repPop) {
      unit.rep = i;
      unit.repPop = pop;
    }
  }
  stats.cells = units.length;
  if (units.length < 2) return empty;
  const seeds = new Int32Array(units.length);
  units.forEach((unit, u) => {
    seeds[u] = rail.vertexOf[unit.rep];
  });
  const G = rail.placeLinks(seeds);
  // Distances along the rail between the cells' places, from one source
  // until every target is settled.
  const dist = new Float64Array(units.length).fill(Infinity);
  const touched = [];
  const distancesFrom = (source, targets) => {
    for (const u of touched) dist[u] = Infinity;
    touched.length = 0;
    const want = new Set(targets);
    const out = new Map();
    const queue = numberHeap();
    dist[source] = 0;
    touched.push(source);
    queue.push(0, source);
    while (queue.size && want.size) {
      const v = queue.pop();
      const d = queue.lastKey;
      if (d > dist[v]) continue;
      if (want.delete(v)) out.set(v, d);
      for (let k = G.offsets[v]; k < G.offsets[v + 1]; k += 1) {
        const u = G.targets[k];
        const next = d + G.km[k];
        if (next < dist[u]) {
          if (dist[u] === Infinity) touched.push(u);
          dist[u] = next;
          queue.push(next, u);
        }
      }
    }
    return out;
  };
  // Levels of cells, each twice the last: units by (cell, country, network).
  const levels = [];
  const top = Math.max(0, Math.ceil(Math.log2(c.topCellDeg / cell)));
  for (let L = 0; L <= top; L += 1) {
    const s = 2 ** L;
    const cols = Math.ceil(cols0 / s);
    const list = [];
    const byKey = new Map();
    const byCell = new Map();
    units.forEach((unit, u) => {
      const cy = unit.cy >> L;
      const cx = Math.floor(unit.cx / s);
      const key = `${cy}:${cx}:${unit.country}:${unit.comp}`;
      let k = byKey.get(key);
      if (k === undefined) {
        k = list.length;
        byKey.set(key, k);
        list.push({
          cy,
          cx,
          country: unit.country,
          comp: unit.comp,
          mass: 0,
          rep: u,
        });
        const at = cy * 100_000 + cx;
        if (!byCell.has(at)) byCell.set(at, []);
        byCell.get(at).push(k);
      }
      const coarse = list[k];
      coarse.mass += unit.mass;
      if (unit.repPop > units[coarse.rep].repPop) coarse.rep = u;
    });
    levels.push({ L, cols, list, byCell });
  }
  const wrap = (d, cols) => {
    const a = Math.abs(d) % cols;
    return Math.min(a, cols - a);
  };
  const cheb = (A, B, cols) =>
    Math.max(Math.abs(A.cy - B.cy), wrap(A.cx - B.cx, cols));
  // Every pair once: [from unit, to unit, mass weight, km].
  const pairFrom = [];
  const pairTo = [];
  const pairW = [];
  const pairKm = [];
  const sumBy = new Map();
  for (const level of levels) {
    const { L, cols, list, byCell } = level;
    const last = L === top;
    const parentCols = Math.ceil(cols / 2);
    for (const A of list) {
      const partners = [];
      const seen = new Set();
      const consider = (cy, cx) => {
        const at = cy * 100_000 + cx;
        if (seen.has(at)) return;
        seen.add(at);
        for (const b of byCell.get(at) || []) {
          const B = list[b];
          if (B === A || B.comp !== A.comp) continue;
          const d = cheb(A, B, cols);
          if (L === 0 && d <= 1) partners.push(B);
          else if (d >= 2) partners.push(B);
        }
      };
      if (L === 0)
        for (let dy = -1; dy <= 1; dy += 1)
          for (let dx = -1; dx <= 1; dx += 1)
            consider(A.cy + dy, (((A.cx + dx) % cols) + cols) % cols);
      if (last) {
        for (const at of byCell.keys())
          consider(Math.floor(at / 100_000), at % 100_000);
      } else {
        const py = A.cy >> 1;
        const px = A.cx >> 1;
        for (let dy = -1; dy <= 1; dy += 1)
          for (let dx = -1; dx <= 1; dx += 1) {
            const qy = py + dy;
            const qx = (((px + dx) % parentCols) + parentCols) % parentCols;
            for (let ky = 0; ky <= 1; ky += 1)
              for (let kx = 0; kx <= 1; kx += 1) {
                const cx = 2 * qx + kx;
                if (cx < cols) consider(2 * qy + ky, cx);
              }
          }
      }
      if (!partners.length) continue;
      const reached = distancesFrom(
        A.rep,
        partners.map((B) => B.rep),
      );
      for (const B of partners) {
        const km = reached.get(B.rep);
        if (!Number.isFinite(km)) continue;
        const border =
          A.country && B.country && A.country !== B.country ? c.crossBorder : 1;
        const w = A.mass * B.mass * border;
        if (!(w > 0)) continue;
        // Every pair of places once: the sum of their masses' products.
        stats.pairMass += A.mass * B.mass;
        pairFrom.push(A.rep);
        pairTo.push(B.rep);
        pairW.push(w);
        pairKm.push(km);
        const D = Math.max(km, c.minKm);
        // Σ T·D per origin country, for its scale.
        sumBy.set(
          A.country,
          (sumBy.get(A.country) || 0) + (w / D ** c.zipfExponent) * km,
        );
      }
    }
  }
  stats.pairs = pairFrom.length;
  // Each origin country's scale: its trips' passenger-km a day.
  const scale = new Map();
  for (const [country, sum] of sumBy) {
    const yearly = Number(countryPkm?.[country]);
    if (!(yearly > 0) || !(sum > 0)) continue;
    scale.set(country, (yearly * 1e6) / 365 / sum);
  }
  const routes = new Map();
  for (let k = 0; k < pairFrom.length; k += 1) {
    const A = units[pairFrom[k]];
    const k0 = scale.get(A.country);
    if (!(k0 > 0)) continue;
    const km = pairKm[k];
    const passengers =
      (k0 * pairW[k]) / Math.max(km, c.minKm) ** c.zipfExponent;
    if (!(passengers > 0)) continue;
    const from = A.rep;
    const to = units[pairTo[k]].rep;
    if (from === to) continue;
    stats.passengersPerDay += passengers;
    stats.passengerKmPerDay += passengers * km;
    const key = `${from}>${to}`;
    const was = routes.get(key);
    if (was) {
      was.passengers += passengers;
      continue;
    }
    const slot = stableIndex(`${nodes[from].id}>${nodes[to].id}|rail`, c.hours);
    routes.set(key, {
      from,
      to,
      timeOfDayMs: (c.firstHour + slot) * HOUR_MS,
      lengthMs: Math.max(1, Math.round((km / speed) * HOUR_MS)),
      passengers,
      km,
      mode: 'rail',
    });
  }
  stats.routes = routes.size;
  stats.passengersPerDay = Math.round(stats.passengersPerDay);
  stats.passengerKmPerDay = Math.round(stats.passengerKmPerDay);
  return { routes: [...routes.values()], stats };
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
 *    OUTBREAK_AIRPORT_KM, or a place of its own sized by its density band;
 *  - with `railNear` (owner ruling 2026-10-12: every rail line on the globe,
 *    in the outbreak sim), also every city on the rail, however far from
 *    an airport: `railNear(lat, lon)` is true where the world rail network
 *    passes within RAIL_REACH_KM. It only adds places.
 *
 * @returns {{nodes: object[], origins: number[], fallback: boolean}}
 */
export function buildEpidemicNodes({
  airports = [],
  cities = [],
  locations = [],
  profile = {},
  railNear = null,
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
    // A town on the rail is reached by train, however far the airports.
    return (
      typeof railNear === 'function' && Boolean(railNear(city.lat, city.lon))
    );
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
/**
 * With a deadline set, the hour loop reads the clock every this many
 * simulated hours and stops the run there once the deadline has passed.
 */
export const ABORT_CHECK_HOURS = 6;
/**
 * Each run draws from its own substream: seed + run × RUN_STRIDE (the
 * golden-ratio stride, so neighbouring runs start far apart). Run 0 is the
 * seed itself, and run r is the same whatever the run count or time limit.
 */
export const RUN_STRIDE = 0x9e3779b9;
/** Places carrying a by-day table, besides the origins. */
export const BY_DAY_PLACES = 100;
/** Target relative half-width of the median's interval for runsSuggested. */
export const MC_TARGET_REL = 0.1;
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
 * @param {boolean} [input.trace] Tests only: also return each run's end
 *   totals and end state (every compartment and counter summed over the
 *   places) and run 0's hourly conservation residual.
 * @param {number} [input.deadlineMs] An absolute time on the `now` clock:
 *   past it, the run in progress stops at its next check (every
 *   ABORT_CHECK_HOURS simulated hours). Run 0 is kept, cut short; a later
 *   run is dropped, so the result is that of the runs done. Unset (the
 *   default), the clock is never read inside a run.
 */
function simulateEnsemble(
  {
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
    trace = false,
    deadlineMs = Infinity,
  },
  { pairs = false, light = false } = {},
) {
  const n = nodes.length;
  const hours = Math.max(1, Math.ceil((untilMs - startMs) / HOUR_MS));
  const runCount = Math.max(
    1,
    Math.min(EPIDEMIC_RUNS_MAX, Math.round(Number(runs) || 1)),
  );
  // The current run's generator (RUN_STRIDE): every draw closes over it.
  let rng = mulberry32(seed);
  const iv = params.interventions;
  const isOrigin = new Uint8Array(n);
  for (const i of origins) isOrigin[i] = 1;
  const valid = (i) => i >= 0 && i < n;

  // Fixed per place: population, contact, out-commuting, hospital beds.
  const N = new Float64Array(n);
  const contactAt = new Float64Array(n);
  const outShare = new Float64Array(n);
  const beds = new Float64Array(n);
  const icuBeds = new Float64Array(n);
  // Who commutes into each place, and what share of them: [place, share].
  const inbound = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i += 1) {
    N[i] = Math.max(1, Math.round(nodes[i].population || 1));
    contactAt[i] =
      params.contact * (isOrigin[i] ? params.originContact : params.newContact);
    beds[i] = (N[i] * (params.bedsPer1000 ?? 0.75)) / 1000;
    // Intensive-care beds free for this outbreak: 30 % of them, as for beds.
    icuBeds[i] = (N[i] * (params.icuPer1000 ?? 0.1) * 0.3) / 1000;
    for (const link of links[i] || []) {
      outShare[i] += link.share;
      inbound[link.j].push(i, link.share);
    }
  }
  // Local time: whole hours from UTC per place (the node's own offset, else
  // its longitude), and the UTC hour the window starts at, so the local hour
  // at place i in hour h is (startHourUtc + h + offset[i]) mod 24.
  const offset = new Int32Array(n);
  for (let i = 0; i < n; i += 1)
    offset[i] = Number.isFinite(nodes[i].utcOffsetHours)
      ? Math.min(14, Math.max(-12, Math.round(nodes[i].utcOffsetHours)))
      : localOffsetHours(nodes[i].lon);
  const startHourUtc = Math.floor(
    (((startMs % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS,
  );
  const localClock = params.clock === 'local';
  // Countries: an index per ISO code (a blank country, as on the synthetic
  // origin node, is −1 and domestic to everything), which hold an origin,
  // and the reports and border flags per country (reset per run).
  const countryOf = new Int32Array(n);
  const countryIndex = new Map();
  for (let i = 0; i < n; i += 1) {
    const code = nodes[i].country || '';
    if (!code) {
      countryOf[i] = -1;
      continue;
    }
    if (!countryIndex.has(code)) countryIndex.set(code, countryIndex.size);
    countryOf[i] = countryIndex.get(code);
  }
  const countryCount = countryIndex.size;
  const originCountry = new Uint8Array(countryCount);
  for (const i of origins)
    if (countryOf[i] >= 0) originCountry[countryOf[i]] = 1;
  let originCountries = 0;
  for (let c = 0; c < countryCount; c += 1) originCountries += originCountry[c];
  const countryReported = new Float64Array(countryCount);
  const countryFlagged = new Uint8Array(countryCount);
  const international = (from, to) =>
    countryOf[from] >= 0 &&
    countryOf[to] >= 0 &&
    countryOf[from] !== countryOf[to];
  // Which legs the ban, screening and quarantine reach under the border
  // policy: every leg; international legs out of an outbreak country; out
  // of a flagged country; or every international leg.
  const borderPolicy = iv.borderPolicy ?? 'none';
  const scopeOK =
    borderPolicy === 'origin'
      ? (from, to) =>
          international(from, to) && originCountry[countryOf[from]] === 1
      : borderPolicy === 'reported'
        ? (from, to) =>
            international(from, to) && countryFlagged[countryOf[from]] === 1
        : borderPolicy === 'all'
          ? international
          : () => true;
  const travelDomestic = params.travelDomestic ?? 1;
  const travelIntl = params.travelIntl ?? 1;
  // Hub transfers: large airports where a share of those landing fly on.
  const transferShare = params.transferShare ?? 0;
  const transferring = transferShare > 0;
  const layoverHours = Math.max(0, Math.round(params.layoverHours ?? 0));
  const isHub = new Uint8Array(n);
  for (let i = 0; i < n; i += 1)
    if (nodes[i].kind === 'airport' && nodes[i].size === 'L') isHub[i] = 1;
  // Two-way daytime mixing: the daytime population of each place, its own
  // people who stay plus the commuters in (daytimePopulations).
  const daytime = params.mixing === 'daytime';
  const Ntilde = daytime ? daytimePopulations(nodes, links) : null;
  // Diurnal commuting: the day's share in daytime hours (0.5: flat, as
  // before), as a factor by the destination's local hour, recomputed each
  // hour for the 27 possible offsets; the 6-hour step takes the mean over
  // its six hours so the day still sums to 24.
  const split = params.commuteDaySplit ?? 0.5;
  const diurnal = split !== 0.5;
  const dfacNow = new Float64Array(27);
  const dfacStep = new Float64Array(27);
  const localHourAt = (h, off) => (((startHourUtc + h + off) % 24) + 24) % 24;
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
  // Under the local clock a pattern route's hour of day is local to its
  // origin, so it flies in the UTC bucket that many hours earlier; a route
  // the scan found (fromScan) keeps its UTC hour and its flown keys.
  const byHourOfDay = Array.from({ length: 24 }, () => []);
  for (const r of routes) {
    if (!valid(r.from) || !valid(r.to) || !(r.lengthMs > 0)) continue;
    const tod = ((Number(r.timeOfDayMs) % DAY_MS) + DAY_MS) % DAY_MS;
    let bucket = Math.floor(tod / HOUR_MS);
    if (localClock && !r.fromScan)
      bucket = (((bucket - offset[r.from]) % 24) + 24) % 24;
    byHourOfDay[bucket].push({ ...r, tod });
  }
  // A daily route is not flown again where the scan found that flight.
  const flownKeys = new Set(flown);
  // Where a hub's transfer passengers can fly on: its daily routes, and its
  // dated flights by day.
  const hubRoutes = transferring ? Array.from({ length: n }, () => []) : null;
  const hubFlights = transferring ? new Map() : null;
  if (transferring) {
    // A transfer is a layover between flights: never onto a train.
    for (const r of routes)
      if (
        r.mode !== 'rail' &&
        valid(r.from) &&
        valid(r.to) &&
        r.lengthMs > 0 &&
        isHub[r.from]
      )
        hubRoutes[r.from].push({
          to: r.to,
          passengers: r.passengers,
          lengthMs: r.lengthMs,
        });
    for (const f of flights) {
      const h = Math.floor((f.departMs - startMs) / HOUR_MS);
      if (h < 0 || h >= hours || !valid(f.from) || !valid(f.to)) continue;
      if (!isHub[f.from]) continue;
      const key = f.from * days + Math.floor(h / 24);
      const list = hubFlights.get(key) || [];
      list.push({
        to: f.to,
        passengers: f.passengers,
        lengthMs: Math.max(0, f.arriveMs - f.departMs),
      });
      hubFlights.set(key, list);
    }
  }

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
  // The hospital pathway and immunity: ward and intensive-care occupancy,
  // the recovered (immune), the dead, the susceptible pool at the start,
  // those back from immunity by waning, the campaign-protected, the hour
  // immunity was last stepped, admissions, the occupancy peaks, the first
  // hour short of beds and the reinfections, per place.
  const H = new Float64Array(n);
  const U = new Float64Array(n);
  const R = new Float64Array(n);
  const D = new Float64Array(n);
  const S0 = new Float64Array(n);
  const Sw = new Float64Array(n);
  const V = new Float64Array(n);
  const lastWane = new Int32Array(n);
  const cumAdm = new Float64Array(n);
  const hPeak = new Float64Array(n);
  const uPeak = new Float64Array(n);
  const overflowAt = new Float64Array(n);
  const reinf = new Float64Array(n);
  // Restrictions, awareness and testing, per place: the restriction switch
  // and the hour it came on, the 7-day window of reported incidence, the
  // first hour it triggered this run, the compliance factor cached at the
  // daily tick, the first death hour, the tests used today and the day they
  // count for, and whether the tests ran out.
  const npiOn = new Uint8Array(n);
  const npiSince = new Float64Array(n);
  const recentRep = new Float64Array(n);
  // Places that still need the daily tick after they leave the affected
  // list: a restriction still on, or reported incidence still decaying.
  const watched = new Set();
  const restrictAt = new Float64Array(n);
  const cDay = new Float64Array(n);
  const firstDeath = new Float64Array(n);
  const testsUsed = new Float64Array(n);
  const testsDay = new Int32Array(n);
  const saturated = new Uint8Array(n);
  // Imported against local, per place: infections caught here (fresh and
  // spillover; seeds apart), infected travellers landed here, the first hour
  // of local spread, the hour the count reached ten, and what brought it
  // first (0 none, 1 seed, 2 air, 3 ground).
  const local = new Float64Array(n);
  const imported = new Float64Array(n);
  const firstLocal = new Float64Array(n);
  const firstTen = new Float64Array(n);
  const firstBy = new Uint8Array(n);
  // Daytime mixing: each place's own infectious pressure this hour, the
  // visitors' pressure pushed to it, and whether an uninfected place holds
  // pushed pressure waiting for the next commute hour.
  const pressure = new Float64Array(n);
  const visitorPressure = new Float64Array(n);
  const visitorPending = new Uint8Array(n);
  const pendingVisitors = [];
  // Per place over the runs that reached it; per run over all places.
  const importedAt = Array.from({ length: n }, () => []);
  const localAts = Array.from({ length: n }, () => []);
  const tenAts = Array.from({ length: n }, () => []);
  const airFirst = new Int32Array(n);
  const groundFirst = new Int32Array(n);
  const firstAbroadReports = [];
  const transfersFlownRuns = [];
  const deathsAt = Array.from({ length: n }, () => []);
  const hPeaks = Array.from({ length: n }, () => []);
  const uPeaks = Array.from({ length: n }, () => []);
  const overflows = Array.from({ length: n }, () => []);
  const vaccAt = Array.from({ length: n }, () => []);
  const reinfAt = Array.from({ length: n }, () => []);
  const restrictAts = Array.from({ length: n }, () => []);
  const restrictedRuns = new Int32Array(n);
  const saturatedRuns = new Int32Array(n);
  const immuneEnds = [];
  const rEndFactors = [];
  const firstOverflows = [];
  // The cost ledger, per run.
  const restrictedPersonDaysRuns = [];
  const passengersBlockedRuns = [];
  const travellersCaughtRuns = [];
  const bedDaysShortRuns = [];
  // By day, per place it ever reached (allocated the first time a place is
  // reached in any run): the runs with a case there, the runs with ten, and
  // the cases summed over the runs. One entry per daily push.
  const dayPushes = Math.ceil(hours / 24);
  const byDayAcc = new Map();
  const byDayOf = (i) => {
    let acc = byDayAcc.get(i);
    if (!acc) {
      acc = {
        anyRuns: new Int32Array(dayPushes),
        tenRuns: new Int32Array(dayPushes),
        caseSum: new Float64Array(dayPushes),
      };
      byDayAcc.set(i, acc);
    }
    return acc;
  };
  // Runs that died out: nobody left infected at the last hour and hardly
  // anyone infected beyond the seeds. And run 0's wall time, for the budget.
  let extinctRuns = 0;
  let runTimeMs = 0;
  const started = now();
  // The longest run so far, so that no run starts that would end past the
  // budget (the worker's hard stop is only 15 s later).
  let maxRunMs = 0;
  let runStart = started;
  const reportDelayH = Math.max(1, Math.round((params.reportDays ?? 4) * 24));
  const awareness = params.awareness ?? 0;
  // The hospital pathway (hospitalDays set; blank is the legacy death path
  // with no occupancy): admission the hour after the Is exit at the
  // earliest, ward and ICU stays, and the death risk given admission,
  // equal at ward and ICU discharge, so that deaths per symptomatic case
  // stay fatalityShare when no one is short of a bed.
  const hospitalDays = Number.isFinite(params.hospitalDays)
    ? params.hospitalDays
    : null;
  const hospitalPath = hospitalDays !== null;
  const icuShare = params.icuShare ?? 0;
  const admitDelayH = Math.max(
    1,
    Math.round(24 * (params.admitDelayDays ?? 0)),
  );
  const exitWardP = hospitalPath ? 1 - Math.exp(-DT / hospitalDays) : 0;
  const exitIcuP = 1 - Math.exp(-DT / ICU_DAYS);
  const deathGivenAdmission =
    params.hospitalShare > 0
      ? Math.min(1, params.fatalityShare / params.hospitalShare)
      : 0;
  // Immunity lost at rate 1 / waningDays a day (0: lifelong).
  const waningDays = params.waningDays ?? 0;
  const waning = waningDays > 0;
  const omega = waning ? 1 / waningDays : 0;
  const waneP = 1 - Math.exp(-omega * DT);
  // Susceptibility variation: the pool left is less susceptible by
  // (S / S0)^cv² (Gomes et al. 2022).
  const cv = params.heterogeneityCv ?? 0;
  const cv2 = cv * cv;
  // The vaccination campaign: doses a day per 1,000, its coverage cap, the
  // protection lag and who goes first.
  const vac = params.vaccine ?? null;
  const vacEff = params.vaccineEfficacy ?? 0;
  const vacProtect = params.vaccineProtectDays ?? VACCINE_PROTECT_DAYS;
  // Restrictions: the window [startHour, endHour) (interventionDays 0: no
  // end), and the trigger: everywhere inside the window, or per place where
  // reported incidence or the hospital load reaches its threshold, released
  // below half of it after minLockDays. Compliance fades towards
  // COMPLIANCE_FLOOR with half-life fatigueHalfDays (0: constant).
  const endHour =
    iv.interventionDays > 0
      ? iv.startHour + 24 * iv.interventionDays
      : Infinity;
  const triggerMode = iv.triggerMode ?? 'everywhere';
  const perPlace = triggerMode !== 'everywhere';
  const threshold =
    triggerMode === 'reported'
      ? (iv.triggerPer100k ?? 0)
      : triggerMode === 'hospital'
        ? (iv.triggerBedShare ?? 0.8)
        : 0;
  const minLockH = 24 * (iv.minLockDays ?? 14);
  const fatigueHalfDays = iv.fatigueHalfDays ?? 0;
  const compliance = (t) =>
    fatigueHalfDays > 0
      ? COMPLIANCE_FLOOR +
        (1 - COMPLIANCE_FLOOR) * 2 ** (-Math.max(0, t) / fatigueHalfDays)
      : 1;
  const incidenceDecay = Math.exp(-1 / INCIDENCE_WINDOW_DAYS);
  // Under 'everywhere', people count as restricted only when something
  // restricts them.
  const restrictsAnyone = iv.lockdown > 0 || iv.travelBan > 0;
  // Awareness: what people react to, how far they look, how fast they tire.
  // The default (reported cases, own place, no fatigue) keeps today's
  // expression to the bit.
  const responseSignal = params.responseSignal ?? 'reported';
  const responseReach = params.responseReach ?? 'local';
  const fatigueDays = params.fatigueDays ?? 0;
  const plainAwareness =
    responseSignal === 'reported' &&
    responseReach === 'local' &&
    !(fatigueDays > 0);
  // Tests a day per place (0: unlimited); reports past it are lost.
  const testsPer1000Day = params.testsPer1000Day ?? 0;
  const capacity = testsPer1000Day > 0 ? new Float64Array(n) : null;
  if (capacity)
    for (let i = 0; i < n; i += 1)
      capacity[i] = Math.max(1, Math.round((N[i] * testsPer1000Day) / 1000));
  // Variants: steady drift, or a fitter strain taking over.
  const takeover = params.variants === 'takeover';
  const takeoverAdv = params.takeoverAdvantage ?? 0;
  // A second strain (variants 'two-strain'; drift and takeover are off): its
  // own infected stages and their weights, the immune of strain-1 type (a
  // subset of R: recovered from strain 1, pre-immune, vaccinated), its
  // infections and admissions per place, its hazard and pull, its daytime
  // pressure, the hour a place was last touched as uninfected, and the runs
  // it reached each place in. Nothing is allocated without it.
  const strain2 = params.strain2 ?? null;
  const twoStrain = strain2 !== null;
  const rel2 = twoStrain ? strain2.rel : 1;
  const cross2 = twoStrain ? strain2.cross : 1;
  const hs2 = twoStrain
    ? Math.min(1, params.hospitalShare * strain2.severity)
    : 0;
  const strain2Array = () => (twoStrain ? new Float64Array(n) : null);
  const E2 = strain2Array();
  const P2 = strain2Array();
  const Is2 = strain2Array();
  const Ia2 = strain2Array();
  const Wp2 = strain2Array();
  const Ws2 = strain2Array();
  const Wa2 = strain2Array();
  const Rx = strain2Array();
  const cum2 = strain2Array();
  const cumAdm2 = strain2Array();
  const lambda2 = strain2Array();
  const force2 = strain2Array();
  const pressure2 = twoStrain && daytime ? new Float64Array(n) : null;
  const visitorPressure2 = twoStrain && daytime ? new Float64Array(n) : null;
  const farMark = twoStrain ? new Int32Array(n) : null;
  const strain2Runs = twoStrain ? new Int32Array(n) : null;
  // When (a whole hour) and where it is seeded: the node with that code
  // (else id), or the outbreak places.
  const strain2Hour = twoStrain ? 24 * strain2.day : Infinity;
  const strain2Node =
    twoStrain && strain2.place
      ? nodes.findIndex(
          (node) =>
            String(node.code || node.id || '').toUpperCase() === strain2.place,
        )
      : -1;
  const strain2Places = strain2Node >= 0 ? [strain2Node] : origins;
  let strain2Total = 0;
  let strain2SeededAt = Infinity;
  // Whether it has been seeded this run: until then every strain-2 step is
  // skipped (it has no one), and all the immune are of strain-1 type, so Rx
  // is set from R at the seeding and kept in step only from then on.
  let live2 = false;
  // The deadline (unset: the clock is never read inside a run), the run it
  // cut, and, only with a deadline, the run's by-day log: (place, cases) at
  // each daily push, committed at the end of the run, so a dropped run
  // leaves nothing behind.
  const deadline = Number.isFinite(deadlineMs) ? deadlineMs : Infinity;
  const deadlineSet = deadline !== Infinity;
  let stoppedAt = null;
  let logPlace = deadlineSet ? new Int32Array(65_536) : null;
  let logCum = deadlineSet ? new Float64Array(65_536) : null;
  let logLength = 0;
  const logPushes = []; // [day, first entry] per daily push this run
  const logEntry = (i, c) => {
    if (logLength === logPlace.length) {
      const place = new Int32Array(2 * logPlace.length);
      place.set(logPlace);
      logPlace = place;
      const cumAt = new Float64Array(2 * logCum.length);
      cumAt.set(logCum);
      logCum = cumAt;
    }
    logPlace[logLength] = i;
    logCum[logLength] = c;
    logLength += 1;
  };
  let done = 0;
  let partial = false;
  // Tests only (trace): each run's end totals and end state, and run 0's
  // hourly residual of the conservation identity Σ(S + E + P + Is + Ia + H +
  // U + R) + deaths + in transit + pending admission + isolated − Σ N.
  const runTotals = [];
  const runEnd = [];
  const conservation = [];
  let populationTotal = 0;
  for (let i = 0; i < n; i += 1) populationTotal += N[i];
  // Run-level counters, reset per run, that the hooks below close over.
  let hourNow = 0;
  let pendingAdmit = 0;
  let inTransit = 0;
  let isolated = 0;
  let admitted = 0;
  let icuAdmitted = 0;
  let vaccinated = 0;
  let reinfTotal = 0;
  let bedDaysShort = 0;
  let firstOverflow = Infinity;
  let restrictedPersonDays = 0;
  let passengersBlocked = 0;
  let travellersCaught = 0;
  // Imported and local infections, the seeds, transfer batches flown on,
  // the first report outside the outbreak countries, and the countries
  // flagged under the 'reported' border policy.
  let importedTotal = 0;
  let localTotal = 0;
  let seeds = 0;
  let transfersFlown = 0;
  let firstAbroadReport = Infinity;
  let flaggedCount = 0;
  // This hour: inside the intervention window; compliance under
  // 'everywhere' (cached at the daily tick); the global awareness signal.
  let inWindow = false;
  let cNow = 1;
  let globalSignal = 0;
  // The places this run has reached, in order.
  const reachedList = [];

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
  // Immunity lost since a place was last stepped, as its expected value
  // (no draw), so places nobody touches are never looped over; the active
  // places and the origins draw it hourly instead (wane).
  const waneCatchUp = (i) => {
    if (lastWane[i] >= hourNow) return;
    if (R[i] > 0) {
      const back = Math.round(
        R[i] * (1 - Math.exp(-omega * (hourNow - lastWane[i]) * DT)),
      );
      if (live2) Rx[i] -= Math.round((back * Rx[i]) / R[i]);
      R[i] -= back;
      S[i] += back;
      Sw[i] += back;
      if (live2 && Rx[i] > R[i]) Rx[i] = R[i];
    }
    lastWane[i] = hourNow;
  };
  const wane = (i) => {
    if (lastWane[i] >= hourNow) return;
    if (R[i] > 0) {
      const back = binomial(R[i], waneP, rng);
      if (live2) Rx[i] -= Math.round((back * Rx[i]) / R[i]);
      R[i] -= back;
      S[i] += back;
      Sw[i] += back;
      if (live2 && Rx[i] > R[i]) Rx[i] = R[i];
    }
    lastWane[i] = hourNow;
  };
  // The campaign: the protected target by this day, by place, and the move
  // S → R up to it (a target count, so the path there does not matter).
  const vaccineTarget = (i, day) => {
    const start =
      vac.startDay +
      (vac.priority === 'origin-first' && !isOrigin[i]
        ? ORIGIN_FIRST_DELAY_DAYS
        : 0);
    const coverage = Math.min(
      vac.coverageMax,
      (vac.perDay / 1000) * Math.max(0, day - vacProtect - start),
    );
    return Math.round(N[i] * vacEff * coverage);
  };
  const vaccinate = (i, day) => {
    const move = Math.max(0, Math.min(S[i], vaccineTarget(i, day) - V[i]));
    if (move <= 0) return;
    S[i] -= move;
    R[i] += move;
    if (live2) Rx[i] += move;
    V[i] += move;
    vaccinated += move;
    if (Sw[i] > S[i]) Sw[i] = S[i];
  };
  // A place touched for the first time in a while catches up on what the
  // hourly loop skipped there.
  const firstTouch = (i) => {
    if (waning) waneCatchUp(i);
    if (vac) vaccinate(i, Math.floor(hourNow / 24));
    if (perPlace && npiOn[i] && fatigueHalfDays > 0)
      cDay[i] = compliance((hourNow - npiSince[i]) / 24);
  };
  const activate = (i) => {
    if (isActive[i]) return;
    isActive[i] = 1;
    active.push(i);
    // Pushed visitor pressure waiting here is stale now: the place is
    // stepped hourly from this hour on.
    visitorPressure[i] = 0;
    if (visitorPressure2) visitorPressure2[i] = 0;
    visitorPending[i] = 0;
    firstTouch(i);
  };
  // The first hour it reached a place this run, and what brought it: a
  // seed (1), a landing (2) or infection on the ground (3).
  const reach = (i, by) => {
    if (arrived[i] !== Infinity) return;
    arrived[i] = hourNow;
    firstBy[i] = by;
    reachedList.push(i);
  };
  // The count here just rose: the hour it first reached ten.
  const countTen = (i) => {
    if (firstTen[i] === Infinity && cum[i] >= 10) firstTen[i] = hourNow;
  };
  // Contacts left under the lockdown here: everywhere inside the window, or
  // where the place's own restriction is on, both fading with compliance.
  let lockdownAll = 1;
  const lockdownOf = (i) =>
    perPlace
      ? lockdownMix(params, npiOn[i] ? iv.lockdown * cDay[i] : 0)
      : lockdownAll;
  // People pull back as the signal (reports, deaths or both per 100,000,
  // here, everywhere or a mix) rises, less so as they tire of it.
  const cautionOf = (i) => {
    if (!(awareness > 0)) return 1;
    if (plainAwareness) return 1 / (1 + (awareness * reported[i] * 1e5) / N[i]);
    let x =
      responseSignal === 'reported'
        ? reported[i]
        : responseSignal === 'deaths'
          ? D[i]
          : reported[i] + D[i];
    x = (x * 1e5) / N[i];
    if (responseReach === 'global') x = globalSignal;
    else if (responseReach === 'mixed') x = (x + globalSignal) / 2;
    let first =
      responseSignal === 'reported'
        ? firstReport[i]
        : responseSignal === 'deaths'
          ? firstDeath[i]
          : Math.min(firstReport[i], firstDeath[i]);
    if (first === Infinity) first = 0;
    return awarenessCaution(awareness, x, (hourNow - first) / 24, fatigueDays);
  };
  // What the per-place trigger reads: reported cases per 100,000 over the
  // last week, or the share of the free beds in use.
  const triggerLevel = (i) => {
    if (triggerMode === 'reported') return (recentRep[i] * 1e5) / N[i];
    const load = hospitalPath
      ? H[i]
      : live2
        ? Is[i] * params.hospitalShare + Is2[i] * hs2
        : Is[i] * params.hospitalShare;
    return beds[i] > 0 ? load / beds[i] : load > 0 ? Infinity : 0;
  };
  // The daily tick of a place's restriction: the incidence window decays,
  // the restriction comes on past the threshold inside the window and goes
  // off below half of it (or once the window ends) after minLockDays; the
  // day's compliance is cached.
  const tickRestrictions = (i) => {
    recentRep[i] *= incidenceDecay;
    const level = triggerLevel(i);
    if (!npiOn[i]) {
      if (inWindow && threshold > 0 && level >= threshold) {
        npiOn[i] = 1;
        npiSince[i] = hourNow;
        watched.add(i);
        if (restrictAt[i] === Infinity) {
          restrictAt[i] = hourNow;
          restrictedRuns[i] += 1;
        }
      }
    } else if (
      (level < TRIGGER_RELEASE_RATIO * threshold || !inWindow) &&
      hourNow - npiSince[i] >= minLockH
    )
      npiOn[i] = 0;
    if (npiOn[i]) cDay[i] = compliance((hourNow - npiSince[i]) / 24);
  };
  // Entry screening and quarantine on arrival, inside the window and the
  // border scope, on a batch's counts (whole people, so only the order of
  // the draws matters): symptomatic then presymptomatic at screening; E, P,
  // Is, Ia in quarantine. Those caught are isolated.
  const quarantineCatch =
    iv.quarantineDays > 0
      ? Math.min(
          0.95,
          1 - Math.exp((-1.2 * iv.quarantineDays) / params.incubationDays),
        )
      : 0;
  const inspectArrival = (b, scope) => {
    if (!inWindow || !scope) return 0;
    let caught = 0;
    if (iv.entryScreening) {
      const caughtS = binomial(b.s, SCREENING_CATCH.symptomatic, rng);
      const caughtP = binomial(b.p, SCREENING_CATCH.presym, rng);
      b.s -= caughtS;
      b.p -= caughtP;
      caught += caughtS + caughtP;
    }
    if (iv.quarantineDays > 0) {
      const caughtE = binomial(b.e, quarantineCatch, rng);
      const caughtP = binomial(b.p, quarantineCatch, rng);
      const caughtS = binomial(b.s, quarantineCatch, rng);
      const caughtA = binomial(b.a, quarantineCatch, rng);
      b.e -= caughtE;
      b.p -= caughtP;
      b.s -= caughtS;
      b.a -= caughtA;
      caught += caughtE + caughtP + caughtS + caughtA;
    }
    isolated += caught;
    travellersCaught += caught;
    return caught;
  };
  // Reports found by the day's tests: past the place's capacity they are
  // lost (the draw is made, then clipped, so the stream is unchanged).
  const testCap = (i, found, day) => {
    if (!capacity || found <= 0) return found;
    if (testsDay[i] !== day) {
      testsUsed[i] = 0;
      testsDay[i] = day;
    }
    const allowed = Math.max(0, capacity[i] - testsUsed[i]);
    let kept = found;
    if (kept > allowed) {
      saturated[i] = 1;
      kept = allowed;
    }
    testsUsed[i] += kept;
    return kept;
  };

  for (let run = 0; run < runCount; run += 1) {
    if (run > 0) {
      const t = now();
      maxRunMs = Math.max(maxRunMs, t - runStart);
      runStart = t;
      if (t - started + maxRunMs > budgetMs) {
        partial = true;
        break;
      }
    }
    rng = mulberry32((seed + Math.imul(run, RUN_STRIDE)) >>> 0);
    hourNow = 0;
    watched.clear();
    for (let i = 0; i < n; i += 1) {
      S[i] = Math.round(N[i] * params.susceptibleShare);
      // The pre-immune and the prior-vaccinated start recovered.
      R[i] = N[i] - S[i];
      S0[i] = S[i];
      E[i] = P[i] = Is[i] = Ia[i] = 0;
      Wp[i] = Ws[i] = Wa[i] = 0;
      H[i] = U[i] = D[i] = Sw[i] = V[i] = 0;
      cumAdm[i] = hPeak[i] = uPeak[i] = reinf[i] = 0;
      lastWane[i] = 0;
      cum[i] = 0;
      reported[i] = 0;
      firstReport[i] = Infinity;
      overwhelmed[i] = 0;
      arrived[i] = Infinity;
      overflowAt[i] = Infinity;
      npiOn[i] = 0;
      npiSince[i] = recentRep[i] = 0;
      restrictAt[i] = firstDeath[i] = Infinity;
      cDay[i] = 1;
      testsUsed[i] = 0;
      testsDay[i] = -1;
      saturated[i] = 0;
      local[i] = imported[i] = 0;
      firstLocal[i] = firstTen[i] = Infinity;
      firstBy[i] = 0;
      visitorPressure[i] = 0;
      visitorPending[i] = 0;
    }
    active.length = 0;
    isActive.fill(0);
    lambda.fill(0);
    if (twoStrain) {
      for (let i = 0; i < n; i += 1) {
        E2[i] = P2[i] = Is2[i] = Ia2[i] = 0;
        Wp2[i] = Ws2[i] = Wa2[i] = 0;
        Rx[i] = 0;
        cum2[i] = cumAdm2[i] = force2[i] = 0;
        farMark[i] = 0;
        if (visitorPressure2) visitorPressure2[i] = 0;
      }
      lambda2.fill(0);
      strain2Total = 0;
      strain2SeededAt = Infinity;
      live2 = false;
    }
    logLength = 0;
    logPushes.length = 0;
    reachedList.length = 0;
    pendingVisitors.length = 0;
    countryReported.fill(0);
    countryFlagged.fill(0);
    flaggedCount = 0;
    importedTotal = 0;
    localTotal = 0;
    seeds = 0;
    transfersFlown = 0;
    firstAbroadReport = Infinity;
    pendingAdmit = 0;
    inTransit = 0;
    isolated = 0;
    admitted = 0;
    icuAdmitted = 0;
    vaccinated = 0;
    reinfTotal = 0;
    bedDaysShort = 0;
    firstOverflow = Infinity;
    restrictedPersonDays = 0;
    passengersBlocked = 0;
    travellersCaught = 0;
    cNow = 1;
    globalSignal = 0;
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
      seeds += m;
      reach(i, 1);
      countTen(i);
      totalInfected += m;
      activate(i);
    }
    const landing = new Map(); // hour -> [{to, e, p, s, a, wp, ws, wa}]
    const reports = new Map(); // hour -> [[place, count]]
    const admissions = new Map(); // hour -> [[place, ward, icu]]
    let deaths = 0;
    const totals = [];
    // A transfer batch landing at a hub flies on: one draw picks the onward
    // route by passengers among the hub's daily routes and the day's dated
    // flights, never back where it came from; the onward leg's scope,
    // entry screening and quarantine apply; it lands after the layover and
    // the flight, as an ordinary batch. No way on: it stays (false).
    const onward = (t) => {
      const hb = t.to;
      const dated = hubFlights.get(hb * days + Math.floor(hourNow / 24)) || [];
      let total = 0;
      for (const r of hubRoutes[hb]) if (r.to !== t.from) total += r.passengers;
      for (const f of dated) if (f.to !== t.from) total += f.passengers;
      if (!(total > 0)) return false;
      let u = rng() * total;
      let pick = null;
      for (const r of hubRoutes[hb]) {
        if (r.to === t.from) continue;
        pick = r;
        u -= r.passengers;
        if (u < 0) break;
      }
      if (!pick || u >= 0)
        for (const f of dated) {
          if (f.to === t.from) continue;
          pick = f;
          u -= f.passengers;
          if (u < 0) break;
        }
      const b = { e: t.e, p: t.p, s: t.s, a: t.a };
      const scope = scopeOK(hb, pick.to);
      inTransit -= inspectArrival(b, scope);
      // The second strain aboard takes the same onward checks, after.
      const b2 =
        live2 && t.e2 !== undefined
          ? { e: t.e2, p: t.p2, s: t.s2, a: t.a2 }
          : null;
      if (b2) inTransit -= inspectArrival(b2, scope);
      transfersFlown += 1;
      if (b.e + b.p + b.s + b.a + (b2 ? b2.e + b2.p + b2.s + b2.a : 0) <= 0)
        return true;
      const at = hourNow + layoverHours + Math.ceil(pick.lengthMs / HOUR_MS);
      const list = landing.get(at) || [];
      const record = {
        to: pick.to,
        e: b.e,
        p: b.p,
        s: b.s,
        a: b.a,
        wp: t.p > 0 ? (t.wp * b.p) / t.p : 0,
        ws: t.s > 0 ? (t.ws * b.s) / t.s : 0,
        wa: t.a > 0 ? (t.wa * b.a) / t.a : 0,
      };
      if (b2) {
        record.e2 = b2.e;
        record.p2 = b2.p;
        record.s2 = b2.s;
        record.a2 = b2.a;
        record.wp2 = t.p2 > 0 ? (t.wp2 * b2.p) / t.p2 : 0;
        record.ws2 = t.s2 > 0 ? (t.ws2 * b2.s) / t.s2 : 0;
        record.wa2 = t.a2 > 0 ? (t.wa2 * b2.a) / t.a2 : 0;
      }
      list.push(record);
      landing.set(at, list);
      return true;
    };
    for (let h = 0; h < hours; h += 1) {
      hourNow = h;
      const day = Math.floor(h / 24);
      inWindow = h >= iv.startHour && h < endHour;
      // The commuting factor by the destination's local hour, for every
      // offset: this hour's, and the mean over the six hours of the step.
      const commuteHour = h % COMMUTE_STEP_H === 0;
      if (diurnal)
        for (let o = 0; o < 27; o += 1) {
          dfacNow[o] = diurnalFactor(localHourAt(h, o - 12), split);
          if (commuteHour) {
            let sum = 0;
            for (let k = 1; k <= COMMUTE_STEP_H; k += 1)
              sum += diurnalFactor(
                localHourAt(h - COMMUTE_STEP_H + k, o - 12),
                split,
              );
            dfacStep[o] = sum / COMMUTE_STEP_H;
          }
        }
      const iso = Math.min(
        0.95,
        params.isolation + (inWindow ? iv.tracingIsolate : 0),
      );
      const presymKeep = 1 - (inWindow ? iv.tracingPresym : 0);
      // Contacts left under a lockdown everywhere: all of them cut, or only
      // those outside the home (lockdownMix), fading with compliance.
      lockdownAll = perPlace
        ? 1
        : lockdownMix(params, inWindow ? iv.lockdown * cNow : 0);
      // Under 'two-strain' the second strain is the variant: no drift.
      const drift = takeover
        ? takeoverMultiplier(day, takeoverAdv)
        : twoStrain
          ? 1
          : 1 + params.mutationPerDay * (h / 24);
      const gatherOn = day < params.gathering.days;
      // 1. Landings, admissions and reports due this hour. Transfer batches
      //    fly on from the hub. Of those landing for good, some of the sick
      //    are found at the gate (importDetection), isolated and reported;
      //    the rest join the place as imported cases.
      for (const t of landing.get(h) || []) {
        if (t.transfer && onward(t)) continue;
        inTransit -= t.e + t.p + t.s + t.a;
        if (live2 && t.e2 !== undefined) inTransit -= t.e2 + t.p2 + t.s2 + t.a2;
        if (params.importDetect > 0 && t.s > 0) {
          const found = binomial(t.s, params.importDetect, rng);
          if (found > 0) {
            t.ws -= (t.ws * found) / t.s;
            t.s -= found;
            isolated += found;
            travellersCaught += found;
            const rep = testCap(t.to, found, day);
            if (rep > 0) {
              const at = h + reportDelayH;
              const list = reports.get(at) || [];
              list.push([t.to, rep]);
              reports.set(at, list);
            }
          }
        }
        // The second strain's sick are found at the gate the same way.
        if (
          live2 &&
          t.e2 !== undefined &&
          params.importDetect > 0 &&
          t.s2 > 0
        ) {
          const found = binomial(t.s2, params.importDetect, rng);
          if (found > 0) {
            t.ws2 -= (t.ws2 * found) / t.s2;
            t.s2 -= found;
            isolated += found;
            travellersCaught += found;
            const rep = testCap(t.to, found, day);
            if (rep > 0) {
              const at = h + reportDelayH;
              const list = reports.get(at) || [];
              list.push([t.to, rep]);
              reports.set(at, list);
            }
          }
        }
        E[t.to] += t.e;
        P[t.to] += t.p;
        Is[t.to] += t.s;
        Ia[t.to] += t.a;
        Wp[t.to] += t.wp;
        Ws[t.to] += t.ws;
        Wa[t.to] += t.wa;
        let landed = t.e + t.p + t.s + t.a;
        if (live2 && t.e2 !== undefined) {
          E2[t.to] += t.e2;
          P2[t.to] += t.p2;
          Is2[t.to] += t.s2;
          Ia2[t.to] += t.a2;
          Wp2[t.to] += t.wp2;
          Ws2[t.to] += t.ws2;
          Wa2[t.to] += t.wa2;
          landed += t.e2 + t.p2 + t.s2 + t.a2;
        }
        imported[t.to] += landed;
        importedTotal += landed;
        if (landed > 0) {
          activate(t.to);
          // By train it came over the ground (RAIL_TRAVEL).
          reach(t.to, t.ground ? 3 : 2);
        }
      }
      landing.delete(h);
      for (const [i, ward, icu, second] of admissions.get(h) || []) {
        H[i] += ward;
        U[i] += icu;
        pendingAdmit -= ward + icu;
        cumAdm[i] += ward + icu;
        // A second-strain batch (4th element 1), for the discharge split.
        if (second === 1) cumAdm2[i] += ward + icu;
        admitted += ward + icu;
        icuAdmitted += icu;
        activate(i);
      }
      admissions.delete(h);
      for (const [i, count] of reports.get(h) || []) {
        reported[i] += count;
        recentRep[i] += count;
        if (perPlace) watched.add(i);
        totalReported += count;
        if (firstReport[i] === Infinity) firstReport[i] = h;
        const c = countryOf[i];
        if (c >= 0) {
          countryReported[c] += count;
          if (!originCountry[c] && h < firstAbroadReport) firstAbroadReport = h;
        }
      }
      reports.delete(h);
      // The second strain is seeded at its hour (no draw), at its place or
      // the outbreak places, each caught up first.
      if (h === strain2Hour) {
        // Until now every immune person is of strain-1 type.
        for (let i = 0; i < n; i += 1) Rx[i] = R[i];
        live2 = true;
        const each = Math.max(
          1,
          Math.round(strain2.cases / strain2Places.length),
        );
        for (const i of strain2Places) {
          activate(i);
          const m = Math.min(each, S[i]);
          S[i] -= m;
          Sw[i] = Math.min(Sw[i], S[i]);
          E2[i] += m;
          cum[i] += m;
          cum2[i] += m;
          seeds += m;
          strain2Total += m;
          totalInfected += m;
          countTen(i);
          reach(i, 1);
        }
        strain2SeededAt = h;
      }
      // 2. The daily tick, over the affected places and the origins: the
      //    per-place restrictions (or the day's compliance everywhere), the
      //    global awareness signal, and the campaign's move up to the day's
      //    protected target.
      if (h % 24 === 0) {
        if (perPlace) {
          for (const i of active) tickRestrictions(i);
          for (const i of origins) if (!isActive[i]) tickRestrictions(i);
          // Places that left the affected list keep their tick until the
          // restriction is off and the incidence has decayed away.
          for (const i of watched) {
            if (isActive[i] || isOrigin[i]) continue;
            tickRestrictions(i);
            if (!npiOn[i] && (recentRep[i] * 1e5) / N[i] < 1e-6) {
              recentRep[i] = 0;
              watched.delete(i);
            }
          }
        } else if (fatigueHalfDays > 0)
          cNow = compliance((h - iv.startHour) / 24);
        // A country whose reports reached the trigger is flagged for good.
        if (borderPolicy === 'reported')
          for (let c = 0; c < countryCount; c += 1)
            if (!countryFlagged[c] && countryReported[c] >= iv.borderTrigger) {
              countryFlagged[c] = 1;
              flaggedCount += 1;
            }
        if (awareness > 0 && responseReach !== 'local') {
          let people = 0;
          for (const i of reachedList) people += N[i];
          const total =
            responseSignal === 'reported'
              ? totalReported
              : responseSignal === 'deaths'
                ? deaths
                : totalReported + deaths;
          globalSignal = people > 0 ? (total * 1e5) / people : 0;
        }
        if (vac) {
          for (const i of active) vaccinate(i, day);
          for (const i of origins) if (!isActive[i]) vaccinate(i, day);
        }
      }
      // 3. Force of infection where someone is infectious. People pull back
      //    as reported cases rise where they live. A place stays active
      //    while anyone is in hospital there.
      let kept = 0;
      for (const i of active) {
        if (
          E[i] + P[i] + Is[i] + Ia[i] + H[i] + U[i] > 0 ||
          (live2 && E2[i] + P2[i] + Is2[i] + Ia2[i] > 0)
        )
          active[kept++] = i;
        else {
          isActive[i] = 0;
          lambda[i] = 0;
          if (live2) lambda2[i] = 0;
        }
      }
      active.length = kept;
      const infectedNodes = active.slice();
      // The hazard at a place from the infectious pressure there: with
      // 'daytime' mixing the pressure is what stays at home plus what the
      // commuters in bring (pushed), over the daytime population.
      const hazard = (i, at) => {
        const boost = gatherOn && isOrigin[i] ? params.gathering.boost : 1;
        return (
          (params.beta *
            contactAt[i] *
            lockdownOf(i) *
            drift *
            boost *
            cautionOf(i) *
            season[i * days + day] *
            at) /
          (daytime ? Ntilde[i] : N[i])
        );
      };
      if (!daytime)
        for (const i of infectedNodes) {
          lambda[i] = 0;
          const at =
            Wp[i] * presymKeep +
            Ws[i] * (1 - iso) +
            Wa[i] * params.asymRelative;
          // The second strain's hazard, even where only it is infectious.
          if (live2) {
            const at2 =
              Wp2[i] * presymKeep +
              Ws2[i] * (1 - iso) +
              Wa2[i] * params.asymRelative;
            lambda2[i] = at2 > 0 ? hazard(i, at2) * rel2 : 0;
          }
          if (at <= 0) continue;
          lambda[i] = hazard(i, at);
        }
      else {
        // Two passes: each infected place pushes its pressure along its
        // commuting links (by the destination's hour), then its own hazard
        // reads what was pushed to it. An uninfected receiver keeps what it
        // was pushed until the next commute hour.
        for (const i of infectedNodes) {
          pressure[i] =
            Wp[i] * presymKeep +
            Ws[i] * (1 - iso) +
            Wa[i] * params.asymRelative;
          if (!live2) {
            if (pressure[i] <= 0) continue;
            for (const link of links[i] || []) {
              const j = link.j;
              visitorPressure[j] +=
                link.share *
                (diurnal ? dfacNow[offset[j] + 12] : 1) *
                pressure[i];
              if (!isActive[j] && !visitorPending[j]) {
                visitorPending[j] = 1;
                pendingVisitors.push(j);
              }
            }
            continue;
          }
          // Both strains push their pressure along the same links.
          pressure2[i] =
            Wp2[i] * presymKeep +
            Ws2[i] * (1 - iso) +
            Wa2[i] * params.asymRelative;
          if (pressure[i] <= 0 && !(pressure2[i] > 0)) continue;
          const own1 = pressure[i] > 0 ? pressure[i] : 0;
          const own2 = pressure2[i] > 0 ? pressure2[i] : 0;
          for (const link of links[i] || []) {
            const j = link.j;
            const dfac = link.share * (diurnal ? dfacNow[offset[j] + 12] : 1);
            visitorPressure[j] += dfac * own1;
            visitorPressure2[j] += dfac * own2;
            if (!isActive[j] && !visitorPending[j]) {
              visitorPending[j] = 1;
              pendingVisitors.push(j);
            }
          }
        }
        for (const i of infectedNodes) {
          const at = (1 - outShare[i]) * pressure[i] + visitorPressure[i];
          visitorPressure[i] = 0;
          lambda[i] = at > 0 ? hazard(i, at) : 0;
          if (live2) {
            const at2 = (1 - outShare[i]) * pressure2[i] + visitorPressure2[i];
            visitorPressure2[i] = 0;
            lambda2[i] = at2 > 0 ? hazard(i, at2) * rel2 : 0;
          }
        }
      }
      // 3. New infections, in infected places and the places that commute
      //    into them; then the stages move on.
      //    Infected places every hour: at home, and on their residents'
      //    trips to other infected places. Places nobody has it in yet,
      //    from the infected places their people commute to, every
      //    COMMUTE_STEP_H hours with that long's exposure at once: with every
      //    town in the model, a big city has thousands commuting in. Every
      //    trip counts by the destination's local hour (diurnal).
      const mark = run * hours + h + 1;
      const touched = [];
      for (const j of infectedNodes) {
        stamp[j] = mark;
        let own = (1 - outShare[j]) * lambda[j];
        // One pass over the links for both strains (strain 1 evaluates as
        // (share * d) * lambda, exactly as before).
        let own2 = live2 ? (1 - outShare[j]) * lambda2[j] : 0;
        for (const link of links[j] || []) {
          const f = link.share * (diurnal ? dfacNow[offset[link.j] + 12] : 1);
          own += f * lambda[link.j];
          if (live2) own2 += f * lambda2[link.j];
        }
        force[j] = own;
        if (live2) force2[j] = own2;
        touched.push(j);
      }
      if (commuteHour && live2) {
        // Both strains pull the places commuting in; a place touched as
        // uninfected is marked by the hour (farMark), and its strain-2 pull
        // is kept positive beside the strain-1 one.
        for (const j of infectedNodes) {
          if (!(lambda[j] > 0 || lambda2[j] > 0)) continue;
          const list = inbound[j];
          const stepFactor = diurnal ? dfacStep[offset[j] + 12] : 1;
          const pull = stepFactor * lambda[j];
          const pull2 = stepFactor * lambda2[j];
          for (let k = 0; k < list.length; k += 2) {
            const i = list[k];
            if (stamp[i] === mark) {
              if (farMark[i] === mark) {
                force[i] -= list[k + 1] * pull;
                force2[i] += list[k + 1] * pull2;
              }
              continue;
            }
            stamp[i] = mark;
            farMark[i] = mark;
            force[i] = -list[k + 1] * pull;
            force2[i] = list[k + 1] * pull2;
            touched.push(i);
          }
        }
        if (daytime && pendingVisitors.length) {
          for (const j of pendingVisitors) {
            if (!visitorPending[j]) continue;
            visitorPending[j] = 0;
            const at = visitorPressure[j] / COMMUTE_STEP_H;
            const at2 = visitorPressure2[j] / COMMUTE_STEP_H;
            visitorPressure[j] = 0;
            visitorPressure2[j] = 0;
            if (isActive[j] || !(at > 0 || at2 > 0)) continue;
            const term = at > 0 ? (1 - outShare[j]) * hazard(j, at) : 0;
            const term2 =
              at2 > 0 ? (1 - outShare[j]) * hazard(j, at2) * rel2 : 0;
            if (stamp[j] === mark) {
              force[j] -= term;
              force2[j] += term2;
            } else {
              stamp[j] = mark;
              farMark[j] = mark;
              force[j] = -term;
              force2[j] = term2;
              touched.push(j);
            }
          }
          pendingVisitors.length = 0;
        }
      } else if (commuteHour) {
        for (const j of infectedNodes) {
          if (!(lambda[j] > 0)) continue;
          const list = inbound[j];
          const pull = (diurnal ? dfacStep[offset[j] + 12] : 1) * lambda[j];
          for (let k = 0; k < list.length; k += 2) {
            const i = list[k];
            if (stamp[i] === mark) {
              if (force[i] < 0) force[i] -= list[k + 1] * pull;
              continue;
            }
            stamp[i] = mark;
            // Negative marks "not infected": exposure over the longer step.
            force[i] = -list[k + 1] * pull;
            touched.push(i);
          }
        }
        // Uninfected places with visitors: the pressure pushed to them since
        // the last commute hour, as its hourly mean over the step, met by
        // their own people at home.
        if (daytime && pendingVisitors.length) {
          for (const j of pendingVisitors) {
            if (!visitorPending[j]) continue;
            visitorPending[j] = 0;
            const at = visitorPressure[j] / COMMUTE_STEP_H;
            visitorPressure[j] = 0;
            if (isActive[j] || !(at > 0)) continue;
            const term = (1 - outShare[j]) * hazard(j, at);
            if (stamp[j] === mark) force[j] -= term;
            else {
              stamp[j] = mark;
              force[j] = -term;
              touched.push(j);
            }
          }
          pendingVisitors.length = 0;
        }
      }
      if (live2)
        for (const i of touched) {
          // One shared pool: the infections the two pulls make together,
          // split between the strains by their pulls; then the second
          // strain escapes the strain-1-type immunity it is not covered by
          // (Gog & Grenfell 2002).
          const step = farMark[i] === mark ? DT * COMMUTE_STEP_H : DT;
          const pull1 = Math.abs(force[i]);
          const pull2 = force2[i];
          force[i] = 0;
          force2[i] = 0;
          if (!isActive[i]) firstTouch(i);
          const pull = pull1 + pull2;
          let fresh = 0;
          if (pull > 0 && S[i] > 0) {
            const exposure =
              cv > 0
                ? pull *
                  step *
                  (S0[i] > 0 ? Math.min(1, S[i] / S0[i]) : 1) ** cv2
                : pull * step;
            fresh = binomial(S[i], 1 - Math.exp(-exposure), rng);
          }
          const fresh2 =
            pull2 > 0 && fresh > 0 ? binomial(fresh, pull2 / pull, rng) : 0;
          if (fresh > 0) {
            if (Sw[i] > 0) {
              const again = Math.round((fresh * Sw[i]) / S[i]);
              Sw[i] -= again;
              reinf[i] += again;
              reinfTotal += again;
            }
            S[i] -= fresh;
            E[i] += fresh - fresh2;
            E2[i] += fresh2;
            cum[i] += fresh;
            cum2[i] += fresh2;
            strain2Total += fresh2;
            local[i] += fresh;
            localTotal += fresh;
            totalInfected += fresh;
            if (firstLocal[i] === Infinity) firstLocal[i] = h;
            countTen(i);
            activate(i);
            reach(i, 3);
          }
          const escape =
            pull2 > 0 && Rx[i] > 0 && cross2 < 1
              ? binomial(Rx[i], 1 - Math.exp(-(1 - cross2) * pull2 * step), rng)
              : 0;
          if (escape > 0) {
            Rx[i] -= escape;
            R[i] -= escape;
            E2[i] += escape;
            cum[i] += escape;
            cum2[i] += escape;
            strain2Total += escape;
            reinf[i] += escape;
            reinfTotal += escape;
            local[i] += escape;
            localTotal += escape;
            totalInfected += escape;
            if (firstLocal[i] === Infinity) firstLocal[i] = h;
            countTen(i);
            activate(i);
            reach(i, 3);
          }
        }
      else
        for (const i of touched) {
          const step = force[i] < 0 ? DT * COMMUTE_STEP_H : DT;
          const pull = Math.abs(force[i]);
          force[i] = 0;
          if (!isActive[i]) firstTouch(i);
          let fresh = 0;
          if (pull > 0 && S[i] > 0) {
            // The most susceptible go first: the pool left is less
            // susceptible than it was, by (S / S0)^cv² (Gomes et al. 2022).
            const exposure =
              cv > 0
                ? pull *
                  step *
                  (S0[i] > 0 ? Math.min(1, S[i] / S0[i]) : 1) ** cv2
                : pull * step;
            fresh = binomial(S[i], 1 - Math.exp(-exposure), rng);
          }
          if (fresh > 0) {
            // Those back from immunity catch it again in their share of S.
            if (Sw[i] > 0) {
              const again = Math.round((fresh * Sw[i]) / S[i]);
              Sw[i] -= again;
              reinf[i] += again;
              reinfTotal += again;
            }
            S[i] -= fresh;
            E[i] += fresh;
            cum[i] += fresh;
            local[i] += fresh;
            localTotal += fresh;
            totalInfected += fresh;
            if (firstLocal[i] === Infinity) firstLocal[i] = h;
            countTen(i);
            activate(i);
            reach(i, 3);
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
          const found = testCap(
            i,
            binomial(onset, params.ascertainment ?? 0.25, rng),
            day,
          );
          if (found > 0) {
            const at = h + reportDelayH;
            const list = reports.get(at) || [];
            list.push([i, found]);
            reports.set(at, list);
          }
        }
        const healS = binomial(Is[i], 1 - Math.exp(-params.gammaSym * DT), rng);
        if (healS > 0) {
          if (!hospitalPath) {
            // The legacy path: the sick leave at once; past the hospital
            // beds, the share who die doubles for those who cannot get one.
            const inHospital = live2
              ? Is[i] * params.hospitalShare + Is2[i] * hs2
              : Is[i] * params.hospitalShare;
            const overflow =
              inHospital > beds[i] && inHospital > 0
                ? (inHospital - beds[i]) / inHospital
                : 0;
            if (overflow > 0) {
              overwhelmed[i] = 1;
              if (h < overflowAt[i]) overflowAt[i] = h;
              if (h < firstOverflow) firstOverflow = h;
            }
            const died = binomial(
              healS,
              Math.min(1, params.fatalityShare * (1 + overflow)),
              rng,
            );
            deaths += died;
            D[i] += died;
            if (died > 0 && firstDeath[i] === Infinity) firstDeath[i] = h;
            R[i] += healS - died;
            if (live2) Rx[i] += healS - died;
            Ws[i] -= (Ws[i] * healS) / Is[i];
            Is[i] -= healS;
          } else if (params.hospitalShare > 0) {
            // The hospital pathway: a share is admitted (some to intensive
            // care) after the admission delay; the rest recover.
            const adm = binomial(healS, params.hospitalShare, rng);
            const icu = binomial(adm, icuShare, rng);
            Ws[i] -= (Ws[i] * healS) / Is[i];
            Is[i] -= healS;
            R[i] += healS - adm;
            if (live2) Rx[i] += healS - adm;
            if (adm > 0) {
              pendingAdmit += adm;
              const at = h + admitDelayH;
              const list = admissions.get(at) || [];
              list.push([i, adm - icu, icu]);
              admissions.set(at, list);
            }
          } else {
            // Nobody is admitted, yet some die: no bed is short.
            const died = binomial(healS, params.fatalityShare, rng);
            Ws[i] -= (Ws[i] * healS) / Is[i];
            Is[i] -= healS;
            deaths += died;
            D[i] += died;
            if (died > 0 && firstDeath[i] === Infinity) firstDeath[i] = h;
            R[i] += healS - died;
            if (live2) Rx[i] += healS - died;
          }
        }
        const healA = binomial(
          Ia[i],
          1 - Math.exp(-params.gammaAsym * DT),
          rng,
        );
        if (healA > 0) {
          Wa[i] -= (Wa[i] * healA) / Ia[i];
          Ia[i] -= healA;
          R[i] += healA;
          if (live2) Rx[i] += healA;
        }
        if (P[i] <= 0) Wp[i] = 0;
        if (Is[i] <= 0) Ws[i] = 0;
        if (Ia[i] <= 0) Wa[i] = 0;
        if (H[i] + U[i] > 0) {
          // Ward and intensive-care discharges; the death risk at discharge
          // rises by the share who had no bed (Ferguson et al. 2020).
          const exitH = binomial(H[i], exitWardP, rng);
          const exitU = binomial(U[i], exitIcuP, rng);
          const overflowH = H[i] > beds[i] ? (H[i] - beds[i]) / H[i] : 0;
          const overflowU = U[i] > icuBeds[i] ? (U[i] - icuBeds[i]) / U[i] : 0;
          const dH = binomial(
            exitH,
            Math.min(1, deathGivenAdmission * (1 + overflowH)),
            rng,
          );
          const dU = binomial(
            exitU,
            Math.min(1, deathGivenAdmission * (1 + overflowU)),
            rng,
          );
          H[i] -= exitH;
          U[i] -= exitU;
          R[i] += exitH - dH + (exitU - dU);
          if (live2) {
            // The wards are shared: survivors return to strain-1-type
            // immunity in proportion to the strain-1 admissions here.
            const surv = exitH - dH + (exitU - dU);
            Rx[i] +=
              cumAdm[i] > 0
                ? Math.round((surv * (cumAdm[i] - cumAdm2[i])) / cumAdm[i])
                : surv;
            if (Rx[i] > R[i]) Rx[i] = R[i];
          }
          D[i] += dH + dU;
          deaths += dH + dU;
          if (dH + dU > 0 && firstDeath[i] === Infinity) firstDeath[i] = h;
          if (overflowH > 0 || overflowU > 0) {
            overwhelmed[i] = 1;
            if (h < overflowAt[i]) overflowAt[i] = h;
            if (h < firstOverflow) firstOverflow = h;
          }
          bedDaysShort +=
            (Math.max(0, H[i] - beds[i]) + Math.max(0, U[i] - icuBeds[i])) / 24;
          if (H[i] > hPeak[i]) hPeak[i] = H[i];
          if (U[i] > uPeak[i]) uPeak[i] = U[i];
        } else if (!hospitalPath) {
          bedDaysShort +=
            Math.max(
              0,
              (live2
                ? Is[i] * params.hospitalShare + Is2[i] * hs2
                : Is[i] * params.hospitalShare) - beds[i],
            ) / 24;
        }
        // The second strain's stages, at the same rates, where it is: its
        // reports join the shared ones, its admissions the shared wards (the
        // H/U step above is not repeated), its recovered are immune to both.
        if (live2 && E2[i] + P2[i] + Is2[i] + Ia2[i] > 0) {
          const out2 = binomial(E2[i], 1 - Math.exp(-params.sigma * DT), rng);
          if (out2 > 0) {
            E2[i] -= out2;
            const asym = binomial(out2, params.asymShare, rng);
            const sym = out2 - asym;
            Ia2[i] += asym;
            Wa2[i] += weightOf(asym);
            P2[i] += sym;
            Wp2[i] += weightOf(sym);
          }
          const onset2 = binomial(P2[i], 1 - Math.exp(-params.rho * DT), rng);
          if (onset2 > 0) {
            const w = (Wp2[i] * onset2) / P2[i];
            P2[i] -= onset2;
            Wp2[i] -= w;
            Is2[i] += onset2;
            Ws2[i] += w;
            const found = testCap(
              i,
              binomial(onset2, params.ascertainment ?? 0.25, rng),
              day,
            );
            if (found > 0) {
              const at = h + reportDelayH;
              const list = reports.get(at) || [];
              list.push([i, found]);
              reports.set(at, list);
            }
          }
          const healS2 = binomial(
            Is2[i],
            1 - Math.exp(-params.gammaSym * DT),
            rng,
          );
          if (healS2 > 0) {
            if (!hospitalPath) {
              const inHospital = Is[i] * params.hospitalShare + Is2[i] * hs2;
              const overflow =
                inHospital > beds[i] && inHospital > 0
                  ? (inHospital - beds[i]) / inHospital
                  : 0;
              if (overflow > 0) {
                overwhelmed[i] = 1;
                if (h < overflowAt[i]) overflowAt[i] = h;
                if (h < firstOverflow) firstOverflow = h;
              }
              const died = binomial(
                healS2,
                Math.min(
                  1,
                  params.fatalityShare * strain2.severity * (1 + overflow),
                ),
                rng,
              );
              deaths += died;
              D[i] += died;
              if (died > 0 && firstDeath[i] === Infinity) firstDeath[i] = h;
              R[i] += healS2 - died;
              Ws2[i] -= (Ws2[i] * healS2) / Is2[i];
              Is2[i] -= healS2;
            } else if (params.hospitalShare > 0) {
              const adm = binomial(healS2, hs2, rng);
              const icu = binomial(adm, icuShare, rng);
              Ws2[i] -= (Ws2[i] * healS2) / Is2[i];
              Is2[i] -= healS2;
              R[i] += healS2 - adm;
              if (adm > 0) {
                pendingAdmit += adm;
                const at = h + admitDelayH;
                const list = admissions.get(at) || [];
                list.push([i, adm - icu, icu, 1]);
                admissions.set(at, list);
              }
            } else {
              const died = binomial(
                healS2,
                Math.min(1, params.fatalityShare * strain2.severity),
                rng,
              );
              Ws2[i] -= (Ws2[i] * healS2) / Is2[i];
              Is2[i] -= healS2;
              deaths += died;
              D[i] += died;
              if (died > 0 && firstDeath[i] === Infinity) firstDeath[i] = h;
              R[i] += healS2 - died;
            }
          }
          const healA2 = binomial(
            Ia2[i],
            1 - Math.exp(-params.gammaAsym * DT),
            rng,
          );
          if (healA2 > 0) {
            Wa2[i] -= (Wa2[i] * healA2) / Ia2[i];
            Ia2[i] -= healA2;
            R[i] += healA2;
          }
          if (P2[i] <= 0) Wp2[i] = 0;
          if (Is2[i] <= 0) Ws2[i] = 0;
          if (Ia2[i] <= 0) Wa2[i] = 0;
        }
      }
      // Immunity wanes where the loop is working, and at the origins.
      if (waning) {
        for (const i of active) wane(i);
        for (const i of origins) if (!isActive[i]) wane(i);
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
            if (Sw[i] > S[i]) Sw[i] = S[i];
            E[i] += spill;
            cum[i] += spill;
            local[i] += spill;
            localTotal += spill;
            totalInfected += spill;
            countTen(i);
            activate(i);
          }
        }
      // 4. Flights leaving this hour: infected travellers board, some are
      //    caught by screening, the rest land later.
      // `rail`: a rail route (RAIL_TRAVEL): its passengers a day may be a
      // fraction, rounded up or down at random by the fraction; it never
      // transfers at a hub, and what it brings in is ground travel.
      const board = (from, to, passengers, landH, rail = false) => {
        // The passengers (domestic or international flying at their own
        // share of normal), and those the ban keeps off (counted whether or
        // not anyone aboard is infected): everywhere inside the window, or
        // where either end is under its own restriction, on the legs the
        // border policy reaches.
        const scope = scopeOK(from, to);
        let pax =
          passengers *
          params.travel *
          (gatherOn && isOrigin[from] ? params.gathering.travel : 1) *
          (international(from, to) ? travelIntl : travelDomestic);
        const banOn = scope && (perPlace ? npiOn[from] || npiOn[to] : inWindow);
        if (banOn && iv.travelBan > 0) {
          const before = Math.round(pax);
          pax *= 1 - iv.travelBan;
          passengersBlocked += before - Math.round(pax);
        }
        const has2 = live2 && E2[from] + P2[from] + Is2[from] + Ia2[from] > 0;
        if (E[from] + P[from] + Is[from] + Ia[from] <= 0 && !has2) return;
        if (rail) {
          const whole = Math.floor(pax);
          pax = whole + (rng() < pax - whole ? 1 : 0);
        } else pax = Math.round(pax);
        if (pax <= 0) return;
        const share = (count) => count / N[from];
        const e = take(binomial(pax, share(E[from]), rng), E[from]);
        const p = take(binomial(pax, share(P[from]), rng), P[from]);
        const s = take(
          binomial(pax, share(Is[from]) * params.symptomaticTravel, rng),
          Is[from],
        );
        const a = take(binomial(pax, share(Ia[from]), rng), Ia[from]);
        // The second strain boards the same way, after (a stated
        // simplification: its sick fly as often as the first strain's).
        let e2 = 0;
        let p2 = 0;
        let s2 = 0;
        let a2 = 0;
        if (has2) {
          e2 = take(binomial(pax, share(E2[from]), rng), E2[from]);
          p2 = take(binomial(pax, share(P2[from]), rng), P2[from]);
          s2 = take(
            binomial(pax, share(Is2[from]) * params.symptomaticTravel, rng),
            Is2[from],
          );
          a2 = take(binomial(pax, share(Ia2[from]), rng), Ia2[from]);
        }
        if (e + p + s + a + (e2 + p2 + s2 + a2) <= 0) return;
        const wp = P[from] > 0 ? (Wp[from] * p) / P[from] : 0;
        const ws = Is[from] > 0 ? (Ws[from] * s) / Is[from] : 0;
        let wa = Ia[from] > 0 ? (Wa[from] * a) / Ia[from] : 0;
        E[from] -= e;
        P[from] -= p;
        Wp[from] -= wp;
        Is[from] -= s;
        Ws[from] -= ws;
        Ia[from] -= a;
        Wa[from] -= wa;
        let wp2 = 0;
        let ws2 = 0;
        let wa2 = 0;
        if (has2) {
          wp2 = P2[from] > 0 ? (Wp2[from] * p2) / P2[from] : 0;
          ws2 = Is2[from] > 0 ? (Ws2[from] * s2) / Is2[from] : 0;
          wa2 = Ia2[from] > 0 ? (Wa2[from] * a2) / Ia2[from] : 0;
          E2[from] -= e2;
          P2[from] -= p2;
          Wp2[from] -= wp2;
          Is2[from] -= s2;
          Ws2[from] -= ws2;
          Ia2[from] -= a2;
          Wa2[from] -= wa2;
        }
        // Screening at departure: those caught are isolated.
        const b = { e, p, s, a };
        const b2 = live2 ? { e: e2, p: p2, s: s2, a: a2 } : null;
        if (inWindow && scope && iv.exitScreening) {
          const caughtS = binomial(b.s, SCREENING_CATCH.symptomatic, rng);
          const caughtP = binomial(b.p, SCREENING_CATCH.presym, rng);
          b.s -= caughtS;
          b.p -= caughtP;
          isolated += caughtS + caughtP;
          travellersCaught += caughtS + caughtP;
          if (b2) {
            const caughtS2 = binomial(b2.s, SCREENING_CATCH.symptomatic, rng);
            const caughtP2 = binomial(b2.p, SCREENING_CATCH.presym, rng);
            b2.s -= caughtS2;
            b2.p -= caughtP2;
            isolated += caughtS2 + caughtP2;
            travellersCaught += caughtS2 + caughtP2;
          }
        }
        // At a hub, a share of each compartment flies on after landing: it
        // skips this leg's entry screening and quarantine and takes the
        // onward leg's instead (onward).
        if (transferring && !rail && isHub[to]) {
          const eOn = binomial(b.e, transferShare, rng);
          const pOn = binomial(b.p, transferShare, rng);
          const sOn = binomial(b.s, transferShare, rng);
          const aOn = binomial(b.a, transferShare, rng);
          let eOn2 = 0;
          let pOn2 = 0;
          let sOn2 = 0;
          let aOn2 = 0;
          if (b2) {
            eOn2 = binomial(b2.e, transferShare, rng);
            pOn2 = binomial(b2.p, transferShare, rng);
            sOn2 = binomial(b2.s, transferShare, rng);
            aOn2 = binomial(b2.a, transferShare, rng);
          }
          if (eOn + pOn + sOn + aOn + (eOn2 + pOn2 + sOn2 + aOn2) > 0) {
            inTransit += eOn + pOn + sOn + aOn;
            const list = landing.get(landH) || [];
            const record = {
              to,
              e: eOn,
              p: pOn,
              s: sOn,
              a: aOn,
              wp: p > 0 ? (wp * pOn) / p : 0,
              ws: s > 0 ? (ws * sOn) / s : 0,
              wa: a > 0 ? (wa * aOn) / a : 0,
              transfer: 1,
              from,
            };
            if (b2) {
              inTransit += eOn2 + pOn2 + sOn2 + aOn2;
              record.e2 = eOn2;
              record.p2 = pOn2;
              record.s2 = sOn2;
              record.a2 = aOn2;
              record.wp2 = p2 > 0 ? (wp2 * pOn2) / p2 : 0;
              record.ws2 = s2 > 0 ? (ws2 * sOn2) / s2 : 0;
              record.wa2 = a2 > 0 ? (wa2 * aOn2) / a2 : 0;
              wa2 = a2 > 0 ? (wa2 * (b2.a - aOn2)) / a2 : 0;
              b2.e -= eOn2;
              b2.p -= pOn2;
              b2.s -= sOn2;
              b2.a -= aOn2;
            }
            list.push(record);
            landing.set(landH, list);
            wa = a > 0 ? (wa * (b.a - aOn)) / a : 0;
            b.e -= eOn;
            b.p -= pOn;
            b.s -= sOn;
            b.a -= aOn;
          }
        }
        // Screening on arrival, and quarantine, which catches those who fall
        // ill or test positive within it: most of a 14-day one, little of a
        // 2-day one.
        inspectArrival(b, scope);
        if (b2) inspectArrival(b2, scope);
        if (b.e + b.p + b.s + b.a + (b2 ? b2.e + b2.p + b2.s + b2.a : 0) <= 0)
          return;
        inTransit += b.e + b.p + b.s + b.a;
        const list = landing.get(landH) || [];
        const record = {
          to,
          e: b.e,
          p: b.p,
          s: b.s,
          a: b.a,
          wp: p > 0 ? (wp * b.p) / p : 0,
          ws: s > 0 ? (ws * b.s) / s : 0,
          wa,
        };
        if (rail) record.ground = 1;
        if (b2) {
          inTransit += b2.e + b2.p + b2.s + b2.a;
          record.e2 = b2.e;
          record.p2 = b2.p;
          record.s2 = b2.s;
          record.a2 = b2.a;
          record.wp2 = p2 > 0 ? (wp2 * b2.p) / p2 : 0;
          record.ws2 = s2 > 0 ? (ws2 * b2.s) / s2 : 0;
          record.wa2 = wa2;
        }
        list.push(record);
        landing.set(landH, list);
      };
      for (const f of byHour[h]) board(f.from, f.to, f.passengers, f.landH);
      const hourMs = startMs + h * HOUR_MS;
      const hourOfDay = Math.floor(
        (((hourMs % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS,
      );
      for (const r of byHourOfDay[hourOfDay]) {
        const departMs = hourMs - (hourMs % HOUR_MS) + (r.tod % HOUR_MS);
        const rail = r.mode === 'rail';
        // The scan's flights are air: a train is never one of them.
        if (
          !rail &&
          flownKeys.size &&
          flownKeys.has(`${r.from}>${r.to}|${Math.round(departMs / 1_800_000)}`)
        )
          continue;
        board(
          r.from,
          r.to,
          r.passengers,
          Math.floor((departMs + r.lengthMs - startMs) / HOUR_MS),
          rail,
        );
      }
      // 5. The ledger: people and places under restriction this hour, among
      //    the affected places and the origins (everywhere: only while
      //    something restricts them), counted as unweighted person-days.
      let restrictedPeople = 0;
      let restrictedPlaces = 0;
      if (perPlace) {
        for (const i of active)
          if (npiOn[i]) {
            restrictedPeople += N[i];
            restrictedPlaces += 1;
          }
        for (const i of origins)
          if (!isActive[i] && npiOn[i]) {
            restrictedPeople += N[i];
            restrictedPlaces += 1;
          }
        for (const i of watched)
          if (!isActive[i] && !isOrigin[i] && npiOn[i]) {
            restrictedPeople += N[i];
            restrictedPlaces += 1;
          }
      } else if (inWindow && restrictsAnyone) {
        for (const i of active) restrictedPeople += N[i];
        restrictedPlaces = active.length;
        for (const i of origins)
          if (!isActive[i]) {
            restrictedPeople += N[i];
            restrictedPlaces += 1;
          }
      }
      restrictedPersonDays += restrictedPeople / 24;
      // The deadline, read every ABORT_CHECK_HOURS hours only when set: past
      // it, this hour's tuple is pushed and the run stops here.
      let stopping = false;
      if (
        deadlineSet &&
        (h + 1) % ABORT_CHECK_HOURS === 0 &&
        h < hours - 1 &&
        now() >= deadline
      )
        stopping = true;
      if (h % 24 === 23 || h === hours - 1 || stopping) {
        // The day's tuple: cumulative infections, reports and deaths, ward
        // and ICU occupancy, admissions, restricted people, the
        // campaign-protected, (countries closed, imported), reinfections,
        // the distancing index, beds short now, restricted places, ICU
        // admissions. The bracketed columns are filled by later
        // mechanisms; 0 here.
        let ward = 0;
        let icu = 0;
        let short = 0;
        for (const i of active) {
          if (hospitalPath) {
            ward += H[i];
            icu += U[i];
            short +=
              Math.max(0, H[i] - beds[i]) + Math.max(0, U[i] - icuBeds[i]);
          } else {
            const inHospital = live2
              ? Is[i] * params.hospitalShare + Is2[i] * hs2
              : Is[i] * params.hospitalShare;
            ward += inHospital;
            short += Math.max(0, inHospital - beds[i]);
          }
        }
        // Distancing: the people-weighted share of contacts the lockdown
        // and caution take away in the affected places.
        let distancing = 0;
        if (iv.lockdown > 0 || awareness > 0) {
          let people = 0;
          let cut = 0;
          for (const i of active) {
            people += N[i];
            cut += N[i] * (1 - lockdownOf(i) * cautionOf(i));
          }
          distancing = people > 0 ? cut / people : 0;
        }
        // Countries whose flights the policy closes right now: the outbreak
        // countries, the flagged ones, or every country in the model.
        const countriesClosed = !inWindow
          ? 0
          : borderPolicy === 'origin'
            ? originCountries
            : borderPolicy === 'reported'
              ? flaggedCount
              : borderPolicy === 'all'
                ? countryCount
                : 0;
        totals.push([
          totalInfected,
          totalReported,
          deaths,
          ward,
          icu,
          admitted,
          restrictedPeople,
          vaccinated,
          countriesClosed,
          importedTotal,
          reinfTotal,
          distancing,
          short,
          restrictedPlaces,
          icuAdmitted,
        ]);
        // The second strain's infections so far, a 16th column.
        if (twoStrain) totals.at(-1).push(strain2Total);
        // The by-day tables of the places this run reached: written now,
        // or, with a deadline (a run may yet be dropped), logged and
        // committed at the end of the run.
        if (deadlineSet) {
          logPushes.push(day, logLength);
          for (const i of reachedList) logEntry(i, cum[i]);
        } else
          for (const i of reachedList) {
            const acc = byDayOf(i);
            if (cum[i] >= 1) acc.anyRuns[day] += 1;
            if (cum[i] >= 10) acc.tenRuns[day] += 1;
            acc.caseSum[day] += cum[i];
          }
      }
      if (trace && run === 0) {
        let people =
          deaths + inTransit + pendingAdmit + isolated - populationTotal;
        for (let i = 0; i < n; i += 1)
          people += S[i] + E[i] + P[i] + Is[i] + Ia[i] + H[i] + U[i] + R[i];
        if (twoStrain)
          for (let i = 0; i < n; i += 1) {
            people += E2[i] + P2[i] + Is2[i] + Ia2[i];
            if (live2 && !(Rx[i] >= 0 && Rx[i] <= R[i]))
              throw new Error(
                `strain-1 immune out of range at ${nodes[i].id}, hour ${h}`,
              );
          }
        conservation.push(people);
      }
      if (stopping) {
        stoppedAt = { run, hour: h + 1 };
        break;
      }
    }
    // A later run the deadline cut is dropped: the result is that of the
    // runs done. Its first triggers are taken back; its by-day log is never
    // committed.
    if (stoppedAt && run > 0) {
      for (let i = 0; i < n; i += 1)
        if (restrictAt[i] !== Infinity) restrictedRuns[i] -= 1;
      logLength = 0;
      logPushes.length = 0;
      partial = true;
      break;
    }
    // The run's by-day log, in the order the direct path writes it.
    if (deadlineSet) {
      for (let k = 0; k < logPushes.length; k += 2) {
        const day = logPushes[k];
        const end = k + 2 < logPushes.length ? logPushes[k + 3] : logLength;
        for (let e = logPushes[k + 1]; e < end; e += 1) {
          const acc = byDayOf(logPlace[e]);
          const c = logCum[e];
          if (c >= 1) acc.anyRuns[day] += 1;
          if (c >= 10) acc.tenRuns[day] += 1;
          acc.caseSum[day] += c;
        }
      }
      logLength = 0;
      logPushes.length = 0;
    }
    // Immunity lost where the loop never looked, up to the last hour.
    if (waning) for (let i = 0; i < n; i += 1) if (R[i] > 0) waneCatchUp(i);
    let immune = 0;
    let sEnd = 0;
    let s0 = 0;
    for (let i = 0; i < n; i += 1) {
      immune += R[i];
      if (arrived[i] !== Infinity) {
        arrivals[i].push(arrived[i]);
        deathsAt[i].push(D[i]);
        hPeaks[i].push(hPeak[i]);
        uPeaks[i].push(uPeak[i]);
        if (overflowAt[i] !== Infinity) overflows[i].push(overflowAt[i]);
        vaccAt[i].push(V[i]);
        reinfAt[i].push(reinf[i]);
        importedAt[i].push(imported[i]);
        if (firstBy[i] === 2) airFirst[i] += 1;
        else if (firstBy[i] === 3) groundFirst[i] += 1;
        if (firstLocal[i] !== Infinity) localAts[i].push(firstLocal[i]);
        if (firstTen[i] !== Infinity) tenAts[i].push(firstTen[i]);
        sEnd += S[i];
        s0 += S0[i];
        if (twoStrain && cum2[i] > 0) strain2Runs[i] += 1;
      }
      if (firstReport[i] !== Infinity) reportsFirst[i].push(firstReport[i]);
      if (overwhelmed[i]) overwhelmedRuns[i] += 1;
      if (restrictAt[i] !== Infinity) restrictAts[i].push(restrictAt[i]);
      if (saturated[i]) saturatedRuns[i] += 1;
      cases[i].push(cum[i]);
    }
    immuneEnds.push(immune);
    rEndFactors.push(s0 > 0 ? sEnd / s0 : 1);
    firstOverflows.push(firstOverflow);
    restrictedPersonDaysRuns.push(restrictedPersonDays);
    passengersBlockedRuns.push(passengersBlocked);
    travellersCaughtRuns.push(travellersCaught);
    bedDaysShortRuns.push(bedDaysShort);
    firstAbroadReports.push(firstAbroadReport);
    transfersFlownRuns.push(transfersFlown);
    dailyTotals.push(totals);
    let living = 0;
    for (const i of active) living += E[i] + P[i] + Is[i] + Ia[i] + H[i] + U[i];
    if (twoStrain)
      for (const i of active) living += E2[i] + P2[i] + Is2[i] + Ia2[i];
    const seeded =
      (params.initialCases ?? 0) +
      (strain2SeededAt !== Infinity ? strain2.cases : 0);
    if (living === 0 && totalInfected < seeded + 20) extinctRuns += 1;
    if (trace) {
      runTotals.push(totals.at(-1).slice());
      const sum = (list) => {
        let t = 0;
        for (let i = 0; i < n; i += 1) t += list[i];
        return t;
      };
      runEnd.push({
        S: sum(S),
        E: sum(E),
        P: sum(P),
        Is: sum(Is),
        Ia: sum(Ia),
        H: sum(H),
        U: sum(U),
        R: sum(R),
        D: sum(D),
        V: sum(V),
        reinf: sum(reinf),
        cumAdm: sum(cumAdm),
        deaths,
        inTransit,
        pendingAdmit,
        isolated,
        admitted,
        icuAdmitted,
        vaccinated,
        reinfTotal,
        bedDaysShort,
        firstOverflow,
        restrictedPersonDays,
        passengersBlocked,
        travellersCaught,
        cum: sum(cum),
        local: sum(local),
        imported: sum(imported),
        seeds,
        localTotal,
        importedTotal,
        transfersFlown,
        firstAbroadReport,
        population: populationTotal,
        ...(twoStrain
          ? {
              E2: sum(E2),
              P2: sum(P2),
              Is2: sum(Is2),
              Ia2: sum(Ia2),
              // Before the seeding every immune person is of strain-1 type.
              Rx: live2 ? sum(Rx) : sum(R),
              cum2: sum(cum2),
              strain2Total,
            }
          : {}),
      });
    }
    done += 1;
    if (run === 0) runTimeMs = now() - started;
    // Run 0 cut by the deadline is kept, cut short, and is the only run.
    if (stoppedAt) {
      partial = true;
      break;
    }
  }
  // How many runs the budget has room for, going by run 0 (never Infinity).
  const fitBy = runTimeMs > 0 ? Math.floor(budgetMs / runTimeMs) : runCount;
  const runsFit = Number.isFinite(fitBy) ? Math.min(runCount, fitBy) : runCount;
  // A comparison arm reads only its runs' day tuples and its time.
  if (light)
    return {
      runs: done,
      partial,
      ...(stoppedAt ? { stoppedAt } : {}),
      _pairs: { daily: dailyTotals },
      _runTimeMs: runTimeMs,
    };

  // Percentiles over all runs: a run where it never came is "later than the
  // window" (null).
  const percentiles = (list) => {
    const sorted = list.sort((a, b) => a - b);
    return ARRIVAL_PERCENTILES.map((p) => {
      const rank = Math.floor((p / 100) * (done - 1));
      return rank < sorted.length ? sorted[rank] : null;
    });
  };
  // A median over all runs of a list kept only for the runs that reached
  // the place: the other runs count as zeros.
  const quantileWithZeros = (sorted, p) => {
    const rank = Math.min(done - 1, Math.floor((p / 100) * done));
    const zeros = done - sorted.length;
    return rank < zeros ? 0 : sorted[rank - zeros];
  };
  const sortedUp = (list) => list.sort((a, b) => a - b);
  // The median hour of an event among `among` runs, kept only for the runs
  // it happened in: null when fewer than half of them had it.
  const medianAmong = (list, among) => {
    const sorted = sortedUp(list);
    const rank = Math.floor(0.5 * (among - 1));
    return rank < sorted.length ? sorted[rank] : null;
  };
  const reachedCountries = new Set();
  const places = [];
  // Which node each place entry stands for, for the by-day tables.
  const nodeOf = new Map();
  for (let i = 0; i < n; i += 1) {
    const pArrive = arrivals[i].length / done;
    if (!(pArrive > 0)) continue;
    // percentiles sorts the arrivals in place; the interval reads them sorted.
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
      // Deaths and the occupancy peaks here, over all runs; when its beds
      // first ran short, over the runs where they did.
      deathsP50: Math.round(quantileWithZeros(sortedUp(deathsAt[i]), 50)),
      hospitalPeakP50: Math.round(quantileWithZeros(sortedUp(hPeaks[i]), 50)),
      icuPeakP50: Math.round(quantileWithZeros(sortedUp(uPeaks[i]), 50)),
      overflowP50: percentiles(overflows[i])[10],
      // Protected by the campaign and caught again here, over all runs.
      vaccinatedP50: Math.round(quantileWithZeros(sortedUp(vaccAt[i]), 50)),
      reinfectedP50: Math.round(quantileWithZeros(sortedUp(reinfAt[i]), 50)),
      // Its own restriction: how often it triggered and when; and how often
      // its tests ran out.
      pRestricted: round3(restrictedRuns[i] / done),
      restrictP50: percentiles(restrictAts[i])[10],
      pTestsSaturated: round3(saturatedRuns[i] / done),
      // Imported against local: travellers landed here over all runs; how
      // often the first case flew in, or walked in, among the runs that
      // reached it; how often it spread here, and when it did, and when the
      // count reached ten; its hours from UTC.
      importedP50: Math.round(quantileWithZeros(sortedUp(importedAt[i]), 50)),
      pImportedFirst: round3(airFirst[i] / arrivals[i].length),
      pGround: round3(groundFirst[i] / arrivals[i].length),
      pLocal: round3(localAts[i].length / done),
      localBy50: medianAmong(localAts[i], arrivals[i].length),
      establishedBy50: medianAmong(tenAts[i], arrivals[i].length),
      localOffsetHours: offset[i],
      // Monte-Carlo intervals: on the chance it comes (Wilson), and on the
      // median arrival among all runs (null when that reaches past the runs
      // it came in).
      pArriveCi: wilsonInterval(arrivals[i].length, done),
      etaP50Ci: quantileInterval(arrivals[i], 0.5, undefined, done),
      // The runs the second strain reached it in.
      ...(twoStrain ? { pStrain2: round3(strain2Runs[i] / done) } : {}),
    });
    nodeOf.set(places.at(-1), i);
    if (pArrive >= 0.5 && countryOf[i] >= 0) reachedCountries.add(countryOf[i]);
  }
  places.sort(
    (a, b) =>
      b.pArrive - a.pArrive || (a.etaP50 ?? Infinity) - (b.etaP50 ?? Infinity),
  );
  // The by-day tables: [P(a case by then), P(ten by then), mean cases] a day,
  // for the origins and the BY_DAY_PLACES likeliest other places; as many
  // days as run 0 pushed (fewer only when the deadline cut it).
  const dayCount = dailyTotals[0]?.length || 0;
  // The hours the result covers: the window, or where run 0 was cut.
  const hoursOut = stoppedAt?.run === 0 ? stoppedAt.hour : hours;
  let tabled = 0;
  for (const place of places) {
    if (!place.origin) {
      if (tabled >= BY_DAY_PLACES) continue;
      tabled += 1;
    }
    const acc = byDayOf(nodeOf.get(place));
    place.byDay = Array.from({ length: dayCount }, (_, d) => [
      round3(acc.anyRuns[d] / done),
      round3(acc.tenRuns[d] / done),
      Math.round(acc.caseSum[d] / done),
    ]);
  }
  byDayAcc.clear();
  const bands = (v) => {
    v.sort((a, b) => a - b);
    return [5, 50, 95].map((p) => Math.round(quantile(v, p)));
  };
  const band = (d, k) => bands(dailyTotals.map((t) => t[d][k]));
  // The median of a column that day, unrounded (shares).
  const medianRaw = (d, k) =>
    quantile(
      dailyTotals.map((t) => t[d][k]).sort((a, b) => a - b),
      50,
    );
  // A median, or another quantile, over the runs of a per-run counter.
  const runQuantile = (list, p = 50) =>
    Math.round(
      quantile(
        list.slice().sort((a, b) => a - b),
        p,
      ) ?? 0,
    );
  // New infections that day, per run: the rise of the cumulative count.
  const newBand = (d) =>
    bands(dailyTotals.map((t) => t[d][0] - (d > 0 ? t[d - 1][0] : 0)));
  // Rt in the runs: each run's renewal ratio over the model's generation
  // kernel; a partial last day is left out; per day the 5/50/95 % over the
  // runs that have one, null when fewer than half do.
  const kernel = generationKernel(params);
  const lastHoursOut = hoursOut - 24 * (dayCount - 1);
  const rtRuns = dailyTotals.map((t) => {
    const rt = renewalRt(
      t.map((row, d) => row[0] - (d > 0 ? t[d - 1][0] : 0)),
      kernel.daily,
    );
    if (lastHoursOut > 0 && lastHoursOut < 24 && rt.length)
      rt[rt.length - 1] = null;
    return rt;
  });
  const rtBand = (d) => {
    const defined = [];
    for (const rt of rtRuns) if (rt[d] !== null) defined.push(rt[d]);
    if (!defined.length || defined.length < 0.5 * done)
      return [null, null, null];
    defined.sort((a, b) => a - b);
    return [5, 50, 95].map((p) => round2(quantile(defined, p)));
  };
  // The median over runs of a column's peak over the days.
  const peakP50 = (k) =>
    bands(
      dailyTotals.map((t) => t.reduce((top, row) => Math.max(top, row[k]), 0)),
    )[1];
  // The peak of new infections, per run: its first day (1-based), its size,
  // and whether the last day is already well below it.
  const peakDays = [];
  const peakNews = [];
  let peaksReached = 0;
  for (const t of dailyTotals) {
    let peakDay = 0;
    let peakNew = -Infinity;
    let lastNew = 0;
    for (let d = 0; d < t.length; d += 1) {
      lastNew = t[d][0] - (d > 0 ? t[d - 1][0] : 0);
      if (lastNew > peakNew) {
        peakNew = lastNew;
        peakDay = d;
      }
    }
    peakDays.push(peakDay + 1);
    peakNews.push(peakNew);
    // A partial last day (the window not a whole number of days) is scaled
    // to a full day's rate before it is compared.
    const lastHours = hoursOut - 24 * (t.length - 1);
    const lastRate =
      lastHours > 0 && lastHours < 24 ? (lastNew * 24) / lastHours : lastNew;
    if (lastRate < 0.9 * peakNew) peaksReached += 1;
  }
  const [peakDayP5, peakDayP50, peakDayP95] = bands(peakDays);
  const [, peakNewP50, peakNewP95] = bands(peakNews);
  // The order-statistic interval round the median of a column's end value.
  const endInterval = (k) =>
    quantileInterval(
      dailyTotals.map((t) => t.at(-1)[k]).sort((a, b) => a - b),
      0.5,
    );
  const infectedP50Ci = endInterval(0);
  // The second strain's share of the day's new infections, as the median
  // over the runs with any (null when fewer than half have any).
  const strain2ShareOn = (d) => {
    // The seeding day's strain-2 count is mostly the injected seeds, which
    // are not transmission, so it has no share.
    if (twoStrain && d === strain2.day) return null;
    const shares = [];
    for (const t of dailyTotals) {
      const fresh = t[d][0] - (d > 0 ? t[d - 1][0] : 0);
      if (fresh > 0)
        shares.push((t[d][15] - (d > 0 ? t[d - 1][15] : 0)) / fresh);
    }
    if (shares.length < 0.5 * dailyTotals.length) return null;
    return round2(
      quantile(
        shares.sort((a, b) => a - b),
        50,
      ),
    );
  };
  const totals = Array.from({ length: dayCount }, (_, d) => {
    const [p5, p50, p95] = band(d, 0);
    const [reportedP5, reportedP50, reportedP95] = band(d, 1);
    const [deathsP5, deathsP50, deathsP95] = band(d, 2);
    const [newP5, newP50, newP95] = newBand(d);
    const [hospitalP5, hospitalP50, hospitalP95] = band(d, 3);
    const [rtP5, rtP50, rtP95] = rtBand(d);
    return {
      day: d + 1,
      p5,
      p50,
      p95,
      newP5,
      newP50,
      newP95,
      reportedP5,
      reportedP50,
      reportedP95,
      deathsP5,
      deathsP50,
      deathsP95,
      hospitalP5,
      hospitalP50,
      hospitalP95,
      icuP50: band(d, 4)[1],
      admittedP50: band(d, 5)[1],
      bedsShortP50: band(d, 12)[1],
      restrictedPeopleP50: band(d, 6)[1],
      restrictedPlacesP50: band(d, 13)[1],
      vaccinatedP50: band(d, 7)[1],
      countriesClosedP50: band(d, 8)[1],
      importedP50: band(d, 9)[1],
      reinfectedP50: band(d, 10)[1],
      distancingP50: round2(medianRaw(d, 11)),
      rtP5,
      rtP50,
      rtP95,
      ...(twoStrain
        ? {
            strain2P50: band(d, 15)[1],
            strain2ShareP50: strain2ShareOn(d),
          }
        : {}),
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
  // Rail trips between places it likely reached (RAIL_TRAVEL, owner ruling
  // 2026-10-12), beside the commuting lines: travellers a day by train.
  const railTrips = [];
  let railRouteCount = 0;
  for (const r of routes) {
    if (r?.mode !== 'rail' || !valid(r.from) || !valid(r.to)) continue;
    railRouteCount += 1;
    if (!likely.has(nodes[r.from].id) || !likely.has(nodes[r.to].id)) continue;
    railTrips.push({
      from: {
        lat: nodes[r.from].lat,
        lon: nodes[r.from].lon,
        name: nodes[r.from].name,
      },
      to: {
        lat: nodes[r.to].lat,
        lon: nodes[r.to].lon,
        name: nodes[r.to].name,
      },
      perDay: Math.round(r.passengers * 10) / 10,
      km: Number.isFinite(r.km) ? Math.round(r.km) : null,
    });
  }
  railTrips.sort((a, b) => b.perDay - a.perDay);
  const last = totals.at(-1);
  // Runs whose hospitals ran short of beds, and the median day it began.
  const overflowDays = firstOverflows
    .filter((h) => h !== Infinity)
    .map((h) => 1 + Math.floor(h / 24))
    .sort((a, b) => a - b);
  const overflowRuns = round3(overflowDays.length / done);
  // The campaign's protected coverage at the origins by the last day, and R
  // at the end from what is left susceptible where it reached.
  const lastDay = Math.floor((hoursOut - 1) / 24);
  const coverageEnd = vac
    ? round2(
        vacEff *
          Math.min(
            vac.coverageMax,
            (vac.perDay / 1000) *
              Math.max(0, lastDay - vac.startDay - vacProtect),
          ),
      )
    : 0;
  const rEnd = round2(
    params.rEffective *
      quantile(
        rEndFactors.sort((a, b) => a - b),
        50,
      ),
  );
  // How tight the median is for the runs done, and the runs it would take
  // to bring its relative half-width to MC_TARGET_REL.
  const infectedP50 = last?.p50 ?? 0;
  const mcRelHalfWidth =
    infectedP50 > 0 && infectedP50Ci
      ? round2((infectedP50Ci[1] - infectedP50Ci[0]) / (2 * infectedP50))
      : 0;
  const runsSuggested = Math.min(
    500,
    Math.max(50, Math.ceil(done * (mcRelHalfWidth / MC_TARGET_REL) ** 2)),
  );
  // The second strain: where and when it was seeded, its R at day 0, its
  // infections and share by the end, and when it took over (the first day
  // from its seeding with at least half the new infections; 1-based).
  let strain2Summary = {};
  if (twoStrain) {
    const end = dayCount - 1;
    const takeoverDays = [];
    for (const t of dailyTotals)
      // From the day after seeding: the seeds are not transmission.
      for (let d = strain2.day + 1; d < t.length; d += 1) {
        const fresh = t[d][0] - (d > 0 ? t[d - 1][0] : 0);
        const fresh2 = t[d][15] - (d > 0 ? t[d - 1][15] : 0);
        if (fresh > 0 && fresh2 / fresh >= 0.5) {
          takeoverDays.push(d + 1);
          break;
        }
      }
    takeoverDays.sort((a, b) => a - b);
    const takeoverRuns = round3(takeoverDays.length / done);
    const took = takeoverRuns >= 0.5;
    strain2Summary = {
      strain2Day: strain2.day,
      strain2Place:
        strain2Node >= 0
          ? String(nodes[strain2Node].code || nodes[strain2Node].id || '')
          : '',
      strain2Seeded: strain2Hour < hours,
      rStrain2: round2(params.rStrain2 ?? 0),
      strain2InfectedP50: end >= 0 ? band(end, 15)[1] : 0,
      strain2ShareEnd:
        end >= 0
          ? round2(
              quantile(
                dailyTotals
                  .map((t) => t[end][15] / Math.max(1, t[end][0]))
                  .sort((a, b) => a - b),
                50,
              ),
            )
          : 0,
      takeoverRuns,
      takeoverDayP5: took ? quantile(takeoverDays, 5) : null,
      takeoverDayP50: took ? quantile(takeoverDays, 50) : null,
      takeoverDayP95: took ? quantile(takeoverDays, 95) : null,
    };
  }
  // The last day with an Rt in most runs (1-based).
  let rtLastIndex = -1;
  for (let d = totals.length - 1; d >= 0; d -= 1)
    if (totals[d].rtP50 !== null) {
      rtLastIndex = d;
      break;
    }
  const result = {
    startMs,
    untilMs,
    hours,
    runs: done,
    runsAsked: runCount,
    partial,
    ...(stoppedAt ? { stoppedAt } : {}),
    seed,
    places,
    commutes: commutes.slice(0, 120),
    railTrips: railTrips.slice(0, 120),
    railRoutes: railRouteCount,
    totals,
    byDayPlaces: BY_DAY_PLACES,
    ...(trace ? { trace: { runTotals, runEnd, conservation } } : {}),
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
      // Admissions on the hospital pathway; the share of the symptomatic
      // who need a bed on the legacy path.
      hospitalP50: hospitalPath
        ? (last?.admittedP50 ?? 0)
        : Math.round(
            (last?.p50 ?? 0) * (1 - params.asymShare) * params.hospitalShare,
          ),
      icuP50: dayCount ? band(dayCount - 1, 14)[1] : 0,
      peakHospitalP50: dayCount ? peakP50(3) : 0,
      peakIcuP50: dayCount ? peakP50(4) : 0,
      // The peak of new infections a day: when (1-based day), how high, and
      // the share of runs past it by the end.
      peakDayP5,
      peakDayP50,
      peakDayP95,
      peakNewP50,
      peakNewP95,
      peakReached: round3(peaksReached / done),
      ascertainment: params.ascertainment ?? 0.25,
      reportDays: params.reportDays ?? 4,
      placesOverwhelmed: places.filter((p) => p.pOverwhelmed >= 0.5).length,
      overflowRuns,
      overflowDayP50: overflowRuns >= 0.5 ? quantile(overflowDays, 50) : null,
      // The herd-immunity line for this R and susceptibility variation,
      // unrounded; the household share of contacts.
      hitShare: herdImmunityShare(params.rEffective, cv),
      heterogeneityCv: cv,
      householdShare: round2(params.householdShare ?? 0),
      // Immunity at the end (after waning), reinfections, the campaign.
      immuneEndP50: Math.round(
        quantile(
          immuneEnds.sort((a, b) => a - b),
          50,
        ),
      ),
      reinfectedP50: last?.reinfectedP50 ?? 0,
      vaccinatedP50: last?.vaccinatedP50 ?? 0,
      coverageEnd,
      rEnd,
      // Restrictions and their cost: places restricted in most runs,
      // person-days under restriction (unweighted), passengers the ban kept
      // off, travellers screening and quarantine caught, bed-days short, and
      // places whose tests ran out in most runs.
      placesRestricted: places.filter((p) => p.pRestricted >= 0.5).length,
      restrictedPersonDaysP50: runQuantile(restrictedPersonDaysRuns, 50),
      restrictedPersonDaysP95: runQuantile(restrictedPersonDaysRuns, 95),
      passengersBlockedP50: runQuantile(passengersBlockedRuns),
      travellersCaughtP50: runQuantile(travellersCaughtRuns),
      bedDaysShortP50: runQuantile(bedDaysShortRuns),
      testsSaturatedPlaces: places.filter((p) => p.pTestsSaturated >= 0.5)
        .length,
      // Borders and imports: countries closed at the end and reached in most
      // runs, travellers who landed infected and their share of all cases,
      // when it was first reported outside the outbreak countries, and the
      // transfer batches that flew on.
      countriesClosedP50: last?.countriesClosedP50 ?? 0,
      countriesReached: reachedCountries.size,
      importedP50: last?.importedP50 ?? 0,
      importedShare: round2(
        (last?.importedP50 ?? 0) / Math.max(1, last?.p50 ?? 0),
      ),
      // The median among the runs with a report abroad; null when fewer
      // than half have one.
      firstDetectedAbroadP50: (() => {
        const abroad = firstAbroadReports
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        return abroad.length >= 0.5 * done ? quantile(abroad, 50) : null;
      })(),
      transfersFlown: runQuantile(transfersFlownRuns),
      // The ensemble itself: the intervals round the medians, the runs
      // that died out against the chance the seeds take hold, how tight
      // the median is and the runs that would tighten it, and what the
      // time limit had room for (run 0's wall time only when it cut in).
      infectedP50Ci,
      deathsP50Ci: endInterval(2),
      reportedP50Ci: endInterval(1),
      pExtinct: round3(extinctRuns / done),
      establishmentSeeds: round2(
        1 -
          (1 - establishmentProbability(params.rEffective, params.k)) **
            (params.initialCases ?? 0),
      ),
      mcRelHalfWidth,
      runsSuggested,
      ...(partial ? { runTimeMs: Math.max(0, Math.round(runTimeMs)) } : {}),
      runsFit,
      // Rt in the runs: its last day and median, and the mean generation
      // interval of the kernel it is read with.
      rtLastDay: rtLastIndex >= 0 ? rtLastIndex + 1 : null,
      rtLastP50: rtLastIndex >= 0 ? totals[rtLastIndex].rtP50 : null,
      generationDays: kernel.meanDays,
      ...strain2Summary,
    },
  };
  if (pairs) {
    result._pairs = { daily: dailyTotals };
    result._runTimeMs = runTimeMs;
  }
  return result;
}

/** The comparison line's wording of each set. */
const CF_PHRASE = Object.freeze({
  all: 'All measures vs none',
  travel: 'Travel measures vs none',
  distancing: 'Lockdown and tracing vs none',
  vaccination: 'Vaccination campaign vs none',
});

/**
 * Run the ensemble (see simulateEnsemble for the input). With
 * `params.compare` set (not 'none'), a second arm runs the same scenario
 * without that set of measures (COUNTERFACTUAL_SETS), run r of both arms on
 * the same substream, so pair r is common-random-number paired. The main
 * arm gets half the budget and the second arm what is left; both share one
 * deadline, the links and the clock. The result is the main arm's, with
 * `counterfactual` (arm B's medians and the paired difference, positive
 * when the measures helped) and each day's `counterfactualP50` and
 * `avertedP50`. Without a comparison it is simulateEnsemble's own result.
 *
 * @param {object} input
 * @returns {object}
 */
export function simulateEpidemic(input) {
  const compare = input?.params?.compare;
  if (!(compare && compare !== 'none')) return simulateEnsemble(input);
  const budgetMs = input.budgetMs ?? EPIDEMIC_BUDGET_MS;
  const now = input.now ?? Date.now;
  const links = input.links ?? gravityLinks(input.nodes);
  const paramsB = counterfactualParams(input.params, compare);
  const t0 = now();
  const A = simulateEnsemble(
    { ...input, links, now, budgetMs: budgetMs / 2 },
    { pairs: true },
  );
  // Past the deadline already: the second arm is skipped.
  const B = A.stoppedAt
    ? null
    : simulateEnsemble(
        {
          ...input,
          links,
          now,
          params: paramsB,
          runs: A.runs,
          trace: false,
          budgetMs: Math.max(0, budgetMs - (now() - t0)),
        },
        { pairs: true, light: true },
      );
  // B's runs are a prefix of A's; a B run 0 cut short pairs with nothing.
  const pairs = B ? (B.stoppedAt?.run === 0 ? 0 : B.runs) : 0;
  const { _pairs: pairsA, _runTimeMs: runTimeA, ...result } = A;
  const runTimeB = B ? B._runTimeMs : 0;
  const both = runTimeA + runTimeB;
  const fit = Math.floor(budgetMs / both);
  result.summary.runsFit =
    Number.isFinite(fit) && both > 0 ? Math.min(A.runsAsked, fit) : A.runsAsked;
  result.partial = A.partial || pairs < A.runs;
  const label =
    EPI_INTERVENTION_CHOICES.find((c) => c.key === 'compare').options.find(
      (o) => o.id === compare,
    )?.label ?? compare;
  const rControlled = round2(paramsB.rEffectiveControlled);
  const dailyA = pairsA.daily.slice(0, pairs);
  const dailyB = B ? B._pairs.daily.slice(0, pairs) : [];
  const sorted = (list) => list.sort((a, b) => a - b);
  const median = (list) => Math.round(quantile(sorted(list), 50));
  for (const [d, day] of result.totals.entries()) {
    day.counterfactualP50 = pairs ? median(dailyB.map((t) => t[d][0])) : null;
    day.avertedP50 = pairs
      ? median(dailyB.map((t, r) => t[d][0] - dailyA[r][d][0]))
      : null;
  }
  const end = (t, k) => t.at(-1)[k];
  const peak = (t, k) => t.reduce((top, row) => Math.max(top, row[k]), 0);
  const paired = (of, k) => dailyB.map((t, r) => of(t, k) - of(dailyA[r], k));
  if (input.trace)
    result.trace = {
      ...result.trace,
      paired: {
        infected: paired(end, 0),
        deaths: paired(end, 2),
        peakHospital: paired(peak, 3),
      },
      runTotalsB: dailyB.map((t) => t.at(-1).slice()),
    };
  if (!pairs) {
    result.counterfactual = { compare, label, runs: 0, cut: true, rControlled };
    return result;
  }
  const spread = (name, list) => {
    const s = sorted(list);
    return {
      [`${name}P5`]: Math.round(quantile(s, 5)),
      [`${name}P50`]: Math.round(quantile(s, 50)),
      [`${name}P95`]: Math.round(quantile(s, 95)),
      [`${name}Ci`]: quantileInterval(s, 0.5),
    };
  };
  result.counterfactual = {
    compare,
    label,
    runs: pairs,
    rControlled,
    infectedP50: median(dailyB.map((t) => end(t, 0))),
    deathsP50: median(dailyB.map((t) => end(t, 2))),
    peakHospitalP50: median(dailyB.map((t) => peak(t, 3))),
    averted: {
      ...spread('infected', paired(end, 0)),
      ...spread('deaths', paired(end, 2)),
      ...spread('peakHospital', paired(peak, 3)),
      reportedP50: median(paired(end, 1)),
    },
  };
  return result;
}

/**
 * Daytime population of each place under two-way mixing: its own people who
 * stay, (1 − Σ shares out) × N, plus the commuters in, Σ share × N of the
 * places commuting to it (Balcan et al. 2009). Sums to Σ N over all places.
 *
 * @param {{population?: number}[]} nodes
 * @param {{j: number, share: number}[][]} links Commuting shares out of each place.
 * @returns {Float64Array}
 */
export function daytimePopulations(nodes, links) {
  const n = nodes.length;
  const N = new Float64Array(n);
  const home = new Float64Array(n).fill(1);
  const daytimeN = new Float64Array(n);
  for (let i = 0; i < n; i += 1)
    N[i] = Math.max(1, Math.round(nodes[i].population || 1));
  for (let i = 0; i < n; i += 1)
    for (const link of links[i] || []) {
      home[i] -= link.share;
      daytimeN[link.j] += link.share * N[i];
    }
  const Ntilde = new Float64Array(n);
  for (let i = 0; i < n; i += 1) Ntilde[i] = home[i] * N[i] + daytimeN[i];
  return Ntilde;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
/** Three decimals, for shares of runs. */
export function round3(n) {
  return Math.round(n * 1000) / 1000;
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

/**
 * The epidemic result in lines, for the box and the language model: the
 * headline lines, then one line for every place it reached, in result order
 * (no limit by default; pass `max` to bound a prompt).
 */
export function epidemicLines(
  result,
  { startMs = result?.startMs, max = Infinity } = {},
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
  const pct = (share) => Math.round((share || 0) * 100);
  const plural = (n, one, many) => (n === 1 ? one : many);
  // A result from before the upgrade has none of the new fields: every
  // clause below is guarded, so it reads as it always did.
  const lines = [
    `R0 ${s.r0} · R now ${s.rEffective}${s.rFactors?.length ? ` (${s.rFactors.map((f) => `${f.label} ×${f.factor}`).join(', ')})` : ''}${s.rControlled !== s.rEffective ? ` · with interventions ${s.rControlled}` : ''} · doubling ${s.doublingDays ?? '—'} d · one import takes hold ${Math.round((s.establishment || 0) * 100)} %${s.heterogeneityCv > 0 ? ` · herd immunity at ${pct(s.hitShare)} %` : ''}${s.placesRestricted > 0 ? ` · local restrictions in ${s.placesRestricted} ${plural(s.placesRestricted, 'place', 'places')}` : ''}${s.countriesClosedP50 > 0 ? ` · borders closed for ${s.countriesClosedP50} ${plural(s.countriesClosedP50, 'country', 'countries')}` : ''}${s.coverageEnd > 0 ? ` · R at the end ${s.rEnd} (vaccination ${pct(s.coverageEnd)} %)` : ''}`,
    `Infected by the end (median, 95th): ${count(s.infectedP50)} · ${count(s.infectedP95)} · ${result.runs} runs, seed ${result.seed}${result.partial ? (result.stoppedAt?.run === 0 ? ` (time limit: one run, stopped at day ${Math.ceil(result.stoppedAt.hour / 24)})` : result.counterfactual && !(result.runs < result.runsAsked) ? ' (time limit: fewer paired runs)' : ' (time limit: fewer runs)') : ''}${Array.isArray(s.infectedP50Ci) ? ` · Monte-Carlo range ${count(s.infectedP50Ci[0])}–${count(s.infectedP50Ci[1])}` : ''}${s.establishmentSeeds !== undefined && s.establishmentSeeds <= 0.99 ? ` · ${pct(s.pExtinct)} % of runs died out` : ''}`,
  ];
  const lastDay = result.totals?.at?.(-1);
  if (s.reportedP50 !== undefined)
    lines.push(
      `Reported: ${count(s.reportedP50)} (${Math.round((s.ascertainment || 0) * 100)} % of cases with symptoms, ~${s.reportDays} d late) · deaths ${count(s.deathsP50)} (95th ${count(s.deathsP95)})${s.placesOverwhelmed ? ` · hospitals overwhelmed in ${s.placesOverwhelmed} place${s.placesOverwhelmed === 1 ? '' : 's'}` : ''}${s.peakHospitalP50 !== undefined && lastDay?.admittedP50 > 0 ? ` · hospital peak ${count(s.peakHospitalP50)} (ICU ${count(s.peakIcuP50)})` : ''}${s.importedP50 > 0 ? ` · imported ${count(s.importedP50)} (${pct(s.importedShare)} % of cases)` : ''}${s.testsSaturatedPlaces > 0 ? ` · tests saturated in ${s.testsSaturatedPlaces} ${plural(s.testsSaturatedPlaces, 'place', 'places')}` : ''}`,
    );
  if (s.peakDayP50 !== undefined) {
    const peak =
      s.peakReached >= 0.5
        ? `Peak: day ${s.peakDayP50} (5–95 %: ${s.peakDayP5}–${s.peakDayP95}), ${count(s.peakNewP50)} new a day`
        : `Peak: not inside the window (day ${s.peakDayP50} so far, ${count(s.peakNewP50)} new a day)`;
    const short =
      s.overflowRuns > 0
        ? s.overflowDayP50 === null || s.overflowDayP50 === undefined
          ? ` · hospitals short of beds in ${pct(s.overflowRuns)} % of runs`
          : ` · hospitals short of beds from ${at(24 * (s.overflowDayP50 - 1))} in ${pct(s.overflowRuns)} % of runs`
        : '';
    const rtDay =
      s.rtLastP50 !== null && s.rtLastP50 !== undefined
        ? result.totals?.[s.rtLastDay - 1]
        : null;
    const rt = rtDay
      ? ` · Rt in the runs ${s.rtLastP50} on day ${s.rtLastDay} (5–95 %: ${rtDay.rtP5}–${rtDay.rtP95})`
      : '';
    lines.push(peak + short + rt);
  }
  if (s.strain2Day !== undefined)
    lines.push(
      !s.strain2Seeded
        ? `Second strain: not seeded inside the window (day ${s.strain2Day + 1})`
        : `Second strain: from day ${s.strain2Day + 1} at ${s.strain2Place || 'the outbreak places'} · R ${s.rStrain2} · ${pct(s.strain2ShareEnd)} % of infections by the end · ` +
            (s.takeoverDayP50 !== null && s.takeoverDayP50 !== undefined
              ? `took over on day ${s.takeoverDayP50} (5–95 %: ${s.takeoverDayP5}–${s.takeoverDayP95})`
              : `took over in ${pct(s.takeoverRuns)} % of runs`),
    );
  if (
    s.restrictedPersonDaysP50 > 0 ||
    s.passengersBlockedP50 > 0 ||
    s.travellersCaughtP50 > 0 ||
    s.bedDaysShortP50 > 0
  )
    lines.push(
      `Cost: ${count(s.restrictedPersonDaysP50)} person-days of restriction · ${count(s.passengersBlockedP50)} passengers blocked · ${count(s.travellersCaughtP50)} travellers caught · ${count(s.bedDaysShortP50)} bed-days short`,
    );
  const cf = result.counterfactual;
  if (cf) {
    // A positive difference is fewer with the measures.
    const fewer = (v, noun) =>
      v >= 0 ? `${count(v)} fewer ${noun}` : `${count(-v)} more ${noun}`;
    const a = cf.averted;
    lines.push(
      cf.runs > 0 && a
        ? `${CF_PHRASE[cf.compare]} (${cf.runs} paired runs): ${fewer(a.infectedP50, 'infections')} (5–95 %: ${count(a.infectedP5)}–${count(a.infectedP95)}) · ${fewer(a.deathsP50, 'deaths')} · hospital peak ${fewer(a.peakHospitalP50, 'patients')}`
        : 'Comparison skipped: the time limit was reached before the comparison could run',
    );
  }
  for (const place of result.places.filter((p) => !p.origin).slice(0, max))
    lines.push(
      `${place.code ? `${place.code} ` : ''}${place.name}: ${Math.round(place.pArrive * 100)} %${arrivalWords(place, at)}${reportWords(place, at)}${place.pImportedFirst > 0 ? ` · first case imported in ${pct(place.pImportedFirst)} %` : ''}${place.localBy50 !== null && place.localBy50 !== undefined ? ` · local spread by ${at(place.localBy50)} in ${pct(place.pLocal)} %` : ''}`,
    );
  return lines;
}
