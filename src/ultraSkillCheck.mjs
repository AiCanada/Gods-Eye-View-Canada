/**
 * CONFIRM ULTRA TOKEN SKILLS: a GEVC user checks the skills another user's
 * Ultra Token claims (medic, firefighter, electrician…) against public
 * pages, through GROK BOT SWARM, OPENAI DOT SWARM, the Ask-panel LLMs
 * that POWER UP has keys for, the Grok Bot computer / Chief of Staff
 * without a Grok Bot key, or ChatGPT without an OPENAI DOTS key.
 * Each skill comes back CONFIRMED, NO CONFIRMATION or REJECTED CLAIM, with
 * the public link behind it, and the verdicts are kept on the PC beside
 * that token in the home list.
 *
 * The details that help a bot or LLM find the right person (name, alias,
 * location, age, sex, profession, their own links, the apps to search) go
 * out with the press and are never stored. Paste an Ultra Token to read
 * the skills it carries; an encrypted suffix opens only with this
 * machine's token key. A bot checks the claimed skills and nothing else
 * about the person. Finding nothing is NO CONFIRMATION, never a rejection,
 * and a verdict without a public link counts as nothing found. No DOM and
 * no network: every request and every answer is handled here.
 *
 * What the box shows is marked with tl() from src/i18n/marker.js (Quebec
 * French on the page); the bots' tasks stay English.
 */
import { msgl, tl } from './i18n/marker.js';
import { SOCIAL_PUBLIC_SITES } from './socialMedia.js';
import {
  ULTRA_CUSTOM_SLUG_SOURCE,
  ULTRA_SKILL_SETS,
  ultraSkillLabel,
} from './ultraHelp.mjs';

/** As many as one token can carry: the catalog and five of the holder's own. */
export const SKILL_CHECK_SKILLS_MAX = 20;
export const SKILL_CHECK_SKILL_MAX = 40;
export const SKILL_CHECK_NAME_MAX = 80;
export const SKILL_CHECK_ALIAS_MAX = 80;
export const SKILL_CHECK_LOCATION_MAX = 120;
export const SKILL_CHECK_PROFESSION_MAX = 80;
export const SKILL_CHECK_URLS_MAX = 5;
export const SKILL_CHECK_URL_MAX = 300;
export const SKILL_CHECK_APPS_MAX = 8;
export const SKILL_CHECK_APP_MAX = 40;
export const SKILL_CHECK_AGE_MIN = 13;
export const SKILL_CHECK_AGE_MAX = 120;
/** One line per skill and a reason each: far beyond what the answer needs. */
export const SKILL_CHECK_ANSWER_TOKENS = 4000;
/** Links kept per verdict, and the reason's length. */
export const SKILL_CHECK_LINKS_MAX = 3;
export const SKILL_CHECK_REASON_MAX = 200;
/** A pasted Chief of Staff report, read once and never stored. */
export const SKILL_CHECK_REPORT_MAX = 8000;
const BOT_LABEL_MAX = 40;

/** The three verdicts, as stored and as shown. */
export const SKILL_CHECK_VERDICTS = Object.freeze({
  confirmed: msgl('CONFIRMED'),
  none: msgl('NO CONFIRMATION'),
  rejected: msgl('REJECTED CLAIM'),
});

/** Male / Female / Other, or not given. */
export const SKILL_CHECK_SEXES = Object.freeze(['male', 'female', 'other']);

/** Apps named in the form, and the public site each one searches. */
const APP_SITES = Object.freeze({
  linkedin: ['linkedin.com'],
  x: SOCIAL_PUBLIC_SITES.x,
  twitter: SOCIAL_PUBLIC_SITES.x,
  facebook: SOCIAL_PUBLIC_SITES.facebook,
  instagram: SOCIAL_PUBLIC_SITES.instagram,
  threads: SOCIAL_PUBLIC_SITES.threads,
  tiktok: SOCIAL_PUBLIC_SITES.tiktok,
  'truth social': SOCIAL_PUBLIC_SITES.truth,
  youtube: ['youtube.com'],
  github: ['github.com'],
  reddit: ['reddit.com'],
  medium: ['medium.com'],
  'stack overflow': ['stackoverflow.com'],
  stackoverflow: ['stackoverflow.com'],
  indeed: ['indeed.com'],
  glassdoor: ['glassdoor.com'],
  upwork: ['upwork.com'],
  fiverr: ['fiverr.com'],
  behance: ['behance.net'],
  dribbble: ['dribbble.com'],
  'google scholar': ['scholar.google.com'],
  researchgate: ['researchgate.net'],
  orcid: ['orcid.org'],
  yelp: ['yelp.com'],
  bluesky: ['bsky.app'],
});

/** Alias keys in APP_SITES; the form offers one option per site. */
const APP_SITE_ALIASES = Object.freeze(['twitter', 'stackoverflow']);

const APP_OPTION_LABELS = Object.freeze({
  linkedin: 'LinkedIn',
  x: 'X',
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  tiktok: 'TikTok',
  'truth social': 'Truth Social',
  youtube: 'YouTube',
  github: 'GitHub',
  reddit: 'Reddit',
  medium: 'Medium',
  'stack overflow': 'Stack Overflow',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
  upwork: 'Upwork',
  fiverr: 'Fiverr',
  behance: 'Behance',
  dribbble: 'Dribbble',
  'google scholar': 'Google Scholar',
  researchgate: 'ResearchGate',
  orcid: 'ORCID',
  yelp: 'Yelp',
  bluesky: 'Bluesky',
});

/** Selectable Apps to search; each label lowercases to an APP_SITES key. */
export const SKILL_CHECK_APP_OPTIONS = Object.freeze(
  Object.keys(APP_SITES)
    .filter((id) => !APP_SITE_ALIASES.includes(id))
    .map((id) =>
      Object.freeze({
        id,
        label: APP_OPTION_LABELS[id] || id,
      }),
    ),
);

/** The bots every check sends. `named` joins them when the form names links or apps. */
export const SKILL_CHECK_BOTS = Object.freeze([
  Object.freeze({
    id: 'linkedin',
    label: 'LinkedIn', // i18n-ignore: product name
    domains: Object.freeze(['linkedin.com']),
  }),
  Object.freeze({ id: 'x', label: 'X', domains: SOCIAL_PUBLIC_SITES.x }),
  Object.freeze({
    id: 'facebook',
    label: 'Facebook', // i18n-ignore: product name
    domains: SOCIAL_PUBLIC_SITES.facebook,
  }),
  Object.freeze({
    id: 'instagram',
    label: 'Instagram', // i18n-ignore: product name
    domains: SOCIAL_PUBLIC_SITES.instagram,
  }),
  Object.freeze({
    id: 'threads',
    label: 'Threads', // i18n-ignore: product name
    domains: SOCIAL_PUBLIC_SITES.threads,
  }),
  Object.freeze({
    id: 'tiktok',
    label: 'TikTok', // i18n-ignore: product name
    domains: SOCIAL_PUBLIC_SITES.tiktok,
  }),
  Object.freeze({
    id: 'registries',
    label: msgl('Licence registries'),
    domains: Object.freeze([]),
    about:
      'public licence, certification and membership registers (colleges, regulators, boards, trade and professional associations), and employer or agency staff pages',
  }),
  Object.freeze({
    id: 'news',
    label: msgl('News and web'),
    domains: Object.freeze([]),
    about: 'news sites and the open web',
  }),
]);

/** The bot for the person's own links and the apps the form names. */
export const SKILL_CHECK_NAMED_BOT = Object.freeze({
  id: 'named',
  label: msgl('Their links and apps'),
});

/** One line when the whole check went to the Chief of Staff bot. */
export const SKILL_CHECK_CHIEF_BOT = Object.freeze({
  id: 'chief',
  label: msgl('Chief of Staff'),
});

/** One line when the whole check was pasted into ChatGPT (OPENAI DOTS). */
export const SKILL_CHECK_CHATGPT_BOT = Object.freeze({
  id: 'chatgpt',
  label: 'ChatGPT', // i18n-ignore: product name
});

/** Sent to every bot ahead of its task, whatever the form says. */
export const SKILL_CHECK_RULES = [
  "You are one bot in a swarm that checks, for a user of God's Eye View, whether a person really has the skills their Ultra Token claims. The token tells others they may call on this person in an emergency, so a false claim matters.",
  'Use your search tool. Search only public posts and public pages, and only the sites you are given.',
  'Never sign in, never read a private account, group, or message, and never ask for a password, cookie, session, or key.',
  "Check only the claimed skills. Do not report the person's home address, phone number, family, photos, health, beliefs, or anything else about them, even when you find it or the details ask for it.",
  'The age and sex given are only there to tell apart people with the same name. Never write them in your answer.',
  'Never invent a page, a link, or a fact. A verdict of CONFIRMED or REJECTED CLAIM needs the public link that shows it.',
  'Answer in plain text, no markdown: one line per claimed skill, in the order given, each written as skill · VERDICT · one short reason · link.',
  'VERDICT is exactly one of: CONFIRMED (a public source shows this person has the skill, such as a licence register, an employer or association page, or their own long-standing professional profile); REJECTED CLAIM (a public source contradicts it, such as a register showing no, lapsed, suspended or revoked licence, or a public correction); NO CONFIRMATION (nothing found either way, or you cannot tell it is the same person). Finding nothing is NO CONFIRMATION, never REJECTED CLAIM.',
].join(' ');

/** The short rules the Chief of Staff / Grok Bot computer gets. */
export const SKILL_CHECK_HANDOFF_RULES = [
  "You are one bot in a swarm that checks, for a user of God's Eye View, whether a person really has the skills their Ultra Token claims. The token tells others they may call on this person in an emergency, so a false claim matters.",
  'Use your search tool. Check only the claimed skills.',
  'Never invent a page, a link, or a fact. A verdict of CONFIRMED or REJECTED CLAIM needs the public link that shows it.',
  'Answer in plain text, no markdown: one line per claimed skill, in the order given, each written as skill · VERDICT · one short reason ; NO CONFIRMATION (nothing found either way, or you cannot tell it is the same person). Finding nothing is NO CONFIRMATION.',
].join(' ');

/** A key or token typed into a field is refused, not sent. */
const KEY_SHAPE =
  /(?:\bsk-[A-Za-z0-9_-]{16,}|\bxai-[A-Za-z0-9_-]{16,}|\bxox[baprs]-|\bghp_[A-Za-z0-9]{20,}|\bya29\.|\beyJ[\w-]{8,}\.|\buht1\.)/;

const KNOWN_SKILLS = new Map(
  ULTRA_SKILL_SETS.map((item) => [item.code, item.label]),
);
const SKILL_CODE_PATTERN = new RegExp(
  `^(?:${ULTRA_SKILL_SETS.map((item) => item.code).join('|')}|x${ULTRA_CUSTOM_SLUG_SOURCE})$`,
);
/** Classic `uht1.` plus 43, then optional `.s.` codes or a `.e.` blob. */
const PASTED_TOKEN_PATTERN =
  /^uht1\.[A-Za-z0-9_-]{43}(?:\.(s|e)\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*))?$/;

function skillsFromTokenPayload(payload) {
  if (payload === '') return [];
  const codes = String(payload).split('.');
  if (codes.length > SKILL_CHECK_SKILLS_MAX) return null;
  const skills = [];
  const seen = new Set();
  for (const code of codes) {
    if (!SKILL_CODE_PATTERN.test(code)) return null;
    if (seen.has(code)) continue;
    seen.add(code);
    skills.push(KNOWN_SKILLS.get(code) || ultraSkillLabel(code.slice(1)));
  }
  return skills;
}

/**
 * Skills carried in a pasted Ultra Token, or null when the field is not one.
 * A clear `.s.` suffix is read here. An encrypted `.e.` suffix needs this
 * machine's token key (the panel asks the server). The token itself is
 * never sent to a bot.
 *
 * @returns {null | {token: true, encrypted: boolean, skills: string[], hidden?: boolean, error?: string}}
 */
export function readPastedUltraTokenSkills(raw) {
  const text = String(raw ?? '').replace(/\s+/g, '');
  const match = PASTED_TOKEN_PATTERN.exec(text);
  if (!match) return null;
  const kind = match[1];
  const rest = match[2] || '';
  if (!kind) return { token: true, encrypted: false, skills: [] };
  if (kind === 'e')
    return { token: true, encrypted: true, skills: [], hidden: true };
  const skills = skillsFromTokenPayload(rest);
  if (!skills)
    return {
      token: true,
      encrypted: false,
      skills: [],
      error: tl('That is not an Ultra Token skill list.'),
    };
  return { token: true, encrypted: false, skills };
}

function cleanLine(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function clockOf(now) {
  return now instanceof Date && Number.isFinite(now.getTime())
    ? now.getTime()
    : Date.now();
}

/** An http(s) link fit to show and send, or ''. */
export function cleanSkillCheckUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > SKILL_CHECK_URL_MAX) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

/** A list from an array or a comma / semicolon / newline separated string. */
function listOf(value) {
  if (Array.isArray(value)) return value;
  return String(value ?? '').split(/[,\n;]+/);
}

/**
 * The form's fields, cleaned, or why the check cannot go out. Skills are
 * required, and so is something to find the person by: a name or a link.
 * A pasted Ultra Token is opened here and replaced with its skill labels
 * so the token never goes to a bot.
 *
 * @returns {{ok: true, claim: {skills: string[], name: string, alias: string, location: string, age: ?number, sex: string, profession: string, urls: string[], apps: string[]}} | {ok: false, error: string}}
 */
export function cleanSkillCheckClaim(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const pasted = readPastedUltraTokenSkills(source.skills);
  if (pasted?.error) return { ok: false, error: pasted.error };
  if (pasted?.encrypted) {
    return {
      ok: false,
      error: tl(
        'Those skills are encrypted. Type the ones they told you, or use CONFIRM ULTRA TOKEN SKILLS on the home-list row.',
      ),
    };
  }
  if (pasted?.token && !pasted.skills.length)
    return { ok: false, error: tl('That token names no skills.') };
  const skillSource = pasted?.token ? pasted.skills : source.skills;
  const skills = [];
  for (const raw of listOf(skillSource)) {
    const label = cleanLine(
      raw && typeof raw === 'object' ? raw.label : raw,
      SKILL_CHECK_SKILL_MAX + 1,
    );
    if (!label) continue;
    if (label.length > SKILL_CHECK_SKILL_MAX) {
      return {
        ok: false,
        error: tl('Keep each skill under {max} characters.', {
          max: SKILL_CHECK_SKILL_MAX,
        }),
      };
    }
    if (skills.some((item) => item.toLowerCase() === label.toLowerCase()))
      continue;
    skills.push(label);
  }
  if (!skills.length)
    return { ok: false, error: tl('Name at least one skill to check.') };
  if (skills.length > SKILL_CHECK_SKILLS_MAX) {
    return {
      ok: false,
      error: tl('Check at most {max} skills at a time.', {
        max: SKILL_CHECK_SKILLS_MAX,
      }),
    };
  }
  const name = cleanLine(source.name, SKILL_CHECK_NAME_MAX);
  const alias = cleanLine(source.alias, SKILL_CHECK_ALIAS_MAX);
  const location = cleanLine(source.location, SKILL_CHECK_LOCATION_MAX);
  const profession = cleanLine(source.profession, SKILL_CHECK_PROFESSION_MAX);
  let age = null;
  const ageText = String(source.age ?? '').trim();
  if (ageText) {
    const n = Number(ageText);
    if (
      !Number.isInteger(n) ||
      n < SKILL_CHECK_AGE_MIN ||
      n > SKILL_CHECK_AGE_MAX
    ) {
      return {
        ok: false,
        error: tl(
          'Age is a whole number from {min} to {max}, or leave it empty.',
          { min: SKILL_CHECK_AGE_MIN, max: SKILL_CHECK_AGE_MAX },
        ),
      };
    }
    age = n;
  }
  const sexText = String(source.sex ?? '')
    .trim()
    .toLowerCase();
  const sex = SKILL_CHECK_SEXES.includes(sexText) ? sexText : '';
  const urls = [];
  for (const raw of listOf(source.urls)) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const url = cleanSkillCheckUrl(
      /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`,
    );
    if (!url) {
      return {
        ok: false,
        error: tl('That is not a web address: {text}', {
          text: cleanLine(text, 60),
        }),
      };
    }
    if (!urls.includes(url)) urls.push(url);
  }
  if (urls.length > SKILL_CHECK_URLS_MAX)
    return {
      ok: false,
      error: tl('Give at most {max} links.', { max: SKILL_CHECK_URLS_MAX }),
    };
  const apps = [];
  for (const raw of listOf(source.apps)) {
    const app = cleanLine(raw, SKILL_CHECK_APP_MAX + 1);
    if (!app) continue;
    if (app.length > SKILL_CHECK_APP_MAX) {
      return {
        ok: false,
        error: tl('Keep each app under {max} characters.', {
          max: SKILL_CHECK_APP_MAX,
        }),
      };
    }
    if (!apps.some((item) => item.toLowerCase() === app.toLowerCase()))
      apps.push(app);
  }
  if (apps.length > SKILL_CHECK_APPS_MAX)
    return {
      ok: false,
      error: tl('Name at most {max} apps.', { max: SKILL_CHECK_APPS_MAX }),
    };
  if (!name && !urls.length) {
    return {
      ok: false,
      error: tl(
        'Give their name or one of their links, so the bots know whom to check.',
      ),
    };
  }
  const typed = [
    ...skills,
    name,
    alias,
    location,
    profession,
    ...urls,
    ...apps,
  ].join(' ');
  if (KEY_SHAPE.test(typed)) {
    return {
      ok: false,
      error: tl('Take the key or token out. The bots never need one.'),
    };
  }
  return {
    ok: true,
    claim: {
      skills,
      name,
      alias,
      location,
      age,
      sex,
      profession,
      urls,
      apps,
    },
  };
}

/** The sites the named-links bot searches: the links' hosts, then the apps' sites. */
export function skillCheckNamedSites(claim) {
  const sites = [];
  const add = (site) => {
    const clean = String(site || '')
      .toLowerCase()
      .replace(/^www\./, '');
    if (clean && !sites.includes(clean)) sites.push(clean);
  };
  for (const url of claim?.urls || []) {
    try {
      add(new URL(url).hostname);
    } catch {
      /* Cleaned already; nothing to add. */
    }
  }
  for (const app of claim?.apps || []) {
    for (const site of APP_SITES[String(app).toLowerCase()] || []) add(site);
  }
  return sites;
}

/** The bots one check sends: the fixed set, and the named-links bot when there is something to name. */
export function skillCheckBots(claim) {
  const bots = [...SKILL_CHECK_BOTS];
  if (claim?.urls?.length || claim?.apps?.length) {
    bots.push({
      ...SKILL_CHECK_NAMED_BOT,
      domains: skillCheckNamedSites(claim),
    });
  }
  return bots;
}

/** The lines about the person, each detail only when given. */
function personLines(claim, { compact = false } = {}) {
  const details = [];
  if (claim.name) details.push(`Name: ${claim.name}`);
  if (claim.alias) details.push(`Also known as: ${claim.alias}`);
  if (claim.location) details.push(`Location: ${claim.location}`);
  if (claim.profession) details.push(`Profession: ${claim.profession}`);
  if (claim.age !== null && claim.age !== undefined)
    details.push(
      compact
        ? `Age: about ${claim.age}`
        : `Age: about ${claim.age} (only to tell people apart)`,
    );
  if (claim.sex)
    details.push(
      compact
        ? `Sex: ${claim.sex}`
        : `Sex: ${claim.sex} (only to tell people apart)`,
    );
  if (claim.urls?.length)
    details.push(`Their own links: ${claim.urls.join(' ')}`);
  if (claim.apps?.length)
    details.push(`Apps to search: ${claim.apps.join(', ')}`);
  return [
    `Skills claimed: ${claim.skills.join('; ')}.`,
    `To find the right person: ${details.join('. ')}.`,
  ];
}

function siteWords(bot) {
  if (bot.id === SKILL_CHECK_NAMED_BOT.id) {
    return `their own links and the apps named below${bot.domains.length ? ` (${bot.domains.join(', ')})` : ''}`;
  }
  return bot.about || `${bot.label} (${bot.domains.join(', ')})`;
}

function skillCheckTools(providerId, bot) {
  const domains = Array.isArray(bot.domains) ? bot.domains : [];
  if (providerId === 'xai' && bot.id === 'x') return [{ type: 'x_search' }];
  if (!domains.length) return [{ type: 'web_search' }];
  if (providerId === 'xai')
    return [{ type: 'web_search', allowed_domains: domains.slice(0, 5) }];
  return [{ type: 'web_search', filters: { allowed_domains: [...domains] } }];
}

/**
 * The request one bot sends, or why it cannot be sent. The claim is
 * cleaned here again, so the server never trusts the page's copy.
 *
 * @returns {{ok: true, bot: object, payload: object} | {ok: false, error: string}}
 */
export function planSkillCheckBot({
  provider,
  bot,
  claim,
  model,
  now = new Date(),
} = {}) {
  const providerId =
    provider === 'xai' || provider === 'openai' ? provider : '';
  if (!providerId) return { ok: false, error: 'Unknown swarm.' };
  const cleaned = cleanSkillCheckClaim(claim);
  if (!cleaned.ok) return cleaned;
  const chosen = skillCheckBots(cleaned.claim).find((item) => item.id === bot);
  if (!chosen) return { ok: false, error: 'Unknown bot.' };
  const task = [
    `Sites: ${siteWords(chosen)}.`,
    `Today is ${isoDay(clockOf(now))}.`,
    ...personLines(cleaned.claim),
  ].join('\n');
  return {
    ok: true,
    bot: chosen,
    payload: {
      model: String(model || ''),
      input: [
        { role: 'system', content: SKILL_CHECK_RULES },
        { role: 'user', content: task },
      ],
      tools: skillCheckTools(providerId, chosen),
      max_output_tokens: SKILL_CHECK_ANSWER_TOKENS,
    },
  };
}

/**
 * The one task for the Chief of Staff bot in Grok Bot (its computer, or the
 * clipboard): every site, the person, the short rules, and one line per
 * skill back. Ask-panel LLMs get the same text as their question.
 *
 * @returns {{ok: true, text: string, skills: string[]} | {ok: false, error: string}}
 */
export function planSkillCheckHandoff({
  claim,
  now = new Date(),
  lead = 'Chief of Staff',
} = {}) {
  const cleaned = cleanSkillCheckClaim(claim);
  if (!cleaned.ok) return cleaned;
  const sites = skillCheckBots(cleaned.claim).map(siteWords);
  const text = [
    `${lead}: run a CONFIRM ULTRA TOKEN SKILLS check. You may give each site to one of your bots.`,
    `Sites: ${sites.join('; ')}.`,
    `Today is ${isoDay(clockOf(now))}.`,
    ...personLines(cleaned.claim, { compact: true }),
    `Rules: ${SKILL_CHECK_HANDOFF_RULES}`,
    'Is this token Skill claimed trust worthy?',
  ].join('\n');
  return { ok: true, text, skills: cleaned.claim.skills };
}

const VERDICT_WORD =
  /\b(REJECTED(?:\s+CLAIMS?)?|NO\s+CONFIRMATION|NOT\s+CONFIRMED|UNCONFIRMED|CONFIRMED)\b/i;
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/gi;
const EDGE_MARKS = /^[\s·|:;,\-–—*•>#]+|[\s·|:;,\-–—*•>#]+$/g;

function verdictId(word) {
  const w = word.toUpperCase().replace(/\s+/g, ' ');
  if (w.startsWith('REJECTED')) return 'rejected';
  if (w === 'CONFIRMED') return 'confirmed';
  return 'none';
}

function skillKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The claimed skill a line's head names: exact first, then the longest one it contains. */
function skillNamed(head, skills) {
  const key = skillKey(head);
  if (!key) return '';
  const exact = skills.find((skill) => skillKey(skill) === key);
  if (exact) return exact;
  const inside = skills
    .filter((skill) => skillKey(skill) && key.includes(skillKey(skill)))
    .sort((a, b) => skillKey(b).length - skillKey(a).length);
  return inside[0] || '';
}

/**
 * One bot's answer read as a verdict per claimed skill. A line names a skill
 * and one verdict word; its links are the http(s) addresses on it.
 * CONFIRMED or REJECTED CLAIM without a link counts as NO CONFIRMATION, and
 * a skill the answer never mentions is NO CONFIRMATION.
 *
 * @returns {{skill: string, verdict: 'confirmed'|'none'|'rejected', reason: string, links: string[]}[]}
 */
export function readSkillCheckAnswer(text, skills) {
  const wanted = Array.isArray(skills) ? skills : [];
  const found = new Map();
  const lines = String(text ?? '')
    .slice(0, SKILL_CHECK_REPORT_MAX)
    .replace(/\r\n/g, '\n')
    .split('\n');
  for (const line of lines) {
    const match = VERDICT_WORD.exec(line);
    if (!match) continue;
    const head = line
      .slice(0, match.index)
      .replace(/\*\*|__/g, '')
      .replace(EDGE_MARKS, '');
    const skill = skillNamed(head, wanted);
    if (!skill || found.has(skill)) continue;
    const rest = line.slice(match.index + match[0].length);
    const links = [];
    for (const raw of rest.match(URL_IN_TEXT) || []) {
      const url = cleanSkillCheckUrl(raw.replace(/[.,;:]+$/, ''));
      if (url && !links.includes(url) && links.length < SKILL_CHECK_LINKS_MAX)
        links.push(url);
    }
    const reason = cleanLine(
      rest.replace(URL_IN_TEXT, ' ').replace(/\*\*|__/g, ''),
      SKILL_CHECK_REASON_MAX * 2,
    )
      .replace(EDGE_MARKS, '')
      .slice(0, SKILL_CHECK_REASON_MAX);
    let verdict = verdictId(match[1]);
    if (verdict !== 'none' && !links.length) verdict = 'none';
    found.set(skill, { skill, verdict, reason, links });
  }
  return wanted.map(
    (skill) =>
      found.get(skill) || { skill, verdict: 'none', reason: '', links: [] },
  );
}

/**
 * Every bot's verdicts folded into one per skill: a rejection with its link
 * wins (a contradiction is what the check is for), then a confirmation, else
 * NO CONFIRMATION. `mixed` marks a skill one bot confirmed and another
 * rejected; `bots` are the labels behind the verdict.
 *
 * @param {string[]} skills
 * @param {{bot: string, verdicts: object[]}[]} answers
 */
export function combineSkillVerdicts(skills, answers) {
  const list = Array.isArray(answers) ? answers : [];
  return (Array.isArray(skills) ? skills : []).map((skill) => {
    const rows = [];
    for (const answer of list) {
      const row = (answer?.verdicts || []).find(
        (item) => item?.skill === skill,
      );
      if (row) rows.push({ ...row, bot: cleanLine(answer.bot, BOT_LABEL_MAX) });
    }
    const rejected = rows.filter((row) => row.verdict === 'rejected');
    const confirmed = rows.filter((row) => row.verdict === 'confirmed');
    const deciding = rejected.length ? rejected : confirmed;
    const verdict = rejected.length
      ? 'rejected'
      : confirmed.length
        ? 'confirmed'
        : 'none';
    const links = [];
    for (const row of deciding) {
      for (const url of row.links || []) {
        if (!links.includes(url) && links.length < SKILL_CHECK_LINKS_MAX)
          links.push(url);
      }
    }
    const reason =
      deciding.find((row) => row.reason)?.reason ||
      (verdict === 'none' ? msgl('Nothing public found either way.') : '');
    return {
      skill,
      verdict,
      reason: cleanLine(reason, SKILL_CHECK_REASON_MAX),
      links,
      bots: [...new Set(deciding.map((row) => row.bot).filter(Boolean))].slice(
        0,
        12,
      ),
      ...(rejected.length && confirmed.length ? { mixed: true } : {}),
    };
  });
}

/** How a saved check was run. */
export const SKILL_CHECK_VIA = Object.freeze([
  'xai',
  'openai',
  'llm',
  'computer',
  'pasted',
]);

/**
 * The swarm select: GROK BOT SWARM, OPENAI DOT SWARM, and LLM from the
 * Ask-panel models POWER UP currently has keys for. `llm` asks every ready
 * model; `llm:<id>` asks one.
 *
 * @param {{id?: string, label?: string, ready?: boolean}[]} [providers]
 * @returns {{value: string, label: string}[]}
 */
export function skillCheckSwarmChoices(providers) {
  const swarm = [
    { value: 'xai', label: tl('GROK BOT SWARM') },
    { value: 'openai', label: tl('OPENAI DOT SWARM') },
  ];
  const ready = (Array.isArray(providers) ? providers : []).filter(
    (item) => item?.ready && item.id,
  );
  if (!ready.length) return [...swarm, { value: 'llm', label: 'LLM' }]; // i18n-ignore: the acronym is the same in every language
  if (ready.length === 1) {
    return [
      ...swarm,
      { value: 'llm', label: `LLM · ${ready[0].label || ready[0].id}` }, // i18n-ignore: the acronym and a model's name
    ];
  }
  return [
    ...swarm,
    { value: 'llm', label: tl('LLM · ALL') },
    ...ready.map((item) => ({
      value: `llm:${item.id}`,
      label: `LLM · ${item.label || item.id}`, // i18n-ignore: the acronym and a model's name
    })),
  ];
}

/**
 * A saved check in its stored shape, or null: when it ran, how, and one
 * verdict per skill. Nothing about the person but the skills.
 */
export function cleanSkillCheckRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const at = Number(value.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  if (!SKILL_CHECK_VIA.includes(value.via)) return null;
  const verdicts = [];
  for (const raw of Array.isArray(value.verdicts) ? value.verdicts : []) {
    if (!raw || typeof raw !== 'object') continue;
    const skill = cleanLine(raw.skill, SKILL_CHECK_SKILL_MAX);
    if (!skill || verdicts.some((item) => item.skill === skill)) continue;
    const verdict = Object.hasOwn(SKILL_CHECK_VERDICTS, raw.verdict)
      ? raw.verdict
      : 'none';
    const links = [];
    for (const url of Array.isArray(raw.links) ? raw.links : []) {
      const clean = cleanSkillCheckUrl(url);
      if (
        clean &&
        !links.includes(clean) &&
        links.length < SKILL_CHECK_LINKS_MAX
      )
        links.push(clean);
    }
    const bots = [];
    for (const bot of Array.isArray(raw.bots) ? raw.bots : []) {
      const label = cleanLine(bot, BOT_LABEL_MAX);
      if (label && !bots.includes(label) && bots.length < 12) bots.push(label);
    }
    verdicts.push({
      skill,
      // A verdict with no link behind it is not one.
      verdict: verdict !== 'none' && !links.length ? 'none' : verdict,
      reason: cleanLine(raw.reason, SKILL_CHECK_REASON_MAX),
      links,
      bots,
      ...(raw.mixed === true ? { mixed: true } : {}),
    });
    if (verdicts.length >= SKILL_CHECK_SKILLS_MAX) break;
  }
  if (!verdicts.length) return null;
  return { at: Math.floor(at), via: value.via, verdicts };
}

/** One verdict as a row word: "MEDIC: CONFIRMED", with "(MIXED)" when the bots disagreed. */
export function skillVerdictWords(row) {
  const word = SKILL_CHECK_VERDICTS[row?.verdict] || SKILL_CHECK_VERDICTS.none;
  return `${tl('{skill}: {verdict}', {
    skill: String(row?.skill || '').toUpperCase(),
    verdict: tl(word),
  })}${row?.mixed ? ` ${tl('(MIXED)')}` : ''}`;
}
