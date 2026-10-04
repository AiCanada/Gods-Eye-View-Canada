import { createApplicationTraffic } from '../app/layers/traffic.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import * as liveTraffic from '../layers/traffic/instances.js';

const sourceSlot = createSourceSlot(
  createTrafficSource(),
  ['requestRoads', 'getStatus', 'fetchFlowForBounds'],
  'Traffic source',
  {
    getFlowSessionStats: () => ({ tilesFetched: 0 }),
    resetFlowTileCache: () => {},
  },
);
export const configureTrafficSource = sourceSlot.configure;
const layer = createApplicationTraffic({
  source: sourceSlot.source,
});
export const getTrafficTimingDiagnostics = layer.getTrafficTimingDiagnostics;
export const deriveTrafficFlowError = layer.deriveTrafficFlowError;
export const trafficFeedPresentation = layer.trafficFeedPresentation;
export {
  nearestRoadBearing,
  tileCacheKeysAwayFrom,
} from '../layers/traffic/index.js';

// Scene owners outside the layer catalog (CCTV pictures and road bearings,
// detection's vehicle tags) read whichever traffic instance is live: the
// catalog builds its own instance, so these never read only this wrapper's.
export const forEachTrafficDot = liveTraffic.forEachTrafficDot;
export const roadBearingNear = liveTraffic.roadBearingNear;
export const getRoadsRevision = liveTraffic.getRoadsRevision;
export const setTrafficTagFilter = liveTraffic.setTrafficTagFilter;

// The application shell pauses traffic for an inter-city world jump through
// this module's default export; reach the live catalog instance as well.
layer.beginWorldJump = liveTraffic.beginWorldJump;
layer.endWorldJump = liveTraffic.endWorldJump;

export default layer;
