import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequestBody } from './common/request.js';
import {
  admitKeySetupRequest,
  sendOwnerRemovalRefusal,
} from '../../src/keySetupCore.mjs';

/** The Grok Bot desktop app's own link to its main window. */
export const GROK_BOT_APP_LINK = 'grokbot://app/v1/open';
/** One open at a time: a held key or a looping page cannot stack windows. */
export const GROK_BOT_OPEN_INTERVAL_MS = 3000;
/** Longest swarm / skill-check task this route will paste (characters). */
export const GROK_BOT_PASTE_MAX = 16 * 1024;
/** JSON body cap: the task plus `{paste,text}` wrapping. */
export const GROK_BOT_OPEN_BODY_BYTES = 68 * 1024;
/** Wait for the paste script (window hunt + composer + Ctrl+V). */
export const GROK_BOT_PASTE_TIMEOUT_MS = 20_000;
/**
 * Pause after spawning the opener so Grok Bot is in front and the composer
 * exists. 600 ms was too short: Ctrl+V landed before the input was ready.
 * The paste script then keeps Grok Bot HWND_TOPMOST until Ctrl+V so Chrome
 * in front does not eat the click.
 */
export const GROK_BOT_PASTE_SETTLE_MS = 2500;
/** Repo-relative paste script; the task rides on stdin, never argv. */
export const GROK_BOT_PASTE_SCRIPT = 'scripts/paste-grok-bot.ps1';

const DEFAULT_SOURCE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function send(res, status, payload) {
  res.writeHead(status, HEADERS);
  res.end(JSON.stringify(payload));
}

function windowsRoot(env) {
  const root = String(env?.SystemRoot || env?.SYSTEMROOT || '');
  if (!/^[A-Za-z]:\\Windows\\?$/i.test(root)) return '';
  return root.replace(/\\$/, '');
}

/**
 * Whether GROK_BOT_LINK names something this machine may open: on Windows a
 * .lnk or .exe on a local drive (never a share or a device path), elsewhere
 * an absolute path; and it must exist.
 */
function grokBotLinkUsable(value, { platform, fileSystem }) {
  if (value.length > 1024 || /[\u0000-\u001f\u007f"]/.test(value)) return false;
  if (platform === 'win32') {
    if (!/^[A-Za-z]:\\/.test(value) || !/\.(lnk|exe)$/i.test(value)) {
      return false;
    }
  } else if (!path.posix.isAbsolute(value)) {
    return false;
  }
  try {
    const stat = fileSystem.statSync(value);
    // A macOS app is a folder (Grok Bot.app); everything else is a file.
    return stat.isFile() || (platform === 'darwin' && stat.isDirectory());
  } catch {
    return false;
  }
}

/**
 * What OPEN GROK BOT opens: the shortcut in GROK_BOT_LINK (the owner's own
 * .lnk to Grok Bot.exe), else the app's grokbot:// link. A GROK_BOT_LINK
 * that cannot be used is refused, never replaced.
 *
 * @returns {{target: string, kind: 'shortcut' | 'app-link' | 'refused'}}
 */
export function grokBotLaunchTarget(
  env = process.env,
  { platform = process.platform, fileSystem = fs } = {},
) {
  const configured = String(env?.GROK_BOT_LINK ?? '').trim();
  if (!configured) return { target: GROK_BOT_APP_LINK, kind: 'app-link' };
  return grokBotLinkUsable(configured, { platform, fileSystem })
    ? { target: configured, kind: 'shortcut' }
    : { target: '', kind: 'refused' };
}

/**
 * The system's own opener, by its full path and never through PATH:
 * Explorer under SystemRoot on Windows, open on macOS, xdg-open elsewhere.
 */
export function systemOpener(
  env = process.env,
  { platform = process.platform, fileSystem = fs } = {},
) {
  let opener;
  if (platform === 'win32') {
    const root = windowsRoot(env);
    if (!root) return '';
    opener = path.win32.join(root, 'explorer.exe');
  } else {
    opener = platform === 'darwin' ? '/usr/bin/open' : '/usr/bin/xdg-open';
  }
  try {
    return fileSystem.statSync(opener).isFile() ? opener : '';
  } catch {
    return '';
  }
}

/**
 * Windows PowerShell 5.1 by its full path under SystemRoot, never PATH.
 * Empty on any other OS, or when SystemRoot is not this machine's Windows.
 */
export function systemPowershell(
  env = process.env,
  { platform = process.platform, fileSystem = fs } = {},
) {
  if (platform !== 'win32') return '';
  const root = windowsRoot(env);
  if (!root) return '';
  const powershell = path.win32.join(
    root,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    return fileSystem.statSync(powershell).isFile() ? powershell : '';
  } catch {
    return '';
  }
}

/**
 * The task to paste: only when `paste` is exactly true and `text` is a
 * non-empty string within GROK_BOT_PASTE_MAX. A named window, target, or
 * agent in the body is ignored. Missing or oversized text is not pasted
 * (never the current clipboard, never a truncated task).
 */
export function grokBotPasteText(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  if (body.paste !== true) return '';
  if (typeof body.text !== 'string') return '';
  if (!body.text || body.text.length > GROK_BOT_PASTE_MAX) return '';
  return body.text;
}

function parseOpenBody(raw) {
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return {};
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body;
}

function pasteScriptFile(sourceRoot, fileSystem) {
  // Windows only, like the PowerShell path: join with backslashes wherever this runs.
  const script = path.win32.join(
    sourceRoot,
    ...GROK_BOT_PASTE_SCRIPT.split('/'),
  );
  try {
    return fileSystem.statSync(script).isFile() ? script : '';
  } catch {
    return '';
  }
}

/**
 * Spawn scripts/paste-grok-bot.ps1 with the task on stdin. Windows only.
 * The script sets the clipboard from that stdin, keeps Grok Bot.exe
 * topmost until a pixel on that window is hit, clicks the composer
 * (SetCursorPos, same DPI space as the window), Ctrl+V, Enter.
 *
 * @returns {Promise<boolean>}
 */
export function pasteIntoGrokBot(
  text,
  {
    spawnImpl = spawn,
    platform = process.platform,
    fileSystem = fs,
    env = process.env,
    sourceRoot = DEFAULT_SOURCE_ROOT,
    timeoutMs = GROK_BOT_PASTE_TIMEOUT_MS,
  } = {},
) {
  const value = String(text ?? '');
  if (!value || value.length > GROK_BOT_PASTE_MAX) {
    return Promise.resolve(false);
  }
  const powershell = systemPowershell(env, { platform, fileSystem });
  const script = pasteScriptFile(sourceRoot, fileSystem);
  if (!powershell || !script) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let child;
    try {
      // CREATE_NO_WINDOW (windowsHide) cannot inject Ctrl+V into Grok Bot.
      // -WindowStyle Hidden keeps the console off screen; -STA is for clipboard.
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
          stdio: ['pipe', 'ignore', 'pipe'],
          windowsHide: false,
          windowsVerbatimArguments: true,
        },
      );
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child?.kill?.();
      } catch {
        /* already gone */
      }
      done(false);
    }, timeoutMs);
    child.stderr?.resume?.();
    child?.on?.('error', () => {
      clearTimeout(timer);
      done(false);
    });
    child?.on?.('exit', (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
    try {
      child.stdin.write(value, 'utf8');
      child.stdin.end();
    } catch {
      clearTimeout(timer);
      try {
        child?.kill?.();
      } catch {
        /* already gone */
      }
      done(false);
    }
  });
}

/**
 * Vite plugin: POST /api/social/grok-bot/open opens the Grok Bot desktop app
 * on this computer for OPEN GROK BOT, and for GROK BOT SWARM when it has no
 * API key and no computer. A swarm / skill-check body `{ paste: true, text }`
 * also pastes that task into the focused Grok Bot composer and sends it
 * (Windows: scripts/paste-grok-bot.ps1). OPEN GROK BOT still posts `{}` and
 * only opens. Only this machine's own page may ask (POWER UP's gate: a
 * loopback socket, a local Host, an exact Origin, JSON), and what is opened
 * comes from the environment, never the request. A named target, window, or
 * agent in the body is ignored.
 */
export function grokBotDesktopProxy({
  spawnImpl = spawn,
  pasteImpl,
  platform = process.platform,
  fileSystem = fs,
  now = () => Date.now(),
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sourceRoot = DEFAULT_SOURCE_ROOT,
  env = process.env,
} = {}) {
  let lastOpen = -Infinity;
  const pasteTask = (text) => {
    if (typeof pasteImpl === 'function') return pasteImpl(text);
    return pasteIntoGrokBot(text, {
      spawnImpl,
      platform,
      fileSystem,
      env,
      sourceRoot,
    });
  };
  const handle = (req, res) => {
    void run(req, res);
  };
  async function run(req, res) {
    const pathName = String(req.url || '/').split('?')[0];
    if (pathName !== '/open') {
      send(res, 404, { error: 'Not found' });
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'Method not allowed' });
      return;
    }
    const admission = admitKeySetupRequest({
      method: req.method,
      remoteAddress: req.socket?.remoteAddress,
      hostHeader: req.headers?.host,
      protocol: req.socket?.encrypted ? 'https:' : 'http:',
      origin: req.headers?.origin,
      contentType: req.headers?.['content-type'],
      proxyHeaders: req.headers || {},
      env: process.env,
    });
    if (!admission.ok && admission.removal === true) {
      sendOwnerRemovalRefusal(res, HEADERS);
      return;
    }
    if (!admission.ok) {
      req.resume?.();
      send(res, admission.status || 403, {
        error: String(admission.error || 'Refused').replace(
          'Provider Settings',
          'Grok Bot',
        ),
      });
      return;
    }
    let raw;
    try {
      raw = await readRequestBody(req, GROK_BOT_OPEN_BODY_BYTES);
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        send(res, 413, { error: 'Request too large' });
        return;
      }
      send(res, 400, { error: 'Malformed request body' });
      return;
    }
    const pasteText = grokBotPasteText(parseOpenBody(raw));
    const at = now();
    if (at - lastOpen < GROK_BOT_OPEN_INTERVAL_MS) {
      send(res, 429, { error: 'Grok Bot is opening.' });
      return;
    }
    const launch = grokBotLaunchTarget(process.env, { platform, fileSystem });
    if (launch.kind === 'refused') {
      send(res, 409, {
        error:
          'GROK_BOT_LINK in .env is not a Grok Bot shortcut on this computer. Fix it, then restart the dev server.',
      });
      return;
    }
    const opener = systemOpener(process.env, { platform, fileSystem });
    if (!opener) {
      send(res, 503, { error: 'This computer has no way to open Grok Bot.' });
      return;
    }
    lastOpen = at;
    try {
      const child = spawnImpl(opener, [launch.target], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child?.on?.('error', () => {});
      child?.unref?.();
    } catch {
      send(res, 503, { error: 'Grok Bot could not be opened.' });
      return;
    }
    const payload = { ok: true, opened: launch.kind };
    if (pasteText) {
      try {
        await sleepImpl(GROK_BOT_PASTE_SETTLE_MS);
        payload.pasted = (await pasteTask(pasteText)) === true;
      } catch {
        payload.pasted = false;
      }
    }
    send(res, 200, payload);
  }
  return {
    name: 'grok-bot-desktop',
    configureServer(server) {
      server.middlewares.use('/api/social/grok-bot', handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/social/grok-bot', handle);
    },
  };
}
