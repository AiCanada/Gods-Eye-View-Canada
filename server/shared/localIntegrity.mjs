/**
 * Checks for the owner's cameras, tracked devices, the address a phone is
 * told to report to, the camera site file, and provider keys.
 *
 * config/local-integrity.key is this machine's key (64 hex). config/local-integrity.json
 * holds a canary sealed under that key and one check per section. A check is
 * written only when the owner saves that section. No file yet is trusted.
 * Sections are independent: a missing check beside one that is present is
 * still an older setting, and it is trusted.
 *
 * A canary that will not open (the key was replaced, or the canary was
 * removed) is trusted. An unreadable file is not overwritten on read, and
 * it is not used while the key is valid. The file holds checks only: never
 * an address, a password, or an API key.
 *
 * Provider checks do nothing until bindLocalIntegrityRoot names a checkout,
 * so a unit test that only sets process.env keeps using that value.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { replaceCredentialStore } from './keySetupHardening.mjs';

const KEY_PATTERN = /^[0-9a-f]{64}$/;
const CANARY_AAD = Buffer.from('local-integrity-canary');
const CANARY_PLAIN = Buffer.from('v1');

export const LOCAL_PROVIDER_CHANGED_MESSAGE =
  'This provider key was changed and is not being used. Save it again from POWER UP.';

/** Env names whose saved value, and where it is sent, a check covers. Trimmed. */
const PROVIDER_FIELDS = Object.freeze({
  google: Object.freeze(['GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_SERVER_API_KEY']),
  cesium: Object.freeze(['CESIUM_ION_TOKEN']),
  openai: Object.freeze(['OPENAI_API_KEY']),
  ais: Object.freeze(['AISSTREAM_API_KEY', 'AISSTREAM_URL']),
  firms: Object.freeze(['FIRMS_MAP_KEY']),
  tomtom: Object.freeze(['TOMTOM_API_KEY']),
  opensky: Object.freeze([
    'OPENSKY_CLIENT_ID',
    'OPENSKY_CLIENT_SECRET',
    'OPENSKY_USERNAME',
    'OPENSKY_PASSWORD',
    'OPENSKY_AUTH_MODE',
  ]),
  launch: Object.freeze(['LL2_API_TOKEN']),
  earthdata: Object.freeze(['EARTHDATA_TOKEN']),
  road511: Object.freeze(['ROAD511_API_KEY']),
  nvidia: Object.freeze(['NVIDIA_API_KEY', 'NVIDIA_BASE_URL', 'NVIDIA_MODEL']),
  xai: Object.freeze(['XAI_API_KEY', 'XAI_BASE_URL', 'XAI_MODEL']),
  openrouter: Object.freeze([
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'OPENROUTER_MODEL',
  ]),
  anthropic: Object.freeze([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
  ]),
  customLlm: Object.freeze([
    'CUSTOM_LLM_API_KEY',
    'CUSTOM_LLM_BASE_URL',
    'CUSTOM_LLM_MODEL',
  ]),
  // The Social Media bot swarms' own keys, and where Grok Bot's task goes
  // without one: a changed webhook address would carry its key elsewhere.
  grokBot: Object.freeze(['GROK_BOT_API_KEY', 'XAI_SWARM_MODEL']),
  grokBotWebhook: Object.freeze([
    'GROK_BOT_WEBHOOK_URL',
    'GROK_BOT_WEBHOOK_KEY',
  ]),
  openaiDots: Object.freeze(['OPENAI_DOTS_API_KEY', 'OPENAI_SWARM_MODEL']),
});

const RECORD_SECTIONS = new Set([
  'cameras',
  'devices',
  'listener',
  'vendorFeed',
]);
const SECTION_ORDER = Object.freeze([
  'cameras',
  'devices',
  'listener',
  'vendorFeed',
  ...Object.keys(PROVIDER_FIELDS),
]);
const SECTION_WARN = Object.freeze({
  listener: 'report address',
  vendorFeed: 'camera site',
});
/** What the report card is allowed to show, and which certificate files it may load. */
const LISTENER_BASE = /^https?:\/\/[^/\s?#]+$/;
const SECTIONS = new Set(SECTION_ORDER);

const ENV_SECTION = new Map();
for (const [section, fields] of Object.entries(PROVIDER_FIELDS)) {
  for (const name of fields) {
    if (ENV_SECTION.has(name)) {
      throw new Error(`local integrity: ${name} is listed twice`);
    }
    ENV_SECTION.set(name, section);
  }
}

const DEVICE_FIELDS = Object.freeze([
  'id',
  'name',
  'method',
  'reportKey',
  'url',
  'pictureUrl',
  'auth',
  'username',
  'password',
  'token',
  'keyName',
]);

let boundRoot = '';
let storeCache = null;
let storeWarned = false;
const sectionWarned = new Set();

const storeFile = (root) => path.join(root, 'config', 'local-integrity.json');
const keyFile = (root) => path.join(root, 'config', 'local-integrity.key');

/** Name the checkout whose provider keys are checked. An empty root stops checking. */
export function bindLocalIntegrityRoot(root) {
  boundRoot = root ? path.resolve(String(root)) : '';
}

/** Ask's provider id, as a section name. `custom` is stored as customLlm. */
export function localLlmSection(providerId) {
  if (providerId === 'custom') return 'customLlm';
  return Object.hasOwn(PROVIDER_FIELDS, providerId) ? providerId : '';
}

function policyText(value) {
  const text = String(value ?? '');
  return `${Buffer.byteLength(text, 'utf8')}:${text}`;
}

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

function macField(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' && KEY_PATTERN.test(value) ? value : 'bad';
}

function readCanary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { iv, data, tag } = value;
  if (
    typeof iv !== 'string' ||
    typeof data !== 'string' ||
    typeof tag !== 'string' ||
    !iv ||
    !data ||
    !tag
  ) {
    return null;
  }
  return { iv, data, tag };
}

function emptyView(missing, unreadable) {
  return { missing, unreadable, canary: null, macs: {} };
}

function readStore(root) {
  const resolved = path.resolve(String(root || ''));
  const file = storeFile(resolved);
  let text = null;
  let missing = false;
  let unreadable = false;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') missing = true;
    else unreadable = true;
  }
  if (
    storeCache &&
    storeCache.root === resolved &&
    storeCache.text === text &&
    storeCache.missing === missing &&
    storeCache.unreadable === unreadable
  ) {
    return storeCache.view;
  }
  let view;
  if (missing) {
    view = emptyView(true, false);
    storeWarned = false;
  } else if (unreadable) {
    view = emptyView(false, true);
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      parsed.version !== 1
    ) {
      view = emptyView(false, true);
    } else {
      const macs = {};
      for (const section of SECTION_ORDER)
        macs[section] = macField(parsed[`${section}Mac`]);
      view = {
        missing: false,
        unreadable: false,
        canary: readCanary(parsed.canary),
        macs,
      };
      storeWarned = false;
    }
  }
  if (view.unreadable && !storeWarned) {
    storeWarned = true;
    console.warn(
      '[Local integrity] config/local-integrity.json could not be read',
    );
  }
  storeCache = { root: resolved, text, missing, unreadable, view };
  return view;
}

function writeStore(root, body) {
  const file = storeFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  replaceCredentialStore(file, `${JSON.stringify(body, null, 2)}\n`);
  storeCache = null;
}

function sealCanary(key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(CANARY_AAD);
  const data = Buffer.concat([cipher.update(CANARY_PLAIN), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64url'),
    data: data.toString('base64url'),
    tag: tag.toString('base64url'),
  };
}

function canaryOpens(canary, key) {
  if (!canary || !Buffer.isBuffer(key) || key.length !== 32) return false;
  try {
    const iv = Buffer.from(canary.iv, 'base64url');
    const data = Buffer.from(canary.data, 'base64url');
    const tag = Buffer.from(canary.tag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || data.length === 0)
      return false;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(CANARY_AAD);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.equals(CANARY_PLAIN);
  } catch {
    return false;
  }
}

function cameraLines(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const lines = [String(list.length)];
  for (const site of list) {
    lines.push(
      policyText(site?.id),
      policyText(site?.kind),
      policyText(site?.auth),
      policyText(site?.bridgeUrl),
      policyText(site?.token),
      policyText(site?.username),
      policyText(site?.password),
      policyText(site?.tlsFingerprint),
      policyText(site?.relayExtensionId),
      policyText(site?.relaySecretHash),
    );
    const cameras = Array.isArray(site?.cameras) ? site.cameras : [];
    lines.push(String(cameras.length));
    for (const camera of cameras) {
      lines.push(policyText(camera?.id), policyText(camera?.source));
    }
  }
  return lines;
}

function deviceLines(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const lines = [String(list.length)];
  for (const feed of list) {
    for (const field of DEVICE_FIELDS) lines.push(policyText(feed?.[field]));
  }
  return lines;
}

/**
 * The report address, public name, and certificate paths as the listener
 * uses them. An address that is not a plain http(s) origin counts as none.
 * The port and the interface are not part of this check.
 */
export function listenerPolicyParts(env = process.env) {
  const source = env || {};
  const raw = String(source.DEVICE_REPORT_PUBLIC_BASE || '')
    .trim()
    .replace(/\/+$/, '');
  return {
    publicBase: LISTENER_BASE.test(raw) ? raw : '',
    publicHost: String(source.DEVICE_REPORT_PUBLIC_HOST || '').trim(),
    tlsCert: String(source.DEVICE_REPORT_TLS_CERT || '').trim(),
    tlsKey: String(source.DEVICE_REPORT_TLS_KEY || '').trim(),
  };
}

/** The camera site file as the server parsed it. Hosts stay in that order. */
export function vendorFeedPolicyParts(parsed) {
  const hosts = Array.isArray(parsed?.imageHosts) ? parsed.imageHosts : [];
  const suffixes = Array.isArray(parsed?.cloudHostSuffixes)
    ? parsed.cloudHostSuffixes
    : [];
  return {
    feedUrl: String(parsed?.feedUrl || '').trim(),
    imageHosts: hosts.map((host) => String(host || '').trim()),
    cloudHostSuffixes: suffixes.map((host) => String(host || '').trim()),
  };
}

function listenerLines(parts) {
  return [
    policyText(parts?.publicBase),
    policyText(parts?.publicHost),
    policyText(parts?.tlsCert),
    policyText(parts?.tlsKey),
  ];
}

function vendorFeedLines(parts) {
  const hosts = Array.isArray(parts?.imageHosts) ? parts.imageHosts : [];
  const suffixes = Array.isArray(parts?.cloudHostSuffixes)
    ? parts.cloudHostSuffixes
    : [];
  return [
    policyText(parts?.feedUrl),
    String(hosts.length),
    ...hosts.map((host) => policyText(host)),
    String(suffixes.length),
    ...suffixes.map((host) => policyText(host)),
  ];
}

function providerLines(section, parts) {
  const fields = PROVIDER_FIELDS[section];
  if (!fields) return null;
  return fields.map((name) => policyText(String(parts?.[name] ?? '').trim()));
}

function sectionLines(section, parts) {
  if (section === 'cameras') return cameraLines(parts);
  if (section === 'devices') return deviceLines(parts);
  if (section === 'listener') return listenerLines(parts);
  if (section === 'vendorFeed') return vendorFeedLines(parts);
  return providerLines(section, parts);
}

function sectionTag(section) {
  return RECORD_SECTIONS.has(section)
    ? `local-${section}:v1`
    : `local-provider:${section}:v1`;
}

function macFor(section, parts, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return '';
  const lines = sectionLines(section, parts);
  if (!lines) return '';
  return crypto
    .createHmac('sha256', key)
    .update([sectionTag(section), ...lines].join('\n'), 'utf8')
    .digest('hex');
}

function macMatches(stored, expected) {
  if (typeof stored !== 'string' || typeof expected !== 'string') return false;
  if (!KEY_PATTERN.test(stored) || !KEY_PATTERN.test(expected)) return false;
  return crypto.timingSafeEqual(
    Buffer.from(stored, 'hex'),
    Buffer.from(expected, 'hex'),
  );
}

function warnSection(section) {
  if (sectionWarned.has(section)) return;
  sectionWarned.add(section);
  console.warn(
    `[Local integrity] ${SECTION_WARN[section] || section} was changed and is not being used`,
  );
}

function providerParts(section, env) {
  const fields = PROVIDER_FIELDS[section];
  if (!fields) return null;
  const parts = {};
  for (const name of fields) parts[name] = String(env?.[name] ?? '').trim();
  return parts;
}

/**
 * Whether this section's parts still match the check at root.
 * Reading never creates the key or the file.
 */
export function localRecordsTrusted(root, section, parts) {
  if (!SECTIONS.has(section)) return true;
  try {
    const resolved = path.resolve(String(root || ''));
    const view = readStore(resolved);
    const read = readKey(resolved);
    const keyOk = read.state === 'ok';
    if (view.missing || !keyOk) return true;
    if (view.unreadable || !canaryOpens(view.canary, read.key)) {
      if (view.unreadable) {
        warnSection(section);
        return false;
      }
      return true;
    }
    const stored = view.macs[section];
    if (!stored) return true;
    if (macMatches(stored, macFor(section, parts, read.key))) return true;
    warnSection(section);
    return false;
  } catch {
    warnSection(section);
    return false;
  }
}

/** Whether a provider section may still be used. Unbound, or an unknown section, is trusted. */
export function localProviderTrusted(section, env = process.env) {
  if (!section || !PROVIDER_FIELDS[section] || !boundRoot) return true;
  return localRecordsTrusted(boundRoot, section, providerParts(section, env));
}

/**
 * The env value when the section is still trusted. Unset stays unset.
 * A section that was changed comes back blank.
 */
export function localClientCredential(section, name, env = process.env) {
  if (!localProviderTrusted(section, env)) return '';
  const value = env?.[name];
  if (value === undefined) return undefined;
  return String(value);
}

/**
 * Write the checks for the sections the owner just saved. One write.
 * A section that was not saved keeps its check, including one that no
 * longer matches. A missing key file is created here, never on a read.
 * An invalid key file is left as it is, and that save writes no new check.
 * Nothing is written when that would only create an empty file.
 */
function writeChecks(root, updates) {
  const resolved = path.resolve(String(root || ''));
  const view = readStore(resolved);
  let read = readKey(resolved);
  if (read.state === 'missing') read = ensureKey(resolved);
  const keyOk = read.state === 'ok';
  const macs = {};
  if (!view.unreadable) {
    for (const section of SECTION_ORDER) {
      if (view.macs[section]) macs[section] = view.macs[section];
    }
  }
  for (const [section, parts] of Object.entries(updates)) {
    if (!SECTIONS.has(section)) continue;
    macs[section] = keyOk
      ? macFor(section, parts, read.key) || undefined
      : undefined;
  }
  const anyMac = SECTION_ORDER.some((section) => macs[section]);
  const keepCanary = Boolean(!keyOk && !view.unreadable && view.canary);
  if (!keyOk && !anyMac && !keepCanary && view.missing) return;
  const body = { version: 1 };
  if (keyOk) body.canary = sealCanary(read.key);
  else if (keepCanary) body.canary = view.canary;
  for (const section of SECTION_ORDER) {
    if (macs[section]) body[`${section}Mac`] = macs[section];
  }
  writeStore(resolved, body);
}

/** After a camera or device save. `parts` is the list just written. */
export function noteLocalRecordsSaved(root, section, parts) {
  if (!SECTIONS.has(section)) return;
  writeChecks(root, { [section]: parts });
}

/**
 * After a device save. Stamps the other devices and the report address the
 * process is using now, in one write. An empty device list is still stamped.
 */
export function noteLocalDevicesSaved(root, deviceParts, env = process.env) {
  writeChecks(root, {
    devices: deviceParts,
    listener: listenerPolicyParts(env),
  });
}

/**
 * After a camera save. Stamps the cameras and the camera site file as it
 * parses now, in one write.
 */
export function noteLocalCamerasSaved(root, cameraParts, feedParts) {
  writeChecks(root, {
    cameras: cameraParts,
    vendorFeed: vendorFeedPolicyParts(feedParts),
  });
}

/**
 * After a POWER UP save. Only names that belong to a provider section are
 * stamped, from the env as it stands now. Any other name writes nothing.
 */
export function noteLocalProvidersSaved(names, root) {
  const updates = {};
  for (const name of Array.isArray(names) ? names : []) {
    const section = ENV_SECTION.get(name);
    if (section) updates[section] = providerParts(section, process.env);
  }
  if (Object.keys(updates).length === 0) return;
  writeChecks(root, updates);
}
