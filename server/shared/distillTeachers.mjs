/**
 * AI DISTILLATION's teachers (owner request 2026-10-19: "use all LLM's and
 * Grok bot and OpenAI dots", then "use all the fall back options for grokbot
 * and open AI dots"): who can answer, and one call to each. The same roster
 * serves as the students (owner request 2026-10-21): a student is asked the
 * same way, and the teachers grade and upgrade what it answered.
 *
 *   llm:<id>      the Ask panel's models (NVIDIA NIM, xAI Grok, OpenRouter,
 *                 Anthropic, the custom endpoint), their POWER UP keys,
 *                 one /chat/completions call (server/providers/llm/ask.js)
 *   grok-bot      GROK BOT, every way the swarm reaches it, in order: its own
 *                 key (xAI Responses, web search), the Grok Bot computer (the
 *                 report comes back), the Chief of Staff webhook (sent; the
 *                 reply is read back from the Grok Bot window), the Grok Bot
 *                 app (opened and pasted into; the reply is read back)
 *   openai-dots   OPENAI DOTS, in order: its own key (OpenAI Responses, web
 *                 search), the ChatGPT app (opened and pasted into; the reply
 *                 comes back through its Copy response button)
 *   local:<name>  a custom LLM trained in CUSTOM LLM TRAINING, on this PC
 *                 (ml.gevtape.llm_chat)
 *
 * A route that fails passes to the next one; the turn records each try. A
 * teacher's own conversation goes on where its route allows: previous_response_id
 * for a key's Responses API, the earlier turns as messages for a chat model,
 * the same bot's chat on the Grok Bot computer. Every prompt still carries
 * the question, the response id and the response, so any teacher can read it.
 *
 * Bringing an app's reply back is best effort (owner, 2026-10-19: "use same
 * method in fallback methods to copy and paste answers back in GEVC", "still
 * uses DOTs automation follow best effort"; server/shared/desktopReply.mjs).
 * When it cannot, the turn waits for the owner's paste, as before.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildLlmChatCall,
  llmAnswerTokens,
  llmAskTimeoutMs,
  llmProviderRoster,
  llmProviderSettings,
  resolveLlmProvider,
} from '../providers/llm/ask.js';
import {
  chiefOfStaffWebhook,
  grokBotGateway,
  swarmUpstream,
} from '../providers/socialSwarm.js';
import { readSwarmAnswer } from '../../src/socialSwarm.mjs';
import { createChild, defaultPython } from './aiWorldJobs.mjs';
import { askGrokBotComputer, readCapped } from './grokBotComputer.mjs';
import { createDesktopRound, desktopTag, tagPrompt } from './desktopReply.mjs';

/** How long an answer may be: the Ask panel's budget, raised for a teacher's full answer. */
export const DISTILL_ANSWER_TOKENS = 4096;
const BOT_TIMEOUT_MS = 180_000;
const WEBHOOK_TIMEOUT_MS = 20_000;
const LOCAL_TIMEOUT_MS = 15 * 60_000;
/** A Grok Bot computer on a swarm task is waited for this long before the next route. */
const COMPUTER_BUSY_WAIT_MS = 10 * 60_000;
const COMPUTER_BUSY_POLL_MS = 5_000;
const ANSWER_MAX = 40_000;

const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener?.(
      'abort',
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
      },
      { once: true },
    );
  });
/** What a reply brought back from an app records as its model. */
const APP_MODELS = Object.freeze({
  'grok-bot': 'Grok Bot app',
  chatgpt: 'ChatGPT app',
});
/**
 * The bots' routes, best first. `manual` ones cannot answer by themselves:
 * their reply is brought back from the app where this PC can, else the
 * owner pastes it.
 */
export const BOT_ROUTES = Object.freeze({
  'grok-bot': Object.freeze(['key', 'computer', 'webhook', 'desktop']),
  'openai-dots': Object.freeze(['key', 'desktop']),
});
export const MANUAL_ROUTES = Object.freeze(['webhook', 'desktop']);

/** A reply id when the provider gives none: stable for the same text. */
export function localResponseId(text) {
  return `gev-${createHash('sha1').update(String(text)).digest('hex').slice(0, 12)}`;
}

/** The routes a bot can use now, best first. */
export function botRoutes(id, env = process.env) {
  if (id === 'grok-bot') {
    const upstream = swarmUpstream('xai', env);
    const gate = grokBotGateway(env);
    const hook = chiefOfStaffWebhook(env);
    return BOT_ROUTES['grok-bot'].filter((route) =>
      route === 'key'
        ? Boolean(upstream.apiKey) && upstream.trusted
        : route === 'computer'
          ? gate.configured && gate.trusted
          : route === 'webhook'
            ? hook.configured && hook.trusted
            : true,
    );
  }
  if (id === 'openai-dots') {
    const upstream = swarmUpstream('openai', env);
    return BOT_ROUTES['openai-dots'].filter((route) =>
      route === 'key' ? Boolean(upstream.apiKey) && upstream.trusted : true,
    );
  }
  return [];
}

/** The custom LLMs trained here: .gev-data/llm/<name>/model with adapter.json. */
export function localModels(dataRoot) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(dataRoot, 'llm')).sort();
  } catch {
    return [];
  }
  return names.filter(
    (name) =>
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) &&
      fs.existsSync(path.join(dataRoot, 'llm', name, 'model', 'adapter.json')),
  );
}

/**
 * Every teacher, ready or not: id, label, kind, model, ready, the routes it
 * would use in order, whether an app's reply comes back by itself (`auto`),
 * and whether every route waits for a paste.
 */
export function teacherRoster({
  env = process.env,
  dataRoot,
  desktopReady = createDesktopRound({ env }).ready(),
}) {
  const llms = llmProviderRoster(env).map((p) => ({
    id: `llm:${p.id}`,
    label: p.label,
    kind: 'llm',
    model: p.model || '',
    ready: p.ready,
    routes: p.ready ? ['api'] : [],
    manualOnly: false,
  }));
  const bots = [
    {
      id: 'grok-bot',
      label: 'GROK BOT',
      app: 'grok-bot',
      model: swarmUpstream('xai', env).model,
    },
    {
      id: 'openai-dots',
      label: 'OPENAI DOTS',
      app: 'chatgpt',
      model: swarmUpstream('openai', env).model,
    },
  ].map((bot) => {
    const routes = botRoutes(bot.id, env);
    const auto =
      desktopReady === true && routes.some((r) => MANUAL_ROUTES.includes(r));
    return {
      ...bot,
      kind: 'bot',
      ready: routes.length > 0,
      routes,
      auto,
      manualOnly: !auto && routes.every((r) => MANUAL_ROUTES.includes(r)),
    };
  });
  const locals = localModels(dataRoot).map((name) => ({
    id: `local:${name}`,
    label: `TRAINED HERE · ${name.toUpperCase()}`,
    kind: 'local',
    model: name,
    ready: true,
    routes: ['local'],
    manualOnly: false,
  }));
  return [...llms, ...bots, ...locals];
}

/** The provider's own words for a refusal, short, never carrying a key. */
function refusalText(label, status, data, key) {
  const raw =
    data?.error?.message || data?.error || data?.message || data?.detail || '';
  let text = String(typeof raw === 'string' ? raw : '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 300);
  if (key) text = text.split(key).join('[key]');
  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [key]');
  return text
    ? `${label} refused (HTTP ${status}): ${text}`
    : `${label} refused (HTTP ${status})`;
}

const capped = (text) =>
  String(text ?? '')
    .trim()
    .slice(0, ANSWER_MAX);

/**
 * One answer from a teacher.
 * @param {object} teacher a teacherRoster() row
 * @param {object} ask
 * @param {string} ask.system  the system prompt
 * @param {string} ask.prompt  this turn's message (question, or review with id and response)
 * @param {Array<{role: string, content: string}>} [ask.history] this teacher's earlier turns
 * @param {{route: string, responseId: string}|null} [ask.previous] this teacher's last reply
 * @param {object} [ask.desktop] the app round trip (createDesktopRound)
 * @param {(step: {route: string, app: string}) => void} [ask.onStep] told when an app is answering
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [ask.sleep] the wait for a busy Grok Bot computer
 * @returns {Promise<{text: string, responseId: string, model: string, route: string, tried: Array} | {manual: true, route: string, app: string, prompt: string, tried: Array}>}
 */
export async function askTeacher(
  teacher,
  {
    system,
    prompt,
    history = [],
    previous = null,
    webSearch = true,
    signal,
    env = process.env,
    fetchImpl = globalThis.fetch,
    root,
    dataRoot,
    python = defaultPython(env),
    spawnImpl,
    desktop = createDesktopRound({ env }),
    onStep,
    sleep = defaultSleep,
    clock = Date.now,
    askComputer = askGrokBotComputer,
  },
) {
  const tried = [];
  const full = `${system}\n\n${prompt}`;
  const abortable = (ms) =>
    signal
      ? AbortSignal.any([AbortSignal.timeout(ms), signal])
      : AbortSignal.timeout(ms);
  for (const route of teacher.routes || []) {
    if (signal?.aborted)
      throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
    try {
      if (route === 'api') {
        const provider = resolveLlmProvider(teacher.id.slice(4));
        const settings = llmProviderSettings(provider, env);
        const call = buildLlmChatCall(
          provider,
          settings,
          [
            { role: 'system', content: system },
            ...history,
            { role: 'user', content: prompt },
          ],
          env,
          llmAnswerTokens(DISTILL_ANSWER_TOKENS, env),
        );
        const response = await fetchImpl(call.url, {
          method: 'POST',
          headers: call.headers,
          body: JSON.stringify(call.payload),
          redirect: 'error',
          signal: abortable(llmAskTimeoutMs(env)),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(
            refusalText(provider.label, response.status, data, settings.apiKey),
          );
        const text = capped(data?.choices?.[0]?.message?.content);
        if (!text) throw new Error(`${provider.label} returned no answer.`);
        return {
          text,
          responseId: String(data?.id || localResponseId(text)),
          model: String(data?.model || settings.model),
          route,
          tried,
        };
      }
      if (route === 'key') {
        const upstream = swarmUpstream(
          teacher.id === 'grok-bot' ? 'xai' : 'openai',
          env,
        );
        // The same conversation goes on from the key's own response id; one
        // made here (gev-…, when the key gave none) would be refused.
        const follow =
          previous?.route === 'key' &&
          previous.responseId &&
          !String(previous.responseId).startsWith('gev-');
        const payload = {
          model: upstream.model,
          ...(follow
            ? {
                previous_response_id: previous.responseId,
                input: [{ role: 'user', content: prompt }],
              }
            : {
                input: [
                  { role: 'system', content: system },
                  { role: 'user', content: prompt },
                ],
              }),
          ...(webSearch ? { tools: [{ type: 'web_search' }] } : {}),
          max_output_tokens: DISTILL_ANSWER_TOKENS,
        };
        const response = await fetchImpl(upstream.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${upstream.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          redirect: 'error',
          signal: abortable(BOT_TIMEOUT_MS),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(
            refusalText(upstream.label, response.status, data, upstream.apiKey),
          );
        const answer = readSwarmAnswer(data);
        const sources = answer.sources
          .map((s) => `- ${s.title ? `${s.title}: ` : ''}${s.url}`)
          .join('\n');
        const text = capped(
          sources ? `${answer.text}\n\nSources:\n${sources}` : answer.text,
        );
        if (!answer.text)
          throw new Error(`${upstream.label} returned no answer.`);
        return {
          text,
          responseId: String(data?.id || localResponseId(text)),
          model: String(data?.model || upstream.model),
          route,
          tried,
        };
      }
      if (route === 'computer') {
        const gate = grokBotGateway(env);
        // The same bot's chat goes on: a review turn needs only its own message.
        const once = () =>
          askComputer({
            gate,
            prompt: previous?.route === 'computer' ? prompt : full,
            fetchImpl,
            signal,
            busyMessage: 'Grok Bot is on a task from this map.',
          });
        // On a swarm task it is waited for, up to ten minutes, before the next route.
        const until = clock() + COMPUTER_BUSY_WAIT_MS;
        let report;
        for (;;) {
          try {
            report = await once();
            break;
          } catch (error) {
            if (
              error?.code !== 'busy' ||
              clock() + COMPUTER_BUSY_POLL_MS > until
            )
              throw error;
            await sleep(COMPUTER_BUSY_POLL_MS, signal);
          }
        }
        const text = capped(report);
        if (!text) throw new Error('Grok Bot returned no answer.');
        return {
          text,
          responseId: localResponseId(text),
          model: gate.named || gate.agent,
          route,
          tried,
        };
      }
      if (route === 'webhook') {
        const hook = chiefOfStaffWebhook(env);
        const auto = desktop.ready();
        const tag = auto ? desktopTag() : '';
        const response = await fetchImpl(hook.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${hook.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            source: "God's Eye View",
            kind: 'ai-distillation',
            text: auto ? tagPrompt(full, tag) : full,
            sentAt: new Date().toISOString(),
          }),
          redirect: 'error',
          signal: abortable(WEBHOOK_TIMEOUT_MS),
        });
        const said = await readCapped(response, 16 * 1024);
        if (!response.ok) {
          let data = {};
          try {
            data = JSON.parse(said);
          } catch {
            data = { message: said };
          }
          throw new Error(
            refusalText('Grok Bot', response.status, data, hook.key),
          );
        }
        // Sent: its answer shows in Grok Bot. Read it from there, else the owner pastes it.
        let note = '';
        if (auto) {
          onStep?.({ route, app: 'grok-bot' });
          try {
            const got = await desktop.read({ app: 'grok-bot', tag, signal });
            const text = capped(got.text);
            if (text)
              return {
                text,
                responseId: localResponseId(text),
                model: APP_MODELS['grok-bot'],
                route,
                how: got.how,
                tried,
              };
          } catch (error) {
            if (signal?.aborted) throw error;
            note = String(error?.message || error).slice(0, 300);
          }
        }
        return {
          manual: true,
          route,
          app: 'grok-bot',
          prompt: full,
          sent: true,
          ...(note ? { note } : {}),
          tried,
        };
      }
      if (route === 'desktop') {
        const app = teacher.app || 'grok-bot';
        let note = '';
        let sent = false;
        if (desktop.ready()) {
          onStep?.({ route, app });
          try {
            const got = await desktop.ask({ app, prompt: full, signal });
            const text = capped(got.text);
            if (text)
              return {
                text,
                responseId: localResponseId(text),
                model: APP_MODELS[app] || app,
                route,
                how: got.how,
                tried,
              };
            note = "The app's reply came back empty.";
            sent = true;
          } catch (error) {
            if (signal?.aborted) throw error;
            note = String(error?.message || error).slice(0, 300);
            sent = error?.pasted === true;
          }
        }
        // The owner pastes the reply (and the prompt too, when it is not in the app yet).
        return {
          manual: true,
          route,
          app,
          prompt: full,
          sent,
          ...(note ? { note } : {}),
          tried,
        };
      }
      if (route === 'local') {
        const text = capped(
          await askLocal({
            teacher,
            prompt: full,
            root,
            dataRoot,
            python,
            spawnImpl,
            signal,
          }),
        );
        if (!text) throw new Error(`${teacher.label} returned no answer.`);
        return {
          text,
          responseId: localResponseId(text),
          model: teacher.model,
          route,
          tried,
        };
      }
    } catch (error) {
      if (signal?.aborted)
        throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
      const timedOut =
        error?.name === 'TimeoutError' || error?.name === 'AbortError';
      tried.push({
        route,
        error: timedOut
          ? 'did not answer in time'
          : String(error?.message || error).slice(0, 300),
      });
    }
  }
  const err = new Error(
    tried.length
      ? `${teacher.label}: ${tried.map((t) => `${t.route} · ${t.error}`).join('; ')}`
      : `${teacher.label} is not set up: add its key in POWER UP.`,
  );
  err.tried = tried;
  throw err;
}

/** A custom LLM's answer from ml.gevtape.llm_chat --json. */
function askLocal({
  teacher,
  prompt,
  root,
  dataRoot,
  python,
  spawnImpl,
  signal,
}) {
  return new Promise((resolve, reject) => {
    let answer = null;
    let failed = '';
    const child = createChild({
      command: python[0],
      args: [
        ...python.slice(1),
        '-m',
        'ml.gevtape.llm_chat',
        '--model',
        path.join(dataRoot, 'llm', teacher.model, 'model'),
        '--prompt',
        prompt,
        '--max-new',
        '1024',
        '--json',
      ],
      cwd: root,
      spawnImpl,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        MLFLOW_DISABLE_TELEMETRY: 'true',
        DO_NOT_TRACK: 'true',
      },
      onEvent: (event) => {
        if (event?.event === 'answer') answer = String(event.answer || '');
        if (event?.event === 'error') failed = String(event.message || '');
      },
      onExit: ({ code, tail }) => {
        clearTimeout(timer);
        if (answer !== null && code === 0) resolve(answer);
        else reject(new Error(failed || tail.at(-1) || `exit ${code}`));
      },
    });
    const timer = setTimeout(() => child.kill(), LOCAL_TIMEOUT_MS);
    timer.unref?.();
    signal?.addEventListener('abort', () => child.kill(), { once: true });
  });
}
