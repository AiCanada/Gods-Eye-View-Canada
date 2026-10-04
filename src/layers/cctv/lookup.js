import {
  LOOKUP_ENDPOINT,
  LOOKUP_RETRYABLE_STATES,
  LOOKUP_RETRY_MIN_MS,
  LOOKUP_RETRY_MAX_MS,
} from './policy.js';

/**
 * Road511 lookup cameras (`feedType:'none'`, `lookup:'road511'`) have no public
 * still. They cost no request until the user explicitly opens one, which sends
 * a single POST /api/cctv/lookup/:id (contract 3).
 */
export function createLookup({ state: layerState, services, parts, source }) {
  /**
   * Sends a lookup camera's one Road511 lookup when its state asks for one:
   * `unresolved`, or a retryable answer (no key yet, key rejected, busy,
   * backoff) whose retry time has passed. At most one request per camera is in
   * flight. Called only from explicit activation.
   * @param {Object} record
   * @returns {boolean} Whether a request started.
   */

  function maybeLookupCamera(record) {
    const camera = record?.camera;
    if (
      !parts.model.isLookupCamera(camera) ||
      layerState._lookupRequests.has(camera.id)
    )
      return false;
    const state = camera.lookupState;
    const due =
      state === 'unresolved' ||
      (LOOKUP_RETRYABLE_STATES.has(state) &&
        Date.now() >= parts.model.safeNumber(camera.lookupRetryAt, 0));
    if (!due) return false;
    const id = camera.id;
    const run = async () => {
      let result = null;
      try {
        const response = await fetch(
          `${LOOKUP_ENDPOINT}/${encodeURIComponent(id)}`,
          {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
        );
        result = await response.json().catch(() => null);
        if (!response.ok && !result?.lookupState) {
          result = {
            lookupState:
              response.status === 429 || response.status >= 500
                ? 'busy'
                : 'no-image',
          };
        }
      } catch {
        result = { lookupState: 'busy' };
      } finally {
        layerState._lookupRequests.delete(id);
      }
      applyLookupResult(id, result);
    };
    layerState._lookupRequests.set(id, null);
    const promise = run();
    if (layerState._lookupRequests.has(id))
      layerState._lookupRequests.set(id, promise);
    return true;
  }

  /**
   * Applies a lookup answer to the camera, if it is still loaded. `resolved`
   * turns it into an image camera (or a stream camera, for video-only
   * operators) and rebuilds its monitor plane and card; retryable answers wait
   * `retryAfterMs` (bounded) before a later explicit open may ask again;
   * anything else means no public image.
   * @param {string} cameraId
   * @param {Object|null} result - `{lookupState, feedType, retryAfterMs, hlsVia}`.
   * @param {Object} [options]
   * @param {boolean} [options.notify=true]
   */

  function applyLookupResult(cameraId, result, { notify = true } = {}) {
    const record = layerState._recordById.get(cameraId);
    const camera = record?.camera;
    if (!camera || !parts.model.isLookupCamera(camera)) return;
    const state = String(result?.lookupState || '').toLowerCase();
    if (state === 'resolved') {
      camera.lookupState = 'resolved';
      // A still, or (video-only operators such as 511NJ) a clip cut from the stream.
      camera.feedType =
        parts.model.normalizeFeedType(result?.feedType) === 'hls'
          ? 'hls'
          : 'image';
      // A Road511 stream is relayed by the server's own HLS proxy.
      if (camera.feedType === 'hls') camera.hlsVia = 'proxy';
      camera.lookupRetryAt = 0;
      // The plane was painting the lookup note: rebuild it as an image plane.
      const runtime = record.projection;
      if (runtime) {
        parts.projection.releaseProjectionRuntime(runtime);
        layerState._projectionEntities = layerState._projectionEntities.filter(
          (entry) => entry !== runtime,
        );
      }
      // A card that settled on the placeholder fetches its first real frame.
      layerState._cardFrameSlots.delete(cameraId);
      if (layerState._enabled && cameraId === layerState._activeCameraId) {
        parts.projection.ensureProjectionRuntime(record);
        parts.frames.refreshProjectionImage(record, true);
        parts.rendering.refreshCoverageStyles();
        parts.projection.startProjectionLoop();
      }
      if (layerState._enabled) parts.cards.pushAmbientCardEntries();
    } else if (LOOKUP_RETRYABLE_STATES.has(state)) {
      camera.lookupState = state;
      camera.lookupRetryAt =
        Date.now() +
        parts.model.clamp(
          parts.model.safeNumber(result?.retryAfterMs, 0),
          LOOKUP_RETRY_MIN_MS,
          LOOKUP_RETRY_MAX_MS,
        );
    } else {
      camera.lookupState = state === 'not-lookup' ? 'not-lookup' : 'no-image';
    }
    layerState._catalogVersion += 1;
    if (notify) parts.presentation.notifyListeners();
  }

  /**
   * Panel and plane note for a camera with no public still.
   * @param {Object} camera
   * @returns {string} Empty for a camera with a still.
   */

  function cameraLookupNote(camera) {
    if (!camera || parts.model.cameraHasStill(camera)) return '';
    if (!parts.model.isLookupCamera(camera))
      return 'No public image for this camera';
    if (layerState._lookupRequests.has(camera.id))
      return 'Looking up a Road511 image';
    switch (camera.lookupState) {
      case 'no-key':
        return (
          services.keySetup?.keySetupRequirement?.('road511') ||
          'Road511 key not set'
        );
      case 'key-rejected':
        return 'Road511 key rejected · check it in Provider Settings';
      case 'busy':
      case 'backoff':
        return 'Road511 lookup busy · open the camera again shortly';
      case 'no-image':
      case 'not-lookup':
        return 'No public image for this camera';
      default:
        return 'No public image · select the camera to look one up';
    }
  }

  /**
   * Short source-badge label for a camera with no public still.
   * @param {Object} camera
   * @returns {string} Empty for a camera with a still.
   */

  function cameraLookupBadge(camera) {
    if (!camera || parts.model.cameraHasStill(camera)) return '';
    if (!parts.model.isLookupCamera(camera)) return 'NO PUBLIC IMAGE';
    if (layerState._lookupRequests.has(camera.id)) return 'LOOKING UP';
    switch (camera.lookupState) {
      case 'no-key':
        return 'KEY NOT SET';
      case 'key-rejected':
        return 'KEY REJECTED';
      case 'busy':
      case 'backoff':
        return 'TRY AGAIN SOON';
      case 'no-image':
      case 'not-lookup':
        return 'NO PUBLIC IMAGE';
      default:
        return 'SELECT TO LOOK UP';
    }
  }

  return {
    maybeLookupCamera,
    applyLookupResult,
    cameraLookupNote,
    cameraLookupBadge,
  };
}
