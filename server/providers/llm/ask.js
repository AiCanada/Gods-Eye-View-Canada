/**
 * Language models the Ask panel can query, keyed by id.
 *
 * All five speak one dialect: POST /chat/completions with a Bearer token and
 * the system prompt as the first message. NVIDIA NIM, xAI and OpenRouter are
 * natively that shape, Anthropic publishes a compatibility endpoint that is,
 * and the custom slot exists for anything else that is.
 *
 * Every base URL and model id is env-overridable, because model names change
 * far more often than this file does.
 */
const LLM_PROVIDERS = Object.freeze({
  nvidia: Object.freeze({
    id: 'nvidia',
    label: 'NVIDIA NIM',
    keyEnv: 'NVIDIA_API_KEY',
    baseUrlEnv: 'NVIDIA_BASE_URL',
    baseUrlDefault: 'https://integrate.api.nvidia.com/v1',
    modelEnv: 'NVIDIA_MODEL',
    modelDefault: 'moonshotai/kimi-k3',
    // NIM's reasoning models spend tokens thinking before they write anything.
    supportsReasoningEffort: true,
  }),
  xai: Object.freeze({
    id: 'xai',
    label: 'xAI Grok',
    keyEnv: 'XAI_API_KEY',
    baseUrlEnv: 'XAI_BASE_URL',
    baseUrlDefault: 'https://api.x.ai/v1',
    modelEnv: 'XAI_MODEL',
    modelDefault: 'grok-4.6',
  }),
  openrouter: Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    baseUrlDefault: 'https://openrouter.ai/api/v1',
    modelEnv: 'OPENROUTER_MODEL',
    // OpenRouter fronts many vendors, so the model id carries its vendor
    // prefix. Override with OPENROUTER_MODEL.
    modelDefault: 'openai/gpt-5.2',
    // OpenRouter asks callers to identify themselves for its leaderboards.
    extraHeaders: Object.freeze({
      'HTTP-Referer': 'http://localhost:4173',
      'X-Title': "God's Eye View",
    }),
  }),
  custom: Object.freeze({
    id: 'custom',
    label: 'Custom LLM',
    keyEnv: 'CUSTOM_LLM_API_KEY',
    baseUrlEnv: 'CUSTOM_LLM_BASE_URL',
    // No default: a custom endpoint has no address we could guess, so the
    // roster reports it unready until CUSTOM_LLM_BASE_URL names one.
    baseUrlDefault: '',
    modelEnv: 'CUSTOM_LLM_MODEL',
    modelDefault: '',
    requiresBaseUrl: true,
  }),
  anthropic: Object.freeze({
    id: 'anthropic',
    label: 'Anthropic Claude',
    // Anthropic publishes an OpenAI-compatible endpoint at this base, which is
    // what the reference integration uses: same Bearer auth, same
    // /chat/completions shape, system prompt as a message. The native Messages
    // API (x-api-key, anthropic-version, content blocks) is the alternative if
    // the compatibility layer ever falls short.
    keyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    baseUrlDefault: 'https://api.anthropic.com/v1',
    modelEnv: 'ANTHROPIC_MODEL',
    modelDefault: 'claude-fable-5-1',
  }),
});

/** Providers whose id is a real registry key (never an inherited Object member). */
export function resolveLlmProvider(id) {
  const key = String(id || 'nvidia');
  return Object.hasOwn(LLM_PROVIDERS, key) ? LLM_PROVIDERS[key] : null;
}

/**
 * Read the per-request LLM limits from the LIVE environment.
 *
 * These are functions, not module constants, because Vite's loadEnv copies .env
 * into process.env inside the config factory, AFTER this module was imported
 * (the same hazard openAiRateLimiter() documents). A module-scope read would
 * silently ignore .env, while the route's own error text tells the operator to
 * set these very variables there.
 */
export function llmMaxTokens(env = process.env) {
  const value = Math.floor(Number(env.LLM_MAX_TOKENS));
  return Number.isFinite(value) && value > 0 ? value : 2048;
}

/**
 * A reasoning model can think for a long time. Measured on NVIDIA NIM's
 * kimi-k3, a one-word answer takes ~100s and the Overview prompt takes longer,
 * so 120s was cutting off answers that were still coming. Four minutes is
 * generous rather than optimistic; lower it if you point the panel at a faster
 * model. The panel reads this value from /api/llm/providers so its own client
 * abort always lands after the server's.
 */
export function llmAskTimeoutMs(env = process.env) {
  const value = Math.floor(Number(env.LLM_ASK_TIMEOUT_MS));
  return Number.isFinite(value) && value > 0 ? value : 240000;
}

/** Resolve a provider's live settings from the environment. */
export function llmProviderSettings(provider, env = process.env) {
  return {
    apiKey: env[provider.keyEnv] || '',
    baseUrl: String(
      env[provider.baseUrlEnv] || provider.baseUrlDefault,
    ).replace(/\/+$/, ''),
    model: env[provider.modelEnv] || provider.modelDefault,
  };
}

/** Which models currently hold a key, for the panel to render a row each. */
export function llmProviderRoster(env = process.env) {
  return Object.values(LLM_PROVIDERS).map((provider) => {
    const { apiKey, baseUrl, model } = llmProviderSettings(provider, env);
    // A custom endpoint needs an address and a model name as well as a key;
    // without them there is nothing to call.
    const complete = provider.requiresBaseUrl
      ? Boolean(baseUrl && model)
      : true;
    return {
      id: provider.id,
      label: provider.label,
      model,
      ready: Boolean(apiKey) && complete,
    };
  });
}

/**
 * Admission for the paid Ask route: same shape the key-setup endpoint uses
 * against cross-site writes. A simple-request POST (text/plain, no preflight)
 * is exactly what a hostile page can fire at localhost without CORS consent,
 * so JSON is required, and a browser-supplied Origin must name this server.
 * Absent Origin (curl, same-origin GET-less clients) is allowed: the guard is
 * against browsers acting for another site, not against the operator.
 *
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function admitLlmAskRequest({ method, contentType, origin, host } = {}) {
  if (method !== 'POST')
    return { ok: false, status: 405, error: 'Method not allowed' };
  if (!/^application\/json\b/i.test(String(contentType || '').trim())) {
    return {
      ok: false,
      status: 415,
      error: 'Content-Type must be application/json',
    };
  }
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(String(origin)).host.toLowerCase();
    } catch {
      return { ok: false, status: 403, error: 'Origin not allowed' };
    }
    if (!host || originHost !== String(host).trim().toLowerCase()) {
      return { ok: false, status: 403, error: 'Origin not allowed' };
    }
  }
  return { ok: true };
}

/** Longest question the Ask route forwards. */
export const LLM_QUESTION_MAX_CHARS = 2000;

/** Largest Ask request body the route reads. */
export const LLM_ASK_MAX_BODY_BYTES = 64 * 1024;

/**
 * Turn a raw Ask body into a validated request, or say exactly why not.
 * Every branch here used to run outside the JSON try/catch: a body of `null`
 * parsed fine and then threw on `.provider` inside an async middleware, which
 * is an unhandled rejection that ends the dev-server process.
 *
 * @param {string} rawBody
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ok: true, provider: object, settings: object, question: string, context: object}
 *   | {ok: false, status: number, payload: object}}
 */
export function parseLlmAskRequest(rawBody, env = process.env) {
  let request;
  try {
    request = JSON.parse(rawBody || '{}');
  } catch {
    return {
      ok: false,
      status: 400,
      payload: { error: 'Malformed request body' },
    };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return {
      ok: false,
      status: 400,
      payload: { error: 'Malformed request body' },
    };
  }
  const provider = resolveLlmProvider(request.provider);
  if (!provider) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: `Unknown model provider: ${String(request.provider).slice(0, 40)}`,
      },
    };
  }
  const settings = llmProviderSettings(provider, env);
  if (!settings.apiKey) {
    // Distinct from a failure: the panel says "add a key" rather than
    // reporting the provider as broken.
    return {
      ok: false,
      status: 501,
      payload: {
        error: `${provider.keyEnv} is not configured`,
        unconfigured: true,
        provider: provider.id,
      },
    };
  }
  if (provider.requiresBaseUrl && (!settings.baseUrl || !settings.model)) {
    return {
      ok: false,
      status: 501,
      payload: {
        error: `${provider.label} also needs ${provider.baseUrlEnv} and ${provider.modelEnv}`,
        unconfigured: true,
        provider: provider.id,
      },
    };
  }
  const question = String(request.question || '')
    .trim()
    .slice(0, LLM_QUESTION_MAX_CHARS);
  if (!question)
    return {
      ok: false,
      status: 400,
      payload: { error: 'A question is required' },
    };
  const context =
    request.context &&
    typeof request.context === 'object' &&
    !Array.isArray(request.context)
      ? request.context
      : {};
  return { ok: true, provider, settings, question, context };
}

const LLM_ASK_INSTRUCTIONS = [
  "You are the analyst console for God's Eye View, a 3D globe showing live public data.",
  'The user is looking at the scene described by the SCENE JSON below.',
  'Answer their question about what is on screen using ONLY that JSON.',
  'It carries the camera position, the place and street labels under the view,',
  'the enabled data layers, the active visual style, and the selected camera if any.',
  'Never invent a place, a reading, or a layer that the JSON does not contain.',
  'Say plainly when the JSON does not cover something rather than guessing.',
  'Write prose for an operator: no markdown, no headings, no bullet characters.',
  'Be specific and brief, at most one short paragraph unless asked for more.',
].join(' ');

/**
 * The upstream call: POST /chat/completions with a Bearer token and a system
 * message. NVIDIA, xAI, OpenRouter and Anthropic's compatibility endpoint all
 * accept exactly this.
 */
export function buildLlmAskCall(
  provider,
  settings,
  question,
  context,
  env = process.env,
) {
  const payload = {
    model: settings.model,
    messages: [
      { role: 'system', content: LLM_ASK_INSTRUCTIONS },
      {
        role: 'user',
        content: `SCENE:\n${JSON.stringify(context ?? {})}\n\nQUESTION:\n${question}`,
      },
    ],
    max_tokens: llmMaxTokens(env),
    temperature: 0.3,
    stream: false,
  };
  // Only NIM's reasoning models accept this; sending it elsewhere is a 400, so
  // it is opt-in per provider, and NVIDIA_REASONING_EFFORT=none switches it off
  // for a NIM model that is not a reasoning model.
  const effort = env.NVIDIA_REASONING_EFFORT ?? 'low';
  if (
    provider.supportsReasoningEffort &&
    effort &&
    !/^(none|off|0)$/i.test(String(effort).trim())
  ) {
    payload.reasoning_effort = String(effort).trim();
  }
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

/**
 * Map an upstream response body to the route's own answer.
 * Upstream status codes are never relayed verbatim: an upstream 501 would
 * otherwise read as "add a key" in the panel, and a 401/403 would be mistaken
 * for this server rejecting the operator.
 */
export function llmAnswerFromUpstream(
  { ok, status },
  data,
  provider,
  settings,
) {
  if (!ok) {
    return {
      status: 502,
      payload: {
        error:
          data?.error?.message ||
          data?.detail ||
          `${provider.label} returned ${status}`,
        provider: provider.id,
        upstreamStatus: status,
      },
    };
  }
  const choice = data?.choices?.[0];
  const answer = String(choice?.message?.content || '').trim();
  if (!answer) {
    const truncated = choice?.finish_reason === 'length';
    return {
      status: 502,
      payload: {
        error: truncated
          ? 'The model spent its whole token budget before writing an answer. Raise LLM_MAX_TOKENS.'
          : `${provider.label} returned no answer.`,
        provider: provider.id,
      },
    };
  }
  return {
    status: 200,
    payload: {
      answer,
      provider: provider.id,
      model: data?.model || settings.model,
      usage: data?.usage || null,
    },
  };
}
