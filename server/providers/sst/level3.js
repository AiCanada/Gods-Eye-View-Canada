import { readResponseTextCapped } from '../common/http.js';
import {
  L3_CELLS_PER_DEGREE,
  L3_CELL_KM,
  gridIndexRange,
  normalizeBbox,
  opendapSubsetUrl,
  parseDap2SstQuality,
} from './opendap.js';
import {
  DEFAULT_FRONT_SENSITIVITY,
  FRONT_SENSITIVITY,
  detectThermalFronts,
} from './fronts.js';
import { createLandMaskSource } from './landmask.js';
import { encodeRgbaPng } from './png.js';
import { renderFrontsRgba, renderSstRgba, sstDisplayRange } from './render.js';

/** Newest OceanColor MODIS Aqua Level-3 SST granules, daily and 8-day mixed. */
export const CMR_LEVEL3_LIST_URL =
  'https://cmr.earthdata.nasa.gov/search/granules.json?short_name=MODISA_L3m_SST&sort_key=-start_date&page_size=60';
export const LEVEL3_PERIODS = Object.freeze(['day', '8d']);

const OPENDAP_L3_4KM =
  /^https:\/\/oceandata\.sci\.gsfc\.nasa\.gov\/opendap\/.+\.L3m\.(DAY|8D)\.SST\.sst\.4km\.nc$/;
const OCEANCOLOR_HOST = 'oceandata.sci.gsfc.nasa.gov';
const GRANULE_TTL_MS = 60 * 60 * 1000;
const FAILURE_RETRY_MS = 5 * 60 * 1000;
const CMR_TIMEOUT_MS = 30 * 1000;
const OPENDAP_TIMEOUT_MS = 90 * 1000;
const CMR_MAX_BYTES = 4 * 1024 * 1024;

const httpError = (status, message) =>
  Object.assign(new Error(message), { status });

/**
 * The newest 4 km daily and 8-day OPeNDAP URLs in a CMR granule search.
 *
 * @returns {{day?: {opendapUrl: string, startDate: string, endDate: string}, '8d'?: object}}
 */
export function newestLevel3Granules(cmrJson) {
  const found = {};
  for (const entry of cmrJson?.feed?.entry || []) {
    for (const link of entry?.links || []) {
      const href = String(link?.href || '');
      const match = OPENDAP_L3_4KM.exec(href);
      if (!match) continue;
      const period = match[1] === 'DAY' ? 'day' : '8d';
      if (found[period]) continue;
      found[period] = {
        opendapUrl: href,
        startDate: String(entry.time_start || '').slice(0, 10),
        endDate: String(entry.time_end || entry.time_start || '').slice(0, 10),
      };
    }
  }
  return found;
}

async function readBytesCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      /* already closed */
    }
    throw httpError(502, 'OceanColor response is larger than expected');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes)
      throw httpError(502, 'OceanColor response is larger than expected');
    return bytes;
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw httpError(502, 'OceanColor response is larger than expected');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Level-3 view source behind /api/sst/l3/*. For a period and a view box it
 * downloads just that box from the newest Level-3 file, drops poor-quality and
 * land or lake cells, colours SST, and detects thermal fronts at the requested
 * sensitivity. The masked grid is cached per file and view, so changing the
 * sensitivity never downloads again.
 */
export function createLevel3Source({
  fetchImpl = (...args) => fetch(...args),
  env = process.env,
  now = Date.now,
  landMask = createLandMaskSource({ fetchImpl, now }),
  maxEntries = 8,
} = {}) {
  let granules = null;
  const grids = new Map();
  const views = new Map();

  const recall = (cache, key) => {
    if (!cache.has(key)) return null;
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  };
  const remember = (cache, key, pending, limit) => {
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
    while (cache.size > limit) cache.delete(cache.keys().next().value);
    return pending;
  };

  const newestGranules = async () => {
    if (granules && now() - granules.at <= GRANULE_TTL_MS)
      return granules.value;
    try {
      const signal = AbortSignal.timeout(CMR_TIMEOUT_MS);
      const response = await fetchImpl(CMR_LEVEL3_LIST_URL, {
        headers: { 'User-Agent': 'gods-eye-view-sst/1.0' },
        signal,
      });
      if (!response.ok) throw new Error(`CMR HTTP ${response.status}`);
      const text = await readResponseTextCapped(
        response,
        CMR_MAX_BYTES,
        signal,
      );
      granules = { at: now(), value: newestLevel3Granules(JSON.parse(text)) };
    } catch {
      granules = {
        at: now() - GRANULE_TTL_MS + FAILURE_RETRY_MS,
        value: granules?.value || {},
      };
    }
    return granules.value;
  };

  const downloadGrid = async (granule, range) => {
    const url = opendapSubsetUrl(granule.opendapUrl, range);
    const token = String(env.EARTHDATA_TOKEN || '').trim();
    const headers = { 'User-Agent': 'gods-eye-view-sst/1.0' };
    // The Earthdata login goes to OceanColor's own host and nowhere else.
    if (token && new URL(url).hostname === OCEANCOLOR_HOST) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(OPENDAP_TIMEOUT_MS),
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      throw httpError(502, `OceanColor OPeNDAP returned ${response.status}`);
    }
    const cells = range.rows * range.cols;
    const bytes = await readBytesCapped(response, cells * 6 + 64 * 1024);
    return parseDap2SstQuality(bytes, range);
  };

  const loadGrid = async (granule, range) => {
    const [grid, mask] = await Promise.all([
      downloadGrid(granule, range),
      landMask(range).catch((error) => {
        console.warn('[SST] land mask unavailable:', error?.message || error);
        return null;
      }),
    ]);
    const { sst } = grid;
    let validCells = 0;
    for (let i = 0; i < sst.length; i += 1) {
      if (mask?.land[i]) sst[i] = Number.NaN;
      if (sst[i] === sst[i]) validCells += 1;
    }
    const width = range.cols;
    const height = range.rows;
    const sstRange = sstDisplayRange(sst);
    return {
      sst,
      latitudes: grid.latitudes,
      validCells,
      sstRange,
      landMask: mask ? 'applied' : 'unavailable',
      landCells: mask ? mask.landCells : null,
      sstPng: encodeRgbaPng(
        width,
        height,
        renderSstRgba(sst, width, height, sstRange),
      ),
    };
  };

  const buildView = async (
    period,
    granule,
    range,
    sensitivity,
    gridPromise,
  ) => {
    const grid = await gridPromise;
    const width = range.cols;
    const height = range.rows;
    const { thresholdCPerKm, minCells } = FRONT_SENSITIVITY[sensitivity];
    const fronts = detectThermalFronts({
      sst: grid.sst,
      width,
      height,
      latitudes: grid.latitudes,
      cellDegrees: range.stride / L3_CELLS_PER_DEGREE,
      thresholdCPerKm,
      minCells,
    });
    return {
      meta: {
        source: 'OceanColor MODIS Aqua Level-3 SST (4 km)',
        period,
        startDate: granule.startDate,
        endDate: granule.endDate,
        cellKm: Math.round(L3_CELL_KM * range.stride * 10) / 10,
        stride: range.stride,
        width,
        height,
        rectangle: range.rectangle,
        sstRange: grid.sstRange,
        validCells: grid.validCells,
        landMask: grid.landMask,
        landCells: grid.landCells,
        fronts: {
          sensitivity,
          cells: fronts.cells,
          maxGradientCPerKm: fronts.maxGradientCPerKm,
          thresholdCPerKm,
          minCells,
        },
      },
      sstPng: grid.sstPng,
      frontsPng: encodeRgbaPng(
        width,
        height,
        renderFrontsRgba(fronts.strength, width, height, thresholdCPerKm),
      ),
    };
  };

  return async function level3View({
    period,
    bbox,
    fronts = DEFAULT_FRONT_SENSITIVITY,
  }) {
    if (!LEVEL3_PERIODS.includes(period))
      throw httpError(400, 'period must be day or 8d');
    if (!Object.hasOwn(FRONT_SENSITIVITY, fronts))
      throw httpError(400, 'fronts must be strong, moderate or all');
    const box = normalizeBbox(bbox);
    if (!box) throw httpError(400, 'bbox must be west,south,east,north');
    const granule = (await newestGranules())[period];
    if (!granule)
      throw httpError(503, 'No OceanColor Level-3 file is available right now');
    const range = gridIndexRange(box);
    const gridKey = `${granule.opendapUrl}|${range.row0}|${range.col0}|${range.stride}|${range.rows}|${range.cols}`;
    const viewKey = `${gridKey}|${fronts}`;
    const cachedView = recall(views, viewKey);
    if (cachedView) return cachedView;
    const gridPromise =
      recall(grids, gridKey) ||
      remember(grids, gridKey, loadGrid(granule, range), maxEntries);
    return remember(
      views,
      viewKey,
      buildView(period, granule, range, fronts, gridPromise),
      maxEntries * Object.keys(FRONT_SENSITIVITY).length,
    );
  };
}
