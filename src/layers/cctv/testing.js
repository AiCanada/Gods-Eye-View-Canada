import * as Cesium from 'cesium';
import {
  createProjectionPrimitiveAppearance,
  projectionImageSource,
} from './projection.js';

export function createTesting({ state: layerState, services, parts, source }) {
  /** Test seam: republishes host entries through the real push path, so tests
   * can observe the pristine module default without touching the setter. */

  function _pushAmbientCardEntriesForTest() {
    parts.cards.pushAmbientCardEntries();
  }

  /** Test seam for exercising real layer lifecycle paths without a DOM host. */

  function _setCctvOverlayHostForTest(host = null) {
    layerState._cctvOverlayHost = host
      ? { ...layerState.DEFAULT_CCTV_OVERLAY_HOST, ...host }
      : layerState.DEFAULT_CCTV_OVERLAY_HOST;
    layerState._projectionOverlayOwnerId = null;
  }

  /**
   * Create the production monitor-plane/host-label pair without media setup.
   * @param {Object} viewer Cesium viewer seam.
   * @param {Object} record CCTV runtime record.
   * @returns {Object} Projection runtime.
   */

  function _createCctvProjectionPlaneForTest(viewer, record) {
    layerState._viewer = viewer;
    const geometry =
      record.frustumGeometry ||
      parts.geometry.computeFrustumGeometry(
        record.camera,
        parts.ground.groundAltFor(record),
        record.probeClampRangeM,
      );
    const positions =
      record.frustumPositions || parts.geometry.frustumCartesians(geometry);
    record.frustumGeometry = geometry;
    record.frustumPositions = positions;
    const runtime = {
      cameraId: String(record.camera.id),
      planeEntity: null,
      planePrimitive: null,
      planePrimitiveMaterial: null,
      labelPosition: new Cesium.Cartesian3(),
      overlayEntry: null,
      planeMaterial: new Cesium.ColorMaterialProperty(Cesium.Color.WHITE),
    };
    parts.projection.createProjectionPlane(
      record,
      runtime,
      geometry,
      positions,
    );
    record.projection = runtime;
    return runtime;
  }

  /**
   * Exercise the production geometry-to-plane-and-label cache update.
   * @param {Object} record CCTV runtime record.
   */

  function _updateCctvProjectionPlaneForTest(record) {
    parts.projection.updatePlanePlacement(record);
  }

  /** Test-only seam for the CCTV ownership proof used by the world-click route. */

  function _extractPickedCameraIdForTest(picked) {
    return parts.selection.extractPickedCameraId(picked);
  }

  /**
   * Primes the minimum module state needed to exercise the production coverage
   * refresh path in unit tests.
   * @param {Object} [options={}] Test state values.
   * @param {Object|null} [options.viewer] Viewer-like entity owner.
   * @param {Object[]} [options.records] Seeded CCTV records.
   * @param {string|null} [options.activeCameraId] Active record id.
   * @param {boolean} [options.enabled=true] Layer enabled state.
   * @param {'off'|'on'|'viewshed'} [options.coverageMode='on'] Coverage mode.
   * @param {boolean} [options.showProjection=false] Projection visibility.
   * @param {Object|null} [options.billboards] Billboard-collection seam (`add`/`remove`).
   * @param {Object|null} [options.area] Loaded area report, as the server sends it.
   * @returns {void}
   */

  function _setCctvCoverageStateForTest({
    viewer = null,
    records = [],
    activeCameraId = null,
    enabled = true,
    coverageMode = 'on',
    showProjection = false,
    billboards = null,
    area = null,
  } = {}) {
    parts.geometryQueue.stopGeometryLoadQueue();
    parts.area.abortAreaRequest();
    parts.area.clearAreaRefetchTimer();
    layerState._viewer = viewer;
    layerState._records = Array.isArray(records) ? records : [];
    layerState._recordById = new Map(
      layerState._records
        .filter((record) => record?.camera?.id)
        .map((record) => [record.camera.id, record]),
    );
    layerState._catalogVersion += 1;
    layerState._coverageEntities = [];
    layerState._projectionEntities = [];
    layerState._billboards = billboards;
    layerState._activeCameraId = activeCameraId;
    layerState._autoHopSuspended = false;
    layerState._enabled = !!enabled;
    layerState._coverageMode = parts.model.normalizeCoverageMode(
      coverageMode,
      'on',
    );
    layerState._showProjection = !!showProjection;
    layerState._locationSwitching = false;
    layerState._locationSwitchStartedAt = 0;
    layerState._locationSwitchHadActive = false;
    layerState._area = area
      ? parts.area.normalizeArea(
          area,
          area,
          layerState._records.length,
          layerState._areaGeneration,
        )
      : null;
    layerState._pendingAreaPoint = null;
    layerState._areaDefaultPending = false;
    layerState._areaCameraOwed = null;
    layerState._lookupRequests.clear();
  }

  /** Test seam: the live record for a camera id, or null. */

  function _cctvRecordForTest(cameraId) {
    return layerState._recordById.get(cameraId) || null;
  }

  /** Test seam: starts a private camera reload; resolves once that reload has settled. */

  function _reloadCctvPrivateCamerasForTest() {
    return parts.area.scheduleCatalogReload();
  }

  /** Test seam: replaces the ground-prior batch resolver (null restores the proxy). */

  function _setCctvGroundPriorResolverForTest(resolver = null) {
    layerState._groundPriorResolver =
      typeof resolver === 'function' ? resolver : null;
  }

  /** Test seam: the image a monitor plane's picture is bound to. */

  function _projectionImageSourceForTest(runtime) {
    return projectionImageSource(runtime);
  }

  /** Test seam: monitor-plane appearance must not write depth over traffic. */

  function _createCctvProjectionAppearanceForTest(material) {
    return createProjectionPrimitiveAppearance(material);
  }
  return {
    _cctvRecordForTest,
    _reloadCctvPrivateCamerasForTest,
    _setCctvGroundPriorResolverForTest,
    _projectionImageSourceForTest,
    _createCctvProjectionAppearanceForTest,
    _pushAmbientCardEntriesForTest,
    _setCctvOverlayHostForTest,
    _createCctvProjectionPlaneForTest,
    _updateCctvProjectionPlaneForTest,
    _extractPickedCameraIdForTest,
    _setCctvCoverageStateForTest,
  };
}
