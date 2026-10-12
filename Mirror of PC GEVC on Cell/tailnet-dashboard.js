import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OWNER_DEVICE_AUTHORITY_HEADER,
  OWNER_DEVICE_HEADER,
  isTailnetIPv4,
  sendOwnerRemovalRefusal,
  setOwnerDeviceToken,
} from '../src/keySetupCore.mjs';
import { hasProxySignals } from '../src/localRequestGate.mjs';

// Moved to the core gate; re-exported so existing imports keep working.
export { isTailnetIPv4 };

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
 * this machine's keys through it. Every request from the owner's device is
 * stamped with this process's in-memory token and the listener's own
 * authority, so it gets what the PC gets, writes included (writes still need
 * an exact Origin and JSON). Removing anything stored on the PC stays on the
 * PC (owner ruling 2026-10-11: "full write access - except delete or
 * remove"): the mirror refuses an owner's DELETE and the plain removal
 * routes itself, and the gates behind it refuse the rest.
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

/** The read-only stamp the mirror used before; still stripped on entry. */
const LEGACY_OWNER_DEVICE_READ_HEADER = 'x-gev-owner-device-read';

/** Remove every owner-device stamp a caller may have sent. */
function stripOwnerStamp(headers) {
  if (!headers) return;
  delete headers[OWNER_DEVICE_HEADER];
  delete headers[OWNER_DEVICE_AUTHORITY_HEADER];
  delete headers[LEGACY_OWNER_DEVICE_READ_HEADER];
}

/**
 * POST routes whose only effect is removing something stored on the PC. The
 * mirror refuses them for the owner's device before they reach the server
 * (the routes refuse them too). Lower case, no trailing slash.
 */
export const OWNER_DEVICE_REMOVAL_ROUTES = Object.freeze([
  '/api/ultra-help/media/delete',
  '/api/private-cams/relay/unpair',
]);

/**
 * Whether the owner's device is asking to delete or remove something stored
 * on the PC: every DELETE, and a POST to a plain removal route. One DELETE is
 * not a removal: a road camera's live-stream lease release
 * (`/api/cctv/media/<id>?lease=...`) only frees the viewer's own in-memory
 * stream session, and refusing it would hold the PC's stream open.
 */
export function ownerRemovalRequest(method, url) {
  const verb = String(method || '').toUpperCase();
  if (verb !== 'DELETE' && verb !== 'POST') return false;
  const raw = String(url || '/');
  let parsed;
  try {
    // Joined, not resolved, so a path starting "//" stays a path.
    parsed = new URL(
      raw.startsWith('/') ? `http://localhost${raw}` : raw,
      'http://localhost',
    );
  } catch {
    return verb === 'DELETE';
  }
  const pathname = parsed.pathname
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  if (verb === 'DELETE')
    return !(
      /^\/api\/cctv\/media\/[^/]+$/.test(pathname) &&
      parsed.searchParams.has('lease')
    );
  return OWNER_DEVICE_REMOVAL_ROUTES.includes(pathname);
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
 * machine, from a single untagged device that does not relay other hosts'
 * traffic (see nodeIsShared). Answers are kept for a few minutes; when
 * Tailscale cannot say, the answer is no.
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
    // A tagged PC has no single human owner (every tagged node shares one
    // user ID), so nobody counts as its owner.
    const tagged = (status?.Self?.Tags?.length ?? 0) > 0;
    self = Number.isFinite(id) && !tagged ? { id, at: now() } : null;
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
      Number.isFinite(owner) &&
      Number.isFinite(caller) &&
      owner === caller &&
      !nodeIsShared(who?.Node);
    seen.set(ip, { ok, at: now() });
    if (seen.size > 256) seen.delete(seen.keys().next().value);
    return ok;
  };
}

/**
 * True when a whois node cannot stand for one owner device: it is tagged
 * (tagged nodes share one user ID), or it relays other hosts' traffic as a
 * subnet router or exit node (every device behind it would show up as the
 * owner). An unknown node is treated the same way.
 * @param {any} node
 */
export function nodeIsShared(node) {
  if (!node || typeof node !== 'object') return true;
  if ((node.Tags?.length ?? 0) > 0) return true;
  if (Array.isArray(node.PrimaryRoutes) && node.PrimaryRoutes.length) {
    return true;
  }
  const own = new Set((node.Addresses || []).map(String));
  return (node.AllowedIPs || []).some((prefix) => !own.has(String(prefix)));
}

/**
 * The tailnet listener's request handler: owners only. Any stamp a caller
 * sent is removed first; then every request from the owner's device, on any
 * method and path, is stamped with the token and the listener's authority,
 * unless it carries proxy headers (those are refused further in). A removal
 * from the owner's device is refused here with the PC-only message.
 * @param {{isOwnerDevice: (address: string) => any, token?: string, authority?: string, next: Function}} options
 */
export function ownerOnlyHandler({ isOwnerDevice, token, authority, next }) {
  return (req, res) => {
    stripOwnerStamp(req.headers);
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
        if (ownerRemovalRequest(req.method, req.url)) {
          // No message (owner ruling 2026-10-11): the phone leaves the item
          // as it is, since the PC still has it.
          sendOwnerRemovalRefusal(res);
          return;
        }
        if (token && authority && !hasProxySignals(req.headers || {})) {
          req.headers[OWNER_DEVICE_HEADER] = token;
          req.headers[OWNER_DEVICE_AUTHORITY_HEADER] = authority;
        }
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
      setOwnerDeviceToken(token);
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
            authority: `http://${address}:${port}`,
            next: (req, res) => server.middlewares(req, res),
          }),
        );
        // Live reload: the page's websocket goes to the same handler as on
        // the PC, for the owner's devices only.
        mirror.on('upgrade', (req, socket, head) => {
          stripOwnerStamp(req.headers);
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
        setOwnerDeviceToken('');
        mirror?.close();
      });
    },
  };
}
