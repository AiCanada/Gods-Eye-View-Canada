/**
 * /api/ai-world: the Artificial Intelligence World Training Sim tab's routes
 * (owner request 2026-10-13; docs/AI-WORLD-TAB.md is the contract). A local
 * control surface, admitted as Device feeds are: this machine's loopback
 * and Host, an exact Origin on writes, JSON bodies, same-origin fetches. The
 * owner's phone (the tailnet mirror) may read and run everything but the
 * DELETE routes (the files, or an area off the list), which it is refused
 * with no message, as every removal is (owner ruling 2026-10-11).
 */
import { defaultSourceRoot } from './common/source-root.js';
import { readRequestBody } from './common/request.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { privateFetchSiteAllowed } from './private-cameras.js';
import {
  admitKeySetupRequest,
  sendOwnerRemovalRefusal,
} from '../../src/keySetupCore.mjs';
import { createApiFetch, createLocalToolServices } from '../mcp/services.js';
import { createAiWorldManager } from '../shared/aiWorldJobs.mjs';

const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const BODY_BYTES = 64 * 1024;

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...HEADERS });
  res.end(JSON.stringify(payload));
}

export function aiWorldProvider({
  root = defaultSourceRoot,
  createManager = createAiWorldManager,
  env = process.env,
  log = (line) => console.log(`[ai-world] ${line}`),
} = {}) {
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 60 });
  let manager = null;

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
          'The AI world tab',
        ),
      });
      return;
    }
    if (!privateFetchSiteAllowed(req.headers || {})) {
      send(res, 403, { error: 'Cross-site request refused' });
      return;
    }
    // The status route answers before the rate limiter: the tab polls it.
    if (method === 'GET' && route === '/status') {
      send(res, 200, manager.status());
      return;
    }
    if (method === 'GET' && route === '/catalog') {
      send(res, 200, manager.catalog());
      return;
    }
    if (!allow(clientKey(req))) {
      send(res, 429, { error: 'Too many requests' });
      return;
    }
    if (method === 'GET' && route === '/delete-preview') {
      send(
        res,
        200,
        manager.deletePreview(url.searchParams.get('scope') || 'all'),
      );
      return;
    }
    if (method === 'GET' && route === '/areas') {
      send(res, 200, manager.areas());
      return;
    }
    if (method === 'GET' && route === '/news-urls') {
      send(res, 200, manager.newsUrls());
      return;
    }
    if (method === 'GET' && route === '/markets') {
      send(res, 200, manager.markets());
      return;
    }
    if (method === 'GET' && route === '/predict') {
      const bbox = (url.searchParams.get('bbox') || '')
        .split(',')
        .map(Number)
        .filter(Number.isFinite);
      send(
        res,
        200,
        await manager.predict({
          domain: url.searchParams.get('domain') || '',
          horizon: Number(url.searchParams.get('horizon')) || 24,
          bbox: bbox.length === 4 ? bbox : null,
        }),
      );
      return;
    }
    let body = {};
    if (method === 'POST' || method === 'DELETE')
      try {
        body = JSON.parse((await readRequestBody(req, BODY_BYTES)) || '{}');
      } catch {
        send(res, 400, { error: 'The body must be JSON.' });
        return;
      }
    // Stops recording around an area (the phone was refused above, as for
    // every removal); what was recorded there stays.
    if (method === 'DELETE' && route === '/news-urls') {
      send(res, 200, manager.removeNewsUrl(body?.url));
      return;
    }
    if (method === 'DELETE' && route === '/areas') {
      send(
        res,
        200,
        manager.removeArea(
          String(body?.key || url.searchParams.get('key') || ''),
        ),
      );
      return;
    }
    if (method === 'DELETE' && route === '/delete') {
      send(
        res,
        200,
        manager.deleteListed(
          String(body?.scope || 'all'),
          String(body?.token || ''),
        ),
      );
      return;
    }
    if (method === 'POST') {
      if (route === '/selection') {
        send(
          res,
          200,
          manager.setSelection(
            Array.isArray(body?.selection) ? body.selection : [],
          ),
        );
        return;
      }
      if (route === '/estimate') {
        send(
          res,
          200,
          manager.estimate({
            selection: Array.isArray(body?.selection)
              ? body.selection
              : undefined,
            capGb: body?.capGb,
          }),
        );
        return;
      }
      if (route === '/initialize') {
        send(
          res,
          200,
          manager.initialize({
            selection: Array.isArray(body?.selection)
              ? body.selection
              : undefined,
            capGb: body?.capGb,
            sim: body?.sim,
          }),
        );
        return;
      }
      if (route === '/areas') {
        send(res, 200, manager.addArea(body));
        return;
      }
      if (route === '/news-urls') {
        send(res, 200, manager.addNewsUrl(body?.url));
        return;
      }
      if (route === '/posttrain') {
        send(res, 200, manager.setPostTrain(body || {}));
        return;
      }
      if (route === '/infer') {
        send(res, 200, await manager.infer(body || {}));
        return;
      }
      if (route === '/pause') return send(res, 200, manager.pause());
      if (route === '/continue') return send(res, 200, manager.continue());
      if (route === '/stop') return send(res, 200, manager.stop());
    }
    send(res, 404, { error: 'Not found' });
  };

  const install = (server) => {
    const httpServer = server.httpServer;
    let port = null;
    const portOf = () =>
      port ??
      httpServer?.address?.()?.port ??
      server.config?.server?.port ??
      5173;
    const apiBase = () => `http://localhost:${portOf()}`;
    manager = createManager({
      root,
      servicesFor: () => createLocalToolServices({ apiBase: apiBase() }),
      apiFetch: () => createApiFetch({ apiBase: apiBase() }),
      log,
    });
    const restore = () => {
      port = httpServer?.address?.()?.port ?? null;
      try {
        manager.restore();
      } catch (error) {
        log(`restore failed: ${error.message}`);
      }
    };
    if (httpServer?.listening) restore();
    else if (httpServer?.once) httpServer.once('listening', restore);
    else restore();
    httpServer?.once?.('close', () => manager.close());
    server.middlewares.use('/api/ai-world', async (req, res) => {
      try {
        await handle(req, res);
      } catch (error) {
        if (res.headersSent) return res.destroy();
        send(res, error?.status || 500, {
          error: error?.status ? error.message : 'The AI world tab failed.',
        });
      }
    });
  };

  return {
    name: 'gev-ai-world',
    configureServer: install,
    configurePreviewServer: install,
  };
}
