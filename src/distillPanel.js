/**
 * AI DISTILLATION, a left-stack tab under the AI World Training Sim (owner
 * request 2026-10-19). Its seven headings each hold the owner's own
 * sub-headings, as many as wanted; each sub-heading is a saved run: a name,
 * questions typed or loaded from a CSV file, the teachers its heading asks
 * for, the prompts, a web-search tick, and its dataset of ground truths.
 *
 * Above the headings: the teachers (the Ask panel's LLMs, GROK BOT and
 * OPENAI DOTS with every fallback, the custom LLMs trained here) with the
 * route each one uses now, the run with PAUSE / CONTINUE and STOP, and, while
 * a fallback waits for the owner, the prompt to copy or paste into the app and
 * a box for its reply. The routes are /api/distill (server/providers/distill.js).
 *
 * The headings and sub-headings are built once and updated in place: an open
 * one stays open, and settings being edited keep what was typed until SAVE.
 * The text is marked with tl() and tln().
 */
import { formatCount } from './aiWorldSelection.mjs';
import { DISTILL_HEADINGS } from './distillCore.mjs';
import { msgl, tl, tln } from './i18n/index.js';
import { copyText as defaultCopyText } from './ui/copyText.js';
import {
  isOwnerRemovalRefusal,
  noteOwnerRemovalRefusal,
  watchOwnerRemoval,
} from './ui/ownerRemoval.js';

export const DISTILL_API = '/api/distill';
const POLL_BUSY_MS = 2_000;
const POLL_IDLE_MS = 10_000;
const CONFIRM_MS = 6_000;
const APP_OPEN_URLS = Object.freeze({
  'grok-bot': '/api/social/grok-bot/open',
  chatgpt: '/api/social/openai-dots/open',
});
const APP_NAMES = Object.freeze({
  'grok-bot': msgl('GROK BOT'),
  chatgpt: msgl('CHATGPT'),
});
const ROUTE_NAMES = Object.freeze({
  api: msgl('KEY'),
  key: msgl('KEY'),
  computer: msgl('GROK BOT COMPUTER'),
  webhook: msgl('CHIEF OF STAFF WEBHOOK'),
  desktop: msgl('APP'),
  local: msgl('ON THIS PC'),
});
const STATE_NAMES = Object.freeze({
  idle: msgl('IDLE'),
  running: msgl('RUNNING'),
  waiting: msgl('WAITING FOR YOUR PASTE'),
  stopping: msgl('STOPPING'),
  paused: msgl('PAUSED'),
  stopped: msgl('STOPPED'),
  done: msgl('DONE'),
  error: msgl('ERROR'),
});
const PICK_NAMES = Object.freeze({
  'best-graded': msgl('THE BEST GRADED ANSWER'),
  writer: msgl('ONE A REVIEWER WRITES FROM ALL OF THEM'),
});
const upper = (v) => String(v ?? '').toUpperCase();

/**
 * A teacher's line: whether it answers now, and by which route (then which).
 * An app's reply comes back by itself where this PC can (`auto`), else it is
 * pasted back.
 */
export function teacherState(teacher) {
  const routes = teacher?.routes || [];
  if (!teacher?.ready || !routes.length)
    return { state: 'off', text: tl('NOT SET UP: ADD ITS KEY IN POWER UP') };
  const names = routes.map((r) => tl(ROUTE_NAMES[r] || upper(r)));
  const first = routes[0];
  const viaApp = first === 'webhook' || first === 'desktop';
  const paste = viaApp && teacher.auto !== true;
  const head = viaApp
    ? paste
      ? tl('{route} · PASTE THE REPLY BACK', { route: names[0] })
      : tl('{route} · THE REPLY COMES BACK BY ITSELF', { route: names[0] })
    : teacher.model
      ? `${names[0]} · ${teacher.model}`
      : names[0];
  const then =
    names.length > 1
      ? ` · ${tl('THEN {routes}', { routes: names.slice(1).join(', ') })}`
      : '';
  return { state: paste ? 'paste' : 'ready', text: `${head}${then}` };
}

/** The run's line. */
export function runText(run) {
  const state = run?.state || 'idle';
  const name = STATE_NAMES[state] ? tl(STATE_NAMES[state]) : upper(state);
  if (state === 'idle' || !run?.featureId)
    return tl('RUN · {state}', { state: name });
  const parts = [
    `${tl('RUN · {state}', { state: name })} · ${upper(run.name)}`,
  ];
  if (run.question)
    parts.push(
      tl('QUESTION {n}/{total}', { n: run.question, total: run.total ?? '?' }),
    );
  if (run.calls)
    parts.push(
      tln(run.calls, '{count} CALL', '{count} CALLS', {
        count: formatCount(run.calls),
      }),
    );
  if (run.desktop?.app)
    parts.push(
      tl('{app} IS ANSWERING: ITS REPLY COMES BACK BY ITSELF', {
        app: tl(APP_NAMES[run.desktop.app] || upper(run.desktop.app)),
      }),
    );
  if (run.pauseWanted && state !== 'paused')
    parts.push(tl('PAUSES AFTER THIS QUESTION'));
  if (state === 'error' && run.error) parts.push(upper(run.error));
  return parts.join(' · ');
}

/** A sub-heading's one-line summary. */
export function featureSummary(f) {
  return [
    f.name,
    tln(f.questions, '{count} QUESTION', '{count} QUESTIONS', {
      count: formatCount(f.questions),
    }),
    tl('{done} DONE', {
      done: formatCount(Math.min(f.cursor ?? 0, f.questions)),
    }),
    tln(f.records, '{count} GROUND TRUTH', '{count} GROUND TRUTHS', {
      count: formatCount(f.records),
    }),
  ].join(' · ');
}

/** What a run will cost before it starts. */
export function estimateText(e) {
  if (!e) return '';
  const head = tl(
    '{questions} QUESTIONS FROM QUESTION {from} · {each} PAID CALLS EACH · {calls} CALLS IN ALL',
    {
      questions: formatCount(e.questions),
      from: e.from,
      each: e.callsPerQuestion,
      calls: formatCount(e.calls),
    },
  );
  return e.pastes
    ? `${head} · ${tl('{pastes} REPLIES TO PASTE BACK', { pastes: formatCount(e.pastes) })}`
    : head;
}

/**
 * The paste box's line: who waits, why (a reply that did not come back by
 * itself), and what to do.
 */
export function pendingText(p) {
  if (!p) return '';
  const app = tl(APP_NAMES[p.app] || upper(p.app));
  const how =
    p.route === 'webhook'
      ? tl(
          'SENT TO THE CHIEF OF STAFF WEBHOOK: PASTE ITS REPLY FROM GROK BOT HERE',
        )
      : p.sent
        ? tl('ALREADY IN {app}: PASTE ITS REPLY HERE', { app })
        : tl('OPEN {app}, PASTE THE PROMPT THERE, THEN PASTE ITS REPLY HERE', {
            app,
          });
  return [
    tl('WAITING FOR YOUR PASTE'),
    p.label,
    tl('QUESTION {n}', { n: p.question }),
    tl('TURN {n}', { n: p.turn }),
    ...(p.note
      ? [`${tl('THE REPLY DID NOT COME BACK BY ITSELF')} (${upper(p.note)})`]
      : []),
    how,
  ].join(' · ');
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

function textarea(doc, label, placeholder = '') {
  const node = element(doc, 'textarea');
  node.setAttribute('aria-label', label);
  node.placeholder = placeholder;
  node.spellcheck = false;
  return node;
}

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
}

function fillList(doc, ul, lines) {
  ul.textContent = '';
  for (const text of lines) ul.append(element(doc, 'li', '', text));
  ul.hidden = lines.length === 0;
}

/**
 * Mount the tab on #distill-panel.
 * @param {{documentRef?: Document, fetchImpl?: typeof fetch, signal?: AbortSignal, timers?: object, copyText?: Function}} options
 */
export function initDistillPanel({
  documentRef = globalThis.document,
  fetchImpl,
  signal,
  timers = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  },
  copyText = defaultCopyText,
} = {}) {
  const doc = documentRef;
  const host = doc?.getElementById?.('distill-body');
  const line = doc?.getElementById?.('distill-status');
  if (!host || !doc?.createElement)
    return { refresh() {}, render() {}, destroy() {} };
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const lifetime = new AbortController();
  if (signal) {
    if (signal.aborted) lifetime.abort();
    else
      signal.addEventListener('abort', () => lifetime.abort(), { once: true });
  }
  let status = null;
  let note = '';
  let pollTimer = null;
  const featureUi = new Map();

  const call = async (route, { method = 'GET', body } = {}) => {
    const request = doFetch(`${DISTILL_API}/${route}`, {
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
      // Only the PC removes: nothing changes, and nothing is said.
      noteOwnerRemovalRefusal();
      return null;
    }
    if (!response.ok)
      throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  };
  /** A write; its answer (a status) is shown, its refusal goes on the run line. */
  const act = async (route, body = {}, method = 'POST') => {
    try {
      const next = await call(route, { method, body });
      note = '';
      if (next?.features) render(next);
      else render(status);
      return next;
    } catch (error) {
      if (lifetime.signal.aborted) return null;
      note = String(error.message || error);
      render(status);
      return null;
    }
  };

  // --- The frame, built once ---------------------------------------------------------
  const ui = {};
  host.append(element(doc, 'div', 'distill-label', tl('TEACHERS')));
  ui.teachers = element(doc, 'ul', 'distill-list distill-teachers');
  ui.teachers.setAttribute('aria-label', tl('Teachers'));
  host.append(ui.teachers);
  const runRow = element(doc, 'div', 'distill-actions');
  ui.pause = button(doc, tl('PAUSE'), 'pause');
  ui.pause.addEventListener(
    'click',
    () =>
      void act(
        status?.run?.state === 'paused' || status?.run?.state === 'stopped'
          ? 'continue'
          : 'pause',
      ),
  );
  ui.stop = button(
    doc,
    tl('STOP'),
    'stop',
    tl('End the run; the question it was on is not kept'),
  );
  ui.stop.addEventListener('click', () => void act('stop'));
  runRow.append(ui.pause, ui.stop);
  host.append(runRow);
  ui.errors = element(doc, 'ul', 'distill-list distill-error');
  host.append(ui.errors);

  // The reply to paste back from a fallback that cannot send it.
  ui.pending = element(doc, 'div', 'distill-pending');
  ui.pending.hidden = true;
  ui.pendingLine = element(doc, 'p', 'distill-label');
  ui.prompt = textarea(doc, tl('The prompt'));
  ui.prompt.readOnly = true;
  const pendingRow = element(doc, 'div', 'distill-actions');
  ui.copy = button(doc, tl('COPY PROMPT'), 'copy');
  ui.copy.addEventListener('click', async () => {
    const ok = await copyText(ui.prompt.value).catch(() => false);
    note = ok ? tl('PROMPT COPIED') : tl('COPY THE PROMPT FROM THE BOX');
    render(status);
  });
  ui.openApp = button(doc, tl('OPEN THE APP AND PASTE'), 'open-app');
  ui.openApp.addEventListener('click', async () => {
    const p = status?.run?.pending;
    const url = APP_OPEN_URLS[p?.app];
    if (!url) return;
    await copyText(ui.prompt.value).catch(() => false);
    try {
      const response = await doFetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paste: true, text: ui.prompt.value }),
        signal: lifetime.signal,
      });
      const data = await response.json().catch(() => ({}));
      note = response.ok
        ? data.pasted
          ? tl('PASTED INTO {app}: SEND IT THERE, THEN PASTE ITS REPLY HERE', {
              app: tl(APP_NAMES[p.app]),
            })
          : tl(
              '{app} OPENED: PASTE THE PROMPT (IT IS COPIED), THEN ITS REPLY HERE',
              { app: tl(APP_NAMES[p.app]) },
            )
        : String(data.error || `HTTP ${response.status}`);
    } catch (error) {
      if (lifetime.signal.aborted) return;
      note = String(error.message || error);
    }
    render(status);
  });
  pendingRow.append(ui.copy, ui.openApp);
  ui.reply = textarea(doc, tl('The reply'), tl('Paste the reply here'));
  const replyRow = element(doc, 'div', 'distill-actions');
  ui.submit = button(doc, tl('SUBMIT ANSWER'), 'paste');
  ui.submit.addEventListener('click', async () => {
    const answer = String(ui.reply.value || '').trim();
    if (!answer) return;
    if (await act('paste', { answer })) ui.reply.value = '';
  });
  ui.skip = button(
    doc,
    tl('SKIP'),
    'skip',
    tl('No reply: this question is not kept'),
  );
  ui.skip.addEventListener('click', () => void act('skip'));
  replyRow.append(ui.submit, ui.skip);
  ui.pending.append(ui.pendingLine, ui.prompt, pendingRow, ui.reply, replyRow);
  host.append(ui.pending);

  // The seven headings.
  const headings = new Map();
  for (const heading of DISTILL_HEADINGS) {
    const details = element(doc, 'details', 'distill-heading');
    details.dataset.heading = String(heading.id);
    details.append(element(doc, 'summary', '', tl(heading.title)));
    details.append(element(doc, 'p', 'distill-note', tl(heading.note)));
    const addRow = element(doc, 'div', 'distill-actions');
    const name = input(doc, {
      label: tl('New heading name'),
      placeholder: tl('NAME OF THE NEW HEADING'),
    });
    name.maxLength = 80;
    name.dataset.field = 'new-name';
    const add = button(doc, tl('ADD HEADING'), 'add-feature');
    add.addEventListener('click', async () => {
      const value = String(name.value || '').trim();
      if (!value) return;
      if (await act('features', { heading: heading.id, name: value }))
        name.value = '';
    });
    addRow.append(name, add);
    details.append(addRow);
    const list = element(doc, 'div', 'distill-features');
    details.append(list);
    host.append(details);
    headings.set(heading.id, { details, list });
  }

  // --- A sub-heading -----------------------------------------------------------------
  const teacherOptions = () =>
    (status?.teachers || []).map((t) => [
      t.id,
      t.ready ? t.label : `${t.label} · ${tl('NOT SET UP')}`,
    ]);

  const buildFeature = (f) => {
    const box = element(doc, 'details', 'distill-feature');
    box.dataset.feature = f.id;
    const summary = element(doc, 'summary', '', featureSummary(f));
    box.append(summary);
    const refs = { box, summary, dirty: false, heading: f.heading };
    const markDirty = () => {
      refs.dirty = true;
    };
    const fields = (pairs) => {
      const div = element(doc, 'div', 'distill-fields');
      for (const [label, node] of pairs)
        div.append(element(doc, 'span', '', label), node);
      box.append(div);
    };
    const row = (...nodes) => {
      const div = element(doc, 'div', 'distill-actions');
      div.append(...nodes);
      box.append(div);
      return div;
    };

    // Its name.
    refs.name = input(doc, { label: tl('Heading name') });
    refs.name.maxLength = 80;
    refs.name.value = f.name;
    refs.rename = button(doc, tl('RENAME'), 'rename');
    refs.rename.addEventListener(
      'click',
      () => void act('features/update', { id: f.id, name: refs.name.value }),
    );
    fields([[tl('NAME'), refs.name]]);
    row(refs.rename);

    // Questions.
    refs.questionsLine = element(doc, 'p', 'distill-label');
    box.append(refs.questionsLine);
    refs.preview = element(doc, 'ul', 'distill-list');
    box.append(refs.preview);
    refs.typed = textarea(
      doc,
      tl('Questions'),
      tl('One question a line (a blank line keeps a long one whole)'),
    );
    box.append(refs.typed);
    refs.addQuestions = button(doc, tl('ADD QUESTIONS'), 'add-questions');
    refs.addQuestions.addEventListener('click', async () => {
      const text = String(refs.typed.value || '').trim();
      if (!text) return;
      if (await act('questions', { id: f.id, text })) refs.typed.value = '';
    });
    refs.file = input(doc, {
      type: 'file',
      label: tl('CSV file of questions'),
    });
    refs.file.accept = '.csv,text/csv,text/plain';
    refs.loadCsv = button(doc, tl('LOAD CSV'), 'load-csv');
    refs.loadCsv.addEventListener('click', async () => {
      const file = refs.file.files?.[0];
      if (!file) {
        note = tl('Choose a CSV file first.');
        render(status);
        return;
      }
      const csv = await file.text();
      if (await act('questions', { id: f.id, csv })) refs.file.value = '';
    });
    refs.clearQuestions = button(
      doc,
      tl('CLEAR QUESTIONS'),
      'clear-questions',
      tl('On this PC only'),
    );
    refs.clearQuestions.addEventListener(
      'click',
      () => void act('questions', { id: f.id }, 'DELETE'),
    );
    row(refs.addQuestions, refs.file, refs.loadCsv, refs.clearQuestions);

    // Teachers, as the heading asks for them.
    const pickOne = (field) => {
      const node = element(doc, 'select');
      node.setAttribute('aria-label', field);
      node.addEventListener('change', markDirty);
      return node;
    };
    const ticks = (field) => {
      const div = element(doc, 'div', 'distill-ticks');
      div.dataset.field = field;
      return div;
    };
    if (f.heading === 2) {
      box.append(
        element(doc, 'p', 'distill-label', tl('ANSWER WITH (ONE TO ALL)')),
      );
      refs.teachers = ticks('teachers');
      box.append(refs.teachers);
      const reviewLabel = element(doc, 'label', 'distill-tick');
      refs.review = input(doc, { type: 'checkbox', label: tl('Review') });
      refs.review.addEventListener('change', markDirty);
      reviewLabel.append(
        refs.review,
        tl(
          'SEND THE QUESTION AND EVERY ANSWER FOR ADVERSARIAL REVIEW AND GRADING',
        ),
      );
      box.append(reviewLabel);
      box.append(
        element(doc, 'p', 'distill-label', tl('REVIEWERS (ONE TO ALL)')),
      );
      refs.reviewers = ticks('reviewers');
      box.append(refs.reviewers);
      refs.pick = element(doc, 'select');
      refs.pick.setAttribute('aria-label', tl('Ground truth'));
      refs.pick.addEventListener('change', markDirty);
      setOptions(
        doc,
        refs.pick,
        Object.entries(PICK_NAMES).map(([v, t]) => [v, tl(t)]),
      );
      refs.writer = pickOne(tl('Writer'));
      fields([
        [tl('GROUND TRUTH'), refs.pick],
        [tl('WRITER'), refs.writer],
      ]);
    } else if (f.heading === 1 || f.heading === 3 || f.heading === 4) {
      refs.t1 = pickOne(tl('Teacher'));
      fields([[tl('TEACHER'), refs.t1]]);
    } else {
      refs.t1 = pickOne(tl('First teacher'));
      refs.t2 = pickOne(tl('Second teacher'));
      const pairs = [
        [tl('FIRST TEACHER'), refs.t1],
        [tl('SECOND TEACHER (DIFFERENT)'), refs.t2],
      ];
      if (f.heading === 6) {
        refs.turn3 = element(doc, 'select');
        refs.turn3.setAttribute('aria-label', tl('Turn 3'));
        refs.turn3.addEventListener('change', markDirty);
        setOptions(doc, refs.turn3, [
          ['turn2', tl("BACK TO TURN 2'S TEACHER")],
          ['turn1', tl("BACK TO TURN 1'S TEACHER")],
        ]);
        pairs.push([tl('TURN 3'), refs.turn3]);
      }
      fields(pairs);
    }
    const searchLabel = element(doc, 'label', 'distill-tick');
    refs.webSearch = input(doc, { type: 'checkbox', label: tl('Web search') });
    refs.webSearch.addEventListener('change', markDirty);
    searchLabel.append(
      refs.webSearch,
      tl('GROK BOT AND OPENAI DOTS SEARCH THE WEB'),
    );
    box.append(searchLabel);

    // Prompts, folded.
    const prompts = element(doc, 'details', 'distill-prompts');
    prompts.append(element(doc, 'summary', '', tl('PROMPTS')));
    refs.prompts = {};
    const promptKeys =
      f.heading === 2
        ? ['system', 'grade', 'write']
        : f.heading === 1
          ? ['system']
          : ['system', 'review'];
    const promptNames = {
      system: tl('TEACHER INSTRUCTIONS'),
      review: tl(
        'ADVERSARIAL REVIEW ({question} {responseId} {teacher} {response})',
      ),
      grade: tl('GRADING ({question} {answers})'),
      write: tl('WRITING THE GROUND TRUTH ({question} {answers} {reviews})'),
    };
    for (const key of promptKeys) {
      prompts.append(element(doc, 'p', 'distill-label', promptNames[key]));
      const area = textarea(doc, promptNames[key]);
      area.addEventListener('input', markDirty);
      refs.prompts[key] = area;
      prompts.append(area);
    }
    box.append(prompts);
    refs.save = button(doc, tl('SAVE SETTINGS'), 'save');
    refs.save.addEventListener('click', async () => {
      const next = await act('features/update', {
        id: f.id,
        config: readConfig(refs),
      });
      if (next) {
        refs.dirty = false;
        render(next);
      }
    });
    row(refs.save);

    // The run.
    const freshLabel = element(doc, 'label', 'distill-tick');
    refs.fresh = input(doc, { type: 'checkbox', label: tl('Start over') });
    freshLabel.append(refs.fresh, tl('START OVER FROM THE FIRST QUESTION'));
    box.append(freshLabel);
    refs.estimate = button(
      doc,
      tl('ESTIMATE'),
      'estimate',
      tl('The paid calls this run makes, before it starts'),
    );
    refs.confirm = button(doc, tl('CONFIRM START'), 'start');
    refs.confirm.disabled = true;
    refs.estimateLine = element(doc, 'p', 'distill-note');
    refs.estimate.addEventListener('click', async () => {
      try {
        const got = await call('estimate', {
          method: 'POST',
          body: { id: f.id, fresh: refs.fresh.checked },
        });
        refs.estimated = got?.estimate || null;
        refs.estimateLine.textContent = estimateText(refs.estimated);
        refs.confirm.disabled = !refs.estimated?.questions;
        note = '';
      } catch (error) {
        refs.estimated = null;
        refs.estimateLine.textContent = '';
        refs.confirm.disabled = true;
        note = String(error.message || error);
      }
      render(status);
    });
    refs.confirm.addEventListener('click', async () => {
      const next = await act('start', {
        id: f.id,
        confirm: true,
        fresh: refs.fresh.checked,
      });
      if (next) {
        refs.confirm.disabled = true;
        refs.fresh.checked = false;
      }
    });
    row(refs.estimate, refs.confirm);
    box.append(refs.estimateLine);

    // The dataset.
    refs.datasetLine = element(doc, 'p', 'distill-label');
    box.append(refs.datasetLine);
    refs.jsonl = element(doc, 'a', 'scene-btn', tl('EXPORT JSONL'));
    refs.jsonl.href = `${DISTILL_API}/export?id=${encodeURIComponent(f.id)}&format=jsonl`;
    refs.jsonl.download = '';
    refs.csv = element(doc, 'a', 'scene-btn', tl('EXPORT CSV'));
    refs.csv.href = `${DISTILL_API}/export?id=${encodeURIComponent(f.id)}&format=csv`;
    refs.csv.download = '';
    refs.clearData = button(
      doc,
      tl('CLEAR DATASET'),
      'clear-dataset',
      tl('On this PC only'),
    );
    refs.remove = button(
      doc,
      tl('DELETE HEADING'),
      'remove',
      tl('On this PC only; a second press deletes it'),
    );
    refs.remove.className = 'scene-btn distill-danger';
    const twoStep = (node, word, run) => {
      let armed = false;
      let timer = null;
      node.addEventListener('click', () => {
        timers.clearTimeout(timer);
        if (armed) {
          armed = false;
          node.textContent = word;
          void run();
          return;
        }
        armed = true;
        node.textContent = tl('PRESS AGAIN TO CONFIRM');
        timer = timers.setTimeout(() => {
          armed = false;
          node.textContent = word;
        }, CONFIRM_MS);
      });
    };
    twoStep(refs.clearData, tl('CLEAR DATASET'), () =>
      act('dataset', { id: f.id }, 'DELETE'),
    );
    twoStep(refs.remove, tl('DELETE HEADING'), () =>
      act('features', { id: f.id }, 'DELETE'),
    );
    row(refs.jsonl, refs.csv, refs.clearData, refs.remove);
    return refs;
  };

  const ticksFill = (div, chosen, keepUi) => {
    const teachers = status?.teachers || [];
    const ids = teachers.map((t) => t.id).join('|');
    const current = keepUi
      ? Array.from(div.children)
          .map((l) => l.children?.[0])
          .filter((box) => box?.checked)
          .map((box) => box.dataset.teacher)
      : chosen;
    if (div.dataset.ids !== ids || !keepUi) {
      div.textContent = '';
      for (const t of teachers) {
        const label = element(doc, 'label', 'distill-tick');
        const box = input(doc, { type: 'checkbox', label: t.label });
        box.dataset.teacher = t.id;
        box.checked = current.includes(t.id);
        box.disabled = !t.ready && !current.includes(t.id);
        box.addEventListener('change', () => {
          const refs = [...featureUi.values()].find(
            (r) => r.teachers === div || r.reviewers === div,
          );
          if (refs) refs.dirty = true;
        });
        label.append(
          box,
          t.ready ? t.label : `${t.label} · ${tl('NOT SET UP')}`,
        );
        div.append(label);
      }
      div.dataset.ids = ids;
    }
  };

  const fillConfig = (refs, f) => {
    const cfg = f.config || {};
    const keep = refs.dirty;
    const options = [['', tl('CHOOSE A TEACHER')], ...teacherOptions()];
    for (const key of ['t1', 't2', 'writer']) {
      if (!refs[key]) continue;
      setOptions(doc, refs[key], options);
      if (!keep) refs[key].value = cfg[key] || '';
    }
    if (refs.teachers) ticksFill(refs.teachers, cfg.teachers || [], keep);
    if (refs.reviewers) ticksFill(refs.reviewers, cfg.reviewers || [], keep);
    if (keep) return;
    if (refs.review) refs.review.checked = cfg.review !== false;
    if (refs.pick) refs.pick.value = cfg.pick || 'best-graded';
    if (refs.turn3) refs.turn3.value = cfg.turn3From || 'turn2';
    refs.webSearch.checked = cfg.webSearch !== false;
    for (const [key, area] of Object.entries(refs.prompts))
      area.value = cfg.prompts?.[key] ?? status?.prompts?.[key] ?? '';
  };

  const readConfig = (refs) => {
    const ticked = (div) =>
      Array.from(div.children)
        .map((l) => l.children?.[0])
        .filter((box) => box?.checked)
        .map((box) => box.dataset.teacher);
    const config = { webSearch: refs.webSearch.checked, prompts: {} };
    for (const key of ['t1', 't2', 'writer'])
      if (refs[key]) config[key] = refs[key].value;
    if (refs.teachers) config.teachers = ticked(refs.teachers);
    if (refs.reviewers) config.reviewers = ticked(refs.reviewers);
    if (refs.review) config.review = refs.review.checked;
    if (refs.pick) config.pick = refs.pick.value;
    if (refs.turn3) config.turn3From = refs.turn3.value;
    for (const [key, area] of Object.entries(refs.prompts))
      config.prompts[key] = area.value;
    return config;
  };

  // --- Updates, in place -----------------------------------------------------------------
  function render(next) {
    if (!next || lifetime.signal.aborted) return;
    status = next;
    host.hidden = false;
    const run = next.run || {};
    const busy = run.busy === true;
    if (line) {
      line.textContent = note || runText(run);
      line.dataset.ok = note || run.state === 'error' ? 'false' : 'true';
    }
    ui.teachers.textContent = '';
    for (const t of next.teachers || []) {
      const li = element(doc, 'li', 'distill-teacher');
      const state = teacherState(t);
      li.dataset.state = state.state;
      li.append(
        element(doc, 'span', 'distill-swatch'),
        `${t.label} · ${state.text}`,
      );
      ui.teachers.append(li);
    }
    const resumable = run.state === 'paused' || run.state === 'stopped';
    ui.pause.textContent = resumable ? tl('CONTINUE') : tl('PAUSE');
    ui.pause.dataset.action = resumable ? 'continue' : 'pause';
    ui.pause.disabled = !(busy || resumable);
    ui.stop.disabled = !busy && run.state !== 'paused';
    fillList(
      doc,
      ui.errors,
      (run.errors || [])
        .slice(0, 5)
        .map((e) =>
          tl('QUESTION {n}: {error}', { n: e.question, error: e.error }),
        ),
    );
    const p = run.state === 'waiting' ? run.pending : null;
    ui.pending.hidden = !p;
    if (p) {
      ui.pendingLine.textContent = pendingText(p);
      if (ui.prompt.value !== p.prompt) ui.prompt.value = p.prompt;
      ui.openApp.hidden = !APP_OPEN_URLS[p.app];
      ui.openApp.textContent = tl('OPEN {app} AND PASTE', {
        app: tl(APP_NAMES[p.app] || 'GROK BOT'),
      });
    }
    // Sub-headings: new ones built, gone ones taken out, every one updated.
    const seen = new Set();
    for (const f of next.features || []) {
      seen.add(f.id);
      let refs = featureUi.get(f.id);
      if (!refs) {
        refs = buildFeature(f);
        featureUi.set(f.id, refs);
        headings.get(f.heading)?.list.append(refs.box);
      }
      refs.summary.textContent = featureSummary(f);
      if (doc.activeElement !== refs.name && !refs.dirty)
        refs.name.value = f.name;
      refs.questionsLine.textContent = tln(
        f.questions,
        '{count} QUESTION',
        '{count} QUESTIONS',
        {
          count: formatCount(f.questions),
        },
      );
      fillList(doc, refs.preview, f.preview || []);
      fillConfig(refs, f);
      const mine = run.featureId === f.id;
      const locked = mine && busy;
      for (const node of [
        refs.addQuestions,
        refs.loadCsv,
        refs.clearQuestions,
        refs.save,
        refs.rename,
        refs.clearData,
        refs.remove,
      ])
        node.disabled = locked;
      refs.estimate.disabled = busy;
      if (busy) refs.confirm.disabled = true;
      refs.datasetLine.textContent = `${tln(
        f.records,
        '{count} GROUND TRUTH',
        '{count} GROUND TRUTHS',
        {
          count: formatCount(f.records),
        },
      )} · ${tl('CLASS RESTRICTED: THE TEACHERS’ TERMS MAY LIMIT TRAINING ON THEIR ANSWERS')}`;
    }
    for (const [id, refs] of featureUi)
      if (!seen.has(id)) {
        refs.box.remove?.();
        featureUi.delete(id);
      }
    schedule();
  }

  const schedule = () => {
    timers.clearTimeout(pollTimer);
    if (lifetime.signal.aborted) return;
    const busy = status?.run?.busy === true;
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
      // No server route (a production build, a LAN visitor): the box keeps its instructions only.
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
      featureUi.clear();
    },
  };
}
