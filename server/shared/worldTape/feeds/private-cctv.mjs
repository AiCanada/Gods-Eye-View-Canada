/**
 * World tape feed: stills from the owner's own home and business cameras,
 * only through the existing private-camera routes (/api/private-cams/sources
 * and /api/private-cams/frame/<id>, which hold the logins, the relay's
 * pictures and the per-camera failure backoff); no camera is ever asked
 * directly. Each camera at most once a minute (the layer's own refresh; the
 * relay itself accepts a picture at most every 2 seconds), and a picture is
 * stored only when it changed.
 */
import {
  MINUTE,
  discard,
  fileName,
  header,
  imageExt,
  round,
  sha1,
  text,
  timeTag,
} from './_util.mjs';

const FRAME_TYPES = /^image\/(jpeg|pjpeg|png|webp|gif)$/;

export default {
  id: 'private-cctv',
  label: 'Private cameras',
  layers: ['private-cctv'],
  kind: 'feed',
  class: 'personal',
  licence: "The owner's own home and business cameras",
  cadenceMs: MINUTE,
  phase: 2,
  bytesPerDay: 300e6,
  async poll({ fetch, state, now, signal }) {
    if (typeof fetch !== 'function')
      throw new Error('Private cameras need the app API');
    const listed = await fetch('/api/private-cams/sources', {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!listed.ok) throw new Error(`Private cameras HTTP ${listed.status}`);
    const sources = (await listed.json())?.sources;
    state.cameras ??= new Map(); // id → { sha, status }
    const t = now();
    const files = [];
    const records = [];
    const ids = new Set();
    for (const camera of Array.isArray(sources) ? sources : []) {
      const id = text(camera?.id, 200);
      if (!id) continue;
      ids.add(id);
      const entry = state.cameras.get(id) || { sha: null, status: null };
      state.cameras.set(id, entry);
      const note = (status) => {
        if (entry.status === status) return;
        entry.status = status;
        records.push({ camera: id, status });
      };
      let response;
      try {
        response = await fetch(
          `/api/private-cams/frame/${encodeURIComponent(id)}`,
          { signal },
        );
      } catch {
        note('error');
        continue;
      }
      const type = String(header(response, 'content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const via = header(response, 'x-private-camera');
      if (!response.ok || !FRAME_TYPES.test(type) || via === 'offline') {
        await discard(response);
        note(response.ok ? 'offline' : `http-${response.status}`);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) {
        note('empty');
        continue;
      }
      const digest = sha1(bytes);
      if (digest === entry.sha) {
        note('unchanged');
        continue;
      }
      entry.sha = digest;
      entry.status = 'frame';
      files.push({
        name: fileName([timeTag(t), id], imageExt(type)),
        bytes,
        record: {
          camera: id,
          name: text(camera.name, 120),
          site: text(camera.city, 120),
          provider: text(camera.provider, 80),
          lat: round(camera.lat, 6),
          lon: round(camera.lon, 6),
          heading: round(camera.headingDeg, 0),
          via: via || null,
          contentType: type,
          sha1: digest,
        },
      });
    }
    for (const id of state.cameras.keys())
      if (!ids.has(id)) state.cameras.delete(id);
    return { files, records };
  },
};
