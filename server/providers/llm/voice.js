/**
 * Voice control for the Ask-panel providers.
 *
 * Grok speaks on its own realtime socket. The browser receives a short-lived
 * client secret and the same tool list OpenAI already uses. The long-lived
 * key stays here.
 *
 * Claude and NVIDIA have no speech API on the chat route this app already
 * calls, so the browser hears and speaks and the chat route runs the tools.
 * OpenRouter transcribes and speaks on its audio routes, then uses the same
 * chat route for the tools. A custom OpenAI-compatible endpoint does that
 * when it implements the audio routes.
 *
 * Nothing here runs on a timer. The mic calls it, and only then.
 */
import crypto from 'node:crypto';
import { readRequestBody } from '../common/request.js';
import { realtimeInstructions } from '../openai/instructions.js';
import { enforceOptInRateLimit, openAiRateLimiter } from '../openai/rate-limit.js';
import { GEV_REALTIME_TOOLS } from '../openai/tools.js';
import {
  LOCAL_PROVIDER_CHANGED_MESSAGE,
  localLlmSection,
  localProviderTrusted,
} from '../../../src/localIntegrity.mjs';
import {
  admitLlmRequestFrom,
  llmMaxTokens,
  llmProviderSettings,
  resolveLlmProvider,
} from './ask.js';

const VOICE_TURN_BODY_BYTES = 1024 * 1024;
const VOICE_AUDIO_BODY_BYTES = 2 * 1024 * 1024;
const VOICE_AUDIO_MAX_CHARS = 1_500_000;
const VOICE_AUDIO_MAX_BYTES = 1024 * 1024;
const VOICE_SPEECH_MAX_BYTES = 8 * 1024 * 1024;
const VOICE_SESSION_BODY_BYTES = 64 * 1024;
const MAX_VOICE_MESSAGES = 32;
const MAX_USER_CHARS = 4000;
const MAX_TOOL_CHARS = 80_000;
const MAX_TOOL_CALLS = 8;
const MAX_ARG_CHARS = 8000;
const AUDIO_FORMATS = new Set(['webm', 'wav', 'mp3', 'ogg', 'flac', 'm4a', 'mp4']);
const AUDIO_MIME = Object.freeze({
  webm: 'audio/webm',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
});

const TOOL_NAMES = new Set(GEV_REALTIME_TOOLS.map((tool) => tool.name));

const VOICE_NAMES = Object.freeze({
  anthropic: 'Claude',
  custom: 'Custom LLM',
  openrouter: 'OpenRouter',
  xai: 'Grok',
  nvidia: 'NVIDIA',
});

/** How the mic should talk to a provider. OpenAI is not in this map. */
export function voiceSpeechPlan(providerId) {
  switch (providerId) {
    case 'xai':
      return { mode: 'realtime', transcribe: 'native', speak: 'native' };
    case 'openrouter':
      return { mode: 'turn', transcribe: 'server', speak: 'server' };
    case 'custom':
      return {
        mode: 'turn',
        transcribe: 'server',
        speak: 'server',
        browserFallback: true,
      };
    case 'anthropic':
    case 'nvidia':
      return { mode: 'turn', transcribe: 'browser', speak: 'browser' };
    default:
      return null;
  }
}

function voiceName(providerId) {
  return VOICE_NAMES[providerId] || 'That provider';
}

function safeToken(value, fallback, pattern) {
  const text = String(value || '').trim();
  return pattern.test(text) ? text : fallback;
}

/** One spoken turn's server budget. Read live so a .env edit applies next turn. */
export function llmVoiceTimeoutMs(env = process.env) {
  const value = Math.floor(Number(env.LLM_VOICE_TIMEOUT_MS));
  if (!Number.isFinite(value) || value <= 0) return 60_000;
  return Math.max(5_000, Math.min(value, 240_000));
}

/**
 * Chat-completions tools from the realtime list. The realtime list itself is
 * not rewritten: providers that speak HTTP want the name nested under function.
 */
export function chatToolsFromRealtime(tools = GEV_REALTIME_TOOLS) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** Grok session the browser sends after the socket opens. No API key. */
export function grokVoiceSessionConfig(env = process.env) {
  const model = safeToken(
    env.XAI_VOICE_MODEL,
    'grok-voice-latest',
    /^[A-Za-z0-9._-]{1,80}$/,
  );
  const voice = safeToken(env.XAI_VOICE, 'eve', /^[A-Za-z0-9_-]{1,40}$/);
  const effort = env.XAI_VOICE_REASONING === 'high' ? 'high' : 'none';
  return {
    model,
    voice,
    sampleRate: 24000,
    url: `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`,
    sessionUpdate: {
      type: 'session.update',
      session: {
        voice,
        instructions: realtimeInstructions(),
        reasoning: { effort },
        turn_detection: { type: 'server_vad' },
        tools: GEV_REALTIME_TOOLS,
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24000 } },
          output: { format: { type: 'audio/pcm', rate: 24000 } },
        },
      },
    },
  };
}

/** Mint body for xAI. The session itself is sent by the browser after connect. */
export function buildGrokClientSecretCall(apiKey) {
  return {
    url: 'https://api.x.ai/v1/realtime/client_secrets',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    payload: { expires_after: { seconds: 300 } },
  };
}

function jsonReply(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function publicUpstreamError(value, apiKey) {
  const message = typeof value === 'string' ? value : value?.message || '';
  const text = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!text || (apiKey && text.includes(apiKey))) {
    return 'The voice service refused the request.';
  }
  return text;
}

function readJsonBody(raw) {
  try {
    const request = JSON.parse(raw || '{}');
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return null;
    }
    return request;
  } catch {
    return null;
  }
}

/**
 * Key and integrity gate shared by every voice route. An unknown id is refused
 * before the default Ask provider (NVIDIA) can be substituted.
 */
export function admitVoiceProvider(providerId, env = process.env) {
  const id = String(providerId || '').trim();
  if (!id || !voiceSpeechPlan(id)) {
    return {
      ok: false,
      status: 400,
      payload: { error: `Unknown voice provider: ${id.slice(0, 40)}` },
    };
  }
  const provider = resolveLlmProvider(id);
  if (!provider) {
    return {
      ok: false,
      status: 400,
      payload: { error: `Unknown voice provider: ${id.slice(0, 40)}` },
    };
  }
  if (!localProviderTrusted(localLlmSection(provider.id), env)) {
    return {
      ok: false,
      status: 409,
      payload: { error: LOCAL_PROVIDER_CHANGED_MESSAGE, provider: provider.id },
    };
  }
  const settings = llmProviderSettings(provider, env);
  if (!settings.apiKey) {
    return {
      ok: false,
      status: 503,
      payload: { error: `${provider.keyEnv} is not set`, provider: provider.id },
    };
  }
  if (provider.requiresBaseUrl && (!settings.baseUrl || !settings.model)) {
    return {
      ok: false,
      status: 503,
      payload: {
        error: `${provider.label} also needs ${provider.baseUrlEnv} and ${provider.modelEnv}`,
        provider: provider.id,
      },
    };
  }
  return { ok: true, provider, settings };
}

function modeRefusal(providerId, route) {
  const name = voiceName(providerId);
  if (route === 'session') return `${name} uses a spoken turn.`;
  if (providerId === 'xai') return 'Grok voice uses its realtime session.';
  return `${name} listens and speaks in this browser.`;
}

export function parseVoiceSessionRequest(rawBody) {
  const request = readJsonBody(rawBody);
  if (!request) {
    return { ok: false, status: 400, payload: { error: 'Malformed request body' } };
  }
  const providerId = String(request.provider || '').trim();
  if (!providerId) {
    return { ok: false, status: 400, payload: { error: 'A voice provider is required.' } };
  }
  return { ok: true, providerId };
}

function sanitizeToolCalls(toolCalls) {
  if (toolCalls == null) return { value: [] };
  if (!Array.isArray(toolCalls) || toolCalls.length > MAX_TOOL_CALLS) {
    return { error: 'Malformed conversation.' };
  }
  const value = [];
  for (const call of toolCalls) {
    const name = String(call?.function?.name || call?.name || '');
    if (!TOOL_NAMES.has(name)) return { error: 'Malformed conversation.' };
    const id = String(call?.id || '').slice(0, 80);
    if (!id) return { error: 'Malformed conversation.' };
    let args = call?.function?.arguments ?? call?.arguments ?? '{}';
    if (typeof args !== 'string') {
      try {
        args = JSON.stringify(args);
      } catch {
        return { error: 'Malformed conversation.' };
      }
    }
    if (args.length > MAX_ARG_CHARS) return { error: 'Malformed conversation.' };
    value.push({
      id,
      type: 'function',
      function: { name, arguments: args },
    });
  }
  return { value };
}

/** Keep the client's history to user, assistant, and tool rows. System is ours. */
export function sanitizeVoiceMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_VOICE_MESSAGES) {
    return { ok: false, error: 'A spoken turn needs its conversation.' };
  }
  const clean = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { ok: false, error: 'Malformed conversation.' };
    }
    if (message.role === 'user') {
      const content = String(message.content || '').trim();
      if (!content) return { ok: false, error: 'A spoken turn needs words.' };
      if (content.length > MAX_USER_CHARS) {
        return { ok: false, error: 'That utterance is too long.' };
      }
      clean.push({ role: 'user', content });
    } else if (message.role === 'assistant') {
      const toolCalls = sanitizeToolCalls(message.tool_calls);
      if (toolCalls.error) return { ok: false, error: toolCalls.error };
      const content = message.content == null
        ? null
        : String(message.content).slice(0, MAX_USER_CHARS);
      const row = { role: 'assistant', content };
      if (toolCalls.value.length) row.tool_calls = toolCalls.value;
      if (!row.tool_calls && !row.content) {
        return { ok: false, error: 'Malformed conversation.' };
      }
      clean.push(row);
    } else if (message.role === 'tool') {
      const id = String(message.tool_call_id || '').slice(0, 80);
      if (!id) return { ok: false, error: 'Malformed conversation.' };
      clean.push({
        role: 'tool',
        tool_call_id: id,
        content: String(message.content ?? '').slice(0, MAX_TOOL_CHARS),
      });
    } else {
      return { ok: false, error: 'Malformed conversation.' };
    }
  }
  const last = clean[clean.length - 1];
  if (last.role !== 'user' && last.role !== 'tool') {
    return { ok: false, error: 'A spoken turn needs words.' };
  }
  if (!clean.some((message) => message.role === 'user')) {
    return { ok: false, error: 'A spoken turn needs words.' };
  }
  return { ok: true, messages: clean };
}

export function parseVoiceTurnRequest(rawBody) {
  const request = readJsonBody(rawBody);
  if (!request) {
    return { ok: false, status: 400, payload: { error: 'Malformed request body' } };
  }
  const providerId = String(request.provider || '').trim();
  if (!providerId) {
    return { ok: false, status: 400, payload: { error: 'A voice provider is required.' } };
  }
  const messages = sanitizeVoiceMessages(request.messages);
  if (!messages.ok) {
    return { ok: false, status: 400, payload: { error: messages.error } };
  }
  return { ok: true, providerId, messages: messages.messages };
}

function applyNvidiaReasoning(provider, payload, env) {
  const effort = env.NVIDIA_REASONING_EFFORT ?? 'low';
  if (
    provider.supportsReasoningEffort
    && effort
    && !/^(none|off|0)$/i.test(String(effort).trim())
  ) {
    payload.reasoning_effort = String(effort).trim();
  }
}

/** The chat call for one spoken turn. The system prompt is always ours. */
export function buildVoiceChatCall(provider, settings, messages, env = process.env) {
  const payload = {
    model: settings.model,
    messages: [
      { role: 'system', content: realtimeInstructions() },
      ...messages,
    ],
    tools: chatToolsFromRealtime(),
    tool_choice: 'auto',
    temperature: 0.3,
    max_tokens: llmMaxTokens(env),
    stream: false,
  };
  applyNvidiaReasoning(provider, payload, env);
  return {
    url: `${settings.baseUrl}/chat/completions`,
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(provider.extraHeaders || {}),
    },
    payload,
  };
}

function messageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .join('')
    .trim();
}

function upstreamToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const out = [];
  for (const call of toolCalls) {
    if (out.length >= MAX_TOOL_CALLS) break;
    const name = call?.function?.name || call?.name;
    if (!TOOL_NAMES.has(name)) continue;
    let args = call?.function?.arguments ?? call?.arguments ?? '{}';
    if (typeof args !== 'string') {
      try {
        args = JSON.stringify(args);
      } catch {
        args = '{}';
      }
    }
    if (args.length > MAX_ARG_CHARS) args = '{}';
    out.push({
      id: String(call?.id || `call_${out.length + 1}`).slice(0, 80),
      type: 'function',
      function: { name, arguments: args },
    });
  }
  return out;
}

export function voiceTurnFromUpstream({ ok, status }, data, provider, settings) {
  if (!ok) {
    return {
      status: 502,
      payload: {
        error: publicUpstreamError(data?.error || data?.detail, settings.apiKey)
          || `${provider.label} returned ${status}`,
        provider: provider.id,
        upstreamStatus: status,
      },
    };
  }
  const choice = data?.choices?.[0];
  const toolCalls = upstreamToolCalls(choice?.message?.tool_calls);
  const text = messageText(choice?.message?.content);
  if (!toolCalls.length && !text) {
    const truncated = choice?.finish_reason === 'length';
    return {
      status: 502,
      payload: {
        error: truncated
          ? 'The model ran out of room before it answered. Raise LLM_MAX_TOKENS.'
          : `${provider.label} returned no answer.`,
        provider: provider.id,
      },
    };
  }
  const assistant = {
    role: 'assistant',
    content: text || null,
  };
  if (toolCalls.length) assistant.tool_calls = toolCalls;
  return {
    status: 200,
    payload: {
      provider: provider.id,
      model: data?.model || settings.model,
      text: toolCalls.length ? '' : text,
      toolCalls: toolCalls.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      assistant,
    },
  };
}

function audioLanguage(env) {
  const language = env.OPENROUTER_STT_LANGUAGE ?? 'en';
  const text = String(language || '').trim();
  if (!text || text === 'auto') return '';
  return /^[A-Za-z-]{2,16}$/.test(text) ? text : '';
}

function decodeAudio(audioBase64) {
  const clean = String(audioBase64 || '').replace(/\s+/g, '');
  if (!clean || clean.length > VOICE_AUDIO_MAX_CHARS) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  const bytes = Buffer.from(clean, 'base64');
  if (!bytes.length || bytes.length > VOICE_AUDIO_MAX_BYTES) return null;
  return { clean, bytes };
}

export function parseVoiceAudioRequest(rawBody, kind) {
  const request = readJsonBody(rawBody);
  if (!request) {
    return { ok: false, status: 400, payload: { error: 'Malformed request body' } };
  }
  const providerId = String(request.provider || '').trim();
  if (!providerId) {
    return { ok: false, status: 400, payload: { error: 'A voice provider is required.' } };
  }
  if (kind === 'speak') {
    const text = String(request.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, status: 400, payload: { error: 'There is nothing to say.' } };
    if (text.length > MAX_USER_CHARS) {
      return { ok: false, status: 400, payload: { error: 'That reply is too long to speak.' } };
    }
    return { ok: true, providerId, text };
  }
  const format = String(request.format || '').toLowerCase();
  if (!AUDIO_FORMATS.has(format)) {
    return { ok: false, status: 400, payload: { error: 'Unsupported audio format.' } };
  }
  const audio = decodeAudio(request.audioBase64);
  if (!audio) {
    return { ok: false, status: 400, payload: { error: 'The recording could not be read.' } };
  }
  return { ok: true, providerId, format, audio };
}

function speechModels(providerId, env) {
  if (providerId === 'openrouter') {
    return {
      stt: safeToken(
        env.OPENROUTER_STT_MODEL,
        'openai/whisper-large-v3',
        /^[A-Za-z0-9_.:/+-]{1,120}$/,
      ),
      tts: safeToken(
        env.OPENROUTER_TTS_MODEL,
        'openai/gpt-4o-mini-tts-2025-12-15',
        /^[A-Za-z0-9_.:/+-]{1,120}$/,
      ),
      voice: safeToken(env.OPENROUTER_TTS_VOICE, 'alloy', /^[A-Za-z0-9_-]{1,40}$/),
    };
  }
  return {
    stt: safeToken(env.CUSTOM_LLM_STT_MODEL, 'whisper-1', /^[A-Za-z0-9_.:/+-]{1,120}$/),
    tts: safeToken(env.CUSTOM_LLM_TTS_MODEL, 'tts-1', /^[A-Za-z0-9_.:/+-]{1,120}$/),
    voice: safeToken(env.CUSTOM_LLM_TTS_VOICE, 'alloy', /^[A-Za-z0-9_-]{1,40}$/),
  };
}

function browserSpeechRefusal(providerId) {
  return {
    ok: false,
    status: 501,
    payload: {
      browserSpeech: true,
      error: `${voiceName(providerId)} listens and speaks in this browser.`,
      provider: providerId,
    },
  };
}

/** Transcription request. Claude and NVIDIA never leave this machine as audio. */
export function buildTranscriptionCall(provider, settings, audio, env = process.env) {
  const plan = voiceSpeechPlan(provider.id);
  if (!plan || plan.transcribe !== 'server') return browserSpeechRefusal(provider.id);
  const models = speechModels(provider.id, env);
  const headers = {
    Authorization: `Bearer ${settings.apiKey}`,
    ...(provider.extraHeaders || {}),
  };
  const language = audioLanguage(env);
  if (provider.id === 'openrouter') {
    const payload = {
      model: models.stt,
      input_audio: { data: audio.clean, format: audio.format },
    };
    if (language) payload.language = language;
    return {
      ok: true,
      url: `${settings.baseUrl}/audio/transcriptions`,
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    };
  }
  const boundary = `gev${crypto.randomBytes(8).toString('hex')}`;
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${models.stt}\r\n`,
  ];
  if (language) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`);
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.${audio.format}"\r\nContent-Type: ${AUDIO_MIME[audio.format]}\r\n\r\n`,
  );
  return {
    ok: true,
    url: `${settings.baseUrl}/audio/transcriptions`,
    headers: { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([
      Buffer.from(parts.join('')),
      audio.bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

/** Speech request. The reply is audio bytes, not JSON. */
export function buildSpeechCall(provider, settings, text, env = process.env) {
  const plan = voiceSpeechPlan(provider.id);
  if (!plan || plan.speak !== 'server') return browserSpeechRefusal(provider.id);
  const models = speechModels(provider.id, env);
  return {
    ok: true,
    url: `${settings.baseUrl}/audio/speech`,
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
      ...(provider.extraHeaders || {}),
    },
    body: JSON.stringify({
      model: models.tts,
      input: text,
      voice: models.voice,
      response_format: 'mp3',
    }),
  };
}

async function readVoiceBody(req, res, maxBytes) {
  try {
    return await readRequestBody(req, maxBytes);
  } catch {
    jsonReply(res, 413, { error: 'Request too large' });
    return null;
  }
}

/** The paid-route admission, against this server's own hosts. */
function admitRoute(req, res, allowedHosts) {
  const admission = admitLlmRequestFrom(req, allowedHosts);
  if (!admission.ok) {
    jsonReply(res, admission.status, { error: admission.error });
    return false;
  }
  return true;
}

function gateProvider(providerId, res) {
  const gate = admitVoiceProvider(providerId);
  if (!gate.ok) {
    jsonReply(res, gate.status, gate.payload);
    return null;
  }
  return gate;
}

function createVoiceSessionHandler(allowedHosts) {
  return async (req, res) => {
    if (!admitRoute(req, res, allowedHosts)) return;
    const raw = await readVoiceBody(req, res, VOICE_SESSION_BODY_BYTES);
    if (raw == null) return;
    const parsed = parseVoiceSessionRequest(raw);
    if (!parsed.ok) return jsonReply(res, parsed.status, parsed.payload);
    const gate = gateProvider(parsed.providerId, res);
    if (!gate) return;
    if (voiceSpeechPlan(parsed.providerId).mode !== 'realtime') {
      return jsonReply(res, 400, { error: modeRefusal(parsed.providerId, 'session') });
    }
    if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;
    const call = buildGrokClientSecretCall(gate.settings.apiKey);
    const disconnect = new AbortController();
    res.on('close', () => disconnect.abort());
    try {
      const upstream = await fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: JSON.stringify(call.payload),
        signal: AbortSignal.any([
          AbortSignal.timeout(20_000),
          disconnect.signal,
        ]),
      });
      const rawBody = await upstream.text();
      let data = {};
      try {
        data = JSON.parse(rawBody);
      } catch {
        data = { error: rawBody };
      }
      if (disconnect.signal.aborted) return;
      if (!upstream.ok || typeof data?.value !== 'string' || !data.value) {
        return jsonReply(res, 502, {
          error: publicUpstreamError(data?.error, gate.settings.apiKey),
          provider: 'xai',
        });
      }
      const session = grokVoiceSessionConfig();
      jsonReply(res, 200, {
        mode: 'realtime',
        provider: 'xai',
        value: data.value,
        expiresAt: Number.isFinite(data.expires_at) ? data.expires_at : null,
        url: session.url,
        model: session.model,
        voice: session.voice,
        sampleRate: session.sampleRate,
        sessionUpdate: session.sessionUpdate,
      });
    } catch {
      if (disconnect.signal.aborted) return;
      jsonReply(res, 502, { error: 'Grok voice did not answer.', provider: 'xai' });
    }
  };
}

function createVoiceTurnHandler(allowedHosts) {
  return async (req, res) => {
    if (!admitRoute(req, res, allowedHosts)) return;
    const raw = await readVoiceBody(req, res, VOICE_TURN_BODY_BYTES);
    if (raw == null) return;
    const parsed = parseVoiceTurnRequest(raw);
    if (!parsed.ok) return jsonReply(res, parsed.status, parsed.payload);
    const gate = gateProvider(parsed.providerId, res);
    if (!gate) return;
    if (voiceSpeechPlan(parsed.providerId).mode !== 'turn') {
      return jsonReply(res, 400, { error: modeRefusal(parsed.providerId, 'turn') });
    }
    if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;
    const call = buildVoiceChatCall(
      gate.provider,
      gate.settings,
      parsed.messages,
    );
    const disconnect = new AbortController();
    res.on('close', () => disconnect.abort());
    try {
      const upstream = await fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: JSON.stringify(call.payload),
        signal: AbortSignal.any([
          AbortSignal.timeout(llmVoiceTimeoutMs()),
          disconnect.signal,
        ]),
      });
      const data = await upstream.json().catch(() => ({}));
      if (disconnect.signal.aborted) return;
      const answer = voiceTurnFromUpstream(upstream, data, gate.provider, gate.settings);
      jsonReply(res, answer.status, answer.payload);
    } catch (error) {
      if (disconnect.signal.aborted) return;
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      jsonReply(res, 504, {
        error: timedOut
          ? `${gate.provider.label} did not answer in time.`
          : 'The voice request failed.',
        provider: gate.provider.id,
      });
    }
  };
}

function createVoiceTranscribeHandler(allowedHosts) {
  return async (req, res) => {
    if (!admitRoute(req, res, allowedHosts)) return;
    const raw = await readVoiceBody(req, res, VOICE_AUDIO_BODY_BYTES);
    if (raw == null) return;
    const parsed = parseVoiceAudioRequest(raw, 'transcribe');
    if (!parsed.ok) return jsonReply(res, parsed.status, parsed.payload);
    const gate = gateProvider(parsed.providerId, res);
    if (!gate) return;
    const call = buildTranscriptionCall(gate.provider, gate.settings, {
      clean: parsed.audio.clean,
      bytes: parsed.audio.bytes,
      format: parsed.format,
    });
    if (!call.ok) return jsonReply(res, call.status, call.payload);
    if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;
    const disconnect = new AbortController();
    res.on('close', () => disconnect.abort());
    try {
      const upstream = await fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: call.body,
        signal: AbortSignal.any([
          AbortSignal.timeout(llmVoiceTimeoutMs()),
          disconnect.signal,
        ]),
      });
      const data = await upstream.json().catch(() => ({}));
      if (disconnect.signal.aborted) return;
      if (!upstream.ok) {
        const unsupported = upstream.status === 404 || upstream.status === 405;
        if (unsupported && voiceSpeechPlan(gate.provider.id).browserFallback) {
          return jsonReply(res, 501, {
            browserSpeech: true,
            error: 'This endpoint has no transcription route. The browser will listen.',
            provider: gate.provider.id,
          });
        }
        return jsonReply(res, 502, {
          error: publicUpstreamError(data?.error || data?.detail, gate.settings.apiKey),
          provider: gate.provider.id,
          upstreamStatus: upstream.status,
        });
      }
      const text = String(data?.text || '').trim().slice(0, MAX_USER_CHARS);
      jsonReply(res, 200, { provider: gate.provider.id, text });
    } catch {
      if (disconnect.signal.aborted) return;
      jsonReply(res, 504, {
        error: 'Transcription did not answer in time.',
        provider: gate.provider.id,
      });
    }
  };
}

function createVoiceSpeakHandler(allowedHosts) {
  return async (req, res) => {
    if (!admitRoute(req, res, allowedHosts)) return;
    const raw = await readVoiceBody(req, res, VOICE_SESSION_BODY_BYTES);
    if (raw == null) return;
    const parsed = parseVoiceAudioRequest(raw, 'speak');
    if (!parsed.ok) return jsonReply(res, parsed.status, parsed.payload);
    const gate = gateProvider(parsed.providerId, res);
    if (!gate) return;
    const call = buildSpeechCall(gate.provider, gate.settings, parsed.text);
    if (!call.ok) return jsonReply(res, call.status, call.payload);
    if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;
    const disconnect = new AbortController();
    res.on('close', () => disconnect.abort());
    try {
      const upstream = await fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: call.body,
        signal: AbortSignal.any([
          AbortSignal.timeout(llmVoiceTimeoutMs()),
          disconnect.signal,
        ]),
      });
      const type = upstream.headers.get('content-type') || '';
      if (!upstream.ok || /json|text\/html/i.test(type)) {
        const data = await upstream.json().catch(() => ({}));
        if (disconnect.signal.aborted) return;
        const unsupported = upstream.status === 404 || upstream.status === 405;
        if (unsupported && voiceSpeechPlan(gate.provider.id).browserFallback) {
          return jsonReply(res, 501, {
            browserSpeech: true,
            error: 'This endpoint has no speech route. The browser will speak.',
            provider: gate.provider.id,
          });
        }
        return jsonReply(res, 502, {
          error: publicUpstreamError(data?.error || data?.detail, gate.settings.apiKey),
          provider: gate.provider.id,
          upstreamStatus: upstream.status,
        });
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (disconnect.signal.aborted) return;
      if (!bytes.length || bytes.length > VOICE_SPEECH_MAX_BYTES) {
        return jsonReply(res, 502, {
          error: 'The spoken reply could not be played.',
          provider: gate.provider.id,
        });
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', /^audio\//i.test(type) ? type : 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.end(bytes);
    } catch {
      if (disconnect.signal.aborted) return;
      jsonReply(res, 504, {
        error: 'Speech did not answer in time.',
        provider: gate.provider.id,
      });
    }
  };
}

function installLlmVoiceRoutes(middlewares, { allowedHosts } = {}) {
  middlewares.use('/api/llm/voice/session', createVoiceSessionHandler(allowedHosts));
  middlewares.use('/api/llm/voice/turn', createVoiceTurnHandler(allowedHosts));
  middlewares.use('/api/llm/voice/transcribe', createVoiceTranscribeHandler(allowedHosts));
  middlewares.use('/api/llm/voice/speak', createVoiceSpeakHandler(allowedHosts));
}

export { installLlmVoiceRoutes };
