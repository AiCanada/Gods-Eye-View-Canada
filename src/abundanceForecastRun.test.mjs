// The forecast runner (src/abundanceForecastRun.js): a run through a
// worker when one can be made, inline otherwise; progress, the result, a
// place's detail; a newer run ends the one in flight. Hermetic: a fake
// worker that answers on the next tick, and the inline handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createForecastRunner, makeForecastWorker } from './abundanceForecastRun.js';
import { createForecastHandler } from './abundanceForecast.mjs';

const units = [
  { id: 'A', name: 'A', iso2: 'A', country: 'A', lat: 0, lon: 0, values: { gdp: { v: 50000, year: 2024, from: 'own', n: 0, m: 10.8 }, work: { v: 4, year: 2024, from: 'own' } } },
  { id: 'B', name: 'B', iso2: 'B', country: 'B', lat: 1, lon: 1, values: { gdp: { v: 20000, year: 2024, from: 'own' }, work: { v: 9, year: 2024, from: 'own' } } },
  { id: 'C', name: 'C', iso2: 'C', country: 'C', lat: 2, lon: 2, values: { gdp: { v: 8000, year: 2024, from: 'own' } } },
];
const request = () => ({ planId: 'p', level: 'country', units, indicators: ['gdp', 'work'], weights: {}, runs: 100, seed: 1, crises: true });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A worker that runs the real handler, answering on later ticks. */
function fakeWorker(log = []) {
  const handle = createForecastHandler();
  const worker = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage(message) {
      log.push(message.type);
      setTimeout(() => {
        if (worker.terminated) return;
        handle(message, (answer) => worker.onmessage?.({ data: answer }));
      }, 0);
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return worker;
}

test('without a worker the handler answers inline: progress, the result, the detail and the model', async () => {
  const runner = createForecastRunner({ makeWorker: () => null });
  const years = [];
  const done = await runner.run(request(), (p) => years.push(p.year));
  assert.equal(runner.usingWorker, false);
  assert.equal(done.type, 'done');
  assert.equal(years.length, 100);
  assert.deepEqual(done.result.ids, ['A', 'B', 'C']);
  assert.equal(runner.running, false);
  const detail = await runner.detail('p', 'B');
  assert.equal(detail.type, 'detail');
  assert.equal(detail.detail.id, 'B');
  assert.deepEqual(Object.keys(detail.detail.indicators), ['gdp', 'work']);
  const stale = await runner.detail('old', 'B');
  assert.equal(stale.stale, true);
  const model = await runner.model('p');
  assert.deepEqual(model.model.map((m) => m.id), ['gdp', 'work']);
  runner.destroy();
  const after = await runner.run(request());
  assert.equal(after.type, 'cancelled');
});

test('with a worker the messages cross to it and back; a newer run drops the worker and the run in flight', async () => {
  const made = [];
  const runner = createForecastRunner({
    makeWorker: () => {
      const log = [];
      const worker = fakeWorker(log);
      made.push({ worker, log });
      return worker;
    },
  });
  const first = runner.run(request());
  assert.equal(runner.usingWorker, true);
  assert.equal(runner.running, true);
  const second = runner.run({ ...request(), seed: 2 });
  assert.equal(made.length, 2, 'a fresh worker for the newer run');
  assert.equal(made[0].worker.terminated, true);
  const firstAnswer = await first;
  assert.equal(firstAnswer.type, 'cancelled');
  const progress = [];
  const secondAnswer = await second;
  assert.equal(secondAnswer.type, 'done');
  assert.equal(secondAnswer.result.seed, 2);
  assert.deepEqual(made[1].log, ['run']);
  const detail = await runner.detail('p', 'A');
  assert.equal(detail.detail.id, 'A');
  assert.deepEqual(made[1].log, ['run', 'detail']);
  assert.equal(progress.length, 0);
  // A worker that fails ends what it owed; the next send makes a new one.
  const pending = runner.detail('p', 'B');
  made[1].worker.onerror({ message: 'boom' });
  const failed = await pending;
  assert.equal(failed.type, 'cancelled');
  assert.equal(made[1].worker.terminated, true);
  const again = await runner.run(request());
  assert.equal(again.type, 'done');
  assert.equal(made.length, 3);
  runner.destroy();
  assert.equal(made[2].worker.terminated, true);
  await tick();
});

test('a worker needs the Worker constructor', () => {
  assert.equal(typeof Worker === 'function' ? typeof makeForecastWorker() : makeForecastWorker(), typeof Worker === 'function' ? 'object' : null);
});
