/**
 * The operator's own social logins, encrypted on this computer.
 *
 * config/social-accounts.key is a 32-byte key (64 hex). config/social-accounts.json
 * holds a canary and one sealed row per platform. A row is AES-256-GCM of the
 * user id and password and/or the platform's API key, bound to that platform,
 * plus an HMAC so a swapped row
 * does not open. The password is not returned by the HTTP API and is not sent
 * to a platform, a model, or a news lookup.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { replaceCredentialStore } from './keySetupHardening.mjs';
import { SOCIAL_ACCOUNT_PLATFORMS } from '../../src/socialMedia.js';

const KEY_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SECRET_PREFIX = /^(?:sk-|xox[baprs]-|ghp_|ya29\.|eyJ)/;
const SECRET_PATTERN =
  /password|api[_-]?key|bearer|\bsession\b|\bcookie\b|\bsecret\b|\btoken\b/i;
const CANARY_AAD = Buffer.from('social-accounts-canary');
const CANARY_PLAIN = Buffer.from('social-accounts-v1');
const USER_ID_MAX = 128;
const PASSWORD_MAX = 256;
const API_KEY_MAX = 512;

export const SOCIAL_LOGIN_LOCKED =
  'The encrypted store on this computer could not be opened.';

/** KDF labels. A test recomputes a MAC with these and still must not open a swapped row. */
export const SOCIAL_ACCOUNT_KDF = Object.freeze({
  salt: 'gev-social-accounts-v1',
  enc: 'social-accounts-enc',
  mac: 'social-accounts-mac',
});

const PLATFORMS = SOCIAL_ACCOUNT_PLATFORMS.map((item) => item.id);
const PLATFORM_SET = new Set(PLATFORMS);

const storeFile = (root) => path.join(root, 'config', 'social-accounts.json');
const keyFile = (root) => path.join(root, 'config', 'social-accounts.key');

function parseKey(text) {
  const hex = String(text ?? '').trim();
  return KEY_PATTERN.test(hex) ? Buffer.from(hex, 'hex') : null;
}

function readKey(root) {
  let text;
  try {
    text = fs.readFileSync(keyFile(root), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { key: null, state: 'missing' };
    return { key: null, state: 'invalid' };
  }
  const key = parseKey(text);
  return key ? { key, state: 'ok' } : { key: null, state: 'invalid' };
}

function ensureKey(root) {
  const read = readKey(root);
  if (read.state !== 'missing') return read;
  const key = crypto.randomBytes(32);
  const file = keyFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  replaceCredentialStore(file, `${key.toString('hex')}\n`);
  return { key, state: 'ok' };
}

function derivedKeys(master) {
  const salt = Buffer.from(SOCIAL_ACCOUNT_KDF.salt);
  const enc = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      master,
      salt,
      Buffer.from(SOCIAL_ACCOUNT_KDF.enc),
      32,
    ),
  );
  const mac = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      master,
      salt,
      Buffer.from(SOCIAL_ACCOUNT_KDF.mac),
      32,
    ),
  );
  return { enc, mac };
}

function accountAad(platform) {
  return Buffer.from(`social-account:v1:${platform}`);
}

function seal(key, aad, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64url'),
    data: data.toString('base64url'),
    tag: tag.toString('base64url'),
  };
}

function openSeal(key, aad, sealed) {
  const iv = Buffer.from(String(sealed?.iv || ''), 'base64url');
  const data = Buffer.from(String(sealed?.data || ''), 'base64url');
  const tag = Buffer.from(String(sealed?.tag || ''), 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || data.length === 0) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function macFor(macKey, platform, sealed) {
  return crypto
    .createHmac('sha256', macKey)
    .update(String(platform), 'utf8')
    .update('\n')
    .update(String(sealed.iv), 'utf8')
    .update('\n')
    .update(String(sealed.data), 'utf8')
    .update('\n')
    .update(String(sealed.tag), 'utf8')
    .digest('hex');
}

function macMatches(macKey, platform, sealed) {
  const given = String(sealed?.mac || '');
  if (!KEY_PATTERN.test(given)) return false;
  const expected = macFor(macKey, platform, sealed);
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(given, 'hex'),
  );
}

function canaryOpens(encKey, canary) {
  if (!canary) return false;
  try {
    const plain = openSeal(encKey, CANARY_AAD, canary);
    return Boolean(plain && plain.equals(CANARY_PLAIN));
  } catch {
    return false;
  }
}

function readStoreText(root) {
  try {
    return {
      text: fs.readFileSync(storeFile(root), 'utf8'),
      missing: false,
      unreadable: false,
    };
  } catch (error) {
    if (error?.code === 'ENOENT')
      return { text: '', missing: true, unreadable: false };
    return { text: '', missing: false, unreadable: true };
  }
}

function readCanary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { iv, data, tag } = value;
  if (
    typeof iv !== 'string' ||
    typeof data !== 'string' ||
    typeof tag !== 'string'
  )
    return null;
  if (!iv || !data || !tag) return null;
  return { iv, data, tag };
}

function parseStore(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.version !== 1
  ) {
    return null;
  }
  const canary = readCanary(parsed.canary);
  if (!canary) return null;
  const accounts =
    parsed.accounts &&
    typeof parsed.accounts === 'object' &&
    !Array.isArray(parsed.accounts)
      ? parsed.accounts
      : {};
  return { canary, accounts };
}

function load(root) {
  const resolved = path.resolve(String(root || ''));
  const keyRead = readKey(resolved);
  const store = readStoreText(resolved);
  if (store.unreadable || keyRead.state === 'invalid')
    return { state: 'locked' };
  if (store.missing && keyRead.state === 'missing')
    return { state: 'empty', root: resolved, key: null };
  if (store.missing && keyRead.state === 'ok') {
    return { state: 'empty', root: resolved, key: keyRead.key };
  }
  if (keyRead.state !== 'ok') return { state: 'locked' };
  const parsed = parseStore(store.text);
  if (!parsed) return { state: 'locked' };
  const keys = derivedKeys(keyRead.key);
  if (!canaryOpens(keys.enc, parsed.canary)) return { state: 'locked' };
  return { state: 'ok', root: resolved, key: keyRead.key, keys, parsed };
}

function openAccount(keys, platform, sealed) {
  if (
    !sealed ||
    typeof sealed !== 'object' ||
    !macMatches(keys.mac, platform, sealed)
  )
    return null;
  let plain;
  try {
    plain = openSeal(keys.enc, accountAad(platform), sealed);
  } catch {
    return null;
  }
  if (!plain) return null;
  let parsed;
  try {
    parsed = JSON.parse(plain.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const userId = typeof parsed.userId === 'string' ? parsed.userId : '';
  const password = typeof parsed.password === 'string' ? parsed.password : '';
  const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
  const login = Boolean(userId && password);
  if (!login && !apiKey) return null;
  return {
    userId: login ? userId : '',
    password: login ? password : '',
    apiKey,
  };
}

function sealCopy(row) {
  if (!row || typeof row !== 'object') return null;
  const { iv, data, tag, mac } = row;
  if ([iv, data, tag, mac].some((part) => typeof part !== 'string' || !part))
    return null;
  return { iv, data, tag, mac };
}

function sealAccount(keys, platform, userId, password, apiKey = '') {
  const row = userId && password ? { userId, password } : {};
  if (apiKey) row.apiKey = apiKey;
  const sealed = seal(
    keys.enc,
    accountAad(platform),
    Buffer.from(JSON.stringify(row), 'utf8'),
  );
  sealed.mac = macFor(keys.mac, platform, sealed);
  return sealed;
}

function writeBody(root, keys, accounts) {
  const ordered = {};
  for (const platform of PLATFORMS) {
    if (accounts[platform]) ordered[platform] = accounts[platform];
  }
  const body = {
    version: 1,
    canary: seal(keys.enc, CANARY_AAD, CANARY_PLAIN),
    accounts: ordered,
  };
  const file = storeFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  replaceCredentialStore(file, `${JSON.stringify(body, null, 2)}\n`);
}

function keptRows(loaded) {
  const accounts = {};
  if (loaded.state !== 'ok') return accounts;
  for (const platform of PLATFORMS) {
    const row = loaded.parsed.accounts[platform];
    if (!row || !openAccount(loaded.keys, platform, row)) continue;
    const copy = sealCopy(row);
    if (copy) accounts[platform] = copy;
  }
  return accounts;
}

function cleanUserId(raw) {
  const userId = String(raw ?? '').trim();
  if (!userId) return { ok: false, error: 'Type the user id.' };
  if (userId.length > USER_ID_MAX)
    return { ok: false, error: 'That user id is too long.' };
  if (
    CONTROL_CHARS.test(userId) ||
    SECRET_PREFIX.test(userId) ||
    SECRET_PATTERN.test(userId)
  ) {
    return { ok: false, error: 'That user id looks like a key.' };
  }
  return { ok: true, userId };
}

function cleanPassword(raw) {
  const password = String(raw ?? '');
  if (!password) return { ok: false, error: 'Type the password.' };
  if (password.length > PASSWORD_MAX || CONTROL_CHARS.test(password)) {
    return { ok: false, error: 'Type the password.' };
  }
  return { ok: true, password };
}

function cleanApiKey(raw) {
  const apiKey = String(raw ?? '').trim();
  if (!apiKey) return { ok: false, error: 'Paste the API key.' };
  if (apiKey.length > API_KEY_MAX || CONTROL_CHARS.test(apiKey)) {
    return { ok: false, error: 'That API key is not valid.' };
  }
  return { ok: true, apiKey };
}

/**
 * Saved logins with the password removed. A store that will not open is locked
 * and returns no rows.
 * @param {string} root
 */
export function listSocialLogins(root) {
  const loaded = load(root);
  if (loaded.state === 'empty')
    return { ok: true, locked: false, accounts: [] };
  if (loaded.state !== 'ok') return { ok: false, locked: true, accounts: [] };
  const accounts = [];
  for (const platform of PLATFORMS) {
    const opened = openAccount(
      loaded.keys,
      platform,
      loaded.parsed.accounts[platform],
    );
    if (!opened) continue;
    accounts.push({
      platform,
      userId: opened.userId,
      passwordSaved: Boolean(opened.password),
      apiKeySaved: Boolean(opened.apiKey),
    });
  }
  return { ok: true, locked: false, accounts };
}

/**
 * The operator's own login for one platform. Local callers only. The HTTP API
 * does not use this.
 * @param {string} root
 * @param {string} platform
 * @returns {{platform: string, userId: string, password: string, apiKey: string}|null}
 */
export function openSocialLogin(root, platform) {
  if (!PLATFORM_SET.has(platform)) return null;
  const loaded = load(root);
  if (loaded.state !== 'ok') return null;
  const opened = openAccount(
    loaded.keys,
    platform,
    loaded.parsed.accounts[platform],
  );
  if (!opened) return null;
  return {
    platform,
    userId: opened.userId,
    password: opened.password,
    apiKey: opened.apiKey,
  };
}

/**
 * @param {string} root
 * Saves a login, an API key, or both (`mode`: 'login', 'api' or 'both', the
 * default). What is not given this time is kept from the saved row.
 * @param {{platform?: unknown, userId?: unknown, password?: unknown, apiKey?: unknown, mode?: unknown}} input
 */
export function saveSocialLogin(root, input) {
  const platform = String(input?.platform || '');
  if (!PLATFORM_SET.has(platform))
    return { ok: false, error: 'Pick a platform.' };
  // Without a stated mode, what was sent says: a key alone, a login alone, or both.
  const sentKey = String(input?.apiKey ?? '').trim() !== '';
  const sentLogin = String(input?.password ?? '') !== '';
  const inferred = sentKey && sentLogin ? 'both' : sentKey ? 'api' : 'login';
  const mode = ['login', 'api', 'both'].includes(input?.mode)
    ? input.mode
    : inferred;
  const offersApi = Boolean(
    SOCIAL_ACCOUNT_PLATFORMS.find((item) => item.id === platform)?.api,
  );
  if (mode !== 'login' && !offersApi)
    return { ok: false, error: 'This platform has no API key to save.' };
  let userId = null;
  let password = null;
  if (mode !== 'api') {
    userId = cleanUserId(input?.userId);
    if (!userId.ok) return userId;
    password = cleanPassword(input?.password);
    if (!password.ok) return password;
  }
  let apiKey = null;
  if (mode !== 'login') {
    apiKey = cleanApiKey(input?.apiKey);
    if (!apiKey.ok) return apiKey;
  }
  const loaded = load(root);
  if (loaded.state === 'locked')
    return { ok: false, error: SOCIAL_LOGIN_LOCKED };
  const keyRead = loaded.key
    ? { key: loaded.key, state: 'ok' }
    : ensureKey(loaded.root);
  if (keyRead.state !== 'ok' || !keyRead.key)
    return { ok: false, error: SOCIAL_LOGIN_LOCKED };
  const keys = derivedKeys(keyRead.key);
  const accounts = keptRows(
    loaded.state === 'ok' ? loaded : { state: 'empty' },
  );
  const before =
    loaded.state === 'ok'
      ? openAccount(loaded.keys, platform, loaded.parsed.accounts[platform])
      : null;
  const nextUser = userId ? userId.userId : before?.userId || '';
  const nextPass = password ? password.password : before?.password || '';
  const nextKey = apiKey ? apiKey.apiKey : before?.apiKey || '';
  accounts[platform] = sealAccount(keys, platform, nextUser, nextPass, nextKey);
  writeBody(loaded.root, keys, accounts);
  return {
    ok: true,
    platform,
    userId: nextUser,
    passwordSaved: Boolean(nextUser && nextPass),
    apiKeySaved: Boolean(nextKey),
  };
}

/**
 * @param {string} root
 * @param {string} platform
 */
export function removeSocialLogin(root, platform) {
  if (!PLATFORM_SET.has(platform))
    return { ok: false, error: 'Pick a platform.' };
  const loaded = load(root);
  if (loaded.state === 'locked')
    return { ok: false, error: SOCIAL_LOGIN_LOCKED };
  if (loaded.state === 'empty') return { ok: true, platform };
  const accounts = keptRows(loaded);
  delete accounts[platform];
  writeBody(loaded.root, loaded.keys, accounts);
  return { ok: true, platform };
}
