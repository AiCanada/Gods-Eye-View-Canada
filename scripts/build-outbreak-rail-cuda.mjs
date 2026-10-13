#!/usr/bin/env node
/**
 * Optional CUDA binary for Outbreak world-rail crossings.
 * Needs nvcc (CUDA 12/13) and, on Windows, MSVC via vcvars64.
 * No postinstall: run by hand when this machine has an NVIDIA GPU.
 *
 *   node scripts/build-outbreak-rail-cuda.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'native', 'outbreak-rail-cuda', 'rail_cross.cu');
const OUT_DIR = path.join(ROOT, 'native', 'outbreak-rail-cuda');
const OUT =
  process.platform === 'win32'
    ? path.join(OUT_DIR, 'rail_cross.exe')
    : path.join(OUT_DIR, 'rail_cross');

function findVcvars() {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (!fs.existsSync(vswhere)) return null;
  const r = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8' },
  );
  const install = String(r.stdout || '').trim();
  if (!install) return null;
  const bat = path.join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return fs.existsSync(bat) ? bat : null;
}

function nvccArgs() {
  return ['-O2', '-o', OUT, SRC];
}

function run(command, args, env) {
  const r = spawnSync(command, args, {
    cwd: ROOT,
    env: env || process.env,
    encoding: 'utf8',
    shell: false,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status ?? 1;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

if (process.platform === 'win32') {
  const vcvars = findVcvars();
  if (!vcvars) {
    console.error(
      'MSVC vcvars64.bat not found. Install Visual Studio Build Tools.',
    );
    process.exit(1);
  }
  const line = `call "${vcvars}" && nvcc -O2 -o "${OUT}" "${SRC}"`;
  const r = spawnSync('cmd.exe', ['/d', '/c', line], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status) process.exit(r.status);
} else {
  const status = run('nvcc', nvccArgs());
  if (status) process.exit(status);
}

if (!fs.existsSync(OUT)) {
  console.error('nvcc did not write', OUT);
  process.exit(1);
}
console.log('wrote', OUT);
