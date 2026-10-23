import { openSkyProxy } from './aircraft/opensky.js';
import { celestrakProxy, rocketLaunchesProxy } from './space.js';
import { tomtomProxy } from './traffic.js';
import { firmsProxy } from './firms.js';
import { firePerimetersProxy } from './firePerimeters.js';
import { terrainHeightsProxy } from './terrain.js';
import { adsbdbProxy } from './aircraft/enrichment.js';
import { overpassProxy } from './overpass.js';
import { roadsTilesProxy } from './roads-tiles.js';
import { militaryInstallationsProxy } from './military-installations.js';
import { regionalBriefProxy } from './regional/briefing.js';
import { geocodeProxy } from './regional/place.js';
import { weatherEffectsProxy } from './regional/weather-effects.js';
import { weatherProxy } from './weather.js';
import { windProxy } from './wind.js';
import { cycloneProxy } from './cyclones.js';
import { cctvProxy } from './cctv.js';
import { defaultSourceRoot } from './common/source-root.js';
import { radioBrowserProxy } from './radio.js';
import { gbfsProxy } from './gbfs.js';
import { localReceiversProxy } from './local-receivers.js';
import { transitProxy } from './transit.js';
import { adsbLolProxy } from './aircraft/adsb-lol.js';
import { aisLiveProxy } from './vessels/ais-live.js';
import { trackBackfillProxies } from './aircraft/tracks.js';
import { openAiRealtimeProxy } from './openai.js';
import { llmAskProxy } from './llm.js';
import { seaSurfaceTemperatureProxy } from './sst.js';
import { geminiLiveProxy } from './gemini.js';
import { googlePlacesContextProxy } from './places.js';
import { mapillaryProxy } from './mapillary.js';
import { keySetupEndpoint } from '../standalone/key-setup.js';
import { privateCamerasProxy } from './private-cameras.js';
import { deviceFeedsProxy } from './device-feeds.js';
import { noteOutboundEnvSaved, ultraHelpProxy } from './ultra-help.js';
import { bindLocalIntegrityRoot } from '../shared/localIntegrity.mjs';
import { locationSwitchReleaseEndpoint } from './location-switch.js';
import { socialAccountsProxy } from './socialAccounts.js';
import { roadCctvKeysProxy } from './roadCctvKeys.js';
import { socialSwarmProxy } from './socialSwarm.js';
import { grokBotDesktopProxy } from './grokBotDesktop.js';
import { openaiDotsDesktopProxy } from './openaiDotsDesktop.js';
import { outbreakProxy } from './outbreak.js';
import { aiWorldProvider } from './aiWorld.js';
import { llmTrainingProvider } from './llmTraining.js';
import { tensorflowProvider } from './tensorflow.js';
import { mlflowProvider } from './mlflow.js';
import { distillProvider } from './distill.js';
import { abundanceProvider } from './abundance.js';
import { gnssIntegrityProxy } from './gnssIntegrity.js';

/**
 * Construct the local provider plugins in their established order.
 * `realtime` configures the OpenAI voice session token endpoint; `gemini`
 * explicitly opts into Gemini Live. `sourceRoot` is the
 * checkout whose config and data folders the rooted providers use: this one
 * by default, a temp folder for a test, so no test reads or writes this
 * machine's recordings, caches or private config.
 */
function localProviderPlugins({
  realtime,
  gemini,
  sourceRoot = defaultSourceRoot,
} = {}) {
  // Provider checks apply only after this checkout is bound. A unit test
  // that never binds still uses the keys it set.
  bindLocalIntegrityRoot(sourceRoot);
  const mlflow = mlflowProvider({ root: sourceRoot });
  return [
    openSkyProxy(),
    celestrakProxy(),
    tomtomProxy(),
    firmsProxy(),
    firePerimetersProxy(),
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
    weatherProxy(),
    windProxy(),
    cycloneProxy(),
    cctvProxy({ sourceRoot }),
    // Home and business security cameras: separate from the public CCTV proxy.
    privateCamerasProxy({ sourceRoot }),
    // The owner's own drones, robots, marine drones and GPS trackers.
    deviceFeedsProxy({ sourceRoot }),
    ultraHelpProxy({ sourceRoot }),
    radioBrowserProxy(),
    gbfsProxy(),
    localReceiversProxy(),
    transitProxy(),
    adsbLolProxy(),
    aisLiveProxy(),
    trackBackfillProxies(),
    openAiRealtimeProxy({ realtime }),
    ...(gemini ? [geminiLiveProxy({ realtime: gemini })] : []),
    llmAskProxy(),
    seaSurfaceTemperatureProxy(),
    googlePlacesContextProxy(),
    // Releases the area-keyed memory caches above when the user changes place.
    locationSwitchReleaseEndpoint(),
    // The operator's own social logins. The password stays in the encrypted store.
    socialAccountsProxy({ sourceRoot }),
    // POWER UP → ROAD511: any number of generic road CCTV API keys.
    roadCctvKeysProxy({ sourceRoot }),
    // Social Media Analysis bot swarms: one paid search request per bot, on a press.
    socialSwarmProxy(),
    // Opens the Grok Bot desktop app for OPEN GROK BOT and the no-key swarm.
    grokBotDesktopProxy(),
    // Opens ChatGPT for OPEN CHATGPT and the no-key OPENAI DOT SWARM.
    openaiDotsDesktopProxy(),
    // OUTBREAK LOCATIONS & PREDICTED SPREAD: airports, flight history,
    // rail and water near an outbreak, and the global media search; every
    // rail line on the globe, found once in the background (2026-10-12).
    outbreakProxy({ railWorld: true }),
    // Street Level imagery (upstream): Mapillary tiles, cached.
    mapillaryProxy(),
    // GNSS integrity (upstream #1108): GET /api/gnss-integrity.
    gnssIntegrityProxy(),
    // The AI World tab's MLFLOW sections (owner request 2026-10-17): first,
    // so the jobs of the three providers after it are tracked from the start.
    mlflow,
    // ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM (owner request 2026-10-13):
    // records every ticked feed, generates sim episodes, trains and predicts.
    aiWorldProvider({ root: sourceRoot, tracker: mlflow.tracker }),
    // CUSTOM LLM TRAINING (owner request 2026-10-16): the POWER UP section's
    // dataset build and LoRA training on a base model already on this PC.
    llmTrainingProvider({ root: sourceRoot, tracker: mlflow.tracker }),
    // The AI World tab's TENSORFLOW sections (owner request 2026-10-17):
    // Keras training, TensorBoard, TFRecord/SavedModel/TFLite export and
    // post-training, on the GPU through WSL2 when it is set up.
    tensorflowProvider({ root: sourceRoot, tracker: mlflow.tracker }),
    // AI DISTILLATION (owner request 2026-10-19): teacher LLMs and bots
    // answer, review and correct, one question at a time, for ground truths.
    distillProvider({ root: sourceRoot }),
    // GLOBAL ABUNDANCE MAP (owner request 2026-10-22): the World Bank, Our
    // World in Data and OECD figures behind the abundance score, cached.
    abundanceProvider({ root: sourceRoot }),
    keySetupEndpoint({ sourceRoot, onEnvSaved: noteOutboundEnvSaved }),
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
  admitLlmAskRequest,
  buildLlmAskCall,
  llmAnswerFromUpstream,
  llmAnswerTokens,
  llmAskTimeoutMs,
  llmMaxTokens,
  llmModelSampling,
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
export { keylessGoogleGeocodeResponse } from './places.js';
export { validateGeocodeAddress } from './places.js';
export { geocodeBounds } from './places.js';
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
