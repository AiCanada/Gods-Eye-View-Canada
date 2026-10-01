import { formatAskLogEntry, prependOutputLog } from './askOverview.js';
import { closestCityForSearch, selectedPlaceLabel } from './locations.js';
import {
  SOCIAL_ACCOUNT_PLATFORMS,
  SOCIAL_LOCATION_OPTIONS,
  acceptDeviceFix,
  formatSocialSearchBody,
  liveLocationLabel,
  locationSharingAccounts,
  normalizePublicNewsReport,
  normalizeSocialHandle,
  officialOpenUrl,
  cleanPlace,
  planSocialRequest,
  readShowLocation,
  readSocialAccounts,
  removeSocialAccount,
  saveSocialAccount,
  socialPublicNewsPath,
  writeShowLocation,
} from './socialMedia.js';
import {
  SOCIAL_SWARM_BOTS,
  SOCIAL_SWARM_PROVIDERS,
  formatSwarmBotLog,
  planSwarmHandoff,
  swarmBotFoundNothing,
} from './socialSwarm.mjs';

/** One marker for this device. The camera stays where the operator left it. */
export const SOCIAL_LOCATION_FIX_ID = 'social-location-fix';

const PROVIDERS_URL = '/api/llm/providers';
const ASK_URL = '/api/llm/ask';
const ACCOUNTS_URL = '/api/social/accounts';
const SWARM_URL = '/api/social/swarm';
const SWARM_STATUS_URL = '/api/social/swarm/status';
const CHIEF_OF_STAFF_URL = '/api/social/swarm/chief-of-staff';
const NEAREST_CITY_URL = '/api/social/swarm/nearest-city';
/** The server asks Nominatim for up to 8 s; the box waits a little longer. */
const NEAREST_CITY_WAIT_MS = 25000;
const GROK_BOT_OPEN_URL = '/api/social/grok-bot/open';
const CLIENT_TIMEOUT_MARGIN_MS = 10000;
const DEFAULT_ASK_TIMEOUT_MS = 240000;
/** The server gives a bot 150 s; the box waits a little longer for its answer. */
const SWARM_BOT_TIMEOUT_MS = 150000;

/**
 * Social Media Analysis. One note, three menus, and the same Ask route the
 * other model buttons use. Analyze, Breaking News, and Search look up public
 * news for the map place first. A press is the only time a model is contacted.
 * A hooked-up account that shares the operator's own location draws this
 * device's live position.
 */
export class SocialMediaPanel {
  /**
   * @param {object} viewer
   * @param {{sceneContext?: Function, storage?: Storage, fetch?: Function, openWindow?: Function, document?: Document, geolocation?: Geolocation | null, placeFix?: Function, clearFix?: Function, clipboard?: {writeText: Function} | null}} [options]
   */
  constructor(viewer, options = {}) {
    this.viewer = viewer;
    this._sceneContext = typeof options.sceneContext === 'function' ? options.sceneContext : null;
    this._storage = options.storage || null;
    this._fetch = options.fetch || null;
    this._openWindow = options.openWindow || null;
    this._clipboard =
      options.clipboard !== undefined ? options.clipboard : globalThis.navigator?.clipboard || null;
    this._geolocation =
      options.geolocation !== undefined ? options.geolocation : globalThis.navigator?.geolocation || null;
    this._placeFix = options.placeFix || placeSocialFix;
    this._clearFix = options.clearFix || clearSocialFix;
    this._askTimeoutMs = DEFAULT_ASK_TIMEOUT_MS;
    this._inFlight = null;
    this._saving = false;
    this._vault = [];
    this._entries = 0;
    this._watchId = null;
    this._watching = false;
    this._fix = null;
    this._markerLive = false;
    this._swarms = {};

    const doc = options.document || globalThis.document;
    this._doc = doc || null;
    this._panel = doc?.getElementById?.('social-panel') || null;
    if (!this._panel || !doc) return;

    this._accountPlatform = doc.getElementById('social-account-platform');
    this._handle = doc.getElementById('social-account-handle');
    this._password = doc.getElementById('social-account-password');
    this._accountList = doc.getElementById('social-account-list');
    this._query = doc.getElementById('social-query');
    this._model = doc.getElementById('social-model');
    this._analysisPlatform = doc.getElementById('social-analyze-platform');
    this._newsPlatform = doc.getElementById('social-news-platform');
    this._helpPlatform = doc.getElementById('social-help-platform');
    this._status = doc.getElementById('social-status');
    this._output = doc.getElementById('social-output');
    this._showLocation = doc.getElementById('social-show-location');
    this._locationNote = doc.getElementById('social-location-note');
    if (this._showLocation) {
      this._showLocation.checked = readShowLocation(this._browserStorage());
      this._showLocation.addEventListener('change', () => {
        try {
          writeShowLocation(this._browserStorage(), this._showLocation.checked === true);
        } catch {
          // The choice still applies until this page closes.
        }
        this._syncLiveLocation();
      });
    }
    this._actions = {
      analyze: doc.getElementById('social-analyze'),
      news: doc.getElementById('social-news'),
      search: doc.getElementById('social-search'),
      help: doc.getElementById('social-help'),
      save: doc.getElementById('social-account-save'),
    };

    this._actions.save?.addEventListener('click', () => {
      void this._saveAccount();
    });
    doc.getElementById('social-account-open')?.addEventListener('click', () => {
      this._open(this._accountPlatform?.value);
    });
    this._accountPlatform?.addEventListener('change', () => this._showSavedUserId());
    const saveOnEnter = (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void this._saveAccount();
    };
    this._handle?.addEventListener('keydown', saveOnEnter);
    this._password?.addEventListener('keydown', saveOnEnter);
    this._query?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      void this._run('search');
    });
    this._actions.analyze?.addEventListener('click', () => void this._run('analyze'));
    this._actions.news?.addEventListener('click', () => void this._run('news'));
    this._actions.search?.addEventListener('click', () => void this._run('search'));
    this._actions.help?.addEventListener('click', () => void this._run('help'));
    // GROK BOT SWARM and OPENAI BOT SWARM: the instructions, and the button
    // that sends one bot per platform at once on that swarm's own key.
    for (const provider of Object.values(SOCIAL_SWARM_PROVIDERS)) {
      const prefix = `social-swarm-${provider.id}`;
      const swarm = {
        provider,
        instructions: doc.getElementById(`${prefix}-instructions`),
        run: doc.getElementById(`${prefix}-run`),
        status: doc.getElementById(`${prefix}-status`),
        running: false,
      };
      if (!swarm.run) continue;
      this._swarms[provider.id] = swarm;
      swarm.label = swarm.run.textContent;
      swarm.run.addEventListener('click', () => void this._runSwarm(swarm));
      doc.getElementById(`${prefix}-open`)?.addEventListener('click', () => {
        // OPEN GROK BOT opens the desktop app on this computer; OPEN CHATGPT
        // opens ChatGPT, where the dots live.
        if (provider.desktop) {
          void this._openGrokBot().then((result) => {
            this._setSwarmStatus(swarm, result.ok ? 'GROK BOT OPENED' : result.error);
          });
          return;
        }
        const open = this._openWindow || globalThis.open;
        if (provider.openUrl) open?.(provider.openUrl, '_blank', 'noopener,noreferrer');
      });
    }

    this._renderAccounts();
    void this._loadVault();
    void this._loadModels();
  }

  _browserStorage() {
    if (this._storage) return this._storage;
    try {
      return globalThis.localStorage;
    } catch {
      return null;
    }
  }

  _setStatus(text) {
    if (this._status) this._status.textContent = text || '';
  }

  _setLocationNote(text) {
    if (this._locationNote) this._locationNote.textContent = text || '';
  }

  _syncLiveLocation() {
    const sharing = locationSharingAccounts(this._vault);
    const show = this._showLocation
      ? this._showLocation.checked === true
      : readShowLocation(this._browserStorage());
    if (!show || sharing.length === 0) {
      this._stopLiveLocation();
      return;
    }
    this._startLiveLocation();
    if (this._fix) this._queueFix();
  }

  _startLiveLocation() {
    if (this._watching) return;
    const geo = this._geolocation;
    if (!geo?.watchPosition) {
      this._setLocationNote('This browser did not share a location.');
      return;
    }
    this._setLocationNote("Waiting for this device's location.");
    this._watching = true;
    try {
      this._watchId = geo.watchPosition(
        (position) => {
          if (!this._watching) return;
          const fix = acceptDeviceFix(position);
          if (!fix) return;
          this._fix = fix;
          this._queueFix();
        },
        () => {
          if (!this._watching) return;
          this._setLocationNote('This browser did not share a location.');
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
      );
    } catch {
      this._watching = false;
      this._watchId = null;
      this._setLocationNote('This browser did not share a location.');
    }
  }

  _stopLiveLocation() {
    const wasWatching = this._watching;
    if (this._watching) {
      this._watching = false;
      const watchId = this._watchId;
      this._watchId = null;
      if (watchId != null) {
        try {
          this._geolocation?.clearWatch?.(watchId);
        } catch {
          // The browser already dropped the watch.
        }
      }
    }
    this._fix = null;
    const hadMarker = this._markerLive;
    if (hadMarker) {
      this._markerLive = false;
      void this._clearFix(this.viewer);
    }
    if (wasWatching || hadMarker) {
      const hidden = this._showLocation
        ? this._showLocation.checked !== true
        : !readShowLocation(this._browserStorage());
      this._setLocationNote(
        hidden
          ? 'Live position is hidden.'
          : 'A hooked-up account that shares location displays live position on the map.',
      );
    }
  }

  _queueFix() {
    const token = (this._drawToken || 0) + 1;
    this._drawToken = token;
    const run = this._drawQueue || Promise.resolve();
    this._drawQueue = run.then(() => this._applyFix(token)).catch(() => {});
  }

  async _applyFix(token) {
    if (token !== this._drawToken) return;
    const show = !this._showLocation || this._showLocation.checked === true;
    const sharing = locationSharingAccounts(this._vault).length > 0;
    if (!this._watching || !this._fix || !show || !sharing) {
      if (token !== this._drawToken) return;
      this._markerLive = false;
      await this._clearFix(this.viewer);
      return;
    }
    const fix = this._fix;
    const label = liveLocationLabel(this._vault);
    try {
      await this._placeFix(this.viewer, fix, label);
    } catch {
      if (token !== this._drawToken || !this._watching) return;
      this._setLocationNote('The map did not take that position.');
      return;
    }
    if (token !== this._drawToken || !this._watching) {
      if (!this._watching && token === this._drawToken) {
        this._markerLive = false;
        await this._clearFix(this.viewer);
      }
      return;
    }
    this._markerLive = true;
    this._setLocationNote('Your live position is on the map.');
  }

  _setBusy(busy) {
    for (const button of Object.values(this._actions)) {
      if (button) button.disabled = busy;
    }
  }

  _accountRows() {
    const storage = this._browserStorage();
    const local = storage ? readSocialAccounts(storage) : [];
    const rows = [];
    const seen = new Set();
    for (const row of this._vault) {
      const platform = SOCIAL_ACCOUNT_PLATFORMS.find((entry) => entry.id === row.platform);
      if (!platform || seen.has(platform.id) || typeof row.userId !== 'string') continue;
      seen.add(platform.id);
      rows.push({
        platform: platform.id,
        label: platform.label,
        userId: row.userId,
        passwordSaved: row.passwordSaved === true,
        vault: true,
      });
    }
    for (const row of local) {
      if (seen.has(row.platform)) continue;
      const platform = SOCIAL_ACCOUNT_PLATFORMS.find((entry) => entry.id === row.platform);
      if (!platform) continue;
      rows.push({
        platform: platform.id,
        label: platform.label,
        userId: row.handle,
        passwordSaved: false,
        vault: false,
      });
    }
    return rows;
  }

  _renderAccounts() {
    const list = this._accountList;
    const doc = this._doc;
    if (!list || !doc) return;
    list.replaceChildren();
    const rows = this._accountRows();
    if (rows.length === 0) {
      const empty = doc.createElement('li');
      empty.className = 'social-note';
      empty.textContent = 'No account saved yet.';
      list.append(empty);
      return;
    }
    for (const row of rows) {
      const item = doc.createElement('li');
      const name = doc.createElement('span');
      name.textContent = row.vault
        ? `${row.label} · ${row.userId}${row.passwordSaved ? ' · password saved' : ''}`
        : `${row.label} · @${row.userId}`;
      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'scene-btn';
      remove.textContent = 'REMOVE';
      remove.addEventListener('click', () => {
        void this._removeAccount(row);
      });
      item.append(name, remove);
      list.append(item);
    }
  }


  _setSwarmStatus(swarm, text) {
    if (swarm.status) swarm.status.textContent = text;
  }

  /**
   * A press. Each swarm runs on its own key (POWER UP → GROK BOT, OPENAI
   * DOTS). Without one, Grok's task goes to the Chief of Staff bot in Grok
   * Bot, and OpenAI's swarm says where its key goes. When the server cannot
   * say which keys are in, the bots are sent and each answers for itself.
   */
  async _runSwarm(swarm) {
    if (swarm.running) {
      this._setSwarmStatus(swarm, 'The swarm is still out.');
      return;
    }
    swarm.running = true;
    // Said on the press itself, before the map place is looked up.
    const total = SOCIAL_SWARM_BOTS.length;
    swarm.run.disabled = true;
    swarm.run.textContent = 'SPINNING UP SWARM…';
    this._setSwarmStatus(swarm, `SPINNING UP SWARM · ${total} BOTS`);
    const instructions = swarm.instructions?.value ?? '';
    try {
      const [context, keys] = await Promise.all([this._context(), this._swarmStatus()]);
      const view = this._openView();
      const place = context?.selectedLocation || context?.locality || view.place || '';
      const own = keys?.[swarm.provider.id];
      if (own && own.key === false) {
        if (swarm.provider.id === 'xai') {
          await this._handOffToChiefOfStaff(swarm, {
            instructions,
            place,
            view,
            webhook: own.chiefOfStaff === true,
          });
        } else {
          this._setSwarmStatus(
            swarm,
            `No ${swarm.provider.keyTitle} key yet. Add it in POWER UP → ${swarm.provider.keyTitle}.`,
          );
        }
        return;
      }
      await this._sendSwarmBots(swarm, { instructions, place, view });
    } finally {
      swarm.running = false;
      swarm.run.disabled = false;
      swarm.run.textContent = swarm.label;
    }
  }

  /** Which swarms have their own key, and Grok's Chief of Staff webhook; null when unknown. */
  async _swarmStatus() {
    try {
      const response = await this._request(SWARM_STATUS_URL, { headers: { Accept: 'application/json' } });
      if (!response?.ok) return null;
      const data = await response.json().catch(() => null);
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  /**
   * GROK BOT SWARM with no Grok Bot key: the same sweep, as one task, for
   * the Chief of Staff bot in Grok Bot, which runs it or hands platforms to
   * its bots. With its webhook in POWER UP the task is sent there; otherwise
   * Grok Bot is opened (GROK_BOT_LINK, else its own link) with the task
   * copied to paste. The task is also kept in the log.
   */
  async _handOffToChiefOfStaff(swarm, { instructions, place, view, webhook }) {
    const title = swarm.provider.title;
    this._setSwarmStatus(swarm, 'FINDING THE NEAREST CITY…');
    const nearestCity = await this._nearestCity(view);
    const plan = planSwarmHandoff({
      instructions,
      place,
      nearestCity,
      latitude: view.latitude,
      longitude: view.longitude,
    });
    if (!plan.ok) {
      this._setSwarmStatus(swarm, plan.error);
      return;
    }
    const time = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (webhook) {
      this._setSwarmStatus(swarm, 'SENDING THE TASK TO CHIEF OF STAFF…');
      let response = null;
      let data = null;
      try {
        response = await this._request(CHIEF_OF_STAFF_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instructions, place, nearestCity, latitude: view.latitude, longitude: view.longitude }),
        });
        data = await response.json().catch(() => null);
      } catch {
        response = null;
      }
      if (!response?.ok || !data?.ok) {
        this._setSwarmStatus(swarm, String(data?.error || 'The task did not reach Grok Bot.'));
        return;
      }
      this._prepend(
        formatAskLogEntry(
          `${title} · CHIEF OF STAFF`,
          `Sent to your Chief of Staff bot's webhook routine in Grok Bot. Its report comes back in Grok Bot.\n\n${plan.text}`,
          { locationName: place },
        ),
      );
      this._setSwarmStatus(swarm, `SENT TO CHIEF OF STAFF ${time()} · ITS REPORT COMES BACK IN GROK BOT`);
      return;
    }
    const copied = await this._copyText(plan.text);
    const opened = await this._openGrokBot();
    this._prepend(
      formatAskLogEntry(
        `${title} · CHIEF OF STAFF`,
        `${copied ? 'Copied for' : 'For'} your Chief of Staff bot in Grok Bot:\n\n${plan.text}`,
        { locationName: place },
      ),
    );
    const where = opened.ok ? 'GROK BOT OPENED' : opened.error;
    this._setSwarmStatus(
      swarm,
      copied
        ? `${where} · TASK COPIED · PASTE IT TO YOUR CHIEF OF STAFF BOT`
        : `${where} · COPY THE TASK FROM THE LOG TO YOUR CHIEF OF STAFF BOT`,
    );
  }

  /**
   * The nearest city to the map point: the town it is in, from the server's
   * reverse lookup; else the nearest city in the built-in gazetteer within
   * 150 km (the same one the Ask panel searches by), with its distance, for
   * a point at sea or in the woods; else '' and the task asks the bot.
   */
  async _nearestCity(view) {
    const found = await this._nearestCityFromServer(view);
    if (found) return found;
    const known = closestCityForSearch(view?.latitude, view?.longitude);
    if (!known?.name) return '';
    const km = Math.round(known.distKm);
    return km >= 2 ? `${known.name} (about ${km} km away)` : known.name;
  }

  /** The town the map point is in, from the server's reverse lookup, or ''. */
  async _nearestCityFromServer(view) {
    const latitude = Number(view?.latitude);
    const longitude = Number(view?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), NEAREST_CITY_WAIT_MS);
    try {
      const response = await this._request(
        `${NEAREST_CITY_URL}?lat=${latitude.toFixed(4)}&lon=${longitude.toFixed(4)}`,
        { headers: { Accept: 'application/json' }, signal: controller.signal },
      );
      if (!response?.ok) return '';
      const data = await response.json().catch(() => null);
      return typeof data?.city === 'string' ? data.city : '';
    } catch {
      return '';
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  /** Open the Grok Bot desktop app on this computer: { ok } or { ok: false, error }. */
  async _openGrokBot() {
    const failed = 'Grok Bot could not be opened.';
    try {
      const response = await this._request(GROK_BOT_OPEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.ok) return { ok: true };
      return { ok: false, error: String(data?.error || failed) };
    } catch {
      return { ok: false, error: failed };
    }
  }

  /** Put text on the clipboard; false when this browser will not. */
  async _copyText(text) {
    const clipboard = this._clipboard;
    if (typeof clipboard?.writeText !== 'function') return false;
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One bot per platform, all sent at once. Each comes back on its own: its
   * list goes into the log as it lands, and the status line counts them in.
   */
  async _sendSwarmBots(swarm, { instructions, place, view }) {
    const total = SOCIAL_SWARM_BOTS.length;
    const title = swarm.provider.title;
    this._setSwarmStatus(swarm, `SPINNING UP SWARM · ${total} BOTS · ${place || 'this map view'}`);
    let back = 0;
    let found = 0;
    let empty = 0;
    let failed = 0;
    let unconfigured = '';
    const sendBot = async (bot) => {
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
            provider: swarm.provider.id,
            bot: bot.id,
            instructions,
            place,
            latitude: view.latitude,
            longitude: view.longitude,
          }),
          signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        if (response.status === 501 || data?.unconfigured) {
          unconfigured = String(
            data?.error || `No ${swarm.provider.keyTitle} key yet. Add it in POWER UP → ${swarm.provider.keyTitle}.`,
          );
          return;
        }
        if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        if (swarmBotFoundNothing(data.text)) empty += 1;
        else found += 1;
        this._prepend(formatAskLogEntry(`${title} · ${bot.label}`, formatSwarmBotLog(data), { locationName: place }));
      } catch (error) {
        failed += 1;
        const reason = error?.name === 'AbortError' ? 'no answer in time' : error?.message || 'request failed';
        this._prepend(formatAskLogEntry(`${title} · ${bot.label}`, `BOT FAILED: ${reason}`, { locationName: place }));
      } finally {
        globalThis.clearTimeout(timer);
        back += 1;
        if (!unconfigured) this._setSwarmStatus(swarm, `SWARM OUT · ${back}/${total} BACK`);
      }
    };
    await Promise.all(SOCIAL_SWARM_BOTS.map(sendBot));
    if (unconfigured) {
      this._setSwarmStatus(swarm, unconfigured);
      return;
    }
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this._setSwarmStatus(
      swarm,
      `SWARM DONE ${time} · ${found} with reports · ${empty} found nothing${failed ? ` · ${failed} failed` : ''}`,
    );
  }

  _showSavedUserId() {
    const row = this._vault.find((item) => item.platform === this._accountPlatform?.value);
    if (this._handle) this._handle.value = row?.userId || '';
    if (this._password) this._password.value = '';
  }

  _publicAccounts() {
    const storage = this._browserStorage();
    const accounts = storage ? readSocialAccounts(storage) : [];
    for (const row of this._vault) {
      const handle = normalizeSocialHandle(row.userId);
      if (!handle.ok) continue;
      const next = { platform: row.platform, handle: handle.handle };
      const index = accounts.findIndex((item) => item.platform === row.platform);
      if (index >= 0) accounts[index] = next;
      else accounts.push(next);
    }
    return accounts;
  }

  async _loadVault() {
    try {
      const response = await this._request(ACCOUNTS_URL);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) return;
      if (data.locked) {
        this._vault = [];
        this._setStatus('The encrypted store on this computer could not be opened.');
        this._syncLiveLocation();
        return;
      }
      if (!Array.isArray(data.accounts)) return;
      this._vault = [];
      for (const row of data.accounts) {
        if (!row || typeof row.platform !== 'string' || typeof row.userId !== 'string') continue;
        this._vault.push({
          platform: row.platform,
          userId: row.userId,
          passwordSaved: row.passwordSaved === true,
        });
      }
      this._renderAccounts();
      this._syncLiveLocation();
    } catch {
      // Public handles already on this browser stay.
    }
  }

  _saveHandle() {
    const storage = this._browserStorage();
    if (!storage) {
      this._setStatus('This browser is not keeping handles.');
      return;
    }
    let saved;
    try {
      saved = saveSocialAccount(
        storage,
        this._accountPlatform?.value,
        this._handle?.value,
      );
    } catch {
      this._setStatus('This browser is not keeping handles.');
      return;
    }
    if (!saved.ok) {
      this._setStatus(saved.error);
      return;
    }
    if (this._handle) this._handle.value = '';
    this._renderAccounts();
    this._setStatus('Saved that public handle on this computer.');
  }

  async _saveAccount() {
    const password = this._password?.value ?? '';
    if (!password) {
      this._saveHandle();
      return;
    }
    if (this._saving) return;
    this._saving = true;
    const platform = this._accountPlatform?.value;
    const userId = this._handle?.value ?? '';
    try {
      let response;
      try {
        response = await this._request(ACCOUNTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform, userId, password }),
        });
      } catch {
        this._setStatus('This computer did not keep that login.');
        return;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || typeof data.userId !== 'string') {
        const error = String(data?.error || 'This computer did not keep that login.');
        this._setStatus(error.includes(password) ? 'This computer did not keep that login.' : error);
        return;
      }
      const handle = normalizeSocialHandle(data.userId);
      if (handle.ok) {
        const storage = this._browserStorage();
        if (storage) {
          try {
            saveSocialAccount(storage, platform, handle.handle);
          } catch {
            // The encrypted login is already stored.
          }
        }
      }
      this._vault = this._vault.filter((row) => row.platform !== platform);
      this._vault.push({ platform, userId: data.userId, passwordSaved: true });
      if (this._password) this._password.value = '';
      if (this._handle) this._handle.value = '';
      this._renderAccounts();
      this._syncLiveLocation();
      this._setStatus('Saved that login encrypted on this computer.');
    } finally {
      this._saving = false;
    }
  }

  async _removeAccount(row) {
    if (row.vault) {
      try {
        const response = await this._request(ACCOUNTS_URL, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: row.platform }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          const error = String(data?.error || 'This computer did not remove that login.');
          this._setStatus(error);
          return;
        }
      } catch {
        this._setStatus('This computer did not remove that login.');
        return;
      }
      this._vault = this._vault.filter((item) => item.platform !== row.platform);
      this._syncLiveLocation();
    }
    const storage = this._browserStorage();
    if (storage) {
      try {
        removeSocialAccount(storage, row.platform);
      } catch {
        this._setStatus('This browser is not keeping handles.');
        return;
      }
    }
    this._renderAccounts();
    this._setStatus(row.vault ? 'Removed that login.' : 'Removed that handle.');
  }

  async _loadModels() {
    const select = this._model;
    if (!select || !this._doc) return;
    let providers = [];
    let reachable = true;
    try {
      const response = await this._request(PROVIDERS_URL);
      const data = await response.json();
      providers = (data?.providers || []).filter((provider) => provider.ready);
      if (Number.isFinite(data?.askTimeoutMs) && data.askTimeoutMs > 0) {
        this._askTimeoutMs = data.askTimeoutMs;
      }
    } catch {
      reachable = false;
    }
    select.replaceChildren();
    if (providers.length === 0) {
      const option = this._doc.createElement('option');
      option.value = '';
      option.textContent = reachable ? 'No model key yet' : 'Model list unavailable';
      select.append(option);
      select.disabled = true;
      select.value = '';
      return;
    }
    select.disabled = false;
    for (const provider of providers) {
      const option = this._doc.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label;
      select.append(option);
    }
    select.value = providers[0].id;
  }

  async _context() {
    try {
      const context = await this._sceneContext?.();
      return context && typeof context === 'object' ? context : {};
    } catch {
      return {};
    }
  }

  _planInput(action, where) {
    return {
      action,
      text: this._query?.value,
      analysisId: this._analysisPlatform?.value,
      newsId: this._newsPlatform?.value,
      helpId: this._helpPlatform?.value,
      accounts: this._publicAccounts(),
      place: where?.place || '',
      latitude: where?.view?.latitude,
      longitude: where?.view?.longitude,
      providerId: this._model?.value,
    };
  }

  /**
   * The place an ANALYZE, BREAKING NEWS, SEARCH or FIND HELP press is about,
   * so none runs without one: the location the operator picked, else the
   * map's own label at the view, else the town at the middle of the map
   * (the swarm's nearest-city route), else the nearest city in the built-in
   * gazetteer, else the map point itself. Empty only while the map has no
   * view at all.
   *
   * @param {object} context The scene context.
   * @param {(text: string) => void} [say] Told while the town is looked up.
   * @returns {Promise<{place: string, view: object}>}
   */
  async _resolvePlace(context, say) {
    const view = this._openView();
    const picked = cleanPlace(context?.selectedLocation || context?.locality || view.place || '');
    if (picked) return { place: picked, view };
    if (!Number.isFinite(view.latitude) || !Number.isFinite(view.longitude)) {
      return { place: '', view };
    }
    say?.('Finding the place at the middle of the map...');
    const town = cleanPlace(await this._nearestCityFromServer(view));
    if (town) return { place: town, view };
    const city = cleanPlace(closestCityForSearch(view.latitude, view.longitude)?.name);
    if (city) return { place: city, view };
    return { place: `${view.latitude.toFixed(4)}, ${view.longitude.toFixed(4)}`, view };
  }

  async _loadPublicNews(planInput, signal) {
    try {
      const response = await this._request(socialPublicNewsPath(planInput), { signal });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) return { status: 'unavailable', articles: [] };
      return normalizePublicNewsReport(data);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return { status: 'unavailable', articles: [] };
    }
  }

  _openView() {
    const view = {};
    const place = selectedPlaceLabel(
      this._doc?.getElementById('location-mini-city')?.textContent,
      this._doc?.getElementById('location-mini-poi')?.textContent,
    );
    if (place) view.place = place;
    const point = this._viewPoint();
    if (point) {
      view.latitude = (point.latitude * 180) / Math.PI;
      view.longitude = (point.longitude * 180) / Math.PI;
    }
    return view;
  }

  /**
   * The map point, in radians: the ground at the middle of the screen, which
   * is what the operator is looking at. A tilted camera can hang far out to
   * sea over a coastal city, so its own position is only the fallback, for a
   * view above the horizon or a scene that is not ready. Null when neither.
   */
  _viewPoint() {
    const viewer = this.viewer;
    const usable = (carto) =>
      carto && Number.isFinite(carto.latitude) && Number.isFinite(carto.longitude) ? carto : null;
    try {
      const canvas = viewer?.scene?.canvas;
      const ellipsoid = viewer?.scene?.globe?.ellipsoid;
      const width = canvas?.clientWidth || canvas?.width || 0;
      const height = canvas?.clientHeight || canvas?.height || 0;
      if (width > 0 && height > 0 && ellipsoid && typeof viewer.camera?.pickEllipsoid === 'function') {
        const ground = viewer.camera.pickEllipsoid({ x: width / 2, y: height / 2 }, ellipsoid);
        const centre = ground ? usable(ellipsoid.cartesianToCartographic(ground)) : null;
        if (centre) return centre;
      }
    } catch {
      // Fall back to the camera itself.
    }
    try {
      return usable(viewer?.camera?.positionCartographic);
    } catch {
      // The camera is not ready. The official site still opens.
      return null;
    }
  }

  _open(id) {
    const url = officialOpenUrl(id, this._openView());
    if (!url) {
      const option = SOCIAL_LOCATION_OPTIONS.find((item) => item.id === id);
      this._setStatus(option?.note || 'Open that app on your phone.');
      return;
    }
    const open = this._openWindow || globalThis.open;
    open?.(url, '_blank', 'noopener,noreferrer');
  }

  _request(url, init) {
    const fetchImpl = this._fetch || globalThis.fetch;
    return fetchImpl(url, init);
  }

  async _run(action) {
    if (this._inFlight) {
      this._setStatus('Still working on the last question.');
      return;
    }
    // Held across the view lookup so a second press cannot send twice.
    this._inFlight = true;
    const context = await this._context();
    const where = await this._resolvePlace(context, (text) => this._setStatus(text));
    const planInput = this._planInput(action, where);
    const plan = planSocialRequest(planInput);
    if (!plan.ok) {
      this._inFlight = null;
      this._setStatus(plan.error);
      return;
    }

    this._setBusy(true);
    let phase = action === 'help' ? plan.kind : 'Looking up public news';
    this._setStatus(`${phase}...`);
    const startedAt = Date.now();
    const ticker = globalThis.setInterval(() => {
      this._setStatus(`${phase}... ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }, 1000);
    const controller = new AbortController();
    this._inFlight = controller;
    const timeout = globalThis.setTimeout(
      () => controller.abort(),
      this._askTimeoutMs + CLIENT_TIMEOUT_MARGIN_MS,
    );

    try {
      let publicNews = null;
      if (action !== 'help') {
        publicNews = await this._loadPublicNews(planInput, controller.signal);
        this._prepend(
          formatAskLogEntry('PUBLIC NEWS', formatSocialSearchBody(publicNews), {
            locationName: plan.place,
          }),
        );
        phase = plan.kind;
        this._setStatus(`${phase}...`);
      }
      const asked = planSocialRequest({ ...planInput, publicNews });
      const response = await this._request(ASK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: plan.provider,
          question: asked.ok ? asked.question : plan.question,
          context: {
            ...context,
            socialPublicNews: publicNews || { status: 'skipped', articles: [] },
          },
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      globalThis.clearInterval(ticker);
      if (response.status === 501 || data?.unconfigured) {
        this._setStatus('No key for this model. Add one in POWER UP.');
        return;
      }
      if (!response.ok || !data?.answer) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      this._prepend(formatAskLogEntry(plan.kind, data.answer, { locationName: plan.place }));
      this._setStatus(this._usageLine(data));
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      this._setStatus(aborted ? 'No answer in time.' : error?.message || 'Request failed.');
    } finally {
      globalThis.clearInterval(ticker);
      globalThis.clearTimeout(timeout);
      this._inFlight = null;
      this._setBusy(false);
    }
  }

  _usageLine(data) {
    const usage = data?.usage || {};
    const total = Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0) || null;
    const model = data?.model ? String(data.model) : '';
    if (model && total) return `${model} · ${total} tokens`;
    return model || '';
  }

  _prepend(text) {
    if (!this._output) return;
    const next = prependOutputLog(this._output.textContent, text);
    if (!next) return;
    this._output.textContent = next;
    this._output.scrollTop = 0;
    this._entries += 1;
  }
}

async function placeSocialFix(viewer, fix, label) {
  if (!viewer?.entities?.add || viewer.isDestroyed?.()) return;
  const latitude = Number(fix?.latitude);
  const longitude = Number(fix?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  const Cesium = await import('cesium');
  const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, 0);
  const existing = viewer.entities.getById?.(SOCIAL_LOCATION_FIX_ID);
  if (existing) {
    existing.position = position;
    if (existing.label) existing.label.text = label;
    existing.show = true;
    return;
  }
  viewer.entities.add({
    id: SOCIAL_LOCATION_FIX_ID,
    position,
    point: {
      pixelSize: 14,
      color: Cesium.Color.fromCssColorString('#00d4ff'),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: label,
      font: 'bold 13px "JetBrains Mono", "SF Mono", monospace',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -20),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

async function clearSocialFix(viewer) {
  if (!viewer?.entities?.remove || viewer.isDestroyed?.()) return;
  const existing = viewer.entities.getById?.(SOCIAL_LOCATION_FIX_ID);
  if (existing) viewer.entities.remove(existing);
}
