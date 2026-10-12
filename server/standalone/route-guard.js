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
 *
 * Uncaught exceptions are sorted into two kinds. A socket or stream error that
 * escaped its `'error'` listener (a client that hung up mid-response, an
 * upstream that reset the connection, a DNS blip) says nothing about the state
 * of the process, so it is logged and the server keeps running. Anything else
 * (a TypeError in a timer, EADDRINUSE on a relisten) leaves the process in a
 * state nobody planned for, and serving from it would be guessing. The stack
 * is written to stderr synchronously, so a piped log keeps it, and the process
 * exits with code 70 (EX_SOFTWARE): the dev supervisor relaunches a fresh
 * server in about a second.
 */

import fs from 'node:fs';

const GUARDED = Symbol.for('gev.routeGuard.guarded');
const PROCESS_GUARD = Symbol.for('gev.routeGuard.process');

/** Exit code for an uncaught exception the guard does not recognise (EX_SOFTWARE). */
export const FATAL_EXIT_CODE = 70;

/**
 * Error codes a long-running server outlives: each names a connection or
 * stream that is already gone, never process state. EADDRINUSE is deliberately
 * absent; a server that cannot listen must stop and say so.
 */
export const RECOVERABLE_ERROR_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_DESTROYED',
  'ERR_HTTP_HEADERS_SENT',
  'ERR_STREAM_WRITE_AFTER_END',
]);

/** True when an uncaught error is a known connection failure the server can outlive. */
export function isRecoverableError(error) {
  return (
    typeof error?.code === 'string' && RECOVERABLE_ERROR_CODES.has(error.code)
  );
}

/** Write to stderr without the event loop: the process is about to exit. */
function writeFatal(text) {
  try {
    fs.writeSync(2, text);
  } catch {
    /* stderr is gone; nothing left to tell */
  }
}

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
export function guardHandler(
  handler,
  log = (message) => console.error(message),
) {
  if (typeof handler !== 'function' || handler.length >= 4 || handler[GUARDED])
    return handler;
  const guarded = function guardedRoute(req, res, next) {
    const fail = (error) => {
      log(
        `[Server] ${req.method || 'GET'} ${String(req.url || '').split('?')[0]} failed: ${describe(error)}`,
      );
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
    if (result && typeof result.then === 'function')
      return result.then(undefined, fail);
    return result;
  };
  Object.defineProperty(guarded, GUARDED, { value: true });
  return guarded;
}

/** Wrap every middleware registered on this connect app from now on. */
export function guardMiddlewares(middlewares, log) {
  if (!middlewares || middlewares[GUARDED]) return;
  const use = middlewares.use.bind(middlewares);
  middlewares.use = (...args) =>
    use(...args.map((arg) => guardHandler(arg, log)));
  Object.defineProperty(middlewares, GUARDED, { value: true });
}

/**
 * Keep the process alive through unhandled rejections and recoverable
 * uncaught exceptions; end it (exit 70) on any other uncaught exception.
 * Once per process: a second call adds no listeners.
 * @param {NodeJS.EventEmitter} target
 * @param {(message: string) => void} log
 * @param {(code: number) => void} exit
 * @param {(text: string) => void} fatalLog synchronous stderr writer
 */
export function guardProcess(
  target = process,
  log = (message) => console.error(message),
  exit = (code) => process.exit(code),
  fatalLog = writeFatal,
) {
  if (target[PROCESS_GUARD]) return;
  Object.defineProperty(target, PROCESS_GUARD, { value: true });
  target.on('unhandledRejection', (reason) => {
    log(`[Server] unhandled rejection (kept running): ${describe(reason)}`);
  });
  target.on('uncaughtException', (error) => {
    if (isRecoverableError(error)) {
      log(`[Server] recovered from uncaught ${describe(error)}`);
      return;
    }
    fatalLog(
      `[Server] uncaught exception, exiting ${FATAL_EXIT_CODE} so the supervisor relaunches: ${describe(error)}\n`,
    );
    exit(FATAL_EXIT_CODE);
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
