/**
 * Voice providers beside OpenAI.
 *
 * Grok opens a realtime socket with a short-lived secret and runs the same
 * map tools in the browser. Claude, NVIDIA, OpenRouter, and a custom endpoint
 * take one spoken turn at a time: hear, run those tools, speak. Keys stay on
 * the server. This file never imports a Node built-in.
 */

const VOICE_PROVIDER_STORAGE_KEY = 'godsEyeView.voice.provider';

export const VOICE_PROVIDER_ORDER = Object.freeze([
  'openai',
  'anthropic',
  'custom',
  'openrouter',
  'xai',
  'nvidia',
]);

const VOICE_PROVIDER_IDS = new Set(VOICE_PROVIDER_ORDER);

const VOICE_PROVIDER_LABELS = Object.freeze({
  openai: 'OAI',
  anthropic: 'CLAUDE',
  custom: 'CUSTOM',
  openrouter: 'ROUTER',
  xai: 'GROK',
  nvidia: 'NVIDIA',
});

const VOICE_PROVIDER_NAMES = Object.freeze({
  openai: 'OpenAI',
  anthropic: 'Claude',
  custom: 'Custom LLM',
  openrouter: 'OpenRouter',
  xai: 'Grok',
  nvidia: 'NVIDIA',
});

function voiceStorage(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function voiceProviderLabel(providerId) {
  return VOICE_PROVIDER_LABELS[providerId] || VOICE_PROVIDER_LABELS.openai;
}

export function voiceProviderFullName(providerId) {
  return VOICE_PROVIDER_NAMES[providerId] || VOICE_PROVIDER_NAMES.openai;
}

export function voiceProviderTitle(providerId) {
  const name = voiceProviderFullName(providerId);
  if (providerId === 'openai') {
    return 'Voice provider: OpenAI. Click for Claude, Custom LLM, OpenRouter, Grok, or NVIDIA. The spend cap stays on OpenAI.';
  }
  if (providerId === 'xai') {
    return `${name} is live voice. The key stays on this machine. Billed by xAI. Click for another provider.`;
  }
  if (providerId === 'openrouter') {
    return `${name} transcribes, runs the map tools, and speaks. Billed by OpenRouter. Click for another provider.`;
  }
  if (providerId === 'custom') {
    return `${name} uses the endpoint's audio routes when they exist, and this browser's speech when they do not. Click for another provider.`;
  }
  if (providerId === 'anthropic') {
    return `${name} runs the map tools. This browser hears and speaks. Click for another provider.`;
  }
  return `${name} runs the map tools. This browser hears and speaks. Click for another provider.`;
}

export function readStoredVoiceProvider(storage) {
  try {
    const raw = voiceStorage(storage)?.getItem(VOICE_PROVIDER_STORAGE_KEY);
    return VOICE_PROVIDER_IDS.has(raw) ? raw : 'openai';
  } catch {
    return 'openai';
  }
}

export function writeStoredVoiceProvider(providerId, storage) {
  const stored = VOICE_PROVIDER_IDS.has(providerId) ? providerId : 'openai';
  try {
    voiceStorage(storage)?.setItem(VOICE_PROVIDER_STORAGE_KEY, stored);
  } catch {
    /* best effort */
  }
  return stored;
}

export function nextVoiceProvider(providerId) {
  const index = VOICE_PROVIDER_ORDER.indexOf(providerId);
  const next = index < 0 ? 0 : (index + 1) % VOICE_PROVIDER_ORDER.length;
  return VOICE_PROVIDER_ORDER[next];
}

/** Accept only the xAI realtime socket, so the ephemeral token cannot be sent elsewhere. */
export function grokSocketUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:') return '';
    if (parsed.hostname !== 'api.x.ai') return '';
    if (parsed.pathname !== '/v1/realtime') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function grokSessionForPushToTalk(sessionUpdate, pushToTalk) {
  if (!pushToTalk || !sessionUpdate?.session) return sessionUpdate;
  return {
    ...sessionUpdate,
    session: { ...sessionUpdate.session, turn_detection: null },
  };
}

export function grokFunctionCalls(event) {
  if (!event) return [];
  if (event.type === 'response.function_call_arguments.done' && event.name) {
    return [{
      id: event.call_id || '',
      itemId: event.item_id || '',
      name: event.name,
      arguments: event.arguments || '{}',
    }];
  }
  if (event.type === 'response.output_item.done' && event.item?.type === 'function_call' && event.item.name) {
    return [{
      id: event.item.call_id || '',
      itemId: event.item.id || '',
      name: event.item.name,
      arguments: event.item.arguments || '{}',
    }];
  }
  return [];
}

export function grokAudioDelta(event) {
  if (!event) return '';
  if (event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') {
    return event.delta || event.audio || '';
  }
  return '';
}

function floatSampleToInt16(sample) {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

export function downsampleToPcm16(float32, inputRate, outputRate = 24000) {
  const input = float32?.length || 0;
  const inRate = Number(inputRate);
  const outRate = Number(outputRate);
  if (!input || !inRate || !outRate) return new Int16Array(0);
  if (inRate === outRate) {
    const same = new Int16Array(input);
    for (let i = 0; i < input; i += 1) same[i] = floatSampleToInt16(float32[i]);
    return same;
  }
  const ratio = inRate / outRate;
  const length = Math.max(0, Math.floor(input / ratio));
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += float32[j];
    out[i] = floatSampleToInt16(end > start ? sum / (end - start) : 0);
  }
  return out;
}

export function bytesToBase64(bytes) {
  if (!bytes?.length) return '';
  const chunk = 0x4000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunk));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

export function pcm16ToBase64(int16) {
  if (!int16?.length) return '';
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  return bytesToBase64(bytes);
}

export function base64ToPcm16(value) {
  if (typeof value !== 'string' || !value) return new Int16Array(0);
  const binary = atob(value);
  const length = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export function rmsLevel(samples) {
  const count = samples?.length || 0;
  if (!count) return 0;
  let sum = 0;
  for (let i = 0; i < count; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / count);
}

/**
 * End an utterance after speech followed by quiet. Times are milliseconds
 * from the start of the recording.
 */
export function createUtteranceMonitor({ speech = 0.015, silenceMs = 700, minSpeechMs = 200 } = {}) {
  let speaking = false;
  let speechAt = 0;
  let silenceAt = 0;
  return {
    push(level, now) {
      if (level >= speech) {
        if (!speaking) speechAt = now;
        speaking = true;
        silenceAt = 0;
        return false;
      }
      if (!speaking) return false;
      if (!silenceAt) silenceAt = now;
      return now - silenceAt >= silenceMs && now - speechAt >= minSpeechMs;
    },
    reset() {
      speaking = false;
      speechAt = 0;
      silenceAt = 0;
    },
  };
}

export function trimVoiceHistory(messages, max = 24) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= max) return list.slice();
  const slice = list.slice(list.length - max);
  while (slice.length && slice[0].role !== 'user') slice.shift();
  return slice;
}

/**
 * One spoken turn: post the transcript, run each tool in the browser, post
 * the results, and stop when the model answers in words.
 */
export async function runSpokenTurn({
  provider,
  transcript = '',
  history = [],
  post,
  runner,
  isCurrent = () => true,
  classifyRadio = () => '',
  maxRounds = 6,
} = {}) {
  const messages = trimVoiceHistory(history);
  const spoken = String(transcript || '').trim();
  if (spoken) messages.push({ role: 'user', content: spoken });
  if (!messages.length) {
    return { ok: false, error: 'A spoken turn needs words.', messages };
  }
  let pendingRadio = null;
  for (let round = 0; round < maxRounds; round += 1) {
    if (!isCurrent()) return { ok: false, cancelled: true, messages };
    const data = await post({ provider, messages: trimVoiceHistory(messages) });
    if (!data || data.error) {
      return { ok: false, error: data?.error || 'The model did not answer.', messages };
    }
    if (data.assistant) messages.push(data.assistant);
    const calls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
    if (!calls.length) {
      return {
        ok: true,
        text: String(data.text || '').trim(),
        messages,
        pendingRadio,
      };
    }
    for (const call of calls) {
      if (!isCurrent()) return { ok: false, cancelled: true, messages };
      let args = {};
      if (typeof call.arguments === 'string') {
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          args = {};
        }
      } else if (call.arguments && typeof call.arguments === 'object') {
        args = call.arguments;
      }
      let result;
      try {
        result = await runner(call.name, args);
      } catch (error) {
        result = {
          ok: false,
          error: error?.message || 'GEV command failed',
          tool: call.name,
        };
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result ?? { ok: false }),
      });
      const kind = classifyRadio(result);
      if (kind === 'stop') {
        return { ok: true, stopVoice: true, lastResult: result, text: '', messages };
      }
      if (kind === 'playback') pendingRadio = result;
    }
  }
  return {
    ok: false,
    error: 'The model kept calling tools without a spoken answer.',
    messages,
  };
}

/**
 * Grok's browser-side event loop. The socket itself is owned by the caller.
 * Tool calls are answered with the same function_call_output shape OpenAI uses.
 */
export class GrokVoiceSession {
  constructor({
    send,
    sessionUpdate,
    pushToTalk = false,
    onTool,
    onAudio,
    onSpeaker,
    onRadioReady,
    onStopVoice,
    classifyRadio,
  } = {}) {
    this.send = send;
    this.sessionUpdate = grokSessionForPushToTalk(sessionUpdate, pushToTalk);
    this.pushToTalk = Boolean(pushToTalk);
    this.sending = !this.pushToTalk;
    this.onTool = onTool;
    this.onAudio = onAudio;
    this.onSpeaker = onSpeaker;
    this.onRadioReady = onRadioReady;
    this.onStopVoice = onStopVoice;
    this.classifyRadio = classifyRadio;
    this.processed = new Set();
    this.stopped = false;
    this.pendingRadio = null;
    this.followupStarted = false;
    this.toolQueue = Promise.resolve();
  }

  handleOpen() {
    if (this.stopped) return;
    this.send(this.sessionUpdate);
  }

  appendPcm(int16) {
    if (this.stopped || !this.sending || !int16?.length) return false;
    this.send({ type: 'input_audio_buffer.append', audio: pcm16ToBase64(int16) });
    return true;
  }

  setMicrophoneHeld(held) {
    const next = Boolean(held);
    const was = this.sending;
    this.sending = this.pushToTalk ? next : true;
    if (this.pushToTalk && was && !next && !this.stopped) {
      this.send({ type: 'input_audio_buffer.commit' });
      this.send({ type: 'response.create' });
    }
  }

  handleMessage(raw) {
    if (this.stopped || typeof raw !== 'string') return;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const audio = grokAudioDelta(event);
    if (audio) {
      this.onSpeaker?.('ai');
      this.onAudio?.(base64ToPcm16(audio));
      return;
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      this.onSpeaker?.('user');
      return;
    }
    if (event.type === 'response.created' && this.pendingRadio) this.followupStarted = true;
    if (event.type === 'response.done' && this.followupStarted && this.pendingRadio) {
      this.followupStarted = false;
      const pending = this.pendingRadio;
      this.pendingRadio = null;
      this.onRadioReady?.(pending);
      return;
    }
    for (const call of grokFunctionCalls(event)) this.queueTool(call);
  }

  queueTool(call) {
    const keys = [call.id, call.itemId].filter(Boolean);
    if (!keys.length || keys.some((key) => this.processed.has(key))) return;
    for (const key of keys) {
      this.processed.add(key);
      if (this.processed.size > 200) {
        this.processed.delete(this.processed.values().next().value);
      }
    }
    this.toolQueue = this.toolQueue.then(() => this.runTool(call)).catch(() => {});
  }

  async runTool(call) {
    if (this.stopped) return;
    let args = {};
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      args = {};
    }
    let result;
    try {
      result = await this.onTool?.(call.name, args);
    } catch (error) {
      result = { ok: false, error: error?.message || 'GEV command failed', tool: call.name };
    }
    if (this.stopped) return;
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: call.id,
        output: JSON.stringify(result ?? { ok: false }),
      },
    });
    const kind = this.classifyRadio?.(result) || '';
    if (kind === 'stop') {
      this.onStopVoice?.(result);
      return;
    }
    if (kind === 'playback') this.pendingRadio = result;
    this.send({ type: 'response.create' });
  }
}

async function readJsonResponse(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      typeof data?.error === 'string' ? data.error : `Voice request failed: HTTP ${response.status}`,
    );
    error.browserSpeech = Boolean(data?.browserSpeech);
    error.status = response.status;
    throw error;
  }
  return data;
}

function voiceFetch(host) {
  return host.fetch || globalThis.fetch.bind(globalThis);
}

async function postJson(host, path, body) {
  const response = await voiceFetch(host)(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return readJsonResponse(response);
}

export function speakWithSynthesis(text, synth = globalThis.speechSynthesis) {
  const spoken = String(text || '').trim();
  const Utter = globalThis.SpeechSynthesisUtterance;
  if (!synth || !Utter || !spoken) return Promise.resolve(false);
  return new Promise((resolve) => {
    const utter = new Utter(spoken);
    utter.onend = () => resolve(true);
    utter.onerror = () => resolve(false);
    try {
      synth.cancel();
      synth.speak(utter);
    } catch {
      resolve(false);
    }
  });
}

function audioFormatFromMime(mime) {
  const text = String(mime || '').toLowerCase();
  if (text.includes('wav')) return 'wav';
  if (text.includes('mpeg') || text.includes('mp3')) return 'mp3';
  if (text.includes('ogg')) return 'ogg';
  if (text.includes('flac')) return 'flac';
  if (text.includes('mp4') || text.includes('m4a')) return 'mp4';
  return 'webm';
}

function blobToBase64(blob) {
  return blob.arrayBuffer().then((buffer) => bytesToBase64(new Uint8Array(buffer)));
}

function classifyFromHost(host) {
  return (result) => host.classifyRadio?.(result) || '';
}

async function openMicrophone(host) {
  if (typeof host.getUserMedia !== 'function') {
    throw new Error('Microphone support is unavailable.');
  }
  const stream = await host.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  if (!host.isCurrent()) {
    stream.getTracks?.().forEach((track) => track.stop());
    return null;
  }
  host.setStream?.(stream);
  return stream;
}

function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => {
    try { track.stop(); } catch { /* already stopped */ }
  });
}

/**
 * Live Grok session. Resolves once the socket is open.
 * @returns {Promise<{stop: Function, setMicrophoneHeld: Function}|null>}
 */
export function startGrokVoice(host) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let detachMic = () => {};
    let audioContext = null;
    let socket = null;
    let micStream = null;
    let connectTimer = null;
    const clearConnectTimer = () => {
      if (!connectTimer) return;
      clearTimeout(connectTimer);
      connectTimer = null;
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearConnectTimer();
      resolve(value);
    };
    const fail = (error) => {
      if (stopped) return;
      stopped = true;
      clearConnectTimer();
      detachMic();
      detachMic = () => {};
      try { socket?.close(); } catch { /* closing */ }
      try { audioContext?.close(); } catch { /* closing */ }
      stopStream(micStream);
      const wrapped = error instanceof Error ? error : new Error(String(error || 'Grok voice failed.'));
      if (!settled) {
        settled = true;
        reject(wrapped);
        return;
      }
      host.fail?.(wrapped);
    };
    postJson(host, '/api/llm/voice/session', { provider: 'xai' }).then(async (session) => {
      if (!host.isCurrent()) {
        finish(null);
        return;
      }
      const url = grokSocketUrl(session?.url);
      if (!url || typeof session?.value !== 'string' || !session.value) {
        throw new Error('Grok voice did not return a session.');
      }
      if (!session.sessionUpdate || session.sessionUpdate.type !== 'session.update') {
        throw new Error('Grok voice did not return a session.');
      }
      const Socket = host.WebSocket || globalThis.WebSocket;
      const AudioCtx = host.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Socket || !AudioCtx) throw new Error('This browser cannot open a Grok voice socket.');
      const stream = await openMicrophone(host);
      if (!stream || !host.isCurrent()) {
        stopStream(stream);
        finish(null);
        return;
      }
      micStream = stream;
      audioContext = new AudioCtx();
      await audioContext.resume?.().catch(() => {});
      if (!host.isCurrent()) {
        stopStream(micStream);
        try { audioContext.close?.(); } catch { /* closing */ }
        finish(null);
        return;
      }
      const sessionApi = new GrokVoiceSession({
        send: (message) => {
          if (socket?.readyState === 1) socket.send(JSON.stringify(message));
        },
        sessionUpdate: session.sessionUpdate,
        pushToTalk: host.pushToTalk,
        onTool: (name, args) => host.runner(name, args),
        onAudio: (pcm) => playPcm(audioContext, session.sampleRate || 24000, pcm),
        onSpeaker: (speaker) => host.setSpeaker?.(speaker),
        onRadioReady: (result) => host.finishRadio?.(result),
        onStopVoice: () => host.stopForRadio?.(),
        classifyRadio: classifyFromHost(host),
      });
      if (host.pushToTalk) sessionApi.sending = Boolean(host.initiallyHeld);
      detachMic = attachMicPcm(audioContext, micStream, (pcm) => sessionApi.appendPcm(pcm));
      const transport = {
        stop() {
          stopped = true;
          sessionApi.stopped = true;
          clearConnectTimer();
          detachMic();
          detachMic = () => {};
          try { socket?.close(); } catch { /* closing */ }
          try { audioContext?.close(); } catch { /* closing */ }
          stopStream(micStream);
        },
        setMicrophoneHeld(held) {
          sessionApi.setMicrophoneHeld(held);
        },
      };
      socket = new Socket(url, [`xai-client-secret.${session.value}`]);
      socket.onopen = () => {
        if (stopped || !host.isCurrent()) {
          try { socket.close(); } catch { /* closing */ }
          stopStream(micStream);
          finish(null);
          return;
        }
        sessionApi.handleOpen();
        finish(transport);
      };
      socket.onmessage = (event) => {
        if (typeof event?.data === 'string') sessionApi.handleMessage(event.data);
      };
      socket.onerror = () => fail(new Error('Grok voice connection failed.'));
      socket.onclose = () => {
        if (!stopped) fail(new Error('Grok voice disconnected.'));
      };
      if (!settled && !stopped) {
        connectTimer = setTimeout(() => {
          if (!settled && !stopped) fail(new Error('Grok voice did not connect.'));
        }, 15000);
      }
    }).catch((error) => {
      fail(error);
    });
  });
}

const pcmQueues = new WeakMap();

function playPcm(audioContext, sampleRate, pcm) {
  if (!audioContext || !pcm?.length) return;
  let nextTime = pcmQueues.get(audioContext) || 0;
  const floats = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) floats[i] = pcm[i] / 32768;
  const buffer = audioContext.createBuffer(1, floats.length, sampleRate);
  buffer.getChannelData(0).set(floats);
  const node = audioContext.createBufferSource();
  node.buffer = buffer;
  node.connect(audioContext.destination);
  const startAt = Math.max(audioContext.currentTime || 0, nextTime);
  node.start(startAt);
  nextTime = startAt + buffer.duration;
  pcmQueues.set(audioContext, nextTime);
}

function attachMicPcm(audioContext, stream, onPcm) {
  const source = audioContext.createMediaStreamSource(stream);
  if (typeof audioContext.createScriptProcessor !== 'function') {
    throw new Error('This browser cannot capture microphone audio for Grok.');
  }
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    onPcm(downsampleToPcm16(input, audioContext.sampleRate || 48000, 24000));
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioContext.destination);
  return () => {
    processor.onaudioprocess = null;
    try { source.disconnect(); } catch { /* already disconnected */ }
    try { processor.disconnect(); } catch { /* already disconnected */ }
    try { mute.disconnect(); } catch { /* already disconnected */ }
  };
}

function startBrowserListener(host, onFinal) {
  const Ctor = host.SpeechRecognition
    || globalThis.SpeechRecognition
    || globalThis.webkitSpeechRecognition;
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = false;
  let paused = host.pushToTalk && !host.initiallyHeld;
  let stopped = false;
  recognition.onresult = (event) => {
    if (paused || stopped) return;
    for (let i = event.resultIndex || 0; i < event.results.length; i += 1) {
      if (!event.results[i].isFinal) continue;
      const text = String(event.results[i][0]?.transcript || '').trim();
      if (text) onFinal(text);
    }
  };
  recognition.onerror = (event) => {
    const code = event?.error || '';
    if (code === 'no-speech' || code === 'aborted') return;
    if (!stopped) host.fail?.(new Error(code === 'not-allowed'
      ? 'Microphone permission was denied.'
      : 'Speech recognition failed.'));
  };
  recognition.onend = () => {
    if (stopped || paused || !host.isCurrent()) return;
    try { recognition.start(); } catch { /* already started */ }
  };
  if (!paused) {
    try { recognition.start(); } catch { /* start races are benign */ }
  }
  return {
    stop() {
      stopped = true;
      recognition.onend = null;
      try { recognition.stop(); } catch { /* already stopped */ }
    },
    setMicrophoneHeld(held) {
      if (!host.pushToTalk) return;
      if (held && paused) {
        paused = false;
        try { recognition.start(); } catch { /* already started */ }
      } else if (!held && !paused) {
        paused = true;
        try { recognition.stop(); } catch { /* already stopped */ }
      }
    },
  };
}

async function recordUtterance(host, stream, audioContext, heldOnly) {
  const Recorder = host.MediaRecorder || globalThis.MediaRecorder;
  if (!Recorder || typeof audioContext?.createMediaStreamSource !== 'function') {
    throw new Error('This browser cannot record audio for that provider.');
  }
  const mime = Recorder.isTypeSupported?.('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (Recorder.isTypeSupported?.('audio/webm') ? 'audio/webm' : '');
  const recorder = mime ? new Recorder(stream, { mimeType: mime }) : new Recorder(stream);
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  const monitor = createUtteranceMonitor();
  recorder.start();
  const started = audioContext.currentTime || 0;
  const frame = host.requestAnimationFrame || globalThis.requestAnimationFrame;
  const heard = await new Promise((resolve) => {
    const tick = () => {
      if (!host.isCurrent()) {
        try { recorder.stop(); } catch { /* stopped */ }
        resolve(false);
        return;
      }
      if (heldOnly && !host.isHeld?.()) {
        try { recorder.onstop = () => resolve(monitor.push(0, 10_000) || chunks.length > 0); } catch { /* ignore */ }
        try { recorder.stop(); } catch { resolve(false); }
        return;
      }
      analyser.getFloatTimeDomainData?.(data);
      const nowMs = ((audioContext.currentTime || 0) - started) * 1000;
      if (!heldOnly && monitor.push(rmsLevel(data), nowMs)) {
        recorder.onstop = () => resolve(true);
        try { recorder.stop(); } catch { resolve(false); }
        return;
      }
      if (nowMs > 20_000) {
        recorder.onstop = () => resolve(false);
        try { recorder.stop(); } catch { resolve(false); }
        return;
      }
      if (typeof frame === 'function') frame(tick);
      else setTimeout(tick, 50);
    };
    if (typeof frame === 'function') frame(tick);
    else setTimeout(tick, 50);
  });
  try { source.disconnect(); } catch { /* already disconnected */ }
  if (!heard) return null;
  const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
  if (!blob.size) return null;
  return blob;
}

async function speakReply(host, speech, text) {
  const spoken = String(text || '').trim();
  if (!spoken) return speech;
  if (speech.speak === 'browser') {
    await speakWithSynthesis(spoken, host.speechSynthesis);
    return speech;
  }
  try {
    const response = await voiceFetch(host)('/api/llm/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: host.provider, text: spoken }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const error = new Error(typeof data?.error === 'string' ? data.error : 'Speech failed.');
      error.browserSpeech = Boolean(data?.browserSpeech);
      throw error;
    }
    const bytes = await response.arrayBuffer();
    const mime = response.headers?.get?.('content-type') || 'audio/mpeg';
    await playAudioBytes(bytes, mime, host);
  } catch (error) {
    if (speech.browserFallback && error?.browserSpeech) {
      const next = { ...speech, speak: 'browser', transcribe: 'browser' };
      await speakWithSynthesis(spoken, host.speechSynthesis);
      return next;
    }
    throw error;
  }
  return speech;
}

function playAudioBytes(bytes, mime, host) {
  const URLImpl = host.URL || globalThis.URL;
  const AudioImpl = host.Audio || globalThis.Audio;
  if (!URLImpl || !AudioImpl) return speakWithSynthesis('', null);
  const blob = new Blob([bytes], { type: mime || 'audio/mpeg' });
  const url = URLImpl.createObjectURL(blob);
  const audio = new AudioImpl(url);
  return new Promise((resolve) => {
    const done = () => {
      try { URLImpl.revokeObjectURL(url); } catch { /* already revoked */ }
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

export async function startTurnVoice(host) {
  const stream = await openMicrophone(host);
  if (!stream) return null;
  let speech = {
    ...(host.speechPlan || {}),
  };
  if (!speech.mode) {
    speech = {
      mode: 'turn',
      transcribe: host.provider === 'openrouter' || host.provider === 'custom' ? 'server' : 'browser',
      speak: host.provider === 'openrouter' || host.provider === 'custom' ? 'server' : 'browser',
      browserFallback: host.provider === 'custom',
    };
  }
  let stopped = false;
  let busy = false;
  let history = [];
  let listener = null;
  let audioContext = null;
  let held = Boolean(host.initiallyHeld);
  const isHeld = () => held;
  const localHost = { ...host, isHeld };

  async function consume(text) {
    if (stopped || busy || !host.isCurrent() || !String(text || '').trim()) return;
    busy = true;
    host.setStatus?.('executing', 'Running command');
    try {
      const outcome = await runSpokenTurn({
        provider: host.provider,
        transcript: text,
        history,
        post: (body) => postJson(host, '/api/llm/voice/turn', body),
        runner: (name, args) => host.runner(name, args),
        isCurrent: () => !stopped && host.isCurrent(),
        classifyRadio: classifyFromHost(host),
      });
      history = outcome.messages || history;
      if (stopped || !host.isCurrent()) return;
      if (!outcome.ok) {
        host.fail?.(new Error(outcome.error || 'Voice turn failed.'));
        stopped = true;
        return;
      }
      if (outcome.text) speech = await speakReply(localHost, speech, outcome.text);
      if (stopped || !host.isCurrent()) return;
      if (outcome.pendingRadio) await host.finishRadio?.(outcome.pendingRadio);
      else if (outcome.stopVoice) host.stopForRadio?.(outcome.lastResult);
      else host.setStatus?.('listening', host.pushToTalk ? 'Hold Space to talk' : 'Ask or command');
    } catch (error) {
      if (!stopped && host.isCurrent()) host.fail?.(error);
      stopped = true;
    } finally {
      busy = false;
    }
  }

  async function serverLoop() {
    const AudioCtx = host.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtx) throw new Error('This browser cannot record audio for that provider.');
    audioContext = new AudioCtx();
    await audioContext.resume?.().catch(() => {});
    while (!stopped && host.isCurrent() && speech.transcribe === 'server') {
      if (host.pushToTalk && !held) {
        await new Promise((resolve) => { setTimeout(resolve, 40); });
        continue;
      }
      const blob = await recordUtterance(localHost, stream, audioContext, host.pushToTalk);
      if (!blob || stopped || !host.isCurrent()) continue;
      if (speech.transcribe !== 'server') break;
      const audioBase64 = await blobToBase64(blob);
      try {
        const data = await postJson(host, '/api/llm/voice/transcribe', {
          provider: host.provider,
          audioBase64,
          format: audioFormatFromMime(blob.type),
        });
        if (data?.text) await consume(data.text);
      } catch (error) {
        if (speech.browserFallback && error?.browserSpeech) {
          speech = { ...speech, transcribe: 'browser', speak: 'browser' };
          break;
        }
        throw error;
      }
    }
    if (stopped || !host.isCurrent() || speech.transcribe !== 'browser' || listener) return;
    try { await audioContext?.close?.(); } catch { /* closing */ }
    audioContext = null;
    listener = startBrowserListener({ ...host, initiallyHeld: held }, consume);
    if (!listener) {
      const name = voiceProviderFullName(host.provider);
      throw new Error(`${name} listens through this browser's speech recognition, and this browser does not have it.`);
    }
  }

  if (speech.transcribe === 'browser') {
    listener = startBrowserListener(host, consume);
    if (!listener) {
      stopStream(stream);
      const name = voiceProviderFullName(host.provider);
      throw new Error(`${name} listens through this browser's speech recognition, and this browser does not have it.`);
    }
  } else {
    serverLoop().catch((error) => {
      if (!stopped && host.isCurrent()) host.fail?.(error);
    });
  }

  return {
    stop() {
      stopped = true;
      listener?.stop();
      try { audioContext?.close(); } catch { /* closing */ }
      stopStream(stream);
    },
    setMicrophoneHeld(next) {
      held = Boolean(next);
      listener?.setMicrophoneHeld(next);
    },
  };
}

export async function startProviderVoice(host) {
  if (host.provider === 'xai') return startGrokVoice(host);
  return startTurnVoice(host);
}
