/**
 * The AI World tab's six MLFLOW sections (owner request 2026-10-17: "also
 * integrate https://mlflow.org/ as additional optons and features open source
 * as well"; ruling: all six, local only):
 *
 *   MLFLOW TRACKING   every training run as an MLflow run (mlflowTrack.mjs),
 *                     written through the server's REST API
 *   MLFLOW UI         the MLflow server on 127.0.0.1, opened through
 *                     /api/mlflow/ui/ (the phone mirror reaches it too)
 *   MODEL REGISTRY    trained models as registered versions with aliases
 *                     (ml.gevtape.mlflow_register)
 *   MODEL SERVING     one registered version answering REST requests
 *                     (`mlflow models serve`, through /api/mlflow/serve/)
 *   EVALUATION        registered world models scored side by side against
 *                     persistence (ml.gevtape.mlflow_evaluate)
 *   LLM TRACING       a custom LLM's questions and answers kept as MLflow
 *                     traces (ml.gevtape.llm_chat --trace)
 *
 * Everything stays in .gev-data/mlflow/: the runs and the registry in a
 * SQLite file, the artifacts beside it. MLflow runs in the Windows Python
 * 3.13 (GEV_MLFLOW_PYTHON, else GEV_PYTHON, else py -3.13); a run on the GPU
 * in WSL2 is still tracked, since the server writes its events here. One job
 * (register, evaluate, ask) at a time.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createChild, defaultPython } from './aiWorldJobs.mjs';
import { createMlflowRest } from './mlflowRest.mjs';
import { createRunTracker } from './mlflowTrack.mjs';
import {
  killTree as defaultKillTree,
  treeSpawnOptions,
} from './processTree.mjs';

export const MLFLOW_API = '/api/mlflow';
/** The MLflow server's own path prefix (`--static-prefix`): the proxy passes it on. */
export const MLFLOW_UI_PREFIX = `${MLFLOW_API}/ui`;
export const MLFLOW_SERVE_PREFIX = `${MLFLOW_API}/serve`;
export const MLFLOW_ALIASES = Object.freeze(['champion', 'challenger']);
export const MLFLOW_KINDS = Object.freeze(['world', 'tf-world', 'llm']);
export const MLFLOW_TRACE_EXPERIMENT = 'ai-world/llm-traces';
const READY_MS = 120_000;
const REGISTRY_TTL_MS = 15_000;
const PROMPT_MAX = 2000;

const refuse = (message, status = 400) =>
  Object.assign(new Error(message), { status });

/** A registered model name: letters, digits, dot, dash, underscore; 1 to 100. */
export function cleanModelName(raw) {
  const name = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name))
    throw refuse(
      'MODEL NAME is letters, digits, dot, dash and underscore (up to 100).',
    );
  return name;
}

/** A question for the custom LLM: one to 2,000 characters, no control characters. */
export function cleanPrompt(raw) {
  const text = String(raw ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .trim();
  if (!text) throw refuse('Type a question first.');
  if (text.length > PROMPT_MAX)
    throw refuse(`A question is at most ${PROMPT_MAX} characters.`);
  return text;
}

/** A served model's test request: zeros of its own shape, four places. */
export function sampleRequest(version) {
  const tags = version?.tags || {};
  if (tags['gev.kind'] === 'llm')
    return {
      dataframe_split: {
        columns: ['prompt'],
        data: [['What moved before crude oil?']],
      },
    };
  let channels = [];
  try {
    channels = JSON.parse(tags['gev.channels'] || '[]');
  } catch {
    channels = [];
  }
  const C = Math.max(1, channels.length);
  const L =
    Number(tags['gev.context'] || 24) + Number(tags['gev.horizon'] || 24);
  const S = Number(tags['gev.nStatic'] || 4);
  const K = 4;
  const zeros = (...shape) =>
    shape.length === 1
      ? new Array(shape[0]).fill(0)
      : Array.from({ length: shape[0] }, () => zeros(...shape.slice(1)));
  return {
    inputs: {
      v: zeros(1, L, K, C),
      m: zeros(1, L, K, C),
      tf: zeros(1, L, K, 6),
      s: zeros(1, K, S),
    },
  };
}

/**
 * A served model's error without the request it repeats: MLflow answers
 * "Failed to predict data '<the whole input>'. Error: <why>".
 */
export function servedError(message) {
  const text = String(message ?? '');
  const at = text.lastIndexOf('Error:');
  return (
    (at >= 0 ? text.slice(at + 6) : text).trim().slice(0, 300) ||
    'the model failed'
  );
}

/** The shape of a nested list, or [] for a scalar. */
function shapeOf(value) {
  const out = [];
  let at = value;
  while (Array.isArray(at)) {
    out.push(at.length);
    at = at[0];
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} options.root The repository.
 */
export function createMlflowManager({
  root,
  dataRoot = path.join(root, '.gev-data'),
  env = process.env,
  platform = process.platform,
  python = String(env.GEV_MLFLOW_PYTHON || '').trim()
    ? String(env.GEV_MLFLOW_PYTHON).trim().split(/\s+/)
    : defaultPython(env, platform),
  port = Number(env.GEV_MLFLOW_PORT) || 5000,
  servePort = Number(env.GEV_MLFLOW_SERVE_PORT) || 5001,
  spawnImpl = nodeSpawn,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timers = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
  },
  log = () => {},
  /** Ends a server child and what it started (a seam for tests). */
  killTree = (child) => defaultKillTree(child, { platform }),
} = {}) {
  const mlRoot = path.join(dataRoot, 'mlflow');
  const stateFile = path.join(mlRoot, 'state.json');
  const dbFile = path.join(mlRoot, 'mlflow.db');
  const artifactsDir = path.join(mlRoot, 'artifacts');
  const trackingUri = `http://127.0.0.1:${port}${MLFLOW_UI_PREFIX}`;
  const read = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };
  const saved = read(stateFile, {});
  const persisted = {
    settings: { tracking: true, ...(saved.settings || {}) },
    last: saved.last && typeof saved.last === 'object' ? saved.last : {},
  };
  const save = () => {
    fs.mkdirSync(mlRoot, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2));
    fs.renameSync(tmp, stateFile);
  };
  const pyArgs = (...args) => [...python.slice(1), ...args];
  // Local only (owner ruling 2026-10-18): MLflow's usage telemetry, from the
  // Python side and from its UI, is off in every MLflow process started here.
  const mlflowEnv = {
    ...env,
    MLFLOW_DISABLE_TELEMETRY: 'true',
    DO_NOT_TRACK: 'true',
    PYTHONIOENCODING: 'utf-8',
  };
  const children = new Set();
  let closed = false;

  // --- What this Python has -------------------------------------------------
  let installed = null; // { python, mlflow, torch, tensorflow, transformers }
  let probing = null;
  const probe = () => {
    if (probing || closed) return probing || Promise.resolve(installed);
    probing = new Promise((resolve) => {
      let found = null;
      const child = createChild({
        command: python[0],
        args: pyArgs('-m', 'ml.gevtape.mlflow_probe'),
        cwd: root,
        spawnImpl,
        env: mlflowEnv,
        log: (line) => log(`[mlflow-probe] ${line}`),
        onEvent: (event) => {
          if (event?.event === 'probe') found = event;
        },
        onExit: ({ tail }) => {
          children.delete(child);
          installed = found
            ? {
                python: found.python || null,
                mlflow: found.mlflow || null,
                torch: found.torch || null,
                tensorflow: found.tensorflow || null,
                transformers: found.transformers || null,
                error: null,
              }
            : { mlflow: null, error: tail.at(-1) || 'no answer' };
          probing = null;
          resolve(installed);
        },
      });
      children.add(child);
    });
    return probing;
  };

  // --- The MLflow server -----------------------------------------------------
  let serverChild = null;
  let server = { state: 'off', error: null, startedAt: null, held: false };
  const client = createMlflowRest({ baseUrl: trackingUri, fetchImpl });
  const waitReady = async (check, child, ms) => {
    const until = now() + ms;
    while (now() < until && !closed) {
      if (child.exited) return false;
      if (await check()) return true;
      await new Promise((resolve) => {
        const t = timers.setTimeout(resolve, 1_000);
        t?.unref?.();
      });
    }
    return false;
  };
  const startServer = async ({ byOwner = false } = {}) => {
    if (byOwner) server.held = false;
    if (serverChild || closed || server.held) return;
    server = { state: 'starting', error: null, startedAt: now(), held: false };
    const have = installed?.mlflow ? installed : await probe();
    if (!have?.mlflow) {
      server = {
        ...server,
        state: 'error',
        error: 'MLFLOW IS NOT INSTALLED: py -3.13 -m pip install mlflow',
      };
      return;
    }
    fs.mkdirSync(artifactsDir, { recursive: true });
    const child = spawnImpl(
      python[0],
      pyArgs(
        '-m',
        'mlflow',
        'server',
        '--backend-store-uri',
        `sqlite:///${dbFile.replace(/\\/g, '/')}`,
        '--artifacts-destination',
        artifactsDir,
        '--serve-artifacts',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--static-prefix',
        MLFLOW_UI_PREFIX,
        '--workers',
        '1',
      ),
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: mlflowEnv,
        ...treeSpawnOptions(platform),
      },
    );
    serverChild = child;
    const tail = [];
    const keep = (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean))
        tail.push(line);
      while (tail.length > 30) tail.shift();
    };
    child.stdout?.on?.('data', keep);
    child.stderr?.on?.('data', keep);
    const gone = (error) => {
      child.exited = true;
      if (serverChild !== child) return;
      serverChild = null;
      server =
        server.state === 'stopping'
          ? { state: 'off', error: null, startedAt: null, held: true }
          : {
              ...server,
              state: 'error',
              error: String(
                error ||
                  tail
                    .filter((l) => /error|address|in use|denied/i.test(l))
                    .at(-1) ||
                  tail.at(-1) ||
                  'the MLflow server stopped',
              ).slice(0, 300),
            };
    };
    child.on?.('exit', () => gone());
    child.on?.('error', (error) => gone(error?.message || error));
    if (await waitReady(() => client.health(), child, READY_MS)) {
      if (serverChild === child) server = { ...server, state: 'running' };
      void tracker.flush();
      void refreshRegistry(true);
    } else if (serverChild === child) {
      server = {
        ...server,
        state: 'error',
        error: 'the MLflow server did not answer in time',
      };
      killTree(child);
    }
  };
  const stopServer = () => {
    stopServing();
    if (!serverChild) {
      server = { state: 'off', error: null, startedAt: null, held: true };
      return;
    }
    server = { ...server, state: 'stopping' };
    killTree(serverChild);
  };
  const ensureServer = async () => {
    if (server.state === 'running') return true;
    if (server.state !== 'starting') await startServer();
    else
      await waitReady(
        async () => server.state === 'running',
        { exited: false },
        READY_MS,
      );
    return server.state === 'running';
  };

  // --- Tracking --------------------------------------------------------------
  const tracker = createRunTracker({
    rest: () => (server.state === 'running' ? client : null),
    wake: () => {
      if (server.state === 'off' && !server.held) void startServer();
    },
    enabled: () =>
      persisted.settings.tracking === true && installed?.mlflow !== null,
    now,
    timers,
    log,
  });

  // --- Registry --------------------------------------------------------------
  let registry = { models: [], error: null, updatedAt: null };
  let refreshing = null;
  let refreshAgain = false;
  const refreshRegistry = (force = false) => {
    if (server.state !== 'running') return Promise.resolve();
    if (refreshing) {
      // A job just changed the registry: read it again once this read ends.
      if (force) refreshAgain = true;
      return refreshing;
    }
    if (
      !force &&
      registry.updatedAt &&
      now() - registry.updatedAt < REGISTRY_TTL_MS
    )
      return Promise.resolve();
    refreshing = (async () => {
      try {
        const models = [];
        for (const rm of (await client.registeredModels()).slice(0, 30)) {
          const versions = (await client.modelVersions(rm.name))
            .map((v) => ({
              version: String(v.version),
              createdAt: Number(v.creation_timestamp) || null,
              runId: v.run_id || null,
              status: v.status || null,
              tags: Object.fromEntries(
                (v.tags || []).map((t) => [t.key, t.value]),
              ),
            }))
            .sort((a, b) => Number(b.version) - Number(a.version))
            .slice(0, 12);
          const aliases = Object.fromEntries(
            (rm.aliases || []).map((a) => [a.alias, String(a.version)]),
          );
          const kind =
            (rm.tags || []).find((t) => t.key === 'gev.kind')?.value ||
            versions[0]?.tags?.['gev.kind'] ||
            null;
          models.push({ name: rm.name, kind, aliases, versions });
        }
        registry = { models, error: null, updatedAt: now() };
      } catch (error) {
        registry = {
          ...registry,
          error: String(error?.message || error),
          updatedAt: now(),
        };
      } finally {
        refreshing = null;
        if (refreshAgain) {
          refreshAgain = false;
          void refreshRegistry(true);
        }
      }
    })();
    return refreshing;
  };
  const findVersion = (name, version) =>
    registry.models
      .find((m) => m.name === name)
      ?.versions.find((v) => v.version === String(version)) || null;

  /** Trained models on this PC that can be registered. */
  const sources = () => {
    const out = [];
    const stamp = (file) => {
      try {
        return Math.round(fs.statSync(file).mtimeMs);
      } catch {
        return null;
      }
    };
    const add = (id, kind, label, folder, marker, name) => {
      const at = stamp(path.join(folder, marker));
      if (at)
        out.push({
          id,
          kind,
          label,
          folder: path.relative(dataRoot, folder),
          updatedAt: at,
          defaultName: name,
        });
    };
    add(
      'world',
      'world',
      'KIT WORLD MODEL (PYTORCH)',
      path.join(dataRoot, 'ai-world', 'models', 'world'),
      'checkpoint.pt',
      'gev-world',
    );
    add(
      'posttrain',
      'world',
      'POST-TRAINED WORLD MODEL (PYTORCH)',
      path.join(dataRoot, 'ai-world', 'models', 'posttrain', 'model'),
      'checkpoint.pt',
      'gev-world-posttrained',
    );
    add(
      'tf-world',
      'tf-world',
      'TENSORFLOW WORLD MODEL (KERAS)',
      path.join(dataRoot, 'ai-world', 'tensorflow', 'models', 'tf-world'),
      'model.keras',
      'gev-tf-world',
    );
    add(
      'tf-posttrain',
      'tf-world',
      'POST-TRAINED KERAS MODEL',
      path.join(dataRoot, 'ai-world', 'tensorflow', 'posttrain', 'model'),
      'model.keras',
      'gev-tf-world-posttrained',
    );
    let names = [];
    try {
      names = fs.readdirSync(path.join(dataRoot, 'llm')).sort();
    } catch {
      names = [];
    }
    for (const name of names)
      if (
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) &&
        name !== 'base' &&
        name !== 'sources'
      )
        add(
          `llm:${name}`,
          'llm',
          `CUSTOM LLM ${name.toUpperCase()}`,
          path.join(dataRoot, 'llm', name, 'model'),
          'adapter.json',
          `gev-llm-${name}`.slice(0, 100),
        );
    return out;
  };

  // --- Jobs (register, evaluate, ask) -----------------------------------------
  let job = null;
  let run = { kind: null, state: 'idle' };
  const busy = () => Boolean(job) || run.state === 'starting';
  const remember = (kind, value) => {
    persisted.last[kind] = { ...value, at: now() };
    save();
  };
  const startJob = (
    kind,
    args,
    { onEvent = () => {}, onDone = () => {} } = {},
  ) => {
    if (busy()) throw refuse('An MLflow job is running already.', 409);
    run = { kind, state: 'starting', startedAt: now(), error: null };
    const launch = async () => {
      if (!(await ensureServer())) {
        run = {
          ...run,
          state: 'error',
          error: server.error || 'the MLflow server is not running',
          endedAt: now(),
        };
        return;
      }
      run = { ...run, state: 'running' };
      const child = createChild({
        command: python[0],
        args: pyArgs('-m', ...args),
        cwd: root,
        spawnImpl,
        env: mlflowEnv,
        log: (line) => log(`[mlflow-${kind}] ${line}`),
        onEvent: (event) => {
          if (event?.event === 'progress')
            run = {
              ...run,
              stage: event.stage ?? run.stage,
              done: event.done ?? run.done,
              total: event.total ?? run.total,
              name: event.name ?? run.name,
              version: event.version ?? run.version,
            };
          else if (event?.event === 'error')
            run.error = String(event.message || 'the job failed');
          onEvent(event);
        },
        onExit: ({ code, tail }) => {
          children.delete(child);
          job = null;
          if (code === 0) {
            run = { ...run, state: 'done', endedAt: now() };
            onDone();
          } else
            run = {
              ...run,
              state: 'error',
              error: run.error || tail.at(-1) || `exit ${code}`,
              endedAt: now(),
            };
          void refreshRegistry(true);
        },
      });
      children.add(child);
      job = { kind, child };
    };
    manager.started = launch().catch((error) => {
      job = null;
      run = {
        ...run,
        state: 'error',
        error: String(error?.message || error),
        endedAt: now(),
      };
    });
  };

  // --- Serving ---------------------------------------------------------------
  let serveChild = null;
  let serving = {
    state: 'off',
    name: null,
    version: null,
    error: null,
    test: null,
  };
  const serveBase = `http://127.0.0.1:${servePort}`;
  const startServing = async (name, version) => {
    if (serveChild) stopServing();
    serving = {
      state: 'starting',
      name,
      version: String(version),
      error: null,
      test: null,
      startedAt: now(),
    };
    if (!(await ensureServer())) {
      serving = {
        ...serving,
        state: 'error',
        error: server.error || 'the MLflow server is not running',
      };
      return;
    }
    const child = spawnImpl(
      python[0],
      pyArgs(
        '-m',
        'mlflow',
        'models',
        'serve',
        '-m',
        `models:/${name}/${version}`,
        '--env-manager',
        'local',
        '-h',
        '127.0.0.1',
        '-p',
        String(servePort),
      ),
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...mlflowEnv,
          MLFLOW_TRACKING_URI: trackingUri,
          MLFLOW_EXPERIMENT_NAME: MLFLOW_TRACE_EXPERIMENT,
          TF_CPP_MIN_LOG_LEVEL: '2',
        },
        ...treeSpawnOptions(platform),
      },
    );
    serveChild = child;
    const tail = [];
    const keep = (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean))
        tail.push(line);
      while (tail.length > 30) tail.shift();
    };
    child.stdout?.on?.('data', keep);
    child.stderr?.on?.('data', keep);
    const gone = (error) => {
      child.exited = true;
      if (serveChild !== child) return;
      serveChild = null;
      serving =
        serving.state === 'stopping'
          ? { state: 'off', name: null, version: null, error: null, test: null }
          : {
              ...serving,
              state: 'error',
              error: String(
                error ||
                  tail
                    .filter((l) => /error|exception|in use/i.test(l))
                    .at(-1) ||
                  tail.at(-1) ||
                  'serving stopped',
              ).slice(0, 300),
            };
    };
    child.on?.('exit', () => gone());
    child.on?.('error', (error) => gone(error?.message || error));
    const ping = async () => {
      try {
        return (await fetchImpl(`${serveBase}/ping`)).ok;
      } catch {
        return false;
      }
    };
    if (await waitReady(ping, child, READY_MS)) {
      if (serveChild === child) serving = { ...serving, state: 'running' };
    } else if (serveChild === child) {
      serving = {
        ...serving,
        state: 'error',
        error: 'the served model did not answer in time',
      };
      killTree(child);
    }
  };
  const stopServing = () => {
    if (!serveChild) {
      serving = {
        state: 'off',
        name: null,
        version: null,
        error: null,
        test: null,
      };
      return;
    }
    serving = { ...serving, state: 'stopping' };
    killTree(serveChild);
  };

  // --- Status ----------------------------------------------------------------
  const manager = {
    started: Promise.resolve(),
    serverStarted: Promise.resolve(),
    servingStarted: Promise.resolve(),
    tracker,
    status() {
      if (!installed && !probing) void probe();
      void refreshRegistry();
      return {
        installed: installed
          ? { ...installed, checking: Boolean(probing) }
          : { checking: true, mlflow: null },
        settings: persisted.settings,
        server: {
          state: server.state,
          error: server.error,
          startedAt: server.startedAt,
          held: server.held,
          url: `${MLFLOW_UI_PREFIX}/`,
          port,
        },
        tracking: {
          enabled: persisted.settings.tracking === true,
          ...tracker.status(),
        },
        registry,
        sources: sources(),
        run: { ...run, busy: busy() },
        last: persisted.last,
        serving: {
          ...serving,
          url: `${MLFLOW_SERVE_PREFIX}/invocations`,
          port: servePort,
        },
        traceExperiment: MLFLOW_TRACE_EXPERIMENT,
      };
    },
    check() {
      installed = null;
      void probe();
      return manager.status();
    },
    setSettings(body) {
      if (body?.tracking !== undefined)
        persisted.settings.tracking = body.tracking === true;
      save();
      return manager.status();
    },
    startServer() {
      manager.serverStarted = startServer({ byOwner: true }).catch((error) => {
        serverChild = null;
        server = {
          ...server,
          state: 'error',
          error: String(error?.message || error),
        };
      });
      return manager.status();
    },
    stopServer() {
      stopServer();
      return manager.status();
    },
    register({ source, name, alias } = {}) {
      const found = sources().find((s) => s.id === source);
      if (!found) throw refuse('Choose a trained model to register.');
      const clean = cleanModelName(name || found.defaultName);
      if (alias && !MLFLOW_ALIASES.includes(alias))
        throw refuse('ALIAS is champion or challenger.');
      startJob(
        'register',
        [
          'ml.gevtape.mlflow_register',
          '--tracking-uri',
          trackingUri,
          '--data',
          dataRoot,
          '--kind',
          found.kind,
          '--source',
          path.join(dataRoot, found.folder),
          '--name',
          clean,
          ...(alias ? ['--alias', alias] : []),
        ],
        {
          onEvent: (event) => {
            if (event?.event === 'registered')
              remember('register', {
                name: event.name,
                version: String(event.version),
                alias: event.alias || null,
                kind: event.kind,
                source: found.id,
              });
          },
        },
      );
      return manager.status();
    },
    async setAlias({ name, version, alias } = {}) {
      const clean = cleanModelName(name);
      if (!MLFLOW_ALIASES.includes(alias))
        throw refuse('ALIAS is champion or challenger.');
      if (!/^\d{1,6}$/.test(String(version ?? '')))
        throw refuse('Choose a version.');
      if (server.state !== 'running')
        throw refuse('Start the MLflow server first.', 409);
      await client.setAlias(clean, alias, String(version));
      await refreshRegistry(true);
      return manager.status();
    },
    evaluate() {
      startJob(
        'evaluate',
        [
          'ml.gevtape.mlflow_evaluate',
          '--tracking-uri',
          trackingUri,
          '--data',
          dataRoot,
        ],
        {
          onEvent: (event) => {
            if (event?.event === 'evaluation')
              remember('evaluate', {
                rows: Array.isArray(event.rows) ? event.rows.slice(0, 40) : [],
                best: event.best || null,
                runId: event.runId || null,
                heldOutDays: Array.isArray(event.heldOutDays)
                  ? event.heldOutDays
                  : [],
              });
          },
        },
      );
      return manager.status();
    },
    ask({ model, prompt } = {}) {
      const found = sources().find(
        (s) => s.kind === 'llm' && s.id === `llm:${model}`,
      );
      if (!found) throw refuse('Choose a trained custom LLM.');
      const question = cleanPrompt(prompt);
      startJob(
        'ask',
        [
          'ml.gevtape.llm_chat',
          '--model',
          path.join(dataRoot, found.folder),
          '--prompt',
          question,
          '--trace',
          '--tracking-uri',
          trackingUri,
          '--json',
        ],
        {
          onEvent: (event) => {
            if (event?.event === 'answer')
              remember('ask', {
                model,
                prompt: question,
                answer: String(event.answer || '').slice(0, 8000),
                traceId: event.traceId || null,
                experimentId: event.experimentId || null,
                seconds: event.seconds ?? null,
              });
          },
        },
      );
      return manager.status();
    },
    startServing({ name, version } = {}) {
      const clean = cleanModelName(name);
      if (!/^\d{1,6}$/.test(String(version ?? '')))
        throw refuse('Choose a version.');
      manager.servingStarted = startServing(clean, String(version)).catch(
        (error) => {
          serveChild = null;
          serving = {
            ...serving,
            state: 'error',
            error: String(error?.message || error),
          };
        },
      );
      return manager.status();
    },
    stopServing() {
      stopServing();
      return manager.status();
    },
    async testServing() {
      if (serving.state !== 'running') throw refuse('Nothing is served.', 409);
      const version = findVersion(serving.name, serving.version);
      const started = now();
      let test;
      try {
        const response = await fetchImpl(`${serveBase}/invocations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sampleRequest(version)),
        });
        const payload = await response.json().catch(() => ({}));
        const predictions = payload.predictions ?? payload;
        test = response.ok
          ? {
              ok: true,
              shape: shapeOf(predictions),
              answer:
                Array.isArray(predictions) && typeof predictions[0] === 'string'
                  ? predictions[0].slice(0, 2000)
                  : null,
              ms: now() - started,
            }
          : {
              ok: false,
              error: servedError(payload.message || `HTTP ${response.status}`),
            };
      } catch (error) {
        test = { ok: false, error: String(error?.message || error) };
      }
      serving = { ...serving, test };
      return manager.status();
    },
    /** Where the UI proxy sends a request, or null while the server is not up. */
    uiTarget() {
      return server.state === 'running' ? { host: '127.0.0.1', port } : null;
    },
    serveTarget() {
      return serving.state === 'running'
        ? { host: '127.0.0.1', port: servePort }
        : null;
    },
    close() {
      closed = true;
      tracker.close();
      for (const child of children) child.kill();
      job?.child.kill();
      stopServing();
      if (serverChild) {
        server = { ...server, state: 'stopping' };
        killTree(serverChild);
      }
    },
  };
  return manager;
}
