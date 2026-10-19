/**
 * ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM: the left-hand box
 * (docs/AI-WORLD-TAB.md).
 *
 * TRAIN ON: one tick box per data layer, then the entries that are not
 * layers (news events, population demographics, outbreak sim episodes and
 * the owner's devices), each with its licence class and live status; ALL
 * ticks or clears every row and shows a partial state between. A tick is
 * sent to the server shortly after the last change, in any state.
 * INITIALIZE shows an estimate first and starts only on CONFIRM INITIALIZE.
 * PAUSE / CONTINUE and STOP follow the job's state. DELETE lists exactly the
 * files it would remove; a second press inside the box removes them, and on
 * the owner's phone that removal is a quiet no-op (src/ui/ownerRemoval.js).
 * AREAS lists the places cameras, traffic, news and imagery record around:
 * ADD VIEW AS AREA adds the middle of the map, and REMOVE (a quiet no-op on
 * the owner's phone) stops recording there.
 * STATUS follows each stage; PREDICTIONS picks the domains and horizon the
 * globe draws, handed to the overlay on AI_WORLD_PREDICTIONS_EVENT.
 *
 * Every answer comes from the dev server's /api/ai-world routes. Until they
 * exist the box says AI WORLD SERVER NOT READY and stays usable. The rules
 * and every line of text are src/aiWorldSelection.mjs. The text is marked
 * with tl() and tln(): Quebec French in the fork locales, else English.
 */
import { formatAskLogEntry, prependOutputLog } from './askOverview.js';
import { msgl, tl, tln } from './i18n/index.js';
import { initLlmTrainingSetup } from './llmTrainingSetup.js';
import { initTensorflowSetup } from './tensorflowSetup.js';
import { initMlflowSetup } from './mlflowSetup.js';
import {
  isOwnerRemovalRefusal,
  noteOwnerRemovalRefusal,
  watchOwnerRemoval,
} from './ui/ownerRemoval.js';
import {
  AI_WORLD_DELETE_SCOPES,
  AI_WORLD_DOMAINS,
  AI_WORLD_HORIZON_DEFAULT,
  AI_WORLD_HORIZON_MAX,
  AI_WORLD_HORIZON_MIN,
  AI_WORLD_NO_AREAS,
  AI_WORLD_STAGE_KEYS,
  allState,
  areaRows,
  buildSelectionItems,
  clampInt,
  classTag,
  cleanPredictions,
  controlStates,
  domainNote,
  marketLines,
  postTrainNote,
  deletePreviewView,
  estimateLines,
  feedStatusText,
  formatBytes,
  formatCount,
  horizonLabel,
  learningLabel,
  pollDelay,
  sameSelection,
  stageLines,
  stateLabel,
  toggle,
  toggleAll,
} from './aiWorldSelection.mjs';

export const AI_WORLD_API = '/api/ai-world';
/** This browser's PREDICTIONS choice: `{ domains, horizonHours }`. */
export const AI_WORLD_STORAGE_KEY = 'gev-ai-world-v1';
/** Sent on `document` with `{ domains, horizonHours }` for the globe overlay. */
export const AI_WORLD_PREDICTIONS_EVENT = 'ai-world:predictions';
/** English, shown through tl(). */
export const AI_WORLD_NOT_READY = msgl('AI WORLD SERVER NOT READY');
export const AI_WORLD_SELECTION_DEBOUNCE_MS = 400;
export const AI_WORLD_RETRY_MS = 60_000;
/** A DataManager change is looked at once per this long, not per notice. */
export const AI_WORLD_LAYER_CHECK_MS = 500;
export const AI_WORLD_DEFAULT_CAP_GB = 600;
export const AI_WORLD_DEFAULT_SCENARIOS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;
const SIM_RUNS = 8;
const SIM_DAYS = 40;
const CAP_GB_MAX = 100_000;
const SCENARIOS_MAX = 1_000_000;
const PENDING = Object.freeze({
  pause: msgl('PAUSING…'),
  continue: msgl('CONTINUING…'),
  stop: msgl('STOPPING…'),
});

/**
 * The point under the camera, in degrees, when nothing better is given (the
 * shell passes the middle of the view).
 */
function cameraPoint(dataManager) {
  const carto = dataManager?.viewer?.camera?.positionCartographic;
  const lat = (Number(carto?.latitude) * 180) / Math.PI;
  const lon = (Number(carto?.longitude) * 180) / Math.PI;
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** A row's id as a safe piece of an element id. */
function domId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '-');
}

export class AiWorldPanel {
  /**
   * @param {{document?: Document, fetch?: Function, dataManager?: object|null, viewPoint?: () => ?{lat: number, lon: number}, storage?: Storage|null, timers?: {setTimeout?: Function, clearTimeout?: Function}, now?: () => number, signal?: AbortSignal}} [options]
   */
  constructor(options = {}) {
    const doc = options.document ?? globalThis.document ?? null;
    this._doc = doc;
    this._fetch = options.fetch || null;
    this._dataManager = options.dataManager || null;
    this._viewPoint =
      typeof options.viewPoint === 'function'
        ? options.viewPoint
        : () => cameraPoint(this._dataManager);
    this._storage =
      options.storage !== undefined ? options.storage : defaultStorage();
    const timers = options.timers || {};
    this._setTimeout =
      timers.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
    this._clearTimeout =
      timers.clearTimeout || ((id) => globalThis.clearTimeout(id));
    this._now = options.now || (() => Date.now());
    this._signal = options.signal || null;
    this._destroyed = false;
    this._listeners = [];
    /** Requests on their way: AbortController → its timeout. */
    this._requests = new Map();
    this._timers = {
      poll: null,
      selection: null,
      layers: null,
      estimate: null,
    };
    this._listKeys = new Map();
    this._status = null;
    // Every status request and action takes a number; an older answer never
    // replaces a newer one.
    this._seq = 0;
    this._appliedSeq = 0;
    this._polling = false;
    this._selection = [];
    this._selectionDirty = false;
    this._selectionInFlight = false;
    this._selectionAgain = false;
    this._resendWhenReady = false;
    this._items = [];
    this._itemsKey = null;
    this._rows = new Map();
    this._catalog = [];
    this._catalogLoaded = false;
    this._catalogLoading = false;
    this._busy = '';
    this._estimate = null;
    this._estimateSeq = 0;
    this._preview = null;
    this._previewState = 'idle';
    this._previewSeq = 0;
    this._areaBusy = false;
    this._unsubscribe = null;
    this._llm = null;
    this._tensorflow = null;
    this._mlflow = null;

    const byId = (id) => doc?.getElementById?.(id) || null;
    this._root = byId('ai-world-panel');
    if (!this._root || this._signal?.aborted) {
      this._destroyed = true;
      return;
    }
    this._statusLine = byId('ai-world-status');
    this._output = byId('ai-world-output');
    this._allBox = byId('ai-world-all');
    this._sources = byId('ai-world-sources');
    this._areasList = byId('ai-world-areas');
    this._areaAddBtn = byId('ai-world-area-add');
    this._initBtn = byId('ai-world-init');
    this._pauseBtn = byId('ai-world-pause');
    this._stopBtn = byId('ai-world-stop');
    this._deleteBtn = byId('ai-world-delete');
    this._estimateBlock = byId('ai-world-estimate');
    this._estimateLines = byId('ai-world-estimate-lines');
    this._capInput = byId('ai-world-cap');
    this._scenariosLabel = byId('ai-world-scenarios-label');
    this._scenariosInput = byId('ai-world-scenarios');
    this._initConfirm = byId('ai-world-init-confirm');
    this._initCancel = byId('ai-world-init-cancel');
    this._deleteBlock = byId('ai-world-delete-panel');
    this._deleteScope = byId('ai-world-delete-scope');
    this._deleteGroups = byId('ai-world-delete-groups');
    this._deleteTotal = byId('ai-world-delete-total');
    this._deleteConfirm = byId('ai-world-delete-confirm');
    this._deleteCancel = byId('ai-world-delete-cancel');
    this._stageEls = {};
    for (const key of AI_WORLD_STAGE_KEYS)
      this._stageEls[key] = byId(`ai-world-stage-${key}`);
    this._domainBoxes = {};
    this._domainNotes = {};
    for (const domain of AI_WORLD_DOMAINS) {
      this._domainBoxes[domain.id] = byId(`ai-world-domain-${domain.id}`);
      this._domainNotes[domain.id] = byId(`ai-world-domain-${domain.id}-note`);
    }
    this._horizon = byId('ai-world-horizon');
    this._horizonValue = byId('ai-world-horizon-value');
    this._predictAll = byId('ai-world-predict-all');
    this._domainsEl = byId('ai-world-domains');
    this._postAdapter = byId('ai-world-posttrain-adapter');
    this._postCheckpoint = byId('ai-world-posttrain-checkpoint');
    this._postDaily = byId('ai-world-posttrain-daily');
    this._postSave = byId('ai-world-posttrain-save');
    this._postRun = byId('ai-world-posttrain-run');
    this._postNote = byId('ai-world-posttrain-note');
    this._postFilled = false;
    this._inferKind = byId('ai-world-infer-kind');
    this._inferQuery = byId('ai-world-infer-query');
    this._inferBtn = byId('ai-world-infer');
    this._inferNote = byId('ai-world-infer-note');
    this._infer = null;
    this._newsList = byId('ai-world-news-urls');
    this._newsCount = byId('ai-world-news-count');
    this._newsInput = byId('ai-world-news-url');
    this._newsAdd = byId('ai-world-news-add');
    this._marketsList = byId('ai-world-markets');

    this._predictions = this._loadPredictions();
    // Nothing is drawn until the predictor can draw something.
    this._lastEmitted = JSON.stringify({
      domains: [],
      horizonHours: this._predictions.horizonHours,
    });
    if (this._horizon)
      this._horizon.value = String(this._predictions.horizonHours);
    this._showHorizon(this._predictions.horizonHours);
    this._refreshItems();
    this._renderControls();
    this._renderAreas();
    this._renderStages();
    this._renderDomains();

    this._on(this._sources, 'change', (event) => this._onSourceChange(event));
    this._on(this._areaAddBtn, 'click', () => void this._addArea());
    this._on(this._areasList, 'click', (event) => this._onAreaClick(event));
    this._on(this._allBox, 'change', () => this._onAllChange());
    this._on(this._initBtn, 'click', () => void this._openEstimate());
    this._on(this._pauseBtn, 'click', () => void this._pauseOrContinue());
    this._on(this._stopBtn, 'click', () => void this._command('stop'));
    this._on(this._deleteBtn, 'click', () => this._openDelete());
    this._on(this._capInput, 'change', () => {
      if (this._capInput) this._capInput.value = String(this._capGb());
      this._scheduleEstimate();
    });
    this._on(this._scenariosInput, 'change', () => {
      if (this._scenariosInput)
        this._scenariosInput.value = String(this._scenarios());
    });
    this._on(this._initConfirm, 'click', () => void this._initialize());
    this._on(this._initCancel, 'click', () => {
      this._closeEstimate();
      this._say('');
    });
    this._on(this._deleteScope, 'change', () => void this._loadPreview());
    this._on(this._deleteConfirm, 'click', () => void this._delete());
    this._on(this._deleteCancel, 'click', () => {
      this._closeDelete();
      this._say('');
    });
    for (const domain of AI_WORLD_DOMAINS)
      this._on(this._domainBoxes[domain.id], 'change', () =>
        this._onDomainChange(),
      );
    this._on(this._predictAll, 'change', () => this._onPredictAll());
    this._on(this._inferBtn, 'click', () => void this._askInfer());
    this._on(this._newsAdd, 'click', () => void this._addNewsUrl());
    this._on(
      this._newsList,
      'click',
      (event) => void this._removeNewsUrl(event),
    );
    this._on(this._horizon, 'input', () =>
      this._showHorizon(this._horizon?.value),
    );
    this._on(this._horizon, 'change', () => this._onHorizonChange());
    this._on(this._postSave, 'click', () => void this._savePostTrain(false));
    this._on(this._postRun, 'click', () => void this._savePostTrain(true));

    // The rows follow the DataManager's layers; its notices come often, so
    // the list is looked at again once per AI_WORLD_LAYER_CHECK_MS.
    this._onLayers = () => {
      if (this._destroyed || this._timers.layers !== null) return;
      this._timers.layers = this._later(() => {
        this._timers.layers = null;
        this._refreshItems();
      }, AI_WORLD_LAYER_CHECK_MS);
    };
    try {
      const unsubscribe =
        typeof this._dataManager?.subscribe === 'function'
          ? this._dataManager.subscribe(this._onLayers)
          : null;
      this._unsubscribe =
        typeof unsubscribe === 'function' ? unsubscribe : null;
    } catch {
      this._unsubscribe = null;
    }
    this._onAbort = () => this.destroy();
    this._signal?.addEventListener?.('abort', this._onAbort, { once: true });

    void this._loadCatalog();
    void this._loadNewsUrls();
    void this._loadMarkets();
    void this._poll();

    // The TENSORFLOW sections (owner request 2026-10-17), then CUSTOM LLM
    // TRAINING at the bottom of this tab (moved from POWER UP the same day):
    // each with its own routes, polling and lifetime.
    const tfHost = byId('tensorflow-tools');
    if (tfHost)
      this._tensorflow = initTensorflowSetup({
        host: tfHost,
        documentRef: doc,
        fetchImpl: this._fetch || undefined,
        signal: this._signal || undefined,
      });
    const mlflowHost = byId('mlflow-tools');
    if (mlflowHost)
      this._mlflow = initMlflowSetup({
        host: mlflowHost,
        documentRef: doc,
        fetchImpl: this._fetch || undefined,
        signal: this._signal || undefined,
      });
    const llmHost = byId('llm-training');
    if (llmHost)
      this._llm = initLlmTrainingSetup({
        host: llmHost,
        documentRef: doc,
        fetchImpl: this._fetch || undefined,
        signal: this._signal || undefined,
      });
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const key of Object.keys(this._timers)) this._cancel(key);
    for (const [controller, timer] of this._requests) {
      this._clearTimeout(timer);
      try {
        controller.abort();
      } catch {
        /* Already settled. */
      }
    }
    this._requests.clear();
    for (const [el, type, fn] of this._listeners)
      el.removeEventListener?.(type, fn);
    this._listeners = [];
    try {
      this._unsubscribe?.();
    } catch {
      /* The manager is going away too. */
    }
    this._unsubscribe = null;
    this._llm?.destroy();
    this._llm = null;
    this._tensorflow?.destroy();
    this._tensorflow = null;
    this._mlflow?.destroy();
    this._mlflow = null;
    this._signal?.removeEventListener?.('abort', this._onAbort);
  }

  /* --------------------------------------------------------------------- */
  /* Small helpers                                                          */
  /* --------------------------------------------------------------------- */

  get _stateName() {
    return typeof this._status?.state === 'string' ? this._status.state : null;
  }

  _on(el, type, fn) {
    if (typeof el?.addEventListener !== 'function') return;
    el.addEventListener(type, fn);
    this._listeners.push([el, type, fn]);
  }

  _later(fn, ms) {
    const id = this._setTimeout(fn, ms);
    // Under Node (the tests) a timer never holds the process open.
    id?.unref?.();
    return id;
  }

  _cancel(key) {
    if (this._timers[key] === null) return;
    this._clearTimeout(this._timers[key]);
    this._timers[key] = null;
  }

  /* Every text change inside a left-stack box schedules a rail layout pass
   * (its MutationObserver), so text is written only when it changes. */
  _setText(el, value) {
    if (!el) return;
    const text = String(value ?? '');
    if (el.textContent !== text) el.textContent = text;
  }

  _setDisabled(el, disabled) {
    if (el && el.disabled !== disabled) el.disabled = disabled;
  }

  _setHidden(el, hidden) {
    if (el && el.hidden !== hidden) el.hidden = hidden;
  }

  _say(message) {
    this._setText(this._statusLine, message);
  }

  _clearNotReady() {
    if (this._statusLine?.textContent === tl(AI_WORLD_NOT_READY)) this._say('');
  }

  _log(kind, body) {
    if (!this._output) return;
    this._output.textContent = prependOutputLog(
      this._output.textContent,
      formatAskLogEntry(kind, body),
    );
    this._output.scrollTop = 0;
  }

  /** One line per entry; the list is rebuilt only when its lines change. */
  _renderList(list, lines) {
    if (!list || !this._doc) return;
    const key = lines.join('\n');
    if (this._listKeys.get(list) === key) return;
    this._listKeys.set(list, key);
    list.replaceChildren(
      ...lines.map((entry) => {
        const li = this._doc.createElement('li');
        li.textContent = entry;
        return li;
      }),
    );
  }

  _capGb() {
    return clampInt(
      this._capInput?.value,
      1,
      CAP_GB_MAX,
      AI_WORLD_DEFAULT_CAP_GB,
    );
  }

  _scenarios() {
    return clampInt(
      this._scenariosInput?.value,
      1,
      SCENARIOS_MAX,
      AI_WORLD_DEFAULT_SCENARIOS,
    );
  }

  _scope() {
    const value = this._deleteScope?.value;
    return AI_WORLD_DELETE_SCOPES.some((scope) => scope.id === value)
      ? value
      : 'all';
  }

  _labelFor(id) {
    const label = this._items.find((item) => item.id === id)?.label;
    return label ? tl(label) : stateLabel(id);
  }

  /* --------------------------------------------------------------------- */
  /* Network                                                                */
  /* --------------------------------------------------------------------- */

  async _send(url, init, { watch = false } = {}) {
    const fetchImpl = this._fetch || globalThis.fetch;
    const controller =
      typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller
      ? this._later(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : null;
    if (controller) this._requests.set(controller, timer);
    try {
      const request = fetchImpl(
        url,
        controller ? { ...init, signal: controller.signal } : init,
      );
      const response = await (watch ? watchOwnerRemoval(request) : request);
      const data =
        typeof response?.json === 'function'
          ? await response.json().catch(() => null)
          : null;
      return { response, data };
    } finally {
      if (controller) {
        this._clearTimeout(timer);
        this._requests.delete(controller);
      }
    }
  }

  _getJson(path) {
    return this._send(`${AI_WORLD_API}/${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  }

  _postJson(path, body) {
    return this._send(`${AI_WORLD_API}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body ?? {}),
    });
  }

  /** A 404, a failed fetch or the page instead of JSON: no routes yet. */
  _notThere(response, data) {
    if (!response) return true;
    if (Number(response.status) === 404) return true;
    return Boolean(response.ok) && (!data || typeof data !== 'object');
  }

  _refused(what, response, data) {
    if (this._notThere(response, data)) {
      this._say(tl(AI_WORLD_NOT_READY));
      return;
    }
    const message = tl('{what} REFUSED · {why}', {
      what,
      why: data?.error || `HTTP ${Number(response?.status) || 0}`,
    });
    this._say(message);
    this._log(what, message);
  }

  _unanswered(what, error) {
    if (this._destroyed) return;
    this._say(
      error?.name === 'AbortError'
        ? tl('{what} · NO ANSWER IN TIME', { what })
        : tl(AI_WORLD_NOT_READY),
    );
  }

  /* --------------------------------------------------------------------- */
  /* Status                                                                 */
  /* --------------------------------------------------------------------- */

  /**
   * One status request at a time: every 3 s while the work moves, every
   * 15 s otherwise, and 60 s after a failure.
   */
  async _poll() {
    if (this._polling || this._destroyed) return;
    this._polling = true;
    const seq = ++this._seq;
    let answered = false;
    try {
      const { response, data } = await this._getJson('status');
      if (this._destroyed) return;
      if (
        !response?.ok ||
        !data ||
        typeof data !== 'object' ||
        typeof data.state !== 'string'
      ) {
        if (this._notThere(response, data)) this._say(tl(AI_WORLD_NOT_READY));
        else
          this._say(
            tl('AI WORLD STATUS · {why}', {
              why: data?.error || `HTTP ${Number(response?.status) || 0}`,
            }),
          );
        return;
      }
      answered = true;
      this._take(data, seq);
      // Quotes are recorded every five minutes: asked again once a minute.
      if (this._now() - (this._marketsAt ?? -Infinity) >= 60_000)
        void this._loadMarkets();
      this._clearNotReady();
      if (!this._catalogLoaded) void this._loadCatalog();
      // Ticks made while the server was away are sent once it answers.
      if (
        this._resendWhenReady &&
        this._selectionDirty &&
        this._timers.selection === null &&
        !this._selectionInFlight
      )
        this._scheduleSelection(0);
    } catch {
      if (!this._destroyed) this._say(tl(AI_WORLD_NOT_READY));
    } finally {
      this._polling = false;
      if (!this._destroyed)
        this._schedulePoll(
          answered || this._appliedSeq > seq
            ? pollDelay(this._stateName)
            : AI_WORLD_RETRY_MS,
        );
    }
  }

  _schedulePoll(ms) {
    if (this._destroyed) return;
    this._cancel('poll');
    this._timers.poll = this._later(() => {
      this._timers.poll = null;
      void this._poll();
    }, ms);
  }

  /** Take a status answer unless a newer one is already shown. */
  _take(status, seq) {
    if (seq <= this._appliedSeq) return false;
    this._appliedSeq = seq;
    this._status = status;
    // The server's selection is the truth, except while a change made here
    // is still waiting to be sent or on its way.
    if (
      !this._selectionDirty &&
      !this._selectionInFlight &&
      this._timers.selection === null &&
      Array.isArray(status.selection)
    ) {
      const next = status.selection.filter(
        (id) => typeof id === 'string' && id,
      );
      if (!sameSelection(next, this._selection)) this._selection = next;
    }
    this._renderTicks();
    this._renderControls();
    this._renderFeeds();
    this._renderAreas();
    this._renderStages();
    this._renderDomains();
    this._renderPostTrain();
    const allowed = controlStates(this._stateName);
    if (!allowed.initialize) this._closeEstimate();
    if (!allowed.delete) this._closeDelete();
    return true;
  }

  /** POST-TRAIN: the saved adapter and checkpoint once, the last score always. */
  _renderPostTrain() {
    const posttrain = this._status?.posttrain || null;
    this._setText(this._postNote, postTrainNote(posttrain));
    if (this._postFilled || !posttrain?.adapter) return;
    this._postFilled = true;
    if (this._postAdapter && !this._postAdapter.value)
      this._postAdapter.value = posttrain.adapter;
    if (this._postCheckpoint && !this._postCheckpoint.value)
      this._postCheckpoint.value = posttrain.checkpoint || '';
    if (this._postDaily) this._postDaily.checked = posttrain.daily === true;
  }

  async _savePostTrain(run) {
    const body = {
      adapter: String(this._postAdapter?.value || '').trim(),
      checkpoint: String(this._postCheckpoint?.value || '').trim(),
      daily: this._postDaily?.checked === true,
      run,
    };
    const { response, data } = await this._postJson('posttrain', body).catch(
      () => ({ response: null, data: null }),
    );
    if (this._destroyed) return;
    if (!response?.ok) {
      this._refused(
        run ? tl('POST-TRAIN') : tl('POST-TRAIN SAVE'),
        response,
        data,
      );
      return;
    }
    this._postFilled = true;
    if (this._status) this._status.posttrain = data?.posttrain || null;
    this._renderPostTrain();
    this._say(run ? tl('POST-TRAINING QUEUED') : tl('POST-TRAIN SAVED'));
  }

  async _loadCatalog() {
    if (this._catalogLoading || this._catalogLoaded || this._destroyed) return;
    this._catalogLoading = true;
    try {
      const { response, data } = await this._getJson('catalog');
      if (this._destroyed || !response?.ok || !Array.isArray(data?.items))
        return;
      this._catalog = data.items;
      this._catalogLoaded = true;
      this._refreshItems();
    } catch {
      /* Asked for again with the next status that answers. */
    } finally {
      this._catalogLoading = false;
    }
  }

  /* --------------------------------------------------------------------- */
  /* TRAIN ON                                                               */
  /* --------------------------------------------------------------------- */

  _readLayers() {
    try {
      const all = this._dataManager?.getAll?.();
      return Array.isArray(all)
        ? all.map((layer) => ({
            id: layer?.id,
            // A layer the catalog does not name is listed by its own name,
            // as the Data Layers list words it.
            name: typeof layer?.name === 'string' ? tl(layer.name) : '',
            showInTogglePanel: layer?.showInTogglePanel,
          }))
        : [];
    } catch {
      return [];
    }
  }

  /** Rebuild the rows only when the rows themselves change. */
  _refreshItems() {
    if (this._destroyed) return;
    const items = buildSelectionItems({
      layers: this._readLayers(),
      catalog: this._catalog,
    });
    const key = items
      .map((item) =>
        [item.id, item.label, item.cls, item.licence].join('\u0001'),
      )
      .join('\u0002');
    if (key === this._itemsKey) return;
    this._itemsKey = key;
    this._items = items;
    this._renderRows();
  }

  _renderRows() {
    if (!this._sources || !this._doc) return;
    this._rows = new Map();
    this._sources.replaceChildren(
      ...this._items.map((item) => this._row(item)),
    );
    this._renderTicks();
    this._renderFeeds();
  }

  _row(item) {
    const doc = this._doc;
    const safe = domId(item.id);
    const li = doc.createElement('li');
    li.className = 'ai-world-row';
    li.dataset.aiWorldRow = item.id;
    const label = doc.createElement('label');
    label.className = 'outbreak-mode';
    label.dataset.class = item.cls;
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.dataset.aiWorldId = item.id;
    box.setAttribute(
      'aria-describedby',
      `ai-world-row-${safe}-class ai-world-row-${safe}-feed`,
    );
    const swatch = doc.createElement('span');
    swatch.className = 'outbreak-swatch';
    const name = doc.createElement('span');
    name.className = 'ai-world-name';
    name.textContent = tl(item.label);
    label.appendChild(box);
    label.appendChild(swatch);
    label.appendChild(name);
    const tag = doc.createElement('span');
    tag.className = 'ai-world-class';
    tag.id = `ai-world-row-${safe}-class`;
    tag.textContent = classTag(item.cls);
    if (item.licence) tag.title = tl(item.licence);
    const feed = doc.createElement('span');
    feed.className = 'ai-world-feed';
    feed.id = `ai-world-row-${safe}-feed`;
    li.appendChild(label);
    li.appendChild(tag);
    li.appendChild(feed);
    this._rows.set(item.id, { box, feed });
    return li;
  }

  /** Each row's tick, ALL's tick and partial state, and SIM SCENARIOS. */
  _renderTicks() {
    const ticked = new Set(this._selection);
    for (const [id, row] of this._rows) {
      const on = ticked.has(id);
      if (row.box.checked !== on) row.box.checked = on;
    }
    if (this._allBox) {
      const state = allState(this._selection, this._items);
      const checked = state === 'all';
      // Native indeterminate: the box reads as mixed between all and none.
      const mixed = state === 'some';
      if (this._allBox.checked !== checked) this._allBox.checked = checked;
      if (this._allBox.indeterminate !== mixed)
        this._allBox.indeterminate = mixed;
    }
    const sim = this._selection.includes('outbreak-sim');
    this._setHidden(this._scenariosLabel, !sim);
    this._setHidden(this._scenariosInput, !sim);
  }

  _renderFeeds() {
    const feeds = new Map();
    for (const feed of Array.isArray(this._status?.feeds)
      ? this._status.feeds
      : [])
      if (feed && typeof feed.id === 'string') feeds.set(feed.id, feed);
    const now = this._now();
    for (const [id, row] of this._rows)
      this._setText(row.feed, feedStatusText(feeds.get(id), now));
  }

  _onSourceChange(event) {
    const box = event?.target;
    const id = box?.dataset?.aiWorldId;
    if (!id) return;
    this._selection = toggle(this._selection, id, Boolean(box.checked));
    this._selectionChanged();
  }

  _onAllChange() {
    this._selection = toggleAll(this._items, Boolean(this._allBox?.checked));
    this._selectionChanged();
  }

  _selectionChanged() {
    this._selectionDirty = true;
    this._renderTicks();
    this._scheduleSelection();
    this._scheduleEstimate();
  }

  _scheduleSelection(delay = AI_WORLD_SELECTION_DEBOUNCE_MS) {
    if (this._destroyed) return;
    this._cancel('selection');
    this._timers.selection = this._later(() => {
      this._timers.selection = null;
      void this._sendSelection();
    }, delay);
  }

  /** The ticks, to the server: one request at a time, the latest wins. */
  async _sendSelection() {
    if (this._destroyed) return;
    if (this._selectionInFlight) {
      this._selectionAgain = true;
      return;
    }
    this._selectionInFlight = true;
    const sent = [...this._selection];
    const seq = ++this._seq;
    try {
      const { response, data } = await this._postJson('selection', {
        selection: sent,
      });
      if (this._destroyed) return;
      if (response?.ok && typeof data?.state === 'string') {
        if (sameSelection(sent, this._selection)) this._selectionDirty = false;
        this._resendWhenReady = false;
        this._take(data, seq);
        this._clearNotReady();
      } else if (this._notThere(response, data)) {
        this._resendWhenReady = true;
        this._say(tl(AI_WORLD_NOT_READY));
      } else {
        // Refused: the server's selection stands, with the reason shown,
        // unless a newer change is already waiting to be sent.
        this._selectionDirty = false;
        this._resendWhenReady = false;
        if (
          this._timers.selection === null &&
          !this._selectionAgain &&
          Array.isArray(this._status?.selection)
        ) {
          this._selection = this._status.selection.filter(
            (id) => typeof id === 'string' && id,
          );
          this._renderTicks();
        }
        this._refused(tl('SELECTION'), response, data);
      }
    } catch (error) {
      if (!this._destroyed) {
        this._resendWhenReady = true;
        this._unanswered(tl('SELECTION'), error);
      }
    } finally {
      this._selectionInFlight = false;
      if (this._selectionAgain && !this._destroyed) {
        this._selectionAgain = false;
        void this._sendSelection();
      }
    }
  }

  /* --------------------------------------------------------------------- */
  /* AREAS                                                                  */
  /* --------------------------------------------------------------------- */

  /** One row per area, rebuilt only when the list changes. */
  _renderAreas() {
    this._setDisabled(this._areaAddBtn, this._areaBusy);
    const list = this._areasList;
    if (!list || !this._doc) return;
    const rows = areaRows(this._status?.areas);
    const key = JSON.stringify([this._areaBusy, rows]);
    if (this._listKeys.get(list) === key) return;
    this._listKeys.set(list, key);
    if (!rows.length) {
      const li = this._doc.createElement('li');
      li.textContent = tl(AI_WORLD_NO_AREAS);
      list.replaceChildren(li);
      return;
    }
    list.replaceChildren(
      ...rows.map((row) => {
        const li = this._doc.createElement('li');
        li.className = 'ai-world-row';
        li.dataset.aiWorldArea = row.key;
        const name = this._doc.createElement('span');
        name.className = 'ai-world-name';
        name.textContent = row.name;
        const where = this._doc.createElement('span');
        where.className = 'ai-world-feed';
        where.textContent = row.where;
        const remove = this._doc.createElement('button');
        remove.type = 'button';
        remove.className = 'scene-btn ai-world-area-remove';
        remove.dataset.aiWorldAreaKey = row.key;
        remove.textContent = tl('REMOVE');
        remove.setAttribute(
          'aria-label',
          tl('Stop recording around {name}', { name: row.name }),
        );
        remove.disabled = this._areaBusy;
        li.appendChild(name);
        li.appendChild(where);
        li.appendChild(remove);
        return li;
      }),
    );
  }

  _takeAreas(data) {
    if (!Array.isArray(data?.areas)) return;
    this._status = { ...(this._status || {}), areas: data.areas };
    this._renderAreas();
  }

  /** ADD VIEW AS AREA: the middle of the map joins the list. */
  async _addArea() {
    if (this._areaBusy || this._destroyed) return;
    let point = null;
    try {
      point = this._viewPoint();
    } catch {
      point = null;
    }
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon)) {
      this._say(tl('NO MAP VIEW TO ADD'));
      return;
    }
    this._areaBusy = true;
    this._renderAreas();
    try {
      const { response, data } = await this._postJson('areas', {
        lat: point.lat,
        lon: point.lon,
      });
      if (this._destroyed) return;
      if (!response?.ok || !Array.isArray(data?.areas)) {
        this._refused(tl('AREA'), response, data);
        return;
      }
      this._takeAreas(data);
      const areas = data.areas.length;
      const message = tln(
        areas,
        'AREA ADDED · {count} AREA',
        'AREA ADDED · {count} AREAS',
        {
          count: formatCount(areas),
        },
      );
      this._say(message);
      this._log(tl('AREA'), message);
    } catch (error) {
      this._unanswered(tl('AREA'), error);
    } finally {
      this._areaBusy = false;
      if (!this._destroyed) this._renderAreas();
    }
  }

  _onAreaClick(event) {
    const target = event?.target;
    const key =
      target?.dataset?.aiWorldAreaKey ||
      target?.closest?.('[data-ai-world-area-key]')?.dataset?.aiWorldAreaKey;
    if (key) void this._removeArea(key);
  }

  /**
   * REMOVE: recording stops around that area; what was recorded stays. Only
   * the PC removes (owner ruling 2026-10-11): on the owner's phone this is a
   * quiet no-op and the list stays as it was.
   */
  async _removeArea(key) {
    if (this._areaBusy || this._destroyed) return;
    this._areaBusy = true;
    this._renderAreas();
    try {
      const { response, data } = await this._send(
        `${AI_WORLD_API}/areas`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ key }),
        },
        { watch: true },
      );
      if (this._destroyed) return;
      if (!response?.ok) {
        if (isOwnerRemovalRefusal(response)) return;
        if (isOwnerRemovalRefusal(response, data)) {
          noteOwnerRemovalRefusal();
          return;
        }
        this._refused(tl('AREA'), response, data);
        return;
      }
      this._takeAreas(data);
      const left = Array.isArray(data?.areas) ? data.areas.length : 0;
      const message = tln(
        left,
        'AREA REMOVED · {count} AREA LEFT',
        'AREA REMOVED · {count} AREAS LEFT',
        {
          count: formatCount(left),
        },
      );
      this._say(message);
      this._log(tl('AREA'), message);
    } catch (error) {
      this._unanswered(tl('AREA'), error);
    } finally {
      this._areaBusy = false;
      if (!this._destroyed) this._renderAreas();
    }
  }

  /* --------------------------------------------------------------------- */
  /* INITIALIZE, PAUSE / CONTINUE, STOP                                     */
  /* --------------------------------------------------------------------- */

  _renderControls() {
    const allowed = controlStates(this._stateName);
    const busy = Boolean(this._busy);
    this._setDisabled(this._initBtn, busy || !allowed.initialize);
    this._setText(this._pauseBtn, tl(allowed.pauseLabel));
    this._setDisabled(this._pauseBtn, busy || !allowed.pause);
    this._setDisabled(this._stopBtn, busy || !allowed.stop);
    this._setDisabled(this._deleteBtn, busy || !allowed.delete);
    this._setDisabled(
      this._initConfirm,
      busy || !allowed.initialize || !this._estimate,
    );
    this._setDisabled(
      this._deleteConfirm,
      busy ||
        !allowed.delete ||
        this._previewState !== 'ready' ||
        !deletePreviewView(this._preview).canDelete,
    );
  }

  async _openEstimate() {
    if (this._busy || !controlStates(this._stateName).initialize) return;
    if (!this._selection.length) {
      this._say(tl('TICK AT LEAST ONE SOURCE TO TRAIN ON'));
      return;
    }
    this._closeDelete();
    await this._runEstimate({ quiet: false });
  }

  /** The estimate again, quietly, when the cap or the ticks change. */
  _scheduleEstimate() {
    if (this._destroyed || this._estimateBlock?.hidden !== false) return;
    this._cancel('estimate');
    this._timers.estimate = this._later(() => {
      this._timers.estimate = null;
      void this._runEstimate({ quiet: true });
    }, AI_WORLD_SELECTION_DEBOUNCE_MS);
  }

  async _runEstimate({ quiet }) {
    const seq = ++this._estimateSeq;
    if (!quiet) {
      this._busy = 'estimate';
      this._renderControls();
      this._say(tl('ESTIMATING…'));
    }
    try {
      const { response, data } = await this._postJson('estimate', {
        selection: [...this._selection],
        capGb: this._capGb(),
      });
      if (this._destroyed || seq !== this._estimateSeq) return;
      if (!response?.ok || !data || typeof data !== 'object') {
        this._refused(tl('ESTIMATE'), response, data);
        return;
      }
      this._estimate = data;
      this._renderList(
        this._estimateLines,
        estimateLines(data, (id) => this._labelFor(id)),
      );
      this._setHidden(this._estimateBlock, false);
      if (!quiet) this._say(tl('ESTIMATE READY · CONFIRM INITIALIZE TO START'));
    } catch (error) {
      if (seq === this._estimateSeq) this._unanswered(tl('ESTIMATE'), error);
    } finally {
      if (!quiet && this._busy === 'estimate') this._busy = '';
      if (!this._destroyed) this._renderControls();
    }
  }

  _closeEstimate() {
    this._estimateSeq += 1;
    this._cancel('estimate');
    this._estimate = null;
    this._setHidden(this._estimateBlock, true);
    if (!this._destroyed) this._renderControls();
  }

  async _initialize() {
    if (this._busy || !controlStates(this._stateName).initialize) return;
    if (!this._estimate) return;
    if (!this._selection.length) {
      this._say(tl('TICK AT LEAST ONE SOURCE TO TRAIN ON'));
      return;
    }
    const selection = [...this._selection];
    const capGb = this._capGb();
    const scenarios = this._scenarios();
    this._busy = 'initialize';
    this._renderControls();
    this._say(tl('STARTING…'));
    const seq = ++this._seq;
    try {
      const { response, data } = await this._postJson('initialize', {
        selection,
        capGb,
        sim: { scenarios, runs: SIM_RUNS, days: SIM_DAYS },
      });
      if (this._destroyed) return;
      if (!response?.ok || typeof data?.state !== 'string') {
        this._refused(tl('INITIALIZE'), response, data);
        return;
      }
      this._busy = '';
      this._closeEstimate();
      this._take(data, seq);
      const sources = selection.length;
      const message = tln(
        sources,
        'INITIALIZED · {count} SOURCE · CAP {cap} GB',
        'INITIALIZED · {count} SOURCES · CAP {cap} GB',
        {
          count: formatCount(sources),
          cap: capGb,
        },
      );
      this._say(message);
      this._log(tl('INITIALIZE'), message);
      this._schedulePoll(pollDelay(this._stateName));
    } catch (error) {
      this._unanswered(tl('INITIALIZE'), error);
    } finally {
      if (this._busy === 'initialize') this._busy = '';
      if (!this._destroyed) this._renderControls();
    }
  }

  _pauseOrContinue() {
    return this._command(controlStates(this._stateName).pauseAction);
  }

  /** PAUSE, CONTINUE or STOP: the server answers with the new status. */
  async _command(action) {
    const allowed = controlStates(this._stateName);
    if (this._busy) return;
    if (action === 'stop' ? !allowed.stop : !allowed.pause) return;
    if (action !== 'stop' && allowed.pauseAction !== action) return;
    const name = stateLabel(action);
    this._busy = action;
    this._renderControls();
    this._say(tl(PENDING[action]));
    const seq = ++this._seq;
    try {
      const { response, data } = await this._postJson(action, {});
      if (this._destroyed) return;
      if (!response?.ok || typeof data?.state !== 'string') {
        this._refused(name, response, data);
        return;
      }
      this._busy = '';
      this._take(data, seq);
      const message = `${name} · ${stateLabel(data.state)}`;
      this._say(message);
      this._log(name, message);
      this._schedulePoll(pollDelay(this._stateName));
    } catch (error) {
      this._unanswered(name, error);
    } finally {
      if (this._busy === action) this._busy = '';
      if (!this._destroyed) this._renderControls();
    }
  }

  /* --------------------------------------------------------------------- */
  /* DELETE                                                                 */
  /* --------------------------------------------------------------------- */

  _openDelete() {
    if (this._busy || !controlStates(this._stateName).delete) return;
    this._closeEstimate();
    this._setHidden(this._deleteBlock, false);
    void this._loadPreview();
  }

  _closeDelete() {
    this._previewSeq += 1;
    this._preview = null;
    this._previewState = 'idle';
    this._setHidden(this._deleteBlock, true);
    if (!this._destroyed) this._renderControls();
  }

  /** Exactly what DELETE would remove for the scope chosen. */
  async _loadPreview() {
    if (this._destroyed || this._deleteBlock?.hidden !== false) return;
    const scope = this._scope();
    const seq = ++this._previewSeq;
    this._preview = null;
    this._previewState = 'loading';
    this._renderPreview();
    try {
      const { response, data } = await this._getJson(
        `delete-preview?scope=${encodeURIComponent(scope)}`,
      );
      if (this._destroyed || seq !== this._previewSeq) return;
      if (!response?.ok || !Array.isArray(data?.groups)) {
        this._previewState = 'failed';
        this._renderPreview();
        this._refused(tl('DELETE PREVIEW'), response, data);
        return;
      }
      this._preview = {
        ...data,
        scope:
          typeof data.scope === 'string' && data.scope ? data.scope : scope,
      };
      this._previewState = 'ready';
      this._renderPreview();
    } catch (error) {
      if (this._destroyed || seq !== this._previewSeq) return;
      this._previewState = 'failed';
      this._renderPreview();
      this._unanswered(tl('DELETE PREVIEW'), error);
    }
  }

  _renderPreview() {
    if (this._previewState === 'ready') {
      const view = deletePreviewView(this._preview);
      this._renderList(this._deleteGroups, view.groups);
      this._setText(this._deleteTotal, view.total);
      this._setText(this._deleteConfirm, view.confirm);
    } else {
      this._renderList(this._deleteGroups, []);
      this._setText(
        this._deleteTotal,
        this._previewState === 'loading'
          ? tl('LISTING FILES…')
          : tl('THE FILES COULD NOT BE LISTED'),
      );
      this._setText(this._deleteConfirm, tl('DELETE LISTED FILES'));
    }
    this._renderControls();
  }

  /**
   * The second press: removes exactly the files the preview listed (its
   * token). The server refuses when anything changed since; the preview is
   * then listed again.
   */
  async _delete() {
    const preview = this._previewState === 'ready' ? this._preview : null;
    if (this._busy || !preview || !controlStates(this._stateName).delete)
      return;
    if (!deletePreviewView(preview).canDelete) return;
    // No pending line: on the owner's phone the answer is a quiet refusal,
    // and nothing may be said about it.
    this._busy = 'delete';
    this._renderControls();
    try {
      const { response, data } = await this._send(
        `${AI_WORLD_API}/delete`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ scope: preview.scope, token: preview.token }),
        },
        { watch: true },
      );
      if (this._destroyed) return;
      if (!response?.ok) {
        // Only the PC removes (owner ruling 2026-10-11): from the owner's
        // phone this is a quiet no-op, and the preview stays as it was.
        if (isOwnerRemovalRefusal(response)) return;
        if (isOwnerRemovalRefusal(response, data)) {
          noteOwnerRemovalRefusal();
          return;
        }
        this._refused(tl('DELETE'), response, data);
        if (Number(response?.status) === 409) {
          this._busy = '';
          void this._loadPreview();
        }
        return;
      }
      const files = Number(data?.deleted?.files) || 0;
      const bytes = Number(data?.deleted?.bytes) || 0;
      this._busy = '';
      this._closeDelete();
      const message = tln(
        files,
        'DELETED {count} FILE · {size}',
        'DELETED {count} FILES · {size}',
        {
          count: formatCount(files),
          size: formatBytes(bytes),
        },
      );
      this._say(message);
      this._log(tl('DELETE'), message);
      void this._poll();
    } catch (error) {
      this._unanswered(tl('DELETE'), error);
    } finally {
      if (this._busy === 'delete') this._busy = '';
      if (!this._destroyed) this._renderControls();
    }
  }

  /* --------------------------------------------------------------------- */
  /* STATUS and PREDICTIONS                                                 */
  /* --------------------------------------------------------------------- */

  _renderStages() {
    const lines = stageLines(this._status, this._now());
    for (const key of AI_WORLD_STAGE_KEYS)
      this._setText(this._stageEls[key], lines[key]);
    // The measured links show only once ml.gevtape.links has reported.
    const links = this._stageEls.links;
    if (links && links.hidden !== !lines.links) links.hidden = !lines.links;
  }

  _availableDomains() {
    const domains = this._status?.stages?.predictor?.domains;
    return new Set(Array.isArray(domains) ? domains : []);
  }

  _domainList() {
    const ids = AI_WORLD_DOMAINS.map((domain) => domain.id);
    for (const id of this._availableDomains())
      if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
    return ids
      .filter((id) => id !== 'military' && !id.startsWith('military-'))
      .map((id) => ({
        id,
        label: tl(
          (
            AI_WORLD_DOMAINS.find((domain) => domain.id === id)?.label || id
          ).toUpperCase(),
        ),
      }));
  }

  _ensureDomainRow(domain) {
    if (this._domainBoxes[domain.id] || !this._domainsEl || !this._doc) return;
    const row = this._doc.createElement('div');
    row.className = 'ai-world-row';
    const label = this._doc.createElement('label');
    label.className = 'outbreak-mode';
    label.dataset.domain = domain.id;
    const box = this._doc.createElement('input');
    box.type = 'checkbox';
    box.id = `ai-world-domain-${domain.id}`;
    box.setAttribute(
      'aria-label',
      tl('Predict {domain}', { domain: domain.label }),
    );
    const swatch = this._doc.createElement('span');
    swatch.className = 'outbreak-swatch';
    const name = this._doc.createElement('span');
    name.className = 'ai-world-name';
    name.textContent = domain.label;
    const note = this._doc.createElement('span');
    note.className = 'ai-world-note';
    note.id = `ai-world-domain-${domain.id}-note`;
    label.appendChild(box);
    label.appendChild(swatch);
    label.appendChild(name);
    row.appendChild(label);
    row.appendChild(note);
    this._domainsEl.appendChild(row);
    this._domainBoxes[domain.id] = box;
    this._domainNotes[domain.id] = note;
    this._on(box, 'change', () => this._onDomainChange());
  }

  /** A domain the predictor can draw is a live tick; the rest are LEARNING. */
  _renderDomains() {
    const available = this._availableDomains();
    const learning = learningLabel(this._status?.learning);
    const domains = this._domainList();
    for (const domain of domains) this._ensureDomainRow(domain);
    for (const domain of domains) {
      const box = this._domainBoxes[domain.id];
      const ready = available.has(domain.id);
      this._setDisabled(box, !ready);
      const checked = ready && this._predictions.domains.includes(domain.id);
      if (box && box.checked !== checked) box.checked = checked;
      this._setText(
        this._domainNotes[domain.id],
        domainNote(
          ready,
          learning,
          this._status?.stages?.trainer?.domains?.[domain.id],
        ),
      );
    }
    if (this._predictAll) {
      const readyIds = domains.filter((domain) => available.has(domain.id));
      const allOn =
        readyIds.length > 0 &&
        readyIds.every((domain) =>
          this._predictions.domains.includes(domain.id),
        );
      if (this._predictAll.checked !== allOn) this._predictAll.checked = allOn;
      this._setDisabled(this._predictAll, readyIds.length === 0);
    }
    this._emitPredictions();
  }

  _onPredictAll() {
    const available = this._availableDomains();
    const on = Boolean(this._predictAll?.checked);
    const chosen = new Set(
      this._predictions.domains.filter((id) => !available.has(id)),
    );
    if (on) for (const id of available) chosen.add(id);
    this._predictions = cleanPredictions(
      { ...this._predictions, domains: [...chosen] },
      this._domainList().map((domain) => domain.id),
    );
    this._savePredictions();
    this._renderDomains();
  }

  _onDomainChange() {
    const chosen = new Set(this._predictions.domains);
    for (const domain of this._domainList()) {
      const box = this._domainBoxes[domain.id];
      // A domain still learning keeps the choice saved for it.
      if (!box || box.disabled) continue;
      if (box.checked) chosen.add(domain.id);
      else chosen.delete(domain.id);
    }
    this._predictions = cleanPredictions(
      {
        ...this._predictions,
        domains: this._domainList()
          .map((domain) => domain.id)
          .filter((id) => chosen.has(id)),
      },
      this._domainList().map((domain) => domain.id),
    );
    this._savePredictions();
    this._emitPredictions();
  }

  _onHorizonChange() {
    this._predictions = cleanPredictions({
      ...this._predictions,
      horizonHours: this._horizon?.value,
    });
    if (this._horizon)
      this._horizon.value = String(this._predictions.horizonHours);
    this._showHorizon(this._predictions.horizonHours);
    this._savePredictions();
    this._emitPredictions();
  }

  _showHorizon(value) {
    const label = horizonLabel(value);
    this._setText(this._horizonValue, label);
    const hours = clampInt(
      value,
      AI_WORLD_HORIZON_MIN,
      AI_WORLD_HORIZON_MAX,
      AI_WORLD_HORIZON_DEFAULT,
    );
    const spoken = tln(hours, '{count} HOUR', '{count} HOURS');
    if (
      typeof this._horizon?.setAttribute === 'function' &&
      this._horizon.getAttribute?.('aria-valuetext') !== spoken
    )
      this._horizon.setAttribute('aria-valuetext', spoken);
  }

  /** The globe overlay hears what to draw each time that changes. */
  _emitPredictions() {
    const available = this._availableDomains();
    const detail = {
      domains: this._predictions.domains.filter((id) => available.has(id)),
      horizonHours: this._predictions.horizonHours,
    };
    if (this._infer) detail.infer = this._infer;
    const key = JSON.stringify(detail);
    if (key === this._lastEmitted) return;
    this._lastEmitted = key;
    try {
      this._doc?.dispatchEvent?.(
        new CustomEvent(AI_WORLD_PREDICTIONS_EVENT, { detail }),
      );
    } catch {
      /* No event target here: nothing listens. */
    }
  }

  _loadPredictions() {
    let raw = null;
    try {
      raw = JSON.parse(
        this._storage?.getItem?.(AI_WORLD_STORAGE_KEY) || 'null',
      );
    } catch {
      raw = null;
    }
    return cleanPredictions(raw || {});
  }

  _savePredictions() {
    try {
      this._storage?.setItem?.(
        AI_WORLD_STORAGE_KEY,
        JSON.stringify(this._predictions),
      );
    } catch {
      /* Private mode or a full store: the choice lasts this visit. */
    }
  }

  async _askInfer() {
    if (this._destroyed || this._busy) return;
    const kind = String(this._inferKind?.value || 'location');
    const query = String(this._inferQuery?.value || '').trim();
    const point = this._viewPoint?.() || null;
    this._busy = 'infer';
    this._setDisabled(this._inferBtn, true);
    this._say(tl('INFERRING'));
    try {
      const { response, data } = await this._postJson('infer', {
        kind,
        query,
        lat: point?.lat,
        lon: point?.lon,
        horizon: this._predictions.horizonHours,
      });
      if (this._destroyed) return;
      if (!response?.ok || !data || typeof data !== 'object') {
        this._refused(tl('INFER'), response, data);
        return;
      }
      const names = Array.isArray(data.matched)
        ? data.matched
            .map((item) => item.label || item.id)
            .filter(Boolean)
            .slice(0, 3)
            .join(', ')
        : '';
      const note =
        data.note ||
        (data.learning ? msgl('LEARNING') : names || msgl('NO MATCH'));
      // The server's notes are LEARNING and NO MATCH; names show as given.
      const shown = tl(note);
      this._setText(this._inferNote, shown);
      this._infer =
        note === 'NO MATCH' || note === 'LEARNING' || data.learning
          ? null
          : data;
      this._lastEmitted = '';
      this._emitPredictions();
      this._log(tl('INFER'), shown);
      this._say(shown);
    } catch (error) {
      this._unanswered(tl('INFER'), error);
    } finally {
      if (this._busy === 'infer') this._busy = '';
      if (!this._destroyed) this._setDisabled(this._inferBtn, false);
    }
  }

  async _loadNewsUrls() {
    const { response, data } = await this._getJson('news-urls').catch(() => ({
      response: null,
      data: null,
    }));
    if (!response?.ok) return;
    this._paintNews(Array.isArray(data?.urls) ? data.urls : []);
  }

  _paintNews(urls) {
    this._setText(this._newsCount, `${urls.length} / 100`);
    if (!this._newsList || !this._doc) return;
    this._newsList.replaceChildren(
      ...urls.map((url) => {
        const li = this._doc.createElement('li');
        li.className = 'ai-world-row';
        const name = this._doc.createElement('span');
        name.className = 'ai-world-name';
        name.textContent = url;
        const button = this._doc.createElement('button');
        button.type = 'button';
        button.className = 'scene-btn ai-world-area-remove';
        button.dataset.newsUrl = url;
        button.textContent = tl('REMOVE');
        li.appendChild(name);
        li.appendChild(button);
        return li;
      }),
    );
  }

  async _addNewsUrl() {
    const url = String(this._newsInput?.value || '').trim();
    if (!url) return;
    const { response, data } = await this._postJson('news-urls', { url });
    if (!response?.ok) {
      this._refused(tl('NEWS URL'), response, data);
      return;
    }
    if (this._newsInput) this._newsInput.value = '';
    this._paintNews(Array.isArray(data?.urls) ? data.urls : []);
  }

  async _removeNewsUrl(event) {
    const url = event?.target?.dataset?.newsUrl;
    if (!url) return;
    const { response, data } = await this._send(`${AI_WORLD_API}/news-urls`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ url }),
    });
    if (isOwnerRemovalRefusal(response, data)) return;
    if (!response?.ok) {
      this._refused(tl('NEWS URL'), response, data);
      return;
    }
    this._paintNews(Array.isArray(data?.urls) ? data.urls : []);
  }

  async _loadMarkets() {
    this._marketsAt = this._now();
    const { response, data } = await this._getJson('markets').catch(() => ({
      response: null,
      data: null,
    }));
    if (!response?.ok || !this._doc || this._destroyed) return;
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
    // The world model's predicted moves, once it predicts markets.
    let prediction = null;
    const horizon = this._predictions.horizonHours;
    if (this._availableDomains().has('markets')) {
      const asked = await this._getJson(
        `predict?domain=markets&horizon=${encodeURIComponent(horizon)}`,
      ).catch(() => ({ response: null, data: null }));
      if (asked.response?.ok) prediction = asked.data;
    }
    if (!this._marketsList || this._destroyed) return;
    const lines = marketLines(quotes, prediction, horizon);
    const text = lines.join('\n');
    if (text === this._marketsText) return;
    this._marketsText = text;
    this._marketsList.replaceChildren(
      ...lines.map((line) => {
        const li = this._doc.createElement('li');
        li.textContent = line;
        return li;
      }),
    );
  }
}

/**
 * Mount the box for the shell's lifetime (src/app/startupChrome.js). A no-op
 * on a page without #ai-world-panel.
 */
export function initAiWorldPanel({
  documentRef = globalThis.document,
  fetchImpl,
  signal,
  dataManager = null,
  viewPoint,
  storage,
  timers,
  now,
} = {}) {
  return new AiWorldPanel({
    document: documentRef,
    fetch: fetchImpl,
    signal,
    dataManager,
    viewPoint,
    storage,
    timers,
    now,
  });
}
