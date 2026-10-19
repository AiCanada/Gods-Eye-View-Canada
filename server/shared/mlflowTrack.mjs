/**
 * MLFLOW TRACKING (owner request 2026-10-17, "all 6"): every training run in
 * the AI World tab kept as an MLflow run, from the protocol events the server
 * already reads (docs/AI-WORLD-TAB.md, child-process protocol): the kit's
 * PyTorch trainer, the TensorFlow jobs and CUSTOM LLM TRAINING. Parameters
 * come from the child's own `--flag value` arguments; metrics are the training
 * loss by step and the held-out error against persistence, overall and per
 * domain; the run ends with the model folder's metrics.json and manifest.json
 * as artifacts.
 *
 * Writes queue in memory and go out in batches once the MLflow server answers
 * (server/shared/mlflowJobs.mjs starts it), so a run that starts before the
 * server is up loses nothing; past `maxPending` entries the oldest metric
 * points are dropped and counted. Nothing here imports the job managers, so
 * they can import it.
 */
import fs from 'node:fs';
import {
  MLFLOW_BATCH,
  MLFLOW_PARAM_VALUE_MAX,
  MlflowError,
  mlflowKey,
} from './mlflowRest.mjs';

export const NO_RUN = Object.freeze({
  log() {},
  tags() {},
  artifact() {},
  end() {},
});
/** What a manager uses when no tracker is given. */
export const NO_TRACKER = Object.freeze({ startRun: () => NO_RUN });

const ARTIFACT_BYTES_MAX = 64 * 1024 * 1024;
const RECENT_MAX = 8;
const finite = (v) =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/** `--name value` pairs after the module (`-m x`); a flag alone reads 'true'. */
export function childParams(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const at = list.indexOf('-m');
  const rest = at >= 0 ? list.slice(at + 2) : list;
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith('--')) continue;
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--'))
      out[flag.slice(2)] = 'true';
    else {
      out[flag.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

/** The metrics one protocol event carries, as MLflow keys. */
export function eventMetrics(event) {
  const e = event || {};
  const out = {};
  if (e.event === 'progress') {
    if (finite(e.loss)) out['train/loss'] = Number(e.loss);
    if (finite(e.epoch)) out['train/epoch'] = Number(e.epoch);
  } else if (e.event === 'metrics') {
    const skill = e.skill || {};
    if (finite(skill.model)) out['held-out/mae'] = Number(skill.model);
    if (finite(skill.persistence))
      out['held-out/persistence'] = Number(skill.persistence);
    if (finite(skill.model) && Number(skill.persistence) > 0)
      out['held-out/skill'] =
        1 - Number(skill.model) / Number(skill.persistence);
    for (const [domain, sk] of Object.entries(e.domains || {})) {
      if (!sk || typeof sk !== 'object') continue;
      if (finite(sk.model)) out[`domain/${domain}/mae`] = Number(sk.model);
      if (finite(sk.persistence))
        out[`domain/${domain}/persistence`] = Number(sk.persistence);
    }
  } else if (e.event === 'posttrain') {
    if (finite(e.before)) out['held-out/loss-before'] = Number(e.before);
    if (finite(e.after)) out['held-out/loss-after'] = Number(e.after);
    if (typeof e.helped === 'boolean')
      out['held-out/helped'] = e.helped ? 1 : 0;
  } else if (e.event === 'export') {
    for (const key of ['days', 'entries', 'files'])
      if (finite(e[key])) out[`export/${key}`] = Number(e[key]);
  }
  return out;
}

/**
 * A child process followed as one MLflow run: `event` for each protocol
 * event, `exit` when it ends (with the files to keep as artifacts).
 * @param {{startRun: Function}} tracker
 * @param {{experiment: string, name: string, args?: string[], params?: object, tags?: object}} spec
 */
export function trackChild(tracker, spec) {
  const run = (tracker || NO_TRACKER).startRun({
    experiment: spec.experiment,
    name: spec.name,
    params: { ...childParams(spec.args), ...(spec.params || {}) },
    tags: spec.tags || {},
  });
  let step = 0;
  let paused = false;
  return {
    run,
    event(event) {
      const e = event || {};
      if (finite(e.step)) step = Number(e.step);
      const metrics = eventMetrics(e);
      if (Object.keys(metrics).length) run.log(metrics, step);
      const tags = {};
      if (e.device) tags['gev.device'] = e.device;
      if (e.tensorflow) tags['gev.tensorflow'] = e.tensorflow;
      if (e.channelsGrown === true) tags['gev.channelsGrown'] = 'true';
      if (e.channelMismatch === true) tags['gev.newModel'] = 'channels changed';
      if (e.event === 'error') tags['gev.error'] = String(e.message || '');
      if (e.event === 'export') {
        if (e.out) tags['gev.exportFolder'] = String(e.out);
        tags['gev.publishable'] = String(e.publishable === true);
        if (Array.isArray(e.datasetClasses))
          tags['gev.datasetClasses'] = e.datasetClasses.join(',');
      }
      if (e.event === 'paused') paused = true;
      if (Object.keys(tags).length) run.tags(tags);
    },
    /** @param {{code: number|null, stopped?: boolean, files?: Array<[string, string]>}} result */
    exit({ code, stopped = false, files = [] } = {}) {
      for (const [file, rel] of files) run.artifact(file, rel);
      if (paused) run.tags({ 'gev.ended': 'paused' });
      else if (stopped) run.tags({ 'gev.ended': 'stopped' });
      run.end(
        code === 0 && !paused && !stopped
          ? 'FINISHED'
          : paused || stopped
            ? 'KILLED'
            : 'FAILED',
      );
    },
  };
}

/**
 * The queue between the runs and the MLflow server.
 * @param {object} options
 * @param {() => object|null} options.rest The REST client while the server
 *   answers, else null.
 * @param {() => void} [options.wake] Asked for the server when there is
 *   something to write and no client.
 * @param {() => boolean} [options.enabled] TRACK EVERY TRAINING RUN.
 */
export function createRunTracker({
  rest,
  wake = () => {},
  enabled = () => true,
  now = () => Date.now(),
  timers = {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
  },
  log = () => {},
  maxPending = 20_000,
  flushMs = 2_000,
} = {}) {
  const runs = [];
  const recent = [];
  const experiments = new Map();
  let dropped = 0;
  let logged = 0;
  let busy = false;
  let lastError = null;
  let seq = 0;

  const pendingCount = () =>
    runs.reduce(
      (n, r) =>
        n +
        r.pending.metrics.length +
        r.pending.params.length +
        r.pending.tags.length,
      0,
    );
  const trim = () => {
    let over = pendingCount() - maxPending;
    while (over > 0) {
      const largest = runs.reduce(
        (a, r) =>
          !a || r.pending.metrics.length > a.pending.metrics.length ? r : a,
        null,
      );
      if (!largest || !largest.pending.metrics.length) break;
      largest.pending.metrics.shift();
      dropped += 1;
      over -= 1;
    }
  };

  const tracker = {
    startRun({ experiment, name, params = {}, tags = {} }) {
      if (!enabled()) return NO_RUN;
      const run = {
        id: ++seq,
        experiment: String(experiment || 'ai-world'),
        name: String(name || experiment || 'run'),
        startTime: now(),
        tags: {
          'mlflow.source.type': 'LOCAL',
          'mlflow.user': 'gev',
          ...Object.fromEntries(
            Object.entries(tags).map(([k, v]) => [k, String(v)]),
          ),
        },
        created: null,
        pending: {
          metrics: [],
          params: Object.entries(params).map(([key, value]) => ({
            key: mlflowKey(key),
            value: String(value).slice(0, MLFLOW_PARAM_VALUE_MAX),
          })),
          tags: [],
        },
        artifacts: [],
        end: null,
        view: {
          experiment: String(experiment || 'ai-world'),
          name: String(name || ''),
          state: 'RUNNING',
          runId: null,
          experimentId: null,
          startedAt: now(),
          last: {},
        },
      };
      runs.push(run);
      recent.unshift(run.view);
      recent.length = Math.min(recent.length, RECENT_MAX);
      wakeUp();
      return {
        log(metrics, step = 0) {
          for (const [key, value] of Object.entries(metrics || {})) {
            if (!finite(value)) continue;
            run.pending.metrics.push({
              key: mlflowKey(key),
              value: Number(value),
              timestamp: now(),
              step: Math.max(0, Math.round(Number(step) || 0)),
            });
            run.view.last[key] = Number(value);
          }
          trim();
          wakeUp();
        },
        tags(values) {
          for (const [key, value] of Object.entries(values || {}))
            run.pending.tags.push({
              key: mlflowKey(key),
              value: String(value).slice(0, 5000),
            });
        },
        artifact(file, relPath) {
          run.artifacts.push([String(file), String(relPath)]);
        },
        end(status = 'FINISHED') {
          if (run.end) return;
          run.end = { status, at: now() };
          run.view.state = status;
          wakeUp();
        },
      };
    },
    async flush() {
      if (busy || !runs.length) return;
      const client = rest();
      if (!client) {
        wake();
        return;
      }
      busy = true;
      try {
        for (const run of [...runs]) {
          if (!run.created) {
            let experimentId = experiments.get(run.experiment);
            if (!experimentId) {
              experimentId = await client.experimentId(run.experiment);
              experiments.set(run.experiment, experimentId);
            }
            run.created = await client.createRun({
              experimentId,
              name: run.name,
              startTime: run.startTime,
              tags: run.tags,
            });
            run.view.runId = run.created.runId;
            run.view.experimentId = experimentId;
          }
          while (
            run.pending.metrics.length ||
            run.pending.params.length ||
            run.pending.tags.length
          ) {
            const params = run.pending.params.splice(0, MLFLOW_BATCH.params);
            const tags = run.pending.tags.splice(0, MLFLOW_BATCH.tags);
            const metrics = run.pending.metrics.splice(
              0,
              MLFLOW_BATCH.metrics - params.length - tags.length,
            );
            try {
              await client.logBatch(run.created.runId, {
                metrics,
                params,
                tags,
              });
              logged += metrics.length;
            } catch (error) {
              if (error instanceof MlflowError && !error.status) {
                // The server went away: put the batch back and try later.
                run.pending.params.unshift(...params);
                run.pending.tags.unshift(...tags);
                run.pending.metrics.unshift(...metrics);
                throw error;
              }
              log(
                `mlflow: a batch for ${run.name} was refused: ${error.message}`,
              );
              lastError = String(error.message);
            }
          }
          if (run.end) {
            while (run.artifacts.length) {
              const [file, rel] = run.artifacts[0];
              try {
                const stat = fs.statSync(file);
                if (stat.isFile() && stat.size <= ARTIFACT_BYTES_MAX)
                  await client.uploadArtifact(
                    run.created.artifactUri,
                    rel,
                    fs.readFileSync(file),
                    /\.json$/i.test(rel) ? 'application/json' : undefined,
                  );
              } catch (error) {
                // The server went away: keep the file for the next try.
                if (error instanceof MlflowError && !error.status) throw error;
                log(
                  `mlflow: artifact ${rel} for ${run.name}: ${error.message}`,
                );
              }
              run.artifacts.shift();
            }
            await client.updateRun(
              run.created.runId,
              run.end.status,
              run.end.at,
            );
            runs.splice(runs.indexOf(run), 1);
          }
        }
        lastError = null;
      } catch (error) {
        lastError = String(error?.message || error);
      } finally {
        busy = false;
      }
    },
    status() {
      return {
        active: runs.filter((r) => !r.end).length,
        queued: pendingCount(),
        unsent: runs.length,
        dropped,
        logged,
        error: lastError,
        recent: recent.map((view) => ({ ...view, last: { ...view.last } })),
      };
    },
    close() {
      timers.clearInterval(timer);
    },
  };
  const wakeUp = () => {
    if (!busy) void tracker.flush();
  };
  const timer = timers.setInterval(() => {
    if (runs.length) void tracker.flush();
  }, flushMs);
  timer?.unref?.();
  return tracker;
}
