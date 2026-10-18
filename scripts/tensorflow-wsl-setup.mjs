#!/usr/bin/env node
/**
 * npm run tensorflow:wsl-setup
 *
 * Sets up TensorFlow on the GPU for the AI World tab's TENSORFLOW sections:
 * runs scripts/tensorflow-wsl-setup.sh inside WSL2 (TensorFlow has had no
 * GPU on native Windows since 2.11). The distro is GEV_WSL_DISTRO, else
 * Ubuntu (in PowerShell: $env:GEV_WSL_DISTRO = "Ubuntu-24.04"). Nothing
 * needs sudo; it installs into ~/.gev/ in the WSL user's home. On Linux it
 * runs the same script directly.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toWslPath } from '../server/shared/tensorflowJobs.mjs';

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'tensorflow-wsl-setup.sh',
);
let result;
if (process.platform === 'win32') {
  const inside = toWslPath(script);
  if (!inside) {
    console.error(
      `tensorflow:wsl-setup: ${script} has no drive letter WSL2 can mount`,
    );
    process.exit(2);
  }
  const distro = String(process.env.GEV_WSL_DISTRO || '').trim() || 'Ubuntu';
  console.log(`Setting up TensorFlow in WSL2 (${distro})…`);
  result = spawnSync('wsl.exe', ['-d', distro, '--exec', 'bash', inside], {
    stdio: 'inherit',
  });
} else {
  result = spawnSync('bash', [script], { stdio: 'inherit' });
}
if (result.error) {
  console.error(
    `tensorflow:wsl-setup: ${result.error.message} (is WSL2 installed? wsl --install -d Ubuntu)`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
