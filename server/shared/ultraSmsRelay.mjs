/**
 * Ultra Security Package SMS relay: the pure rules.
 * A relay turns a call for help into a real text message: to the owner's
 * own cell when someone in the home list presses SEND HELP, and to the
 * PREDEFINED HELP # numbers when the owner does. Every message costs the
 * owner money at the provider's rate (Twilio's, or their own gateway's).
 * That is why nothing is sent unless the keys are present in the
 * environment the caller hands in at call time, why every send passes the
 * ledger here first (a ten-minute re-notify cooldown per key, fifty a day
 * with the last twenty kept for the owner's own call, sixty an hour per
 * provider host, one test per ten minutes) and why the
 * day's count is shown in the box. Secrets travel only inside the request
 * this module builds, to api.twilio.com or the configured gateway, and are
 * never echoed: the public shape carries a provider word and a host. Only
 * an E.164 number is ever addressed (911 and 112 stay on the phone card; a
 * relay cannot text them). No fetch, no environment read and nothing from
 * Buffer or node:crypto happens at import time; the caller passes the
 * environment and the clock.
 */
import {
  ULTRA_HELP_CONTACT_LIMIT,
  normalizeUltraNumber,
} from '../../src/ultraHelp.mjs';
import { cleanHelpText } from './ultraTokens.mjs';

export const ULTRA_SMS_BODY_LIMIT = 320;
export const ULTRA_SMS_RENOTIFY_MS = 600_000;
export const ULTRA_SMS_DAILY_LIMIT = 50;
/**
 * How much of the day's allowance, and of a provider host's hour, only the
 * owner's own call for help may spend: a whole PREDEFINED HELP # list, so
 * peer notices (and TEST SMS) stop at thirty a day and forty a host-hour,
 * and a busy home list can never be the reason any of the owner's own saved
 * helpers goes untexted, even across midnight.
 */
export const ULTRA_SMS_OWN_RESERVE = ULTRA_HELP_CONTACT_LIMIT;
export const ULTRA_SMS_TEST_MS = 600_000;
/** How soon a number whose text failed may be tried again under the same key. */
export const ULTRA_SMS_RETRY_MS = 60_000;
export const ULTRA_SMS_TIMEOUT_MS = 8_000;
export const ULTRA_SMS_HOST_LIMIT = Object.freeze({
  max: 60,
  windowMs: 3_600_000,
});
export const ULTRA_SMS_TEST_TEXT =
  'GEVC Ultra test: this phone receives help network alerts.';
/** The words the owner's status shows before an outcome exists. */
export const ULTRA_SMS_NO_RELAY = 'NO SMS RELAY';
export const ULTRA_SMS_SENDING = 'SENDING';
/**
 * A call reloaded from the file after a full restart: what its texts did
 * was memory only, so the line says it does not know rather than SENDING.
 */
export const ULTRA_SMS_UNKNOWN = 'SMS: NOT KNOWN SINCE RESTART';
/** A peer's call for help with a relay set up but no SAVE MY # to text. */
export const ULTRA_SMS_NO_NUMBER = 'NO SMS: SAVE MY # FIRST';
export const ULTRA_SMS_TWILIO_HOST = 'api.twilio.com';
export const ULTRA_SMS_USER_AGENT = 'gods-eye-view-ultra/0.2 (help network)';

const NAME_LIMIT = 60;
const PLEA_LIMIT = 500;
const RELAY_URL_LIMIT = 2048;
const LEDGER_KEY_CAP = 1000;
// A Twilio account SID is 'AC' plus 32 hex; anything alphanumeric is
// accepted so a subaccount or a test fixture works, and it is still safe
// to place in the API path.
const SID_PATTERN = /^[A-Za-z0-9]{2,64}$/;
// Printable ASCII with no whitespace: what the key-setup route saves.
const SECRET_PATTERN = /^[\x21-\x7e]{1,512}$/;
// A provider failure code: Twilio's digits or a gateway's short word,
// never a sentence (an answer body can quote request content).
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function envText(env, name) {
  const value = env && typeof env === 'object' ? env[name] : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Whether a hostname is an IPv4 literal in 100.64.0.0/10, the range Tailscale hands out. */
function tailnetLiteral(hostname) {
  const m = IPV4_PATTERN.exec(String(hostname ?? ''));
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (!octets.every((o) => o <= 255)) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/** The gateway URL when the relay may post to it: https anywhere, or http to a 100.64.0.0/10 literal, never with userinfo. */
function relayUrl(raw) {
  if (!raw || raw.length > RELAY_URL_LIMIT) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && tailnetLiteral(url.hostname)) return url;
  return null;
}

function twilioKeys(env) {
  const sid = envText(env, 'TWILIO_ACCOUNT_SID');
  const auth = envText(env, 'TWILIO_AUTH_TOKEN');
  const from = normalizeUltraNumber(envText(env, 'TWILIO_FROM_NUMBER'));
  if (!SID_PATTERN.test(sid) || !SECRET_PATTERN.test(auth) || !from)
    return null;
  return { sid, auth, from };
}

function gatewayKeys(env) {
  const url = relayUrl(envText(env, 'ULTRA_SMS_RELAY_URL'));
  const token = envText(env, 'ULTRA_SMS_RELAY_TOKEN');
  if (!url || !SECRET_PATTERN.test(token)) return null;
  return { url, token };
}

/**
 * Which relay the environment configures, with no secret in it: Twilio
 * when the account SID, the auth token and an E.164 from-number are all
 * set (it wins when both recipes are), the generic gateway when its URL
 * (https, or http to a 100.64.0.0/10 literal) and bearer token are set,
 * else nothing. Read from the environment at call time so a save from the
 * box applies at once.
 */
export function ultraSmsRelayConfig(env) {
  if (twilioKeys(env)) {
    return {
      provider: 'twilio',
      host: ULTRA_SMS_TWILIO_HOST,
      configured: true,
    };
  }
  const gateway = gatewayKeys(env);
  if (gateway) {
    return { provider: 'generic', host: gateway.url.host, configured: true };
  }
  return { provider: '', host: '', configured: false };
}

/**
 * The relay values a check covers, including a gateway that is saved while
 * Twilio is the one in use. A field the relay would not use is empty, so
 * two unusable values compare the same and a usable one does not.
 */
export function ultraSmsRelayMaterial(env) {
  const twilio = twilioKeys(env);
  const gateway = gatewayKeys(env);
  return {
    sid: twilio?.sid || '',
    auth: twilio?.auth || '',
    from: twilio?.from || '',
    url: gateway?.url?.href || '',
    token: gateway?.token || '',
  };
}

/** What the owner's status carries about the relay: a provider word, whether it is configured and the host. Never a value from the environment. */
export function ultraSmsRelayPublic(config) {
  const c = config && typeof config === 'object' ? config : {};
  return {
    provider:
      c.provider === 'twilio' || c.provider === 'generic' ? c.provider : '',
    configured: c.configured === true,
    host: typeof c.host === 'string' ? c.host : '',
  };
}

/**
 * The text of a relayed call for help: the cleaned peer name in capitals,
 * NEEDS HELP, and the plea composed on this machine, cut at 320
 * characters (two SMS segments) so a long address cannot run up the bill.
 * No peer string other than the cleaned name ever reaches the body.
 */
export function ultraSmsRelayBody(name, plea) {
  const who = (cleanHelpText(name, NAME_LIMIT) || 'Someone').toUpperCase();
  const text = cleanHelpText(plea, PLEA_LIMIT);
  return `${who} NEEDS HELP: ${text}`.slice(0, ULTRA_SMS_BODY_LIMIT);
}

/**
 * The one request a send makes, or null when nothing may be sent: no
 * relay configured, the configured provider is not the one `config`
 * names, `to` is not an E.164 number (911 and 112 included) or the body
 * is empty. Twilio is a form POST to the Messages resource under Basic
 * auth; the gateway is a JSON POST { to, body } under a bearer token. Both
 * refuse redirects (a secret must not follow a Location header elsewhere)
 * and time out after eight seconds. The caller fires it and forgets it.
 */
export function ultraSmsRelayRequest(config, env, { to, body } = {}) {
  const relay = ultraSmsRelayConfig(env);
  if (!relay.configured) return null;
  const wanted =
    config && typeof config === 'object' && config.provider
      ? config.provider
      : relay.provider;
  if (wanted !== relay.provider) return null;
  const number = normalizeUltraNumber(to);
  const text = cleanHelpText(body, ULTRA_SMS_BODY_LIMIT);
  if (!number || !text) return null;
  const signal = AbortSignal.timeout(ULTRA_SMS_TIMEOUT_MS);
  if (relay.provider === 'twilio') {
    const { sid, auth, from } = twilioKeys(env);
    const basic = Buffer.from(`${sid}:${auth}`, 'utf8').toString('base64');
    return {
      url: `https://${ULTRA_SMS_TWILIO_HOST}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      init: {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + basic,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': ULTRA_SMS_USER_AGENT,
        },
        body: new URLSearchParams({
          To: number,
          From: from,
          Body: text,
        }).toString(),
        redirect: 'error',
        signal,
      },
    };
  }
  const { url, token } = gatewayKeys(env);
  return {
    url: url.href,
    init: {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': ULTRA_SMS_USER_AGENT,
      },
      body: JSON.stringify({ to: number, body: text }),
      redirect: 'error',
      signal,
    },
  };
}

/** An empty ledger: last send per key, the day's count, the hits per provider host and the last test. Memory only; the day is compared, not the process. */
export function newUltraSmsLedger() {
  return {
    byEntry: new Map(),
    day: { date: '', count: 0 },
    byHost: new Map(),
    lastTestAt: null,
  };
}

/** The ledger with every field present, filled in place when the caller's object lacks one. */
function ledgerOf(ledger) {
  const book = ledger && typeof ledger === 'object' ? ledger : {};
  if (!(book.byEntry instanceof Map)) book.byEntry = new Map();
  if (!(book.byHost instanceof Map)) book.byHost = new Map();
  if (!book.day || typeof book.day !== 'object')
    book.day = { date: '', count: 0 };
  if (!('lastTestAt' in book)) book.lastTestAt = null;
  return book;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** The calendar day on this machine's clock: the owner's day, not UTC's. */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** HH:MM on this machine's clock, as the rows paint it. */
function clockTime(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Whether one message may go out now, and if so it is recorded: a peer
 * or own send waits ten minutes after the last one under the same key (a
 * home-list entry, or the owner's press and recipient), a test waits ten
 * minutes after the last test, at most fifty messages leave in a calendar
 * day and sixty reach one provider host in an hour (a peer notice or a test
 * stops short of both by ULTRA_SMS_OWN_RESERVE). The reason names the
 * first rule that refused; a refusal records nothing. A send that then
 * fails shortens its per-key cooldown through `ultraSmsRelayForget`.
 */
export function ultraSmsRelayAllowed(
  ledger,
  { kind, key, host, now = Date.now() } = {},
) {
  const book = ledgerOf(ledger);
  const at = finiteOrNull(now) ?? Date.now();
  const test = kind === 'test';
  const id = String(key ?? '');
  const hostKey = String(host ?? '')
    .trim()
    .toLowerCase();
  if (test) {
    const last = finiteOrNull(book.lastTestAt);
    if (last !== null && at - last < ULTRA_SMS_TEST_MS)
      return { ok: false, reason: 'test' };
  } else {
    const last = finiteOrNull(book.byEntry.get(id));
    if (last !== null && at - last < ULTRA_SMS_RENOTIFY_MS)
      return { ok: false, reason: 'cooldown' };
  }
  const today = dayKey(at);
  const count = book.day.date === today ? Number(book.day.count) || 0 : 0;
  // The owner's own call for help keeps a reserve of the day's allowance:
  // a chatty peer network must never be the reason their own helpers are
  // not texted. Peer notices stop at the reserve; 'own' runs to the cap.
  const ceiling =
    kind === 'own'
      ? ULTRA_SMS_DAILY_LIMIT
      : ULTRA_SMS_DAILY_LIMIT - ULTRA_SMS_OWN_RESERVE;
  if (count >= ceiling) return { ok: false, reason: 'daily' };
  // The same reserve in the host's hour: the day's count starts again at
  // midnight but the hour rolls on, so without it peer notices could take
  // thirty before midnight and thirty after and leave none for the owner.
  const since = at - ULTRA_SMS_HOST_LIMIT.windowMs;
  const hits = (book.byHost.get(hostKey) || []).filter((t) => t > since);
  const hourly =
    kind === 'own'
      ? ULTRA_SMS_HOST_LIMIT.max
      : ULTRA_SMS_HOST_LIMIT.max - ULTRA_SMS_OWN_RESERVE;
  if (hits.length >= hourly) return { ok: false, reason: 'host' };
  hits.push(at);
  book.byHost.set(hostKey, hits);
  book.day = { date: today, count: count + 1 };
  if (test) {
    book.lastTestAt = at;
  } else {
    // Re-inserting moves the key to the end, so insertion order is recency
    // order and the oldest key is the one evicted past the cap.
    book.byEntry.delete(id);
    book.byEntry.set(id, at);
    while (book.byEntry.size > LEDGER_KEY_CAP)
      book.byEntry.delete(book.byEntry.keys().next().value);
  }
  return { ok: true, reason: '' };
}

/**
 * After a send that did not go out: the per-key cooldown shrinks from ten
 * minutes to ULTRA_SMS_RETRY_MS, so the next press retries that number a
 * minute later instead of waiting out a cooldown for a text nobody
 * received, and a burst of presses during an outage tries each number at
 * most once a minute. The failed request also gives back its place in the
 * day's and the host's counts — those budget texts that leave, and an
 * outage must never be what stops the owner's helpers being texted once it
 * is over — unless it may have gone out after all (`spent`: a timeout).
 * Only the stamp `ultraSmsRelayAllowed` wrote at `at` is touched: a newer
 * send under the same key keeps its own.
 */
export function ultraSmsRelayForget(
  ledger,
  { key, at, spent = false, retryMs = ULTRA_SMS_RETRY_MS } = {},
) {
  const book = ledgerOf(ledger);
  const id = String(key ?? '');
  const stamp = finiteOrNull(at);
  if (stamp === null || book.byEntry.get(id) !== stamp) return;
  const wait = Math.min(
    Math.max(finiteOrNull(retryMs) ?? ULTRA_SMS_RETRY_MS, 0),
    ULTRA_SMS_RENOTIFY_MS,
  );
  // Stamped as if sent earlier, so the cooldown ends `wait` after this send.
  book.byEntry.set(id, stamp - ULTRA_SMS_RENOTIFY_MS + wait);
  if (spent) return;
  if (book.day.date === dayKey(stamp) && Number(book.day.count) > 0)
    book.day = { date: book.day.date, count: Number(book.day.count) - 1 };
  for (const [host, hits] of book.byHost) {
    const index = hits.indexOf(stamp);
    if (index === -1) continue;
    hits.splice(index, 1);
    book.byHost.set(host, hits);
    break;
  }
}

/**
 * The one line the owner's SEND HELP shows for the relay to the PREDEFINED
 * HELP # numbers, built from what happened to each number of this call
 * (`numbers`, the relayable cells) rather than from whichever answer came
 * last: '' before anything was tried; 'SENDING' while any text is on its
 * way; 'SMS SENT HH:MM' when every number got one; 'SMS SENT 2/3 · 1 NOT
 * SENT' when only some did; else the last failure ('SMS FAILED: …') or the
 * limit that held them ('SMS NOT SENT: DAILY LIMIT' / 'HOURLY LIMIT').
 * Never 'already texted' for a number that was not.
 */
export function ultraOwnSmsOutcome({
  numbers = [],
  sent = new Set(),
  pending = new Set(),
  failed = new Map(),
  limited = new Map(),
  lastSentAt = null,
} = {}) {
  const cells = Array.isArray(numbers) ? numbers : [];
  if (cells.some((n) => pending.has(n))) return ULTRA_SMS_SENDING;
  const got = cells.filter((n) => sent.has(n));
  const lost = cells.filter(
    (n) => !sent.has(n) && (failed.has(n) || limited.has(n)),
  );
  if (got.length && !lost.length)
    return 'SMS SENT ' + clockTime(finiteOrNull(lastSentAt) ?? Date.now());
  if (got.length)
    return `SMS SENT ${got.length}/${got.length + lost.length} · ${lost.length} NOT SENT`;
  const failure = cells
    .map((n) => failed.get(n))
    .filter(Boolean)
    .pop();
  if (failure) return String(failure).slice(0, 40);
  const reasons = cells.map((n) => limited.get(n)).filter(Boolean);
  if (reasons.length)
    return reasons.includes('daily')
      ? 'SMS NOT SENT: DAILY LIMIT'
      : 'SMS NOT SENT: HOURLY LIMIT';
  return '';
}

/** How many messages left today on this machine's calendar; zero once the day has turned. */
export function ultraSmsSentToday(ledger, now = Date.now()) {
  const book = ledgerOf(ledger);
  const at = finiteOrNull(now) ?? Date.now();
  return book.day.date === dayKey(at) ? Number(book.day.count) || 0 : 0;
}

/**
 * The failure code a provider's answer names: Twilio's numeric `code`
 * (or a gateway's short word) from the JSON, else 'HTTP <status>', else
 * ''. Never a message string, which can quote what was sent.
 */
export function ultraSmsFailureCode(status, json) {
  const raw = json && typeof json === 'object' ? json.code : undefined;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0)
    return String(raw);
  if (typeof raw === 'string' && CODE_PATTERN.test(raw.trim()))
    return raw.trim();
  const n = Number(status);
  return Number.isInteger(n) && n > 0 ? `HTTP ${n}` : '';
}

function isTimeout(error) {
  const name = String(error?.name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  return /time(d )?out/i.test(String(error?.message ?? error ?? ''));
}

/**
 * The outcome word a row and the status carry, at most 40 characters:
 * 'SMS SENT HH:MM' for any 2xx (Twilio answers 201 on create), else
 * 'SMS FAILED: ' with the provider code, 'HTTP <n>', 'timeout' or
 * 'unreachable'. `code` may be given directly or as the answer's `json`.
 */
export function ultraSmsOutcome({ status, code, json, error } = {}, now) {
  if (error !== undefined && error !== null && error !== '') {
    return 'SMS FAILED: ' + (isTimeout(error) ? 'timeout' : 'unreachable');
  }
  const n = Number(status);
  if (Number.isInteger(n) && n >= 200 && n < 300)
    return 'SMS SENT ' + clockTime(now);
  const given =
    typeof code === 'number' && Number.isInteger(code) && code > 0
      ? String(code)
      : typeof code === 'string' && CODE_PATTERN.test(code.trim())
        ? code.trim()
        : '';
  const word = given || ultraSmsFailureCode(status, json);
  return 'SMS FAILED: ' + (word || 'unreachable');
}
