import { resolvedAllowedHosts } from './common/allowed-hosts.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { readRequestBody } from './common/request.js';
import {
  enforceOptInRateLimit,
  openAiRateLimiter,
} from './openai/rate-limit.js';
import {
  LLM_ASK_MAX_BODY_BYTES,
  admitLlmRequestFrom,
  buildLlmAskCall,
  llmAnswerFromUpstream,
  llmAskTimeoutMs,
  llmProviderRoster,
  parseLlmAskRequest,
} from './llm/ask.js';
import { installLlmVoiceRoutes } from './llm/voice.js';

/** A press is one question: twenty a minute from one address is far past any operator. */
export const LLM_ASK_PER_MINUTE = 20;

const llmJson = (res, statusCode, payload, headers = {}) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [name, value] of Object.entries(headers))
    res.setHeader(name, value);
  res.end(JSON.stringify(payload));
};

/** Which models are available to ask. Costs nothing and contacts no provider. */
function handleLlmProviders(req, res) {
  if (req.method !== 'GET')
    return llmJson(res, 405, { error: 'Method not allowed' });
  llmJson(res, 200, {
    providers: llmProviderRoster(),
    askTimeoutMs: llmAskTimeoutMs(),
  });
}

/** Forward one operator question and the scene JSON to the chosen model. */
async function handleLlmAsk(req, res, { allowedHosts, allow } = {}) {
  const admission = admitLlmRequestFrom(req, allowedHosts);
  if (!admission.ok)
    return llmJson(res, admission.status, { error: admission.error });

  let rawBody;
  try {
    rawBody = await readRequestBody(req, LLM_ASK_MAX_BODY_BYTES);
  } catch {
    return llmJson(res, 413, { error: 'Request too large' });
  }
  const parsed = parseLlmAskRequest(rawBody);
  if (!parsed.ok) return llmJson(res, parsed.status, parsed.payload);
  const { provider, settings, question, context, answerTokens } = parsed;

  // Paid from here on: a built-in limit always, and the same opt-in per-IP
  // throttle the other paid LLM route uses. Both sit after validation so a
  // keyless, malformed or unknown-provider request costs no quota slot,
  // exactly as hud-summary's keyless path does.
  if (allow && !allow(clientKey(req))) {
    return llmJson(
      res,
      429,
      {
        error: 'Too many questions this minute. Wait a minute, then ask again.',
      },
      { 'Retry-After': '30' },
    );
  }
  if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

  const call = buildLlmAskCall(
    provider,
    settings,
    question,
    context,
    process.env,
    answerTokens,
  );
  // A closed browser tab must not leave a billed upstream call running to
  // completion: abort it the moment the response socket goes away.
  const disconnect = new AbortController();
  res.on('close', () => disconnect.abort());

  try {
    const upstream = await fetch(call.url, {
      method: 'POST',
      headers: call.headers,
      body: JSON.stringify(call.payload),
      signal: AbortSignal.any([
        AbortSignal.timeout(llmAskTimeoutMs()),
        disconnect.signal,
      ]),
    });
    const data = await upstream.json().catch(() => ({}));
    const answer = llmAnswerFromUpstream(upstream, data, provider, settings);
    llmJson(res, answer.status, answer.payload);
  } catch (error) {
    if (disconnect.signal.aborted) return; // nobody is listening any more
    const timedOut =
      error?.name === 'TimeoutError' || error?.name === 'AbortError';
    llmJson(res, 504, {
      error: timedOut
        ? `${provider.label} did not answer in time. Try again, or pick a faster model.`
        : error?.message || 'Request to the model failed',
      provider: provider.id,
    });
  }
}

/**
 * Vite plugin: the Ask panel's language-model routes.
 *
 * On-demand only. Nothing in the client calls these on a timer, on camera
 * movement, or at startup. Ask, Overview, and Risk Assessment call
 * /api/llm/ask. The mic calls /api/llm/voice/* when a session or a spoken
 * turn needs a model. Keys stay server-side.
 *
 *   GET  /api/llm/providers          — roster of models and the client abort budget
 *   POST /api/llm/ask                — one question with the scene JSON
 *   POST /api/llm/voice/session      — Grok's short-lived voice secret
 *   POST /api/llm/voice/turn         — one spoken turn and its tool results
 *   POST /api/llm/voice/transcribe   — OpenRouter or custom speech to text
 *   POST /api/llm/voice/speak        — OpenRouter or custom text to speech
 */
function llmAskProxy() {
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: LLM_ASK_PER_MINUTE,
    globalMax: LLM_ASK_PER_MINUTE * 2,
  });
  /** @param {'server' | 'preview'} section - Which Vite server's hosts apply. */
  function install(server, section) {
    // The hosts this server answers: the paid routes check Host themselves.
    const allowedHosts = resolvedAllowedHosts(server.config, section);
    const { middlewares } = server;
    middlewares.use('/api/llm/providers', handleLlmProviders);
    middlewares.use('/api/llm/ask', (req, res) =>
      handleLlmAsk(req, res, { allowedHosts, allow }),
    );
    installLlmVoiceRoutes(middlewares, { allowedHosts });
  }

  return {
    name: 'llm-ask-proxy',
    configureServer(server) {
      install(server, 'server');
    },
    configurePreviewServer(server) {
      install(server, 'preview');
    },
  };
}

export { llmAskProxy };
