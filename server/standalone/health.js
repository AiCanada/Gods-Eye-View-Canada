/**
 * `/__gev/health`: one JSON answer that says whether the dev server is alive
 * and what it is holding.
 *
 * The supervisor (`scripts/dev-server.mjs`) probes it to tell a blocked event
 * loop from a quiet one, and a person comparing it morning against evening
 * can see a leak before it stops the server. Everything in the answer is
 * process bookkeeping: pid, uptime, memory, live handles by type, how many
 * times Vite has restarted in this process, the listener and the AIS store
 * sizes. No environment value, key or address ever goes in.
 *
 * The route guard has `enforce: 'pre'`, so the handler is wrapped wherever
 * this plugin sits; `apiNotFoundPlugin` only matches `/api`.
 */

const HEALTH_PATH = '/__gev/health';

/** Count `process.getActiveResourcesInfo()` entries by type, e.g. {TCPSocketWrap: 3}. */
function countByType(resources) {
  const counts = {};
  if (!Array.isArray(resources)) return counts;
  for (const type of resources) {
    const key = String(type);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * The health answer for one request. Pure: every input is handed in.
 * @param {object} input
 * @param {number} input.pid
 * @param {number} input.uptimeMs
 * @param {object} [input.memory] `process.memoryUsage()`
 * @param {string[]} [input.resources] `process.getActiveResourcesInfo()`
 * @param {number|null} [input.restarts] in-process Vite restarts (starts minus the first), or null when unknown
 * @param {boolean} [input.listening]
 * @param {number|null} [input.port]
 * @param {object} [input.extra] further sections (e.g. the AIS store sizes)
 */
export function healthSnapshot({
  pid,
  uptimeMs,
  memory,
  resources,
  restarts = null,
  listening = false,
  port = null,
  extra,
} = {}) {
  const resourcesByType = countByType(resources);
  return {
    ok: true,
    pid,
    uptimeMs: Math.max(0, Math.round(Number(uptimeMs) || 0)),
    memory: memory ?? null,
    resources: {
      total: Array.isArray(resources) ? resources.length : 0,
      byType: resourcesByType,
    },
    restarts: Number.isInteger(restarts) ? restarts : null,
    listening: listening === true,
    port: Number.isInteger(port) ? port : null,
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}

/** The port the server is bound to, from the http server's address() object. */
function listenerPort(httpServer) {
  try {
    const address = httpServer?.address?.();
    return address && typeof address === 'object' ? address.port : null;
  } catch {
    return null;
  }
}

/**
 * Live store statistics that exist only when their module exports them.
 * The AIS store may or may not expose `aisStreamStoreStats`; its absence,
 * or a failing import, is never a reason for the health answer to fail.
 */
async function storeSections() {
  try {
    const mod = await import('../providers/vessels/ais-store.js');
    if (typeof mod.aisStreamStoreStats === 'function')
      return { ais: mod.aisStreamStoreStats() };
  } catch {
    /* the store is optional here */
  }
  return {};
}

/**
 * Serve `/__gev/health` on the dev server (never in a build).
 * @param {{ now?: () => number }} [options] clock, injectable for tests
 */
export function healthPlugin({ now = Date.now } = {}) {
  return {
    name: 'gev-health',
    apply: 'serve',
    configureServer(server) {
      const startedAt = now();
      server.middlewares.use(HEALTH_PATH, async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        // The single-instance plugin counts starts, the first one included;
        // read, never imported.
        const starts = globalThis.__GEV_DEV_SINGLE_INSTANCE?.starts;
        const snapshot = healthSnapshot({
          pid: process.pid,
          uptimeMs: process.uptime() * 1000,
          memory: process.memoryUsage(),
          resources: process.getActiveResourcesInfo(),
          restarts: Number.isInteger(starts) ? Math.max(0, starts - 1) : null,
          listening: server.httpServer?.listening === true,
          port: listenerPort(server.httpServer),
          extra: {
            // When this Vite server instance (not the process) came up.
            serverStartedAt: startedAt,
            serverAgeMs: Math.max(0, now() - startedAt),
            ...(await storeSections()),
          },
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(snapshot));
      });
    },
  };
}
