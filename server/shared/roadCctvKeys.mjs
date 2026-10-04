/**
 * Generic road CCTV API keys: as many as the owner adds, each for one camera
 * site (a host such as 511ny.org) and sent to it as one query parameter.
 *
 * config/road-cctv-keys.json is git-ignored and written owner-only. A key
 * never leaves this computer except to its own site, over https, when the CCTV
 * layer asks that site for a picture; the setup route lists only its last
 * four characters.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { replaceCredentialStore } from './keySetupHardening.mjs';

export const ROAD_CCTV_KEYS_FILE = path.join('config', 'road-cctv-keys.json');
export const ROAD_CCTV_DEFAULT_PARAM = 'key';
const LABEL_MAX = 60;
const KEY_MAX = 512;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const HOST_PATTERN =
  /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const PARAM_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

const fileOf = (root) => path.join(root, ROAD_CCTV_KEYS_FILE);

/** A camera site as typed: a bare host, or an address whose host is taken. */
export function normalizeRoadHost(raw) {
  let text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
    try {
      text = new URL(text).hostname;
    } catch {
      return '';
    }
  }
  text = text.replace(/^www\./, '').replace(/\.$/, '');
  return HOST_PATTERN.test(text) ? text : '';
}

/**
 * One entry cleaned up, or why it cannot be kept.
 * @returns {{ok: true, value: {label: string, host: string, param: string, apiKey: string}} | {ok: false, error: string}}
 */
export function normalizeRoadCctvKey(input) {
  const host = normalizeRoadHost(input?.host);
  if (!host)
    return { ok: false, error: 'Type the camera site, for example 511ny.org.' };
  const label =
    String(input?.label ?? '')
      .replace(/\s+/g, ' ')
      .trim() || host;
  if (label.length > LABEL_MAX || CONTROL_CHARS.test(label))
    return { ok: false, error: 'That name is too long.' };
  const param = String(input?.param ?? '').trim() || ROAD_CCTV_DEFAULT_PARAM;
  if (!PARAM_PATTERN.test(param))
    return {
      ok: false,
      error: 'The key parameter is letters, digits, - or _.',
    };
  const apiKey = String(input?.apiKey ?? '').trim();
  if (!apiKey) return { ok: false, error: 'Paste the API key.' };
  if (apiKey.length > KEY_MAX || CONTROL_CHARS.test(apiKey))
    return { ok: false, error: 'That API key is not valid.' };
  return { ok: true, value: { label, host, param, apiKey } };
}

let cache = { stamp: '', keys: [] };

/** Every saved entry, read again only when the file changes. A broken file holds none. */
export function readRoadCctvKeys(root = process.cwd()) {
  const file = fileOf(root);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = { stamp: '', keys: [] };
    return [];
  }
  const stamp = `${file}|${stat.mtimeMs}|${stat.size}`;
  if (cache.stamp === stamp) return cache.keys;
  let keys = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const row of Array.isArray(parsed?.keys) ? parsed.keys : []) {
      const checked = normalizeRoadCctvKey(row);
      if (
        checked.ok &&
        typeof row.id === 'string' &&
        /^[a-f0-9]{16}$/.test(row.id)
      )
        keys.push({ id: row.id, ...checked.value });
    }
  } catch {
    keys = [];
  }
  cache = { stamp, keys };
  return keys;
}

function writeKeys(root, keys) {
  const file = fileOf(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  replaceCredentialStore(
    file,
    `${JSON.stringify({ version: 1, keys }, null, 2)}\n`,
  );
  cache = { stamp: '', keys: [] };
}

/** The list the setup dialog shows: never the key, only its last four characters. */
export function listRoadCctvKeys(root = process.cwd()) {
  return readRoadCctvKeys(root).map(({ id, label, host, param, apiKey }) => ({
    id,
    label,
    host,
    param,
    keyEnd: apiKey.length > 8 ? apiKey.slice(-4) : '',
  }));
}

/**
 * Adds an entry, or replaces the one with this id. There is no limit on how
 * many. Editing a saved entry with the key box left empty keeps its key, the
 * way every other POWER UP row reads "saved — paste to replace".
 */
export function saveRoadCctvKey(root, input) {
  const keys = [...readRoadCctvKeys(root)];
  const saved =
    typeof input?.id === 'string'
      ? keys.find((row) => row.id === input.id)
      : null;
  const typedKey = String(input?.apiKey ?? '').trim();
  const checked = normalizeRoadCctvKey(
    saved && !typedKey ? { ...input, apiKey: saved.apiKey } : input,
  );
  if (!checked.ok) return checked;
  const id =
    typeof input?.id === 'string' && keys.some((row) => row.id === input.id)
      ? input.id
      : crypto.randomBytes(8).toString('hex');
  const index = keys.findIndex((row) => row.id === id);
  const row = { id, ...checked.value };
  if (index >= 0) keys[index] = row;
  else keys.push(row);
  writeKeys(root, keys);
  return { ok: true, id };
}

export function removeRoadCctvKey(root, id) {
  const keys = readRoadCctvKeys(root);
  if (!keys.some((row) => row.id === id))
    return { ok: false, error: 'No such key.' };
  writeKeys(
    root,
    keys.filter((row) => row.id !== id),
  );
  return { ok: true, id };
}

/**
 * A camera address with its site's key added, or the address unchanged. Only
 * an https address gets a key, never one that already carries that parameter,
 * and only on its own site or that site's subdomains.
 */
export function withRoadCctvKey(url, keys) {
  const list = Array.isArray(keys) ? keys : [];
  if (!list.length) return url;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return url;
  }
  if (parsed.protocol !== 'https:') return url;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const entry = list.find(
    (row) => host === row.host || host.endsWith(`.${row.host}`),
  );
  if (!entry || parsed.searchParams.has(entry.param)) return url;
  parsed.searchParams.set(entry.param, entry.apiKey);
  return parsed.href;
}

/**
 * The camera sites a key can be saved for: every https host in the loaded
 * camera catalogue, with how many cameras each serves, most cameras first.
 * The owner picks one instead of typing an address. Pure.
 * @param {Iterable<{url?: string, snapshotUrl?: string}>} sources
 * @returns {Array<{host: string, cameras: number}>}
 */
export function roadCctvSitesFrom(sources) {
  const counts = new Map();
  for (const source of sources || []) {
    const raw = String(source?.snapshotUrl || source?.url || '');
    if (!raw.startsWith('https://')) continue;
    const host = normalizeRoadHost(raw);
    if (host) counts.set(host, (counts.get(host) || 0) + 1);
  }
  return [...counts]
    .map(([host, cameras]) => ({ host, cameras }))
    .sort((a, b) => b.cameras - a.cameras || a.host.localeCompare(b.host));
}
