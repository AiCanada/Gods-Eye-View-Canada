import { distance } from '../../geo/vector.js';
import { toLonLatH } from '../../geo/ellipsoid.js';
import { rangeForBoundingSphere } from '../../data/cameraFraming.js';
import { isFollowing } from '../../data/followed.js';
import {
  cellBounds,
  cellCenter,
  cellHalfExtents,
} from '../../data/cctvCellCounts.js';
import {
  CCTV_FOCUS_RESULT,
  LOCATION_SELECT_RADIUS_KM,
  VIEW_CELL_PX,
  VIEW_MIN_CELL_M,
} from './policy.js';
import { cameraOf, canvasOf } from '../../render/rendererOf.js';

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
   * Nearest catalog camera to a WGS84 point.
   * @param {number} lat Latitude in degrees.
   * @param {number} lon Longitude in degrees.
   * @returns {string|null} Camera ID, or null (invalid point, empty catalog).
   */
  function nearestCameraIdToPoint(lat, lon) {
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      !layerState._records.length
    )
      return null;

    let best = null;
    for (const record of layerState._records) {
      const distKm = parts.model.haversineKm(
        lat,
        lon,
        record.camera.lat,
        record.camera.lon,
      );
      if (!best || distKm < best.distKm) {
        best = { id: record.camera.id, distKm };
      }
    }
    return best?.id || null;
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
   * Finds the camera closest to the viewer's current position.
   * @returns {string|null} Camera ID of the nearest camera, or null.
   */
  function nearestCameraIdToViewer() {
    const pose = parts.model.eyePose();
    if (!pose) return null;
    return nearestCameraIdToPoint(pose.lat, pose.lon);
  }

  /**
   * The camera the layer opens on when none is selected: the one nearest the
   * viewer, or the first record when the viewer has no position yet.
   * @returns {string|null} Camera ID, or null when the catalog is empty.
   */

  function openingCameraId() {
    return (
      nearestCameraIdToViewer() || layerState._records[0]?.camera?.id || null
    );
  }

  /**
   * After a settled move, moves the opening camera to the one with a still
   * nearest the view, until someone chooses a camera. A shared view's flight
   * lands after enable() picked from the startup view.
   * @returns {boolean} True when the active camera changed.
   */

  function reopenNearestCamera() {
    if (
      !layerState._openingCameraProvisional ||
      !layerState._enabled ||
      layerState._locationSwitching
    )
      return false;
    // Like enable()'s default: the nearest camera with a still within reach
    // of the view (a location switch's arrival picks its own).
    const nearest = nearestStillCameraId(parts.area.viewerPoint());
    if (!nearest || nearest === layerState._activeCameraId) return false;
    // Still the opening pick: later settled moves may replace it.
    parts.selection.setActiveCamera(nearest, { opening: true });
    return true;
  }

  /** What holds the view instead of a CCTV flight, or null when it is free. */
  function viewHeldBy(viewer) {
    if (
      typeof document !== 'undefined' &&
      document.body?.classList.contains('cockpit-mode')
    )
      return CCTV_FOCUS_RESULT.COCKPIT_ACTIVE;
    return isFollowing(viewer) ? CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW : null;
  }

  /**
   * Flies the viewer's camera to frame the specified CCTV camera,
   * looking along its heading from above.
   * @param {object|null} viewer The viewer that owns the camera.
   * @param {Object|null} record CCTV camera runtime record.
   * @param {number} [duration=2.2] - Flight duration in seconds.
   * @returns {'focused'|'no-active-camera'|'tracking-holds-view'|'cockpit-active'} Focus result.
   */

  function focusCctvRecord(viewer, record, duration = 2.2) {
    if (!viewer || !record) return CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    const held = viewHeldBy(viewer);
    if (held === CCTV_FOCUS_RESULT.COCKPIT_ACTIVE) {
      console.debug('[Data:CCTV] focus ignored while cockpit owns the camera');
      return CCTV_FOCUS_RESULT.COCKPIT_ACTIVE;
    }
    if (held === CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW) {
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
    cameraOf(viewer).flyToBounds(
      { center: record.position, radius: Math.max(40, camera.rangeM * 0.36) },
      {
        offset: {
          heading: parts.model.toRad(camera.headingDeg),
          pitch: parts.model.toRad(-22),
          range,
        },
        durationS: Math.max(0.2, duration || 0),
        easing: 'cubicInOut',
      },
    );
    return CCTV_FOCUS_RESULT.FOCUSED;
  }

  /** The nearest ground cell with two or more cameras, or the group itself if unmerged. */
  function nearestPart(cell, eye) {
    let nearest = cell;
    let best = Infinity;
    for (const part of cell.parts ?? []) {
      if (part.count < 2) continue;
      const d = distance(eye, cellCenter(part));
      if (d < best) {
        best = d;
        nearest = part;
      }
    }
    return nearest;
  }

  /** Frame a group's padded bounds from above, including coincident mounts. */
  function zoomToCell(cell) {
    const viewer = layerState._viewer;
    if (!viewer || viewHeldBy(viewer)) return;
    const camera = cameraOf(viewer);
    const pose = camera.pose();
    const tanHalfY = Math.tan((pose.fovy || Math.PI / 3) / 2);
    const canvas = canvasOf(viewer);
    const height = canvas?.clientHeight || canvas?.height || 1;
    // Half the range where cells stop grouping, so even coincident mounts split.
    const closeRange =
      (VIEW_MIN_CELL_M * height) / (4 * VIEW_CELL_PX * tanHalfY);
    const tanHalfX = tanHalfY * (pose.aspectRatio || 1);
    // Range where a cell's ground extent, times `pad`, fits the frame at the
    // depth of its highest mount above the bounds centre.
    const extentRange = (target, bounds, pad = 1) => {
      const { halfWidthM, halfHeightM } = cellHalfExtents(target);
      const rise = Math.max(0, target.high - toLonLatH(bounds.center).height);
      return (
        rise + pad * Math.max(halfWidthM / tanHalfX, halfHeightM / tanHalfY)
      );
    };
    // The sphere fit spans the wider side, so a very wide window also needs the extent.
    const fitRange = (target, bounds) =>
      Math.max(
        closeRange,
        rangeForBoundingSphere(viewer, bounds.radius),
        extentRange(target, bounds, 1.2),
      );
    // Approach long groups in halves so every click gets closer.
    const halfway = (bounds) =>
      pose.position ? distance(pose.position, bounds.center) / 2 : Infinity;
    let bounds = cellBounds(cell);
    let range = Math.min(halfway(bounds), fitRange(cell, bounds));
    // If the group overflows the frame at that range, approach its nearest counted cell.
    if (range < extentRange(cell, bounds)) {
      const part = nearestPart(cell, pose.position);
      bounds = cellBounds(part);
      range = Math.min(halfway(bounds), fitRange(part, bounds));
    }
    camera.flyToBounds(bounds, {
      offset: { heading: 0, pitch: -Math.PI / 2, range },
      durationS: 1.2,
      easing: 'cubicInOut',
    });
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
    nearestCameraIdToPoint,
    nearestCameraIdToViewer,
    openingCameraId,
    reopenNearestCamera,
    focusCctvRecord,
    zoomToCell,
    focusCamera,
    maybeAutoHop,
    cctvCycleIndex,
  };
}
