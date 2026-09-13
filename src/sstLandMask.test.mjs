import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { encodeRgbaPng } from '../server/providers/sst/png.js';
import {
  OSM_LAND_MASK_TEMPLATE,
  createLandMaskSource,
  decodePngAlpha,
  landMaskZoom,
  mercatorPixel,
  tilesForRectangle,
} from '../server/providers/sst/landmask.js';
import { gridIndexRange, normalizeBbox } from '../server/providers/sst/opendap.js';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
};

/** RGBA PNG whose scanlines use the given filter types, forward-applied. */
function filteredPng(width, height, rgba, filters, colourType = 6) {
  const channels = 4;
  const stride = width * channels;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const line = rgba.subarray(y * stride, (y + 1) * stride);
    const up = y ? rgba.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    const filter = filters[y % filters.length];
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels] : 0;
      const upLeft = i >= channels ? up[i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up[i];
      else if (filter === 3) predictor = (left + up[i]) >> 1;
      else if (filter === 4) {
        const p = left + up[i] - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up[i]);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up[i] : upLeft;
      }
      out[i + 1] = (line[i] - predictor) & 255;
    }
    rows.push(out);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colourType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('tile maths matches GIBS: the Bay of Fundy is zoom-7 tile 40/46', () => {
  const p = mercatorPixel(45, -66, 7);
  assert.equal(Math.floor(p.x / 256), 40);
  assert.equal(Math.floor(p.y / 256), 46);
  const fundy = normalizeBbox('-71,41,-63,47');
  assert.equal(landMaskZoom(fundy), 7);
  assert.ok(tilesForRectangle(fundy, 7).length <= 24);
  const globe = normalizeBbox('-180,-90,180,90');
  const zoom = landMaskZoom(globe);
  assert.ok(zoom < 7);
  assert.ok(tilesForRectangle(globe, zoom).length <= 24);
});

test('PNG alpha decoding reverses every scanline filter', () => {
  const width = 7;
  const height = 10;
  const rgba = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 37 + (i >> 3) * 11) & 255);
  const decoded = decodePngAlpha(filteredPng(width, height, rgba, [0, 1, 2, 3, 4]));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  for (let i = 0; i < width * height; i += 1) assert.equal(decoded.alpha[i], rgba[i * 4 + 3]);
  const plain = decodePngAlpha(encodeRgbaPng(2, 1, Uint8Array.from([1, 2, 3, 0, 4, 5, 6, 200])));
  assert.deepEqual([...plain.alpha], [0, 200]);
  assert.throws(() => decodePngAlpha(filteredPng(1, 1, new Uint8Array(4), [0], 3)), /Unsupported/);
  assert.throws(() => decodePngAlpha(Buffer.from('not a png')), /not a PNG/);
});

test('land cells follow the mask; a missing tile is open ocean; tiles are cached', async () => {
  // Zoom-7 tile 40/45 with its western half land; every other tile is absent.
  const tileRgba = new Uint8Array(256 * 256 * 4);
  for (let y = 0; y < 256; y += 1) {
    for (let x = 0; x < 128; x += 1) tileRgba[(y * 256 + x) * 4 + 3] = 255;
  }
  const tilePng = encodeRgbaPng(256, 256, tileRgba);
  const requested = [];
  const landCells = createLandMaskSource({
    fetchImpl: async (url) => {
      requested.push(url);
      if (url === OSM_LAND_MASK_TEMPLATE.replace('{z}', 7).replace('{y}', 45).replace('{x}', 40)) {
        return { ok: true, status: 200, arrayBuffer: async () => tilePng };
      }
      return { ok: false, status: 404, body: null };
    },
  });
  // Inside tile 40/45: longitudes -67.5..-64.6875 (midpoint -66.09375),
  // latitudes 45.10..47.08 N.
  const range = gridIndexRange(normalizeBbox('-67.4,45.2,-64.8,46.7'));
  const result = await landCells(range);
  assert.equal(result.zoom, 7);
  const middleRow = Math.floor(range.rows / 2);
  const lonOf = (c) => -180 + (range.col0 + c * range.stride + range.stride / 2) / 24;
  for (let c = 0; c < range.cols; c += 1) {
    const land = result.land[middleRow * range.cols + c] === 1;
    if (lonOf(c) < -66.2) assert.ok(land, `cell at ${lonOf(c).toFixed(3)} is land`);
    if (lonOf(c) > -66.0) assert.ok(!land, `cell at ${lonOf(c).toFixed(3)} is water`);
  }
  assert.ok(result.landCells > 0 && result.landCells < range.rows * range.cols);

  const offshore = await landCells(gridIndexRange(normalizeBbox('-51,34,-49,36')));
  assert.equal(offshore.landCells, 0, 'GIBS omits all-ocean tiles');

  const before = requested.length;
  await landCells(range);
  assert.equal(requested.length, before, 'mask tiles are cached');
});
