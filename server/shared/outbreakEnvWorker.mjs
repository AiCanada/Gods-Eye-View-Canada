/**
 * The closed-loop epidemic environment's engine thread (owner request
 * 2026-10-13: reinforcement learning and world-model rollouts). The engine
 * is synchronous, so at each day's end the tape hands the day's state to
 * the main thread and waits (Atomics.wait) for the next day's action, which
 * the main thread writes into shared memory: the engine needs no change.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { epiParameters, simulateEpidemic } from '../../src/outbreakEpi.mjs';
import { sampleScenario } from '../../src/outbreakEpiScenarios.mjs';
import { worldCountries } from '../../src/outbreakEpiTape.mjs';
import { loadWorldSnapshot } from './outbreakWorldStore.mjs';

const { worldDir, scenario: given, seed, shared } = workerData;
const flag = new Int32Array(shared, 0, 2); // [state, length]
const bytes = new Uint8Array(shared, 8);
const world = loadWorldSnapshot(worldDir);
const { countries, countryOfNode } = worldCountries(world.nodes);
const C = countries.length;
const scenario =
  given ??
  sampleScenario(seed >>> 0, {
    seed: 1,
    originPool: Array.from(world.tracked),
    days: workerData.days ?? 40,
  });
const tmp = { S: 0, R: 0, V: 0, Rx: 0 };

/** The day's observation: the run's totals and every country's state. */
function observe(view, day) {
  const state = Array.from({ length: C }, () => new Array(10).fill(0));
  for (let i = 0; i < world.nodes.length; i += 1) {
    view.caughtUp(i, tmp);
    const row = state[countryOfNode[i]];
    row[0] += tmp.S;
    row[1] += view.E[i];
    row[2] += view.P[i];
    row[3] += view.Is[i];
    row[4] += view.Ia[i];
    row[5] += view.H[i];
    row[6] += view.U[i];
    row[7] += tmp.R;
    row[8] += view.D[i];
    row[9] += tmp.V;
  }
  // GLOBAL_CHANNELS (src/outbreakEpiTape.mjs): the 16 totals (the second
  // strain's column 0 without one; before hour 0 only the seeds), then in
  // transit, pending admission, isolated and the awareness signal.
  const global = new Array(20).fill(0);
  if (day > 0) view.totalsRow.forEach((v, j) => (global[j] = v));
  else global[0] = view.totalInfected;
  global[16] = view.inTransit;
  global[17] = view.pendingAdmit;
  global[18] = view.isolated;
  global[19] = view.globalSignal;
  return {
    day,
    global,
    country_state: state.map((row) => row.map((v) => Math.round(v))),
  };
}

/**
 * Wait for the main thread's action for the next day (state 1), or the
 * word to stop (state 2: the thread ends at once). An hour with no word
 * at all ends it too.
 */
function nextAction() {
  const waited = Atomics.wait(flag, 0, 0, 3_600_000);
  if (waited === 'timed-out' || Atomics.load(flag, 0) === 2) process.exit(0);
  const length = flag[1];
  const text = new TextDecoder().decode(bytes.slice(0, length));
  Atomics.store(flag, 0, 0);
  return text ? JSON.parse(text) : null;
}

const tape = {
  begin() {},
  flow() {},
  step(run, day, view) {
    parentPort.postMessage({ type: 'obs', obs: observe(view, day) });
    const action = nextAction();
    if (!action) return null;
    const control = {};
    if (Number.isFinite(action.window)) control.window = action.window >>> 0;
    if (action.switch && typeof action.switch === 'object')
      control.switches = new Map(
        Object.entries(action.switch).map(([node, on]) => [
          Number(node),
          on ? 1 : 0,
        ]),
      );
    if (Array.isArray(action.flag))
      control.flags = action.flag.map((c) => countries[c]).filter(Boolean);
    // The day's magnitudes, as a tape's control sets them (the engine clamps
    // them; what is not given stays the scenario's own).
    for (const name of [
      'lockdown',
      'travelBan',
      'testsPer1000Day',
      'vaccinePer1000Day',
    ])
      if (Number.isFinite(action[name])) control[name] = action[name];
    return control;
  },
  runEnd() {},
};

simulateEpidemic({
  nodes: world.nodes,
  origins: scenario.origins,
  routes: world.routes,
  links: world.links,
  params: epiParameters(scenario.profile || {}),
  startMs: scenario.startMs,
  untilMs: scenario.untilMs,
  runs: 1,
  seed: 1,
  stream: { kind: 'xoshiro128', key: [seed >>> 0, 0x00e1] },
  budgetMs: Infinity,
  now: () => 0,
  tape,
});
parentPort.postMessage({ type: 'done', countries, scenario });
