/**
 * The world-model tape (owner request 2026-10-13): turns each run of the
 * epidemic model into an episode of arrays a world model can learn from —
 * the state of every country and of a fixed set of tracked places at every
 * day's end, the interventions applied each day (exactly, so the run can be
 * replayed, and as dense features), every infected leg flown or ridden, and
 * the run's first events. docs/WORLD-MODEL-DATA.md is the format.
 *
 * Pure: no DOM, no Node. The engine (src/outbreakEpi.mjs) calls the hooks;
 * nothing here draws from the run's stream or changes the run.
 */
import { vaccineTargetCount } from './outbreakEpi.mjs';

export const EPISODE_SCHEMA = 'gev-outbreak-episode/1';

export const STATE_CHANNELS = Object.freeze([
  'S',
  'E',
  'P',
  'Is',
  'Ia',
  'H',
  'U',
  'R',
  'D',
  'V',
  'E2',
  'P2',
  'Is2',
  'Ia2',
  'Rx',
]);
export const CUM_CHANNELS = Object.freeze([
  'infected',
  'reported',
  'admitted',
  'imported',
  'local',
  'reinfected',
  'infected2',
]);
export const AUX_CHANNELS = Object.freeze([
  'switchOn',
  'compliance',
  'caution',
  'contactsLeft',
  'testsUsed',
  'saturated',
]);
export const GLOBAL_CHANNELS = Object.freeze([
  'infected',
  'reported',
  'deaths',
  'ward',
  'icu',
  'admitted',
  'restrictedPeople',
  'vaccinated',
  'countriesClosed',
  'imported',
  'reinfected',
  'distancing',
  'bedsShort',
  'restrictedPlaces',
  'icuAdmitted',
  'infected2',
  'inTransit',
  'pendingAdmit',
  'isolated',
  'globalSignal',
]);
export const GLOBAL_ACTIONS = Object.freeze([
  'windowShare',
  'tracingIsolate',
  'tracingPresym',
  'exitScreening',
  'entryScreening',
  'quarantine',
  'importDetect',
  'lockdownEverywhere',
  'travelBanEverywhere',
]);
export const COUNTRY_ACTIONS = Object.freeze(['borderScope', 'flagged']);
/**
 * The magnitudes a day's control may set (controls_magnitudes columns): NaN
 * where it left the scenario's own setting.
 */
export const MAGNITUDE_CONTROLS = Object.freeze([
  'lockdown',
  'travelBan',
  'testsPer1000Day',
  'vaccinePer1000Day',
]);
export const PLACE_ACTIONS = Object.freeze([
  'lockdown',
  'banned',
  'vaccineTarget',
]);
/** Flow kinds and modes (flows.npy columns 4 and 3). */
export const FLOW_KINDS = Object.freeze([
  'boarded',
  'exitCaught',
  'entryCaught',
  'landed',
  'foundAtGate',
  'flewOn',
]);
export const FLOW_MODES = Object.freeze(['air', 'rail', 'onward']);
export const EVENT_KINDS = Object.freeze([
  'firstArrival',
  'firstReport',
  'firstDeath',
  'tenCases',
  'overwhelmed',
  'switchOn',
  'switchOff',
  'countryFlagged',
  'strain2Seeded',
]);

const NS = STATE_CHANNELS.length;
const NC = CUM_CHANNELS.length;
const NA = AUX_CHANNELS.length;
const NG = GLOBAL_CHANNELS.length;
const NGA = GLOBAL_ACTIONS.length;
const NCA = COUNTRY_ACTIONS.length;
const NPA = PLACE_ACTIONS.length;
const NM = MAGNITUDE_CONTROLS.length;

/**
 * The world's countries: every ISO code on the nodes, sorted, then '' for
 * the nodes with none; and each node's index into that list.
 */
export function worldCountries(nodes) {
  const codes = new Set();
  for (const node of nodes) if (node?.country) codes.add(node.country);
  const countries = [...codes].sort();
  countries.push('');
  const at = new Map(countries.map((code, i) => [code, i]));
  const countryOfNode = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i += 1)
    countryOfNode[i] = at.get(nodes[i]?.country || '');
  return { countries, countryOfNode };
}

/**
 * The tracked places: every large airport, busiest first, then the most
 * populous of the rest, up to `limit`. Node identity is then the same in
 * every episode of a world.
 */
export function trackedPlaces(nodes, limit = 5000) {
  const order = nodes.map((node, i) => i);
  const large = (i) => nodes[i].kind === 'airport' && nodes[i].size === 'L';
  order.sort(
    (a, b) =>
      Number(large(b)) - Number(large(a)) ||
      (nodes[b].population || 0) - (nodes[a].population || 0) ||
      a - b,
  );
  return Int32Array.from(order.slice(0, Math.max(0, limit)));
}

function popcount(x) {
  let v = x >>> 0;
  let c = 0;
  while (v) {
    v &= v - 1;
    c += 1;
  }
  return c;
}

/** Concatenate [day, a, b, …] tuples into an Int32Array of rows. */
function rows(list, width) {
  const out = new Int32Array(list.length * width);
  let k = 0;
  for (const row of list) for (let j = 0; j < width; j += 1) out[k++] = row[j];
  return out;
}

/**
 * The tape for one simulateEpidemic call. `onEpisode(episode)` receives each
 * run's episode at its end. `policy.control(run, day, view, info)` may return
 * the control for day `day` (src/outbreakEpiActions.mjs); unset, the model's
 * own rules decide. `check` throws on a broken conservation identity.
 *
 * @param {object} options
 * @param {object[]} options.nodes The world's nodes (the engine's).
 * @param {Int32Array} options.tracked Tracked node indices (trackedPlaces).
 * @param {string[]} options.countries worldCountries().countries.
 * @param {Int32Array} options.countryOfNode worldCountries().countryOfNode.
 */
export function createEpisodeTape({
  nodes,
  tracked,
  countries,
  countryOfNode,
  policy = null,
  onEpisode = () => {},
  check = false,
  exact = false,
}) {
  const K = tracked.length;
  const C = countries.length;
  const worldIndex = new Map(countries.map((code, i) => [code, i]));
  let info = null;
  let n = 0;
  let T = 0;
  let engineToWorld = null; // engine country index → world index
  let originWorld = null; // world countries holding an origin
  let population = 0;
  // Each node's state before hour 0 and its country's sums, for the fast
  // path: with no waning, campaign or second strain, a node the run never
  // touched is still at its start, so a country is its start plus the
  // touched nodes' change.
  let fast = false;
  let startS = null;
  let startR = null;
  let countryStartS = null;
  let countryStartR = null;
  let seen = null;
  let mark = 0;
  let touched = new Set();
  // Per run.
  let run = -1;
  let day = 0;
  let a = null; // the run's arrays
  let prevNpi = null;
  let prevFlags = null;
  let switchRows = [];
  let flagRows = [];
  let flowRows = [];
  let flowDay = new Map();
  const tmp = { S: 0, R: 0, V: 0, Rx: 0 };

  const allocate = () => {
    a = {
      global: new Float64Array((T + 1) * NG),
      countryState: new Uint32Array((T + 1) * C * NS),
      countryCum: new Uint32Array((T + 1) * C * NC),
      placeState: new Uint32Array((T + 1) * K * NS),
      placeCum: new Uint32Array((T + 1) * K * NC),
      placeAux: new Float32Array((T + 1) * K * NA),
      actionsGlobal: new Float32Array(T * NGA),
      actionsCountry: new Float32Array(T * C * NCA),
      actionsPlace: new Float32Array(T * K * NPA),
      controlsWindow: new Uint32Array(T),
      controlsMagnitudes: new Float64Array(T * NM).fill(NaN),
    };
    prevNpi = new Uint8Array(n);
    prevFlags = new Uint8Array(info.countryCodes.length);
    switchRows = [];
    flagRows = [];
    flowRows = [];
    flowDay = new Map();
    touched = new Set();
  };

  // The state vector of node i into `out` at `at` (15 channels).
  const stateOf = (view, i, out, at) => {
    view.caughtUp(i, tmp);
    out[at] = tmp.S;
    out[at + 1] = view.E[i];
    out[at + 2] = view.P[i];
    out[at + 3] = view.Is[i];
    out[at + 4] = view.Ia[i];
    out[at + 5] = view.H[i];
    out[at + 6] = view.U[i];
    out[at + 7] = tmp.R;
    out[at + 8] = view.D[i];
    out[at + 9] = tmp.V;
    if (view.E2) {
      out[at + 10] = view.E2[i];
      out[at + 11] = view.P2[i];
      out[at + 12] = view.Is2[i];
      out[at + 13] = view.Ia2[i];
      out[at + 14] = view.live2 ? tmp.Rx : tmp.R;
    } else {
      out[at + 10] = out[at + 11] = out[at + 12] = out[at + 13] = 0;
      out[at + 14] = 0;
    }
  };
  const cumOf = (view, i, out, at) => {
    out[at] = view.cum[i];
    out[at + 1] = view.reported[i];
    out[at + 2] = view.cumAdm[i];
    out[at + 3] = view.imported[i];
    out[at + 4] = view.local[i];
    out[at + 5] = view.reinf[i];
    out[at + 6] = view.cum2 ? view.cum2[i] : 0;
  };

  const record = (view, r) => {
    const dayNow = Math.floor(view.hour / 24);
    // Tracked places.
    const st = new Float64Array(NS);
    const cu = new Float64Array(NC);
    for (let k = 0; k < K; k += 1) {
      const i = tracked[k];
      stateOf(view, i, st, 0);
      cumOf(view, i, cu, 0);
      const so = (r * K + k) * NS;
      for (let j = 0; j < NS; j += 1) a.placeState[so + j] = Math.round(st[j]);
      const co = (r * K + k) * NC;
      for (let j = 0; j < NC; j += 1) a.placeCum[co + j] = Math.round(cu[j]);
      const ao = (r * K + k) * NA;
      const caution = view.cautionOf(i);
      a.placeAux[ao] = view.npiOn[i];
      a.placeAux[ao + 1] = info.perPlace
        ? view.npiOn[i]
          ? view.cDay[i]
          : 1
        : view.cNow;
      a.placeAux[ao + 2] = caution;
      a.placeAux[ao + 3] = view.lockdownOf(i) * caution;
      a.placeAux[ao + 4] =
        view.testsDay[i] === dayNow && r > 0 ? view.testsUsed[i] : 0;
      a.placeAux[ao + 5] = view.saturated[i];
    }
    // Countries, summed in float64, then stored whole: every node, or (the
    // fast path) the start plus the change at every touched node.
    const cs = new Float64Array(C * NS);
    const cc = new Float64Array(C * NC);
    const add = (i) => {
      const c = countryOfNode[i];
      stateOf(view, i, st, 0);
      cumOf(view, i, cu, 0);
      const so = c * NS;
      for (let j = 0; j < NS; j += 1) cs[so + j] += st[j];
      const co = c * NC;
      for (let j = 0; j < NC; j += 1) cc[co + j] += cu[j];
    };
    if (fast) {
      for (let c = 0; c < C; c += 1) {
        cs[c * NS] = countryStartS[c];
        cs[c * NS + 7] = countryStartR[c];
      }
      mark += 1;
      const once = (i) => {
        if (seen[i] === mark) return;
        seen[i] = mark;
        cs[countryOfNode[i] * NS] -= startS[i];
        cs[countryOfNode[i] * NS + 7] -= startR[i];
        add(i);
      };
      for (const i of view.reachedList) once(i);
      for (const i of touched) once(i);
      for (const i of info.origins) once(i);
    } else for (let i = 0; i < n; i += 1) add(i);
    a.countryState.set(
      cs.map((v) => Math.round(v)),
      r * C * NS,
    );
    a.countryCum.set(
      cc.map((v) => Math.round(v)),
      r * C * NC,
    );
    // The run as a whole.
    const g = r * NG;
    const row = r > 0 ? view.totalsRow : null;
    if (row)
      for (let j = 0; j < Math.min(16, row.length); j += 1)
        a.global[g + j] = row[j];
    else a.global[g] = view.totalInfected;
    a.global[g + 16] = view.inTransit;
    a.global[g + 17] = view.pendingAdmit;
    a.global[g + 18] = view.isolated;
    a.global[g + 19] = view.globalSignal;
    if (check) {
      let people =
        view.deaths + view.inTransit + view.pendingAdmit + view.isolated;
      for (let c = 0; c < C; c += 1) {
        const o = c * NS;
        for (const j of [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13])
          people += cs[o + j];
      }
      if (Math.abs(people - population) > 0.5)
        throw new Error(
          `tape: conservation broken at row ${r} of run ${run}: ${people - population}`,
        );
    }
  };

  // The decisions of the day just run (`d`), exact and as features.
  const decisions = (view, d) => {
    const mask = view.windowMask >>> 0;
    a.controlsWindow[d] = mask;
    const hoursToday = Math.max(1, Math.min(24, info.hours - 24 * d));
    const share = popcount(mask) / hoursToday;
    const params = info.params;
    const iv = params.interventions;
    const ga = d * NGA;
    a.actionsGlobal[ga] = share;
    a.actionsGlobal[ga + 1] = (iv.tracingIsolate || 0) * share;
    a.actionsGlobal[ga + 2] = (iv.tracingPresym || 0) * share;
    a.actionsGlobal[ga + 3] = iv.exitScreening ? share : 0;
    a.actionsGlobal[ga + 4] = iv.entryScreening ? share : 0;
    a.actionsGlobal[ga + 5] = info.quarantineCatch * share;
    a.actionsGlobal[ga + 6] = params.importDetect || 0;
    // The day's magnitudes as applied (a control may have set them).
    const lockdown = view.lockdownLevel ?? iv.lockdown;
    const travelBan = view.travelBanShare ?? iv.travelBan;
    a.actionsGlobal[ga + 7] = info.perPlace ? 0 : (lockdown || 0) * share;
    a.actionsGlobal[ga + 8] = info.perPlace ? 0 : (travelBan || 0) * share;
    // Switch changes at the day's tick: anywhere in the world.
    const npi = view.npiOn;
    for (let i = 0; i < n; i += 1)
      if (npi[i] !== prevNpi[i]) {
        switchRows.push([d, i, npi[i]]);
        prevNpi[i] = npi[i];
      }
    // Countries flagged at the tick (engine index → world index).
    const flagged = new Uint8Array(C);
    for (let c = 0; c < prevFlags.length; c += 1) {
      const w = engineToWorld[c];
      if (view.countryFlagged[c]) flagged[w] = 1;
      if (view.countryFlagged[c] !== prevFlags[c]) {
        flagRows.push([d, w]);
        prevFlags[c] = view.countryFlagged[c];
      }
    }
    for (let c = 0; c < C; c += 1) {
      const o = (d * C + c) * NCA;
      const policy = info.borderPolicy;
      a.actionsCountry[o] =
        policy === 'origin'
          ? originWorld[c]
          : policy === 'reported'
            ? flagged[c]
            : 1;
      a.actionsCountry[o + 1] = flagged[c];
    }
    for (let k = 0; k < K; k += 1) {
      const i = tracked[k];
      const o = (d * K + k) * NPA;
      if (info.perPlace) {
        a.actionsPlace[o] = npi[i] ? lockdown || 0 : 0;
        a.actionsPlace[o + 1] = npi[i] && travelBan > 0 ? travelBan : 0;
      } else {
        a.actionsPlace[o] = (lockdown || 0) * share;
        a.actionsPlace[o + 1] = (travelBan || 0) * share;
      }
      a.actionsPlace[o + 2] = info.vaccine
        ? (view.vaccineTargetOf
            ? view.vaccineTargetOf(i, d)
            : vaccineTargetCount(
                info.N[i],
                info.isOrigin[i],
                d,
                info.vaccine,
                info.vaccineEfficacy,
                info.vaccineProtectDays,
              )) / info.N[i]
        : 0;
    }
  };

  const flushFlows = (d) => {
    for (const [key, people] of flowDay) {
      let rest = key;
      const kind = rest % 6;
      rest = (rest - kind) / 6;
      const mode = rest % 3;
      rest = (rest - mode) / 3;
      const to = rest % (n + 1);
      const from = (rest - to) / (n + 1) - 1;
      flowRows.push([d, from, to, mode, kind, Math.round(people)]);
    }
    flowDay = new Map();
  };

  // The control for day d, its magnitudes logged exactly as given (the
  // engine clamps them the same way on a replay).
  const control = (view, d) => {
    const given = policy ? policy.control(run, d, view, info) || null : null;
    if (given && d < T)
      MAGNITUDE_CONTROLS.forEach((name, j) => {
        if (Number.isFinite(given[name]))
          a.controlsMagnitudes[d * NM + j] = given[name];
      });
    return given;
  };

  return {
    begin(engineInfo) {
      info = engineInfo;
      n = info.n;
      T = info.days;
      engineToWorld = Int32Array.from(info.countryCodes, (code) =>
        worldIndex.has(code) ? worldIndex.get(code) : C - 1,
      );
      originWorld = new Uint8Array(C);
      for (const i of info.origins)
        if (nodes[i]?.country) originWorld[countryOfNode[i]] = 1;
      population = 0;
      for (let i = 0; i < n; i += 1) population += info.N[i];
      fast = !exact && !info.waning && !info.vaccine && !info.params.strain2;
      startS = new Float64Array(n);
      startR = new Float64Array(n);
      countryStartS = new Float64Array(C);
      countryStartR = new Float64Array(C);
      seen = new Int32Array(n);
      for (let i = 0; i < n; i += 1) {
        startS[i] = Math.round(info.N[i] * info.params.susceptibleShare);
        startR[i] = info.N[i] - startS[i];
        countryStartS[countryOfNode[i]] += startS[i];
        countryStartR[countryOfNode[i]] += startR[i];
      }
      policy?.begin?.(info);
    },
    step(r, d, view) {
      if (d === 0) {
        run = r;
        day = 0;
        allocate();
        record(view, 0);
        return control(view, 0);
      }
      if (d > T) return null;
      flushFlows(d - 1);
      decisions(view, d - 1);
      record(view, d);
      day = d;
      return control(view, d);
    },
    flow(kind, mode, from, to, people) {
      if (!(people > 0)) return;
      if (kind === 3 || kind === 4) touched.add(to);
      const key = (((from + 1) * (n + 1) + to) * 3 + mode) * 6 + kind;
      flowDay.set(key, (flowDay.get(key) || 0) + people);
    },
    runEnd(r, view) {
      if (flowDay.size) flushFlows(Math.min(day, T - 1));
      // First events, read off the run's own stamps.
      const events = [];
      const stamps = [
        [view.arrived, 0],
        [view.firstReport, 1],
        [view.firstDeath, 2],
        [view.firstTen, 3],
        [view.overflowAt, 4],
      ];
      for (let i = 0; i < n; i += 1)
        for (const [list, kind] of stamps)
          if (Number.isFinite(list[i]))
            events.push([list[i], i, kind, kind === 0 ? view.firstBy[i] : 0]);
      for (const [d, i, on] of switchRows)
        events.push([24 * d, i, on ? 5 : 6, 0]);
      for (const [d, c] of flagRows) events.push([24 * d, -1, 7, c]);
      if (Number.isFinite(view.strain2SeededAt))
        events.push([view.strain2SeededAt, -1, 8, 0]);
      events.sort((x, y) => x[0] - y[0] || x[2] - y[2] || x[1] - y[1]);
      // Labels: how the run went.
      const params = info.params;
      let living = 0;
      for (const i of view.active)
        living +=
          view.E[i] +
          view.P[i] +
          view.Is[i] +
          view.Ia[i] +
          view.H[i] +
          view.U[i] +
          (view.E2 ? view.E2[i] + view.P2[i] + view.Is2[i] + view.Ia2[i] : 0);
      let peakDay = 0;
      let peakNew = -1;
      let peakWard = 0;
      for (let d = 1; d <= T; d += 1) {
        const fresh = a.global[d * NG] - a.global[(d - 1) * NG];
        if (fresh > peakNew) {
          peakNew = fresh;
          peakDay = d - 1;
        }
        peakWard = Math.max(peakWard, a.global[d * NG + 3]);
      }
      const reachedCountries = new Set();
      for (const i of view.reachedList) reachedCountries.add(countryOfNode[i]);
      const infected = a.global[T * NG];
      const seeded =
        (params.initialCases ?? 0) +
        (Number.isFinite(view.strain2SeededAt)
          ? (params.strain2?.cases ?? 0)
          : 0);
      onEpisode({
        schema: EPISODE_SCHEMA,
        run: r,
        days: T,
        hours: info.hours,
        places: K,
        countries: C,
        labels: {
          extinct: living === 0 && infected < seeded + 20,
          infected,
          deaths: a.global[T * NG + 2],
          reported: a.global[T * NG + 1],
          peakDay,
          peakNew: Math.max(0, peakNew),
          peakWard,
          reached: view.reachedList.length,
          countriesReached: reachedCountries.size,
          switches: switchRows.length,
          flags: flagRows.length,
        },
        constants: {
          perPlace: info.perPlace,
          borderPolicy: info.borderPolicy,
          startHour: info.startHour,
          endHour: Number.isFinite(info.endHour) ? info.endHour : null,
          lockdown: params.interventions.lockdown || 0,
          travelBan: params.interventions.travelBan || 0,
          tracingIsolate: params.interventions.tracingIsolate || 0,
          tracingPresym: params.interventions.tracingPresym || 0,
          exitScreening: Boolean(params.interventions.exitScreening),
          entryScreening: Boolean(params.interventions.entryScreening),
          quarantineCatch: info.quarantineCatch,
          importDetect: params.importDetect || 0,
          testsPer1000Day: params.testsPer1000Day || 0,
          vaccine: info.vaccine
            ? { ...info.vaccine, efficacy: info.vaccineEfficacy }
            : null,
        },
        arrays: {
          global: { data: a.global, shape: [T + 1, NG] },
          country_state: { data: a.countryState, shape: [T + 1, C, NS] },
          country_cum: { data: a.countryCum, shape: [T + 1, C, NC] },
          place_state: { data: a.placeState, shape: [T + 1, K, NS] },
          place_cum: { data: a.placeCum, shape: [T + 1, K, NC] },
          place_aux: { data: a.placeAux, shape: [T + 1, K, NA] },
          actions_global: { data: a.actionsGlobal, shape: [T, NGA] },
          actions_country: { data: a.actionsCountry, shape: [T, C, NCA] },
          actions_place: { data: a.actionsPlace, shape: [T, K, NPA] },
          controls_window: { data: a.controlsWindow, shape: [T] },
          controls_magnitudes: {
            data: a.controlsMagnitudes,
            shape: [T, NM],
          },
          controls_switch: {
            data: rows(switchRows, 3),
            shape: [switchRows.length, 3],
          },
          controls_flags: {
            data: rows(flagRows, 2),
            shape: [flagRows.length, 2],
          },
          flows: { data: rows(flowRows, 6), shape: [flowRows.length, 6] },
          events: {
            data: Int32Array.from(events.flat()),
            shape: [events.length, 4],
          },
        },
      });
      a = null;
    },
  };
}

/**
 * A policy that replays an episode's exact controls: same seed, same input,
 * same episode. `countries` is the world's list (controls_flags holds world
 * indices; the engine takes ISO codes).
 */
export function replayPolicy(arrays, countries) {
  const window = arrays.controls_window.data;
  const magnitudes = arrays.controls_magnitudes?.data || null;
  const byDay = new Map();
  const sw = arrays.controls_switch;
  for (let r = 0; r < sw.shape[0]; r += 1) {
    const d = sw.data[r * 3];
    if (!byDay.has(d)) byDay.set(d, { switches: new Map(), flags: [] });
    byDay.get(d).switches.set(sw.data[r * 3 + 1], sw.data[r * 3 + 2]);
  }
  const fl = arrays.controls_flags;
  for (let r = 0; r < fl.shape[0]; r += 1) {
    const d = fl.data[r * 2];
    if (!byDay.has(d)) byDay.set(d, { switches: new Map(), flags: [] });
    byDay.get(d).flags.push(countries[fl.data[r * 2 + 1]]);
  }
  return {
    control(run, d) {
      if (d >= window.length) return null;
      const entry = byDay.get(d);
      const out = {
        window: window[d],
        switches: entry ? entry.switches : new Map(),
        flags: entry ? entry.flags : [],
      };
      if (magnitudes)
        MAGNITUDE_CONTROLS.forEach((name, j) => {
          const value = magnitudes[d * NM + j];
          if (Number.isFinite(value)) out[name] = value;
        });
      return out;
    },
  };
}
