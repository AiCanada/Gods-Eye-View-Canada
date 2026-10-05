import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OWNER_DEVICE_READ_HEADER,
  setOwnerDeviceReadToken,
} from '../src/keySetupCore.mjs';

/**
 * Mirror of PC GEVC on Cell: the PC's dashboard on the owner's own phone or
 * tablet, over Tailscale.
 *
 * GEV_TAILNET_DASHBOARD=1 opens a second listener on this machine's tailnet
 * IPv4 address only (100.64.0.0/10), never on a LAN or public address, on the
 * dev server's port. It serves the very same middleware, so the page, its
 * assets and every route are the dashboard the PC sees, and live reload rides
 * along. Each request keeps the caller's own address.
 *
 * Only the owner's own devices get in: Tailscale is asked who each caller is
 * (`tailscale whois`), and a device signed in as anyone else (another GEVC
 * user's shared machine, say) is refused everything, so nobody else can use
 * this machine's keys through it. The owner's device may READ the PC-only
 * status routes (POWER UP, Social Media, Ultra, private cameras); every change
 * still has to be made on the PC.
 *
 * Plain http: the tailnet already encrypts the link. A phone browser treats
 * the page as insecure, so voice, location and camera need the address listed
 * under chrome://flags "Insecure origins treated as secure" (see README.md).
 */
export const TAILNET_DASHBOARD_ENV = 'GEV_TAILNET_DASHBOARD';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The PC layout script, served at /viewport-mode.js (dev) and emitted with the build. */
export const VIEWPORT_SCRIPT_PATH = '/viewport-mode.js';
const VIEWPORT_SCRIPT_FILE = path.join(HERE, 'viewport-mode.js');

/**
 * The PC-only reads the owner's phone may make (GET only). An entry ending
 * in "/" covers what lies under it (one camera's or one device's picture,
 * one device's saved route).
 */
export const OWNER_DEVICE_READ_ROUTES = Object.freeze([
  '/api/setup/status',
  '/api/road-cctv-keys',
  '/api/social/accounts',
  '/api/ultra-help/status',
  '/api/ultra-help/picture',
  '/api/ultra-help/picture/',
  '/api/private-cams/status',
  '/api/private-cams/sources',
  '/api/private-cams/frame/',
  '/api/device-feeds/status',
  '/api/device-feeds/positions',
  '/api/device-feeds/track/',
]);

/** True for an address in Tailscale's 100.64.0.0/10 range. */
export function isTailnetIPv4(address) {
  const parts = String(address || '')
    .split('.')
    .map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/** This machine's tailnet IPv4 address, or '' when Tailscale is not up. */
export function tailnetAddress(interfaces = os.networkInterfaces()) {
  for (const list of Object.values(interfaces || {})) {
    for (const item of list || []) {
      const family = item?.family === 4 ? 'IPv4' : item?.family;
      if (family === 'IPv4' && !item.internal && isTailnetIPv4(item.address))
        return item.address;
    }
  }
  return '';
}

/** Whether the setting asks for the tailnet listener. */
export function tailnetDashboardEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(
    String(env?.[TAILNET_DASHBOARD_ENV] ?? '').trim(),
  );
}

/** Whether a GET for this address is one of the owner's status reads. */
export function ownerReadRoute(method, url) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  let pathname = '';
  try {
    pathname = new URL(String(url || '/'), 'http://localhost').pathname;
  } catch {
    return false;
  }
  if (pathname.includes('..')) return false;
  const exact = pathname.replace(/\/+$/, '');
  return OWNER_DEVICE_READ_ROUTES.some((route) =>
    route.endsWith('/')
      ? pathname.startsWith(route) && pathname.length > route.length
      : exact === route,
  );
}

const TAILSCALE_CLI =
  process.platform === 'win32'
    ? 'C:\\Program Files\\Tailscale\\tailscale.exe'
    : 'tailscale';

function runTailscale(args) {
  return new Promise((resolve) => {
    execFile(
      process.env.TAILSCALE_CLI || TAILSCALE_CLI,
      args,
      { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          resolve(JSON.parse(String(stdout)));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Who may come in: a caller signed in to Tailscale as the same user as this
 * machine. Answers are kept for a few minutes; when Tailscale cannot say, the
 * answer is no.
 * @param {{ask?: (args: string[]) => Promise<any>, ttlMs?: number, now?: () => number}} [options]
 */
export function createOwnerCheck({
  ask = runTailscale,
  ttlMs = 5 * 60_000,
  now = Date.now,
} = {}) {
  let self = null;
  const seen = new Map(); // ip -> {ok, at}
  async function selfUser() {
    if (self && now() - self.at < ttlMs) return self.id;
    const status = await ask(['status', '--json']);
    const id = status?.Self?.UserID;
    self = Number.isFinite(id) ? { id, at: now() } : null;
    return self?.id ?? null;
  }
  return async function isOwnerDevice(address) {
    const ip = String(address || '').replace(/^::ffff:/, '');
    if (!isTailnetIPv4(ip)) return false;
    const held = seen.get(ip);
    if (held && now() - held.at < ttlMs) return held.ok;
    const [owner, who] = await Promise.all([
      selfUser(),
      ask(['whois', '--json', ip]),
    ]);
    const caller = who?.UserProfile?.ID;
    const ok =
      Number.isFinite(owner) && Number.isFinite(caller) && owner === caller;
    seen.set(ip, { ok, at: now() });
    if (seen.size > 256) seen.delete(seen.keys().next().value);
    return ok;
  };
}

/**
 * The tailnet listener's request handler: owners only; a status GET is
 * stamped with the read token; any stamp a caller sent is removed first.
 */
export function ownerOnlyHandler({ isOwnerDevice, token, next }) {
  return (req, res) => {
    delete req.headers[OWNER_DEVICE_READ_HEADER];
    Promise.resolve(isOwnerDevice(req.socket?.remoteAddress))
      .catch(() => false)
      .then((ok) => {
        if (!ok) {
          res.writeHead(403, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(
            'This dashboard opens only on devices signed in to the owner\u2019s Tailscale account.',
          );
          return;
        }
        if (token && ownerReadRoute(req.method, req.url))
          req.headers[OWNER_DEVICE_READ_HEADER] = token;
        next(req, res);
      });
  };
}

/**
 * @param {{env?: object, interfaces?: Function, createServer?: Function, retryMs?: number, ownerCheck?: Function}} [options]
 */
export function tailnetDashboardPlugin({
  env = process.env,
  interfaces = () => os.networkInterfaces(),
  createServer = http.createServer,
  retryMs = 30_000,
  ownerCheck = null,
} = {}) {
  return {
    name: 'gev-tailnet-dashboard',
    // The PC layout script ships with the build too (index.html loads it).
    generateBundle() {
      try {
        this.emitFile({
          type: 'asset',
          fileName: VIEWPORT_SCRIPT_PATH.slice(1),
          source: fs.readFileSync(VIEWPORT_SCRIPT_FILE, 'utf8'),
        });
      } catch {
        /* a build without the folder: the page still works on a PC */
      }
    },
    configureServer(server) {
      server.middlewares.use(VIEWPORT_SCRIPT_PATH, (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let body = '';
        try {
          body = fs.readFileSync(VIEWPORT_SCRIPT_FILE, 'utf8');
        } catch {
          return next();
        }
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(req.method === 'HEAD' ? '' : body);
      });
      if (!tailnetDashboardEnabled(env)) return;
      const main = server.httpServer;
      if (!main) return;
      const token = crypto.randomBytes(32).toString('hex');
      setOwnerDeviceReadToken(token);
      const isOwnerDevice = ownerCheck || createOwnerCheck();
      let mirror = null;
      let retry = null;
      let warned = false;
      const open = () => {
        retry = null;
        const address = tailnetAddress(interfaces());
        const port = main.address()?.port;
        if (!port) return;
        if (!address) {
          // Tailscale is off or not connected yet: look again shortly, so
          // turning it on is enough (no restart of npm run dev).
          if (!warned) {
            warned = true;
            console.warn(
              `[Tailnet dashboard] ${TAILNET_DASHBOARD_ENV} is on, but this machine has no Tailscale address yet: it starts when Tailscale connects.`,
            );
          }
          retry = setTimeout(open, retryMs);
          retry.unref?.();
          return;
        }
        mirror = createServer(
          ownerOnlyHandler({
            isOwnerDevice,
            token,
            next: (req, res) => server.middlewares(req, res),
          }),
        );
        // Live reload: the page's websocket goes to the same handler as on
        // the PC, for the owner's devices only.
        mirror.on('upgrade', (req, socket, head) => {
          Promise.resolve(isOwnerDevice(req.socket?.remoteAddress))
            .catch(() => false)
            .then((ok) => {
              if (ok) main.emit('upgrade', req, socket, head);
              else socket.destroy();
            });
        });
        mirror.on('error', (error) => {
          console.warn(
            `[Tailnet dashboard] not listening on the tailnet: ${error?.message || error}`,
          );
        });
        mirror.listen(port, address, () => {
          console.log(
            `[Tailnet dashboard] Open http://${address}:${port}/ on your phone (Tailscale on, signed in as you).`,
          );
        });
      };
      main.once('listening', open);
      main.once('close', () => {
        if (retry) clearTimeout(retry);
        setOwnerDeviceReadToken('');
        mirror?.close();
      });
    },
  };
}
