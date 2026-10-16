import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../app/startupChrome.js', import.meta.url),
  'utf8',
)
  .replace(/^import .*;\n/gm, '')
  .replace('export function', 'function');

function fixture() {
  const timers = new Map();
  const listeners = new Map();
  const events = [];
  let restored;
  let nextTimer = 0;
  let ultraDestroyed = 0;
  let aiWorldDestroyed = 0;
  const controller = new AbortController();
  const context = {
    console,
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    initFirstRunExperience() {
      events.push('welcome');
      return { destroy: () => events.push('welcome:destroy') };
    },
    async initKeySetup() {
      return { destroy: () => events.push('settings:destroy') };
    },
    /* The standalone entry starts the Ultra box beside Provider Settings.
     * These tests are about the welcome cover, so this one is counted on the
     * side rather than pushed into `events`, which the assertions below
     * read by position. */
    initUltraHelpPanel() {
      return {
        destroy: () => {
          ultraDestroyed += 1;
        },
      };
    },
    // The AI World Training Sim box starts beside it, counted the same way.
    initAiWorldPanel() {
      return {
        destroy: () => {
          aiWorldDestroyed += 1;
        },
      };
    },
    // And its predictions overlay on the globe.
    initAiWorldOverlay() {
      return {
        destroy: () => {
          aiWorldDestroyed += 1;
        },
      };
    },
    // Every box's corner grip, counted the same way.
    installPanelCornerResize() {
      return {
        destroy: () => {
          aiWorldDestroyed += 1;
        },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const stop = context.startApplicationChrome({
    initializeSettings: context.initKeySetup,
    loadingScreen: {
      classList: { add: (value) => events.push(value) },
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type) => listeners.delete(type),
    },
    styleManager: {
      initialRestorePromise: new Promise((resolve) => {
        restored = resolve;
      }),
    },
    dataManager: {},
    signal: controller.signal,
  });
  return {
    events,
    listeners,
    stop,
    restored,
    controller,
    ultraCount: () => ultraDestroyed,
    aiWorldCount: () => aiWorldDestroyed,
    fire(delay) {
      for (const [id, task] of timers) {
        if (task.delay === delay) {
          timers.delete(id);
          task.fn();
        }
      }
    },
    timers,
  };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test('welcome waits for restoration, minimum delay, and the cover transition', async () => {
  const f = fixture();
  f.fire(1000);
  await flush();
  assert.deepEqual(f.events, []);
  f.restored();
  await flush();
  assert.deepEqual(f.events, ['hidden']);
  f.listeners.get('transitionend')();
  f.fire(900);
  assert.deepEqual(f.events, ['hidden', 'welcome']);
  await f.stop();
  assert.deepEqual(f.events.slice(-2), ['welcome:destroy', 'settings:destroy']);
  // The Ultra box is started beside Provider Settings and goes down with it:
  // its poll and its map events must not outlive the shell.
  assert.equal(f.ultraCount(), 1);
  // So do the AI World box, its overlay and the boxes' corner grips:
  // neither its status poll, its predictions nor a grip may outlive the shell.
  assert.equal(f.aiWorldCount(), 3);
  assert.equal(f.timers.size, 0);
});

test('reduced motion uses the bounded fallback after the cover hides', async () => {
  const f = fixture();
  f.restored();
  f.fire(1000);
  await flush();
  f.fire(900);
  assert.deepEqual(f.events, ['hidden', 'welcome']);
  await f.stop();
});

test('shutdown while restore is pending never reveals late welcome UI', async () => {
  const f = fixture();
  f.controller.abort();
  await f.stop();
  f.restored();
  await flush();
  f.fire(1000);
  f.fire(900);
  assert.deepEqual(f.events, ['settings:destroy']);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test('shutdown during the cover transition cancels the listener and fallback', async () => {
  const f = fixture();
  f.restored();
  f.fire(1000);
  await flush();
  const transition = f.listeners.get('transitionend');
  f.controller.abort();
  await f.stop();
  transition();
  f.fire(900);
  assert.deepEqual(f.events, ['hidden', 'settings:destroy']);
});
