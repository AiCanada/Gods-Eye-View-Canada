import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { createCctvCatalog } from './cctv/catalog.js';
import { normalizeFeedType, isVideoFeedType } from './cctv/normalize.js';
import {
  buildSyntheticCctvSvg,
  proxyMediaResponse,
  fetchCctvImageFromUpstream,
  fetchCctvMediaUpstream,
} from './cctv/media.js';
import {
  CCTV_AREA_RADIUS_KM,
  CCTV_FRAME_CACHE_TTL_MS,
  CCTV_FRAME_FAILURES_MAX,
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  CCTV_HEALTH_MAX_ENTRIES,
  CCTV_HOST_BUDGET_FILE,
  CCTV_IBI_ACTIVE_REFRESH_MS,
  CCTV_IBI_CARD_REFRESH_MS,
  CCTV_IBI_LAST_GOOD_MAX_MS,
  CCTV_LOAD_CAP_HARD_LIMIT,
  ROAD511_CACHE_FILE,
} from './cctv/constants.js';
import {
  frameFailureBackoffMs,
  frameHostAllowed,
  resolveFrameUrl,
} from './cctv/frame-resolver.js';
import { googleServerApiKey } from './places/google-key.js';
import {
  CCTV_PROXY_USER_AGENT,
  browserDirectImageUrl,
} from './cctv/upstream-headers.js';
import {
  clampCctvAreaRadiusKm,
  parseCctvAreaPoint,
  queryCctvArea,
} from './cctv/area.js';
import { createFrameCache } from './cctv/frame-cache.js';
import { createUpstreamGate, upstreamHostOf } from './cctv/upstream-gate.js';
import { createHostBudget, isBudgetedFrameUrl } from './cctv/host-budget.js';
import {
  createRoad511Lookup,
  safeRoad511StillUrl,
} from './cctv/road511-lookup.js';
import {
  originIs,
  resolvedAllowedHosts,
  servedRequestOrigin,
} from './common/allowed-hosts.js';
import { coalesceProxyRequest } from './common/http.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
export { CCTV_FRAME_FETCH_TIMEOUT_MS, fetchCctvImageFromUpstream };

const gzip = promisify(zlib.gzip);

/** Placeholder text for a camera with no public still, by lookup state. */
const LOOKUP_PLACEHOLDERS = {
  'no-image': { status: 'NO PUBLIC IMAGE', message: 'No public image' },
  'no-key': {
    status: 'ROAD511 KEY NOT SET',
    message: 'Road511 lookup needs ROAD511_API_KEY',
  },
  'key-rejected': {
    status: 'ROAD511 KEY REJECTED',
    message: 'Road511 refused ROAD511_API_KEY',
  },
  unresolved: {
    status: 'SELECT CAMERA TO LOOK UP',
    message: 'Still not looked up yet',
  },
};

/** Camera id from a route path, or '' when it cannot be decoded. */
function cameraIdFrom(pathname, prefix) {
  try {
    return decodeURIComponent(pathname.slice(prefix.length).trim());
  } catch {
    return '';
  }
}

/** Street View runs only when CCTV_STREETVIEW_FALLBACK=1 (off by default). */
function streetViewEnabled() {
  return String(process.env.CCTV_STREETVIEW_FALLBACK || '').trim() === '1';
}

/**
 * Vite plugin: CCTV camera proxy with an area-scoped source index, frame and
 * media serving, per-host upstream gating, the 511 request budget, on-demand
 * Road511 still lookups, and health tracking.
 *
 * Endpoints:
 *   GET  /api/cctv/sources?lat&lon[&radiusKm] — cameras of one selected area
 *   GET  /api/cctv/health         — per-camera health/status report + counters
 *   GET  /api/cctv/stream/:id     — stream info (feedType, URLs) for a camera
 *   GET  /api/cctv/media/:id      — proxy live video/image media from upstream
 *   GET  /api/cctv/frame/:id      — single frame (cache, gate, placeholder)
 *   POST /api/cctv/lookup/:id     — look up one camera's still (explicit open)
 *
 * Location switch: CCTV is deliberately not in LOCATION_SWITCH_RELEASES. The
 * source index is global (one catalogue serves every place, cut per request),
 * the frame cache is small and bounded, and lookups are keyed by camera id, so
 * nothing here is area-keyed memory a change of place should release.
 *
 * @returns {import('vite').Plugin}
 */
export function cctvProxy({
  sourceRoot = process.cwd(),
  cacheDir = path.join(sourceRoot, '.gev-cache'),
  catalog,
  frameCache,
  upstreamGate,
  hostBudget,
  road511Lookup,
  // Test seam: the fetch for stills on hosts no catalogue vouches for. By
  // default those use the public-only fetch in cctv/media.js.
  guardedFetch,
  frameFailuresMax = CCTV_FRAME_FAILURES_MAX,
} = {}) {
  // Nothing below reads a file, opens a timer or contacts a network until the
  // first request: building the plugin is free.
  const cameras = catalog || createCctvCatalog({ sourceRoot, cacheDir });
  const frames = frameCache || createFrameCache();
  const gate = upstreamGate || createUpstreamGate();
  const budget =
    hostBudget ||
    createHostBudget({ file: path.join(cacheDir, CCTV_HOST_BUDGET_FILE) });
  const road511 =
    road511Lookup ||
    createRoad511Lookup({ cacheFile: path.join(cacheDir, ROAD511_CACHE_FILE) });
  const lookupAllowed = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 120,
  });
  const counters = {
    upstreamFrameFetches: 0,
    frameCacheHits: 0,
    hostThrottled: 0,
    budgetDenied: 0,
    streetViewFetches: 0,
  };
  /** @type {Map<string,{id:string,status:string,sourceKind:string,label:string,message:string,updatedAt:number}>} */
  const health = new Map();
  /** Per-camera frame failures: { failures, until }, least recently failed
   * evicted first. While `until` is in the future the frame route serves the
   * placeholder without touching the upstream. */
  const frameFailures = new Map();
  /** One upstream still request per camera at a time, shared by every caller. */
  const inflightFrames = new Map();

  /** Update the health entry for a camera, evicting the oldest entry if at capacity. */
  const setHealth = (cameraId, patch) => {
    if (!health.has(cameraId) && health.size >= CCTV_HEALTH_MAX_ENTRIES) {
      const oldest = health.keys().next().value;
      health.delete(oldest);
    }
    const prev = health.get(cameraId) || {};
    // Re-insert on every write so eviction is least-recently-updated: an active
    // camera must never be the one dropped because it was registered first.
    health.delete(cameraId);
    health.set(cameraId, {
      id: cameraId,
      status: patch.status || prev.status || 'unknown',
      sourceKind: patch.sourceKind || prev.sourceKind || 'unknown',
      label: patch.label || prev.label || '',
      message: patch.message || prev.message || '',
      updatedAt: Date.now(),
    });
  };

  /** Snapshot all camera health entries as an array. */
  const listHealth = () => Array.from(health.values());

  const noteFrameFailure = (cameraId) => {
    const failures = (frameFailures.get(cameraId)?.failures || 0) + 1;
    frameFailures.delete(cameraId);
    frameFailures.set(cameraId, {
      failures,
      until: Date.now() + frameFailureBackoffMs(failures),
    });
    while (frameFailures.size > frameFailuresMax) {
      frameFailures.delete(frameFailures.keys().next().value);
    }
  };

  /**
   * A catalogue camera by id. An id the catalogue does not know yet may belong
   * to a live pack saved on disk before a restart, so the saved lists are
   * adopted once (a file read, never a download) before giving up.
   */
  const findSource = async (snapshot, cameraId) => {
    if (!cameraId) return undefined;
    const known = snapshot.byId.get(cameraId);
    if (known) return known;
    if (!(await cameras.warmFromDisk())) return undefined;
    return (await cameras.snapshot()).byId.get(cameraId);
  };

  /** The still a camera's frames come from, or '' for none (pack URL or looked-up still). */
  const stillUrlOf = (source, lookup) => {
    const feedType = normalizeFeedType(source?.feedType);
    if (feedType === 'none')
      return lookup?.lookupState === 'resolved' ? lookup.url : '';
    return (
      source?.snapshotUrl || (!isVideoFeedType(feedType) ? source?.url : '')
    );
  };

  /** Write JSON, gzipped when the client accepts it. */
  const sendJson = async (req, res, status, body, extraHeaders = {}) => {
    const json = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Vary: 'Accept-Encoding',
      ...extraHeaders,
    };
    const accepts = String(req?.headers?.['accept-encoding'] || '');
    if (/\bgzip\b/i.test(accepts)) {
      const packed = await gzip(json);
      res.writeHead(status, {
        ...headers,
        'Content-Encoding': 'gzip',
        'Content-Length': packed.length,
      });
      res.end(packed);
      return;
    }
    res.writeHead(status, headers);
    res.end(json);
  };

  /** Build a JSON payload describing stream info (feedType, URLs) for a camera. */
  const buildStreamPayload = (source, cameraId) => {
    const lookup = source ? road511.peek(source) : null;
    const rawType = normalizeFeedType(source?.feedType || 'image');
    const feedType =
      rawType === 'none' && lookup?.lookupState === 'resolved'
        ? 'image'
        : rawType;
    return {
      id: cameraId,
      feedType,
      mediaUrl: isVideoFeedType(feedType)
        ? `/api/cctv/media/${encodeURIComponent(cameraId)}`
        : null,
      frameUrl: `/api/cctv/frame/${encodeURIComponent(cameraId)}`,
      provider: source?.provider || '',
      sourceKind:
        source?.sourceKind || (source?.url ? 'configured' : 'fallback'),
    };
  };

  /** One camera as the /sources route lists it. */
  const serializeSource = (source, distKm) => {
    const lookup = road511.peek(source);
    const rawType = normalizeFeedType(source.feedType);
    const still = stillUrlOf(source, lookup);
    const feedType = rawType === 'none' && still ? 'image' : rawType;
    const lookupState =
      source.lookup === 'road511'
        ? lookup.lookupState
        : rawType === 'none'
          ? 'no-image'
          : 'resolved';
    const budgeted = isBudgetedFrameUrl(still);
    return {
      id: source.id,
      name: source.name,
      city: source.city,
      cityId: source.cityId,
      country: source.country || '',
      region: source.regionKey,
      provider: source.provider,
      lat: source.lat,
      lon: source.lon,
      headingDeg: source.headingDeg,
      headingConfidence: source.headingConfidence || '',
      pitchDeg: source.pitchDeg,
      fovDeg: source.fovDeg,
      rangeM: source.rangeM,
      mountHeightM: source.mountHeightM,
      groundElevationM: source.groundElevationM,
      feedType,
      sourceKind: source.sourceKind || (source.url ? 'configured' : 'fallback'),
      poseSource: source.poseSource,
      license: source.license,
      // Set only for hosts the viewer's browser must load itself
      // (CCTV_BROWSER_DIRECT_HOSTS); every other still stays proxied.
      browserImageUrl: browserDirectImageUrl(source) || undefined,
      distKm: Math.round(distKm * 1000) / 1000,
      lookup: source.lookup || '',
      lookupState,
      // 511 sites allow 20 requests a minute and 1,000 a day per host, so their
      // stills refresh every 15 minutes on cards and every minute when active.
      frameRefreshMs: budgeted ? CCTV_IBI_CARD_REFRESH_MS : undefined,
      activeFrameRefreshMs: budgeted ? CCTV_IBI_ACTIVE_REFRESH_MS : undefined,
    };
  };

  const serveSources = async (req, res, url) => {
    const point = parseCctvAreaPoint(
      url.searchParams.get('lat'),
      url.searchParams.get('lon'),
    );
    if (!point) {
      // No point, no cameras: the whole catalogue is never sent.
      const snapshot = await cameras.snapshot();
      await sendJson(req, res, 200, {
        sources: [],
        area: {
          pointRequired: true,
          radiusKm: CCTV_AREA_RADIUS_KM,
          limit: CCTV_LOAD_CAP_HARD_LIMIT,
          total: snapshot.total,
          generation: snapshot.generation,
          pending: [],
        },
      });
      return;
    }
    const radiusKm = clampCctvAreaRadiusKm(url.searchParams.get('radiusKm'));
    // The area decides which live packs download; they are never fetched for
    // a place nobody selected. No `limit` query is read: 2,500 is fixed.
    const { pending } = await cameras.ensureArea({ ...point, radiusKm });
    const [snapshot] = await Promise.all([cameras.snapshot(), road511.ready()]);
    const { matches, area } = queryCctvArea(snapshot, { ...point, radiusKm });
    await sendJson(req, res, 200, {
      area: { ...area, generation: snapshot.generation, pending },
      sources: matches.map(({ source, distKm }) =>
        serializeSource(source, distKm),
      ),
    });
  };

  const serveLookup = async (req, res, url, allowedHosts) => {
    const headers = req.headers || {};
    const refuse = (status, error, extra = {}) =>
      sendJson(req, res, status, { error }, extra);
    if (req.method !== 'POST') {
      await refuse(405, 'POST only', { Allow: 'POST' });
      return;
    }
    // Vite checks allowedHosts only after plugin middleware, so this route
    // checks the Host itself: a DNS-rebinding page (whose Origin matches its
    // own Host) or a tunnel to this port never spends a Road511 lookup.
    const served = servedRequestOrigin(req, allowedHosts);
    if (!served) {
      await refuse(403, 'Lookup refused for this host');
      return;
    }
    // Same-origin only: a browser marks a cross-site request, and a page on
    // another origin cannot send this JSON body without a preflight.
    const site = String(headers['sec-fetch-site'] || '').toLowerCase();
    if (site && site !== 'same-origin') {
      await refuse(403, 'Cross-site lookup refused');
      return;
    }
    // An Origin, when sent, must be exactly the origin this Host serves.
    if (
      headers.origin !== undefined &&
      !originIs(headers.origin, served.origin)
    ) {
      await refuse(403, 'Cross-origin lookup refused');
      return;
    }
    if (
      !String(headers['content-type'] || '')
        .toLowerCase()
        .startsWith('application/json')
    ) {
      await refuse(415, 'Content-Type must be application/json');
      return;
    }
    if (!lookupAllowed(clientKey(req))) {
      await sendJson(
        req,
        res,
        429,
        { lookupState: 'busy', feedType: 'none', retryAfterMs: 60_000 },
        { 'Retry-After': '60' },
      );
      return;
    }
    const cameraId = cameraIdFrom(url.pathname, '/lookup/');
    if (!cameraId) {
      await refuse(400, 'Camera id required');
      return;
    }
    const source = await findSource(await cameras.snapshot(), cameraId);
    const result = await road511.lookup(source);
    await sendJson(req, res, 200, {
      id: cameraId,
      lookupState: result.lookupState,
      feedType:
        result.lookupState === 'resolved' ||
        (source && normalizeFeedType(source.feedType) !== 'none')
          ? 'image'
          : 'none',
      retryAfterMs: Math.max(0, Math.round(result.retryAfterMs || 0)),
    });
  };

  /**
   * Fetch a Google Street View static image as a fallback frame. Server-side
   * call, never reaches the browser — prefers GOOGLE_MAPS_SERVER_API_KEY
   * (#33: a key scoped to Street View Static/Places, restricted by server IP
   * rather than HTTP referrer) and falls back to the browser-exposed
   * GOOGLE_MAPS_API_KEY for setups that haven't split the two yet. Only the
   * catalogue's own position and pose are ever sent.
   */
  const streetViewFallback = async ({ lat, lon, heading, fov, pitch }) => {
    const streetViewKey = googleServerApiKey();
    if (!streetViewKey || !Number.isFinite(lat) || !Number.isFinite(lon))
      return null;
    try {
      const sv = new URL('https://maps.googleapis.com/maps/api/streetview');
      sv.searchParams.set('size', '960x540');
      sv.searchParams.set('location', `${lat},${lon}`);
      sv.searchParams.set(
        'heading',
        String(Number.isFinite(heading) ? heading : 0),
      );
      sv.searchParams.set(
        'fov',
        String(Number.isFinite(fov) ? Math.max(20, Math.min(120, fov)) : 80),
      );
      sv.searchParams.set(
        'pitch',
        String(Number.isFinite(pitch) ? Math.max(-40, Math.min(20, pitch)) : 0),
      );
      sv.searchParams.set('source', 'outdoor');
      sv.searchParams.set('return_error_code', 'true');
      sv.searchParams.set('key', streetViewKey);

      counters.streetViewFetches += 1;
      const svResp = await fetch(sv.toString(), {
        headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
        signal: AbortSignal.timeout(CCTV_FRAME_FETCH_TIMEOUT_MS),
      });
      const svType = svResp.headers.get('content-type') || '';
      if (!svResp.ok || !svType.startsWith('image/')) return null;

      return {
        ok: true,
        body: Buffer.from(await svResp.arrayBuffer()),
        contentType: svType,
      };
    } catch {
      return null;
    }
  };

  const sendSynthetic = (
    res,
    { cameraId, label, city, status },
    extra = {},
  ) => {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store',
      'X-CCTV-Source': 'synthetic',
      ...extra,
    });
    res.end(buildSyntheticCctvSvg({ cameraId, label, city, status }));
  };

  const sendStill = (res, still, cache, extra = {}) => {
    res.writeHead(200, {
      'Content-Type': still.contentType,
      'Cache-Control': 'no-store',
      'X-CCTV-Source': 'upstream-image',
      'X-CCTV-Cache': cache,
      ...extra,
    });
    res.end(still.body);
  };

  /**
   * One upstream still for a camera, through the host gate and (for 511
   * hosts) the request budget. Runs once per camera at a time; whoever starts
   * it records the outcome (cache, failure backoff, counters, health).
   */
  const fetchFrame = async (source, lookupStill, active) => {
    const cameraId = source.id;
    const provider = source.provider || 'Configured source';
    const resolvedUrl =
      !lookupStill && source.frameResolver ? await resolveFrameUrl(source) : '';
    const candidate =
      resolvedUrl ||
      stillUrlOf(source, {
        lookupState: lookupStill ? 'resolved' : '',
        url: lookupStill,
      });
    if (!candidate) return { kind: 'missing', active };
    // A looked-up still or a page-advertised frame is on a host no catalogue
    // vouches for. It is fetched only from a public address (checked on the
    // address the connection uses), and every redirect hop must pass the same
    // test as the first URL. Catalogue stills keep fetch's own handling.
    const allowUrl = lookupStill
      ? (href) => Boolean(safeRoad511StillUrl(href))
      : resolvedUrl
        ? (href) => frameHostAllowed(source, new URL(href))
        : undefined;
    const budgeted = isBudgetedFrameUrl(candidate);
    if (budgeted) await budget.ready();
    let upstreamStatus = 0;
    const outcome = await gate.run(candidate, async () => {
      if (budgeted) {
        const grant = budget.take(upstreamHostOf(candidate), { active });
        if (!grant.ok)
          return { kind: 'budget', retryAfterMs: grant.retryAfterMs };
      }
      counters.upstreamFrameFetches += 1;
      const image = await fetchCctvImageFromUpstream(candidate, {
        ...(allowUrl ? { allowUrl, fetchImpl: guardedFetch } : {}),
        onResponse: (response) => {
          upstreamStatus = response.status;
          gate.noteResponse(candidate, response);
        },
      });
      return image?.ok ? { kind: 'image', image } : { kind: 'failed' };
    });
    let result;
    if (outcome.status === 'blocked') {
      result = { kind: 'blocked', retryAfterMs: outcome.retryAfterMs };
    } else if (outcome.status === 'throttled') {
      result = { kind: 'throttled' };
    } else if (
      outcome.value.kind === 'failed' &&
      (upstreamStatus === 429 || upstreamStatus === 503) &&
      gate.blockedFor(candidate) > 0
    ) {
      // The host said slow down: that is not this camera failing.
      result = { kind: 'blocked', retryAfterMs: gate.blockedFor(candidate) };
    } else {
      result = outcome.value;
    }

    if (result.kind === 'image') {
      frames.set(cameraId, {
        body: result.image.body,
        contentType: result.image.contentType,
      });
      frameFailures.delete(cameraId);
      setHealth(cameraId, {
        status: 'ok',
        sourceKind: 'snapshot',
        label: provider,
        message: 'Upstream snapshot active',
      });
    } else if (result.kind === 'failed') {
      noteFrameFailure(cameraId);
    } else if (result.kind === 'budget') {
      counters.budgetDenied += 1;
    } else {
      counters.hostThrottled += 1;
    }
    return { ...result, active, budgeted };
  };

  const serveFrame = async (req, res, url, snapshot) => {
    const cameraId = cameraIdFrom(url.pathname, '/frame/');
    // Only the active camera's monitor plane and panel preview send active=1.
    const active = url.searchParams.get('active') === '1';
    const source = await findSource(snapshot, cameraId);
    if (!source) {
      // Unknown id: the query's label, place and pose are never trusted, and
      // nothing upstream (Street View included) is contacted for it.
      sendSynthetic(res, {
        cameraId: cameraId || 'camera',
        label: cameraId || 'camera',
        city: '',
        status: 'NO UPSTREAM CONFIGURED',
      });
      return;
    }
    const label = source.name || cameraId;
    const city = source.city || '';
    const provider = source.provider || 'Configured source';
    const feedType = normalizeFeedType(source.feedType);
    const placeholder = (status, message, extra = {}) => {
      setHealth(cameraId, {
        status: 'degraded',
        sourceKind: 'synthetic',
        label: provider,
        message,
      });
      sendSynthetic(res, { cameraId, label, city, status }, extra);
    };

    // A camera with no public still shows its looked-up still once the user
    // opened it, else a placeholder. This route never calls Road511 itself.
    let lookupStill = '';
    if (feedType === 'none') {
      await road511.ready();
      const lookup = road511.peek(source);
      if (lookup.lookupState === 'resolved' && lookup.url) {
        lookupStill = lookup.url;
      } else {
        const state = !road511.eligible(source)
          ? 'no-image'
          : lookup.lookupState === 'no-image'
            ? 'no-image'
            : !road511.hasKey()
              ? 'no-key'
              : road511.keyRejected()
                ? 'key-rejected'
                : 'unresolved';
        const text = LOOKUP_PLACEHOLDERS[state];
        placeholder(text.status, text.message, { 'X-CCTV-Lookup': state });
        return;
      }
    }

    const unavailable = () =>
      placeholder(
        source.url || source.pageUrl || lookupStill
          ? 'UPSTREAM UNAVAILABLE'
          : 'NO UPSTREAM CONFIGURED',
        source.url || lookupStill
          ? 'Upstream unavailable'
          : 'No source configured',
      );
    // A browser-direct camera's still is refused to every server, so the
    // proxy neither tries it nor spends a Street View request on it.
    if (browserDirectImageUrl(source)) {
      unavailable();
      return;
    }

    const directUrl = stillUrlOf(source, {
      lookupState: lookupStill ? 'resolved' : '',
      url: lookupStill,
    });
    const budgeted = isBudgetedFrameUrl(directUrl);
    const reuseMs = budgeted
      ? active
        ? CCTV_IBI_ACTIVE_REFRESH_MS
        : CCTV_IBI_CARD_REFRESH_MS
      : CCTV_FRAME_CACHE_TTL_MS;
    const cached = frames.get(cameraId, reuseMs);
    if (cached) {
      counters.frameCacheHits += 1;
      sendStill(res, cached, 'hit');
      return;
    }
    /** A spent 511 budget or a blocked 511 host serves the last good still. */
    const held = (status, message, retryAfterMs = 0) => {
      const lastGood = budgeted
        ? frames.get(cameraId, CCTV_IBI_LAST_GOOD_MAX_MS)
        : null;
      const retry =
        retryAfterMs > 0
          ? { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) }
          : {};
      if (lastGood) {
        counters.frameCacheHits += 1;
        sendStill(res, lastGood, 'last-good', retry);
        return;
      }
      placeholder(status, message, retry);
    };

    // A camera inside its failure backoff is not retried yet.
    const failure = frameFailures.get(cameraId);
    if (failure && Date.now() < failure.until) {
      if (budgeted) held('UPSTREAM UNAVAILABLE', 'Upstream unavailable');
      else unavailable();
      return;
    }
    const hostProbe = directUrl || source.pageUrl || '';
    const blockedMs = hostProbe ? gate.blockedFor(hostProbe) : 0;
    if (blockedMs > 0) {
      counters.hostThrottled += 1;
      held('UPSTREAM RATE LIMITED', 'Upstream asked to slow down', blockedMs);
      return;
    }

    /** Street View: opt-in, active camera only, never for a card. */
    const streetView = async () => {
      if (!active || !streetViewEnabled()) return false;
      const sv = await streetViewFallback({
        lat: source.lat,
        lon: source.lon,
        heading: source.headingDeg,
        fov: source.fovDeg,
        pitch: source.pitchDeg,
      });
      if (!sv?.ok) return false;
      setHealth(cameraId, {
        status: 'degraded',
        sourceKind: 'streetview',
        label: 'Google Street View',
        message: 'Fallback Street View frame',
      });
      res.writeHead(200, {
        'Content-Type': sv.contentType,
        'Cache-Control': 'no-store',
        'X-CCTV-Source': 'streetview',
      });
      res.end(sv.body);
      return true;
    };

    const videoFeed = isVideoFeedType(feedType);
    if (!directUrl && !source.frameResolver) {
      // Nothing to fetch. A video-only camera has no still, so it never reaches
      // Street View either.
      if (!videoFeed && (await streetView())) return;
      unavailable();
      return;
    }

    let { promise } = coalesceProxyRequest(inflightFrames, cameraId, () =>
      fetchFrame(source, lookupStill, active),
    );
    let result = await promise;
    if (result.kind === 'budget' && active && !result.active) {
      // A card's request was refused; the active camera may still have room.
      ({ promise } = coalesceProxyRequest(inflightFrames, cameraId, () =>
        fetchFrame(source, lookupStill, true),
      ));
      result = await promise;
    }

    switch (result.kind) {
      case 'image':
        sendStill(res, result.image, 'miss');
        return;
      case 'budget':
        held(
          '511 LIMIT REACHED',
          '511 request limit reached',
          result.retryAfterMs,
        );
        return;
      case 'blocked':
        held(
          'UPSTREAM RATE LIMITED',
          'Upstream asked to slow down',
          result.retryAfterMs,
        );
        return;
      case 'throttled':
        held('UPSTREAM BUSY', 'Upstream queue full');
        return;
      default:
        if (await streetView()) return;
        unavailable();
    }
  };

  const serveMedia = async (req, res, url, snapshot) => {
    const cameraId = cameraIdFrom(url.pathname, '/media/') || 'camera';
    const source = await findSource(snapshot, cameraId);
    const feedType = normalizeFeedType(source?.feedType || 'image');
    // A camera with no public still or stream has nothing to proxy; its kept
    // video address (videoUrl) is never served.
    const mediaUrl = feedType === 'none' ? '' : source?.url || '';

    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
      if (source) {
        setHealth(cameraId, {
          status: 'degraded',
          sourceKind: 'fallback',
          label: source.provider || 'No upstream URL',
          message: 'No stream URL configured',
        });
      }
      res.writeHead(404, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          error: 'No media URL configured for this camera',
        }),
      );
      return;
    }

    // The 511 budget and host blocks apply here too, so this route is not a
    // way around them.
    const blockedMs = gate.blockedFor(mediaUrl);
    let denied = blockedMs;
    if (!denied && isBudgetedFrameUrl(mediaUrl)) {
      await budget.ready();
      const grant = budget.take(upstreamHostOf(mediaUrl), {
        active: url.searchParams.get('active') === '1',
      });
      if (!grant.ok) {
        counters.budgetDenied += 1;
        denied = Math.max(1000, grant.retryAfterMs);
      }
    } else if (denied) {
      counters.hostThrottled += 1;
    }
    if (denied) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Retry-After': String(Math.ceil(denied / 1000)),
      });
      res.end(JSON.stringify({ error: 'Upstream request limit reached' }));
      return;
    }

    try {
      const upstreamHeaders = {
        'User-Agent': CCTV_PROXY_USER_AGENT,
      };
      const requestRange = req.headers?.range;
      if (requestRange) upstreamHeaders.Range = requestRange;
      const upstream = await fetchCctvMediaUpstream(mediaUrl, {
        headers: upstreamHeaders,
      });
      gate.noteResponse(mediaUrl, {
        status: upstream.status,
        headers: upstream.headers,
      });
      const contentType = upstream.headers.get('content-type') || '';
      if (!upstream.ok) {
        try {
          await upstream.body?.cancel();
        } catch {
          /* already closed */
        }
        setHealth(cameraId, {
          status: 'degraded',
          sourceKind: 'upstream',
          label: source?.provider || 'Configured source',
          message: `Upstream HTTP ${upstream.status}`,
        });
        res.writeHead(upstream.status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: `Upstream returned ${upstream.status}`,
          }),
        );
        return;
      }

      const hlsPlaylist = contentType.toLowerCase().includes('mpegurl');
      if (
        isVideoFeedType(feedType) &&
        !(contentType.startsWith('video/') || hlsPlaylist)
      ) {
        setHealth(cameraId, {
          status: 'degraded',
          sourceKind: 'upstream',
          label: source?.provider || 'Configured source',
          message: `Unexpected media type ${contentType || 'unknown'}`,
        });
      } else if (hlsPlaylist) {
        // A playlist is bytes, not a picture: the browser still has to
        // decode HLS itself, and this app ships no HLS player. Do not
        // report a green 'Live stream connected' for it.
        setHealth(cameraId, {
          status: 'degraded',
          sourceKind: 'live',
          label: source?.provider || 'Configured source',
          message: 'HLS playlist proxied; playback depends on browser support',
        });
      } else {
        setHealth(cameraId, {
          status: 'ok',
          sourceKind: isVideoFeedType(feedType) ? 'live' : 'snapshot',
          label: source?.provider || 'Configured source',
          message: isVideoFeedType(feedType)
            ? 'Live stream connected'
            : 'Snapshot feed connected',
        });
      }

      await proxyMediaResponse(res, upstream, {
        sourceHeader: isVideoFeedType(feedType)
          ? 'live-media'
          : 'upstream-image',
      });
    } catch (error) {
      const timedOut =
        error?.name === 'AbortError' || error?.name === 'TimeoutError';
      setHealth(cameraId, {
        status: 'degraded',
        sourceKind: 'upstream',
        label: source?.provider || 'Configured source',
        message: error?.message || 'Media fetch failed',
      });
      res.writeHead(timedOut ? 504 : 502, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          error: timedOut ? 'Upstream media timeout' : 'Media proxy failed',
        }),
      );
    }
  };

  /** @param {'server' | 'preview'} section - Which Vite server's hosts apply. */
  const installMiddleware = (server, section) => {
    // The hosts this server answers, for the route that checks Host itself.
    const allowedHosts = resolvedAllowedHosts(server.config, section);
    server.middlewares.use('/api/cctv', async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost');

        if (url.pathname === '/sources') {
          await serveSources(req, res, url);
          return;
        }

        if (url.pathname === '/health') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({
              cameras: listHealth(),
              counters: {
                ...counters,
                road511Calls: road511.counters.road511Calls,
                road511CacheHits: road511.counters.road511CacheHits,
              },
              frameFailures: frameFailures.size,
            }),
          );
          return;
        }

        if (url.pathname.startsWith('/lookup/')) {
          await serveLookup(req, res, url, allowedHosts);
          return;
        }

        const snapshot = await cameras.snapshot();

        if (url.pathname.startsWith('/stream/')) {
          const cameraId = cameraIdFrom(url.pathname, '/stream/') || 'camera';
          const source = await findSource(snapshot, cameraId);
          if (source) await road511.ready();
          const payload = buildStreamPayload(source, cameraId);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(payload));
          return;
        }

        if (url.pathname.startsWith('/media/')) {
          await serveMedia(req, res, url, snapshot);
          return;
        }

        if (!url.pathname.startsWith('/frame/')) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }

        await serveFrame(req, res, url, snapshot);
      } catch (error) {
        console.error('[CCTV Proxy]', error?.message || String(error));
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'CCTV proxy error' }));
      }
    });
  };
  return {
    name: 'cctv-proxy',
    configureServer: (server) => installMiddleware(server, 'server'),
    configurePreviewServer: (server) => installMiddleware(server, 'preview'),
  };
}
