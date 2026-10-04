import * as Cesium from 'cesium';
import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';

export function createLifecycle({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { restoreSpriteOrderOnEnable } = services.sprites;
  const { clearSelectedEntityContextForLayer } = services.context;
  const { id, overlayHost } = config;

  const methods = {
    init(viewer) {
      if (layerState._destroyed) return;
      layerState._viewer = viewer;
      layerState._dataSource = new Cesium.CustomDataSource(id);
      layerState._dataSource.show = false;
      viewer.dataSources.add(layerState._dataSource);
    },

    async enable(viewer) {
      if (layerState._destroyed) return;
      layerState._enabled = true;
      // Arrival only reaches enabled layers, so a switch that happened while
      // this layer was off never lifted its rebuild hold.
      layerState._locationSwitching = false;
      layerState._viewer = viewer;
      if (!layerState._dataSource) this.init(viewer);
      if (layerState._dataSource) layerState._dataSource.show = true;
      if (layerState._billboards) {
        // The camera can have moved anywhere while the layer was off: moveEnd
        // was not being listened to, and the preRender watcher is inert while
        // disabled AND while the (untimed) refetch below is in flight. So the
        // retained per-sprite show flags describe the OLD viewpoint. Re-cull
        // BEFORE the collection becomes visible — otherwise re-enabling at a
        // new location flashes far-side fires through the planet (and keeps
        // near-side ones hidden) until the fetch resolves.
        components.rendering.refreshHorizonCulling();
        layerState._billboards.show = true;
      }
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, true);
      components.viewport.installLodWatcher();
      components.viewport.installMoveEndWatcher();
      components.selection.installClickHandler();
      registerPickOwner(id, (pickedId) =>
        layerState._pickIndexById.has(pickedId),
      );
      // A location switch while off released the rendered view (the LOD memo
      // reads -1 only then, once data exists): draw the current view now
      // instead of waiting for a camera move to wake the LOD watcher.
      if (
        layerState._fires.length &&
        !layerState._loading &&
        layerState._currentLodIndex < 0
      )
        components.rendering.renderCurrentLod(true);
      if (!layerState._fires.length && !layerState._loading)
        await components.ingestion.loadHeatmap();
      if (
        layerState._enabled &&
        !layerState._destroyed &&
        layerState._viewer === viewer
      )
        restoreSpriteOrderOnEnable('firms', viewer);
    },

    disable() {
      layerState.request?.abort();
      layerState.request = null;
      layerState._loading = false;
      layerState._enabled = false;
      components.selection.clearFireSelection();
      if (layerState._dataSource) layerState._dataSource.show = false;
      if (layerState._billboards) layerState._billboards.show = false;
      overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, false);
      clearSelectedEntityContextForLayer(id);
      components.selection.removeClickHandler();
      components.viewport.removeMoveEndWatcher();
      unregisterPickOwner(id);
      components.viewport.removeLodWatcher();
    },

    /**
     * Location switch start, for this layer on or off. The fire dataset is
     * worldwide (one trailing-24h payload plus its per-grid cell aggregation),
     * so it is not old-location data and is kept: dropping it would re-download
     * the whole feed. What goes is everything built for the old VIEW (sprites,
     * cell rectangles, the pick and card indexes, the published cards, the
     * context-store top-N and the fire selection), and every rebuild is held
     * until {@link onLocationArrive}. Nothing near the destination is kept:
     * the arrival render rebuilds it from the kept data in one clip pass.
     * The in-flight poll is global, so it is left to land. Idempotent, no
     * network, never throws.
     */
    onLocationLeave() {
      if (layerState._destroyed) return;
      layerState._locationSwitching = true;
      try {
        releaseRenderedView();
      } catch (error) {
        console.warn(`[Data:${id}] FIRMS location release failed:`, error);
      }
    },

    /**
     * Location switch end (camera arrived, layer enabled): lift the rebuild
     * hold and draw the destination now instead of on the next throttled
     * preRender tick. An aborted arrival was superseded by a newer switch,
     * which owns the hold, so it changes nothing.
     */
    onLocationArrive({ signal } = {}) {
      if (layerState._destroyed || signal?.aborted) return;
      layerState._locationSwitching = false;
      if (!layerState._enabled) return;
      try {
        components.rendering.renderCurrentLod(true);
        components.rendering.refreshHorizonCulling();
      } catch (error) {
        console.warn(
          `[Data:${id}] FIRMS location arrival render failed:`,
          error,
        );
      }
    },

    destroy(viewer = layerState._viewer) {
      layerState.request?.abort();
      layerState.request = null;
      layerState._loading = false;
      if (layerState._destroyed) return;
      layerState._destroyed = true;
      layerState._enabled = false;
      layerState._locationSwitching = false;
      components.viewport.removeLodWatcher();
      components.viewport.removeMoveEndWatcher();
      components.selection.removeClickHandler();
      unregisterPickOwner(id);
      if (layerState._dataSource && viewer) {
        viewer.dataSources.remove(layerState._dataSource, true);
      }
      layerState._dataSource = null;
      components.rendering.removeDetectionCollections(viewer);
      components.selection.clearContextRegistrations();
      clearSelectedEntityContextForLayer(id);
      layerState._fires = [];
      layerState._firesByFrp = [];
      layerState._cellCacheByGrid.clear();
      layerState._count = 0;
      layerState._cellCount = 0;
      layerState._lastUpdate = null;
      layerState._keyRequired = false;
      layerState._stale = false;
      layerState._error = null;
      layerState._currentLodId = null;
      overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, false);
      layerState._currentLodIndex = -1;
      layerState._lastViewRect = null;
      layerState._selectedFire = null;
      layerState._labelCandidates = [];
      layerState._labelLodDistance = 0;
      layerState._pickIndexById.clear();
      layerState._fireByCardId.clear();
      layerState._cullPositions.length = 0;
      layerState._camSnapValid = false;
    },
  };

  /**
   * Drop everything built for the rendered view, keeping the global dataset
   * and its per-grid cell cache. The selection is cleared as a deliberate
   * deselect (no eviction tag: the detection is still in the feed) and BEFORE
   * the context sweep, for the ownership-guard reason documented in
   * loadHeatmap. No cards are republished. The LOD/view memo and the idle
   * camera snapshot are reset so the next render always rebuilds.
   */
  function releaseRenderedView() {
    components.selection.clearFireSelection({ republish: false });
    components.selection.clearContextRegistrations();
    if (layerState._dataSource) layerState._dataSource.entities.removeAll();
    if (layerState._billboards) layerState._billboards.removeAll();
    layerState._pickIndexById.clear();
    layerState._fireByCardId.clear();
    layerState._cullPositions.length = 0;
    layerState._labelCandidates = [];
    layerState._cellCount = 0;
    overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
    layerState._currentLodIndex = -1;
    layerState._currentLodId = null;
    layerState._lastViewRect = null;
    layerState._camSnapValid = false;
  }

  return { methods };
}
