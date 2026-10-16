/**
 * POWER UP · CUSTOM LLM TRAINING (owner requests 2026-10-16: "add Custom LLM
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
 */
import {
  isOwnerRemovalRefusal,
  noteOwnerRemovalRefusal,
  watchOwnerRemoval,
} from './ui/ownerRemoval.js';

export const LLM_TRAINING_API = '/api/llm-training';
const POLL_BUSY_MS = 3_000;
const POLL_IDLE_MS = 15_000;
const BUSY = new Set(['fetching', 'building', 'training']);

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
  const state = String(status?.state || 'idle').toUpperCase();
  const stage = status?.stage || {};
  if (status?.state === 'error')
    return `ERROR · ${String(status.error || 'THE RUN FAILED').toUpperCase()}`;
  if (status?.state === 'fetching') return 'FETCHING CUSTOM URLS';
  if (status?.state === 'building') return 'BUILDING THE DATASET';
  const built = stage.built
    ? ` · ${stage.built.train ?? 0} EXAMPLES (${stage.built.heldout ?? 0} HELD OUT)`
    : '';
  if (status?.state === 'training' || status?.state === 'paused') {
    const epoch = Number.isFinite(num(stage.epoch))
      ? ` · EPOCH ${stage.epoch}/${stage.epochs ?? '?'}`
      : '';
    const step = Number.isFinite(num(stage.step))
      ? ` · STEP ${stage.step}/${stage.steps ?? '?'}`
      : '';
    const loss = Number.isFinite(num(stage.loss))
      ? ` · LOSS ${Number(stage.loss).toFixed(3)}`
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
    const score =
      Number.isFinite(before) && Number.isFinite(after)
        ? ` · HELD-OUT LOSS ${before.toFixed(3)} → ${after.toFixed(3)}${m.helped ? ' · LEARNED' : ''}`
        : '';
    const through = m.dataThrough ? ` · DATA TO ${m.dataThrough}` : '';
    const from = m.postTrainedFrom
      ? ` · POST-TRAINED FROM ${m.postTrainedFrom}`
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
    ? `NOT ON THIS PC YET. GET IT ONCE (IT IS A LARGE DOWNLOAD): hf download ${base} --local-dir .gev-data/llm/base/${base.split('/').pop()}   (or name a model folder on this PC)`
    : 'NO MODEL IN THAT FOLDER: it needs the model files (config.json and the weights).';
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
 * Mount the section in its host (POWER UP, src/keySetup.js).
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
    host.append(
      element(
        doc,
        'h3',
        'private-cams-heading',
        'CUSTOM LLM TRAINING · ON THIS MACHINE',
      ),
      element(
        doc,
        'p',
        'key-setup-unlocks',
        'Train your own language model on what this app records and on your own sources. The base model must already be on this PC; nothing is downloaded but your custom URLs. Training runs here (the GPU when there is one); the data and the model stay in .gev-data/llm/. Instructions: docs/TRAINING-GUIDE.md, part 4.',
      ),
    );
    const box = element(doc, 'div', 'private-cams-site llm-training-box');
    host.append(box);

    // Name and base model.
    const head = element(doc, 'div', 'private-cams-site-head');
    const name = input(doc, {
      value: next.config?.name || '',
      placeholder: 'MODEL NAME',
      label: 'Model name',
    });
    name.dataset.field = 'name';
    const base = input(doc, {
      value: next.config?.base || '',
      placeholder: 'BASE MODEL (org/name or a folder)',
      label: 'Base model',
    });
    base.dataset.field = 'base';
    // The offered bases, each saying whether it is on this PC; choosing one
    // fills the box (any other id or folder can still be typed there).
    const choice = element(doc, 'select', 'llm-training-base-choice');
    choice.setAttribute('aria-label', 'Choose a base model');
    choice.dataset.field = 'base-choice';
    let known = false;
    for (const option of next.bases || []) {
      const node = element(
        doc,
        'option',
        '',
        `${option.label} · ${option.onMachine ? 'ON THIS PC' : 'NOT ON THIS PC'}`,
      );
      node.value = option.id;
      choice.append(node);
      if (option.id === next.config?.base) known = true;
    }
    const other = element(
      doc,
      'option',
      '',
      'ANOTHER MODEL (TYPE IT IN THE BOX)',
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
      'private-cams-transport',
      next.baseOnMachine ? 'ON THIS MACHINE' : 'NOT ON THIS MACHINE',
    );
    onMachine.dataset.transport = next.baseOnMachine ? 'direct' : 'none';
    head.append(name, base, onMachine);
    box.append(head);
    if ((next.bases || []).length) box.append(choice);
    const fetchHint = baseModelHint(next);
    if (fetchHint)
      box.append(element(doc, 'p', 'private-cams-warning', fetchHint));

    // Data sources.
    box.append(
      element(doc, 'p', 'private-cams-note', 'DATA SOURCES TO TRAIN FROM'),
    );
    const sources = element(
      doc,
      'div',
      'device-feeds-options llm-training-sources',
    );
    const ticked = new Set(next.config?.sources || []);
    for (const source of next.sources || []) {
      const label = element(doc, 'label', 'device-feeds-option');
      const box2 = input(doc, { type: 'checkbox', label: source.label });
      box2.checked = ticked.has(source.id);
      box2.dataset.source = source.id;
      label.append(
        box2,
        ` ${source.label} · ${String(source.class).toUpperCase()}`,
      );
      sources.append(label);
    }
    box.append(sources);

    // Custom URLs.
    const list = (title, items, field, placeholder, addRoute) => {
      box.append(element(doc, 'p', 'private-cams-note', title));
      const ul = element(doc, 'ul', 'device-feeds-list llm-training-list');
      for (const item of items) {
        const li = element(doc, 'li', 'private-cams-actions');
        const value = typeof item === 'string' ? item : item.url;
        const state =
          typeof item === 'string'
            ? ''
            : item.ok === true
              ? ' · FETCHED'
              : item.error
                ? ` · ${item.error}`
                : ' · NOT FETCHED YET';
        li.append(
          element(doc, 'span', 'private-cams-note', `${value}${state}`),
        );
        const remove = button(
          doc,
          'private-cams-remove-camera',
          'REMOVE',
          'Take it off the list (on this PC only)',
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
      box.append(ul);
      const row = element(doc, 'div', 'private-cams-actions');
      const entry = input(doc, { placeholder, label: title });
      entry.dataset.field = `${addRoute}-entry`;
      const add = button(doc, 'private-cams-add', 'ADD');
      add.disabled = !can.edit;
      add.addEventListener('click', () => {
        const value = String(entry.value || '').trim();
        if (value)
          void act(addRoute, { method: 'POST', body: { [field]: value } });
      });
      row.append(entry, add);
      box.append(row);
    };
    list(
      `CUSTOM URLS (${(next.urls || []).length} / ${next.limits?.urls ?? 100})`,
      next.urls || [],
      'url',
      'https://…',
      'urls',
    );
    list(
      `LOCAL SOURCES (${(next.paths || []).length} / ${next.limits?.paths ?? 50}) · FILES OR FOLDERS ON THIS PC`,
      next.paths || [],
      'path',
      'C:\\path\\to\\files',
      'paths',
    );

    // Epochs and post-training.
    const options = element(doc, 'div', 'private-cams-actions');
    const epochs = input(doc, {
      type: 'number',
      value: String(next.config?.epochs ?? 1),
      label: 'Epochs',
    });
    epochs.min = '1';
    epochs.max = '20';
    epochs.dataset.field = 'epochs';
    const from = element(doc, 'select');
    from.setAttribute('aria-label', 'Post-train from');
    from.dataset.field = 'postTrainFrom';
    const fresh = element(doc, 'option', '', 'A NEW MODEL');
    fresh.value = '';
    from.append(fresh);
    for (const model of next.models || []) {
      const option = element(
        doc,
        'option',
        '',
        `POST-TRAIN ${String(model.name).toUpperCase()}`,
      );
      option.value = model.name;
      from.append(option);
    }
    from.value = next.config?.postTrainFrom || '';
    const dailyLabel = element(doc, 'label', 'device-feeds-option');
    const daily = input(doc, { type: 'checkbox', label: 'Post-train daily' });
    daily.checked = next.config?.daily === true;
    daily.dataset.field = 'daily';
    dailyLabel.append(daily, ' POST-TRAIN DAILY ON NEW DATA');
    const saveSettings = button(
      doc,
      'key-setup-apply private-cams-save',
      'SAVE SETTINGS',
    );
    saveSettings.disabled = !can.edit;
    saveSettings.addEventListener('click', () => {
      const chosen = [...sources.children]
        .map((label) => label.children?.[0])
        .filter((box2) => box2?.checked)
        .map((box2) => box2.dataset.source);
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
    options.append(
      element(doc, 'span', 'private-cams-note', 'EPOCHS'),
      epochs,
      from,
      dailyLabel,
      saveSettings,
    );
    box.append(options);

    // The run.
    const controls = element(doc, 'div', 'private-cams-actions');
    const start = button(
      doc,
      'key-setup-apply private-cams-save',
      'INITIALIZE TRAINING',
      'Fetch the URLs, build the dataset from the ticked sources, then train',
    );
    start.dataset.action = 'initialize';
    start.disabled = !can.initialize;
    start.addEventListener(
      'click',
      () => void act('initialize', { method: 'POST', body: {} }),
    );
    const pause = button(
      doc,
      'private-cams-add',
      next.state === 'paused' ? 'CONTINUE' : 'PAUSE',
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
      'private-cams-add',
      'STOP',
      'End the run; the data and the model stay',
    );
    stop.dataset.action = 'stop';
    stop.disabled = !can.stop;
    stop.addEventListener(
      'click',
      () => void act('stop', { method: 'POST', body: {} }),
    );
    controls.append(start, pause, stop);
    box.append(controls);
    const line = element(
      doc,
      'p',
      'device-feeds-state llm-training-state',
      note || llmStateText(next),
    );
    line.setAttribute('role', 'status');
    line.dataset.ok = next.state === 'error' || note ? 'false' : 'true';
    box.append(line);
    const lines = llmModelLines(next.models);
    if (lines.length) {
      box.append(element(doc, 'p', 'private-cams-note', 'TRAINED MODELS'));
      const ul = element(doc, 'ul', 'device-feeds-list llm-training-models');
      for (const text of lines)
        ul.append(element(doc, 'li', 'private-cams-note', text));
      box.append(ul);
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
