/**
 * CUSTOM LLM TRAINING, the POWER UP section's jobs (owner requests
 * 2026-10-16: "add Custom LLM to be trained under Power Up's on Dashboard ·
 * Select data sources to train from · Add any custom URL to train from · Add
 * any local sources to train from · Initialize Training", and post-training
 * "to keep the most up to date").
 *
 * INITIALIZE TRAINING fetches the custom URLs' text, builds the dataset
 * (ml.gevtape.llm_data: the ticked sources, the URLs, the local files) and
 * trains LoRA adapters on a base model already on this machine
 * (ml.gevtape.llm_train). PAUSE saves the adapters and the step, CONTINUE
 * carries on, STOP ends the run and keeps everything. With POST-TRAIN DAILY,
 * a day after the last run the dataset is rebuilt from what was recorded since
 * and the model is post-trained in place from its own adapters.
 *
 * Everything stays under .gev-data/llm/. Nothing is downloaded but the
 * custom URLs, each checked first: https only, a public address (after DNS),
 * redirects followed by hand and checked again, at most 2 MB of text.
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createChild, defaultPython } from './aiWorldJobs.mjs';
import { NO_TRACKER, trackChild } from './mlflowTrack.mjs';
import { cleanNewsUrl } from './newsUrls.mjs';
import { fetchPublic } from './publicFetch.mjs';

export const LLM_SOURCES = Object.freeze([
  Object.freeze({ id: 'news', label: 'NEWS HEADLINES', class: 'nc' }),
  Object.freeze({
    id: 'prices',
    label: 'FINANCIAL ASSET PRICES',
    class: 'unclear',
  }),
  Object.freeze({
    id: 'news-moves',
    label: 'HEADLINES → NEXT-DAY PRICE MOVES',
    class: 'nc',
  }),
  Object.freeze({
    id: 'links',
    label: 'MEASURED LAYER-ASSET LINKS',
    class: 'unclear',
  }),
  Object.freeze({
    id: 'readings',
    label: 'DATA LAYER READINGS (HOURLY BINS)',
    class: 'unclear',
  }),
  Object.freeze({ id: 'urls', label: 'CUSTOM URLS', class: 'unclear' }),
  Object.freeze({ id: 'local', label: 'LOCAL SOURCES', class: 'personal' }),
]);
const SOURCE_IDS = new Set(LLM_SOURCES.map((s) => s.id));
export const LLM_URL_MAX = 100;
export const LLM_PATH_MAX = 50;
/**
 * The base models offered (owner rulings 2026-10-16): Qwen3.5-0.8B is the
 * default, small enough for the GPU alone; Qwen3.6-35B-A3B is the large
 * option (about 72 GB, split across GPU and RAM, slow). Any other model id or
 * folder can be typed.
 */
export const LLM_BASE_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'Qwen/Qwen3.5-0.8B',
    label: 'QWEN3.5-0.8B · DEFAULT · 1.7 GB · TRAINS ON THE GPU',
  }),
  Object.freeze({
    id: 'Qwen/Qwen3.6-35B-A3B',
    label: 'QWEN3.6-35B-A3B · 72 GB · GPU + RAM · SLOW',
  }),
]);
export const LLM_DEFAULT_BASE = LLM_BASE_OPTIONS[0].id;
/** Earlier default, moved to the new one when the owner never changed it. */
const OLD_DEFAULT_BASE = 'Qwen/Qwen3-0.6B';
const URL_BYTES = 2 * 1024 * 1024;
const DAY_MS = 24 * 3_600_000;
const SCHEDULE_MS = 15 * 60_000;

const refuse = (message, status = 400) =>
  Object.assign(new Error(message), { status });

/** A model name: lower case letters, digits and dashes. */
export function cleanLlmName(raw) {
  const name = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return name || 'gev-llm';
}

/** A base model: a Hugging Face id (org/name) or a local folder. */
export function cleanBaseModel(raw) {
  const text = String(raw || '').trim();
  if (!text) return LLM_DEFAULT_BASE;
  if (/^[A-Za-z0-9][\w.-]{0,95}\/[\w.-]{1,95}$/.test(text)) return text;
  if (path.isAbsolute(text)) return path.normalize(text);
  throw refuse(
    'BASE MODEL is a Hugging Face id (org/name) or a folder on this PC.',
  );
}

/**
 * Where a base model is on this machine: a folder (one named, or
 * `.gev-data/llm/base/<name>` for a Hugging Face id), or the id when the
 * Hugging Face cache has it. Null when it is not here; nothing is downloaded.
 */
export function resolveBaseModel(base, { env = process.env, dataRoot } = {}) {
  if (path.isAbsolute(base))
    return fs.existsSync(path.join(base, 'config.json')) ? base : null;
  if (dataRoot) {
    const local = path.join(dataRoot, 'llm', 'base', base.split('/').pop());
    if (fs.existsSync(path.join(local, 'config.json'))) return local;
  }
  return baseModelOnMachine(base, env) ? base : null;
}

/** Whether a Hugging Face id (or a folder) is already on this machine. */
export function baseModelOnMachine(base, env = process.env) {
  if (path.isAbsolute(base))
    return fs.existsSync(path.join(base, 'config.json'));
  const hubs = [
    env.HF_HUB_CACHE,
    env.HF_HOME && path.join(env.HF_HOME, 'hub'),
    path.join(os.homedir(), '.cache', 'huggingface', 'hub'),
  ].filter(Boolean);
  const folder = `models--${base.replace('/', '--')}`;
  return hubs.some((hub) => {
    const snapshots = path.join(hub, folder, 'snapshots');
    try {
      return fs
        .readdirSync(snapshots)
        .some((s) => fs.existsSync(path.join(snapshots, s, 'config.json')));
    } catch {
      return false;
    }
  });
}

/**
 * A local source: an absolute path to a file or folder that exists, not this
 * app's own secrets (config/, .env, the caches) nor its training output.
 */
export function cleanLocalPath(raw, { root, dataRoot }) {
  const text = String(raw || '').trim();
  if (!text || !path.isAbsolute(text))
    throw refuse(
      'A LOCAL SOURCE is a full path to a file or folder on this PC.',
    );
  const target = path.resolve(text);
  const inside = (dir) => {
    const base = path.resolve(dir);
    return target === base || target.startsWith(base + path.sep);
  };
  const blocked = [
    path.join(root, 'config'),
    path.join(root, '.gev-cache'),
    path.join(dataRoot, 'llm'),
  ];
  if (blocked.some(inside) || /(^|[\\/])\.env/i.test(target))
    throw refuse(
      "That path holds this app's own keys or output; it is not training data.",
    );
  // A folder that holds those (the repository itself) is refused too.
  if (blocked.some((dir) => path.resolve(dir).startsWith(target + path.sep)))
    throw refuse(
      'That folder holds the app’s own keys; add the folders inside it you mean.',
    );
  if (!fs.existsSync(target)) throw refuse('Nothing at that path.');
  return target;
}

function htmlToText(raw) {
  return String(raw)
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * One custom URL's text, or an error word (publicFetch.mjs checks the
 * address and every redirect); the body stops at 2 MB.
 */
export async function fetchUrlText(
  raw,
  { fetchImpl = globalThis.fetch, lookup = dns.lookup, signal } = {},
) {
  const got = await fetchPublic(raw, {
    fetchImpl,
    lookup,
    signal,
    headers: {
      Accept:
        'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1',
    },
  });
  if (got.error) return got;
  const { url, response } = got;
  if (!response.ok) return { error: `HTTP ${response.status}` };
  const type = String(response.headers?.get?.('content-type') || '');
  if (type && !/text\/|json|xml|rss|atom/i.test(type)) {
    await response.body?.cancel?.().catch?.(() => {});
    return { error: 'NOT TEXT' };
  }
  const reader = response.body?.getReader?.();
  let text = '';
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= URL_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } else text = (await response.text()).slice(0, URL_BYTES);
  const body = /html|xml/i.test(type) ? htmlToText(text) : text.trim();
  return body ? { url, text: body } : { error: 'EMPTY' };
}

const urlFile = (urlsDir, url) =>
  path.join(
    urlsDir,
    `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.txt`,
  );

/**
 * @param {object} options
 * @param {string} options.root The repository.
 * @param {string} [options.dataRoot] .gev-data.
 */
export function createLlmTrainingManager({
  root,
  dataRoot = path.join(root, '.gev-data'),
  spawnImpl,
  python = defaultPython(),
  fetchImpl = globalThis.fetch,
  lookup = dns.lookup,
  env = process.env,
  now = () => Date.now(),
  timers = {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
  },
  log = () => {},
  /** MLFLOW TRACKING: each training run as an MLflow run (mlflowTrack.mjs). */
  tracker = NO_TRACKER,
} = {}) {
  const llmRoot = path.join(dataRoot, 'llm');
  const stateFile = path.join(llmRoot, 'state.json');
  const urlsDir = path.join(llmRoot, 'sources', 'urls');
  const read = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };
  const saved = read(stateFile, {});
  const persisted = {
    config: {
      name: 'gev-llm',
      base: LLM_DEFAULT_BASE,
      sources: ['news', 'prices', 'news-moves', 'links'],
      epochs: 1,
      postTrainFrom: '',
      daily: false,
      ...(saved.config || {}),
    },
    urls: Array.isArray(saved.urls) ? saved.urls : [],
    paths: Array.isArray(saved.paths) ? saved.paths : [],
    fetched:
      saved.fetched && typeof saved.fetched === 'object' ? saved.fetched : {},
    state: ['training', 'building', 'fetching'].includes(saved.state)
      ? 'stopped'
      : saved.state || 'idle',
    lastRunAt: saved.lastRunAt || null,
    error: saved.error || null,
  };
  // The earlier default base, never changed by the owner, becomes the new one.
  if (persisted.config.base === OLD_DEFAULT_BASE)
    persisted.config.base = LLM_DEFAULT_BASE;
  const save = () => {
    fs.mkdirSync(llmRoot, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2));
    fs.renameSync(tmp, stateFile);
  };
  let child = null;
  let stage = {
    step: null,
    steps: null,
    epoch: null,
    epochs: null,
    loss: null,
    built: null,
  };
  let pauseRequested = false;
  let abort = null;

  const modelDir = (name) => path.join(llmRoot, name, 'model');
  const dataDir = (name) => path.join(llmRoot, name, 'data');
  const models = () => {
    let names = [];
    try {
      names = fs.readdirSync(llmRoot);
    } catch {
      return [];
    }
    return names
      .map((name) => ({
        name,
        meta: read(path.join(modelDir(name), 'adapter.json'), null),
      }))
      .filter((m) => m.meta)
      .map(({ name, meta }) => ({
        name,
        base: meta.base,
        dataThrough: meta.dataThrough ?? null,
        heldOutLossBefore: meta.heldOutLossBefore ?? null,
        heldOutLossAfter: meta.heldOutLossAfter ?? null,
        helped: meta.helped === true,
        postTrainedFrom: meta.postTrainedFrom ?? null,
        classes: meta.classes || [],
        updatedAt: meta.updatedAt ?? null,
      }));
  };

  const setState = (state, error = null) => {
    persisted.state = state;
    persisted.error = error;
    save();
  };

  const runPython = (args, onEvent) =>
    new Promise((resolve) => {
      child = createChild({
        command: python[0],
        args: [...python.slice(1), ...args],
        cwd: root,
        spawnImpl,
        log: (line) => log(line),
        onEvent,
        onExit: ({ code, tail }) => {
          child = null;
          resolve({ code, tail });
        },
      });
    });

  const fetchUrls = async () => {
    fs.mkdirSync(urlsDir, { recursive: true });
    for (const url of persisted.urls) {
      if (abort?.signal.aborted) return;
      const got = await fetchUrlText(url, {
        fetchImpl,
        lookup,
        signal: abort?.signal,
      });
      if (got.text) {
        fs.writeFileSync(urlFile(urlsDir, url), `${url}\n\n${got.text}`);
        persisted.fetched[url] = {
          ok: true,
          at: now(),
          bytes: got.text.length,
        };
      } else
        persisted.fetched[url] = { ok: false, at: now(), error: got.error };
    }
    // A URL taken off the list leaves no text behind.
    const keep = new Set(
      persisted.urls.map((url) => path.basename(urlFile(urlsDir, url))),
    );
    for (const file of fs.readdirSync(urlsDir))
      if (file.endsWith('.txt') && !keep.has(file))
        fs.rmSync(path.join(urlsDir, file));
    save();
  };

  /** Fetch, build, train: one run. `postTrain` re-trains the model in place. */
  const runAll = async ({ resume = false, postTrain = false } = {}) => {
    const { name, base, sources, epochs } = persisted.config;
    abort = new AbortController();
    pauseRequested = false;
    try {
      if (!resume) {
        if (sources.includes('urls') && persisted.urls.length) {
          setState('fetching');
          await fetchUrls();
        }
        if (abort.signal.aborted) return setState('stopped');
        setState('building');
        const built = await runPython(
          [
            '-m',
            'ml.gevtape.llm_data',
            '--data',
            dataRoot,
            '--out',
            dataDir(name),
            '--sources',
            sources.join(','),
            '--urls-dir',
            urlsDir,
            ...persisted.paths.flatMap((p) => ['--path', p]),
          ],
          (event) => {
            if (event.event === 'built') stage = { ...stage, built: event };
            if (event.event === 'error')
              persisted.error = String(event.message);
          },
        );
        if (abort.signal.aborted) return setState('stopped');
        if (built.code !== 0)
          return setState(
            'error',
            persisted.error || built.tail.at(-1) || 'BUILD FAILED',
          );
      }
      setState('training');
      const from = postTrain
        ? modelDir(name)
        : persisted.config.postTrainFrom
          ? modelDir(persisted.config.postTrainFrom)
          : '';
      const trainArgs = [
        '-m',
        'ml.gevtape.llm_train',
        '--data-dir',
        dataDir(name),
        '--base',
        resolveBaseModel(base, { env, dataRoot }) || base,
        '--out',
        modelDir(name),
        '--epochs',
        String(epochs),
        ...(from && fs.existsSync(path.join(from, 'adapter.json'))
          ? ['--from', from]
          : []),
        ...(resume ? ['--resume'] : []),
      ];
      const tracked = trackChild(tracker, {
        experiment: 'ai-world/llm',
        name: `${name} ${new Date(now()).toISOString().slice(0, 16).replace('T', ' ')}`,
        args: trainArgs,
        params: { sources: sources.join(','), postTrain: String(postTrain) },
        tags: {
          'gev.model': name,
          'gev.framework': 'transformers',
          'gev.base': base,
          'mlflow.source.name': 'ml.gevtape.llm_train',
        },
      });
      const trained = await runPython(trainArgs, (event) => {
        tracked.event(event);
        if (event.event === 'progress')
          stage = {
            ...stage,
            epoch: event.epoch ?? stage.epoch,
            epochs: event.epochs ?? stage.epochs,
            step: event.step ?? stage.step,
            steps: event.steps ?? stage.steps,
            loss: event.loss ?? stage.loss,
          };
        if (event.event === 'error') persisted.error = String(event.message);
      });
      const meta = read(path.join(modelDir(name), 'adapter.json'), null);
      if (meta)
        tracked.run.log({
          ...(meta.heldOutLossBefore != null
            ? { 'held-out/loss-before': meta.heldOutLossBefore }
            : {}),
          ...(meta.heldOutLossAfter != null
            ? { 'held-out/loss-after': meta.heldOutLossAfter }
            : {}),
        });
      tracked.exit({
        code: trained.code,
        stopped: pauseRequested || abort.signal.aborted,
        files: [[path.join(modelDir(name), 'adapter.json'), 'adapter.json']],
      });
      if (pauseRequested) return setState('paused');
      if (abort.signal.aborted) return setState('stopped');
      if (trained.code !== 0)
        return setState(
          'error',
          persisted.error || trained.tail.at(-1) || 'TRAINING FAILED',
        );
      persisted.lastRunAt = now();
      setState('done');
    } finally {
      abort = null;
    }
  };

  const busy = () =>
    ['fetching', 'building', 'training'].includes(persisted.state);

  const scheduler = timers.setInterval(() => {
    if (
      persisted.config.daily &&
      !busy() &&
      ['done', 'idle', 'stopped'].includes(persisted.state) &&
      fs.existsSync(
        path.join(modelDir(persisted.config.name), 'adapter.json'),
      ) &&
      now() - (persisted.lastRunAt || 0) >= DAY_MS
    )
      void runAll({ postTrain: true });
  }, SCHEDULE_MS);
  scheduler?.unref?.();

  const manager = {
    status() {
      return {
        state: persisted.state,
        error: persisted.error,
        config: persisted.config,
        bases: LLM_BASE_OPTIONS.map((option) => ({
          ...option,
          onMachine: Boolean(resolveBaseModel(option.id, { env, dataRoot })),
        })),
        baseOnMachine: Boolean(
          resolveBaseModel(persisted.config.base, { env, dataRoot }),
        ),
        sources: LLM_SOURCES,
        urls: persisted.urls.map((url) => ({
          url,
          ...(persisted.fetched[url] || {}),
        })),
        paths: persisted.paths,
        stage,
        models: models(),
        lastRunAt: persisted.lastRunAt,
        limits: { urls: LLM_URL_MAX, paths: LLM_PATH_MAX },
      };
    },
    setConfig(body = {}) {
      if (busy()) throw refuse('Stop the run first.', 409);
      const sources = Array.isArray(body.sources)
        ? [...new Set(body.sources.filter((s) => SOURCE_IDS.has(s)))]
        : persisted.config.sources;
      const epochs = Math.max(
        1,
        Math.min(
          20,
          Math.round(Number(body.epochs) || persisted.config.epochs),
        ),
      );
      const from = cleanLlmName(body.postTrainFrom || '');
      persisted.config = {
        name:
          body.name === undefined
            ? persisted.config.name
            : cleanLlmName(body.name),
        base:
          body.base === undefined
            ? persisted.config.base
            : cleanBaseModel(body.base),
        sources,
        epochs,
        postTrainFrom:
          body.postTrainFrom &&
          fs.existsSync(path.join(modelDir(from), 'adapter.json'))
            ? from
            : '',
        daily:
          body.daily === undefined
            ? persisted.config.daily
            : body.daily === true,
      };
      save();
      return manager.status();
    },
    addUrl(raw) {
      const url = cleanNewsUrl(raw);
      if (!url) throw refuse('A custom URL is a public https address.');
      if (!persisted.urls.includes(url)) {
        if (persisted.urls.length >= LLM_URL_MAX)
          throw refuse(`At most ${LLM_URL_MAX} URLs.`, 409);
        persisted.urls.push(url);
        save();
      }
      return manager.status();
    },
    removeUrl(raw) {
      const url = cleanNewsUrl(raw) || String(raw || '');
      persisted.urls = persisted.urls.filter((u) => u !== url);
      delete persisted.fetched[url];
      try {
        fs.rmSync(urlFile(urlsDir, url), { force: true });
      } catch {
        /* nothing saved for it */
      }
      save();
      return manager.status();
    },
    addPath(raw) {
      const target = cleanLocalPath(raw, { root, dataRoot });
      if (!persisted.paths.includes(target)) {
        if (persisted.paths.length >= LLM_PATH_MAX)
          throw refuse(`At most ${LLM_PATH_MAX} local sources.`, 409);
        persisted.paths.push(target);
        save();
      }
      return manager.status();
    },
    removePath(raw) {
      const target = path.resolve(String(raw || ''));
      persisted.paths = persisted.paths.filter((p) => p !== target);
      save();
      return manager.status();
    },
    initialize() {
      if (busy()) throw refuse('A run is going already.', 409);
      if (!persisted.config.sources.length)
        throw refuse('Tick at least one data source.');
      if (!resolveBaseModel(persisted.config.base, { env, dataRoot }))
        throw refuse(
          `BASE MODEL NOT ON THIS MACHINE: ${persisted.config.base}. Put it in the Hugging Face cache or a folder first; nothing is downloaded here.`,
        );
      void runAll();
      return manager.status();
    },
    pause() {
      if (persisted.state !== 'training' || !child)
        throw refuse('Nothing is training.', 409);
      pauseRequested = true;
      child.send({ cmd: 'pause' });
      return manager.status();
    },
    continue() {
      if (persisted.state !== 'paused') throw refuse('Nothing is paused.', 409);
      void runAll({ resume: true });
      return manager.status();
    },
    stop() {
      if (!busy() && persisted.state !== 'paused') return manager.status();
      abort?.abort();
      if (child) child.send({ cmd: 'stop' });
      if (!child) setState('stopped');
      return manager.status();
    },
    close() {
      timers.clearInterval(scheduler);
      abort?.abort();
      child?.kill();
    },
  };
  return manager;
}
