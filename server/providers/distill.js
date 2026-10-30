/**
 * /api/distill: the AI DISTILLATION tab (owner request 2026-10-19;
 * server/shared/distillJobs.mjs runs it). Admitted as the AI World tab's
 * routes are: this machine's loopback and Host, an exact Origin on writes,
 * JSON bodies, same-origin fetches. The owner's phone (the tailnet mirror)
 * may run everything but the DELETE routes (a heading, its questions or its
 * dataset), which it is refused with no message, as every removal is (owner
 * ruling 2026-10-11).
 *
 *   GET    /status            headings, teachers, sub-headings, the run
 *   POST   /features          { heading, name }        add a sub-heading
 *   POST   /features/update   { id, name?, config? }
 *   DELETE /features          { id }
 *   POST   /questions         { id, text } or { id, csv }
 *   DELETE /questions         { id }
 *   DELETE /dataset           { id }
 *   GET    /records?id=&at=   one record, `at` counted back from the newest
 *   DELETE /records           { id, at }              drop that question's records; it is listed for RETRY
 *   POST   /estimate          { id, fresh?, retry? }   paid calls before START
 *   POST   /start             { id, confirm: true, fresh?, retry?, pauseAfter?, calls? }
 *                             calls: the estimate confirmed; refused when it changed
 *   POST   /pause  /continue  /stop
 *   POST   /paste             { answer }               a reply from a manual route
 *   POST   /skip
 *   GET    /export?id=&format=jsonl|csv
 */
import { defaultSourceRoot } from './common/source-root.js';
import { readRequestBody } from './common/request.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { privateFetchSiteAllowed } from './private-cameras.js';
import {
  admitKeySetupRequest,
  sendOwnerRemovalRefusal,
} from '../../src/keySetupCore.mjs';
import { createDistillManager } from '../shared/distillJobs.mjs';
import { onServerClose } from './serverClose.js';

export const DISTILL_API = '/api/distill';
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const BODY_BYTES = 128 * 1024;
/** A CSV of questions: 4 MB of text in its JSON wrapping. */
const CSV_BODY_BYTES = 5 * 1024 * 1024;

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...HEADERS });
  res.end(JSON.stringify(payload));
}

export function distillProvider({
  root = defaultSourceRoot,
  createManager = createDistillManager,
  env = process.env,
} = {}) {
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 120 });
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
          'AI Distillation',
        ),
      });
      return;
    }
    if (!privateFetchSiteAllowed(req.headers || {})) {
      send(res, 403, { error: 'Cross-site request refused' });
      return;
    }
    if (method === 'GET' && route === '/status')
      return send(res, 200, manager.status());
    if (method === 'GET' && route === '/records')
      return send(
        res,
        200,
        manager.record({
          id: url.searchParams.get('id'),
          at: url.searchParams.get('at'),
        }),
      );
    if (method === 'GET' && route === '/export') {
      const file = manager.exportData({
        id: url.searchParams.get('id'),
        format: url.searchParams.get('format') === 'csv' ? 'csv' : 'jsonl',
      });
      res.writeHead(200, {
        'Content-Type': file.type,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        ...HEADERS,
      });
      res.end(file.body);
      return;
    }
    if (!allow(clientKey(req)))
      return send(res, 429, { error: 'Too many requests' });
    let body = {};
    if (method === 'POST' || method === 'DELETE')
      try {
        body = JSON.parse(
          (await readRequestBody(
            req,
            route === '/questions' ? CSV_BODY_BYTES : BODY_BYTES,
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
    if (method === 'DELETE') {
      if (route === '/features')
        return send(res, 200, manager.removeFeature(body));
      if (route === '/questions')
        return send(res, 200, manager.clearQuestions(body));
      if (route === '/dataset')
        return send(res, 200, manager.clearDataset(body));
      if (route === '/records')
        return send(res, 200, manager.dropRecords(body));
    }
    if (method === 'POST') {
      if (route === '/features')
        return send(res, 200, manager.addFeature(body));
      if (route === '/features/update')
        return send(res, 200, manager.updateFeature(body));
      if (route === '/questions')
        return send(res, 200, manager.addQuestions(body));
      if (route === '/estimate')
        return send(res, 200, { estimate: manager.estimate(body) });
      if (route === '/start') return send(res, 200, manager.start(body));
      if (route === '/pause') return send(res, 200, manager.pause());
      if (route === '/continue') return send(res, 200, manager.continue());
      if (route === '/stop') return send(res, 200, manager.stop());
      if (route === '/paste') return send(res, 200, manager.paste(body));
      if (route === '/skip') return send(res, 200, manager.skipPaste());
    }
    send(res, 404, { error: 'Not found' });
  };

  const install = (server) => {
    manager = createManager({ root, env });
    onServerClose(server, () => manager.close());
    server.middlewares.use(DISTILL_API, async (req, res) => {
      try {
        await handle(req, res);
      } catch (error) {
        if (res.headersSent) return res.destroy();
        send(res, error?.status || 500, {
          error: error?.status ? error.message : 'AI Distillation failed.',
        });
      }
    });
  };

  return {
    name: 'gev-distill',
    configureServer: install,
    configurePreviewServer: install,
  };
}
