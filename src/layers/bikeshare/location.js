import * as Cesium from 'cesium';
import { ACTIVATION_EXIT_ALTITUDE_M } from './policy.js';

/**
 * Location-switch hooks (DataLayerManager onLocationLeave → onLocationArrive)
 * and their focused test seams.
 *
 * Leave stops feeding the old place: the pending camera check and every
 * in-flight GBFS request are cancelled, cities out of load range of the
 * destination are deactivated, and the cached feeds of every far city are
 * dropped. Camera checks and status polls pause until arrival, which loads the
 * arrived view at once and refreshes the cities kept through the switch.
 */
export function createLocation({ state: layerState, parts }) {
  /**
   * Read a location-switch endpoint as a camera-center shaped point.
   * @param {{ lat?: number, lon?: number }|null|undefined} place - Switch endpoint.
   * @returns {{ lat: number, lon: number }|null} Point in degrees, or null when unplaced.
   */
  function toLocationPoint(place) {
    if (!Number.isFinite(place?.lat) || !Number.isFinite(place?.lon))
      return null;
    return { lat: place.lat, lon: place.lon };
  }

  /**
   * Release every city that does not serve a location-switch destination.
   * Cities within load range of the destination keep their points and caches,
   * so a nearby destination re-renders without re-downloading. All other
   * cities are deactivated (points removed, selection cleared if it was
   * theirs), and the parsed station information and status of every far city
   * is dropped from memory, including cities visited earlier in the session.
   * @param {{ lat: number, lon: number }|null} destination - Destination point, or null to release all.
   * @returns {string[]} City ids that were deactivated.
   */
  function releaseCitiesAwayFrom(destination) {
    const keep = parts.viewport.computeInRangeCities(destination);
    const released = [];
    // A city can be mid-activation (active, no points yet) or rendered; release both
    const known = new Set([
      ...layerState._activeCityIds,
      ...layerState._cityRuntime.keys(),
    ]);
    for (const cityId of known) {
      if (keep.has(cityId)) continue;
      parts.viewport.deactivateCity(cityId);
      layerState._activeCityIds.delete(cityId);
      released.push(cityId);
    }

    // Nothing else prunes these caches; they otherwise grow with every city visited
    for (const cityId of Array.from(layerState._stationInfoCache.keys())) {
      if (!keep.has(cityId)) layerState._stationInfoCache.delete(cityId);
    }
    for (const cityId of Array.from(layerState._statusCache.keys())) {
      if (!keep.has(cityId)) layerState._statusCache.delete(cityId);
    }

    layerState._count = layerState._stationRenderMap.size;
    return released;
  }

  const methods = {
    /**
     * Location switch, leave phase. Camera checks and status polls pause until
     * onLocationArrive. The layer stays enabled; the camera listener, click
     * handler and pick owner are kept. No network. Idempotent, never throws.
     * @param {{ from: ?Object, to: ?{ lat: number, lon: number }, signal?: AbortSignal, enabled?: boolean }} change
     */
    onLocationLeave(change) {
      try {
        layerState._locationSwitching = true;
        layerState._proximityGeneration++;
        clearTimeout(layerState._cameraDebounceTimer);
        layerState._cameraDebounceTimer = null;
        parts.ingestion.abortAllInFlight();
        releaseCitiesAwayFrom(toLocationPoint(change?.to));
      } catch (error) {
        console.warn('[Data:Bikeshare] location leave error:', error);
      }
    },

    /**
     * Location switch, arrival phase. Resumes camera checks and status polls
     * and loads the cities around the arrived view at once, without the
     * debounce. Cities kept through the switch get a fresh status fetch, since
     * leave cancelled theirs. The altitude gate is re-seeded for the new view:
     * an arrival anywhere below the exit threshold counts as inside, so landing
     * in the hysteresis band still loads instead of waiting for a zoom-in.
     * A superseded switch (aborted signal) is ignored; the newer one arrives.
     * @param {{ from: ?Object, to: ?Object, signal?: AbortSignal }} [change]
     * @returns {Promise<void>}
     */
    async onLocationArrive(change) {
      if (change?.signal?.aborted) return;
      layerState._locationSwitching = false;
      if (!layerState._enabled || !layerState._viewer) return;

      try {
        layerState._altitudeGateEnabled =
          parts.viewport.getCameraAltitude(layerState._viewer) <
          ACTIVATION_EXIT_ALTITUDE_M;
        const renderedBefore = Array.from(layerState._cityRuntime.keys());
        // The check bumps the generation and settles the active set synchronously
        const check = parts.viewport.runProximityCheck();
        const kept = renderedBefore.filter((cityId) =>
          layerState._activeCityIds.has(cityId),
        );
        await Promise.all([
          check,
          parts.ingestion.refreshCityStatus(
            kept,
            layerState._proximityGeneration,
          ),
        ]);
      } catch (error) {
        console.warn('[Data:Bikeshare] location arrive error:', error);
      }
    },
  };

  /**
   * Reset layer runtime for location-switch tests without init()/enable(),
   * which need a DOM canvas for the click handler. Call with no arguments to
   * tear down.
   */
  function _setBikeshareLocationStateForTest({
    viewer = null,
    enabled = true,
    overlayHost,
    altitudeGateEnabled = false,
  } = {}) {
    clearTimeout(layerState._cameraDebounceTimer);
    parts.ingestion.abortAllInFlight();
    layerState._viewer = viewer;
    layerState._pointCollection = viewer
      ? new Cesium.PointPrimitiveCollection()
      : null;
    layerState._enabled = Boolean(viewer) && enabled;
    layerState._cameraDebounceTimer = null;
    layerState._altitudeGateEnabled = altitudeGateEnabled;
    layerState._proximityGeneration = 0;
    layerState._locationSwitching = false;
    layerState._activeCityIds = new Set();
    layerState._cityRuntime = new Map();
    layerState._stationInfoCache = new Map();
    layerState._statusCache = new Map();
    layerState._inFlightInfo = new Map();
    layerState._inFlightStatus = new Map();
    layerState._stationRenderMap = new Map();
    layerState._selectedKey = null;
    layerState._selectedEntity = null;
    layerState._count = 0;
    layerState._loading = false;
    layerState._loadingOps = 0;
    layerState._error = null;
    layerState._overlayHost = overlayHost || layerState.DEFAULT_OVERLAY_HOST;
  }

  /**
   * Seed one city's parsed feeds, rendering it through the production point
   * and status paths unless `render` is false (a city cached by an earlier visit).
   */
  function _seedBikeshareCityForTest(
    cityId,
    { stations, status = null, render = true },
  ) {
    layerState._stationInfoCache.set(cityId, stations);
    if (status)
      layerState._statusCache.set(cityId, {
        statusMap: status,
        timestamp: Date.now(),
      });
    if (!render) return;
    layerState._activeCityIds.add(cityId);
    parts.rendering.ensureCityPoints(cityId, stations);
    if (status) parts.rendering.applyStatusToPoints(cityId, status);
  }

  /** Snapshot the runtime state a location switch acts on. */
  function _getBikeshareLocationStateForTest() {
    const sorted = (keys) => Array.from(keys).sort();
    return {
      enabled: layerState._enabled,
      switching: layerState._locationSwitching,
      generation: layerState._proximityGeneration,
      altitudeGateEnabled: layerState._altitudeGateEnabled,
      debouncePending: layerState._cameraDebounceTimer !== null,
      activeCityIds: sorted(layerState._activeCityIds),
      renderedCityIds: sorted(layerState._cityRuntime.keys()),
      stationInfoCacheCityIds: sorted(layerState._stationInfoCache.keys()),
      statusCacheCityIds: sorted(layerState._statusCache.keys()),
      inFlightCityIds: sorted([
        ...layerState._inFlightInfo.keys(),
        ...layerState._inFlightStatus.keys(),
      ]),
      pointCount: layerState._pointCollection
        ? layerState._pointCollection.length
        : 0,
      count: layerState._count,
      selectedKey: layerState._selectedKey,
    };
  }

  /** Deliver one camera.changed event through the production handler. */
  function _notifyBikeshareCameraChangedForTest() {
    parts.viewport.onCameraChanged();
  }

  return {
    methods,
    toLocationPoint,
    releaseCitiesAwayFrom,
    _setBikeshareLocationStateForTest,
    _seedBikeshareCityForTest,
    _getBikeshareLocationStateForTest,
    _notifyBikeshareCameraChangedForTest,
  };
}
