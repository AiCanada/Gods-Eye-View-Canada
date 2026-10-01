import * as Cesium from 'cesium';
import {
  createFirePerimetersLayer,
  createInciwebIndexSource,
  createInciwebPublicationSource,
  createWfigsPerimeterSource,
} from './index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire WFIGS fire perimeters into this fork's data-layer list. */
export function createApplicationFirePerimeters() {
  return createFirePerimetersLayer({
    source: createWfigsPerimeterSource(),
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    inciwebSource: createInciwebIndexSource(),
    inciwebPublications: createInciwebPublicationSource(),
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
  });
}
