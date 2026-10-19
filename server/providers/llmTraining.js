/**
 * /api/llm-training: the POWER UP dashboard's CUSTOM LLM TRAINING section
 * (owner requests 2026-10-16; server/shared/llmTraining.mjs runs the jobs).
 * Admitted as the AI World tab's routes are: this machine's loopback and
 * Host, an exact Origin on writes, JSON bodies, same-origin fetches. The
 * owner's phone (the tailnet mirror) may read, add and run everything but the
 * DELETE routes (a URL or a local source off the list), which it is refused
 * with no message, as every removal is (owner ruling 2026-10-11).
 *
 *   GET    /status       settings, sources, URLs, local sources, run, models
 *   POST   /config       name, base model, ticked sources, epochs, post-train
 *   POST   /urls         add a custom URL      DELETE /urls   take one off
 *   POST   /paths        add a local source    DELETE /paths  take one off
 *   POST   /initialize   fetch, build, train
 *   POST   /pause  /continue  /stop
 */
import { defaultSourceRoot } from './common/source-root.js';
import { readRequestBody } from './common/request.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { privateFetchSiteAllowed } from './private-cameras.js';
import {
  admitKeySetupRequest,
  sendOwnerRemovalRefusal,
} from '../../src/keySetupCore.mjs';
import { createLlmTrainingManager } from '../shared/llmTraining.mjs';

const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const BODY_BYTES = 16 * 1024;

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...HEADERS });
  res.end(JSON.stringify(payload));
}

export function llmTrainingProvider({
  root = defaultSourceRoot,
  createManager = createLlmTrainingManager,
  env = process.env,
  log = (line) => console.log(`[llm-training] ${line}`),
  /** MLFLOW TRACKING (server/providers/mlflow.js), when it is installed. */
  tracker,
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
          'Custom LLM training',
        ),
      });
      return;
    }
    if (!privateFetchSiteAllowed(req.headers || {})) {
      send(res, 403, { error: 'Cross-site request refused' });
      return;
    }
    if (method === 'GET' && route === '/status') {
      send(res, 200, manager.status());
      return;
    }
    if (!allow(clientKey(req))) {
      send(res, 429, { error: 'Too many requests' });
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
    if (method === 'DELETE' && route === '/urls')
      return send(res, 200, manager.removeUrl(body?.url));
    if (method === 'DELETE' && route === '/paths')
      return send(res, 200, manager.removePath(body?.path));
    if (method === 'POST') {
      if (route === '/config') return send(res, 200, manager.setConfig(body));
      if (route === '/urls') return send(res, 200, manager.addUrl(body?.url));
      if (route === '/paths')
        return send(res, 200, manager.addPath(body?.path));
      if (route === '/initialize') return send(res, 200, manager.initialize());
      if (route === '/pause') return send(res, 200, manager.pause());
      if (route === '/continue') return send(res, 200, manager.continue());
      if (route === '/stop') return send(res, 200, manager.stop());
    }
    send(res, 404, { error: 'Not found' });
  };

  const install = (server) => {
    manager = createManager({ root, env, log, tracker });
    server.httpServer?.once?.('close', () => manager.close());
    server.middlewares.use('/api/llm-training', async (req, res) => {
      try {
        await handle(req, res);
      } catch (error) {
        if (res.headersSent) return res.destroy();
        send(res, error?.status || 500, {
          error: error?.status ? error.message : 'Custom LLM training failed.',
        });
      }
    });
  };

  return {
    name: 'gev-llm-training',
    configureServer: install,
    configurePreviewServer: install,
  };
}
