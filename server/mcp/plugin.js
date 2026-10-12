/**
 * Serves the local MCP server at /mcp on the development and preview servers.
 *
 * This is local transport safety, not authentication: requests must come from
 * this machine, carry no proxy forwarding headers, arrive while sharing is
 * off, name a loopback host on the port they arrived at (blocking DNS
 * rebinding) and, when a browser sends an Origin, come from that same host.
 *
 * The owner's own device through the tailnet mirror (Mirror of PC GEVC on
 * Cell) is admitted too: a request the mirror stamped after Tailscale
 * confirmed the device is signed in as this machine's owner, whose Host names
 * the mirror and whose POST carries that exact Origin. Its tools reach this
 * machine's API over loopback, never back through the mirror, and the stamp is
 * never handed to them. Removing anything stored here stays on the PC (owner
 * ruling 2026-10-11): an owner device's tool calls are never sent as DELETE,
 * PUT or PATCH, nor as a POST to a route family that can remove stored data.
 */

import {
  OWNER_DEVICE_AUTHORITY_HEADER,
  OWNER_DEVICE_HEADER,
  OWNER_DEVICE_READ_HEADER,
  OWNER_DEVICE_REMOVAL_BODY,
  OWNER_DEVICE_REMOVAL_HEADER,
  isSharingEnabled,
  isTailnetIPv4,
  ownerDeviceAuthority,
} from '../../src/keySetupCore.mjs';
import { hasProxySignals } from '../../src/localRequestGate.mjs';
import { createMcpHttpHandler } from '../../src/tools/mcp/index.js';
import { createLocalMcpServer } from './server.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY_BYTES = 1024 * 1024;
/** Headers the mirror sets; never passed on to the MCP server or its tools. */
const OWNER_DEVICE_HEADERS = new Set([
  OWNER_DEVICE_HEADER,
  OWNER_DEVICE_AUTHORITY_HEADER,
  OWNER_DEVICE_READ_HEADER,
]);
/**
 * Route families an owner device's tools may only read. Each can remove
 * something stored on this machine through a POST: Provider Settings keys,
 * road CCTV keys, social logins, Ultra media, tokens, contacts, numbers,
 * inbox and home-list entries, private cameras and their relay pairing, and
 * device feeds and their recordings. Matched without regard to case and also
 * decoded, as the server routes them. (A tool on the PC cannot write them
 * either: their gate needs an exact Origin, which a tool never sends.)
 */
const OWNER_READ_ONLY_PATHS = [
  /^\/api\/(?:setup|road-cctv-keys|social|ultra-help|private-cams|device-feeds|realtime|openai)(?:[/.]|$)/i,
  /^\/mcp(?:[/.]|$)/i,
  // Any other route whose own name says it removes something.
  /(?:^|[/_.-])(?:delete|remove|unpair|revoke|clear|forget|purge|reset|wipe|erase|unlink|prune)(?:[/_.-]|$)/i,
];
/** The only methods an owner device's tools send (panel_request's own set). */
const OWNER_WRITE_METHODS_ALLOWED = new Set(['GET', 'HEAD', 'POST']);
/** How long a client may take to send its request body. */
const BODY_TIMEOUT_MS = 30 * 1000;

/**
 * Whether a request may reach the local MCP server. `localPort` is the port
 * the connection arrived at; `headers` are the request's, keyed by lower-case
 * name; `env` is checked for launcher sharing. `ownerAuthority` is the
 * mirror's origin when the core recognised the owner device's stamp
 * (ownerDeviceAuthority), else absent; `method` is the request's.
 */
export function isLocalMcpRequest({
  remoteAddress,
  localPort,
  host,
  origin,
  method = 'POST',
  ownerAuthority = null,
  headers = {},
  env = {},
}) {
  const owner = typeof ownerAuthority === 'string' && ownerAuthority !== '';
  if (
    owner
      ? !isTailnetIPv4(String(remoteAddress || '').replace(/^::ffff:/i, ''))
      : !LOOPBACK_ADDRESSES.has(remoteAddress)
  )
    return false;
  // A proxy or tunnel in front of the server can make a remote request look
  // local, and sharing exposes the server beyond this machine.
  if (hasProxySignals(headers) || isSharingEnabled(env)) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (owner) {
    // The owner device names the mirror, exactly.
    if (hostUrl.origin !== ownerAuthority) return false;
    if (hostUrl.username || hostUrl.password) return false;
  } else if (!LOOPBACK_HOSTS.has(hostUrl.hostname)) return false;
  // The Host names the port the request reached, so tools are never pointed
  // at another local service.
  if (localPort != null && (hostUrl.port || '80') !== String(localPort))
    return false;
  // The owner device's page must name itself on every write.
  if (origin == null)
    return !(owner && !['GET', 'HEAD'].includes(String(method).toUpperCase()));
  try {
    const originUrl = new URL(origin);
    return (
      ['http:', 'https:'].includes(originUrl.protocol) &&
      originUrl.host === hostUrl.host
    );
  } catch {
    return false;
  }
}

/**
 * Whether an owner device's tool may send this request to this machine's API:
 * reads anywhere, and a POST only outside the route families that can remove
 * stored data (OWNER_READ_ONLY_PATHS). DELETE, PUT and PATCH never.
 */
export function ownerToolRequestAllowed(input, init = {}) {
  const method = String(
    init?.method || (input instanceof Request ? input.method : 'GET'),
  ).toUpperCase();
  if (!OWNER_WRITE_METHODS_ALLOWED.has(method)) return false;
  if (method !== 'POST') return true;
  let url;
  try {
    url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://127.0.0.1',
    );
  } catch {
    return false;
  }
  const paths = [url.pathname];
  try {
    paths.push(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
  return !OWNER_READ_ONLY_PATHS.some((pattern) =>
    paths.some((path) => pattern.test(path)),
  );
}

/**
 * A fetch for an owner device's tools that refuses removal-capable writes,
 * with no message: 403, X-GEV-Removal: pc-only and {removal: 'pc-only'}.
 */
export function ownerToolFetch(
  fetchImpl = (...args) => globalThis.fetch(...args),
) {
  return (input, init) =>
    ownerToolRequestAllowed(input, init)
      ? fetchImpl(input, init)
      : Promise.resolve(
          new Response(JSON.stringify(OWNER_DEVICE_REMOVAL_BODY), {
            status: 403,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              [OWNER_DEVICE_REMOVAL_HEADER]: OWNER_DEVICE_REMOVAL_BODY.removal,
            },
          }),
        );
}

/** Vite plugin that mounts the local MCP server at /mcp. */
export function localMcpPlugin({
  createServer = createLocalMcpServer,
  bodyTimeoutMs = BODY_TIMEOUT_MS,
  fetchImpl,
} = {}) {
  const handlers = new Map();
  const handlerFor = (apiBase, { ownerDevice = false } = {}) => {
    const key = `${ownerDevice ? 'owner' : 'local'} ${apiBase}`;
    if (!handlers.has(key))
      handlers.set(
        key,
        createMcpHttpHandler(
          createServer(
            ownerDevice
              ? { apiBase, fetchImpl: ownerToolFetch(fetchImpl), ownerDevice }
              : fetchImpl
                ? { apiBase, fetchImpl }
                : { apiBase },
          ),
        ),
      );
    return handlers.get(key);
  };
  const install = (server) => {
    server.middlewares.use('/mcp', async (req, res) => {
      const host = req.headers.host || '';
      const ownerAuthority = hasProxySignals(req.headers)
        ? null
        : ownerDeviceAuthority({
            remoteAddress: req.socket?.remoteAddress,
            hostHeader: host,
            protocol: req.socket?.encrypted ? 'https:' : 'http:',
            headers: req.headers,
          });
      if (
        !isLocalMcpRequest({
          remoteAddress: req.socket?.remoteAddress,
          localPort: req.socket?.localPort,
          host,
          origin: req.headers.origin,
          method: req.method,
          ownerAuthority,
          headers: req.headers,
          env: process.env,
        })
      ) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'The MCP server only accepts local requests',
          }),
        );
        return;
      }
      // A client that disconnects before its answer cancels the tool call.
      const disconnect = new AbortController();
      const onClose = () => {
        if (!res.writableFinished) disconnect.abort();
      };
      res.on('close', onClose);
      try {
        const body =
          req.method === 'POST'
            ? await readBody(req, bodyTimeoutMs)
            : undefined;
        // In process only, and without the mirror's stamp.
        const request = new Request(`http://${host}/mcp`, {
          method: req.method,
          headers: Object.entries(req.headers).flatMap(([name, value]) =>
            value === undefined || OWNER_DEVICE_HEADERS.has(name.toLowerCase())
              ? []
              : [[name, String(value)]],
          ),
          body,
          signal: disconnect.signal,
        });
        // The owner device's tools call this machine's API over loopback, on
        // the port the request reached (the mirror listens on the dev
        // server's port), never back through the mirror. `localhost`, as the
        // dev server binds it, rather than one address family.
        const response = await (
          ownerAuthority
            ? handlerFor(`http://localhost:${req.socket.localPort}`, {
                ownerDevice: true,
              })
            : handlerFor(`http://${host}`)
        )(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        if (disconnect.signal.aborted) return;
        if (res.headersSent) return res.destroy();
        res.writeHead([408, 413].includes(error?.status) ? error.status : 400, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error:
              error?.status === 413
                ? 'Request too large'
                : error?.status === 408
                  ? 'Request timed out'
                  : 'Bad request',
          }),
        );
      } finally {
        res.off('close', onClose);
      }
    });
  };
  return {
    name: 'local-mcp',
    configureServer: install,
    configurePreviewServer: install,
  };
}

function readBody(req, timeoutMs = BODY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    // A client that stops sending must not hold the request open.
    const timer = setTimeout(
      () =>
        reject(Object.assign(new Error('Request timed out'), { status: 408 })),
      timeoutMs,
    );
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      // Keep draining without storing, so the 413 response can still be sent.
      if (tooLarge || size <= MAX_BODY_BYTES) {
        if (!tooLarge) chunks.push(chunk);
        return;
      }
      tooLarge = true;
      chunks.length = 0;
      fail(Object.assign(new Error('Request too large'), { status: 413 }));
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}
