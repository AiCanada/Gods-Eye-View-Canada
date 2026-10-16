#!/usr/bin/env node
/**
 * A closed-loop epidemic environment on stdio (owner request 2026-10-13):
 * one JSON object per line in, one out (ml/gevtape/env.py is the client).
 *
 *   {"cmd":"reset","scenario":<object|null>,"seed":<int>}
 *     → {"ok":true,"obs":{"day":0,"global":[…],"country_state":[[…]]},"info":{…}}
 *   {"cmd":"step","action":{"window":<24-bit mask|null>,
 *     "switch":{"<node>":0|1},"flag":[<country index>…]}}
 *     → {"ok":true,"obs":{…},"done":<bool>,"info":{…}}
 *   {"cmd":"close"} → {"ok":true}
 *
 * The action steers the next day: the intervention window by hour, per-place
 * switches (per-place trigger modes) and countries flagged ('reported'
 * border policy), the three decisions the model makes (src/outbreakEpi.mjs).
 *
 *   node scripts/outbreak-env.mjs [--world <dir|id>] [--days 40]
 */
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import { projectRoot } from './project-root.mjs';
import { latestWorld } from '../server/shared/outbreakWorldStore.mjs';

const SHARED_BYTES = 1 << 20;

export function parseArgs(argv, root = projectRoot(import.meta.url)) {
  const options = {
    worlds: path.join(root, '.gev-data', 'outbreak', 'worlds'),
    world: null,
    days: 40,
  };
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    const next = () => argv[(k += 1)];
    if (arg === '--world') options.world = next();
    else if (arg === '--days') options.days = Math.max(1, Number(next()) | 0);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function createEnvironment({ worldDir, days = 40 }) {
  let worker = null;
  let shared = null;
  let flag = null;
  let bytes = null;
  let waiting = null; // resolves with the next worker message
  let finished = null;

  const nextMessage = () =>
    new Promise((resolve) => {
      waiting = resolve;
    });
  const onMessage = (message) => {
    if (message.type === 'done') finished = message;
    const resolve = waiting;
    waiting = null;
    resolve?.(message);
  };
  const stop = () => {
    if (!worker) return;
    // Wake the engine thread out of its wait with the word to stop, so it
    // ends at once; terminate() alone waits on a blocked Atomics.wait.
    Atomics.store(flag, 0, 2);
    Atomics.notify(flag, 0);
    worker.terminate();
    worker = null;
  };
  const send = (action) => {
    const text = new TextEncoder().encode(JSON.stringify(action ?? null));
    if (text.length > bytes.length) throw new Error('action too large');
    bytes.set(text);
    Atomics.store(flag, 1, text.length);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  };
  return {
    async reset({ scenario = null, seed = 0 } = {}) {
      stop();
      finished = null;
      shared = new SharedArrayBuffer(8 + SHARED_BYTES);
      flag = new Int32Array(shared, 0, 2);
      bytes = new Uint8Array(shared, 8);
      worker = new Worker(
        new URL('../server/shared/outbreakEnvWorker.mjs', import.meta.url),
        { workerData: { worldDir, scenario, seed, days, shared } },
      );
      worker.on('message', onMessage);
      worker.on('error', (error) =>
        onMessage({ type: 'error', error: String(error?.message || error) }),
      );
      const first = await nextMessage();
      if (first.type === 'error') throw new Error(first.error);
      return { obs: first.obs, info: { days } };
    },
    async step(action) {
      if (!worker) throw new Error('reset first');
      const pending = nextMessage();
      send(action);
      const message = await pending;
      if (message.type === 'error') throw new Error(message.error);
      if (message.type === 'done') {
        stop();
        return { obs: null, done: true, info: { scenario: message.scenario } };
      }
      return { obs: message.obs, done: false, info: {} };
    },
    close() {
      stop();
    },
    get finished() {
      return finished;
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const worldDir = options.world
    ? fs.existsSync(path.join(options.world, 'world.json'))
      ? options.world
      : path.join(options.worlds, options.world)
    : latestWorld(options.worlds)?.dir;
  if (!worldDir)
    throw new Error('No world yet: run node scripts/outbreak-world.mjs first.');
  const env = createEnvironment({ worldDir, days: options.days });
  const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      reply({ ok: false, error: 'not JSON' });
      continue;
    }
    try {
      if (message.cmd === 'reset')
        reply({ ok: true, ...(await env.reset(message)) });
      else if (message.cmd === 'step')
        reply({ ok: true, ...(await env.step(message.action ?? null)) });
      else if (message.cmd === 'close') {
        env.close();
        reply({ ok: true });
        break;
      } else reply({ ok: false, error: `unknown cmd: ${message.cmd}` });
    } catch (error) {
      reply({ ok: false, error: String(error?.message || error) });
    }
  }
  env.close();
  // Closed: let go of stdin so the process can end.
  lines.close();
  process.stdin.destroy();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(`[env] ${error.message}`);
    process.exitCode = 1;
  });
