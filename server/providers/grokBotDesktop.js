import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';

/** The Grok Bot desktop app's own link to its main window. */
export const GROK_BOT_APP_LINK = 'grokbot://app/v1/open';
/** One open at a time: a held key or a looping page cannot stack windows. */
export const GROK_BOT_OPEN_INTERVAL_MS = 3000;

const HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function send(res, status, payload) {
  res.writeHead(status, HEADERS);
  res.end(JSON.stringify(payload));
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
 * What GROK BOT SWARM opens when it has no key: the shortcut in GROK_BOT_LINK
 * (the owner's own .lnk to Grok Bot.exe), else the app's grokbot:// link. A
 * GROK_BOT_LINK that cannot be used is refused, never replaced.
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
    const root = String(env?.SystemRoot || env?.SYSTEMROOT || '');
    if (!/^[A-Za-z]:\\Windows\\?$/i.test(root)) return '';
    opener = path.win32.join(root.replace(/\\$/, ''), 'explorer.exe');
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
 * Vite plugin: POST /api/social/grok-bot/open opens the Grok Bot desktop app
 * on this computer, for GROK BOT SWARM's hand-off to the Chief of Staff bot
 * and for OPEN GROK BOT. Only this machine's own page may ask (POWER UP's
 * gate: a loopback socket, a local Host, an exact Origin, JSON), and what is
 * opened comes from the environment, never the request.
 */
export function grokBotDesktopProxy({
  spawnImpl = spawn,
  platform = process.platform,
  fileSystem = fs,
  now = () => Date.now(),
} = {}) {
  let lastOpen = -Infinity;
  const handle = (req, res) => {
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
    if (!admission.ok) {
      send(res, admission.status || 403, {
        error: String(admission.error || 'Refused').replace(
          'Provider Settings',
          'Grok Bot',
        ),
      });
      return;
    }
    // Nothing in the body is used; it is not read.
    req.resume?.();
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
    send(res, 200, { ok: true, opened: launch.kind });
  };
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
