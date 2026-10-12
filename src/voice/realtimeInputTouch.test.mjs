import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeInput } from './realtimeInput.js';
import { PUSH_TO_TALK_HOLD_DELAY_MS } from './realtimeInputPolicy.js';

/** Swap globals for one test and put them back after it. */
function installGlobals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
}

/** A pointer or click event on the mic, with the fields a browser sets. */
function fire(target, type, fields = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(fields))
    Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

const timersOn = new WeakSet();

/**
 * The mic as the page has it: the click that toggles a session is the
 * session's own listener (sessionCommands.js); the document sees the click
 * first, as a capturing listener on the document does in a browser.
 */
function fixture(
  t,
  { active = false, pushToTalkMode = false, touch = true } = {},
) {
  if (!timersOn.has(t)) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    timersOn.add(t);
  }
  const doc = Object.assign(new EventTarget(), {
    activeElement: null,
    visibilityState: 'visible',
    hasFocus: () => true,
    documentElement: { dataset: touch ? { touchDevice: 'true' } : {} },
  });
  installGlobals(t, { document: doc, window: new EventTarget() });
  const button = Object.assign(new EventTarget(), {
    style: {},
    contains: (node) => node === button,
  });
  const helpDetail = { textContent: '' };
  const ui = {
    button,
    buttonLabel: { textContent: '' },
    helpDetail,
    root: { dataset: {} },
  };
  const calls = {
    starts: [],
    mic: [],
    status: [],
    clicks: 0,
    bargeIns: 0,
    holds: 0,
    releases: 0,
  };
  const state = { active, status: active ? 'listening' : 'idle' };
  const input = new RealtimeInput({
    readUi: () => ui,
    readStream: () => null,
    readStatus: () => state.status,
    operations: {
      isActive: () => state.active,
      setStatus: (status, detail) => {
        state.status = status;
        calls.status.push([status, detail]);
      },
      start: (settings) => {
        calls.starts.push(settings);
        // A real start() connects; the session is now push-to-talk.
        input.pushToTalkMode = settings.pushToTalk;
        state.active = true;
        state.status = 'listening';
      },
      pauseRadioForVoice: () => {},
      bargeIn: () => calls.bargeIns++,
      holdPointer: () => calls.holds++,
      releasePointerHold: () => calls.releases++,
      beginPointerTurn: () => {},
      mayClaimSpeaker: () => true,
    },
  });
  input.pushToTalkMode = pushToTalkMode;
  input.setMicrophoneEnabled = (enabled) => calls.mic.push(enabled);
  input.updateVoiceButtonLabel = RealtimeInput.prototype.updateVoiceButtonLabel;
  input.bindPushToTalkShortcut();
  // The session's own click toggle, as sessionCommands.js adds it.
  const sessionClick = () => calls.clicks++;
  button.addEventListener('click', sessionClick);
  const click = () => {
    const event = fire(doc, 'click', { target: button });
    if (!event.cancelBubble) button.dispatchEvent(new Event('click'));
    return event;
  };
  return { input, button, ui, calls, state, click, doc };
}

test('holding the mic with a finger starts a push-to-talk session, and letting go sends', (t) => {
  const f = fixture(t);
  assert.equal(
    f.button.style.touchAction,
    'none',
    'a held finger cannot scroll',
  );
  fire(f.button, 'pointerdown', { pointerType: 'touch', pointerId: 7 });
  assert.equal(
    f.calls.holds,
    1,
    'the map pointer is read when the finger lands',
  );
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS - 1);
  assert.deepEqual(f.calls.starts, [], 'not before the hold delay');
  t.mock.timers.tick(1);
  assert.deepEqual(f.calls.starts, [{ pushToTalk: true }]);
  assert.equal(f.input.pushToTalkKeyHeld, true);
  assert.equal(f.ui.root.dataset.pushToTalk, 'held');

  fire(f.button, 'pointerup', { pointerType: 'touch', pointerId: 7 });
  assert.equal(f.input.pushToTalkKeyHeld, false);
  assert.deepEqual(f.calls.mic, [false], 'the mic is muted on release');
  assert.equal(f.ui.root.dataset.pushToTalk, undefined);
  f.click();
  assert.equal(
    f.calls.clicks,
    0,
    'the click that ends a hold does not stop the session',
  );
  f.click();
  assert.equal(f.calls.clicks, 1, 'the next tap works the mic again');
});

test('a held finger on a push-to-talk session opens the mic, cuts the reply off and mutes on release', (t) => {
  const f = fixture(t, { active: true, pushToTalkMode: true });
  fire(f.button, 'pointerdown', { pointerType: 'touch', pointerId: 3 });
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS);
  assert.deepEqual(f.calls.starts, []);
  assert.deepEqual(f.calls.mic, [true]);
  assert.equal(f.calls.bargeIns, 1);
  assert.deepEqual(f.calls.status.at(-1), [
    'listening',
    'Release the mic to send',
  ]);
  fire(f.button, 'pointercancel', { pointerType: 'touch', pointerId: 3 });
  assert.deepEqual(f.calls.mic, [true, false]);
  assert.equal(f.input.pushToTalkKeyHeld, false);
});

test('a short tap is still a click on the mic, and an open-mic session is left to its click', (t) => {
  const f = fixture(t);
  fire(f.button, 'pointerdown', { pointerType: 'touch', pointerId: 1 });
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS - 100);
  fire(f.button, 'pointerup', { pointerType: 'touch', pointerId: 1 });
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS);
  assert.deepEqual(f.calls.starts, [], 'a tap never claims a hold');
  assert.equal(f.calls.releases, 1, 'the pointer snapshot is let go');
  f.click();
  assert.equal(f.calls.clicks, 1);

  const open = fixture(t, { active: true, pushToTalkMode: false });
  fire(open.button, 'pointerdown', { pointerType: 'touch', pointerId: 2 });
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS * 2);
  assert.deepEqual(
    open.calls.mic,
    [],
    'a click-started session is never muted',
  );
  open.click();
  assert.equal(open.calls.clicks, 1, 'the tap stops it as before');
});

test('the mouse and a second finger leave the mic as it was', (t) => {
  const f = fixture(t, { touch: false });
  fire(f.button, 'pointerdown', { pointerType: 'mouse', pointerId: 1 });
  fire(f.button, 'pointerdown', {
    pointerType: 'touch',
    pointerId: 4,
    isPrimary: false,
  });
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS * 2);
  assert.deepEqual(f.calls.starts, []);
  assert.equal(f.calls.holds, 0);
  f.click();
  assert.equal(f.calls.clicks, 1);
});

test('a phone is told to hold the mic; a computer is still told to hold Space', (t) => {
  const phone = fixture(t);
  phone.input.updateVoiceButtonLabel();
  assert.equal(phone.ui.helpDetail.textContent, 'Hold the mic to talk');
  phone.input.pushToTalkMode = true;
  phone.input.pushToTalkKeyHeld = true;
  phone.input.updateVoiceButtonLabel();
  assert.equal(phone.ui.helpDetail.textContent, 'Release the mic to send');

  const pc = fixture(t, { touch: false });
  pc.input.updateVoiceButtonLabel();
  assert.match(pc.ui.helpDetail.textContent, /Hold Space to speak/);
});

test('detaching removes the touch hold with the keyboard one', (t) => {
  const f = fixture(t);
  f.input.detachBindings();
  fire(f.button, 'pointerdown', { pointerType: 'touch', pointerId: 9 });
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS * 2);
  assert.deepEqual(f.calls.starts, []);
  assert.equal(f.input.touchButton, null);
});
