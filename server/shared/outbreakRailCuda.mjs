/**
 * Optional CUDA path for Outbreak rail-graph crossings.
 * Node-only. The browser keeps railCrossHitsCpu.
 *
 * When native/outbreak-rail-cuda/rail_cross(.exe) exists and
 * GEV_OUTBREAK_RAIL_CUDA is not "0", setRailCrossHits swaps the kernel for
 * pairs at or above GEV_OUTBREAK_RAIL_CUDA_MIN (default 4096). Smaller
 * graphs and a missing binary stay on CPU. A failed spawn falls back once
 * and stays on CPU for the rest of the process.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  railCrossHitsCpu,
  setRailCrossHits,
} from '../../src/outbreakNetwork.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAGIC = Buffer.from('GEVRC1\0\0', 'binary');

export const RAIL_CROSS_CUDA_MIN = 4096;

export function railCrossCudaExe(platform = process.platform, root = ROOT) {
  const base = path.join(root, 'native', 'outbreak-rail-cuda', 'rail_cross');
  return platform === 'win32' ? `${base}.exe` : base;
}

function minPairs(env = process.env) {
  const raw = env.GEV_OUTBREAK_RAIL_CUDA_MIN;
  const n = raw == null || raw === '' ? RAIL_CROSS_CUDA_MIN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : RAIL_CROSS_CUDA_MIN;
}

function cudaOff(env = process.env) {
  return env.GEV_OUTBREAK_RAIL_CUDA === '0';
}

/**
 * Packed pairs → hits through the CUDA binary. Throws on a bad answer so
 * the caller can fall back to CPU.
 *
 * @param {Float64Array} xy
 * @param {object} [options]
 * @param {string} [options.exe]
 * @param {(cmd: string, args: string[], opts: object) => {status:number|null, stdout:Buffer, stderr:Buffer}} [options.spawn]
 */
export function railCrossHitsCuda(xy, { exe, spawn = spawnSync } = {}) {
  const n = xy.length >> 3;
  const bin = exe || railCrossCudaExe();
  const input = Buffer.alloc(8 + 4 + xy.byteLength);
  MAGIC.copy(input, 0);
  input.writeUInt32LE(n, 8);
  Buffer.from(xy.buffer, xy.byteOffset, xy.byteLength).copy(input, 12);
  const ran = spawn(bin, [], {
    input,
    encoding: 'buffer',
    maxBuffer: Math.max(16 * 1024 * 1024, 16 + n * 17),
    timeout: 120_000,
    windowsHide: true,
  });
  if (ran.status !== 0) {
    const err = String(ran.stderr || ran.error || `exit ${ran.status}`);
    throw new Error(err.slice(0, 200));
  }
  const out = Buffer.isBuffer(ran.stdout)
    ? ran.stdout
    : Buffer.from(ran.stdout || []);
  if (out.length < 4) throw new Error('cuda: empty answer');
  const count = out.readUInt32LE(0);
  if (count !== n) throw new Error('cuda: pair count mismatch');
  if (n === 0)
    return {
      hit: new Uint8Array(0),
      u: new Float64Array(0),
      w: new Float64Array(0),
    };
  const pad = (8 - (n % 8)) % 8;
  const hitAt = 4;
  const uAt = hitAt + n + pad;
  const wAt = uAt + n * 8;
  if (out.length < wAt + n * 8) throw new Error('cuda: short answer');
  const hit = new Uint8Array(n);
  hit.set(out.subarray(hitAt, hitAt + n));
  const u = new Float64Array(n);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    u[i] = out.readDoubleLE(uAt + i * 8);
    w[i] = out.readDoubleLE(wAt + i * 8);
  }
  return { hit, u, w };
}

/**
 * Install the CUDA kernel when the binary is on disk. Returns why it did
 * or did not. Pure besides the filesystem check and the one setRailCrossHits
 * call.
 */
export function tryEnableOutbreakRailCuda({
  env = process.env,
  exe = railCrossCudaExe(),
  exists = (p) => fs.existsSync(p),
  spawn = spawnSync,
  setHits = setRailCrossHits,
} = {}) {
  if (cudaOff(env)) {
    setHits(null);
    return { ok: false, reason: 'off' };
  }
  if (!exists(exe)) {
    setHits(null);
    return { ok: false, reason: 'missing' };
  }
  const min = minPairs(env);
  let failed = false;
  setHits((xy) => {
    const n = xy.length >> 3;
    if (failed || n < min) return railCrossHitsCpu(xy);
    try {
      return railCrossHitsCuda(xy, { exe, spawn });
    } catch {
      failed = true;
      return railCrossHitsCpu(xy);
    }
  });
  return { ok: true, reason: 'cuda', exe, min };
}
