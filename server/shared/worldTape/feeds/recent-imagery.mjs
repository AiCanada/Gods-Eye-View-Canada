/**
 * World tape feed: the most recent clear satellite image of each area (NASA
 * HLS Sentinel-2/Landsat at 30 m, else the VIIRS daily overview), through
 * services.imagery, the source the Recent Imagery layer and its tool use:
 * one catalog query and at most one image per area a day, recorded when the
 * best image is a new one.
 */
import {
  DAY,
  areaTag,
  bboxArray,
  boxAround,
  fileName,
  imageExt,
  requireAreas,
} from './_util.mjs';

const DEFAULT_RADIUS_KM = 25;
const MAX_RADIUS_KM = 500;
const IMAGE_WIDTH = 1024;

export default {
  id: 'recent-imagery',
  label: 'Recent satellite imagery (NASA GIBS)',
  layers: ['recent-imagery'],
  kind: 'feed',
  class: 'open',
  licence:
    "NASA GIBS / Worldview snapshots of HLS (Sentinel-2, Landsat 8/9) and VIIRS (U.S. public domain; acknowledgement of NASA's GIBS requested)",
  cadenceMs: DAY,
  phase: 1,
  bytesPerDay: 2e6,
  async poll({ services, areas, state, signal }) {
    const list = requireAreas(areas, { max: 16 });
    state.last ??= new Map(); // area key → product|day recorded
    const files = [];
    let answered = 0;
    let failure = null;
    for (const area of list) {
      const radius = Math.min(
        MAX_RADIUS_KM,
        Math.max(1, area.radiusKm ?? DEFAULT_RADIUS_KM),
      );
      const box = boxAround(area, radius);
      if (!(box.east > box.west) || !(box.north > box.south)) continue;
      try {
        const { candidate, reason } = await services.imagery.latest({
          box,
          signal,
        });
        answered += 1;
        if (!candidate) continue;
        const sig = `${candidate.product}|${candidate.day}`;
        if (state.last.get(area.key) === sig) continue;
        const height = Math.max(
          64,
          Math.min(
            1024,
            Math.round(
              (IMAGE_WIDTH * (box.north - box.south)) / (box.east - box.west),
            ),
          ),
        );
        const image = await services.imagery.getSnapshot({
          product: candidate.product,
          day: candidate.day,
          box,
          width: IMAGE_WIDTH,
          height,
          signal,
        });
        if (!/^image\/(png|jpeg)$/.test(image?.contentType || '')) continue;
        state.last.set(area.key, sig);
        files.push({
          name: fileName(
            [areaTag(area), candidate.product, candidate.day],
            imageExt(image.contentType),
          ),
          bytes: image.bytes,
          record: {
            area: area.name,
            product: candidate.product,
            day: candidate.day,
            quality: reason ?? null,
            cloud: candidate.cloud ?? null,
            coverage: candidate.coverage ?? null,
            bbox: bboxArray(box),
            width: IMAGE_WIDTH,
            height,
          },
        });
      } catch (error) {
        failure ??= error;
      }
    }
    if (!answered && failure) throw failure;
    return { files };
  },
};
