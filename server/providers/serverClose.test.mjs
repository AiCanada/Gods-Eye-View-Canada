import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { onServerClose } from './serverClose.js';

test('the fork providers share one close listener per HTTP server', () => {
  const httpServer = new EventEmitter();
  const ran = [];
  for (let i = 0; i < 12; i += 1)
    onServerClose({ httpServer }, () => ran.push(i));
  assert.equal(httpServer.listenerCount('close'), 1);
  httpServer.emit('close');
  assert.deepEqual(ran, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  httpServer.emit('close');
  assert.equal(ran.length, 12, 'each hook runs once');
});

test('a restarted server runs only its own hooks, and a failing hook stops no other', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const before = new EventEmitter();
  const after = new EventEmitter();
  const ran = [];
  onServerClose({ httpServer: before }, () => {
    throw new Error('boom');
  });
  onServerClose({ httpServer: before }, () => ran.push('old'));
  onServerClose({ httpServer: after }, () => ran.push('new'));
  before.emit('close');
  assert.deepEqual(ran, ['old']);
  assert.equal(warn.mock.callCount(), 1);
  after.emit('close');
  assert.deepEqual(ran, ['old', 'new']);
});

test('a server without an HTTP server has nothing to close', () => {
  assert.doesNotThrow(() => onServerClose({ httpServer: null }, () => {}));
  assert.doesNotThrow(() => onServerClose({}, () => {}));
});
