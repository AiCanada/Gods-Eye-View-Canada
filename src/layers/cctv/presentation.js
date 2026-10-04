import { CCTV_AMBIENT_CARD_MAX } from '../../data/cctvLod.js';
import {
  CCTV_FRAME_CANVAS_W,
  CCTV_FRAME_CANVAS_H,
  applyFrameResult,
} from '../../data/cctvCards.js';
import {
  browserDirectFrameUrl,
  isBrowserDirect,
} from '../../data/cctvBrowserDirect.js';
import {
  CCTV_AREA_LOAD_CAP,
  CCTV_AREA_RADIUS_KM,
  VIDEO_PREVIEW_REFRESH_MS,
} from './policy.js';
import { headingHudToken, isHeadingEstimated } from './headingConfidence.js';

export function createPresentation({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Builds a single-line summary string for the active camera, including city,
   * heading, FOV, coverage area, overlap count, projection mode, alignment
   * confidence, source type, and view context.
   * @returns {string} Summary text separated by mid-dots.
   */

  function buildSummaryText() {
    const active = parts.selection.getActiveRecord();
    if (!active) {
      return layerState._records.length
        ? `${layerState._records.length} CAMERAS STANDING BY · NO CAMERA SELECTED · CLICK A CAMERA TO ACTIVATE`
        : 'No cameras available in catalog.';
    }

    const area = parts.model.sectorAreaKm2(
      active.camera.rangeM,
      active.camera.fovDeg,
    );
    const overlapCount = parts.geometry.coverageNeighborCount(active);
    const viewKey = parts.model.currentViewContext();
    const viewBand = viewKey.split(':')[0] || 'global';
    const health = layerState._healthById.get(active.camera.id) || null;
    const calBadge = parts.calibration.deriveCalBadge(active.camera);

    return [
      `${active.camera.city.toUpperCase()} CCTV`,
      `${active.camera.name.toUpperCase()}`,
      // A synthetic bearing (headingConfidence 'low', no human calibration)
      // is tagged so a hashed guess never reads as a surveyed facing (#639).
      headingHudToken(active.camera),
      `FOV ${Math.round(active.camera.fovDeg)}°`,
      `COVERAGE ${area.toFixed(2)}km²`,
      overlapCount > 0 ? `OVERLAP ${overlapCount} cams` : 'ISOLATED VIEW',
      `PROJ ${layerState._showProjection ? 'MONITOR' : 'OFF'}`,
      layerState._coverageMode === 'viewshed' ? 'VIEWSHED' : null,
      `CAL ${calBadge.replace('-', ' ').toUpperCase()}`,
      health?.sourceKind
        ? `SRC ${String(health.sourceKind).toUpperCase()}`
        : `SRC ${String(active.camera.feedType || 'image').toUpperCase()}`,
      `${viewBand.toUpperCase()} CONTEXT`,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /**
   * A JPEG (data URL) of a video camera's current picture for the panel's
   * <img>, taken from the video its monitor plane plays. Same-origin video
   * through the proxy, so the canvas can be read. Null until the video has a
   * picture. The same picture becomes the camera's map thumbnail.
   * @param {Object} record
   * @returns {string|null}
   */

  function videoPreviewUrlFor(record) {
    const runtime = record?.projection;
    const video = runtime?.video;
    const id = record?.camera?.id || '';
    const held = () =>
      layerState._videoPreview.id === id
        ? layerState._videoPreview.url || null
        : null;
    if (!video || !(video.readyState >= 2) || !(video.videoWidth > 0)) {
      return held();
    }
    const now = Date.now();
    if (
      layerState._videoPreview.id === id &&
      layerState._videoPreview.url &&
      now - layerState._videoPreview.at < VIDEO_PREVIEW_REFRESH_MS
    ) {
      return layerState._videoPreview.url;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
      ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
      // A stream's first drawable frames are blank (fully transparent) for a
      // moment after it starts. A blank is not a picture: keep the prior one.
      const probe = ctx2d.getImageData(0, 0, canvas.width, 8).data;
      let seen = 0;
      for (let i = 3; i < probe.length; i += 4) seen += probe[i];
      if (seen === 0) return held();
      layerState._videoPreview = {
        id,
        at: now,
        url: canvas.toDataURL('image/jpeg', 0.82),
      };
      // The same picture is this camera's thumbnail from now on.
      const card = document.createElement('canvas');
      card.width = CCTV_FRAME_CANVAS_W;
      card.height = CCTV_FRAME_CANVAS_H;
      card.getContext('2d').drawImage(video, 0, 0, card.width, card.height);
      const slot = parts.cards.ensureCardFrameSlot(id);
      Object.assign(
        slot,
        applyFrameResult(slot, { ok: true, frame: card }, now),
      );
    } catch {
      return held();
    }
    return layerState._videoPreview.url;
  }

  /**
   * Builds a public-facing camera state object for UI consumption.
   * Includes all pose, calibration, CAL badge, projection, and feed metadata.
   * @param {Object} record - Camera record.
   * @param {string|null} [activeId=null] - Active camera ID for the `active` flag.
   * @returns {Object} Public camera state.
   */

  function getPublicCameraState(record, activeId = null) {
    const resolvedActiveId =
      activeId || parts.selection.getActiveRecord()?.camera.id || null;
    const camera = record.camera;
    const health = layerState._healthById.get(camera.id) || null;
    const isActive = camera.id === resolvedActiveId;
    const refreshMs = isActive
      ? parts.frames.activeFrameRefreshMsFor(camera)
      : parts.frames.idleFrameRefreshMsFor(camera);
    const hasStill = parts.model.cameraHasStill(camera);
    // A video whose playback failed falls back to stills (projection.js).
    const videoFeed =
      parts.model.isVideoFeedType(
        parts.model.normalizeFeedType(camera.feedType),
      ) && record.projection?.mode !== 'image';
    return {
      id: camera.id,
      name: camera.name,
      city: camera.city,
      provider: camera.provider,
      lat: camera.lat,
      lon: camera.lon,
      headingDeg: camera.headingDeg,
      // Bearing provenance (#639): the pack's confidence flag plus the derived
      // "is this a synthetic guess" bit (calibration-aware), so UI consumers
      // never have to re-derive it.
      headingConfidence: camera.headingConfidence || null,
      headingEstimated: isHeadingEstimated(camera),
      pitchDeg: camera.pitchDeg,
      fovDeg: camera.fovDeg,
      rangeM: camera.rangeM,
      elevationM: camera.absoluteHeightM,
      mountHeightM: camera.mountHeightM,
      active: isActive,
      feedType: camera.feedType,
      isVideo:
        parts.model.isVideoFeedType(camera.feedType) &&
        record.projection?.mode !== 'image',
      sourceKind:
        health?.sourceKind ||
        camera.sourceKind ||
        (camera.feedConfigured ? 'configured' : 'seed'),
      sourceStatus: health?.status || 'unknown',
      sourceMessage: health?.message || '',
      sourceLabel: health?.label || camera.provider || '',
      credit: camera.credit || '',
      calibration: {
        ...parts.calibration.normalizeCalibration(camera.calibration),
      },
      // Save-gated persistence (design §3e): true while the live pose carries
      // edits that have not been SAVEd (or RESET). Drives the CAL · EDITED chip.
      calDirty: !!record.calDirty,
      // Deterministic QA seam: counts commit-grade anchor resolutions (E/N drag
      // release, numeric E/N edit, or reset), never transient gizmo moves.
      groundResolveCount: record.calibrationGroundResolveCount || 0,
      // Per-record QA seam for proving transient gizmo moves never enter the
      // shared mesh-floor sampler while unrelated catalog cells finish.
      groundMeshSampleRequestCount: record.groundMeshSampleRequestCount || 0,
      // Datum QA seam: expose the immutable Re:Earth ellipsoidal prior
      // separately from the currently applied frustum ground. Google-3D may
      // legitimately refine the latter to the rendered mesh, so callers must
      // not infer the prior by subtracting mount height from live geometry.
      groundPriorM: Number.isFinite(record.groundPrior?.ellipsoid)
        ? record.groundPrior.ellipsoid
        : null,
      intrinsics: camera.intrinsics ? { ...camera.intrinsics } : null,
      extrinsics: camera.extrinsics ? { ...camera.extrinsics } : null,
      anchor: camera.anchor ? { ...camera.anchor } : null,
      // Panel-only trust signal (design §3b, amended by LOCKED §9.2/§9.3): no
      // in-world rendering reads this, no score-based quality math backs it.
      calBadge: parts.calibration.deriveCalBadge(camera),
      poseSource: camera.poseSource || null,
      basePose: camera.basePose ? { ...camera.basePose } : null,
      // A browser-direct camera's still comes straight from its operator into
      // the panel's <img>; every other camera goes through the proxy, and only
      // the active camera's preview asks as active. A camera with no public
      // still has no frame to request: the panel shows its lookup note
      // instead. A video camera has no still on the server: the panel's <img>
      // gets a picture taken from the video already playing on its monitor
      // plane (the panel may also paint the video itself, getActiveVideoElement).
      frameUrl: !hasStill
        ? null
        : videoFeed
          ? videoPreviewUrlFor(record)
          : isBrowserDirect(camera)
            ? browserDirectFrameUrl(camera, refreshMs)
            : parts.frames.frameUrlFor(camera, refreshMs, { active: isActive }),
      mediaUrl: hasStill ? parts.frames.mediaUrlFor(camera) : null,
      lookup: camera.lookup || '',
      lookupState: camera.lookupState || '',
      lookupPending: layerState._lookupRequests.has(camera.id),
      lookupNote: parts.lookup.cameraLookupNote(camera),
      lookupBadge: parts.lookup.cameraLookupBadge(camera),
    };
  }

  /**
   * The area as the panel chip reads it: the server's report for the loaded
   * area plus whether a load is in flight.
   * @returns {Object}
   */

  function areaUiState() {
    const area = layerState._area || {};
    const { safeNumber } = parts.model;
    return {
      loading: Boolean(layerState._areaRequest),
      ready: Boolean(layerState._area),
      lat: Number.isFinite(area.lat) ? area.lat : null,
      lon: Number.isFinite(area.lon) ? area.lon : null,
      radiusKm: safeNumber(area.radiusKm, CCTV_AREA_RADIUS_KM),
      limit: safeNumber(area.limit, CCTV_AREA_LOAD_CAP),
      inArea: safeNumber(area.inArea, 0),
      loaded: safeNumber(area.loaded, 0),
      dropped: safeNumber(area.dropped, 0),
      reachKm: safeNumber(area.reachKm, 0),
      capped: area.capped === true,
      total: safeNumber(area.total, 0),
      pending: Array.isArray(area.pending) ? [...area.pending] : [],
    };
  }

  /**
   * Light per-camera entries for the dropdown and voice matching, rebuilt only
   * when the catalogue version changes (not on every notify). Full per-camera
   * state stays available through getCameraState(id).
   * @returns {ReadonlyArray<Object>}
   */

  function lightCameraEntries() {
    if (layerState._camerasCache.version !== layerState._catalogVersion) {
      layerState._camerasCache = {
        version: layerState._catalogVersion,
        cameras: Object.freeze(
          layerState._records.map(({ camera }) =>
            Object.freeze({
              id: camera.id,
              name: camera.name,
              city: camera.city,
              provider: camera.provider,
              lat: camera.basePose?.lat ?? camera.lat,
              lon: camera.basePose?.lon ?? camera.lon,
              feedType: camera.feedType,
              sourceKind: camera.sourceKind,
              lookup: camera.lookup || '',
              lookupState: camera.lookupState || '',
            }),
          ),
        ),
      };
    }
    return layerState._camerasCache.cameras;
  }

  /**
   * Assembles the full UI state payload containing layer toggles, camera list,
   * active camera details, summary text, and error state.
   * @returns {Object} Complete UI state for subscribers.
   */

  function uiState() {
    const active = parts.selection.getActiveRecord();
    const activeId = active?.camera.id || null;
    const payload = {
      enabled: layerState._enabled,
      // Compat boolean + the full tri-state (viewshed design §3b).
      showCoverage: layerState._coverageMode !== 'off',
      coverageMode: layerState._coverageMode,
      showProjection: layerState._showProjection,
      calibrationMode: layerState._calibrationMode,
      autoHop: layerState._autoHop,
      autoHopSuspended: layerState._autoHopSuspended,
      autoHopSec: layerState._autoHopSec,
      // The loaded camera area (at most 1,000 within 50 km of one place).
      area: areaUiState(),
      count: layerState._count,
      lastUpdate: layerState._lastUpdate,
      error: layerState._lastError,
      loading: {
        active: layerState._geoLoading,
        loaded: Math.min(layerState._geoLoadDone, layerState._geoLoadTotal),
        total: layerState._geoLoadTotal,
      },
      // Ambient card tier telemetry (QA harnesses assert the fetch pacing —
      // minFrameFetchSpacingMs reads together with fetchMode: cold-fill bursts
      // legitimately reach the burst spacing, steady state stays >=1000 ms).
      ambientCards: {
        count: layerState._cardIds.size,
        limit: CCTV_AMBIENT_CARD_MAX,
        frameFetches: layerState._cardFetchCount,
        minFrameFetchSpacingMs: layerState._cardMinFetchSpacingMs,
        fetchMode: layerState._cardFetchMode,
        fetchesInFlight: layerState._cardFetchInFlightCount,
        // Item B QA seam: the hover-summoned pinned card, if any.
        hoverId: layerState._hoverCardId,
      },
      activeCameraId: activeId,
      activeCamera: active ? getPublicCameraState(active, activeId) : null,
      cameras: lightCameraEntries(),
      summary: buildSummaryText(),
    };
    return payload;
  }

  /** Dispatches the current UI state to all registered subscriber callbacks. */

  function notifyListeners() {
    const payload = uiState();
    for (const callback of layerState._listeners) {
      try {
        callback(payload);
      } catch (error) {
        console.warn('[Data:CCTV] listener error:', error);
      }
    }
  }

  /**
   * Throttled notifyListeners for transient (mid-drag) calibration patches —
   * the panel re-render is DOM-heavy, so live gizmo drags publish state at
   * ≤10 Hz while the in-world geometry still tracks every processed move.
   */

  function notifyListenersThrottled() {
    const now = Date.now();
    if (now - layerState._lastTransientNotifyAt < 100) return;
    layerState._lastTransientNotifyAt = now;
    notifyListeners();
  }
  return {
    buildSummaryText,
    getPublicCameraState,
    videoPreviewUrlFor,
    areaUiState,
    lightCameraEntries,
    uiState,
    notifyListeners,
    notifyListenersThrottled,
  };
}
