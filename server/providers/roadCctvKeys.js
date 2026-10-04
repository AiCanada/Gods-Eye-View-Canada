import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { defaultSourceRoot } from './common/source-root.js';
import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';
import {
  listRoadCctvKeys,
  removeRoadCctvKey,
  saveRoadCctvKey,
} from '../shared/roadCctvKeys.mjs';
import { listRoadCctvSites, setRoadCctvKeysRoot } from './cctv/media.js';

const BODY_LIMIT = 4096;
const HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

function send(res, status, payload) {
  res.writeHead(status, HEADERS);
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        req.destroy();
        finish({ ok: false, status: 413, error: 'Too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        finish({
          ok: true,
          value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        });
      } catch {
        finish({ ok: false, status: 400, error: 'Send JSON.' });
      }
    });
    req.on('error', () =>
      finish({ ok: false, status: 400, error: 'Send JSON.' }),
    );
  });
}

/**
 * POWER UP → ROAD511 → GENERIC ROAD CCTV API KEYS. Lists (never the key),
 * adds any number, and removes. POWER UP's own gate: this machine only, a
 * local Host, an exact local Origin and a JSON body.
 * @param {{sourceRoot?: string}} [options]
 */
export function roadCctvKeysProxy({ sourceRoot = defaultSourceRoot } = {}) {
  setRoadCctvKeysRoot(sourceRoot);
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 90 });
  function install(middlewares) {
    middlewares.use('/api/road-cctv-keys', async (req, res) => {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
        send(res, 405, { error: 'Method Not Allowed' });
        return;
      }
      const admitted = admitKeySetupRequest({
        method: req.method,
        remoteAddress: req.socket?.remoteAddress,
        hostHeader: req.headers?.host,
        protocol: req.socket?.encrypted ? 'https:' : 'http:',
        origin: req.headers?.origin,
        contentType: req.headers?.['content-type'],
        proxyHeaders: req.headers || {},
        env: process.env,
      });
      if (!admitted.ok) {
        send(res, admitted.status || 403, {
          error: String(admitted.error || 'Refused'),
        });
        return;
      }
      if (!allow(clientKey(req))) {
        send(res, 429, { error: 'Rate limit exceeded' });
        return;
      }
      try {
        if (req.method === 'GET') {
          // ?sites=1: the camera sites to pick from (waits for the catalogue).
          const wantsSites =
            new URL(req.url || '/', 'http://localhost').searchParams.get(
              'sites',
            ) === '1';
          send(
            res,
            200,
            wantsSites
              ? { sites: await listRoadCctvSites() }
              : { keys: listRoadCctvKeys(sourceRoot) },
          );
          return;
        }
        const body = await readJson(req);
        if (!body.ok) {
          send(res, body.status, { error: body.error });
          return;
        }
        const result =
          req.method === 'POST'
            ? saveRoadCctvKey(sourceRoot, body.value)
            : removeRoadCctvKey(sourceRoot, String(body.value?.id || ''));
        if (!result.ok) {
          send(res, 400, { error: result.error });
          return;
        }
        send(res, 200, {
          ok: true,
          id: result.id,
          keys: listRoadCctvKeys(sourceRoot),
        });
      } catch {
        send(res, 500, { error: 'This computer did not keep that key.' });
      }
    });
  }
  return {
    name: 'road-cctv-keys-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
