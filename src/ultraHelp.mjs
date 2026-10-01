/**
 * Ultra Security Package help rules.
 * Pure: phone camera roles, incident classify/reject, help matching, SMS text.
 * A phone is only ever the one the owner paired. Nothing here looks up a
 * person by their number or collects a private phone from the map.
 */

export const ULTRA_POSITION_MAX_AGE_MS = 20 * 60 * 1000;
export const ULTRA_INCIDENT_COOLDOWN_MS = 10 * 60 * 1000;
export const ULTRA_HELP_RADIUS_M = 20_000;
/**
 * How many PREDEFINED HELP # numbers the store keeps. The SMS relay reserves
 * at least this many of the day's texts for the owner's own call, so the
 * whole list is always texted however busy the home list has been.
 */
export const ULTRA_HELP_CONTACT_LIMIT = 20;

export const ULTRA_CAMERA_ROLES = Object.freeze([
  Object.freeze({ id: 'front', label: 'Activate Front Cell Cam' }),
  Object.freeze({ id: 'rear', label: 'Activate Rear Cell Cam' }),
  Object.freeze({
    id: 'rear-ultrawide',
    label: 'Activate Rear Ultrawide Cam',
  }),
  Object.freeze({
    id: 'rear-tele',
    label: 'Activate Rear Telephoto Cam',
  }),
  Object.freeze({ id: 'inner', label: 'Activate Inside Fold Cell Cam' }),
]);

const DUAL = Object.freeze(['front', 'rear', 'rear-ultrawide']);
const QUAD = Object.freeze(['front', 'rear', 'rear-ultrawide', 'rear-tele']);
const FOLD3 = Object.freeze([
  'front',
  'rear',
  'rear-ultrawide',
  'rear-tele',
  'inner',
]);
const FOLD8 = Object.freeze(['front', 'rear', 'rear-ultrawide', 'inner']);

/**
 * One row per handset. Every row uses the same position report and the same
 * live-video page. Buttons match that phone's real cameras. The generic cell
 * stops at four: front, rear, ultrawide, and telephoto. Unknown ids use it.
 */
export const ULTRA_PHONE_MODELS = Object.freeze([
  Object.freeze({ id: 'generic-cell', label: 'Generic cell', cameras: QUAD }),
  Object.freeze({
    id: 'apple-iphone-17',
    label: 'Apple iPhone 17',
    cameras: DUAL,
  }),
  Object.freeze({
    id: 'apple-iphone-16',
    label: 'Apple iPhone 16',
    cameras: DUAL,
  }),
  Object.freeze({
    id: 'apple-iphone-15',
    label: 'Apple iPhone 15',
    cameras: DUAL,
  }),
  Object.freeze({ id: 'google-pixel', label: 'Google Pixel', cameras: QUAD }),
  Object.freeze({ id: 'motorola', label: 'Motorola', cameras: DUAL }),
  Object.freeze({ id: 'oppo', label: 'Oppo', cameras: QUAD }),
  Object.freeze({ id: 'vivo', label: 'Vivo', cameras: QUAD }),
  Object.freeze({ id: 'xiaomi', label: 'Xiaomi', cameras: QUAD }),
  Object.freeze({
    id: 'samsung-s26',
    label: 'Samsung Galaxy S26',
    cameras: QUAD,
  }),
  Object.freeze({
    id: 'samsung-s22-ultra',
    label: 'Samsung Galaxy S22 Ultra',
    cameras: QUAD,
  }),
  Object.freeze({
    id: 'samsung-z8',
    label: 'Samsung Galaxy Z8',
    cameras: FOLD8,
  }),
  Object.freeze({
    id: 'samsung-z3',
    label: 'Samsung Galaxy Z3',
    cameras: FOLD3,
  }),
  Object.freeze({
    id: 'samsung-z-fold',
    label: 'Samsung Galaxy Z Fold',
    cameras: FOLD8,
  }),
]);

const MODEL_BY_ID = new Map(
  ULTRA_PHONE_MODELS.map((model) => [model.id, model]),
);
const ROLE_BY_ID = new Map(ULTRA_CAMERA_ROLES.map((role) => [role.id, role]));

const INCIDENT_WORDS = Object.freeze({
  threat: 'threat',
  crime: 'threat',
  assault: 'threat',
  attack: 'threat',
  fire: 'fire',
  smoke: 'fire',
  medical: 'medical',
  injury: 'medical',
  health: 'medical',
  other: 'other',
});

const INCIDENT_LABEL = Object.freeze({
  threat: 'threat',
  fire: 'fire',
  medical: 'medical',
  other: 'other',
});

const POLICE_LADDER = Object.freeze({
  canada: Object.freeze(['local', 'provincial', 'rcmp']),
  usa: Object.freeze(['local', 'state', 'fbi']),
  international: Object.freeze(['local', 'provincial', 'federal']),
});

const E164 = /^\+[1-9]\d{7,14}$/;

const LEGACY_PHONE_IDS = Object.freeze({
  'samsung-s3': 'samsung-z3',
  'samsung-s6': 'generic-cell',
});

export function ultraPhoneModel(id) {
  const key = LEGACY_PHONE_IDS[id] || id;
  return MODEL_BY_ID.get(key) || MODEL_BY_ID.get('generic-cell');
}

/** Camera buttons for this handset, in the standard order. */
export function ultraCameraButtons(modelId) {
  const have = new Set(ultraPhoneModel(modelId).cameras);
  return ULTRA_CAMERA_ROLES.filter((role) => have.has(role.id));
}

export function ultraCameraRole(modelId, roleId) {
  const role = ROLE_BY_ID.get(roleId);
  if (!role) return null;
  return ultraPhoneModel(modelId).cameras.includes(role.id) ? role : null;
}

/** A submitted word becomes a class, or null when it is not one. Panic is not a class. */
export function classifyUltraIncident(raw) {
  const word = String(raw ?? '')
    .trim()
    .toLowerCase();
  return INCIDENT_WORDS[word] || null;
}

/**
 * Decide whether this incident may look for help.
 * A position update by itself is not an incident. Confirmation is separate
 * and required before any SMS.
 */
export function reviewUltraIncident({
  type,
  now,
  positionAt,
  lastSentAt = null,
  lastSentType = null,
} = {}) {
  const incident = classifyUltraIncident(type);
  if (!incident) return { ok: false, reason: 'unclassified' };
  if (positionAt === null || positionAt === undefined || positionAt === '') {
    return { ok: false, reason: 'no-position', incident };
  }
  const fixAt = Number(positionAt);
  if (!Number.isFinite(fixAt))
    return { ok: false, reason: 'no-position', incident };
  const age = Number(now) - fixAt;
  if (!Number.isFinite(age) || age < 0 || age > ULTRA_POSITION_MAX_AGE_MS) {
    return { ok: false, reason: 'stale', incident };
  }
  if (
    lastSentType === incident &&
    Number.isFinite(Number(lastSentAt)) &&
    Number(now) - Number(lastSentAt) < ULTRA_INCIDENT_COOLDOWN_MS
  ) {
    return { ok: false, reason: 'cooldown', incident };
  }
  return { ok: true, incident };
}

export function ultraCountryGroup(code) {
  const country = String(code || '')
    .trim()
    .toUpperCase();
  if (country === 'CA') return 'canada';
  if (country === 'US' || country === 'USA') return 'usa';
  return 'international';
}

function blob(place) {
  return `${place?.name || ''} ${place?.operator || ''}`.toUpperCase();
}

/** Which police tier a published station belongs to. Unknown stations are local. */
export function policeTier(place, group) {
  const name = blob(place);
  if (group === 'canada') {
    if (/\b(RCMP|GRC)\b/.test(name)) return 'rcmp';
    if (/\b(OPP|SURETE|SÛRETÉ|PROVINCIAL)\b/.test(name)) return 'provincial';
    return 'local';
  }
  if (group === 'usa') {
    if (/\bFBI\b/.test(name)) return 'fbi';
    if (
      /\bSTATE\b/.test(name) &&
      /\b(POLICE|TROOPER|PATROL|HIGHWAY)\b/.test(name)
    )
      return 'state';
    return 'local';
  }
  if (/\b(FEDERAL|NATIONAL|RCMP|FBI)\b/.test(name)) return 'federal';
  if (/\b(PROVINCIAL|STATE)\b/.test(name)) return 'provincial';
  return 'local';
}

export function helpLadder(group, incident) {
  if (incident === 'fire') return ['fire'];
  if (incident === 'threat')
    return POLICE_LADDER[group] || POLICE_LADDER.international;
  return ['closer', 'other'];
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function ultraDistanceKm(from, to) {
  const lat1 = finite(from?.lat);
  const lon1 = finite(from?.lon);
  const lat2 = finite(to?.lat);
  const lon2 = finite(to?.lon);
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null)
    return null;
  const r = 6371;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

function tagged(place, group) {
  const kind = place?.kind === 'fire' ? 'fire' : 'police';
  const tier = kind === 'fire' ? 'fire' : policeTier(place, group);
  return {
    ...place,
    kind,
    tier,
    distanceKm: ultraDistanceKm(place, place.from),
  };
}

/**
 * Order published stations and the owner's saved numbers for this incident.
 * Saved numbers have no map pin, so they sort after located stations unless
 * the incident is medical/other, where they are the list.
 */
export function matchUltraHelp({
  group,
  incident,
  places = [],
  contacts = [],
  from,
}) {
  const ladder = helpLadder(group, incident);
  const located = places
    .map((place) => tagged({ ...place, from }, group))
    .filter(
      (place) =>
        place.distanceKm !== null &&
        place.distanceKm <= ULTRA_HELP_RADIUS_M / 1000,
    );
  if (incident === 'threat' || incident === 'fire') {
    const wanted = new Set(ladder);
    const stations = located
      .filter((place) => wanted.has(place.tier))
      .sort(
        (a, b) =>
          ladder.indexOf(a.tier) - ladder.indexOf(b.tier) ||
          a.distanceKm - b.distanceKm,
      );
    const saved = contacts.filter((contact) =>
      incident === 'fire' ? contact.kind === 'fire' : contact.kind === 'police',
    );
    return { ladder, matches: [...saved, ...stations] };
  }
  const nearer = [...located].sort((a, b) => a.distanceKm - b.distanceKm);
  const saved = contacts.filter(
    (contact) =>
      contact.kind === 'other' ||
      contact.kind === 'police' ||
      contact.kind === 'fire',
  );
  return { ladder, matches: [...saved, ...nearer.slice(0, 5)] };
}

export function ultraHelpMessage(place, incident) {
  const label = INCIDENT_LABEL[incident] || 'other';
  const where = String(place || '').trim() || 'the reported position';
  return `Please HELP you are close by, to ${where} of victim in progress, ${label} thank you.`;
}

export function normalizeUltraNumber(value) {
  const raw = String(value ?? '')
    .trim()
    .replace(/[\s()-]/g, '');
  return E164.test(raw) ? raw : null;
}

/**
 * An sms: link the owner's or holder's own phone opens. An empty number
 * lets the phone pick the recipient; anything that is not E.164 yields ''
 * so no link is ever built from an unchecked string. It lives here, not in
 * ultraTokens.mjs, because the dashboard box paints it and this module is
 * the one that is safe to bundle for the browser.
 */
export function ultraHelpSmsLink(number, text = '') {
  const raw = String(number ?? '').trim();
  const body = '?body=' + encodeURIComponent(String(text ?? ''));
  if (raw === '') return 'sms:' + body;
  const e164 = normalizeUltraNumber(raw);
  return e164 ? 'sms:' + e164 + body : '';
}

/** Canada and the United States use 911. Other countries use 112, the mobile emergency number. */
export function emergencyNumber(group) {
  return group === 'canada' || group === 'usa' ? '911' : '112';
}

/** A helper number, or the emergency numbers the phone is allowed to text. */
export function sendableNumber(value) {
  const raw = String(value ?? '').trim();
  if (raw === '911' || raw === '112') return raw;
  return normalizeUltraNumber(raw);
}

export function ultraContactKind(value) {
  const kind = String(value ?? '')
    .trim()
    .toLowerCase();
  return kind === 'police' || kind === 'fire' || kind === 'other' ? kind : null;
}

/**
 * The slug a custom skill set can occupy inside a token. One source, shared
 * with the token pattern: the dashboard previews this and the minter writes it.
 */
export const ULTRA_CUSTOM_SLUG_SOURCE =
  '[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?';
const CUSTOM_SLUG_PATTERN = new RegExp(`^${ULTRA_CUSTOM_SLUG_SOURCE}$`);
const CUSTOM_SLUG_LIMIT = 24;
export const ULTRA_CUSTOM_SKILL_LIMIT = 5;
const SMALL_SKILL_WORDS = new Set(['and', 'of', 'the', 'for']);

function skillText(raw, limit) {
  const text =
    typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, limit);
}

/** The words a peer can rebuild from a custom code. Small joining words stay lower case. */
export function ultraSkillLabel(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((word, index) =>
      index > 0 && SMALL_SKILL_WORDS.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

/**
 * A custom skill set as the token can carry it, or null when the text has
 * no letters or numbers. A long name is cut to 24 characters on a word: a
 * word that ends inside that budget stays, and a word the cut splits is
 * dropped. `full` is the slug before that cut, so two different names that
 * land on the same code can be told apart.
 */
export function ultraCustomSkill(raw) {
  const full = skillText(raw, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let slug = full;
  if (full.length > CUSTOM_SLUG_LIMIT) {
    let sliced = full.slice(0, CUSTOM_SLUG_LIMIT);
    if (full[CUSTOM_SLUG_LIMIT] !== '-')
      sliced = sliced.replace(/-+[^-]*$/, '');
    slug = sliced.replace(/-+$/g, '');
    if (!slug) slug = full.slice(0, CUSTOM_SLUG_LIMIT).replace(/-+$/g, '');
  }
  if (!CUSTOM_SLUG_PATTERN.test(slug)) return null;
  return {
    slug,
    full,
    code: `x${slug}`,
    label: ultraSkillLabel(slug),
  };
}

/**
 * The custom boxes, in order, as the token will carry them. The same name
 * typed twice is one skill. Two different names that shorten to one code,
 * a box with no letters or numbers, or more than five filled boxes, refuse
 * the whole list. The reason never repeats what was typed.
 */
export function ultraCustomSkillList(values) {
  const list = Array.isArray(values) ? values : [];
  const skills = [];
  const seen = new Map();
  let count = 0;
  let differs = false;
  const refuse = (error) => ({ ok: false, error, skills: [], differs: false });
  for (const raw of list) {
    if (typeof raw !== 'string' && typeof raw !== 'number')
      return refuse('A custom skill set needs letters or numbers');
    if (String(raw).trim() === '') continue;
    count += 1;
    if (count > ULTRA_CUSTOM_SKILL_LIMIT)
      return refuse('At most 5 custom skill sets');
    const built = ultraCustomSkill(raw);
    if (!built) return refuse('A custom skill set needs letters or numbers');
    const prior = seen.get(built.code);
    if (prior !== undefined) {
      if (prior === built.full) continue;
      return refuse('Two custom skill sets would share one token code');
    }
    seen.set(built.code, built.full);
    if (skillText(raw, 80) !== built.label) differs = true;
    skills.push({ code: built.code, label: built.label });
  }
  return { ok: true, error: '', skills, differs };
}
