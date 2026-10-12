import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  FATAL_EXIT_CODE,
  RECOVERABLE_ERROR_CODES,
  guardHandler,
  guardMiddlewares,
  guardProcess,
  isRecoverableError,
  routeGuardPlugin,
} from '../../server/standalone/route-guard.js';

function fakeResponse() {
  return {
    headersSent: false,
    writableEnded: false,
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(body = '') {
      this.body += body;
      this.writableEnded = true;
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a rejected async route answers 500 for that request instead of ending the process', async () => {
  const logged = [];
  const route = guardHandler(
    async () => {
      throw new Error('provider exploded');
    },
    (message) => logged.push(message),
  );
  const res = fakeResponse();
  await route(
    { method: 'GET', url: '/api/cctv/frame/x?secret=1' },
    res,
    () => {},
  );
  await tick();
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'Internal error' });
  assert.match(
    logged[0],
    /GET \/api\/cctv\/frame\/x failed: Error: provider exploded/,
  );
  assert.doesNotMatch(logged[0], /secret=1/, 'the query string is not logged');
});

test('a synchronous throw is answered too, and a response already under way is only ended', async () => {
  const log = () => {};
  const res = fakeResponse();
  guardHandler(() => {
    throw new Error('sync');
  }, log)({ url: '/api/x' }, res, () => {});
  assert.equal(res.status, 500);

  const streaming = fakeResponse();
  streaming.headersSent = true;
  await guardHandler(async () => {
    throw new Error('mid-stream');
  }, log)({ url: '/api/media' }, streaming, () => {});
  await tick();
  assert.equal(streaming.status, 0, 'no second status line');
  assert.equal(streaming.writableEnded, true);
});

test('healthy routes, error handlers and non-functions pass through untouched', async () => {
  let nextCalled = false;
  const route = guardHandler((_req, _res, next) => next());
  route({}, fakeResponse(), () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  const errorHandler = (_error, _req, _res, _next) => {};
  assert.equal(
    guardHandler(errorHandler),
    errorHandler,
    'four arguments: connect error handler',
  );
  assert.equal(guardHandler('/api'), '/api');
  assert.equal(guardHandler(route), route, 'never wrapped twice');
});

test('the plugin wraps every middleware registered after it, once', async () => {
  const registered = [];
  const middlewares = { use: (...args) => registered.push(args) };
  guardMiddlewares(middlewares, () => {});
  guardMiddlewares(middlewares, () => {});
  middlewares.use('/api/boom', async () => {
    throw new Error('x');
  });
  const [path, handler] = registered[0];
  assert.equal(path, '/api/boom');
  const res = fakeResponse();
  await handler({ url: '/api/boom' }, res, () => {});
  await tick();
  assert.equal(res.status, 500);

  const plugin = routeGuardPlugin();
  assert.equal(plugin.enforce, 'pre');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
});

/** A guarded fake process with every side effect captured. */
function guardedProcess() {
  const fakeProcess = new EventEmitter();
  const logged = [];
  const exits = [];
  const fatal = [];
  guardProcess(
    fakeProcess,
    (message) => logged.push(message),
    (code) => exits.push(code),
    (text) => fatal.push(text),
  );
  return { fakeProcess, logged, exits, fatal };
}

test('background rejections are logged and survived, with one listener per process', () => {
  const fakeProcess = new EventEmitter();
  const logged = [];
  guardProcess(fakeProcess, (message) => logged.push(message));
  guardProcess(fakeProcess, (message) => logged.push(message));
  assert.equal(fakeProcess.listenerCount('unhandledRejection'), 1);
  fakeProcess.emit('unhandledRejection', new Error('cache write failed'));
  assert.match(
    logged[0],
    /unhandled rejection \(kept running\): Error: cache write failed/,
  );
});

test('only known connection and stream codes count as recoverable', () => {
  const withCode = (code) => Object.assign(new Error(code), { code });
  for (const code of ['EPIPE', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'])
    assert.equal(isRecoverableError(withCode(code)), true, code);
  assert.equal(
    isRecoverableError(withCode('EADDRINUSE')),
    false,
    'a dead listener must stop the process',
  );
  assert.equal(isRecoverableError(new TypeError('x is not a function')), false);
  assert.equal(
    isRecoverableError({ code: 7 }),
    false,
    'numeric codes never match',
  );
  assert.equal(isRecoverableError(null), false);
  assert.equal(isRecoverableError(undefined), false);
  assert.equal(RECOVERABLE_ERROR_CODES.has('EADDRINUSE'), false);
  assert.equal(FATAL_EXIT_CODE, 70);
});

test('a recoverable uncaught exception is logged and the process keeps running', () => {
  const { fakeProcess, logged, exits, fatal } = guardedProcess();
  const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  fakeProcess.emit('uncaughtException', error);
  assert.match(logged[0], /recovered from uncaught Error: write EPIPE/);
  assert.deepEqual(exits, [], 'no exit');
  assert.deepEqual(fatal, [], 'nothing written as fatal');
});

test('an unknown uncaught exception writes its stack synchronously and exits 70', () => {
  const { fakeProcess, logged, exits, fatal } = guardedProcess();
  const error = new TypeError('undefined is not iterable');
  fakeProcess.emit('uncaughtException', error);
  assert.deepEqual(exits, [70]);
  assert.equal(fatal.length, 1);
  assert.ok(
    fatal[0].includes(error.stack),
    'the full stack reaches the fatal writer',
  );
  assert.match(fatal[0], /exiting 70/);
  assert.equal(logged.length, 0, 'the regular log is not used on the way out');
});

test('guarding a process twice leaves exactly one listener per event', () => {
  const { fakeProcess } = guardedProcess();
  guardProcess(
    fakeProcess,
    () => {},
    () => {},
    () => {},
  );
  assert.equal(fakeProcess.listenerCount('uncaughtException'), 1);
  assert.equal(fakeProcess.listenerCount('unhandledRejection'), 1);
});
