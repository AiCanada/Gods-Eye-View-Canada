import { attachCctvVideo } from './videoPlayback.js';
import {
  CCTV_PROJECTION_OVERLAY_SOURCE_ID,
  CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
  PLANE_OUTLINE_COLOR,
  PROJECTION_CANVAS_WIDTH,
  PROJECTION_CANVAS_HEIGHT,
  PROJECTION_PLANE_ALPHA,
} from './policy.js';

/**
 * Image currently bound to the monitor plane (video element or canvas buffer).
 * @param {Object} runtime - Projection runtime.
 * @returns {HTMLCanvasElement|HTMLVideoElement|*}
 */
export function projectionImageSource(runtime) {
  // A video drawn through the canvas buffers (`viaCanvas`) is textured like a still.
  if (runtime?.video && !runtime.viaCanvas) return runtime.video;
  // The buffer last swapped in, NOT the working canvas. The renderer reads a
  // canvas when a plane first names it, so only a newly named buffer shows new
  // pixels (see paintNextProjectionBuffer). A plane handed the one working
  // canvas uploaded it once, usually while it still held the placeholder: the
  // panel showed the camera's picture and the map showed a dark plane.
  const buffer = runtime?.buffers?.[runtime.bufferIndex];
  if (buffer) return buffer;
  if (runtime?.canvas) return runtime.canvas;
  const source = runtime?.planeSource;
  return source?.video || source?.canvas || source?.image || null;
}

/**
 * What the traffic projector needs to know about a monitor plane: where the
 * camera is mounted, where the picture stands, how it is turned, how big it is.
 */
export function trafficPlaneSpec(geometry, positions, orientation) {
  return {
    mount: positions.mount,
    center: positions.capCenter,
    orientation,
    halfW: geometry.halfW,
    halfH: geometry.halfH,
  };
}

/** A plain white image, for a plane with no media (tests). */
const WHITE_IMAGE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
      '<rect width="1" height="1" fill="#fff"/></svg>',
  );

/** Copy a position's coordinates into `out`. */
function copyPosition(from, out) {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
  return out;
}

export function createProjection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  /** Street traffic the active camera can see is drawn onto its open picture. */
  const setCctvTrafficPlane = (viewer, cameraId, spec) =>
    services.pictureTraffic?.setCctvTrafficPlane?.(viewer, cameraId, spec);

  /**
   * Build the protected label associated with one active monitor plane.
   * @param {{cameraId: string, name: string, position: object|Function}} input
   * @returns {Object} Shared-host presentation entry.
   */

  function createCctvProjectionOverlayEntry({ cameraId, name, position }) {
    return {
      id: String(cameraId),
      position,
      variant: 'selected',
      selected: true,
      protected: true,
      paintLane: 'selected',
      collisionGroup: 'ambient-card',
      priority: Number.MAX_SAFE_INTEGER - 1,
      title: String(name || cameraId || 'CAMERA'),
      details: [],
      accent: '#6be8ff',
      interactive: false,
      gapPx: 6,
      verticalOnly: true,
      placement: 'above',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
    };
  }

  /**
   * Re-derives the monitor plane's placement (position, orientation,
   * dimensions) + label from the record's current frustum geometry, so the plane
   * always caps the wireframe exactly (corner rays terminate on its corners).
   * No-op when the record has no plane runtime (idle neighbors have no plane).
   * @param {Object} record - Camera record.
   */

  function updatePlanePlacement(record) {
    const runtime = record?.projection;
    const plane = runtime?.plane;
    if (!plane) return;
    const geometry =
      record.frustumGeometry ||
      parts.geometry.computeFrustumGeometry(
        record.camera,
        parts.ground.groundAltFor(record),
        record.probeClampRangeM,
      );
    const positions =
      record.frustumPositions || parts.rendering.frustumCartesians(geometry);
    placePlane(plane, record.camera, geometry, positions);
    runtime.trafficPlane = trafficPlaneSpec(
      geometry,
      positions,
      plane.orientation,
    );
    // A calibration edit moves the picture; keep the projected traffic on it.
    if (plane.show) {
      setCctvTrafficPlane(
        layerState._viewer,
        runtime.cameraId,
        runtime.trafficPlane,
      );
    }
    if (runtime.labelPosition)
      copyPosition(positions.label, runtime.labelPosition);
    parts.drawSets.writePlane(plane);
  }

  /** Pose a plane handle on the frustum's far cap. */
  function placePlane(plane, camera, geometry, positions) {
    plane.center = positions.capCenter;
    plane.orientation = parts.model.planeOrientationFor(
      camera,
      positions.capCenter,
    );
    plane.size = [geometry.halfW * 2, geometry.halfH * 2];
  }

  /**
   * Give the monitor plane another image: a canvas, or the video element.
   * @param {Object} runtime - Projection runtime.
   * @param {{canvas: HTMLCanvasElement}|{video: HTMLVideoElement}} source
   */
  function setPlaneSource(runtime, source) {
    runtime.planeSource = source;
    if (!runtime.plane) return;
    runtime.plane.source = source;
    parts.drawSets.writePlane(runtime.plane);
  }

  /**
   * Clear the active monitor-plane label source and ownership marker.
   */

  function clearProjectionOverlay() {
    layerState._cctvOverlayHost.clearSource(CCTV_PROJECTION_OVERLAY_SOURCE_ID);
    layerState._cctvOverlayHost.setVisible(
      CCTV_PROJECTION_OVERLAY_SOURCE_ID,
      false,
    );
    layerState._projectionOverlayOwnerId = null;
  }

  /**
   * Shows/hides the monitor plane and its associated shared-host label.
   * @param {Object} runtime - Projection runtime.
   * @param {boolean} visible
   */

  function setPlaneVisible(runtime, visible) {
    if (!runtime) return;
    const show = !!visible;
    if (runtime.plane && runtime.plane.show !== show) {
      runtime.plane.show = show;
      parts.drawSets.writePlane(runtime.plane);
    }
    // Street traffic the camera can see is drawn onto its open picture.
    setCctvTrafficPlane(
      layerState._viewer,
      runtime.cameraId,
      show ? runtime.trafficPlane : null,
    );
    if (visible && runtime.overlayEntry && runtime.cameraId) {
      if (layerState._projectionOverlayOwnerId !== runtime.cameraId) {
        layerState._cctvOverlayHost.setEntries(
          CCTV_PROJECTION_OVERLAY_SOURCE_ID,
          [runtime.overlayEntry],
          CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
        );
        layerState._cctvOverlayHost.setVisible(
          CCTV_PROJECTION_OVERLAY_SOURCE_ID,
          true,
        );
        layerState._projectionOverlayOwnerId = runtime.cameraId;
      }
    } else if (layerState._projectionOverlayOwnerId === runtime.cameraId) {
      clearProjectionOverlay();
    }
  }

  /** A plain white plane image, for a plane with no media (tests). */
  function plainPlaneSource() {
    return { image: WHITE_IMAGE };
  }

  /** Create the monitor plane plus its cached host-label presentation. */

  function createProjectionPlane(record, runtime, geometry, positions) {
    runtime.labelPosition ||= { x: 0, y: 0, z: 0 };
    copyPosition(positions.label, runtime.labelPosition);
    runtime.cameraId = String(record.camera.id);
    runtime.overlayEntry = createCctvProjectionOverlayEntry({
      cameraId: runtime.cameraId,
      name: record.camera.name,
      position: () => runtime.labelPosition,
    });
    const plane = {
      id: `cctv-${record.camera.id}-plane`,
      cameraId: record.camera.id,
      source: runtime.planeSource || plainPlaneSource(),
      alpha: PROJECTION_PLANE_ALPHA,
      outline: { color: PLANE_OUTLINE_COLOR, widthPx: 1 },
      show: false,
    };
    placePlane(plane, record.camera, geometry, positions);
    runtime.trafficPlane = trafficPlaneSpec(
      geometry,
      positions,
      plane.orientation,
    );
    runtime.plane = plane;
    parts.drawSets.writePlane(plane);
    return plane;
  }

  /**
   * Plays a stream-only camera relayed by the server's own HLS proxy
   * (`hlsVia: 'proxy'`). Where the browser plays HLS natively the live
   * playlist plays directly (it never ends, so nothing loops or chains); a
   * proxied stream that fails may be played from the operator's own address
   * once (some operators serve an incomplete certificate chain the proxy cannot
   * verify and a browser can). Elsewhere the server cuts short MP4 clips: when
   * one ends the next loads in a second element, so the picture keeps moving
   * forward in time instead of replaying the same seconds.
   * @param {Object} record
   * @param {Object} runtime
   * @param {HTMLVideoElement} video
   */

  function playProxyStream(record, runtime, video) {
    video.autoplay = true;
    video.loop = false;
    video.addEventListener('canplay', () => {
      video.play().catch(() => {});
    });
    if (parts.model.nativeHlsSupported()) {
      video.addEventListener(
        'error',
        async () => {
          if (runtime.video !== video || runtime.triedDirectStream) return;
          runtime.triedDirectStream = true;
          try {
            const response = await fetch(
              `/api/cctv/stream/${encodeURIComponent(record.camera.id)}`,
              { cache: 'no-store' },
            );
            const direct = response.ok
              ? (await response.json())?.directStreamUrl
              : null;
            if (
              runtime.video !== video ||
              typeof direct !== 'string' ||
              !direct.startsWith('https://')
            )
              return;
            // A cross-origin stream draws to a canvas but does not survive
            // the renderer's direct video-texture path (the plane stayed
            // dark): texture the plane from the canvas buffers instead, which
            // this video is drawn into anyway.
            runtime.viaCanvas = true;
            runtime.lastSwappedCanvasStamp = -1;
            setPlaneSource(runtime, { canvas: runtime.canvas });
            video.src = direct;
            video.play().catch(() => {});
          } catch {
            /* no direct address: the plane keeps its note */
          }
        },
        { once: true },
      );
    } else {
      const discard = (element) => {
        try {
          element.pause();
          element.removeAttribute('src');
          element.load();
        } catch {
          /* already released */
        }
      };
      const queueNext = (current) => {
        current.addEventListener(
          'ended',
          () => {
            if (runtime.video !== current) return;
            const next = document.createElement('video');
            next.muted = true;
            next.loop = false;
            next.autoplay = true;
            next.playsInline = true;
            next.crossOrigin = 'anonymous';
            next.preload = 'auto';
            next.addEventListener(
              'loadeddata',
              () => {
                if (runtime.video !== current) {
                  discard(next);
                  return;
                }
                runtime.video = next;
                if (!runtime.viaCanvas)
                  setPlaneSource(runtime, { video: next });
                next.play().catch(() => {});
                discard(current);
                queueNext(next);
              },
              { once: true },
            );
            next.addEventListener(
              'error',
              () => {
                discard(next);
                // No new clip: the last picture stays, and it is asked for
                // again shortly.
                setTimeout(() => {
                  if (runtime.video === current) {
                    queueNext(current);
                    current.dispatchEvent(new Event('ended'));
                  }
                }, 4000);
              },
              { once: true },
            );
            next.src = `${parts.frames.mediaUrlFor(record.camera)}&clip=${Date.now()}`;
          },
          { once: true },
        );
      };
      queueNext(video);
    }
    video.src = parts.frames.mediaUrlFor(record.camera);
  }

  /**
   * Creates the projection runtime for a camera record: an offscreen canvas,
   * the monitor plane plus associated host label, and either an
   * <img> or <video> element depending on the feed type.
   *
   * The plane is the only projection representation (v2): the frustum's far cap,
   * perpendicular to the view axis (§2b — never billboarded; a wall primitive
   * can't pitch, the plane can). It is textured with the live frame: video
   * element direct, canvas double-buffer otherwise.
   *
   * A camera with no public still (`none`) paints its lookup note and never
   * creates an Image or requests a frame. A video camera plays only once the
   * user has clicked it; until then its plane says how to start it.
   *
   * @param {Object} record - Camera record.
   * @returns {Object|null} Projection runtime, or null if no viewer.
   */

  function createProjectionRuntime(record) {
    if (!layerState._viewer) return null;
    // Québec 511 denies CORS pixel access; Québec map previews are native DOM
    // videos positioned over the globe, never Cesium video textures.
    if (parts.model.isBrowserOverlayCamera(record.camera)) return null;
    const canvas = document.createElement('canvas');
    canvas.width = PROJECTION_CANVAS_WIDTH;
    canvas.height = PROJECTION_CANVAS_HEIGHT;
    const ctx = canvas.getContext('2d', { alpha: true });

    const feedType = parts.model.normalizeFeedType(record.camera.feedType);
    // 'none': no public still. The plane paints the lookup note locally and
    // never creates an Image or requests a frame.
    const mode =
      feedType === 'none'
        ? 'none'
        : parts.model.isVideoFeedType(feedType)
          ? 'video'
          : 'image';
    const runtime = {
      mode,
      drawnNote: null,
      canvas,
      ctx,
      image: null,
      video: null,
      plane: null,
      cameraId: String(record.camera.id),
      labelPosition: { x: 0, y: 0, z: 0 },
      overlayEntry: null,
      planeSource: { canvas },
      buffers: null,
      bufferIndex: 0,
      lastTextureSwapAt: 0,
      lastImageRefreshAt: 0,
      imageReady: false,
      imageLoading: false,
      imageStamp: 0,
      drawnImageStamp: -1,
      // Signature of the pixels currently ON the canvas, plus the reused 64x36
      // scratch used to compute it. null = "nothing known", which always redraws.
      lastFrameSignature: null,
      signatureCanvas: null,
      signatureCtx: null,
      lastPlaceholderPaintAt: 0,
      // canvasStamp increments on every canvas write (frame blit / placeholder
      // paint); lastSwappedCanvasStamp trails it so refreshProjectionTextures
      // only re-uploads the plane texture when there is genuinely new content.
      canvasStamp: 1,
      lastSwappedCanvasStamp: 0,
      disposed: false,
    };

    parts.frames.paintProjectionPlaceholder(ctx, record.camera);

    if (
      mode === 'video' &&
      layerState._videoPlayCameraId !== record.camera.id
    ) {
      // Not clicked: no request is made. The plane says how to start it.
      runtime.idleNote = 'VIDEO · CLICK THE CAMERA TO PLAY';
    } else if (mode === 'video') {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.preload = 'auto';
      // The plane shows the video once it knows its size (the element's
      // width/height follow the real stream dimensions); the renderer reads
      // it at a new size on any later resolution change (camera switch,
      // adaptive source).
      const bindVideoTexture = () => {
        if (runtime.video !== video || runtime.disposed) return;
        if (!(video.videoWidth > 0 && video.videoHeight > 0)) return;
        if (runtime.viaCanvas) return;
        video.width = video.videoWidth;
        video.height = video.videoHeight;
        if (runtime.planeSource?.video !== video)
          setPlaneSource(runtime, { video });
      };
      video.addEventListener('loadedmetadata', bindVideoTexture);
      video.addEventListener('resize', bindVideoTexture);
      runtime.video = video;
      if (parts.model.isProxyStreamCamera(record.camera)) {
        playProxyStream(record, runtime, video);
      } else {
        runtime.playback = attachCctvVideo(
          video,
          parts.frames.mediaUrlFor(record.camera),
          feedType,
          {
            onFailure: () => {
              if (runtime.disposed) return;
              runtime.video = null;
              runtime.mode = 'image';
              runtime.image = new Image();
              runtime.image.decoding = 'async';
              runtime.image.onload = () => {
                runtime.imageLoading = false;
                runtime.imageReady = true;
                runtime.imageStamp = Date.now();
              };
              runtime.image.onerror = () => {
                runtime.imageLoading = false;
                runtime.imageReady = false;
              };
              setPlaneSource(runtime, { canvas: runtime.canvas });
              parts.frames.refreshProjectionImage(record, true);
              parts.presentation.notifyListeners();
            },
          },
        );
      }
    } else if (mode === 'image') {
      const img = new Image();
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        runtime.imageLoading = false;
        runtime.imageReady = true;
        runtime.imageStamp = Date.now();
      };
      img.onerror = () => {
        runtime.imageLoading = false;
        runtime.imageReady = false;
      };
      runtime.image = img;
    }

    // Monitor plane = the frustum's far cap: video feeds bind the video element
    // directly once its dimensions are known (the renderer reads it every
    // frame); image feeds start on the placeholder canvas and switch to
    // double-buffer swaps at <=1Hz.
    const geometry =
      record.frustumGeometry ||
      parts.geometry.computeFrustumGeometry(
        record.camera,
        parts.ground.groundAltFor(record),
        record.probeClampRangeM,
      );
    const positions =
      record.frustumPositions || parts.rendering.frustumCartesians(geometry);
    createProjectionPlane(record, runtime, geometry, positions);

    return runtime;
  }

  /**
   * Lazily initializes the projection runtime for a record if it doesn't exist yet.
   * @param {Object} record - Camera record.
   * @returns {Object|null} The record's projection runtime.
   */

  function ensureProjectionRuntime(record) {
    if (!record) return null;
    if (record.projection && !record.projection.disposed)
      return record.projection;
    const runtime = createProjectionRuntime(record);
    record.projection = runtime;
    if (runtime) {
      layerState._projectionEntities.push(runtime);
    }
    return runtime;
  }

  /**
   * Tears down a projection runtime: stops video playback, removes the monitor
   * plane, and clears its host label if it owns the active source.
   * @param {Object} runtime - Projection runtime to destroy.
   */

  function destroyProjectionRuntime(runtime) {
    if (!runtime || runtime.disposed) return;
    runtime.disposed = true;
    setCctvTrafficPlane(layerState._viewer, runtime.cameraId, null);
    runtime.playback?.dispose();
    runtime.playback = null;
    if (runtime.image) {
      runtime.image.onload = null;
      runtime.image.onerror = null;
      runtime.image.src = '';
    }
    if (runtime.video) {
      runtime.video.pause();
      runtime.video.removeAttribute('src');
      runtime.video.load();
    }
    if (runtime.plane) {
      parts.drawSets.removePlane(runtime.plane);
      runtime.plane = null;
    }
    if (layerState._projectionOverlayOwnerId === runtime.cameraId)
      clearProjectionOverlay();
    runtime.overlayEntry = null;
    runtime.labelPosition = null;
    runtime.planeSource = null;
  }

  /**
   * Destroys a projection runtime for good (location switch, area swap, a
   * resolved lookup): beyond destroyProjectionRuntime it cancels an in-flight
   * frame request, zero-sizes the 1920x1080 canvas, its texture buffers and
   * signature scratch (which frees their pixels at once instead of at the next
   * GC), and detaches the runtime from its record so the next activation
   * builds a fresh one.
   * @param {Object} runtime - Projection runtime to release.
   */

  function releaseProjectionRuntime(runtime) {
    if (!runtime) return;
    destroyProjectionRuntime(runtime);
    if (runtime.image) {
      runtime.image.onload = null;
      runtime.image.onerror = null;
      runtime.image.removeAttribute?.('src');
      runtime.image = null;
    }
    runtime.video = null;
    for (const canvas of [
      runtime.canvas,
      runtime.signatureCanvas,
      ...(runtime.buffers || []),
    ]) {
      if (!canvas) continue;
      canvas.width = 0;
      canvas.height = 0;
    }
    runtime.canvas = null;
    runtime.ctx = null;
    runtime.buffers = null;
    runtime.signatureCanvas = null;
    runtime.signatureCtx = null;
    runtime.imageLoading = false;
    runtime.imageReady = false;
    const record = layerState._recordById.get(runtime.cameraId);
    if (record?.projection === runtime) record.projection = null;
  }

  function startProjectionLoop() {
    if (layerState._projectionRaf) return;
    if (!parts.model.projectionLoopIsNeeded()) return;
    // The armed projection loop uploads video textures / runs focus fades per
    // frame — the scene must render continuously while it runs. Released when
    // the tick self-stops. (perf wave 2)
    holdContinuousRender('cctv-projection');

    const tick = () => {
      if (!layerState._viewer || !parts.model.projectionLoopIsNeeded()) {
        layerState._projectionRaf = 0;
        releaseContinuousRender('cctv-projection');
        return;
      }

      parts.rendering.refreshCctvFocusStyles(performance.now());

      const active = parts.selection.getActiveRecord();
      if (layerState._enabled && layerState._showProjection && active) {
        ensureProjectionRuntime(active);
        const runtime = active.projection;
        if (runtime && (!runtime.video || runtime.viaCanvas)) {
          parts.frames.drawProjectionFrame(active);
          parts.frames.refreshProjectionTextures(active);
        } else if (runtime?.video) {
          // The video textures the plane directly; the panel's picture of it
          // is retaken every few seconds.
          parts.frames.notifyVideoPreview(runtime);
        }
      }

      layerState._projectionRaf = requestAnimationFrame(tick);
    };

    layerState._projectionRaf = requestAnimationFrame(tick);
  }

  /** Cancels the projection animation loop. */

  function stopProjectionLoop() {
    if (layerState._projectionRaf) {
      cancelAnimationFrame(layerState._projectionRaf);
      layerState._projectionRaf = 0;
    }
    releaseContinuousRender('cctv-projection');
  }

  /**
   * The active camera's decoded <video>, for a second surface (the panel card)
   * to paint from. Null when the active feed is a still or not yet attached.
   * @returns {HTMLVideoElement|null}
   */
  function getActiveVideoElement() {
    if (!layerState._enabled) return null;
    return parts.selection.getActiveRecord()?.projection?.video || null;
  }

  /**
   * Pauses video playback on all non-active camera projections and resumes
   * the active one (if projection is enabled).
   * @param {string|null} activeId - ID of the currently active camera.
   */

  function pauseInactiveProjectionFeeds(activeId) {
    for (const record of layerState._records) {
      if (!record.projection?.video) continue;
      if (record.camera.id === activeId && layerState._enabled) {
        record.projection.video.play().catch(() => {});
      } else {
        const runtime = record.projection;
        destroyProjectionRuntime(runtime);
        record.projection = null;
        layerState._projectionEntities = layerState._projectionEntities.filter(
          (entry) => entry !== runtime,
        );
      }
    }
  }
  return {
    createCctvProjectionOverlayEntry,
    getActiveVideoElement,
    updatePlanePlacement,
    clearProjectionOverlay,
    setPlaneVisible,
    setPlaneSource,
    plainPlaneSource,
    createProjectionPlane,
    createProjectionRuntime,
    ensureProjectionRuntime,
    destroyProjectionRuntime,
    releaseProjectionRuntime,
    startProjectionLoop,
    stopProjectionLoop,
    pauseInactiveProjectionFeeds,
  };
}
