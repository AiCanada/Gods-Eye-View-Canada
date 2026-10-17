/**
 * Send one bot per platform from GEVC and retrieve each answer into GEVC.
 * With a Grok Bot key, every press POSTs `/api/social/swarm`. Without one,
 * GROK BOT SWARM uses the Grok Bot computer when POWER UP has it, else it
 * copies the Chief of Staff task, opens Grok Bot, and pastes it into the
 * focused composer (Chief of Staff). Without an OPENAI DOTS key, OPENAI
 * BOT SWARM copies the ChatGPT task, opens ChatGPT, and pastes it. No
 * Chief of Staff webhook. What the operator reads is marked with tl()
 * (src/i18n/marker.js): Quebec French on the page.
 */
import { tl } from './i18n/marker.js';
import {
  GROK_BOT_UNCONFIGURED,
  SOCIAL_SWARM_BOTS,
  SOCIAL_SWARM_CHATGPT_BOT,
  SOCIAL_SWARM_CHIEF_BOT,
  SOCIAL_SWARM_PROVIDERS,
  planSwarmHandoff,
  swarmBotFoundNothing,
} from './socialSwarm.mjs';
import { GROK_BOT_GATEWAY_TOTAL_MS } from './grokBotGateway.mjs';
import { copyText as defaultCopyText } from './ui/copyText.js';

const SWARM_URL = '/api/social/swarm';
const SWARM_STATUS_URL = '/api/social/swarm/status';
const SWARM_COMPUTER_URL = '/api/social/swarm/grok-bot';
const NEAREST_CITY_URL = '/api/social/swarm/nearest-city';
const GROK_BOT_OPEN_URL = '/api/social/grok-bot/open';
const OPENAI_DOTS_OPEN_URL = '/api/social/openai-dots/open';
/** The server gives a bot 150 s; the box waits a little longer for its answer. */
const SWARM_BOT_TIMEOUT_MS = 150_000;
/**
 * The server gives the Grok Bot computer GROK_BOT_GATEWAY_TOTAL_MS in all;
 * the box waits a little longer for its answer.
 */
const SWARM_COMPUTER_TIMEOUT_MS = GROK_BOT_GATEWAY_TOTAL_MS;
const CLIENT_TIMEOUT_MARGIN_MS = 10_000;
const NEAREST_CITY_WAIT_MS = 25_000;

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

/**
 * The town a point is in: the server's reverse lookup, else the box's own
 * gazetteer (`fallbackCity`, e.g. at sea or in the woods), else ''.
 */
async function nearestCity(request, latitude, longitude, fallbackCity) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  const found = await nearestCityFromServer(request, lat, lon);
  if (found) return found;
  try {
    const known = fallbackCity?.(lat, lon);
    if (!known?.name) return '';
    const km = Math.round(Number(known.distKm) || 0);
    return km >= 2 ? `${known.name} (about ${km} km away)` : known.name;
  } catch {
    return '';
  }
}

async function nearestCityFromServer(request, lat, lon) {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(
    () => controller.abort(),
    NEAREST_CITY_WAIT_MS,
  );
  try {
    const response = await request(
      `${NEAREST_CITY_URL}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`,
      { headers: { Accept: 'application/json' }, signal: controller.signal },
    );
    if (!response?.ok) return '';
    const data = await readJson(response);
    return typeof data?.city === 'string' ? data.city : '';
  } catch {
    return '';
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * Put the task on the clipboard: true only when a clipboard took it. A
 * `copyText` that answers false (no clipboard here) is not a copy. Plain
 * http pages (the phone mirror) have no navigator.clipboard, so the default
 * falls back to a hidden-textarea copy and then the share sheet.
 */
async function writeClipboard(text, copyText) {
  if (typeof copyText === 'function') {
    try {
      return (await copyText(text)) !== false;
    } catch {
      return false;
    }
  }
  // The clipboard, then a hidden-textarea copy, then the share sheet.
  return defaultCopyText(text);
}

async function openDesktop(request, url, failed, body = {}) {
  try {
    const response = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await readJson(response);
    if (response?.ok && data?.ok) {
      return { ok: true, pasted: data.pasted === true };
    }
    return {
      ok: false,
      error: String(data?.error || failed),
      pasted: false,
    };
  } catch {
    return { ok: false, error: failed, pasted: false };
  }
}

function countSection(text, onBot, bot) {
  const empty = swarmBotFoundNothing(text);
  onBot?.({ bot, text, sources: [] });
  return empty ? 'empty' : 'found';
}

async function runGrokBotComputer({
  request,
  instructions,
  place,
  latitude,
  longitude,
  fallbackCity,
  onBot,
  onProgress,
}) {
  const city = await nearestCity(request, latitude, longitude, fallbackCity);
  const controller = new AbortController();
  const timer = globalThis.setTimeout(
    () => controller.abort(),
    SWARM_COMPUTER_TIMEOUT_MS + CLIENT_TIMEOUT_MARGIN_MS,
  );
  onProgress?.({ back: 0, total: 1 });
  try {
    const response = await request(SWARM_COMPUTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instructions,
        place,
        nearestCity: city,
        latitude,
        longitude,
      }),
      signal: controller.signal,
    });
    const data = await readJson(response);
    if (response.status === 501 || data?.unconfigured) {
      return {
        found: 0,
        empty: 0,
        failed: 0,
        unconfigured: String(data?.error || GROK_BOT_UNCONFIGURED),
        total: 1,
        via: '',
      };
    }
    if (!response.ok || !data?.ok)
      throw new Error(data?.error || `HTTP ${response.status}`);
    const sections = Array.isArray(data.sections) ? data.sections : [];
    let found = 0;
    let empty = 0;
    if (sections.length) {
      for (const row of sections) {
        const bot =
          SOCIAL_SWARM_BOTS.find((item) => item.id === row.bot) ||
          SOCIAL_SWARM_CHIEF_BOT;
        if (countSection(row.text, onBot, bot) === 'empty') empty += 1;
        else found += 1;
      }
    } else {
      if (countSection(data.text, onBot, SOCIAL_SWARM_CHIEF_BOT) === 'empty') {
        empty += 1;
      } else found += 1;
    }
    onProgress?.({ back: 1, total: 1 });
    return {
      found,
      empty,
      failed: 0,
      unconfigured: '',
      total: 1,
      via: 'computer',
    };
  } catch (error) {
    const reason =
      error?.name === 'AbortError'
        ? tl('no answer in time')
        : error?.message || tl('request failed');
    onBot?.({ bot: SOCIAL_SWARM_CHIEF_BOT, error: reason });
    return {
      found: 0,
      empty: 0,
      failed: 1,
      unconfigured: '',
      total: 1,
      via: 'computer',
    };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function runGrokBotDesktop({
  request,
  instructions,
  place,
  latitude,
  longitude,
  fallbackCity,
  onBot,
  copyText,
}) {
  const city = await nearestCity(request, latitude, longitude, fallbackCity);
  const plan = planSwarmHandoff({
    instructions,
    place,
    nearestCity: city,
    latitude,
    longitude,
    now: new Date(),
  });
  if (!plan.ok) {
    return {
      found: 0,
      empty: 0,
      failed: 0,
      unconfigured: plan.error,
      total: 1,
      via: '',
    };
  }
  const copied = await writeClipboard(plan.text, copyText);
  const opened = await openDesktop(
    request,
    GROK_BOT_OPEN_URL,
    tl('Grok Bot could not be opened.'),
    { paste: true, text: plan.text },
  );
  // The task itself, for the log: `task` marks it, so no box reads it as a
  // bot's findings.
  onBot?.({
    bot: SOCIAL_SWARM_CHIEF_BOT,
    text: plan.text,
    sources: [],
    task: true,
  });
  return {
    found: 0,
    empty: 0,
    failed: 0,
    unconfigured: '',
    total: 1,
    via: 'desktop',
    desktopApp: 'grok-bot',
    opened: opened.ok,
    copied,
    pasted: opened.pasted === true,
    openError: opened.ok ? '' : opened.error,
  };
}

async function runOpenaiDotsDesktop({
  request,
  instructions,
  place,
  latitude,
  longitude,
  fallbackCity,
  onBot,
  copyText,
}) {
  const city = await nearestCity(request, latitude, longitude, fallbackCity);
  const plan = planSwarmHandoff({
    instructions,
    place,
    nearestCity: city,
    latitude,
    longitude,
    now: new Date(),
    lead: 'ChatGPT',
    swarmTitle: 'OPENAI DOT SWARM',
  });
  if (!plan.ok) {
    return {
      found: 0,
      empty: 0,
      failed: 0,
      unconfigured: plan.error,
      total: 1,
      via: '',
    };
  }
  const copied = await writeClipboard(plan.text, copyText);
  const opened = await openDesktop(
    request,
    OPENAI_DOTS_OPEN_URL,
    tl('ChatGPT could not be opened.'),
    { paste: true, text: plan.text },
  );
  onBot?.({
    bot: SOCIAL_SWARM_CHATGPT_BOT,
    text: plan.text,
    sources: [],
    task: true,
  });
  return {
    found: 0,
    empty: 0,
    failed: 0,
    unconfigured: '',
    total: 1,
    via: 'desktop',
    desktopApp: 'chatgpt',
    opened: opened.ok,
    copied,
    pasted: opened.pasted === true,
    openError: opened.ok ? '' : opened.error,
  };
}

/** Status line after a no-key press that opened Grok Bot or ChatGPT. */
export function formatSwarmDesktopStatus(result) {
  const chatgpt = result?.desktopApp === 'chatgpt';
  if (result?.pasted) {
    return chatgpt
      ? tl(
          'CHATGPT OPENED · task sent to ChatGPT. Its report stays in ChatGPT.',
        )
      : tl(
          'GROK BOT OPENED · task sent to your Chief of Staff. Its report stays in Grok Bot.',
        );
  }
  if (result?.opened && result?.copied) {
    return chatgpt
      ? tl(
          'CHATGPT OPENED · paste the task in ChatGPT. Its report stays in ChatGPT.',
        )
      : tl(
          'GROK BOT OPENED · paste the task to your Chief of Staff. Its report stays in Grok Bot.',
        );
  }
  if (result?.copied) {
    const copied = chatgpt
      ? tl('Task copied. Open ChatGPT and paste it.')
      : tl('Task copied. Open Grok Bot and paste it to your Chief of Staff.');
    return result.openError ? `${copied} ${result.openError}` : copied;
  }
  if (result?.opened) {
    return chatgpt
      ? tl('CHATGPT OPENED · the task is in the log; paste it in ChatGPT.')
      : tl(
          'GROK BOT OPENED · the task is in the log; paste it to your Chief of Staff.',
        );
  }
  return chatgpt
    ? tl('The task is in the log. Open ChatGPT and paste it.')
    : tl(
        'The task is in the log. Open Grok Bot and paste it to your Chief of Staff.',
      );
}

/**
 * @param {object} options
 * @param {Function} options.request fetch-like (url, init) => Response
 * @param {string} [options.provider] `xai` or `openai`
 * @param {string} [options.instructions]
 * @param {string} [options.place]
 * @param {number} [options.latitude]
 * @param {number} [options.longitude]
 * @param {{key?: boolean, computer?: boolean}} [options.xaiStatus]
 * @param {{key?: boolean}} [options.openaiStatus]
 * @param {(text: string) => Promise<void|boolean>|void|boolean} [options.copyText]
 *   Answers false when there is no clipboard.
 * @param {(lat: number, lon: number) => ?{name: string, distKm: number}} [options.fallbackCity]
 *   The box's own gazetteer, when the server finds no town.
 * @param {(row: {bot: object, text?: string, sources?: object[], error?: string, task?: boolean}) => void} [options.onBot]
 *   `task` marks the copied task (no key, no computer): log it, do not read it as findings.
 * @param {(row: {back: number, total: number}) => void} [options.onProgress]
 * @returns {Promise<{found: number, empty: number, failed: number, unconfigured: string, total: number, via?: string}>}
 */
export async function runSocialSwarm({
  request,
  provider,
  instructions,
  place,
  latitude,
  longitude,
  xaiStatus,
  openaiStatus,
  copyText,
  fallbackCity,
  onBot,
  onProgress,
} = {}) {
  const providerId = provider === 'openai' ? 'openai' : 'xai';
  const meta = SOCIAL_SWARM_PROVIDERS[providerId];
  if (providerId === 'xai') {
    const keys = await readXaiStatus(request, xaiStatus);
    if (keys && keys.key === false && keys.computer) {
      const computer = await runGrokBotComputer({
        request,
        instructions,
        place,
        latitude,
        longitude,
        fallbackCity,
        onBot,
        onProgress,
      });
      if (!computer.unconfigured) return computer;
    }
    if (keys && keys.key === false) {
      return runGrokBotDesktop({
        request,
        instructions,
        place,
        latitude,
        longitude,
        fallbackCity,
        onBot,
        copyText,
      });
    }
  }
  if (providerId === 'openai') {
    const keys = await readOpenaiStatus(request, openaiStatus);
    if (keys && keys.key === false) {
      return runOpenaiDotsDesktop({
        request,
        instructions,
        place,
        latitude,
        longitude,
        fallbackCity,
        onBot,
        copyText,
      });
    }
  }
  const total = SOCIAL_SWARM_BOTS.length;
  let back = 0;
  let found = 0;
  let empty = 0;
  let failed = 0;
  let unconfigured = '';
  const sendBot = async (bot) => {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(
      () => controller.abort(),
      SWARM_BOT_TIMEOUT_MS + CLIENT_TIMEOUT_MARGIN_MS,
    );
    try {
      const response = await request(SWARM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: providerId,
          bot: bot.id,
          instructions,
          place,
          latitude,
          longitude,
        }),
        signal: controller.signal,
      });
      const data = await readJson(response);
      if (response.status === 501 || data?.unconfigured) {
        unconfigured = String(
          data?.error ||
            (providerId === 'xai'
              ? GROK_BOT_UNCONFIGURED
              : tl('No {key} key yet. Add it in POWER UP → {key}.', {
                  key: meta.keyTitle,
                })),
        );
        return;
      }
      if (!response.ok || !data?.ok)
        throw new Error(data?.error || `HTTP ${response.status}`);
      if (swarmBotFoundNothing(data.text)) empty += 1;
      else found += 1;
      onBot?.({ bot, text: data.text, sources: data.sources });
    } catch (error) {
      failed += 1;
      const reason =
        error?.name === 'AbortError'
          ? tl('no answer in time')
          : error?.message || tl('request failed');
      onBot?.({ bot, error: reason });
    } finally {
      globalThis.clearTimeout(timer);
      back += 1;
      if (!unconfigured) onProgress?.({ back, total });
    }
  };
  await Promise.all(SOCIAL_SWARM_BOTS.map(sendBot));
  return { found, empty, failed, unconfigured, total, via: 'api' };
}
