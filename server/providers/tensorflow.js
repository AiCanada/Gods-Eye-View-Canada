/**
 * /api/tensorflow: the AI World tab's four TENSORFLOW sections (owner
 * request 2026-10-17; server/shared/tensorflowJobs.mjs runs the jobs).
 * Admitted as the tab's other routes are: this machine's loopback and Host,
 * an exact Origin on writes, JSON bodies, same-origin fetches. The owner's
 * phone (the tailnet mirror) may use all of it: there is no removal route.
 *
 *   GET  /status        runner, the run, settings, the model, exports, board
 *   POST /check         ask the runners again (WSL2 GPU, Windows CPU)
 *   POST /settings      epochs, device, export classes, post-train model
 *   POST /train         TENSORFLOW TRAINING ({fresh: true} starts a new model)
 *   POST /export        EXPORT FOR TENSORFLOW
 *   POST /posttrain     POST-TRAIN A TENSORFLOW MODEL
 *   POST /pause  /continue  /stop
 *   POST /board-start  /board-stop   TensorBoard
 *   *    /board/...     TensorBoard itself, passed through to its port on
 *                       127.0.0.1 (its own POSTs only read curves)
 */
import http from 'node:http';
import { defaultSourceRoot } from './common/source-root.js';
import { readRequestBody } from './common/request.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { privateFetchSiteAllowed } from './private-cameras.js';
import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';
import {
  TENSORFLOW_API,
  createTensorflowManager,
} from '../shared/tensorflowJobs.mjs';

const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const BODY_BYTES = 16 * 1024;
/** Request headers TensorBoard has no use for, kept on this side. */
const KEPT_BACK = new Set(['cookie', 'authorization', 'origin', 'referer']);

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...HEADERS });
  res.end(JSON.stringify(payload));
}

/** One request through to TensorBoard on 127.0.0.1 (its --path_prefix is ours). */
export function proxyToBoard(req, res, target, request = http.request) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers || {}))
    if (!KEPT_BACK.has(name.toLowerCase())) headers[name] = value;
  headers.host = `${target.host}:${target.port}`;
  const upstream = request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: `${TENSORFLOW_API}${req.url || '/'}`,
      headers,
    },
    (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    send(res, 502, { error: 'TensorBoard did not answer.' });
  });
  req.pipe(upstream);
}

export function tensorflowProvider({
  root = defaultSourceRoot,
  createManager = createTensorflowManager,
  env = process.env,
  log = (line) => console.log(`[tensorflow] ${line}`),
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

  const handle = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const method = String(req.method || 'GET').toUpperCase();
    if (route === '/board' || route.startsWith('/board/')) {
      // TensorBoard reads curves, its POSTs too: admitted as a read.
      const admitted = admit(req, 'GET');
      if (!admitted.ok || !privateFetchSiteAllowed(req.headers || {})) {
        send(res, admitted.ok ? 403 : admitted.status || 403, {
          error: 'Refused',
        });
        return;
      }
      const target = manager.boardTarget();
      if (!target) {
        send(res, 503, {
          error: 'TensorBoard is not running: START TENSORBOARD in the tab.',
        });
        return;
      }
      proxyToBoard(req, res, target);
      return;
    }
    const admitted = admit(req, method);
    if (!admitted.ok) {
      send(res, admitted.status || 403, {
        error: String(admitted.error || 'Refused').replace(
          'Provider Settings',
          'TensorFlow',
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
      if (route === '/train')
        return send(res, 200, manager.train({ fresh: body?.fresh === true }));
      if (route === '/export') return send(res, 200, manager.exportNow());
      if (route === '/posttrain') return send(res, 200, manager.postTrain());
      if (route === '/pause') return send(res, 200, manager.pause());
      if (route === '/continue') return send(res, 200, manager.continue());
      if (route === '/stop') return send(res, 200, manager.stop());
      if (route === '/board-start') return send(res, 200, manager.startBoard());
      if (route === '/board-stop') return send(res, 200, manager.stopBoard());
    }
    send(res, 404, { error: 'Not found' });
  };

  const install = (server) => {
    manager = createManager({ root, env, log });
    server.httpServer?.once?.('close', () => manager.close());
    server.middlewares.use(TENSORFLOW_API, async (req, res) => {
      try {
        await handle(req, res);
      } catch (error) {
        if (res.headersSent) return res.destroy();
        send(res, error?.status || 500, {
          error: error?.status ? error.message : 'TensorFlow failed.',
        });
      }
    });
  };

  return {
    name: 'gev-tensorflow',
    configureServer: install,
    configurePreviewServer: install,
  };
}
