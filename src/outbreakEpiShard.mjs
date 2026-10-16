/**
 * Byte encoders for world-model datasets (owner request 2026-10-13): numpy
 * `.npy` arrays and ustar tar members, so an episode becomes a WebDataset
 * sample (`<key>.json` plus `<key>.<array>.npy`) that Python reads with the
 * standard tarfile module and numpy. docs/WORLD-MODEL-DATA.md is the
 * format. Pure: no DOM, no Node; the streaming and gzip are in
 * server/shared/outbreakDatasetWriter.mjs.
 */

const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** numpy dtype strings by typed array. */
const DTYPES = new Map([
  [Float64Array, '<f8'],
  [Float32Array, '<f4'],
  [Int32Array, '<i4'],
  [Uint32Array, '<u4'],
  [Int16Array, '<i2'],
  [Uint16Array, '<u2'],
  [Uint8Array, '|u1'],
  [Int8Array, '|i1'],
]);
const ARRAYS = new Map([...DTYPES].map(([type, descr]) => [descr, type]));

const ascii = (text) => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};
const utf8 = (text) => new TextEncoder().encode(text);

/** A typed array as `.npy` bytes (version 1.0, C order). */
export function npyBytes(data, shape = [data.length]) {
  if (!LITTLE) throw new Error('npy: big-endian hosts are not supported');
  const descr = DTYPES.get(data.constructor);
  if (!descr) throw new Error(`npy: no dtype for ${data.constructor.name}`);
  const count = shape.reduce((p, x) => p * x, 1);
  if (count !== data.length)
    throw new Error(`npy: shape ${shape} does not hold ${data.length} values`);
  const tuple = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${tuple}, }`;
  // Magic (6) + version (2) + length (2) + header + '\n', to 64 bytes.
  const total = 10 + header.length + 1;
  header += ' '.repeat((64 - (total % 64)) % 64) + '\n';
  const out = new Uint8Array(10 + header.length + data.byteLength);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
  out[8] = header.length & 0xff;
  out[9] = header.length >> 8;
  out.set(ascii(header), 10);
  out.set(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    10 + header.length,
  );
  return out;
}

/** `.npy` bytes back to `{ data, shape }` (tests and Node readers). */
export function parseNpy(bytes) {
  if (bytes[0] !== 0x93 || bytes[1] !== 0x4e) throw new Error('npy: no magic');
  const length = bytes[8] | (bytes[9] << 8);
  const header = new TextDecoder().decode(bytes.subarray(10, 10 + length));
  const descr = /'descr': '([^']+)'/.exec(header)?.[1];
  const shapeText = /'shape': \(([^)]*)\)/.exec(header)?.[1] ?? '';
  const shape = shapeText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const Type = ARRAYS.get(descr);
  if (!Type) throw new Error(`npy: unknown dtype ${descr}`);
  const start = 10 + length;
  const copy = bytes.slice(start);
  return {
    data: new Type(copy.buffer, 0, copy.byteLength / Type.BYTES_PER_ELEMENT),
    shape,
  };
}

const octal = (value, width) =>
  value.toString(8).padStart(width - 1, '0') + '\0';

/**
 * One ustar member: a 512-byte header, the bytes, zero padding to 512.
 * `mtime` is fixed (0 by default) so the same episode always gives the same
 * bytes.
 */
export function tarMember(name, bytes, mtime = 0) {
  let base = name;
  let prefix = '';
  if (utf8(base).length > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || utf8(name.slice(cut + 1)).length > 100)
      throw new Error(`tar: name too long: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const header = new Uint8Array(512);
  header.set(utf8(base), 0);
  header.set(ascii(octal(0o644, 8)), 100);
  header.set(ascii(octal(0, 8)), 108);
  header.set(ascii(octal(0, 8)), 116);
  header.set(ascii(octal(bytes.length, 12)), 124);
  header.set(ascii(octal(mtime, 12)), 136);
  header.fill(0x20, 148, 156); // checksum counted as spaces
  header[156] = 0x30; // regular file
  header.set(ascii('ustar\0'), 257);
  header.set(ascii('00'), 263);
  if (prefix) header.set(utf8(prefix), 345);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  header.set(ascii(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  const padded = Math.ceil(bytes.length / 512) * 512;
  const out = new Uint8Array(512 + padded);
  out.set(header, 0);
  out.set(bytes, 512);
  return out;
}

/** The two zero blocks that end a tar archive. */
export function tarEnd() {
  return new Uint8Array(1024);
}

/** A tar archive's members back to `[{ name, bytes }]` (tests, readers). */
export function parseTar(bytes) {
  const out = [];
  let at = 0;
  while (at + 512 <= bytes.length) {
    const header = bytes.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const text = (from, to) =>
      new TextDecoder().decode(header.subarray(from, to)).replace(/\0.*$/s, '');
    const prefix = text(345, 500);
    const name = (prefix ? `${prefix}/` : '') + text(0, 100);
    const size = parseInt(text(124, 136).trim(), 8);
    out.push({ name, bytes: bytes.slice(at + 512, at + 512 + size) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/**
 * An episode's members: `<key>.json` (everything but the arrays, plus each
 * array's shape and dtype) and `<key>.<array>.npy` per array.
 */
export function episodeMembers(key, episode, extra = {}) {
  const { arrays, ...meta } = episode;
  const shapes = {};
  const members = [];
  for (const [name, { data, shape }] of Object.entries(arrays)) {
    shapes[name] = { shape, dtype: DTYPES.get(data.constructor) };
    members.push([`${key}.${name}.npy`, npyBytes(data, shape)]);
  }
  const json = utf8(JSON.stringify({ key, ...meta, ...extra, arrays: shapes }));
  return [[`${key}.json`, json], ...members];
}
