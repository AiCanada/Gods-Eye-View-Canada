import { distance, dot } from '../../geo/vector.js';
import {
  canvasOf,
  findCamera,
  findFrame,
  findGlobe,
} from '../../render/rendererOf.js';
import { CCTV_OVERLAY_SOURCE_ID } from '../../data/cctvCards.js';
import { GIZMO_ID_PREFIX } from '../../data/cctvGizmo.js';
import { ownsCctvPick } from './pickIds.js';
import { inputFor } from '../../input/dispatcher.js';
import { bindCctvCardResize } from '../../data/cctvCardResize.js';
import { bearingBetween, bindCctvCardAlign } from '../../data/cctvCardAlign.js';
import { bindPrivateCameraMove } from '../../data/cctvPrivateMove.js';
import { haversineKmBetween, waitBounded } from './area.js';
import {
  AREA_ARRIVE_MATCH_KM,
  AREA_ARRIVE_WAIT_MS,
  VIEW_MOTION_REFRESH_MS,
  VIEW_MOTION_MIN_MOVE_FRACTION,
  VIEW_MOTION_MIN_TURN_DEG,
  VIEW_MOTION_COST_FACTOR,
} from './policy.js';

const MIN_TURN_COS = Math.cos((VIEW_MOTION_MIN_TURN_DEG * Math.PI) / 180);

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { activateCctvCameraFromWorldClick } = services.activation;
  const {
    resolvePickId,
    registerPickOwner,
    unregisterPickOwner,
    clickCard,
    registerClickClaim,
    unregisterClickClaim,
  } = services.picking;
  const { onFocusTargetAppear } = services.focus;
  const { holdContinuousRender, releaseContinuousRender } = services.render;

  /** The camera-input hold a card or icon gesture took, or null. */
  let globeInputsHold = null;

  /** Globe drags are paused while a card or icon gesture owns the pointer. */

  function setGlobeInputs(enabled) {
    if (enabled) {
      globeInputsHold?.();
      globeInputsHold = null;
      return;
    }
    if (globeInputsHold || !layerState._viewer) return;
    globeInputsHold = inputFor(layerState._viewer).suspendCamera(
      'cctv-card-gesture',
    );
  }

  /**
   * The settled-view pass: thin the icons, queue the newly visible geometry,
   * reselect cards, and tell subscribers (the camera picker) when the shown
   * set changed since they were last told, including by motion passes.
   */
  function settleView() {
    const changed = parts.rendering.refreshHorizonCulling();
    noteViewPose();
    parts.geometryQueue.enqueueViewGeometry();
    parts.cards.refreshAmbientCards();
    if (changed || layerState._viewUnpublished) {
      layerState._viewUnpublished = false;
      parts.presentation.notifyListeners();
    }
  }

  /** Records the camera pose the last view pass ran at. */
  function noteViewPose() {
    const pose = findCamera(layerState._viewer)?.pose();
    if (!pose) return;
    layerState._viewPose = {
      position: pose.position,
      direction: pose.direction,
    };
  }

  /**
   * Whether the camera moved or turned enough since the last view pass to
   * change what is on screen. A camera that tracks or flies without settling
   * would otherwise rerun the full pass on every tick.
   */
  function viewPoseChanged() {
    const now = findCamera(layerState._viewer)?.pose();
    const pose = layerState._viewPose;
    if (!pose || !now) return true;
    // An eye with no geographic position (the earth's centre) has no height.
    const height = Math.max(1, Number.isFinite(now.height) ? now.height : 0);
    const moved = distance(now.position, pose.position);
    if (moved > height * VIEW_MOTION_MIN_MOVE_FRACTION) return true;
    return dot(now.direction, pose.direction) < MIN_TURN_COS;
  }

  function viewMotionTick() {
    if (!layerState._enabled) return;
    const now = performance.now();
    const pass = layerState._viewMotionPass;
    if (pass && now - pass.at < pass.ms * VIEW_MOTION_COST_FACTOR) return;
    if (!viewPoseChanged()) return;
    if (parts.rendering.refreshHorizonCulling())
      layerState._viewUnpublished = true;
    noteViewPose();
    parts.geometryQueue.enqueueViewGeometry();
    layerState._viewMotionPass = { at: now, ms: performance.now() - now };
  }

  function startViewMotionTimer() {
    if (layerState._viewMotionTimer) return;
    layerState._viewMotionTimer = setInterval(
      viewMotionTick,
      VIEW_MOTION_REFRESH_MS,
    );
  }

  function stopViewMotionTimer() {
    clearInterval(layerState._viewMotionTimer);
    layerState._viewMotionTimer = 0;
  }

  /**
   * Listen for the camera's moves on the viewer's camera port: hover picking
   * pauses while it moves, and the view pass reruns on an interval until the
   * move ends, then once more. A re-init against a new viewer moves the
   * listeners to its camera; one against the same viewer keeps them.
   */
  function attachViewListeners() {
    const globe = findGlobe(layerState._viewer);
    if (layerState._surfaceListenerGlobe !== globe) {
      layerState._surfaceListener?.();
      layerState._surfaceListener = null;
      layerState._surfaceListenerGlobe = globe;
    }
    if (!layerState._surfaceListener && globe?.on) {
      // Refresh drawn heights when terrain finishes loading or the surface changes.
      let version = globe.surfaceVersion?.();
      let terrainPending = globe.isSettled?.('terrain') === false ? 1 : 0;
      layerState._surfaceListener = globe.on('progress', (progress) => {
        const next = globe.surfaceVersion?.();
        const loaded = progress?.terrainPending === 0 && terrainPending !== 0;
        const swapped = next !== version;
        version = next;
        terrainPending = progress?.terrainPending ?? terrainPending;
        if (
          (loaded || swapped) &&
          layerState._enabled &&
          !layerState._cameraMoving
        )
          settleView();
      });
    }
    const viewCamera = findCamera(layerState._viewer);
    if (
      layerState._viewListenerCamera &&
      layerState._viewListenerCamera !== viewCamera
    ) {
      layerState._horizonCullListener?.();
      layerState._moveStartListener?.();
      layerState._horizonCullListener = null;
      layerState._moveStartListener = null;
      layerState._cameraMoving = false;
    }
    layerState._viewListenerCamera = viewCamera;
    if (!layerState._horizonCullListener && viewCamera) {
      // Ambient cards piggyback the same settle event: moveEnd-driven
      // reselection only, never per frame (refreshAmbientCards no-ops while
      // the layer is disabled).
      layerState._horizonCullListener = viewCamera.on('moveEnd', () => {
        layerState._cameraMoving = false;
        stopViewMotionTimer();
        parts.navigation.reopenNearestCamera();
        settleView();
        // The first low settle with the layer on loads the first area.
        parts.area?.maybeSeedArea?.();
      });
    }
    if (!layerState._moveStartListener && viewCamera) {
      // Item B: hover picking pauses while the camera is in motion. A long
      // move (cockpit flight, a drag) never settles, so the view pass also
      // reruns on an interval until it does.
      layerState._moveStartListener = viewCamera.on('moveStart', () => {
        layerState._cameraMoving = true;
        // enable() starts it for a move already under way.
        if (layerState._enabled) startViewMotionTimer();
      });
    }
  }

  /** Drop the move listeners; nothing reports the end of a move after it. */
  function detachViewListeners() {
    layerState._surfaceListener?.();
    layerState._surfaceListener = null;
    layerState._surfaceListenerGlobe = null;
    layerState._horizonCullListener?.();
    layerState._horizonCullListener = null;
    layerState._moveStartListener?.();
    layerState._moveStartListener = null;
    layerState._cameraMoving = false;
    layerState._viewListenerCamera = null;
    stopViewMotionTimer();
  }

  /** Resets all module-scoped runtime state to initial values. */

  function clearRuntimeState() {
    parts.geometryQueue.stopGeometryLoadQueue();
    stopViewMotionTimer();
    // Idempotent — also covers a re-init without a prior destroy().
    parts.cards.teardownAmbientCards();
    parts.projection.clearProjectionOverlay();
    parts.area.abortAreaRequest();
    parts.area.clearAreaRefetchTimer();
    layerState._area = null;
    layerState._pendingAreaPoint = null;
    layerState._areaDefaultPending = false;
    layerState._areaCameraOwed = null;
    layerState._lookupRequests.clear();
    // An activation probe still to answer lands on none of these records.
    for (const record of layerState._records || [])
      if (record) record.probeToken = (record.probeToken || 0) + 1;
    layerState._records = [];
    layerState._recordById = new Map();
    layerState._catalogVersion += 1;
    layerState._viewRecords = [];
    layerState._pickerRecords = [];
    layerState._cameraIndexCache = null;
    layerState._coverageVisibleIds = new Set();
    layerState._neighborCountCache = null;
    layerState._coverageCohort = null;
    layerState._viewUnpublished = false;
    layerState._viewPose = null;
    layerState._viewMotionPass = null;
    layerState._healthById = new Map();
    layerState._count = 0;
    layerState._lastUpdate = null;
    layerState._lastHealthSyncAt = 0;
    layerState._lastError = null;
    layerState._lastFocusStyleAt = 0;
    layerState._activeFocusStyleCount = 0;
    // Task 5: the applied-regime tracker is record-set-scoped — a fresh init
    // recomputes it against the then-current scene.
    layerState._lastAppliedRegime = null;
  }
  const methods = {
    /**
     * Initializes the CCTV layer: restores calibration from localStorage, loads
     * this machine's private cameras, creates their camera icons, sets up click
     * handling, and performs initial health sync. The viewer is still at globe
     * view here (the startup flight is deferred), so no public camera area
     * loads yet: the first settled view below 400 km, or a selected place,
     * loads it once the layer is on. No camera is active. Coverage entities
     * stay lazy.
     * @param {object} viewer - The viewer.
     */
    async init(viewer, { panel = null } = {}) {
      layerState._panel = panel;
      layerState._sourceAbort?.abort();
      const sourceAbort = new AbortController();
      layerState._sourceAbort = sourceAbort;
      if (typeof document !== 'undefined')
        document.addEventListener(
          'visibilitychange',
          parts.cards.handleVisibilityChange,
        );
      layerState._viewer = viewer;
      clearRuntimeState();
      layerState._enabled = false;
      layerState._activeCameraId = null;
      layerState._autoHopSuspended = false;
      layerState._openingCameraProvisional = false;
      layerState._lastHopAt = 0;
      layerState._lastViewContext = '';
      layerState._calibrationById = parts.calibration.loadCalibrationStore();

      parts.rendering.createCameraIcons(layerState._viewer);

      const catalog = parts.area.prepareCameras(
        parts.catalog.buildCatalogFromSources(
          await parts.catalog.loadPrivateCameraSources(),
        ),
      );
      sourceAbort.signal.throwIfAborted();

      // Task 5 (height-datum fix): the cameras' coords go through the Re:Earth
      // ellipsoidal ground-prior resolver (network-cached — NOT a scene query;
      // the catalog's orthometric groundElevationM feeds the geoid fallback
      // chain), with a bounded wait so a cold upstream never hangs init.
      const { priors, late } = await parts.area.boundedGroundPriors(catalog);
      sourceAbort.signal.throwIfAborted();
      layerState._records = catalog.map((camera, index) =>
        parts.area.createCameraRecord(camera, priors?.[index] || null),
      );
      layerState._count = layerState._records.length;
      layerState._catalogVersion += 1;

      // Task 5: if the prior batch lost init's bounded race, apply it post-hoc
      // when it lands (pure recomputes — applyLateGroundPriors guards against
      // a torn-down/re-inited catalog).
      if (late) {
        const initRecords = layerState._records.slice();
        late
          .then((resolved) => {
            if (resolved)
              parts.ground.applyLateGroundPriors(initRecords, resolved);
          })
          .catch(() => {});
      }

      // Task 5: track the surface regime the initial geometry was computed for
      // and listen for map-stack changes (main.js re-dispatches
      // MapStackController.onChange as this CustomEvent). The handler compares
      // regimes itself, so 'switching'/'error' emissions and same-regime stack
      // swaps (bing→osm) no-op.
      layerState._lastAppliedRegime = parts.ground.currentSurfaceRegime();
      if (!layerState._mapStackListener && typeof window !== 'undefined') {
        layerState._mapStackListener = () =>
          parts.ground.handleMapStackChanged();
        window.addEventListener(
          'gev:map-stack-changed',
          layerState._mapStackListener,
        );
      }
      // POWER UP saving private camera settings reloads the private cameras.
      if (
        !layerState._privateCamerasListener &&
        typeof window !== 'undefined'
      ) {
        layerState._privateCamerasListener = () =>
          parts.area.scheduleCatalogReload();
        window.addEventListener(
          'gev:private-cameras-changed',
          layerState._privateCamerasListener,
        );
      }

      // Field-test fix (2026-07-06): horizon-cull on camera settle (pairs with
      // the icons' always-on-top drawing) + one initial pass so the
      // first paint is already culled.
      attachViewListeners();
      // A resize or rotation changes what is on screen without moving the
      // camera.
      const canvas = canvasOf(layerState._viewer);
      if (layerState._viewResizeCanvas !== canvas) {
        // A re-init against a new viewer observes its canvas instead.
        layerState._viewResizeObserver?.disconnect();
        layerState._viewResizeObserver = null;
        layerState._viewResizeCanvas = null;
      }
      if (
        !layerState._viewResizeObserver &&
        typeof ResizeObserver === 'function' &&
        canvas
      ) {
        let frame = 0;
        layerState._viewResizeObserver = new ResizeObserver(() => {
          if (frame || !layerState._enabled) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (layerState._enabled) settleView();
          });
        });
        layerState._viewResizeObserver.observe(canvas);
        layerState._viewResizeCanvas = canvas;
      }
      parts.rendering.refreshHorizonCulling();

      const input = inputFor(layerState._viewer);
      const thumbs = parts.thumbnails;
      // Drag a map card's corner to resize every card; the globe does not pan
      // meanwhile.
      layerState._unbindCardResize?.();
      layerState._unbindCardResize = bindCctvCardResize({
        canvas: canvasOf(layerState._viewer),
        hitTest: (x, y) => thumbs.hitTestAmbientCard(x, y),
        isEnabled: () =>
          layerState._enabled &&
          !layerState._calibrationMode &&
          !layerState._alignSession,
        getScale: () => layerState._cardScale,
        setScale: (scale) => {
          layerState._cardScale = scale;
          parts.cards.pushAmbientCardEntries();
        },
        onDragStart: () => {
          setGlobeInputs(false);
          holdContinuousRender('cctv-card-resize');
        },
        onDragEnd: () => {
          setGlobeInputs(true);
          releaseContinuousRender('cctv-card-resize');
        },
      });
      // Right-click a map thumbnail to line it up with the map by hand (move,
      // turn), right-click it again to save. See cctvCardAlign.js.
      layerState._unbindCardAlign?.();
      layerState._unbindCardAlign = bindCctvCardAlign({
        canvas: canvasOf(layerState._viewer),
        hitTest: (x, y) => thumbs.hitTestAmbientCard(x, y),
        isEnabled: () => layerState._enabled && !layerState._calibrationMode,
        getSession: () => layerState._alignSession,
        begin: thumbs.beginThumbnailAlign,
        pickGround: thumbs.privateGlobePoint,
        screenUpBearing: (x, y) => {
          const here = thumbs.privateGlobePoint(x, y);
          const above = thumbs.privateGlobePoint(x, y - 60);
          return here && above
            ? bearingBetween(here.lat, here.lon, above.lat, above.lon)
            : null;
        },
        update: (patch) => {
          if (!layerState._alignSession) return;
          // A NEW object each time: the world points cached against the old
          // one go with it.
          layerState._alignSession.draft = {
            ...layerState._alignSession.draft,
            ...patch,
          };
          findFrame(layerState._viewer)?.requestRender('cctv-card-align');
        },
        save: thumbs.saveThumbnailAlign,
        cancel: thumbs.endThumbnailAlign,
        reset: thumbs.resetThumbnailAlign,
        onDragStart: () => setGlobeInputs(false),
        onDragEnd: () => setGlobeInputs(true),
      });
      thumbs.loadThumbnailAlignments();
      // Drag a private (home or business) camera icon to a new spot; a click
      // still selects it.
      layerState._unbindPrivateMove?.();
      layerState._unbindPrivateMove = bindPrivateCameraMove({
        canvas: canvasOf(layerState._viewer),
        isEnabled: () => layerState._enabled && !layerState._calibrationMode,
        pickCameraId: (x, y) => parts.rendering.pickCameraIdAt({ x, y }),
        globePoint: (x, y) => thumbs.privateGlobePoint(x, y),
        onPreview: (id, point) => thumbs.previewPrivateCameraMove(id, point),
        onCommit: (id, point) => void thumbs.commitPrivateCameraMove(id, point),
        onSelect: (id) =>
          activateCctvCameraFromWorldClick(
            id,
            parts.selection.activateCameraExplicitly,
          ),
        onPressStart: () => {
          setGlobeInputs(false);
          holdContinuousRender('cctv-private-move');
        },
        onPressEnd: () => {
          setGlobeInputs(true);
          releaseContinuousRender('cctv-private-move');
        },
      });
      layerState._clickSubscription?.();
      const unsubscribeClick = parts.selection.bindCctvWorldClickGesture(
        input,
        (event) => {
          if (!layerState._enabled) return;
          const picked = event.topHit;
          // The card or label painted on top takes the click, read once per
          // click so every layer agrees: a live card of ours acts whatever
          // is drawn under it; another layer's is that layer's click.
          const top = clickCard?.(event) ?? null;
          if (top && top.sourceId !== CCTV_OVERLAY_SOURCE_ID) return;
          if (top) {
            // A card of ours that is going away is still not the scene.
            if (layerState._recordById.has(top.entryId))
              activateCctvCameraFromWorldClick(
                top.entryId,
                parts.selection.activateCameraExplicitly,
              );
            return;
          }
          const cameraId = parts.selection.extractPickedCameraId(event.hit);
          // World and card clicks are explicit activations (they may send a
          // Road511 lookup or start a video).
          if (cameraId) {
            activateCctvCameraFromWorldClick(
              cameraId,
              parts.selection.activateCameraExplicitly,
            );
            return;
          }
          // Any identified scene object owns this click even if its layer
          // does not register a shared pick predicate. This keeps selectable
          // siblings ahead of the CCTV selection while ID-less globe, terrain
          // and tile surfaces remain eligible for empty-space deselection.
          if (resolvePickId(picked) !== null) return;
          // Item A (owner round 2): a painted ambient card the click registry
          // did not report still selects its camera, exactly like a click on
          // the icon. The cards canvas is pointer-events:none, and click
          // positions and the recorded rects are both CSS px.
          const cardId = event.position
            ? layerState._cctvOverlayHost?.hitTest(
                event.position.x,
                event.position.y,
                { sourceId: CCTV_OVERLAY_SOURCE_ID },
              )?.entryId
            : null;
          if (cardId && layerState._recordById.has(cardId)) {
            activateCctvCameraFromWorldClick(
              cardId,
              parts.selection.activateCameraExplicitly,
            );
            return;
          }
          if (
            parts.selection.cctvEmptyClickDeselects(picked, {
              activeCameraId: layerState._activeCameraId,
              calibrationMode: layerState._calibrationMode,
            })
          ) {
            parts.selection.deactivateActiveCamera();
          }
        },
      );
      // Item B: hover summons a card on a cardless camera icon.
      const unsubscribeHover = input.onPointer('move', (movement) =>
        parts.hover.handleHoverMove(movement?.endPosition),
      );
      layerState._clickSubscription = () => {
        unsubscribeClick();
        unsubscribeHover();
      };

      await parts.health.syncHealthState(true);
      // Health ranks crowded cells: thin again now that it has arrived (a
      // no-op unless enable() ran while health was loading).
      if (parts.rendering.refreshHorizonCulling()) {
        parts.geometryQueue.enqueueViewGeometry();
        parts.cards.refreshAmbientCards();
      }
      parts.rendering.refreshCoverageStyles();
      parts.presentation.notifyListeners();
      console.log('[Data:CCTV] Initialized with', layerState._count, 'cameras');
    },

    /**
     * Enables the layer: shows entities, starts the projection loop, queues the
     * records still unresolved for geometry, and loads the camera area when
     * none is loaded (or a place was selected while the layer was off). Heavy
     * work (per-camera ground sampling) is deferred/batched so the frame budget
     * never collapses at enable time.
     */
    enable() {
      layerState._enabled = true;
      layerState._lastUpdate = Date.now();
      // Pick-ownership (H2): camera icons use the camera id directly;
      // coverage polyline entities use `cctv-<cameraId>-<role>` entity ids.
      registerPickOwner('cctv', (pickedId) =>
        ownsCctvPick(pickedId, layerState._recordById, GIZMO_ID_PREFIX),
      );
      registerClickClaim?.('cctv', parts.selection.countClickCard);
      // enable() rebuilds for the view it finds, so no location switch holds
      // past this point (one the layer saw while off gets no arrival).
      layerState._locationSwitching = false;
      layerState._locationSwitchStartedAt = 0;
      layerState._locationSwitchHadActive = false;
      if (!layerState._activeCameraId) {
        // The default is the nearest camera with a still within 50 km of the
        // view, or none: never the first catalogue camera, which may be far
        // away. With none, the first area to land (or arrival) picks it. The
        // default is not an explicit activation, so it sends no lookup. Until
        // someone picks a camera, settled moves re-pick the nearest
        // (reopenNearestCamera): a shared view's flight lands after enable.
        layerState._activeCameraId = parts.navigation.nearestStillCameraId(
          parts.area.viewerPoint(),
        );
        layerState._areaDefaultPending = !layerState._activeCameraId;
        layerState._autoHopSuspended = false;
        layerState._openingCameraProvisional = Boolean(
          layerState._activeCameraId,
        );
      }
      const activeRecord = parts.selection.getActiveRecord();
      if (activeRecord) {
        parts.projection.ensureProjectionRuntime(activeRecord);
        parts.frames.refreshProjectionImage(activeRecord, true);
      }
      parts.rendering.refreshHorizonCulling();
      // Re-enabled mid-flight: moveStart has already fired.
      if (layerState._cameraMoving) startViewMotionTimer();
      // Fresh drain → fresh one-shot completion pass. Only unresolved records
      // queue, so re-enabling never re-walks cameras that already resolved.
      layerState._tilesReadyReenqueued = false;
      parts.geometryQueue.queueUnresolvedGeometry(
        layerState._records,
        parts.area.viewerPoint(),
      );
      parts.rendering.refreshCoverageStyles();
      parts.projection.startProjectionLoop();
      // The projection loop self-stops when idle; a focus target appearing
      // (user starts tracking a contact) is the one edge it can't see while
      // stopped, so re-arm on it. Removed on disable.
      layerState._removeFocusAppearListener?.();
      layerState._removeFocusAppearListener = onFocusTargetAppear(() =>
        parts.projection.startProjectionLoop(),
      );
      // Ambient card tier: shared host source + policy-gated frame pacer + the
      // initial selection pass (moveEnd drives every later reselection).
      layerState._cctvOverlayHost.setVisible(CCTV_OVERLAY_SOURCE_ID, true);
      // Vehicles driving behind a thumbnail are repainted over its picture.
      services.pictureTraffic?.setCctvThumbnailTrafficActive?.(true);
      parts.cards.startCardFrameLoop();
      parts.cards.refreshAmbientCards();
      parts.area.maybeSeedArea();
      parts.presentation.notifyListeners();
    },

    /**
     * Disables the layer: hides entities, stops the projection loop and load
     * queue, and cancels an area load in flight (a chosen place loads on the
     * next enable; a seeded load re-seeds from the view then).
     */
    disable() {
      layerState._enabled = false;
      if (layerState._areaRequest) {
        if (!layerState._areaRequest.seeded)
          layerState._pendingAreaPoint = layerState._areaRequest.point;
        parts.area.abortAreaRequest();
      }
      parts.area.clearAreaRefetchTimer();
      unregisterPickOwner('cctv');
      unregisterClickClaim?.('cctv');
      // ADJUST mode does not survive a layer toggle — predictable re-entry.
      layerState._calibrationMode = false;
      releaseContinuousRender('cctv-adjust');
      layerState._gizmo?.setEnabled(false);
      layerState._removeFocusAppearListener?.();
      layerState._removeFocusAppearListener = null;
      parts.projection.stopProjectionLoop();
      parts.geometryQueue.stopGeometryLoadQueue();
      stopViewMotionTimer();
      // Ambient cards tear down COMPLETELY on disable (owner design point 6):
      // source entries, pacer timer, in-flight handlers, and caches.
      parts.cards.teardownAmbientCards();
      parts.rendering.hideCctvVisuals();
      // Nothing is in view while the layer is off.
      layerState._viewRecords = [];
      layerState._pickerRecords = [];
      layerState._cameraIndexCache = null;
      parts.presentation.notifyListeners();
    },

    /**
     * DataLayerManager selection hook (every selected place, in this region or
     * another): re-centres the camera area. With the layer off it only
     * remembers the point, for the next enable. A point the loaded area covers
     * (within max(cover·0.5, cover − 10 km)) changes nothing; otherwise the
     * area request starts now, and its response applies once `arrival` settles
     * (at most 10 s) if it is still the newest. Never throws.
     * @param {Object} [event]
     * @param {{lat:number, lon:number}} [event.point] - The selected place.
     * @param {Promise<unknown>|null} [event.arrival] - Settles when a camera
     *   flight to it lands; null when the camera is already there.
     * @param {boolean} [event.enabled] - Whether the manager has the layer on.
     * @returns {Promise<boolean>|undefined} Settles when the area is settled.
     */
    onLocationSelect(event = {}) {
      try {
        const point = parts.area.locationSwitchPoint(event?.point);
        if (!point) return undefined;
        if (!layerState._enabled || !layerState._viewer) {
          layerState._pendingAreaPoint = point;
          return undefined;
        }
        layerState._pendingAreaPoint = null;
        return parts.area.selectArea(point, {
          arrival: event?.arrival ?? null,
        });
      } catch (error) {
        console.warn(
          '[Data:CCTV] location select failed:',
          error?.message || error,
        );
        return undefined;
      }
    },

    /**
     * DataLayerManager location-switch hook: the user selected a place in
     * another region and the camera is about to fly there. Runs for the
     * initialized layer whether it is on or off.
     *
     * Released: the map-card ring, its frame pacer and in-flight frame
     * requests, the hover card, thumbnails, wireframes and viewshed volumes
     * away from the destination, every monitor-plane runtime, the active
     * camera (unless it sits at the destination; AUTO HOP's deselect hold is
     * left alone), ADJUST mode and the geometry queue. Kept: the loaded camera
     * records, their billboards and ground priors (an area swap replaces
     * those, see onLocationSelect). Card reselection, hover cards, AUTO HOP and
     * the tiles-ready geometry pass hold until onLocationArrive. Synchronous,
     * network-free and idempotent; never throws.
     * @param {Object} [event]
     * @param {Object|null} [event.from] - Place left: `{ key, region, country, lat, lon }`.
     * @param {Object|null} [event.to] - Destination, same shape.
     * @param {AbortSignal} [event.signal] - Aborted when a newer switch supersedes this one.
     * @param {boolean} [event.enabled] - Whether the layer is on.
     */
    onLocationLeave(event = {}) {
      try {
        parts.area.beginLocationSwitch(event?.to ?? null);
      } catch (error) {
        console.warn(
          '[Data:CCTV] location leave failed:',
          error?.message || error,
        );
      }
    },

    /**
     * DataLayerManager location-switch hook: the camera has arrived (enabled
     * layer only). When an area load for the destination (within 5 km) is
     * still in flight it waits for it first (at most 12 s), so the destination
     * camera comes from the destination's cameras. Then it restarts the card
     * pacer and reselects cards for the destination, and queues the
     * destination's unresolved geometry nearest first. When no camera is
     * active it activates the camera with a still nearest the destination
     * without flying, if one lies within 50 km, but only in place of the
     * camera this switch released, when enable found none, or when
     * `to.selectCamera` is true (a private-site pill lands on the site's
     * camera). A deliberate deselect (AUTO HOP held) is kept unless
     * `to.selectCamera` asks. An aborted signal means a newer switch owns the
     * resume. Runs synchronously when no load is pending. Never throws.
     * @param {Object} [event]
     * @param {Object|null} [event.from] - Place left.
     * @param {Object|null} [event.to] - Destination: `{ key, region, country, lat, lon }`,
     *   plus `selectCamera: true` to activate the destination's nearest camera.
     * @param {AbortSignal} [event.signal] - Aborted when a newer switch supersedes this one.
     * @returns {Promise<void>}
     */
    async onLocationArrive(event = {}) {
      try {
        if (event?.signal?.aborted) return;
        const to = event?.to ?? null;
        const point = parts.area.locationSwitchPoint(to);
        const request = layerState._areaRequest;
        if (
          request &&
          point &&
          haversineKmBetween(point, request.point) <= AREA_ARRIVE_MATCH_KM
        ) {
          await waitBounded(
            request.promise,
            AREA_ARRIVE_WAIT_MS,
            event?.signal ?? null,
          );
          if (event?.signal?.aborted) return;
        }
        parts.area.endLocationSwitch(to);
      } catch (error) {
        console.warn(
          '[Data:CCTV] location arrive failed:',
          error?.message || error,
        );
      }
    },

    /**
     * Tears down the layer: destroys click handler, projection loop, coverage
     * entities, icons, and clears all runtime state and subscribers. It
     * releases what init attached, whichever viewer it is handed.
     */
    destroy() {
      layerState._panel = null;
      layerState._sourceAbort?.abort();
      if (typeof document !== 'undefined')
        document.removeEventListener(
          'visibilitychange',
          parts.cards.handleVisibilityChange,
        );
      unregisterPickOwner('cctv');
      unregisterClickClaim?.('cctv');
      if (layerState._mapStackListener && typeof window !== 'undefined') {
        window.removeEventListener(
          'gev:map-stack-changed',
          layerState._mapStackListener,
        );
        layerState._mapStackListener = null;
      }
      if (layerState._privateCamerasListener && typeof window !== 'undefined') {
        window.removeEventListener(
          'gev:private-cameras-changed',
          layerState._privateCamerasListener,
        );
        layerState._privateCamerasListener = null;
      }
      detachViewListeners();
      layerState._viewResizeObserver?.disconnect();
      layerState._viewResizeObserver = null;
      layerState._viewResizeCanvas = null;
      if (layerState._gizmo) {
        layerState._gizmo.destroy();
        layerState._gizmo = null;
      }
      layerState._calibrationMode = false;
      releaseContinuousRender('cctv-adjust');
      layerState._unbindCardResize?.();
      layerState._unbindCardResize = null;
      layerState._unbindCardAlign?.();
      layerState._unbindCardAlign = null;
      if (layerState._alignSession) {
        layerState._alignSession = null;
        releaseContinuousRender('cctv-card-align');
      }
      layerState._thumbAlignmentsLoaded = false;
      layerState._unbindPrivateMove?.();
      layerState._unbindPrivateMove = null;
      setGlobeInputs(true);
      layerState._clickSubscription?.();
      layerState._clickSubscription = null;
      parts.projection.stopProjectionLoop();
      parts.geometryQueue.stopGeometryLoadQueue();
      parts.cards.teardownAmbientCards();
      parts.geometry.destroyCoverageEntities();
      parts.rendering.destroyCameraIcons();
      parts.drawSets.dispose();
      clearRuntimeState();
      layerState._viewer = null;
      layerState._enabled = false;
      layerState._activeCameraId = null;
      layerState._autoHopSuspended = false;
      layerState._locationSwitching = false;
      layerState._locationSwitchStartedAt = 0;
      layerState._locationSwitchHadActive = false;
      layerState._openingCameraProvisional = false;
      // Clear existing subscribers rather than replacing the Set —
      // replacing would silently orphan any unsubscribe() closures
      layerState._listeners.clear();
    },
  };

  return {
    clearRuntimeState,
    attachViewListeners,
    detachViewListeners,
    methods,
  };
}
