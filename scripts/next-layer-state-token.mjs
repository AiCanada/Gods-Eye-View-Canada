#!/usr/bin/env node

import {
  LAYER_STATE_TOKEN_RESERVATIONS,
  nextForkLayerStateToken,
  nextLayerStateToken,
} from '../src/data/layerState.js';

const args = process.argv.slice(2);
// Fork layers count down from zz so upstream's tokens never reach them.
const fork = args[0] === '--fork';
const layerId = String((fork ? args[1] : args[0]) || '').trim();

if (!/^[a-z0-9-]+$/.test(layerId)) {
  console.error('Usage: npm run layer-token:next -- [--fork] <layer-id>');
  process.exitCode = 1;
} else if (Object.hasOwn(LAYER_STATE_TOKEN_RESERVATIONS, layerId)) {
  console.error(
    `${layerId} already owns token ${LAYER_STATE_TOKEN_RESERVATIONS[layerId]}`,
  );
  process.exitCode = 1;
} else if (fork) {
  console.log(`${layerId}: ${nextForkLayerStateToken()}`);
  console.log('Fork order: two-character base-36 down from zz.');
  console.log(
    'Append the id to FORK_LAYER_STATE_IDS in src/data/layerState.js.',
  );
} else {
  console.log(`${layerId}: ${nextLayerStateToken()}`);
  console.log('Order: free digits 0-9, then two-character base-36 00-zz.');
  console.log('Re-run after rebasing onto the latest main before merge.');
}
