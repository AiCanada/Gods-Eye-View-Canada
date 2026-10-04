import {
  resolvedAllowedHosts,
  servedRequestOrigin,
} from './common/allowed-hosts.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { readRequestBody } from './common/request.js';
import { fetchNominatimPlace } from './regional/place.js';
import { admitLlmRequestFrom } from './llm/ask.js';
import { enforceRateLimit, openAiRateLimiter } from './openai/rate-limit.js';
import { keySetupValueProblem } from '../../src/keySetupCore.mjs';
import {
  LOCAL_PROVIDER_CHANGED_MESSAGE,
  localProviderTrusted,
} from '../shared/localIntegrity.mjs';
import {
  SOCIAL_SWARM_PROVIDERS,
  planSwarmBot,
  planSwarmHandoff,
  readSwarmAnswer,
} from '../../src/socialSwarm.mjs';

/** One bot's body is a few hundred bytes; this is far beyond any of them. */
const SWARM_BODY_BYTES = 8 * 1024;
/** A bot searches, reads and reasons before it writes: give it the time. */
export const SOCIAL_SWARM_BOT_TIMEOUT_MS = 150_000;
/** Seven bots a swarm: two swarms a minute from one address, four overall. */
export const SOCIAL_SWARM_BOTS_PER_MINUTE = 14;
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';
/** The model OpenAI's dots run on; OPENAI_SWARM_MODEL overrides it. */
export const OPENAI_SWARM_MODEL_DEFAULT = 'gpt-6-astra';
/** Grok's own default, as the Ask panel's; XAI_SWARM_MODEL overrides it. */
export const XAI_SWARM_MODEL_DEFAULT = 'grok-4.6';
/** A press is one routine run in Grok Bot: four a minute from one address. */
export const CHIEF_OF_STAFF_PER_MINUTE = 4;
const CHIEF_OF_STAFF_TIMEOUT_MS = 20_000;
/** What is read of the webhook's answer, which is never passed on. */
const CHIEF_OF_STAFF_ANSWER_BYTES = 16 * 1024;
/** Nearest-city lookups per address a minute; Nominatim itself is one a second for the whole app. */
export const NEAREST_CITY_PER_MINUTE = 20;
const NEAREST_CITY_TIMEOUT_MS = 8_000;
const NEAREST_CITY_CACHE_MS = 10 * 60_000;
const NEAREST_CITY_CACHE_MAX = 200;

const HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function send(res, status, payload, extra = {}) {
  res.writeHead(status, { ...HEADERS, ...extra });
  res.end(JSON.stringify(payload));
}

/**
 * The key, address and model one swarm runs on, read from the live
 * environment at every request so a POWER UP save applies at once. Each
 * swarm has a key of its own, never the Ask panel's or voice control's:
 * GROK_BOT_API_KEY (POWER UP → GROK BOT) and OPENAI_DOTS_API_KEY
 * (POWER UP → OPENAI DOTS). XAI_SWARM_MODEL and OPENAI_SWARM_MODEL choose
 * the models.
 */
export function swarmUpstream(providerId, env = process.env) {
  if (providerId === 'xai') {
    return {
      label: 'xAI',
      keyTitle: SOCIAL_SWARM_PROVIDERS.xai.keyTitle,
      apiKey: String(env.GROK_BOT_API_KEY ?? '').trim(),
      url: XAI_RESPONSES_URL,
      model:
        String(env.XAI_SWARM_MODEL ?? '').trim() || XAI_SWARM_MODEL_DEFAULT,
      trusted: localProviderTrusted('grokBot', env),
    };
  }
  return {
    label: 'OpenAI',
    keyTitle: SOCIAL_SWARM_PROVIDERS.openai.keyTitle,
    apiKey: String(env.OPENAI_DOTS_API_KEY ?? '').trim(),
    url: OPENAI_RESPONSES_URL,
    model:
      String(env.OPENAI_SWARM_MODEL ?? '').trim() || OPENAI_SWARM_MODEL_DEFAULT,
    trusted: localProviderTrusted('openaiDots', env),
  };
}

/**
 * Where GROK BOT SWARM's task goes without a Grok Bot key: a webhook
 * routine of the Chief of Staff bot in Grok Bot (POWER UP → GROK BOT —
 * CHIEF OF STAFF). Configured only when both halves pass the rule POWER UP
 * saved them under, re-checked here so a hand edit cannot send the key
 * anywhere but Grok Bot.
 */
export function chiefOfStaffWebhook(env = process.env) {
  const url = String(env.GROK_BOT_WEBHOOK_URL ?? '').trim();
  const key = String(env.GROK_BOT_WEBHOOK_KEY ?? '').trim();
  const configured =
    Boolean(url && key) &&
    !keySetupValueProblem('GROK_BOT_WEBHOOK_URL', url) &&
    !keySetupValueProblem('GROK_BOT_WEBHOOK_KEY', key) &&
    /^[\x21-\x7e]+$/.test(key);
  return {
    url,
    key,
    configured,
    trusted: localProviderTrusted('grokBotWebhook', env),
  };
}

/** The provider's own words for a refusal, short, and never carrying the key. */
function upstreamError(data, status, upstream) {
  const raw = data?.error?.message || data?.error || data?.message || '';
  let text = String(typeof raw === 'string' ? raw : '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 300);
  if (upstream.apiKey) text = text.split(upstream.apiKey).join('[key]');
  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [key]');
  return text
    ? `${upstream.label} refused the bot (HTTP ${status}): ${text}`
    : `${upstream.label} refused the bot (HTTP ${status})`;
}

/** One bot: one request to the chosen provider, with its search tool. */
async function handleSwarmBot(req, res, allow, allowedHosts) {
  // A Host this server serves, an exact Origin, JSON: a DNS-rebinding page
  // naming its own host cannot spend the keys or read the answers.
  const admission = admitLlmRequestFrom(req, allowedHosts);
  if (!admission.ok) {
    send(res, admission.status, { error: admission.error });
    return;
  }
  let raw;
  try {
    raw = await readRequestBody(req, SWARM_BODY_BYTES);
  } catch {
    send(res, 413, { error: 'Request too large' });
    return;
  }
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    send(res, 400, { error: 'Malformed request body' });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    send(res, 400, { error: 'Malformed request body' });
    return;
  }
  const providerId =
    typeof body.provider === 'string' &&
    Object.hasOwn(SOCIAL_SWARM_PROVIDERS, body.provider)
      ? body.provider
      : '';
  if (!providerId) {
    send(res, 400, { error: 'Unknown swarm.' });
    return;
  }
  const upstream = swarmUpstream(providerId);
  if (upstream.apiKey && !upstream.trusted) {
    send(res, 409, {
      error: LOCAL_PROVIDER_CHANGED_MESSAGE,
      provider: providerId,
    });
    return;
  }
  if (!upstream.apiKey) {
    // Distinct from a failure: the box says "add a key", once.
    send(res, 501, {
      error: `No ${upstream.keyTitle} key yet. Add it in POWER UP → ${upstream.keyTitle}.`,
      unconfigured: true,
      provider: providerId,
    });
    return;
  }
  const plan = planSwarmBot({
    provider: providerId,
    bot: body.bot,
    instructions: body.instructions,
    place: body.place,
    latitude: body.latitude,
    longitude: body.longitude,
    model: upstream.model,
    now: new Date(),
  });
  if (!plan.ok) {
    send(res, 400, { error: plan.error, provider: providerId });
    return;
  }
  // Paid from here on: a refused or keyless bot costs no slot.
  if (!allow(clientKey(req))) {
    send(
      res,
      429,
      { error: 'Too many bots this minute. Wait a minute, then try again.' },
      { 'Retry-After': '30' },
    );
    return;
  }
  if (!enforceRateLimit(openAiRateLimiter(), req, res)) return;
  // A closed tab must not leave a billed search running to completion.
  const disconnect = new AbortController();
  res.on('close', () => disconnect.abort());
  try {
    const response = await fetch(upstream.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstream.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(plan.payload),
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(SOCIAL_SWARM_BOT_TIMEOUT_MS),
        disconnect.signal,
      ]),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      send(res, 502, {
        error: upstreamError(data, response.status, upstream),
        provider: providerId,
        bot: plan.bot.id,
      });
      return;
    }
    const answer = readSwarmAnswer(data);
    const usage =
      data?.usage && typeof data.usage === 'object' ? data.usage : {};
    send(res, 200, {
      ok: true,
      provider: providerId,
      bot: plan.bot.id,
      label: plan.bot.label,
      text: answer.text,
      sources: answer.sources,
      model: String(data?.model || upstream.model).slice(0, 80),
      usage: {
        input_tokens: Number(usage.input_tokens) || 0,
        output_tokens: Number(usage.output_tokens) || 0,
      },
    });
  } catch (error) {
    if (disconnect.signal.aborted) return; // nobody is listening any more
    const timedOut =
      error?.name === 'TimeoutError' || error?.name === 'AbortError';
    send(res, 504, {
      error: timedOut
        ? `${upstream.label} did not answer in time.`
        : `The bot could not reach ${upstream.label}.`,
      provider: providerId,
      bot: plan.bot.id,
    });
  }
}

/**
 * What the box needs before a press: whether each swarm has its own key,
 * and whether Grok's Chief of Staff webhook is set. Booleans only. Asked
 * by this page alone (a Host this server serves, a same-origin fetch).
 */
/** A GET from this page only: a Host this server serves, a same-origin or typed fetch. */
function admitSameOriginGet(req, res, allowedHosts) {
  if (req.method !== 'GET') {
    send(res, 405, { error: 'Method not allowed' });
    return false;
  }
  const site = String(
    req.headers?.['sec-fetch-site'] ?? 'same-origin',
  ).toLowerCase();
  if (
    !servedRequestOrigin(req, allowedHosts) ||
    (site !== 'same-origin' && site !== 'none')
  ) {
    send(res, 403, { error: 'Same-origin requests only' });
    return false;
  }
  return true;
}

function handleSwarmStatus(req, res, allowedHosts) {
  if (!admitSameOriginGet(req, res, allowedHosts)) return;
  const xai = swarmUpstream('xai');
  const openai = swarmUpstream('openai');
  send(res, 200, {
    xai: {
      key: Boolean(xai.apiKey),
      chiefOfStaff: chiefOfStaffWebhook().configured,
    },
    openai: { key: Boolean(openai.apiKey) },
  });
}

/**
 * The nearest city to the map point, for the Chief of Staff's task: a post
 * names a town, not a point. One reverse lookup through the app's shared
 * Nominatim queue, kept ten minutes for its 0.01° cell, and an empty answer
 * when there is none (at sea) or the lookup fails: the task then asks the
 * bot to find it.
 */
/** A name fit for the task: one line, at most 60 characters. */
function placeName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * The town a point is in: the city, town or village from one Nominatim
 * reverse lookup, through the app's shared one-a-second queue, with its
 * province or state. A province alone is not a town. '' when there is
 * none (at sea) or the lookup fails: the page then uses its built-in
 * gazetteer, or the task asks the bot.
 */
export async function nearestCityFor(point, { lookup }) {
  try {
    const place = await lookup(point, {
      signal: AbortSignal.timeout(NEAREST_CITY_TIMEOUT_MS),
    });
    const region = placeName(place?.region);
    const locality = placeName(place?.locality);
    if (!locality) return '';
    return locality === region
      ? locality
      : [locality, region].filter(Boolean).join(', ');
  } catch {
    return '';
  }
}

async function handleNearestCity(req, res, allowedHosts, lookup, allow, cache) {
  if (!admitSameOriginGet(req, res, allowedHosts)) return;
  const query = new URL(req.url || '/', 'http://localhost').searchParams;
  const latitude = Number(query.get('lat'));
  const longitude = Number(query.get('lon'));
  if (
    !query.has('lat') ||
    !query.has('lon') ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    send(res, 400, { error: 'Give lat and lon.' });
    return;
  }
  const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
  const kept = cache.get(key);
  if (kept && Date.now() - kept.at < NEAREST_CITY_CACHE_MS) {
    send(res, 200, { city: kept.city });
    return;
  }
  if (!allow(clientKey(req))) {
    send(
      res,
      429,
      { error: 'Too many lookups this minute.' },
      { 'Retry-After': '30' },
    );
    return;
  }
  const city = await nearestCityFor({ latitude, longitude }, { lookup });
  cache.delete(key);
  cache.set(key, { city, at: Date.now() });
  while (cache.size > NEAREST_CITY_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  send(res, 200, { city });
}

/** The webhook's refusal, short, and never carrying its key. */
function webhookError(status, raw, key) {
  let text = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 200);
  if (key) text = text.split(key).join('[key]');
  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [key]');
  return text
    ? `Grok Bot refused the task (HTTP ${status}): ${text}`
    : `Grok Bot refused the task (HTTP ${status})`;
}

/**
 * GROK BOT SWARM without a Grok Bot key: one POST of the swarm's task to
 * the Chief of Staff bot's webhook routine, which runs it once in Grok Bot.
 * Its report comes back in Grok Bot; the webhook's answer is not passed on.
 */
async function handleChiefOfStaff(req, res, allow, allowedHosts, fetchImpl) {
  const admission = admitLlmRequestFrom(req, allowedHosts);
  if (!admission.ok) {
    send(res, admission.status, { error: admission.error });
    return;
  }
  let raw;
  try {
    raw = await readRequestBody(req, SWARM_BODY_BYTES);
  } catch {
    send(res, 413, { error: 'Request too large' });
    return;
  }
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    send(res, 400, { error: 'Malformed request body' });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    send(res, 400, { error: 'Malformed request body' });
    return;
  }
  const hook = chiefOfStaffWebhook();
  if (!hook.configured) {
    send(res, 501, {
      error:
        'No Chief of Staff webhook yet. Add it in POWER UP → GROK BOT — CHIEF OF STAFF.',
      unconfigured: true,
    });
    return;
  }
  if (!hook.trusted) {
    send(res, 409, { error: LOCAL_PROVIDER_CHANGED_MESSAGE });
    return;
  }
  const plan = planSwarmHandoff({
    instructions: body.instructions,
    place: body.place,
    nearestCity: body.nearestCity,
    latitude: body.latitude,
    longitude: body.longitude,
    now: new Date(),
  });
  if (!plan.ok) {
    send(res, 400, { error: plan.error });
    return;
  }
  if (!allow(clientKey(req))) {
    send(
      res,
      429,
      {
        error: 'Too many hand-offs this minute. Wait a minute, then try again.',
      },
      { 'Retry-After': '30' },
    );
    return;
  }
  const disconnect = new AbortController();
  res.on('close', () => disconnect.abort());
  try {
    const response = await fetchImpl(hook.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hook.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: "God's Eye View",
        kind: 'grok-bot-swarm',
        text: plan.text,
        place: plan.place,
        nearestCity: plan.nearestCity,
        latitude: plan.latitude,
        longitude: plan.longitude,
        sentAt: new Date().toISOString(),
      }),
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(CHIEF_OF_STAFF_TIMEOUT_MS),
        disconnect.signal,
      ]),
    });
    const answer = await readCapped(response, CHIEF_OF_STAFF_ANSWER_BYTES);
    if (!response.ok) {
      let said = answer;
      try {
        const data = JSON.parse(answer);
        said = data?.error?.message || data?.error || data?.message || '';
      } catch {
        /* plain text, or nothing */
      }
      send(res, 502, {
        error: webhookError(
          response.status,
          typeof said === 'string' ? said : '',
          hook.key,
        ),
      });
      return;
    }
    send(res, 200, { ok: true, sent: true, at: Date.now() });
  } catch (error) {
    if (disconnect.signal.aborted) return;
    const timedOut =
      error?.name === 'TimeoutError' || error?.name === 'AbortError';
    send(res, 504, {
      error: timedOut
        ? 'Grok Bot did not take the task in time.'
        : 'The task could not reach Grok Bot.',
    });
  }
}

/** Up to `limit` bytes of an answer as text; the rest is not read. */
async function readCapped(response, limit) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body || []) {
      total += chunk.length;
      if (total > limit) break;
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    /* what arrived is enough */
  } finally {
    try {
      await response.body?.cancel();
    } catch {
      /* already closed */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Vite plugin: the Social Media Analysis bot swarms. On demand only: a press
 * of GROK BOT SWARM or OPENAI BOT SWARM sends one POST per bot, and nothing
 * calls this on a timer. Keys stay server-side.
 *
 *   POST /api/social/swarm — { provider, bot, instructions, place, latitude, longitude }
 *   GET  /api/social/swarm/status — which swarms have a key, and the Chief of Staff webhook
 *   POST /api/social/swarm/chief-of-staff — { instructions, place, nearestCity, latitude, longitude }: Grok's task to that webhook
 *   GET  /api/social/swarm/nearest-city?lat=&lon= — { city } for that task, empty when none
 */
export function socialSwarmProxy({
  fetchImpl,
  placeLookup = fetchNominatimPlace,
} = {}) {
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: SOCIAL_SWARM_BOTS_PER_MINUTE,
    globalMax: SOCIAL_SWARM_BOTS_PER_MINUTE * 2,
  });
  const allowChief = makeRateLimiter({
    windowMs: 60_000,
    max: CHIEF_OF_STAFF_PER_MINUTE,
    globalMax: CHIEF_OF_STAFF_PER_MINUTE * 2,
  });
  const allowPlace = makeRateLimiter({
    windowMs: 60_000,
    max: NEAREST_CITY_PER_MINUTE,
    globalMax: NEAREST_CITY_PER_MINUTE * 2,
  });
  const cities = new Map();
  /** @param {'server' | 'preview'} section - Which Vite server's hosts apply. */
  function install(server, section) {
    const allowedHosts = resolvedAllowedHosts(server.config, section);
    server.middlewares.use('/api/social/swarm', (req, res) => {
      const pathName = String(req.url || '/').split('?')[0];
      const failed =
        (error = 'The bot failed.') =>
        () => {
          if (!res.headersSent) send(res, 500, { error });
        };
      if (pathName === '/status') {
        handleSwarmStatus(req, res, allowedHosts);
        return;
      }
      if (pathName === '/nearest-city') {
        handleNearestCity(
          req,
          res,
          allowedHosts,
          placeLookup,
          allowPlace,
          cities,
        ).catch(failed('The lookup failed.'));
        return;
      }
      if (pathName === '/chief-of-staff') {
        handleChiefOfStaff(
          req,
          res,
          allowChief,
          allowedHosts,
          fetchImpl || globalThis.fetch,
        ).catch(failed('The hand-off failed.'));
        return;
      }
      if (pathName !== '/' && pathName !== '') {
        send(res, 404, { error: 'Not found' });
        return;
      }
      handleSwarmBot(req, res, allow, allowedHosts).catch(failed());
    });
  }
  return {
    name: 'social-swarm-proxy',
    configureServer(server) {
      install(server, 'server');
    },
    configurePreviewServer(server) {
      install(server, 'preview');
    },
  };
}
