import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { CCTV_PROXY_USER_AGENT } from './upstream-headers.js';
import { isPublicAddress } from './frame-resolver.js';
import { hashSeed, escapeXml } from './normalize.js';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  CCTV_FRAME_MAX_BODY_BYTES,
  CCTV_FRAME_MAX_REDIRECTS,
  CCTV_MEDIA_FETCH_TIMEOUT_MS,
  CCTV_MEDIA_MAX_BODY_BYTES,
} from './constants.js';
/**
 * Generate a synthetic SVG billboard image for a CCTV camera placeholder.
 *
 * Produces a 960x540 SVG with a deterministic gradient (hue derived from
 * camera ID hash), scanline overlay, HUD-style grid, and text labels
 * showing camera name, city, ID, status, and current timestamp. Used
 * when no upstream image or Street View fallback is available.
 *
 * @param {object} opts
 * @param {string} opts.cameraId
 * @param {string} opts.label
 * @param {string} [opts.city]
 * @param {string} [opts.status]
 * @returns {string} SVG markup string.
 */
export function buildSyntheticCctvSvg({ cameraId, label, city, status }) {
  const seed = hashSeed(`${cameraId}:${label}:${city}`);
  const hue = seed % 360;
  const hue2 = (hue + 46) % 360;
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').replace('Z', 'Z').slice(0, 20);
  const safeLabel = escapeXml(label);
  const safeCity = escapeXml(city || 'GLOBAL GRID');
  const safeId = escapeXml(cameraId);
  const safeStatus = escapeXml(status || 'SYNTHETIC');

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 35%, 10%)" />
      <stop offset="60%" stop-color="hsl(${hue2}, 42%, 6%)" />
      <stop offset="100%" stop-color="#020509" />
    </linearGradient>
    <radialGradient id="flare" cx="0.22" cy="0.24" r="0.78">
      <stop offset="0%" stop-color="hsla(${hue2}, 100%, 65%, 0.35)" />
      <stop offset="100%" stop-color="hsla(${hue2}, 100%, 40%, 0)" />
    </radialGradient>
    <pattern id="scan" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="transparent" />
      <rect y="0" width="8" height="1" fill="rgba(255,255,255,0.08)" />
      <rect y="4" width="8" height="1" fill="rgba(255,255,255,0.05)" />
    </pattern>
  </defs>
  <rect width="960" height="540" fill="url(#bg)" />
  <rect width="960" height="540" fill="url(#flare)" />
  <rect width="960" height="540" fill="url(#scan)" />
  <g stroke="rgba(123,233,255,0.25)" stroke-width="1" fill="none">
    <path d="M60 460 Q300 300 520 420 T900 320" />
    <path d="M100 160 Q340 40 620 130 T920 90" />
    <path d="M20 280 Q220 230 390 270 T760 250" />
  </g>
  <g fill="none" stroke="rgba(180,248,255,0.2)" stroke-width="1">
    <rect x="70" y="80" width="820" height="380" rx="8" />
    <line x1="70" y1="270" x2="890" y2="270" />
    <line x1="480" y1="80" x2="480" y2="460" />
  </g>
  <g fill="#9cefff" font-family="JetBrains Mono, monospace" text-transform="uppercase">
    <text x="74" y="54" font-size="16" letter-spacing="2">CCTV FEED PLACEHOLDER</text>
    <text x="74" y="512" font-size="14" letter-spacing="1.5">${safeLabel} · ${safeCity}</text>
    <text x="646" y="512" font-size="13" letter-spacing="1.2">${safeId}</text>
    <text x="704" y="54" font-size="15" letter-spacing="2">${escapeXml(ts)}</text>
    <text x="74" y="486" font-size="13" letter-spacing="1.3">${safeStatus}</text>
  </g>
</svg>`.trim();
}

/**
 * Coerce a fetch() response body to a Node.js Readable stream.
 *
 * Handles both Node-native streams (.pipe) and web ReadableStreams (.getReader).
 *
 * @param {ReadableStream|NodeJS.ReadableStream|null} body
 * @returns {import('stream').Readable|null}
 */
export function toReadable(body) {
  if (!body) return null;
  if (typeof body.pipe === 'function') return body;
  if (typeof body.getReader === 'function') {
    return Readable.fromWeb(body);
  }
  return null;
}

/**
 * Pipe an upstream fetch Response (image or video) to the client HTTP response.
 *
 * Forwards Content-Type, Content-Length, Content-Range, Accept-Ranges, and
 * Cache-Control headers from the upstream. Falls back to buffered arrayBuffer
 * if the body is not streamable.
 *
 * @param {import('http').ServerResponse} res
 * @param {Response} upstream - fetch() Response object.
 * @param {object} [opts]
 * @param {string} [opts.sourceHeader='upstream'] - Value for X-CCTV-Source header.
 */
export async function proxyMediaResponse(
  res,
  upstream,
  { sourceHeader = 'upstream' } = {},
) {
  const contentType =
    upstream.headers.get('content-type') || 'application/octet-stream';
  const cacheControl = upstream.headers.get('cache-control') || 'no-store';
  const contentLength = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  const acceptRanges = upstream.headers.get('accept-ranges');
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'X-CCTV-Source': sourceHeader,
  };
  if (contentLength) headers['Content-Length'] = contentLength;
  if (contentRange) headers['Content-Range'] = contentRange;
  if (acceptRanges) headers['Accept-Ranges'] = acceptRanges;

  // Cheap defense: reject an upstream that DECLARES an oversized fixed body.
  // Live MJPEG/HLS streams are unbounded by design and send no content-length,
  // so they pipe normally (piping streams to the client, never buffering).
  if (
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > CCTV_MEDIA_MAX_BODY_BYTES
  ) {
    res.writeHead(502, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ error: 'Upstream media exceeds size cap' }));
    try {
      await upstream.body?.cancel();
    } catch {
      /* no-op */
    }
    return;
  }

  res.writeHead(upstream.status, headers);

  const stream = toReadable(upstream.body);
  if (!stream) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
    return;
  }

  stream.on('error', () => {
    if (!res.writableEnded) res.end();
  });

  // A live camera feed has no end of its own. When the viewer goes away the
  // upstream connection must go with it, or every abandoned view leaves a
  // stream open against the camera host for as long as that host will hold it.
  let released = false;
  const releaseUpstream = () => {
    if (released) return;
    released = true;
    stream.unpipe(res);
    // Destroying the Node stream cancels the web body it wraps; the direct
    // cancel covers a body that was never wrapped, and rejects harmlessly when
    // the reader is already held.
    stream.destroy();
    try {
      const cancelled = upstream.body?.cancel?.();
      if (typeof cancelled?.catch === 'function') cancelled.catch(() => {});
    } catch {
      /* already closed */
    }
  };
  res.once('close', () => {
    if (!res.writableEnded) releaseUpstream();
  });
  res.once('error', releaseUpstream);
  stream.once('end', () => {
    released = true;
  });
  stream.pipe(res);
}

/**
 * Watch a client response for an early goodbye.
 *
 * Bound BEFORE the upstream request goes out, because most of the waiting
 * happens before any header comes back: a viewer who closes the tab while a
 * slow camera is still thinking would otherwise leave that request running with
 * nobody to receive it.
 *
 * @param {import('http').ServerResponse} res - The client response.
 * @returns {{signal: AbortSignal, closed: boolean}} `signal` cancels the
 *   upstream request; `closed` says the client left before the response ended.
 */
export function watchDownstreamClose(res) {
  const controller = new AbortController();
  const state = {
    signal: controller.signal,
    closed: false,
  };
  const onClose = () => {
    // A response that ended normally also emits close; only an early one counts.
    if (res.writableEnded) return;
    state.closed = true;
    controller.abort();
  };
  res.once?.('close', onClose);
  res.once?.('error', onClose);
  return state;
}

/** Read a snapshot incrementally, retaining at most maxBytes of owned chunks. */
async function readCappedResponseBytes(upstream, maxBytes) {
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await upstream.body?.cancel();
    } catch {
      /* no-op */
    }
    return null;
  }
  if (!upstream.body) return null;
  const chunks = [];
  let total = 0;
  // Every retained chunk is an OWNED copy: a chunk can be a small view over a
  // much larger backing ArrayBuffer, and keeping the view would retain that
  // whole allocation while the byte accounting only counted the view.
  const keep = (chunk) => {
    total += chunk.byteLength;
    if (total > maxBytes) return false;
    chunks.push(Buffer.from(chunk));
    return true;
  };
  if (typeof upstream.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of upstream.body) {
      if (!keep(chunk)) {
        try {
          await upstream.body.cancel();
        } catch {
          /* no-op */
        }
        return null;
      }
    }
    return Buffer.concat(chunks, total);
  }
  // No async iterator: stream through a reader so the cap still applies while
  // reading. A body that cannot be streamed at all is refused rather than
  // buffered uncapped — the helper's whole contract is the cap.
  const reader =
    typeof upstream.body.getReader === 'function'
      ? upstream.body.getReader()
      : null;
  if (!reader) return null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!keep(value)) {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
        return null;
      }
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

/**
 * Finds the first whole JPEG in a motion-JPEG stream as its bytes arrive.
 *
 * A part that declares a believable Content-Length is cut to it. Otherwise (or
 * when that length turns out wrong) the picture runs to the last end-of-image
 * marker before the next part delimiter: a JPEG can carry an embedded preview
 * with an end marker of its own, so the first marker is not proof the picture
 * is over.
 *
 * Work is linear in the bytes read: they are copied once into a buffer that
 * doubles, and each search resumes where the last one stopped. Joining and
 * rescanning everything on every chunk made a stream that never completes a
 * picture cost gigabytes of copying before the byte cap, on the proxy's one
 * thread.
 * @param {string} [boundary] The boundary parameter, leading dashes dropped.
 * @returns {{push: (chunk: Uint8Array) => Buffer|null}}
 */
export function createMotionJpegScanner(boundary = '') {
  // The body's delimiter is always two dashes and the boundary, whether or not
  // the operator also put dashes in the parameter itself.
  const delimiter = Buffer.from(
    boundary ? `--${boundary}` : '\r\n--',
    'latin1',
  );
  let buffer = Buffer.allocUnsafe(64 * 1024);
  let length = 0;
  let start = -1;
  let startSearchFrom = 0;
  let delimiterSearchFrom = 0;
  let declared = NaN;
  let declaredChecked = false;
  return {
    push(chunk) {
      if (length + chunk.byteLength > buffer.length) {
        const grown = Buffer.allocUnsafe(
          Math.max(buffer.length * 2, length + chunk.byteLength),
        );
        buffer.copy(grown, 0, 0, length);
        buffer = grown;
      }
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(
        buffer,
        length,
      );
      length += chunk.byteLength;
      const seen = buffer.subarray(0, length);
      if (start < 0) {
        start = seen.indexOf(JPEG_START, startSearchFrom);
        if (start < 0) {
          startSearchFrom = Math.max(0, length - (JPEG_START.length - 1));
          return null;
        }
        const partHeaders = seen
          .subarray(Math.max(0, start - 512), start)
          .toString('latin1');
        declared = Number(
          /content-length:\s*(\d+)\s*\r?\n/i.exec(partHeaders)?.[1],
        );
        delimiterSearchFrom = start;
      }
      if (
        !declaredChecked &&
        Number.isFinite(declared) &&
        declared > JPEG_START.length &&
        length >= start + declared
      ) {
        declaredChecked = true;
        // Some servers count the line break after the picture in that length.
        const cut = seen.subarray(start, start + declared);
        const end = cut.lastIndexOf(JPEG_END);
        if (end >= cut.length - 4)
          return Buffer.from(cut.subarray(0, end + JPEG_END.length));
      }
      // Looked for even while a declared length is still unmet: a delimiter
      // arriving first proves that length wrong, and waiting on it would run
      // the stream to the byte cap.
      const next = seen.indexOf(delimiter, delimiterSearchFrom);
      if (next < 0) {
        delimiterSearchFrom = Math.max(start, length - (delimiter.length - 1));
        return null;
      }
      const end = seen.subarray(start, next).lastIndexOf(JPEG_END);
      if (end < 0) {
        delimiterSearchFrom = next + 1;
        return null;
      }
      return Buffer.from(seen.subarray(start, start + end + JPEG_END.length));
    },
  };
}

/** The first whole JPEG in these bytes of a motion-JPEG stream, or null. */
export function firstJpegInMotionStream(bytes, boundary = '') {
  return createMotionJpegScanner(boundary).push(bytes);
}

/**
 * Read a motion-JPEG stream only until its first picture is whole, then hang
 * up. Some operators (Taiwan's freeway and highway bureaus, about 3,500
 * cameras) publish nothing but such a stream, so without this their cameras
 * have no still, and so no map thumbnail. Gives up at maxBytes.
 */
async function readFirstMotionJpeg(upstream, contentType, maxBytes) {
  if (
    !upstream.body ||
    typeof upstream.body[Symbol.asyncIterator] !== 'function'
  )
    return null;
  const boundary = (
    /boundary="?([^";]+)"?/i.exec(contentType)?.[1] || ''
  ).replace(/^-+/, '');
  const scanner = createMotionJpegScanner(boundary);
  let total = 0;
  let frame = null;
  try {
    for await (const chunk of upstream.body) {
      total += chunk.byteLength;
      if (total > maxBytes) break;
      frame = scanner.push(chunk);
      if (frame) break;
    }
  } catch {
    frame = null;
  }
  cancelQuietly(upstream);
  return frame;
}

/** Open registered media within a header deadline; leave timely live bodies running. */
export async function fetchCctvMediaUpstream(
  url,
  {
    headers = {},
    fetchImpl = fetch,
    timeoutMs = CCTV_MEDIA_FETCH_TIMEOUT_MS,
    signal: downstream = null,
  } = {},
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  // The client going away cancels the upstream request, not just the response
  // to it.
  const onDownstreamAbort = () => controller.abort();
  if (downstream?.aborted) controller.abort();
  else downstream?.addEventListener?.('abort', onDownstreamAbort);
  try {
    return await fetchImpl(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    downstream?.removeEventListener?.('abort', onDownstreamAbort);
  }
}

/** Error code for a connection refused because its address is not public. */
const NON_PUBLIC_ADDRESS = 'ERR_CCTV_NON_PUBLIC_ADDRESS';

const nonPublicAddressError = (message) =>
  Object.assign(new Error(message), { code: NON_PUBLIC_ADDRESS });

/**
 * A connect-time DNS lookup that answers only allowed (public) addresses: the
 * name is resolved once with every address, all of them must pass
 * `addressAllowed`, and the socket then connects to one of exactly those. A
 * name therefore cannot be re-pointed at a private address between the check
 * and the connection.
 */
function publicOnlyLookup(lookup, addressAllowed) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const settings =
      typeof options === 'number'
        ? { family: options }
        : options && typeof options === 'object'
          ? options
          : {};
    lookup(hostname, { ...settings, all: true }, (error, addresses) => {
      if (error) {
        done(error);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [];
      if (
        !list.length ||
        !list.every((entry) => addressAllowed(entry?.address))
      ) {
        done(
          nonPublicAddressError(
            `Refused ${hostname}: it resolves to a non-public address`,
          ),
        );
        return;
      }
      if (settings.all) done(null, list);
      else done(null, list[0].address, list[0].family);
    });
  };
}

/** Statuses a WHATWG Response must carry without a body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * A fetch() for stills on a host no catalogue vouches for (a Road511 lookup,
 * a page's og:image). It is node:http(s) whose connection goes only to a
 * checked public address (see publicOnlyLookup; an address literal is checked
 * directly), over its own socket rather than a pooled one another request
 * opened, and it never follows a redirect: a 3xx comes back as it is, for the
 * caller to check. Answers a WHATWG Response.
 *
 * @param {object} [options] - Test seams.
 * @param {typeof dns.lookup} [options.lookup=dns.lookup]
 * @param {(address: string) => boolean} [options.addressAllowed=isPublicAddress]
 * @returns {(url: string, init?: {headers?: object, signal?: AbortSignal}) => Promise<Response>}
 */
export function createPublicOnlyFetch({
  lookup = dns.lookup,
  addressAllowed = isPublicAddress,
} = {}) {
  const connectLookup = publicOnlyLookup(lookup, addressAllowed);
  return (input, { headers = {}, signal } = {}) =>
    new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(String(input));
      } catch (error) {
        reject(error);
        return;
      }
      const transport =
        target.protocol === 'https:'
          ? https
          : target.protocol === 'http:'
            ? http
            : null;
      if (!transport) {
        reject(new TypeError(`Refused ${target.protocol} URL`));
        return;
      }
      const literal = target.hostname.replace(/^\[(.*)\]$/, '$1');
      if (net.isIP(literal) && !addressAllowed(literal)) {
        reject(nonPublicAddressError(`Refused non-public address ${literal}`));
        return;
      }
      let request;
      try {
        request = transport.request(
          target,
          {
            method: 'GET',
            headers,
            signal,
            agent: false,
            lookup: connectLookup,
          },
          (response) => {
            try {
              const status = response.statusCode || 0;
              if (status < 200 || status > 599)
                throw new Error(`Upstream answered HTTP ${status}`);
              const responseHeaders = new Headers();
              const raw = response.rawHeaders || [];
              for (let i = 0; i + 1 < raw.length; i += 2) {
                try {
                  responseHeaders.append(raw[i], raw[i + 1]);
                } catch {
                  /* a header fetch would refuse is dropped */
                }
              }
              const nullBody = NULL_BODY_STATUSES.has(status);
              if (nullBody) response.resume();
              resolve(
                new Response(nullBody ? null : Readable.toWeb(response), {
                  status,
                  headers: responseHeaders,
                }),
              );
            } catch (error) {
              response.destroy();
              reject(error);
            }
          },
        );
      } catch (error) {
        reject(error);
        return;
      }
      request.on('error', reject);
      request.end();
    });
}

let sharedPublicOnlyFetch = null;
const publicOnlyFetch = () =>
  (sharedPublicOnlyFetch ||= createPublicOnlyFetch());

/** A redirect a caller must check before following: any 3xx, or fetch's
 * opaque form of one. */
const isRedirectResponse = (response) =>
  response?.type === 'opaqueredirect' ||
  response?.status === 0 ||
  (response?.status >= 300 && response?.status < 400);

const cancelQuietly = (response) => {
  try {
    void response?.body?.cancel?.()?.catch?.(() => {});
  } catch {
    /* already closed */
  }
};

/**
 * Hosts that refused `fetch` and then answered the node:https request. They are
 * asked that way first from then on (until it fails once), so a refusing
 * operator costs one wasted request per server run, not one per frame.
 */
const _refererHosts = new Set([
  // Measured to refuse fetch and answer node:https: asked that way from the
  // first frame, so a fresh server does not spend its first request on a 403.
  'www.quebec511.info',
  'snapshots.media.verkeerscentrum.be',
]);

/**
 * Warm connections for the node:https path: at most two per host, kept alive.
 *
 * Québec 511's firewall refuses most NEW connections and keeps serving one it
 * has already answered. Measured: five stills over one kept-alive connection
 * went 403, 200, 200, 200, 200 (30 to 50 ms each once warm); five stills each
 * on a connection of its own went 403, 200, 403, 403, 403. Node's default agent
 * opens a new connection for every concurrent request, which is the second
 * pattern. Two matches the per-host gate (CCTV_HOST_MAX_CONCURRENT), so every
 * request rides a warm connection. Idle sockets are unref'd by the agent and
 * never hold the process open.
 */
const STILL_AGENT_OPTIONS = Object.freeze({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 2,
  maxFreeSockets: 2,
});
const _stillAgents = {
  'https:': new https.Agent(STILL_AGENT_OPTIONS),
  'http:': new http.Agent(STILL_AGENT_OPTIONS),
};
/** A refused NEW connection is retried this many times, this far apart. */
const REFUSED_CONNECTION_RETRIES = 2;
const REFUSED_CONNECTION_RETRY_MS = 150;

/**
 * Fetch one still through node:https with a same-site `Referer`.
 *
 * Two kinds of operator refuse the ordinary fetch. Some guard their stills
 * against hotlinking and answer 403 unless the request names their own site as
 * the referrer. Others (Québec 511, 678 cameras) refuse Node's `fetch` client
 * outright, every time, whatever headers it carries, yet answer node:https and
 * curl over a connection they have warmed to (see STILL_AGENT_OPTIONS). This
 * path serves both. It sends only a User-Agent and a Referer (that same
 * firewall turned away some requests with more), follows no redirects, and
 * byte-caps the body.
 * @returns {Promise<{status:number,headers:Headers,body:Buffer|null,contentType:string}|null>}
 */
export function requestCctvImageWithReferer(
  url,
  { timeoutMs, maxBytes, signal } = {},
) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    const client = target.protocol === 'http:' ? http : https;
    const request = client.get(
      target,
      {
        headers: {
          'User-Agent': CCTV_PROXY_USER_AGENT,
          Referer: `${target.origin}/`,
        },
        timeout: timeoutMs,
        signal,
        agent: _stillAgents[target.protocol],
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            headers.set(
              name,
              Array.isArray(value) ? value.join(', ') : String(value),
            );
        }
        const contentType = headers.get('content-type') || '';
        const status = response.statusCode || 0;
        if (
          status < 200 ||
          status >= 300 ||
          !contentType.startsWith('image/')
        ) {
          response.resume();
          resolve({ status, headers, body: null, contentType });
          return;
        }
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            request.destroy();
            resolve({ status, headers, body: null, contentType });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status,
            headers,
            body: Buffer.concat(chunks),
            contentType,
          }),
        );
        response.on('error', () => resolve(null));
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

/**
 * Fetch one upstream CCTV image within the frame-refresh budget.
 *
 * A timeout is treated like every other upstream miss so the caller can
 * continue through the Street View and synthetic fallback chain. `fetchImpl`
 * and `timeoutMs` are injectable only to keep the timeout contract unit-testable.
 *
 * @param {string} url - Server-registered upstream image URL.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - Fetch implementation: fetch, or
 *   the public-only fetch when `allowUrl` is set.
 * @param {number} [options.timeoutMs=CCTV_FRAME_FETCH_TIMEOUT_MS] - Abort timeout.
 * @param {number} [options.maxBytes=CCTV_FRAME_MAX_BODY_BYTES] - Snapshot byte cap.
 * @param {(response: {status: number, headers: Headers}) => void} [options.onResponse] -
 *   Sees each upstream status and headers (for 429 / Retry-After handling)
 *   before the body is read. It never changes what this function returns.
 * @param {(href: string) => boolean} [options.allowUrl] - Set for a still on a
 *   host no catalogue vouches for. Each URL is then checked before it is
 *   requested, and redirects are followed by hand: at most
 *   CCTV_FRAME_MAX_REDIRECTS hops, every Location checked again.
 * @returns {Promise<{ok:true,body:Buffer,contentType:string}|null>}
 */
export async function fetchCctvImageFromUpstream(
  url,
  {
    fetchImpl,
    timeoutMs = CCTV_FRAME_FETCH_TIMEOUT_MS,
    maxBytes = CCTV_FRAME_MAX_BODY_BYTES,
    onResponse,
    allowUrl,
    refererRequest,
    secondAttempt = true,
  } = {},
) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const guarded = typeof allowUrl === 'function';
  // The node:https second attempt is for hosts a catalogue vouches for, and only
  // on the real network (or when a test supplies its own requester). Guarded
  // URLs never take it: it has no public-address check of its own.
  // `secondAttempt: false` switches it off for a host with a request budget:
  // there every extra request is one the budget never counted.
  const viaReferer =
    guarded || !secondAttempt || (fetchImpl && !refererRequest)
      ? null
      : refererRequest || requestCctvImageWithReferer;
  const doFetch = fetchImpl || (guarded ? publicOnlyFetch() : fetch);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(
      new DOMException('CCTV upstream frame fetch timed out', 'TimeoutError'),
    );
  }, timeoutMs);
  const refused = (status) => status === 401 || status === 403;
  /**
   * One still through node:https. A refusal is nearly always a NEW connection
   * being turned away (see STILL_AGENT_OPTIONS), so it is asked again, briefly,
   * until a connection sticks; after that every request reuses it.
   * @returns {Promise<{image: object|null, status: number}>}
   */
  const askHttps = async (host) => {
    const ask = () =>
      viaReferer(url, { timeoutMs, maxBytes, signal: controller.signal });
    let answer = await ask();
    for (
      let retry = 0;
      retry < REFUSED_CONNECTION_RETRIES &&
      answer &&
      !answer.body &&
      refused(answer.status);
      retry += 1
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, REFUSED_CONNECTION_RETRY_MS),
      );
      if (controller.signal.aborted) return { image: null, status: 0 };
      answer = await ask();
    }
    if (!answer) return { image: null, status: 0 };
    if (typeof onResponse === 'function') {
      try {
        onResponse({ status: answer.status, headers: answer.headers });
      } catch {
        /* an observer never breaks the fetch */
      }
    }
    if (!answer.body) return { image: null, status: answer.status };
    _refererHosts.add(host);
    return {
      image: { ok: true, body: answer.body, contentType: answer.contentType },
      status: answer.status,
    };
  };
  try {
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      host = '';
    }
    // A host already known to refuse fetch is asked the other way first: one
    // request, not a refused one plus a retry.
    let httpsRefused = false;
    if (viaReferer && _refererHosts.has(host)) {
      const direct = await askHttps(host);
      if (direct.image) return direct.image;
      // Only a refusal says anything about the HOST. A 404, a timeout, a 429
      // or a non-image answer is about this camera or this moment: the miss
      // stands, the host stays remembered, and nothing more is sent (fetch is
      // known to be refused here, and after a 429 more requests are the last
      // thing the operator wants).
      if (!refused(direct.status)) return null;
      _refererHosts.delete(host);
      httpsRefused = true;
    }
    let target = url;
    let upstream;
    for (let hop = 0; ; hop += 1) {
      if (guarded && !allowUrl(target)) return null;
      upstream = await doFetch(target, {
        headers: { 'User-Agent': CCTV_PROXY_USER_AGENT },
        signal: controller.signal,
        ...(guarded ? { redirect: 'manual' } : {}),
      });
      if (typeof onResponse === 'function') {
        try {
          onResponse({ status: upstream.status, headers: upstream.headers });
        } catch {
          /* an observer never breaks the fetch */
        }
      }
      if (!guarded || !isRedirectResponse(upstream)) break;
      const location = upstream.headers?.get?.('location') || '';
      cancelQuietly(upstream);
      if (!location || hop >= CCTV_FRAME_MAX_REDIRECTS) return null;
      target = new URL(location, target).href;
    }
    const contentType = upstream.headers.get('content-type') || '';
    if (viaReferer && (upstream.status === 401 || upstream.status === 403)) {
      // Refused outright: hotlink protection, or a firewall that turns away
      // Node's fetch client but not node:https.
      cancelQuietly(upstream);
      // Both ways refused already: that is the answer, not a reason to ask again.
      if (httpsRefused) return null;
      return (await askHttps(host)).image;
    }
    if (upstream.ok && /^multipart\/x-mixed-replace/i.test(contentType)) {
      // A camera published only as a motion-JPEG stream: its first picture is
      // the still.
      const frame = await readFirstMotionJpeg(upstream, contentType, maxBytes);
      return frame
        ? { ok: true, body: frame, contentType: 'image/jpeg' }
        : null;
    }
    if (!upstream.ok || !contentType.startsWith('image/')) {
      controller.abort();
      return null;
    }
    const body = await readCappedResponseBytes(upstream, maxBytes);
    if (!body) return null;
    return { ok: true, body, contentType };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
  }
}
