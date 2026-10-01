import assert from 'node:assert/strict';
import test from 'node:test';
import { GevRealtimeController } from './gevRealtime.js';
import {
  VOICE_PROVIDER_ORDER,
  GrokVoiceSession,
  base64ToPcm16,
  createUtteranceMonitor,
  downsampleToPcm16,
  grokAudioDelta,
  grokFunctionCalls,
  grokSessionForPushToTalk,
  grokSocketUrl,
  nextVoiceProvider,
  pcm16ToBase64,
  readStoredVoiceProvider,
  runSpokenTurn,
  startGrokVoice,
  startTurnVoice,
  voiceProviderLabel,
  writeStoredVoiceProvider,
} from './gevVoiceProviders.js';

function memoryStorage() {
  const memory = new Map();
  return {
    getItem(key) {
      return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
      memory.set(key, String(value));
    },
    removeItem(key) {
      memory.delete(key);
    },
  };
}

function installMemoryStorage() {
  const storage = memoryStorage();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });
  return {
    storage,
    restore() {
      if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
      else delete globalThis.localStorage;
    },
  };
}

test('the voice provider preference round-trips and rejects a hostile value', () => {
  const storage = memoryStorage();
  assert.equal(readStoredVoiceProvider(storage), 'openai');
  assert.equal(writeStoredVoiceProvider('anthropic', storage), 'anthropic');
  assert.equal(readStoredVoiceProvider(storage), 'anthropic');
  storage.setItem('godsEyeView.voice.provider', 'javascript:alert(1)');
  assert.equal(readStoredVoiceProvider(storage), 'openai');
  assert.equal(writeStoredVoiceProvider('not-a-provider', storage), 'openai');
});

test('the provider control cycles Claude, Custom LLM, OpenRouter, Grok, and NVIDIA', () => {
  assert.deepEqual(VOICE_PROVIDER_ORDER, [
    'openai', 'anthropic', 'custom', 'openrouter', 'xai', 'nvidia',
  ]);
  let current = 'openai';
  const seen = [];
  for (let i = 0; i < VOICE_PROVIDER_ORDER.length; i += 1) {
    current = nextVoiceProvider(current);
    seen.push(voiceProviderLabel(current));
  }
  assert.deepEqual(seen, ['CLAUDE', 'CUSTOM', 'ROUTER', 'GROK', 'NVIDIA', 'OAI']);
  assert.equal(nextVoiceProvider('nope'), 'openai');
});

test('microphone audio is downsampled to 24 kHz PCM', () => {
  const input = new Float32Array(480);
  input[0] = 0.5;
  const out = downsampleToPcm16(input, 48000, 24000);
  assert.equal(out.length, 240);
  const same = downsampleToPcm16(Float32Array.from([0.5, -0.5]), 24000, 24000);
  const back = base64ToPcm16(pcm16ToBase64(same));
  assert.equal(back.length, 2);
  assert.equal(back[0] > 0, true);
  assert.equal(back[1] < 0, true);
});

test('push-to-talk clears turn detection without editing the server session', () => {
  const session = {
    type: 'session.update',
    session: { voice: 'eve', turn_detection: { type: 'server_vad' } },
  };
  const copy = grokSessionForPushToTalk(session, true);
  assert.equal(copy.session.turn_detection, null);
  assert.deepEqual(session.session.turn_detection, { type: 'server_vad' });
  assert.equal(grokSessionForPushToTalk(session, false), session);
});

test('Grok function-call events keep one call across both shapes', () => {
  const done = grokFunctionCalls({
    type: 'response.function_call_arguments.done',
    call_id: 'c1',
    item_id: 'i1',
    name: 'zoom_to_globe',
    arguments: '{}',
  });
  const item = grokFunctionCalls({
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: 'c1',
      id: 'i1',
      name: 'zoom_to_globe',
      arguments: '{}',
    },
  });
  assert.equal(done.length, 1);
  assert.equal(item.length, 1);
  assert.equal(done[0].id, item[0].id);
  assert.equal(done[0].itemId, item[0].itemId);
  const sent = [];
  const ran = [];
  const session = new GrokVoiceSession({
    send: (message) => sent.push(message),
    sessionUpdate: {
      type: 'session.update',
      session: { voice: 'eve', turn_detection: { type: 'server_vad' } },
    },
    onTool: async (name) => {
      ran.push(name);
      return { ok: true, action: name };
    },
  });
  session.handleOpen();
  assert.equal(sent[0].type, 'session.update');
  session.handleMessage(JSON.stringify({
    type: 'response.function_call_arguments.done',
    call_id: 'c1',
    item_id: 'i1',
    name: 'zoom_to_globe',
    arguments: '{}',
  }));
  session.handleMessage(JSON.stringify({
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: 'c1',
      id: 'i1',
      name: 'zoom_to_globe',
      arguments: '{}',
    },
  }));
  return session.toolQueue.then(() => {
    assert.deepEqual(ran, ['zoom_to_globe']);
    assert.equal(sent.some((message) => message.item?.type === 'function_call_output'), true);
    assert.equal(sent.some((message) => message.type === 'response.create'), true);
  });
});

test('Grok audio deltas are read from either event name', () => {
  assert.equal(grokAudioDelta({ type: 'response.output_audio.delta', delta: 'abc' }), 'abc');
  assert.equal(grokAudioDelta({ type: 'response.audio.delta', delta: 'def' }), 'def');
  assert.equal(grokAudioDelta({ type: 'response.done' }), '');
});

test('releasing push-to-talk commits Grok audio and asks for a reply', () => {
  const sent = [];
  const session = new GrokVoiceSession({
    send: (message) => sent.push(message),
    sessionUpdate: { type: 'session.update', session: { turn_detection: { type: 'server_vad' } } },
    pushToTalk: true,
  });
  session.setMicrophoneHeld(true);
  session.setMicrophoneHeld(false);
  assert.deepEqual(sent, [
    { type: 'input_audio_buffer.commit' },
    { type: 'response.create' },
  ]);
});

test('a stopped Grok session ignores a later tool call', async () => {
  const ran = [];
  const session = new GrokVoiceSession({
    send() {},
    sessionUpdate: { type: 'session.update', session: {} },
    onTool: async (name) => {
      ran.push(name);
      return { ok: true };
    },
  });
  session.stopped = true;
  session.handleMessage(JSON.stringify({
    type: 'response.function_call_arguments.done',
    call_id: 'c9',
    name: 'zoom_to_globe',
    arguments: '{}',
  }));
  await session.toolQueue;
  assert.deepEqual(ran, []);
});

test('a spoken turn runs the tool and then returns the reply', async () => {
  const ran = [];
  let round = 0;
  const result = await runSpokenTurn({
    provider: 'anthropic',
    transcript: 'zoom out',
    post: async () => {
      round += 1;
      if (round === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'c1', name: 'zoom_to_globe', arguments: '{}' }],
          assistant: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'c1',
              type: 'function',
              function: { name: 'zoom_to_globe', arguments: '{}' },
            }],
          },
        };
      }
      return {
        text: 'Zoomed out.',
        toolCalls: [],
        assistant: { role: 'assistant', content: 'Zoomed out.' },
      };
    },
    runner: async (name) => {
      ran.push(name);
      return { ok: true, action: name };
    },
  });
  assert.deepEqual(ran, ['zoom_to_globe']);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Zoomed out.');
});

test('a cancelled spoken turn does not run the tool', async () => {
  const ran = [];
  let current = true;
  const result = await runSpokenTurn({
    provider: 'nvidia',
    transcript: 'zoom out',
    isCurrent: () => current,
    post: async () => {
      current = false;
      return {
        text: '',
        toolCalls: [{ id: 'c1', name: 'zoom_to_globe', arguments: '{}' }],
        assistant: { role: 'assistant', content: null },
      };
    },
    runner: async (name) => {
      ran.push(name);
      return { ok: true };
    },
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(ran, []);
});

test('a radio tool can end the spoken turn', async () => {
  let posts = 0;
  const result = await runSpokenTurn({
    provider: 'anthropic',
    transcript: 'play the radio',
    post: async () => {
      posts += 1;
      return {
        text: '',
        toolCalls: [{ id: 'c1', name: 'control_radio', arguments: '{"action":"play"}' }],
        assistant: { role: 'assistant', content: null },
      };
    },
    runner: async () => ({ ok: true, action: 'control_radio', radioAction: 'play' }),
    classifyRadio: () => 'stop',
  });
  assert.equal(posts, 1);
  assert.equal(result.stopVoice, true);
  assert.equal(result.text, '');
});

test('utterance detection waits for speech and then quiet', () => {
  const monitor = createUtteranceMonitor();
  assert.equal(monitor.push(0.001, 0), false);
  assert.equal(monitor.push(0.02, 50), false);
  assert.equal(monitor.push(0.02, 200), false);
  assert.equal(monitor.push(0, 300), false);
  assert.equal(monitor.push(0, 1000), true);
});

test('the Grok socket URL stays on api.x.ai', () => {
  const url = 'wss://api.x.ai/v1/realtime?model=grok-voice-latest';
  assert.equal(grokSocketUrl(url), url);
  assert.equal(grokSocketUrl('wss://evil.example/v1/realtime'), '');
  assert.equal(grokSocketUrl('https://api.x.ai/v1/realtime'), '');
  assert.equal(grokSocketUrl('wss://api.x.ai/v1/other'), '');
});

function fakeMic() {
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  return {
    track,
    getTracks() { return [track]; },
    getAudioTracks() { return [track]; },
  };
}

class FakeGrokSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    FakeGrokSocket.latest = this;
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

class FakeGrokAudio {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = {};
  }

  resume() { return Promise.resolve(); }

  close() { return Promise.resolve(); }

  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }

  createScriptProcessor() {
    return { connect() {}, disconnect() {}, onaudioprocess: null };
  }

  createGain() {
    return { gain: { value: 0 }, connect() {}, disconnect() {} };
  }

  createBuffer() {
    return { duration: 0, getChannelData: () => ({ set() {} }) };
  }

  createBufferSource() {
    return { buffer: null, connect() {}, start() {} };
  }
}

function grokSessionBody() {
  return {
    url: 'wss://api.x.ai/v1/realtime?model=grok-voice-latest',
    value: 'ephemeral-voice-value',
    sampleRate: 24000,
    sessionUpdate: {
      type: 'session.update',
      session: { voice: 'eve', turn_detection: { type: 'server_vad' } },
    },
  };
}

test('Grok voice sends the session once and runs one tool', async () => {
  const ran = [];
  const stream = fakeMic();
  const transport = await startGrokVoice({
    provider: 'xai',
    isCurrent: () => true,
    pushToTalk: false,
    fetch: async () => new Response(JSON.stringify(grokSessionBody()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    getUserMedia: async () => stream,
    WebSocket: FakeGrokSocket,
    AudioContext: FakeGrokAudio,
    runner: async (name) => {
      ran.push(name);
      return { ok: true, action: name };
    },
  });
  assert.equal(FakeGrokSocket.latest.protocols[0], 'xai-client-secret.ephemeral-voice-value');
  assert.equal(FakeGrokSocket.latest.sent[0].type, 'session.update');
  assert.equal(FakeGrokSocket.latest.sent[0].session.turn_detection.type, 'server_vad');
  FakeGrokSocket.latest.onmessage({
    data: JSON.stringify({
      type: 'response.function_call_arguments.done',
      call_id: 'c1',
      item_id: 'i1',
      name: 'zoom_to_globe',
      arguments: '{}',
    }),
  });
  FakeGrokSocket.latest.onmessage({
    data: JSON.stringify({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'c1',
        id: 'i1',
        name: 'zoom_to_globe',
        arguments: '{}',
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ran, ['zoom_to_globe']);
  assert.equal(
    FakeGrokSocket.latest.sent.some((message) => message.item?.type === 'function_call_output'),
    true,
  );
  transport.stop();
  const before = ran.length;
  FakeGrokSocket.latest.onmessage({
    data: JSON.stringify({
      type: 'response.function_call_arguments.done',
      call_id: 'c2',
      name: 'zoom_to_globe',
      arguments: '{}',
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran.length, before);
  assert.equal(stream.track.stopped, true);
});

test('Grok push-to-talk release commits the buffer', async () => {
  const transport = await startGrokVoice({
    provider: 'xai',
    isCurrent: () => true,
    pushToTalk: true,
    initiallyHeld: false,
    fetch: async () => new Response(JSON.stringify(grokSessionBody()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    getUserMedia: async () => fakeMic(),
    WebSocket: FakeGrokSocket,
    AudioContext: FakeGrokAudio,
    runner: async () => ({ ok: true }),
  });
  const sent = FakeGrokSocket.latest.sent;
  assert.equal(sent[0].session.turn_detection, null);
  assert.deepEqual(grokSessionBody().sessionUpdate.session.turn_detection, { type: 'server_vad' });
  transport.setMicrophoneHeld(true);
  transport.setMicrophoneHeld(false);
  assert.deepEqual(sent.slice(-2), [
    { type: 'input_audio_buffer.commit' },
    { type: 'response.create' },
  ]);
  transport.stop();
});

test('a Grok session URL off api.x.ai is refused before the microphone opens', async () => {
  let opened = false;
  await assert.rejects(
    () => startGrokVoice({
      provider: 'xai',
      isCurrent: () => true,
      fetch: async () => new Response(JSON.stringify({
        url: 'wss://evil.example/v1/realtime',
        value: 'ephemeral-voice-value',
        sessionUpdate: { type: 'session.update', session: {} },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      getUserMedia: async () => {
        opened = true;
        return fakeMic();
      },
      WebSocket: FakeGrokSocket,
      AudioContext: FakeGrokAudio,
    }),
    /did not return a session/,
  );
  assert.equal(opened, false);
});

test('a browser that cannot capture PCM closes the microphone', async () => {
  const stream = fakeMic();
  class DeafAudio extends FakeGrokAudio {
    createScriptProcessor = undefined;
  }
  await assert.rejects(
    () => startGrokVoice({
      provider: 'xai',
      isCurrent: () => true,
      fetch: async () => new Response(JSON.stringify(grokSessionBody()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      getUserMedia: async () => stream,
      WebSocket: FakeGrokSocket,
      AudioContext: DeafAudio,
    }),
    /cannot capture microphone audio/,
  );
  assert.equal(stream.track.stopped, true);
});

test('a custom endpoint without audio routes starts browser speech', async () => {
  let started = 0;
  let liveAudio = null;
  class FakeAudio {
    constructor() {
      liveAudio = this;
      this.currentTime = 0;
      this.sampleRate = 48000;
      this.destination = {};
    }

    resume() { return Promise.resolve(); }

    close() { return Promise.resolve(); }

    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }

    createAnalyser() {
      return {
        fftSize: 1024,
        getFloatTimeDomainData(buffer) {
          buffer.fill(liveAudio.currentTime < 0.35 ? 0.2 : 0);
        },
      };
    }
  }
  class FakeRecorder {
    constructor(_stream, options) {
      this.mimeType = options?.mimeType || 'audio/webm';
    }

    static isTypeSupported() { return true; }

    start() {
      this.ondataavailable?.({ data: new Blob([Uint8Array.from([1, 2, 3, 4])]) });
    }

    stop() {
      this.onstop?.();
    }
  }
  class FakeRecognition {
    start() { started += 1; }

    stop() {}
  }
  const calls = [];
  const transport = await startTurnVoice({
    provider: 'custom',
    isCurrent: () => true,
    pushToTalk: false,
    getUserMedia: async () => fakeMic(),
    AudioContext: FakeAudio,
    MediaRecorder: FakeRecorder,
    SpeechRecognition: FakeRecognition,
    requestAnimationFrame(fn) {
      if (liveAudio) liveAudio.currentTime += 0.1;
      fn();
    },
    fetch: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        browserSpeech: true,
        error: 'This endpoint has no transcription route. The browser will listen.',
      }), { status: 501, headers: { 'content-type': 'application/json' } });
    },
  });
  for (let i = 0; i < 20 && started === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(started, 1);
  assert.equal(calls.includes('/api/llm/voice/transcribe'), true);
  transport.stop();
});

test('Claude on the mic uses the spoken turn and not the OpenAI realtime call', async () => {
  const installed = installMemoryStorage();
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousRecognition = globalThis.SpeechRecognition;
  const previousMedia = globalThis.navigator?.mediaDevices;
  const calls = [];
  let recognition = null;
  class FakeRecognition {
    start() { recognition = this; }

    stop() {}
  }
  writeStoredVoiceProvider('anthropic');
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? String(init.body) : '' });
    if (String(url) === '/api/llm/voice/turn') {
      return new Response(JSON.stringify({
        text: 'Zoomed out.',
        toolCalls: [],
        assistant: { role: 'assistant', content: 'Zoomed out.' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 204 });
  };
  globalThis.SpeechRecognition = FakeRecognition;
  globalThis.window = previousWindow || {};
  const ui = {
    root: {
      dataset: {},
      classList: { add() {}, remove() {} },
      querySelectorAll: () => [],
    },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    buttonLabel: { textContent: '' },
    tierButton: {
      textContent: '',
      title: '',
      hidden: false,
      setAttribute() {},
    },
    providerButton: { textContent: '', title: '' },
    costValue: { textContent: '', title: '', dataset: {}, hidden: false },
  };
  const controller = new GevRealtimeController({
    ui,
    runner: async () => ({ ok: true }),
  });
  controller.debugLog = () => {};
  try {
    if (globalThis.navigator) globalThis.navigator.mediaDevices = {
      getUserMedia: async () => fakeMic(),
    };
    await controller.start({ pushToTalk: false });
    assert.equal(controller.status, 'listening', ui.detail.textContent);
    controller.syncCostUi();
    assert.equal(ui.providerButton.textContent, 'CLAUDE');
    assert.equal(ui.tierButton.hidden, true);
    assert.equal(ui.costValue.hidden, true);
    recognition.onresult({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: 'zoom out' } }],
    });
    for (let i = 0; i < 20 && !calls.some((call) => call.url === '/api/llm/voice/turn'); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const turn = calls.find((call) => call.url === '/api/llm/voice/turn');
    assert.equal(Boolean(turn), true);
    assert.equal(turn.body.includes('zoom out'), true);
    assert.equal(turn.body.includes('"provider":"anthropic"'), true);
    assert.equal(calls.some((call) => call.url.includes('api.openai.com')), false);
    assert.equal(calls.some((call) => call.url === '/api/realtime/token'), false);
    controller.cycleVoiceProvider();
    assert.equal(controller.status, 'idle');
    assert.equal(readStoredVoiceProvider(), 'custom');
  } finally {
    controller.stop();
    globalThis.fetch = previousFetch;
    globalThis.SpeechRecognition = previousRecognition;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (globalThis.navigator) {
      if (previousMedia === undefined) delete globalThis.navigator.mediaDevices;
      else globalThis.navigator.mediaDevices = previousMedia;
    }
    installed.restore();
  }
});
