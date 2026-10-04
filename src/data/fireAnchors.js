import { createFireAnchors } from '../layers/firms/anchors.js';
import * as groundFloor from './groundFloor.js';
import {
  terrainHeightsSwitchGeneration,
  terrainPointSurvivesSwitch,
} from './terrainHeights.js';
export { FIRE_ANCHOR_LIFT_M } from '../layers/firms/anchors.js';
const anchors = createFireAnchors({
  ...groundFloor,
  terrainHeightsSwitchGeneration,
  terrainPointSurvivesSwitch,
});
export const {
  fireAnchorHeight,
  warmFireAnchorFloors,
  _resetFireAnchorsForTest,
} = anchors;
