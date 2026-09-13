import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/**
 * Encode 8-bit RGBA pixels (row 0 at the top) as a PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba width * height * 4 bytes.
 * @returns {Buffer}
 */
export function encodeRgbaPng(width, height, rgba) {
  if (rgba.length !== width * height * 4)
    throw new Error('RGBA buffer does not match the image size');
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), row + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
