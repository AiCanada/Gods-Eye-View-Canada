/**
 * Bot swarms for Social Media Analysis, Outbreak SOCIAL SEARCH, and Ultra:
 * one bot per platform, each one request to Grok or OpenAI that searches
 * with the provider's own search tool, all sent at once, on the swarm's
 * own key. A missing Grok Bot key is a 501 from the API unless GROK BOT
 * SWARM uses the Grok Bot computer instead. The Chief of Staff hand-off
 * planner stays for that computer and for POST /api/social/swarm/chief-of-staff.
 * No DOM and no network: every request and that task are built here, and
 * every answer is read here. A bot reads public posts and public pages
 * only. Nothing here signs in anywhere.
 */
import { SOCIAL_PUBLIC_SITES, cleanPlace } from './socialMedia.js';

export const SOCIAL_SWARM_INSTRUCTIONS_MAX = 1000;
/** Room for a reasoning model to search, think and still write its list. */
export const SOCIAL_SWARM_ANSWER_TOKENS = 4000;
export const SOCIAL_SWARM_SOURCES_MAX = 10;
const ANSWER_MAX = 6000;
const TITLE_MAX = 160;
const URL_MAX = 500;
const DAY_MS = 86_400_000;

/** The two swarms, and the POWER UP card that holds each one's own key. */
export const SOCIAL_SWARM_PROVIDERS = Object.freeze({
  xai: Object.freeze({
    id: 'xai',
    label: 'Grok',
    title: 'GROK BOT SWARM',
    keyTitle: 'GROK BOT',
    // OPEN GROK BOT opens the Grok Bot desktop app on this computer.
    desktop: true,
  }),
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    title: 'OPENAI BOT SWARM',
    keyTitle: 'OPENAI DOTS',
    // OPEN CHATGPT: the dots live inside ChatGPT.
    openUrl: 'https://chatgpt.com/',
  }),
});

/** One bot per platform. Local news has no domain filter. */
export const SOCIAL_SWARM_BOTS = Object.freeze([
  Object.freeze({ id: 'x', label: 'X', domains: SOCIAL_PUBLIC_SITES.x }),
  Object.freeze({
    id: 'facebook',
    label: 'Facebook',
    domains: SOCIAL_PUBLIC_SITES.facebook,
  }),
  Object.freeze({
    id: 'instagram',
    label: 'Instagram',
    domains: SOCIAL_PUBLIC_SITES.instagram,
  }),
  Object.freeze({
    id: 'threads',
    label: 'Threads',
    domains: SOCIAL_PUBLIC_SITES.threads,
  }),
  Object.freeze({
    id: 'tiktok',
    label: 'TikTok',
    domains: SOCIAL_PUBLIC_SITES.tiktok,
  }),
  Object.freeze({
    id: 'truth',
    label: 'Truth Social',
    domains: SOCIAL_PUBLIC_SITES.truth,
  }),
  Object.freeze({
    id: 'news',
    label: 'Local news',
    domains: Object.freeze([]),
  }),
]);

/** The 501 when GROK BOT SWARM has neither an xAI key nor a computer. */
export const GROK_BOT_UNCONFIGURED =
  'No GROK BOT key yet. Add it in POWER UP → GROK BOT, or your Grok Bot computer in POWER UP → GROK BOT — COMPUTER.';

/** One log line when the sweep went to the Chief of Staff bot as a whole. */
export const SOCIAL_SWARM_CHIEF_BOT = Object.freeze({
  id: 'chief',
  label: 'Chief of Staff',
});

/** What every bot looks for when the instructions box is empty. */
export const SOCIAL_SWARM_DEFAULT_PURPOSE =
  'Find threat incidents reported near that place in the last 24 hours: crime, violence, shootings, stabbings, robberies, fires, explosions, crashes, hazards, police or emergency activity, evacuations, severe weather, and unrest.';

/** Sent to every bot ahead of its task, whatever the operator typed. */
export const SOCIAL_SWARM_RULES = [
  "You are one bot in a swarm that watches public social media for the operator of God's Eye View, a situational-awareness map.",
  'Use your search tool. Search only public posts and public pages, and only on the platform you are given.',
  'Never sign in, never read a private account, group, or message, and never ask for a password, cookie, session, or key.',
  'Report incidents and places, not people: do not identify, locate, or profile a private person, even when the instructions ask. Public agencies, officials, and businesses may be named.',
  'Never invent a post, a link, a time, or a number. Every item needs the link you found it at.',
  'Answer in plain text, no markdown: one line per item, newest first, at most 8 items, each written as time · place · what happened · link.',
  'If you find nothing, answer exactly: NOTHING FOUND.',
].join(' ');

/**
 * The rules the Chief of Staff bot gets with its task, in the owner's own
 * words (2026-10-01): the first line follows "Rules:", the second stands on
 * its own.
 */
export const SOCIAL_SWARM_HANDOFF_RULES = [
  'situational-awareness map, through its GROK BOT SWARM button.',
  'Report incidents and places, not people: do not identify, or profile a private person, even when the instructions ask. Public agencies, officials, and businesses may be named. Never invent a post, a link, a time, or a number. Every item needs the link you found it at. You may give each platform to one of your bots.',
].join('\n');

/** A key or token pasted into the instructions is refused, not sent. */
const KEY_SHAPE =
  /(?:\bsk-[A-Za-z0-9_-]{16,}|\bxai-[A-Za-z0-9_-]{16,}|\bxox[baprs]-|\bghp_[A-Za-z0-9]{20,}|\bya29\.|\beyJ[\w-]{8,}\.)/;

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function coordinate(value, limit) {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** The search tools one bot gets: X search for Grok's X bot, else web search kept to the platform's own sites. */
function swarmTools(providerId, bot, { since }) {
  if (providerId === 'xai' && bot.id === 'x') {
    return [{ type: 'x_search', ...(since ? { from_date: since } : {}) }];
  }
  if (!bot.domains.length) return [{ type: 'web_search' }];
  if (providerId === 'xai') {
    return [{ type: 'web_search', allowed_domains: bot.domains.slice(0, 5) }];
  }
  return [
    { type: 'web_search', filters: { allowed_domains: [...bot.domains] } },
  ];
}

/**
 * What every plan shares: the operator's instructions (refused when too
 * long or carrying a key), the place, and the day.
 *
 * @returns {{ok: true, typed: string, name: string, lat: ?number, lon: ?number, where: string, at: number} | {ok: false, error: string}}
 */
function swarmScope({ instructions, place, latitude, longitude, now }) {
  const typed = cleanText(instructions, SOCIAL_SWARM_INSTRUCTIONS_MAX + 1);
  if (typed.length > SOCIAL_SWARM_INSTRUCTIONS_MAX) {
    return {
      ok: false,
      error: `Keep the instructions under ${SOCIAL_SWARM_INSTRUCTIONS_MAX} characters.`,
    };
  }
  if (KEY_SHAPE.test(typed)) {
    return {
      ok: false,
      error: 'Take the key out of the instructions. The bots never need one.',
    };
  }
  const name = cleanPlace(place);
  const lat = coordinate(latitude, 90);
  const lon = coordinate(longitude, 180);
  const point =
    lat !== null && lon !== null ? `${lat.toFixed(4)}, ${lon.toFixed(4)}` : '';
  const where = name
    ? `${name}${point ? ` (${point})` : ''}`
    : point
      ? `the map point ${point}`
      : 'the current map view';
  const at =
    now instanceof Date && Number.isFinite(now.getTime())
      ? now.getTime()
      : Date.now();
  return { ok: true, typed, name, lat, lon, where, at };
}

/**
 * The request one bot sends, or why it cannot be sent. `model` is the one
 * the server chose; `now` is a Date.
 *
 * @returns {{ok: true, bot: object, payload: object} | {ok: false, error: string}}
 */
export function planSwarmBot({
  provider,
  bot,
  instructions,
  place,
  latitude,
  longitude,
  model,
  now = new Date(),
} = {}) {
  const providerId =
    typeof provider === 'string' &&
    Object.hasOwn(SOCIAL_SWARM_PROVIDERS, provider)
      ? provider
      : '';
  if (!providerId) return { ok: false, error: 'Unknown swarm.' };
  const chosen = SOCIAL_SWARM_BOTS.find((item) => item.id === bot) || null;
  if (!chosen) return { ok: false, error: 'Unknown bot.' };
  const scope = swarmScope({ instructions, place, latitude, longitude, now });
  if (!scope.ok) return scope;
  const { typed, where, at } = scope;
  const task = [
    `Platform: ${chosen.label}${chosen.id === 'news' ? ' (local news sites and official agency pages)' : ''}.`,
    `Place: ${where}.`,
    `Today is ${isoDay(at)}.`,
    typed
      ? `Operator's instructions: ${typed}\nStay near the place unless the instructions name another one.`
      : `Task: ${SOCIAL_SWARM_DEFAULT_PURPOSE}`,
  ].join('\n');
  return {
    ok: true,
    bot: chosen,
    payload: {
      model: String(model || ''),
      input: [
        { role: 'system', content: SOCIAL_SWARM_RULES },
        { role: 'user', content: task },
      ],
      // The default task is the last day; typed instructions may want more.
      tools: swarmTools(providerId, chosen, {
        since: typed ? '' : isoDay(at - DAY_MS),
      }),
      max_output_tokens: SOCIAL_SWARM_ANSWER_TOKENS,
    },
  };
}

/**
 * The one task the Chief of Staff bot in the Grok Bot desktop app gets when
 * GROK BOT SWARM has no key of its own: the seven platforms, the place and
 * its nearest city, the window, the rules, and how to report. The same text
 * goes to its webhook routine, or onto the clipboard when Grok Bot is opened
 * instead. `nearestCity` is the reverse lookup of the map point, or empty:
 * then the bot is asked to find it, since a post names a town, not a point.
 *
 * @returns {{ok: true, text: string, place: string, nearestCity: string, latitude: ?number, longitude: ?number} | {ok: false, error: string}}
 */
export function planSwarmHandoff({
  instructions,
  place,
  nearestCity,
  latitude,
  longitude,
  now = new Date(),
} = {}) {
  const scope = swarmScope({ instructions, place, latitude, longitude, now });
  if (!scope.ok) return scope;
  const { typed, where, at, name, lat, lon } = scope;
  const city = cleanPlace(nearestCity);
  const point = lat !== null && lon !== null;
  const town = city.split(',')[0].trim().toLowerCase();
  let placeLine = `Place: ${where}.`;
  if (city && !(name && town && name.toLowerCase().includes(town))) {
    placeLine += ` Nearest city: ${city}.`;
  } else if (!city && point && !name) {
    placeLine +=
      ' Nearest city: find the nearest city or town to this point and search there.';
  }
  const platforms = SOCIAL_SWARM_BOTS.map((bot) =>
    bot.id === 'news'
      ? 'local news sites and official agency pages'
      : bot.label,
  ).join(', ');
  const text = [
    'Chief of Staff: run a GROK BOT SWARM sweep of public social media.',
    `Platforms: ${platforms}.`,
    placeLine,
    `Today is ${isoDay(at)}.`,
    typed
      ? `Operator's instructions: ${typed}\nStay near the place unless the instructions name another one.`
      : `Task: ${SOCIAL_SWARM_DEFAULT_PURPOSE}`,
    `Rules: ${SOCIAL_SWARM_HANDOFF_RULES}`,
    'Report one section per platform: one line per item, newest first, at most 8 items, each written as time · place · what happened · link. For a platform with nothing, write NOTHING FOUND.',
  ].join('\n');
  return {
    ok: true,
    text,
    place: name,
    nearestCity: city,
    latitude: lat,
    longitude: lon,
  };
}

/** An http(s) link fit to show, or ''. */
function cleanSourceUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > URL_MAX) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

/**
 * The text and the links one bot found, from a Responses API answer: the
 * message text, its url_citation annotations, and a top-level citations
 * list where the provider gives one. Anything else in the answer is ignored.
 *
 * @returns {{text: string, sources: {url: string, title: string}[]}}
 */
export function readSwarmAnswer(data) {
  const parts = [];
  const sources = new Map();
  const add = (url, title) => {
    const clean = cleanSourceUrl(url);
    if (!clean || sources.has(clean)) return;
    if (sources.size >= SOCIAL_SWARM_SOURCES_MAX) return;
    sources.set(clean, cleanText(title, TITLE_MAX).replace(/\s+/g, ' '));
  };
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (typeof part?.text === 'string') parts.push(part.text);
      const notes = Array.isArray(part?.annotations) ? part.annotations : [];
      for (const note of notes) add(note?.url, note?.title);
    }
  }
  if (!parts.length && typeof data?.output_text === 'string') {
    parts.push(data.output_text);
  }
  const citations = Array.isArray(data?.citations) ? data.citations : [];
  for (const cite of citations) {
    if (typeof cite === 'string') add(cite, '');
    else add(cite?.url, cite?.title);
  }
  return {
    text: cleanText(parts.join('\n'), ANSWER_MAX),
    sources: [...sources].map(([url, title]) => ({ url, title })),
  };
}

const HANDOFF_SECTION_HEAD =
  /^(?:#{1,6}\s*|\*\*|__)?\s*(X|Facebook|Instagram|Threads|TikTok|Truth Social|Local news)\s*(?:\*\*|__)?\s*:?\s*$/i;

/**
 * Split a Chief of Staff report into one entry per platform. Headings are
 * the platform names the task asked for. No heading means no sections.
 *
 * @returns {{bot: object, text: string}[]}
 */
export function readSwarmHandoffSections(text) {
  const source = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!source) return [];
  const byLabel = new Map(
    SOCIAL_SWARM_BOTS.map((bot) => [bot.label.toLowerCase(), bot]),
  );
  const sections = [];
  let current = null;
  let buf = [];
  const flush = () => {
    if (!current) return;
    sections.push({
      bot: current,
      text: buf.join('\n').trim() || 'NOTHING FOUND',
    });
    buf = [];
  };
  for (const line of source.split('\n')) {
    const match = HANDOFF_SECTION_HEAD.exec(line.trim());
    if (match) {
      flush();
      current = byLabel.get(match[1].toLowerCase()) || null;
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return sections;
}

/** Whether a bot came back empty-handed. */
export function swarmBotFoundNothing(text) {
  const trimmed = String(text ?? '').trim();
  return !trimmed || /^NOTHING FOUND\.?$/i.test(trimmed);
}

/** One bot's entry in the box's log: its list, then the links it cited. */
export function formatSwarmBotLog({ text, sources } = {}) {
  const lines = [
    swarmBotFoundNothing(text) ? 'NOTHING FOUND' : String(text).trim(),
  ];
  const list = Array.isArray(sources) ? sources : [];
  if (list.length) {
    lines.push('Sources:');
    for (const source of list) {
      const url = cleanSourceUrl(source?.url);
      if (!url) continue;
      const title = cleanText(source?.title, TITLE_MAX).replace(/\s+/g, ' ');
      lines.push(`- ${title ? `${title} · ` : ''}${url}`);
    }
  }
  return lines.join('\n');
}
