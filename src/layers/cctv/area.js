import * as Cesium from 'cesium';
import { viewshedColors, cameraHue } from '../../data/cctvViewshed.js';
import { cctvHueIndexFromId } from './model.js';
import {
  AREA_ARRIVAL_WAIT_MS,
  AREA_PENDING_REFETCH_MS,
  AREA_SEED_MAX_ALTITUDE_M,
  CALIBRATION_RANGE_FLOOR_M,
  CAMERA_ICON,
  CCTV_AREA_LOAD_CAP,
  CCTV_AREA_RADIUS_KM,
  GROUND_PRIOR_INIT_WAIT_MS,
  IDLE_CAMERA_COLOR,
  LOCATION_KEEP_ACTIVE_RADIUS_KM,
  LOCATION_KEEP_RADIUS_KM,
  LOCATION_SELECT_RADIUS_KM,
  LOCATION_SWITCH_STALE_MS,
} from './policy.js';

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two `{lat, lon}` points, in kilometres. */
export function haversineKmBetween(a, b) {
  return haversineKm(a.lat, a.lon, b.lat, b.lon);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Whether a point is already covered by a loaded area: within
 * `max(cover·0.5, cover − 10 km)` of its centre, where `cover` is the area's
 * reach when the 1,000 cap cut it short and its radius otherwise. A covered
 * selection keeps the area; anything farther re-centres it.
 * @param {Object|null} area - `{lat, lon, radiusKm, reachKm, capped}`.
 * @param {{lat:number, lon:number}|null} point
 * @returns {boolean}
 */
export function cctvAreaCovers(area, point) {
  const lat = Number(area?.lat);
  const lon = Number(area?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon))
    return false;
  const radiusKm =
    Number(area.radiusKm) > 0 ? Number(area.radiusKm) : CCTV_AREA_RADIUS_KM;
  const reachKm = Number(area.reachKm);
  const cover =
    area.capped === true && Number.isFinite(reachKm) && reachKm >= 0
      ? reachKm
      : radiusKm;
  return (
    haversineKm(lat, lon, point.lat, point.lon) <=
    Math.max(cover * 0.5, cover - 10)
  );
}

/**
 * Lists the records within `radiusKm` of a point, nearest first. Pure (reads
 * only `record.camera.lat/lon`), so the location-switch release, the arrival
 * camera pick and the arrival geometry pass share one distance rule.
 * @param {Object[]} records - Camera records.
 * @param {number} lat - Point latitude (degrees).
 * @param {number} lon - Point longitude (degrees).
 * @param {number} radiusKm - Inclusive radius in kilometres.
 * @returns {{ record: Object, distKm: number }[]} Matches, nearest first.
 */
export function cctvRecordsWithinKm(records, lat, lon, radiusKm) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusKm >= 0))
    return [];
  const matches = [];
  for (const record of Array.isArray(records) ? records : []) {
    const camera = record?.camera;
    if (!Number.isFinite(camera?.lat) || !Number.isFinite(camera?.lon))
      continue;
    const distKm = haversineKm(lat, lon, camera.lat, camera.lon);
    if (distKm <= radiusKm) matches.push({ record, distKm });
  }
  return matches.sort((a, b) => a.distKm - b.distKm);
}

/**
 * Resolves once `promise` settles, `ms` passes or `signal` aborts, whichever
 * comes first. Never rejects.
 * @param {Promise<unknown>|unknown} promise
 * @param {number} ms
 * @param {AbortSignal|null} [signal]
 * @returns {Promise<void>}
 */
export function waitBounded(promise, ms, signal = null) {
  return new Promise((resolve) => {
    let timer = 0;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    };
    if (signal?.aborted) {
      finish();
      return;
    }
    timer = setTimeout(finish, ms);
    signal?.addEventListener?.('abort', finish, { once: true });
    Promise.resolve(promise).then(finish, finish);
  });
}

/**
 * The camera area: the layer holds the cameras nearest ONE selected place —
 * at most 1,000 within 50 km, fetched from /api/cctv/sources?lat&lon — plus
 * this machine's private cameras, which load separately and never leave. A
 * place outside the loaded area (a pill, search result or map click, even in
 * the same state) swaps the area by id: kept cameras keep their records,
 * dropped ones release everything built for them. Nothing is fabricated for
 * an empty area.
 *
 * Location switch: onLocationSelect re-centres the camera area on every
 * selection outside it; onLocationLeave releases what was built for the view
 * being left (map cards, monitor planes, the active camera, wireframes and
 * volumes away from the destination); onLocationArrive waits for a matching
 * area load, then reloads for the destination.
 */
export function createArea({ state: layerState, services, parts, source }) {
  const { CCTV_ACTIVATION_RESULT } = services.activation;
  const { releaseContinuousRender } = services.render;

  /**
   * OpenStreetMap-derived camera packs (Warendorf) carry the OSM credit while
   * any of their cameras is loaded with the layer on.
   */

  function refreshOsmCredit() {
    if (!layerState._viewer) return;
    if (
      layerState._enabled &&
      layerState._records.some((record) => record.camera.cityId === 'warendorf')
    )
      services.credits?.showOsmCredit?.(layerState._viewer, 'cctv');
    else services.credits?.hideOsmCredit?.(layerState._viewer, 'cctv');
  }

  // -------------------------------------------------------------------------
  // Camera records
  // -------------------------------------------------------------------------

  /**
   * Whether a record is one of this machine's private cameras (loaded apart
   * from the public area and never removed by an area swap).
   * @param {Object} record
   * @returns {boolean}
   */

  function isPrivateRecord(record) {
    return record?.camera?.sourceKind === 'private';
  }

  /**
   * Applies each camera's saved calibration (kept across area swaps) and
   * derives its pose. Entries saved before the range floor dropped (no
   * rangeFloorM) keep their effective range by re-basing rangeScale once.
   * Mutates and returns the cameras.
   * @param {Object[]} cameras
   * @returns {Object[]}
   */

  function prepareCameras(cameras) {
    for (const camera of cameras) {
      const savedEntry = layerState._calibrationById.get(camera.id);
      if (savedEntry) {
        const values =
          savedEntry.rangeFloorM === CALIBRATION_RANGE_FLOOR_M
            ? savedEntry.values
            : parts.calibration.migrateRangeScaleForFloor(
                savedEntry.values,
                camera.rangeM,
              );
        savedEntry.values = values;
        savedEntry.rangeFloorM = CALIBRATION_RANGE_FLOOR_M;
        camera.calibration = parts.calibration.normalizeCalibration(values);
        camera.calSource = savedEntry.source;
      }
      parts.model.ensureCameraPose(camera);
    }
    return cameras;
  }

  /**
   * Resolves ground priors for cameras about to get records, waiting at most
   * GROUND_PRIOR_INIT_WAIT_MS. A warm proxy cache answers in milliseconds, so
   * records are normally built with their prior; a slow upstream loses the
   * race and `late` settles with the batch for applyLateGroundPriors.
   * @param {Object[]} cameras
   * @returns {Promise<{priors: Array|null, late: Promise<Array|null>|null}>}
   */

  async function boundedGroundPriors(cameras) {
    if (!cameras.length) return { priors: [], late: null };
    const priorsPromise = parts.ground.resolveGroundPriors(cameras);
    let timer = 0;
    const priors = await Promise.race([
      priorsPromise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), GROUND_PRIOR_INIT_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    return { priors, late: priors ? null : priorsPromise };
  }

  /**
   * Fingerprint of a private camera's saved source (base pose and feed), so a
   * reload rebuilds only cameras that actually changed.
   * @param {Object} camera
   * @returns {string}
   */

  function privateSourceKey(camera) {
    const base = camera.basePose || camera;
    return [
      base.lat,
      base.lon,
      base.headingDeg,
      base.pitchDeg,
      base.fovDeg,
      base.rangeM,
      base.mountHeightM,
      camera.name,
      camera.city,
      camera.privateFrameUrl,
      camera.feedType,
    ].join('|');
  }

  /**
   * Builds one camera's record: its billboard, ground state and viewshed
   * colours, registered in `_recordById`. The caller places it in `_records`.
   * Coverage entities and the projection runtime stay lazy.
   * @param {Object} camera - Calibrated camera (prepareCameras).
   * @param {{ellipsoid:number, source:string}|null} [groundPrior]
   * @returns {Object} The record.
   */

  function createCameraRecord(camera, groundPrior = null) {
    // Cheap first-pass altitude from the ellipsoidal prior (catalog value only
    // as the pre-prior fallback) — the staggered geometry queue refines with
    // sampled heights after enable, so building records never raycasts the
    // scene once per camera.
    const priorGround = Number.isFinite(groundPrior?.ellipsoid)
      ? groundPrior.ellipsoid
      : Number(camera.groundElevationM) || 0;
    camera.absoluteHeightM = priorGround + camera.mountHeightM;
    const position = Cesium.Cartesian3.fromDegrees(
      camera.lon,
      camera.lat,
      camera.absoluteHeightM,
    );
    const billboard = layerState._billboards
      ? layerState._billboards.add({
          id: camera.id,
          image: CAMERA_ICON,
          position,
          color: IDLE_CAMERA_COLOR,
          width: 24,
          height: 24,
          // Field-test fix (2026-07-06): always-on-top vs the globe mesh. The
          // old finite value (1800 m) re-engaged the depth test at far zoom,
          // where the COARSE far-LOD Google-3D mesh sits above the true ground
          // and swallowed ground-anchored icons ("submerged" pills over SF).
          // Far-side-of-globe icons are handled by refreshHorizonCulling()
          // (the flights-layer EllipsoidalOccluder pattern), not by the depth
          // test. Street traffic still draws above these icons via
          // SPRITE_LAYER_ORDER.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(350, 1.25, 4_000_000, 0.42),
        })
      : null;

    const record = {
      camera,
      position,
      billboard,
      coverageEntities: [],
      projection: null,
      // Task 5 (height-datum fix): regime-aware ground resolution state.
      //   groundPrior     — { ellipsoid, source } from the Re:Earth batch
      //     (null until a late batch lands). The prior applies in EVERY
      //     regime and is the terrain-globe resolution outright.
      //   groundResolved  — PER-REGIME one-shot latch (regime key →
      //     boolean): true once this record's resolution completed for that
      //     regime; such records are excluded from the completion pass so
      //     their geometry freezes. Re-armed only on a genuine pose change,
      //     explicit user select/move, or a surface-regime change — never
      //     on the 10s timer.
      //   groundSamples   — PER-REGIME resolved ground (regime key →
      //     metres): the accepted one-shot scene sample in google-3d, the
      //     mirrored prior in terrain-globe. Kept across re-arms as the
      //     "has ever resolved" memory for the B9c mid-stream guard.
      //   frustumPositions — cached Cartesians for pure recomputes (so
      //     plane placement never re-derives geometry it already has).
      groundPrior,
      groundResolved: {},
      groundSamples: {},
      frustumGeometry: null,
      frustumPositions: null,
      // §9.1 activation obstruction probe result: effective-range clamp so
      // the far-cap plane never clips into the tiles. Null = unclamped.
      // Reset + re-probed on every activation; cleared when the user takes
      // the range slider (slider overrides the clamp).
      probeClampRangeM: null,
      // Viewshed (design §3a/§3b): per-camera color identity from an id hash,
      // stable whichever neighbours load with it, plus the volume primitive
      // handle (exists only in viewshed mode for the visible set).
      viewshedColors: viewshedColors(cameraHue(cctvHueIndexFromId(camera.id))),
      viewshedPrimitive: null,
      viewshedActiveTint: false,
      // Private cameras only: what their source said, to tell a changed camera.
      sourceKey:
        camera.sourceKind === 'private' ? privateSourceKey(camera) : '',
    };
    layerState._recordById.set(camera.id, record);
    return record;
  }

  /**
   * Removes the materialized frustum wireframes of the given records. They are
   * rebuilt lazily the next time one of those cameras is active or in the
   * coverage-visible set.
   * @param {Object[]} records - Camera records whose wireframes go.
   */

  function releaseCoverageEntities(records) {
    if (!records.length) return;
    const removed = new Set();
    const entities = layerState._viewer?.entities;
    entities?.suspendEvents?.();
    try {
      for (const record of records) {
        for (const entity of record.coverageEntities || []) {
          entities?.remove(entity);
          removed.add(entity);
        }
        record.coverageEntities = [];
      }
    } finally {
      entities?.resumeEvents?.();
    }
    layerState._coverageEntities = layerState._coverageEntities.filter(
      (entity) => !removed.has(entity),
    );
  }

  /**
   * Releases cameras for good (an area swap or a removed private camera): the
   * billboard, wireframes, viewshed volume, monitor-plane runtime, map card
   * slot and grace state, hover card, health entry, geometry-queue entry and
   * record. An active camera among them leaves no camera active. Saved
   * calibration stays, so the camera keeps it if it loads again.
   * @param {Object[]} records
   */

  function destroyCameraRecords(records) {
    const doomed = (Array.isArray(records) ? records : []).filter(
      (record) =>
        record?.camera &&
        layerState._recordById.get(record.camera.id) === record,
    );
    if (!doomed.length) return;
    const doomedSet = new Set(doomed);
    const doomedIds = new Set(doomed.map((record) => record.camera.id));
    releaseCoverageEntities(
      doomed.filter((record) => record.coverageEntities?.length),
    );
    let activeLeft = false;
    for (const record of doomed) {
      const id = record.camera.id;
      parts.geometry.destroyViewshedVolume(record);
      // Before the record leaves the map: the release detaches it from its record.
      if (record.projection)
        parts.projection.releaseProjectionRuntime(record.projection);
      if (record.billboard) {
        layerState._billboards?.remove(record.billboard);
        record.billboard = null;
      }
      layerState._cardIds.delete(id);
      layerState._cardGraceState.delete(id);
      layerState._cardFrameSlots.delete(id);
      if (layerState._hoverCardId === id) parts.hover.clearHoverCard();
      layerState._healthById.delete(id);
      layerState._geoQueueSet.delete(record);
      if (layerState._activeCameraId === id) {
        layerState._activeCameraId = null;
        activeLeft = true;
      }
      layerState._recordById.delete(id);
      record.destroyed = true;
    }
    layerState._projectionEntities = layerState._projectionEntities.filter(
      (runtime) => !doomedIds.has(runtime?.cameraId),
    );
    layerState._geoQueue = layerState._geoQueue.filter(
      (record) => !doomedSet.has(record),
    );
    layerState._records = layerState._records.filter(
      (record) => !doomedSet.has(record),
    );
    layerState._count = layerState._records.length;
    layerState._catalogVersion += 1;
    if (activeLeft) layerState._gizmo?.refresh();
  }

  /**
   * Applies a fresh private camera list: private records whose source changed
   * (or whose icon was left somewhere the saved spot is not) are rebuilt,
   * removed ones are released, new ones are added. Public area records are
   * untouched. The selected camera stays selected when it is still listed.
   * @param {Object[]} rawSources
   * @returns {Promise<void>}
   */

  async function applyPrivateSources(rawSources) {
    const catalog = parts.catalog.buildCatalogFromSources(
      (Array.isArray(rawSources) ? rawSources : []).filter(
        (entry) => String(entry?.sourceKind || '').toLowerCase() === 'private',
      ),
    );
    const byId = new Map(catalog.map((camera) => [camera.id, camera]));
    const stale = layerState._records.filter((record) => {
      if (!isPrivateRecord(record)) return false;
      const next = byId.get(record.camera.id);
      if (!next || privateSourceKey(next) !== record.sourceKey) return true;
      const base = record.camera.basePose;
      return !base || base.lat !== next.lat || base.lon !== next.lon;
    });
    const staleIds = new Set(stale.map((record) => record.camera.id));
    const incoming = prepareCameras(
      catalog.filter(
        (camera) =>
          staleIds.has(camera.id) || !layerState._recordById.has(camera.id),
      ),
    );
    if (!stale.length && !incoming.length) return;
    const { priors, late } = await boundedGroundPriors(incoming);
    if (!layerState._viewer) return;

    const activeId = layerState._activeCameraId;
    destroyCameraRecords(stale);
    const created = [];
    for (const [index, camera] of incoming.entries()) {
      if (layerState._recordById.has(camera.id)) continue;
      created.push(createCameraRecord(camera, priors?.[index] || null));
    }
    layerState._records = [...layerState._records, ...created];
    layerState._count = layerState._records.length;
    layerState._catalogVersion += 1;
    if (late) {
      late
        .then((resolved) => {
          if (!resolved) return;
          const priorByCamera = new Map(
            incoming.map((camera, index) => [camera, resolved[index] || null]),
          );
          parts.ground.applyLateGroundPriors(
            created,
            created.map((record) => priorByCamera.get(record.camera) || null),
          );
        })
        .catch(() => {});
    }
    if (
      activeId &&
      !layerState._activeCameraId &&
      layerState._recordById.has(activeId)
    )
      layerState._activeCameraId = activeId;
    if (!layerState._enabled) return;
    parts.geometryQueue.queueUnresolvedGeometry(created, viewerPoint());
    const active = parts.selection.getActiveRecord();
    if (active) {
      parts.projection.ensureProjectionRuntime(active);
      parts.frames.refreshProjectionImage(active, true);
    }
    parts.rendering.refreshHorizonCulling();
    parts.rendering.refreshCoverageStyles();
    parts.cards.refreshAmbientCards();
    parts.projection.startProjectionLoop();
  }

  /**
   * Reloads the private cameras after they change (saved, removed, or a move
   * that failed to save). Only private records are diffed: a camera whose
   * source changed (or whose icon sits somewhere the saved spot does not) is
   * rebuilt, a removed one is released, and the public camera area is left
   * alone with no refetch. The selected camera stays selected when it is still
   * listed. Requests made while a reload runs queue behind it.
   */

  function scheduleCatalogReload() {
    const run = async () => {
      if (!layerState._viewer) return;
      const sources = await parts.catalog.loadPrivateCameraSources();
      if (!layerState._viewer) return;
      // Awaited: the queue, the error catch and the notification below all
      // follow the record swap, not just the list fetch.
      await applyPrivateSources(sources);
    };
    const current = (layerState._catalogReload || Promise.resolve())
      .catch(() => {})
      .then(run)
      .catch((error) => {
        layerState._lastError = `Camera list reload failed: ${error?.message || error}`;
        console.warn('[Data:CCTV] camera list reload failed:', error);
      })
      .finally(() => {
        if (layerState._catalogReload === current)
          layerState._catalogReload = null;
        parts.presentation.notifyListeners();
      });
    layerState._catalogReload = current;
    return current;
  }

  // -------------------------------------------------------------------------
  // The camera area
  // -------------------------------------------------------------------------

  /**
   * Normalizes a server area report (contract 2) for the loaded area.
   * @param {Object} area - `area` from /api/cctv/sources.
   * @param {{lat:number, lon:number}} point - The requested point (fallback centre).
   * @param {number} loadedCount - Area records the layer actually built.
   * @param {number} generation
   * @returns {Object}
   */

  function normalizeArea(area, point, loadedCount, generation) {
    const { clamp, safeNumber } = parts.model;
    const raw = area && typeof area === 'object' ? area : {};
    const radiusKm = clamp(
      safeNumber(raw.radiusKm, CCTV_AREA_RADIUS_KM),
      0.5,
      CCTV_AREA_RADIUS_KM,
    );
    const loaded = Math.max(
      0,
      Math.round(safeNumber(loadedCount, safeNumber(raw.loaded, 0))),
    );
    const dropped = Math.max(0, Math.round(safeNumber(raw.dropped, 0)));
    const reachKm = safeNumber(raw.reachKm, NaN);
    return {
      lat: safeNumber(raw.lat, safeNumber(point?.lat, NaN)),
      lon: safeNumber(raw.lon, safeNumber(point?.lon, NaN)),
      radiusKm,
      limit: clamp(
        Math.round(safeNumber(raw.limit, CCTV_AREA_LOAD_CAP)),
        1,
        CCTV_AREA_LOAD_CAP,
      ),
      inArea: Math.max(loaded + dropped, Math.round(safeNumber(raw.inArea, 0))),
      loaded,
      dropped,
      reachKm:
        Number.isFinite(reachKm) && reachKm >= 0
          ? Math.min(reachKm, radiusKm)
          : radiusKm,
      capped: raw.capped === true || dropped > 0,
      total: Math.max(0, Math.round(safeNumber(raw.total, 0))),
      pending: Array.isArray(raw.pending) ? raw.pending.map(String) : [],
      generation,
    };
  }

  /** Cancels the area load in flight; its response can no longer land. */

  function abortAreaRequest() {
    if (!layerState._areaRequest) return;
    layerState._areaRequest.controller.abort();
    layerState._areaRequest = null;
    layerState._areaGeneration += 1;
  }

  /** Cancels a scheduled live-pack refetch. */

  function clearAreaRefetchTimer() {
    if (!layerState._areaRefetchTimer) return;
    clearTimeout(layerState._areaRefetchTimer);
    layerState._areaRefetchTimer = 0;
  }

  /**
   * Builds an area response's cameras and starts the ground-prior batch for
   * the ones the layer does not hold yet, so priors resolve while a camera
   * flight lands. Kept cameras cost no prior request.
   * @param {Object[]} rawSources
   * @returns {{catalog: Object[], priorById: Promise<Map<string, Object|null>>}}
   */

  function prepareAreaCatalog(rawSources) {
    const catalog = prepareCameras(
      parts.catalog.buildCatalogFromSources(
        (Array.isArray(rawSources) ? rawSources : [])
          .filter(
            (entry) =>
              String(entry?.sourceKind || '').toLowerCase() !== 'private',
          )
          .slice(0, CCTV_AREA_LOAD_CAP),
      ),
    );
    const added = catalog.filter(
      (camera) => !layerState._recordById.has(camera.id),
    );
    const priorById = (
      added.length
        ? parts.ground.resolveGroundPriors(added)
        : Promise.resolve([])
    ).then(
      (priors) =>
        new Map(
          added.map((camera, index) => [camera.id, priors?.[index] || null]),
        ),
    );
    return { catalog, priorById };
  }

  /**
   * Swaps the public camera area to a server response, by id. Kept cameras
   * keep their record objects (cards, geometry and calibration intact);
   * cameras that left are released completely (destroyCameraRecords); new
   * cameras get records with ground priors fetched for them alone and are
   * queued for geometry nearest the area centre. Private cameras stay.
   * `_records` is the area nearest first, then private cameras. A response for
   * an older request (generation) is dropped, checked again after every await.
   * @param {Object[]} rawSources - `sources` from /api/cctv/sources, nearest first.
   * @param {Object} area - `area` from the same response.
   * @param {number} generation - The request generation it answers.
   * @param {Object} [prepared] - prepareAreaCatalog() output started earlier.
   * @param {Object} [request] - The request it answers; its `seeded` flag tags the area.
   * @returns {Promise<boolean>} Whether the response was applied.
   */

  async function applyAreaSources(
    rawSources,
    area,
    generation,
    prepared = null,
    request = null,
  ) {
    if (generation !== layerState._areaGeneration || !layerState._viewer)
      return false;
    const { catalog, priorById } = prepared || prepareAreaCatalog(rawSources);
    let timer = 0;
    const priors = await Promise.race([
      priorById,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), GROUND_PRIOR_INIT_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (generation !== layerState._areaGeneration || !layerState._viewer)
      return false;

    const nextIds = new Set(catalog.map((camera) => camera.id));
    destroyCameraRecords(
      layerState._records.filter(
        (record) => !isPrivateRecord(record) && !nextIds.has(record.camera.id),
      ),
    );
    const areaRecords = [];
    const added = [];
    const awaitingPrior = [];
    for (const camera of catalog) {
      const existing = layerState._recordById.get(camera.id);
      if (existing) {
        // An id a private camera already owns stays private.
        if (isPrivateRecord(existing)) continue;
        // The server may have resolved a lookup camera's still since it loaded.
        if (
          camera.lookupState === 'resolved' &&
          existing.camera.lookupState !== 'resolved'
        ) {
          parts.lookup.applyLookupResult(
            camera.id,
            { lookupState: 'resolved', feedType: camera.feedType },
            { notify: false },
          );
        }
        areaRecords.push(existing);
        continue;
      }
      const prior = priors?.get(camera.id) || null;
      const record = createCameraRecord(camera, prior);
      areaRecords.push(record);
      added.push(record);
      if (!prior) awaitingPrior.push(record);
    }
    layerState._records = [
      ...areaRecords,
      ...layerState._records.filter(isPrivateRecord),
    ];
    layerState._count = layerState._records.length;
    layerState._catalogVersion += 1;
    layerState._area = {
      ...normalizeArea(area, area, areaRecords.length, generation),
      seeded: request?.seeded === true,
    };
    if (!priors && awaitingPrior.length) {
      priorById
        .then((map) => {
          parts.ground.applyLateGroundPriors(
            awaitingPrior,
            awaitingPrior.map((record) => map.get(record.camera.id) || null),
          );
        })
        .catch(() => {});
    }

    const center =
      Number.isFinite(layerState._area.lat) &&
      Number.isFinite(layerState._area.lon)
        ? { lat: layerState._area.lat, lon: layerState._area.lon }
        : null;
    if (layerState._enabled)
      parts.geometryQueue.queueUnresolvedGeometry(added, center, {
        restartProgress: true,
      });
    refreshOsmCredit();
    parts.rendering.refreshHorizonCulling();
    parts.rendering.refreshCoverageStyles();
    parts.cards.refreshAmbientCards();
    parts.projection.startProjectionLoop();
    if (layerState._areaRequest?.generation === generation)
      layerState._areaRequest = null;
    parts.presentation.notifyListeners();
    return true;
  }

  /**
   * After an area lands, picks its camera when one is owed: the NEAREST intent
   * that started a re-centre (explicit when the user pressed it), an arrival
   * whose destination cameras were still loading, or enable's default. Only
   * cameras with a still within 50 km; defaults never send a lookup.
   * @param {Object} request - The applied area request.
   */

  function settleAreaCamera(request) {
    if (
      !layerState._enabled ||
      layerState._activeCameraId ||
      layerState._locationSwitching
    )
      return;
    const nearest = request.nearest;
    if (nearest && nearest.deselectSerial === layerState._deselectSerial) {
      const id =
        parts.navigation.nearestStillCameraId(request.point) ||
        nearestCameraIdWithinKm(request.point, LOCATION_SELECT_RADIUS_KM);
      if (
        id &&
        parts.selection.setActiveCamera(id, {
          explicit: nearest.explicit === true,
        }) === CCTV_ACTIVATION_RESULT.ACTIVATED
      )
        return;
    }
    if (layerState._areaCameraOwed) {
      const owed = layerState._areaCameraOwed;
      layerState._areaCameraOwed = null;
      const id = parts.navigation.nearestStillCameraId(owed);
      if (
        id &&
        parts.selection.setActiveCamera(id) === CCTV_ACTIVATION_RESULT.ACTIVATED
      )
        return;
    }
    if (layerState._areaDefaultPending && !layerState._autoHopSuspended) {
      // Like enable()'s default: selected, its plane shown, but not activated.
      const id =
        parts.navigation.nearestStillCameraId(viewerPoint()) ||
        parts.navigation.nearestStillCameraId(request.point);
      if (!id) return;
      layerState._areaDefaultPending = false;
      layerState._activeCameraId = id;
      const record = parts.selection.getActiveRecord();
      parts.projection.ensureProjectionRuntime(record);
      parts.frames.refreshProjectionImage(record, true);
      parts.rendering.refreshCoverageStyles();
      parts.cards.refreshAmbientCards();
      parts.projection.startProjectionLoop();
      parts.presentation.notifyListeners();
    }
  }

  /**
   * A response still downloading a live pack for this area (`area.pending`)
   * is fetched once more after ~5 s. The refetch itself never schedules another.
   * @param {Object} request
   * @param {Object} area
   */

  function scheduleAreaRefetch(request, area) {
    if (
      request.refetch ||
      !Array.isArray(area?.pending) ||
      !area.pending.length
    )
      return;
    clearAreaRefetchTimer();
    layerState._areaRefetchTimer = setTimeout(() => {
      layerState._areaRefetchTimer = 0;
      if (
        !layerState._enabled ||
        layerState._areaRequest ||
        !layerState._area ||
        layerState._area.generation !== request.generation
      )
        return;
      requestArea(request.point, {
        refetch: true,
        seeded: layerState._area.seeded === true,
      });
      parts.presentation.notifyListeners();
    }, AREA_PENDING_REFETCH_MS);
  }

  /**
   * Starts loading the camera area around a point, replacing any load in
   * flight. With `arrival` (a camera flight to the point) the response is
   * applied once the flight lands, waiting at most 10 s.
   * @param {{lat:number, lon:number}} point
   * @param {Object} [options]
   * @param {Promise<unknown>|null} [options.arrival]
   * @param {{explicit:boolean, deselectSerial:number}|null} [options.nearest] - NEAREST intent.
   * @param {boolean} [options.refetch=false] - The one live-pack refetch.
   * @param {boolean} [options.seeded=false] - Loaded for the view, not a chosen
   *   place (a low settle or the enable default): a later low settle outside
   *   the area may replace it.
   * @returns {Object} The request (`promise` resolves true when applied).
   */

  function requestArea(
    point,
    { arrival = null, nearest = null, refetch = false, seeded = false } = {},
  ) {
    abortAreaRequest();
    clearAreaRefetchTimer();
    const generation = ++layerState._areaGeneration;
    const controller = new AbortController();
    const request = {
      point: { lat: point.lat, lon: point.lon },
      controller,
      generation,
      nearest,
      refetch,
      seeded: seeded === true,
      promise: null,
    };
    layerState._areaRequest = request;
    const current = () =>
      generation === layerState._areaGeneration && !controller.signal.aborted;
    request.promise = (async () => {
      try {
        const payload = await parts.catalog.loadAreaSources(
          request.point,
          controller.signal,
        );
        if (!current()) return false;
        const prepared = prepareAreaCatalog(payload.sources);
        if (arrival)
          await waitBounded(arrival, AREA_ARRIVAL_WAIT_MS, controller.signal);
        if (!current()) return false;
        if (
          !(await applyAreaSources(
            payload.sources,
            payload.area,
            generation,
            prepared,
            request,
          ))
        )
          return false;
        settleAreaCamera(request);
        scheduleAreaRefetch(request, payload.area);
        return true;
      } catch (error) {
        if (current()) {
          layerState._lastError = `Camera area load failed: ${error?.message || error}`;
          console.warn(
            '[Data:CCTV] camera area load failed:',
            error?.message || error,
          );
        }
        return false;
      } finally {
        if (layerState._areaRequest === request) {
          layerState._areaRequest = null;
          parts.presentation.notifyListeners();
        }
      }
    })();
    return request;
  }

  /**
   * A place was selected with the layer on. A point the loaded area covers
   * changes nothing (a load elsewhere still in flight is cancelled); a point a
   * load in flight already covers joins it; anything else starts a new load.
   * A chosen (not seeded) point marks the area it keeps or joins as chosen,
   * and a seeded point never replaces a chosen load in flight.
   * @param {{lat:number, lon:number}} point
   * @param {Object} [options] - requestArea options.
   * @returns {Promise<boolean>} Resolves when the area for the point is settled.
   */

  function selectArea(point, options = {}) {
    const seeded = options.seeded === true;
    const inFlight = layerState._areaRequest;
    if (
      inFlight &&
      cctvAreaCovers(
        { ...inFlight.point, radiusKm: CCTV_AREA_RADIUS_KM },
        point,
      )
    ) {
      if (options.nearest && !inFlight.nearest)
        inFlight.nearest = options.nearest;
      if (!seeded) inFlight.seeded = false;
      return inFlight.promise;
    }
    if (seeded && inFlight && !inFlight.seeded) return inFlight.promise;
    if (cctvAreaCovers(layerState._area, point)) {
      if (!seeded) layerState._area.seeded = false;
      if (inFlight) {
        abortAreaRequest();
        parts.presentation.notifyListeners();
      }
      return Promise.resolve(false);
    }
    const request = requestArea(point, options);
    parts.presentation.notifyListeners();
    return request.promise;
  }

  /**
   * Whether the view is below the 400 km seed altitude, low enough for the
   * point under it to be a place (never the globe view the app starts in).
   * @returns {boolean}
   */

  function viewLowEnoughForArea() {
    return (
      layerState._viewer?.camera?.positionCartographic?.height <
      AREA_SEED_MAX_ALTITUDE_M
    );
  }

  /**
   * Loads an area for the view once the layer is on: the place selected while
   * it was off, else the settled view below 400 km. A seeded area (loaded for
   * the view, not a chosen place) moves when a later low settle falls outside
   * it; a chosen area (a selection or an explicit NEAREST) stays until the
   * next selection.
   */

  function maybeSeedArea() {
    if (!layerState._enabled || !layerState._viewer) return;
    if (layerState._areaRequest && !layerState._areaRequest.seeded) return;
    if (layerState._pendingAreaPoint) {
      const point = layerState._pendingAreaPoint;
      layerState._pendingAreaPoint = null;
      selectArea(point);
      return;
    }
    if (layerState._area && !layerState._area.seeded) return;
    if (!viewLowEnoughForArea()) return;
    const point = viewerPoint();
    if (point) selectArea(point, { seeded: true });
  }

  // -------------------------------------------------------------------------
  // Location switch (DataLayerManager onLocationLeave / onLocationArrive)
  // -------------------------------------------------------------------------

  /**
   * Returns the id of the camera nearest a point within `radiusKm`, or null.
   * @param {{lat: number, lon: number}|null} point
   * @param {number} radiusKm
   * @param {Object} [options]
   * @param {boolean} [options.requireStill=false] - Skip cameras with no public still.
   * @returns {string|null}
   */

  function nearestCameraIdWithinKm(
    point,
    radiusKm,
    { requireStill = false } = {},
  ) {
    if (!point) return null;
    const matches = cctvRecordsWithinKm(
      layerState._records,
      point.lat,
      point.lon,
      radiusKm,
    );
    const match = requireStill
      ? matches.find(({ record }) => parts.model.cameraHasStill(record.camera))
      : matches[0];
    return match?.record.camera.id || null;
  }

  /**
   * Returns the viewer's ground point, or null without a camera.
   * @returns {{lat: number, lon: number}|null}
   */

  function viewerPoint() {
    const carto = layerState._viewer?.camera?.positionCartographic;
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  /**
   * Reads the coordinates of a location-switch endpoint
   * (`{ key, region, country, lat, lon }`).
   * @param {Object|null} place
   * @returns {{lat: number, lon: number}|null} Null when it carries none.
   */

  function locationSwitchPoint(place) {
    const lat = typeof place?.lat === 'number' ? place.lat : NaN;
    const lon = typeof place?.lon === 'number' ? place.lon : NaN;
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }

  /**
   * Whether a location switch still holds camera-driven card work. A switch
   * whose arrival never came (a gesture cancelled the flight) lets go after
   * LOCATION_SWITCH_STALE_MS and restarts the card pacer, so the ring cannot
   * stay empty for the rest of the session.
   * @returns {boolean}
   */

  function locationSwitchHoldsCards() {
    if (!layerState._locationSwitching) return false;
    if (
      Date.now() - layerState._locationSwitchStartedAt <
      LOCATION_SWITCH_STALE_MS
    )
      return true;
    layerState._locationSwitching = false;
    layerState._locationSwitchStartedAt = 0;
    if (layerState._enabled) parts.cards.startCardFrameLoop();
    return false;
  }

  /**
   * Location-switch leave: releases what the layer built for the view being
   * left. The loaded camera records, their billboards and ground priors stay
   * until the destination's area swap replaces them (onLocationSelect).
   * Synchronous and network-free; a second call finds nothing left to do.
   * @param {Object|null} to - Destination `{ key, region, country, lat, lon }`.
   */

  function beginLocationSwitch(to) {
    layerState._locationSwitching = true;
    layerState._locationSwitchStartedAt = Date.now();
    // A camera an earlier arrival still owed belongs to the place being left.
    layerState._areaCameraOwed = null;
    const point = locationSwitchPoint(to);
    const nearIds = new Set(
      cctvRecordsWithinKm(
        layerState._records,
        point?.lat,
        point?.lon,
        LOCATION_KEEP_RADIUS_KM,
      ).map(({ record }) => record.camera.id),
    );
    const active = layerState._activeCameraId
      ? layerState._recordById.get(layerState._activeCameraId)
      : null;
    const keepActive =
      !!active &&
      !!point &&
      haversineKm(point.lat, point.lon, active.camera.lat, active.camera.lon) <=
        LOCATION_KEEP_ACTIVE_RADIUS_KM;

    // Map cards: the pacer stops and detaches its in-flight frame requests;
    // the ring, grace state and hover card go. Thumbnails near the destination
    // stay so its first cards paint without a placeholder flash.
    parts.cards.stopCardFrameLoop();
    parts.hover.clearHoverCard();
    layerState._cardIds = new Set();
    layerState._cardGraceState = new Map();
    for (const id of [...layerState._cardFrameSlots.keys()]) {
      if (!nearIds.has(id)) layerState._cardFrameSlots.delete(id);
    }
    // The drain is ordered for the view being left; arrival queues the
    // destination's unresolved cameras nearest first.
    parts.geometryQueue.stopGeometryLoadQueue();

    // ADJUST does not survive a switch, just as it does not survive a toggle.
    if (layerState._calibrationMode) {
      layerState._calibrationMode = false;
      releaseContinuousRender('cctv-adjust');
    }
    layerState._gizmo?.setEnabled(false);

    // The active camera goes unless it sits at the destination. Unlike
    // deactivateActiveCamera this leaves AUTO HOP's suspend state alone: a
    // switch is not the user's empty-space deselect. Arrival selects a
    // destination camera in its place; a leave that supersedes this one finds
    // nothing active and keeps that owed.
    const released = active && !keepActive ? active : null;
    layerState._locationSwitchHadActive ||= !!released;
    if (released) {
      layerState._activeCameraId = null;
      released.activationDone = false;
    }

    // Monitor planes: only the active camera shows one, so every other runtime
    // is dead weight (a 1920x1080 canvas and its buffers, a frame request or
    // video, the plane entity). The self-stopping projection loop idles out.
    const keptRuntime = keepActive ? active.projection : null;
    for (const runtime of layerState._projectionEntities) {
      if (runtime !== keptRuntime)
        parts.projection.releaseProjectionRuntime(runtime);
    }
    for (const record of layerState._records) {
      if (record.projection && record.projection !== keptRuntime) {
        parts.projection.releaseProjectionRuntime(record.projection);
      }
    }
    layerState._projectionEntities = layerState._projectionEntities.filter(
      (runtime) => runtime === keptRuntime,
    );

    // Viewshed volumes and wireframes rebuild lazily for whatever is active or
    // in coverage view next; only those near the destination stay.
    const farWithWireframes = [];
    for (const record of layerState._records) {
      const near = nearIds.has(record.camera.id);
      if (record.viewshedPrimitive && !(keepActive && near))
        parts.geometry.destroyViewshedVolume(record);
      if (record.coverageEntities?.length && !near)
        farWithWireframes.push(record);
    }
    releaseCoverageEntities(farWithWireframes);

    if (released) {
      // Nominal geometry for the camera left behind, then the null-active
      // styles (idle icon colour, hidden wireframes, paused feeds).
      parts.geometry.clearProbeClampOnDeactivation(released, (previous) => {
        parts.geometry.applyFrustumGeometry(
          previous,
          parts.ground.groundAltFor(previous),
        );
      });
      parts.rendering.refreshCoverageStyles();
      layerState._gizmo?.refresh();
    }

    if (layerState._enabled) parts.cards.pushAmbientCardEntries();
    // With no active camera the panel drops its preview frame request (and any
    // browser-direct still).
    parts.presentation.notifyListeners();
  }

  /**
   * Location-switch arrival: resumes camera-driven work for the destination
   * at once instead of waiting for the next moveEnd or poll.
   * @param {Object|null} to - Destination `{ key, region, country, lat, lon }`.
   */

  function endLocationSwitch(to) {
    layerState._locationSwitching = false;
    layerState._locationSwitchStartedAt = 0;
    // The arrival consumes what this switch released, whichever way it ends.
    const hadActive = layerState._locationSwitchHadActive;
    layerState._locationSwitchHadActive = false;
    // A layer that is off resumes in enable(), which reads the view it finds.
    if (!layerState._enabled || !layerState._viewer) return;
    const point = locationSwitchPoint(to) || viewerPoint();

    parts.cards.startCardFrameLoop();
    // Select the destination's camera with a still, without flying;
    // setActiveCamera also reselects the card ring and notifies the panel.
    // Only in place of the camera this switch released, when the destination
    // asks for one (a private security-site pill), or when enable found none
    // to default to. A camera the user deliberately deselected (an empty-map
    // click, which is also the click that started this switch) stays
    // deselected, and AUTO HOP stays held. Arrival is never an explicit
    // activation.
    const wantsCamera =
      to?.selectCamera === true ||
      (!layerState._autoHopSuspended &&
        (hadActive || layerState._areaDefaultPending));
    let activated = false;
    if (!layerState._activeCameraId && wantsCamera) {
      const nearestId = parts.navigation.nearestStillCameraId(point);
      activated =
        !!nearestId &&
        parts.selection.setActiveCamera(nearestId) ===
          CCTV_ACTIVATION_RESULT.ACTIVATED;
      if (activated) layerState._areaDefaultPending = false;
      // The destination's cameras are still loading (the load outlived the
      // arrival wait): the camera is picked when they land.
      if (!nearestId && layerState._areaRequest)
        layerState._areaCameraOwed = point;
    }
    if (!activated) parts.cards.refreshAmbientCards();

    // Ground-resolve the destination's unresolved cameras, nearest first.
    const regime = parts.ground.currentSurfaceRegime();
    const unresolved = cctvRecordsWithinKm(
      layerState._records,
      point?.lat,
      point?.lon,
      LOCATION_KEEP_RADIUS_KM,
    )
      .filter(({ record }) => !parts.ground.isGroundResolved(record, regime))
      .map(({ record }) => record);
    if (unresolved.length) {
      layerState._geoReanchorCardsOnDrain = true;
      parts.geometryQueue.enqueueGeometryRefresh(unresolved);
    }
    parts.projection.startProjectionLoop();
    if (!activated) parts.presentation.notifyListeners();
  }

  return {
    refreshOsmCredit,
    isPrivateRecord,
    prepareCameras,
    boundedGroundPriors,
    createCameraRecord,
    releaseCoverageEntities,
    destroyCameraRecords,
    privateSourceKey,
    applyPrivateSources,
    scheduleCatalogReload,
    normalizeArea,
    abortAreaRequest,
    clearAreaRefetchTimer,
    prepareAreaCatalog,
    applyAreaSources,
    settleAreaCamera,
    scheduleAreaRefetch,
    requestArea,
    selectArea,
    viewLowEnoughForArea,
    maybeSeedArea,
    nearestCameraIdWithinKm,
    viewerPoint,
    locationSwitchPoint,
    locationSwitchHoldsCards,
    beginLocationSwitch,
    endLocationSwitch,
  };
}
