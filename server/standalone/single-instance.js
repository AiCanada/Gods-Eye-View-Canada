import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * One dev server per checkout.
 *
 * Stopping `npm run dev` on Windows ends npm and its cmd wrapper but not the
 * node process that is Vite, so every restart left a server behind and the
 * next one moved up a port (nine were found holding 4173 to 4181). Two guards:
 *  - at start-up, the server recorded in the pid file is stopped if it is
 *    still a Vite process, so the new one takes the usual port;
 *  - while running, the server exits by itself when any process in the chain
 *    that launched it (cmd, npm, the shell, the terminal) is gone.
 */

const PID_FILE = path.join('node_modules', '.vite', 'gev-dev-server.pid');
const WATCH_INTERVAL_MS = 2000;
const STOP_WAIT_MS = 3000;
const CLOSE_WAIT_MS = 3000;

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

/** Command line of a process, or null when it cannot be read. */
async function commandLineOf(pid) {
  try {
    if (process.platform === 'win32') {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 });
      return stdout.trim() || null;
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'args=', '-p', String(pid)], { timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Every process as {pid, ppid, name}, or [] when the table cannot be read. */
async function processTable() {
  try {
    if (process.platform === 'win32') {
      const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }';
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
      return parseProcessTable(stdout);
    }
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,comm='], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    return parseProcessTable(stdout);
  } catch {
    return [];
  }
}

export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), name: match[3].trim() });
  }
  return rows;
}

/** Where a launch chain ends: the session's root processes, which outlive any command. */
const CHAIN_ROOTS = /^(explorer\.exe|services\.exe|wininit\.exe|winlogon\.exe|svchost\.exe|csrss\.exe|smss\.exe|system|launchd|systemd|init)$/i;

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
    if (!parent || parent.pid === current.pid || parent.pid <= 1 || CHAIN_ROOTS.test(parent.name)) break;
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
  if (typeof commandLine !== 'string' || !/vite/i.test(commandLine)) return null;
  return pid;
}

/**
 * Decide whether this server has lost what launched it: its parent changed
 * (POSIX re-parents an orphan to pid 1), or any process in the chain recorded
 * at start-up is gone. Stopping a command from a tool or a terminal can kill
 * any link of that chain (the shell, npm, or cmd) and leave the rest running,
 * so every link counts.
 */
export function launcherGone({ parentPid, currentParentPid, chain = [], alive }) {
  if (currentParentPid !== parentPid) return true;
  if (!alive(parentPid)) return true;
  return chain.some((pid) => !alive(pid));
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

async function stopPrevious(file, log) {
  const record = readRecord(file);
  if (!record) return;
  const pid = Number.parseInt(record.pid, 10);
  const commandLine = isAlive(pid) && pid !== process.pid ? await commandLineOf(pid) : null;
  const target = previousToStop({
    record,
    selfPid: process.pid,
    alive: isAlive(pid),
    commandLine,
  });
  if (!target) return;
  try {
    process.kill(target, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (isAlive(target) && Date.now() < deadline) await sleep(50);
  log(isAlive(target)
    ? `[dev] Previous dev server (pid ${target}) did not stop; the port may still be held`
    : `[dev] Stopped the previous dev server (pid ${target})`);
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
  if (process.env.GEV_DEV_WATCH_DEBUG) log(`[dev] Watching launcher chain: parent ${parentPid}, above it ${chain.join(' <- ') || 'nothing'}`);
  let leaving = false;
  const leave = (why) => {
    if (leaving) return;
    leaving = true;
    clearInterval(timer);
    // The launcher's pipes may be closed already: a failed log must not stop the exit.
    try {
      log(`[dev] The process that started this dev server is gone (${why}); stopping`);
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
// SHARED; `server` is the one the latest start handed in.
const STATE = (globalThis.__GEV_DEV_SINGLE_INSTANCE ??= {
  watching: false,
  cleanupInstalled: false,
  server: null,
  file: '',
});

/**
 * Vite plugin: stop the previous dev server of this checkout, record this
 * one, and exit when the launcher goes away. `vite build` never runs it.
 * `watch` is there for the tests, which must not scan real processes.
 */
export function singleInstancePlugin({ root = process.cwd(), log = console.log, watch = watchLauncher } = {}) {
  const file = path.join(root, PID_FILE);
  return {
    name: 'dev-single-instance',
    apply: 'serve',
    async configureServer(server) {
      await stopPrevious(file, log);
      // The watch closes whichever server is live when the launcher goes.
      STATE.server = server;
      STATE.file = file;
      server.httpServer?.once('listening', () => writeRecord(file, { pid: process.pid, startedAt: new Date().toISOString() }));
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
