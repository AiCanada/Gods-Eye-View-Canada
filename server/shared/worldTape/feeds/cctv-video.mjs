/**
 * Short CCTV clips beside the stills. Only an HLS camera, only through the
 * app's own frame route, and only a fragmented-MP4 clip that route already
 * knows how to cut. A school camera is never requested.
 */
import { isSchoolCamera } from '../../../providers/cctv/school-filter.js';
import {
  HOUR,
  fileName,
  requireAreas,
  round,
  text,
  timeTag,
} from './_util.mjs';
import { nearestCameras } from './cctv.mjs';

const MAX_CLIPS = 20;
const IN_FLIGHT = 2;

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length) await fn(queue.shift());
    },
  );
  await Promise.all(workers);
}

export default {
  id: 'cctv-video',
  label: 'Public cameras (video)',
  layers: ['cctv'],
  kind: 'feed',
  class: 'unclear',
  licence:
    'Per camera operator (each clip names its operator licence). Fragmented MP4 only.',
  cadenceMs: 5 * 60 * 1000,
  phase: 2,
  bytesPerDay: 0.4e9,
  async poll({ services, fetch, areas, state, now, signal }) {
    const list = requireAreas(areas);
    const t = now();
    state.lastClip ??= new Map();
    const cameras = [];
    for (const area of list) {
      let payload;
      try {
        payload = await services.cctv.getCatalog({
          lat: area.lat,
          lon: area.lon,
          radiusKm: 50,
          signal,
        });
      } catch {
        continue;
      }
      for (const { camera, km } of nearestCameras(payload?.sources, area)) {
        if (isSchoolCamera(camera)) continue;
        const playlist = String(camera.videoUrl || '');
        const hls = camera.feedType === 'hls' || /\.m3u8(\?|$)/i.test(playlist);
        if (!hls || !playlist) continue;
        if ((state.lastClip.get(camera.id) || 0) + HOUR > t) continue;
        cameras.push({ camera, area: area.name, km });
        if (cameras.length >= MAX_CLIPS) break;
      }
      if (cameras.length >= MAX_CLIPS) break;
    }
    const files = [];
    await mapLimit(cameras, IN_FLIGHT, async ({ camera, area, km }) => {
      if (typeof fetch !== 'function') return;
      const url = `/api/cctv/frame/${encodeURIComponent(camera.id)}?clip=${Math.floor(t / HOUR)}`;
      let response;
      try {
        response = await fetch(url, { cache: 'no-store', signal });
      } catch {
        return;
      }
      const type = String(response.headers?.get?.('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!response.ok || type !== 'video/mp4') {
        try {
          await response.body?.cancel?.();
        } catch {
          /* closed */
        }
        return;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) return;
      state.lastClip.set(camera.id, t);
      files.push({
        name: fileName([timeTag(t), camera.id], 'mp4'),
        bytes,
        record: {
          camera: camera.id,
          name: text(camera.name),
          lat: round(camera.lat, 6),
          lon: round(camera.lon, 6),
          area,
          km: round(km, 2),
          contentType: 'video/mp4',
          operatorLicence: text(camera.license, 240),
        },
      });
    });
    return { files };
  },
};
