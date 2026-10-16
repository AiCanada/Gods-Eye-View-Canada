/**
 * A dataset worker thread (owner request 2026-10-13): loads the frozen
 * world once, then writes the shards it is handed, one at a time, and says
 * when each is done. The engine runs here in-process, so the tape's hooks
 * reach it (the server's epidemic worker copies its input instead).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { loadWorldSnapshot } from './outbreakWorldStore.mjs';
import { writeShard } from './outbreakDatasetEpisodes.mjs';

const world = loadWorldSnapshot(workerData.worldDir);
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', async (message) => {
  if (message?.type !== 'shard') return;
  try {
    const result = await writeShard(
      world,
      workerData.spec,
      message.shard,
      workerData.shardsDir,
    );
    parentPort.postMessage({ type: 'done', result });
  } catch (error) {
    parentPort.postMessage({
      type: 'failed',
      shard: message.shard,
      error: String(error?.stack || error?.message || error),
    });
  }
});
