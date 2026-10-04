import * as Cesium from 'cesium';
import { loadCardScale } from '../../data/cctvCardResize.js';

export function createState({ services }) {
  const {
    clearOverlaySource,
    hitTestWorldOverlay,
    setOverlayEntries,
    setOverlaySourceVisible,
  } = services.overlays;
  const layerState = {};

  // ---------------------------------------------------------------------------
  // Module-scoped mutable state
  // ---------------------------------------------------------------------------

  layerState._viewer = null;

  layerState._billboards = null;

  layerState._records = [];

  layerState._recordById = new Map();

  layerState._coverageEntities = [];

  layerState._projectionEntities = [];

  layerState._enabled = false;

  layerState._activeCameraId = null;

  layerState._coverageMode = 'on';
  // 'off' | 'on' (wireframes) | 'viewshed' (color-coded volumes)

  layerState._showProjection = true;

  layerState._autoHop = false;

  // An explicit empty-space deselect keeps AUTO HOP configured but prevents its
  // timer from silently choosing a replacement. A later explicit activation or
  // AUTO HOP toggle-on releases the hold.

  layerState._autoHopSuspended = false;

  layerState._autoHopSec = 18;

  layerState._lastHopAt = 0;

  layerState._lastViewContext = '';

  layerState._clickHandler = null;

  layerState._count = 0;

  layerState._lastUpdate = null;

  layerState._lastHealthSyncAt = 0;

  layerState._lastError = null;

  layerState._healthById = new Map();

  layerState._calibrationById = new Map();

  layerState._listeners = new Set();

  layerState._projectionRaf = 0;

  layerState._removeFocusAppearListener = null;

  layerState._lastFocusStyleAt = 0;

  /** Icons whose animated emphasis remains outside the 1.0 deadband. */

  layerState._activeFocusStyleCount = 0;

  layerState._scratchFocusScreen = new Cesium.Cartesian2();

  // Staggered geometry-load queue state (see queueUnresolvedGeometry).

  layerState._geoQueue = [];

  layerState._geoQueueTimer = 0;

  layerState._geoLoading = false;

  layerState._geoLoadTotal = 0;

  layerState._geoLoadDone = 0;

  layerState._geoProgressNotifier = null;

  // One-shot completion latch for shared floor resolution: the enable-time queue
  // can drain while DEM cells or 3D tiles are still loading. The first update()
  // tick that sees projectionTilesReady() re-enqueues unresolved records ONCE;
  // shared mesh cells remain one-shot and idle ticks stay sample-free. Reset by
  // enable() so each enable-time drain gets its own completion pass.

  layerState._tilesReadyReenqueued = false;

  // Calibration ADJUST mode (viewshed/gizmo design §3c): while true, the active
  // camera renders the direct-manipulation gizmo. Reset on layer disable.

  layerState._calibrationMode = false;

  layerState._gizmo = null;

  layerState._lastTransientNotifyAt = 0;

  // Cached handle on the active Google Photorealistic 3D Tileset, discovered
  // lazily from scene.primitives. Shared mesh-floor sampling is gated on its
  // tilesLoaded flag so a coarse-LOD miss is never baked in. Cleared when the
  // tileset is destroyed / the layer tears down.

  layerState._activeTileset = null;

  // Task 5: last surface regime the record geometry was recomputed for. The
  // map-stack change listener compares the CURRENT regime (derived live from
  // scene.globe.show) against this so bing→osm switches (same 'terrain-globe'
  // regime) don't trigger a pointless full-catalog rewrite.

  layerState._lastAppliedRegime = null;

  // Task 5: window listener handle for the 'gev:map-stack-changed' CustomEvent
  // main.js dispatches from MapStackController's onChange (removed in destroy).

  layerState._mapStackListener = null;

  // Field-test fix (2026-07-06): camera.moveEnd handle for the horizon-culling
  // pass (removed in destroy). Event-driven only — never a per-frame loop, so
  // the zero-steady-state-work invariant holds.

  layerState._horizonCullListener = null;

  // Ambient card tier state (2026-07-29 design). The card set is rebuilt only
  // on moveEnd/enable/activation (refreshAmbientCards); frame slots are STABLE
  // objects shared with the overlay host so landed frames appear without an
  // entry rebuild.

  layerState._cardIds = new Set();

  /** @type {Map<string,{misses:number,since:number}>} */

  layerState._cardGraceState = new Map();

  /** @type {Map<string,{frame:*, stamp:number, failCount:number, lastAttemptAt:number}>} */

  layerState._cardFrameSlots = new Map();

  layerState._cardFetchTimer = 0;

  /** In-flight card-frame fetch count (burst allows up to 4, steady is 1). */

  layerState._cardFetchInFlightCount = 0;

  /** @type {Set<HTMLImageElement>} in-flight fetches, detached on teardown. */

  layerState._cardFetchImages = new Set();

  /** @type {Set<string>} camera ids with an in-flight fetch (no double-fetch). */

  layerState._cardFetchPendingIds = new Set();

  layerState._cardFetchCount = 0;

  layerState._cardLastFetchAt = 0;

  layerState._cardMinFetchSpacingMs = null;

  /** Pacer mode telemetry: 'burst' during cold fill, 'steady' after. */

  layerState._cardFetchMode = 'steady';

  layerState.DEFAULT_CCTV_OVERLAY_HOST = Object.freeze({
    clearSource: clearOverlaySource,
    hitTest: hitTestWorldOverlay,
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
  });

  layerState._cctvOverlayHost = layerState.DEFAULT_CCTV_OVERLAY_HOST;

  layerState._projectionOverlayOwnerId = null;

  /**
   * Product presentation option. Shipped behavior keeps the active camera's
   * thumbnail absent because its monitor plane is the active representation.
   */

  layerState._activeCameraCardEnabled = false;

  /** Camera id currently holding the hover-summoned pinned card (or null). */

  layerState._hoverCardId = null;

  layerState._hoverReleaseTimer = 0;

  layerState._hoverLastPickAt = 0;

  // True between camera.moveStart and moveEnd — hover picking pauses while the
  // camera is in motion (picks during a flight would fight the reselection).

  layerState._cameraMoving = false;

  layerState._moveStartListener = null;
  layerState._sourceAbort = null;

  // ---------------------------------------------------------------------------
  // Camera area, Road511 lookups, private cameras and thumbnails
  // ---------------------------------------------------------------------------

  /** Dedicated primitive collection for monitor-plane pictures (not entity batches). */
  layerState._projectionPrimitiveCollection = null;
  layerState._scratchPlaneScale = new Cesium.Cartesian3();
  layerState._scratchPlaneRotation = new Cesium.Matrix3();
  /** The loaded camera area as the server reported it
   * (`{lat, lon, radiusKm, limit, inArea, loaded, dropped, reachKm, capped,
   * total, pending, generation}`), or null before the first area lands. */
  layerState._area = null;
  /** The area load in flight: `{point, controller, generation, promise, nearest}`. */
  layerState._areaRequest = null;
  /** Bumped by every area request; a response for an older one is dropped. */
  layerState._areaGeneration = 0;
  /** A place selected while the layer was off (or whose load disable aborted);
   * the next enable loads it. */
  layerState._pendingAreaPoint = null;
  /** One refetch while the server is still downloading a live pack for the area. */
  layerState._areaRefetchTimer = 0;
  /** Enable found no camera with a still near the view; the first area picks one. */
  layerState._areaDefaultPending = false;
  /** An arrival wanted a destination camera before its area landed: `{lat, lon}`. */
  layerState._areaCameraOwed = null;
  /** Counts explicit deselects, so an older NEAREST intent cannot undo a newer one. */
  layerState._deselectSerial = 0;
  /** Bumped whenever the record set or a camera's feed changes (memoizes uiState().cameras). */
  layerState._catalogVersion = 0;
  layerState._camerasCache = { version: -1, cameras: [] };
  /** In-flight Road511 lookups by camera id (at most one each). */
  layerState._lookupRequests = new Map();
  /** Ground-prior batch resolver (test seam; null = the Re:Earth proxy). */
  layerState._groundPriorResolver = null;
  /** In-flight catalogue rebuild (a private camera moved or saved), or null. */
  layerState._catalogReload = null;
  /** Reloads the catalogue when POWER UP saves private camera settings. */
  layerState._privateCamerasListener = null;
  /** Map card size chosen by dragging a card corner (cctvCardResize.js), per browser. */
  layerState._cardScale = loadCardScale();
  layerState._unbindCardResize = null;
  layerState._unbindCardAlign = null;
  /** The video camera the user clicked: the only one whose video may play. */
  layerState._videoPlayCameraId = null;
  /** Hand-made thumbnail alignments by camera id: {lat, lon, bearingDeg|null}
   * (saved in config/cctv_thumbnail_alignments.json). */
  layerState._thumbAlignments = new Map();
  layerState._thumbAlignmentsLoaded = false;
  /** The thumbnail being aligned right now: {id, draft, saving}. */
  layerState._alignSession = null;
  layerState._unbindPrivateMove = null;
  /** Membership of `_geoQueue`, so enqueueing stays O(1) at 1,000 cameras. */
  layerState._geoQueueSet = new Set();
  /** Set by a location-switch arrival drain: its completion re-anchors the map
   * cards, whose entries hold the record.position objects refinement replaces. */
  layerState._geoReanchorCardsOnDrain = false;
  /** Camera ids that currently have a thumbnail card entry. */
  layerState._thumbnailEntryIds = new Set();
  // Location switch state. While `_locationSwitching` is set the camera is
  // flying to a place in another region: card reselection, hover cards, AUTO
  // HOP and the tiles-ready geometry pass hold until onLocationArrive, so
  // nothing loads for the ground the flight passes over.
  layerState._locationSwitching = false;
  layerState._locationSwitchStartedAt = 0;
  /** The pending switch released an active camera (a superseding leave keeps
   * it), so arrival may select one at the destination in its place. */
  layerState._locationSwitchHadActive = false;
  /** The panel's last picture of a video camera (a JPEG data URL). */
  layerState._videoPreview = { id: '', at: 0, url: '' };
  return layerState;
}
