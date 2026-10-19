/**
 * /api/mlflow: the AI World tab's six MLFLOW sections (owner request
 * 2026-10-17, "all 6"; server/shared/mlflowJobs.mjs runs them). Admitted as
 * the tab's other routes are: this machine's loopback and Host, an exact
 * Origin on writes, JSON bodies, same-origin fetches. The owner's phone (the
 * tailnet mirror) may use all of it but removal: inside the MLflow UI a
 * delete (a DELETE request, or a path naming delete) from the phone is refused
 * with no message, as every removal is (owner ruling 2026-10-11).
 *
 *   GET  /status        installed, server, tracking, registry, sources, job, serving
 *   POST /check         ask the Python again what it has
 *   POST /settings      { tracking }
 *   POST /server-start  /server-stop        the MLflow server
 *   POST /register      { source, name?, alias? }   MODEL REGISTRY
 *   POST /alias         { name, version, alias }
 *   POST /evaluate      EVALUATION
 *   POST /serve-start   { name, version }   /serve-stop   /serve-test
 *   POST /ask           { model, prompt }   LLM TRACING
 *   *    /ui/...        the MLflow UI and its API (the server's own prefix)
 *   *    /serve/...     the served model (/serve/invocations, /serve/ping)
 *
 * `tracker` is ready before the server starts, for the providers whose jobs
 * are tracked (AI World, CUSTOM LLM TRAINING, TENSORFLOW).
 */
import http from 'node:http';
import { defaultSourceRoot } from './common/source-root.js';
import { readRequestBody } from './common/request.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { privateFetchSiteAllowed } from './private-cameras.js';
import {
  admitKeySetupRequest,
  isOwnerDeviceRequest,
  sendOwnerRemovalRefusal,
} from '../../src/keySetupCore.mjs';
import { MLFLOW_API, createMlflowManager } from '../shared/mlflowJobs.mjs';
import { NO_RUN } from '../shared/mlflowTrack.mjs';

const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const BODY_BYTES = 16 * 1024;
/** Request headers the MLflow server has no use for, kept on this side. */
const KEPT_BACK = new Set(['cookie', 'authorization', 'origin', 'referer']);

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...HEADERS });
  res.end(JSON.stringify(payload));
}

/** Whether a request through the UI would remove something. */
export function isRemoval(method, pathname) {
  return (
    String(method).toUpperCase() === 'DELETE' ||
    /(^|\/)[^/]*delete[^/]*(\/|$)/i.test(String(pathname))
  );
}

/** One request through to a local MLflow process, at `path`. */
export function proxyTo(req, res, target, pathname, request = http.request) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers || {}))
    if (!KEPT_BACK.has(name.toLowerCase())) headers[name] = value;
  headers.host = `${target.host}:${target.port}`;
  const upstream = request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: pathname,
      headers,
    },
    (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    send(res, 502, { error: 'MLflow did not answer.' });
  });
  req.pipe(upstream);
}

export function mlflowProvider({
  root = defaultSourceRoot,
  createManager = createMlflowManager,
  env = process.env,
  log = (line) => console.log(`[mlflow] ${line}`),
} = {}) {
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 60 });
  let manager = null;

  const admit = (req, method) =>
    admitKeySetupRequest({
      method,
      remoteAddress: req.socket?.remoteAddress,
      hostHeader: req.headers?.host,
      protocol: req.socket?.encrypted ? 'https:' : 'http:',
      origin: req.headers?.origin,
      contentType: req.headers?.['content-type'],
      proxyHeaders: req.headers || {},
      env,
    });

  const passThrough = (req, res, route, url) => {
    // The UI and a served model are read and written by their own pages: admitted as reads.
    const admitted = admit(req, 'GET');
    if (!admitted.ok || !privateFetchSiteAllowed(req.headers || {})) {
      send(res, admitted.ok ? 403 : admitted.status || 403, {
        error: 'Refused',
      });
      return;
    }
    if (route.startsWith('/ui')) {
      if (isOwnerDeviceRequest(req) && isRemoval(req.method, url.pathname)) {
        sendOwnerRemovalRefusal(res, HEADERS);
        return;
      }
      const target = manager.uiTarget();
      if (!target) {
        send(res, 503, {
          error: 'The MLflow server is not running: START MLFLOW in the tab.',
        });
        return;
      }
      proxyTo(req, res, target, `${MLFLOW_API}${req.url || '/ui/'}`);
      return;
    }
    const target = manager.serveTarget();
    if (!target) {
      send(res, 503, {
        error: 'No model is served: START SERVING in the tab.',
      });
      return;
    }
    proxyTo(
      req,
      res,
      target,
      String(req.url || '/serve/').replace(/^\/serve/, '') || '/',
    );
  };

  const handle = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const method = String(req.method || 'GET').toUpperCase();
    if (/^\/(ui|serve)(\/|$)/.test(url.pathname))
      return passThrough(req, res, url.pathname, url);
    const admitted = admit(req, method);
    if (!admitted.ok) {
      if (admitted.removal === true) {
        sendOwnerRemovalRefusal(res, HEADERS);
        return;
      }
      send(res, admitted.status || 403, {
        error: String(admitted.error || 'Refused').replace(
          'Provider Settings',
          'MLflow',
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
    if (method === 'POST')
      try {
        body = JSON.parse((await readRequestBody(req, BODY_BYTES)) || '{}');
      } catch {
        send(res, 400, { error: 'The body must be JSON.' });
        return;
      }
    if (method === 'POST') {
      if (route === '/check') return send(res, 200, manager.check());
      if (route === '/settings')
        return send(res, 200, manager.setSettings(body));
      if (route === '/server-start')
        return send(res, 200, manager.startServer());
      if (route === '/server-stop') return send(res, 200, manager.stopServer());
      if (route === '/register') return send(res, 200, manager.register(body));
      if (route === '/alias')
        return send(res, 200, await manager.setAlias(body));
      if (route === '/evaluate') return send(res, 200, manager.evaluate());
      if (route === '/ask') return send(res, 200, manager.ask(body));
      if (route === '/serve-start')
        return send(res, 200, manager.startServing(body));
      if (route === '/serve-stop') return send(res, 200, manager.stopServing());
      if (route === '/serve-test')
        return send(res, 200, await manager.testServing());
    }
    send(res, 404, { error: 'Not found' });
  };

  const install = (server) => {
    manager = createManager({ root, env, log });
    server.httpServer?.once?.('close', () => manager.close());
    server.middlewares.use(MLFLOW_API, async (req, res) => {
      try {
        await handle(req, res);
      } catch (error) {
        if (res.headersSent) return res.destroy();
        send(res, error?.status || 500, {
          error: error?.status ? error.message : 'MLflow failed.',
        });
      }
    });
  };

  return {
    name: 'gev-mlflow',
    configureServer: install,
    configurePreviewServer: install,
    /** For the tracked providers: a run before this provider is installed is not kept. */
    tracker: {
      startRun: (spec) => (manager ? manager.tracker.startRun(spec) : NO_RUN),
    },
  };
}
