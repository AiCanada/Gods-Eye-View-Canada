import { createFlightSnapshotRenderer } from './snapshotRenderer.js';
import { createFlightState } from './state.js';
import { createRendering } from './rendering.js';
import { createMotion } from './motion.js';
import { createTracking } from './tracking.js';
import { createController } from './controller.js';
import { createEnrichment } from './enrichment.js';
import { createIngestion } from './ingestion.js';
import { createLifecycle } from './lifecycle.js';
import { createEvidence } from './evidence.js';
import { createTesting } from './testing.js';
import { createQueries } from './queries.js';
import { createLocationSwitch } from './locationSwitch.js';
/** Compose one civil-flight layer with application-owned scene services. */
export function createCivilFlightLayer({
  source,
  services,
  resolveAsset = (url) => url,
} = {}) {
  const flightState = createFlightState({ source, services });
  const parts = {};
  const layer = {};
  const context = { flightState, services, parts, layer, resolveAsset };
  parts.rendering = createRendering(context);
  parts.motion = createMotion(context);
  parts.tracking = createTracking(context);
  parts.controller = createController(context);
  parts.enrichment = createEnrichment(context);
  parts.lifecycle = createLifecycle(context);
  parts.evidence = createEvidence(context);
  parts.testing = createTesting(context);
  parts.queries = createQueries(context);
  parts.locationSwitch = createLocationSwitch(context);
  const applySnapshot = createFlightSnapshotRenderer({
    flightState,
    records: flightState.records,
    militaryRegistry: services.militaryRegistry,
    groundFloor: services.groundFloor,
    meshFloor: services.meshFloor,
    rendering: parts.rendering,
    tracking: parts.tracking,
    motion: parts.motion,
    enrichment: parts.enrichment,
    queries: parts.queries,
    locationSwitch: parts.locationSwitch,
  });
  parts.ingestion = createIngestion({
    feed: flightState.feed,
    getQuery: (viewer) =>
      parts.controller._flightQuery(viewer || flightState._viewer),
    applySnapshot,
    setSourceLabel: (source) => {
      layer.source = source;
    },
    applyPendingTrackingRestore: () =>
      parts.tracking._applyPendingTrackingRestore(),
    holdPoll: () =>
      parts.locationSwitch._locationSwitchActive() &&
      parts.locationSwitch._onRegionalFallback(),
  });

  Object.assign(
    layer,
    parts.queries.methods,
    parts.lifecycle.methods,
    parts.ingestion.methods,
    parts.locationSwitch.methods,
  );
  // Copy the accessor itself (Object.assign would freeze the getter's value).
  Object.defineProperties(
    layer,
    Object.getOwnPropertyDescriptors(parts.locationSwitch.accessors),
  );
  Object.defineProperty(layer, 'testing', { value: parts.testing });
  return layer;
}
export { TRACKED_MODEL_MAX_PX } from './policy.js';
