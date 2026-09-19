import * as Cesium from 'cesium';
import { closestCityForSearch } from './locations.js';
import { getBasemapLabelContext } from './voice/gevActions.js';
import {
  buildLayerActivity,
  buildOverviewQuestion,
  buildOverviewRiskBrief,
  buildRiskAssessmentQuestion,
  formatAskLogEntry,
  formatRiskSearchBody,
  prependOutputLog,
} from './askOverview.js';

/**
 * Ask panel — operator-driven questions about the scene on screen.
 *
 * Two rules shape this file.
 *
 * It is silent until asked. There is no timer, no camera-move hook and no
 * startup call: a language model is contacted when the operator presses Ask,
 * Overview, or Risk Assessment, and at no other time. Overview rates on-screen
 * activity (low/mid/high) and how it changes operational risk. Risk Assessment
 * can run first. Each Risk press searches government and local sources, shows
 * those hits, and prepends them on a running output log. Each press costs one
 * model request plus the basemap label lookup that describes the view
 * (reverse geocoding through Google when a Maps key is present), so a
 * session costs as many of each as questions asked.
 *
 * It draws one row per model that holds a key. With a single key the panel
 * looks like one search box; with three it becomes three, each labelled, so the
 * same view can be put to several models and their answers compared.
 */

const PROVIDERS_URL = '/api/llm/providers';
const ASK_URL = '/api/llm/ask';

/**
 * The browser aborts this long after the server's own ceiling, which the
 * roster reports, so the server's error message wins rather than the browser
 * aborting first and reporting something vaguer.
 */
const CLIENT_TIMEOUT_MARGIN_MS = 10000;
/** Used only until the roster has said what the server's ceiling is. */
const DEFAULT_ASK_TIMEOUT_MS = 240000;

export class AskPanel {
  /**
   * @param {Cesium.Viewer} viewer - The live scene, read for camera context.
   */
  constructor(viewer) {
    this.viewer = viewer;
    this._dataManager = null;
    this._askTimeoutMs = DEFAULT_ASK_TIMEOUT_MS;
    /** @type {Map<string, AbortController>} One in-flight request per model. */
    this._inFlight = new Map();
    /** @type {Map<string, {input: HTMLInputElement, ask: HTMLButtonElement, overview: HTMLButtonElement, risk: HTMLButtonElement, output: HTMLElement, logCount: HTMLElement, status: HTMLElement, entries: number}>} */
    this._rows = new Map();

    this._panel = document.getElementById('ask-panel');
    this._body = document.getElementById('ask-body');
    this._rowHost = document.getElementById('ask-rows');
    this._toggle = document.getElementById('ask-toggle');
    this._empty = document.getElementById('ask-empty');

    if (!this._panel || !this._rowHost) return;

    this._toggle?.addEventListener('click', () => {
      if (!this._body) return;
      this._body.hidden = !this._body.hidden;
      const hidden = this._body.hidden;
      this._toggle.textContent = hidden ? '+' : '-';
      this._toggle.setAttribute('aria-expanded', String(!hidden));
      this._toggle.title = hidden ? 'Show the LLM panel' : 'Hide the LLM panel';
    });

    // Reading the roster asks the server which keys exist. It contacts no
    // model and costs nothing.
    void this._buildRows();
  }

  /** @param {object|null} dataManager - Layer roster, read for enabled layers. */
  attachDataManager(dataManager) {
    this._dataManager = dataManager || null;
  }

  /** Draw one control row per model that holds a key. */
  async _buildRows() {
    let providers = [];
    let reachable = true;
    try {
      const response = await fetch(PROVIDERS_URL);
      const data = await response.json();
      providers = (data?.providers || []).filter((p) => p.ready);
      if (Number.isFinite(data?.askTimeoutMs) && data.askTimeoutMs > 0) {
        this._askTimeoutMs = data.askTimeoutMs;
      }
    } catch {
      reachable = false;
    }

    this._rowHost.textContent = '';
    this._rows.clear();

    if (providers.length === 0) {
      if (this._empty) {
        // A server that could not be reached is a different problem from a
        // server that has no keys; say which.
        this._empty.textContent = reachable
          ? 'No model key yet. Add one in POWER UP.'
          : 'Could not reach the server for the model list.';
        this._empty.hidden = false;
      }
      return;
    }
    if (this._empty) this._empty.hidden = true;

    // With one model the label would be noise; with several it is the only way
    // to tell the rows apart.
    const showLabels = providers.length > 1;
    for (const provider of providers) {
      this._rowHost.append(this._buildRow(provider, showLabels));
    }
  }

  /**
   * @param {{id: string, label: string, model: string}} provider
   * @param {boolean} showLabel
   * @returns {HTMLElement}
   */
  _buildRow(provider, showLabel) {
    const row = document.createElement('div');
    row.className = 'ask-row';
    row.dataset.provider = provider.id;

    const status = document.createElement('div');
    status.className = 'ask-status';
    // Progress and error lines are worth announcing too; without this a
    // screen-reader operator hears nothing until the answer lands.
    status.setAttribute('aria-live', 'polite');

    const controls = document.createElement('div');
    controls.className = 'ask-controls';

    if (showLabel) {
      const label = document.createElement('span');
      label.className = 'ask-row-label';
      label.textContent = provider.label;
      label.title = `${provider.label} · ${provider.model}`;
      controls.append(label);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ask-input';
    input.placeholder = showLabel ? `Ask ${provider.label}...` : 'Ask about this view...';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', `Ask ${provider.label} about the current view`);

    const ask = document.createElement('button');
    ask.type = 'button';
    ask.className = 'scene-btn';
    ask.textContent = 'ASK';
    ask.title = `Send the typed question to ${provider.label}`;

    const overview = document.createElement('button');
    overview.type = 'button';
    overview.className = 'scene-btn ask-overview-btn';
    overview.textContent = 'OVERVIEW';
    overview.title = `Have ${provider.label} rate on-screen activity and how it changes risk`;

    const risk = document.createElement('button');
    risk.type = 'button';
    risk.className = 'scene-btn ask-risk-btn';
    risk.textContent = 'RISK ASSESSMENT';
    risk.title = `Have ${provider.label} assess risk from government crime-stat outliers and correlated sources. Can run before Overview`;

    const actions = document.createElement('div');
    actions.className = 'ask-actions';
    actions.append(overview, risk);

    const logCount = document.createElement('div');
    logCount.className = 'ask-log-count';
    logCount.hidden = true;

    const output = document.createElement('div');
    output.className = 'ask-output';
    output.setAttribute('role', 'status');
    output.setAttribute('aria-live', 'polite');

    controls.append(input, ask);
    row.append(controls, actions, status, logCount, output);

    ask.addEventListener('click', () => this._askTyped(provider.id));
    overview.addEventListener('click', () => void this.overview(provider.id));
    risk.addEventListener('click', () => void this.riskAssessment(provider.id));
    // The globe's single-letter hotkeys already ignore keystrokes whose target
    // is a text field, so only Enter needs handling here.
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this._askTyped(provider.id);
    });

    this._rows.set(provider.id, {
      input,
      ask,
      overview,
      risk,
      output,
      logCount,
      status,
      entries: 0,
    });
    return row;
  }

  /** Ask whatever is typed in one model's box. */
  _askTyped(providerId) {
    const row = this._rows.get(providerId);
    const question = String(row?.input?.value || '').trim();
    if (!question) {
      this._setStatus(providerId, 'Type a question first.');
      return;
    }
    void this.ask(question, {
      provider: providerId,
      kind: 'ASK',
    });
  }

  /**
   * Ask one model what is on screen, activity level, and how that changes risk.
   *
   * @param {string} providerId
   */
  async overview(providerId) {
    const context = await this.sceneContext();
    const brief = this._riskBrief(context);
    return this.ask(buildOverviewQuestion(brief), {
      provider: providerId,
      label: 'Overview',
      kind: 'OVERVIEW',
      locationName: brief.locationName,
      context,
    });
  }

  /**
   * Ask one model for a location-specific risk assessment.
   * Independent of Overview — may run first and keeps its own answer.
   *
   * @param {string} providerId
   */
  async riskAssessment(providerId) {
    const row = this._rows.get(providerId);
    if (!row) return null;
    if (this._inFlight.has(providerId)) {
      this._setStatus(providerId, 'Still working on the last question.');
      return null;
    }

    this._inFlight.set(providerId, new AbortController());
    this._setBusy(providerId, true, 'Searching risk sources...');
    try {
      const context = await this.sceneContext();
      const brief = this._riskBrief(context);
      const headlines = await this._riskHeadlines(brief, context.view);
      context.riskAssessment = { ...brief, ...headlines };
      this._prependAnswer(
        providerId,
        formatAskLogEntry('RISK SEARCH', formatRiskSearchBody(headlines), {
          locationName: brief.searchCity || brief.locationName,
        }),
      );
      return await this.ask(buildRiskAssessmentQuestion(brief), {
        provider: providerId,
        label: 'Risk assessment',
        kind: 'RISK ASSESSMENT',
        locationName: brief.searchCity || brief.locationName,
        context,
        continueFlight: true,
      });
    } catch (error) {
      this._inFlight.delete(providerId);
      this._setBusy(providerId, false);
      this._setStatus(providerId, error?.message || 'Risk search failed.');
      return null;
    }
  }

  /**
   * Send one question to one model with the current scene as context.
   *
   * @param {string} question
   * @param {{provider: string, label?: string, kind?: string, locationName?: string, continueFlight?: boolean, context?: object}} options
   */
  async ask(question, options) {
    const providerId = options?.provider;
    const row = this._rows.get(providerId);
    if (!row) return null;

    if (!options?.continueFlight && this._inFlight.has(providerId)) {
      this._setStatus(providerId, 'Still working on the last question.');
      return null;
    }

    const verb = options.label || 'Asking';
    this._setBusy(providerId, true, `${verb}...`);
    // These models take a minute or more. Without a visible clock the panel
    // looks broken, which is exactly how it was first reported.
    const startedAt = Date.now();
    const ticker = window.setInterval(() => {
      this._setStatus(providerId, `${verb}... ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }, 1000);

    const controller = new AbortController();
    this._inFlight.set(providerId, controller);
    const timeout = window.setTimeout(
      () => controller.abort(),
      this._askTimeoutMs + CLIENT_TIMEOUT_MARGIN_MS,
    );

    try {
      const context = options.context || await this.sceneContext();
      const response = await fetch(ASK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, question, context }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      // Stop the clock before anything writes the final line, so a tick landing
      // in the same second cannot overwrite the answer's status.
      window.clearInterval(ticker);

      if (response.status === 501 || data?.unconfigured) {
        this._setStatus(providerId, 'No key for this model. Add one in POWER UP.');
        return null;
      }
      if (!response.ok || !data?.answer) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }

      this._prependAnswer(
        providerId,
        formatAskLogEntry(options.kind || 'ASK', data.answer, {
          locationName: options.locationName || context.selectedLocation,
        }),
      );
      this._setStatus(providerId, this._usageLine(data));
      return data.answer;
    } catch (error) {
      // The previous answer stays on screen: a failed follow-up must not erase
      // what the operator was reading.
      const aborted = error?.name === 'AbortError';
      this._setStatus(providerId, aborted ? 'No answer in time.' : (error?.message || 'Request failed.'));
      return null;
    } finally {
      window.clearInterval(ticker);
      window.clearTimeout(timeout);
      this._inFlight.delete(providerId);
      this._setBusy(providerId, false);
    }
  }

  /** One line naming the model and what the answer cost. */
  _usageLine(data) {
    const usage = data?.usage || {};
    // OpenAI-shaped and Anthropic-shaped usage report different field names.
    const total = Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : (Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0)) || null;
    const model = data?.model ? String(data.model) : '';
    if (model && total) return `${model} · ${total} tokens`;
    return model || '';
  }

  /**
   * Describe the scene for the model: where the camera is, what is under it,
   * and what is switched on. Text labels only — the model is told to use this
   * and nothing else, so anything absent here is something it must not claim.
   *
   * @returns {Promise<object>}
   */
  async sceneContext() {
    const camera = this.viewer?.camera;
    const carto = camera?.positionCartographic;
    const view = carto
      ? {
        latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(5)),
        longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(5)),
        cameraAltitudeMeters: Math.round(carto.height),
        headingDegrees: Math.round(Cesium.Math.toDegrees(camera.heading)),
        pitchDegrees: Math.round(Cesium.Math.toDegrees(camera.pitch)),
      }
      : null;

    let labels = { placeLabels: [], streetLabels: [], nearbyPlaceLabels: [], locality: null };
    try {
      labels = await getBasemapLabelContext(this.viewer);
    } catch {
      // A label pick can fail while tiles are still loading. An overview
      // without place names is worth more than an error.
    }

    const layers = this._dataManager?.getAll?.() || [];
    const enabled = layers.filter((layer) => layer.enabled);
    return {
      capturedAt: new Date().toISOString(),
      view,
      placeLabels: labels.placeLabels || [],
      streetLabels: labels.streetLabels || [],
      nearbyPlaceLabels: labels.nearbyPlaceLabels || [],
      enabledLayers: enabled.map((layer) => layer.name),
      layerActivity: buildLayerActivity(enabled),
      availableLayers: layers.map((layer) => layer.name),
      activeVisualStyle: document.getElementById('active-style-name')?.textContent?.trim() || null,
      selectedCamera: this._selectedCameraLabel(),
      selectedLocation: this._selectedLocationLabel(),
      locality: labels.locality || null,
    };
  }

  _selectedCityLabel() {
    const city = document.getElementById('location-mini-city')?.textContent || '';
    const cityName = city.replace(/^📍\s*/u, '').replace(/^location:\s*/i, '').trim();
    if (!cityName || cityName === '--') return null;
    return cityName;
  }

  _selectedLocationLabel() {
    const cityName = this._selectedCityLabel();
    const poi = document.getElementById('location-mini-poi')?.textContent || '';
    const poiName = poi.replace(/^landmark:\s*/i, '').trim();
    if (!cityName) return null;
    if (poiName && poiName !== '--' && !/^searched location$/i.test(poiName)) {
      return `${poiName}, ${cityName}`;
    }
    return cityName;
  }

  _closestSearchCity(context) {
    const fromView = closestCityForSearch(
      context?.view?.latitude,
      context?.view?.longitude,
    );
    return fromView?.name || context?.locality || this._selectedCityLabel() || null;
  }

  _riskBrief(context) {
    return buildOverviewRiskBrief({
      selectedLocation: this._selectedLocationLabel(),
      selectedCity: this._selectedCityLabel(),
      closestCity: this._closestSearchCity(context),
      locality: context?.locality,
      placeLabels: context?.placeLabels,
      view: context?.view,
    });
  }

  async _riskHeadlines(brief, view) {
    const empty = { localHeadlines: [], govCrimeHeadlines: [], alJazeera: null };
    if (!Number.isFinite(view?.latitude) || !Number.isFinite(view?.longitude)) {
      return empty;
    }
    try {
      const params = new URLSearchParams({
        latitude: String(view.latitude),
        longitude: String(view.longitude),
        q: brief.newsQuery || '',
        region: brief.region || '',
        place: brief.searchCity || brief.locationName || '',
      });
      const response = await fetch(`/api/regional-risk-news?${params}`, {
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) return empty;
      const data = await response.json();
      return {
        localHeadlines: Array.isArray(data?.articles) ? data.articles.slice(0, 8) : [],
        govCrimeHeadlines: Array.isArray(data?.govArticles)
          ? data.govArticles.slice(0, 10)
          : [],
        alJazeera: data?.alJazeera
          ? {
              status: String(data.alJazeera.status || 'unavailable'),
              lookbackDays: Number(data.alJazeera.lookbackDays) || 90,
              url: 'https://www.aljazeera.com/',
              articles: Array.isArray(data.alJazeera.articles)
                ? data.alJazeera.articles.slice(0, 5)
                : [],
            }
          : null,
      };
    } catch {
      return empty;
    }
  }

  /** Name of the CCTV camera currently open, when one is. */
  _selectedCameraLabel() {
    const text = document.getElementById('cctv-source-badge')?.textContent?.trim();
    if (!text || /unknown/i.test(text)) return null;
    return text.replace(/^SOURCE\s*[^A-Za-z0-9]*/i, '').trim() || null;
  }

  _setBusy(providerId, busy, message) {
    const row = this._rows.get(providerId);
    if (!row) return;
    row.ask.disabled = busy;
    if (row.overview) row.overview.disabled = busy;
    if (row.risk) row.risk.disabled = busy;
    if (busy && message) this._setStatus(providerId, message);
  }

  _setStatus(providerId, text) {
    const row = this._rows.get(providerId);
    if (row) row.status.textContent = text || '';
  }

  _prependAnswer(providerId, text) {
    const row = this._rows.get(providerId);
    if (!row?.output) return;
    const next = prependOutputLog(row.output.textContent, text);
    if (!next) return;
    row.output.textContent = next;
    row.output.scrollTop = 0;
    row.entries = (row.entries || 0) + 1;
    if (row.logCount) {
      row.logCount.hidden = false;
      row.logCount.textContent =
        row.entries === 1 ? '1 report' : `${row.entries} reports`;
    }
  }
}
