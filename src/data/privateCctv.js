/**
 * PRIVATE CCTV CAMS: the switch for this machine's own home and business
 * cameras (POWER UP > SECURITY CAMERAS) on the map, listed under Other layers
 * and mirrored by a tick box in the Ultra box.
 *
 * The cameras themselves are drawn by the Cameras layer (src/layers/cctv),
 * which asks `privateCamerasShown()` before it loads them and reloads them on
 * PRIVATE_CAMERAS_CHANGED_EVENT. This layer draws nothing of its own: it holds
 * the choice. Ticked by its owner while Cameras is off, it turns Cameras on,
 * because that is where the private cameras appear.
 *
 * Like the Cell layer it comes on by itself once this machine has a private
 * camera, unless its owner switched it off (a click, voice or a tool).
 */

export const PRIVATE_CCTV_LAYER_ID = 'private-cctv';
/** The Cameras layer reloads its private cameras on this window event. */
export const PRIVATE_CAMERAS_CHANGED_EVENT = 'gev:private-cameras-changed';
const PRIVATE_SOURCES_URL = '/api/private-cams/sources';
const CAMERAS_LAYER_ID = 'cctv';
const OWNER_CHOICE_ORIGINS = new Set(['user', 'voice', 'tool']);
/** How often a switched-off layer asks whether a private camera exists. */
export const PRIVATE_CCTV_AUTO_SHOW_MS = 60_000;

/* Shown until a Private CCTV layer takes charge, so a page without one (an
 * embed, a test) keeps the private cameras it always had. */
let shown = true;

/** Whether the Cameras layer should draw this machine's private cameras. */
export function privateCamerasShown() {
  return shown;
}

/** @returns {object} The layer module. */
export function createPrivateCctvLayer({
  fetchImpl = (...args) => fetch(...args),
  windowRef = typeof window === 'undefined' ? null : window,
  autoShowMs = PRIVATE_CCTV_AUTO_SHOW_MS,
} = {}) {
  let _dataManager = null;
  let _enabled = false;
  let _count = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _autoShowTimer = null;
  let _firstTimer = null;

  const announce = (next) => {
    if (shown === next) return;
    shown = next;
    try {
      windowRef?.dispatchEvent?.(
        new CustomEvent(PRIVATE_CAMERAS_CHANGED_EVENT, {
          detail: { shown: next },
        }),
      );
    } catch {
      /* No CustomEvent here: the Cameras layer reloads on its next pass. */
    }
  };

  const originOf = (id) =>
    _dataManager?.layers?.get?.(id)?.visibilityIntentOrigin;

  const countCameras = async () => {
    const response = await fetchImpl(PRIVATE_SOURCES_URL, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const sources = Array.isArray(payload?.sources) ? payload.sources : [];
    return sources.filter((entry) => entry?.sourceKind === 'private').length;
  };

  const autoShow = async () => {
    if (_enabled) return;
    if (OWNER_CHOICE_ORIGINS.has(originOf(PRIVATE_CCTV_LAYER_ID))) return;
    try {
      const count = await countCameras();
      _count = count;
      if (count > 0 && !_enabled)
        await _dataManager?.setEnabled?.(PRIVATE_CCTV_LAYER_ID, true);
    } catch {
      // No server, or a viewer that is not this machine: asked again later.
    }
  };

  const layer = {
    id: PRIVATE_CCTV_LAYER_ID,
    name: 'Private CCTV Cams',
    icon: '📹',
    source: 'POWER UP',
    updateInterval: PRIVATE_CCTV_AUTO_SHOW_MS,

    attachDataManager(dataManager) {
      _dataManager = dataManager;
      // This layer now owns the choice, and starts off like every layer.
      announce(false);
      if (!(autoShowMs > 0) || !windowRef?.setInterval) return;
      _firstTimer = windowRef.setTimeout?.(autoShow, 2_000) ?? null;
      _autoShowTimer = windowRef.setInterval(autoShow, autoShowMs);
    },

    init() {
      _enabled = false;
    },

    enable() {
      _enabled = true;
      announce(true);
      // Ticked by its owner with Cameras off: Cameras is where they appear.
      if (
        OWNER_CHOICE_ORIGINS.has(originOf(PRIVATE_CCTV_LAYER_ID)) &&
        typeof _dataManager?.isEnabled === 'function' &&
        !_dataManager.isEnabled(CAMERAS_LAYER_ID)
      ) {
        Promise.resolve(
          _dataManager.setEnabled?.(CAMERAS_LAYER_ID, true, {
            origin: 'user',
          }),
        ).catch(() => {});
      }
    },

    disable() {
      _enabled = false;
      announce(false);
    },

    async update() {
      try {
        _count = await countCameras();
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch {
        _lastError = 'Private cameras need the local server';
        return false;
      }
    },

    destroy() {
      _enabled = false;
      if (_autoShowTimer !== null) windowRef?.clearInterval?.(_autoShowTimer);
      if (_firstTimer !== null) windowRef?.clearTimeout?.(_firstTimer);
      _autoShowTimer = null;
      _firstTimer = null;
      announce(true);
    },

    getStats() {
      return {
        count: _count ?? 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
