import { openSkyProxy } from './aircraft/opensky.js';
import { celestrakProxy, rocketLaunchesProxy } from './space.js';
import { tomtomProxy } from './traffic.js';
import { firmsProxy } from './firms.js';
import { terrainHeightsProxy } from './terrain.js';
import { adsbdbProxy } from './aircraft/enrichment.js';
import { overpassProxy } from './overpass.js';
import { roadsTilesProxy } from './roads-tiles.js';
import { militaryInstallationsProxy } from './military-installations.js';
import { regionalBriefProxy } from './regional/briefing.js';
import { geocodeProxy } from './regional/place.js';
import { weatherEffectsProxy } from './regional/weather-effects.js';
import { cctvProxy } from './cctv.js';
import { defaultSourceRoot } from './common/source-root.js';
import { radioBrowserProxy } from './radio.js';
import { gbfsProxy } from './gbfs.js';
import { adsbLolProxy } from './aircraft/adsb-lol.js';
import { aisLiveProxy } from './vessels/ais-live.js';
import { trackBackfillProxies } from './aircraft/tracks.js';
import { openAiRealtimeProxy } from './openai.js';
import { llmAskProxy } from './llm.js';
import { seaSurfaceTemperatureProxy } from './sst.js';
import { googlePlacesContextProxy } from './places.js';
import { keySetupEndpoint } from '../standalone/key-setup.js';
import { privateCamerasProxy } from './private-cameras.js';
import { locationSwitchReleaseEndpoint } from './location-switch.js';

/** Construct the local provider plugins in their established order. */
function localProviderPlugins() {
  return [
    openSkyProxy(),
    celestrakProxy(),
    tomtomProxy(),
    firmsProxy(),
    rocketLaunchesProxy(),
    terrainHeightsProxy(),
    adsbdbProxy(),
    overpassProxy(),
    // Street traffic road geometry (OpenFreeMap vector tiles, disk-cached).
    roadsTilesProxy(),
    militaryInstallationsProxy(),
    regionalBriefProxy(),
    geocodeProxy(),
    weatherEffectsProxy(),
    cctvProxy({ sourceRoot: defaultSourceRoot }),
    // Home and business security cameras: separate from the public CCTV proxy.
    privateCamerasProxy({ sourceRoot: defaultSourceRoot }),
    radioBrowserProxy(),
    gbfsProxy(),
    adsbLolProxy(),
    aisLiveProxy(),
    trackBackfillProxies(),
    openAiRealtimeProxy(),
    llmAskProxy(),
    seaSurfaceTemperatureProxy(),
    googlePlacesContextProxy(),
    // Releases the area-keyed memory caches above when the user changes place.
    locationSwitchReleaseEndpoint(),
    keySetupEndpoint(),
  ];
}

export { localProviderPlugins };

export {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  fetchCctvImageFromUpstream,
} from './cctv.js';
export { CCTV_LOAD_CAP_HARD_LIMIT } from './cctv/constants.js';
export { enabledCctvCountries } from './cctv/catalog.js';
export { normalizeSourceItem } from './cctv/normalize.js';
export {
  frameFailureBackoffMs,
  frameHostAllowed,
  resolveFrameUrl,
} from './cctv/frame-resolver.js';
export {
  LLM_QUESTION_MAX_CHARS,
  admitLlmAskRequest,
  buildLlmAskCall,
  llmAnswerFromUpstream,
  llmAskTimeoutMs,
  llmMaxTokens,
  llmProviderRoster,
  llmProviderSettings,
  parseLlmAskRequest,
  resolveLlmProvider,
} from './llm/ask.js';
export {
  createRadioProxyMiddleware,
  isPublicRadioAddress,
  normalizeRadioBrowserStation,
  publicRadioStation,
  publicRadioHttpsUrl,
} from './radio.js';
export { LL2_CACHE_TTL_MS, launchLibraryRequestHeaders } from './space.js';
export { googlePlacesContextProxy } from './places.js';
export { googleServerApiKey } from './places.js';
export { keylessGooglePlacesResponse } from './places.js';
export { adsbLolFallbackAnchor } from './aircraft/opensky.js';
export { readResponseTextCapped } from './common/http.js';
export { readResponseJsonCapped } from './common/http.js';
export { coalesceProxyRequest } from './common/http.js';
export { requiredFiniteQueryNumber } from './common/query.js';
export { isOverpassBoundaryQuery } from './overpass/query.js';
export { simplifyOverpassPayloadBody } from './overpass/geometry.js';
export { readOverpassDisk } from './overpass/cache.js';
export { resolveOverpassPreflight } from './overpass/cache.js';
export { overpassPayloadIsData } from './overpass/transport.js';
export { fetchOverpassPayload } from './overpass/transport.js';
export { openAiRealtimeProxy } from './openai.js';
export { MILITARY_INSTALLATION_ELEMENT_CAP } from './military-installations/constants.js';
export { quantizeMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationCacheKey } from './military-installations/query.js';
export { resolveMilitaryInstallationTier } from './military-installations/cache.js';
export { migrateMilitaryInstallationEntry } from './military-installations/cache.js';
export { militaryInstallationDiskFresh } from './military-installations/cache.js';
export { militaryInstallationDiskPath } from './military-installations/cache.js';
export { readMilitaryInstallationDisk } from './military-installations/cache.js';
export { writeMilitaryInstallationDisk } from './military-installations/cache.js';
export { validMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationFailureReason } from './military-installations/query.js';
export { validRegionalPoint } from './regional/query.js';
export { regionalBriefHasAnySource } from './regional/briefing.js';
