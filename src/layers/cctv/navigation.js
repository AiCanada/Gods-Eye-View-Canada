import * as Cesium from 'cesium';
import { CCTV_FOCUS_RESULT, LOCATION_SELECT_RADIUS_KM } from './policy.js';

export function createNavigation({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Finds the camera with a still nearest a point, within `radiusKm`. Defaults
   * (enable, area, arrival) and AUTO HOP only ever pick these.
   * @param {{lat:number, lon:number}|null} point
   * @param {number} [radiusKm=LOCATION_SELECT_RADIUS_KM]
   * @returns {string|null} Camera ID, or null.
   */

  function nearestStillCameraId(point, radiusKm = LOCATION_SELECT_RADIUS_KM) {
    return parts.area.nearestCameraIdWithinKm(point, radiusKm, {
      requireStill: true,
    });
  }

  /**
   * The next camera with a still after `currentId` in catalogue order (AUTO
   * HOP's cycle), skipping cameras that have no public still.
   * @param {string|null} currentId
   * @param {number} [step=1]
   * @returns {string|null}
   */

  function nextStillCameraId(currentId, step = 1) {
    const records = layerState._records;
    const count = records.length;
    let index = records.findIndex((record) => record.camera.id === currentId);
    for (let i = 0; i < count; i++) {
      index = cctvCycleIndex(index, step, count);
      const camera = records[index]?.camera;
      if (
        camera &&
        camera.id !== currentId &&
        parts.model.cameraHasStill(camera)
      )
        return camera.id;
    }
    return null;
  }

  /**
   * Flies the Cesium viewer camera to frame the specified CCTV camera,
   * looking along its heading from above.
   * @param {Cesium.Viewer|null} viewer Cesium viewer that owns the camera.
   * @param {Object|null} record CCTV camera runtime record.
   * @param {number} [duration=2.2] - Flight duration in seconds.
   * @returns {'focused'|'no-active-camera'|'tracking-holds-view'|'cockpit-active'} Focus result.
   */

  function focusCctvRecord(viewer, record, duration = 2.2) {
    if (!viewer || !record) return CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    if (
      typeof document !== 'undefined' &&
      document.body?.classList.contains('cockpit-mode')
    ) {
      console.debug('[Data:CCTV] focus ignored while cockpit owns the camera');
      return CCTV_FOCUS_RESULT.COCKPIT_ACTIVE;
    }
    if (viewer.trackedEntity) {
      console.debug(
        '[Data:CCTV] focus ignored while a tracked entity owns the camera',
      );
      return CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW;
    }
    const { camera } = record;
    const range = Math.max(
      camera.sourceKind === 'private' ? 60 : 280,
      camera.rangeM * 1.18,
    );
    viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        record.position,
        Math.max(40, camera.rangeM * 0.36),
      ),
      {
        offset: new Cesium.HeadingPitchRange(
          parts.model.toRad(camera.headingDeg),
          parts.model.toRad(-22),
          range,
        ),
        duration: Math.max(0.2, duration || 0),
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      },
    );
    return CCTV_FOCUS_RESULT.FOCUSED;
  }

  function focusCamera(cameraId, duration = 2.2) {
    return focusCctvRecord(
      layerState._viewer,
      layerState._recordById.get(cameraId),
      duration,
    );
  }

  /**
   * Advances to the next camera if auto-hop is enabled and the hop interval
   * has elapsed. If the viewer has panned to a new region since the last hop,
   * snaps to the nearest camera instead of cycling sequentially. Holds during a
   * location switch; its arrival picks the destination's camera.
   * @param {number} nowMs - Current timestamp in milliseconds.
   */

  function maybeAutoHop(nowMs) {
    if (
      !layerState._autoHop ||
      layerState._autoHopSuspended ||
      !layerState._enabled ||
      layerState._locationSwitching ||
      layerState._records.length < 2
    )
      return;
    if (nowMs - layerState._lastHopAt < layerState._autoHopSec * 1000) return;

    const viewKey = parts.model.currentViewContext();
    const viewChanged = viewKey !== layerState._lastViewContext;
    layerState._lastViewContext = viewKey;

    // AUTO HOP only lands on cameras with a still, and it is never an explicit
    // activation, so it sends no Road511 lookup.
    if (viewChanged) {
      const nearest = nearestStillCameraId(parts.area.viewerPoint());
      if (nearest && nearest !== layerState._activeCameraId) {
        // Use setActiveCamera so the full activation path runs (obstruction
        // probe, projection runtime, geometry rewrite) — previously bypassed
        // with a bare assignment
        parts.selection.setActiveCamera(nearest);
        layerState._lastHopAt = nowMs;
        return;
      }
    }

    const nextId = nextStillCameraId(layerState._activeCameraId, 1);
    if (nextId) parts.selection.setActiveCamera(nextId);
    layerState._lastHopAt = nowMs;
  }

  /**
   * Resolves a catalog cycle target, including the explicit no-selection state.
   * NEXT from null selects the first record; PREV selects the last.
   * @param {number} currentIdx
   * @param {number} step
   * @param {number} count
   * @returns {number}
   */

  function cctvCycleIndex(currentIdx, step, count) {
    const total = Number.isFinite(count) ? Math.floor(count) : 0;
    if (total <= 0) return -1;
    const delta = Number.isFinite(step) ? Math.trunc(step) : 1;
    if (!Number.isFinite(currentIdx) || currentIdx < 0) {
      return delta < 0 ? total - 1 : 0;
    }
    return (((Math.floor(currentIdx) + delta) % total) + total) % total;
  }
  return {
    nearestStillCameraId,
    nextStillCameraId,
    focusCctvRecord,
    focusCamera,
    maybeAutoHop,
    cctvCycleIndex,
  };
}
