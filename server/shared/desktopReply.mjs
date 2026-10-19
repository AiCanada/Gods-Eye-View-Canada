/**
 * AI DISTILLATION's round trip through a bot's desktop app, best effort
 * (owner request 2026-10-19: "use same method in fallback methods to copy and
 * paste answers back in GEVC", then "still uses DOTs automation follow best
 * effort"). The prompt goes into Grok Bot or ChatGPT the way the swarm pastes
 * a task (scripts/paste-grok-bot.ps1, scripts/paste-openai-dots.ps1), with a
 * tag on its last line; scripts/read-desktop-reply.ps1 then waits for the
 * reply after the tagged message and brings it back: ChatGPT's own Copy
 * response button, else the reply's text read from the window. Windows only.
 * Whatever fails leaves the turn to the paste-back box, as before.
 *
 * One app at a time: a paste and a copy each take the foreground, the mouse
 * and the clipboard. Reading alone (after the Chief of Staff webhook) needs
 * none of them and does not wait its turn.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GROK_BOT_PASTE_MAX,
  GROK_BOT_PASTE_SETTLE_MS,
  grokBotLaunchTarget,
  pasteIntoGrokBot,
  systemOpener,
  systemPowershell,
} from '../providers/grokBotDesktop.js';
import {
  OPENAI_DOTS_PASTE_MAX,
  OPENAI_DOTS_PASTE_SETTLE_MS,
  openaiDotsLaunchTarget,
  pasteIntoChatGpt,
} from '../providers/openaiDotsDesktop.js';

/** Repo-relative reader; the job rides on stdin, never argv. */
export const DESKTOP_REPLY_SCRIPT = 'scripts/read-desktop-reply.ps1';
/** Longest wait for a reply to finish. */
export const DESKTOP_REPLY_TIMEOUT_MS = 10 * 60_000;
/** The pasted prompt shows in the app within this, or the paste missed. */
export const DESKTOP_FIND_MS = 60_000;
/** A webhook's task can take longer to reach the Grok Bot window. */
export const WEBHOOK_FIND_MS = 3 * 60_000;
/**
 * How long a reply must stay the same to count as finished. ChatGPT also
 * shows its Copy response bar only when done; Grok Bot's typing dots are
 * hidden from UI Automation, so it gets the longer quiet.
 */
export const DESKTOP_QUIET_MS = Object.freeze({
  'grok-bot': 15_000,
  chatgpt: 5_000,
});
const READ_SLACK_MS = 30_000;
const STDOUT_BYTES = 1024 * 1024;

// One paste-and-copy at a time on this PC, across every run and round.
let turns = Promise.resolve();
const inTurn = (fn) => {
  const next = turns.then(fn, fn);
  turns = next.catch(() => {});
  return next;
};

const DEFAULT_SOURCE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const APPS = Object.freeze({
  'grok-bot': {
    max: GROK_BOT_PASTE_MAX,
    settle: GROK_BOT_PASTE_SETTLE_MS,
    launch: grokBotLaunchTarget,
    paste: pasteIntoGrokBot,
    copy: false,
  },
  chatgpt: {
    max: OPENAI_DOTS_PASTE_MAX,
    settle: OPENAI_DOTS_PASTE_SETTLE_MS,
    launch: openaiDotsLaunchTarget,
    paste: pasteIntoChatGpt,
    copy: true,
  },
});

/** A fresh tag: GEV- and eight hex digits. */
export function desktopTag() {
  return `GEV-${crypto.randomBytes(4).toString('hex')}`;
}

/** The prompt as pasted: the tag on its own last line. */
export function tagPrompt(text, tag) {
  return `${String(text ?? '')}\n\n[${tag}]`;
}

const failure = (message, pasted = false) =>
  Object.assign(new Error(message), { pasted });

const stopped = () =>
  Object.assign(new Error('Stopped'), { name: 'AbortError' });

function readerScript(sourceRoot, fileSystem) {
  const script = path.win32.join(
    sourceRoot,
    ...DESKTOP_REPLY_SCRIPT.split('/'),
  );
  try {
    return fileSystem.statSync(script).isFile() ? script : '';
  } catch {
    return '';
  }
}

/**
 * The reply after the message tagged `tag` in an app's window, from
 * scripts/read-desktop-reply.ps1.
 * @returns {Promise<{text: string, how: 'copy' | 'read'}>}
 */
export function readDesktopReply({
  app,
  tag,
  signal,
  findMs = DESKTOP_FIND_MS,
  timeoutMs = DESKTOP_REPLY_TIMEOUT_MS,
  quietMs = DESKTOP_QUIET_MS[app] ?? 15_000,
  copy = APPS[app]?.copy === true,
  spawnImpl = spawn,
  platform = process.platform,
  fileSystem = fs,
  env = process.env,
  sourceRoot = DEFAULT_SOURCE_ROOT,
} = {}) {
  if (!APPS[app]) return Promise.reject(failure(`Unknown app: ${app}.`));
  if (signal?.aborted) return Promise.reject(stopped());
  const powershell = systemPowershell(env, { platform, fileSystem });
  const script = readerScript(sourceRoot, fileSystem);
  if (!powershell || !script)
    return Promise.reject(failure('Reading a desktop app needs Windows.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let out = '';
    let child;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const kill = () => {
      try {
        child?.kill?.();
      } catch {
        /* already gone */
      }
    };
    const onAbort = () => {
      finish(stopped());
      kill();
    };
    const timer = setTimeout(() => {
      finish(failure('The app gave no finished reply in time.'));
      kill();
    }, timeoutMs + READ_SLACK_MS);
    timer.unref?.();
    try {
      // As the paste scripts: a hidden console cannot click for ChatGPT's copy.
      child = spawnImpl(
        powershell,
        [
          '-NoProfile',
          '-STA',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          `"${script}"`,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: false,
          windowsVerbatimArguments: true,
        },
      );
    } catch {
      finish(failure('The desktop reader could not start.'));
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => {
      out += String(chunk);
      if (out.length > STDOUT_BYTES) {
        kill();
        finish(failure('The desktop reader said too much.'));
      }
    });
    child.stderr?.resume?.();
    child.on?.('error', () => finish(failure('The desktop reader failed.')));
    child.on?.('exit', () => {
      let said = null;
      for (const line of out.split(/\r?\n/).reverse()) {
        if (!line.trim()) continue;
        try {
          said = JSON.parse(line);
          break;
        } catch {
          /* not one of ours */
        }
      }
      if (said?.event === 'reply' && typeof said.b64 === 'string') {
        const text = Buffer.from(said.b64, 'base64').toString('utf8').trim();
        if (text)
          return finish(null, {
            text,
            how: said.how === 'copy' ? 'copy' : 'read',
          });
      }
      finish(
        failure(
          said?.event === 'error' && said.reason
            ? `The app's reply did not come back: ${String(said.reason).slice(0, 200)}.`
            : "The app's reply did not come back.",
        ),
      );
    });
    try {
      child.stdin.write(
        JSON.stringify({ app, tag, timeoutMs, findMs, quietMs, copy }),
        'utf8',
      );
      child.stdin.end();
    } catch {
      kill();
      finish(failure('The desktop reader could not start.'));
    }
  });
}

/**
 * The desktop round trip, with its seams. `ready()` says whether this machine
 * can do it at all; `ask` pastes and reads back; `read` only reads.
 */
export function createDesktopRound({
  spawnImpl = spawn,
  platform = process.platform,
  fileSystem = fs,
  env = process.env,
  sourceRoot = DEFAULT_SOURCE_ROOT,
  sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener?.(
        'abort',
        () => {
          clearTimeout(timer);
          reject(stopped());
        },
        { once: true },
      );
    }),
  read = readDesktopReply,
} = {}) {
  const seams = { spawnImpl, platform, fileSystem, env, sourceRoot };
  return {
    ready() {
      return Boolean(
        systemPowershell(env, { platform, fileSystem }) &&
        readerScript(sourceRoot, fileSystem),
      );
    },
    /** Paste `prompt` (tagged) into the app, then bring its reply back. */
    ask({ app, prompt, signal }) {
      const kit = APPS[app];
      if (!kit) return Promise.reject(failure(`Unknown app: ${app}.`));
      const tag = desktopTag();
      const text = tagPrompt(prompt, tag);
      return inTurn(async () => {
        if (signal?.aborted) throw stopped();
        if (text.length > kit.max)
          throw failure('The prompt is too long to paste into the app.');
        const launch = kit.launch(env, { platform, fileSystem });
        const opener = systemOpener(env, { platform, fileSystem });
        if (launch.kind === 'refused' || !opener)
          throw failure('This computer cannot open the app.');
        try {
          const child = spawnImpl(opener, [launch.target], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child?.on?.('error', () => {});
          child?.unref?.();
        } catch {
          throw failure('The app could not be opened.');
        }
        await sleep(kit.settle, signal);
        if (signal?.aborted) throw stopped();
        const pasted = await kit.paste(text, seams);
        if (pasted !== true)
          throw failure('The prompt could not be pasted into the app.');
        try {
          return {
            ...(await read({ app, tag, signal, ...seams })),
            tag,
          };
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          throw failure(error?.message || String(error), true);
        }
      });
    },
    /** The reply to a message already sent with `tag` (the webhook's). */
    read({ app, tag, signal, findMs = WEBHOOK_FIND_MS }) {
      return read({ app, tag, signal, findMs, ...seams });
    },
  };
}
