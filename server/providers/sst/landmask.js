import { inflateSync } from 'node:zlib';

/**
 * Ocean-only mask for Level-3 SST from NASA GIBS `OSM_Land_Mask` tiles.
 *
 * The tiles are OpenStreetMap land rasterised in Web Mercator: land pixels are
 * opaque grey, water is transparent, and inland lakes count as land, which is
 * exactly what keeps lake and land-edge SST out of front detection. GIBS
 * omits tiles that are entirely ocean, so a 404 means "all water".
 */

export const OSM_LAND_MASK_TEMPLATE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/OSM_Land_Mask/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png';

const TILE_SIZE = 256;
const MAX_ZOOM = 7;
const MIN_ZOOM = 1;
/** Most mask tiles fetched for one view; wide views use a coarser zoom. */
const MAX_TILES = 24;
const MERCATOR_MAX_LAT = 85.0511;
/** Antialiased coast pixels above half opacity count as land. */
const LAND_ALPHA = 128;
/** Land does not move: keep decoded tiles for a week. */
const TILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TILE_CACHE_ENTRIES = 256;
const TILE_TIMEOUT_MS = 20 * 1000;
const TILE_MAX_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Global Web Mercator pixel position of a point at a zoom. */
export function mercatorPixel(lat, lon, zoom) {
  const size = 2 ** zoom * TILE_SIZE;
  const phi =
    (Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) * Math.PI) /
    180;
  return {
    x: ((lon + 180) / 360) * size,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * size,
  };
}

/** Mask tiles covering a degrees rectangle at a zoom. */
export function tilesForRectangle(rectangle, zoom) {
  const count = 2 ** zoom;
  const clampTile = (value) => Math.max(0, Math.min(count - 1, value));
  const northWest = mercatorPixel(rectangle.north, rectangle.west, zoom);
  const southEast = mercatorPixel(rectangle.south, rectangle.east, zoom);
  const x0 = clampTile(Math.floor(northWest.x / TILE_SIZE));
  const x1 = clampTile(Math.floor((southEast.x - 1e-6) / TILE_SIZE));
  const y0 = clampTile(Math.floor(northWest.y / TILE_SIZE));
  const y1 = clampTile(Math.floor((southEast.y - 1e-6) / TILE_SIZE));
  const tiles = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) tiles.push({ x, y });
  }
  return tiles;
}

/** Deepest zoom (at most 7) whose tiles for the rectangle stay within budget. */
export function landMaskZoom(rectangle) {
  for (let zoom = MAX_ZOOM; zoom > MIN_ZOOM; zoom -= 1) {
    if (tilesForRectangle(rectangle, zoom).length <= MAX_TILES) return zoom;
  }
  return MIN_ZOOM;
}

/**
 * Decode the alpha channel of an 8-bit, non-interlaced RGBA or grey+alpha PNG,
 * reversing all five scanline filters.
 *
 * @returns {{width: number, height: number, alpha: Uint8Array}}
 */
export function decodePngAlpha(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new Error('Land mask tile is not a PNG');
  let offset = 8;
  let header = null;
  const data = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header) throw new Error('Land mask tile has no header');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8];
  const colourType = header[9];
  const interlace = header[12];
  const channels = colourType === 6 ? 4 : colourType === 4 ? 2 : 0;
  if (depth !== 8 || !channels || interlace !== 0) {
    throw new Error(
      `Unsupported land mask PNG (depth ${depth}, colour type ${colourType}, interlace ${interlace})`,
    );
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height)
    throw new Error('Land mask tile is truncated');
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let value = raw[start + 1 + i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`Land mask tile uses unknown filter ${filter}`);
      }
      current[i] = value & 255;
    }
    for (let x = 0; x < width; x += 1) {
      alpha[y * width + x] = current[x * channels + channels - 1];
    }
    previous.set(current);
  }
  return { width, height, alpha };
}

/**
 * Build the cached land-mask source. `landCells(range)` marks every Level-3
 * cell in a grid range that touches land: the cell centre and four points a
 * quarter cell out are sampled, so a cell partly over the coast counts as land.
 */
export function createLandMaskSource({
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
} = {}) {
  const tiles = new Map();

  const loadTile = (zoom, x, y) => {
    const key = `${zoom}/${x}/${y}`;
    const hit = tiles.get(key);
    if (hit && now() - hit.at <= TILE_TTL_MS) {
      tiles.delete(key);
      tiles.set(key, hit);
      return hit.promise;
    }
    const promise = (async () => {
      const url = OSM_LAND_MASK_TEMPLATE.replace('{z}', zoom)
        .replace('{y}', y)
        .replace('{x}', x);
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': 'gods-eye-view-sst/1.0' },
        signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
      });
      if (response.status === 404) {
        try {
          await response.body?.cancel();
        } catch {
          /* already closed */
        }
        return null;
      }
      if (!response.ok)
        throw new Error(`Land mask tile HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > TILE_MAX_BYTES)
        throw new Error('Land mask tile is too large');
      const tile = decodePngAlpha(bytes);
      if (tile.width !== TILE_SIZE || tile.height !== TILE_SIZE)
        throw new Error('Land mask tile has an unexpected size');
      return tile.alpha;
    })();
    tiles.set(key, { at: now(), promise });
    promise.catch(() => tiles.delete(key));
    while (tiles.size > TILE_CACHE_ENTRIES)
      tiles.delete(tiles.keys().next().value);
    return promise;
  };

  return async function landCells(range) {
    const zoom = landMaskZoom(range.rectangle);
    const needed = tilesForRectangle(range.rectangle, zoom);
    const loaded = new Map(
      await Promise.all(
        needed.map(async ({ x, y }) => [
          `${x}/${y}`,
          await loadTile(zoom, x, y),
        ]),
      ),
    );
    const isLand = (lat, lon) => {
      if (Math.abs(lat) > MERCATOR_MAX_LAT) return false;
      const pixel = mercatorPixel(lat, lon, zoom);
      const tileX = Math.floor(pixel.x / TILE_SIZE);
      const tileY = Math.floor(pixel.y / TILE_SIZE);
      const alpha = loaded.get(`${tileX}/${tileY}`);
      if (!alpha) return false;
      const px = Math.min(
        TILE_SIZE - 1,
        Math.max(0, Math.floor(pixel.x - tileX * TILE_SIZE)),
      );
      const py = Math.min(
        TILE_SIZE - 1,
        Math.max(0, Math.floor(pixel.y - tileY * TILE_SIZE)),
      );
      return alpha[py * TILE_SIZE + px] >= LAND_ALPHA;
    };

    const { rows, cols, stride, row0, col0 } = range;
    const cellDegrees = stride / 24;
    const quarter = cellDegrees / 4;
    const land = new Uint8Array(rows * cols);
    let count = 0;
    for (let r = 0; r < rows; r += 1) {
      const lat = 90 - (row0 + r * stride + stride / 2) / 24;
      for (let c = 0; c < cols; c += 1) {
        const lon = -180 + (col0 + c * stride + stride / 2) / 24;
        if (
          isLand(lat, lon) ||
          isLand(lat + quarter, lon + quarter) ||
          isLand(lat + quarter, lon - quarter) ||
          isLand(lat - quarter, lon + quarter) ||
          isLand(lat - quarter, lon - quarter)
        ) {
          land[r * cols + c] = 1;
          count += 1;
        }
      }
    }
    return { land, landCells: count, zoom, tiles: needed.length };
  };
}
