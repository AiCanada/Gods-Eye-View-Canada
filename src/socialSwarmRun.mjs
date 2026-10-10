/**
 * Send one bot per platform from GEVC and retrieve each answer into GEVC.
 * With a Grok Bot key, every press POSTs `/api/social/swarm`. Without one,
 * GROK BOT SWARM uses the Grok Bot computer when POWER UP has it, else it
 * copies the Chief of Staff task, opens Grok Bot, and keeps the task in the
 * log. No Chief of Staff webhook.
 */
import {
  GROK_BOT_UNCONFIGURED,
  SOCIAL_SWARM_BOTS,
  SOCIAL_SWARM_CHIEF_BOT,
  SOCIAL_SWARM_PROVIDERS,
  planSwarmHandoff,
  swarmBotFoundNothing,
} from './socialSwarm.mjs';
import { GROK_BOT_GATEWAY_TOTAL_MS } from './grokBotGateway.mjs';

const SWARM_URL = '/api/social/swarm';
const SWARM_STATUS_URL = '/api/social/swarm/status';
const SWARM_COMPUTER_URL = '/api/social/swarm/grok-bot';
const NEAREST_CITY_URL = '/api/social/swarm/nearest-city';
const GROK_BOT_OPEN_URL = '/api/social/grok-bot/open';
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

async function readXaiStatus(request, given) {
  if (given && typeof given === 'object') return given;
  try {
    const response = await request(SWARM_STATUS_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!response?.ok) return null;
    const data = await readJson(response);
    return data?.xai && typeof data.xai === 'object' ? data.xai : null;
  } catch {
    return null;
  }
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
 * `copyText` that answers false (no clipboard here) is not a copy; plain
 * http pages have no navigator.clipboard at all.
 */
async function writeClipboard(text, copyText) {
  if (typeof copyText === 'function') {
    try {
      return (await copyText(text)) !== false;
    } catch {
      return false;
    }
  }
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function openGrokBot(request) {
  try {
    const response = await request(GROK_BOT_OPEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await readJson(response);
    if (response?.ok && data?.ok) return { ok: true };
    return {
      ok: false,
      error: String(data?.error || 'Grok Bot could not be opened.'),
    };
  } catch {
    return { ok: false, error: 'Grok Bot could not be opened.' };
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
        ? 'no answer in time'
        : error?.message || 'request failed';
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
  const opened = await openGrokBot(request);
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
    opened: opened.ok,
    copied,
    openError: opened.ok ? '' : opened.error,
  };
}

/** Status line after a no-key press that opened Grok Bot or copied the task. */
export function formatSwarmDesktopStatus(result) {
  if (result?.opened && result?.copied) {
    return 'GROK BOT OPENED · paste the task to your Chief of Staff. Its report stays in Grok Bot.';
  }
  if (result?.copied) {
    return result.openError
      ? `Task copied. Open Grok Bot and paste it to your Chief of Staff. ${result.openError}`
      : 'Task copied. Open Grok Bot and paste it to your Chief of Staff.';
  }
  if (result?.opened) {
    return 'GROK BOT OPENED · the task is in the log; paste it to your Chief of Staff.';
  }
  return 'The task is in the log. Open Grok Bot and paste it to your Chief of Staff.';
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
              : `No ${meta.keyTitle} key yet. Add it in POWER UP → ${meta.keyTitle}.`),
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
          ? 'no answer in time'
          : error?.message || 'request failed';
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
