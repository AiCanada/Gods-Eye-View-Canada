// God's Eye View Canada: the GLOBAL ABUNDANCE MAP box's state in the short
// share code, field 2046 (FORK_ABUNDANCE_FIELD), three bytes beside the
// fork's layer field, and through the long-form bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORK_ABUNDANCE_FIELD,
  FORK_TOP_LAYERS_FIELD,
  SHARE_VIEW_FORMAT_VERSION,
  createDefaultShareViewState,
  decodeShareView,
  encodeShareView,
  normalizeShareViewState,
} from './viewCodec.js';
import { fromLegacyShareState, toLegacyShareState } from './legacyShareState.js';
import {
  WIRE_LEN,
  WireReader,
  WireWriter,
  crc8,
  decodeBase64Url,
  encodeBase64Url,
} from './wire.js';

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

test('the box’s state rides in field 2046 as three bytes, and comes back', () => {
  const abundance = {
    level: 'region',
    show: true,
    year: 25,
    view: 'p10',
    scale: 'others',
    scenario: 'pessimistic',
  };
  const plain = encodeShareView({ lat: 10, lon: 20 });
  const code = encodeShareView({ lat: 10, lon: 20, abundance });
  // Region 1, SHOW ON MAP 4, AMONG THE OTHERS 8, PESSIMISTIC 32; IF IT GOES BADLY 1; 25 years.
  assert.deepEqual(fieldsOf(code).get(FORK_ABUNDANCE_FIELD), [45, 1, 25]);
  // Tag (2 bytes), length and three bytes: 6 bytes, within 8 characters.
  assert.ok(code.length - plain.length <= 8, code);
  const decoded = decodeShareView(code);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.state.abundance, abundance);
  assert.equal(decoded.unknownFields, undefined);
  assert.equal(decodeShareView(plain).state.abundance, null);
  assert.equal(fieldsOf(plain).has(FORK_ABUNDANCE_FIELD), false);
  assert.equal(createDefaultShareViewState().abundance, null);
  assert.equal(normalizeShareViewState({ abundance: { level: 'planet' } }).abundance, null);
  assert.deepEqual(normalizeShareViewState({ abundance: { level: 'city' } }).abundance, {
    level: 'city',
    show: true,
    year: 0,
    view: 'p50',
    scale: 'today',
    scenario: 'baseline',
  });
});

test('the box field sits beside the fork layers field, each its own', () => {
  const code = encodeShareView({
    layerState: { enabledLayerIds: ['device-feeds'] },
    abundance: { level: 'city' },
  });
  const fields = fieldsOf(code);
  assert.deepEqual(fields.get(FORK_ABUNDANCE_FIELD), [6, 0, 0]);
  assert.deepEqual(fields.get(FORK_TOP_LAYERS_FIELD), [1]);
  const decoded = decodeShareView(code, { nowMs: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(decoded.state.layerState.enabledLayerIds, ['device-feeds']);
  assert.equal(decoded.state.abundance.level, 'city');
  assert.equal(decoded.unknownFields, undefined);
});

test('a malformed box field is reported and the view still opens; a repeat is refused', () => {
  const code = codeOf((w) => w.bytesField(FORK_ABUNDANCE_FIELD, [7, 0]));
  const result = decodeShareView(code);
  assert.equal(result.ok, true);
  assert.equal(result.state.abundance, null);
  assert.deepEqual(
    result.unknownFields.map((u) => [u.scope, u.code]),
    [['abundance', 'malformed']],
  );
  const twice = codeOf((w) => {
    w.bytesField(FORK_ABUNDANCE_FIELD, [4, 0, 0]);
    w.bytesField(FORK_ABUNDANCE_FIELD, [4, 0, 0]);
  });
  assert.deepEqual(decodeShareView(twice), { ok: false, reason: 'duplicate-field' });
});

test('the long form’s state carries the box through the bridge both ways', () => {
  const abundance = {
    level: 'country',
    show: false,
    year: 50,
    view: 'change',
    scale: 'today',
    scenario: 'optimistic',
  };
  const compact = fromLegacyShareState({ lat: 1, lon: 2, abundance });
  assert.deepEqual(compact.abundance, abundance);
  assert.deepEqual(toLegacyShareState(compact).abundance, abundance);
  assert.equal(toLegacyShareState({ lat: 1, lon: 2 }).abundance, null);
  assert.deepEqual(
    toLegacyShareState(decodeShareView(encodeShareView(compact)).state).abundance,
    abundance,
  );
});
