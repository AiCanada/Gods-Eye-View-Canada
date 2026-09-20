/**
 * Keeps one failing route from taking the whole dev server down.
 *
 * Most provider routes are `async (req, res) => { ... }` middleware. Connect
 * catches what a handler throws synchronously, but a rejected promise from an
 * async handler is nobody's: Node treats it as an unhandled rejection and ends
 * the process, and with it every other layer of the application. This plugin is
 * installed FIRST and wraps every middleware registered after it, so such a
 * rejection is logged and answered with a 500 for that one request instead.
 *
 * It also logs (and survives) unhandled rejections from background work that
 * belongs to no request: catalogue downloads, cache writes, timers.
 */

const GUARDED = Symbol.for('gev.routeGuard.guarded');
const PROCESS_GUARD = Symbol.for('gev.routeGuard.process');

function describe(error) {
  if (error instanceof Error) return error.stack || error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Answer a request whose handler failed, if nothing has been sent yet. */
function answerFailure(res) {
  try {
    if (res.headersSent || res.writableEnded) {
      // Too late for a status line: end the response so the client is not left hanging.
      if (!res.writableEnded) res.end();
      return;
    }
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ error: 'Internal error' }));
  } catch {
    /* the socket is already gone */
  }
}

/**
 * Wrap one connect handler. Only three-argument request handlers are wrapped;
 * four-argument error handlers keep their arity, which is how connect tells
 * them apart.
 * @param {Function} handler
 * @param {(message: string) => void} log
 */
export function guardHandler(handler, log = (message) => console.error(message)) {
  if (typeof handler !== 'function' || handler.length >= 4 || handler[GUARDED]) return handler;
  const guarded = function guardedRoute(req, res, next) {
    const fail = (error) => {
      log(`[Server] ${req.method || 'GET'} ${String(req.url || '').split('?')[0]} failed: ${describe(error)}`);
      answerFailure(res);
    };
    let result;
    try {
      result = handler.call(this, req, res, next);
    } catch (error) {
      fail(error);
      return undefined;
    }
    // The handled chain is what goes back: nobody downstream can be left
    // holding the rejected original.
    if (result && typeof result.then === 'function') return result.then(undefined, fail);
    return result;
  };
  Object.defineProperty(guarded, GUARDED, { value: true });
  return guarded;
}

/** Wrap every middleware registered on this connect app from now on. */
export function guardMiddlewares(middlewares, log) {
  if (!middlewares || middlewares[GUARDED]) return;
  const use = middlewares.use.bind(middlewares);
  middlewares.use = (...args) => use(...args.map((arg) => guardHandler(arg, log)));
  Object.defineProperty(middlewares, GUARDED, { value: true });
}

/** Log unhandled rejections instead of letting them end the process. Once per process. */
export function guardProcess(target = process, log = (message) => console.error(message)) {
  if (target[PROCESS_GUARD]) return;
  Object.defineProperty(target, PROCESS_GUARD, { value: true });
  target.on('unhandledRejection', (reason) => {
    log(`[Server] unhandled rejection (kept running): ${describe(reason)}`);
  });
}

/** Install first, before any provider plugin registers a route. */
export function routeGuardPlugin() {
  const install = (server) => {
    guardProcess();
    guardMiddlewares(server.middlewares);
  };
  return {
    name: 'route-guard',
    enforce: 'pre',
    configureServer: install,
    configurePreviewServer: install,
  };
}
