import { readRequestBody } from './common/request.js';
import {
  enforceOptInRateLimit,
  openAiRateLimiter,
} from './openai/rate-limit.js';
import {
  LLM_ASK_MAX_BODY_BYTES,
  admitLlmAskRequest,
  buildLlmAskCall,
  llmAnswerFromUpstream,
  llmAskTimeoutMs,
  llmProviderRoster,
  parseLlmAskRequest,
} from './llm/ask.js';

const llmJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
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
async function handleLlmAsk(req, res) {
  const admission = admitLlmAskRequest({
    method: req.method,
    contentType: req.headers?.['content-type'],
    origin: req.headers?.origin,
    host: req.headers?.host,
  });
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
  const { provider, settings, question, context } = parsed;

  // Same opt-in per-IP throttle the other paid LLM route uses. It sits
  // after validation so a keyless, malformed or unknown-provider request
  // costs no quota slot, exactly as hud-summary's keyless path does.
  if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

  const call = buildLlmAskCall(provider, settings, question, context);
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
 * movement, or at startup: they run when the operator presses Ask or
 * Overview, and at no other time. That keeps a paid endpoint off the
 * per-frame path and makes the cost of a session equal to the number of
 * questions asked. Keys stay server-side.
 *
 *   GET  /api/llm/providers — roster of models and the client abort budget
 *   POST /api/llm/ask       — one question with the scene JSON
 */
function llmAskProxy() {
  function install(middlewares) {
    middlewares.use('/api/llm/providers', handleLlmProviders);
    middlewares.use('/api/llm/ask', handleLlmAsk);
  }

  return {
    name: 'llm-ask-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { llmAskProxy };
