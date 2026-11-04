import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectKeyUpdates,
  keySetupChipLabel,
  keySetupPlaceholder,
  keySetupPowerUpCount,
  stripKeylessBasemapFromHash,
  waitForChatGptOAuth,
  initKeySetup,
  KEY_SETUP_PLACEMENT_ATTRIBUTES,
  keySetupChipInToolbar,
} from './keySetup.js';
import { createPinia } from 'pinia';
import { useProviderSettingsStore } from './ui/stores/providerSettings.js';

// The chip's placement is ProviderSettingsView's (upstream #1499); the rule
// it follows is the fork's: Cyber, and the owner's phone in either layout.
test('the POWER UP chip moves to the toolbar in Cyber and on the owner phone only', () => {
  for (const variant of ['tactical', 'minimal', 'cyber'])
    assert.equal(keySetupChipInToolbar({ uiTheme: variant }), variant === 'cyber');
  // The PC layout on a phone puts it in the toolbar whatever the theme.
  assert.equal(
    keySetupChipInToolbar({ uiTheme: 'tactical', pcMirror: 'true' }),
    true,
  );
  // So does the phone layout on a touch screen; a PC in the phone layout does not move it.
  assert.equal(
    keySetupChipInToolbar({ touchDevice: 'true', layoutMode: 'phone' }),
    true,
  );
  assert.equal(
    keySetupChipInToolbar({ touchDevice: 'false', layoutMode: 'phone' }),
    false,
  );
  assert.equal(keySetupChipInToolbar(), false);
  assert.deepEqual(
    [...KEY_SETUP_PLACEMENT_ATTRIBUTES],
    ['data-ui-theme', 'data-pc-mirror', 'data-touch-device', 'data-layout-mode'],
  );
});

const freshStore = () => useProviderSettingsStore(createPinia());

test('the chip counts what is missing, and retires the count at zero', () => {
  assert.equal(
    keySetupChipLabel({ setCount: 0, total: 8 }),
    'POWER UP · 8 KEYS WAITING',
  );
  assert.equal(
    keySetupChipLabel({ setCount: 7, total: 8 }),
    'POWER UP · 1 KEY WAITING',
  );
  assert.equal(keySetupChipLabel({ setCount: 8, total: 8 }), 'POWERED UP');
  assert.equal(
    keySetupChipLabel(null),
    'POWERED UP',
    'no status is not a broken label',
  );
});

test('the chip counts every power-up: keys, camera sections and device sections', () => {
  const keys = { setCount: 5, total: 12 };
  const sections = [
    { id: 'cameras-home', set: true },
    { id: 'cameras-business', set: false },
    { id: 'devices-drone', set: false },
    { id: 'devices-robot', set: false },
    { id: 'devices-marine', set: false },
    { id: 'devices-tracker', set: true },
    { id: 'devices-security', set: false },
  ];
  assert.deepEqual(keySetupPowerUpCount(keys, sections), {
    on: 7,
    total: 19,
    missing: 12,
  });
  assert.equal(keySetupChipLabel(keys, sections), 'POWER UP · 12 WAITING');
  assert.equal(
    keySetupChipLabel(
      { setCount: 12, total: 12 },
      sections.map((section) => ({ ...section, set: true })),
    ),
    'POWERED UP',
  );
  assert.equal(
    keySetupChipLabel({ setCount: 12, total: 12 }, sections),
    'POWER UP · 5 WAITING',
    'all keys in, sections still waiting',
  );
  assert.deepEqual(keySetupPowerUpCount(null, null), {
    on: 0,
    total: 0,
    missing: 0,
  });
  assert.deepEqual(
    keySetupPowerUpCount({ setCount: 20, total: 12 }, []),
    { on: 12, total: 12, missing: 0 },
    'never more on than there are',
  );
});

test('a saved value the provider cannot use reads as saved, and says which box to replace', () => {
  const vars = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
  ];
  const refused = {
    set: false,
    present: true,
    unusable: ['TWILIO_FROM_NUMBER'],
  };
  assert.deepEqual(
    vars.map((name) => keySetupPlaceholder(refused, name)),
    [
      'TWILIO_ACCOUNT_SID saved — paste to replace',
      'TWILIO_AUTH_TOKEN saved — paste to replace',
      'TWILIO_FROM_NUMBER saved but not usable — paste to replace',
    ],
  );
  assert.equal(
    keySetupPlaceholder(
      { set: true, present: true, unusable: [] },
      'TWILIO_AUTH_TOKEN',
    ),
    'TWILIO_AUTH_TOKEN saved — paste to replace',
  );
  assert.equal(
    keySetupPlaceholder(
      { set: false, present: false, unusable: [] },
      'TWILIO_AUTH_TOKEN',
    ),
    'paste TWILIO_AUTH_TOKEN',
  );
  // A status from before `present` existed still reads as it did.
  assert.equal(
    keySetupPlaceholder({ set: true }, 'OPENAI_API_KEY'),
    'OPENAI_API_KEY saved — paste to replace',
  );
  assert.equal(
    keySetupPlaceholder({ set: false }, 'OPENAI_API_KEY'),
    'paste OPENAI_API_KEY',
  );
});

test('collectKeyUpdates keeps only non-empty trimmed values', () => {
  const updates = collectKeyUpdates([
    { envVar: 'OPENAI_API_KEY', value: '  sk-abc  ' },
    { envVar: 'FIRMS_MAP_KEY', value: '' },
    { envVar: 'TOMTOM_API_KEY', value: '   ' },
    { envVar: '', value: 'orphan' },
    null,
  ]);
  assert.deepEqual(updates, { OPENAI_API_KEY: 'sk-abc' });
  assert.deepEqual(collectKeyUpdates([]), {});
  assert.deepEqual(collectKeyUpdates(null), {});
});

test('OAuth login polling stops as soon as local ChatGPT auth becomes available', async () => {
  let checks = 0;
  let clock = 0;
  const available = await waitForChatGptOAuth({
    fetchImpl: async () => {
      checks += 1;
      return {
        ok: true,
        json: async () => ({ available: checks >= 3 }),
      };
    },
    timeoutMs: 10_000,
    pollMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(available, true);
  assert.equal(checks, 3);
});

test('OAuth login polling stops on login or HTTP failure instead of waiting for timeout', async () => {
  for (const result of [
    { ok: true, payload: { available: false, loginFailed: true, error: 'Sign-in failed.' } },
    { ok: false, payload: { error: 'Sign-in is local only.' } },
  ]) {
    let checks = 0;
    await assert.rejects(waitForChatGptOAuth({
      fetchImpl: async () => { checks += 1; return { ok: result.ok, json: async () => result.payload }; },
      sleep: () => assert.fail('failed login must stop polling'),
    }), { message: result.payload.error });
    assert.equal(checks, 1);
  }
});

test('OAuth login polling respects timeout and an aborted setup surface', async () => {
  let clock = 0;
  let checks = 0;
  const poll = { fetchImpl: async () => { checks += 1; return { ok: true, json: async () => ({ available: false, pending: true }) }; } };
  assert.equal(await waitForChatGptOAuth({ ...poll, timeoutMs: 100, pollMs: 100, now: () => clock, sleep: async (ms) => { clock += ms; } }), false);
  assert.equal(checks, 2);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await waitForChatGptOAuth({ ...poll, signal: controller.signal }), false);
  assert.equal(checks, 2, 'aborted polling does not fetch');
});

test('OAuth polling ignores a ready response received after the surface was aborted', async () => {
  const controller = new AbortController();
  const available = await waitForChatGptOAuth({
    signal: controller.signal,
    fetchImpl: async () => ({ ok: true, json: async () => { controller.abort(); return { available: true }; } }),
    sleep: () => assert.fail('aborted polling must not continue'),
  });
  assert.equal(available, false);
});

test('the first Google key strips ONLY the keyless OSM basemap from the share hash', () => {
  const stripped = stripKeylessBasemapFromHash(
    'lat=30.2&lon=-97.7&map=osm&style=normal',
  );
  assert.ok(stripped !== null);
  const params = new URLSearchParams(stripped);
  assert.equal(params.get('map'), null, 'osm basemap removed');
  assert.equal(params.get('lat'), '30.2', 'camera survives');
  assert.equal(params.get('style'), 'normal', 'style survives');
  // A stack under any other name was chosen or shared on purpose.
  assert.equal(stripKeylessBasemapFromHash('map=bing-aerial&lat=1'), null);
  assert.equal(
    stripKeylessBasemapFromHash('lat=1&lon=2'),
    null,
    'no stack, nothing to do',
  );
  assert.equal(stripKeylessBasemapFromHash(''), null);
  assert.equal(stripKeylessBasemapFromHash(undefined), null);
});

test('aborting pending setup removes its surface and ignores a late response', async () => {
  const store = freshStore();
  const root = { dataset: {} };
  let resolveResponse;
  let requestSignal;
  const controller = new AbortController();
  const pending = initKeySetup({
    documentRef: { getElementById: (id) => (id === 'key-setup' ? root : null) },
    signal: controller.signal,
    store,
    fetchImpl: (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    },
  });
  assert.equal(store.controls !== null, true);
  controller.abort();
  assert.equal(requestSignal.aborted, true);
  assert.equal(store.view.available, false);
  assert.equal(store.controls, null);
  resolveResponse({ ok: true, json: async () => ({ keys: [] }) });
  assert.equal(await pending, null);
  assert.equal(store.view.available, false);
});
