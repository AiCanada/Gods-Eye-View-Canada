/**
 * The GLOBAL ABUNDANCE MAP's forecast runner: hands a level's units and the
 * forecast settings to a Web Worker (src/abundanceForecast.worker.js), so
 * a hundred years of a few thousand places never stall the globe, and
 * answers the tab with the result, each year's progress and a selected
 * place's detail. Where no worker can run (a test, an old browser) the same
 * handler answers inline (src/abundanceForecast.mjs, createForecastHandler).
 * A new run ends the one in flight: the worker is dropped and a fresh one
 * started, since a simulation cannot be interrupted midway.
 */
import { createForecastHandler } from './abundanceForecast.mjs';

/** A worker for the forecast, or null where none can be made. */
export function makeForecastWorker() {
  if (typeof Worker !== 'function') return null;
  try {
    return new Worker(
      new URL('./abundanceForecast.worker.js', import.meta.url),
      { type: 'module' },
    );
  } catch {
    return null;
  }
}

/**
 * @param {object} [options]
 * @param {() => (Worker|null)} [options.makeWorker]
 * @param {(message: object, post: Function) => void} [options.inline] the handler used without a worker
 */
export function createForecastRunner({
  makeWorker = makeForecastWorker,
  inline = null,
} = {}) {
  let worker = null;
  let workerTried = false;
  let handler = inline;
  const pending = new Map();
  let nextId = 1;
  let runId = null;
  let destroyed = false;

  const receive = (data) => {
    const waiting = data ? pending.get(data.id) : null;
    if (!waiting) return;
    if (data.type === 'progress') {
      waiting.onProgress?.(data);
      return;
    }
    pending.delete(data.id);
    if (data.id === runId) runId = null;
    waiting.resolve(data);
  };

  const ensureWorker = () => {
    if (worker || workerTried) return worker;
    workerTried = true;
    worker = makeWorker?.() ?? null;
    if (worker) {
      worker.onmessage = (event) => receive(event.data);
      worker.onerror = () =>
        dropWorker(new Error('The forecast worker failed.'));
    }
    return worker;
  };

  /** End the worker and every answer it owed; a later send makes a new one. */
  const dropWorker = (why) => {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate?.();
      worker = null;
    }
    workerTried = false;
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting.resolve({ type: 'cancelled', id, error: why?.message || null });
    }
    runId = null;
  };

  const send = (message, onProgress) =>
    new Promise((resolve) => {
      if (destroyed) {
        resolve({ type: 'cancelled', id: message.id });
        return;
      }
      pending.set(message.id, { resolve, onProgress });
      const w = ensureWorker();
      if (w) {
        try {
          w.postMessage(message);
          return;
        } catch (error) {
          dropWorker(error);
          return;
        }
      }
      if (!handler) handler = createForecastHandler();
      try {
        handler(message, receive);
      } catch (error) {
        pending.delete(message.id);
        resolve({ type: 'cancelled', id: message.id, error: error?.message });
      }
    });

  return {
    /**
     * Simulate a level: `{ planId, units, indicators, weights, runs, seed, crises }`.
     * Resolves with `{ type: 'done', result }`, or `{ type: 'cancelled' }`
     * when a newer run replaced it or the worker failed.
     */
    run(request, onProgress) {
      if (runId !== null) dropWorker(null);
      const id = nextId++;
      runId = id;
      return send({ ...request, type: 'run', id }, onProgress);
    },
    /** A unit's detail from the last run's plan: `{ type: 'detail', detail, model }` or `stale`. */
    detail(planId, unitId) {
      return send({ type: 'detail', id: nextId++, planId, unitId });
    },
    /** The level's typical model lines from the last run's plan. */
    model(planId) {
      return send({ type: 'model', id: nextId++, planId });
    },
    /**
     * The world's line under another scenario, from the last run's units
     * at `runs` runs (never more than the run's): `{ type: 'compare',
     * scenario, world, runs }` or `stale`.
     */
    compare(planId, scenario, runs) {
      return send({ type: 'compare', id: nextId++, planId, scenario, runs });
    },
    /** Whether a run is in flight. */
    get running() {
      return runId !== null;
    },
    /** Whether the runner has a worker (a test seam). */
    get usingWorker() {
      return Boolean(worker);
    },
    destroy() {
      destroyed = true;
      dropWorker(null);
    },
  };
}
