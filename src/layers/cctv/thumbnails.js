import * as Cesium from 'cesium';
import { CCTV_OVERLAY_SOURCE_ID } from '../../data/cctvCards.js';
import { trafficPlaneSpec } from './projection.js';
import {
  PRIVATE_POSITION_ENDPOINT,
  SIGHT_LINE_HIT_JITTER_MS,
  SIGHT_LINE_HIT_TTL_MS,
  THUMBNAIL_FRAME_RECHECK_MS,
} from './policy.js';

/**
 * Where the map thumbnails stand: on the spot the camera's spatial picture
 * opens (so nothing jumps when one is clicked), on the road by a road-matched
 * camera, or where the user aligned it by hand (right-click a thumbnail, move
 * and turn it, right-click again to save to
 * config/cctv_thumbnail_alignments.json). Also the private (home or business)
 * camera icon drag.
 */
export function createThumbnails({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  // The traffic layer's road lines and the monitor-plane projector, supplied
  // by the application (src/app/layers/cctv.js).
  const pictureTraffic = services.pictureTraffic || {};
  const getRoadsRevision = () => pictureTraffic.getRoadsRevision?.() ?? 0;
  const roadBearingNear = (lat, lon) =>
    pictureTraffic.roadBearingNear?.(lat, lon) || null;
  const monitorPlaneFrame = (spec) =>
    pictureTraffic.monitorPlaneFrame?.(spec) || null;
  const sightLineHits = new WeakMap();
  const roadSpots = new WeakMap();
  /** Projection frames for thumbnail traffic, rebuilt only when a pose or its ground changes. */
  const thumbnailTrafficFrames = new WeakMap();
  const alignmentSpots = new WeakMap();

  /** The record's sight line against the loaded terrain, re-read every few seconds. */

  function terrainSightLineHitM(record) {
    const globe = layerState._viewer?.scene?.globe;
    if (!globe?.show || typeof globe.getHeight !== 'function') return null;
    const now = Date.now();
    const cached = sightLineHits.get(record);
    const camera = record.camera;
    const key = parts.geometry.probePoseKey(camera);
    if (cached && cached.key === key && now < cached.until) return cached.hitM;
    let hitM = null;
    try {
      const { toRad, clamp, safeNumber } = parts.model;
      const pitchRad = toRad(clamp(safeNumber(camera.pitchDeg, -17), -89, 89));
      const horizontal = Math.cos(pitchRad);
      const carto = new Cesium.Cartographic();
      hitM = parts.geometry.sightLineGroundHitM({
        mountAltM:
          parts.ground.groundAltFor(record) +
          safeNumber(camera.mountHeightM, 24),
        pitchRad,
        // The whole pose range: a line that is clear for the part that was
        // read is not clear for the part that was not.
        maxM: Math.max(1, safeNumber(camera.rangeM, 700)),
        heightAt: (distanceM) => {
          const at = parts.model.projectPoint(
            camera.lat,
            camera.lon,
            camera.headingDeg,
            distanceM * horizontal,
          );
          return globe.getHeight(
            Cesium.Cartographic.fromDegrees(at.lon, at.lat, 0, carto),
          );
        },
      });
    } catch {
      hitM = null;
    }
    // Whole metres: terrain refining by centimetres must not move the card.
    if (Number.isFinite(hitM)) hitM = Math.round(hitM);
    sightLineHits.set(record, {
      key,
      hitM,
      until:
        now + SIGHT_LINE_HIT_TTL_MS + Math.random() * SIGHT_LINE_HIT_JITTER_MS,
    });
    return hitM;
  }

  /** The record's near-field road spot as a world position, re-derived about once a second. */

  function thumbnailRoadSpot(record) {
    const camera = record?.camera;
    if (!camera) return null;
    const held = roadSpots.get(record);
    const nowMs = Date.now();
    const roadsRevision = getRoadsRevision();
    if (
      held &&
      nowMs < held.recheckAt &&
      held.roadsRevision === roadsRevision &&
      held.positions === (record.frustumPositions || null)
    )
      return held.spot;
    let spot = null;
    try {
      const near = parts.geometry.nearFieldRoadSpot(camera);
      if (near) {
        // The real road by the camera (the traffic layer's road lines), when loaded.
        const road = roadBearingNear(camera.lat, camera.lon);
        const direction = parts.geometry.roadMatchDirection({
          headingDeg: camera.headingDeg,
          headingKnown: camera.headingConfidence !== 'unknown',
          roadBearingDeg: road ? road.bearingDeg : null,
        });
        // On the road's own line when the road decided the direction;
        // otherwise straight ahead of the mount. An ambiguous camera stands ON
        // the road by the camera: which way is "ahead" is exactly what is not
        // known.
        const from = direction?.onRoad ? road : camera;
        const along = direction ? direction.alongDeg : camera.headingDeg;
        const at = parts.model.projectPoint(
          from.lat,
          from.lon,
          along,
          direction?.ambiguous ? 0 : near.forwardM,
        );
        const ahead = direction
          ? parts.model.projectPoint(at.lat, at.lon, along, 40)
          : null;
        // The loaded terrain under that point when there is any, else the
        // mount's ground.
        const globe = layerState._viewer?.scene?.globe;
        const heightAt = (point) => {
          const terrain =
            globe?.show && typeof globe.getHeight === 'function'
              ? globe.getHeight(
                  Cesium.Cartographic.fromDegrees(point.lon, point.lat),
                )
              : undefined;
          return Number.isFinite(terrain)
            ? terrain
            : parts.ground.groundAltFor(record);
        };
        spot = {
          position: Cesium.Cartesian3.fromDegrees(at.lon, at.lat, heightAt(at)),
          // A second point farther along the road: the painter turns the card
          // so "up the picture" runs from the first point toward this one.
          ahead: ahead
            ? Cesium.Cartesian3.fromDegrees(
                ahead.lon,
                ahead.lat,
                heightAt(ahead),
              )
            : null,
          ambiguous: Boolean(direction?.ambiguous),
          widthM: near.widthM,
        };
      }
    } catch {
      spot = null;
    }
    roadSpots.set(record, {
      spot,
      roadsRevision,
      positions: record.frustumPositions || null,
      recheckAt:
        nowMs +
        THUMBNAIL_FRAME_RECHECK_MS +
        Math.random() * THUMBNAIL_FRAME_RECHECK_MS,
    });
    return spot;
  }

  /**
   * Where a camera's spatial picture opens, for standing its thumbnail on that
   * same spot. Every camera has one, a camera of unknown heading included: its
   * picture opens along its placeholder bearing, and a thumbnail anywhere else
   * would jump when clicked (385 of Québec 511's 678 cameras are such).
   * @param {string} cameraId
   * @returns {object|null}
   */

  function thumbnailTrafficFrame(cameraId) {
    const record = layerState._recordById.get(cameraId);
    const camera = record?.camera;
    if (!camera) return null;
    // Called every frame for every card. Everything that moves the picture
    // replaces one of these three references (geometry rewrite, activation
    // clamp, remembered probe), so comparing them is the whole steady-state
    // cost; the full check below runs about once a second per card.
    const held = thumbnailTrafficFrames.get(record);
    const nowMs = Date.now();
    if (
      held &&
      nowMs < held.recheckAt &&
      held.positions === (record.frustumPositions || null) &&
      held.clamp === record.probeClampRangeM &&
      held.lastProbe === (record.lastProbe || null)
    )
      return held.frame;
    // An idle record's own geometry runs to the full pose range; the picture
    // will not open there (see expectedMonitorRangeM), so the frame is built at
    // the range it WILL open at, from the same ground the record's geometry
    // used.
    const live = Number.isFinite(record.probeClampRangeM);
    const probed =
      record.lastProbe?.key === parts.geometry.probePoseKey(camera)
        ? record.lastProbe
        : null;
    const expectedRangeM = parts.geometry.expectedMonitorRangeM(camera, {
      liveClampM: record.probeClampRangeM,
      probed,
      groundHitM: live || probed ? null : terrainSightLineHitM(record),
    });
    const useRecordGeometry = live || expectedRangeM == null;
    const groundAlt = Number.isFinite(record.frustumGeometry?.groundAltM)
      ? record.frustumGeometry.groundAltM
      : parts.ground.groundAltFor(record);
    const key = [
      camera.lat,
      camera.lon,
      camera.headingDeg,
      camera.pitchDeg,
      camera.fovDeg,
      camera.rangeM,
      camera.mountHeightM,
      groundAlt,
      expectedRangeM,
      useRecordGeometry,
    ].join('|');
    const cached = held;
    // The record's geometry is REPLACED whenever it is rewritten (ground snap,
    // activation range clamp, calibration), sometimes from a ground sample
    // this key never sees. Its identity is the reliable staleness test: a
    // frame built from an older geometry stands where the picture used to be.
    if (
      cached?.key === key &&
      cached.positions === (record.frustumPositions || null)
    ) {
      cached.recheckAt =
        nowMs +
        THUMBNAIL_FRAME_RECHECK_MS +
        Math.random() * THUMBNAIL_FRAME_RECHECK_MS;
      cached.clamp = record.probeClampRangeM;
      cached.lastProbe = record.lastProbe || null;
      return cached.frame;
    }
    let frame = null;
    try {
      const geometry =
        (useRecordGeometry && record.frustumGeometry) ||
        parts.geometry.computeFrustumGeometry(
          camera,
          groundAlt,
          expectedRangeM,
        );
      const positions =
        (useRecordGeometry &&
          record.frustumGeometry &&
          record.frustumPositions) ||
        parts.geometry.frustumCartesians(geometry);
      frame = monitorPlaneFrame(
        trafficPlaneSpec(
          geometry,
          positions,
          parts.model.planeOrientationFor(camera, positions.capCenter),
        ),
      );
    } catch {
      frame = null;
    }
    thumbnailTrafficFrames.set(record, {
      key,
      frame,
      positions: record.frustumPositions || null,
      clamp: record.probeClampRangeM,
      lastProbe: record.lastProbe || null,
      recheckAt:
        nowMs +
        THUMBNAIL_FRAME_RECHECK_MS +
        Math.random() * THUMBNAIL_FRAME_RECHECK_MS,
    });
    return frame;
  }

  // -------------------------------------------------------------------------
  // Hand alignment (right-click a thumbnail; cctvCardAlign.js)
  // -------------------------------------------------------------------------

  /** Load the saved thumbnail alignments once per init. */

  async function loadThumbnailAlignments() {
    if (layerState._thumbAlignmentsLoaded) return;
    layerState._thumbAlignmentsLoaded = true;
    try {
      const response = await fetch('/api/cctv/alignments', {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const next = new Map();
      for (const [id, a] of Object.entries(data?.alignments || {})) {
        if (Number.isFinite(a?.lat) && Number.isFinite(a?.lon)) {
          next.set(id, {
            lat: a.lat,
            lon: a.lon,
            bearingDeg: Number.isFinite(a.bearingDeg) ? a.bearingDeg : null,
          });
        }
      }
      layerState._thumbAlignments = next;
      if (next.size) parts.cards.pushAmbientCardEntries();
    } catch (error) {
      layerState._thumbAlignmentsLoaded = false;
      console.warn(
        '[Data:CCTV] saved thumbnail alignments unavailable:',
        error?.message || error,
      );
    }
  }

  /** The alignment in force for a camera: the draft while it is being aligned, else the saved one. */

  function thumbnailAlignmentFor(id) {
    return layerState._alignSession?.id === id
      ? layerState._alignSession.draft
      : layerState._thumbAlignments.get(id) || null;
  }

  /** World points for an alignment: where the picture's middle stands, and a point "up the picture". */

  function alignmentSpot(record, alignment) {
    const held = alignmentSpots.get(alignment);
    const nowMs = Date.now();
    if (held && nowMs < held.recheckAt) return held;
    const globe = layerState._viewer?.scene?.globe;
    const heightAt = (lat, lon) => {
      const terrain =
        globe?.show && typeof globe.getHeight === 'function'
          ? globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat))
          : undefined;
      return Number.isFinite(terrain)
        ? terrain
        : parts.ground.groundAltFor(record);
    };
    const spot = {
      position: Cesium.Cartesian3.fromDegrees(
        alignment.lon,
        alignment.lat,
        heightAt(alignment.lat, alignment.lon),
      ),
      ahead: null,
      recheckAt: nowMs + 2000,
    };
    if (Number.isFinite(alignment.bearingDeg)) {
      const ahead = parts.model.projectPoint(
        alignment.lat,
        alignment.lon,
        alignment.bearingDeg,
        40,
      );
      spot.ahead = Cesium.Cartesian3.fromDegrees(
        ahead.lon,
        ahead.lat,
        heightAt(ahead.lat, ahead.lon),
      );
    }
    alignmentSpots.set(alignment, spot);
    return spot;
  }

  /** Start aligning a thumbnail from wherever it stands now. */

  function beginThumbnailAlign(id, anchor) {
    if (layerState._alignSession || !layerState._recordById.has(id))
      return false;
    const saved = layerState._thumbAlignments.get(id);
    let draft = saved ? { ...saved } : null;
    if (!draft) {
      const ground = privateGlobePoint(anchor.x, anchor.y);
      if (!ground) return false;
      draft = { lat: ground.lat, lon: ground.lon, bearingDeg: null };
    }
    layerState._alignSession = { id, draft, saving: false };
    holdContinuousRender('cctv-card-align');
    parts.cards.pushAmbientCardEntries();
    return true;
  }

  function endThumbnailAlign() {
    if (!layerState._alignSession) return;
    layerState._alignSession = null;
    releaseContinuousRender('cctv-card-align');
    parts.cards.pushAmbientCardEntries();
  }

  /** Write the draft to the tracked alignment file through the dev server. */

  async function saveThumbnailAlign() {
    const session = layerState._alignSession;
    if (!session || session.saving) return;
    session.saving = true;
    const { id, draft } = session;
    // In force at once, saved or not: a failed save still holds for this session.
    layerState._thumbAlignments.set(id, { ...draft });
    try {
      const response = await fetch(
        `/api/cctv/alignments/${encodeURIComponent(id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const saved = (await response.json())?.alignment;
      if (saved) layerState._thumbAlignments.set(id, saved);
      console.info(
        `[Data:CCTV] thumbnail alignment saved for ${id} (config/cctv_thumbnail_alignments.json)`,
      );
    } catch (error) {
      console.warn(
        `[Data:CCTV] thumbnail alignment for ${id} could not be saved; it holds for this session only:`,
        error?.message || error,
      );
    }
    if (layerState._alignSession === session) endThumbnailAlign();
  }

  /** Forget a camera's saved alignment: back to where the program places it, upright. */

  async function resetThumbnailAlign() {
    const session = layerState._alignSession;
    if (!session) return;
    const { id } = session;
    layerState._thumbAlignments.delete(id);
    endThumbnailAlign();
    try {
      await fetch(`/api/cctv/alignments/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    } catch (error) {
      console.warn(
        `[Data:CCTV] saved alignment for ${id} could not be removed:`,
        error?.message || error,
      );
    }
  }

  /** The ambient card under a canvas point (size badge, alignment), not the click-selection path. */

  function hitTestAmbientCard(x, y) {
    return layerState._cctvOverlayHost.hitTest(x, y, {
      sourceId: CCTV_OVERLAY_SOURCE_ID,
    });
  }

  /** Globe position under a canvas point: the rendered surface when depth picking works, the ellipsoid otherwise. */

  function privateGlobePoint(x, y) {
    if (!layerState._viewer || layerState._viewer.isDestroyed()) return null;
    const windowPosition = new Cesium.Cartesian2(x, y);
    const scene = layerState._viewer.scene;
    let cartesian = scene.pickPositionSupported
      ? scene.pickPosition(windowPosition)
      : undefined;
    if (!Cesium.defined(cartesian))
      cartesian = layerState._viewer.camera.pickEllipsoid(
        windowPosition,
        scene.globe.ellipsoid,
      );
    if (!Cesium.defined(cartesian)) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  // -------------------------------------------------------------------------
  // Private camera move (cctvPrivateMove.js)
  // -------------------------------------------------------------------------

  /** While a private camera is dragged, only its icon follows the pointer; the cone waits for the drop. */

  function previewPrivateCameraMove(id, point) {
    const record = layerState._recordById.get(id);
    if (!record?.billboard || !point) return;
    record.billboard.position = Cesium.Cartesian3.fromDegrees(
      point.lon,
      point.lat,
      record.camera.absoluteHeightM,
    );
  }

  /** On drop: move the camera in place (icon, cone and ground) and save its new spot. */

  async function commitPrivateCameraMove(id, point) {
    const record = layerState._recordById.get(id);
    if (!record) return;
    if (!point) {
      parts.geometry.updateRecordGeometry(record);
      return;
    }
    record.camera.basePose = {
      ...(record.camera.basePose || {}),
      lat: point.lat,
      lon: point.lon,
    };
    parts.model.ensureCameraPose(record.camera);
    parts.ground.resolveCommittedGroundAnchor(record);
    parts.rendering.refreshCoverageStyles();
    parts.presentation.notifyListeners();
    try {
      const response = await fetch(PRIVATE_POSITION_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, lat: point.lat, lon: point.lon }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.warn(
        '[Data:CCTV] could not save the moved camera; restoring its saved spot:',
        error?.message || error,
      );
      parts.area.scheduleCatalogReload();
    }
  }

  return {
    terrainSightLineHitM,
    thumbnailRoadSpot,
    thumbnailTrafficFrame,
    loadThumbnailAlignments,
    thumbnailAlignmentFor,
    alignmentSpot,
    beginThumbnailAlign,
    endThumbnailAlign,
    saveThumbnailAlign,
    resetThumbnailAlign,
    hitTestAmbientCard,
    privateGlobePoint,
    previewPrivateCameraMove,
    commitPrivateCameraMove,
  };
}
