/**
 * The AI World tab's four TENSORFLOW sections (owner request 2026-10-17:
 * "include tensorflow functions in AI world tab as seperate expandape options
 * within the tab"; ruling the same day: all four, Python 3.13, the GPU
 * through WSL2):
 *
 *   TENSORFLOW TRAINING            ml.gevtape.tf_train: a Keras world model
 *                                  on the kit's bins, scored against
 *                                  persistence as the kit's own model is
 *   TENSORBOARD                    the training curves of every trainer, the
 *                                  kit's PyTorch ones and these, served
 *                                  through /api/tensorflow/board/
 *   EXPORT FOR TENSORFLOW          ml.gevtape.tf_export: a TFRecord dataset,
 *                                  the model as a SavedModel and as TFLite
 *   POST-TRAIN A TENSORFLOW MODEL  ml.gevtape.tf_posttrain with a Keras
 *                                  adapter (ml/adapters/keras_world.py)
 *
 * Where a job runs: TensorFlow has had no GPU on native Windows since 2.11,
 * so it goes to WSL2 when the Python that scripts/tensorflow-wsl-setup.sh
 * made answers (scripts/tensorflow-wsl-run.sh puts the CUDA wheels on the
 * library path), else to the Windows Python 3.13 on the CPU. Both are asked
 * once at start (ml.gevtape.tf_probe) and again on CHECK AGAIN. One job at a
 * time: they share the GPU with the kit's own trainer (TensorFlow takes GPU
 * memory as it needs it, not the whole card).
 *
 * Nothing here deletes anything: an export goes to a new folder, a model is
 * written over in place, and there is no removal route.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cleanPostTrain, createChild, defaultPython } from './aiWorldJobs.mjs';
import { NO_TRACKER, trackChild } from './mlflowTrack.mjs';

export const TENSORFLOW_API = '/api/tensorflow';
/** Where TensorBoard is served, through the dev server. */
export const TENSORBOARD_PREFIX = `${TENSORFLOW_API}/board`;
export const TF_JOB_KINDS = Object.freeze(['train', 'export', 'posttrain']);
export const TF_EXPORT_CLASSES = Object.freeze(['all', 'open']);
export const TF_DEFAULT_ADAPTER = 'keras_world:KerasWorldAdapter';
const EPOCHS_MAX = 200;
const PROBE_MS = 120_000;
const STOP_KILL_MS = 120_000;
const MODULES = Object.freeze({
  train: 'ml.gevtape.tf_train',
  export: 'ml.gevtape.tf_export',
  posttrain: 'ml.gevtape.tf_posttrain',
});

const refuse = (message, status = 400) =>
  Object.assign(new Error(message), { status });

/** A Windows path as WSL2 sees it (A:\x\y -> /mnt/a/x/y); null when it has no drive. */
export function toWslPath(raw) {
  const match = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(String(raw || ''));
  if (!match) return null;
  return `/mnt/${match[1].toLowerCase()}/${String(match[2] || '').replace(/\\/g, '/')}`;
}

/**
 * Which runner trains: WSL2 when it has TensorFlow and a GPU, else the
 * Windows Python when it has TensorFlow, else WSL2 on its CPU. GEV_TF_RUNNER
 * (wsl, windows) overrides when that runner has TensorFlow.
 * @param {{wsl?: object|null, windows?: object|null}} probes
 */
export function pickRunner(probes, wanted = '') {
  const has = (p) => Boolean(p?.tensorflow);
  if (wanted === 'wsl' && has(probes.wsl)) return 'wsl';
  if (wanted === 'windows' && has(probes.windows)) return 'windows';
  if (has(probes.wsl) && (probes.wsl.gpus || []).length) return 'wsl';
  if (has(probes.windows)) return 'windows';
  if (has(probes.wsl)) return 'wsl';
  return null;
}

/** The settings the tab may change, cleaned. */
export function cleanTfSettings(raw, current) {
  const out = { ...current };
  if (raw?.epochs !== undefined) {
    const epochs = Math.round(Number(raw.epochs));
    if (!Number.isFinite(epochs) || epochs < 1 || epochs > EPOCHS_MAX)
      throw refuse(`EPOCHS is 1 to ${EPOCHS_MAX}.`);
    out.epochs = epochs;
  }
  if (raw?.device !== undefined) {
    if (!['auto', 'cpu'].includes(raw.device))
      throw refuse('DEVICE is auto or cpu.');
    out.device = raw.device;
  }
  if (raw?.classes !== undefined) {
    if (!TF_EXPORT_CLASSES.includes(raw.classes))
      throw refuse('CLASSES is all or open.');
    out.classes = raw.classes;
  }
  if (raw?.withModel !== undefined) out.withModel = raw.withModel === true;
  return out;
}

/** The export folder name for a moment: 2026-10-17T12-30-05Z. */
export function exportStamp(ms) {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-');
}

/**
 * @param {object} options
 * @param {string} options.root The repository.
 * @param {string} [options.dataRoot] .gev-data.
 */
export function createTensorflowManager({
  root,
  dataRoot = path.join(root, '.gev-data'),
  env = process.env,
  platform = process.platform,
  python = String(env.GEV_TF_PYTHON || '').trim()
    ? String(env.GEV_TF_PYTHON).trim().split(/\s+/)
    : defaultPython(env, platform),
  distro = String(env.GEV_WSL_DISTRO || '').trim() || 'Ubuntu',
  boardPort = Number(env.GEV_TENSORBOARD_PORT) || 6006,
  spawnImpl = nodeSpawn,
  now = () => Date.now(),
  timers = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  },
  log = () => {},
  /** Windows paths as WSL2 sees them (a seam for tests). */
  wslPath = toWslPath,
  /** MLFLOW TRACKING: each job as an MLflow run (mlflowTrack.mjs). */
  tracker = NO_TRACKER,
} = {}) {
  const tfRoot = path.join(dataRoot, 'ai-world', 'tensorflow');
  const stateFile = path.join(tfRoot, 'state.json');
  const trainDir = path.join(tfRoot, 'models', 'tf-world');
  const exportsDir = path.join(tfRoot, 'exports');
  const posttrainDir = path.join(tfRoot, 'posttrain');
  // Shared with the kit's trainer (server/shared/aiWorldJobs.mjs).
  const boardDir = path.join(dataRoot, 'ai-world', 'tensorboard');
  const wslScript = path.join(root, 'scripts', 'tensorflow-wsl-run.sh');
  const read = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };
  const saved = read(stateFile, {});
  const persisted = {
    settings: cleanTfSettings(saved.settings || {}, {
      epochs: 10,
      device: 'auto',
      classes: 'all',
      withModel: true,
    }),
    posttrain: {
      adapter: TF_DEFAULT_ADAPTER,
      checkpoint: path.relative(dataRoot, trainDir),
      epochs: 1,
      ...(saved.posttrain || {}),
    },
    last: saved.last && typeof saved.last === 'object' ? saved.last : {},
  };
  const save = () => {
    fs.mkdirSync(tfRoot, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2));
    fs.renameSync(tmp, stateFile);
  };

  // --- Runners ----------------------------------------------------------------
  const probes = { wsl: null, windows: null };
  let probing = null;
  let checkedAt = null;
  // WSL2 only on Windows, and only when the repository and the data have a
  // drive letter WSL2 mounts (/mnt/<drive>); a network path stays on Windows.
  const wslUsable =
    platform === 'win32' &&
    Boolean(wslPath(root)) &&
    Boolean(wslPath(dataRoot));
  /** The command and arguments for a module on a runner (paths moved for WSL). */
  const command = (runner, module, args) => {
    if (runner === 'wsl')
      return {
        command: 'wsl.exe',
        args: [
          '-d',
          distro,
          '--exec',
          'bash',
          wslPath(wslScript),
          '-m',
          module,
          ...args.map((a) => (typeof a === 'object' ? wslPath(a.path) : a)),
        ],
      };
    return {
      command: python[0],
      args: [
        ...python.slice(1),
        '-m',
        module,
        ...args.map((a) => (typeof a === 'object' ? a.path : a)),
      ],
    };
  };
  const probeChildren = new Set();
  let closed = false;
  const probeOne = (runner) =>
    new Promise((resolve) => {
      let found = null;
      const { command: cmd, args } = command(runner, 'ml.gevtape.tf_probe', []);
      const child = createChild({
        command: cmd,
        args,
        cwd: root,
        spawnImpl,
        log: (line) => log(`[tf-probe ${runner}] ${line}`),
        onEvent: (event) => {
          if (event?.event === 'probe') found = event;
        },
        onExit: ({ tail }) => {
          timers.clearTimeout(timer);
          probeChildren.delete(child);
          resolve(
            found
              ? {
                  python: found.python || null,
                  tensorflow: found.tensorflow || null,
                  tensorboard: found.tensorboard || null,
                  gpus: Array.isArray(found.gpus) ? found.gpus : [],
                  error: found.error || null,
                }
              : {
                  tensorflow: null,
                  gpus: [],
                  error: tail.at(-1) || 'no answer',
                },
          );
        },
      });
      probeChildren.add(child);
      const timer = timers.setTimeout(() => child.kill(), PROBE_MS);
      timer?.unref?.();
    });
  const check = () => {
    if (probing || closed) return probing || Promise.resolve(probes);
    probing = Promise.all([
      wslUsable ? probeOne('wsl') : Promise.resolve(null),
      probeOne('windows'),
    ]).then(([wsl, windows]) => {
      probes.wsl = wsl;
      probes.windows = windows;
      checkedAt = now();
      probing = null;
      return probes;
    });
    return probing;
  };
  const runner = () =>
    pickRunner(probes, String(env.GEV_TF_RUNNER || '').trim());

  // --- Jobs ---------------------------------------------------------------------
  let job = null; // { kind, child, stopping, killTimer }
  let run = { kind: null, state: 'idle' };
  const busy = () => Boolean(job) || run.state === 'starting';

  const finish = (state, extra = {}) => {
    const kind = run.kind;
    run = { ...run, ...extra, state, endedAt: now() };
    if (kind) {
      persisted.last[kind] = {
        state,
        at: now(),
        runner: run.runner || null,
        device: run.device || null,
        error: run.error || null,
        ...(run.result || {}),
      };
      save();
    }
  };

  const argsFor = (kind, resume) => {
    const s = persisted.settings;
    if (kind === 'train')
      return [
        '--data',
        { path: dataRoot },
        '--out',
        { path: trainDir },
        '--epochs',
        String(s.epochs),
        '--device',
        s.device,
        '--tensorboard',
        { path: path.join(boardDir, 'tf-world') },
        ...(resume ? ['--resume'] : []),
      ];
    if (kind === 'posttrain') {
      const p = persisted.posttrain;
      return [
        '--data',
        { path: dataRoot },
        '--adapter',
        p.adapter,
        '--checkpoint',
        { path: path.resolve(dataRoot, p.checkpoint) },
        '--out',
        { path: posttrainDir },
        '--epochs',
        String(p.epochs || 1),
        '--device',
        s.device,
        '--tensorboard',
        { path: path.join(boardDir, 'tf-posttrain') },
        ...(resume ? ['--resume'] : []),
      ];
    }
    const out = path.join(exportsDir, exportStamp(now()));
    run.out = out;
    return [
      '--data',
      { path: dataRoot },
      '--out',
      { path: out },
      '--classes',
      s.classes === 'open' ? 'open' : 'open,nc,restricted,unclear,personal',
      '--model',
      { path: trainDir },
      ...(s.withModel ? [] : ['--no-model']),
    ];
  };

  const onEvent = (event) => {
    const e = event || {};
    if (e.event === 'progress') {
      run = {
        ...run,
        state: 'running',
        epoch: e.epoch ?? run.epoch ?? null,
        epochs: e.epochs ?? run.epochs ?? null,
        step: e.step ?? run.step ?? null,
        loss: e.loss ?? run.loss ?? null,
        stage: e.stage ?? run.stage ?? null,
        done: e.done ?? run.done ?? null,
        total: e.total ?? run.total ?? null,
        device: e.device ?? run.device ?? null,
        tensorflow: e.tensorflow ?? run.tensorflow ?? null,
        channelsGrown: e.channelsGrown === true || run.channelsGrown === true,
        channelMismatch:
          e.channelMismatch === true || run.channelMismatch === true,
      };
    } else if (e.event === 'metrics') {
      run.result = {
        ...(run.result || {}),
        skill: e.skill ?? null,
        domains: e.domains && typeof e.domains === 'object' ? e.domains : null,
        inSample: e.inSample === true,
        epoch: e.epoch ?? null,
      };
    } else if (e.event === 'posttrain') {
      run.result = {
        ...(run.result || {}),
        helped: e.helped === true,
        before: e.before ?? null,
        after: e.after ?? null,
      };
    } else if (e.event === 'export') {
      run.result = {
        ...(run.result || {}),
        out: e.out ?? run.out ?? null,
        days: e.days ?? null,
        entries: e.entries ?? null,
        files: e.files ?? null,
        publishable: e.publishable === true,
        datasetClasses: Array.isArray(e.datasetClasses) ? e.datasetClasses : [],
        model: e.model === true,
        tfliteOk: e.tfliteOk ?? null,
      };
    } else if (e.event === 'paused') run.paused = true;
    else if (e.event === 'error')
      run.error = String(e.message || 'the job failed');
  };

  /**
   * Starts a job: refused at once when one runs, else STARTING while the
   * runners are asked (the first time), then the child. Resolves when it is
   * launched or has failed to.
   */
  const start = (kind, { resume = false } = {}) => {
    if (busy()) throw refuse('A TensorFlow job is running already.', 409);
    run = { kind, state: 'starting', startedAt: now(), error: null };
    return launch(kind, resume).catch((error) => {
      job = null;
      run = {
        ...run,
        state: 'error',
        error: String(error?.message || error),
        endedAt: now(),
      };
    });
  };
  const launch = async (kind, resume) => {
    await (probing || (checkedAt ? null : check()));
    const where = runner();
    if (!where) {
      run = {
        kind,
        state: 'error',
        error:
          'NO TENSORFLOW: run npm run tensorflow:wsl-setup (GPU, WSL2) or py -3.13 -m pip install tensorflow (CPU)',
        endedAt: now(),
      };
      return;
    }
    run.runner = where;
    const { command: cmd, args } = command(
      where,
      MODULES[kind],
      argsFor(kind, resume),
    );
    const exportOut = run.out;
    const tracked = trackChild(tracker, {
      experiment: `ai-world/tensorflow-${kind}`,
      name: `tensorflow ${kind} ${new Date(now()).toISOString().slice(0, 16).replace('T', ' ')}`,
      args,
      tags: {
        'gev.model': `tensorflow-${kind}`,
        'gev.framework': 'tensorflow',
        'gev.runner': where,
        'mlflow.source.name': MODULES[kind],
      },
    });
    const artifactFiles = () =>
      kind === 'train'
        ? ['metrics.json', 'manifest.json'].map((n) => [
            path.join(trainDir, n),
            n,
          ])
        : kind === 'posttrain'
          ? [[path.join(posttrainDir, 'metrics.json'), 'metrics.json']]
          : exportOut
            ? ['tensorflow.json', 'TENSORFLOW.md'].map((n) => [
                path.join(exportOut, n),
                n,
              ])
            : [];
    const child = createChild({
      command: cmd,
      args,
      cwd: root,
      spawnImpl,
      log: (line) => log(`[tf-${kind}] ${line}`),
      onEvent: (event) => {
        tracked.event(event);
        onEvent(event);
      },
      onExit: ({ code, tail }) => {
        const stopping = job?.stopping === true;
        tracked.exit({ code, stopped: stopping, files: artifactFiles() });
        timers.clearTimeout(job?.killTimer);
        job = null;
        if (run.paused) finish('paused');
        else if (code === 0) finish(stopping ? 'stopped' : 'done');
        else if (stopping) finish('stopped');
        else
          finish('error', {
            error: run.error || tail.at(-1) || `exit ${code}`,
          });
      },
    });
    job = { kind, child, stopping: false, killTimer: null };
  };

  // --- TensorBoard --------------------------------------------------------------
  let boardChild = null;
  let board = { state: 'off', error: null, runner: null, startedAt: null };
  const boardRuns = () => {
    let names = [];
    try {
      names = fs.readdirSync(boardDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.sort()) {
      let newest = 0;
      try {
        for (const file of fs.readdirSync(path.join(boardDir, name)))
          if (file.includes('tfevents'))
            newest = Math.max(
              newest,
              fs.statSync(path.join(boardDir, name, file)).mtimeMs,
            );
      } catch {
        continue;
      }
      if (newest) out.push({ name, updatedAt: Math.round(newest) });
    }
    return out;
  };
  const startBoard = async () => {
    if (boardChild || board.state === 'starting') return;
    board = { state: 'starting', error: null, runner: null, startedAt: now() };
    await (probing || (checkedAt ? null : check()));
    const where = probes.windows?.tensorboard
      ? 'windows'
      : probes.wsl?.tensorboard
        ? 'wsl'
        : null;
    if (!where) {
      board = {
        ...board,
        state: 'error',
        error: 'NO TENSORBOARD: py -3.13 -m pip install tensorboard',
      };
      return;
    }
    fs.mkdirSync(boardDir, { recursive: true });
    const { command: cmd, args } = command(where, 'tensorboard.main', [
      '--logdir',
      { path: boardDir },
      '--host',
      '127.0.0.1',
      '--port',
      String(boardPort),
      '--path_prefix',
      TENSORBOARD_PREFIX,
      '--reload_interval',
      '15',
    ]);
    const child = spawnImpl(cmd, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...env, TF_CPP_MIN_LOG_LEVEL: '3' },
    });
    boardChild = child;
    board.runner = where;
    const tail = [];
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        tail.push(line);
        if (/^TensorBoard \S+ at http/.test(line.trim()))
          board = { ...board, state: 'running' };
      }
      while (tail.length > 20) tail.shift();
    });
    child.stdout?.on?.('data', () => {});
    const gone = (error) => {
      if (boardChild !== child) return;
      boardChild = null;
      board =
        board.state === 'stopping'
          ? { state: 'off', error: null, runner: null, startedAt: null }
          : {
              ...board,
              state: 'error',
              error: String(
                error ||
                  tail
                    .filter((l) => /error|could not|in use/i.test(l))
                    .at(-1) ||
                  tail.at(-1) ||
                  'TensorBoard stopped',
              ),
            };
    };
    child.on?.('exit', () => gone());
    child.on?.('error', (error) => gone(error?.message || error));
  };
  const stopBoard = () => {
    if (!boardChild) {
      board = { state: 'off', error: null, runner: null, startedAt: null };
      return;
    }
    board = { ...board, state: 'stopping' };
    try {
      boardChild.kill();
    } catch {
      /* gone */
    }
  };

  // --- Status -------------------------------------------------------------------
  const runnerStatus = () => {
    const where = runner();
    const probe = where ? probes[where] : null;
    return {
      checking: Boolean(probing),
      checkedAt,
      kind: where,
      distro: where === 'wsl' ? distro : null,
      python: probe?.python || null,
      tensorflow: probe?.tensorflow || null,
      gpu: (probe?.gpus || [])[0] || null,
      wsl: wslUsable
        ? probes.wsl
          ? {
              tensorflow: probes.wsl.tensorflow,
              gpus: probes.wsl.gpus,
              error: probes.wsl.error,
            }
          : null
        : null,
      windows: probes.windows
        ? {
            tensorflow: probes.windows.tensorflow,
            gpus: probes.windows.gpus,
            error: probes.windows.error,
          }
        : null,
    };
  };
  const trainedModel = () => {
    const metrics = read(path.join(trainDir, 'metrics.json'), null);
    const state = read(path.join(trainDir, 'state.json'), null);
    if (!state && !metrics) return null;
    return {
      epoch: state?.epoch ?? metrics?.epoch ?? null,
      step: state?.step ?? null,
      device: state?.device ?? metrics?.device ?? null,
      channels: (state?.task?.channels || []).length || null,
      skill: metrics?.skill ?? null,
      domains: metrics?.domains ?? null,
      heldOutDays: metrics?.heldOutDays ?? [],
      inSample: metrics?.inSample === true,
      updatedAt: metrics?.updatedAt ?? state?.savedAt ?? null,
      folder: path.relative(dataRoot, trainDir),
      paused: Boolean(state && state.stepInEpoch > 0),
    };
  };
  const posttrained = () => {
    const metrics = read(path.join(posttrainDir, 'metrics.json'), null);
    const state = read(path.join(posttrainDir, 'posttrain-state.json'), null);
    return metrics || state
      ? {
          helped: metrics?.helped === true,
          before: metrics?.heldOutLossBefore ?? null,
          after: metrics?.heldOutLossAfter ?? null,
          trainedThrough: metrics?.trainedThrough ?? null,
          updatedAt: metrics?.updatedAt ?? null,
          folder: path.relative(dataRoot, path.join(posttrainDir, 'model')),
          paused: Boolean(state && state.step > 0),
        }
      : null;
  };
  const exports = () => {
    let names = [];
    try {
      names = fs.readdirSync(exportsDir).sort().reverse();
    } catch {
      return [];
    }
    return names.slice(0, 5).map((name) => {
      const summary = read(
        path.join(exportsDir, name, 'tensorflow.json'),
        null,
      );
      return {
        name,
        folder: path.relative(dataRoot, path.join(exportsDir, name)),
        complete: Boolean(summary),
        days: summary?.days?.length ?? null,
        places: summary?.places ?? null,
        channels: summary?.channels ?? null,
        files: summary?.files?.length ?? null,
        bytes: summary?.files
          ? summary.files.reduce((n, f) => n + (Number(f.bytes) || 0), 0)
          : null,
        publishable: summary?.publishable === true,
        model: Boolean(summary?.model),
        tfliteOk: summary?.model?.tflite?.ok ?? null,
      };
    });
  };

  // The runners are asked when the tab first asks for the status (or a job
  // starts), not when the server starts: a server that never shows the tab,
  // such as a test server, starts no Python.
  const manager = {
    started: Promise.resolve(),
    boardStarted: Promise.resolve(),
    status() {
      if (!checkedAt && !probing) void check();
      return {
        runner: runnerStatus(),
        run: { ...run, busy: busy() },
        settings: persisted.settings,
        posttrain: persisted.posttrain,
        last: persisted.last,
        model: trainedModel(),
        posttrained: posttrained(),
        exports: exports(),
        board: {
          ...board,
          url: `${TENSORBOARD_PREFIX}/`,
          port: boardPort,
          runs: boardRuns(),
        },
      };
    },
    check() {
      void check();
      return manager.status();
    },
    setSettings(body) {
      persisted.settings = cleanTfSettings(body || {}, persisted.settings);
      if (body?.posttrain !== undefined) {
        const clean = cleanPostTrain(
          {
            adapter: body.posttrain?.adapter || TF_DEFAULT_ADAPTER,
            checkpoint: body.posttrain?.checkpoint,
          },
          { root, dataRoot },
        );
        const epochs = Math.round(Number(body.posttrain?.epochs ?? 1));
        if (!Number.isFinite(epochs) || epochs < 1 || epochs > 20)
          throw refuse('POST-TRAIN EPOCHS is 1 to 20.');
        persisted.posttrain = {
          adapter: clean.adapter,
          checkpoint: path.relative(dataRoot, clean.checkpoint) || '.',
          epochs,
        };
      }
      save();
      return manager.status();
    },
    /** Each start answers at once (STARTING); `started` settles once it has launched. */
    train({ fresh = false } = {}) {
      const resume = !fresh && fs.existsSync(path.join(trainDir, 'state.json'));
      manager.started = start('train', { resume });
      return manager.status();
    },
    exportNow() {
      manager.started = start('export');
      return manager.status();
    },
    postTrain() {
      const checkpoint = path.resolve(dataRoot, persisted.posttrain.checkpoint);
      if (!fs.existsSync(checkpoint))
        throw refuse(
          'No model at that CHECKPOINT yet: train one in TENSORFLOW TRAINING first, or name another.',
        );
      manager.started = start('posttrain');
      return manager.status();
    },
    pause() {
      if (!job || job.kind === 'export') throw refuse('Nothing to pause.', 409);
      job.child.send({ cmd: 'pause' });
      return manager.status();
    },
    continue() {
      if (
        job ||
        run.state !== 'paused' ||
        !['train', 'posttrain'].includes(run.kind)
      )
        throw refuse('Nothing is paused.', 409);
      manager.started = start(run.kind, { resume: true });
      return manager.status();
    },
    stop() {
      if (!job) {
        if (run.state === 'paused') finish('stopped');
        return manager.status();
      }
      job.stopping = true;
      if (job.kind === 'export') job.child.kill();
      else {
        job.child.send({ cmd: 'stop' });
        const child = job.child;
        job.killTimer = timers.setTimeout(() => child.kill(), STOP_KILL_MS);
        job.killTimer?.unref?.();
      }
      return manager.status();
    },
    startBoard() {
      manager.boardStarted = startBoard().catch((error) => {
        boardChild = null;
        board = {
          ...board,
          state: 'error',
          error: String(error?.message || error),
        };
      });
      return manager.status();
    },
    stopBoard() {
      stopBoard();
      return manager.status();
    },
    /** Where the board proxy sends a request, or null while it is not up. */
    boardTarget() {
      return board.state === 'running'
        ? { host: '127.0.0.1', port: boardPort }
        : null;
    },
    close() {
      closed = true;
      for (const child of probeChildren) child.kill();
      job?.child.kill();
      stopBoard();
    },
  };
  return manager;
}
