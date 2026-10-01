/**
 * Ultra Security Package share help tokens: the pure rules.
 * A token is a bearer secret the owner hands to one person so that person
 * can send a help message to the owner's phone. Everything here is plain
 * computation over node:crypto: token shape, hashing, sealing, constant-time
 * lookup, store and inbox normalisation, text cleaning and the request
 * budgets. No file, socket or clock is touched unless the caller passes one.
 * Privacy rule: nothing here looks up a person by their number. The only
 * numbers that pass through are the owner's own (typed by the owner, shown
 * only to tokens marked SMS) and one a holder volunteers about themselves,
 * or a position a peer released to this machine.
 */
import crypto from 'node:crypto';
import {
  normalizeUltraNumber,
  ULTRA_CUSTOM_SKILL_LIMIT,
  ULTRA_CUSTOM_SLUG_SOURCE,
  ultraCustomSkill,
  ultraCustomSkillList,
  ultraSkillLabel,
} from './ultraHelp.mjs';

export { ULTRA_CUSTOM_SKILL_LIMIT };

// The sms: link builder is browser-safe and lives in ultraHelp.mjs; the
// server and the tests reach it from here as well.
export { ultraHelpSmsLink } from './ultraHelp.mjs';

export const ULTRA_TOKEN_PREFIX = 'uht1.';
/**
 * Skill sets the owner can build into a token. The code is what the token
 * string carries; the label is what the box shows. Custom skills are not in
 * this list: up to five of those are slugged in beside it, or the token
 * carries none.
 */
export const ULTRA_SKILL_SETS = Object.freeze([
  Object.freeze({ code: 'dr', label: 'Doctor' }),
  Object.freeze({ code: 'pm', label: 'Paramedic' }),
  Object.freeze({ code: 'fr', label: 'First Responder' }),
  Object.freeze({ code: 'lg', label: 'Lifeguard' }),
  Object.freeze({ code: 'ff', label: 'Firefighter' }),
  Object.freeze({ code: 'sr', label: 'Search and Rescue (SAR) Specialist' }),
  Object.freeze({ code: 'br', label: 'Brave' }),
  Object.freeze({ code: 'st', label: 'Strong' }),
  Object.freeze({ code: 'cc', label: 'Crisis Counselor' }),
  Object.freeze({ code: 'en', label: 'Enforcer' }),
  Object.freeze({ code: 'ac', label: 'Animal Control' }),
  Object.freeze({ code: 'hz', label: 'Hazardous Materials (HAZMAT)' }),
  Object.freeze({ code: 'rg', label: 'Ranger' }),
]);
const SKILL_CODE_SOURCE =
  '(?:dr|pm|fr|lg|ff|sr|br|st|cc|en|ac|hz|rg|x' +
  ULTRA_CUSTOM_SLUG_SOURCE +
  ')';
const SKILL_CODE_PATTERN = new RegExp(`^${SKILL_CODE_SOURCE}$`);
const CATALOG_INDEX = new Map(
  ULTRA_SKILL_SETS.map((item, index) => [item.code, index]),
);
const CLASSIC_TOKEN_PATTERN = /^uht1\.[A-Za-z0-9_-]{43}$/;
/**
 * 'uht1.' plus 43 base64url characters, then optionally the skill sets.
 * `.s.` writes the codes in the clear. `.e.` is those same codes sealed
 * with AES-256-GCM under the machine key, so the link does not spell them
 * out. No skills and Encrypt left off is the original 48-character token.
 * The dot keeps either shape out of the 43-character phone key class.
 */
export const ULTRA_TOKEN_SOURCE =
  'uht1\\.[A-Za-z0-9_-]{43}(?:\\.s\\.' +
  SKILL_CODE_SOURCE +
  '(?:\\.' +
  SKILL_CODE_SOURCE +
  '){0,17}|\\.e\\.[A-Za-z0-9_-]{38,360})?';
export const ULTRA_TOKEN_PATTERN = new RegExp(`^${ULTRA_TOKEN_SOURCE}$`);
export const ULTRA_HELP_TEXT_LIMIT = 500;
export const ULTRA_HELP_NAME_LIMIT = 60;
export const ULTRA_HELP_BODY_LIMIT = 4096;
export const ULTRA_TOKEN_COOLDOWN_MS = 10_000;
export const ULTRA_TOKEN_HOURLY_LIMIT = 20;
export const ULTRA_HOLDER_ADDRESS_LIMIT = Object.freeze({
  max: 60,
  windowMs: 60_000,
});
export const ULTRA_HOLDER_MISS_LIMIT = Object.freeze({
  max: 20,
  windowMs: 60_000,
});
export const ULTRA_INBOX_LIMIT = 100;
export const ULTRA_NOTIFY_LIMIT = 20;
/**
 * How many help tokens one machine keeps, live and revoked together. Reading
 * a larger file keeps every well-formed record; minting is what refuses.
 */
export const ULTRA_TOKEN_LIMIT = 200;

const HOUR_MS = 60 * 60 * 1000;
const FEED_ID_LIMIT = 80;
const ADDRESS_LIMIT = 64;
const TOKEN_ID_PATTERN = /^t-[0-9a-f]{16}$/;
const MESSAGE_ID_PATTERN = /^m-[0-9a-f]{16}$/;
// A home-list entry id (src/ultraNetwork.mjs mints them); an inbox row of
// kind 'release' names the entry whose poll produced it.
const NETWORK_ID_PATTERN = /^n-[0-9a-f]{16}$/;
const INCIDENTS = Object.freeze(['threat', 'fire', 'medical', 'other']);
const PLACE_LIMIT = 160;
const SMS_OUTCOME_LIMIT = 40;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const LOOPBACK = /^(127\.|::1$)/;
const AAD_PREFIX = 'ultra-token:';
const SKILL_AAD = 'ultra-token-skills:';
// Nothing here touches Buffer or node:crypto at import time: the dashboard
// no longer bundles this module, but a browser build that ever pulls it in
// again must not fail while loading (the test pins it).
let zeroDigestBytes = null;
function zeroDigest() {
  if (!zeroDigestBytes) zeroDigestBytes = Buffer.alloc(32);
  return zeroDigestBytes;
}

/**
 * A token is 32 bytes — 256 bits — from the system CSPRNG. Uniqueness is not
 * arranged, it is arithmetic: by the birthday bound the chance that any two
 * of n tokens collide is about n² / 2²⁵⁷. At a hundred billion people
 * holding ten tokens each (n = 10¹², about 2⁴⁰) that is 2⁻¹⁷⁷, roughly one
 * in 10⁵³ — far below the chance of the machine miscomputing the comparison.
 * No counter, no registry and no coordination between installs is needed,
 * which is what lets two people who have never met hand tokens to each other.
 *
 * So the only real way to get a repeat is a broken generator, not bad luck.
 * A draw whose bytes are all identical (the classic shape of a CSPRNG that
 * is returning zeros, or of a stub left in by accident) is refused rather
 * than handed out, and the caller redraws.
 */
export function newUltraToken(randomBytes = crypto.randomBytes) {
  return ULTRA_TOKEN_PREFIX + drawBytes(randomBytes, 32).toString('base64url');
}

/**
 * Random bytes the generator is willing to stand behind. A CSPRNG never
 * returns a run of one repeated byte in practice, so treat it as a fault and
 * try again; giving up loudly beats minting a token that is not a secret.
 */
function drawBytes(randomBytes, length, attempts = 3) {
  // Only the system generator is policed. A caller that injected its own is
  // a test choosing its bytes on purpose, and refusing those would say
  // nothing about the CSPRNG this actually runs on.
  if (randomBytes !== crypto.randomBytes)
    return Buffer.from(randomBytes(length));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const bytes = Buffer.from(randomBytes(length));
    if (bytes.length !== length) continue;
    if (!bytes.every((byte) => byte === bytes[0])) return bytes;
  }
  throw Object.assign(
    new Error('the random generator is not returning usable bytes'),
    { code: 'GEV_WEAK_RANDOM' },
  );
}

/** The text of config/ultra-tokens.key: 32 random bytes as 64 hex and a newline. */
export function newUltraTokenKeyText(randomBytes = crypto.randomBytes) {
  return drawBytes(randomBytes, 32).toString('hex') + '\n';
}

/** The 32-byte key a key file holds, or null when the file is not one. */
export function parseUltraTokenKey(text) {
  const hex = String(text ?? '').trim();
  return KEY_PATTERN.test(hex) ? Buffer.from(hex, 'hex') : null;
}

/** The lookup key of a token: SHA-256 of its UTF-8 text as lowercase hex. */
export function ultraTokenHash(token) {
  return crypto
    .createHash('sha256')
    .update(String(token), 'utf8')
    .digest('hex');
}

/** The first 8 hex of a hash: what the owner sees in a row, never the token. */
export function ultraTokenFingerprint(hash) {
  const text = String(hash ?? '');
  return HASH_PATTERN.test(text) ? text.slice(0, 8) : '';
}

/** A record id is random, never derived from the token. */
export function ultraTokenId(randomBytes = crypto.randomBytes) {
  return 't-' + drawBytes(randomBytes, 8).toString('hex');
}

export function ultraMessageId(randomBytes = crypto.randomBytes) {
  return 'm-' + drawBytes(randomBytes, 8).toString('hex');
}

/**
 * Constant-time: does this stored hash equal SHA-256 of the opened token?
 * A hash that is not 64 hex is compared against a zero digest and misses.
 */
export function ultraTokenHashEqual(hash, token) {
  const given = Buffer.from(ultraTokenHash(String(token ?? '')), 'hex');
  const text = String(hash ?? '');
  if (!HASH_PATTERN.test(text)) {
    crypto.timingSafeEqual(given, zeroDigest());
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(text, 'hex'), given);
}

/**
 * AES-256-GCM under the machine-local key. The record id is the additional
 * authenticated data, so a blob cannot be moved between records and the tag
 * checks that blob. The flags beside it have their own per-record policy MAC;
 * there is still no store-wide MAC. The `aad`
 * prefix names the store a blob belongs to ('ultra-token:' for the owner's
 * own tokens, 'ultra-network:' for the home list), so a blob cannot be moved
 * between stores either; the default keeps every existing record opening.
 */
export function sealUltraToken(
  token,
  key,
  { id, randomBytes = crypto.randomBytes, aad = AAD_PREFIX } = {},
) {
  const iv = drawBytes(randomBytes, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad) + String(id), 'utf8'));
  const data = Buffer.concat([
    cipher.update(String(token), 'utf8'),
    cipher.final(),
  ]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/** A custom skill set reduced to the slug the token string can carry, or '' when it has no letters or numbers. */
export function ultraSkillSlug(raw) {
  return ultraCustomSkill(raw)?.slug || '';
}

const KNOWN_SKILLS = new Map(
  ULTRA_SKILL_SETS.map((item) => [item.code, item.label]),
);

/** The skill list a clear payload names, or null when a code is not one. Duplicates collapse. */
function skillsFromPayload(payload) {
  if (payload === '') return [];
  const codes = String(payload).split('.');
  if (codes.length > ULTRA_SKILL_SETS.length + ULTRA_CUSTOM_SKILL_LIMIT)
    return null;
  const skills = [];
  const seen = new Set();
  for (const code of codes) {
    if (!SKILL_CODE_PATTERN.test(code)) return null;
    if (seen.has(code)) continue;
    seen.add(code);
    const known = KNOWN_SKILLS.get(code);
    skills.push({
      code,
      label: known || ultraSkillLabel(code.slice(1)),
    });
  }
  return skills;
}

function sealSkillBlob(payload, key, secretBody, randomBytes) {
  const iv = drawBytes(randomBytes, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(SKILL_AAD + secretBody, 'utf8'));
  const data = Buffer.concat([
    cipher.update(String(payload), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

function openSkillBlob(blob, key, secretBody) {
  try {
    if (!/^[A-Za-z0-9_-]{38,360}$/.test(blob)) return null;
    if (!Buffer.isBuffer(key) || key.length !== 32) return null;
    const bytes = Buffer.from(blob, 'base64url');
    if (bytes.length < 28) return null;
    const iv = bytes.subarray(0, 12);
    const tag = bytes.subarray(12, 28);
    const data = bytes.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(SKILL_AAD + secretBody, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    return null;
  }
}

/**
 * The skill sets on a presented token. A clear suffix is read by anyone
 * holding the link. An encrypted suffix opens only with this machine's
 * token key; without it the caller learns that the skills are hidden and
 * nothing else. A classic token has none.
 */
export function readUltraTokenSkills(token, key = null) {
  if (typeof token !== 'string' || !ULTRA_TOKEN_PATTERN.test(token))
    return null;
  if (token.length === ULTRA_TOKEN_PREFIX.length + 43)
    return { encrypted: false, skills: [] };
  const secretBody = token.slice(
    ULTRA_TOKEN_PREFIX.length,
    ULTRA_TOKEN_PREFIX.length + 43,
  );
  const mark = token.slice(48, 51);
  const rest = token.slice(51);
  if (mark === '.s.') {
    const skills = skillsFromPayload(rest);
    return skills ? { encrypted: false, skills } : null;
  }
  if (mark !== '.e.') return null;
  if (!key) return { encrypted: true, skills: [] };
  const payload = openSkillBlob(rest, key, secretBody);
  if (payload === null) return { encrypted: true, skills: [] };
  const skills = skillsFromPayload(payload);
  return { encrypted: true, skills: skills || [] };
}

/** Named codes in catalog order, then custom codes in the order given. Null when a code cannot be carried. */
function skillPayload(skills) {
  const list = Array.isArray(skills) ? skills : [];
  const known = [];
  const custom = [];
  const seen = new Set();
  for (const item of list) {
    const code = String(item?.code ?? '');
    if (!SKILL_CODE_PATTERN.test(code)) return null;
    if (seen.has(code)) continue;
    seen.add(code);
    if (CATALOG_INDEX.has(code)) known.push(code);
    else custom.push(code);
  }
  if (
    known.length + custom.length >
    ULTRA_SKILL_SETS.length + ULTRA_CUSTOM_SKILL_LIMIT
  )
    return null;
  known.sort((a, b) => CATALOG_INDEX.get(a) - CATALOG_INDEX.get(b));
  return [...known, ...custom].join('.');
}

function composedToken(token, payload, key) {
  if (!ULTRA_TOKEN_PATTERN.test(token)) return null;
  const opened = readUltraTokenSkills(token, key);
  if (!opened) return null;
  const got = opened.skills.map((item) => item.code).join('.');
  return got === payload ? token : null;
}

/**
 * The bearer string: the 256-bit secret, then the skill codes when there
 * are any. Encrypt seals those codes under the machine key and the secret
 * itself, so a copy of the link does not list them and the blob cannot be
 * moved onto another secret. The hash of a token is the hash of this whole
 * string, so taking the skills off, or rewriting them, is a different token.
 * No skills and Encrypt off returns the secret unchanged. A code the string
 * cannot carry refuses the mint rather than dropping that skill.
 */
export function composeUltraToken(
  secret,
  skills,
  { encrypt = false, key, randomBytes = crypto.randomBytes } = {},
) {
  if (typeof secret !== 'string' || !CLASSIC_TOKEN_PATTERN.test(secret))
    return null;
  const payload = skillPayload(skills);
  if (payload === null) return null;
  if (encrypt !== true && !payload) return secret;
  if (encrypt !== true)
    return composedToken(`${secret}.s.${payload}`, payload, null);
  if (!Buffer.isBuffer(key) || key.length !== 32) return null;
  const token = `${secret}.e.${sealSkillBlob(payload, key, secret.slice(ULTRA_TOKEN_PREFIX.length), randomBytes)}`;
  return composedToken(token, payload, key);
}

/** Labels a peer can show from a link, and whether the skills are sealed. Nothing when the token is not one. */
export function ultraTokenSkillFields(token) {
  const read = readUltraTokenSkills(token);
  if (!read) return {};
  const fields = {};
  if (read.skills.length)
    fields.skills = read.skills.map((item) => item.label);
  if (read.encrypted) fields.encrypted = true;
  return fields;
}

/**
 * The skill sets a mint asked for. Named ones come out in catalog order;
 * custom ones keep the order they were typed, at most five. The label is
 * the short name the link carries, cut on a word. The same name typed twice
 * is one skill. Two different names that shorten to one code are refused.
 * A blank custom box is skipped. The reason never repeats what was typed.
 */
export function normalizeUltraSkillRequest(body) {
  const source = body && typeof body === 'object' ? body : {};
  const named = source.skills === undefined ? [] : source.skills;
  const custom = source.custom === undefined ? [] : source.custom;
  if (!Array.isArray(named) || !Array.isArray(custom))
    return { ok: false, error: 'Skill sets must be a list' };
  if (named.length > ULTRA_SKILL_SETS.length)
    return { ok: false, error: 'At most the listed skill sets' };
  const wanted = new Set();
  for (const item of named) {
    const code = typeof item === 'string' ? item : '';
    if (!KNOWN_SKILLS.has(code))
      return { ok: false, error: 'Unknown skill set' };
    wanted.add(code);
  }
  const skills = ULTRA_SKILL_SETS.filter((item) => wanted.has(item.code)).map(
    (item) => ({ code: item.code, label: item.label }),
  );
  const customSkills = ultraCustomSkillList(custom);
  if (!customSkills.ok) return { ok: false, error: customSkills.error };
  for (const item of customSkills.skills)
    skills.push({ code: item.code, label: item.label });
  return { ok: true, encrypt: source.encrypt === true, skills };
}

/** Skill sets stored on a token record. Known labels stay the catalog's. A custom label is rebuilt from its code, so the row shows the name the link carries. Junk codes are dropped, and a missing list is none. */
function normalizeStoredSkills(value) {
  if (!Array.isArray(value)) return [];
  const skills = [];
  const seen = new Set();
  for (const item of value) {
    const code = String(item?.code ?? '');
    if (!SKILL_CODE_PATTERN.test(code) || seen.has(code)) continue;
    seen.add(code);
    const known = KNOWN_SKILLS.get(code);
    const label = known || ultraSkillLabel(code.slice(1));
    if (!label) continue;
    skills.push({ code, label });
    if (skills.length >= ULTRA_SKILL_SETS.length + ULTRA_CUSTOM_SKILL_LIMIT)
      break;
  }
  return skills;
}

/** The token a sealed blob holds, or null for any failure: wrong key, wrong id or store prefix, a changed byte, a bad shape. */
export function openUltraToken(sealed, key, { id, aad = AAD_PREFIX } = {}) {
  try {
    if (!sealed || typeof sealed !== 'object' || sealed.v !== 1) return null;
    if (!Buffer.isBuffer(key) || key.length !== 32) return null;
    const iv = base64Bytes(sealed.iv, 12);
    const tag = base64Bytes(sealed.tag, 16);
    const data = base64Bytes(sealed.data);
    if (!iv || !tag || !data) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(String(aad) + String(id), 'utf8'));
    decipher.setAuthTag(tag);
    const text = Buffer.concat([
      decipher.update(data),
      decipher.final(),
    ]).toString('utf8');
    return ULTRA_TOKEN_PATTERN.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Bytes of a base64 field, or null when it is not base64 of the wanted length (any non-empty length when none is given). */
function base64Bytes(value, length = null) {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (length === null ? bytes.length < 1 : bytes.length !== length) return null;
  return bytes;
}

const POLICY_TAG = 'ultra-token-policy:v1';

/** A length-prefixed field, so a label that contains a newline cannot slide into the next flag. */
function policyText(value) {
  const text = String(value ?? '');
  return `${Buffer.byteLength(text, 'utf8')}:${text}`;
}

function policyFlag(value) {
  return value === true ? '1' : '0';
}

/** A finite number, or '-' when the field is empty. Null and a missing field encode the same, so a row written without one still matches. */
function policyNum(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-';
}

/**
 * The bytes the policy MAC covers. Fixed order, and not the MAC itself or
 * the stored skill list: the skills are already inside the bearer hash, and
 * an encrypted token stores no skill names.
 */
function policyCanonical(record) {
  const revoked =
    typeof record?.revokedAt === 'number' && Number.isFinite(record.revokedAt)
      ? String(record.revokedAt)
      : '-';
  return [
    POLICY_TAG,
    policyText(record?.id),
    policyText(record?.feedId),
    policyText(record?.label),
    policyFlag(record?.sms),
    policyFlag(record?.voice),
    policyFlag(record?.network),
    policyFlag(record?.anytime),
    policyFlag(record?.locationOnly),
    policyFlag(record?.encrypted),
    revoked,
    policyText(record?.hash),
  ].join('\n');
}

/** HMAC-SHA256 of the flags under the token key, or '' when the key cannot make one. */
export function ultraTokenPolicyMac(record, key) {
  if (!record || typeof record !== 'object') return '';
  if (!Buffer.isBuffer(key) || key.length !== 32) return '';
  return crypto
    .createHmac('sha256', key)
    .update(policyCanonical(record), 'utf8')
    .digest('hex');
}

/**
 * 'legacy' when this record has never had a policy MAC (a file from before
 * the check, or a MAC that was cleared). 'ok' when the MAC matches. 'bad'
 * when a MAC is present but is not 64 hex, the key cannot check it, or it
 * does not match. A present MAC is never treated as legacy.
 */
export function ultraTokenPolicyState(record, key) {
  const mac = record?.policyMac;
  if (mac === undefined || mac === null || mac === '') return 'legacy';
  if (typeof mac !== 'string' || !HASH_PATTERN.test(mac)) return 'bad';
  if (!Buffer.isBuffer(key) || key.length !== 32) return 'bad';
  const expected = ultraTokenPolicyMac(record, key);
  if (!HASH_PATTERN.test(expected)) return 'bad';
  return crypto.timingSafeEqual(
    Buffer.from(mac, 'hex'),
    Buffer.from(expected, 'hex'),
  )
    ? 'ok'
    : 'bad';
}

/**
 * The record with a fresh policy MAC and no stored skill names. Unchanged
 * when the key cannot make a MAC, so a missing key is not laundered into a
 * check the next key would fail.
 */
export function stampUltraTokenPolicy(record, key) {
  const policyMac = ultraTokenPolicyMac(record, key);
  if (!policyMac) return record;
  return { ...record, skills: [], policyMac };
}

const INBOX_POLICY_TAG = 'ultra-inbox-policy:v1';

/**
 * The bytes an inbox row's check covers: everything the box shows or says,
 * and not the check itself. A rewritten plea, number, place or position
 * fails it. deliveredAt and readAt are included so a mark the process
 * writes is stamped again with the row.
 */
function inboxPolicyCanonical(record) {
  return [
    INBOX_POLICY_TAG,
    policyText(record?.id),
    policyText(record?.tokenId),
    policyText(record?.kind),
    policyText(record?.networkId),
    policyText(record?.label),
    policyText(record?.from),
    policyText(record?.number),
    policyText(record?.text),
    policyText(record?.place),
    policyText(record?.incident),
    policyNum(record?.lat),
    policyNum(record?.lon),
    policyNum(record?.at),
    policyNum(record?.until),
    policyText(record?.sms),
    policyNum(record?.deliveredAt),
    policyNum(record?.readAt),
    policyNum(record?.peerUntil),
  ].join('\n');
}

/** HMAC-SHA256 of one inbox row under the token key, or '' when the key cannot make one. */
export function ultraInboxPolicyMac(record, key) {
  if (!record || typeof record !== 'object') return '';
  if (!Buffer.isBuffer(key) || key.length !== 32) return '';
  return crypto
    .createHmac('sha256', key)
    .update(inboxPolicyCanonical(record), 'utf8')
    .digest('hex');
}

/** 'legacy' with no check, 'ok' when it matches, 'bad' when a check is present and does not. */
export function ultraInboxPolicyState(record, key) {
  const mac = record?.policyMac;
  if (mac === undefined || mac === null || mac === '') return 'legacy';
  if (typeof mac !== 'string' || !HASH_PATTERN.test(mac)) return 'bad';
  if (!Buffer.isBuffer(key) || key.length !== 32) return 'bad';
  const expected = ultraInboxPolicyMac(record, key);
  if (!HASH_PATTERN.test(expected)) return 'bad';
  return crypto.timingSafeEqual(
    Buffer.from(mac, 'hex'),
    Buffer.from(expected, 'hex'),
  )
    ? 'ok'
    : 'bad';
}

/** The row with a fresh check. Unchanged when the key cannot make one. */
export function stampUltraInboxPolicy(record, key) {
  const policyMac = ultraInboxPolicyMac(record, key);
  if (!policyMac) return record;
  return { ...record, policyMac };
}

function inboxCarriesPolicyMac(record) {
  const mac = record?.policyMac;
  return mac !== undefined && mac !== null && mac !== '';
}

/**
 * Rows the box may show and read aloud. A file in which no row has a check
 * is shown as stored: that is a file from before the check, and wiping
 * every check looks the same. Once any row has a check, or this key opens
 * some seal (`sealsOpen`), a row whose check is missing or wrong is left
 * out. When the key opens nothing and no row's check matches, the rows are
 * shown: that is a replaced key, and the copies cannot be told apart.
 */
export function ultraInboxVisibleMessages(
  messages,
  key,
  { sealsOpen = false } = {},
) {
  const list = Array.isArray(messages) ? messages : [];
  if (!Buffer.isBuffer(key) || key.length !== 32) return list;
  if (!list.some(inboxCarriesPolicyMac)) return list;
  const someOk = list.some(
    (record) => ultraInboxPolicyState(record, key) === 'ok',
  );
  if (!someOk && !sealsOpen) return list;
  return list.filter(
    (record) => ultraInboxPolicyState(record, key) === 'ok',
  );
}

/**
 * What this one record says while this key is the one that sealed the token.
 * The store decides whether a 'legacy' or 'unsealed' record is still trusted:
 * see selectUltraToken.
 * 'unsealed' — the key is missing or this seal will not open.
 * 'tampered' — the seal opens and the hash or the policy MAC does not match.
 * 'legacy' — the seal matches and no policy MAC has been stored on this record.
 * 'ok' — the seal matches and the policy MAC matches.
 */
export function ultraTokenRecordVerdict(record, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return 'unsealed';
  const opened = openUltraToken(record?.sealed, key, { id: record?.id });
  if (!opened) return 'unsealed';
  if (!ultraTokenHashEqual(record?.hash, opened)) return 'tampered';
  const state = ultraTokenPolicyState(record, key);
  if (state === 'bad') return 'tampered';
  if (state === 'legacy') return 'legacy';
  return 'ok';
}

/**
 * Skill names for the owner's row. Taken from the opened token when this key
 * opens the seal and the hash matches, so the file's skill list is not a
 * second source of truth. When the seal will not open, an encrypted record
 * shows nothing (the file is not trusted) and a clear record may still show
 * the labels it stored before they were stripped.
 */
export function ultraTokenDisplayedSkills(record, key) {
  const keyOk = Buffer.isBuffer(key) && key.length === 32;
  const opened = keyOk
    ? openUltraToken(record?.sealed, key, { id: record?.id })
    : null;
  if (opened) {
    if (!ultraTokenHashEqual(record?.hash, opened))
      return { skills: [], encrypted: record?.encrypted === true };
    const read = readUltraTokenSkills(opened, key);
    if (read)
      return { skills: read.skills, encrypted: read.encrypted === true };
  }
  if (record?.encrypted === true) return { skills: [], encrypted: true };
  return {
    skills: Array.isArray(record?.skills) ? record.skills : [],
    encrypted: false,
  };
}

/** A policy MAC this record actually carries. Absent, null and '' do not: those are a record that has not been checked. */
function recordCarriesPolicyMac(record) {
  const mac = record?.policyMac;
  return mac !== undefined && mac !== null && mac !== '';
}

/** True when any record carries a policy MAC, including one that does not verify. */
export function ultraTokenStoreHasPolicyMac(records) {
  const list = Array.isArray(records) ? records : [];
  return list.some(recordCarriesPolicyMac);
}

/**
 * Per-record tamper flags for the owner's rows, one open of each seal.
 * False when the key cannot be used. A record is tampered when its seal
 * opens and the check does not, when its check is missing while another
 * record still has one, or when a live row's seal will not open while some
 * other seal in the file does. A revoked row is not marked for that last
 * reason. Nothing is tampered when this key opens no seal:
 * that is a missing or replaced key, and every link is still admitted by hash.
 */
export function ultraTokenTamperFlags(records, key) {
  const list = Array.isArray(records) ? records : [];
  const flags = new Array(list.length).fill(false);
  if (!Buffer.isBuffer(key) || key.length !== 32) return flags;
  const hasMac = list.some(recordCarriesPolicyMac);
  const verdicts = list.map((record) => ultraTokenRecordVerdict(record, key));
  const anyOpen = verdicts.some((verdict) => verdict !== 'unsealed');
  for (let i = 0; i < list.length; i += 1) {
    const verdict = verdicts[i];
    // A revoked row whose seal will not open is not marked tampered: that is
    // what a token revoked before the key was replaced looks like, and the
    // link is already dead. A live row is, once any seal in the file opens.
    flags[i] =
      verdict === 'tampered' ||
      (verdict === 'legacy' && hasMac) ||
      (verdict === 'unsealed' && anyOpen && list[i]?.revokedAt == null);
  }
  return flags;
}

/** The owner's row for this record: same rules as ultraTokenTamperFlags. */
export function ultraTokenRowTampered(record, records, key) {
  const list = Array.isArray(records) ? records : [];
  const index = list.indexOf(record);
  const flags = ultraTokenTamperFlags(
    index >= 0 ? list : [...list, record],
    key,
  );
  return flags[index >= 0 ? index : list.length] === true;
}

/**
 * Which stored record a presented token is, and whether the file disagrees
 * with the seal. Null when no record has this hash. `{ tampered: false }`
 * admits `record`. `{ tampered: true }` is a known token the file no longer
 * supports: the same 404 as an unknown link, and not a wrong guess.
 *
 * The hash compare walks the whole list. Among the matches, the first whose
 * seal opens and whose check is ok (or missing, when no record in the file
 * has a check) is the one admitted, so a copy placed above the real record
 * does not take its place. A live match wins over a revoked one. When every
 * match is damaged, or none of them open while some other seal in the file
 * does, the result is tampered. When the key is missing or opens nothing,
 * the first match is admitted by hash: a deleted or replaced key must not
 * stop a link, and with no seal open the copies cannot be told apart.
 */
export function selectUltraToken(
  records,
  presented,
  key,
  { hash = ultraTokenHash } = {},
) {
  if (typeof presented !== 'string' || !ULTRA_TOKEN_PATTERN.test(presented))
    return null;
  const given = Buffer.from(hash(presented), 'hex');
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) {
    crypto.timingSafeEqual(given, zeroDigest());
    return null;
  }
  const matches = [];
  for (const record of list) {
    const text = String(record?.hash ?? '');
    const saved = HASH_PATTERN.test(text)
      ? Buffer.from(text, 'hex')
      : zeroDigest();
    if (crypto.timingSafeEqual(saved, given)) matches.push(record);
  }
  if (matches.length === 0) return null;
  if (!Buffer.isBuffer(key) || key.length !== 32)
    return { record: matches[0], tampered: false };
  const verdicts = new Map();
  for (const record of list)
    verdicts.set(record, ultraTokenRecordVerdict(record, key));
  const hasMac = list.some(recordCarriesPolicyMac);
  const live = (item) => item?.revokedAt == null;
  let chosen = null;
  let damaged = false;
  for (const record of matches) {
    const verdict = verdicts.get(record);
    const admissible = verdict === 'ok' || (verdict === 'legacy' && !hasMac);
    if (admissible) {
      if (chosen === null || (!live(chosen) && live(record))) chosen = record;
    } else if (verdict === 'tampered' || (verdict === 'legacy' && hasMac)) {
      damaged = true;
    }
  }
  if (chosen) return { record: chosen, tampered: false };
  if (damaged) return { record: matches[0], tampered: true };
  const matched = new Set(matches);
  const otherOpens = list.some(
    (record) => !matched.has(record) && verdicts.get(record) !== 'unsealed',
  );
  if (!otherOpens) return { record: matches[0], tampered: false };
  // Some other seal opens, so this key is good and a live match that will
  // not open was damaged. A revoked match is already dead; admit it so the
  // caller can keep treating a revoked link as revoked.
  const liveMatch = matches.find((record) => record?.revokedAt == null);
  return liveMatch
    ? { record: liveMatch, tampered: true }
    : { record: matches[0], tampered: false };
}

/**
 * The first record a presented token hashes to, in constant time over the
 * whole list: the shape is checked before anything is hashed, the digest is
 * taken once, every record is compared with timingSafeEqual and none is
 * skipped early. An empty list still compares against a zero digest. Two
 * records sharing a hash keep the first here; admission uses selectUltraToken,
 * which keeps looking when that copy's seal will not open. A revoked record
 * is returned like any other; the caller decides what that means.
 */
export function findUltraToken(
  records,
  presented,
  { hash = ultraTokenHash } = {},
) {
  if (typeof presented !== 'string' || !ULTRA_TOKEN_PATTERN.test(presented))
    return null;
  const given = Buffer.from(hash(presented), 'hex');
  const list = Array.isArray(records) ? records : [];
  let found = null;
  if (list.length === 0) {
    crypto.timingSafeEqual(given, zeroDigest());
    return null;
  }
  for (const record of list) {
    const text = String(record?.hash ?? '');
    const saved = HASH_PATTERN.test(text)
      ? Buffer.from(text, 'hex')
      : zeroDigest();
    if (crypto.timingSafeEqual(saved, given) && found === null) found = record;
  }
  return found;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A policy MAC kept on the record. Absent, null or '' is a record from
 * before the check and is omitted, so older files still deep-equal. Anything
 * present that is not 64 hex is kept as 'bad': dropping it would look like
 * a record that was never checked.
 */
function storedPolicyMac(item) {
  if (!Object.hasOwn(item, 'policyMac')) return undefined;
  const mac = item.policyMac;
  if (mac === undefined || mac === null || mac === '') return undefined;
  return typeof mac === 'string' && HASH_PATTERN.test(mac) ? mac : 'bad';
}

/** One stored token record in the current shape, or null when it is unusable. */
export function normalizeUltraTokenRecord(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id ?? '');
  const hash = String(item.hash ?? '');
  const label = cleanHelpText(item.label, ULTRA_HELP_NAME_LIMIT);
  if (!TOKEN_ID_PATTERN.test(id) || !HASH_PATTERN.test(hash) || !label)
    return null;
  const sealed = item.sealed;
  if (
    !sealed ||
    typeof sealed !== 'object' ||
    sealed.v !== 1 ||
    !base64Bytes(sealed.iv, 12) ||
    !base64Bytes(sealed.tag, 16) ||
    !base64Bytes(sealed.data)
  )
    return null;
  const policyMac = storedPolicyMac(item);
  return {
    id,
    feedId: String(item.feedId ?? '')
      .trim()
      .slice(0, FEED_ID_LIMIT),
    label,
    sms: item.sms === true,
    voice: item.voice === true,
    // Only a literal true switches the help network on: a record minted
    // before the flag existed reads as off, so no holder gains the owner's
    // position by an upgrade.
    network: item.network === true,
    // Owner ruling, 2026-09-28: a token is dark until its owner asks for
    // help. ANYTIME is the deliberate exception — the holder page, what it
    // says and its message box stay open the rest of the time. Only a
    // literal true, so nothing minted before this reads as always open.
    anytime: item.anytime === true,
    // Owner ruling, 2026-09-29: a token in the group directory is a location
    // subscription and nothing else. Its holders — everyone who reads the
    // directory — get the position poll alone: no page, no /status, no
    // message box, even while a call for help is on. Set when the token is
    // made for the directory or published to it, and never taken back.
    locationOnly: item.locationOnly === true,
    // Skill sets are fixed in the token string at mint. A record from
    // before they existed reads as none, and Encrypt reads on only for a
    // literal true, so nothing older hides a skill list it never had.
    skills: normalizeStoredSkills(item.skills),
    encrypted: item.encrypted === true,
    createdAt: finiteOrNull(item.createdAt),
    revokedAt: finiteOrNull(item.revokedAt),
    hash,
    sealed: { v: 1, iv: sealed.iv, tag: sealed.tag, data: sealed.data },
    ...(policyMac === undefined ? {} : { policyMac }),
  };
}

/**
 * Whatever config/ultra-tokens.json holds, in the current shape. Malformed
 * records are dropped. A repeated id keeps the first record. A repeated
 * hash is kept: a copy inserted above the real record must not erase the
 * one whose seal still opens. Reading never drops a token for the count:
 * minting refuses once ULTRA_TOKEN_LIMIT are kept.
 */
export function normalizeUltraTokenStore(parsed) {
  const items = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
  const takenIds = new Set();
  const tokens = [];
  for (const item of items) {
    const record = normalizeUltraTokenRecord(item);
    if (!record || takenIds.has(record.id)) continue;
    takenIds.add(record.id);
    tokens.push(record);
  }
  return { version: 1, tokens };
}

/**
 * A lat/lon pair the holder volunteered (or a peer released), or nulls:
 * both finite, in range and not the 0,0 a blank form sends. Exported for
 * the help network, which runs every peer position through it.
 */
export function cleanPosition(lat, lon) {
  const la = finiteOrNull(lat);
  const lo = finiteOrNull(lon);
  if (
    la === null ||
    lo === null ||
    Math.abs(la) > 90 ||
    Math.abs(lo) > 180 ||
    (la === 0 && lo === 0)
  )
    return { lat: null, lon: null };
  return { lat: la, lon: lo };
}

/**
 * One inbox message in the current shape, or null when it has no id, text
 * or time. A row is a holder's message (kind 'message') or a call for help
 * received through the help network (kind 'release': the entry it came
 * through, the street address, the incident class, the local window end,
 * the SMS relay outcome and the peer's own window end); a row written
 * before those fields existed reads as a message with the defaults.
 */
export function normalizeUltraInboxRecord(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id ?? '');
  const text = cleanHelpText(item.text, ULTRA_HELP_TEXT_LIMIT, {
    lines: true,
  });
  const at = finiteOrNull(item.at);
  if (!MESSAGE_ID_PATTERN.test(id) || !text || at === null) return null;
  const tokenId = String(item.tokenId ?? '');
  const networkId = String(item.networkId ?? '');
  const incident = String(item.incident ?? '');
  const release = item.kind === 'release';
  // A call for help also keeps the window end its peer last sent, as sent:
  // after a restart it is what tells a second link to the same call that
  // this row is already that call. Only a row that has one carries it.
  const peerUntil = release ? finiteOrNull(item.peerUntil) : null;
  const policyMac = storedPolicyMac(item);
  return {
    id,
    tokenId: TOKEN_ID_PATTERN.test(tokenId) ? tokenId : '',
    kind: release ? 'release' : 'message',
    networkId: NETWORK_ID_PATTERN.test(networkId) ? networkId : '',
    label: cleanHelpText(item.label, ULTRA_HELP_NAME_LIMIT),
    from: cleanHelpText(item.from, ULTRA_HELP_NAME_LIMIT),
    number: normalizeUltraNumber(item.number) || '',
    text,
    place: cleanHelpText(item.place, PLACE_LIMIT),
    incident: INCIDENTS.includes(incident) ? incident : '',
    ...cleanPosition(item.lat, item.lon),
    at,
    until: finiteOrNull(item.until),
    sms: cleanHelpText(item.sms, SMS_OUTCOME_LIMIT),
    deliveredAt: finiteOrNull(item.deliveredAt),
    readAt: finiteOrNull(item.readAt),
    ...(peerUntil === null ? {} : { peerUntil }),
    // Absent when the row has never had a check, so an older inbox still
    // deep-equals. A present value that is not 64 hex is kept as 'bad'.
    ...(policyMac === undefined ? {} : { policyMac }),
  };
}

/** Whatever config/ultra-inbox.json holds: newest first, capped at 100. */
export function normalizeUltraInbox(parsed) {
  const items = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const taken = new Set();
  const messages = [];
  for (const item of items) {
    const record = normalizeUltraInboxRecord(item);
    if (!record || taken.has(record.id)) continue;
    taken.add(record.id);
    messages.push(record);
  }
  messages.sort((a, b) => b.at - a.at);
  return { version: 1, messages: messages.slice(0, ULTRA_INBOX_LIMIT) };
}

/**
 * Characters that change how the text around them is shown, never what it
 * says: C0 and C1 controls other than the tab and newline, zero-width
 * characters, the bidi marks, embeddings, overrides and isolates (U+061C,
 * U+200E/U+200F, U+202A-U+202E, U+2066-U+2069), the line and paragraph
 * separators and the byte-order mark. A right-to-left override in a peer's
 * name would show what follows it reversed, in the relayed SMS too.
 */
const HIDDEN_TEXT =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/**
 * Peer- or holder-supplied text made safe to store, paint, speak and text
 * on: only a string (or a number) counts as text, the hidden characters
 * above go, and so does every line break unless `lines` keeps them (a
 * message, never a name, label or place); runs of spaces and tabs become
 * one space, the ends are trimmed and the rest is cut at the limit (in code
 * units).
 */
export function cleanHelpText(
  raw,
  limit = ULTRA_HELP_TEXT_LIMIT,
  { lines = false } = {},
) {
  const text =
    typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
  const shown = text.replace(HIDDEN_TEXT, '');
  return (lines ? shown : shown.replace(/\n/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * The inbox record for one accepted message, or null when the cleaned text
 * is empty. `ids` makes the message id: a function, an object with a
 * `message` function, or an object carrying `randomBytes`.
 */
export function ultraHelpMessageRecord({ record, body, now, ids } = {}) {
  const text = cleanHelpText(body?.text, ULTRA_HELP_TEXT_LIMIT, {
    lines: true,
  });
  if (!text) return null;
  const id =
    typeof ids === 'function'
      ? ids()
      : typeof ids?.message === 'function'
        ? ids.message()
        : ultraMessageId(ids?.randomBytes);
  return {
    id,
    tokenId: String(record?.id ?? ''),
    kind: 'message',
    networkId: '',
    label: cleanHelpText(record?.label, ULTRA_HELP_NAME_LIMIT),
    from: cleanHelpText(body?.from, ULTRA_HELP_NAME_LIMIT),
    number: normalizeUltraNumber(body?.number) || '',
    text,
    place: '',
    incident: '',
    ...cleanPosition(body?.lat, body?.lon),
    at: Number(now),
    until: null,
    sms: '',
    deliveredAt: null,
    readAt: null,
  };
}

/**
 * What the phone pops on its poll: the message, nothing about the token. A
 * holder's message keeps the keys the page has always read; a call for help
 * received through the network is kind 'release' and carries the place, the
 * incident, the window end and the home-list entry, never a number (the
 * victim's phone is never texted).
 */
export function ultraNotifyItem(message) {
  if (message.kind === 'release') {
    return {
      kind: 'release',
      id: message.id,
      label: message.label,
      from: message.from,
      number: '',
      lat: message.lat,
      lon: message.lon,
      text: message.text,
      place: message.place,
      incident: message.incident,
      at: message.at,
      until: message.until,
      networkId: message.networkId,
    };
  }
  return {
    kind: 'notify',
    id: message.id,
    label: message.label,
    from: message.from,
    number: message.number,
    lat: message.lat,
    lon: message.lon,
    text: message.text,
    at: message.at,
  };
}

/**
 * A sliding-window budget per key (an address), kept in the caller's Map of
 * key to hit times. A refused hit is not recorded, so a client is served
 * again as soon as the window clears. The Map never holds more than `cap`
 * keys: the least recently touched one is evicted first.
 */
export function allowUltraRequest(
  buckets,
  key,
  now,
  { max, windowMs, cap = 1000 } = {},
) {
  const since = Number(now) - Number(windowMs);
  const hits = (buckets.get(key) || []).filter((at) => at > since);
  if (hits.length >= max) {
    if (buckets.has(key)) buckets.set(key, hits);
    return false;
  }
  hits.push(Number(now));
  // Re-inserting moves the key to the end, so insertion order is recency order.
  buckets.delete(key);
  buckets.set(key, hits);
  while (buckets.size > cap) buckets.delete(buckets.keys().next().value);
  return true;
}

/**
 * Whether a token may send now, from its accepted-message times (pruned in
 * place to the last hour). Nothing is recorded here: the caller pushes `now`
 * once the message is accepted, and the status route reads `sent` without
 * spending anything.
 */
export function ultraTokenSendAllowed(
  sends,
  now,
  {
    cooldownMs = ULTRA_TOKEN_COOLDOWN_MS,
    hourlyLimit = ULTRA_TOKEN_HOURLY_LIMIT,
    windowMs = HOUR_MS,
  } = {},
) {
  const at = Number(now);
  const since = at - windowMs;
  for (let i = sends.length - 1; i >= 0; i -= 1) {
    if (!(sends[i] > since)) sends.splice(i, 1);
  }
  const sent = sends.length;
  if (sent >= hourlyLimit) return { ok: false, reason: 'hourly', sent };
  const last = sent ? Math.max(...sends) : null;
  if (last !== null && at - last < cooldownMs)
    return { ok: false, reason: 'cooldown', sent };
  return { ok: true, reason: '', sent };
}

/**
 * The address a holder request is budgeted under. Behind tailscale serve the
 * socket is loopback and the holder is the first x-forwarded-for hop; on any
 * other socket the header is ignored entirely, so it cannot be spoofed to
 * escape a budget.
 */
export function ultraClientAddress({ remoteAddress, forwardedFor } = {}) {
  const socketAddress = String(remoteAddress ?? '')
    .trim()
    .replace(/^::ffff:/i, '');
  const hop = String(forwardedFor ?? '')
    .split(',')[0]
    .trim();
  const address = LOOPBACK.test(socketAddress) && hop ? hop : socketAddress;
  return address.slice(0, ADDRESS_LIMIT);
}
