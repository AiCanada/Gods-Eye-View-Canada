import * as Cesium from 'cesium';
import { CCTV_OVERLAY_SOURCE_ID } from '../../data/cctvCards.js';
import { GIZMO_ID_PREFIX } from '../../data/cctvGizmo.js';
import { bindCctvCardResize } from '../../data/cctvCardResize.js';
import { bearingBetween, bindCctvCardAlign } from '../../data/cctvCardAlign.js';
import { bindPrivateCameraMove } from '../../data/cctvPrivateMove.js';
import { haversineKmBetween, waitBounded } from './area.js';
import { AREA_ARRIVE_MATCH_KM, AREA_ARRIVE_WAIT_MS } from './policy.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { registerSpriteCollection, restoreSpriteOrder } = services.sprites;
  const unregisterSpriteCollection =
    services.sprites.unregisterSpriteCollection || (() => {});
  const { activateCctvCameraFromWorldClick } = services.activation;
  const { resolvePickId, registerPickOwner, unregisterPickOwner } =
    services.picking;
  const { onFocusTargetAppear } = services.focus;
  const { holdContinuousRender, releaseContinuousRender } = services.render;

  /** Globe drags are paused while a card or icon gesture owns the pointer. */

  function setGlobeInputs(enabled) {
    if (layerState._viewer?.scene)
      layerState._viewer.scene.screenSpaceCameraController.enableInputs =
        enabled;
  }

  /** Resets all module-scoped runtime state to initial values. */

  function clearRuntimeState() {
    parts.geometryQueue.stopGeometryLoadQueue();
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
    layerState._records = [];
    layerState._recordById = new Map();
    layerState._catalogVersion += 1;
    layerState._healthById = new Map();
    layerState._count = 0;
    layerState._lastUpdate = null;
    layerState._lastHealthSyncAt = 0;
    layerState._lastError = null;
    layerState._lastFocusStyleAt = 0;
    layerState._activeFocusStyleCount = 0;
    // FIX ①/③: the discovered tileset handle is scene-scoped — drop it so a fresh
    // init re-discovers against the current scene primitives.
    layerState._activeTileset = null;
    // Task 5: the applied-regime tracker is record-set-scoped — a fresh init
    // recomputes it against the then-current scene.
    layerState._lastAppliedRegime = null;
  }
  const methods = {
    /**
     * Initializes the CCTV layer: restores calibration from localStorage, loads
     * this machine's private cameras, creates their billboards, sets up click
     * handling, and performs initial health sync. The viewer is still at globe
     * view here (the startup flight is deferred), so no public camera area
     * loads yet: the first settled view below 400 km, or a selected place,
     * loads it once the layer is on. No camera is active. Coverage entities
     * stay lazy.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    async init(viewer) {
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
      layerState._lastHopAt = 0;
      layerState._lastViewContext = '';
      layerState._calibrationById = parts.calibration.loadCalibrationStore();

      layerState._billboards = new Cesium.BillboardCollection();
      layerState._viewer.scene.primitives.add(layerState._billboards);
      registerSpriteCollection('cctv', layerState._billboards);

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
      // the billboards' always-on-top depth setting) + one initial pass so the
      // first paint is already culled.
      if (!layerState._horizonCullListener) {
        // Ambient cards piggyback the same settle event: moveEnd-driven
        // reselection only, never per frame (refreshAmbientCards no-ops while
        // the layer is disabled).
        layerState._horizonCullListener = () => {
          layerState._cameraMoving = false;
          parts.rendering.refreshHorizonCulling();
          parts.cards.refreshAmbientCards();
          // The first low settle with the layer on loads the first area.
          parts.area.maybeSeedArea();
        };
        layerState._viewer.camera.moveEnd.addEventListener(
          layerState._horizonCullListener,
        );
      }
      if (!layerState._moveStartListener) {
        // Item B: hover picking pauses while the camera is in motion.
        layerState._moveStartListener = () => {
          layerState._cameraMoving = true;
        };
        layerState._viewer.camera.moveStart.addEventListener(
          layerState._moveStartListener,
        );
      }
      parts.rendering.refreshHorizonCulling();

      layerState._clickHandler = new Cesium.ScreenSpaceEventHandler(
        layerState._viewer.scene.canvas,
      );
      const thumbs = parts.thumbnails;
      // Drag a map card's corner to resize every card; the globe does not pan
      // meanwhile.
      layerState._unbindCardResize?.();
      layerState._unbindCardResize = bindCctvCardResize({
        canvas: layerState._viewer.scene.canvas,
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
        canvas: layerState._viewer.scene.canvas,
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
          layerState._viewer?.scene?.requestRender?.();
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
        canvas: layerState._viewer.scene.canvas,
        isEnabled: () => layerState._enabled && !layerState._calibrationMode,
        pickCameraId: (x, y) =>
          parts.selection.extractPickedCameraId(
            layerState._viewer.scene.pick(new Cesium.Cartesian2(x, y)),
          ),
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
      parts.selection.bindCctvWorldClickGesture(
        layerState._clickHandler,
        (click) => {
          if (!layerState._enabled) return;
          const picked = layerState._viewer.scene.pick(click.position);
          const cameraId = parts.selection.extractPickedCameraId(picked);
          // World and card clicks are explicit activations (they may send a
          // Road511 lookup or start a video).
          if (cameraId) {
            activateCctvCameraFromWorldClick(
              cameraId,
              parts.selection.activateCameraExplicitly,
            );
            return;
          }
          // Any identified scene object owns this click even if its layer does not
          // register a shared pick predicate. This keeps selectable siblings ahead
          // of an overlapping CCTV card while ID-less globe/terrain/tile surfaces
          // remain eligible for true empty-space deselection.
          const pickedId = resolvePickId(picked);
          if (pickedId !== null) return;
          // Item A (owner round 2): the scene pick found no camera — try the
          // painted ambient cards. The cards canvas is pointer-events:none (this
          // handler owns the events), so a click landing on a card's rect selects
          // its camera exactly like a click on the icon. Cesium click positions
          // and the recorded rects are both CSS px — direct comparison.
          const cardId = layerState._cctvOverlayHost.hitTest(
            click.position.x,
            click.position.y,
            { sourceId: CCTV_OVERLAY_SOURCE_ID },
          )?.entryId;
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
        {
          // Item B: hover summons a card on a cardless camera icon. The gesture
          // classifier owns MOUSE_MOVE too, so chain hover work through its seam
          // instead of replacing the travel accumulator's handler.
          onMouseMove: (movement) =>
            parts.hover.handleHoverMove(movement?.endPosition),
        },
      );

      await parts.health.syncHealthState(true);
      parts.rendering.refreshCoverageStyles();
      parts.presentation.notifyListeners();
      restoreSpriteOrder(layerState._viewer);
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
      // OpenStreetMap-derived packs (Warendorf) carry the OSM credit; an area
      // swap re-checks it as cameras arrive and leave (area.js).
      if (
        layerState._records.some(
          (record) => record.camera.cityId === 'warendorf',
        )
      )
        services.credits?.showOsmCredit?.(layerState._viewer, 'cctv');
      layerState._lastUpdate = Date.now();
      // Pick-ownership (H2): camera billboards use the camera id directly;
      // coverage polyline entities use `cctv-<cameraId>-<role>` entity ids.
      registerPickOwner('cctv', (pickedId) => {
        if (layerState._recordById.has(pickedId)) return true;
        if (
          typeof pickedId === 'string' &&
          pickedId.startsWith(GIZMO_ID_PREFIX)
        )
          return true;
        const coverage =
          /^cctv-(.+)-(?:ray-tl|ray-tr|ray-br|ray-bl|cap|plane|plane-label)$/.exec(
            pickedId,
          );
        return Boolean(coverage && layerState._recordById.has(coverage[1]));
      });
      // enable() rebuilds for the view it finds, so no location switch holds
      // past this point (one the layer saw while off gets no arrival).
      layerState._locationSwitching = false;
      layerState._locationSwitchStartedAt = 0;
      layerState._locationSwitchHadActive = false;
      if (!layerState._activeCameraId) {
        // The default is the nearest camera with a still within 50 km of the
        // view, or none — never the first catalogue camera, which may be far
        // away. With none, the first area to land (or arrival) picks it. The
        // default is not an explicit activation, so it sends no lookup.
        layerState._activeCameraId = parts.navigation.nearestStillCameraId(
          parts.area.viewerPoint(),
        );
        layerState._areaDefaultPending = !layerState._activeCameraId;
        layerState._autoHopSuspended = false;
      }
      const activeRecord = parts.selection.getActiveRecord();
      if (activeRecord) {
        parts.projection.ensureProjectionRuntime(activeRecord);
        parts.frames.refreshProjectionImage(activeRecord, true);
      }
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
      restoreSpriteOrder(layerState._viewer);
    },

    /**
     * Disables the layer: hides entities, stops the projection loop and load
     * queue, and cancels an area load in flight (a chosen place loads on the
     * next enable; a seeded load re-seeds from the view then).
     */
    disable() {
      services.credits?.hideOsmCredit?.(layerState._viewer, 'cctv');
      layerState._enabled = false;
      if (layerState._areaRequest) {
        if (!layerState._areaRequest.seeded)
          layerState._pendingAreaPoint = layerState._areaRequest.point;
        parts.area.abortAreaRequest();
      }
      parts.area.clearAreaRefetchTimer();
      unregisterPickOwner('cctv');
      // ADJUST mode does not survive a layer toggle — predictable re-entry.
      layerState._calibrationMode = false;
      releaseContinuousRender('cctv-adjust');
      layerState._gizmo?.setEnabled(false);
      layerState._removeFocusAppearListener?.();
      layerState._removeFocusAppearListener = null;
      parts.projection.stopProjectionLoop();
      parts.geometryQueue.stopGeometryLoadQueue();
      // Ambient cards tear down COMPLETELY on disable (owner design point 6):
      // source entries, pacer timer, in-flight handlers, and caches.
      parts.cards.teardownAmbientCards();
      parts.rendering.hideCctvVisuals();
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
     * entities, billboards, and clears all runtime state and subscribers.
     * @param {Cesium.Viewer} [viewer] - Viewer instance (falls back to stored ref).
     */
    destroy(viewer) {
      services.credits?.hideOsmCredit?.(layerState._viewer, 'cctv');
      layerState._sourceAbort?.abort();
      if (typeof document !== 'undefined')
        document.removeEventListener(
          'visibilitychange',
          parts.cards.handleVisibilityChange,
        );
      unregisterPickOwner('cctv');
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
      const teardownViewer = viewer || layerState._viewer;
      if (layerState._horizonCullListener && teardownViewer?.camera?.moveEnd) {
        teardownViewer.camera.moveEnd.removeEventListener(
          layerState._horizonCullListener,
        );
        layerState._horizonCullListener = null;
      }
      if (layerState._moveStartListener && teardownViewer?.camera?.moveStart) {
        teardownViewer.camera.moveStart.removeEventListener(
          layerState._moveStartListener,
        );
        layerState._moveStartListener = null;
      }
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
      if (layerState._clickHandler) {
        layerState._clickHandler.destroy();
        layerState._clickHandler = null;
      }
      if (teardownViewer?.scene?.screenSpaceCameraController) {
        teardownViewer.scene.screenSpaceCameraController.enableInputs = true;
      }
      parts.projection.stopProjectionLoop();
      parts.geometryQueue.stopGeometryLoadQueue();
      parts.cards.teardownAmbientCards();
      parts.geometry.destroyCoverageEntities();
      parts.projection.destroyProjectionPrimitiveCollection(teardownViewer);
      if (layerState._billboards && teardownViewer) {
        unregisterSpriteCollection('cctv', layerState._billboards);
        teardownViewer.scene.primitives.remove(layerState._billboards);
        layerState._billboards = null;
      }
      clearRuntimeState();
      layerState._viewer = null;
      layerState._enabled = false;
      layerState._activeCameraId = null;
      layerState._autoHopSuspended = false;
      layerState._locationSwitching = false;
      layerState._locationSwitchStartedAt = 0;
      layerState._locationSwitchHadActive = false;
      // Clear existing subscribers rather than replacing the Set —
      // replacing would silently orphan any unsubscribe() closures
      layerState._listeners.clear();
    },
  };

  return { clearRuntimeState, methods };
}
