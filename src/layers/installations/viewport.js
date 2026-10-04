import * as Cesium from 'cesium';
import {
  REQUEST_DEBOUNCE_MS,
  UNBOUNDED_VIEW_KEEP_MAX_HEIGHT_M,
  UNBOUNDED_VIEW_KEEP_MARGIN_DEGREES,
} from './policy.js';
import { installationAnchorBox } from './source.js';

/** @param {?{south:number, west:number, north:number, east:number}} box @returns {?string} */
export function viewportKey(box) {
  return box
    ? [box.south, box.west, box.north, box.east]
        .map((value) => value.toFixed(5))
        .join(',')
    : null;
}

/** @param {object} viewer @returns {?{latitude:number, longitude:number, height:number}} Degrees and metres. */
export function cameraGroundPosition(viewer) {
  const cartographic = viewer?.camera?.positionCartographic;
  if (!cartographic) return null;
  return {
    latitude: Cesium.Math.toDegrees(cartographic.latitude),
    longitude: Cesium.Math.toDegrees(cartographic.longitude),
    height: cartographic.height,
  };
}

/**
 * Whether sites loaded for `box` still describe where a camera with an
 * unbounded view is.
 *
 * An unbounded view is either a zoom-out (a globe reset, a high approach) or a
 * low camera looking along the ground at the horizon, as Cockpit does. The
 * first must drop the previous place's sites: they otherwise stayed on the globe
 * and in the awareness cohort under a "zoom in" prompt. The second is still
 * flying over them, and dropping them would empty Contacts mid-flight.
 * @param {?{south:number, west:number, north:number, east:number}} box Last loaded viewport.
 * @param {?{latitude:number, longitude:number, height:number}} camera Camera position, degrees and metres.
 * @returns {boolean} True when the records should be kept.
 */
export function installationRecordsOutliveUnboundedView(box, camera) {
  if (!box || !camera) return false;
  const { latitude, longitude, height } = camera;
  if (![latitude, longitude, height].every(Number.isFinite)) return false;
  if (height > UNBOUNDED_VIEW_KEEP_MAX_HEIGHT_M) return false;
  const margin = UNBOUNDED_VIEW_KEEP_MARGIN_DEGREES;
  return (
    latitude >= box.south - margin &&
    latitude <= box.north + margin &&
    longitude >= box.west - margin &&
    longitude <= box.east + margin
  );
}

export function createViewport({ state: layerState, services, parts, source }) {
  /** Whether a location switch in flight mutes camera-driven loads. */
  function locationSwitchSuspended() {
    return layerState.suspendedUntil > Date.now();
  }

  /**
   * The area this load describes: the window around a Contacts subject while
   * one is set (a follow or Cockpit camera never settles and often looks at the
   * horizon), otherwise the settled camera viewport.
   * @param {object} viewer Cesium viewer.
   * @returns {{box: object|null, coverage: object}} Query box and its coverage.
   */
  function loadArea(viewer) {
    const anchor = layerState.contextAnchor;
    if (anchor) {
      const box = installationAnchorBox(anchor);
      if (box) {
        const { radiusM, ...bounds } = box;
        return { box: bounds, coverage: { kind: 'subject', radiusM } };
      }
    }
    return { box: viewportBox(viewer), coverage: { kind: 'viewport' } };
  }

  function viewportBox(viewer) {
    const rectangle = viewer?.camera?.computeViewRectangle(
      viewer.scene.globe.ellipsoid,
    );
    if (!rectangle) return null;
    const south = Cesium.Math.toDegrees(rectangle.south);
    const north = Cesium.Math.toDegrees(rectangle.north);
    const west = Cesium.Math.toDegrees(rectangle.west);
    const east = Cesium.Math.toDegrees(rectangle.east);
    // Wide and dateline views use the bundled point index.
    if (
      !Number.isFinite(south + north + west + east) ||
      east === west ||
      north <= south
    )
      return null;
    return { south, west, north, east };
  }

  /**
   * Backoff progression for the unavailable-state retry: 30 s, doubling to a
   * 240 s ceiling. Pure so the progression is pinnable without booting the layer.
   */

  function installationRetryDelayMs(prevDelayMs) {
    const RETRY_MIN_MS = 30000;
    const RETRY_CEIL_MS = 240000;
    if (!Number.isFinite(prevDelayMs) || prevDelayMs <= 0) return RETRY_MIN_MS;
    return Math.min(prevDelayMs * 2, RETRY_CEIL_MS);
  }

  /**
   * 'Temporarily unavailable' must mean temporarily: fetches otherwise fire only
   * on enable and on camera moveEnd, so a parked camera whose first request died
   * (one flaky Overpass mirror is enough) stayed unavailable forever while the
   * proxy sat healthy while the layer refused to show its features. While the
   * layer is enabled and
   * unavailable, retry on a 30 s → 240 s backoff; any success, user-driven load,
   * zoom-out, or disable cancels it.
   */

  function scheduleUnavailableRetry(retryAfterMs = 0) {
    if (!layerState.enabled) return;
    clearTimeout(layerState.retryTimer);
    layerState.retryDelayMs = Math.max(
      retryAfterMs,
      installationRetryDelayMs(layerState.retryDelayMs),
    );
    layerState.retryAt = Date.now() + layerState.retryDelayMs;
    layerState.retryTimer = setTimeout(() => {
      layerState.retryTimer = null;
      layerState.retryAt = 0;
      // A location switch in flight owns the next query; arrival reloads.
      if (locationSwitchSuspended()) return;
      if (layerState.enabled && !layerState.loading)
        parts.ingestion.loadInstallations();
    }, layerState.retryDelayMs);
  }

  function clearUnavailableRetry({ resetBackoff = true } = {}) {
    clearTimeout(layerState.retryTimer);
    layerState.retryTimer = null;
    layerState.retryAt = 0;
    if (resetBackoff) layerState.retryDelayMs = 0;
  }

  function scheduleLoad() {
    // During a location switch the camera is crossing places nobody asked for;
    // onLocationArrive issues the one query for where it lands.
    if (!layerState.enabled || locationSwitchSuspended()) return;
    const { box, coverage } = loadArea(layerState.viewer);
    const camera = layerState.viewer.camera;
    const widePose =
      coverage.kind === 'viewport' &&
      box &&
      (box.east < box.west ||
        box.east - box.west > 10 ||
        box.north - box.south > 10)
        ? [camera.positionWC, camera.directionWC]
            .map((v) =>
              v ? [v.x, v.y, v.z].map((n) => n.toFixed(4)).join(',') : '',
            )
            .join(':')
        : '';
    const key = `${coverage.kind}:${box ? [box.south, box.west, box.north, box.east].map((v) => v.toFixed(6)).join(',') : 'wide'}:${widePose}`;
    if (layerState.cameraLoadKey === key && !layerState.error) return;
    // The settle that follows an arrival lands on the view the arrival load is
    // already fetching; restarting it would only abort that request.
    if (
      layerState.loading &&
      layerState.loadingKey &&
      layerState.loadingKey === viewportKey(box)
    ) {
      layerState.cameraLoadKey = key;
      return;
    }
    layerState.cameraLoadKey = key;
    layerState.cameraLoadOwner = {};
    layerState.abort?.abort();
    // A user-driven load supersedes any pending retry; the load reschedules on
    // failure, so the backoff step is kept rather than reset.
    clearUnavailableRetry({ resetBackoff: false });
    clearTimeout(layerState.timer);
    layerState.timer = setTimeout(() => {
      layerState.timer = null;
      parts.ingestion.loadInstallations();
    }, REQUEST_DEBOUNCE_MS);
  }
  return {
    locationSwitchSuspended,
    loadArea,
    viewportBox,
    installationRetryDelayMs,
    scheduleUnavailableRetry,
    clearUnavailableRetry,
    scheduleLoad,
  };
}
