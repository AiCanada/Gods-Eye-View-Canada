import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * One dev server per checkout.
 *
 * Stopping `npm run dev` on Windows ends npm and its cmd wrapper but not the
 * node process that is Vite, so every restart left a server behind and the
 * next one moved up a port (nine were found holding 4173 to 4181). Three
 * guards:
 *  - at start-up, the server recorded in the pid file is stopped if it is
 *    still a Vite process, so the new one takes the usual port; a supervisor
 *    (`scripts/dev-server.mjs`) that would relaunch it is stopped first, and
 *    the record is rewritten at once so a slower supervisor sees the takeover;
 *  - while running, the server exits by itself when any process in the chain
 *    that launched it (cmd, npm, the shell, the terminal) is gone;
 *  - after an in-process restart, the server exits when it has not come back
 *    to listening in time, so a supervisor can relaunch it instead of leaving
 *    a live process with a dead URL.
 */

/** Relative to the checkout root; the supervisor imports it to find the same file. */
export const PID_FILE = path.join(
  'node_modules',
  '.vite',
  'gev-dev-server.pid',
);
const WATCH_INTERVAL_MS = 2000;
const STOP_WAIT_MS = 3000;
const CLOSE_WAIT_MS = 3000;
/** A cold start can spend longer than this on dependency optimisation; restarts cannot. */
const RESTART_GUARD_MS = 30_000;
/** Exit code for "did not come back after a restart"; the supervisor relaunches on it. */
export const EXIT_RESTART_FAILED = 75;

const execFileAsync = promisify(execFile);

/** True while a process with this id exists (EPERM means it exists but is not ours). */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** A positive integer pid from a record field or an env value, or null. */
function parsePid(value) {
  const pid = Number.parseInt(value, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The supervisor that spawned this process, when `scripts/dev-server.mjs` did. */
function ownSupervisorPid(env = process.env) {
  return parsePid(env.GEV_DEV_SUPERVISOR_PID);
}

/** Command line of a process, or null when it cannot be read. The supervisor uses it too. */
export async function commandLineOf(pid) {
  try {
    if (process.platform === 'win32') {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`;
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 10_000 },
      );
      return stdout.trim() || null;
    }
    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'args=', '-p', String(pid)],
      { timeout: 10_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Every process as {pid, ppid, name}, or [] when the table cannot be read. */
async function processTable() {
  try {
    if (process.platform === 'win32') {
      const script =
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }';
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      );
      return parseProcessTable(stdout);
    }
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,comm='], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseProcessTable(stdout);
  } catch {
    return [];
  }
}

export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (match)
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        name: match[3].trim(),
      });
  }
  return rows;
}

/** Where a launch chain ends: the session's root processes, which outlive any command. */
const CHAIN_ROOTS =
  /^(explorer\.exe|services\.exe|wininit\.exe|winlogon\.exe|svchost\.exe|csrss\.exe|smss\.exe|system|launchd|systemd|init)$/i;

/**
 * The processes above this one, nearest first, stopping before a session root
 * and at any pid the table does not list. Pure: takes the table.
 */
export function ancestorChain(selfPid, table, { limit = 8 } = {}) {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const chain = [];
  let current = byPid.get(selfPid);
  while (current && chain.length < limit) {
    const parent = byPid.get(current.ppid);
    if (
      !parent ||
      parent.pid === current.pid ||
      parent.pid <= 1 ||
      CHAIN_ROOTS.test(parent.name)
    )
      break;
    chain.push(parent.pid);
    current = parent;
  }
  return chain;
}

/**
 * Decide whether the recorded process should be stopped: it must be another
 * process, still alive, and its command line must show it is Vite.
 * Pure so it can be tested; returns the pid to stop or null.
 */
export function previousToStop({ record, selfPid, alive, commandLine }) {
  const pid = Number.parseInt(record?.pid, 10);
  if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) return null;
  if (!alive) return null;
  if (typeof commandLine !== 'string' || !/vite/i.test(commandLine))
    return null;
  return pid;
}

/**
 * Decide whether the recorded supervisor should be stopped before its server:
 * a live `scripts/dev-server.mjs` process that is neither this process nor
 * the supervisor that spawned it (the record left by our own supervisor's
 * previous child names that same supervisor). A supervisor left alive would
 * relaunch the server we are about to stop, so it goes first; whether its
 * server is still alive does not matter. Pure; returns the pid or null.
 */
export function supervisorToStop({
  record,
  selfPid,
  selfSupervisorPid = null,
  alive,
  commandLine,
}) {
  const pid = parsePid(record?.supervisorPid);
  if (!pid || pid === selfPid || pid === selfSupervisorPid) return null;
  if (!alive) return null;
  if (typeof commandLine !== 'string' || !/dev-server\.mjs/i.test(commandLine))
    return null;
  return pid;
}

/**
 * Decide whether this server has lost what launched it: its parent changed
 * (POSIX re-parents an orphan to pid 1), or any process in the chain recorded
 * at start-up is gone. Stopping a command from a tool or a terminal can kill
 * any link of that chain (the shell, npm, or cmd) and leave the rest running,
 * so every link counts.
 */
export function launcherGone({
  parentPid,
  currentParentPid,
  chain = [],
  alive,
}) {
  if (currentParentPid !== parentPid) return true;
  if (!alive(parentPid)) return true;
  return chain.some((pid) => !alive(pid));
}

const toIso = (now) => new Date(now ?? Date.now()).toISOString();

/**
 * The record written once the server listens: enough for a supervisor to
 * probe it (port and address) and for the next start to know which supervisor
 * owns it. `address` is the object form of `net.Server#address()`; a pipe
 * path (string) or an unbound server (null) leaves port and address null.
 * Pure.
 */
export function listeningRecord({ pid, address, supervisorPid = null, now }) {
  const bound = address && typeof address === 'object' ? address : null;
  return {
    pid,
    startedAt: toIso(now),
    port: bound?.port ?? null,
    address: bound?.address ?? null,
    supervisorPid: parsePid(supervisorPid),
  };
}

/**
 * The record written the moment a previous server (or its supervisor) has been
 * stopped, before this one listens: same keys as the listening record so any
 * reader handles both, port and address still unknown, plus the pid that was
 * taken over. An old supervisor polling the file sees a live pid that is not
 * its child and stops instead of relaunching into our port. Pure.
 */
export function takeoverRecord({
  selfPid,
  previousPid = null,
  supervisorPid = null,
  now,
}) {
  return {
    pid: selfPid,
    startedAt: toIso(now),
    port: null,
    address: null,
    supervisorPid: parsePid(supervisorPid),
    previousPid: parsePid(previousPid),
  };
}

/**
 * Whether a restart guard applies and what it should do once its timer fires.
 * Never armed on the first start (`skip`): cold dependency optimisation can
 * take longer than the guard allows. Pure.
 */
export function restartGuardVerdict({ starts, listening }) {
  if (!(Number(starts) > 1)) return 'skip';
  return listening ? 'ok' : 'exit';
}

/**
 * After an in-process restart Vite closes the old listener before opening the
 * new one, and a listen failure is only logged, so a restart can leave a live
 * process with a dead URL. Arm a timer that the `listening` event clears; if
 * it fires first the process exits with `EXIT_RESTART_FAILED` so a supervisor
 * relaunches it. A restart that failed before Vite closed the old server
 * (a later plugin threw while the new one was being built) leaves that
 * listener up and serving; `previousHttpServer` is that listener, and while
 * it still listens the guard stands down. Returns the timer, or null when
 * nothing was armed. Every side effect is injectable for tests.
 */
export function armRestartGuard(
  server,
  {
    starts,
    previousHttpServer = null,
    timeoutMs = RESTART_GUARD_MS,
    exit = (code) => process.exit(code),
    log = console.error,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  if (restartGuardVerdict({ starts, listening: false }) === 'skip') return null;
  const httpServer = server?.httpServer ?? null;
  const timer = setTimer(() => {
    const verdict = restartGuardVerdict({
      starts,
      listening:
        Boolean(httpServer?.listening) ||
        previousHttpServer?.listening === true,
    });
    if (verdict !== 'exit') return;
    log(
      '[dev] The server did not come back after a restart (port busy or listen failed); exiting so the supervisor can relaunch',
    );
    exit(EXIT_RESTART_FAILED);
  }, timeoutMs);
  // The guard must never keep an otherwise finished process alive.
  timer?.unref?.();
  httpServer?.once?.('listening', () => clearTimer(timer));
  return timer;
}

function readRecord(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeRecord(file, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record));
}

function removeRecordIfOurs(file) {
  const record = readRecord(file);
  if (record && Number.parseInt(record.pid, 10) === process.pid) {
    try {
      rmSync(file, { force: true });
    } catch {
      // Nothing to do: the next start checks whether the pid is alive anyway.
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send SIGTERM (TerminateProcess on Windows); false when the kill itself failed. */
function terminate(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll until the process is gone or the wait runs out; true when it is gone.
 * The clock and the pause are injectable for tests.
 */
export async function waitForExit(
  pid,
  {
    timeoutMs = STOP_WAIT_MS,
    alive = isAlive,
    now = Date.now,
    pause = sleep,
  } = {},
) {
  const deadline = now() + timeoutMs;
  while (alive(pid) && now() < deadline) await pause(50);
  return !alive(pid);
}

/**
 * Stop what the pid file records, supervisor first: a supervisor left alive
 * would relaunch the server the moment it is stopped, and a stopped supervisor
 * cannot, which closes that race even if the takeover record is written late.
 * The takeover record goes down as soon as a kill is confirmed, before this
 * server listens.
 *
 * First, though, a server whose own supervisor is already gone leaves: it is
 * an orphan (its supervisor was stopped by a newer server while this one was
 * still booting), and an orphan that went on would stop that newer server
 * and its supervisor, then exit a moment later by the launcher watch, leaving
 * nothing. Every process operation is injectable for tests.
 */
export async function stopPrevious(
  file,
  log,
  {
    selfPid = process.pid,
    selfSupervisorPid = ownSupervisorPid(),
    alive = isAlive,
    commandLine = commandLineOf,
    kill = terminate,
    wait = waitForExit,
    write = writeRecord,
    exit = (code) => process.exit(code),
    now = Date.now,
  } = {},
) {
  if (selfSupervisorPid && !alive(selfSupervisorPid)) {
    log(
      `[dev] The supervisor that started this dev server (pid ${selfSupervisorPid}) is gone; exiting instead of taking over`,
    );
    exit(0);
    return;
  }
  const record = readRecord(file);
  if (!record) return;
  const recordedSupervisor = parsePid(record.supervisorPid);
  const supervisorIsForeign =
    recordedSupervisor &&
    recordedSupervisor !== selfPid &&
    recordedSupervisor !== selfSupervisorPid &&
    alive(recordedSupervisor);
  const supervisor = supervisorToStop({
    record,
    selfPid,
    selfSupervisorPid,
    alive: alive(recordedSupervisor),
    commandLine: supervisorIsForeign
      ? await commandLine(recordedSupervisor)
      : null,
  });
  let supervisorStopped = false;
  if (supervisor && kill(supervisor))
    supervisorStopped = await wait(supervisor);

  const pid = Number.parseInt(record.pid, 10);
  const serverCommandLine =
    alive(pid) && pid !== selfPid ? await commandLine(pid) : null;
  const target = previousToStop({
    record,
    selfPid,
    alive: alive(pid),
    commandLine: serverCommandLine,
  });
  const serverStopped = Boolean(target && kill(target) && (await wait(target)));

  if (supervisorStopped || serverStopped)
    write(
      file,
      takeoverRecord({
        selfPid,
        previousPid: serverStopped ? target : null,
        supervisorPid: selfSupervisorPid,
        now: now(),
      }),
    );

  if (!target) {
    if (supervisorStopped)
      log(
        `[dev] Stopped the supervisor (pid ${supervisor}) of the previous dev server (pid ${pid}, already gone)`,
      );
    return;
  }
  if (!serverStopped) {
    log(
      `[dev] Previous dev server (pid ${target}) did not stop; the port may still be held` +
        (supervisorStopped
          ? `; its supervisor (pid ${supervisor}) was stopped`
          : ''),
    );
    return;
  }
  log(
    supervisorStopped
      ? `[dev] Stopped the previous dev server (pid ${target}) and its supervisor (pid ${supervisor})`
      : `[dev] Stopped the previous dev server (pid ${target})`,
  );
}

/**
 * A launcher that is not a terminal (a tool, a script) holds the server's
 * stdout pipe; when it stops the command that pipe closes even if every
 * process above is left running. Vite closes itself when stdin ends, but a
 * piped stdin is never read, so that never fires (and a stdin already at EOF
 * when the server starts, as under some tools, must not end it either), so
 * stdout is the pipe watched: the heartbeat write in `watchLauncher` gets the
 * EPIPE that a closed reader answers with.
 */
function watchStdout(onGone) {
  if (!process.stdout || process.stdout.isTTY) return;
  process.stdout.on('error', (error) => {
    if (error?.code === 'EPIPE') onGone('stdout closed');
  });
  process.stdout.on('close', () => onGone('stdout closed'));
}

/**
 * `currentServer` is asked for the server at the moment of leaving, not
 * captured at start: after an in-process restart the first server is
 * already closed, and the live one is what must be closed.
 */
async function watchLauncher(currentServer, log) {
  const parentPid = process.ppid;
  const chain = ancestorChain(process.pid, await processTable());
  // Always logged: when the server later leaves because a link died, this is
  // the line that says which pids were being watched.
  log(
    `[dev] Watching launcher chain: parent ${parentPid}, above it ${chain.join(' <- ') || 'nothing'}`,
  );
  let leaving = false;
  const leave = (why) => {
    if (leaving) return;
    leaving = true;
    clearInterval(timer);
    // The launcher's pipes may be closed already: a failed log must not stop the exit.
    try {
      log(
        `[dev] The process that started this dev server is gone (${why}); stopping`,
      );
    } catch {
      /* nowhere to write */
    }
    // Vite's close can wait on open connections; the exit does not.
    const exit = () => process.exit(0);
    setTimeout(exit, CLOSE_WAIT_MS).unref();
    try {
      Promise.resolve(currentServer()?.close()).then(exit, exit);
    } catch {
      exit();
    }
  };
  const timer = setInterval(() => {
    const gone = launcherGone({
      parentPid,
      currentParentPid: process.ppid,
      chain,
      alive: isAlive,
    });
    if (gone) leave('a launcher process exited');
    // A piped stdout only reports a closed reader on a write; an empty write
    // shows nothing and still gets the EPIPE.
    if (process.stdout && !process.stdout.isTTY) {
      try {
        process.stdout.write('');
      } catch {
        leave('stdout closed');
      }
    }
  }, WATCH_INTERVAL_MS);
  timer.unref();
  watchStdout(leave);
  return timer;
}

// A config change restarts Vite in-process, and Vite re-evaluates the config
// and this module with it, so a flag kept in the plugin or in this module
// starts over each time: every restart would add a watch (a 2 s timer and a
// PowerShell process scan), stdout listeners and an exit listener. What must
// happen once per process lives on globalThis instead, as ultra-help.js keeps
// SHARED; `server` is the one the latest start handed in, `listener` is the
// http server that last reached `listening` (the restart guard checks it is
// closed before it treats a missing listener as a failure), and `starts`
// counts every start of this process (the health endpoint reads it; the
// restart guard arms from the second one on).
const STATE = (globalThis.__GEV_DEV_SINGLE_INSTANCE ??= {
  watching: false,
  cleanupInstalled: false,
  server: null,
  listener: null,
  file: '',
  starts: 0,
});

/**
 * Vite plugin: stop the previous dev server of this checkout, record this
 * one, exit when the launcher goes away, and exit when a restart never comes
 * back to listening. `vite build` never runs it. `watch` and `restartGuard`
 * are there for the tests, which must not scan real processes or arm real
 * exits.
 */
export function singleInstancePlugin({
  root = process.cwd(),
  log = console.log,
  watch = watchLauncher,
  restartGuard = armRestartGuard,
} = {}) {
  const file = path.join(root, PID_FILE);
  return {
    name: 'dev-single-instance',
    apply: 'serve',
    async configureServer(server) {
      // A STATE made by an older copy of this module (a restart picking up
      // this file) has no counter yet; it starts from that restart.
      STATE.starts = (STATE.starts ?? 0) + 1;
      // The listener that was serving before this start; on a restart Vite
      // closes it only once the new server has been built, and a restart
      // that fails before then leaves it serving.
      const previousListener = STATE.listener ?? null;
      await stopPrevious(file, log);
      // The watch closes whichever server is live when the launcher goes.
      STATE.server = server;
      STATE.file = file;
      server.httpServer?.once('listening', () => {
        STATE.listener = server.httpServer;
        writeRecord(
          file,
          listeningRecord({
            pid: process.pid,
            address: server.httpServer.address(),
            supervisorPid: ownSupervisorPid(),
            now: Date.now(),
          }),
        );
      });
      restartGuard(server, {
        starts: STATE.starts,
        previousHttpServer: previousListener,
      });
      // Vite handles the signals and exits; a process killed outright leaves
      // the record behind, and the next start sees its pid is dead.
      if (!STATE.cleanupInstalled) {
        STATE.cleanupInstalled = true;
        process.once('exit', () => removeRecordIfOurs(STATE.file));
      }
      // The launcher is unchanged by a restart, so it is watched once.
      if (!STATE.watching) {
        STATE.watching = true;
        await watch(() => STATE.server, log);
      }
    },
  };
}
