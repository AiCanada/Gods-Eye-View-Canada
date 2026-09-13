import { readResponseTextCapped } from '../common/http.js';

/** Layer list and date extents for every GIBS product. */
export const GIBS_CAPABILITIES_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=GetCapabilities';
/** Newest OceanColor MODIS Aqua Level-3 mapped SST files (public CMR search). */
export const CMR_MODIS_AQUA_L3_SST_URL =
  'https://cmr.earthdata.nasa.gov/search/granules.json?short_name=MODISA_L3m_SST&sort_key=-start_date&page_size=10';

/** GIBS publishes new dates a few times a day at most. */
const CAPABILITIES_TTL_MS = 6 * 60 * 60 * 1000;
const GRANULE_TTL_MS = 60 * 60 * 1000;
const ACCESS_TTL_MS = 30 * 60 * 1000;
/** A failed upstream is retried after this, not on every panel open. */
const FAILURE_RETRY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const CAPABILITIES_MAX_BYTES = 16 * 1024 * 1024;
const CMR_MAX_BYTES = 2 * 1024 * 1024;
const OCEANCOLOR_L3_SST_FILE =
  /^https:\/\/oceandata\.sci\.gsfc\.nasa\.gov\/.+\.L3m\.DAY\.SST\.sst\.(?:4|9)km\.nc$/;

/**
 * What the server can say about an Earthdata Login token without calling
 * anyone: whether one is set and when it expires. The token is a JWT whose
 * payload carries `exp`; the signature is not verified here, only NASA can.
 *
 * @param {string} token
 * @param {number} [nowMs]
 * @returns {{configured: boolean, expiresAt: string|null, expired: boolean}}
 */
export function earthdataTokenInfo(token, nowMs = Date.now()) {
  const value = String(token || '').trim();
  if (!value) return { configured: false, expiresAt: null, expired: false };
  let expiresAt = null;
  try {
    const payload = JSON.parse(
      Buffer.from(value.split('.')[1] || '', 'base64url').toString('utf8'),
    );
    if (Number.isFinite(payload?.exp))
      expiresAt = new Date(payload.exp * 1000).toISOString();
  } catch {
    // Not a JWT: still configured, expiry unknown.
  }
  return {
    configured: true,
    expiresAt,
    expired: expiresAt !== null && Date.parse(expiresAt) <= nowMs,
  };
}

/**
 * Newest date GIBS serves for each named layer, from its WMTS capabilities.
 * Each layer's time dimension lists extents such as "2024-08-31/2026-05-01/P1D";
 * the end of the last extent is the newest renderable date.
 *
 * @param {string} capabilitiesXml
 * @param {string[]} layerIds
 * @returns {Record<string, string>} layer id -> YYYY-MM-DD
 */
export function latestGibsDates(capabilitiesXml, layerIds) {
  const xml = String(capabilitiesXml || '');
  const dates = {};
  for (const layerId of layerIds) {
    const at = xml.indexOf(`<ows:Identifier>${layerId}</ows:Identifier>`);
    if (at < 0) continue;
    const start = xml.lastIndexOf('<Layer>', at);
    const end = xml.indexOf('</Layer>', at);
    if (start < 0 || end < 0) continue;
    const extents = [
      ...xml.slice(start, end).matchAll(/<Value>([^<]+)<\/Value>/g),
    ];
    const last = extents.at(-1)?.[1] || '';
    const newest = (last.split('/')[1] || last).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(newest)) dates[layerId] = newest;
  }
  return dates;
}

/**
 * The newest OceanColor MODIS Aqua Level-3 daily SST file in a CMR response.
 *
 * @param {object} cmrJson
 * @returns {{date: string, url: string}|null}
 */
export function latestModisAquaL3Granule(cmrJson) {
  for (const entry of cmrJson?.feed?.entry || []) {
    const url = (entry?.links || [])
      .map((link) => String(link?.href || ''))
      .find((href) => OCEANCOLOR_L3_SST_FILE.test(href));
    if (url) return { date: String(entry.time_start || '').slice(0, 10), url };
  }
  return null;
}

/**
 * Ask OceanColor whether this token may download a Level-3 file. HEAD only:
 * nothing is downloaded. fetch drops the Authorization header if a redirect
 * leaves the origin, so the token only ever reaches NASA's file host.
 *
 * @returns {Promise<{authenticated: boolean, httpStatus: number|null}>}
 */
export async function checkEarthdataAccess(
  fileUrl,
  token,
  { fetchImpl = (...args) => fetch(...args) } = {},
) {
  if (!token || !fileUrl) return { authenticated: false, httpStatus: null };
  try {
    const response = await fetchImpl(fileUrl, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return { authenticated: response.ok, httpStatus: response.status };
  } catch {
    return { authenticated: false, httpStatus: null };
  }
}

/**
 * Build the cached status source behind GET /api/sst/status. Every upstream
 * is cached and a failure serves the last good value. The token is read from
 * the live environment per call and never appears in the payload.
 */
export function createSstStatusSource({
  products,
  fetchImpl = (...args) => fetch(...args),
  env = process.env,
  now = Date.now,
} = {}) {
  let capabilities = null;
  let granule = null;
  let access = null;

  const fresh = (entry, ttlMs) => entry && now() - entry.at <= ttlMs;
  const failed = (entry, ttlMs) => ({
    at: now() - ttlMs + FAILURE_RETRY_MS,
    value: entry?.value ?? null,
  });

  const readText = async (url, maxBytes) => {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'gods-eye-view-sst/1.0' },
      signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      throw new Error(`HTTP ${response.status}`);
    }
    return readResponseTextCapped(response, maxBytes, signal);
  };

  const gibsDates = async () => {
    if (fresh(capabilities, CAPABILITIES_TTL_MS)) return capabilities.value;
    try {
      const xml = await readText(GIBS_CAPABILITIES_URL, CAPABILITIES_MAX_BYTES);
      capabilities = {
        at: now(),
        value: latestGibsDates(
          xml,
          products.map((product) => product.gibsLayer),
        ),
      };
    } catch {
      capabilities = failed(capabilities, CAPABILITIES_TTL_MS);
    }
    return capabilities.value || {};
  };

  const latestGranule = async () => {
    if (fresh(granule, GRANULE_TTL_MS)) return granule.value;
    try {
      const text = await readText(CMR_MODIS_AQUA_L3_SST_URL, CMR_MAX_BYTES);
      granule = {
        at: now(),
        value: latestModisAquaL3Granule(JSON.parse(text)),
      };
    } catch {
      granule = failed(granule, GRANULE_TTL_MS);
    }
    return granule.value;
  };

  const accessFor = async (file, token) => {
    if (
      fresh(access, ACCESS_TTL_MS) &&
      access.token === token &&
      access.url === file.url
    ) {
      return access.value;
    }
    const value = await checkEarthdataAccess(file.url, token, { fetchImpl });
    access = { at: now(), token, url: file.url, value };
    return value;
  };

  return async function sstStatus() {
    const token = String(env.EARTHDATA_TOKEN || '').trim();
    const [dates, file] = await Promise.all([gibsDates(), latestGranule()]);
    const tokenInfo = earthdataTokenInfo(token, now());
    const result =
      tokenInfo.configured && !tokenInfo.expired && file
        ? await accessFor(file, token)
        : { authenticated: false, httpStatus: null };
    return {
      products: products.map((product) => ({
        id: product.id,
        latestDate: dates[product.gibsLayer] || null,
      })),
      oceanColor: { latestModisAquaL3Date: file?.date || null },
      earthdata: {
        configured: tokenInfo.configured,
        expired: tokenInfo.expired,
        expiresAt: tokenInfo.expiresAt,
        authenticated: result.authenticated,
        httpStatus: result.httpStatus,
      },
      checkedAt: new Date(now()).toISOString(),
    };
  };
}
