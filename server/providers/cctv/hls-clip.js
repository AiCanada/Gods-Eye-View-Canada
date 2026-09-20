/**
 * A short MP4 clip cut from a live HLS stream.
 *
 * Some operators publish nothing but HLS video (511NJ: 808 cameras, no still).
 * The application plays plain MP4 everywhere already (monitor plane, panel),
 * and has no HLS player. Where the stream is fragmented MP4 (an `EXT-X-MAP`
 * init segment plus `.mp4`/`.m4s` media segments) the last few seconds can be
 * turned into an ordinary fragmented MP4 by simple concatenation: init segment,
 * then the newest media segments. No decoding, no new dependency.
 *
 * A stream of MPEG-TS segments cannot be handled this way (a browser does not
 * play raw TS), and yields null.
 *
 * Every address fetched is checked by the caller's `allowUrl` first, and must
 * stay on the playlist's own host: a playlist is remote content and must not
 * be able to point this server anywhere else.
 */

/** Newest media segments stitched into one clip (2 s each on 511NJ). */
export const HLS_CLIP_SEGMENTS = 3;
export const HLS_CLIP_MAX_BYTES = 8 * 1024 * 1024;
const PLAYLIST_MAX_BYTES = 256 * 1024;

/**
 * Parse one playlist. Pure.
 * @param {string} text
 * @param {string} baseUrl The playlist's own address.
 * @returns {{variants: string[], initUrl: string, segments: string[]}}
 */
export function parseHlsPlaylist(text, baseUrl) {
  const out = { variants: [], initUrl: '', segments: [] };
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (lines[0] !== '#EXTM3U') return out;
  const resolve = (uri) => {
    try {
      return new URL(uri, baseUrl).href;
    } catch {
      return '';
    }
  };
  let expectVariant = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      expectVariant = true;
      continue;
    }
    if (line.startsWith('#EXT-X-MAP')) {
      const uri = /URI="([^"]+)"/i.exec(line)?.[1];
      if (uri) out.initUrl = resolve(uri);
      continue;
    }
    if (line.startsWith('#')) continue;
    const url = resolve(line);
    if (!url) continue;
    if (expectVariant) {
      out.variants.push(url);
      expectVariant = false;
    } else {
      out.segments.push(url);
    }
  }
  return out;
}

async function readCapped(response, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      try {
        await response.body.cancel();
      } catch {
        /* already closed */
      }
      return null;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Build a clip from a live HLS playlist.
 * @param {string} playlistUrl
 * @param {object} options
 * @param {typeof fetch} options.fetchImpl The public-only fetch.
 * @param {(href: string) => boolean} options.allowUrl
 * @param {Record<string, string>} [options.headers]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.segments]
 * @param {number} [options.maxBytes]
 * @returns {Promise<{body: Buffer, contentType: 'video/mp4'}|null>}
 */
export async function fetchHlsClip(
  playlistUrl,
  {
    fetchImpl,
    allowUrl,
    headers = {},
    signal,
    segments = HLS_CLIP_SEGMENTS,
    maxBytes = HLS_CLIP_MAX_BYTES,
  } = {},
) {
  let host = '';
  try {
    host = new URL(playlistUrl).host;
  } catch {
    return null;
  }
  const permitted = (href) => {
    try {
      return (
        new URL(href).host === host &&
        (typeof allowUrl !== 'function' || allowUrl(href))
      );
    } catch {
      return false;
    }
  };
  const get = async (href, cap) => {
    if (!permitted(href)) return null;
    const response = await fetchImpl(href, {
      headers,
      signal,
      redirect: 'manual',
    });
    if (!response.ok || !response.body) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      return null;
    }
    return readCapped(response, cap);
  };
  try {
    const first = await get(playlistUrl, PLAYLIST_MAX_BYTES);
    if (!first) return null;
    let playlist = parseHlsPlaylist(first.toString('utf8'), playlistUrl);
    if (playlist.variants.length) {
      const variantUrl = playlist.variants[0];
      const variant = await get(variantUrl, PLAYLIST_MAX_BYTES);
      if (!variant) return null;
      playlist = parseHlsPlaylist(variant.toString('utf8'), variantUrl);
    }
    // Fragmented MP4 only: an init segment, then media segments.
    if (!playlist.initUrl || !playlist.segments.length) return null;
    const wanted = playlist.segments.slice(-Math.max(1, segments));
    const parts = [await get(playlist.initUrl, maxBytes)];
    if (!parts[0]) return null;
    let total = parts[0].length;
    for (const url of wanted) {
      const part = await get(url, maxBytes - total);
      // A segment that rolled off the live window is skipped, not fatal.
      if (!part) continue;
      parts.push(part);
      total += part.length;
    }
    if (parts.length < 2) return null;
    return { body: Buffer.concat(parts, total), contentType: 'video/mp4' };
  } catch {
    return null;
  }
}

/**
 * Serve a buffer with byte-range support (a <video> asks for ranges, and needs
 * them to loop and seek).
 * @returns {{status: number, headers: Record<string, string>, body: Buffer}}
 */
export function rangedBufferResponse(body, contentType, rangeHeader) {
  const size = body.length;
  const base = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) {
    return {
      status: 200,
      headers: { ...base, 'Content-Length': String(size) },
      body,
    };
  }
  let start =
    match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  let end =
    match[1] === '' || match[2] === ''
      ? size - 1
      : Math.min(size - 1, Number(match[2]));
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end ||
    start >= size
  ) {
    return {
      status: 416,
      headers: {
        ...base,
        'Content-Range': `bytes */${size}`,
        'Content-Length': '0',
      },
      body: Buffer.alloc(0),
    };
  }
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  const slice = body.subarray(start, end + 1);
  return {
    status: 206,
    headers: {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(slice.length),
    },
    body: slice,
  };
}
