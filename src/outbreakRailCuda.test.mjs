import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  RAIL_CROSS_CUDA_MIN,
  railCrossCudaExe,
  railCrossHitsCuda,
  tryEnableOutbreakRailCuda,
} from '../server/shared/outbreakRailCuda.mjs';
import {
  buildRailGraph,
  railComponents,
  railCrossHits,
  railCrossHitsCpu,
  railVertexIndex,
  setRailCrossHits,
} from './outbreakNetwork.mjs';

/** Two segments that cross at (0.5, 0). */
function crossXy() {
  return Float64Array.from([0, 0, 1, 0, 0.5, -0.5, 0.5, 0.5]);
}

test('railCrossHitsCpu: interior cross and miss', () => {
  const hit = railCrossHitsCpu(crossXy());
  assert.equal(hit.hit.length, 1);
  assert.equal(hit.hit[0], 1);
  assert.ok(Math.abs(hit.u[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(hit.w[0] - 0.5) < 1e-9);
  const miss = railCrossHitsCpu(Float64Array.from([0, 0, 1, 0, 0, 1, 1, 1]));
  assert.equal(miss.hit[0], 0);
  const empty = railCrossHitsCpu(new Float64Array(0));
  assert.equal(empty.hit.length, 0);
});

test('railCrossHits: rejects a length that is not eights', () => {
  assert.throws(() => railCrossHits(new Float64Array(3)), /eights/);
});

test('setRailCrossHits: swapped kernel is used, then CPU again', () => {
  let calls = 0;
  setRailCrossHits((xy) => {
    calls += 1;
    return railCrossHitsCpu(xy);
  });
  try {
    const graph = buildRailGraph(
      [
        [
          [0, 0],
          [1, 0],
        ],
        [
          [0.5, -0.5],
          [0.5, 0.5],
        ],
      ],
      { joinKm: 0.001 },
    );
    assert.equal(calls, 1);
    const comp = railComponents(graph);
    const index = railVertexIndex(graph);
    const a = comp[index.nearest({ lat: 0, lon: 0 }, 5)[0]];
    const b = comp[index.nearest({ lat: 0.5, lon: 0.5 }, 5)[0]];
    assert.equal(a, b);
  } finally {
    setRailCrossHits(null);
  }
});

test('tryEnableOutbreakRailCuda: off, missing, and a stubbed binary', () => {
  assert.equal(
    tryEnableOutbreakRailCuda({ env: { GEV_OUTBREAK_RAIL_CUDA: '0' } }).reason,
    'off',
  );
  assert.equal(
    tryEnableOutbreakRailCuda({
      env: {},
      exists: () => false,
    }).reason,
    'missing',
  );
  const ran = [];
  const n = RAIL_CROSS_CUDA_MIN;
  const xy = new Float64Array(n * 8);
  xy.set(crossXy(), 0);
  const cpu = railCrossHitsCpu(xy);
  const pad = (8 - (n % 8)) % 8;
  const out = Buffer.alloc(4 + n + pad + n * 16);
  out.writeUInt32LE(n, 0);
  out[4] = cpu.hit[0];
  out.writeDoubleLE(cpu.u[0], 4 + n + pad);
  out.writeDoubleLE(cpu.w[0], 4 + n + pad + n * 8);
  const enabled = tryEnableOutbreakRailCuda({
    env: { GEV_OUTBREAK_RAIL_CUDA_MIN: String(n) },
    exe: 'rail_cross.exe',
    exists: () => true,
    spawn: (cmd, args, opts) => {
      ran.push({ cmd, n: opts.input.readUInt32LE(8) });
      return { status: 0, stdout: out, stderr: Buffer.alloc(0) };
    },
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.reason, 'cuda');
  try {
    const got = railCrossHits(xy);
    assert.equal(ran.length, 1);
    assert.equal(ran[0].cmd, 'rail_cross.exe');
    assert.equal(got.hit[0], 1);
    assert.ok(Math.abs(got.u[0] - 0.5) < 1e-9);
  } finally {
    setRailCrossHits(null);
  }
});

test('tryEnableOutbreakRailCuda: a failed spawn stays on CPU', () => {
  let spawns = 0;
  tryEnableOutbreakRailCuda({
    env: { GEV_OUTBREAK_RAIL_CUDA_MIN: '0' },
    exe: 'missing.exe',
    exists: () => true,
    spawn: () => {
      spawns += 1;
      return {
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('cuda: boom'),
      };
    },
  });
  try {
    const a = railCrossHits(crossXy());
    const b = railCrossHits(crossXy());
    assert.equal(a.hit[0], 1);
    assert.equal(b.hit[0], 1);
    assert.equal(spawns, 1, 'one failure, then CPU');
  } finally {
    setRailCrossHits(null);
  }
});

test('railCrossHitsCuda: protocol round-trip through a stub', () => {
  const xy = crossXy();
  const cpu = railCrossHitsCpu(xy);
  const pad = (8 - (1 % 8)) % 8;
  const out = Buffer.alloc(4 + 1 + pad + 16);
  out.writeUInt32LE(1, 0);
  out[4] = 1;
  out.writeDoubleLE(cpu.u[0], 4 + 1 + pad);
  out.writeDoubleLE(cpu.w[0], 4 + 1 + pad + 8);
  const got = railCrossHitsCuda(xy, {
    exe: 'x',
    spawn: () => ({ status: 0, stdout: out, stderr: Buffer.alloc(0) }),
  });
  assert.equal(got.hit[0], 1);
  assert.ok(Math.abs(got.u[0] - cpu.u[0]) < 1e-12);
});

test('railCrossCudaExe: windows suffix', () => {
  assert.match(railCrossCudaExe('win32', '/repo'), /rail_cross\.exe$/);
  assert.match(railCrossCudaExe('linux', '/repo'), /rail_cross$/);
});

const liveExe = railCrossCudaExe();
test(
  'CUDA binary matches CPU on a packed batch when built',
  { skip: !fs.existsSync(liveExe) },
  () => {
    const n = 5000;
    const xy = new Float64Array(n * 8);
    for (let i = 0; i < n; i += 1) {
      if (i % 2 === 0) {
        xy.set(crossXy(), i * 8);
      } else {
        xy.set([0, 0, 1, 0, 0, 1, 1, 1], i * 8);
      }
    }
    const cpu = railCrossHitsCpu(xy);
    const gpu = railCrossHitsCuda(xy, { exe: liveExe });
    assert.equal(gpu.hit.length, n);
    assert.deepEqual([...gpu.hit], [...cpu.hit]);
    for (let i = 0; i < n; i += 1) {
      if (!cpu.hit[i]) continue;
      assert.ok(Math.abs(gpu.u[i] - cpu.u[i]) < 1e-12);
      assert.ok(Math.abs(gpu.w[i] - cpu.w[i]) < 1e-12);
    }
  },
);
