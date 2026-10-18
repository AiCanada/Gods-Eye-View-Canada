/**
 * The TENSORFLOW sections of the ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM
 * tab (owner request 2026-10-17: "include tensorflow functions in AI world tab
 * as seperate expandape options within the tab"; ruling: all four, Python
 * 3.13, the GPU through WSL2). Each is its own expandable section:
 *
 *   TENSORFLOW TRAINING            a Keras world model on the same bins,
 *                                  scored against persistence
 *   TENSORBOARD                    the training curves of every trainer
 *   EXPORT FOR TENSORFLOW          TFRecord dataset, SavedModel, TFLite
 *   POST-TRAIN A TENSORFLOW MODEL  a Keras model brought up to date
 *
 * Above them: where the jobs run (the GPU through WSL2, else the CPU) and the
 * one job that runs at a time, with PAUSE / CONTINUE and STOP. The routes are
 * /api/tensorflow (server/providers/tensorflow.js). The sections are built
 * once and updated in place, so an open section stays open and a box being
 * typed in keeps its text while the status polls.
 *
 * The text is marked with tl() and tln(): Quebec French, Inuktitut and
 * Ancient Egyptian in the fork locales, English in every other.
 */
import { agoLabel, formatBytes, formatCount } from './aiWorldSelection.mjs';
import { localDigits, msgl, tl, tln } from './i18n/index.js';

export const TENSORFLOW_API = '/api/tensorflow';
const POLL_BUSY_MS = 3_000;
const POLL_IDLE_MS = 15_000;
/** The adapter for the Keras model TENSORFLOW TRAINING makes (a code name, never translated). */
const DEFAULT_ADAPTER = 'keras_world:KerasWorldAdapter';

/** The four sections, in the order the tab shows them. */
export const TF_SECTIONS = Object.freeze([
  Object.freeze({ id: 'train', title: msgl('TENSORFLOW TRAINING') }),
  Object.freeze({ id: 'board', title: msgl('TENSORBOARD') }),
  Object.freeze({ id: 'export', title: msgl('EXPORT FOR TENSORFLOW') }),
  Object.freeze({
    id: 'posttrain',
    title: msgl('POST-TRAIN A TENSORFLOW MODEL'),
  }),
]);

const JOB_NAMES = Object.freeze({
  train: msgl('TENSORFLOW TRAINING'),
  export: msgl('EXPORT FOR TENSORFLOW'),
  posttrain: msgl('POST-TRAIN A TENSORFLOW MODEL'),
});
const STATE_NAMES = Object.freeze({
  idle: msgl('IDLE'),
  starting: msgl('STARTING'),
  running: msgl('RUNNING'),
  paused: msgl('PAUSED'),
  stopped: msgl('STOPPED'),
  done: msgl('DONE'),
  error: msgl('ERROR'),
});
const EXPORT_STAGES = Object.freeze({
  dataset: msgl('COPYING THE BINS'),
  tfrecord: msgl('WRITING TFRECORDS'),
  savedmodel: msgl('WRITING THE SAVEDMODEL'),
  tflite: msgl('CONVERTING TO TFLITE'),
});
const DOMAIN_NAMES = Object.freeze({
  mobility: msgl('MOBILITY'),
  weather: msgl('WEATHER'),
  hazards: msgl('HAZARDS'),
  news: msgl('NEWS'),
  markets: msgl('PRICE MOVES'),
});

const num = (v) =>
  v === null || v === undefined || v === '' ? NaN : Number(v);
/** Three significant digits: these losses and errors are often 0.000172. */
const sig = (v) => localDigits(Number(v).toPrecision(3));
const upper = (v) => String(v ?? '').toUpperCase();

/** MAE 0.000418 VS PERSISTENCE 0.000249, or '' without a score. */
export function tfSkillText(skill) {
  const model = num(skill?.model);
  const persistence = num(skill?.persistence);
  if (!Number.isFinite(model) || !Number.isFinite(persistence)) return '';
  return tl('MAE {model} VS PERSISTENCE {persistence}', {
    model: sig(model),
    persistence: sig(persistence),
  });
}

/** Where the jobs run: the GPU through WSL2, the CPU, or how to set it up. */
export function tfRunnerText(runner) {
  if (!runner || (runner.checking && !runner.kind && !runner.checkedAt))
    return tl('RUNS ON · CHECKING THIS PC');
  if (!runner.kind)
    return tl(
      'RUNS ON · NO TENSORFLOW YET: npm run tensorflow:wsl-setup (GPU, WSL2) or py -3.13 -m pip install tensorflow (CPU)',
    );
  const where =
    runner.kind === 'wsl'
      ? tl('WSL2 {distro}', { distro: upper(runner.distro || 'Ubuntu') })
      : tl('WINDOWS');
  const device = runner.gpu
    ? tl('GPU {name}', { name: runner.gpu })
    : tl('CPU ONLY');
  const text = tl(
    'RUNS ON · {device} · {where} · PYTHON {python} · TENSORFLOW {tensorflow}',
    {
      device,
      where,
      python: runner.python || '?',
      tensorflow: runner.tensorflow || '?',
    },
  );
  const hint =
    !runner.gpu && runner.wsl && !runner.wsl.tensorflow
      ? ` · ${tl('FOR THE GPU: npm run tensorflow:wsl-setup')}`
      : '';
  return `${text}${hint}`;
}

/** The one job: which, its state, where it is. */
export function tfRunText(run) {
  const kind = run?.kind;
  const state = run?.state || 'idle';
  const stateName = STATE_NAMES[state] ? tl(STATE_NAMES[state]) : upper(state);
  if (!kind) return tl('JOB · NONE YET');
  const name = tl(JOB_NAMES[kind] || upper(kind));
  if (state === 'error')
    return tl('{job} · ERROR · {error}', {
      job: name,
      error: upper(run.error || tl('THE JOB FAILED')),
    });
  const parts = [`${name} · ${stateName}`];
  if (kind === 'export' && state === 'running' && run.stage) {
    const stage = EXPORT_STAGES[run.stage];
    parts.push(stage ? tl(stage) : upper(run.stage));
    if (run.stage === 'tfrecord' && Number.isFinite(num(run.done)))
      parts.push(
        tl('DAY {done}/{total}', { done: run.done, total: run.total ?? '?' }),
      );
  }
  if (kind !== 'export' && Number.isFinite(num(run.epoch)) && run.epoch > 0)
    parts.push(
      tl('EPOCH {epoch}/{epochs}', {
        epoch: run.epoch,
        epochs: run.epochs ?? '?',
      }),
    );
  if (Number.isFinite(num(run.step)))
    parts.push(tl('STEP {step}', { step: formatCount(run.step) }));
  if (Number.isFinite(num(run.loss)))
    parts.push(tl('LOSS {loss}', { loss: sig(run.loss) }));
  if (run.channelsGrown) parts.push(tl('GREW TO THE NEW CHANNELS'));
  else if (run.channelMismatch)
    parts.push(tl('NEW MODEL: THE CHANNELS CHANGED'));
  if (run.device && state === 'running') parts.push(upper(run.device));
  return parts.join(' · ');
}

/** Which buttons the state allows. */
export function tfControlStates(status) {
  const run = status?.run || {};
  const busy = run.busy === true;
  const ready = Boolean(status?.runner?.kind);
  const paused = !busy && run.state === 'paused';
  return {
    start: ready && !busy && !paused,
    pause: busy && run.state === 'running' && run.kind !== 'export',
    continue: paused,
    stop: busy || paused,
    posttrain: ready && !busy && !paused,
  };
}

/** The trained Keras model: its score, then one line per scored domain. */
export function tfModelLines(model, nowMs = Date.now()) {
  if (!model) return [tl('NO TENSORFLOW MODEL YET: TRAIN ONE')];
  const skill = tfSkillText(model.skill);
  const head = [
    tl('MODEL · EPOCH {epoch}', { epoch: model.epoch ?? 0 }),
    skill || tl('NO HELD-OUT SCORE YET'),
  ];
  if (model.inSample) head.push(tl('IN-SAMPLE (TOO FEW DAYS TO HOLD OUT)'));
  if (model.device) head.push(upper(model.device));
  const ago = agoLabel(model.updatedAt, nowMs);
  if (ago) head.push(ago);
  const lines = [head.join(' · ')];
  for (const [id, sk] of Object.entries(model.domains || {})) {
    const text = tfSkillText(sk);
    if (!text) continue;
    const name = DOMAIN_NAMES[id] ? tl(DOMAIN_NAMES[id]) : upper(id);
    lines.push(`${name} · ${text}`);
  }
  if (model.folder)
    lines.push(tl('IN .gev-data/{folder}', { folder: toSlash(model.folder) }));
  return lines;
}

function toSlash(p) {
  return String(p || '').replace(/\\/g, '/');
}

/** TensorBoard's line: off, starting, running with its runs, or the error. */
export function tfBoardText(board) {
  const state = board?.state || 'off';
  const runs = Array.isArray(board?.runs) ? board.runs.length : 0;
  const count = tln(runs, '{count} RUN', '{count} RUNS', { count: runs });
  if (state === 'running')
    return tl('TENSORBOARD · RUNNING · {runs}', { runs: count });
  if (state === 'starting') return tl('TENSORBOARD · STARTING');
  if (state === 'stopping') return tl('TENSORBOARD · STOPPING');
  if (state === 'error')
    return tl('TENSORBOARD · ERROR · {error}', {
      error: upper(board.error || ''),
    });
  return tl('TENSORBOARD · OFF · {runs}', { runs: count });
}

/** One line per run folder TensorBoard reads. */
export function tfBoardRunLines(runs, nowMs = Date.now()) {
  return (Array.isArray(runs) ? runs : []).map((r) => {
    const ago = agoLabel(r.updatedAt, nowMs);
    return ago ? `${upper(r.name)} · ${ago}` : upper(r.name);
  });
}

/** The latest exports, newest first. */
export function tfExportLines(exports) {
  return (Array.isArray(exports) ? exports : []).map((e) => {
    if (!e.complete) return tl('{name} · INCOMPLETE', { name: e.name });
    const parts = [
      e.name,
      tln(num(e.days) || 0, '{count} DAY', '{count} DAYS', {
        count: e.days ?? 0,
      }),
      tln(num(e.files) || 0, '{count} FILE', '{count} FILES', {
        count: formatCount(e.files ?? 0),
      }),
      formatBytes(e.bytes),
    ];
    if (e.model)
      parts.push(
        e.tfliteOk
          ? tl('SAVEDMODEL + TFLITE (CHECKED)')
          : tl('SAVEDMODEL + TFLITE'),
      );
    else parts.push(tl('DATASET ONLY'));
    parts.push(e.publishable ? tl('OPEN ONLY: SHAREABLE') : tl('THIS PC ONLY'));
    return parts.join(' · ');
  });
}

/** The post-trained model's line: held-out loss before and after. */
export function tfPosttrainLine(result) {
  if (!result) return tl('NOT POST-TRAINED YET');
  const before = num(result.before);
  const after = num(result.after);
  const score =
    Number.isFinite(before) && Number.isFinite(after)
      ? tl('HELD-OUT LOSS {before} → {after} · {verdict}', {
          before: sig(before),
          after: sig(after),
          verdict: result.helped ? tl('HELPED') : tl('DID NOT HELP'),
        })
      : result.paused
        ? tl('PAUSED PART WAY')
        : tl('NO HELD-OUT SCORE');
  const through = result.trainedThrough
    ? ` · ${tl('TRAINED THROUGH {day}', { day: result.trainedThrough })}`
    : '';
  const where = result.folder
    ? ` · ${tl('IN .gev-data/{folder}', { folder: toSlash(result.folder) })}`
    : '';
  return `${score}${through}${where}`;
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc, text, title) {
  const node = element(doc, 'button', 'scene-btn', text);
  node.type = 'button';
  if (title) node.title = title;
  return node;
}

function input(doc, { type = 'text', label, placeholder = '' }) {
  const field = element(doc, 'input');
  field.type = type;
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.placeholder = placeholder;
  field.setAttribute('aria-label', label);
  return field;
}

function select(doc, label, options) {
  const node = element(doc, 'select');
  node.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const option = element(doc, 'option', '', text);
    option.value = value;
    node.append(option);
  }
  return node;
}

function fillList(doc, ul, lines) {
  ul.textContent = '';
  for (const text of lines) ul.append(element(doc, 'li', '', text));
  ul.hidden = lines.length === 0;
}

/**
 * Mount the sections in their host (#tensorflow-tools in the AI World tab,
 * src/aiWorldPanel.js).
 * @param {{host: HTMLElement, documentRef?: Document, fetchImpl?: typeof fetch, signal?: AbortSignal, timers?: object, now?: () => number}} options
 */
export function initTensorflowSetup({
  host,
  documentRef = globalThis.document,
  fetchImpl,
  signal,
  timers = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  },
  now = () => Date.now(),
} = {}) {
  if (!host || !documentRef?.createElement)
    return { refresh() {}, destroy() {} };
  const doc = documentRef;
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const lifetime = new AbortController();
  if (signal) {
    if (signal.aborted) lifetime.abort();
    else
      signal.addEventListener('abort', () => lifetime.abort(), { once: true });
  }
  let status = null;
  let pollTimer = null;
  let note = '';
  let filled = false;

  const call = async (route, { method = 'GET', body } = {}) => {
    const response = await doFetch(`${TENSORFLOW_API}/${route}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: lifetime.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  };
  const act = async (route, body = {}) => {
    try {
      const next = await call(route, { method: 'POST', body });
      note = '';
      render(next);
      return true;
    } catch (error) {
      if (lifetime.signal.aborted) return false;
      note = String(error.message || error);
      render(status);
      return false;
    }
  };

  // --- The frame: built once ---------------------------------------------------
  const ui = {};
  host.textContent = '';
  host.append(
    element(doc, 'div', 'cctv-summary-label', tl('TENSORFLOW')),
    (ui.runner = element(doc, 'p', 'social-note tf-runner')),
  );
  const top = element(doc, 'div', 'cctv-controls ai-world-actions');
  ui.check = button(
    doc,
    tl('CHECK AGAIN'),
    tl('Ask WSL2 and Windows again what TensorFlow they have'),
  );
  ui.check.dataset.action = 'check';
  ui.check.addEventListener('click', () => void act('check'));
  ui.pause = button(doc, tl('PAUSE'));
  ui.pause.dataset.action = 'pause';
  ui.pause.addEventListener(
    'click',
    () => void act(status?.run?.state === 'paused' ? 'continue' : 'pause'),
  );
  ui.stop = button(doc, tl('STOP'), tl('End the job; what it saved stays'));
  ui.stop.dataset.action = 'stop';
  ui.stop.addEventListener('click', () => void act('stop'));
  top.append(ui.check, ui.pause, ui.stop);
  host.append(top);
  ui.run = element(doc, 'p', 'ask-status tf-run');
  ui.run.setAttribute('role', 'status');
  host.append(ui.run);

  const section = (id, title, intro) => {
    const details = element(doc, 'details', 'ai-world-howto ai-world-tf');
    details.dataset.section = id;
    details.append(element(doc, 'summary', '', tl(title)));
    details.append(element(doc, 'p', 'social-note', intro));
    host.append(details);
    return details;
  };
  const row = (parent, ...nodes) => {
    const div = element(doc, 'div', 'cctv-controls ai-world-actions');
    div.append(...nodes);
    parent.append(div);
    return div;
  };
  const fields = (parent, pairs) => {
    const div = element(doc, 'div', 'ai-world-fields');
    for (const [label, node] of pairs)
      div.append(element(doc, 'span', '', label), node);
    parent.append(div);
  };

  // TENSORFLOW TRAINING
  const train = section(
    'train',
    TF_SECTIONS[0].title,
    tl(
      "A Keras world model on the same hourly bins as the kit's world model, with the same held-out days and the same score (MAE against persistence, per domain). Each place is read by itself; a new data layer or asset grows the model instead of replacing it. TRAIN carries on from the saved model; NEW MODEL starts over.",
    ),
  );
  ui.epochs = input(doc, { type: 'number', label: tl('Epochs') });
  ui.epochs.min = '1';
  ui.epochs.max = '200';
  ui.epochs.dataset.field = 'epochs';
  ui.device = select(doc, tl('Device'), [
    ['auto', tl('THE GPU WHEN THERE IS ONE')],
    ['cpu', tl('THE CPU ONLY')],
  ]);
  ui.device.dataset.field = 'device';
  fields(train, [
    [tl('EPOCHS'), ui.epochs],
    [tl('DEVICE'), ui.device],
  ]);
  ui.trainSave = button(doc, tl('SAVE'));
  ui.trainSave.addEventListener(
    'click',
    () =>
      void act('settings', {
        epochs: Number(ui.epochs.value),
        device: ui.device.value,
      }),
  );
  ui.train = button(
    doc,
    tl('TRAIN'),
    tl('Train the Keras world model now on every binned day'),
  );
  ui.train.dataset.action = 'train';
  ui.train.addEventListener('click', () => void act('train', {}));
  ui.fresh = button(
    doc,
    tl('NEW MODEL'),
    tl('Start a new Keras world model instead of carrying on'),
  );
  ui.fresh.dataset.action = 'fresh';
  ui.fresh.addEventListener('click', () => void act('train', { fresh: true }));
  row(train, ui.trainSave, ui.train, ui.fresh);
  ui.model = element(doc, 'ul', 'ai-world-list tf-model');
  ui.model.setAttribute('aria-label', tl('The TensorFlow world model'));
  train.append(ui.model);

  // TENSORBOARD
  const board = section(
    'board',
    TF_SECTIONS[1].title,
    tl(
      "The training curves of every trainer here: the kit's world, outbreak and tracks models and the TensorFlow ones (training loss, held-out MAE against persistence, per domain). It opens through this app, on this PC and on your phone.",
    ),
  );
  ui.boardStart = button(doc, tl('START TENSORBOARD'));
  ui.boardStart.dataset.action = 'board-start';
  ui.boardStart.addEventListener(
    'click',
    () =>
      void act(
        status?.board?.state === 'running' ? 'board-stop' : 'board-start',
      ),
  );
  ui.boardOpen = element(
    doc,
    'a',
    'scene-btn tf-board-open',
    tl('OPEN TENSORBOARD'),
  );
  ui.boardOpen.href = `${TENSORFLOW_API}/board/`;
  ui.boardOpen.target = '_blank';
  ui.boardOpen.rel = 'noopener';
  row(board, ui.boardStart, ui.boardOpen);
  ui.boardLine = element(doc, 'p', 'social-note tf-board-state');
  board.append(ui.boardLine);
  ui.boardRuns = element(doc, 'ul', 'ai-world-list tf-board-runs');
  ui.boardRuns.setAttribute('aria-label', tl('TensorBoard runs'));
  board.append(ui.boardRuns);

  // EXPORT FOR TENSORFLOW
  const exp = section(
    'export',
    TF_SECTIONS[2].title,
    tl(
      'Writes a new folder in .gev-data/ai-world/tensorflow/exports/: the bins as TFRecords (one example per hour, observed entries only), the Keras world model as a SavedModel and as TFLite (checked against Keras), and TENSORFLOW.md on reading them with tf.data. Nothing is uploaded.',
    ),
  );
  ui.classes = select(doc, tl('Licence classes'), [
    ['all', tl('EVERY CLASS (THIS PC ONLY)')],
    ['open', tl('OPEN ONLY (SHAREABLE)')],
  ]);
  ui.classes.dataset.field = 'classes';
  fields(exp, [[tl('CLASSES'), ui.classes]]);
  const withLabel = element(doc, 'label', 'outbreak-mode ai-world-all');
  withLabel.dataset.class = 'all';
  ui.withModel = input(doc, { type: 'checkbox', label: tl('With the model') });
  ui.withModel.dataset.field = 'withModel';
  withLabel.append(
    ui.withModel,
    element(doc, 'span', 'outbreak-swatch'),
    tl('WITH THE MODEL (SAVEDMODEL + TFLITE)'),
  );
  exp.append(withLabel);
  ui.exportSave = button(doc, tl('SAVE'));
  ui.exportSave.addEventListener(
    'click',
    () =>
      void act('settings', {
        classes: ui.classes.value,
        withModel: ui.withModel.checked,
      }),
  );
  ui.export = button(doc, tl('EXPORT NOW'));
  ui.export.dataset.action = 'export';
  ui.export.addEventListener('click', () => void act('export'));
  row(exp, ui.exportSave, ui.export);
  ui.exportNote = element(
    doc,
    'p',
    'social-note',
    tl(
      'The model learned from every class it trained on, whatever the dataset keeps: an export is shareable only when both are open only, and only when you say so.',
    ),
  );
  exp.append(ui.exportNote);
  ui.exports = element(doc, 'ul', 'ai-world-list tf-exports');
  ui.exports.setAttribute('aria-label', tl('Latest exports'));
  exp.append(ui.exports);

  // POST-TRAIN A TENSORFLOW MODEL
  const post = section(
    'posttrain',
    TF_SECTIONS[3].title,
    tl(
      'Brings a Keras world model up to date on the newest recorded days through an adapter: keras_world:KerasWorldAdapter for the model TENSORFLOW TRAINING makes, or your own in .gev-data/ai-world/adapters/. The last days are held out to score it before and after.',
    ),
  );
  ui.adapter = input(doc, {
    label: tl('Adapter'),
    placeholder: DEFAULT_ADAPTER,
  });
  ui.adapter.maxLength = 130;
  ui.adapter.dataset.field = 'adapter';
  ui.checkpoint = input(doc, {
    label: tl('Checkpoint'),
    placeholder: tl('path inside .gev-data/'),
  });
  ui.checkpoint.maxLength = 400;
  ui.checkpoint.dataset.field = 'checkpoint';
  ui.postEpochs = input(doc, {
    type: 'number',
    label: tl('Post-train epochs'),
  });
  ui.postEpochs.min = '1';
  ui.postEpochs.max = '20';
  ui.postEpochs.dataset.field = 'postEpochs';
  fields(post, [
    [tl('ADAPTER'), ui.adapter],
    [tl('CHECKPOINT'), ui.checkpoint],
    [tl('EPOCHS'), ui.postEpochs],
  ]);
  ui.postSave = button(doc, tl('SAVE'));
  ui.postSave.addEventListener(
    'click',
    () =>
      void act('settings', {
        posttrain: {
          adapter: ui.adapter.value.trim(),
          checkpoint: ui.checkpoint.value.trim(),
          epochs: Number(ui.postEpochs.value),
        },
      }),
  );
  ui.post = button(doc, tl('POST-TRAIN NOW'));
  ui.post.dataset.action = 'posttrain';
  ui.post.addEventListener('click', () => void act('posttrain'));
  row(post, ui.postSave, ui.post);
  ui.postLine = element(doc, 'p', 'social-note tf-posttrain');
  post.append(ui.postLine);

  // --- Updates: in place ---------------------------------------------------------
  function render(next) {
    if (!next || lifetime.signal.aborted) return;
    status = next;
    host.hidden = false;
    const can = tfControlStates(next);
    const run = next.run || {};
    ui.runner.textContent = tfRunnerText(next.runner);
    ui.check.disabled = next.runner?.checking === true;
    ui.run.textContent = note || tfRunText(run);
    ui.run.dataset.ok = note || run.state === 'error' ? 'false' : 'true';
    ui.pause.textContent = can.continue ? tl('CONTINUE') : tl('PAUSE');
    ui.pause.dataset.action = can.continue ? 'continue' : 'pause';
    ui.pause.disabled = !(can.pause || can.continue);
    ui.stop.disabled = !can.stop;
    // Settings: from the server the first time, then left to the owner.
    if (!filled) {
      filled = true;
      ui.epochs.value = String(next.settings?.epochs ?? 10);
      ui.device.value = next.settings?.device || 'auto';
      ui.classes.value = next.settings?.classes || 'all';
      ui.withModel.checked = next.settings?.withModel !== false;
      ui.adapter.value = next.posttrain?.adapter || '';
      ui.checkpoint.value = toSlash(next.posttrain?.checkpoint || '');
      ui.postEpochs.value = String(next.posttrain?.epochs ?? 1);
    }
    ui.train.disabled = !can.start;
    ui.train.textContent = next.model ? tl('TRAIN (CARRY ON)') : tl('TRAIN');
    ui.fresh.disabled = !can.start || !next.model;
    fillList(doc, ui.model, tfModelLines(next.model, now()));
    const boardState = next.board?.state || 'off';
    ui.boardStart.textContent =
      boardState === 'running'
        ? tl('STOP TENSORBOARD')
        : tl('START TENSORBOARD');
    ui.boardStart.dataset.action =
      boardState === 'running' ? 'board-stop' : 'board-start';
    ui.boardStart.disabled =
      boardState === 'starting' || boardState === 'stopping';
    ui.boardOpen.hidden = boardState !== 'running';
    ui.boardLine.textContent = tfBoardText(next.board);
    fillList(doc, ui.boardRuns, tfBoardRunLines(next.board?.runs, now()));
    ui.export.disabled = !can.start;
    fillList(doc, ui.exports, tfExportLines(next.exports));
    ui.post.disabled = !can.posttrain;
    ui.postLine.textContent = tfPosttrainLine(next.posttrained);
    schedule();
  }

  const schedule = () => {
    timers.clearTimeout(pollTimer);
    if (lifetime.signal.aborted) return;
    const busy =
      status?.run?.busy === true ||
      status?.runner?.checking === true ||
      ['starting', 'stopping'].includes(status?.board?.state);
    pollTimer = timers.setTimeout(
      () => void refresh(),
      busy ? POLL_BUSY_MS : POLL_IDLE_MS,
    );
    pollTimer?.unref?.();
  };

  async function refresh() {
    try {
      render(await call('status'));
    } catch {
      // No server route (a production build, a LAN visitor): show nothing.
      if (!status) host.hidden = true;
      schedule();
    }
  }
  host.hidden = true;
  void refresh();

  return {
    refresh,
    render,
    destroy() {
      lifetime.abort();
      timers.clearTimeout(pollTimer);
      host.textContent = '';
    },
  };
}
