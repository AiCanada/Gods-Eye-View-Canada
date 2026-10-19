/**
 * The MLFLOW sections of the ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM tab
 * (owner request 2026-10-17: "also integrate https://mlflow.org/ as additional
 * optons and features open source as well"; ruling: all six, local only).
 * Each is its own expandable section:
 *
 *   MLFLOW TRACKING  every training run in the tab kept as an MLflow run
 *   MLFLOW UI        the MLflow server, opened through this app
 *   MODEL REGISTRY   trained models as versions, CHAMPION and CHALLENGER
 *   MODEL SERVING    one registered version answering REST requests
 *   EVALUATION       registered world models scored against persistence
 *   LLM TRACING      a custom LLM's question and answer kept as a trace
 *
 * Above them: what this PC has (MLflow, Python) and the one job that runs
 * (register, evaluate, ask). The routes are /api/mlflow
 * (server/providers/mlflow.js). Built once and updated in place, so an open
 * section stays open and a box being typed in keeps its text.
 *
 * The text is marked with tl() and tln(): Quebec French, Inuktitut and
 * Ancient Egyptian in the fork locales, English in every other.
 */
import { agoLabel, formatCount } from './aiWorldSelection.mjs';
import { localDigits, msgl, tl, tln } from './i18n/index.js';

export const MLFLOW_API = '/api/mlflow';
const POLL_BUSY_MS = 3_000;
const POLL_IDLE_MS = 15_000;

/** The six sections, in the order the tab shows them. */
export const MLFLOW_SECTIONS = Object.freeze([
  Object.freeze({ id: 'tracking', title: msgl('MLFLOW TRACKING') }),
  Object.freeze({ id: 'ui', title: msgl('MLFLOW UI') }),
  Object.freeze({ id: 'registry', title: msgl('MODEL REGISTRY') }),
  Object.freeze({ id: 'serving', title: msgl('MODEL SERVING') }),
  Object.freeze({ id: 'evaluation', title: msgl('EVALUATION') }),
  Object.freeze({ id: 'tracing', title: msgl('LLM TRACING') }),
]);

const JOB_NAMES = Object.freeze({
  register: msgl('MODEL REGISTRY'),
  evaluate: msgl('EVALUATION'),
  ask: msgl('LLM TRACING'),
});
const STATE_NAMES = Object.freeze({
  idle: msgl('IDLE'),
  off: msgl('OFF'),
  starting: msgl('STARTING'),
  running: msgl('RUNNING'),
  stopping: msgl('STOPPING'),
  done: msgl('DONE'),
  error: msgl('ERROR'),
  FINISHED: msgl('DONE'),
  RUNNING: msgl('RUNNING'),
  FAILED: msgl('ERROR'),
  KILLED: msgl('STOPPED'),
});
const KIND_NAMES = Object.freeze({
  world: msgl('WORLD MODEL (PYTORCH)'),
  'tf-world': msgl('WORLD MODEL (KERAS)'),
  llm: msgl('CUSTOM LLM'),
});
const SOURCE_LABELS = Object.freeze([
  msgl('KIT WORLD MODEL (PYTORCH)'),
  msgl('POST-TRAINED WORLD MODEL (PYTORCH)'),
  msgl('TENSORFLOW WORLD MODEL (KERAS)'),
  msgl('POST-TRAINED KERAS MODEL'),
]);
const DOMAIN_NAMES = Object.freeze({
  mobility: msgl('MOBILITY'),
  weather: msgl('WEATHER'),
  hazards: msgl('HAZARDS'),
  news: msgl('NEWS'),
  markets: msgl('PRICE MOVES'),
});

const num = (v) =>
  v === null || v === undefined || v === '' ? NaN : Number(v);
const sig = (v) => localDigits(Number(v).toPrecision(3));
const upper = (v) => String(v ?? '').toUpperCase();
const stateName = (s) => (STATE_NAMES[s] ? tl(STATE_NAMES[s]) : upper(s));

/** A source's label: the fixed ones translated, a custom LLM by its name. */
export function sourceLabel(source) {
  const label = String(source?.label || '');
  if (SOURCE_LABELS.includes(label)) return tl(label);
  if (source?.kind === 'llm')
    return tl('CUSTOM LLM {name}', { name: label.replace(/^CUSTOM LLM /, '') });
  return label;
}

/** What this PC has, and the server. */
export function mlflowHeadText(status) {
  const have = status?.installed || {};
  if (!have.mlflow)
    return have.checking
      ? tl('MLFLOW · CHECKING THIS PC')
      : tl('MLFLOW IS NOT INSTALLED: py -3.13 -m pip install mlflow');
  return tl('MLFLOW {version} · PYTHON {python} · SERVER {state}', {
    version: have.mlflow,
    python: have.python || '?',
    state: stateName(status?.server?.state || 'off'),
  });
}

/** The one job: which, its state, where it is. */
export function mlflowRunText(run) {
  if (!run?.kind) return tl('JOB · NONE YET');
  const name = tl(JOB_NAMES[run.kind] || upper(run.kind));
  if (run.state === 'error')
    return tl('{job} · ERROR · {error}', {
      job: name,
      error: upper(run.error || tl('THE JOB FAILED')),
    });
  const parts = [`${name} · ${stateName(run.state)}`];
  if (run.kind === 'evaluate' && Number.isFinite(num(run.total)))
    parts.push(
      tl('MODEL {done}/{total}', {
        done: (run.done ?? 0) + 1,
        total: run.total,
      }),
    );
  if (run.name && run.version) parts.push(`${upper(run.name)} V${run.version}`);
  return parts.join(' · ');
}

/** Which buttons the state allows. */
export function mlflowControlStates(status) {
  const installed = Boolean(status?.installed?.mlflow);
  const server = status?.server?.state || 'off';
  const busy = status?.run?.busy === true;
  const serving = status?.serving?.state || 'off';
  return {
    serverStart: installed && (server === 'off' || server === 'error'),
    serverStop: server === 'running' || server === 'starting',
    open: server === 'running',
    job: installed && !busy,
    alias: installed && server === 'running',
    serveStart: installed && serving !== 'starting',
    serveStop: serving === 'running' || serving === 'starting',
    serveTest: serving === 'running',
  };
}

/** TRACKING's line: what is waiting to be sent, sent and dropped. */
export function trackingText(tracking) {
  const t = tracking || {};
  if (!t.enabled) return tl('TRACKING · OFF');
  const parts = [
    tl('TRACKING · ON'),
    tln(num(t.active) || 0, '{count} RUN GOING', '{count} RUNS GOING', {
      count: t.active ?? 0,
    }),
    tl('{count} POINTS SENT', { count: formatCount(t.logged ?? 0) }),
  ];
  if (num(t.queued) > 0)
    parts.push(
      tl('{count} WAITING FOR THE SERVER', { count: formatCount(t.queued) }),
    );
  if (num(t.dropped) > 0)
    parts.push(tl('{count} DROPPED', { count: formatCount(t.dropped) }));
  if (t.error) parts.push(upper(t.error));
  return parts.join(' · ');
}

/** One line per recent run. */
export function trackedRunLines(recent, nowMs = Date.now()) {
  return (Array.isArray(recent) ? recent : []).map((r) => {
    const last = r.last || {};
    const parts = [upper(r.name || r.experiment), stateName(r.state)];
    if (Number.isFinite(num(last['train/loss'])))
      parts.push(tl('LOSS {loss}', { loss: sig(last['train/loss']) }));
    if (
      Number.isFinite(num(last['held-out/mae'])) &&
      Number.isFinite(num(last['held-out/persistence']))
    )
      parts.push(
        tl('MAE {model} VS PERSISTENCE {persistence}', {
          model: sig(last['held-out/mae']),
          persistence: sig(last['held-out/persistence']),
        }),
      );
    const ago = agoLabel(r.startedAt, nowMs);
    if (ago) parts.push(ago);
    return parts.join(' · ');
  });
}

/** The MLflow server's line. */
export function serverText(server) {
  const state = server?.state || 'off';
  if (state === 'error')
    return tl('MLFLOW SERVER · ERROR · {error}', {
      error: upper(server.error || ''),
    });
  if (state === 'off' && server?.held)
    return tl('MLFLOW SERVER · OFF (TRACKING WAITS UNTIL YOU START IT)');
  return tl('MLFLOW SERVER · {state}', { state: stateName(state) });
}

/** One line per registered model: its kind, versions and aliases. */
export function registryLines(registry) {
  return (registry?.models || []).map((m) => {
    const parts = [upper(m.name)];
    if (KIND_NAMES[m.kind]) parts.push(tl(KIND_NAMES[m.kind]));
    for (const alias of ['champion', 'challenger'])
      if (m.aliases?.[alias])
        parts.push(
          alias === 'champion'
            ? tl('V{version} CHAMPION', { version: m.aliases[alias] })
            : tl('V{version} CHALLENGER', { version: m.aliases[alias] }),
        );
    const n = (m.versions || []).length;
    parts.push(tln(n, '{count} VERSION', '{count} VERSIONS', { count: n }));
    const best = (m.versions || []).find((v) => v.tags?.['gev.eval.mae']);
    if (best)
      parts.push(
        tl('V{version} EVALUATED MAE {mae}', {
          version: best.version,
          mae: sig(best.tags['gev.eval.mae']),
        }),
      );
    return parts.join(' · ');
  });
}

/** Every registered version, newest first per model, as select options. */
export function versionOptions(registry, kinds = null) {
  const out = [];
  for (const m of registry?.models || []) {
    if (kinds && !kinds.includes(m.kind)) continue;
    for (const v of m.versions || []) {
      const marks = Object.entries(m.aliases || {})
        .filter(([, version]) => version === v.version)
        .map(([alias]) => alias.toUpperCase());
      out.push({
        value: `${m.name}/${v.version}`,
        text: [`${m.name.toUpperCase()} V${v.version}`, ...marks].join(' · '),
      });
    }
  }
  return out;
}

/** The serving line, with the test's result. */
export function servingText(serving) {
  const s = serving || {};
  if (s.state === 'error')
    return tl('SERVING · ERROR · {error}', { error: upper(s.error || '') });
  if (!s.name)
    return tl('SERVING · {state}', { state: stateName(s.state || 'off') });
  const head = tl('SERVING · {state} · {model}', {
    state: stateName(s.state),
    model: `${upper(s.name)} V${s.version}`,
  });
  const test = s.test;
  if (!test) return head;
  if (!test.ok)
    return `${head} · ${tl('TEST FAILED · {error}', { error: upper(test.error || '') })}`;
  return test.answer
    ? `${head} · ${tl('TEST ANSWER: {answer}', { answer: test.answer })}`
    : `${head} · ${tl('TEST OK · SHAPE {shape} · {ms} MS', {
        shape: (test.shape || []).join(' × '),
        ms: test.ms ?? '?',
      })}`;
}

/** EVALUATION's lines: one per model, then per domain for the best. */
export function evaluationLines(result) {
  if (!result) return [tl('NOT EVALUATED YET')];
  const lines = [];
  const best = result.best ? `${result.best.name}/${result.best.version}` : '';
  for (const r of result.rows || []) {
    const parts = [`${upper(r.name)} V${r.version}`];
    if (Number.isFinite(num(r.mae)) && Number.isFinite(num(r.persistence)))
      parts.push(
        tl('MAE {model} VS PERSISTENCE {persistence}', {
          model: sig(r.mae),
          persistence: sig(r.persistence),
        }),
      );
    else parts.push(tl('NO OBSERVED TARGETS'));
    if (`${r.name}/${r.version}` === best) parts.push(tl('BEST'));
    lines.push(parts.join(' · '));
  }
  const top = (result.rows || []).find(
    (r) => `${r.name}/${r.version}` === best,
  );
  for (const [domain, sk] of Object.entries(top?.domains || {}))
    lines.push(
      `${DOMAIN_NAMES[domain] ? tl(DOMAIN_NAMES[domain]) : upper(domain)} · ${tl(
        'MAE {model} VS PERSISTENCE {persistence}',
        { model: sig(sk.mae), persistence: sig(sk.persistence) },
      )}`,
    );
  if ((result.heldOutDays || []).length)
    lines.push(
      tl('HELD OUT {first} TO {last}', {
        first: result.heldOutDays[0],
        last: result.heldOutDays.at(-1),
      }),
    );
  return lines;
}

/** Where the MLflow UI shows a trace. */
export function traceHref(ask, base = `${MLFLOW_API}/ui/`) {
  if (!ask?.traceId || !ask?.experimentId) return '';
  const id = encodeURIComponent(ask.traceId);
  return `${base}#/experiments/${encodeURIComponent(ask.experimentId)}/traces?selectedEvaluationId=${id}&traceId=${id}`;
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc, text, action, title) {
  const node = element(doc, 'button', 'scene-btn', text);
  node.type = 'button';
  node.dataset.action = action;
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

function select(doc, label) {
  const node = element(doc, 'select');
  node.setAttribute('aria-label', label);
  return node;
}

/** Options of a select, keeping the choice when it is still offered. */
function setOptions(doc, node, options) {
  const keep = node.value;
  const same =
    node.children.length === options.length &&
    Array.from(node.children).every(
      (o, i) => o.value === options[i][0] && o.textContent === options[i][1],
    );
  if (!same) {
    node.textContent = '';
    for (const [value, text] of options) {
      const option = element(doc, 'option', '', text);
      option.value = value;
      node.append(option);
    }
  }
  if (options.some(([value]) => value === keep)) node.value = keep;
  else if (options.length) node.value = options[0][0];
}

function fillList(doc, ul, lines) {
  ul.textContent = '';
  for (const text of lines) ul.append(element(doc, 'li', '', text));
  ul.hidden = lines.length === 0;
}

/**
 * Mount the sections in their host (#mlflow-tools in the AI World tab,
 * src/aiWorldPanel.js).
 * @param {{host: HTMLElement, documentRef?: Document, fetchImpl?: typeof fetch, signal?: AbortSignal, timers?: object, now?: () => number}} options
 */
export function initMlflowSetup({
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

  const call = async (route, { method = 'GET', body } = {}) => {
    const response = await doFetch(`${MLFLOW_API}/${route}`, {
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
    } catch (error) {
      if (lifetime.signal.aborted) return;
      note = String(error.message || error);
      render(status);
    }
  };

  // --- The frame: built once -----------------------------------------------------
  const ui = {};
  host.textContent = '';
  host.append(
    element(doc, 'div', 'cctv-summary-label', tl('MLFLOW')),
    (ui.head = element(doc, 'p', 'social-note mlflow-head')),
  );
  const top = element(doc, 'div', 'cctv-controls ai-world-actions');
  ui.check = button(
    doc,
    tl('CHECK AGAIN'),
    'check',
    tl('Ask the Python again whether MLflow is installed'),
  );
  ui.check.addEventListener('click', () => void act('check'));
  top.append(ui.check);
  host.append(top);
  ui.run = element(doc, 'p', 'ask-status mlflow-run');
  ui.run.setAttribute('role', 'status');
  host.append(ui.run);

  const section = (id, title, intro) => {
    const details = element(doc, 'details', 'ai-world-howto ai-world-mlflow');
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
  };
  const fields = (parent, pairs) => {
    const div = element(doc, 'div', 'ai-world-fields');
    for (const [label, node] of pairs)
      div.append(element(doc, 'span', '', label), node);
    parent.append(div);
  };
  const list = (parent, className, label) => {
    const ul = element(doc, 'ul', `ai-world-list ${className}`);
    ul.setAttribute('aria-label', label);
    parent.append(ul);
    return ul;
  };

  // MLFLOW TRACKING
  const tracking = section(
    'tracking',
    MLFLOW_SECTIONS[0].title,
    tl(
      "Every training run in this tab is kept as an MLflow run: the kit's world, outbreak and tracks models, the TensorFlow jobs and the custom LLM. Its parameters, the training loss by step, the held-out error against persistence per domain, the device and the licence classes, with its metrics.json and manifest.json. Stored on this PC only, in .gev-data/mlflow/.",
    ),
  );
  const trackLabel = element(doc, 'label', 'outbreak-mode ai-world-all');
  trackLabel.dataset.class = 'all';
  ui.tracking = input(doc, {
    type: 'checkbox',
    label: tl('Track every training run'),
  });
  ui.tracking.dataset.field = 'tracking';
  ui.tracking.addEventListener(
    'change',
    () => void act('settings', { tracking: ui.tracking.checked }),
  );
  trackLabel.append(
    ui.tracking,
    element(doc, 'span', 'outbreak-swatch'),
    tl('TRACK EVERY TRAINING RUN'),
  );
  tracking.append(trackLabel);
  ui.trackingLine = element(doc, 'p', 'social-note mlflow-tracking-state');
  tracking.append(ui.trackingLine);
  ui.runs = list(tracking, 'mlflow-runs', tl('Recent MLflow runs'));

  // MLFLOW UI
  const uiSection = section(
    'ui',
    MLFLOW_SECTIONS[1].title,
    tl(
      'The MLflow server holds the runs, the registered models and the traces. OPEN MLFLOW shows them through this app, on this PC and on your phone; from the phone nothing can be deleted.',
    ),
  );
  ui.serverStart = button(doc, tl('START MLFLOW'), 'server-start');
  ui.serverStart.addEventListener('click', () => void act('server-start'));
  ui.serverStop = button(doc, tl('STOP MLFLOW'), 'server-stop');
  ui.serverStop.addEventListener('click', () => void act('server-stop'));
  ui.open = element(doc, 'a', 'scene-btn mlflow-open', tl('OPEN MLFLOW'));
  ui.open.href = `${MLFLOW_API}/ui/`;
  ui.open.target = '_blank';
  ui.open.rel = 'noopener';
  row(uiSection, ui.serverStart, ui.serverStop, ui.open);
  ui.serverLine = element(doc, 'p', 'social-note mlflow-server-state');
  uiSection.append(ui.serverLine);

  // MODEL REGISTRY
  const registry = section(
    'registry',
    MLFLOW_SECTIONS[2].title,
    tl(
      'Puts a trained model in the MLflow model registry as a new version, with what it reads, the days it learned from, its licence classes and its held-out score. CHAMPION marks the version to use, CHALLENGER the one to try.',
    ),
  );
  ui.source = select(doc, tl('Trained model'));
  ui.source.dataset.field = 'source';
  ui.name = input(doc, { label: tl('Registered model name') });
  ui.name.maxLength = 100;
  ui.name.dataset.field = 'name';
  ui.alias = select(doc, tl('Alias'));
  ui.alias.dataset.field = 'alias';
  setOptions(doc, ui.alias, [
    ['', tl('NO ALIAS')],
    ['champion', tl('CHAMPION')],
    ['challenger', tl('CHALLENGER')],
  ]);
  fields(registry, [
    [tl('MODEL'), ui.source],
    [tl('NAME'), ui.name],
    [tl('ALIAS'), ui.alias],
  ]);
  ui.register = button(doc, tl('REGISTER'), 'register');
  ui.register.addEventListener(
    'click',
    () =>
      void act('register', {
        source: ui.source.value,
        name: ui.name.value.trim() || undefined,
        alias: ui.alias.value || undefined,
      }),
  );
  row(registry, ui.register);
  ui.models = list(registry, 'mlflow-models', tl('Registered models'));
  ui.aliasVersion = select(doc, tl('Version'));
  ui.aliasVersion.dataset.field = 'aliasVersion';
  ui.aliasName = select(doc, tl('Alias to set'));
  ui.aliasName.dataset.field = 'aliasName';
  setOptions(doc, ui.aliasName, [
    ['champion', tl('CHAMPION')],
    ['challenger', tl('CHALLENGER')],
  ]);
  fields(registry, [
    [tl('VERSION'), ui.aliasVersion],
    [tl('ALIAS'), ui.aliasName],
  ]);
  ui.setAlias = button(doc, tl('SET ALIAS'), 'alias');
  ui.setAlias.addEventListener('click', () => {
    const [name, version] = String(ui.aliasVersion.value).split('/');
    if (name && version)
      void act('alias', { name, version, alias: ui.aliasName.value });
  });
  row(registry, ui.setAlias);

  // MODEL SERVING
  const serving = section(
    'serving',
    MLFLOW_SECTIONS[3].title,
    tl(
      'Serves one registered version on this PC: POST to /api/mlflow/serve/invocations (or 127.0.0.1:5001/invocations). A world model takes windows of v, m, tf and s; a custom LLM takes a prompt column. TEST sends a small request of its own shape.',
    ),
  );
  ui.serveVersion = select(doc, tl('Version to serve'));
  ui.serveVersion.dataset.field = 'serveVersion';
  fields(serving, [[tl('VERSION'), ui.serveVersion]]);
  ui.serveStart = button(doc, tl('START SERVING'), 'serve-start');
  ui.serveStart.addEventListener('click', () => {
    const [name, version] = String(ui.serveVersion.value).split('/');
    if (name && version) void act('serve-start', { name, version });
  });
  ui.serveStop = button(doc, tl('STOP SERVING'), 'serve-stop');
  ui.serveStop.addEventListener('click', () => void act('serve-stop'));
  ui.serveTest = button(doc, tl('TEST'), 'serve-test');
  ui.serveTest.addEventListener('click', () => void act('serve-test'));
  row(serving, ui.serveStart, ui.serveStop, ui.serveTest);
  ui.servingLine = element(doc, 'p', 'social-note mlflow-serving-state');
  serving.append(ui.servingLine);

  // EVALUATION
  const evaluation = section(
    'evaluation',
    MLFLOW_SECTIONS[4].title,
    tl(
      "Scores every registered world model's champion, challenger and newest version on the held-out days of the newest binned world, against persistence, overall and per domain, as the trainers score their own models. PyTorch and Keras models are scored side by side.",
    ),
  );
  ui.evaluate = button(doc, tl('EVALUATE NOW'), 'evaluate');
  ui.evaluate.addEventListener('click', () => void act('evaluate'));
  row(evaluation, ui.evaluate);
  ui.evaluation = list(evaluation, 'mlflow-evaluation', tl('Evaluation'));

  // LLM TRACING
  const tracing = section(
    'tracing',
    MLFLOW_SECTIONS[5].title,
    tl(
      'Asks a custom LLM trained in CUSTOM LLM TRAINING and keeps the question and the answer as an MLflow trace (experiment ai-world/llm-traces). A served custom LLM keeps a trace of each answer too.',
    ),
  );
  ui.llm = select(doc, tl('Custom LLM'));
  ui.llm.dataset.field = 'llm';
  ui.prompt = input(doc, {
    label: tl('Question'),
    placeholder: tl('What moved before crude oil?'),
  });
  ui.prompt.maxLength = 2000;
  ui.prompt.dataset.field = 'prompt';
  fields(tracing, [
    [tl('MODEL'), ui.llm],
    [tl('QUESTION'), ui.prompt],
  ]);
  ui.ask = button(doc, tl('ASK'), 'ask');
  ui.ask.addEventListener('click', () => {
    const prompt = String(ui.prompt.value || '').trim();
    if (prompt && ui.llm.value)
      void act('ask', { model: ui.llm.value, prompt });
  });
  row(tracing, ui.ask);
  ui.answer = element(doc, 'p', 'social-note mlflow-answer');
  tracing.append(ui.answer);
  ui.trace = element(doc, 'a', 'scene-btn mlflow-trace', tl('OPEN THE TRACE'));
  ui.trace.target = '_blank';
  ui.trace.rel = 'noopener';
  tracing.append(ui.trace);

  // --- Updates: in place ---------------------------------------------------------
  function render(next) {
    if (!next || lifetime.signal.aborted) return;
    status = next;
    host.hidden = false;
    const can = mlflowControlStates(next);
    ui.head.textContent = mlflowHeadText(next);
    ui.check.disabled = next.installed?.checking === true;
    ui.run.textContent = note || mlflowRunText(next.run);
    ui.run.dataset.ok = note || next.run?.state === 'error' ? 'false' : 'true';
    ui.tracking.checked = next.settings?.tracking === true;
    ui.tracking.disabled = !next.installed?.mlflow;
    ui.trackingLine.textContent = trackingText(next.tracking);
    fillList(doc, ui.runs, trackedRunLines(next.tracking?.recent, now()));
    ui.serverStart.disabled = !can.serverStart;
    ui.serverStop.disabled = !can.serverStop;
    ui.open.hidden = !can.open;
    ui.serverLine.textContent = serverText(next.server);
    const sources = next.sources || [];
    setOptions(
      doc,
      ui.source,
      sources.length
        ? sources.map((s) => [s.id, sourceLabel(s)])
        : [['', tl('NO TRAINED MODEL YET')]],
    );
    const chosen = sources.find((s) => s.id === ui.source.value);
    ui.name.placeholder = chosen?.defaultName || '';
    ui.register.disabled = !can.job || !chosen;
    fillList(
      doc,
      ui.models,
      (next.registry?.models || []).length
        ? registryLines(next.registry)
        : [
            next.registry?.error
              ? upper(next.registry.error)
              : tl('NO REGISTERED MODEL YET'),
          ],
    );
    const versions = versionOptions(next.registry).map((o) => [
      o.value,
      o.text,
    ]);
    setOptions(
      doc,
      ui.aliasVersion,
      versions.length ? versions : [['', tl('NO VERSION YET')]],
    );
    ui.setAlias.disabled = !can.alias || !versions.length;
    setOptions(
      doc,
      ui.serveVersion,
      versions.length ? versions : [['', tl('NO VERSION YET')]],
    );
    ui.serveStart.disabled = !can.serveStart || !versions.length;
    ui.serveStop.disabled = !can.serveStop;
    ui.serveTest.disabled = !can.serveTest;
    ui.servingLine.textContent = servingText(next.serving);
    ui.evaluate.disabled = !can.job;
    fillList(doc, ui.evaluation, evaluationLines(next.last?.evaluate));
    const llms = sources.filter((s) => s.kind === 'llm');
    setOptions(
      doc,
      ui.llm,
      llms.length
        ? llms.map((s) => [s.id.replace(/^llm:/, ''), sourceLabel(s)])
        : [['', tl('NO CUSTOM LLM TRAINED YET')]],
    );
    ui.ask.disabled = !can.job || !llms.length;
    const ask = next.last?.ask;
    ui.answer.textContent = ask
      ? tl('{model}: {answer}', {
          model: upper(ask.model),
          answer: ask.answer || '',
        })
      : tl('NO QUESTION ASKED YET');
    const href = traceHref(ask);
    ui.trace.href = href || '#';
    ui.trace.hidden = !href || !can.open;
    schedule();
  }

  const schedule = () => {
    timers.clearTimeout(pollTimer);
    if (lifetime.signal.aborted) return;
    const busy =
      status?.run?.busy === true ||
      status?.installed?.checking === true ||
      ['starting', 'stopping'].includes(status?.server?.state) ||
      ['starting', 'stopping'].includes(status?.serving?.state) ||
      num(status?.tracking?.active) > 0;
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
