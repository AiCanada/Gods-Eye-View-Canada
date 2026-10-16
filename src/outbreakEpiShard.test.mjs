import test from 'node:test';
import assert from 'node:assert/strict';
import {
  episodeMembers,
  npyBytes,
  parseNpy,
  parseTar,
  tarEnd,
  tarMember,
} from './outbreakEpiShard.mjs';

test('npy: every dtype and shape round-trips, and the header is 64-byte aligned', () => {
  const cases = [
    [Float64Array.from([1.5, -2, 3e300]), [3]],
    [Float32Array.from([1, 2, 3, 4, 5, 6]), [2, 3]],
    [Uint32Array.from([0, 4294967295, 7, 8]), [2, 1, 2]],
    [Int32Array.from([-1, 2]), [1, 2]],
    [Uint8Array.from([1, 0, 1]), [3]],
    [new Int16Array(0), [0, 4]],
  ];
  for (const [data, shape] of cases) {
    const bytes = npyBytes(data, shape);
    const headerLength = bytes[8] | (bytes[9] << 8);
    assert.equal((10 + headerLength) % 64, 0);
    const back = parseNpy(bytes);
    assert.deepEqual(back.shape, shape);
    assert.equal(back.data.constructor, data.constructor);
    assert.deepEqual(Array.from(back.data), Array.from(data));
  }
  assert.match(
    new TextDecoder().decode(
      npyBytes(Float64Array.from([1]), [1]).subarray(10, 70),
    ),
    /'shape': \(1,\)/,
  );
  assert.throws(() => npyBytes(Float64Array.from([1, 2]), [3]), /shape/);
});

test('tar: members round-trip with padding, a long name uses the prefix, and the end is two zero blocks', () => {
  const a = new TextEncoder().encode('{"a":1}');
  const b = new Uint8Array(1000).fill(7);
  const long = `${'d'.repeat(60)}/${'n'.repeat(90)}.npy`;
  const archive = new Uint8Array([
    ...tarMember('s000001-r00-A.json', a),
    ...tarMember(long, b),
    ...tarEnd(),
  ]);
  assert.equal(archive.length % 512, 0);
  const members = parseTar(archive);
  assert.deepEqual(
    members.map((m) => m.name),
    ['s000001-r00-A.json', long],
  );
  assert.deepEqual(Array.from(members[0].bytes), Array.from(a));
  assert.deepEqual(Array.from(members[1].bytes), Array.from(b));
  // The same member twice is the same bytes (fixed mtime).
  assert.deepEqual(tarMember('x', a), tarMember('x', a));
  // The header checksum is what tar computes: spaces in its own field.
  const header = tarMember('x', a).subarray(0, 512);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
  assert.equal(
    parseInt(new TextDecoder().decode(header.subarray(148, 154)), 8),
    sum,
  );
});

test('an episode becomes a WebDataset sample: one JSON and one npy per array', () => {
  const episode = {
    schema: 'gev-outbreak-episode/1',
    run: 2,
    labels: { infected: 10 },
    arrays: {
      global: { data: new Float64Array(6), shape: [3, 2] },
      flows: { data: new Int32Array(0), shape: [0, 6] },
    },
  };
  const members = episodeMembers('s000007-r02-A', episode, { scenario: 7 });
  assert.deepEqual(
    members.map(([name]) => name),
    [
      's000007-r02-A.json',
      's000007-r02-A.global.npy',
      's000007-r02-A.flows.npy',
    ],
  );
  const meta = JSON.parse(new TextDecoder().decode(members[0][1]));
  assert.equal(meta.scenario, 7);
  assert.equal(meta.run, 2);
  assert.deepEqual(meta.arrays.global, { shape: [3, 2], dtype: '<f8' });
  assert.equal(meta.arrays.flows.dtype, '<i4');
});
