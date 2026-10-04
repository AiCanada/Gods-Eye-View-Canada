import {
  CCTV_AREA_LOAD_CAP,
  GEO_PROGRESS_NOTIFY_INTERVAL_MS,
  GEO_PROGRESS_NOTIFY_BATCH_LIMIT,
  GEO_TRACKING_BATCH_SIZE,
  GEO_TRACKING_BATCH_DELAY_MS,
  GEO_LOAD_BATCH_SIZE,
  GEO_LOAD_BATCH_DELAY_MS,
} from './policy.js';

export function createGeometryQueue({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Stops the staggered geometry-load queue and optionally clears progress
   * counters (kept when pausing mid-flight is not needed — we always clear).
   * @param {boolean} [clearProgress=true]
   */

  function stopGeometryLoadQueue(clearProgress = true) {
    if (layerState._geoQueueTimer) {
      clearTimeout(layerState._geoQueueTimer);
      layerState._geoQueueTimer = 0;
    }
    layerState._geoQueue = [];
    layerState._geoQueueSet = new Set();
    layerState._geoProgressNotifier = null;
    layerState._geoReanchorCardsOnDrain = false;
    if (clearProgress) {
      layerState._geoLoading = false;
      layerState._geoLoadTotal = 0;
      layerState._geoLoadDone = 0;
    }
  }

  /**
   * Creates the notification coalescer used by a staggered geometry drain.
   * Progress emits after roughly 300 ms or ten batches, whichever comes first;
   * finish always emits once even when the last progress tick just fired.
   *
   * @param {Function} notify Notification callback.
   * @param {Object} [options={}] Testable timing options.
   * @param {() => number} [options.now] Monotonic clock returning milliseconds.
   * @param {number} [options.intervalMs] Maximum progress-notification cadence.
   * @param {number} [options.batchLimit] Maximum batches between progress ticks.
   * @returns {{ progress: () => boolean, finish: () => void }} Drain notifier.
   */

  function createGeometryProgressNotifier(notify, options = {}) {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const intervalMs = Number.isFinite(options.intervalMs)
      ? Math.max(0, options.intervalMs)
      : GEO_PROGRESS_NOTIFY_INTERVAL_MS;
    const batchLimit = Number.isFinite(options.batchLimit)
      ? Math.max(1, Math.floor(options.batchLimit))
      : GEO_PROGRESS_NOTIFY_BATCH_LIMIT;
    let lastNotifyAt = now();
    let batchesSinceNotify = 0;

    return {
      progress() {
        batchesSinceNotify += 1;
        const current = now();
        if (
          current - lastNotifyAt < intervalMs &&
          batchesSinceNotify < batchLimit
        ) {
          return false;
        }
        batchesSinceNotify = 0;
        lastNotifyAt = current;
        notify?.();
        return true;
      },
      finish() {
        batchesSinceNotify = 0;
        lastNotifyAt = now();
        notify?.();
      },
    };
  }

  /**
   * Processes one geometry-queue batch and routes progress/completion through
   * the callbacks shared by production and the unit drain harness.
   *
   * @param {Object} options Batch inputs.
   * @param {Object[]} options.queue Mutable record queue.
   * @param {number} options.batchSize Maximum records to visit.
   * @param {(record: Object) => void} options.visit Per-record geometry work.
   * @param {() => void} options.progress Coalesced progress publication.
   * @param {() => void} options.complete Unconditional completion publication.
   * @returns {boolean} True when more records remain.
   */

  function processCctvGeometryQueueBatch({
    queue,
    batchSize,
    visit,
    progress,
    complete,
  }) {
    const safeQueue = Array.isArray(queue) ? queue : [];
    const take = Number.isFinite(batchSize)
      ? Math.max(1, Math.floor(batchSize))
      : 1;
    const batch = safeQueue.splice(0, take);
    for (const record of batch) visit?.(record);
    if (safeQueue.length) {
      progress?.();
      return true;
    }
    complete?.();
    return false;
  }

  /**
   * Selects per-batch geometry-drain pacing from current camera ownership.
   * Called for every batch so releasing tracking immediately restores normal
   * throughput without restarting the queue.
   *
   * @param {Object} [ownership={}] Current camera-ownership state.
   * @param {*} [ownership.trackedEntity] Cesium tracked entity, if any.
   * @param {boolean} [ownership.cockpitActive] Whether cockpit owns the camera.
   * @returns {{ batchSize: number, delayMs: number }} Drain pacing.
   */

  function cctvGeometryDrainPacing({
    trackedEntity = null,
    cockpitActive = false,
  } = {}) {
    if (trackedEntity || cockpitActive) {
      return {
        batchSize: GEO_TRACKING_BATCH_SIZE,
        delayMs: GEO_TRACKING_BATCH_DELAY_MS,
      };
    }
    return { batchSize: GEO_LOAD_BATCH_SIZE, delayMs: GEO_LOAD_BATCH_DELAY_MS };
  }

  /**
   * Processes one tracking-aware geometry-drain batch. Ownership is read inside
   * every call so a mid-drain tracking/cockpit transition changes the very next
   * batch's size and delay.
   *
   * @param {Object} options Batch inputs.
   * @param {Object[]} options.queue Mutable record queue.
   * @param {() => Object} [options.readOwnership] Current camera ownership.
   * @param {(record: Object) => void} options.visit Per-record geometry work.
   * @param {() => void} options.progress Coalesced progress publication.
   * @param {() => void} options.complete Unconditional completion publication.
   * @returns {{ hasMore: boolean, batchSize: number, delayMs: number }} Batch result and pacing.
   */

  function processCctvGeometryDrainBatch({
    queue,
    readOwnership,
    visit,
    progress,
    complete,
  }) {
    const pacing = cctvGeometryDrainPacing(readOwnership?.() || {});
    const hasMore = processCctvGeometryQueueBatch({
      queue,
      batchSize: pacing.batchSize,
      visit,
      progress,
      complete,
    });
    return { hasMore, ...pacing };
  }

  /**
   * Moves the current active record to the front of a live drain queue.
   * @param {Object[]} queue Mutable geometry queue.
   * @param {Object|null} activeRecord Current active CCTV record.
   * @returns {boolean} Whether the queue order changed.
   */

  function prioritizeActiveCctvGeometryRecord(queue, activeRecord) {
    if (!Array.isArray(queue) || !activeRecord) return false;
    const index = queue.indexOf(activeRecord);
    if (index <= 0) return false;
    queue.splice(index, 1);
    queue.unshift(activeRecord);
    return true;
  }

  /**
   * Processes one batch (GEO_LOAD_BATCH_SIZE records) of the geometry queue:
   * full ground-sampled coverage geometry per record, then yields back to the
   * event loop before the next batch so tile rendering never stalls. When the
   * initial-load pass completes it clears the loading flag and refreshes styles.
   */

  function processGeometryBatch() {
    layerState._geoQueueTimer = 0;
    if (!layerState._viewer) {
      stopGeometryLoadQueue();
      return;
    }
    // Active-camera-first is re-established every batch because the operator
    // can select a new camera while a long catalog drain is in flight.
    prioritizeActiveCctvGeometryRecord(
      layerState._geoQueue,
      parts.selection.getActiveRecord(),
    );
    const batchResult = processCctvGeometryDrainBatch({
      queue: layerState._geoQueue,
      readOwnership: () => ({
        trackedEntity: layerState._viewer.trackedEntity,
        cockpitActive:
          typeof document !== 'undefined' &&
          document.body?.classList.contains('cockpit-mode'),
      }),
      visit: (record) => {
        layerState._geoQueueSet.delete(record);
        try {
          parts.geometry.updateRecordGeometry(record);
        } catch (err) {
          console.warn(
            '[Data:CCTV] geometry refresh error:',
            err?.message || err,
          );
        }
        if (
          layerState._geoLoading &&
          layerState._geoLoadDone < layerState._geoLoadTotal
        ) {
          layerState._geoLoadDone += 1;
        }
      },
      progress: () => layerState._geoProgressNotifier?.progress(),
      complete: () => {
        const wasInitialLoad = layerState._geoLoading;
        const reanchorCards = layerState._geoReanchorCardsOnDrain;
        layerState._geoLoading = false;
        layerState._geoReanchorCardsOnDrain = false;
        if (wasInitialLoad) {
          layerState._geoLoadDone = layerState._geoLoadTotal;
          if (layerState._enabled) {
            parts.rendering.refreshCoverageStyles();
            // Geometry refinement may have replaced record.position objects — the
            // one-shot drain completion re-anchors the card entries (event-driven,
            // not a per-frame or timer pass).
            parts.cards.refreshAmbientCards();
          }
        } else if (reanchorCards && layerState._enabled) {
          // Same re-anchor for a location-switch arrival drain.
          parts.cards.refreshAmbientCards();
        }
        // Completion is never coalesced: subscribers must observe the final
        // loading state even if the last progress tick just happened.
        layerState._geoProgressNotifier?.finish();
        layerState._geoProgressNotifier = null;
      },
    });
    if (batchResult.hasMore) {
      layerState._geoQueueTimer = setTimeout(
        processGeometryBatch,
        batchResult.delayMs,
      );
      return;
    }
  }

  /**
   * Appends records to the geometry queue (no progress tracking) and starts
   * the batch timer if idle. Used by update()'s ONE-SHOT tiles-ready completion
   * pass (records left `!groundResolved` by an enable-time drain that ran while
   * tiles were still streaming) so it shares the same stagger machinery as the
   * initial load. Fires at most once per enable — never on a recurring timer.
   * @param {Object[]} records - Camera records needing geometry refresh.
   */

  function enqueueGeometryRefresh(records) {
    for (const record of records) {
      if (!layerState._geoQueueSet.has(record)) {
        layerState._geoQueueSet.add(record);
        layerState._geoQueue.push(record);
      }
    }
    if (!layerState._geoQueueTimer && layerState._geoQueue.length) {
      layerState._geoProgressNotifier = createGeometryProgressNotifier(
        parts.presentation.notifyListeners,
      );
      layerState._geoQueueTimer = setTimeout(processGeometryBatch, 0);
    }
  }

  /**
   * Queues the given records that are still unresolved for the current surface
   * regime: active camera first, then nearest `center` first, with loaded/total
   * progress through uiState()/getStats(). Records already resolved or already
   * queued are skipped, so an enable after a disable, or an area swap that keeps
   * most cameras, never re-walks what is done.
   * @param {Object[]} records - Candidate records (only live ones are queued).
   * @param {{lat:number, lon:number}|null} [center] - Distance reference.
   * @param {Object} [options]
   * @param {boolean} [options.restartProgress=false] - Count progress from this
   *   queue alone (an area swap), so the total never exceeds one area's cameras.
   * @returns {number} Records added to the queue.
   */

  function queueUnresolvedGeometry(
    records,
    center = null,
    { restartProgress = false } = {},
  ) {
    const regime = parts.ground.currentSurfaceRegime();
    const pending = [];
    for (const record of Array.isArray(records) ? records : []) {
      if (
        !record?.camera ||
        layerState._geoQueueSet.has(record) ||
        parts.ground.isGroundResolved(record, regime)
      )
        continue;
      if (layerState._recordById.get(record.camera.id) !== record) continue;
      pending.push(record);
    }
    if (!pending.length) return 0;
    const active = parts.selection.getActiveRecord();
    const refLat = Number.isFinite(center?.lat)
      ? center.lat
      : (active?.camera.lat ?? 0);
    const refLon = Number.isFinite(center?.lon)
      ? center.lon
      : (active?.camera.lon ?? 0);
    const ordered = pending
      .map((record) => ({
        record,
        distKm: parts.model.haversineKm(
          refLat,
          refLon,
          record.camera.lat,
          record.camera.lon,
        ),
      }))
      .sort((a, b) => a.distKm - b.distKm)
      .map((entry) => entry.record);
    if (!layerState._geoLoading || restartProgress) layerState._geoLoadDone = 0;
    for (const record of ordered) {
      layerState._geoQueueSet.add(record);
      layerState._geoQueue.push(record);
    }
    prioritizeActiveCctvGeometryRecord(layerState._geoQueue, active);
    layerState._geoLoading = true;
    layerState._geoLoadTotal = Math.min(
      CCTV_AREA_LOAD_CAP,
      layerState._geoLoadDone + layerState._geoQueue.length,
    );
    layerState._geoProgressNotifier ||= createGeometryProgressNotifier(
      parts.presentation.notifyListeners,
    );
    if (!layerState._geoQueueTimer)
      layerState._geoQueueTimer = setTimeout(processGeometryBatch, 0);
    return ordered.length;
  }
  return {
    stopGeometryLoadQueue,
    createGeometryProgressNotifier,
    processCctvGeometryQueueBatch,
    cctvGeometryDrainPacing,
    processCctvGeometryDrainBatch,
    prioritizeActiveCctvGeometryRecord,
    processGeometryBatch,
    enqueueGeometryRefresh,
    queueUnresolvedGeometry,
  };
}
