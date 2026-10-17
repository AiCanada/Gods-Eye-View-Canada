/**
 * CONFIRM ULTRA TOKEN SKILLS from the page: one bot per site on the
 * swarm's own key (POST /api/social/swarm/skill-check), each answer read
 * into verdicts and folded into one per skill. LLM asks every ready
 * Ask-panel model (GET /api/llm/providers, POST /api/llm/ask) or one
 * `llm:<id>`. Without a Grok Bot key, GROK BOT SWARM gives the whole check
 * to the Grok Bot computer when POWER UP has it, else copies the Chief of
 * Staff task, opens Grok Bot, and pastes it into the focused composer;
 * without an OPENAI DOTS key, OPENAI DOT SWARM copies the ChatGPT task,
 * opens ChatGPT, and pastes it; its report can then be pasted back and
 * read the same way.
 */
import { msgl, tl } from './i18n/marker.js';
import { GROK_BOT_UNCONFIGURED } from './socialSwarm.mjs';
import { GROK_BOT_GATEWAY_TOTAL_MS } from './grokBotGateway.mjs';
import {
  SKILL_CHECK_ANSWER_TOKENS,
  SKILL_CHECK_CHATGPT_BOT,
  SKILL_CHECK_CHIEF_BOT,
  cleanSkillCheckClaim,
  combineSkillVerdicts,
  planSkillCheckHandoff,
  readSkillCheckAnswer,
  skillCheckBots,
} from './ultraSkillCheck.mjs';
import { copyText as defaultCopyText } from './ui/copyText.js';

const CHECK_URL = '/api/social/swarm/skill-check';
const CHECK_COMPUTER_URL = '/api/social/swarm/skill-check/grok-bot';
const SWARM_STATUS_URL = '/api/social/swarm/status';
const GROK_BOT_OPEN_URL = '/api/social/grok-bot/open';
const OPENAI_DOTS_OPEN_URL = '/api/social/openai-dots/open';
const LLM_PROVIDERS_URL = '/api/llm/providers';
const LLM_ASK_URL = '/api/llm/ask';
/** The server gives a bot 150 s and the computer its total; the page waits a little longer. */
const BOT_TIMEOUT_MS = 150_000 + 10_000;
const COMPUTER_TIMEOUT_MS = GROK_BOT_GATEWAY_TOTAL_MS + 10_000;
/** Ask's own ceiling plus the same client margin the Outbreak LLM search uses. */
const LLM_ASK_TIMEOUT_MS = 240_000 + 10_000;

const LLM_UNCONFIGURED = msgl('No model key yet. Add one in POWER UP.');

function llmProviderId(provider) {
  const value = String(provider || '');
  if (value === 'llm') return '';
  return value.startsWith('llm:') ? value.slice(4) : '';
}

function readyLlmProviders(data) {
  return (Array.isArray(data?.providers) ? data.providers : []).filter(
    (item) => item?.ready && item.id,
  );
}

/**
 * Every ready Ask-panel model, or one `only` id, asked the same Chief of
 * Staff text. Their answers fold the same way as the swarm bots.
 */
async function runSkillCheckLlm({
  request,
  claim,
  skills,
  only = '',
  onBot,
  onProgress,
}) {
  const plan = planSkillCheckHandoff({ claim });
  if (!plan.ok) {
    return {
      ok: false,
      error: plan.error,
      via: 'llm',
      skills,
      verdicts: [],
      failed: 0,
      total: 0,
    };
  }
  let reachable = true;
  let roster = [];
  try {
    const response = await request(LLM_PROVIDERS_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!response?.ok) reachable = false;
    else roster = readyLlmProviders(await readJson(response));
  } catch {
    reachable = false;
  }
  if (only) roster = roster.filter((item) => item.id === only);
  if (!roster.length) {
    const error = !reachable
      ? tl('Could not reach the server for the model list.')
      : only
        ? tl('No key for this model. Add one in POWER UP.')
        : tl(LLM_UNCONFIGURED);
    return {
      ok: false,
      unconfigured: error,
      error,
      via: 'llm',
      skills,
      verdicts: [],
      failed: 0,
      total: 0,
    };
  }
  const total = roster.length;
  const answers = [];
  let back = 0;
  let failed = 0;
  await Promise.all(
    roster.map(async (provider) => {
      const bot = { id: provider.id, label: provider.label || provider.id };
      try {
        const { response, data } = await postJson(
          request,
          LLM_ASK_URL,
          {
            provider: provider.id,
            question: plan.text,
            context: { skillCheck: claim },
            answerTokens: SKILL_CHECK_ANSWER_TOKENS,
          },
          LLM_ASK_TIMEOUT_MS,
        );
        if (response.status === 501 || data?.unconfigured) {
          failed += 1;
          onBot?.({
            bot,
            error: String(data?.error || LLM_UNCONFIGURED),
          });
          return;
        }
        if (!response.ok || !data?.answer)
          throw new Error(data?.error || `HTTP ${response.status}`);
        const text = String(data.answer || '');
        answers.push({
          bot: bot.label,
          verdicts: readSkillCheckAnswer(text, skills),
        });
        onBot?.({ bot, text });
      } catch (error) {
        failed += 1;
        onBot?.({ bot, error: failure(error) });
      } finally {
        back += 1;
        onProgress?.({ back, total });
      }
    }),
  );
  if (!answers.length) {
    return {
      ok: false,
      error: tl('No model answered. Nothing was saved.'),
      via: 'llm',
      skills,
      verdicts: [],
      failed,
      total,
    };
  }
  return {
    ok: true,
    via: 'llm',
    skills,
    verdicts: combineSkillVerdicts(skills, answers),
    failed,
    total,
  };
}

async function readJson(response) {
  return response?.json?.().catch?.(() => null) ?? null;
}

async function readSwarmProviderStatus(request, given, field) {
  if (given && typeof given === 'object') return given;
  try {
    const response = await request(SWARM_STATUS_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!response?.ok) return null;
    const data = await readJson(response);
    return data?.[field] && typeof data[field] === 'object'
      ? data[field]
      : null;
  } catch {
    return null;
  }
}

async function readXaiStatus(request, given) {
  return readSwarmProviderStatus(request, given, 'xai');
}

async function readOpenaiStatus(request, given) {
  return readSwarmProviderStatus(request, given, 'openai');
}

async function postJson(request, url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { response, data: await readJson(response) };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function failure(error) {
  return error?.name === 'AbortError'
    ? tl('no answer in time')
    : error?.message || tl('request failed');
}

/**
 * A Chief of Staff report pasted back into the form, read as verdicts.
 *
 * @returns {{verdicts: object[]}}
 */
export function readPastedSkillReport(text, skills) {
  const verdicts = readSkillCheckAnswer(text, skills);
  return {
    verdicts: combineSkillVerdicts(skills, [
      { bot: SKILL_CHECK_CHIEF_BOT.label, verdicts },
    ]),
  };
}

/**
 * @param {object} options
 * @param {Function} options.request fetch-like (url, init) => Response
 * @param {string} [options.provider] `xai`, `openai`, `llm`, or `llm:<id>`
 * @param {object} options.claim the form's fields (see cleanSkillCheckClaim)
 * @param {{key?: boolean, computer?: boolean}} [options.xaiStatus]
 * @param {{key?: boolean}} [options.openaiStatus]
 * @param {(text: string) => Promise<void|boolean>|void|boolean} [options.copyText]
 * @param {(row: {bot: object, text?: string, error?: string, task?: boolean}) => void} [options.onBot]
 * @param {(row: {back: number, total: number}) => void} [options.onProgress]
 * @returns {Promise<{ok: boolean, error?: string, unconfigured?: string, via: string, skills: string[], verdicts: object[], failed: number, total: number, task?: string, opened?: boolean, copied?: boolean, pasted?: boolean}>}
 */
export async function runSkillCheck({
  request,
  provider,
  claim,
  xaiStatus,
  openaiStatus,
  copyText,
  onBot,
  onProgress,
} = {}) {
  const cleaned = cleanSkillCheckClaim(claim);
  if (!cleaned.ok) {
    return {
      ok: false,
      error: cleaned.error,
      via: '',
      skills: [],
      verdicts: [],
      failed: 0,
      total: 0,
    };
  }
  const { skills } = cleaned.claim;
  if (
    String(provider || '') === 'llm' ||
    String(provider || '').startsWith('llm:')
  ) {
    return runSkillCheckLlm({
      request,
      claim: cleaned.claim,
      skills,
      only: llmProviderId(provider),
      onBot,
      onProgress,
    });
  }
  const providerId = provider === 'openai' ? 'openai' : 'xai';
  if (providerId === 'xai') {
    const keys = await readXaiStatus(request, xaiStatus);
    if (keys && keys.key === false && keys.computer) {
      onProgress?.({ back: 0, total: 1 });
      try {
        const { response, data } = await postJson(
          request,
          CHECK_COMPUTER_URL,
          { claim: cleaned.claim },
          COMPUTER_TIMEOUT_MS,
        );
        if (response.status !== 501 && !data?.unconfigured) {
          if (!response.ok || !data?.ok)
            throw new Error(data?.error || `HTTP ${response.status}`);
          onBot?.({
            bot: SKILL_CHECK_CHIEF_BOT,
            text: String(data.text || ''),
          });
          onProgress?.({ back: 1, total: 1 });
          return {
            ok: true,
            via: 'computer',
            skills,
            verdicts: combineSkillVerdicts(skills, [
              {
                bot: SKILL_CHECK_CHIEF_BOT.label,
                verdicts: readSkillCheckAnswer(data.text, skills),
              },
            ]),
            failed: 0,
            total: 1,
          };
        }
      } catch (error) {
        onBot?.({ bot: SKILL_CHECK_CHIEF_BOT, error: failure(error) });
        return {
          ok: false,
          error: tl('Grok Bot: {error}', { error: failure(error) }),
          via: 'computer',
          skills,
          verdicts: [],
          failed: 1,
          total: 1,
        };
      }
    }
    if (keys && keys.key === false) {
      const plan = planSkillCheckHandoff({ claim: cleaned.claim });
      if (!plan.ok) {
        return {
          ok: false,
          error: plan.error,
          via: '',
          skills,
          verdicts: [],
          failed: 0,
          total: 0,
        };
      }
      let copied = false;
      try {
        copied =
          (await (typeof copyText === 'function'
            ? copyText(plan.text)
            : defaultCopyText(plan.text))) !== false;
      } catch {
        copied = false;
      }
      let opened = false;
      let pasted = false;
      try {
        const { response, data } = await postJson(
          request,
          GROK_BOT_OPEN_URL,
          { paste: true, text: plan.text },
          35_000,
        );
        opened = Boolean(response?.ok && data?.ok);
        pasted = data?.pasted === true;
      } catch {
        opened = false;
        pasted = false;
      }
      onBot?.({ bot: SKILL_CHECK_CHIEF_BOT, text: plan.text, task: true });
      return {
        ok: true,
        via: 'desktop',
        desktopApp: 'grok-bot',
        skills,
        verdicts: [],
        failed: 0,
        total: 1,
        task: plan.text,
        opened,
        copied,
        pasted,
      };
    }
  }
  if (providerId === 'openai') {
    const keys = await readOpenaiStatus(request, openaiStatus);
    if (keys && keys.key === false) {
      const plan = planSkillCheckHandoff({
        claim: cleaned.claim,
        lead: 'ChatGPT',
      });
      if (!plan.ok) {
        return {
          ok: false,
          error: plan.error,
          via: '',
          skills,
          verdicts: [],
          failed: 0,
          total: 0,
        };
      }
      let copied = false;
      try {
        copied =
          (await (typeof copyText === 'function'
            ? copyText(plan.text)
            : defaultCopyText(plan.text))) !== false;
      } catch {
        copied = false;
      }
      let opened = false;
      let pasted = false;
      try {
        const { response, data } = await postJson(
          request,
          OPENAI_DOTS_OPEN_URL,
          { paste: true, text: plan.text },
          35_000,
        );
        opened = Boolean(response?.ok && data?.ok);
        pasted = data?.pasted === true;
      } catch {
        opened = false;
        pasted = false;
      }
      onBot?.({ bot: SKILL_CHECK_CHATGPT_BOT, text: plan.text, task: true });
      return {
        ok: true,
        via: 'desktop',
        desktopApp: 'chatgpt',
        skills,
        verdicts: [],
        failed: 0,
        total: 1,
        task: plan.text,
        opened,
        copied,
        pasted,
      };
    }
  }
  const bots = skillCheckBots(cleaned.claim);
  const total = bots.length;
  const answers = [];
  let back = 0;
  let failed = 0;
  let unconfigured = '';
  await Promise.all(
    bots.map(async (bot) => {
      try {
        const { response, data } = await postJson(
          request,
          CHECK_URL,
          { provider: providerId, bot: bot.id, claim: cleaned.claim },
          BOT_TIMEOUT_MS,
        );
        if (response.status === 501 || data?.unconfigured) {
          unconfigured = String(
            data?.error ||
              (providerId === 'xai'
                ? GROK_BOT_UNCONFIGURED
                : tl(
                    'No OPENAI DOTS key yet. Add it in POWER UP → OPENAI DOTS.',
                  )),
          );
          return;
        }
        if (!response.ok || !data?.ok)
          throw new Error(data?.error || `HTTP ${response.status}`);
        answers.push({
          bot: bot.label,
          verdicts: readSkillCheckAnswer(data.text, skills),
        });
        onBot?.({ bot, text: String(data.text || '') });
      } catch (error) {
        failed += 1;
        onBot?.({ bot, error: failure(error) });
      } finally {
        back += 1;
        if (!unconfigured) onProgress?.({ back, total });
      }
    }),
  );
  if (unconfigured) {
    return {
      ok: false,
      unconfigured,
      error: unconfigured,
      via: providerId,
      skills,
      verdicts: [],
      failed,
      total,
    };
  }
  if (!answers.length) {
    return {
      ok: false,
      error: tl('No bot answered. Nothing was saved.'),
      via: providerId,
      skills,
      verdicts: [],
      failed,
      total,
    };
  }
  return {
    ok: true,
    via: providerId,
    skills,
    verdicts: combineSkillVerdicts(skills, answers),
    failed,
    total,
  };
}
