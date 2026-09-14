import {
  DEFAULT_AUSTIN_ROWS_URL,
  CALTRANS_CCTV_URL,
  TFL_JAMCAM_URL,
  TFL_IMAGE_ORIGIN,
  CCTV_SOURCE_FETCH_TIMEOUT_MS,
} from './constants.js';
import {
  toFiniteNumber,
  extractAustinCoords,
  extractAustinCameraId,
  extractAustinName,
  extractAustinHeading,
  isPlausibleUsCoordinate,
  fallbackHeadingFromId,
  rowArrayToObject,
} from './normalize.js';
import { directionToHeading } from '../../../src/data/directionText.js';

/** Austin rows that were never built or are gone for good. A switched-off
 * camera (TURNED_OFF) is still a real camera and stays in the pack. */
const AUSTIN_DROPPED_STATUSES = new Set(['DESIRED', 'REMOVED', 'VOID']);

/**
 * Caltrans districts named by CCTV_CALTRANS_DISTRICTS (comma-separated 1..12).
 * There is no default: unset or empty means the Caltrans pack is off.
 *
 * @returns {number[]}
 */
export function caltransDistricts(env = process.env) {
  return String(env.CCTV_CALTRANS_DISTRICTS ?? '')
    .split(',')
    .map((token) => Number(token.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
}

/**
 * Fetch and parse Austin traffic camera records from the city Open Data portal.
 *
 * Downloads the Socrata rows.json payload, converts each row to a keyed
 * record, extracts camera ID / coords / heading / name, and returns every
 * camera: suburban ones and switched-off ones included. Only rows that were
 * never built or were removed are dropped, and only coordinates that cannot
 * be a US camera are refused.
 *
 * @param {{fetchImpl?: typeof fetch, env?: object}} [options]
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadAustinSourcesFromOpenData({
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const endpoint = env.CCTV_AUSTIN_ROWS_URL || DEFAULT_AUSTIN_ROWS_URL;
  try {
    const resp = await fetchImpl(endpoint, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] Austin source download failed:', resp.status);
      return [];
    }
    const payload = await resp.json();
    const columns = Array.isArray(payload?.meta?.view?.columns)
      ? payload.meta.view.columns
      : [];
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (!columns.length || !rows.length) return [];

    const cameras = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const record = rowArrayToObject(row, columns);
      const cameraId = extractAustinCameraId(record);
      if (!cameraId) continue;

      // DESIRED (planned, not built), REMOVED and VOID rows are not cameras.
      // Tolerate a missing column (keep the row) so a schema change fails open.
      const status = String(record.camera_status || '')
        .trim()
        .toUpperCase();
      if (AUSTIN_DROPPED_STATUSES.has(status)) continue;

      const { lat, lon } = extractAustinCoords(record);
      if (!isPlausibleUsCoordinate(lat, lon)) continue;

      const extractedHeading = extractAustinHeading(record);
      const hasHeading = Number.isFinite(extractedHeading);
      const headingDeg = hasHeading
        ? extractedHeading
        : fallbackHeadingFromId(cameraId);
      cameras.push({
        id: cameraId,
        name: extractAustinName(record, cameraId),
        city: 'Austin',
        cityId: 'austin',
        provider: 'Austin Transportation & Public Works',
        lat,
        lon,
        headingDeg,
        headingConfidence: hasHeading ? 'high' : 'low',
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        groundElevationM: 150,
        feedType: 'image',
        url: `https://cctv.austinmobility.io/image/${encodeURIComponent(cameraId)}.jpg`,
        snapshotUrl: `https://cctv.austinmobility.io/image/${encodeURIComponent(cameraId)}.jpg`,
        country: 'US',
        sourceKind: 'austin-open-data',
        license: 'Public city traffic camera frame',
      });
    }

    const unique = Array.from(
      new Map(cameras.map((camera) => [camera.id, camera])).values(),
    );
    console.log('[CCTV] Loaded Austin camera sources:', unique.length);
    return unique;
  } catch (error) {
    console.warn(
      '[CCTV] Austin source download error:',
      error?.message || error,
    );
    return [];
  }
}

/**
 * Fetch Caltrans CCTV cameras for the configured districts (CCTV_CALTRANS_DISTRICTS,
 * comma-separated 1..12; unset or empty disables the pack). One official JSON feed per
 * district, identical schema statewide; keyless. Only inService cameras with finite
 * coords and a cwwp2.dot.ca.gov https image URL are kept (the image-URL origin check
 * is defense-in-depth: the proxy only ever fetches catalog URLs, and this pins the
 * catalog to the official host). Districts fetch in parallel and fail independently
 * (Promise.allSettled) — one district outage never darkens the others. When any
 * district failed, the returned list carries `partial: true` and
 * `failedDistricts`, so the live pack retries soon instead of keeping an
 * incomplete list for a day.
 *
 * @param {{fetchImpl?: typeof fetch, env?: object}} [options]
 * @returns {Promise<Array<object> & {partial?: true, failedDistricts?: number[]}>}
 *   Normalized camera source objects.
 */
export async function loadCaltransSourcesFromOpenData({
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const districts = caltransDistricts(env);
  if (!districts.length) return [];

  const settled = await Promise.allSettled(
    districts.map(async (district) => {
      const resp = await fetchImpl(CALTRANS_CCTV_URL(district), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`D${district} HTTP ${resp.status}`);
      const payload = await resp.json();
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      return { district, rows };
    }),
  );

  const cameras = [];
  const failedDistricts = [];
  for (const [index, result] of settled.entries()) {
    if (result.status !== 'fulfilled') {
      failedDistricts.push(districts[index]);
      console.warn(
        '[CCTV] Caltrans district fetch failed:',
        result.reason?.message || result.reason,
      );
      continue;
    }
    const { district, rows } = result.value;
    for (const row of rows) {
      const cctv = row?.cctv;
      if (!cctv || String(cctv.inService).toLowerCase() !== 'true') continue;
      const loc = cctv.location || {};
      const lat = toFiniteNumber(loc.latitude);
      const lon = toFiniteNumber(loc.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const imageUrl = String(cctv.imageData?.static?.currentImageURL || '');
      // Official-host pin (see JSDoc). Also drops records with no still image.
      if (!imageUrl.startsWith('https://cwwp2.dot.ca.gov/')) continue;

      const locationName = String(loc.locationName || '').trim();
      // Leading token of locationName is the stable camera code ("TV102 -- I-580 : …").
      const codeMatch = /^([A-Za-z0-9_-]+)\s*--/.exec(locationName);
      const code = (
        codeMatch ? codeMatch[1] : `x${cameras.length}`
      ).toLowerCase();
      const cameraId = `ca-d${district}-${code}`;

      // loc.direction is a dedicated field ("West", "South") → allow bare words.
      const heading = directionToHeading(loc.direction, true);
      const hasHeading = Number.isFinite(heading);
      const label =
        locationName.replace(/^([A-Za-z0-9_-]+)\s*--\s*/, '') ||
        `Caltrans D${district} ${code}`;
      cameras.push({
        country: 'US',
        id: cameraId,
        name: loc.nearbyPlace ? `${label} (${loc.nearbyPlace})` : label,
        city: String(loc.nearbyPlace || `Caltrans D${district}`),
        cityId: `ca-d${district}`,
        provider: 'Caltrans',
        lat,
        lon,
        headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
        headingConfidence: hasHeading ? 'high' : 'low',
        // Same two fabricated pose personalities as Austin (design §1a): these are
        // RAW PRIOR starting points; the client's one-shot ground snap + manual
        // calibration own the truth.
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        // loc.elevation is reported in FEET (verified: D3 maxes at 7427 ft ≈
        // 2264 m for the Sierra passes — as metres that would top Mt Whitney).
        // Convert to metres and clamp to a sane CA-roads range so an occasional
        // garbage upstream value can't fling a camera kilometres up. Prior only:
        // the client one-shot snap corrects it on 3D-tile stacks — but on a
        // no-tileset stack (keyless OSM) the snap misses and this height freezes,
        // so it must be right-ish on its own.
        groundElevationM: (() => {
          const ft = toFiniteNumber(loc.elevation, NaN);
          return Number.isFinite(ft)
            ? Math.max(-100, Math.min(4000, ft * 0.3048))
            : 150;
        })(),
        feedType: 'image',
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'caltrans-open-data',
        license: 'Public Caltrans highway camera frame',
      });
    }
  }

  if (failedDistricts.length) {
    cameras.partial = true;
    cameras.failedDistricts = failedDistricts;
  }
  console.log(
    `[CCTV] Loaded Caltrans camera sources: ${cameras.length} inService`,
  );
  return cameras;
}

/**
 * Fetch TfL JamCams (London). Keyless: the optional TFL_APP_KEY only raises the
 * list-endpoint rate limit (frames come from TfL's public S3 bucket, which is not
 * rate-limited); the day-long live pack cache keeps list hits far below anonymous
 * limits anyway. Only `available === "true"` cameras with finite coords and an
 * image URL on the official bucket are kept. Attribution: "Powered by TfL Open
 * Data" (registered in src/data/dataCredits.js).
 *
 * @param {{fetchImpl?: typeof fetch, env?: object}} [options]
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadTflSourcesFromOpenData({
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  try {
    const appKey = String(env.TFL_APP_KEY || '').trim();
    const url = appKey
      ? `${TFL_JAMCAM_URL}?app_key=${encodeURIComponent(appKey)}`
      : TFL_JAMCAM_URL;
    const resp = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] TfL JamCam download failed:', resp.status);
      return [];
    }
    const places = await resp.json();
    if (!Array.isArray(places)) return [];

    const cameras = [];
    for (const place of places) {
      const props = {};
      for (const p of place?.additionalProperties || []) {
        if (p?.key) props[p.key] = p.value;
      }
      if (String(props.available).toLowerCase() !== 'true') continue;
      const lat = toFiniteNumber(place?.lat);
      const lon = toFiniteNumber(place?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const imageUrl = String(props.imageUrl || '');
      if (!imageUrl.startsWith(TFL_IMAGE_ORIGIN)) continue; // official-bucket pin

      // "JamCams_00002.00865" → "tfl-00002.00865" (provider-stable id).
      const rawId = String(place?.id || '').replace(/^JamCams_/, '');
      if (!rawId) continue;
      const cameraId = `tfl-${rawId}`;

      cameras.push({
        country: 'GB',
        id: cameraId,
        name: String(place?.commonName || `JamCam ${rawId}`),
        city: 'London',
        cityId: 'london',
        provider: 'Transport for London',
        lat,
        lon,
        // No heading signal at all in JamCam data → id-hash fallback, low
        // confidence personality (same as headingless Austin cameras).
        headingDeg: fallbackHeadingFromId(cameraId),
        headingConfidence: 'low',
        pitchDeg: -18,
        fovDeg: 44,
        rangeM: 145,
        mountHeightM: 8,
        groundElevationM: 15, // Thames-basin prior; one-shot snap corrects.
        feedType: 'image', // stills-first (owner decision); props.videoUrl deliberately unused
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'tfl-open-data',
        license: 'Powered by TfL Open Data',
      });
    }

    console.log(
      `[CCTV] Loaded TfL JamCam sources: ${cameras.length} available`,
    );
    return cameras;
  } catch (error) {
    console.warn('[CCTV] TfL JamCam download error:', error?.message || error);
    return [];
  }
}
