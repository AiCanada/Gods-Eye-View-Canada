// src/data/fixtures/vectorTileEncoder.mjs
// Test-only Mapbox Vector Tile (MVT 2.1) encoder, so road-tile tests can build
// synthetic OpenMapTiles `transportation` tiles without network or committed
// binaries. Supports points, lines and polygons with string, boolean and
// numeric properties — the subset @mapbox/vector-tile decodes for the app.
import { PbfWriter } from 'pbf';

const zigzag = (n) => (n << 1) ^ (n >> 31);

/** Geometry command stream for one feature, in tile pixels. */
function encodeGeometry(type, parts) {
  const out = [];
  let cx = 0;
  let cy = 0;
  const moveTo = ([x, y]) => {
    out.push(zigzag(x - cx), zigzag(y - cy));
    cx = x;
    cy = y;
  };
  if (type === 1) {
    const points = parts.flat();
    out.push(1 | (points.length << 3));
    points.forEach(moveTo);
    return out;
  }
  for (const part of parts) {
    const ring = type === 3 ? part.slice(0, -1) : part;
    out.push(1 | (1 << 3));
    moveTo(ring[0]);
    out.push(2 | ((ring.length - 1) << 3));
    ring.slice(1).forEach(moveTo);
    if (type === 3) out.push(7 | (1 << 3));
  }
  return out;
}

function writeValue(value, pbf) {
  if (typeof value === 'string') pbf.writeStringField(1, value);
  else if (typeof value === 'boolean') pbf.writeBooleanField(7, value);
  else if (Number.isInteger(value) && value >= 0) pbf.writeVarintField(5, value);
  else if (Number.isInteger(value)) pbf.writeSVarintField(6, value);
  else pbf.writeDoubleField(3, value);
}

function writeFeature({ feature, keys, values }, pbf) {
  if (Number.isInteger(feature.id)) pbf.writeVarintField(1, feature.id);
  const tags = [];
  for (const [key, value] of Object.entries(feature.properties || {})) {
    if (value === undefined || value === null) continue;
    if (!keys.has(key)) keys.set(key, keys.size);
    const valueKey = `${typeof value}:${value}`;
    if (!values.has(valueKey)) values.set(valueKey, { index: values.size, value });
    tags.push(keys.get(key), values.get(valueKey).index);
  }
  pbf.writePackedVarint(2, tags);
  const type = feature.type ?? 2;
  pbf.writeVarintField(3, type);
  pbf.writePackedVarint(4, encodeGeometry(type, feature.geometry));
}

function writeLayer(layer, pbf) {
  pbf.writeVarintField(15, 2);
  pbf.writeStringField(1, layer.name);
  const keys = new Map();
  const values = new Map();
  for (const feature of layer.features) {
    pbf.writeMessage(2, writeFeature, { feature, keys, values });
  }
  for (const key of keys.keys()) pbf.writeStringField(3, key);
  for (const { value } of values.values()) pbf.writeMessage(4, writeValue, value);
  pbf.writeVarintField(5, layer.extent ?? 4096);
}

/**
 * Encode layers into MVT bytes.
 * @param {Array<{name:string, extent?:number, features:Array<{id?:number,
 *   type?:1|2|3, properties?:object, geometry:number[][][]}>}>} layers
 *   Geometry is a list of parts, each a list of [x, y] tile pixels.
 * @returns {Uint8Array}
 */
export function encodeVectorTile(layers) {
  const pbf = new PbfWriter();
  for (const layer of layers) pbf.writeMessage(3, writeLayer, layer);
  return pbf.finish();
}

/**
 * One OpenMapTiles-style `transportation` layer.
 * @param {Array<object>} features See encodeVectorTile.
 * @param {{extent?:number}} [options]
 * @returns {Uint8Array}
 */
export function encodeTransportationTile(features, { extent = 4096 } = {}) {
  return encodeVectorTile([{ name: 'transportation', extent, features }]);
}
