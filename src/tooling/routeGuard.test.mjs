import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  guardHandler,
  guardMiddlewares,
  guardProcess,
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
  const route = guardHandler(async () => {
    throw new Error('provider exploded');
  }, (message) => logged.push(message));
  const res = fakeResponse();
  await route({ method: 'GET', url: '/api/cctv/frame/x?secret=1' }, res, () => {});
  await tick();
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'Internal error' });
  assert.match(logged[0], /GET \/api\/cctv\/frame\/x failed: Error: provider exploded/);
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
  assert.equal(guardHandler(errorHandler), errorHandler, 'four arguments: connect error handler');
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

test('background rejections are logged and survived, with one listener per process', () => {
  const fakeProcess = new EventEmitter();
  const logged = [];
  guardProcess(fakeProcess, (message) => logged.push(message));
  guardProcess(fakeProcess, (message) => logged.push(message));
  assert.equal(fakeProcess.listenerCount('unhandledRejection'), 1);
  fakeProcess.emit('unhandledRejection', new Error('cache write failed'));
  assert.match(logged[0], /unhandled rejection \(kept running\): Error: cache write failed/);
});
