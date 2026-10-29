// God's Eye View Canada: the fork's layers sit at the top of the token
// namespace (zz, zy, zx), and a short link carries them in their own field,
// counted down from the top, instead of a 167-byte field-10 bitset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORK_TOP_LAYERS_FIELD,
  SHARE_VIEW_FORMAT_VERSION,
  decodeShareView,
  encodeShareView,
  layerTokenNumber,
} from './viewCodec.js';
import { FORK_LAYER_STATE_IDS, REGISTRY_BY_ID } from '../data/layerState.js';
import {
  WIRE_LEN,
  WireReader,
  WireWriter,
  crc8,
  decodeBase64Url,
  encodeBase64Url,
} from './wire.js';

const TOP = layerTokenNumber('zz');
const tokenOf = (id) => REGISTRY_BY_ID.get(id).token;

/** The top-level fields of a code: number → bytes (LEN) or value (varint). */
function fieldsOf(code) {
  const sealed = decodeBase64Url(code);
  const reader = new WireReader(sealed, 1, sealed.length - 1);
  const fields = new Map();
  while (!reader.done) {
    const { field, wireType } = reader.tag();
    fields.set(
      field,
      wireType === WIRE_LEN
        ? [...reader.lengthDelimited().rest()]
        : reader.varint(),
    );
  }
  return fields;
}

/** A sealed code written by hand, for payloads the encoder never makes. */
function codeOf(write) {
  const writer = new WireWriter();
  writer.bytes.push(SHARE_VIEW_FORMAT_VERSION);
  write(writer);
  const bytes = writer.finish();
  const sealed = new Uint8Array(bytes.length + 1);
  sealed.set(bytes);
  sealed[bytes.length] = crc8(bytes);
  return encodeBase64Url(sealed);
}

const layersOf = (code) =>
  decodeShareView(code, { nowMs: Number.MAX_SAFE_INTEGER }).state.layerState
    ?.enabledLayerIds;

test('every fork layer token is one of the top tokens the fork field holds', () => {
  for (const id of FORK_LAYER_STATE_IDS) {
    const number = layerTokenNumber(tokenOf(id));
    assert.ok(TOP - number < 64, `${id} (${tokenOf(id)}) is in the top 64`);
  }
});

test('a fork layer costs one byte of its own field, not a field-10 bitset', () => {
  const plain = encodeShareView({
    layerState: { enabledLayerIds: ['flights', 'traffic'] },
  });
  const withFork = encodeShareView({
    layerState: {
      enabledLayerIds: ['flights', 'traffic', ...FORK_LAYER_STATE_IDS],
    },
  });
  assert.deepEqual(
    [...layersOf(withFork)].sort(),
    ['flights', 'traffic', ...FORK_LAYER_STATE_IDS].sort(),
  );
  // Tag (2 bytes), length and one byte of bits: 4 bytes, under 6 characters.
  assert.ok(withFork.length - plain.length <= 6, withFork);
  const fields = fieldsOf(withFork);
  assert.deepEqual(fields.get(10), fieldsOf(plain).get(10));
  // zz is bit 0, zy bit 1, zx bit 2.
  const expected = FORK_LAYER_STATE_IDS.reduce(
    (bits, id) => bits | (1 << (TOP - layerTokenNumber(tokenOf(id)))),
    0,
  );
  assert.deepEqual(fields.get(FORK_TOP_LAYERS_FIELD), [expected]);
});

test('only fork layers on: field 10 is present and empty beside the fork field', () => {
  const code = encodeShareView({
    layerState: { enabledLayerIds: ['device-feeds'] },
  });
  const fields = fieldsOf(code);
  assert.deepEqual(fields.get(10), []);
  assert.deepEqual(fields.get(FORK_TOP_LAYERS_FIELD), [1]);
  assert.deepEqual(layersOf(code), ['device-feeds']);
  // Without fork layers the field is not written at all.
  const none = encodeShareView({ layerState: { enabledLayerIds: [] } });
  assert.equal(fieldsOf(none).has(FORK_TOP_LAYERS_FIELD), false);
});

test('a fork layer spelled in field 10 still opens, and re-encodes into the fork field', () => {
  const number = layerTokenNumber(tokenOf('outbreak'));
  const bits = new Array(Math.floor(number / 8) + 1).fill(0);
  bits[Math.floor(number / 8)] |= 1 << (number % 8);
  const code = codeOf((w) => w.bytesField(10, bits));
  assert.deepEqual(layersOf(code), ['outbreak']);
  const state = decodeShareView(code).state;
  assert.deepEqual(
    fieldsOf(encodeShareView(state)).get(FORK_TOP_LAYERS_FIELD),
    [1 << (TOP - number)],
  );
});

test('fork-field bits past the top span and a fork field without field 10 are reported, not guessed', () => {
  const past = codeOf((w) => {
    w.bytesField(10, []);
    w.bytesField(FORK_TOP_LAYERS_FIELD, [0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });
  const result = decodeShareView(past);
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.layerState.enabledLayerIds, []);
  assert.deepEqual(
    result.unknownFields.map((u) => [u.scope, u.code]),
    [['layer', 'top-64']],
  );
  const alone = decodeShareView(
    codeOf((w) => w.bytesField(FORK_TOP_LAYERS_FIELD, [1])),
  );
  assert.equal(alone.ok, true);
  assert.equal(alone.state.layerState, null);
  assert.deepEqual(
    alone.unknownFields.map((u) => [u.scope, u.code]),
    [['layer', 'fork-top-without-layers']],
  );
});
