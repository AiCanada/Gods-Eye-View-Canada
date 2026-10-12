// The dev supervisor's decisions: when a dead child is relaunched, paused,
// given up on, or left alone because another server took over; how health
// probes become a hang; when the log rotates; when QuickEdit is switched off;
// where the probe goes; and the lines it writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KILL_ESCALATE_MS,
  LOG_CAP_BYTES,
  MAX_BACKOFF_MS,
  MAX_FAST_FAILURES,
  PROBE_INTERVAL_MS,
  PROBE_MISSES_FOR_HANG,
  QUICKEDIT_SCRIPT,
  RECORD_POLL_MS,
  RECYCLE_RESTARTS,
  RECYCLE_RSS_BYTES,
  STABLE_UPTIME_MS,
  backoffMs,
  formatExitLine,
  healthState,
  killPlan,
  killWithEscalation,
  parseRecord,
  probeOutcome,
  probeTarget,
  quickEditPlan,
  recyclePlan,
  restartDecision,
  rotationPlan,
  spawnPlan,
  startWatchdog,
  takeoverPid,
} from '../../scripts/dev-server.mjs';

const CHILD = 4321;
const SELF = 1000;
const neverAlive = () => false;
const alwaysAlive = () => true;
/** When the child was launched; a takeover record is always written later. */
const LAUNCHED_AT = 1_000_000;
const before = (ms) => new Date(LAUNCHED_AT - ms).toISOString();
const after = (ms) => new Date(LAUNCHED_AT + ms).toISOString();
/** A record another server wrote after it stopped our child. */
const foreignRecord = (extra = {}) => ({
  pid: 9999,
  port: 4173,
  startedAt: after(2000),
  ...extra,
});

/** A crash exit with the usual context; every field can be overridden. */
const crash = (overrides = {}) => ({
  code: 1,
  signal: null,
  uptimeMs: 5000,
  attempts: 0,
  stopping: false,
  ownKill: false,
  record: null,
  childPid: CHILD,
  selfPid: SELF,
  launchedAt: LAUNCHED_AT,
  alive: neverAlive,
  viteLike: true,
  ...overrides,
});

test('backoffMs: doubles from 1 s and caps at 30 s', () => {
  assert.equal(backoffMs(0), 1000);
  assert.equal(backoffMs(1), 2000);
  assert.equal(backoffMs(2), 4000);
  assert.equal(backoffMs(4), 16_000);
  assert.equal(backoffMs(5), MAX_BACKOFF_MS);
  assert.equal(backoffMs(9), MAX_BACKOFF_MS);
  assert.equal(backoffMs(undefined), 1000);
  assert.equal(backoffMs(-3), 1000);
});

test('restartDecision: a requested stop wins over everything', () => {
  const decision = restartDecision(
    crash({ stopping: true, signal: 'SIGTERM', code: null }),
  );
  assert.equal(decision.action, 'stop');
  assert.equal(decision.reason, 'stop requested');
  assert.equal(decision.delayMs, 0);
});

test('restartDecision: exit 0 means the server stopped itself', () => {
  const decision = restartDecision(crash({ code: 0 }));
  assert.equal(decision.action, 'stop');
  assert.equal(decision.reason, 'the server stopped itself');
});

test('restartDecision: CTRL_C_EXIT and 130 are an interruption, not a crash', () => {
  for (const code of [3221225786, 130]) {
    const decision = restartDecision(crash({ code }));
    assert.equal(decision.action, 'stop', `code ${code}`);
    assert.equal(decision.reason, 'interrupted');
    assert.equal(decision.delayMs, 0);
  }
});

test('restartDecision: our own kill signal restarts at once', () => {
  const decision = restartDecision(
    crash({
      code: null,
      signal: 'SIGTERM',
      ownKill: true,
      attempts: 2,
      uptimeMs: 90_000,
    }),
  );
  assert.equal(decision.action, 'restart');
  assert.equal(decision.delayMs, 0);
  assert.match(decision.reason, /SIGTERM/);
  // Stable uptime still resets the count on this path.
  assert.equal(decision.attempts, 0);
  // The watchdog may end up sending SIGKILL; any own signal is the fast path.
  assert.equal(
    restartDecision(crash({ code: null, signal: 'SIGKILL', ownKill: true }))
      .delayMs,
    0,
  );
});

test('restartDecision: a signal from outside is an ordinary failure: backoff, count, give-up, takeover', () => {
  const abort = restartDecision(
    crash({ code: null, signal: 'SIGABRT', attempts: 3, uptimeMs: 5000 }),
  );
  assert.equal(abort.action, 'restart');
  assert.equal(abort.delayMs, backoffMs(3));
  assert.equal(abort.attempts, 4);
  assert.equal(abort.reason, 'killed by SIGABRT');
  assert.equal(
    restartDecision(
      crash({
        code: null,
        signal: 'SIGKILL',
        attempts: MAX_FAST_FAILURES,
        uptimeMs: 5000,
      }),
    ).action,
    'give-up',
  );
  assert.equal(
    restartDecision(
      crash({
        code: null,
        signal: 'SIGTERM',
        record: foreignRecord(),
        alive: alwaysAlive,
      }),
    ).action,
    'stop',
  );
  // A stable server killed from outside starts the count over, but still waits.
  const stable = restartDecision(
    crash({ code: null, signal: 'SIGKILL', attempts: 7, uptimeMs: 90_000 }),
  );
  assert.equal(stable.delayMs, 1000);
  assert.equal(stable.attempts, 1);
});

test('restartDecision: a live foreign Vite in a record newer than the launch means a takeover', () => {
  const decision = restartDecision(
    crash({ record: foreignRecord(), alive: alwaysAlive }),
  );
  assert.equal(decision.action, 'stop');
  assert.equal(decision.reason, 'another dev server took over (pid 9999)');
  assert.equal(decision.delayMs, 0);
  // A record whose supervisor is alive is a takeover too.
  assert.equal(
    restartDecision(
      crash({
        record: foreignRecord({ supervisorPid: 888 }),
        alive: alwaysAlive,
      }),
    ).action,
    'stop',
  );
});

test('restartDecision: the record is no takeover when it names the child, this process, a dead pid, a non-Vite process, is stale, is ours, or its supervisor is dead', () => {
  for (const [name, overrides] of [
    [
      'the child',
      { record: foreignRecord({ pid: CHILD }), alive: alwaysAlive },
    ],
    [
      'this process',
      { record: foreignRecord({ pid: SELF }), alive: alwaysAlive },
    ],
    ['a dead pid', { record: foreignRecord(), alive: neverAlive }],
    [
      'a non-Vite process',
      { record: foreignRecord(), alive: alwaysAlive, viteLike: false },
    ],
    [
      'a record older than the launch (left by a killed server, pid reused)',
      {
        record: foreignRecord({ startedAt: before(500) }),
        alive: alwaysAlive,
      },
    ],
    [
      'a record without a start time',
      { record: { pid: 9999, port: 4173 }, alive: alwaysAlive },
    ],
    [
      'a record one of our own children wrote',
      { record: foreignRecord({ supervisorPid: SELF }), alive: alwaysAlive },
    ],
    [
      'a record whose supervisor is dead (an orphan that exits by itself)',
      {
        record: foreignRecord({ supervisorPid: 888 }),
        alive: (pid) => pid === 9999,
      },
    ],
    ['no record', { record: null, alive: alwaysAlive }],
    ['a malformed record', { record: { pid: 'x' }, alive: alwaysAlive }],
  ]) {
    const decision = restartDecision(crash(overrides));
    assert.equal(decision.action, 'restart', name);
    assert.equal(decision.delayMs, 1000, name);
  }
});

test('takeoverPid: the recorded pid only when the record is fresh, foreign, live and its supervisor is live', () => {
  const base = { childPid: CHILD, selfPid: SELF, launchedAt: LAUNCHED_AT };
  assert.equal(
    takeoverPid({ ...base, record: foreignRecord(), alive: alwaysAlive }),
    9999,
  );
  assert.equal(
    takeoverPid({
      ...base,
      record: foreignRecord({ startedAt: after(0) }),
      alive: alwaysAlive,
    }),
    9999,
    'written at the launch instant counts as after it',
  );
  assert.equal(
    takeoverPid({
      ...base,
      record: foreignRecord({ startedAt: before(1) }),
      alive: alwaysAlive,
    }),
    null,
  );
  assert.equal(
    takeoverPid({
      ...base,
      record: foreignRecord({ supervisorPid: 888 }),
      alive: (pid) => pid !== 888,
    }),
    null,
  );
  assert.equal(
    takeoverPid({
      ...base,
      record: foreignRecord({ supervisorPid: SELF }),
      alive: alwaysAlive,
    }),
    null,
  );
  assert.equal(
    takeoverPid({ ...base, record: foreignRecord(), alive: neverAlive }),
    null,
  );
  assert.equal(
    takeoverPid({ ...base, record: null, alive: alwaysAlive }),
    null,
  );
  assert.equal(takeoverPid(), null);
});

test('restartDecision: a plain crash restarts with growing backoff and counts the attempt', () => {
  const first = restartDecision(crash({ attempts: 0 }));
  assert.deepEqual(
    { action: first.action, delayMs: first.delayMs, attempts: first.attempts },
    { action: 'restart', delayMs: 1000, attempts: 1 },
  );
  assert.equal(first.reason, 'exited with code 1');
  const third = restartDecision(crash({ attempts: 3 }));
  assert.equal(third.delayMs, 8000);
  assert.equal(third.attempts, 4);
  const capped = restartDecision(crash({ attempts: 9 }));
  assert.equal(capped.action, 'restart');
  assert.equal(capped.delayMs, MAX_BACKOFF_MS);
});

test('restartDecision: exit 70 (fatal exception) and 75 (restart guard) are ordinary restarts', () => {
  for (const code of [70, 75]) {
    const decision = restartDecision(crash({ code, attempts: 1 }));
    assert.equal(decision.action, 'restart', `code ${code}`);
    assert.equal(decision.delayMs, 2000);
    assert.equal(decision.reason, `exited with code ${code}`);
  }
});

test('restartDecision: gives up after ten fast failures in a row', () => {
  const decision = restartDecision(crash({ attempts: MAX_FAST_FAILURES }));
  assert.equal(decision.action, 'give-up');
  assert.match(decision.reason, /dev-server\.log/);
  assert.equal(decision.delayMs, 0);
  assert.equal(
    restartDecision(crash({ attempts: MAX_FAST_FAILURES - 1 })).action,
    'restart',
  );
});

test('restartDecision: a minute of uptime resets the failure count', () => {
  const decision = restartDecision(
    crash({ attempts: MAX_FAST_FAILURES + 5, uptimeMs: STABLE_UPTIME_MS }),
  );
  assert.equal(decision.action, 'restart');
  assert.equal(decision.delayMs, 1000);
  assert.equal(decision.attempts, 1);
  assert.equal(
    restartDecision(crash({ attempts: 12, uptimeMs: STABLE_UPTIME_MS - 1 }))
      .action,
    'give-up',
  );
});

test('killPlan: SIGTERM first, SIGKILL once the escalation time is up, nothing for a child that left', () => {
  assert.equal(killPlan({ elapsedMs: 0, exited: false }), 'SIGTERM');
  assert.equal(
    killPlan({ elapsedMs: KILL_ESCALATE_MS - 1, exited: false }),
    'SIGTERM',
  );
  assert.equal(
    killPlan({ elapsedMs: KILL_ESCALATE_MS, exited: false }),
    'SIGKILL',
  );
  assert.equal(killPlan({ elapsedMs: KILL_ESCALATE_MS, exited: true }), 'none');
  assert.equal(killPlan({ elapsedMs: 0, exited: true }), 'none');
  assert.equal(
    killPlan({ elapsedMs: 100, exited: false, escalateMs: 100 }),
    'SIGKILL',
  );
  assert.equal(killPlan(), 'SIGTERM');
  assert.equal(KILL_ESCALATE_MS, 5000);
});

/** A child whose kills are recorded and whose exit can be staged. */
function fakeChild() {
  return {
    exitCode: null,
    signalCode: null,
    kills: [],
    kill(signal) {
      this.kills.push(signal);
      return true;
    },
  };
}

test('killWithEscalation: SIGTERM now, SIGKILL when the timer fires and the child is still there', () => {
  const timers = [];
  const setTimer = (fn, ms) => {
    const timer = {
      fn,
      ms,
      unrefs: 0,
      unref() {
        this.unrefs += 1;
      },
    };
    timers.push(timer);
    return timer;
  };
  const child = fakeChild();
  const timer = killWithEscalation(child, { setTimer });
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(timer, timers[0]);
  assert.equal(timer.ms, KILL_ESCALATE_MS);
  assert.equal(timer.unrefs, 1, 'the escalation never keeps the process alive');
  timer.fn();
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);

  // A child that left on SIGTERM is not killed again.
  const polite = fakeChild();
  const second = killWithEscalation(polite, { setTimer, escalateMs: 10 });
  assert.equal(second.ms, 10);
  polite.signalCode = 'SIGTERM';
  second.fn();
  assert.deepEqual(polite.kills, ['SIGTERM']);
  const exitedByCode = fakeChild();
  exitedByCode.exitCode = 0;
  killWithEscalation(exitedByCode, { setTimer });
  assert.deepEqual(exitedByCode.kills, []);

  // A kill that throws is swallowed.
  const gone = fakeChild();
  gone.kill = () => {
    throw new Error('ESRCH');
  };
  assert.doesNotThrow(() => killWithEscalation(gone, { setTimer }));
});

/**
 * A watchdog driven by hand: timers are captured, probes answer from a
 * queue, and the record is whatever the test says it is.
 */
function fakeWatchdog({ record, outcomes = [], recycle = false } = {}) {
  const state = {
    record,
    outcomes: [...outcomes],
    timers: [],
    cleared: [],
    probes: [],
    logs: [],
    hangs: 0,
    recycles: 0,
  };
  const watchdog = startWatchdog({
    childPid: CHILD,
    log: (line) => state.logs.push(line),
    onHang: () => {
      state.hangs += 1;
    },
    onRecycle: recycle
      ? () => {
          state.recycles += 1;
        }
      : null,
    readRecord: () => state.record,
    probe: async (target) => {
      state.probes.push(target);
      return (
        state.outcomes.shift() ?? { ok: true, connected: true, detail: null }
      );
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      state.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => state.cleared.push(timer),
  });
  /** Run the next pending timer to completion; returns its delay. */
  const run = async () => {
    const timer = state.timers.shift();
    assert.ok(timer, 'a timer was pending');
    await timer.fn();
    return timer.ms;
  };
  return { state, watchdog, run };
}

const listeningRecord = { pid: CHILD, port: 4173, address: '127.0.0.1' };
const ok = { ok: true, connected: true, detail: null };
const miss = { ok: false, connected: true, detail: 'ETIMEDOUT' };
const refused = { ok: false, connected: false, detail: 'ECONNREFUSED' };
const leaky = {
  ok: true,
  connected: true,
  detail: null,
  health: { restarts: RECYCLE_RESTARTS, memory: { rss: RECYCLE_RSS_BYTES } },
};

test('recyclePlan: only many restarts AND a large resident set together', () => {
  assert.equal(recyclePlan({ restarts: 30, rss: 2 * 1024 ** 3 }), true);
  assert.equal(recyclePlan({ restarts: 31, rss: 3 * 1024 ** 3 }), true);
  assert.equal(recyclePlan({ restarts: 29, rss: 3 * 1024 ** 3 }), false);
  assert.equal(recyclePlan({ restarts: 100, rss: 2 * 1024 ** 3 - 1 }), false);
  assert.equal(recyclePlan({ restarts: 0, rss: 100 * 1024 ** 2 }), false);
  assert.equal(recyclePlan({ restarts: null, rss: 3 * 1024 ** 3 }), false);
  assert.equal(recyclePlan({ restarts: 40, rss: undefined }), false);
  assert.equal(recyclePlan({}), false);
  assert.equal(
    recyclePlan({ restarts: 3, rss: 10, minRestarts: 3, minRss: 10 }),
    true,
  );
});

test('probeOutcome: a 200 keeps the parsed health; anything else drops it', () => {
  const health = { restarts: 2, memory: { rss: 5 } };
  assert.deepEqual(probeOutcome({ statusCode: 200, health }), {
    ok: true,
    connected: true,
    detail: null,
    health,
  });
  assert.equal(probeOutcome({ statusCode: 503, health }).health, null);
  assert.equal(probeOutcome({ statusCode: 200 }).health, null);
});

test('startWatchdog: a leaky but healthy child is handed to onRecycle once, after arming', async () => {
  const { state, run } = fakeWatchdog({
    record: listeningRecord,
    outcomes: [leaky, leaky],
    recycle: true,
  });
  await run();
  assert.equal(state.recycles, 1);
  assert.equal(state.hangs, 0);
  assert.match(
    state.logs.at(-1),
    /30 in-process restarts and 2048 MB resident; relaunching/,
  );
  assert.equal(state.timers.length, 0, 'nothing scheduled after the recycle');
});

test('startWatchdog: without onRecycle a leaky child is left alone', async () => {
  const { state, run } = fakeWatchdog({
    record: listeningRecord,
    outcomes: [leaky, leaky],
  });
  await run();
  await run();
  assert.equal(state.recycles, 0);
  assert.equal(state.timers.length, 1, 'still watching');
});

test('startWatchdog: polls the record and never probes while it does not name the child with a port', async () => {
  const { state, run } = fakeWatchdog({ record: { pid: 9999, port: 4173 } });
  assert.equal(
    state.timers[0].ms,
    RECORD_POLL_MS,
    'first look after a poll interval',
  );
  await run();
  assert.deepEqual(state.probes, []);
  assert.equal(state.timers[0].ms, RECORD_POLL_MS);
  state.record = { pid: CHILD, port: null };
  await run();
  assert.deepEqual(
    state.probes,
    [],
    'listening record without a port: still waiting',
  );
  state.record = null;
  await run();
  assert.deepEqual(state.probes, []);
  assert.equal(state.hangs, 0);
});

test('startWatchdog: the first answer arms it and switches to the probe interval', async () => {
  const { state, run } = fakeWatchdog({
    record: listeningRecord,
    outcomes: [ok],
  });
  await run();
  assert.equal(state.probes.length, 1);
  assert.deepEqual(state.probes[0], { host: '127.0.0.1', port: 4173 });
  assert.equal(state.logs.length, 1);
  assert.match(
    state.logs[0],
    /health probe answered; watching 127\.0\.0\.1:4173\/__gev\/health/,
  );
  assert.equal(state.timers[0].ms, PROBE_INTERVAL_MS);
});

test('startWatchdog: misses before the first answer never count', async () => {
  const { state, run } = fakeWatchdog({
    record: listeningRecord,
    outcomes: [miss, miss, miss, miss, ok],
  });
  for (let i = 0; i < 4; i += 1) await run();
  assert.equal(state.hangs, 0);
  assert.ok(
    !state.logs.some((line) => /miss \d of/.test(line)),
    'no miss logged',
  );
  assert.equal(
    state.timers[0].ms,
    RECORD_POLL_MS,
    'still polling quickly until armed',
  );
  await run();
  assert.equal(state.timers[0].ms, PROBE_INTERVAL_MS);
});

test('startWatchdog: once armed, an answer resets the misses', async () => {
  const { state, run } = fakeWatchdog({
    record: listeningRecord,
    outcomes: [ok, miss, miss, ok, miss],
  });
  for (let i = 0; i < 5; i += 1) await run();
  assert.equal(state.hangs, 0);
  const misses = state.logs.filter((line) => /miss \d of 3/.test(line));
  assert.deepEqual(
    misses.map((line) => /miss (\d) of/.exec(line)[1]),
    ['1', '2', '1'],
  );
  assert.equal(state.timers.length, 1, 'still scheduled');
});

test('startWatchdog: three misses in a row fire onHang exactly once and stop the schedule', async () => {
  const { state, run } = fakeWatchdog({
    record: listeningRecord,
    outcomes: [ok, miss, miss, miss, miss],
  });
  await run();
  await run();
  await run();
  assert.equal(state.hangs, 0);
  await run();
  assert.equal(state.hangs, 1);
  assert.deepEqual(state.timers, [], 'nothing rescheduled after the hang');
  assert.ok(state.logs.some((line) => /miss 3 of 3/.test(line)));
});

test('startWatchdog: a refused connection is logged once and never becomes a hang', async () => {
  const { state, run } = fakeWatchdog({
    record: listeningRecord,
    outcomes: [ok, refused, refused, refused, refused, refused],
  });
  for (let i = 0; i < 6; i += 1) await run();
  assert.equal(state.hangs, 0);
  assert.equal(
    state.logs.filter((line) =>
      /could not connect \(ECONNREFUSED\); no miss counted/.test(line),
    ).length,
    1,
    'the same reason is logged once, not every probe',
  );
  assert.equal(state.timers.length, 1);
});

test('startWatchdog: stop() clears the pending timer and ends the probing', async () => {
  const { state, watchdog, run } = fakeWatchdog({
    record: listeningRecord,
    outcomes: [ok, miss],
  });
  await run();
  const pending = state.timers[0];
  watchdog.stop();
  assert.deepEqual(state.cleared, [pending]);
  // A tick that was already running when stop() came does nothing more.
  await pending.fn();
  assert.equal(state.timers.length, 1, 'no new timer after stop');
  assert.equal(state.hangs, 0);
});

test('healthState: starts clean, counts connected misses, flags a hang at three', () => {
  let state = healthState();
  assert.deepEqual(state, { misses: 0, unresponsive: false });
  state = healthState(state, { ok: false, connected: true });
  assert.deepEqual(state, { misses: 1, unresponsive: false });
  state = healthState(state, { ok: false, connected: true });
  assert.deepEqual(state, { misses: 2, unresponsive: false });
  state = healthState(state, { ok: false, connected: true });
  assert.deepEqual(state, {
    misses: PROBE_MISSES_FOR_HANG,
    unresponsive: true,
  });
});

test('healthState: a success resets the count', () => {
  const state = healthState(
    { misses: 2, unresponsive: false },
    { ok: true, connected: true },
  );
  assert.deepEqual(state, { misses: 0, unresponsive: false });
});

test('healthState: a refused connection is neither a miss nor a success', () => {
  const state = healthState(
    { misses: 2, unresponsive: false },
    { ok: false, connected: false },
  );
  assert.deepEqual(state, { misses: 2, unresponsive: false });
  assert.deepEqual(healthState(undefined, { ok: false, connected: false }), {
    misses: 0,
    unresponsive: false,
  });
});

test('probeOutcome: 200 is ok; refused or unknown host is not connected; a timeout is a connected miss', () => {
  assert.deepEqual(probeOutcome({ statusCode: 200 }), {
    ok: true,
    connected: true,
    detail: null,
    health: null,
  });
  assert.equal(probeOutcome({ statusCode: 503 }).ok, false);
  assert.equal(probeOutcome({ statusCode: 503 }).connected, true);
  for (const code of ['ECONNREFUSED', 'ENOTFOUND']) {
    const outcome = probeOutcome({ error: { code } });
    assert.equal(outcome.connected, false, code);
    assert.equal(outcome.ok, false, code);
    assert.equal(outcome.detail, code);
  }
  const timeout = probeOutcome({ error: { code: 'ETIMEDOUT' } });
  assert.deepEqual(timeout, {
    ok: false,
    connected: true,
    detail: 'ETIMEDOUT',
  });
  const reset = probeOutcome({ error: { code: 'ECONNRESET' } });
  assert.equal(reset.connected, true);
});

test('rotationPlan: rotates only when the append would pass the cap', () => {
  assert.equal(rotationPlan({ size: 0, incoming: 10 }), false);
  assert.equal(rotationPlan({ size: LOG_CAP_BYTES - 10, incoming: 10 }), false);
  assert.equal(rotationPlan({ size: LOG_CAP_BYTES - 10, incoming: 11 }), true);
  assert.equal(rotationPlan({ size: 50, incoming: 1, cap: 50 }), true);
  assert.equal(rotationPlan({ size: 49, incoming: 1, cap: 50 }), false);
  assert.equal(LOG_CAP_BYTES, 8 * 1024 * 1024);
});

test('quickEditPlan: only a classic Windows console with stdin attached, unless opted out', () => {
  assert.equal(
    quickEditPlan({ platform: 'win32', isTTY: true, env: {} }),
    true,
  );
  assert.equal(
    quickEditPlan({ platform: 'win32', isTTY: true, env: { WT_SESSION: 'x' } }),
    false,
  );
  assert.equal(
    quickEditPlan({ platform: 'win32', isTTY: false, env: {} }),
    false,
  );
  assert.equal(
    quickEditPlan({ platform: 'linux', isTTY: true, env: {} }),
    false,
  );
  assert.equal(
    quickEditPlan({ platform: 'darwin', isTTY: true, env: {} }),
    false,
  );
  assert.equal(
    quickEditPlan({
      platform: 'win32',
      isTTY: true,
      env: { GEV_DEV_KEEP_QUICKEDIT: '1' },
    }),
    false,
  );
  assert.equal(
    quickEditPlan({
      platform: 'win32',
      isTTY: true,
      env: { GEV_DEV_KEEP_QUICKEDIT: '0' },
    }),
    true,
  );
  assert.equal(quickEditPlan(), false);
});

test('QUICKEDIT_SCRIPT: clears 0x40, sets 0x80, and reads the console input handle', () => {
  assert.match(QUICKEDIT_SCRIPT, /GetStdHandle\(-10\)/);
  assert.match(QUICKEDIT_SCRIPT, /GetConsoleMode/);
  assert.match(QUICKEDIT_SCRIPT, /SetConsoleMode/);
  assert.match(QUICKEDIT_SCRIPT, /-band \(-bnot 0x40\)\) -bor 0x80/);
  assert.match(QUICKEDIT_SCRIPT, /CONIN\$/);
});

test('probeTarget: wildcard or missing addresses map to loopback, others pass through', () => {
  assert.deepEqual(probeTarget({ address: '0.0.0.0', port: 4173 }), {
    host: '127.0.0.1',
    port: 4173,
  });
  assert.deepEqual(probeTarget({ address: '::', port: 4173 }), {
    host: '127.0.0.1',
    port: 4173,
  });
  assert.deepEqual(probeTarget({ address: null, port: 5000 }), {
    host: '127.0.0.1',
    port: 5000,
  });
  assert.deepEqual(probeTarget({ address: '192.168.1.5', port: 4173 }), {
    host: '192.168.1.5',
    port: 4173,
  });
  assert.deepEqual(probeTarget({ address: '::1', port: 4173 }), {
    host: '::1',
    port: 4173,
  });
  assert.deepEqual(probeTarget({ address: 'fe80::1', port: 4173 }), {
    host: 'fe80::1',
    port: 4173,
  });
  assert.deepEqual(probeTarget({}), { host: '127.0.0.1', port: 4173 });
  assert.deepEqual(probeTarget(null), { host: '127.0.0.1', port: 4173 });
  assert.deepEqual(probeTarget({ port: '4174' }).port, 4174);
  assert.deepEqual(probeTarget({ port: 'x' }).port, 4173);
});

test('formatExitLine: code, signal and seconds, with null spelled out', () => {
  assert.equal(
    formatExitLine({ code: 75, signal: null, uptimeMs: 12_345 }),
    '[dev-server] exited code=75 signal=null after 12.3s',
  );
  assert.equal(
    formatExitLine({ code: null, signal: 'SIGTERM', uptimeMs: 0 }),
    '[dev-server] exited code=null signal=SIGTERM after 0.0s',
  );
  assert.equal(
    formatExitLine({}),
    '[dev-server] exited code=null signal=null after 0.0s',
  );
});

test('parseRecord: an object or null, never a throw', () => {
  assert.deepEqual(parseRecord('{"pid":1,"port":4173}'), {
    pid: 1,
    port: 4173,
  });
  assert.equal(parseRecord(''), null);
  assert.equal(parseRecord('not json'), null);
  assert.equal(parseRecord('null'), null);
  assert.equal(parseRecord('[1,2]'), null);
  assert.equal(parseRecord('42'), null);
  assert.equal(parseRecord(undefined), null);
});

test('spawnPlan: same node, same heap ceiling, Vite bin, stdin inherited, supervisor pid and colour in env', () => {
  const plan = spawnPlan({
    execPath: '/usr/bin/node',
    viteBin: '/repo/node_modules/vite/bin/vite.js',
    argv: ['--host', '0.0.0.0'],
    env: { PATH: '/bin', FORCE_COLOR: '0' },
    pid: 777,
    isTTY: true,
    cwd: '/repo',
  });
  assert.equal(plan.command, '/usr/bin/node');
  assert.deepEqual(plan.args, [
    '--max-old-space-size=16384',
    '/repo/node_modules/vite/bin/vite.js',
    '--host',
    '0.0.0.0',
  ]);
  assert.deepEqual(plan.options.stdio, ['inherit', 'pipe', 'pipe']);
  assert.equal(plan.options.cwd, '/repo');
  assert.equal(plan.options.shell, false);
  assert.equal(plan.options.detached, false);
  assert.deepEqual(plan.options.env, {
    PATH: '/bin',
    GEV_DEV_SUPERVISOR_PID: '777',
    FORCE_COLOR: '1',
  });
  const piped = spawnPlan({
    execPath: 'node',
    viteBin: 'vite.js',
    env: {},
    pid: 1,
    isTTY: false,
  });
  assert.deepEqual(piped.options.env, { GEV_DEV_SUPERVISOR_PID: '1' });
  // A console that asked for no colour keeps it that way (no Node warning).
  const plain = spawnPlan({
    execPath: 'node',
    viteBin: 'vite.js',
    env: { NO_COLOR: '1' },
    pid: 2,
    isTTY: true,
  });
  assert.deepEqual(plain.options.env, {
    NO_COLOR: '1',
    GEV_DEV_SUPERVISOR_PID: '2',
  });
});
