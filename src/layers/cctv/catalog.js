import {
  CCTV_AREA_RADIUS_KM,
  PRIVATE_FRAME_PATH,
  PRIVATE_SOURCE_ENDPOINT,
} from './policy.js';
import { privateCamerasShown } from '../../data/privateCctv.js';

export function createCatalog({ state: layerState, services, parts, source }) {
  const { CITY_POIS } = services.locations;
  const matchCityId = services.cityMatch?.cityIdByName;

  /**
   * The preset city a camera belongs to: its `city` text names the preset (or
   * an alias) AND the camera sits near that city (cctvCityMatch.js).
   * @param {string} cityName
   * @param {number} [lat]
   * @param {number} [lon]
   * @returns {string|null} Matching city ID or null.
   */

  function cityIdByName(cityName, lat = Number.NaN, lon = Number.NaN) {
    if (typeof matchCityId === 'function')
      return matchCityId(cityName, lat, lon, CITY_POIS || {});
    // Without the application's matcher: exact preset names only.
    const probe = String(cityName || '')
      .trim()
      .toLowerCase();
    if (!probe) return null;
    for (const [cityId, city] of Object.entries(CITY_POIS || {})) {
      if (String(city?.name || '').toLowerCase() === probe) return cityId;
    }
    return null;
  }

  /**
   * Fetches the public cameras nearest a point (contract 2): at most 1,000
   * within 50 km, nearest first, plus the server's area report. Never asks for
   * the whole catalogue. Private cameras are not part of it.
   * @param {{lat:number, lon:number}} point
   * @param {AbortSignal} [signal]
   * @returns {Promise<{sources: Object[], area: Object}>} Rejects on HTTP/network failure or abort.
   */

  async function loadAreaSources(point, signal) {
    const data = await source.getCatalog({
      signal,
      lat: point.lat,
      lon: point.lon,
      radiusKm: CCTV_AREA_RADIUS_KM,
    });
    signal?.throwIfAborted?.();
    return {
      sources: Array.isArray(data?.sources)
        ? data.sources.filter(
            (entry) =>
              String(entry?.sourceKind || '').toLowerCase() !== 'private',
          )
        : [],
      area: data?.area && typeof data.area === 'object' ? data.area : {},
    };
  }

  /**
   * Fetches this machine's home and business security cameras. The route
   * answers only the machine running the server, so a LAN or shared viewer
   * simply gets none. Records carry a position and a private frame route,
   * never a login.
   * @returns {Promise<Object[]>}
   */

  async function loadPrivateCameraSources() {
    // Private CCTV Cams (Other layers, or the Ultra box) switched off.
    if (!privateCamerasShown()) return [];
    try {
      const signal = layerState._sourceAbort?.signal;
      const resp = await fetch(PRIVATE_SOURCE_ENDPOINT, {
        cache: 'no-store',
        signal,
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return Array.isArray(data?.sources)
        ? data.sources.filter(
            (entry) =>
              entry?.sourceKind === 'private' &&
              PRIVATE_FRAME_PATH.test(String(entry.frameUrl || '')),
          )
        : [];
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return [];
    }
  }

  /**
   * Normalizes a server lookup state for a Road511 lookup camera.
   * @param {*} value
   * @returns {'resolved'|'no-image'|'unresolved'}
   */

  function normalizeLookupState(value) {
    const state = String(value || '')
      .trim()
      .toLowerCase();
    return state === 'resolved' || state === 'no-image' ? state : 'unresolved';
  }

  /**
   * Turns raw backend sources into camera objects. Missing heading, FOV, range
   * and mount values get conservative defaults; nothing is invented for a
   * source without coordinates. Each camera is passed through ensureCameraPose.
   * @param {Object[]} rawSources - Raw source objects from the backend.
   * @returns {Object[]} Array of fully-initialized camera objects.
   */

  function buildCatalogFromSources(rawSources) {
    const sources = Array.isArray(rawSources) ? rawSources : [];
    if (!sources.length) return [];

    const catalog = [];
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const id = String(source.id || '').trim();
      if (!id) continue;
      const lat = parts.model.safeNumber(source.lat, NaN);
      const lon = parts.model.safeNumber(source.lon, NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // A named city only counts when the camera actually sits near it.
      const cityId =
        String(source.cityId || '').trim() ||
        cityIdByName(source.city, lat, lon) ||
        '';
      const city = cityId && CITY_POIS?.[cityId] ? CITY_POIS[cityId] : null;

      const sourceHeading = parts.model.safeNumber(source.headingDeg, NaN);
      const headingDeg = parts.model.normalizeHeading(
        Number.isFinite(sourceHeading)
          ? sourceHeading
          : parts.model.headingFromId(id),
      );
      // Home and business cameras watch a yard or a doorway, not a highway:
      // they keep the short reach and low mount a real security camera has.
      const privateCamera =
        String(source.sourceKind || '').toLowerCase() === 'private';
      const fovDeg = parts.model.clamp(
        parts.model.safeNumber(source.fovDeg, 74),
        20,
        privateCamera ? 150 : 125,
      );
      // Same floor as the pose model (model.js): the packs' 145/210 m ranges
      // are intentional, and inflating them to 220 m pushed the monitor
      // plane's far edge into higher ground (owner field test 2026-09-13).
      const rangeM = parts.model.clamp(
        parts.model.safeNumber(source.rangeM, 700),
        privateCamera ? 5 : 120,
        privateCamera ? 400 : 2200,
      );
      const mountHeightM = parts.model.clamp(
        parts.model.safeNumber(source.mountHeightM, 24),
        privateCamera ? 1 : 6,
        privateCamera ? 60 : 120,
      );
      const pitchDeg = parts.model.clamp(
        parts.model.safeNumber(source.pitchDeg, -17),
        -55,
        -2,
      );
      const groundElevationM = parts.model.safeNumber(
        source.groundElevationM,
        city?.groundElevation ?? 0,
      );
      const lookup =
        !privateCamera && source.lookup === 'road511' ? 'road511' : '';
      const lookupState = lookup
        ? normalizeLookupState(source.lookupState)
        : '';
      const feedType = parts.model.normalizeFeedType(
        source.feedType || source.type || 'image',
      );
      const headingConfidence = String(
        source.headingConfidence || 'low',
      ).toLowerCase();
      // CAL badge input (design §3b passthrough): hand-authored file/env source
      // entries may carry poseSource:'curated'. Live and generated pack rows
      // never set this — they stay RAW PRIOR until a human calibrates them.
      const poseSource = source.poseSource === 'curated' ? 'curated' : null;
      // Budgeted hosts (IBI 511) publish their cadences (contract 5): cards use
      // frameRefreshMs, the active plane and panel use activeFrameRefreshMs.
      const frameRefreshMs = parts.model.safeNumber(source.frameRefreshMs, NaN);
      const activeFrameRefreshMs = parts.model.safeNumber(
        source.activeFrameRefreshMs,
        NaN,
      );

      const camera = {
        id,
        name: String(source.name || id),
        cityId,
        city: String(source.city || city?.name || 'Global'),
        provider: String(source.provider || 'Configured CCTV Source'),
        sourceKind: String(
          source.sourceKind || source.kind || 'configured',
        ).toLowerCase(),
        feedType,
        lookup,
        lookupState,
        // How the server relays a stream-only camera's HLS: `proxy` for a
        // `none` camera with a stream address or a Road511 stream (its own
        // ?hls=1 playlist / MP4 clips); absent for pack HLS feeds, which use
        // the leased segment puller (videoPlayback.js).
        hlsVia: source.hlsVia === 'proxy' ? 'proxy' : '',
        feedConfigured: typeof source.url === 'string' && !!source.url.trim(),
        ...(frameRefreshMs > 0 ? { frameRefreshMs } : {}),
        ...(activeFrameRefreshMs > 0 ? { activeFrameRefreshMs } : {}),
        lat,
        lon,
        headingDeg,
        headingConfidence,
        fovDeg,
        rangeM,
        mountHeightM,
        groundElevationM,
        absoluteHeightM: groundElevationM + mountHeightM,
        pitchDeg,
        license: String(source.license || source.licenseNote || ''),
        credit: String(source.credit || ''),
        code: String(source.code || ''),
        // Shipped precompute (see server/providers/cctv/groundHeights.js).
        groundHeights:
          source.groundHeights && typeof source.groundHeights === 'object'
            ? source.groundHeights
            : null,
        poseSource,
        // Set by the server (CCTV_ROAD_MATCH_HOSTS): this camera's map
        // thumbnail is matched to the road nearest the camera.
        roadMatch: source.roadMatch === true,
        // Set by the server for operators that refuse server-side clients: the
        // viewer's browser loads this still itself (panel and map thumbnail,
        // see cctvBrowserDirect.js).
        browserImageUrl:
          typeof source.browserImageUrl === 'string' &&
          /^https:\/\//i.test(source.browserImageUrl)
            ? source.browserImageUrl
            : '',
        // Home and business cameras load stills from their own loopback-only route.
        privateFrameUrl:
          source.sourceKind === 'private' &&
          PRIVATE_FRAME_PATH.test(String(source.frameUrl || ''))
            ? source.frameUrl
            : '',
      };
      parts.model.ensureCameraPose(camera);
      catalog.push(camera);
    }

    return catalog;
  }
  return {
    cityIdByName,
    loadAreaSources,
    loadPrivateCameraSources,
    normalizeLookupState,
    buildCatalogFromSources,
  };
}
