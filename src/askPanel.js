import * as Cesium from 'cesium';
import { getBasemapLabelContext } from './voice/gevActions.js';

/**
 * Ask panel — operator-driven questions about the scene on screen.
 *
 * Two rules shape this file.
 *
 * It is silent until asked. There is no timer, no camera-move hook and no
 * startup call: a language model is contacted when the operator presses Ask
 * or Overview, and at no other time. Each press costs one model request plus
 * the basemap label lookup that describes the view (reverse geocoding through
 * Google when a Maps key is present), so a session costs as many of each as
 * questions asked.
 *
 * It draws one row per model that holds a key. With a single key the panel
 * looks like one search box; with three it becomes three, each labelled, so the
 * same view can be put to several models and their answers compared.
 */

const PROVIDERS_URL = '/api/llm/providers';
const ASK_URL = '/api/llm/ask';

/**
 * What Overview asks on the operator's behalf: first what is on screen, then
 * what about it is worth worrying about.
 *
 * The risk half is deliberately fenced. The model only ever sees the scene
 * JSON, so it is told to reason from the hazard layers actually switched on and
 * to say when the data will not support an assessment. Without that it will
 * cheerfully invent threats from a place name alone.
 */
const OVERVIEW_QUESTION = [
  'Give me an overview of what I am looking at right now:',
  'where the camera is pointed, what that place is,',
  'and which of the enabled layers matter here.',
  'Then give a short risk assessment of this view.',
  'Base it only on the scene data: the hazard-bearing layers that are enabled',
  '(earthquakes, active fires, flights, vessels, traffic, cameras),',
  'the altitude and what it means for what is observable,',
  'and anything the place and street labels imply about what is below.',
  'Name what you cannot assess from this data instead of guessing,',
  'and do not invent hazards that the enabled layers would not show.',
  'Keep the overview and the risk assessment to one short paragraph each.',
].join(' ');

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
    /** @type {Map<string, {input: HTMLInputElement, ask: HTMLButtonElement, overview: HTMLButtonElement, output: HTMLElement, status: HTMLElement}>} */
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

    const output = document.createElement('div');
    output.className = 'ask-output';
    output.setAttribute('role', 'status');
    output.setAttribute('aria-live', 'polite');

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
    overview.title = `Have ${provider.label} describe what is on screen`;

    controls.append(input, ask, overview);
    row.append(output, status, controls);

    ask.addEventListener('click', () => this._askTyped(provider.id));
    overview.addEventListener('click', () => void this.overview(provider.id));
    // The globe's single-letter hotkeys already ignore keystrokes whose target
    // is a text field, so only Enter needs handling here.
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this._askTyped(provider.id);
    });

    this._rows.set(provider.id, { input, ask, overview, output, status });
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
    void this.ask(question, { provider: providerId });
  }

  /**
   * Ask one model to describe the current view.
   *
   * @param {string} providerId
   */
  overview(providerId) {
    return this.ask(OVERVIEW_QUESTION, { provider: providerId, label: 'Overview' });
  }

  /**
   * Send one question to one model with the current scene as context.
   *
   * @param {string} question
   * @param {{provider: string, label?: string}} options
   */
  async ask(question, options) {
    const providerId = options?.provider;
    const row = this._rows.get(providerId);
    if (!row) return null;

    if (this._inFlight.has(providerId)) {
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
      const context = await this.sceneContext();
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

      this._setAnswer(providerId, data.answer);
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

    let labels = { placeLabels: [], streetLabels: [], nearbyPlaceLabels: [] };
    try {
      labels = await getBasemapLabelContext(this.viewer);
    } catch {
      // A label pick can fail while tiles are still loading. An overview
      // without place names is worth more than an error.
    }

    const layers = this._dataManager?.getAll?.() || [];
    return {
      capturedAt: new Date().toISOString(),
      view,
      placeLabels: labels.placeLabels || [],
      streetLabels: labels.streetLabels || [],
      nearbyPlaceLabels: labels.nearbyPlaceLabels || [],
      enabledLayers: layers.filter((l) => l.enabled).map((l) => l.name),
      availableLayers: layers.map((l) => l.name),
      activeVisualStyle: document.getElementById('active-style-name')?.textContent?.trim() || null,
      selectedCamera: this._selectedCameraLabel(),
    };
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
    row.overview.disabled = busy;
    if (busy && message) this._setStatus(providerId, message);
  }

  _setStatus(providerId, text) {
    const row = this._rows.get(providerId);
    if (row) row.status.textContent = text || '';
  }

  _setAnswer(providerId, text) {
    const row = this._rows.get(providerId);
    if (!row) return;
    row.output.textContent = text || '';
    row.output.scrollTop = 0;
  }
}
