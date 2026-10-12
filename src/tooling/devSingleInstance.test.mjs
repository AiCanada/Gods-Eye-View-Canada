// One dev server per checkout: which recorded process (and which supervisor)
// gets stopped at start-up, what the pid file records, when a running server
// decides its launcher is gone, and when a restart that never comes back
// makes it exit for the supervisor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EXIT_RESTART_FAILED,
  PID_FILE,
  ancestorChain,
  armRestartGuard,
  commandLineOf,
  isAlive,
  launcherGone,
  listeningRecord,
  parseProcessTable,
  previousToStop,
  restartGuardVerdict,
  stopPrevious,
  supervisorToStop,
  takeoverRecord,
  waitForExit,
} from '../../server/standalone/single-instance.js';

const VITE = '"node" "node_modules\\vite\\bin\\vite.js"';
const SUPERVISOR =
  '"C:\\Program Files\\nodejs\\node.exe" "scripts\\dev-server.mjs"';
const NOW = Date.UTC(2026, 9, 10, 7, 31, 0);
const NOW_ISO = '2026-10-10T07:31:00.000Z';

test('PID_FILE: the path the supervisor shares, unchanged', () => {
  assert.equal(
    PID_FILE,
    path.join('node_modules', '.vite', 'gev-dev-server.pid'),
  );
});

test('previousToStop: stops another live Vite process from the record', () => {
  assert.equal(
    previousToStop({
      record: { pid: 4321 },
      selfPid: 1,
      alive: true,
      commandLine: VITE,
    }),
    4321,
  );
});

test('previousToStop: never stops itself, a dead pid, or a non-Vite process', () => {
  assert.equal(
    previousToStop({
      record: { pid: 7 },
      selfPid: 7,
      alive: true,
      commandLine: VITE,
    }),
    null,
  );
  assert.equal(
    previousToStop({
      record: { pid: 4321 },
      selfPid: 1,
      alive: false,
      commandLine: VITE,
    }),
    null,
  );
  assert.equal(
    previousToStop({
      record: { pid: 4321 },
      selfPid: 1,
      alive: true,
      commandLine: 'C:\\Windows\\explorer.exe',
    }),
    null,
  );
  assert.equal(
    previousToStop({
      record: { pid: 4321 },
      selfPid: 1,
      alive: true,
      commandLine: undefined,
    }),
    null,
  );
});

test('previousToStop: ignores a missing or malformed record', () => {
  assert.equal(
    previousToStop({
      record: null,
      selfPid: 1,
      alive: true,
      commandLine: VITE,
    }),
    null,
  );
  assert.equal(
    previousToStop({
      record: { pid: 'x' },
      selfPid: 1,
      alive: true,
      commandLine: VITE,
    }),
    null,
  );
  assert.equal(
    previousToStop({
      record: { pid: -5 },
      selfPid: 1,
      alive: true,
      commandLine: VITE,
    }),
    null,
  );
});

test('supervisorToStop: stops a live foreign dev-server.mjs process named by the record', () => {
  const record = { pid: 4321, supervisorPid: 900 };
  assert.equal(
    supervisorToStop({
      record,
      selfPid: 1,
      selfSupervisorPid: null,
      alive: true,
      commandLine: SUPERVISOR,
    }),
    900,
  );
  assert.equal(
    supervisorToStop({
      record,
      selfPid: 1,
      selfSupervisorPid: 55,
      alive: true,
      commandLine: 'node /srv/app/scripts/dev-server.mjs',
    }),
    900,
  );
  // The server being dead already does not spare the supervisor: it would relaunch one.
  assert.equal(
    supervisorToStop({
      record: { pid: null, supervisorPid: 900 },
      selfPid: 1,
      alive: true,
      commandLine: SUPERVISOR,
    }),
    900,
  );
});

test('supervisorToStop: never our own supervisor, ourselves, a dead pid, or another command line', () => {
  const record = { pid: 4321, supervisorPid: 900 };
  assert.equal(
    supervisorToStop({
      record,
      selfPid: 1,
      selfSupervisorPid: 900,
      alive: true,
      commandLine: SUPERVISOR,
    }),
    null,
    'our own supervisor relaunched us',
  );
  assert.equal(
    supervisorToStop({
      record,
      selfPid: 900,
      selfSupervisorPid: null,
      alive: true,
      commandLine: SUPERVISOR,
    }),
    null,
  );
  assert.equal(
    supervisorToStop({
      record,
      selfPid: 1,
      selfSupervisorPid: null,
      alive: false,
      commandLine: SUPERVISOR,
    }),
    null,
  );
  assert.equal(
    supervisorToStop({
      record,
      selfPid: 1,
      selfSupervisorPid: null,
      alive: true,
      commandLine: VITE,
    }),
    null,
    'a pid reused by Vite itself is not a supervisor',
  );
  assert.equal(
    supervisorToStop({
      record,
      selfPid: 1,
      selfSupervisorPid: null,
      alive: true,
      commandLine: 'C:\\Windows\\explorer.exe',
    }),
    null,
  );
  assert.equal(
    supervisorToStop({
      record,
      selfPid: 1,
      selfSupervisorPid: null,
      alive: true,
      commandLine: null,
    }),
    null,
  );
});

test('supervisorToStop: ignores a missing, old-shape, or malformed record', () => {
  assert.equal(
    supervisorToStop({
      record: null,
      selfPid: 1,
      alive: true,
      commandLine: SUPERVISOR,
    }),
    null,
  );
  assert.equal(
    supervisorToStop({
      record: { pid: 4321 },
      selfPid: 1,
      alive: true,
      commandLine: SUPERVISOR,
    }),
    null,
    'a record from before supervisors',
  );
  assert.equal(
    supervisorToStop({
      record: { pid: 4321, supervisorPid: 'x' },
      selfPid: 1,
      alive: true,
      commandLine: SUPERVISOR,
    }),
    null,
  );
  assert.equal(
    supervisorToStop({
      record: { pid: 4321, supervisorPid: -2 },
      selfPid: 1,
      alive: true,
      commandLine: SUPERVISOR,
    }),
    null,
  );
  assert.equal(
    supervisorToStop({
      record: { pid: 4321, supervisorPid: 0 },
      selfPid: 1,
      alive: true,
      commandLine: SUPERVISOR,
    }),
    null,
  );
});

test('takeoverRecord: our pid, the pid taken over, our supervisor, no port yet', () => {
  assert.deepEqual(
    takeoverRecord({
      selfPid: 500,
      previousPid: 4321,
      supervisorPid: 77,
      now: NOW,
    }),
    {
      pid: 500,
      startedAt: NOW_ISO,
      port: null,
      address: null,
      supervisorPid: 77,
      previousPid: 4321,
    },
  );
  // Without a supervisor, and when only a supervisor was stopped (its server already gone).
  const alone = takeoverRecord({
    selfPid: 500,
    previousPid: null,
    supervisorPid: null,
    now: new Date(NOW),
  });
  assert.equal(alone.supervisorPid, null);
  assert.equal(alone.previousPid, null);
  assert.equal(alone.startedAt, NOW_ISO);
  assert.equal(
    takeoverRecord({
      selfPid: 500,
      previousPid: '4321',
      supervisorPid: '77',
      now: NOW,
    }).previousPid,
    4321,
    'string pids are parsed',
  );
  assert.deepEqual(
    Object.keys(takeoverRecord({ selfPid: 1, now: NOW })).slice(0, 5),
    ['pid', 'startedAt', 'port', 'address', 'supervisorPid'],
    'same leading keys as the listening record',
  );
});

test('listeningRecord: pid, start time, port and address from the bound server, supervisor pid', () => {
  assert.deepEqual(
    listeningRecord({
      pid: 500,
      address: { address: '::', family: 'IPv6', port: 4173 },
      supervisorPid: '77',
      now: NOW,
    }),
    {
      pid: 500,
      startedAt: NOW_ISO,
      port: 4173,
      address: '::',
      supervisorPid: 77,
    },
  );
  // A pipe (string) or an unbound server (null) leave port and address empty; no env means no supervisor.
  assert.deepEqual(
    listeningRecord({
      pid: 500,
      address: '\\\\.\\pipe\\vite',
      supervisorPid: undefined,
      now: NOW,
    }),
    {
      pid: 500,
      startedAt: NOW_ISO,
      port: null,
      address: null,
      supervisorPid: null,
    },
  );
  assert.equal(
    listeningRecord({ pid: 500, address: null, now: NOW }).port,
    null,
  );
});

test('restartGuardVerdict: skipped on the first start, ok once listening, exit otherwise', () => {
  assert.equal(restartGuardVerdict({ starts: 1, listening: false }), 'skip');
  assert.equal(restartGuardVerdict({ starts: 1, listening: true }), 'skip');
  assert.equal(restartGuardVerdict({ starts: 0, listening: false }), 'skip');
  assert.equal(
    restartGuardVerdict({ starts: undefined, listening: false }),
    'skip',
  );
  assert.equal(restartGuardVerdict({ starts: 2, listening: true }), 'ok');
  assert.equal(restartGuardVerdict({ starts: 2, listening: false }), 'exit');
  assert.equal(restartGuardVerdict({ starts: 9, listening: false }), 'exit');
});

function fakeGuardDeps() {
  const calls = { exits: [], logs: [], armed: [], cleared: [] };
  const deps = {
    exit: (code) => calls.exits.push(code),
    log: (line) => calls.logs.push(line),
    setTimer: (fn, ms) => {
      const timer = {
        fire: fn,
        ms,
        unrefs: 0,
        unref() {
          this.unrefs += 1;
          return this;
        },
      };
      calls.armed.push(timer);
      return timer;
    },
    clearTimer: (timer) => calls.cleared.push(timer),
  };
  return { calls, deps };
}

test('armRestartGuard: nothing is armed on the first start', () => {
  const { calls, deps } = fakeGuardDeps();
  assert.equal(
    armRestartGuard({ httpServer: new EventEmitter() }, { starts: 1, ...deps }),
    null,
  );
  assert.equal(
    armRestartGuard({ httpServer: null }, { starts: 0, ...deps }),
    null,
  );
  assert.deepEqual(calls.armed, []);
});

test('armRestartGuard: exits 75 when listening never fires after a restart', () => {
  const { calls, deps } = fakeGuardDeps();
  const httpServer = new EventEmitter();
  httpServer.listening = false;
  const timer = armRestartGuard({ httpServer }, { starts: 2, ...deps });
  assert.equal(calls.armed.length, 1);
  assert.equal(timer, calls.armed[0]);
  assert.equal(timer.ms, 30_000, 'default timeout');
  assert.equal(timer.unrefs, 1, 'the guard never keeps the process alive');
  assert.deepEqual(calls.exits, [], 'nothing before the timer fires');
  timer.fire();
  assert.deepEqual(calls.exits, [EXIT_RESTART_FAILED]);
  assert.equal(EXIT_RESTART_FAILED, 75);
  assert.equal(calls.logs.length, 1);
  assert.match(
    calls.logs[0],
    /^\[dev\] The server did not come back after a restart/,
  );
  assert.match(calls.logs[0], /supervisor can relaunch/);
});

test('armRestartGuard: a restart that failed before the old server closed leaves it serving; the guard stands down', () => {
  const { calls, deps } = fakeGuardDeps();
  const neverListens = new EventEmitter();
  neverListens.listening = false;
  const previous = { listening: true };
  const timer = armRestartGuard(
    { httpServer: neverListens },
    { starts: 2, previousHttpServer: previous, ...deps },
  );
  timer.fire();
  assert.deepEqual(calls.exits, [], 'the URL still answers; nothing to fix');
  assert.deepEqual(calls.logs, []);
  // A real restart closes the old listener first: then a missing new one is a failure.
  const closedPrevious = { listening: false };
  const second = armRestartGuard(
    { httpServer: neverListens },
    { starts: 2, previousHttpServer: closedPrevious, ...deps },
  );
  second.fire();
  assert.deepEqual(calls.exits, [EXIT_RESTART_FAILED]);
  // The previous listener closing after the guard was armed is read at fire time.
  const closesLater = { listening: true };
  const third = armRestartGuard(
    { httpServer: neverListens },
    { starts: 3, previousHttpServer: closesLater, ...deps },
  );
  closesLater.listening = false;
  third.fire();
  assert.deepEqual(calls.exits, [EXIT_RESTART_FAILED, EXIT_RESTART_FAILED]);
});

test('armRestartGuard: stands down when the server listens in time', () => {
  const { calls, deps } = fakeGuardDeps();
  const httpServer = new EventEmitter();
  httpServer.listening = false;
  const timer = armRestartGuard(
    { httpServer },
    { starts: 3, timeoutMs: 1234, ...deps },
  );
  assert.equal(timer.ms, 1234);
  httpServer.listening = true;
  httpServer.emit('listening');
  assert.deepEqual(
    calls.cleared,
    [timer],
    'the listening event clears the timer',
  );
  assert.equal(
    httpServer.listenerCount('listening'),
    0,
    'armed with once, not on',
  );
  // Even if the timer raced the clear, a listening server is left alone.
  timer.fire();
  assert.deepEqual(calls.exits, []);
  assert.deepEqual(calls.logs, []);
});

test('armRestartGuard: a server without an http listener still gets the timer and exits on fire', () => {
  const { calls, deps } = fakeGuardDeps();
  const timer = armRestartGuard({ httpServer: null }, { starts: 2, ...deps });
  assert.ok(timer);
  timer.fire();
  assert.deepEqual(calls.exits, [75]);
});

test('waitForExit: true once the process is gone, false when the wait runs out', async () => {
  let clock = 0;
  const pause = async (ms) => {
    clock += ms;
  };
  let polls = 0;
  assert.equal(
    await waitForExit(42, {
      timeoutMs: 300,
      alive: () => (polls += 1) < 3,
      now: () => clock,
      pause,
    }),
    true,
  );
  assert.equal(clock, 100, 'two pauses before the third poll saw it gone');
  clock = 0;
  assert.equal(
    await waitForExit(42, {
      timeoutMs: 300,
      alive: () => true,
      now: () => clock,
      pause,
    }),
    false,
  );
  assert.equal(clock, 300);
  assert.equal(
    await waitForExit(42, {
      timeoutMs: 300,
      alive: () => false,
      now: () => clock,
      pause,
    }),
    true,
    'already gone: no pause',
  );
});

test('launcherGone: stays while the parent and every link above it live', () => {
  const alive = () => true;
  assert.equal(
    launcherGone({
      parentPid: 10,
      currentParentPid: 10,
      chain: [10, 20, 30],
      alive,
    }),
    false,
  );
  assert.equal(
    launcherGone({ parentPid: 10, currentParentPid: 10, chain: [], alive }),
    false,
  );
});

test('launcherGone: leaves when the parent dies, is replaced, or any link above it dies', () => {
  assert.equal(
    launcherGone({
      parentPid: 10,
      currentParentPid: 10,
      chain: [10, 20, 30],
      alive: (pid) => pid !== 10,
    }),
    true,
  );
  assert.equal(
    launcherGone({
      parentPid: 10,
      currentParentPid: 1,
      chain: [10, 20, 30],
      alive: () => true,
    }),
    true,
  );
  // The observed cases: npm gone with cmd alive; the shell gone with npm and cmd alive.
  assert.equal(
    launcherGone({
      parentPid: 10,
      currentParentPid: 10,
      chain: [10, 20, 30],
      alive: (pid) => pid !== 20,
    }),
    true,
  );
  assert.equal(
    launcherGone({
      parentPid: 10,
      currentParentPid: 10,
      chain: [10, 20, 30],
      alive: (pid) => pid !== 30,
    }),
    true,
  );
});

test('ancestorChain: nearest first, stops before the session root or an unknown pid', () => {
  const table = parseProcessTable(
    [
      '4 0 System',
      '900 4 wininit.exe',
      '1000 900 explorer.exe',
      '1100 1000 WindowsTerminal.exe',
      '1200 1100 powershell.exe',
      '1300 1200 node.exe',
      '1400 1300 cmd.exe',
      '1500 1400 node.exe',
    ].join('\r\n'),
  );
  assert.deepEqual(ancestorChain(1500, table), [1400, 1300, 1200, 1100]);
  assert.deepEqual(ancestorChain(1500, table, { limit: 2 }), [1400, 1300]);
  assert.deepEqual(
    ancestorChain(1100, table),
    [],
    'explorer is the root, never watched',
  );
  assert.deepEqual(
    ancestorChain(1500, parseProcessTable('1500 77 node.exe')),
    [],
    'a parent the table does not list',
  );
  assert.deepEqual(ancestorChain(9, table), []);
  // POSIX: pid 1 ends the chain.
  const posix = parseProcessTable(
    '1 0 systemd\n50 1 bash\n60 50 npm\n70 60 sh\n80 70 node',
  );
  assert.deepEqual(ancestorChain(80, posix), [70, 60, 50]);
});

test('isAlive: this process is alive; an impossible pid is not', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive(Number.NaN), false);
});

test('commandLineOf: exported for the supervisor; an impossible pid reads as null', async () => {
  assert.equal(typeof commandLineOf, 'function');
  assert.equal(await commandLineOf(-1), null);
});

/**
 * A checkout with a pid record, and every process operation of
 * `stopPrevious` replaced by a recorder: which pids are alive, what their
 * command lines say, and what was killed or written, in order.
 */
async function stopPreviousFixture(record, { aliveSet, commandLines }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-stop-'));
  const file = path.join(root, PID_FILE);
  if (record) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(record));
  }
  const alive = new Set(aliveSet);
  const events = [];
  const logs = [];
  const deps = {
    selfPid: 333,
    selfSupervisorPid: 444,
    alive: (pid) => alive.has(pid),
    commandLine: async (pid) => commandLines[pid] ?? null,
    kill: (pid) => {
      events.push(['kill', pid]);
      alive.delete(pid);
      return true;
    },
    wait: async (pid) => !alive.has(pid),
    write: (_file, written) => events.push(['record', written]),
    exit: (code) => events.push(['exit', code]),
    now: () => NOW,
  };
  return {
    root,
    file,
    events,
    logs,
    alive,
    deps,
    log: (line) => logs.push(line),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('stopPrevious: the foreign supervisor goes first, then its server, then the takeover record', async () => {
  const fx = await stopPreviousFixture(
    { pid: 222, supervisorPid: 111, port: 4173 },
    {
      aliveSet: [111, 222, 444],
      commandLines: { 111: SUPERVISOR, 222: VITE },
    },
  );
  try {
    await stopPrevious(fx.file, fx.log, fx.deps);
    assert.deepEqual(fx.events, [
      ['kill', 111],
      ['kill', 222],
      [
        'record',
        {
          pid: 333,
          startedAt: NOW_ISO,
          port: null,
          address: null,
          supervisorPid: 444,
          previousPid: 222,
        },
      ],
    ]);
    assert.deepEqual(fx.logs, [
      '[dev] Stopped the previous dev server (pid 222) and its supervisor (pid 111)',
    ]);
  } finally {
    await fx.cleanup();
  }
});

test('stopPrevious: nothing confirmed dead means no takeover record', async () => {
  const fx = await stopPreviousFixture(
    { pid: 222, supervisorPid: 111, port: 4173 },
    {
      aliveSet: [111, 222, 444],
      commandLines: { 111: SUPERVISOR, 222: VITE },
    },
  );
  // Kills are sent but neither process leaves.
  fx.deps.kill = (pid) => {
    fx.events.push(['kill', pid]);
    return true;
  };
  fx.deps.wait = async () => false;
  try {
    await stopPrevious(fx.file, fx.log, fx.deps);
    assert.deepEqual(fx.events, [
      ['kill', 111],
      ['kill', 222],
    ]);
    assert.equal(fx.logs.length, 1);
    assert.match(fx.logs[0], /did not stop/);
    assert.ok(!/supervisor \(pid 111\) was stopped/.test(fx.logs[0]));
  } finally {
    await fx.cleanup();
  }
});

test('stopPrevious: a supervisor whose server is already gone is still stopped, and the record says so', async () => {
  const fx = await stopPreviousFixture(
    { pid: 222, supervisorPid: 111, port: 4173 },
    { aliveSet: [111, 444], commandLines: { 111: SUPERVISOR } },
  );
  try {
    await stopPrevious(fx.file, fx.log, fx.deps);
    assert.deepEqual(
      fx.events.map((event) => event[0]),
      ['kill', 'record'],
    );
    assert.equal(fx.events[0][1], 111);
    assert.equal(fx.events[1][1].previousPid, null);
    assert.match(fx.logs[0], /Stopped the supervisor \(pid 111\)/);
    assert.match(fx.logs[0], /pid 222, already gone/);
  } finally {
    await fx.cleanup();
  }
});

test('stopPrevious: our own supervisor and a dead or non-Vite pid are left alone', async () => {
  const fx = await stopPreviousFixture(
    { pid: 222, supervisorPid: 444, port: 4173 },
    {
      aliveSet: [444, 222],
      commandLines: { 444: SUPERVISOR, 222: 'C:\\Windows\\explorer.exe' },
    },
  );
  try {
    await stopPrevious(fx.file, fx.log, fx.deps);
    assert.deepEqual(
      fx.events,
      [],
      'a reused pid is not Vite: nothing stopped',
    );
    assert.deepEqual(fx.logs, []);
  } finally {
    await fx.cleanup();
  }
});

test('stopPrevious: a server whose own supervisor is gone exits instead of taking over', async () => {
  // The orphan: its supervisor (444) was stopped by a newer server while
  // this one was booting; going on would stop that newer server too.
  const fx = await stopPreviousFixture(
    { pid: 222, supervisorPid: 111, port: 4173 },
    {
      aliveSet: [111, 222],
      commandLines: { 111: SUPERVISOR, 222: VITE },
    },
  );
  try {
    await stopPrevious(fx.file, fx.log, fx.deps);
    assert.deepEqual(fx.events, [['exit', 0]], 'nothing killed, no record');
    assert.equal(fx.logs.length, 1);
    assert.match(
      fx.logs[0],
      /supervisor that started this dev server \(pid 444\) is gone/,
    );
  } finally {
    await fx.cleanup();
  }
  // Even with no record at all: an orphan never takes the port.
  const bare = await stopPreviousFixture(null, {
    aliveSet: [],
    commandLines: {},
  });
  try {
    await stopPrevious(bare.file, bare.log, bare.deps);
    assert.deepEqual(bare.events, [['exit', 0]]);
  } finally {
    await bare.cleanup();
  }
  // Without a supervisor of its own there is nothing to miss.
  const direct = await stopPreviousFixture(null, {
    aliveSet: [],
    commandLines: {},
  });
  direct.deps.selfSupervisorPid = null;
  try {
    await stopPrevious(direct.file, direct.log, direct.deps);
    assert.deepEqual(direct.events, []);
  } finally {
    await direct.cleanup();
  }
});

test('singleInstancePlugin hands the restart guard the listener that last came up, never one that did not', async () => {
  delete globalThis.__GEV_DEV_SINGLE_INSTANCE;
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-single-'));
  const guards = [];
  try {
    const href = new URL(
      '../../server/standalone/single-instance.js',
      import.meta.url,
    ).href;
    const { singleInstancePlugin } = await import(`${href}?copy=listener`);
    const plugin = singleInstancePlugin({
      root,
      log() {},
      watch() {},
      restartGuard: (_server, options) => guards.push(options),
    });
    const listener = (listening) => {
      const httpServer = new EventEmitter();
      httpServer.listening = listening;
      httpServer.address = () => ({ address: '127.0.0.1', port: 4173 });
      return httpServer;
    };
    const first = listener(false);
    await plugin.configureServer({ httpServer: first, close() {} });
    assert.equal(
      guards[0].previousHttpServer,
      null,
      'a cold start has no previous listener',
    );
    first.listening = true;
    first.emit('listening');
    // A restart: the old listener is still up while the new server is built.
    const second = listener(false);
    await plugin.configureServer({ httpServer: second, close() {} });
    assert.equal(guards[1].previousHttpServer, first);
    // That restart never listened (it failed); the next one still sees the first.
    const third = listener(false);
    await plugin.configureServer({ httpServer: third, close() {} });
    assert.equal(guards[2].previousHttpServer, first);
    third.listening = true;
    third.emit('listening');
    const fourth = listener(false);
    await plugin.configureServer({ httpServer: fourth, close() {} });
    assert.equal(guards[3].previousHttpServer, third);
  } finally {
    delete globalThis.__GEV_DEV_SINGLE_INSTANCE;
    await rm(root, { recursive: true, force: true });
  }
});

test('singleInstancePlugin arms the launcher watch and exit cleanup once per process, counts starts and guards every start, across re-evaluated copies', async () => {
  // Vite re-bundles the config on an in-process restart, which evaluates
  // this module again: each `?copy=` import is such a fresh evaluation.
  delete globalThis.__GEV_DEV_SINGLE_INSTANCE;
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-single-'));
  const exitBefore = process.listenerCount('exit');
  const watches = [];
  const servers = [];
  const guards = [];
  try {
    for (const copy of ['a', 'b', 'c']) {
      const href = new URL(
        '../../server/standalone/single-instance.js',
        import.meta.url,
      ).href;
      const { singleInstancePlugin } = await import(`${href}?copy=${copy}`);
      const server = { httpServer: null, close() {}, copy };
      servers.push(server);
      const plugin = singleInstancePlugin({
        root,
        log() {},
        watch: (current) => watches.push(current),
        restartGuard: (guarded, options) =>
          guards.push({ server: guarded, ...options }),
      });
      await plugin.configureServer(server);
    }
    assert.equal(
      watches.length,
      1,
      'the launcher is watched once, not once per restart',
    );
    assert.equal(
      watches[0](),
      servers[2],
      'leaving closes the live server, not the first one',
    );
    assert.equal(
      process.listenerCount('exit'),
      exitBefore + 1,
      'one exit cleanup for the process',
    );
    assert.equal(
      globalThis.__GEV_DEV_SINGLE_INSTANCE.starts,
      3,
      'every start of the process is counted',
    );
    assert.deepEqual(
      guards.map((guard) => guard.starts),
      [1, 2, 3],
      'the guard is asked on every start with the running count',
    );
    assert.deepEqual(
      guards.map((guard) => guard.server),
      servers,
      'each start guards its own server',
    );
  } finally {
    delete globalThis.__GEV_DEV_SINGLE_INSTANCE;
    await rm(root, { recursive: true, force: true });
  }
});
