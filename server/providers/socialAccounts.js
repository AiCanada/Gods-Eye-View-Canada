import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { defaultSourceRoot } from './common/source-root.js';
import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';
import {
  SOCIAL_LOGIN_LOCKED,
  listSocialLogins,
  removeSocialLogin,
  saveSocialLogin,
} from '../shared/socialAccounts.mjs';

const BODY_LIMIT = 8192;
const HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        finish({ overflowed: true, body: null });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () =>
      finish({ overflowed: false, body: Buffer.concat(chunks) }),
    );
    req.on('error', () => finish({ overflowed: false, body: null }));
  });
}

async function readJsonBody(req) {
  const read = await readBody(req, BODY_LIMIT);
  if (read.overflowed)
    return { ok: false, status: 413, error: 'Request too large' };
  if (!read.body) return { ok: false, status: 400, error: 'Invalid JSON' };
  try {
    const value = JSON.parse(read.body.toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, status: 400, error: 'Invalid JSON' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON' };
  }
}

function send(res, status, payload, extra = {}) {
  res.writeHead(status, { ...HEADERS, ...extra });
  res.end(JSON.stringify(payload));
}

/**
 * Saves and lists the operator's own social logins. The password is never
 * written into the response.
 * @param {{sourceRoot?: string}} [options]
 */
export function socialAccountsProxy({ sourceRoot = defaultSourceRoot } = {}) {
  const allow = makeRateLimiter({ windowMs: 60_000, max: 20, globalMax: 60 });
  function install(middlewares) {
    middlewares.use('/api/social/accounts', async (req, res) => {
      if (
        req.method !== 'GET' &&
        req.method !== 'POST' &&
        req.method !== 'DELETE'
      ) {
        send(res, 405, { error: 'Method Not Allowed' });
        return;
      }
      // POWER UP's own gate: this machine only, a local Host, an exact local
      // Origin and a JSON body on a save. Without it a web page open in this
      // browser could post a plain form here and replace a saved login.
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
          error: String(admitted.error || 'Refused').replace(
            'Provider Settings',
            'Saved logins',
          ),
        });
        return;
      }
      if (!allow(clientKey(req))) {
        send(
          res,
          429,
          { error: 'Rate limit exceeded' },
          { 'Retry-After': '10' },
        );
        return;
      }
      try {
        if (req.method === 'GET') {
          const listed = listSocialLogins(sourceRoot);
          send(res, 200, {
            accounts: listed.accounts,
            locked: listed.locked === true,
          });
          return;
        }
        const body = await readJsonBody(req);
        if (!body.ok) {
          send(res, body.status, { error: body.error });
          return;
        }
        const result =
          req.method === 'POST'
            ? saveSocialLogin(sourceRoot, {
                platform: body.value.platform,
                userId: body.value.userId,
                password: body.value.password,
                apiKey: body.value.apiKey,
                mode: body.value.mode,
              })
            : removeSocialLogin(sourceRoot, String(body.value.platform || ''));
        if (!result.ok) {
          const status = result.error === SOCIAL_LOGIN_LOCKED ? 409 : 400;
          send(res, status, { error: result.error });
          return;
        }
        send(res, 200, {
          ok: true,
          platform: result.platform,
          userId: result.userId,
          passwordSaved: result.passwordSaved === true,
          apiKeySaved: result.apiKeySaved === true,
        });
      } catch {
        send(res, 500, { error: 'This computer did not keep that login.' });
      }
    });
  }

  return {
    name: 'social-accounts-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
