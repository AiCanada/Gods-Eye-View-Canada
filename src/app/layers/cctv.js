import { createCctvLayer } from '../../layers/cctv/index.js';
import * as credits from '../../data/dataCredits.js';
import * as sprites from '../../data/spriteOrder.js';
import * as activation from '../../cctvFocusRequest.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as locations from '../../locations.js';
import * as picking from '../../data/pickRegistry.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as render from '../../renderGovernor.js';
import { cityIdByName } from '../../data/cctvCityMatch.js';
import { keySetupRequirement } from '../../keySetupCore.mjs';
import {
  clearCctvTrafficPlanes,
  monitorPlaneFrame,
  setCctvTrafficPlane,
} from '../../data/cctvTrafficProjection.js';
import { setCctvThumbnailTrafficActive } from '../../data/cctvThumbnailTraffic.js';
import { getRoadsRevision, roadBearingNear } from '../../data/traffic.js';

/** Street traffic drawn onto camera pictures, and the road lines thumbnails follow. */
const pictureTraffic = {
  setCctvTrafficPlane,
  clearCctvTrafficPlanes,
  monitorPlaneFrame,
  setCctvThumbnailTrafficActive,
  getRoadsRevision,
  roadBearingNear,
};

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationCctv({ surface, source }) {
  const { terrain, groundFloor: ground, meshFloor: mesh } = surface;
  return createCctvLayer({
    source,
    services: {
      credits,
      sprites,
      activation,
      overlays,
      locations,
      picking,
      terrain,
      ground,
      mesh,
      focus,
      render,
      pictureTraffic,
      keySetup: { keySetupRequirement },
      cityMatch: { cityIdByName },
    },
  });
}
