import * as Cesium from 'cesium';
import { LAYER_ID, LOCATION_SWITCH_SUSPEND_MAX_MS } from './policy.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../data/cameraSensitivity.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { clearSelectedEntityContextForLayer } = services.context;

  const methods = {
    init(viewer) {
      layerState.viewer = viewer;
      layerState.dataSource = new Cesium.CustomDataSource(
        'military-installations',
      );
      viewer.dataSources.add(layerState.dataSource);
      const cameraChanged = () => {
        if (!layerState.contextAnchor) parts.viewport.scheduleLoad();
      };
      layerState.moveEndRemove =
        viewer.camera.moveEnd.addEventListener(cameraChanged);
      layerState.changedRemove =
        viewer.camera.changed?.addEventListener(cameraChanged);
      parts.selection.installInteraction(viewer);
    },

    enable() {
      layerState.enabled = true;
      // A layer switched on after it was left while disabled gets no arrival
      // hook; its own first load and later moveEnds must not stay muted.
      layerState.suspendedUntil = 0;
      layerState.surfaceChangedRemove ||= services.maps?.subscribeMapStack(
        parts.rendering.syncSelectionFill,
      );
      // Cached markers and geometry become visible before the next fetch.
      if (
        layerState.records?.some((r) =>
          r.sources?.some((s) => s.name === 'OpenStreetMap'),
        )
      )
        services.credits?.showOsmCredit?.(layerState.viewer, LAYER_ID, {
          openMapTiles: layerState.records.some((r) =>
            r.sources?.some(
              (s) => s.name === 'OpenStreetMap' && s.id?.startsWith('tile:'),
            ),
          ),
        });
      parts.namedMarkers?.enable();
      parts.namedMarkers?.sync(layerState.records || []);
      claimCameraSensitivity(layerState.viewer.camera, LAYER_ID, 0.01);
      registerPickOwner(LAYER_ID, (id) => layerState.recordById.has(id));
      layerState.dataSource.show = true;
      // DataLayerManager invokes update() immediately after enable(), which owns
      // the first fetch. Avoid racing it with a second aborting request here.
    },

    disable() {
      layerState.enabled = false;
      services.credits?.hideOsmCredit?.(layerState.viewer, LAYER_ID);
      parts.namedMarkers?.hide();
      releaseCameraSensitivity(layerState.viewer?.camera, LAYER_ID);
      layerState.contextAnchor = null;
      layerState.contextPosition = null;
      layerState.coverage = { kind: 'viewport' };
      layerState.cameraLoadKey = null;
      layerState.cameraLoadOwner = null;
      unregisterPickOwner(LAYER_ID);
      parts.viewport.clearUnavailableRetry();
      clearTimeout(layerState.timer);
      layerState.abort?.abort();
      layerState.abort = null;
      layerState.loading = false;
      layerState.loadingKey = null;
      if (layerState.dataSource) layerState.dataSource.show = false;
      clearSelectedEntityContextForLayer(LAYER_ID);
      layerState.selectedId = null;
      parts.rendering.clearSelectionFill?.();
      layerState.surfaceChangedRemove?.();
      layerState.surfaceChangedRemove = null;
      layerState.failureReason = null;
      parts.ingestion.setInstallationStatus('idle');
    },

    /**
     * Location switch start (DataLayerManager hook, every initialized layer).
     *
     * Everything this layer holds was fetched for the viewport being left, so it
     * cancels that view's debounce, retry and in-flight fetch, releases the
     * records, entities, contexts and selection built for it, and mutes
     * camera-driven loads until onLocationArrive, so neither a mid-flight moveEnd
     * nor a backoff retry queries the flight path. The selection clear is tagged
     * 'location-switch', so a Contacts subject on the selected site survives the
     * switch with no CONTACT LOST cue; FOCUS can reselect it once a later load
     * brings that site back into the records. Nothing is kept near the
     * destination: a viewport is at most 10 degrees and the proxy's snapped-bbox
     * cache makes the arrival query cheap. Enablement and persisted params are
     * untouched; a disabled layer only hid its sites, so it releases them too.
     * Idempotent, synchronous, no network, never throws.
     */
    onLocationLeave() {
      try {
        layerState.suspendedUntil = Date.now() + LOCATION_SWITCH_SUSPEND_MAX_MS;
        clearTimeout(layerState.timer);
        layerState.timer = null;
        parts.viewport.clearUnavailableRetry();
        layerState.abort?.abort();
        layerState.abort = null;
        layerState.loading = false;
        layerState.loadingKey = null;
        layerState.cameraLoadKey = null;
        layerState.cameraLoadOwner = null;
        layerState.googleSearchRequested = false;
        layerState.failureReason = null;
        parts.ingestion.releaseRecords({ reason: 'location-switch' });
        parts.ingestion.setInstallationStatus('idle');
      } catch (error) {
        console.warn(
          '[Data:military-installations] location leave cleanup failed',
          error,
        );
      }
    },

    /**
     * Location switch arrival (DataLayerManager hook, enabled layers only): lift
     * the suspension and query the arrived view now instead of waiting out the
     * moveEnd debounce. An aborted arrival belongs to a switch a newer one
     * replaced, whose own leave holds the suspension, so it does nothing.
     * @param {{signal?: AbortSignal}} [context]
     * @returns {Promise<void>|undefined} The arrival load, when one started.
     */
    onLocationArrive({ signal } = {}) {
      if (signal?.aborted) return undefined;
      layerState.suspendedUntil = 0;
      if (!layerState.enabled) return undefined;
      return parts.ingestion.loadInstallations().catch((error) => {
        console.warn(
          '[Data:military-installations] arrival load failed',
          error,
        );
      });
    },

    destroy(viewer) {
      source.destroy?.();
      this.disable();
      layerState.contextAnchor = null;
      layerState.contextPosition = null;
      layerState.coverage = { kind: 'viewport' };
      layerState.moveEndRemove?.();
      layerState.changedRemove?.();
      parts.selection.destroy?.();
      layerState.clickHandler?.destroy();
      layerState.clickHandler = null;
      parts.namedMarkers?.destroy();
      parts.rendering.clearRendered();
      if (layerState.dataSource && viewer)
        viewer.dataSources.remove(layerState.dataSource, true);
      layerState.dataSource = null;
    },
  };

  return { methods };
}
