#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PID_FILE,
  commandLineOf,
  isAlive,
} from '../server/standalone/single-instance.js';
import { isDirectInvocation } from './pinokio-install.mjs';

/**
 * `npm run dev`: keep the Vite dev server up and leave a reason behind.
 *
 * Vite runs as a child of this process. Whatever ends it (an uncaught
 * exception, a restart that never came back to listening, a kill from
 * outside, a hang) is written to `.gev-logs/dev-server.log` with the exit
 * code and the uptime, and the server is started again after a short,
 * growing pause. Four things stop the relaunching: the server stopped itself
 * (`q`, its launcher went away, exit code 0), the console interrupted it
 * (Ctrl+C), another dev server of this checkout took its port, or ten
 * launches in a row died inside a minute.
 *
 * A child that has to be killed (a hang, a stop it ignores) gets SIGTERM and,
 * five seconds later, SIGKILL: Vite handles SIGTERM in JavaScript, which a
 * blocked event loop never runs. On Windows both are TerminateProcess.
 *
 * The child keeps the console's stdin, so Vite's `r`, `u`, `o`, `c`, `q` +
 * enter shortcuts work as before; this process never reads stdin. Its stdout
 * and stderr are teed: every byte goes to the console and to the log, and
 * only this process writes the log. On a classic Windows console QuickEdit
 * is switched off for the session (a click in the window otherwise freezes
 * every writer attached to it until Esc), without touching the registry.
 *
 * `npm run dev:raw` is the bare Vite command for anyone who wants none of
 * this. `GEV_DEV_HANG_RESTART=0` keeps the health watchdog from restarting a
 * silent server; `GEV_DEV_KEEP_QUICKEDIT=1` leaves the console mode alone.
 *
 * Every in-process restart (a server file or .env edit, a POWER UP save)
 * loads a fresh copy of every server module and Node never unloads the old
 * one: about 45 MB stays behind each time, which is how a long editing day
 * ends at several gigabytes. Once the health route reports both many
 * restarts and a large resident set, the child is relaunched at a quiet
 * moment (right after a good probe) to hand that memory back; a few seconds
 * of downtime, logged. `GEV_DEV_RECYCLE=0` turns that off.
 */

const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT = fs.realpathSync(path.resolve(path.dirname(MODULE_PATH), '..'));
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const LOG_FILE = path.join(ROOT, '.gev-logs', 'dev-server.log');
const PID_RECORD = path.join(ROOT, PID_FILE);

/** Ceiling for the live log; one generation (`.log.1`) is kept, so disk use is bounded at twice this. */
export const LOG_CAP_BYTES = 8 * 1024 * 1024;
/** A server that stayed up this long had a clean launch; the failure count starts over. */
export const STABLE_UPTIME_MS = 60_000;
/** Launches that died inside STABLE_UPTIME_MS, one after another, before giving up. */
export const MAX_FAST_FAILURES = 10;
/** Longest pause between relaunches. */
export const MAX_BACKOFF_MS = 30_000;
/** Health probe cadence, per-probe timeout, and the misses that mean a hang (~70 s of silence). */
export const PROBE_INTERVAL_MS = 20_000;
export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_MISSES_FOR_HANG = 3;
/** In-process restarts and resident bytes that, together, earn the child a fresh process. */
export const RECYCLE_RESTARTS = 30;
export const RECYCLE_RSS_BYTES = 2 * 1024 ** 3;
/** The most of a health answer that is kept for parsing. */
const HEALTH_BODY_CAP = 64 * 1024;
/** How often the pid record is read while waiting for the new server to listen. */
export const RECORD_POLL_MS = 1000;
/** Grace between a stop request and the child being killed outright. */
const STOP_GRACE_MS = 5000;
/**
 * Longest a child may ignore SIGTERM before SIGKILL follows. Vite handles
 * SIGTERM in JavaScript, so a blocked event loop never acts on it; on Windows
 * both are TerminateProcess and the first one already ends the child.
 */
export const KILL_ESCALATE_MS = 5000;
/** Windows STATUS_CONTROL_C_EXIT: Ctrl+C reached the child and nothing handled it. */
const WINDOWS_CTRL_C_EXIT = 3221225786;
/** The POSIX convention for "interrupted"; Vite's own SIGINT handler exits with it too. */
const POSIX_INTERRUPTED = 130;
/** Default port of the dev server when the record does not say. */
const DEFAULT_PORT = 4173;
const HEALTH_PATH = '/__gev/health';
/** Errors that mean "nothing is listening there" rather than "something answered nothing". */
const NOT_CONNECTED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
]);

/** Pause before relaunch number `attempts` (0-based): 1 s, 2 s, 4 s, … capped at 30 s. */
export function backoffMs(attempts) {
  const count = Math.max(0, Number(attempts) || 0);
  return Math.min(1000 * 2 ** count, MAX_BACKOFF_MS);
}

/**
 * The pid in the record that may have taken the port over, or null. It must
 * be a live process other than the child and this process; the record must
 * have been written after the child was launched (a takeover is written by
 * the server that stopped the child, so it is always newer; an older record
 * is one a killed server left behind, and nothing removes those after
 * TerminateProcess, so its pid may belong to anything by now); it must not
 * come from one of this process's own children; and the supervisor it names,
 * if any, must be alive (a server whose supervisor is dead is an orphan that
 * exits by itself within seconds). The command line is not checked here;
 * `restartDecision` takes that as `viteLike`. Pure.
 */
export function takeoverPid({
  record = null,
  childPid = null,
  selfPid = null,
  launchedAt = 0,
  alive = isAlive,
} = {}) {
  const recorded = Number.parseInt(record?.pid, 10);
  if (!Number.isInteger(recorded) || recorded <= 0) return null;
  if (recorded === childPid || recorded === selfPid) return null;
  const writtenAt = Date.parse(record?.startedAt ?? '');
  if (!Number.isFinite(writtenAt) || writtenAt < launchedAt) return null;
  const supervisor = Number.parseInt(record?.supervisorPid, 10);
  if (Number.isInteger(supervisor) && supervisor > 0) {
    if (supervisor === selfPid) return null;
    if (!alive(supervisor)) return null;
  }
  return alive(recorded) ? recorded : null;
}

/**
 * What to do once the child has exited. Pure; the rules apply in order:
 *  - a stop was requested (signal, stdout gone): stop;
 *  - exit code 0: the server stopped itself (`q`, launcher gone, stdin end);
 *  - CTRL_C_EXIT or 130: the console interrupted it, the person wants it gone;
 *  - `ownKill` with a signal: this process killed it (the hang watchdog), so
 *    relaunch at once;
 *  - the pid record names a takeover (see `takeoverPid`) and that pid is a
 *    Vite process (`viteLike`, from its command line): another dev server of
 *    this checkout took the port, stop;
 *  - ten launches that each died inside a minute: give up;
 *  - anything else (crash, exit 70, exit 75, a signal from outside such as an
 *    OOM kill or a kill -9): relaunch after a growing pause. A child that
 *    stayed up a minute resets the count.
 */
export function restartDecision({
  code = null,
  signal = null,
  uptimeMs = 0,
  attempts = 0,
  stopping = false,
  ownKill = false,
  record = null,
  childPid = null,
  selfPid = null,
  launchedAt = 0,
  alive = isAlive,
  viteLike = true,
} = {}) {
  if (stopping) return { action: 'stop', reason: 'stop requested', delayMs: 0 };
  if (code === 0)
    return { action: 'stop', reason: 'the server stopped itself', delayMs: 0 };
  if (code === WINDOWS_CTRL_C_EXIT || code === POSIX_INTERRUPTED)
    return { action: 'stop', reason: 'interrupted', delayMs: 0 };
  const effectiveAttempts = uptimeMs >= STABLE_UPTIME_MS ? 0 : attempts;
  if (signal && ownKill)
    return {
      action: 'restart',
      reason: `killed by ${signal}`,
      delayMs: 0,
      attempts: effectiveAttempts,
    };
  const takeover = takeoverPid({
    record,
    childPid,
    selfPid,
    launchedAt,
    alive,
  });
  if (takeover && viteLike)
    return {
      action: 'stop',
      reason: `another dev server took over (pid ${takeover})`,
      delayMs: 0,
    };
  if (effectiveAttempts >= MAX_FAST_FAILURES)
    return {
      action: 'give-up',
      reason: `${MAX_FAST_FAILURES} launches in a row died inside ${STABLE_UPTIME_MS / 1000} s; see .gev-logs/dev-server.log`,
      delayMs: 0,
    };
  return {
    action: 'restart',
    reason: signal
      ? `killed by ${signal}`
      : `exited with code ${code ?? 'null'}`,
    delayMs: backoffMs(effectiveAttempts),
    attempts: effectiveAttempts + 1,
  };
}

/**
 * Which signal a kill sends, given how long ago it began and whether the
 * child has already left: SIGTERM first, SIGKILL once the escalation time is
 * up, nothing for a child that is gone. Pure.
 */
export function killPlan({
  elapsedMs = 0,
  exited = false,
  escalateMs = KILL_ESCALATE_MS,
} = {}) {
  if (exited) return 'none';
  return elapsedMs >= escalateMs ? 'SIGKILL' : 'SIGTERM';
}

/**
 * SIGTERM now, SIGKILL after `escalateMs` if the child is still running. A
 * child that cannot run its SIGTERM handler (a blocked event loop) is the
 * case the hang watchdog exists for, so the second signal is not optional.
 * Never throws; returns the escalation timer.
 */
export function killWithEscalation(
  child,
  { escalateMs = KILL_ESCALATE_MS, setTimer = setTimeout } = {},
) {
  const exited = () =>
    !child || child.exitCode !== null || child.signalCode !== null;
  const send = (elapsedMs) => {
    const signal = killPlan({ elapsedMs, exited: exited(), escalateMs });
    if (signal === 'none') return;
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  send(0);
  const timer = setTimer(() => send(escalateMs), escalateMs);
  timer?.unref?.();
  return timer;
}

/**
 * Fold one health probe into the watchdog's state. A success clears the
 * count. A connection that was made but got no answer in time is a miss, and
 * three in a row mean the event loop is stuck. A connection that could not
 * be made at all (ECONNREFUSED while the listener is closed for a restart,
 * ENOTFOUND) is neither: the restart guard in the server already turns a
 * listener that never comes back into an exit. Pure.
 */
export function healthState(
  prev = { misses: 0, unresponsive: false },
  { ok = false, connected = false } = {},
) {
  if (ok) return { misses: 0, unresponsive: false };
  const misses = connected ? (prev?.misses ?? 0) + 1 : (prev?.misses ?? 0);
  return { misses, unresponsive: misses >= PROBE_MISSES_FOR_HANG };
}

/**
 * Whether the child has leaked enough through in-process restarts to be worth
 * a relaunch: only when BOTH the restart count and the resident set are at
 * their thresholds, so a big but fresh process and a much-restarted small one
 * are both left alone. Pure.
 */
export function recyclePlan({
  restarts,
  rss,
  minRestarts = RECYCLE_RESTARTS,
  minRss = RECYCLE_RSS_BYTES,
} = {}) {
  return (
    Number.isFinite(restarts) &&
    Number.isFinite(rss) &&
    restarts >= minRestarts &&
    rss >= minRss
  );
}

/** The health answer as an object, or null for anything that is not one. Pure. */
export function parseHealth(text) {
  return parseRecord(text);
}

/**
 * Classify a probe's end: an answer, a connection that went quiet, or no
 * connection. `health` is the parsed answer when there was one. Pure.
 */
export function probeOutcome({
  statusCode = null,
  error = null,
  health = null,
} = {}) {
  if (!error)
    return {
      ok: statusCode === 200,
      connected: true,
      detail: null,
      health: statusCode === 200 ? health : null,
    };
  const code = typeof error?.code === 'string' ? error.code : null;
  if (code && NOT_CONNECTED_CODES.has(code))
    return { ok: false, connected: false, detail: code };
  return {
    ok: false,
    connected: true,
    detail: code ?? error?.message ?? 'timeout',
  };
}

/** True when appending `incoming` bytes would push the log past the cap. Pure. */
export function rotationPlan({
  size = 0,
  incoming = 0,
  cap = LOG_CAP_BYTES,
} = {}) {
  return size + incoming > cap;
}

/**
 * Whether to switch QuickEdit off: only a classic Windows console (not
 * Windows Terminal, which has no QuickEdit and sets WT_SESSION), only when
 * stdin is that console, and never when the person opted out. Pure.
 */
export function quickEditPlan({ platform, isTTY, env = {} } = {}) {
  return (
    platform === 'win32' &&
    Boolean(isTTY) &&
    !env.WT_SESSION &&
    env.GEV_DEV_KEEP_QUICKEDIT !== '1'
  );
}

/**
 * Where to send the health probe, from the pid record. A wildcard bind
 * (`0.0.0.0`, `::`) or a record without an address is reached on the
 * loopback; any other address is used as is (an IPv6 literal goes to
 * `http.request` as a bare host, no brackets). Pure.
 */
export function probeTarget(record) {
  const address =
    typeof record?.address === 'string' ? record.address.trim() : '';
  const host =
    !address || address === '0.0.0.0' || address === '::'
      ? '127.0.0.1'
      : address;
  const port = Number.parseInt(record?.port, 10);
  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT,
  };
}

/** The line written when the child exits. Pure. */
export function formatExitLine({
  code = null,
  signal = null,
  uptimeMs = 0,
} = {}) {
  const seconds = (Math.max(0, Number(uptimeMs) || 0) / 1000).toFixed(1);
  return `[dev-server] exited code=${code ?? 'null'} signal=${signal ?? 'null'} after ${seconds}s`;
}

/** The pid record as an object, or null for anything that is not one. Pure. */
export function parseRecord(text) {
  try {
    const value = JSON.parse(String(text));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * How the child is spawned. The same node binary, the same heap ceiling the
 * old `npm run dev` had, Vite's bin script, and whatever arguments were given
 * to `npm run dev --`. The child learns this process's pid so
 * `single-instance.js` can tell our supervisor from a foreign one, and keeps
 * colour on a console (Vite drops it on a pipe) unless the person has asked
 * for none with NO_COLOR, which Node would otherwise warn about. Pure.
 */
export function spawnPlan({
  execPath = process.execPath,
  viteBin = VITE_BIN,
  argv = [],
  env = process.env,
  pid = process.pid,
  isTTY = Boolean(process.stdout?.isTTY),
  cwd = ROOT,
} = {}) {
  return {
    command: execPath,
    args: ['--max-old-space-size=16384', viteBin, ...argv],
    options: {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...env,
        GEV_DEV_SUPERVISOR_PID: String(pid),
        ...(isTTY && env.NO_COLOR === undefined ? { FORCE_COLOR: '1' } : {}),
      },
      shell: false,
      detached: false,
    },
  };
}

/**
 * Clear ENABLE_QUICK_EDIT_MODE (0x40) on the console's input mode and set
 * ENABLE_EXTENDED_FLAGS (0x80), which SetConsoleMode needs for the former to
 * take. Prints "<before> <after>". The handle is the console input: stdin
 * when that is the console, else `CONIN$` opened directly.
 */
export const QUICKEDIT_SCRIPT = [
  "Add-Type -Namespace GevDev -Name Console -MemberDefinition '",
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int nStdHandle);',
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);',
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);',
  '[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);',
  "'",
  '$mode = [uint32]0',
  '$h = [GevDev.Console]::GetStdHandle(-10)',
  'if (-not [GevDev.Console]::GetConsoleMode($h, [ref]$mode)) {',
  '  $h = [GevDev.Console]::CreateFile("CONIN$", 0xC0000000, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)',
  '  if (-not [GevDev.Console]::GetConsoleMode($h, [ref]$mode)) { throw "GetConsoleMode failed: no console input handle" }',
  '}',
  '$before = [uint32]$mode',
  '$after = [uint32](($before -band (-bnot 0x40)) -bor 0x80)',
  'if (-not [GevDev.Console]::SetConsoleMode($h, $after)) { throw "SetConsoleMode failed (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }',
  '"$before $after"',
].join('\n');

/**
 * Run the QuickEdit script in a PowerShell that shares this console. The
 * console input mode is one setting per console, shared by every process
 * attached to it, so the change made here reaches the Vite child as well.
 * stdin is inherited on purpose: `execFile` would pipe it, and a pipe has
 * no console mode. Never awaited by the spawn; one log line either way.
 */
function disableQuickEdit(log, { run = spawn, timeoutMs = 10_000 } = {}) {
  let child;
  try {
    child = run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(QUICKEDIT_SCRIPT, 'utf16le').toString('base64'),
      ],
      { stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true },
    );
  } catch (error) {
    log(`[dev-server] could not change console mode: ${error.message}`);
    return;
  }
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    err += chunk;
  });
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  timer.unref?.();
  child.on('error', (error) => {
    clearTimeout(timer);
    log(`[dev-server] could not change console mode: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    const match = /(\d+)\s+(\d+)/.exec(out);
    if (code === 0 && match) {
      log(
        `[dev-server] QuickEdit disabled for this console (mode ${match[1]} -> ${match[2]})`,
      );
      return;
    }
    const reason =
      err.trim().split(/\r?\n/)[0] ||
      (signal ? `powershell ${signal}` : `powershell exited ${code}`);
    log(`[dev-server] could not change console mode: ${reason}`);
  });
}

/**
 * The log sink: an append-only fd, a byte counter, and a best-effort
 * rotation at the cap (rm the old generation, then rename, as
 * `server/providers/openai/debug-log.js` does; Node does not replace an
 * existing destination on Windows). A rotation that fails, because another
 * supervisor briefly holds the file, is swallowed and the log keeps growing
 * until the next try.
 */
function openLog(file, { cap = LOG_CAP_BYTES } = {}) {
  let fd = null;
  let size = 0;
  const open = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = fs.openSync(file, 'a');
      size = fs.fstatSync(fd).size;
    } catch {
      fd = null;
      size = 0;
    }
  };
  const close = () => {
    if (fd === null) return;
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    fd = null;
  };
  const rotate = () => {
    close();
    try {
      fs.rmSync(`${file}.1`, { force: true });
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* another writer holds it; append on and try at the next cap */
    }
    open();
  };
  open();
  return {
    write(chunk) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      if (rotationPlan({ size, incoming: buffer.length, cap })) rotate();
      if (fd === null) return;
      try {
        fs.writeSync(fd, buffer);
        size += buffer.length;
      } catch {
        /* disk full or file gone; the console still has the line */
      }
    },
    close,
  };
}

function readRecordFile(file = PID_RECORD) {
  try {
    return parseRecord(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One GET of the health route; resolves to a probe outcome, never rejects. */
function probeHealth({ host, port, timeoutMs = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const request = http.get(
      { host, port, path: HEALTH_PATH, timeout: timeoutMs },
      (response) => {
        // Keep a bounded copy of the answer for the recycle rule; the rest
        // is drained so the socket is released.
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (body.length < HEALTH_BODY_CAP) body += chunk;
        });
        response.on('end', () =>
          finish(
            probeOutcome({
              statusCode: response.statusCode,
              health: parseHealth(body.slice(0, HEALTH_BODY_CAP)),
            }),
          ),
        );
        response.on('error', (error) => finish(probeOutcome({ error })));
      },
    );
    request.on('timeout', () => {
      request.destroy(
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      );
    });
    request.on('error', (error) => finish(probeOutcome({ error })));
  });
}

/**
 * The hang watchdog for one child. First the pid record is polled until it
 * names the child with a port (the server is listening), then the health
 * route is probed every PROBE_INTERVAL_MS. Misses only count from the first
 * answer on: a server still optimising dependencies is slow, not stuck. A
 * good answer whose restart count and resident set pass `recycle` calls
 * `onRecycle` instead (when given) and stops: the child is to be relaunched.
 * Returns a `stop()` that clears every timer.
 */
export function startWatchdog({
  childPid,
  log,
  onHang,
  onRecycle = null,
  recycle = recyclePlan,
  readRecord = readRecordFile,
  probe = probeHealth,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let stopped = false;
  let armed = false;
  let state = healthState();
  let lastNotConnected = null;
  const schedule = (fn, ms) => {
    if (stopped) return;
    timer = setTimer(fn, ms);
    timer?.unref?.();
  };
  const tick = async () => {
    if (stopped) return;
    const record = readRecord();
    if (Number.parseInt(record?.pid, 10) !== childPid || !record?.port) {
      // Not listening yet, or the record belongs to someone else now.
      schedule(tick, armed ? PROBE_INTERVAL_MS : RECORD_POLL_MS);
      return;
    }
    const outcome = await probe(probeTarget(record));
    if (stopped) return;
    if (outcome.ok && !armed) {
      armed = true;
      log(
        `[dev-server] health probe answered; watching ${probeTarget(record).host}:${probeTarget(record).port}${HEALTH_PATH} every ${PROBE_INTERVAL_MS / 1000} s`,
      );
    }
    if (!outcome.connected && outcome.detail !== lastNotConnected) {
      lastNotConnected = outcome.detail;
      log(
        `[dev-server] health probe could not connect (${outcome.detail}); no miss counted`,
      );
    }
    if (outcome.connected) lastNotConnected = null;
    if (armed) {
      state = healthState(state, outcome);
      if (outcome.connected && !outcome.ok)
        log(
          `[dev-server] health probe got no answer (${outcome.detail}); miss ${state.misses} of ${PROBE_MISSES_FOR_HANG}`,
        );
      if (state.unresponsive) {
        stopped = true;
        onHang();
        return;
      }
      const restarts = outcome.health?.restarts;
      const rss = outcome.health?.memory?.rss;
      if (outcome.ok && onRecycle && recycle({ restarts, rss })) {
        stopped = true;
        log(
          `[dev-server] ${restarts} in-process restarts and ${Math.round(rss / 1048576)} MB resident; relaunching to hand the memory back`,
        );
        onRecycle();
        return;
      }
    }
    schedule(tick, armed ? PROBE_INTERVAL_MS : RECORD_POLL_MS);
  };
  schedule(tick, RECORD_POLL_MS);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

/**
 * Watch this process's own stdout when it is a pipe: a launcher that stops
 * reading (a tool, a script) is the only sign that it is gone, and the first
 * write after that answers with EPIPE (as `single-instance.js` does for the
 * server itself).
 */
function watchOwnStdout(onGone) {
  if (!process.stdout || process.stdout.isTTY) return;
  process.stdout.on('error', (error) => {
    if (error?.code === 'EPIPE') onGone('stdout closed');
  });
  process.stdout.on('close', () => onGone('stdout closed'));
}

async function main() {
  const sink = openLog(LOG_FILE);
  const toConsole = (stream, chunk) => {
    try {
      stream.write(chunk);
    } catch {
      /* the console is gone; the log still has it */
    }
  };
  const log = (line) => {
    const text = `${line}\n`;
    toConsole(process.stdout, text);
    sink.write(text);
  };

  // A closed stderr pipe must not become an uncaught exception.
  process.stderr?.on?.('error', () => {});

  const argv = process.argv.slice(2);
  log(
    `[dev-server] start pid=${process.pid} node=${process.version} cwd=${ROOT} argv=${JSON.stringify(argv)} log=${path.relative(ROOT, LOG_FILE)}`,
  );

  if (
    quickEditPlan({
      platform: process.platform,
      isTTY: Boolean(process.stdin?.isTTY),
      env: process.env,
    })
  )
    disableQuickEdit(log);

  const hangRestart = process.env.GEV_DEV_HANG_RESTART !== '0';
  if (!hangRestart)
    log('[dev-server] hang watchdog off (GEV_DEV_HANG_RESTART=0)');
  const recycleOn = process.env.GEV_DEV_RECYCLE !== '0';
  if (!recycleOn) log('[dev-server] memory recycle off (GEV_DEV_RECYCLE=0)');

  let child = null;
  let watchdog = null;
  let attempts = 0;
  let stopping = false;
  let stopSignal = null;
  let stopTimer = null;
  /** True once this process has sent the current child a kill; a signal exit is then its own doing. */
  let ownKill = false;

  const finish = (code) => {
    if (stopTimer) clearTimeout(stopTimer);
    sink.close();
    process.exit(code);
  };

  /** A stop from outside: let the child leave on its own, kill it after the grace. */
  const beginStop = (why, signal = null) => {
    if (stopping) return;
    stopping = true;
    stopSignal = signal;
    log(`[dev-server] ${why}; stopping the server`);
    watchdog?.stop();
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      finish(signal === 'SIGINT' ? POSIX_INTERRUPTED : 0);
      return;
    }
    ownKill = true;
    // Ctrl+C reaches the child from the console by itself; a SIGTERM or
    // SIGHUP aimed at this pid (a takeover, a service stop) does not, so it
    // is passed on now and the grace is the time until SIGKILL. Either way
    // the child is killed outright in the end: a blocked event loop never
    // runs Vite's own SIGTERM handler.
    if (signal === 'SIGTERM' || signal === 'SIGHUP') {
      killWithEscalation(child, { escalateMs: STOP_GRACE_MS });
      return;
    }
    stopTimer = setTimeout(() => killWithEscalation(child), STOP_GRACE_MS);
    stopTimer.unref?.();
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => beginStop(`${signal} received`, signal));
  watchOwnStdout((why) => beginStop(why));

  const launch = () => {
    const plan = spawnPlan({ argv });
    const startedAt = Date.now();
    let settled = false;
    ownKill = false;
    try {
      child = spawn(plan.command, plan.args, plan.options);
    } catch (error) {
      log(`[dev-server] could not start the server: ${error.message}`);
      child = null;
      void settle({ child: null, code: 1, signal: null, startedAt });
      return;
    }
    const current = child;
    log(`[dev-server] started vite pid=${current.pid ?? 'unknown'}`);
    current.stdout?.on('data', (chunk) => {
      toConsole(process.stdout, chunk);
      sink.write(chunk);
    });
    current.stderr?.on('data', (chunk) => {
      toConsole(process.stderr, chunk);
      sink.write(chunk);
    });
    current.on('error', (error) => {
      log(`[dev-server] could not start the server: ${error.message}`);
      // A spawn failure fires no 'exit'; a later error still gets one.
      if (!current.pid && !settled) {
        settled = true;
        void settle({ child: current, code: 1, signal: null, startedAt });
      }
    });
    current.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      void settle({ child: current, code, signal, startedAt });
    });
    if (hangRestart && current.pid)
      watchdog = startWatchdog({
        childPid: current.pid,
        log,
        onHang: () => {
          log(
            `[dev-server] server unresponsive for ~${(PROBE_INTERVAL_MS * PROBE_MISSES_FOR_HANG + PROBE_TIMEOUT_MS) / 1000} s; restarting`,
          );
          ownKill = true;
          killWithEscalation(current);
        },
        onRecycle: recycleOn
          ? () => {
              ownKill = true;
              killWithEscalation(current);
            }
          : null,
      });
  };

  /** The child is gone: say so, decide, wait, look again, and relaunch or leave. */
  const settle = async ({ child: gone, code, signal, startedAt }) => {
    watchdog?.stop();
    watchdog = null;
    const pid = gone?.pid ?? null;
    const uptimeMs = Date.now() - startedAt;
    log(formatExitLine({ code, signal, uptimeMs }));
    const decide = async () => {
      const record = readRecordFile();
      const candidate = takeoverPid({
        record,
        childPid: pid,
        selfPid: process.pid,
        launchedAt: startedAt,
        alive: isAlive,
      });
      // A stale record can name a recycled pid; only a Vite process is a
      // takeover. The process scan runs only when the record is a candidate.
      const viteLike = candidate
        ? /vite/i.test((await commandLineOf(candidate)) ?? '')
        : false;
      return restartDecision({
        code,
        signal,
        uptimeMs,
        attempts,
        stopping,
        ownKill,
        record,
        childPid: pid,
        selfPid: process.pid,
        launchedAt: startedAt,
        alive: isAlive,
        viteLike,
      });
    };
    const leave = (decision) => {
      log(`[dev-server] ${decision.action}: ${decision.reason}`);
      const exitCode =
        decision.action === 'give-up'
          ? 1
          : code === WINDOWS_CTRL_C_EXIT
            ? POSIX_INTERRUPTED
            : (code ?? (stopSignal === 'SIGINT' ? POSIX_INTERRUPTED : 0));
      // 'exit' can fire with output still in the pipes; give 'close' a moment
      // so the last lines reach the log before the process ends.
      let left = false;
      const exitNow = () => {
        if (left) return;
        left = true;
        finish(exitCode);
      };
      if (!gone || gone.stdout?.destroyed !== false) exitNow();
      else {
        gone.once('close', exitNow);
        setTimeout(exitNow, 1000).unref?.();
      }
    };
    let decision = await decide();
    if (decision.action !== 'restart') return leave(decision);
    if (decision.delayMs > 0) {
      log(
        `[dev-server] ${decision.reason}; restarting in ${decision.delayMs / 1000} s`,
      );
      // The pause comes first so a takeover record written late is seen.
      await sleep(decision.delayMs);
      decision = await decide();
      if (decision.action !== 'restart') return leave(decision);
    } else log(`[dev-server] ${decision.reason}; restarting now`);
    attempts = decision.attempts ?? attempts;
    launch();
  };

  launch();
}

if (isDirectInvocation(process.argv[1], MODULE_PATH)) {
  main().catch((error) => {
    console.error(`[dev-server] failed: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
