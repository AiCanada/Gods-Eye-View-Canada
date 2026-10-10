import { createStreetLevelLayer } from '../../layers/streetLevel/index.js';
import { createMapillaryProvider } from '../../layers/streetLevel/providers/mapillary/index.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as render from '../../renderGovernor.js';

/** Inject providers, or use Mapillary only when its source is supplied. */
export function createApplicationStreetLevel({
  surface,
  sources = {},
  providers = sources.mapillary == null
    ? []
    : [createMapillaryProvider({ source: sources.mapillary })],
}) {
  return createStreetLevelLayer({
    providers,
    services: {
      sprites,
      picking,
      input,
      render,
      ground: surface?.groundFloor ?? null,
      meshFloor: surface?.meshFloor ?? null,
      terrain: surface?.terrain ?? null,
    },
  });
}
