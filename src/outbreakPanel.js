/**
 * OUTBREAK LOCATIONS & PREDICTED SPREAD: the left-hand box.
 *
 * It keeps the outbreak locations (Irkutsk and Shelekhov to start; any can
 * be added by name or removed), scans the travel out of them since the scan
 * began, works out how far each way of travel could have carried the
 * outbreak by the hour picked (src/outbreakCore.mjs), and hands that to the
 * Outbreak map layer on OUTBREAK_MODEL_EVENT.
 *
 * SCAN TRAVEL:
 *  - OpenStreetMap near each location: is there a railway station (train
 *    spread), the area's train speed from its rail lines, and water traffic
 *    within 100 km (boat spread);
 *  - flight history out of the airports near each location and the
 *    connecting flights out of where they landed (OpenSky, POWER UP →
 *    OPENSKY); without that account, the chosen language model's knowledge
 *    of airline schedules, read from a list of real airports.
 * MEDIA SEARCH: a global news search (GDELT), then the chosen language model
 * (the Ask route) names the new places those articles report.
 * SOCIAL SEARCH: the Grok Bot or OpenAI DOTS swarm (the Social Media
 * Analysis route), one bot per platform, on that swarm's own key.
 * New places found are listed for the operator to add; none is added alone.
 */
import { formatAskLogEntry, prependOutputLog } from './askOverview.js';
import { geocodeKeyless } from './keylessGeocoder.js';
import { SOCIAL_SWARM_BOTS, SOCIAL_SWARM_PROVIDERS } from './socialSwarm.mjs';
import {
  CONNECTING_AIRPORTS_MAX,
  CONNECTION_HOURS,
  OUTBREAK_ANSWER_TOKENS,
  OUTBREAK_FORECAST_WINDOWS,
  OUTBREAK_MODEL_EVENT,
  OUTBREAK_REQUEST_EVENT,
  OUTBREAK_MODE_IDS,
  OUTBREAK_SCAN_DAYS_DEFAULT,
  OUTBREAK_SCAN_DAY_OPTIONS,
  OUTBREAK_SHOWN_EVENT,
  OUTBREAK_STORAGE_KEY,
  candidateLine,
  cleanFlight,
  cleanLocation,
  cleanLocations,
  cleanSpeed,
  outbreakHourOptions,
  outbreakMediaQuestion,
  outbreakRoutesQuestion,
  outbreakSocialInstructions,
  outbreakForecastQuestion,
  outbreakForecastScene,
  outbreakSpread,
  parseForecastLines,
  outbreakViewTarget,
  parsePlaceLines,
  parseRouteLines,
  presentHour,
  scanStartMs,
  spreadSummary,
  timeScheduleRoutes,
} from './outbreakCore.mjs';

const PROVIDERS_URL = '/api/llm/providers';
const ASK_URL = '/api/llm/ask';
const SWARM_URL = '/api/social/swarm';
const API = '/api/outbreak';
const DEFAULT_ASK_TIMEOUT_MS = 90_000;
const CLIENT_TIMEOUT_MARGIN_MS = 10_000;
const SWARM_BOT_TIMEOUT_MS = 150_000;
/** PLAY's step: long enough for the map to finish drawing each hour. */
const PLAY_STEP_MS = 900;

function timeLabel(ms) {
  const at = new Date(ms);
  return Number.isNaN(at.getTime())
    ? ''
    : `${String(at.getUTCDate()).padStart(2, '0')} ${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export class OutbreakPanel {
  /**
   * @param {object} viewer The Cesium viewer (unused today; kept like the other boxes).
   * @param {{document?: Document, fetch?: Function, storage?: Storage|null, windowRef?: Window|null, geocode?: Function, now?: Function}} [options]
   */
  constructor(viewer, options = {}) {
    this.viewer = viewer;
    const doc = options.document || globalThis.document;
    this._doc = doc;
    this._fetch = options.fetch || null;
    this._window =
      options.windowRef ?? (typeof window === 'undefined' ? null : window);
    this._storage =
      options.storage !== undefined
        ? options.storage
        : (() => {
            try {
              return globalThis.localStorage || null;
            } catch {
              return null;
            }
          })();
    this._geocode = options.geocode || ((name) => geocodeKeyless(name));
    this._now = options.now || (() => Date.now());
    this._askTimeoutMs = DEFAULT_ASK_TIMEOUT_MS;
    this._busy = '';
    this._playTimer = null;
    // The layer, once listening, asks for the model: a reload with the
    // spread shown draws it again.
    this._onRequest = () => {
      if (this._state) this._send(this._state.show ? { show: true } : {});
    };
    this._onShown = (event) => {
      const shown = Boolean(event?.detail?.shown);
      if (this._showBox) this._showBox.checked = shown;
      if (this._state.show !== shown) {
        this._state.show = shown;
        this._save();
      }
    };

    const byId = (id) => doc?.getElementById?.(id) || null;
    this._root = byId('outbreak-panel');
    if (!this._root) return;
    this._showBox = byId('outbreak-show');
    this._list = byId('outbreak-locations');
    this._addForm = byId('outbreak-add');
    this._addName = byId('outbreak-add-name');
    this._keywords = byId('outbreak-keywords');
    this._days = byId('outbreak-days');
    this._scanBtn = byId('outbreak-scan');
    this._scanNote = byId('outbreak-scan-note');
    this._hour = byId('outbreak-hour');
    this._playBtn = byId('outbreak-play');
    this._summary = byId('outbreak-summary');
    this._destinations = byId('outbreak-destinations');
    this._model = byId('outbreak-model');
    this._mediaBtn = byId('outbreak-media');
    this._swarm = byId('outbreak-swarm');
    this._socialBtn = byId('outbreak-social');
    this._futureBtn = byId('outbreak-future');
    this._forecastList = byId('outbreak-forecast');
    this._found = byId('outbreak-found');
    this._status = byId('outbreak-status');
    this._output = byId('outbreak-output');
    this._modeBoxes = {};
    this._speedBoxes = {};
    for (const mode of OUTBREAK_MODE_IDS) {
      this._modeBoxes[mode] = byId(`outbreak-mode-${mode}`);
      this._speedBoxes[mode] = byId(`outbreak-speed-${mode}`);
    }

    this._state = this._load();
    this._fillControls();
    this._renderLocations();
    this._renderFound();
    this._renderForecast();
    this._refresh();
    this._send(this._state.show ? { show: true } : {});

    this._showBox?.addEventListener('change', () => {
      this._state.show = this._showBox.checked;
      this._save();
      this._send({ show: this._state.show });
    });
    this._addForm?.addEventListener('submit', (event) => {
      event?.preventDefault?.();
      void this._addByName(this._addName?.value);
    });
    this._keywords?.addEventListener('change', () => {
      this._state.keywords = String(this._keywords.value || '')
        .trim()
        .slice(0, 80);
      this._save();
    });
    this._days?.addEventListener('change', () => {
      this._state.days = Number(this._days.value) || OUTBREAK_SCAN_DAYS_DEFAULT;
      this._save();
      this._say('Press SCAN TRAVEL to scan from the new start.');
    });
    this._scanBtn?.addEventListener('click', () => void this._scan());
    this._hour?.addEventListener('change', () => {
      this._stopPlay();
      this._state.hour = Number(this._hour.value) || null;
      this._refresh({ send: true });
    });
    this._playBtn?.addEventListener('click', () => this._togglePlay());
    for (const mode of OUTBREAK_MODE_IDS) {
      this._modeBoxes[mode]?.addEventListener('change', () => {
        this._state.shown[mode] = this._modeBoxes[mode].checked;
        this._refresh({ send: true });
      });
      this._speedBoxes[mode]?.addEventListener('change', () => {
        this._state.speeds[mode] = cleanSpeed(
          mode,
          this._speedBoxes[mode].value,
        );
        this._speedBoxes[mode].value = String(this._state.speeds[mode]);
        this._refresh({ send: true });
      });
    }
    this._list?.addEventListener('click', (event) => {
      const id = event?.target?.dataset?.outbreakRemove;
      if (id) this._remove(id);
    });
    this._found?.addEventListener('click', (event) => {
      const index = event?.target?.dataset?.outbreakFound;
      if (index !== undefined) void this._addFound(Number(index));
    });
    this._mediaBtn?.addEventListener('click', () => void this._mediaSearch());
    this._futureBtn?.addEventListener('click', () => void this._futureSpread());
    this._forecastList?.addEventListener('click', (event) => {
      const index = event?.target?.dataset?.outbreakForecast;
      if (index !== undefined) void this._addForecast(Number(index));
    });
    this._socialBtn?.addEventListener('click', () => void this._socialSearch());
    this._window?.addEventListener?.(OUTBREAK_SHOWN_EVENT, this._onShown);
    this._window?.addEventListener?.(OUTBREAK_REQUEST_EVENT, this._onRequest);
    void this._loadModels();
  }

  destroy() {
    this._stopPlay();
    this._window?.removeEventListener?.(OUTBREAK_SHOWN_EVENT, this._onShown);
    this._window?.removeEventListener?.(
      OUTBREAK_REQUEST_EVENT,
      this._onRequest,
    );
  }

  /* --------------------------------------------------------------------- */
  /* State                                                                  */
  /* --------------------------------------------------------------------- */

  _load() {
    let saved = {};
    try {
      saved =
        JSON.parse(this._storage?.getItem?.(OUTBREAK_STORAGE_KEY) || '{}') ||
        {};
    } catch {
      saved = {};
    }
    const speeds = {};
    const shown = {};
    for (const mode of OUTBREAK_MODE_IDS) {
      speeds[mode] = cleanSpeed(mode, saved?.speeds?.[mode]);
      shown[mode] = saved?.shown?.[mode] !== false;
    }
    const scan =
      saved?.scan && typeof saved.scan === 'object' ? saved.scan : null;
    const startMs = Number(scan?.startMs);
    return {
      locations: cleanLocations(saved?.locations),
      keywords: String(saved?.keywords || '').slice(0, 80),
      days: OUTBREAK_SCAN_DAY_OPTIONS.includes(Number(saved?.days))
        ? Number(saved.days)
        : OUTBREAK_SCAN_DAYS_DEFAULT,
      speeds,
      shown,
      show: saved?.show === true,
      hour: Number(saved?.hour) || null,
      scan: Number.isFinite(startMs)
        ? {
            startMs,
            flights: (Array.isArray(scan.flights) ? scan.flights : [])
              .map((f) => cleanFlight(f))
              .filter(Boolean),
            surroundings:
              scan.surroundings && typeof scan.surroundings === 'object'
                ? scan.surroundings
                : {},
            flightSource: String(scan.flightSource || '').slice(0, 80),
          }
        : null,
      found: (Array.isArray(saved?.found) ? saved.found : []).slice(0, 30),
      forecast: (Array.isArray(saved?.forecast) ? saved.forecast : [])
        .filter((f) => Number.isFinite(f?.lat) && Number.isFinite(f?.lon))
        .slice(0, 24),
    };
  }

  _save() {
    try {
      this._storage?.setItem?.(
        OUTBREAK_STORAGE_KEY,
        JSON.stringify(this._state),
      );
    } catch {
      /* This browser is not keeping it; the box still works. */
    }
  }

  _startMs() {
    return (
      this._state.scan?.startMs ?? scanStartMs(this._now(), this._state.days)
    );
  }

  _fillControls() {
    if (this._showBox) this._showBox.checked = this._state.show;
    if (this._keywords) this._keywords.value = this._state.keywords;
    if (this._days) this._days.value = String(this._state.days);
    for (const mode of OUTBREAK_MODE_IDS) {
      if (this._modeBoxes[mode])
        this._modeBoxes[mode].checked = this._state.shown[mode];
      if (this._speedBoxes[mode])
        this._speedBoxes[mode].value = String(this._state.speeds[mode]);
    }
  }

  /** The hour list, kept on the present when that is where it was. */
  _fillHours() {
    if (!this._hour || !this._doc) return;
    const startMs = this._startMs();
    const nowMs = this._now();
    const last = presentHour(startMs, nowMs);
    const options = outbreakHourOptions(startMs, nowMs);
    const wanted = options.some((o) => o.value === this._state.hour)
      ? this._state.hour
      : last;
    this._hour.replaceChildren();
    for (const option of options) {
      const el = this._doc.createElement('option');
      el.value = String(option.value);
      el.textContent = option.label;
      this._hour.appendChild(el);
    }
    this._hour.value = String(wanted);
    this._state.hour = wanted === last ? null : wanted;
  }

  _spread() {
    const startMs = this._startMs();
    const hour = this._state.hour || presentHour(startMs, this._now());
    return outbreakSpread({
      locations: this._state.locations,
      flights: this._state.scan?.flights || [],
      speeds: this._state.speeds,
      surroundings: this._state.scan?.surroundings || {},
      shown: this._state.shown,
      forecast: this._state.forecast,
      startMs,
      hour,
    });
  }

  _send(extra = {}) {
    try {
      this._window?.dispatchEvent?.(
        new CustomEvent(OUTBREAK_MODEL_EVENT, {
          detail: { spread: this._spread(), ...extra },
        }),
      );
    } catch {
      /* No CustomEvent here (a test without one). */
    }
  }

  _refresh({ send = false } = {}) {
    this._fillHours();
    const spread = this._spread();
    this._renderSummary(spread);
    this._save();
    if (send) this._send();
  }

  /* --------------------------------------------------------------------- */
  /* Rendering                                                              */
  /* --------------------------------------------------------------------- */

  _item(text, button) {
    const li = this._doc.createElement('li');
    const span = this._doc.createElement('span');
    span.textContent = text;
    li.appendChild(span);
    if (button) li.appendChild(button);
    return li;
  }

  _button(label, data) {
    const button = this._doc.createElement('button');
    button.type = 'button';
    button.className = 'scene-btn';
    button.textContent = label;
    Object.assign(button.dataset, data);
    return button;
  }

  _renderLocations() {
    if (!this._list || !this._doc) return;
    this._list.replaceChildren(
      ...this._state.locations.map((location) =>
        this._item(
          `● ${location.name}${location.kind ? ` · ${location.kind}` : ''}${location.source ? ` · ${location.source}` : ''}`,
          this._button('REMOVE', { outbreakRemove: location.id }),
        ),
      ),
    );
    if (!this._state.locations.length)
      this._list.appendChild(
        this._item('No outbreak location. Add one below.'),
      );
  }

  _renderSummary(spread) {
    if (this._summary && this._doc) {
      const lines = spreadSummary(spread, this._state.speeds);
      const scan = this._state.scan;
      lines.push(
        scan
          ? `Scanned from ${timeLabel(scan.startMs)} · flights: ${scan.flightSource || 'none found'}`
          : 'Not scanned yet: press SCAN TRAVEL.',
      );
      this._summary.replaceChildren(...lines.map((line) => this._item(line)));
    }
    if (this._destinations && this._doc) {
      this._destinations.replaceChildren(
        ...spread.destinations.map((place) =>
          this._item(
            `✈ ${place.code}${place.name ? ` ${place.name}` : ''} · landed ${timeLabel(place.arriveMs)}${place.hop === 2 ? ' · connecting' : ''}`,
          ),
        ),
      );
    }
  }

  _renderForecast() {
    if (!this._forecastList || !this._doc) return;
    this._forecastList.replaceChildren(
      ...this._state.forecast.map((row, index) =>
        this._item(
          `WITHIN ${row.within} H · ${row.name}${row.likelihood ? ` · ${row.likelihood}` : ''}${row.reason ? ` · ${row.reason}` : ''}`,
          this._button('+ ADD', { outbreakForecast: String(index) }),
        ),
      ),
    );
  }

  async _addForecast(index) {
    const row = this._state.forecast[index];
    if (!row) return;
    const location = cleanLocation({
      name: row.name,
      lat: row.lat,
      lon: row.lon,
      source: `Future ${row.within} h`,
    });
    if (!location) return;
    if (this._state.locations.some((l) => l.id === location.id)) {
      this._say(`${location.name} is already listed.`);
      return;
    }
    this._state.locations.push(location);
    this._state.forecast.splice(index, 1);
    this._renderLocations();
    this._renderForecast();
    this._refresh({ send: true });
    this._say(
      `ADDED · ${location.name}. Press SCAN TRAVEL to scan its travel.`,
    );
  }

  _renderFound() {
    if (!this._found || !this._doc) return;
    this._found.replaceChildren(
      ...this._state.found.map((row, index) => {
        const li = this._item(
          `${row.place}${row.evidence ? ` · ${row.evidence}` : ''}${row.via ? ` · ${row.via}` : ''}`,
          this._button('+ ADD', { outbreakFound: String(index) }),
        );
        if (row.link) {
          const a = this._doc.createElement('a');
          a.href = row.link;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = 'LINK';
          li.insertBefore(a, li.lastChild);
        }
        return li;
      }),
    );
  }

  _say(text) {
    if (this._status) this._status.textContent = text;
  }

  _log(kind, body) {
    if (!this._output) return;
    this._output.textContent = prependOutputLog(
      this._output.textContent,
      formatAskLogEntry(kind, body),
    );
    this._output.scrollTop = 0;
  }

  /* --------------------------------------------------------------------- */
  /* Locations                                                              */
  /* --------------------------------------------------------------------- */

  async _addByName(rawName, extra = {}) {
    const name = String(rawName || '')
      .trim()
      .slice(0, 80);
    if (!name) {
      this._say('Type a city or town to add.');
      return false;
    }
    this._say(`Finding ${name}…`);
    let place = null;
    try {
      place = await this._geocode(name);
    } catch {
      place = null;
    }
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) {
      this._say(`${name} was not found. Try "town, country".`);
      return false;
    }
    const location = cleanLocation({
      name: place.label || place.name || name,
      lat: place.lat,
      lon: place.lng,
      ...extra,
    });
    if (!location) {
      this._say(`${name} was not found.`);
      return false;
    }
    if (this._state.locations.some((l) => l.id === location.id)) {
      this._say(`${location.name} is already listed.`);
      return false;
    }
    this._state.locations.push(location);
    if (this._addName && !extra.source) this._addName.value = '';
    this._renderLocations();
    this._refresh({ send: true });
    this._say(
      `ADDED · ${location.name}. Press SCAN TRAVEL to scan its travel.`,
    );
    return true;
  }

  _remove(id) {
    const before = this._state.locations.length;
    this._state.locations = this._state.locations.filter((l) => l.id !== id);
    if (this._state.locations.length === before) return;
    this._renderLocations();
    this._refresh({ send: true });
  }

  async _addFound(index) {
    const row = this._state.found[index];
    if (!row) return;
    const added = await this._addByName(row.place, {
      source: row.via || 'Found',
    });
    if (added) {
      this._state.found.splice(index, 1);
      this._renderFound();
      this._save();
    }
  }

  /* --------------------------------------------------------------------- */
  /* Network                                                                */
  /* --------------------------------------------------------------------- */

  _request(url, init) {
    const fetchImpl = this._fetch || globalThis.fetch;
    return fetchImpl(url, init);
  }

  async _getJson(url) {
    const response = await this._request(url, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    return { response, data };
  }

  async _loadModels() {
    const select = this._model;
    if (!select || !this._doc) return;
    let providers = [];
    let reachable = true;
    try {
      const { data } = await this._getJson(PROVIDERS_URL);
      providers = (data?.providers || []).filter((provider) => provider.ready);
      if (Number.isFinite(data?.askTimeoutMs) && data.askTimeoutMs > 0)
        this._askTimeoutMs = data.askTimeoutMs;
    } catch {
      reachable = false;
    }
    select.replaceChildren();
    if (!providers.length) {
      const option = this._doc.createElement('option');
      option.value = '';
      option.textContent = reachable
        ? 'No model key yet'
        : 'Model list unavailable';
      select.appendChild(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const provider of providers) {
      const option = this._doc.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label;
      select.appendChild(option);
    }
    select.value = providers[0].id;
  }

  /** One question to the chosen model; its answer text, or throws. */
  async _ask(question, context) {
    const provider = this._model?.value;
    if (!provider) throw new Error('No model key yet. Add one in POWER UP.');
    const controller = new AbortController();
    const timer = globalThis.setTimeout(
      () => controller.abort(),
      this._askTimeoutMs + CLIENT_TIMEOUT_MARGIN_MS,
    );
    try {
      const response = await this._request(ASK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          question,
          context,
          answerTokens: OUTBREAK_ANSWER_TOKENS,
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (response.status === 501 || data?.unconfigured)
        throw new Error('No key for this model. Add one in POWER UP.');
      if (!response.ok || !data?.answer)
        throw new Error(data?.error || `HTTP ${response.status}`);
      return String(data.answer);
    } catch (error) {
      if (error?.name === 'AbortError')
        throw new Error('The model did not answer in time.');
      throw error;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  _setBusy(what) {
    this._busy = what;
    for (const button of [
      this._scanBtn,
      this._mediaBtn,
      this._socialBtn,
      this._futureBtn,
    ])
      if (button) button.disabled = Boolean(what);
  }

  /* --------------------------------------------------------------------- */
  /* SCAN TRAVEL                                                            */
  /* --------------------------------------------------------------------- */

  async _scan() {
    if (this._busy) {
      this._say(`Still working: ${this._busy}.`);
      return;
    }
    const locations = this._state.locations;
    if (!locations.length) {
      this._say('Add an outbreak location first.');
      return;
    }
    this._stopPlay();
    this._setBusy('scanning');
    const nowMs = this._now();
    const startMs = scanStartMs(nowMs, this._state.days);
    try {
      this._say('SCANNING · rail and water near each location…');
      const surroundings = await this._scanSurroundings(locations);
      this._say('SCANNING · flights…');
      const { flights, source } = await this._scanFlights(
        locations,
        startMs,
        nowMs,
      );
      this._state.scan = {
        startMs,
        flights,
        surroundings,
        flightSource: source,
      };
      this._state.hour = null;
      this._state.show = true;
      if (this._showBox) this._showBox.checked = true;
      this._refresh();
      this._send({ show: true });
      void this._flyToOutbreak();
      const spread = this._spread();
      this._log(
        'OUTBREAK SCAN',
        spreadSummary(spread, this._state.speeds).join('\n'),
      );
      this._say(
        `SCAN DONE · ${flights.length} flight${flights.length === 1 ? '' : 's'} · ${spread.destinations.length} place${spread.destinations.length === 1 ? '' : 's'} reached by plane`,
      );
    } catch (error) {
      this._say(error?.message || 'The scan failed.');
    } finally {
      this._setBusy('');
    }
  }

  async _scanSurroundings(locations) {
    const out = {};
    const speeds = [];
    const lines = [];
    await Promise.all(
      locations.map(async (location) => {
        try {
          const { response, data } = await this._getJson(
            `${API}/surroundings?lat=${location.lat}&lon=${location.lon}`,
          );
          if (!response.ok || !data)
            throw new Error(data?.error || `HTTP ${response.status}`);
          out[location.id] = {
            rail: data.rail === true,
            water: data.water === true,
          };
          if (Number.isFinite(data.trainKmh)) speeds.push(data.trainKmh);
          lines.push(
            `${location.name}: ${data.stations} railway station${data.stations === 1 ? '' : 's'} within 30 km${Number.isFinite(data.trainKmh) ? ` (rail lines average ${data.trainKmh} km/h)` : ''} · ${data.water ? `water traffic within 100 km (${data.waterPlaces})` : 'no water traffic within 100 km'}`,
          );
        } catch (error) {
          out[location.id] = {};
          lines.push(
            `${location.name}: OpenStreetMap did not answer (${error.message}); train and boat both counted (untick one to leave it out).`,
          );
        }
      }),
    );
    if (speeds.length) {
      // The area's average train speed, from its rail lines' own limits.
      const kmh = Math.round(
        speeds.reduce((sum, v) => sum + v, 0) / speeds.length,
      );
      this._state.speeds.train = cleanSpeed('train', kmh);
      if (this._speedBoxes.train)
        this._speedBoxes.train.value = String(this._state.speeds.train);
    }
    this._log('RAIL & WATER', lines.join('\n'));
    return out;
  }

  /** The airports near the outbreak locations, nearest first, at most six. */
  async _outbreakAirports(locations) {
    const airports = new Map();
    for (const location of locations) {
      const { response, data } = await this._getJson(
        `${API}/airports/near?lat=${location.lat}&lon=${location.lon}`,
      );
      if (!response.ok)
        throw new Error(data?.error || `Airports: HTTP ${response.status}`);
      for (const airport of data?.airports || [])
        if (!airports.has(airport.code)) airports.set(airport.code, airport);
    }
    return [...airports.values()].slice(0, 6);
  }

  async _scanFlights(locations, startMs, nowMs) {
    const airports = await this._outbreakAirports(locations);
    if (!airports.length) {
      this._log(
        'FLIGHTS',
        'No airport with scheduled flights within 60 km of the outbreak.',
      );
      return { flights: [], source: 'no airport near' };
    }
    this._log(
      'AIRPORTS',
      airports
        .map((a) => `${a.code} ${a.iata || ''} ${a.name} · ${a.km} km`)
        .join('\n'),
    );
    const { response, data } = await this._getJson(
      `${API}/flights?airports=${airports.map((a) => a.code).join(',')}&begin=${Math.floor(startMs / 1000)}&end=${Math.floor(nowMs / 1000)}`,
    );
    if (response.ok && Array.isArray(data?.flights)) {
      const flights = data.flights.map((f) => cleanFlight(f)).filter(Boolean);
      this._log(
        'FLIGHT HISTORY · OPENSKY',
        flights.length
          ? flights
              .map(
                (f) =>
                  `${f.hop === 2 ? '  connecting ' : ''}${f.from.code} → ${f.to.code} ${f.to.name} · ${f.callsign || '—'} · left ${timeLabel(f.departMs)} · landed ${timeLabel(f.arriveMs)}`,
              )
              .join('\n')
          : 'No flight left these airports in the scan window.',
      );
      if (flights.length) return { flights, source: 'OpenSky flight history' };
    } else {
      this._log('FLIGHT HISTORY', data?.error || `HTTP ${response.status}`);
    }
    if (!this._model?.value) {
      this._log(
        'FLIGHTS',
        'No language model key either: no flights are drawn. Add one in POWER UP.',
      );
      return { flights: [], source: 'none (no OpenSky account or model key)' };
    }
    return this._scheduleFlights(airports, locations[0], startMs);
  }

  /** Airline schedules from the chosen model, read from a list of real airports. */
  async _scheduleFlights(airports, near, startMs) {
    this._say('SCANNING · airline schedules with the language model…');
    const { response, data } = await this._getJson(
      `${API}/airports/candidates?lat=${near.lat}&lon=${near.lon}`,
    );
    if (!response.ok)
      throw new Error(data?.error || `Airports: HTTP ${response.status}`);
    const candidates = data?.airports || [];
    const byCode = new Map(candidates.map((a) => [a.code, a]));
    for (const a of airports) byCode.set(a.code, a);
    const context = {
      outbreakRoutes: {
        origins: airports.map(candidateLine),
        candidates: candidates.map(candidateLine),
      },
    };
    const origins = new Set(airports.map((a) => a.code));
    const firstAnswer = await this._ask(
      outbreakRoutesQuestion(airports),
      context,
    );
    const first = parseRouteLines(firstAnswer).filter(
      (r) => origins.has(r.from) && byCode.has(r.to) && !origins.has(r.to),
    );
    const destinations = [...new Set(first.map((r) => r.to))]
      .map((code) => byCode.get(code))
      .slice(0, CONNECTING_AIRPORTS_MAX);
    let onward = [];
    if (destinations.length) {
      this._say('SCANNING · connecting flights with the language model…');
      try {
        const answer = await this._ask(
          outbreakRoutesQuestion(destinations, { connecting: true }),
          context,
        );
        const from = new Set(destinations.map((a) => a.code));
        onward = parseRouteLines(answer).filter(
          (r) => from.has(r.from) && byCode.has(r.to) && !origins.has(r.to),
        );
      } catch (error) {
        this._log('CONNECTING FLIGHTS', error.message);
      }
    }
    const routes = [
      ...first.map((r) => ({
        from: byCode.get(r.from),
        to: byCode.get(r.to),
        hop: 1,
      })),
      ...onward.map((r) => ({
        from: byCode.get(r.from),
        to: byCode.get(r.to),
        hop: 2,
      })),
    ];
    const flights = timeScheduleRoutes(
      routes,
      startMs,
      'Airline schedule (LLM)',
    );
    this._log(
      'AIRLINE SCHEDULES · LLM',
      flights.length
        ? `${flights.length} routes; times assumed: first flights leave at the scan's start, connections ${CONNECTION_HOURS} h after landing.\n${flights
            .map(
              (f) =>
                `${f.hop === 2 ? '  connecting ' : ''}${f.from.code} → ${f.to.code} ${f.to.name}`,
            )
            .join('\n')}`
        : 'The model named no route.',
    );
    return { flights, source: 'airline schedules (language model)' };
  }

  /** SCAN TRAVEL ends over the outbreak, with the region round it in view. */
  async _flyToOutbreak() {
    const target = outbreakViewTarget(this._state.locations);
    const camera = this.viewer?.camera;
    if (!target || typeof camera?.flyTo !== 'function') return;
    if (this.viewer.isDestroyed?.()) return;
    try {
      const Cesium = await import('cesium');
      // A camera following something would pull the view straight back.
      if (this.viewer.trackedEntity) this.viewer.trackedEntity = undefined;
      camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          target.lon,
          target.lat,
          target.heightM,
        ),
        orientation: {
          heading: 0,
          pitch: -Math.PI / 2,
          roll: 0,
        },
        duration: 3,
      });
    } catch {
      /* The scene is not ready: the spread is drawn all the same. */
    }
  }

  /* --------------------------------------------------------------------- */
  /* Time                                                                   */
  /* --------------------------------------------------------------------- */

  _togglePlay() {
    if (this._playTimer !== null) {
      this._stopPlay();
      return;
    }
    const last = presentHour(this._startMs(), this._now());
    let hour = 1;
    if (this._playBtn) this._playBtn.textContent = 'STOP';
    const step = () => {
      this._state.hour = hour >= last ? null : hour;
      this._refresh({ send: true });
      if (hour >= last) {
        this._stopPlay();
        return;
      }
      hour += 1;
      this._playTimer = globalThis.setTimeout(step, PLAY_STEP_MS);
    };
    this._playTimer = 0;
    step();
  }

  _stopPlay() {
    if (this._playTimer) globalThis.clearTimeout(this._playTimer);
    this._playTimer = null;
    if (this._playBtn) this._playBtn.textContent = 'PLAY';
  }

  /* --------------------------------------------------------------------- */
  /* Searches                                                               */
  /* --------------------------------------------------------------------- */

  /**
   * FUTURE SPREAD LOCATIONS: a new global news search, then two requests to
   * the chosen model: where it is most likely to be reported within 24 h,
   * then (told those) where in the 24 h after. Each place named is placed by
   * its airport, else by name, and drawn on the map.
   */
  async _futureSpread() {
    if (this._busy) {
      this._say(`Still working: ${this._busy}.`);
      return;
    }
    const locations = this._state.locations;
    if (!locations.length) {
      this._say('Add an outbreak location first.');
      return;
    }
    if (!this._model?.value) {
      this._say('No model key yet. Add one in POWER UP.');
      return;
    }
    this._stopPlay();
    this._setBusy('the future spread');
    try {
      this._say('FUTURE SPREAD · new global news search…');
      const params = new URLSearchParams({
        places: locations.map((l) => l.name).join(';'),
        keywords: this._state.keywords,
      });
      const news = await this._getJson(`${API}/news?${params}`);
      const articles = news.response.ok ? news.data?.articles || [] : [];
      this._log(
        'FUTURE SPREAD · GLOBAL NEWS',
        news.response.ok
          ? `${articles.length} article${articles.length === 1 ? '' : 's'} in the last 7 days`
          : news.data?.error ||
              'The news search did not answer; the forecast uses the scan alone.',
      );
      const near = locations[0];
      const pool = await this._getJson(
        `${API}/airports/candidates?lat=${near.lat}&lon=${near.lon}`,
      );
      if (!pool.response.ok)
        throw new Error(pool.data?.error || 'The airport list did not load.');
      const candidates = pool.data?.airports || [];
      const byCode = new Map();
      for (const a of candidates) {
        byCode.set(a.code, a);
        if (a.iata) byCode.set(a.iata, a);
      }
      // The reach at the present hour, whatever hour the menu shows.
      const startMs = this._startMs();
      const spread = outbreakSpread({
        locations,
        flights: this._state.scan?.flights || [],
        speeds: this._state.speeds,
        surroundings: this._state.scan?.surroundings || {},
        startMs,
        hour: presentHour(startMs, this._now()),
      });
      const forecast = [];
      let within24 = [];
      for (const within of OUTBREAK_FORECAST_WINDOWS) {
        this._say(`FUTURE SPREAD · asking the model: within ${within} h…`);
        const answer = await this._ask(
          outbreakForecastQuestion(within, this._state.keywords),
          outbreakForecastScene({
            locations,
            spread,
            speeds: this._state.speeds,
            flights: this._state.scan?.flights || [],
            candidates,
            articles,
            within24,
          }),
        );
        this._log(`FUTURE SPREAD · WITHIN ${within} H · LLM`, answer);
        const rows = parseForecastLines(answer, within, [
          ...locations,
          ...forecast.map((f) => ({ name: f.name })),
        ]);
        if (within === 24) within24 = rows;
        for (const row of rows) {
          const placed = await this._placeForecast(row, byCode);
          if (placed) forecast.push(placed);
        }
      }
      this._state.forecast = forecast;
      this._renderForecast();
      this._state.show = true;
      if (this._showBox) this._showBox.checked = true;
      this._refresh();
      this._send({ show: true });
      const soon = forecast.filter((f) => f.within === 24).length;
      this._say(
        `FUTURE SPREAD DONE · ${soon} within 24 h · ${forecast.length - soon} within 48 h`,
      );
    } catch (error) {
      this._say(error?.message || 'The future spread failed.');
    } finally {
      this._setBusy('');
    }
  }

  /** A forecast place on the map: by its airport, else by its name. */
  async _placeForecast(row, byCode) {
    const airport = row.code ? byCode.get(row.code) : null;
    let lat = airport?.lat;
    let lon = airport?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      try {
        const place = await this._geocode(row.place);
        lat = place?.lat;
        lon = place?.lng;
      } catch {
        lat = undefined;
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      this._log(
        'FUTURE SPREAD',
        `${row.place} could not be placed on the map.`,
      );
      return null;
    }
    return {
      name: row.place,
      lat,
      lon,
      within: row.within,
      likelihood: row.likelihood,
      reason: row.reason,
    };
  }

  _keepFound(rows, via) {
    const known = new Set(this._state.found.map((r) => r.place.toLowerCase()));
    let added = 0;
    for (const row of rows) {
      if (known.has(row.place.toLowerCase())) continue;
      known.add(row.place.toLowerCase());
      this._state.found.push({ ...row, via });
      added += 1;
    }
    this._state.found = this._state.found.slice(-30);
    this._renderFound();
    this._save();
    return added;
  }

  async _mediaSearch() {
    if (this._busy) {
      this._say(`Still working: ${this._busy}.`);
      return;
    }
    const locations = this._state.locations;
    if (!locations.length) {
      this._say('Add an outbreak location first.');
      return;
    }
    this._setBusy('the media search');
    try {
      this._say('MEDIA SEARCH · global news…');
      const params = new URLSearchParams({
        places: locations.map((l) => l.name).join(';'),
        keywords: this._state.keywords,
      });
      const { response, data } = await this._getJson(`${API}/news?${params}`);
      if (!response.ok)
        throw new Error(data?.error || `HTTP ${response.status}`);
      const articles = data?.articles || [];
      this._log(
        'GLOBAL MEDIA · GDELT',
        articles.length
          ? articles
              .slice(0, 25)
              .map((a) => `${a.title} · ${a.domain} · ${a.url}`)
              .join('\n')
          : 'No article in the last 7 days.',
      );
      if (!articles.length) {
        this._say('MEDIA SEARCH DONE · no article in the last 7 days');
        return;
      }
      this._say('MEDIA SEARCH · the language model is reading the articles…');
      const answer = await this._ask(
        outbreakMediaQuestion(locations, this._state.keywords),
        {
          outbreakNews: articles.slice(0, 60),
        },
      );
      this._log('NEW LOCATIONS · LLM', answer);
      const added = this._keepFound(
        parsePlaceLines(answer, locations),
        'Media',
      );
      this._say(
        `MEDIA SEARCH DONE · ${added} new location${added === 1 ? '' : 's'} found`,
      );
    } catch (error) {
      this._say(error?.message || 'The media search failed.');
    } finally {
      this._setBusy('');
    }
  }

  async _socialSearch() {
    if (this._busy) {
      this._say(`Still working: ${this._busy}.`);
      return;
    }
    const locations = this._state.locations;
    if (!locations.length) {
      this._say('Add an outbreak location first.');
      return;
    }
    const providerId = this._swarm?.value === 'openai' ? 'openai' : 'xai';
    const provider = SOCIAL_SWARM_PROVIDERS[providerId];
    const instructions = outbreakSocialInstructions(
      locations,
      this._state.keywords,
    );
    const place = locations[0];
    this._setBusy('the social media search');
    let back = 0;
    let found = 0;
    let unconfigured = '';
    const total = SOCIAL_SWARM_BOTS.length;
    this._say(`SOCIAL SEARCH · ${provider.title} · ${total} BOTS`);
    try {
      await Promise.all(
        SOCIAL_SWARM_BOTS.map(async (bot) => {
          const controller = new AbortController();
          const timer = globalThis.setTimeout(
            () => controller.abort(),
            SWARM_BOT_TIMEOUT_MS + CLIENT_TIMEOUT_MARGIN_MS,
          );
          try {
            const response = await this._request(SWARM_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                provider: providerId,
                bot: bot.id,
                instructions,
                place: place.name,
                latitude: place.lat,
                longitude: place.lon,
              }),
              signal: controller.signal,
            });
            const data = await response.json().catch(() => null);
            if (response.status === 501 || data?.unconfigured) {
              unconfigured =
                data?.error ||
                `No ${provider.keyTitle} key yet. Add it in POWER UP → ${provider.keyTitle}.`;
              return;
            }
            if (!response.ok || !data?.ok)
              throw new Error(data?.error || `HTTP ${response.status}`);
            this._log(`${provider.title} · ${bot.label}`, data.text);
            found += this._keepFound(
              parsePlaceLines(data.text, locations),
              bot.label,
            );
          } catch (error) {
            this._log(
              `${provider.title} · ${bot.label}`,
              `BOT FAILED: ${error?.name === 'AbortError' ? 'no answer in time' : error?.message || 'request failed'}`,
            );
          } finally {
            globalThis.clearTimeout(timer);
            back += 1;
            if (!unconfigured)
              this._say(`SOCIAL SEARCH · ${back}/${total} BACK`);
          }
        }),
      );
      this._say(
        unconfigured ||
          `SOCIAL SEARCH DONE · ${found} new location${found === 1 ? '' : 's'} found`,
      );
    } finally {
      this._setBusy('');
    }
  }
}
