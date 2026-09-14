// Location switch contract for DataLayerManager: layers stop feeding the old
// place and reload the new one, while visibility, intents and persistence stay
// exactly as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './manager.js';

function makeLayer(id, extra = {}) {
  const calls = { init: 0, enable: 0, disable: 0, update: 0, leave: [], arrive: [] };
  const module = {
    id,
    name: id,
    icon: '',
    source: 'test',
    updateInterval: -1,
    async init() { calls.init++; },
    enable() { calls.enable++; },
    disable() { calls.disable++; },
    async update() { calls.update++; },
    getStats() { return { count: 0, lastUpdate: null }; },
    onLocationLeave(change) { calls.leave.push(change); },
    onLocationArrive(change) { calls.arrive.push(change); },
    ...extra,
  };
  return { module, calls };
}

const FROM = { key: 'CA-ON', lat: 43.65, lon: -79.38 };
const TO = { key: 'CA-QC', lat: 45.5, lon: -73.57 };

test('leave reaches every initialized layer, on or off; arrive only the enabled ones', async () => {
  const manager = new DataLayerManager({});
  const on = makeLayer('on');
  const off = makeLayer('off');
  const never = makeLayer('never');
  for (const layer of [on, off, never]) manager.register(layer.module);
  await manager.setEnabled('on', true);
  await manager.setEnabled('off', true);
  await manager.setEnabled('off', false);

  const before = manager.getEnabledLayerIds();
  const events = [];
  manager.subscribe((event) => events.push(event.type));
  await manager.beginLocationSwitch({ from: FROM, to: TO });
  assert.deepEqual(on.calls.leave.map((c) => [c.from, c.to, c.enabled]), [[FROM, TO, true]]);
  assert.deepEqual(off.calls.leave.map((c) => c.enabled), [false], 'a switched-off layer still releases its memory');
  assert.equal(never.calls.leave.length, 0, 'a layer never initialized holds nothing');

  await manager.completeLocationSwitch({ from: FROM, to: TO });
  assert.equal(on.calls.arrive.length, 1);
  assert.equal(off.calls.arrive.length, 0);
  assert.equal(never.calls.arrive.length, 0);

  assert.deepEqual(manager.getEnabledLayerIds(), before, 'the same layers stay on');
  assert.equal(on.calls.enable, 1);
  assert.equal(on.calls.disable, 0);
  assert.ok(!events.includes('visibility') && !events.includes('params'), 'nothing is toggled or persisted');
});

test('a layer can ask for one fresh update on arrival', async () => {
  const manager = new DataLayerManager({});
  const refreshing = makeLayer('refreshing', { refreshOnLocationArrive: true });
  const quiet = makeLayer('quiet');
  manager.register(refreshing.module);
  manager.register(quiet.module);
  await manager.setEnabled('refreshing', true);
  await manager.setEnabled('quiet', true);
  const updates = [refreshing.calls.update, quiet.calls.update];
  await manager.completeLocationSwitch({ from: FROM, to: TO });
  assert.equal(refreshing.calls.update, updates[0] + 1);
  assert.equal(quiet.calls.update, updates[1]);
});

test('an aborted switch never loads the new place', async () => {
  const manager = new DataLayerManager({});
  const layer = makeLayer('layer', { refreshOnLocationArrive: true });
  manager.register(layer.module);
  await manager.setEnabled('layer', true);
  const controller = new AbortController();
  controller.abort();
  const updates = layer.calls.update;
  await manager.completeLocationSwitch({ from: FROM, to: TO, signal: controller.signal });
  assert.equal(layer.calls.arrive.length, 0);
  assert.equal(layer.calls.update, updates);
});

test('leave drops an enabled layer\'s in-flight poll so the old place cannot land', async () => {
  const manager = new DataLayerManager({});
  const layer = makeLayer('layer');
  manager.register(layer.module);
  await manager.setEnabled('layer', true);
  const entry = manager.layers.get('layer');
  entry.refreshing = true;
  const epoch = entry.refreshEpoch;
  const events = [];
  manager.subscribe((event) => events.push(event));
  await manager.beginLocationSwitch({ from: FROM, to: TO });
  assert.equal(entry.refreshEpoch, epoch + 1);
  assert.equal(entry.refreshing, false);
  assert.equal(events.at(-1)?.reason, 'location-switch');
});

test('a selection reaches every initialized layer, on or off, and a failing one never stops the others', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const manager = new DataLayerManager({});
  const heard = { on: [], off: [], never: [] };
  const hook = (id) => ({ onLocationSelect(change) { heard[id].push(change); } });
  const on = makeLayer('on', hook('on'));
  const off = makeLayer('off', hook('off'));
  const never = makeLayer('never', hook('never'));
  const broken = makeLayer('broken', { async onLocationSelect() { throw new Error('boom'); } });
  const plain = makeLayer('plain');
  for (const layer of [on, off, never, broken, plain]) manager.register(layer.module);
  await manager.setEnabled('on', true);
  await manager.setEnabled('off', true);
  await manager.setEnabled('off', false);
  await manager.setEnabled('broken', true);
  await manager.setEnabled('plain', true);

  const before = manager.getEnabledLayerIds();
  const events = [];
  manager.subscribe((event) => events.push(event.type));
  const arrival = Promise.resolve();
  const details = { selectCamera: true };
  await manager.selectLocationArea({ point: TO, arrival, details });

  assert.equal(heard.on.length, 1);
  assert.equal(heard.on[0].point, TO);
  assert.equal(heard.on[0].arrival, arrival, 'the one arrival promise is passed through');
  assert.equal(heard.on[0].details, details);
  assert.equal(heard.on[0].enabled, true);
  assert.deepEqual(heard.off.map((change) => change.enabled), [false], 'a layer that is off hears it too');
  assert.equal(heard.never.length, 0, 'a layer never initialized holds nothing');
  assert.equal(console.warn.mock.callCount(), 1);
  assert.deepEqual(manager.getEnabledLayerIds(), before, 'the same layers stay on');
  assert.ok(!events.includes('visibility') && !events.includes('params'), 'nothing is toggled or persisted');
});

test('one failing layer never stops the others', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const manager = new DataLayerManager({});
  const broken = makeLayer('broken', {
    onLocationLeave() { throw new Error('boom'); },
    async onLocationArrive() { throw new Error('boom'); },
  });
  const healthy = makeLayer('healthy');
  manager.register(broken.module);
  manager.register(healthy.module);
  await manager.setEnabled('broken', true);
  await manager.setEnabled('healthy', true);
  await manager.beginLocationSwitch({ from: FROM, to: TO });
  await manager.completeLocationSwitch({ from: FROM, to: TO });
  assert.equal(healthy.calls.leave.length, 1);
  assert.equal(healthy.calls.arrive.length, 1);
  assert.equal(console.warn.mock.callCount(), 2);
});
