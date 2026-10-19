/**
 * CUSTOM LLM TRAINING, at the bottom of the ARTIFICIAL INTELLIGENCE WORLD
 * TRAINING SIM tab (owner request 2026-10-17: moved there from POWER UP).
 * First asked for 2026-10-16: "add Custom LLM
 * to be trained under Power Up's on Dashboard · Select data sources to train
 * from · Add any custom URL to train from · Add any local sources to train
 * from · Initialize Training", and post-training "to keep the most up to
 * date"). The routes are /api/llm-training (server/providers/llmTraining.js).
 *
 * The section: a name and a base model already on this PC; a tick box per
 * data source (what the app records, the custom URLs, the local sources);
 * the URL and local-source lists, each with ADD and REMOVE (the owner's phone
 * may add, never remove: its REMOVE is refused with no message); epochs,
 * POST-TRAIN FROM an earlier model and POST-TRAIN DAILY; INITIALIZE TRAINING,
 * PAUSE / CONTINUE and STOP; the run's progress and every trained model with
 * the day its data runs to and its held-out loss before and after.
 *
 * The text is marked with tl() and tln(): Quebec French in the fork
 * locales, English in every other.
 */
import { classTag } from './aiWorldSelection.mjs';
import { localDigits, msgl, tl, tln } from './i18n/index.js';
import {
  isOwnerRemovalRefusal,
  noteOwnerRemovalRefusal,
  watchOwnerRemoval,
} from './ui/ownerRemoval.js';

export const LLM_TRAINING_API = '/api/llm-training';
const POLL_BUSY_MS = 3_000;
const POLL_IDLE_MS = 15_000;
const BUSY = new Set(['fetching', 'building', 'training']);

/**
 * The labels the server gives the data sources and the offered base models
 * (server/shared/llmTraining.mjs), listed so they are translated; any other
 * label shows as the server gives it.
 */
export const LLM_SERVER_LABELS = Object.freeze([
  msgl('NEWS HEADLINES'),
  msgl('FINANCIAL ASSET PRICES'),
  msgl('HEADLINES → NEXT-DAY PRICE MOVES'),
  msgl('MEASURED LAYER-ASSET LINKS'),
  msgl('DATA LAYER READINGS (HOURLY BINS)'),
  msgl('CUSTOM URLS'),
  msgl('LOCAL SOURCES'),
  msgl('DISTILLED ANSWERS (AI DISTILLATION)'),
  msgl('QWEN3.5-0.8B · DEFAULT · 1.7 GB · TRAINS ON THE GPU'),
  msgl('QWEN3.6-35B-A3B · 72 GB · GPU + RAM · SLOW'),
]);

/** The run states, as the status line names them. */
const STATE_NAMES = Object.freeze({
  idle: msgl('IDLE'),
  fetching: msgl('FETCHING'),
  building: msgl('BUILDING'),
  training: msgl('TRAINING'),
  paused: msgl('PAUSED'),
  stopped: msgl('STOPPED'),
  done: msgl('DONE'),
  error: msgl('ERROR'),
});

/** Which buttons a run state allows. */
export function llmControlStates(state) {
  const busy = BUSY.has(state);
  return {
    initialize: !busy && state !== 'paused',
    pause: state === 'training',
    continue: state === 'paused',
    stop: busy || state === 'paused',
    edit: !busy,
  };
}

const num = (v) =>
  v === null || v === undefined || v === '' ? NaN : Number(v);

/** The status line: the run's state and where it is. */
export function llmStateText(status) {
  const name = STATE_NAMES[status?.state || 'idle'];
  const state = name ? tl(name) : String(status?.state || 'idle').toUpperCase();
  const stage = status?.stage || {};
  if (status?.state === 'error')
    return tl('ERROR · {error}', {
      error: status.error
        ? String(status.error).toUpperCase()
        : tl('THE RUN FAILED'),
    });
  if (status?.state === 'fetching') return tl('FETCHING CUSTOM URLS');
  if (status?.state === 'building') return tl('BUILDING THE DATASET');
  const examples = Number(stage.built?.train ?? 0);
  const built = stage.built
    ? ` · ${tln(
        examples,
        '{count} EXAMPLE ({heldout} HELD OUT)',
        '{count} EXAMPLES ({heldout} HELD OUT)',
        {
          count: stage.built.train ?? 0,
          heldout: stage.built.heldout ?? 0,
        },
      )}`
    : '';
  if (status?.state === 'training' || status?.state === 'paused') {
    const epoch = Number.isFinite(num(stage.epoch))
      ? ` · ${tl('EPOCH {epoch}/{epochs}', { epoch: stage.epoch, epochs: stage.epochs ?? '?' })}`
      : '';
    const step = Number.isFinite(num(stage.step))
      ? ` · ${tl('STEP {step}/{steps}', { step: stage.step, steps: stage.steps ?? '?' })}`
      : '';
    const loss = Number.isFinite(num(stage.loss))
      ? ` · ${tl('LOSS {loss}', { loss: localDigits(Number(stage.loss).toFixed(3)) })}`
      : '';
    return `${state}${built}${epoch}${step}${loss}`;
  }
  return `${state}${built}`;
}

/** One line per trained model. */
export function llmModelLines(models) {
  return (Array.isArray(models) ? models : []).map((m) => {
    const before = num(m.heldOutLossBefore);
    const after = num(m.heldOutLossAfter);
    const learned = m.helped ? ` · ${tl('LEARNED')}` : '';
    const score =
      Number.isFinite(before) && Number.isFinite(after)
        ? ` · ${tl('HELD-OUT LOSS {before} → {after}', {
            before: localDigits(before.toFixed(3)),
            after: localDigits(after.toFixed(3)),
          })}${learned}`
        : '';
    const through = m.dataThrough
      ? ` · ${tl('DATA TO {day}', { day: m.dataThrough })}`
      : '';
    const from = m.postTrainedFrom
      ? ` · ${tl('POST-TRAINED FROM {name}', { name: m.postTrainedFrom })}`
      : '';
    return `${String(m.name).toUpperCase()} · ${m.base}${through}${score}${from}`;
  });
}

/**
 * What to do when the base model is not on this PC: the app never downloads
 * it; the owner fetches it once (a Hugging Face id) or names a folder.
 */
export function baseModelHint(status) {
  if (!status || status.baseOnMachine) return '';
  const base = String(status.config?.base || '');
  return /^[\w.-]+\/[\w.-]+$/.test(base)
    ? tl(
        'NOT ON THIS PC YET. GET IT ONCE (IT IS A LARGE DOWNLOAD): {command}   (or name a model folder on this PC)',
        {
          command: `hf download ${base} --local-dir .gev-data/llm/base/${base.split('/').pop()}`,
        },
      )
    : tl(
        'NO MODEL IN THAT FOLDER: it needs the model files (config.json and the weights).',
      );
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc, className, text, title) {
  const node = element(doc, 'button', className, text);
  node.type = 'button';
  if (title) node.title = title;
  return node;
}

function input(doc, { value = '', placeholder = '', label, type = 'text' }) {
  const field = element(doc, 'input');
  field.type = type;
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.value = value;
  field.placeholder = placeholder;
  field.setAttribute('aria-label', label || placeholder);
  return field;
}

/**
 * Mount the section in its host (#llm-training at the bottom of the AI World
 * tab, src/aiWorldPanel.js).
 * @param {{host: HTMLElement, documentRef?: Document, fetchImpl?: typeof fetch, signal?: AbortSignal, timers?: object}} options
 */
export function initLlmTrainingSetup({
  host,
  documentRef = globalThis.document,
  fetchImpl,
  signal,
  timers = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  },
} = {}) {
  if (!host || !documentRef?.createElement)
    return { refresh() {}, destroy() {} };
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
    const request = doFetch(`${LLM_TRAINING_API}/${route}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: lifetime.signal,
    });
    const response = await (method === 'DELETE'
      ? watchOwnerRemoval(request)
      : request);
    const payload = await response.json().catch(() => ({}));
    if (isOwnerRemovalRefusal(response, payload)) {
      // Only the PC removes: the list stays as it was, and nothing is said.
      noteOwnerRemovalRefusal();
      return null;
    }
    if (!response.ok)
      throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  };

  const act = async (route, options) => {
    try {
      const next = await call(route, options);
      if (next && typeof next.state === 'string') render(next);
      note = '';
    } catch (error) {
      if (lifetime.signal.aborted) return;
      note = String(error.message || error);
      render(status);
    }
  };

  const schedule = () => {
    timers.clearTimeout(pollTimer);
    if (lifetime.signal.aborted) return;
    pollTimer = timers.setTimeout(
      () => void refresh(),
      BUSY.has(status?.state) ? POLL_BUSY_MS : POLL_IDLE_MS,
    );
    pollTimer?.unref?.();
  };

  function render(next) {
    if (!next || lifetime.signal.aborted) return;
    status = next;
    const doc = documentRef;
    const can = llmControlStates(next.state);
    host.textContent = '';
    host.hidden = false;
    // Laid out like the tab's other sections (src/ui/styles/aiWorld.css).
    host.append(
      element(
        doc,
        'div',
        'cctv-summary-label',
        tl('CUSTOM LLM TRAINING · ON THIS MACHINE'),
      ),
      element(
        doc,
        'p',
        'social-note',
        tl(
          'Train your own language model on what this app records and on your own sources. The base model must already be on this PC; nothing is downloaded but your custom URLs. Training runs here (the GPU when there is one); the data and the model stay in .gev-data/llm/. Instructions: docs/TRAINING-GUIDE.md, part 4.',
        ),
      ),
    );

    // Name and base model.
    const fields = element(doc, 'div', 'ai-world-fields');
    const name = input(doc, {
      value: next.config?.name || '',
      placeholder: tl('MODEL NAME'),
      label: tl('Model name'),
    });
    name.dataset.field = 'name';
    const base = input(doc, {
      value: next.config?.base || '',
      placeholder: tl('BASE MODEL (org/name or a folder)'),
      label: tl('Base model'),
    });
    base.dataset.field = 'base';
    fields.append(
      element(doc, 'span', '', tl('MODEL NAME')),
      name,
      element(doc, 'span', '', tl('BASE MODEL')),
      base,
    );
    host.append(fields);
    // The offered bases, each saying whether it is on this PC; choosing one
    // fills the box (any other id or folder can still be typed there).
    const baseRow = element(doc, 'div', 'cctv-controls ai-world-actions');
    const choice = element(doc, 'select', 'llm-training-base-choice');
    choice.setAttribute('aria-label', tl('Choose a base model'));
    choice.dataset.field = 'base-choice';
    let known = false;
    for (const option of next.bases || []) {
      const node = element(
        doc,
        'option',
        '',
        `${tl(option.label)} · ${option.onMachine ? tl('ON THIS PC') : tl('NOT ON THIS PC')}`,
      );
      node.value = option.id;
      choice.append(node);
      if (option.id === next.config?.base) known = true;
    }
    const other = element(
      doc,
      'option',
      '',
      tl('ANOTHER MODEL (TYPE IT IN THE BOX)'),
    );
    other.value = '';
    choice.append(other);
    choice.value = known ? next.config.base : '';
    choice.addEventListener('change', () => {
      if (choice.value) base.value = choice.value;
    });
    const onMachine = element(
      doc,
      'span',
      'ai-world-note',
      next.baseOnMachine ? tl('ON THIS MACHINE') : tl('NOT ON THIS MACHINE'),
    );
    onMachine.dataset.onMachine = next.baseOnMachine ? 'true' : 'false';
    if ((next.bases || []).length) baseRow.append(choice);
    baseRow.append(onMachine);
    host.append(baseRow);
    const fetchHint = baseModelHint(next);
    if (fetchHint)
      host.append(
        element(doc, 'p', 'social-note ai-world-llm-warning', fetchHint),
      );

    // Data sources, each with its licence class, as TRAIN ON shows them.
    host.append(
      element(doc, 'p', 'social-note', tl('DATA SOURCES TO TRAIN FROM')),
    );
    const sources = element(
      doc,
      'div',
      'ai-world-domains llm-training-sources',
    );
    const ticked = new Set(next.config?.sources || []);
    const sourceBoxes = [];
    for (const source of next.sources || []) {
      const row = element(doc, 'div', 'ai-world-row');
      const label = element(doc, 'label', 'outbreak-mode');
      label.dataset.class = String(source.class || '');
      const box = input(doc, { type: 'checkbox', label: tl(source.label) });
      box.checked = ticked.has(source.id);
      box.dataset.source = source.id;
      sourceBoxes.push(box);
      label.append(
        box,
        element(doc, 'span', 'outbreak-swatch'),
        `${tl(source.label)} · ${classTag(source.class)}`,
      );
      row.append(label);
      sources.append(row);
    }
    host.append(sources);

    // Custom URLs and local sources: a list with REMOVE, then a box and ADD.
    const list = (title, items, field, placeholder, addRoute) => {
      host.append(element(doc, 'p', 'social-note', title));
      const ul = element(doc, 'ul', 'ai-world-list llm-training-list');
      ul.setAttribute('aria-label', title);
      for (const item of items) {
        const li = element(doc, 'li', 'ai-world-row');
        const value = typeof item === 'string' ? item : item.url;
        const state =
          typeof item === 'string'
            ? ''
            : item.ok === true
              ? ` · ${tl('FETCHED')}`
              : item.error
                ? ` · ${item.error}`
                : ` · ${tl('NOT FETCHED YET')}`;
        li.append(element(doc, 'span', 'ai-world-name', `${value}${state}`));
        const remove = button(
          doc,
          'scene-btn ai-world-area-remove',
          tl('REMOVE'),
          tl('Take it off the list (on this PC only)'),
        );
        remove.disabled = !can.edit;
        remove.addEventListener(
          'click',
          () =>
            void act(addRoute, { method: 'DELETE', body: { [field]: value } }),
        );
        li.append(remove);
        ul.append(li);
      }
      host.append(ul);
      const row = element(doc, 'div', 'cctv-controls ai-world-actions');
      const entry = input(doc, { placeholder, label: title });
      entry.dataset.field = `${addRoute}-entry`;
      const add = button(doc, 'scene-btn', tl('ADD'));
      add.disabled = !can.edit;
      add.addEventListener('click', () => {
        const value = String(entry.value || '').trim();
        if (value)
          void act(addRoute, { method: 'POST', body: { [field]: value } });
      });
      row.append(entry, add);
      host.append(row);
    };
    list(
      tl('CUSTOM URLS ({count} / {max})', {
        count: (next.urls || []).length,
        max: next.limits?.urls ?? 100,
      }),
      next.urls || [],
      'url',
      'https://…',
      'urls',
    );
    list(
      tl('LOCAL SOURCES ({count} / {max}) · FILES OR FOLDERS ON THIS PC', {
        count: (next.paths || []).length,
        max: next.limits?.paths ?? 50,
      }),
      next.paths || [],
      'path',
      tl('C:\\path\\to\\files'),
      'paths',
    );

    // Epochs and post-training.
    const settings = element(doc, 'div', 'ai-world-fields');
    const epochs = input(doc, {
      type: 'number',
      value: String(next.config?.epochs ?? 1),
      label: tl('Epochs'),
    });
    epochs.min = '1';
    epochs.max = '20';
    epochs.dataset.field = 'epochs';
    const from = element(doc, 'select');
    from.setAttribute('aria-label', tl('Post-train from'));
    from.dataset.field = 'postTrainFrom';
    const fresh = element(doc, 'option', '', tl('A NEW MODEL'));
    fresh.value = '';
    from.append(fresh);
    for (const model of next.models || []) {
      const option = element(
        doc,
        'option',
        '',
        tl('POST-TRAIN {name}', { name: String(model.name).toUpperCase() }),
      );
      option.value = model.name;
      from.append(option);
    }
    from.value = next.config?.postTrainFrom || '';
    settings.append(
      element(doc, 'span', '', tl('EPOCHS')),
      epochs,
      element(doc, 'span', '', tl('TRAIN')),
      from,
    );
    host.append(settings);
    const dailyLabel = element(doc, 'label', 'outbreak-mode ai-world-all');
    dailyLabel.dataset.class = 'all';
    const daily = input(doc, {
      type: 'checkbox',
      label: tl('Post-train daily'),
    });
    daily.checked = next.config?.daily === true;
    daily.dataset.field = 'daily';
    dailyLabel.append(
      daily,
      element(doc, 'span', 'outbreak-swatch'),
      tl('POST-TRAIN DAILY ON NEW DATA'),
    );
    host.append(dailyLabel);
    const saveRow = element(doc, 'div', 'cctv-controls ai-world-actions');
    const saveSettings = button(doc, 'scene-btn', tl('SAVE SETTINGS'));
    saveSettings.disabled = !can.edit;
    saveSettings.addEventListener('click', () => {
      const chosen = sourceBoxes
        .filter((box) => box.checked)
        .map((box) => box.dataset.source);
      void act('config', {
        method: 'POST',
        body: {
          name: name.value,
          base: base.value,
          sources: chosen,
          epochs: Number(epochs.value),
          postTrainFrom: from.value,
          daily: daily.checked,
        },
      });
    });
    saveRow.append(saveSettings);
    host.append(saveRow);

    // The run.
    const controls = element(doc, 'div', 'cctv-controls ai-world-actions');
    const start = button(
      doc,
      'scene-btn',
      tl('INITIALIZE TRAINING'),
      tl(
        'Fetch the URLs, build the dataset from the ticked sources, then train',
      ),
    );
    start.dataset.action = 'initialize';
    start.disabled = !can.initialize;
    start.addEventListener(
      'click',
      () => void act('initialize', { method: 'POST', body: {} }),
    );
    const pause = button(
      doc,
      'scene-btn',
      next.state === 'paused' ? tl('CONTINUE') : tl('PAUSE'),
    );
    pause.dataset.action = next.state === 'paused' ? 'continue' : 'pause';
    pause.disabled = !(can.pause || can.continue);
    pause.addEventListener(
      'click',
      () =>
        void act(next.state === 'paused' ? 'continue' : 'pause', {
          method: 'POST',
          body: {},
        }),
    );
    const stop = button(
      doc,
      'scene-btn',
      tl('STOP'),
      tl('End the run; the data and the model stay'),
    );
    stop.dataset.action = 'stop';
    stop.disabled = !can.stop;
    stop.addEventListener(
      'click',
      () => void act('stop', { method: 'POST', body: {} }),
    );
    controls.append(start, pause, stop);
    host.append(controls);
    const line = element(
      doc,
      'p',
      'ask-status llm-training-state',
      note || llmStateText(next),
    );
    line.setAttribute('role', 'status');
    line.dataset.ok = next.state === 'error' || note ? 'false' : 'true';
    host.append(line);
    const lines = llmModelLines(next.models);
    if (lines.length) {
      host.append(element(doc, 'p', 'social-note', tl('TRAINED MODELS')));
      const ul = element(doc, 'ul', 'ai-world-list llm-training-models');
      ul.setAttribute('aria-label', tl('Trained models'));
      for (const text of lines) ul.append(element(doc, 'li', '', text));
      host.append(ul);
    }
    schedule();
  }

  async function refresh() {
    try {
      render(await call('status'));
    } catch {
      // No server route (a production build, a LAN visitor): show nothing.
      if (!status) host.hidden = true;
      schedule();
    }
  }
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
