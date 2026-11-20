import { drawOf } from '../../render/rendererOf.js';
import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';

/**
 * The layer's shape sets start with this; each layer has its own
 * (`firms:1:cells`, …), so several can share a renderer.
 */
export const FIRMS_CELL_SET_PREFIX = 'firms';
let instances = 0;

export function createLifecycle({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { clearSelectedEntityContextForLayer } = services.context;
  const { id, overlayHost } = config;

  const methods = {
    /**
     * Shell services: `imageryHost()` resolves where draped imagery goes on
     * the active map stack (globe or 3D tiles, src/maps/imageryHost.js). The
     * heatmap moves with it; without a host it drapes on viewer.imageryLayers.
     * @param {{imageryHost?: () => {collection: ?Object, kind: string}}|null} services
     */
    attachShellServices(services) {
      layerState._imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      layerState._heatImagery?.rehome();
    },

    init(viewer) {
      if (layerState._destroyed) return;
      layerState._viewer = viewer;
      layerState._cells = drawOf(viewer).shapes({
        id: `${FIRMS_CELL_SET_PREFIX}:${++instances}:cells`,
        clampTo: 'both',
        show: false,
      });
    },

    async enable(viewer) {
      if (layerState._destroyed) return;
      layerState._enabled = true;
      // Arrival only reaches enabled layers, so a switch that happened while
      // this layer was off never lifted its rebuild hold.
      layerState._locationSwitching = false;
      layerState._viewer = viewer;
      if (!layerState._cells) this.init(viewer);
      if (layerState._cells) layerState._cells.show = true;
      // The GPU culls the far side each frame, so retained rows are right
      // for wherever the camera went while the layer was off.
      if (layerState._icons) layerState._icons.show = !layerState._standIn;
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, true);
      // A filter can leave an old raster cached while the current set is empty.
      layerState._heatImagery?.setShow(
        layerState._fires.length > 0 && !layerState._standIn,
      );
      // The camera can have crossed the hand-off while the layer was off.
      components.rendering.applyHandoffFade(true);
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
    },

    /**
     * Let an application draw the detections in place of the layer's
     * markers. While a stand-in is set, the glows, the heatmap and the
     * ambient cards are hidden and everything else works as before: a click
     * on a fire the stand-in draws (`standIn.hitTest(screenPosition)`, which
     * answers a detection record from the same source, or null) selects it
     * and moves the camera to it as a click on its marker does, the selected
     * fire's card shows, and a click on empty space clears the selection.
     * Its optional `focusRangeM(record)` gives how far, in metres, the camera
     * stands from a fire it draws when moving to it, for fires drawn larger
     * than a marker; without one, or for null, the usual fire framing holds.
     * `null` brings the markers back. The selection is kept either way.
     * @param {?{hitTest: (screenPosition: {x: number, y: number}) => ?Object, focusRangeM?: (record: Object) => ?number}} standIn
     */
    setMarkerStandIn(standIn) {
      layerState._standIn =
        typeof standIn?.hitTest === 'function' ? standIn : null;
      layerState._heatImagery?.setShow(
        layerState._enabled &&
          layerState._fires.length > 0 &&
          !layerState._standIn,
      );
      components.rendering.applyHandoffFade(true);
      components.cards.rebuildAmbientLabels();
    },

    disable() {
      layerState.request?.abort();
      layerState.request = null;
      layerState._loading = false;
      layerState._enabled = false;
      components.selection.clearFireSelection();
      if (layerState._cells) layerState._cells.show = false;
      if (layerState._icons) layerState._icons.show = false;
      layerState._heatImagery?.setShow(false);
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
        // The GPU culls the far side from the arrival camera on its own.
        components.rendering.renderCurrentLod(true);
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
      layerState._cells?.dispose();
      layerState._cells = null;
      components.rendering.removeDetectionCollections(viewer);
      components.selection.clearContextRegistrations();
      clearSelectedEntityContextForLayer(id);
      layerState._allFires = [];
      layerState._allFiresByFrp = [];
      layerState._fires = [];
      layerState._firesByFrp = [];
      layerState._cellCacheByGrid.clear();
      clearTimeout(layerState._heatRebuildTimer);
      layerState._heatRebuildTimer = null;
      layerState._heatImagery?.destroy();
      layerState._heatImagery = null;
      layerState._heatRaster = null;
      layerState._handoffHeat = -1;
      layerState._imageryHost = null;
      layerState._count = 0;
      layerState._totalCount = 0;
      layerState._rowControlsListener = null;
      layerState._cellCount = 0;
      layerState._lastUpdate = null;
      layerState._at = null;
      layerState._keyRequired = false;
      layerState._stale = false;
      layerState._error = null;
      layerState._currentLodId = null;
      overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, false);
      layerState._currentLodIndex = -1;
      layerState._lastViewRect = null;
      layerState._selectedFire = null;
      layerState._standIn = null;
      layerState._labelCandidates = [];
      layerState._labelLodDistance = 0;
      layerState._pickIndexById.clear();
      layerState._fireByCardId.clear();
      layerState._camSnapValid = false;
    },
  };

  /**
   * Drop everything built for the rendered view (the glow sprites, the pick and
   * card indexes, the cards), keeping the global dataset, its per-grid cell
   * cache and the worldwide heatmap. The selection is cleared as a deliberate
   * deselect (no eviction tag: the detection is still in the feed) and BEFORE
   * the context sweep, for the ownership-guard reason documented in
   * loadHeatmap. No cards are republished. The LOD/view memo and the idle
   * camera snapshot are reset so the next render always rebuilds.
   */
  function releaseRenderedView() {
    components.selection.clearFireSelection({ republish: false });
    components.selection.clearContextRegistrations();
    components.rendering.clearIcons();
    layerState._pickIndexById.clear();
    layerState._fireByCardId.clear();
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
