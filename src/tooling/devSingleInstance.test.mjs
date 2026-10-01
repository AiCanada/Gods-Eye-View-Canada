// One dev server per checkout: which recorded process gets stopped at
// start-up, and when a running server decides its launcher is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ancestorChain,
  isAlive,
  launcherGone,
  parseProcessTable,
  previousToStop,
} from '../../server/standalone/single-instance.js';

const VITE = '"node" "node_modules\\vite\\bin\\vite.js"';

test('previousToStop: stops another live Vite process from the record', () => {
  assert.equal(previousToStop({ record: { pid: 4321 }, selfPid: 1, alive: true, commandLine: VITE }), 4321);
});

test('previousToStop: never stops itself, a dead pid, or a non-Vite process', () => {
  assert.equal(previousToStop({ record: { pid: 7 }, selfPid: 7, alive: true, commandLine: VITE }), null);
  assert.equal(previousToStop({ record: { pid: 4321 }, selfPid: 1, alive: false, commandLine: VITE }), null);
  assert.equal(previousToStop({ record: { pid: 4321 }, selfPid: 1, alive: true, commandLine: 'C:\\Windows\\explorer.exe' }), null);
  assert.equal(previousToStop({ record: { pid: 4321 }, selfPid: 1, alive: true, commandLine: undefined }), null);
});

test('previousToStop: ignores a missing or malformed record', () => {
  assert.equal(previousToStop({ record: null, selfPid: 1, alive: true, commandLine: VITE }), null);
  assert.equal(previousToStop({ record: { pid: 'x' }, selfPid: 1, alive: true, commandLine: VITE }), null);
  assert.equal(previousToStop({ record: { pid: -5 }, selfPid: 1, alive: true, commandLine: VITE }), null);
});

test('launcherGone: stays while the parent and every link above it live', () => {
  const alive = () => true;
  assert.equal(launcherGone({ parentPid: 10, currentParentPid: 10, chain: [10, 20, 30], alive }), false);
  assert.equal(launcherGone({ parentPid: 10, currentParentPid: 10, chain: [], alive }), false);
});

test('launcherGone: leaves when the parent dies, is replaced, or any link above it dies', () => {
  assert.equal(launcherGone({ parentPid: 10, currentParentPid: 10, chain: [10, 20, 30], alive: (pid) => pid !== 10 }), true);
  assert.equal(launcherGone({ parentPid: 10, currentParentPid: 1, chain: [10, 20, 30], alive: () => true }), true);
  // The observed cases: npm gone with cmd alive; the shell gone with npm and cmd alive.
  assert.equal(launcherGone({ parentPid: 10, currentParentPid: 10, chain: [10, 20, 30], alive: (pid) => pid !== 20 }), true);
  assert.equal(launcherGone({ parentPid: 10, currentParentPid: 10, chain: [10, 20, 30], alive: (pid) => pid !== 30 }), true);
});

test('ancestorChain: nearest first, stops before the session root or an unknown pid', () => {
  const table = parseProcessTable([
    '4 0 System',
    '900 4 wininit.exe',
    '1000 900 explorer.exe',
    '1100 1000 WindowsTerminal.exe',
    '1200 1100 powershell.exe',
    '1300 1200 node.exe',
    '1400 1300 cmd.exe',
    '1500 1400 node.exe',
  ].join('\r\n'));
  assert.deepEqual(ancestorChain(1500, table), [1400, 1300, 1200, 1100]);
  assert.deepEqual(ancestorChain(1500, table, { limit: 2 }), [1400, 1300]);
  assert.deepEqual(ancestorChain(1100, table), [], 'explorer is the root, never watched');
  assert.deepEqual(ancestorChain(1500, parseProcessTable('1500 77 node.exe')), [], 'a parent the table does not list');
  assert.deepEqual(ancestorChain(9, table), []);
  // POSIX: pid 1 ends the chain.
  const posix = parseProcessTable('1 0 systemd\n50 1 bash\n60 50 npm\n70 60 sh\n80 70 node');
  assert.deepEqual(ancestorChain(80, posix), [70, 60, 50]);
});

test('isAlive: this process is alive; an impossible pid is not', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive(Number.NaN), false);
});

test('singleInstancePlugin arms the launcher watch and exit cleanup once per process, across re-evaluated copies', async () => {
  // Vite re-bundles the config on an in-process restart, which evaluates
  // this module again: each `?copy=` import is such a fresh evaluation.
  delete globalThis.__GEV_DEV_SINGLE_INSTANCE;
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-single-'));
  const exitBefore = process.listenerCount('exit');
  const watches = [];
  const servers = [];
  try {
    for (const copy of ['a', 'b', 'c']) {
      const href = new URL('../../server/standalone/single-instance.js', import.meta.url).href;
      const { singleInstancePlugin } = await import(`${href}?copy=${copy}`);
      const server = { httpServer: null, close() {}, copy };
      servers.push(server);
      const plugin = singleInstancePlugin({ root, log() {}, watch: (current) => watches.push(current) });
      await plugin.configureServer(server);
    }
    assert.equal(watches.length, 1, 'the launcher is watched once, not once per restart');
    assert.equal(watches[0](), servers[2], 'leaving closes the live server, not the first one');
    assert.equal(process.listenerCount('exit'), exitBefore + 1, 'one exit cleanup for the process');
  } finally {
    delete globalThis.__GEV_DEV_SINGLE_INSTANCE;
    await rm(root, { recursive: true, force: true });
  }
});
