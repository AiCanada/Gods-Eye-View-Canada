/**
 * /api/abundance: the GLOBAL ABUNDANCE MAP tab (owner request 2026-10-22;
 * server/shared/abundanceData.mjs holds the figures). Admitted as the AI
 * World tab's routes are: this machine's loopback and Host, an exact Origin
 * on writes, JSON bodies, same-origin fetches. The owner's phone (the
 * tailnet mirror) may read, refresh and load a CSV but not clear one (a
 * DELETE), which it is refused with no message, as every removal is (owner
 * ruling 2026-10-11).
 *
 *   GET    /status          the sources, when each was fetched, each level's coverage
 *   GET    /data?level=     country | region | city: the units with their figures
 *   POST   /refresh         { force? }   fetch the sources again (stale ones, or all)
 *   POST   /import          { level, csv }   the owner's own figures for a level
 *   DELETE /import          { level }        take that CSV away
 */
import { defaultSourceRoot } from './common/source-root.js';
import { readRequestBody } from './common/request.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { privateFetchSiteAllowed } from './private-cameras.js';
import {
  admitKeySetupRequest,
  sendOwnerRemovalRefusal,
} from '../../src/keySetupCore.mjs';
import { createAbundanceStore } from '../shared/abundanceData.mjs';

export const ABUNDANCE_API = '/api/abundance';
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const BODY_BYTES = 16 * 1024;
/** A CSV of figures: 4 MB of text in its JSON wrapping. */
const CSV_BODY_BYTES = 5 * 1024 * 1024;

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...HEADERS });
  res.end(JSON.stringify(payload));
}

export function abundanceProvider({
  root = defaultSourceRoot,
  createStore = createAbundanceStore,
  env = process.env,
  log = (line) => console.log(`[abundance] ${line}`),
} = {}) {
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 120 });
  let store = null;

  const handle = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const method = String(req.method || 'GET').toUpperCase();
    const admitted = admitKeySetupRequest({
      method,
      remoteAddress: req.socket?.remoteAddress,
      hostHeader: req.headers?.host,
      protocol: req.socket?.encrypted ? 'https:' : 'http:',
      origin: req.headers?.origin,
      contentType: req.headers?.['content-type'],
      proxyHeaders: req.headers || {},
      env,
    });
    if (!admitted.ok) {
      if (admitted.removal === true) {
        sendOwnerRemovalRefusal(res, HEADERS);
        return;
      }
      send(res, admitted.status || 403, {
        error: String(admitted.error || 'Refused').replace(
          'Provider Settings',
          'The Global Abundance Map',
        ),
      });
      return;
    }
    if (!privateFetchSiteAllowed(req.headers || {})) {
      send(res, 403, { error: 'Cross-site request refused' });
      return;
    }
    if (method === 'GET' && route === '/status')
      return send(res, 200, store.status());
    if (method === 'GET' && route === '/data')
      return send(res, 200, store.data(url.searchParams.get('level')));
    if (!allow(clientKey(req)))
      return send(res, 429, { error: 'Too many requests' });
    let body = {};
    if (method === 'POST' || method === 'DELETE')
      try {
        body = JSON.parse(
          (await readRequestBody(
            req,
            route === '/import' ? CSV_BODY_BYTES : BODY_BYTES,
          )) || '{}',
        );
      } catch (error) {
        const tooLarge =
          error?.code === 'BODY_TOO_LARGE' ||
          /large/i.test(String(error?.message));
        return send(res, tooLarge ? 413 : 400, {
          error: tooLarge
            ? 'Too large: a CSV file is at most 4 MB.'
            : 'The body must be JSON.',
        });
      }
    if (method === 'DELETE' && route === '/import')
      return send(res, 200, store.clearImport(body));
    if (method === 'POST') {
      if (route === '/refresh') {
        // Started, not awaited: the tab polls /status while it runs.
        store
          .refresh({ force: body?.force === true })
          .catch((error) => log(`refresh: ${error?.message || error}`));
        return send(res, 200, store.status());
      }
      if (route === '/import') {
        const result = store.importCsv(body);
        return send(res, result?.error ? 400 : 200, result);
      }
    }
    send(res, 404, { error: 'Not found' });
  };

  const install = (server) => {
    store = createStore({ root, log });
    server.httpServer?.once?.('close', () => store.close());
    server.middlewares.use(ABUNDANCE_API, async (req, res) => {
      try {
        await handle(req, res);
      } catch (error) {
        if (res.headersSent) return res.destroy();
        send(res, error?.status || 500, {
          error: error?.status
            ? error.message
            : 'The Global Abundance Map failed.',
        });
      }
    });
  };

  return {
    name: 'gev-abundance',
    configureServer: install,
    configurePreviewServer: install,
  };
}
