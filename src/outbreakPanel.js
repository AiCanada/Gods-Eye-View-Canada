/**
 * OUTBREAK LOCATIONS & PREDICTED SPREAD: the left-hand box.
 *
 * It keeps the outbreak locations (Irkutsk and Shelekhov to start; any can
 * be added by name or removed), scans the travel out of them since the scan
 * began, works out how far each way of travel could have carried the
 * outbreak by the hour picked (src/outbreakCore.mjs), and hands that to the
 * Outbreak map layer on OUTBREAK_MODEL_EVENT.
 *
 * SCAN TRAVEL:
 *  - OpenStreetMap near each location: is there a railway station (train
 *    spread), the area's train speed from its rail lines, and water traffic
 *    within 100 km (boat spread);
 *  - flight history out of the airports near each location and the
 *    connecting flights out of where they landed (OpenSky, POWER UP →
 *    OPENSKY); without that account, the chosen language model's knowledge
 *    of airline schedules, read from a list of real airports.
 * MEDIA SEARCH: a global news search (GDELT), then the chosen language model
 * (the Ask route) names the new places those articles report.
 * SOCIAL SEARCH: the Grok Bot or OpenAI DOTS swarm (the Social Media
 * Analysis route), one bot per platform, on that swarm's own key; answers
 * land in this box.
 * New places found are listed for the operator to add; none is added alone.
 * RUN EPIDEMIC MODEL: the server's stochastic simulation (src/outbreakEpi.mjs)
 * over the scan, the pathogen, the people and the interventions; each place's
 * chance of arrival goes to the map with the spread. A Random seed box makes
 * a run repeatable (blank: the server derives one from the inputs); the
 * result is kept across reloads when it is small enough, and DOWNLOAD RESULTS
 * / DOWNLOAD CSV save it (src/outbreakEpiExport.mjs).
 */
import { formatAskLogEntry, prependOutputLog } from './askOverview.js';
import { geocodeKeyless } from './keylessGeocoder.js';
import { SOCIAL_SWARM_BOTS, SOCIAL_SWARM_PROVIDERS } from './socialSwarm.mjs';
import { formatSwarmDesktopStatus, runSocialSwarm } from './socialSwarmRun.mjs';
import {
  CONNECTING_AIRPORTS_MAX,
  FUTURE_FLIGHT_HOURS,
  CONNECTION_HOURS,
  OUTBREAK_ANSWER_TOKENS,
  OUTBREAK_FORECAST_BOUNDS,
  OUTBREAK_FORECAST_HORIZONS,
  OUTBREAK_FUTURE_HOURS,
  OUTBREAK_MODEL_EVENT,
  OUTBREAK_REQUEST_EVENT,
  OUTBREAK_MODE_IDS,
  OUTBREAK_SCAN_DAYS_DEFAULT,
  OUTBREAK_SCAN_DAY_OPTIONS,
  OUTBREAK_SHOWN_EVENT,
  OUTBREAK_STORAGE_KEY,
  candidateLine,
  airportInfectedAfterHours,
  cleanContagion,
  cleanProfile,
  HUMAN_FACTORS,
  suggestedContagion,
  contagionLabel,
  cleanFlight,
  cleanForecastHorizon,
  cleanForecastWithin,
  cleanLocation,
  cleanLocations,
  forecastWindowLabel,
  forecastWindowStart,
  forecastWindows,
  cleanSpeed,
  outbreakHourOptions,
  outbreakMediaQuestion,
  outbreakRoutesQuestion,
  outbreakSocialInstructions,
  outbreakForecastQuestion,
  outbreakForecastScene,
  outbreakSpread,
  parseForecastLines,
  outbreakViewTarget,
  parsePlaceLines,
  parseRouteLines,
  presentHour,
  scanStartMs,
  spreadSummary,
  timeScheduleRoutes,
  unpackTraffic,
} from './outbreakCore.mjs';
import {
  EPI_HUMAN_FACTORS,
  EPI_INTERVENTION_CHOICES,
  OUTBREAK_DEFAULT_PROFILE,
  PATHOGEN_PRESETS,
  SUPERSPREADING,
  cleanEpiProfile,
  epidemicLines,
  presetValues,
} from './outbreakEpi.mjs';
import {
  epidemicExport,
  epidemicPlacesCsv,
  epidemicTotalsCsv,
} from './outbreakEpiExport.mjs';

const PROVIDERS_URL = '/api/llm/providers';
const ASK_URL = '/api/llm/ask';
const API = '/api/outbreak';
const DEFAULT_ASK_TIMEOUT_MS = 90_000;
const CLIENT_TIMEOUT_MARGIN_MS = 10_000;
/** PLAY's step: long enough for the map to finish drawing each hour. */
const PLAY_STEP_MS = 900;
/**
 * The epidemic model may take a while: many runs over many places. Longer
 * than the server's 58 s limit and its worker's 73 s hard stop, so a long
 * run is never given up on here first.
 */
const EPIDEMIC_TIMEOUT_MS = 90_000;
/** Raised when OUTBREAK_DEFAULT_PROFILE changes, so it fills in once more. */
export const PROFILE_DEFAULTS_VERSION = 3;
/** How far ahead the epidemic model looks, in days. */
const EPIDEMIC_FORECAST_DAYS = Object.freeze([2, 7, 14, 30]);
/**
 * The curve's hospital and intensive-care lines and the peak-day tick; the
 * second strain, the comparison run and the Rt line when the result has them.
 */
const EPIDEMIC_CURVE_COLORS = Object.freeze({
  hospital: '#4a9bff',
  icu: '#9b5cff',
  peak: '#ffffff',
  strain2: '#ff6bd6',
  compare: '#19e6b0',
  rt: '#c8f04a',
});
/** The top of the curve's Rt scale (a higher Rt is drawn at the top). */
const RT_CURVE_MAX = 3;
/**
 * The epidemic result is kept across reloads twice: whole in IndexedDB
 * (fullResultStore), and trimmed in localStorage as the fallback: the first
 * 500 places and none of it when the saved JSON would pass 1.5 MB
 * (localStorage holds about 5 MB for the whole site). A trimmed copy says
 * how many places the run had (`trimmed`), so the list and the downloads
 * can say they are short.
 */
export const EPIDEMIC_PERSIST_MAX_BYTES = 1_500_000;
export const EPIDEMIC_PERSIST_PLACES = 500;
/** What the trimmed result keeps, besides its places. */
const EPIDEMIC_PERSIST_KEYS = Object.freeze([
  'startMs',
  'untilMs',
  'hours',
  'runs',
  'runsAsked',
  'partial',
  'seed',
  'summary',
  'totals',
  'commutes',
  'railTrips',
  'railRoutes',
  'railSource',
  'byDayPlaces',
  'network',
  'populationSource',
  'sensitivity',
  'counterfactual',
  'stoppedAt',
]);
/** The Random seed box: a whole number the server's rng takes, else auto (null). */
const SEED_MAX = 2 ** 32;

/** The seed as the box or the saved state has it: an integer in [0, 2^32), else null. */
export function cleanSeed(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < SEED_MAX ? n : null;
}

/**
 * The epidemic result trimmed for storage, or null when even trimmed it is
 * too big to keep. The kept places are whole (byDay included where present).
 */
export function trimmedEpidemic(data) {
  if (!data || !Array.isArray(data.places)) return null;
  const kept = {};
  for (const key of EPIDEMIC_PERSIST_KEYS)
    if (data[key] !== undefined) kept[key] = data[key];
  kept.places = data.places.slice(0, EPIDEMIC_PERSIST_PLACES);
  // How many places the run had, when some were left out.
  const total = Number.isFinite(data.trimmed)
    ? Math.max(data.trimmed, data.places.length)
    : data.places.length;
  if (total > kept.places.length) kept.trimmed = total;
  return JSON.stringify(kept).length > EPIDEMIC_PERSIST_MAX_BYTES ? null : kept;
}

/** The note for a result that is a trimmed saved copy, else ''. */
export function epidemicTrimmedNote(result) {
  const shown = Array.isArray(result?.places) ? result.places.length : 0;
  return Number.isFinite(result?.trimmed) && result.trimmed > shown
    ? `Saved result trimmed to ${shown.toLocaleString('en-US')} of ${result.trimmed.toLocaleString('en-US')} places; run again for every place.`
    : '';
}

const FULL_RESULT_DB = 'outbreak-epidemic';
const FULL_RESULT_STORE = 'results';

/**
 * The whole epidemic result, kept in IndexedDB (no 5 MB localStorage limit):
 * get(key), put(key, value) and delete(key), each a promise. null when this
 * browser has no IndexedDB. Every failure rejects; the panel catches it and
 * falls back to the trimmed copy.
 */
export function fullResultStore(idb) {
  let factory = idb;
  if (factory === undefined)
    try {
      factory = globalThis.indexedDB;
    } catch {
      factory = null;
    }
  if (!factory || typeof factory.open !== 'function') return null;
  let opened = null;
  const open = () =>
    (opened ||= new Promise((resolve, reject) => {
      const request = factory.open(FULL_RESULT_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(FULL_RESULT_STORE))
          request.result.createObjectStore(FULL_RESULT_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB blocked'));
    }).catch((error) => {
      opened = null;
      throw error;
    }));
  const run = (mode, act) =>
    open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(FULL_RESULT_STORE, mode);
          const request = act(tx.objectStore(FULL_RESULT_STORE));
          tx.oncomplete = () => resolve(request.result);
          tx.onerror = () => reject(tx.error || request.error);
          tx.onabort = () => reject(tx.error || new Error('aborted'));
        }),
    );
  return {
    get: (key) => run('readonly', (store) => store.get(key)),
    put: (key, value) => run('readwrite', (store) => store.put(value, key)),
    delete: (key) => run('readwrite', (store) => store.delete(key)),
  };
}

/** A whole number with thousands commas (0 when unset). */
function count(n) {
  return Math.round(n || 0).toLocaleString('en-US');
}

/** A share (0-1) as a whole percent. */
function pct(share) {
  return Math.round((share || 0) * 100);
}

/** "N fewer things", or "N more things" when the difference is negative. */
function fewer(n, noun) {
  return n >= 0 ? `${count(n)} fewer ${noun}` : `${count(-n)} more ${noun}`;
}

/** The curve's third legend: Rt, the second strain and the comparison run. */
function curveExtras(s, cf) {
  const parts = [];
  if (s.rtLastP50 !== null && s.rtLastP50 !== undefined)
    parts.push(
      `Rt in the runs, day ${s.rtLastDay}: ${s.rtLastP50} (line at 1 = holding steady; generation ${s.generationDays} d)`,
    );
  if (s.strain2Day !== undefined)
    parts.push(
      s.strain2Seeded
        ? `second strain ${pct(s.strain2ShareEnd)} % of infections` +
            (s.takeoverDayP50 !== null && s.takeoverDayP50 !== undefined
              ? ` · took over on day ${s.takeoverDayP50}`
              : '')
        : 'second strain not seeded inside the window',
    );
  if (cf?.runs > 0)
    parts.push(
      `vs ${cf.label.toLowerCase()}: ${fewer(cf.averted.infectedP50, 'infected')} (5–95 %: ${count(cf.averted.infectedP5)}–${count(cf.averted.infectedP95)}) · ${fewer(cf.averted.deathsP50, 'deaths')}`,
    );
  else if (cf?.cut) parts.push('comparison skipped (time limit)');
  return parts;
}

/**
 * EVERY RAIL LINE ON THE GLOBE (owner ruling 2026-10-12): the status line
 * while the server finds and builds the world rail, polled this often, and
 * after a failed poll this long.
 */
export const RAIL_WORLD_POLL_MS = 10_000;
const RAIL_WORLD_RETRY_MS = 60_000;

/** The world rail's status as one line of text. */
export function railWorldLine(status) {
  const done = count(status?.tilesDone);
  const total = count(status?.tilesTotal);
  const km = count(status?.railKm);
  if (status?.state === 'ready')
    return `World rail: ${km} km from ${done} map tiles, every continent's.`;
  if (status?.state === 'building')
    return `World rail: ${done} / ${total} tiles · joining the lines into one network…`;
  if (status?.state === 'error')
    return `World rail: ${status.error || 'failed'}; rail works as before.`;
  return `World rail: ${done} / ${total} tiles${status?.railKm ? ` · ${km} km` : ''}; rail works as before until it is done.`;
}

/** Roads come in three levels, each farther; rail in one. */
const ROAD_LEVELS = 3;
function networkDone(entry, mode) {
  return (
    mode === 'rail' || entry.lastLevel || (entry.level || 1) >= ROAD_LEVELS
  );
}

/** Everything the box keeps about the outbreak: pathogen, people, interventions. */
function cleanAllProfile(raw) {
  return { ...cleanProfile(raw), ...cleanEpiProfile(raw) };
}

/** The menus filled from the epidemic model's tables, by profile key. */
const FILLED_MENUS = Object.freeze({
  preset: PATHOGEN_PRESETS,
  superspreading: SUPERSPREADING,
  ...Object.fromEntries(
    [...EPI_HUMAN_FACTORS, ...EPI_INTERVENTION_CHOICES].map((f) => [
      f.key,
      f.options,
    ]),
  ),
});

function timeLabel(ms) {
  const at = new Date(ms);
  return Number.isNaN(at.getTime())
    ? ''
    : `${String(at.getUTCDate()).padStart(2, '0')} ${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export class OutbreakPanel {
  /**
   * @param {object} viewer The Cesium viewer (unused today; kept like the other boxes).
   * @param {{document?: Document, fetch?: Function, storage?: Storage|null, resultStore?: object|null, windowRef?: Window|null, geocode?: Function, now?: Function}} [options]
   */
  constructor(viewer, options = {}) {
    this.viewer = viewer;
    const doc = options.document || globalThis.document;
    this._doc = doc;
    this._fetch = options.fetch || null;
    this._window =
      options.windowRef ?? (typeof window === 'undefined' ? null : window);
    this._storage =
      options.storage !== undefined
        ? options.storage
        : (() => {
            try {
              return globalThis.localStorage || null;
            } catch {
              return null;
            }
          })();
    // The whole epidemic result across reloads (fullResultStore).
    this._resultStore =
      options.resultStore !== undefined
        ? options.resultStore
        : fullResultStore();
    this._geocode = options.geocode || ((name) => geocodeKeyless(name));
    this._now = options.now || (() => Date.now());
    this._askTimeoutMs = DEFAULT_ASK_TIMEOUT_MS;
    this._busy = '';
    this._playTimer = null;
    // The layer, once listening, asks for the model: a reload with the
    // spread shown draws it again.
    this._onRequest = () => {
      if (this._state) this._send(this._state.show ? { show: true } : {});
    };
    this._onShown = (event) => {
      const shown = Boolean(event?.detail?.shown);
      if (this._showBox) this._showBox.checked = shown;
      if (this._state.show !== shown) {
        this._state.show = shown;
        this._save();
      }
    };

    const byId = (id) => doc?.getElementById?.(id) || null;
    this._root = byId('outbreak-panel');
    if (!this._root) return;
    this._showBox = byId('outbreak-show');
    this._clearBtn = byId('outbreak-clear');
    this._clearMapBtn = byId('outbreak-clear-map');
    this._list = byId('outbreak-locations');
    this._addForm = byId('outbreak-add');
    this._addName = byId('outbreak-add-name');
    this._keywords = byId('outbreak-keywords');
    this._days = byId('outbreak-days');
    this._scanBtn = byId('outbreak-scan');
    this._scanNote = byId('outbreak-scan-note');
    this._hour = byId('outbreak-hour');
    this._playBtn = byId('outbreak-play');
    this._futurePlayBtn = byId('outbreak-play-future');
    this._contagion = byId('outbreak-contagion');
    this._contagionValue = byId('outbreak-contagion-value');
    this._contagionNote = byId('outbreak-contagion-note');
    this._profileFields = {
      transmission: byId('outbreak-transmission'),
      r0: byId('outbreak-r0'),
      asymptomatic: byId('outbreak-asymptomatic'),
      incubationDays: byId('outbreak-incubation'),
      mutation: byId('outbreak-mutation'),
      density: byId('outbreak-density'),
      densityNew: byId('outbreak-density-new'),
      travel: byId('outbreak-travel'),
      compliance: byId('outbreak-compliance'),
      vulnerability: byId('outbreak-vulnerability'),
      season: byId('outbreak-season'),
      immunity: byId('outbreak-immunity'),
      preset: byId('outbreak-preset'),
      latentDays: byId('outbreak-latent'),
      infectiousDays: byId('outbreak-infectious'),
      asymptomaticPct: byId('outbreak-asym-pct'),
      asymRelative: byId('outbreak-asym-relative'),
      superspreading: byId('outbreak-superspreading'),
      hospitalPct: byId('outbreak-hospital'),
      fatalityPct: byId('outbreak-fatality'),
      age: byId('outbreak-age'),
      household: byId('outbreak-household'),
      healthcare: byId('outbreak-healthcare'),
      gathering: byId('outbreak-gathering'),
      holiday: byId('outbreak-holiday'),
      transit: byId('outbreak-transit'),
      reservoir: byId('outbreak-reservoir'),
      response: byId('outbreak-response'),
      interventionHour: byId('outbreak-intervention-hour'),
      travelBanPct: byId('outbreak-travel-ban'),
      exitScreening: byId('outbreak-exit-screening'),
      entryScreening: byId('outbreak-entry-screening'),
      quarantineDays: byId('outbreak-quarantine'),
      lockdownPct: byId('outbreak-lockdown'),
      tracing: byId('outbreak-tracing'),
      initialCases: byId('outbreak-initial-cases'),
      // The hospital pathway, immunity and variants (pathogen grid).
      hospitalDays: byId('outbreak-hospital-days'),
      icuPct: byId('outbreak-icu'),
      admitDelayDays: byId('outbreak-admit-delay'),
      waningDays: byId('outbreak-waning'),
      variants: byId('outbreak-variants'),
      // The second strain, used when variants is 'two-strain'.
      strain2Day: byId('outbreak-strain2-day'),
      strain2Cases: byId('outbreak-strain2-cases'),
      strain2Place: byId('outbreak-strain2-place'),
      strain2Pct: byId('outbreak-strain2-spread'),
      strain2SeverityPct: byId('outbreak-strain2-severity'),
      crossImmunityPct: byId('outbreak-cross-immunity'),
      // Susceptibility, commuting, transfers, awareness, vaccination, travel
      // (human grid).
      heterogeneity: byId('outbreak-heterogeneity'),
      mixing: byId('outbreak-mixing'),
      commuteDaySplit: byId('outbreak-commute-day'),
      clock: byId('outbreak-clock'),
      transfers: byId('outbreak-transfers'),
      responseSignal: byId('outbreak-response-signal'),
      responseReach: byId('outbreak-response-reach'),
      fatigueDays: byId('outbreak-response-fatigue'),
      vaccinatedPct: byId('outbreak-vaccinated'),
      vaccineEfficacyPct: byId('outbreak-vaccine-efficacy'),
      travelDomesticPct: byId('outbreak-travel-domestic'),
      travelIntlPct: byId('outbreak-travel-intl'),
      // Triggers, borders, testing and the campaign (interventions grid).
      interventionDays: byId('outbreak-intervention-days'),
      triggerMode: byId('outbreak-trigger-mode'),
      triggerPer100k: byId('outbreak-trigger-level'),
      triggerBedShare: byId('outbreak-trigger-beds'),
      minLockDays: byId('outbreak-min-lock-days'),
      fatigueHalfDays: byId('outbreak-restriction-fatigue'),
      lockdownScope: byId('outbreak-lockdown-scope'),
      borderPolicy: byId('outbreak-border-policy'),
      borderTrigger: byId('outbreak-border-trigger'),
      importDetection: byId('outbreak-import-detection'),
      testsPer1000Day: byId('outbreak-test-capacity'),
      vaccineStartDay: byId('outbreak-vaccine-start'),
      vaccinePer1000Day: byId('outbreak-vaccine-pace'),
      vaccineCoverageMaxPct: byId('outbreak-vaccine-cap'),
      vaccinePriority: byId('outbreak-vaccine-priority'),
      // A paired comparison run against fewer measures.
      compare: byId('outbreak-compare'),
    };
    // The two density menus: people in the area, from HUMAN_FACTORS.
    for (const key of ['density', 'densityNew']) {
      const select = this._profileFields[key];
      const factor = HUMAN_FACTORS.find((f) => f.key === key);
      if (!select || !factor || !doc) continue;
      for (const option of factor.options) {
        const el = doc.createElement('option');
        el.value = option.id;
        el.textContent = option.label;
        select.appendChild(el);
      }
    }
    // The epidemic model's menus, from its own tables.
    for (const [key, options] of Object.entries(FILLED_MENUS)) {
      const select = this._profileFields[key];
      if (!select || !doc) continue;
      for (const option of options) {
        const el = doc.createElement('option');
        el.value = option.id;
        el.textContent = option.label;
        select.appendChild(el);
      }
    }
    this._epiRunBtn = byId('outbreak-epi-run');
    this._epiRuns = byId('outbreak-epi-runs');
    this._epiShow = byId('outbreak-mode-epidemic');
    this._epiList = byId('outbreak-epidemic');
    this._epiDays = byId('outbreak-epi-days');
    this._epiCurve = byId('outbreak-epi-curve');
    this._epiSeed = byId('outbreak-epi-seed');
    this._epiDownload = byId('outbreak-epi-download');
    this._epiCsv = byId('outbreak-epi-csv');
    this._epidemic = null;
    /** The body of the last run (plus flightCount): saved with the result. */
    this._lastRequest = null;
    this._persistWarned = false;
    this._suggest = byId('outbreak-suggest');
    this._useSuggested = byId('outbreak-use-suggested');
    this._summary = byId('outbreak-summary');
    this._destinations = byId('outbreak-destinations');
    this._model = byId('outbreak-model');
    this._mediaBtn = byId('outbreak-media');
    this._swarm = byId('outbreak-swarm');
    this._socialBtn = byId('outbreak-social');
    this._futureBtn = byId('outbreak-future');
    // How far ahead FIND FUTURE SPREAD LOCATIONS looks: 24 h to 30 days.
    this._futureDays = byId('outbreak-future-days');
    if (this._futureDays && doc && !this._futureDays.children?.length)
      for (const hours of OUTBREAK_FORECAST_HORIZONS) {
        const el = doc.createElement('option');
        el.value = String(hours);
        el.textContent =
          hours < 72 ? `Next ${hours} hours` : `Next ${hours / 24} days`;
        this._futureDays.appendChild(el);
      }
    this._forecastList = byId('outbreak-forecast');
    this._found = byId('outbreak-found');
    this._status = byId('outbreak-status');
    this._output = byId('outbreak-output');
    this._modeBoxes = {};
    this._speedBoxes = {};
    for (const mode of OUTBREAK_MODE_IDS) {
      this._modeBoxes[mode] = byId(`outbreak-mode-${mode}`);
      this._speedBoxes[mode] = byId(`outbreak-speed-${mode}`);
    }

    this._state = this._load();
    // A result saved before the reload is shown and sent again as it was.
    this._epidemic = this._state.epidemic;
    this._fillControls();
    this._renderLocations();
    this._renderFound();
    this._renderForecast();
    this._renderEpidemic();
    this._refresh();
    this._send(this._state.show ? { show: true } : {});
    if (this._epidemic) this._say(this._epidemicStatus('(saved result)'));
    // The whole result, when IndexedDB kept it, replaces the trimmed copy.
    this._restored = this._restoreFullEpidemic();

    this._showBox?.addEventListener('change', () => {
      this._state.show = this._showBox.checked;
      this._save();
      this._send({ show: this._state.show });
    });
    this._addForm?.addEventListener('submit', (event) => {
      event?.preventDefault?.();
      void this._addByName(this._addName?.value);
    });
    this._keywords?.addEventListener('change', () => {
      this._state.keywords = String(this._keywords.value || '')
        .trim()
        .slice(0, 80);
      this._save();
    });
    this._days?.addEventListener('change', () => {
      this._state.days = Number(this._days.value) || OUTBREAK_SCAN_DAYS_DEFAULT;
      this._save();
      this._say('Press SCAN TRAVEL to scan from the new start.');
    });
    this._scanBtn?.addEventListener('click', () => void this._scan());
    this._hour?.addEventListener('change', () => {
      this._stopPlay();
      this._state.hour = Number(this._hour.value) || null;
      this._refresh({ send: true });
    });
    this._playBtn?.addEventListener('click', () =>
      this._togglePlay(this._playBtn, 'past'),
    );
    // Redrawn at most every 150 ms while the slider is dragged: a scan can
    // hold well over a hundred flight lines.
    let contagionTimer = null;
    this._contagion?.addEventListener('input', () => {
      this._state.contagion = cleanContagion(this._contagion.value);
      this._showContagion();
      if (contagionTimer !== null) return;
      contagionTimer = globalThis.setTimeout(() => {
        contagionTimer = null;
        this._refresh({ send: true });
      }, 150);
    });
    this._futurePlayBtn?.addEventListener('click', () =>
      this._togglePlay(this._futurePlayBtn, 'future'),
    );
    for (const mode of OUTBREAK_MODE_IDS) {
      this._modeBoxes[mode]?.addEventListener('change', () => {
        this._state.shown[mode] = this._modeBoxes[mode].checked;
        this._refresh({ send: true });
      });
      this._speedBoxes[mode]?.addEventListener('change', () => {
        this._state.speeds[mode] = cleanSpeed(
          mode,
          this._speedBoxes[mode].value,
        );
        this._speedBoxes[mode].value = String(this._state.speeds[mode]);
        this._refresh({ send: true });
      });
    }
    this._list?.addEventListener('click', (event) => {
      const id = event?.target?.dataset?.outbreakRemove;
      if (id) this._remove(id);
    });
    this._found?.addEventListener('click', (event) => {
      const index = event?.target?.dataset?.outbreakFound;
      if (index !== undefined) void this._addFound(Number(index));
    });
    this._mediaBtn?.addEventListener('click', () => void this._mediaSearch());
    this._clearBtn?.addEventListener('click', () => this._clear());
    this._clearMapBtn?.addEventListener('click', () => this._clearMap());
    for (const [fieldKey, field] of Object.entries(this._profileFields)) {
      for (const type of ['change', 'input'])
        field?.addEventListener(type, () => {
          // A preset fills the pathogen fields; each stays editable.
          if (fieldKey === 'preset' && type === 'change' && field.value) {
            for (const [key, value] of Object.entries(
              presetValues(field.value),
            ))
              if (this._profileFields[key])
                this._profileFields[key].value = String(value);
          }
          const read = {};
          for (const [key, el] of Object.entries(this._profileFields))
            if (el) read[key] = el.value;
          this._state.profile = cleanAllProfile(read);
          // A fixed seed belongs to one set of inputs: a change lets it go.
          // The comparison is not one of them (the server's seed ignores it).
          if (fieldKey !== 'compare') {
            this._state.epidemicSeed = null;
            if (this._epiSeed) this._epiSeed.value = '';
          }
          this._save();
          this._showSuggestion();
        });
    }
    this._epiRunBtn?.addEventListener('click', () => void this._runEpidemic());
    for (const type of ['change', 'input'])
      this._epiSeed?.addEventListener(type, () => {
        this._state.epidemicSeed = cleanSeed(this._epiSeed.value);
        this._save();
      });
    this._epiDownload?.addEventListener('click', () => this._downloadJson());
    this._epiCsv?.addEventListener('click', () => this._downloadCsv());
    this._epiShow?.addEventListener('change', () => {
      this._state.showEpidemic = this._epiShow.checked;
      this._save();
      this._send();
    });
    // USE SUGGESTED: the only way the profile moves the slider.
    this._useSuggested?.addEventListener('click', () => {
      const suggestion = suggestedContagion(this._state.profile);
      if (!suggestion) return;
      this._state.contagion = suggestion.level;
      if (this._contagion) this._contagion.value = String(suggestion.level);
      this._showContagion();
      this._refresh({ send: true });
      this._say(
        `HOW CONTAGIOUS set to ${contagionLabel(suggestion.level)} from the disease profile.`,
      );
    });
    this._futureBtn?.addEventListener('click', () => void this._futureSpread());
    this._futureDays?.addEventListener('change', () => {
      this._state.futureHours = cleanForecastHorizon(this._futureDays.value);
      // Only a reach picked here is kept over the default.
      this._state.futureHoursChosen = true;
      this._futureDays.value = String(this._state.futureHours);
      this._save();
    });
    this._forecastList?.addEventListener('click', (event) => {
      const index = event?.target?.dataset?.outbreakForecast;
      if (index !== undefined) void this._addForecast(Number(index));
    });
    this._socialBtn?.addEventListener('click', () => void this._socialSearch());
    this._window?.addEventListener?.(OUTBREAK_SHOWN_EVENT, this._onShown);
    this._window?.addEventListener?.(OUTBREAK_REQUEST_EVENT, this._onRequest);
    void this._loadModels();
  }

  destroy() {
    this._stopPlay();
    this._destroyed = true;
    if (this._railWorldTimer) globalThis.clearTimeout(this._railWorldTimer);
    this._railWorldTimer = null;
    this._window?.removeEventListener?.(OUTBREAK_SHOWN_EVENT, this._onShown);
    this._window?.removeEventListener?.(
      OUTBREAK_REQUEST_EVENT,
      this._onRequest,
    );
  }

  /* --------------------------------------------------------------------- */
  /* State                                                                  */
  /* --------------------------------------------------------------------- */

  _load() {
    let saved = {};
    try {
      saved =
        JSON.parse(this._storage?.getItem?.(OUTBREAK_STORAGE_KEY) || '{}') ||
        {};
    } catch {
      saved = {};
    }
    const speeds = {};
    const shown = {};
    for (const mode of OUTBREAK_MODE_IDS) {
      speeds[mode] = cleanSpeed(mode, saved?.speeds?.[mode]);
      shown[mode] = saved?.shown?.[mode] !== false;
    }
    const scan =
      saved?.scan && typeof saved.scan === 'object' ? saved.scan : null;
    const startMs = Number(scan?.startMs);
    return {
      locations: cleanLocations(saved?.locations),
      keywords: String(saved?.keywords || '').slice(0, 80),
      days: OUTBREAK_SCAN_DAY_OPTIONS.includes(Number(saved?.days))
        ? Number(saved.days)
        : OUTBREAK_SCAN_DAYS_DEFAULT,
      speeds,
      shown,
      show: saved?.show === true,
      contagion: cleanContagion(saved?.contagion),
      // The default profile (OUTBREAK_DEFAULT_PROFILE) fills every field the
      // operator has not set, once per version of it; after that the
      // operator's choices, blanks included, are kept as they are.
      profile: cleanAllProfile(
        saved?.profileDefaults === PROFILE_DEFAULTS_VERSION
          ? saved?.profile
          : {
              ...OUTBREAK_DEFAULT_PROFILE,
              // The saved preset's own values fill the fields it never had.
              ...presetValues(saved?.profile?.preset),
              ...cleanAllProfile(saved?.profile),
            },
      ),
      profileDefaults: PROFILE_DEFAULTS_VERSION,
      showEpidemic: saved?.showEpidemic !== false,
      epidemicDays: EPIDEMIC_FORECAST_DAYS.includes(Number(saved?.epidemicDays))
        ? Number(saved.epidemicDays)
        : 2,
      epidemicRuns: [50, 200, 500].includes(Number(saved?.epidemicRuns))
        ? Number(saved.epidemicRuns)
        : 200,
      // null: the server picks the seed from the inputs.
      epidemicSeed: Number.isInteger(saved?.epidemicSeed)
        ? cleanSeed(saved.epidemicSeed)
        : null,
      // Which run the whole result in IndexedDB belongs to (fullResultStore).
      epidemicId: Number.isFinite(saved?.epidemicId) ? saved.epidemicId : null,
      // The last result, trimmed (trimmedEpidemic); null when none was kept.
      epidemic:
        saved?.epidemic &&
        typeof saved.epidemic === 'object' &&
        Array.isArray(saved.epidemic.places)
          ? saved.epidemic
          : null,
      hour: Number(saved?.hour) || null,
      scan: Number.isFinite(startMs)
        ? {
            startMs,
            flights: (Array.isArray(scan.flights) ? scan.flights : [])
              .map((f) => cleanFlight(f))
              .filter(Boolean),
            surroundings:
              scan.surroundings && typeof scan.surroundings === 'object'
                ? scan.surroundings
                : {},
            flightSource: String(scan.flightSource || '').slice(0, 80),
            airports: (Array.isArray(scan.airports) ? scan.airports : [])
              .map((code) => String(code).toUpperCase())
              .filter((code) => /^[A-Z0-9]{3,4}$/.test(code))
              .slice(0, 10),
          }
        : null,
      found: (Array.isArray(saved?.found) ? saved.found : []).slice(0, 30),
      // FIND FUTURE SPREAD LOCATIONS' reach in hours: 30 days unless the
      // person picked another from the menu (a reach saved without that
      // pick is the old 48 h default and gives way to the new one).
      futureHours: cleanForecastHorizon(
        saved?.futureHoursChosen === true ? saved?.futureHours : undefined,
      ),
      futureHoursChosen: saved?.futureHoursChosen === true,
      // At most 12 places a window, six windows to 30 days.
      forecast: (Array.isArray(saved?.forecast) ? saved.forecast : [])
        .filter((f) => Number.isFinite(f?.lat) && Number.isFinite(f?.lon))
        .slice(0, OUTBREAK_FORECAST_BOUNDS.length * 12)
        .map((f) => ({ ...f, within: cleanForecastWithin(f.within) })),
    };
  }

  _save() {
    const write = () =>
      this._storage?.setItem?.(
        OUTBREAK_STORAGE_KEY,
        JSON.stringify(this._state),
      );
    try {
      write();
    } catch {
      // This browser is not keeping it; the box still works. Most likely
      // the storage is full: drop the kept epidemic result (the full one
      // stays in this._epidemic) so the rest of the state still saves.
      if (!this._state.epidemic) return;
      this._state.epidemic = null;
      if (!this._persistWarned) {
        this._persistWarned = true;
        console.warn(
          'Outbreak: storage is full; the epidemic result is not kept across reloads.',
        );
      }
      try {
        write();
      } catch {
        /* Not keeping it. */
      }
    }
  }

  _startMs() {
    return (
      this._state.scan?.startMs ?? scanStartMs(this._now(), this._state.days)
    );
  }

  _showContagion() {
    if (this._contagionValue)
      this._contagionValue.textContent = contagionLabel(this._state.contagion);
    // Under the slider: when an airport counts as infected as a whole.
    if (this._contagionNote)
      this._contagionNote.textContent =
        airportInfectedAfterHours(this._state.contagion) === 0
          ? 'Zero Hour: entire airport considered infected the moment the outbreak lands, not just connected flights on infected planes'
          : `Entire airport considered infected after ${airportInfectedAfterHours(this._state.contagion)} h, not just connected flights on infected planes`;
  }

  /** The suggested HOW CONTAGIOUS level, and what each field added. */
  _showSuggestion() {
    const suggestion = suggestedContagion(this._state.profile);
    if (this._useSuggested) this._useSuggested.disabled = !suggestion;
    if (!this._suggest) return;
    this._suggest.textContent = suggestion
      ? `Suggested HOW CONTAGIOUS: ${contagionLabel(suggestion.level)} (${suggestion.parts
          .map((p) => `${p.label} ${p.delta >= 0 ? '+' : ''}${p.delta}`)
          .join(
            ', ',
          )}) · airports infected after ${airportInfectedAfterHours(suggestion.level)} h`
      : 'Set any of these for a suggested HOW CONTAGIOUS level.';
  }

  _fillControls() {
    for (const [key, el] of Object.entries(this._profileFields || {}))
      if (el) el.value = this._state.profile?.[key] ?? '';
    this._showSuggestion();
    if (this._contagion) this._contagion.value = String(this._state.contagion);
    this._showContagion();
    if (this._showBox) this._showBox.checked = this._state.show;
    if (this._epiShow) this._epiShow.checked = this._state.showEpidemic;
    if (this._epiRuns) this._epiRuns.value = String(this._state.epidemicRuns);
    if (this._epiDays) this._epiDays.value = String(this._state.epidemicDays);
    if (this._futureDays)
      this._futureDays.value = String(this._state.futureHours);
    if (this._epiSeed)
      this._epiSeed.value =
        this._state.epidemicSeed === null
          ? ''
          : String(this._state.epidemicSeed);
    if (this._keywords) this._keywords.value = this._state.keywords;
    if (this._days) this._days.value = String(this._state.days);
    for (const mode of OUTBREAK_MODE_IDS) {
      if (this._modeBoxes[mode])
        this._modeBoxes[mode].checked = this._state.shown[mode];
      if (this._speedBoxes[mode])
        this._speedBoxes[mode].value = String(this._state.speeds[mode]);
    }
  }

  /** The hour list, kept on the present when that is where it was. */
  _fillHours() {
    if (!this._hour || !this._doc) return;
    const startMs = this._startMs();
    const nowMs = this._now();
    const last = presentHour(startMs, nowMs);
    const options = outbreakHourOptions(startMs, nowMs);
    const wanted = options.some((o) => o.value === this._state.hour)
      ? this._state.hour
      : last;
    this._hour.replaceChildren();
    for (const option of options) {
      const el = this._doc.createElement('option');
      el.value = String(option.value);
      el.textContent = option.label;
      this._hour.appendChild(el);
    }
    this._hour.value = String(wanted);
    this._state.hour = wanted === last ? null : wanted;
  }

  /** The scan's flights and, after the present, the same routes flown daily. */
  _flights() {
    const now = this._now();
    const past = this._state.scan?.flights || [];
    const traffic = (this._traffic?.flights || []).map((f) =>
      f.departMs > now ? { ...f, future: true } : f,
    );
    return [...past, ...traffic];
  }

  /**
   * The air traffic beyond the scan (the server's simulateAirTraffic): every
   * departure from an airport that has had the outbreak an hour, the scan's
   * routes flown daily, normal traffic where there is no data, to 48 h past
   * the present. Asked again once the present has moved on.
   */
  async _loadTraffic({ quiet = false } = {}) {
    const scan = this._state.scan;
    if (!scan || this._trafficLoading) return;
    const nowMs = this._now();
    const untilMs = nowMs + FUTURE_FLIGHT_HOURS * 3_600_000;
    const delay = airportInfectedAfterHours(this._state.contagion);
    this._trafficLoading = true;
    try {
      const response = await this._request(`${API}/traffic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          startMs: scan.startMs,
          untilMs,
          infectedAfterHours: delay,
          outbreakAirports: scan.airports || [],
          flights: (scan.flights || []).map((f) => ({
            from: f.from.code,
            to: f.to.code,
            departMs: f.departMs,
            arriveMs: f.arriveMs,
            hop: f.hop,
          })),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(data?.flights))
        throw new Error(data?.error || `HTTP ${response.status}`);
      this._traffic = {
        untilMs,
        delay,
        flights: unpackTraffic(data)
          .map((f) => cleanFlight(f))
          .filter(Boolean),
      };
      if (!quiet)
        this._log(
          'AIR TRAFFIC · ASSUMED',
          `${this._traffic.flights.length} more flights out of the ${data.airportsReached} airports the outbreak reaches by ${timeLabel(untilMs)}. An airport gets infected status ${delay} h after the outbreak lands (HOW CONTAGIOUS): from then on every flight leaving it counts, its scanned routes flown daily, or its normal traffic where there is no data.`,
        );
      this._refresh({ send: true });
    } catch (error) {
      // Asked again at most once a minute while the server cannot answer.
      this._trafficRetryAt = this._now() + 60_000;
      if (!quiet) this._log('AIR TRAFFIC', `Not worked out: ${error.message}`);
    } finally {
      this._trafficLoading = false;
    }
  }

  _spread() {
    const startMs = this._startMs();
    const hour = this._state.hour || presentHour(startMs, this._now());
    return outbreakSpread({
      locations: this._state.locations,
      flights: this._flights(),
      speeds: this._state.speeds,
      surroundings: this._state.scan?.surroundings || {},
      shown: this._state.shown,
      airports: this._state.scan?.airports || [],
      forecast: this._state.forecast,
      present: presentHour(startMs, this._now()),
      contagion: this._state.contagion,
      networks: this._networksKnown(),
      airRoads: Boolean(this._airRoads?.network),
      airRails: Boolean(this._airRails?.network),
      startMs,
      hour,
    });
  }

  /* --------------------------------------------------------------------- */
  /* Main roads and rail lines (owner ruling, 2026-10-09)                   */
  /* --------------------------------------------------------------------- */

  /** By location id: {road: true, rail: true} where that network is known. */
  _networksKnown() {
    const known = {};
    for (const [key, entry] of this._networks || []) {
      if (!entry?.network) continue;
      const [id, mode] = key.split('|');
      (known[id] ||= {})[mode] = true;
    }
    return known;
  }

  /** The networks for the map: every known one for a current location. */
  _networksForMap() {
    const ids = new Set(this._state.locations.map((l) => l.id));
    const out = [];
    for (const [key, entry] of this._networks || []) {
      const [locationId, mode] = key.split('|');
      if (entry?.network && ids.has(locationId))
        out.push({ key, locationId, mode, network: entry.network });
    }
    if (this._airRoads?.network)
      out.push({
        key: 'air',
        locationId: '',
        mode: 'air',
        network: this._airRoads.network,
      });
    if (this._airRails?.network)
      out.push({
        key: 'air-rail',
        locationId: '',
        mode: 'air-rail',
        network: this._airRails.network,
      });
    return out;
  }

  /**
   * Every airport the outbreak lands at to the end of the time menu, with
   * the hour it lands, for the roads and rail after landing.
   */
  _landings(startMs) {
    const last =
      presentHour(startMs, this._now()) + OUTBREAK_FUTURE_HOURS.at(-1);
    const spread = outbreakSpread({
      locations: this._state.locations,
      flights: this._flights(),
      speeds: this._state.speeds,
      surroundings: this._state.scan?.surroundings || {},
      airports: this._state.scan?.airports || [],
      contagion: this._state.contagion,
      startMs,
      hour: last,
    });
    return spread.destinations.map((d) => ({
      code: d.code,
      lat: d.lat,
      lon: d.lon,
      hour: Math.round(((d.arriveMs - startMs) / 3_600_000) * 10) / 10,
    }));
  }

  /**
   * The roads out of every airport the outbreak lands at (owner ruling,
   * 2026-10-09: instead of a red circle round each): every landing to the end
   * of the time menu, with its hour, to the server, which lights each road
   * from the first landing to reach it. Asked again only when the flights,
   * the start, the locations or the road speed change.
   */
  async _loadAirRoads() {
    if (this._airRoadsLoading || !this._state.scan || !this._traffic) return;
    const startMs = this._startMs();
    const cheap = [
      startMs,
      this._traffic.flights.length,
      this._traffic.delay,
      this._state.speeds.road,
      this._state.locations.map((l) => l.id).join(','),
    ].join('|');
    if (
      cheap === this._airRoadsCheap &&
      !(this._airRoadsRetryAt <= this._now())
    )
      return;
    const destinations = this._landings(startMs);
    this._airRoadsCheap = cheap;
    this._airRoadsRetryAt = Infinity;
    if (!destinations.length) return;
    this._airRoadsLoading = true;
    try {
      const response = await this._request(`${API}/air-roads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          destinations,
          speedKmh: this._state.speeds.road,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.network)
        throw new Error(data?.error || `HTTP ${response.status}`);
      this._airRoads = { network: data.network };
      if (data.failedTiles) this._airRoadsRetryAt = this._now() + 300_000;
      this._log(
        'ROADS AFTER LANDING',
        `The roads out of ${data.landings.toLocaleString('en-US')} landing airport${data.landings === 1 ? '' : 's'} (${data.network.lengthKm.toLocaleString('en-US')} km within ${data.radiusKm} km of them) light up green from each landing: 100 km at road speed, then a quarter of it.${data.failedTiles ? ` ${data.failedTiles} of ${data.tiles} map tiles did not load; asked again later.` : ''}`,
      );
      this._refresh({ send: true });
    } catch {
      // The red circles stand in; asked again in five minutes.
      this._airRoadsRetryAt = this._now() + 300_000;
    } finally {
      this._airRoadsLoading = false;
    }
  }

  /**
   * The rail lines round every airport the outbreak lands at (owner report,
   * 2026-10-12: rail in Europe and North America never lit after a flight),
   * lit orange from each landing at train speed. Asked again only when the
   * flights, the start, the locations or the train speed change; not asked
   * while trains are hidden.
   */
  async _loadAirRails() {
    if (this._airRailsLoading || !this._state.scan || !this._traffic) return;
    if (this._state.shown?.train === false) return;
    const startMs = this._startMs();
    const cheap = [
      startMs,
      this._traffic.flights.length,
      this._traffic.delay,
      this._state.speeds.train,
      this._state.locations.map((l) => l.id).join(','),
    ].join('|');
    if (
      cheap === this._airRailsCheap &&
      !(this._airRailsRetryAt <= this._now())
    )
      return;
    const destinations = this._landings(startMs);
    this._airRailsCheap = cheap;
    this._airRailsRetryAt = Infinity;
    if (!destinations.length) return;
    this._airRailsLoading = true;
    try {
      const response = await this._request(`${API}/air-rails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          destinations,
          speedKmh: this._state.speeds.train,
        }),
      });
      const data = await response.json().catch(() => null);
      if (response.status === 429) {
        // Too many requests: a short wait, not five minutes dark.
        this._airRailsRetryAt = this._now() + 30_000;
        return;
      }
      if (!response.ok || !data)
        throw new Error(data?.error || `HTTP ${response.status}`);
      if (data.failedTiles) this._airRailsRetryAt = this._now() + 300_000;
      // No rail near any landing: nothing to light, and nothing to ask again.
      this._airRails = data.network ? { network: data.network } : null;
      if (!data.network) return;
      this._log(
        'RAIL AFTER LANDING',
        data.world
          ? `The world's rail (${data.network.lengthKm.toLocaleString('en-US')} km) lights up orange from ${count(data.seededLandings)} of ${count(data.landings)} landing airport${data.landings === 1 ? '' : 's'} with rail within reach, along the whole network at train speed.${data.failedTiles ? ` ${data.failedTiles} of ${data.tiles} map tiles did not load; asked again later.` : ''}`
          : `The rail lines round ${data.landings.toLocaleString('en-US')} landing airport${data.landings === 1 ? '' : 's'} (${data.network.lengthKm.toLocaleString('en-US')} km within ${data.radiusKm} km of them) light up orange from each landing at train speed.${data.skippedLandings ? ` ${data.skippedLandings.toLocaleString('en-US')} later landing${data.skippedLandings === 1 ? '' : 's'} left out.` : ''}${data.failedTiles ? ` ${data.failedTiles} of ${data.tiles} map tiles did not load; asked again later.` : ''}`,
      );
      this._refresh({ send: true });
    } catch {
      // Asked again in five minutes.
      this._airRailsRetryAt = this._now() + 300_000;
    } finally {
      this._airRailsLoading = false;
    }
  }

  /**
   * EVERY RAIL LINE ON THE GLOBE (owner ruling 2026-10-12): how far the
   * server's world rail has got. While it finds and builds it, the status
   * line says so, every RAIL_WORLD_POLL_MS; once it is built, the log says
   * so once, the rail round each location and after each landing is asked
   * for again (now the whole world's), and the map draws every rail line.
   */
  async _pollRailWorld() {
    if (this._railWorldPolling || this._destroyed) return;
    this._railWorldPolling = true;
    let wait = RAIL_WORLD_RETRY_MS;
    try {
      const { response, data } = await this._getJson(
        `${API}/rail-world/status`,
      ).catch(() => ({ response: { ok: false }, data: null }));
      if (!response?.ok || !data?.state) return;
      const was = this._railWorld;
      this._railWorld = data;
      const ours =
        !this._status?.textContent ||
        this._status.textContent === this._railWorldSaid;
      if (data.state === 'off') {
        this._railWorldDone = true;
        return;
      }
      if (data.state === 'ready') {
        this._railWorldDone = true;
        if (ours && this._railWorldSaid) this._say('');
        if (was?.state === 'ready' && was.builtAt === data.builtAt) return;
        this._log(
          'WORLD RAIL',
          `${railWorldLine(data)} Rail now lights along the whole network from each outbreak location and each landing, and the epidemic model carries rail travellers between the places it joins.`,
        );
        // Asked again, now from the whole world's rail.
        for (const key of [...(this._networks || new Map()).keys()])
          if (key.endsWith('|rail')) this._networks.delete(key);
        this._airRailsCheap = null;
        this._refresh({ send: true });
        return;
      }
      wait = RAIL_WORLD_POLL_MS;
      const text = railWorldLine(data);
      if (ours) {
        this._say(text);
        this._railWorldSaid = text;
      }
    } finally {
      this._railWorldPolling = false;
      if (!this._destroyed && !this._railWorldDone) {
        this._railWorldTimer = globalThis.setTimeout(() => {
          this._railWorldTimer = null;
          void this._pollRailWorld();
        }, wait);
        // Under Node (the tests) the poll never holds the process open.
        this._railWorldTimer?.unref?.();
      }
    }
  }

  /**
   * Fetch, in the background and one at a time, the main roads and the rail
   * lines round each outbreak location (rail only where a station is near or
   * it is unknown, or the world rail is built). A failure is asked again at
   * most every five minutes; the circle stands in meanwhile.
   */
  async _loadNetworks() {
    if (this._networksLoading || !this._state.scan) return;
    this._networks ||= new Map();
    const now = this._now();
    const wanted = [];
    for (const location of this._state.locations) {
      const around = this._state.scan?.surroundings?.[location.id] || {};
      for (const mode of ['road', 'rail']) {
        // No station near by OpenStreetMap: rail is still asked for once
        // the world rail is built, which knows the lines itself.
        if (
          mode === 'rail' &&
          around.rail === false &&
          this._railWorld?.state !== 'ready'
        )
          continue;
        const entry = this._networks.get(`${location.id}|${mode}`);
        if (entry?.retryAt > now) continue;
        // Roads keep spreading to the end of the forecast (owner ruling,
        // 2026-10-09): once a level is in, the next, farther one is asked.
        if (entry?.network && networkDone(entry, mode)) continue;
        wanted.push({
          location,
          mode,
          level: entry?.network ? (entry.level || 1) + 1 : 1,
        });
      }
    }
    if (!wanted.length) return;
    // Every location's first level before anyone's farther one.
    wanted.sort((x, y) => x.level - y.level);
    this._networksLoading = true;
    try {
      for (const { location, mode, level } of wanted) {
        const key = `${location.id}|${mode}`;
        const before = this._networks.get(key);
        const params = new URLSearchParams({
          lat: String(location.lat),
          lon: String(location.lon),
          mode,
          level: String(level),
        });
        const { response, data } = await this._getJson(
          `${API}/network?${params}`,
        ).catch(() => ({ response: { ok: false }, data: null }));
        if (response.ok && data?.network) {
          this._networks.set(key, {
            mode,
            network: data.network,
            level: data.level || level,
            lastLevel: Boolean(data.lastLevel),
            // A partial answer is asked for again later.
            retryAt: data.failedTiles ? this._now() + 300_000 : 0,
          });
          this._log(
            `${mode === 'rail' ? 'RAIL LINES' : 'MAIN ROADS'} · ${location.name}${mode === 'road' ? ` · level ${data.level || level}` : ''}`,
            data.world
              ? `The world's rail, ${data.network.lengthKm.toLocaleString('en-US')} km, from ${data.network.startKm} km away; ${count(data.network.reachedKm)} km along it at the farthest${data.failedTiles ? ` (${data.failedTiles} of ${data.tiles} map tiles did not load; asked again later)` : ''}. The spread follows it, orange once reached.`
              : `${data.network.lengthKm.toLocaleString('en-US')} km of ${mode === 'rail' ? 'rail line' : 'main road'} within ${data.radiusKm.toLocaleString('en-US')} km, from ${data.network.startKm} km away${data.failedTiles ? ` (${data.failedTiles} of ${data.tiles} map tiles did not load; asked again later)` : ''}. The spread follows it, ${mode === 'rail' ? 'orange' : 'dark red'} once reached.${mode === 'road' && !data.lastLevel ? ' Farther roads are loading.' : ''}`,
          );
        } else {
          // A farther level that fails keeps the nearer one on the map.
          this._networks.set(key, {
            mode,
            network: before?.network || null,
            level: before?.level || 0,
            lastLevel: Boolean(before?.lastLevel),
            retryAt: this._now() + 300_000,
          });
        }
        this._refresh({ send: true });
      }
    } finally {
      this._networksLoading = false;
    }
    // The next, farther level, now this one is in.
    if (
      [...this._networks.values()].some(
        (entry) =>
          entry.network &&
          !networkDone(entry, entry.mode) &&
          !(entry.retryAt > 0),
      )
    )
      void this._loadNetworks();
  }

  _send(extra = {}) {
    try {
      this._window?.dispatchEvent?.(
        new CustomEvent(OUTBREAK_MODEL_EVENT, {
          detail: {
            spread: this._spread(),
            networks: this._networksForMap(),
            epidemic:
              this._epidemic && this._state.showEpidemic
                ? {
                    startMs: this._epidemic.startMs,
                    places: this._epidemic.places,
                    commutes: this._epidemic.commutes,
                  }
                : null,
            // Every rail line on the globe, once the server has built it
            // (owner ruling 2026-10-12), while trains are shown.
            railWorld:
              this._railWorld?.state === 'ready' &&
              this._state.shown?.train !== false
                ? { builtAt: this._railWorld.builtAt }
                : null,
            ...extra,
          },
        }),
      );
    } catch {
      /* No CustomEvent here (a test without one). */
    }
  }

  _refresh({ send = false } = {}) {
    // The assumed traffic is kept in memory: after a reload, or once the
    // present has moved on an hour, it is asked for again (at most once a
    // minute when the server cannot answer).
    const now = this._now();
    // A new HOW CONTAGIOUS level changes when airports get infected status,
    // so the traffic is worked out again for it too.
    if (
      this._state.scan &&
      (!(
        this._traffic?.untilMs >=
        now + (FUTURE_FLIGHT_HOURS - 1) * 3_600_000
      ) ||
        this._traffic?.delay !==
          airportInfectedAfterHours(this._state.contagion)) &&
      !(this._trafficRetryAt > now)
    ) {
      void this._loadTraffic({ quiet: true });
    }
    // Every rail line on the globe: how far the server has got.
    if (this._state.scan && !this._railWorldTimer && !this._railWorldDone)
      void this._pollRailWorld();
    // The main roads and rail lines round each location, once each.
    if (this._state.scan && !this._networksLoading) void this._loadNetworks();
    if (this._state.scan && this._traffic && !this._airRoadsLoading)
      void this._loadAirRoads();
    if (this._state.scan && this._traffic && !this._airRailsLoading)
      void this._loadAirRails();
    this._fillHours();
    const spread = this._spread();
    this._renderSummary(spread);
    this._save();
    if (send) this._send();
  }

  /* --------------------------------------------------------------------- */
  /* Rendering                                                              */
  /* --------------------------------------------------------------------- */

  _item(text, button) {
    const li = this._doc.createElement('li');
    const span = this._doc.createElement('span');
    span.textContent = text;
    li.appendChild(span);
    if (button) li.appendChild(button);
    return li;
  }

  _button(label, data) {
    const button = this._doc.createElement('button');
    button.type = 'button';
    button.className = 'scene-btn';
    button.textContent = label;
    Object.assign(button.dataset, data);
    return button;
  }

  _renderLocations() {
    if (!this._list || !this._doc) return;
    this._list.replaceChildren(
      ...this._state.locations.map((location) =>
        this._item(
          `● ${location.name}${location.kind ? ` · ${location.kind}` : ''}${location.source ? ` · ${location.source}` : ''}`,
          this._button('REMOVE', { outbreakRemove: location.id }),
        ),
      ),
    );
    if (!this._state.locations.length)
      this._list.appendChild(
        this._item('No outbreak location. Add one below.'),
      );
  }

  _renderSummary(spread) {
    if (this._summary && this._doc) {
      const lines = spreadSummary(spread, this._state.speeds);
      const scan = this._state.scan;
      lines.push(
        scan
          ? `Scanned from ${timeLabel(scan.startMs)} · flights: ${scan.flightSource || 'none found'}`
          : 'Not scanned yet: press SCAN TRAVEL.',
      );
      this._summary.replaceChildren(...lines.map((line) => this._item(line)));
    }
    if (this._destinations && this._doc) {
      this._destinations.replaceChildren(
        ...spread.destinations.map((place) =>
          this._item(
            `✈ ${place.code}${place.name ? ` ${place.name}` : ''} · ${place.future ? 'lands' : 'landed'} ${timeLabel(place.arriveMs)}${place.hop === 2 ? ' · connecting' : ''}${place.future ? ' · future flight' : ''}`,
          ),
        ),
      );
    }
  }

  _renderForecast() {
    if (!this._forecastList || !this._doc) return;
    this._forecastList.replaceChildren(
      ...this._state.forecast.map((row, index) =>
        this._item(
          `WITHIN ${forecastWindowLabel(row.within)} · ${row.name}${row.likelihood ? ` · ${row.likelihood}` : ''}${row.reason ? ` · ${row.reason}` : ''}`,
          this._button('+ ADD', { outbreakForecast: String(index) }),
        ),
      ),
    );
  }

  async _addForecast(index) {
    const row = this._state.forecast[index];
    if (!row) return;
    const location = cleanLocation({
      name: row.name,
      lat: row.lat,
      lon: row.lon,
      source: `Future ${forecastWindowLabel(row.within).toLowerCase()}`,
    });
    if (!location) return;
    if (this._state.locations.some((l) => l.id === location.id)) {
      this._say(`${location.name} is already listed.`);
      return;
    }
    this._state.locations.push(location);
    this._state.forecast.splice(index, 1);
    this._renderLocations();
    this._renderForecast();
    this._refresh({ send: true });
    this._say(
      `ADDED · ${location.name}. Press SCAN TRAVEL to scan its travel.`,
    );
  }

  _renderFound() {
    if (!this._found || !this._doc) return;
    this._found.replaceChildren(
      ...this._state.found.map((row, index) => {
        const li = this._item(
          `${row.place}${row.evidence ? ` · ${row.evidence}` : ''}${row.via ? ` · ${row.via}` : ''}`,
          this._button('+ ADD', { outbreakFound: String(index) }),
        );
        if (row.link) {
          const a = this._doc.createElement('a');
          a.href = row.link;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = 'LINK';
          li.insertBefore(a, li.lastChild);
        }
        return li;
      }),
    );
  }

  _say(text) {
    if (this._status) this._status.textContent = text;
  }

  _log(kind, body) {
    if (!this._output) return;
    this._output.textContent = prependOutputLog(
      this._output.textContent,
      formatAskLogEntry(kind, body),
    );
    this._output.scrollTop = 0;
  }

  /* --------------------------------------------------------------------- */
  /* Locations                                                              */
  /* --------------------------------------------------------------------- */

  async _addByName(rawName, extra = {}) {
    const name = String(rawName || '')
      .trim()
      .slice(0, 80);
    if (!name) {
      this._say('Type a city or town to add.');
      return false;
    }
    this._say(`Finding ${name}…`);
    let place = null;
    try {
      place = await this._geocode(name);
    } catch {
      place = null;
    }
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) {
      this._say(`${name} was not found. Try "town, country".`);
      return false;
    }
    const location = cleanLocation({
      name: place.label || place.name || name,
      lat: place.lat,
      lon: place.lng,
      ...extra,
    });
    if (!location) {
      this._say(`${name} was not found.`);
      return false;
    }
    if (this._state.locations.some((l) => l.id === location.id)) {
      this._say(`${location.name} is already listed.`);
      return false;
    }
    this._state.locations.push(location);
    if (this._addName && !extra.source) this._addName.value = '';
    this._renderLocations();
    this._refresh({ send: true });
    this._say(
      `ADDED · ${location.name}. Press SCAN TRAVEL to scan its travel.`,
    );
    return true;
  }

  /**
   * CLEAR DATA: a new run from scratch. The last run's results go: the scan and
   * its flights, the assumed air traffic, the future spread places, the new
   * locations found, the hour picked, the log. The outbreak locations, the
   * disease name, the speeds, the ticks and HOW CONTAGIOUS stay.
   */
  /**
   * CLEAR MAP: the spread leaves the map and every result stays, so ticking
   * "Display spread on map" brings it straight back.
   */
  _clearMap() {
    this._stopPlay();
    this._hideMap();
    this._say(
      'MAP CLEARED · the results are kept; tick Display spread on map to show them again.',
    );
  }

  _hideMap() {
    this._state.show = false;
    if (this._showBox) this._showBox.checked = false;
    this._save();
    this._send({ show: false });
  }

  _clear() {
    if (this._busy) {
      this._say(`Still working: ${this._busy}. Clear once it is done.`);
      return;
    }
    this._stopPlay();
    this._state.scan = null;
    this._traffic = null;
    this._trafficRetryAt = 0;
    this._epidemic = null;
    this._state.epidemic = null;
    this._dropFullEpidemic();
    this._lastRequest = null;
    this._renderEpidemic();
    this._state.forecast = [];
    this._state.found = [];
    this._state.hour = null;
    this._renderForecast();
    this._renderFound();
    if (this._output) this._output.textContent = '';
    this._refresh();
    this._hideMap();
    this._say('DATA CLEARED · press SCAN TRAVEL for a new run.');
  }

  _remove(id) {
    const before = this._state.locations.length;
    this._state.locations = this._state.locations.filter((l) => l.id !== id);
    if (this._state.locations.length === before) return;
    this._renderLocations();
    this._refresh({ send: true });
  }

  async _addFound(index) {
    const row = this._state.found[index];
    if (!row) return;
    const added = await this._addByName(row.place, {
      source: row.via || 'Found',
    });
    if (added) {
      this._state.found.splice(index, 1);
      this._renderFound();
      this._save();
    }
  }

  /* --------------------------------------------------------------------- */
  /* Network                                                                */
  /* --------------------------------------------------------------------- */

  _request(url, init) {
    const fetchImpl = this._fetch || globalThis.fetch;
    return fetchImpl(url, init);
  }

  async _getJson(url) {
    const response = await this._request(url, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    return { response, data };
  }

  async _loadModels() {
    const select = this._model;
    if (!select || !this._doc) return;
    let providers = [];
    let reachable = true;
    try {
      const { data } = await this._getJson(PROVIDERS_URL);
      providers = (data?.providers || []).filter((provider) => provider.ready);
      if (Number.isFinite(data?.askTimeoutMs) && data.askTimeoutMs > 0)
        this._askTimeoutMs = data.askTimeoutMs;
    } catch {
      reachable = false;
    }
    select.replaceChildren();
    if (!providers.length) {
      const option = this._doc.createElement('option');
      option.value = '';
      option.textContent = reachable
        ? 'No model key yet'
        : 'Model list unavailable';
      select.appendChild(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const provider of providers) {
      const option = this._doc.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label;
      select.appendChild(option);
    }
    select.value = providers[0].id;
  }

  /** One question to the chosen model; its answer text, or throws. */
  async _ask(question, context) {
    const provider = this._model?.value;
    if (!provider) throw new Error('No model key yet. Add one in POWER UP.');
    const controller = new AbortController();
    const timer = globalThis.setTimeout(
      () => controller.abort(),
      this._askTimeoutMs + CLIENT_TIMEOUT_MARGIN_MS,
    );
    try {
      const response = await this._request(ASK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          question,
          context,
          answerTokens: OUTBREAK_ANSWER_TOKENS,
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (response.status === 501 || data?.unconfigured)
        throw new Error('No key for this model. Add one in POWER UP.');
      if (!response.ok || !data?.answer)
        throw new Error(data?.error || `HTTP ${response.status}`);
      return String(data.answer);
    } catch (error) {
      if (error?.name === 'AbortError')
        throw new Error('The model did not answer in time.');
      throw error;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  _setBusy(what) {
    this._busy = what;
    for (const button of [
      this._scanBtn,
      this._clearBtn,
      this._mediaBtn,
      this._socialBtn,
      this._futureBtn,
    ])
      if (button) button.disabled = Boolean(what);
  }

  /* --------------------------------------------------------------------- */
  /* SCAN TRAVEL                                                            */
  /* --------------------------------------------------------------------- */

  async _scan() {
    if (this._busy) {
      this._say(`Still working: ${this._busy}.`);
      return;
    }
    const locations = this._state.locations;
    if (!locations.length) {
      this._say('Add an outbreak location first.');
      return;
    }
    this._stopPlay();
    this._setBusy('scanning');
    const nowMs = this._now();
    const startMs = scanStartMs(nowMs, this._state.days);
    try {
      this._say('SCANNING · rail and water near each location…');
      const surroundings = await this._scanSurroundings(locations);
      this._say('SCANNING · flights…');
      const { flights, source } = await this._scanFlights(
        locations,
        startMs,
        nowMs,
      );
      this._state.scan = {
        startMs,
        flights,
        surroundings,
        flightSource: source,
        airports: this._scanAirports || [],
      };
      this._traffic = null;
      this._say('SCANNING · air traffic out of the airports it reaches…');
      await this._loadTraffic();
      this._state.hour = null;
      this._state.show = true;
      if (this._showBox) this._showBox.checked = true;
      this._refresh();
      this._send({ show: true });
      void this._flyToOutbreak();
      const spread = this._spread();
      this._log(
        'OUTBREAK SCAN',
        spreadSummary(spread, this._state.speeds).join('\n'),
      );
      this._say(
        `SCAN DONE · ${flights.length} flight${flights.length === 1 ? '' : 's'} · ${spread.destinations.length} place${spread.destinations.length === 1 ? '' : 's'} reached by plane`,
      );
    } catch (error) {
      this._say(error?.message || 'The scan failed.');
    } finally {
      this._setBusy('');
    }
  }

  async _scanSurroundings(locations) {
    const out = {};
    const speeds = [];
    const lines = [];
    await Promise.all(
      locations.map(async (location) => {
        try {
          const { response, data } = await this._getJson(
            `${API}/surroundings?lat=${location.lat}&lon=${location.lon}`,
          );
          if (!response.ok || !data)
            throw new Error(data?.error || `HTTP ${response.status}`);
          out[location.id] = {
            rail: data.rail === true,
            water: data.water === true,
          };
          if (Number.isFinite(data.trainKmh)) speeds.push(data.trainKmh);
          lines.push(
            `${location.name}: ${data.stations} railway station${data.stations === 1 ? '' : 's'} within 30 km${Number.isFinite(data.trainKmh) ? ` (rail lines average ${data.trainKmh} km/h)` : ''} · ${data.water ? `water traffic within 100 km (${data.waterPlaces})` : 'no water traffic within 100 km'}`,
          );
        } catch (error) {
          out[location.id] = {};
          lines.push(
            `${location.name}: OpenStreetMap did not answer (${error.message}); train and boat both counted (untick one to leave it out).`,
          );
        }
      }),
    );
    if (speeds.length) {
      // The area's average train speed, from its rail lines' own limits.
      const kmh = Math.round(
        speeds.reduce((sum, v) => sum + v, 0) / speeds.length,
      );
      this._state.speeds.train = cleanSpeed('train', kmh);
      if (this._speedBoxes.train)
        this._speedBoxes.train.value = String(this._state.speeds.train);
    }
    this._log('RAIL & WATER', lines.join('\n'));
    return out;
  }

  /** The airports near the outbreak locations, nearest first, at most six. */
  async _outbreakAirports(locations) {
    const airports = new Map();
    for (const location of locations) {
      const { response, data } = await this._getJson(
        `${API}/airports/near?lat=${location.lat}&lon=${location.lon}`,
      );
      if (!response.ok)
        throw new Error(data?.error || `Airports: HTTP ${response.status}`);
      for (const airport of data?.airports || [])
        if (!airports.has(airport.code)) airports.set(airport.code, airport);
    }
    return [...airports.values()].slice(0, 6);
  }

  async _scanFlights(locations, startMs, nowMs) {
    const airports = await this._outbreakAirports(locations);
    this._scanAirports = airports.map((a) => a.code);
    if (!airports.length) {
      this._log(
        'FLIGHTS',
        'No airport with scheduled flights within 60 km of the outbreak.',
      );
      return { flights: [], source: 'no airport near' };
    }
    this._log(
      'AIRPORTS',
      airports
        .map((a) => `${a.code} ${a.iata || ''} ${a.name} · ${a.km} km`)
        .join('\n'),
    );
    const { response, data } = await this._getJson(
      `${API}/flights?airports=${airports.map((a) => a.code).join(',')}&begin=${Math.floor(startMs / 1000)}&end=${Math.floor(nowMs / 1000)}`,
    );
    if (response.ok && Array.isArray(data?.flights)) {
      const flights = data.flights.map((f) => cleanFlight(f)).filter(Boolean);
      this._log(
        'FLIGHT HISTORY · OPENSKY',
        flights.length
          ? flights
              .map(
                (f) =>
                  `${f.hop === 2 ? '  connecting ' : ''}${f.from.code} → ${f.to.code} ${f.to.name} · ${f.callsign || '—'} · left ${timeLabel(f.departMs)} · landed ${timeLabel(f.arriveMs)}`,
              )
              .join('\n')
          : 'No flight left these airports in the scan window.',
      );
      if (flights.length) return { flights, source: 'OpenSky flight history' };
    } else {
      this._log('FLIGHT HISTORY', data?.error || `HTTP ${response.status}`);
    }
    if (!this._model?.value) {
      this._log(
        'FLIGHTS',
        'No language model key either: no flights are drawn. Add one in POWER UP.',
      );
      return { flights: [], source: 'none (no OpenSky account or model key)' };
    }
    return this._scheduleFlights(airports, locations[0], startMs);
  }

  /** Airline schedules from the chosen model, read from a list of real airports. */
  async _scheduleFlights(airports, near, startMs) {
    this._say('SCANNING · airline schedules with the language model…');
    const { response, data } = await this._getJson(
      `${API}/airports/candidates?lat=${near.lat}&lon=${near.lon}`,
    );
    if (!response.ok)
      throw new Error(data?.error || `Airports: HTTP ${response.status}`);
    const candidates = data?.airports || [];
    const byCode = new Map(candidates.map((a) => [a.code, a]));
    for (const a of airports) byCode.set(a.code, a);
    const context = {
      outbreakRoutes: {
        origins: airports.map(candidateLine),
        candidates: candidates.map(candidateLine),
      },
    };
    const origins = new Set(airports.map((a) => a.code));
    const firstAnswer = await this._ask(
      outbreakRoutesQuestion(airports),
      context,
    );
    const first = parseRouteLines(firstAnswer).filter(
      (r) => origins.has(r.from) && byCode.has(r.to) && !origins.has(r.to),
    );
    const destinations = [...new Set(first.map((r) => r.to))]
      .map((code) => byCode.get(code))
      .slice(0, CONNECTING_AIRPORTS_MAX);
    let onward = [];
    if (destinations.length) {
      this._say('SCANNING · connecting flights with the language model…');
      try {
        const answer = await this._ask(
          outbreakRoutesQuestion(destinations, { connecting: true }),
          context,
        );
        const from = new Set(destinations.map((a) => a.code));
        onward = parseRouteLines(answer).filter(
          (r) => from.has(r.from) && byCode.has(r.to) && !origins.has(r.to),
        );
      } catch (error) {
        this._log('CONNECTING FLIGHTS', error.message);
      }
    }
    const routes = [
      ...first.map((r) => ({
        from: byCode.get(r.from),
        to: byCode.get(r.to),
        hop: 1,
      })),
      ...onward.map((r) => ({
        from: byCode.get(r.from),
        to: byCode.get(r.to),
        hop: 2,
      })),
    ];
    const flights = timeScheduleRoutes(
      routes,
      startMs,
      'Airline schedule (LLM)',
    );
    this._log(
      'AIRLINE SCHEDULES · LLM',
      flights.length
        ? `${flights.length} routes; times assumed: first flights leave at the scan's start, connections ${CONNECTION_HOURS} h after landing.\n${flights
            .map(
              (f) =>
                `${f.hop === 2 ? '  connecting ' : ''}${f.from.code} → ${f.to.code} ${f.to.name}`,
            )
            .join('\n')}`
        : 'The model named no route.',
    );
    return { flights, source: 'airline schedules (language model)' };
  }

  /** SCAN TRAVEL ends over the outbreak, with the region round it in view. */
  async _flyToOutbreak() {
    const target = outbreakViewTarget(this._state.locations);
    const camera = this.viewer?.camera;
    if (!target || typeof camera?.flyTo !== 'function') return;
    if (this.viewer.isDestroyed?.()) return;
    try {
      const Cesium = await import('cesium');
      // A camera following something would pull the view straight back.
      if (this.viewer.trackedEntity) this.viewer.trackedEntity = undefined;
      camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          target.lon,
          target.lat,
          target.heightM,
        ),
        orientation: {
          heading: 0,
          pitch: -Math.PI / 2,
          roll: 0,
        },
        duration: 3,
      });
    } catch {
      /* The scene is not ready: the spread is drawn all the same. */
    }
  }

  /* --------------------------------------------------------------------- */
  /* Time                                                                   */
  /* --------------------------------------------------------------------- */

  /**
   * PLAY steps from hour 1 to the present; MAP FUTURE SPREAD steps from the
   * present to 30 days ahead. Either button stops whichever is running.
   */
  _togglePlay(button, range) {
    const running = this._playTimer !== null;
    const same = this._playing === range;
    if (running) this._stopPlay();
    if (running && same) return;
    const present = presentHour(this._startMs(), this._now());
    // The hours it steps through: every hour of the past; into the future,
    // the time menu's own steps (hourly to +48 h, then every 6 h).
    const hours =
      range === 'future'
        ? [present, ...OUTBREAK_FUTURE_HOURS.map((ahead) => present + ahead)]
        : Array.from({ length: present }, (_, i) => i + 1);
    let at = 0;
    this._playing = range;
    if (button) button.textContent = 'STOP';
    const step = () => {
      const hour = hours[at];
      this._state.hour = hour === present ? null : hour;
      this._refresh({ send: true });
      if (at >= hours.length - 1) {
        this._stopPlay();
        return;
      }
      at += 1;
      this._playTimer = globalThis.setTimeout(step, PLAY_STEP_MS);
    };
    this._playTimer = 0;
    step();
  }

  _stopPlay() {
    if (this._playTimer) globalThis.clearTimeout(this._playTimer);
    this._playTimer = null;
    this._playing = '';
    if (this._playBtn) this._playBtn.textContent = 'PLAY';
    if (this._futurePlayBtn)
      this._futurePlayBtn.textContent = 'MAP FUTURE SPREAD';
  }

  /* --------------------------------------------------------------------- */
  /* Searches                                                               */
  /* --------------------------------------------------------------------- */

  /**
   * FIND FUTURE SPREAD LOCATIONS: a new global news search, then one request
   * to the chosen model per window up to the chosen reach (24 h to 30 days;
   * 30 days by default): where it is most likely to be reported within 24 h,
   * then (told those) where in 24 to 48 h, then 48 h to 3 days, and so on to
   * 7, 14 and 30 days. A window the model fails to answer is skipped. Each
   * place named is placed by its airport, else by name, and drawn on the map.
   */
  async _futureSpread() {
    if (this._busy) {
      this._say(`Still working: ${this._busy}.`);
      return;
    }
    const locations = this._state.locations;
    if (!locations.length) {
      this._say('Add an outbreak location first.');
      return;
    }
    if (!this._model?.value) {
      this._say('No model key yet. Add one in POWER UP.');
      return;
    }
    this._stopPlay();
    this._setBusy('the future spread');
    try {
      this._say('FUTURE SPREAD · new global news search…');
      const params = new URLSearchParams({
        places: locations.map((l) => l.name).join(';'),
        keywords: this._state.keywords,
      });
      const news = await this._getJson(`${API}/news?${params}`);
      const articles = news.response.ok ? news.data?.articles || [] : [];
      this._log(
        'FUTURE SPREAD · GLOBAL NEWS',
        news.response.ok
          ? `${articles.length} article${articles.length === 1 ? '' : 's'} in the last 7 days`
          : news.data?.error ||
              'The news search did not answer; the forecast uses the scan alone.',
      );
      const near = locations[0];
      const pool = await this._getJson(
        `${API}/airports/candidates?lat=${near.lat}&lon=${near.lon}`,
      );
      if (!pool.response.ok)
        throw new Error(pool.data?.error || 'The airport list did not load.');
      const candidates = pool.data?.airports || [];
      const byCode = new Map();
      for (const a of candidates) {
        byCode.set(a.code, a);
        if (a.iata) byCode.set(a.iata, a);
      }
      // The reach at the present hour, whatever hour the menu shows.
      const startMs = this._startMs();
      const spread = outbreakSpread({
        locations,
        flights: this._flights().filter((f) => !f.future),
        speeds: this._state.speeds,
        surroundings: this._state.scan?.surroundings || {},
        airports: this._state.scan?.airports || [],
        contagion: this._state.contagion,
        startMs,
        hour: presentHour(startMs, this._now()),
      });
      const epidemic = this._epidemic
        ? [
            ...epidemicLines(this._epidemic, { max: 15 }),
            ...(this._epidemic.effectiveDistance || [])
              .slice(0, 10)
              .map(
                (e) => `effective distance ${e.distance}: ${e.code} ${e.name}`,
              ),
          ]
        : [];
      const horizon = cleanForecastHorizon(
        this._futureDays?.value ?? this._state.futureHours,
      );
      this._state.futureHours = horizon;
      const windows = forecastWindows(horizon);
      const forecast = [];
      const earlier = [];
      const failed = [];
      let firstError = null;
      for (const [index, within] of windows.entries()) {
        const label = forecastWindowLabel(within);
        const from = forecastWindowStart(within);
        this._say(
          `FUTURE SPREAD · asking the model: ${from ? `${forecastWindowLabel(from)} to ` : 'within '}${label}${windows.length > 1 ? ` (${index + 1} of ${windows.length})` : ''}…`,
        );
        let answer;
        try {
          answer = await this._ask(
            outbreakForecastQuestion(
              within,
              this._state.keywords,
              this._state.profile,
              { epidemic: epidemic.length > 0, from },
            ),
            outbreakForecastScene({
              locations,
              spread,
              speeds: this._state.speeds,
              flights: this._state.scan?.flights || [],
              futureFlights: this._flights().filter((f) => f.future),
              candidates,
              articles,
              earlier,
              epidemic,
            }),
          );
        } catch (error) {
          // One window that fails is skipped; the others still count.
          firstError ??= error;
          failed.push(label);
          this._log(
            `FUTURE SPREAD · WITHIN ${label}`,
            `Skipped: ${error?.message || 'the model did not answer'}.`,
          );
          continue;
        }
        this._log(`FUTURE SPREAD · WITHIN ${label} · LLM`, answer);
        const rows = parseForecastLines(answer, within, [
          ...locations,
          ...forecast.map((f) => ({ name: f.name })),
        ]);
        earlier.push(...rows);
        for (const row of rows) {
          const placed = await this._placeForecast(row, byCode);
          if (placed) forecast.push(placed);
        }
      }
      if (failed.length === windows.length) throw firstError;
      this._state.forecast = forecast;
      this._renderForecast();
      this._state.show = true;
      if (this._showBox) this._showBox.checked = true;
      this._refresh();
      this._send({ show: true });
      const counts = windows
        .filter((within) => !failed.includes(forecastWindowLabel(within)))
        .map(
          (within) =>
            `${forecast.filter((f) => f.within === within).length} within ${forecastWindowLabel(within).toLowerCase()}`,
        );
      this._say(
        `FUTURE SPREAD DONE · ${counts.join(' · ')}${failed.length ? ` · no answer for ${failed.map((l) => l.toLowerCase()).join(', ')}` : ''}`,
      );
    } catch (error) {
      this._say(error?.message || 'The future spread failed.');
    } finally {
      this._setBusy('');
    }
  }

  /**
   * RUN EPIDEMIC MODEL: the scan, the profile and the interventions to the
   * server's ensemble; its chances of arrival go to the map and the list.
   */
  async _runEpidemic() {
    if (this._busy) {
      this._say(`Still working: ${this._busy}.`);
      return;
    }
    const scan = this._state.scan;
    if (!scan) {
      this._say('Press SCAN TRAVEL first: the model runs over its flights.');
      return;
    }
    if (!this._state.locations.length) {
      this._say('Add an outbreak location first.');
      return;
    }
    const runs = Number(this._epiRuns?.value) || 200;
    this._state.epidemicRuns = runs;
    const days = EPIDEMIC_FORECAST_DAYS.includes(Number(this._epiDays?.value))
      ? Number(this._epiDays.value)
      : this._state.epidemicDays;
    this._state.epidemicDays = days;
    // The seed box as it stands (blank: the server derives one).
    const seed = this._epiSeed
      ? cleanSeed(this._epiSeed.value)
      : this._state.epidemicSeed;
    this._state.epidemicSeed = seed;
    this._save();
    this._setBusy('the epidemic model');
    // While it runs: RUNNING MODEL... on the button, with the seconds so far.
    const startedAt = this._now();
    const running = () => {
      const seconds = Math.floor((this._now() - startedAt) / 1000);
      if (this._epiRunBtn)
        this._epiRunBtn.textContent = `RUNNING MODEL... ${seconds} s`;
      this._say(
        `Running Model... ${runs} runs · ${days} days ahead · ${seconds} s`,
      );
    };
    if (this._epiRunBtn) this._epiRunBtn.disabled = true;
    running();
    const ticker = globalThis.setInterval(running, 1000);
    try {
      const untilMs = this._now() + days * 24 * 3_600_000;
      const controller =
        typeof AbortController === 'undefined' ? null : new AbortController();
      const timer = controller
        ? globalThis.setTimeout(() => controller.abort(), EPIDEMIC_TIMEOUT_MS)
        : null;
      const body = {
        startMs: scan.startMs,
        untilMs,
        runs,
        // Only when set: the server derives one from the inputs otherwise.
        ...(seed === null ? {} : { seed }),
        outbreakAirports: scan.airports || [],
        locations: this._state.locations.map((l) => ({
          id: l.id,
          name: l.name,
          lat: l.lat,
          lon: l.lon,
        })),
        flights: (scan.flights || []).map((f) => ({
          from: f.from.code,
          to: f.to.code,
          departMs: f.departMs,
          arriveMs: f.arriveMs,
          hop: f.hop,
        })),
        profile: this._state.profile,
        // Rail travel (owner ruling 2026-10-12): at the box's train speed,
        // and left out only with the train off.
        speedKmh: this._state.speeds.train,
        rail: this._state.shown?.train !== false,
      };
      let response;
      try {
        response = await this._request(`${API}/epidemic`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          ...(controller ? { signal: controller.signal } : {}),
          body: JSON.stringify(body),
        });
      } finally {
        if (timer !== null) globalThis.clearTimeout(timer);
      }
      const data = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(data?.places))
        throw new Error(data?.error || `HTTP ${response.status}`);
      this._epidemic = data;
      this._lastRequest = { ...body, flightCount: body.flights.length };
      // Kept across reloads when small enough; the full result stays here.
      this._state.epidemic = trimmedEpidemic(data);
      this._keepFullEpidemic(data);
      if (!this._state.epidemic && !this._resultStore && !this._persistWarned) {
        this._persistWarned = true;
        console.warn(
          `Outbreak: the epidemic result is over ${EPIDEMIC_PERSIST_MAX_BYTES.toLocaleString('en-US')} bytes even trimmed and is not kept across reloads.`,
        );
      }
      this._renderEpidemic();
      const sensitivity = Array.isArray(data.sensitivity)
        ? data.sensitivity
        : [];
      this._log(
        'EPIDEMIC MODEL',
        [
          // Every place at risk, however many.
          ...epidemicLines(data, { max: Infinity }),
          `Network: ${data.network?.places ?? '?'} places, ${data.network?.flights ?? '?'} scanned flights and ${data.network?.routes ?? '?'} daily routes${data.network?.capped ? ' (capped)' : ''}. People: ${data.populationSource || 'unknown'}.`,
          ...(data.railSource === 'pending'
            ? [
                'Rail: the world rail is still being found; rail travel joins the model once it is built.',
              ]
            : data.network?.railRoutes
              ? [
                  `Rail: ${count(data.network.railRoutes)} daily rail routes, ${count(data.railStats?.passengersPerDay)} travellers a day (${data.railSource}).`,
                ]
              : []),
          ...(sensitivity.length
            ? [
                `What moves R most (one at a time): ${sensitivity
                  .slice(0, 3)
                  .map(
                    (r) =>
                      `${r.key} ${r.low}–${r.high} → R ${r.rLow}–${r.rHigh}`,
                  )
                  .join(' · ')}`,
              ]
            : []),
          'A scenario model for exploring, not a forecast of real cases.',
        ].join('\n'),
      );
      this._state.show = true;
      if (this._showBox) this._showBox.checked = true;
      this._save();
      this._refresh();
      this._send({ show: true });
      this._say(this._epidemicStatus('DONE'));
    } catch (error) {
      this._say(
        error?.name === 'AbortError'
          ? 'The epidemic model took too long. Try fewer runs.'
          : `EPIDEMIC MODEL: ${error?.message || 'failed'}`,
      );
    } finally {
      globalThis.clearInterval(ticker);
      if (this._epiRunBtn) {
        this._epiRunBtn.textContent = 'RUN EPIDEMIC MODEL';
        this._epiRunBtn.disabled = false;
      }
      this._setBusy('');
    }
  }

  /** The status line for a result: `how` is DONE or (saved result). */
  _epidemicStatus(how) {
    const data = this._epidemic;
    const atRisk = data.places.filter((pl) => !pl.origin).length;
    const limit =
      data.stoppedAt?.run === 0
        ? ` · time limit: stopped at day ${Math.ceil(data.stoppedAt.hour / 24)} of ${Math.ceil(data.hours / 24)} (try fewer days)`
        : data.partial && Number.isFinite(data.runsAsked)
          ? data.counterfactual && data.runs >= data.runsAsked
            ? // Every main run finished; the comparison was cut.
              ` · time limit: ${data.counterfactual.runs ?? 0} of ${data.runs} paired runs`
            : ` · time limit: ${data.runs} of ${data.runsAsked} runs (try 50)`
          : '';
    const paired =
      data.counterfactual?.runs > 0
        ? ` · ${data.counterfactual.runs} paired runs × 2 arms`
        : '';
    return (
      `EPIDEMIC MODEL ${how} · ${atRisk} places at risk · ${data.runs} runs` +
      limit +
      paired
    );
  }

  /**
   * The model's headline and every place at risk, under the buttons. The
   * rows are built in a fragment and go in at once, so a long list is laid
   * out once; the panel's own scroll carries it.
   */
  _renderEpidemic() {
    this._renderCurve();
    for (const button of [this._epiDownload, this._epiCsv])
      if (button) button.disabled = !this._epidemic;
    if (!this._epiList || !this._doc) return;
    this._epiList.replaceChildren();
    if (!this._epidemic) return;
    const fragment =
      typeof this._doc.createDocumentFragment === 'function'
        ? this._doc.createDocumentFragment()
        : this._epiList;
    const note = epidemicTrimmedNote(this._epidemic);
    for (const line of [
      ...epidemicLines(this._epidemic, { max: Infinity }),
      ...(note ? [note] : []),
    ])
      fragment.appendChild(this._item(line));
    if (fragment !== this._epiList) this._epiList.appendChild(fragment);
  }

  /** DOWNLOAD RESULTS: the result and the request that made it, as JSON. */
  _downloadJson() {
    const result = this._epidemic;
    if (!result) return;
    const request = this._lastRequest || {
      startMs: result.startMs,
      untilMs: result.untilMs,
      runs: result.runs,
      seed: result.seed,
    };
    this._download(
      `outbreak-epidemic-${result.seed ?? 'auto'}.json`,
      JSON.stringify(
        epidemicExport(result, request, { now: this._now }),
        null,
        2,
      ),
      'application/json',
    );
    const note = epidemicTrimmedNote(result);
    if (note) this._say(`DOWNLOAD RESULTS: ${note}`);
  }

  /** DOWNLOAD CSV: the places table, a blank line, then the daily totals. */
  _downloadCsv() {
    const result = this._epidemic;
    if (!result) return;
    this._download(
      `outbreak-epidemic-${result.seed ?? 'auto'}.csv`,
      `${epidemicPlacesCsv(result)}\r\n\r\n${epidemicTotalsCsv(result)}`,
      'text/csv',
    );
    const note = epidemicTrimmedNote(result);
    if (note) this._say(`DOWNLOAD CSV: ${note}`);
  }

  /**
   * Keeps the whole result in IndexedDB under a fresh id, which the state
   * (localStorage) names, so a reload takes back only this run's result.
   */
  _keepFullEpidemic(data) {
    const id = this._now();
    this._state.epidemicId = this._resultStore ? id : null;
    if (!this._resultStore) return Promise.resolve(false);
    let put;
    try {
      put = this._resultStore.put(OUTBREAK_STORAGE_KEY, { id, result: data });
    } catch (error) {
      put = Promise.reject(error);
    }
    return Promise.resolve(put).then(
      () => true,
      () => {
        // Not kept whole: the trimmed copy is all a reload gets.
        if (this._state.epidemicId === id) {
          this._state.epidemicId = null;
          this._save();
        }
        return false;
      },
    );
  }

  _dropFullEpidemic() {
    this._state.epidemicId = null;
    try {
      Promise.resolve(this._resultStore?.delete(OUTBREAK_STORAGE_KEY)).catch(
        () => {},
      );
    } catch {
      /* Nothing kept. */
    }
  }

  /**
   * After a reload: the whole result from IndexedDB in place of the trimmed
   * copy (or of none, when it was too big for localStorage). Only the run
   * the state names, and only while no newer run or CLEAR came since.
   */
  async _restoreFullEpidemic() {
    const id = this._state.epidemicId;
    if (!this._resultStore || !Number.isFinite(id)) return false;
    const before = this._epidemic;
    let record;
    try {
      record = await this._resultStore.get(OUTBREAK_STORAGE_KEY);
    } catch {
      return false;
    }
    if (
      record?.id !== id ||
      !Array.isArray(record.result?.places) ||
      this._state.epidemicId !== id ||
      this._epidemic !== before
    )
      return false;
    this._epidemic = record.result;
    this._renderEpidemic();
    this._send();
    if (!before) this._say(this._epidemicStatus('(saved result)'));
    return true;
  }

  /**
   * Saves `text` as a file named `name` through a hidden link. Says so when
   * this is not a browser (no Blob, no object URLs, no elements to make).
   */
  _download(name, text, type) {
    const doc = this._doc;
    if (
      typeof Blob === 'undefined' ||
      typeof URL?.createObjectURL !== 'function' ||
      typeof doc?.createElement !== 'function'
    ) {
      this._say('Downloads need a browser.');
      return false;
    }
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = doc.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    doc.body?.appendChild?.(link);
    link.click?.();
    link.remove?.();
    // The browser has read the blob by then.
    globalThis.setTimeout(() => URL.revokeObjectURL?.(url), 1000);
    this._say(`Saved ${name}.`);
    return true;
  }

  /**
   * The epidemic curve, day by day: infected (teal line, its 5–95 % band
   * shaded), reported (orange), deaths (red), in hospital (blue) and in
   * intensive care (dashed violet), on one scale; a white tick marks the
   * median peak day.
   */
  _renderCurve() {
    const box = this._epiCurve;
    if (!box) return;
    box.replaceChildren?.();
    const totals = this._epidemic?.totals || [];
    const doc = this._doc;
    if (!totals.length || typeof doc?.createElementNS !== 'function') {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const NS = 'http://www.w3.org/2000/svg';
    const W = 280;
    const H = 90;
    const pad = 4;
    const max = Math.max(
      1,
      ...totals.map((t) => Math.max(t.p95, t.counterfactualP50 ?? 0)),
    );
    // Rt on its own 0 to RT_CURVE_MAX axis, when the result has it.
    const hasRt = totals.some((t) => Number.isFinite(t.rtP50));
    const yRt = (v) =>
      H - pad - ((H - 2 * pad) * Math.min(v, RT_CURVE_MAX)) / RT_CURVE_MAX;
    const x = (i) =>
      pad +
      ((W - 2 * pad) * (totals.length === 1 ? 1 : i)) /
        Math.max(1, totals.length - 1);
    const y = (v) => H - pad - ((H - 2 * pad) * (v || 0)) / max;
    const el = (tag, attrs) => {
      const node = doc.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attrs))
        node.setAttribute(key, String(value));
      return node;
    };
    const line = (key) =>
      totals
        .map((t, i) => `${x(i).toFixed(1)},${y(t[key]).toFixed(1)}`)
        .join(' ');
    const svg = el('svg', {
      viewBox: `0 0 ${W} ${H}`,
      width: '100%',
      height: H,
      role: 'img',
      'aria-label':
        `Epidemic curve over ${totals.length} days: up to ${max.toLocaleString('en-US')} infected` +
        (hasRt ? `; Rt line on a 0 to ${RT_CURVE_MAX} scale` : ''),
    });
    const band = [
      ...totals.map((t, i) => `${x(i).toFixed(1)},${y(t.p95).toFixed(1)}`),
      ...totals
        .map((t, i) => `${x(i).toFixed(1)},${y(t.p5).toFixed(1)}`)
        .reverse(),
    ].join(' ');
    svg.appendChild(
      el('polygon', { points: band, fill: '#19e6b0', 'fill-opacity': 0.18 }),
    );
    // A result from before the hospital path draws flat lines, never NaN.
    for (const [key, color, extra] of [
      ['p50', '#19e6b0'],
      ['reportedP50', '#ffb14a'],
      ['deathsP50', '#ff4a4a'],
      ['hospitalP50', EPIDEMIC_CURVE_COLORS.hospital],
      ['icuP50', EPIDEMIC_CURVE_COLORS.icu, { 'stroke-dasharray': '3 2' }],
      // The second strain and the comparison run, only when the result has them.
      ...(totals[0].strain2P50 !== undefined
        ? [
            [
              'strain2P50',
              EPIDEMIC_CURVE_COLORS.strain2,
              { 'stroke-dasharray': '5 2' },
            ],
          ]
        : []),
      ...(totals.some((t) => Number.isFinite(t.counterfactualP50))
        ? [
            [
              'counterfactualP50',
              EPIDEMIC_CURVE_COLORS.compare,
              { 'stroke-dasharray': '4 3', 'stroke-opacity': 0.7 },
            ],
          ]
        : []),
    ])
      svg.appendChild(
        el('polyline', {
          points: line(key),
          fill: 'none',
          stroke: color,
          'stroke-width': 1.6,
          ...(extra || {}),
        }),
      );
    const summary = this._epidemic?.summary || {};
    const peakDay = summary.peakDayP50;
    if (Number.isFinite(peakDay)) {
      const tick = x(Math.min(totals.length - 1, Math.max(0, peakDay - 1)));
      svg.appendChild(
        el('line', {
          x1: tick.toFixed(1),
          x2: tick.toFixed(1),
          y1: pad,
          y2: H - pad,
          stroke: EPIDEMIC_CURVE_COLORS.peak,
          'stroke-width': 0.8,
          'stroke-opacity': 0.6,
        }),
      );
    }
    if (hasRt) {
      // One line per stretch of days that have an Rt, then the Rt = 1 line.
      let run = [];
      const flush = () => {
        if (run.length)
          svg.appendChild(
            el('polyline', {
              points: run.join(' '),
              fill: 'none',
              stroke: EPIDEMIC_CURVE_COLORS.rt,
              'stroke-width': 1.2,
            }),
          );
        run = [];
      };
      totals.forEach((t, i) => {
        if (Number.isFinite(t.rtP50))
          run.push(`${x(i).toFixed(1)},${yRt(t.rtP50).toFixed(1)}`);
        else flush();
      });
      flush();
      svg.appendChild(
        el('line', {
          x1: pad,
          x2: W - pad,
          y1: yRt(1).toFixed(1),
          y2: yRt(1).toFixed(1),
          stroke: EPIDEMIC_CURVE_COLORS.rt,
          'stroke-width': 0.6,
          'stroke-dasharray': '2 3',
          'stroke-opacity': 0.6,
        }),
      );
    }
    box.appendChild(svg);
    const count = (n) => (n ?? 0).toLocaleString('en-US');
    const legend = doc.createElement('p');
    legend.className = 'outbreak-epi-legend';
    const last = totals.at(-1);
    legend.textContent = `Day ${totals.length}: infected ${count(last.p50)} (5–95 %: ${count(last.p5)}–${count(last.p95)}) · reported ${count(last.reportedP50)} · deaths ${count(last.deathsP50)}`;
    box.appendChild(legend);
    // The second legend: the peak and the hospital load, when the result has them.
    if (Number.isFinite(peakDay) || last.hospitalP50 !== undefined) {
      const parts = [];
      if (Number.isFinite(peakDay)) {
        const band =
          Number.isFinite(summary.peakDayP5) &&
          Number.isFinite(summary.peakDayP95)
            ? ` (5–95 %: ${summary.peakDayP5}–${summary.peakDayP95})`
            : '';
        parts.push(`Peak day ${peakDay}${band}`);
        if (Number.isFinite(summary.peakNewP50))
          parts.push(`${count(summary.peakNewP50)} new a day`);
      }
      parts.push(`in hospital ${count(last.hospitalP50)}`);
      parts.push(`intensive care ${count(last.icuP50)}`);
      if (summary.overflowRuns > 0) {
        const share = Math.round(summary.overflowRuns * 100);
        parts.push(
          Number.isFinite(summary.overflowDayP50)
            ? `hospitals short of beds from ${timeLabel(this._epidemic.startMs + (summary.overflowDayP50 - 1) * 86_400_000)} in ${share} % of runs`
            : `hospitals short of beds in ${share} % of runs`,
        );
      }
      const peakLegend = doc.createElement('p');
      peakLegend.className = 'outbreak-epi-legend';
      peakLegend.textContent = parts.join(' · ');
      box.appendChild(peakLegend);
    }
    // The third legend: Rt, the second strain and the comparison, when present.
    const more = curveExtras(summary, this._epidemic?.counterfactual);
    if (more.length) {
      const extraLegend = doc.createElement('p');
      extraLegend.className = 'outbreak-epi-legend';
      extraLegend.textContent = more.join(' · ');
      box.appendChild(extraLegend);
    }
  }

  /** A forecast place on the map: by its airport, else by its name. */
  async _placeForecast(row, byCode) {
    const airport = row.code ? byCode.get(row.code) : null;
    let lat = airport?.lat;
    let lon = airport?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      try {
        const place = await this._geocode(row.place);
        lat = place?.lat;
        lon = place?.lng;
      } catch {
        lat = undefined;
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      this._log(
        'FUTURE SPREAD',
        `${row.place} could not be placed on the map.`,
      );
      return null;
    }
    return {
      name: row.place,
      lat,
      lon,
      within: row.within,
      likelihood: row.likelihood,
      reason: row.reason,
    };
  }

  _keepFound(rows, via) {
    const known = new Set(this._state.found.map((r) => r.place.toLowerCase()));
    let added = 0;
    for (const row of rows) {
      if (known.has(row.place.toLowerCase())) continue;
      known.add(row.place.toLowerCase());
      this._state.found.push({ ...row, via });
      added += 1;
    }
    this._state.found = this._state.found.slice(-30);
    this._renderFound();
    this._save();
    return added;
  }

  async _mediaSearch() {
    if (this._busy) {
      this._say(`Still working: ${this._busy}.`);
      return;
    }
    const locations = this._state.locations;
    if (!locations.length) {
      this._say('Add an outbreak location first.');
      return;
    }
    this._setBusy('the media search');
    try {
      this._say('MEDIA SEARCH · global news…');
      const params = new URLSearchParams({
        places: locations.map((l) => l.name).join(';'),
        keywords: this._state.keywords,
      });
      const { response, data } = await this._getJson(`${API}/news?${params}`);
      if (!response.ok)
        throw new Error(data?.error || `HTTP ${response.status}`);
      const articles = data?.articles || [];
      this._log(
        'GLOBAL MEDIA · GDELT',
        articles.length
          ? articles
              .slice(0, 25)
              .map((a) => `${a.title} · ${a.domain} · ${a.url}`)
              .join('\n')
          : 'No article in the last 7 days.',
      );
      if (!articles.length) {
        this._say('MEDIA SEARCH DONE · no article in the last 7 days');
        return;
      }
      this._say('MEDIA SEARCH · the language model is reading the articles…');
      const answer = await this._ask(
        outbreakMediaQuestion(
          locations,
          this._state.keywords,
          this._state.profile,
        ),
        {
          outbreakNews: articles.slice(0, 60),
        },
      );
      this._log('NEW LOCATIONS · LLM', answer);
      const added = this._keepFound(
        parsePlaceLines(answer, locations),
        'Media',
      );
      this._say(
        `MEDIA SEARCH DONE · ${added} new location${added === 1 ? '' : 's'} found`,
      );
    } catch (error) {
      this._say(error?.message || 'The media search failed.');
    } finally {
      this._setBusy('');
    }
  }

  async _socialSearch() {
    if (this._busy) {
      this._say(`Still working: ${this._busy}.`);
      return;
    }
    const locations = this._state.locations;
    if (!locations.length) {
      this._say('Add an outbreak location first.');
      return;
    }
    const providerId = this._swarm?.value === 'openai' ? 'openai' : 'xai';
    const provider = SOCIAL_SWARM_PROVIDERS[providerId];
    const instructions = outbreakSocialInstructions(
      locations,
      this._state.keywords,
      this._state.profile,
    );
    const place = locations[0];
    this._setBusy('the social media search');
    let found = 0;
    this._say(
      `SOCIAL SEARCH · ${provider.title} · ${SOCIAL_SWARM_BOTS.length} BOTS`,
    );
    try {
      const result = await runSocialSwarm({
        request: (url, init) => this._request(url, init),
        provider: providerId,
        instructions,
        place: place.name,
        latitude: place.lat,
        longitude: place.lon,
        onBot: ({ bot, text, error, task }) => {
          if (error) {
            this._log(
              `${provider.title} · ${bot.label}`,
              `BOT FAILED: ${error}`,
            );
            return;
          }
          this._log(`${provider.title} · ${bot.label}`, text);
          // The copied task (no key, no computer) names this place: it is not
          // a finding.
          if (task) return;
          found += this._keepFound(parsePlaceLines(text, locations), bot.label);
        },
        onProgress: ({ back, total }) => {
          this._say(`SOCIAL SEARCH · ${back}/${total} BACK`);
        },
      });
      this._say(
        result.unconfigured ||
          (result.via === 'desktop'
            ? formatSwarmDesktopStatus(result)
            : `SOCIAL SEARCH DONE · ${found} new location${found === 1 ? '' : 's'} found`),
      );
    } finally {
      this._setBusy('');
    }
  }
}
