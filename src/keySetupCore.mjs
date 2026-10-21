/**
 * Key setup ("POWER UP") — the pure core.
 *
 * One registry and pure functions; it imports only the proxy-header check
 * shared with the other local gates (localRequestGate.mjs) and the msg()
 * marker (src/i18n/marker.js). The dev server's
 * /api/setup endpoints (vite.config.js) and the in-app panel (keySetup.js)
 * are both thin shells over this module, so what a key is called, what it
 * unlocks, and how a .env line is written each live in exactly one place.
 *
 * Nothing here touches the filesystem, the network, or process.env — callers
 * pass environments in and write text out, which is also what makes every
 * behavior below unit-testable.
 */

import { msg } from './i18n/marker.js';
import { hasProxySignals } from './localRequestGate.mjs';

/** Longest accepted key/token value. NASA Earthdata Login tokens are JWTs of
 * roughly 700 characters; every other provider key is far shorter. */
export const KEY_SETUP_VALUE_LIMIT = 4096;

/** Most env var NAMES accepted in one save. The registry defines thirty-three,
 * plus eight optional boxes (the LLM and swarm MODEL ids and the directory
 * write token), so one save can carry every name with room for a few more. */
export const KEY_SETUP_UPDATE_LIMIT = 48;

/** Header line written above keys the panel appends to a .env file. */
export const KEY_SETUP_APPEND_HEADER =
  '# Keys added by the in-app POWER UP panel';

/**
 * Provider credentials, in display order — most magic per
 * minute first. `tier` mirrors the README's color legend: 'metered' (🔴) is a
 * billing-enabled account, 'free' (🟡) is a register-and-paste key, and
 * 'paid' (🔴) is an optional paid higher-rate token.
 * `clientExposed` marks the keys that are injected into the browser
 * bundle by design (restrict them at the provider, per SECURITY.md).
 * `hidden` keeps advanced configuration out of the panel and missing-key count.
 */
export const KEY_SETUP_KEYS = Object.freeze([
  Object.freeze({
    id: 'google-maps',
    title: 'GOOGLE MAPS', // i18n-ignore: provider product name
    unlocks: msg('The photorealistic 3D planet, place search + Street View'),
    getUrl: 'https://developers.google.com/maps/documentation/tile/get-api-key',
    envVars: Object.freeze(['GOOGLE_MAPS_API_KEY']),
    tier: 'metered',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'google-maps-server',
    title: 'GOOGLE MAPS — SERVER', // i18n-ignore: provider product name; row is hidden
    unlocks: msg(
      'Places context + Street View fallback; optional separate key',
    ),
    getUrl:
      'https://developers.google.com/maps/documentation/places/web-service/get-api-key',
    envVars: Object.freeze(['GOOGLE_MAPS_SERVER_API_KEY']),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'openai',
    title: 'OPENAI', // i18n-ignore: provider product name
    unlocks: msg('Voice control — API key or ChatGPT OAuth'),
    getUrl: 'https://platform.openai.com/api-keys',
    envVars: Object.freeze(['OPENAI_API_KEY']),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'gemini',
    title: 'GEMINI', // i18n-ignore: provider product name
    unlocks: msg('Gemini Live voice control'),
    getUrl: 'https://aistudio.google.com/apikey',
    envVars: Object.freeze(['GEMINI_API_KEY']),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'aisstream',
    title: 'AISSTREAM', // i18n-ignore: provider product name
    unlocks: msg('Live ships, worldwide'),
    getUrl: 'https://aisstream.io',
    envVars: Object.freeze(['AISSTREAM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'firms',
    title: 'NASA FIRMS', // i18n-ignore: provider product name
    unlocks: msg('Live active-fire detections'),
    getUrl: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/',
    envVars: Object.freeze(['FIRMS_MAP_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'tomtom',
    title: 'TOMTOM', // i18n-ignore: provider product name
    unlocks: msg('Real live traffic (keyless runs a simulation)'),
    getUrl: 'https://my.tomtom.com/keys',
    envVars: Object.freeze(['TOMTOM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'cesium-ion',
    title: 'CESIUM ION', // i18n-ignore: provider product name
    unlocks: msg('Bing imagery map stacks + world terrain'),
    getUrl: 'https://ion.cesium.com/tokens',
    envVars: Object.freeze(['CESIUM_ION_TOKEN']),
    tier: 'free',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'opensky',
    title: 'OPENSKY', // i18n-ignore: provider product name
    unlocks: msg('More flight-polling credits (anonymous works without)'),
    getUrl: 'https://opensky-network.org',
    envVars: Object.freeze(['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'mapillary',
    title: 'MAPILLARY', // i18n-ignore: provider product name
    unlocks: msg(
      'Street-level imagery and coverage in the Street Level layer. Free: register an app in the Mapillary developer dashboard and paste its Client Token',
    ),
    getUrl: 'https://www.mapillary.com/dashboard/developers',
    envVars: Object.freeze(['MAPILLARY_CLIENT_TOKEN']),
    tier: 'free',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'launch-library',
    title: 'LAUNCH LIBRARY', // i18n-ignore: provider product name
    unlocks: msg(
      'Public space-missions access needs no key. Leave blank for standard use; paid tokens only raise request limits.',
    ),
    getUrl: 'https://thespacedevs.com/supportus',
    envVars: Object.freeze(['LL2_API_TOKEN']),
    tier: 'paid',
  }),
  Object.freeze({
    id: 'earthdata',
    // i18n-ignore: fork text, English only for now
    title: 'NASA EARTHDATA',
    unlocks: 'Sea Surface Temperature: OceanColor MODIS Aqua data access',
    getUrl: 'https://urs.earthdata.nasa.gov/profile',
    envVars: Object.freeze(['EARTHDATA_TOKEN']),
    tier: 'free',
  }),
  // Server-side only: the CCTV lookup route reads it from process.env on every
  // call, and only when someone opens a US camera that has no public image.
  Object.freeze({
    id: 'road511',
    // i18n-ignore: fork text, English only for now
    title: 'ROAD511',
    unlocks:
      'US traffic cams with no public image: looks one up only when you open that camera',
    getUrl: 'https://road511.com',
    envVars: Object.freeze(['ROAD511_API_KEY']),
    tier: 'metered',
  }),
  // Ask-panel language models. Each one that carries a key gets its own input
  // box and buttons under the LLM heading, so several can be compared side by
  // side on the same view. They share a group: any ONE of them powers the
  // panel, so the POWER UP chip counts the group once and retires as soon as
  // one key is in, rather than nagging for all five.
  // Each LLM key also carries a MODEL box (`optionalEnvVars`): the model id
  // the provider is asked for. Optional: an empty box means the provider's
  // default (server/providers/llm/ask.js), and it never decides whether the
  // key counts as set. `placeholder` is that default; `options` are ids the
  // box suggests, any id the provider lists may be typed instead.
  Object.freeze({
    id: 'nvidia',
    group: 'llm',
    // i18n-ignore: fork text, English only for now
    title: 'NVIDIA NIM',
    unlocks:
      'AI Risk & Truth Assessment: typed questions and one-click overviews of the view',
    getUrl: 'https://build.nvidia.com/',
    envVars: Object.freeze(['NVIDIA_API_KEY']),
    optionalEnvVars: Object.freeze([
      Object.freeze({
        name: 'NVIDIA_MODEL',
        // i18n-ignore: fork text, English only for now
        label: 'MODEL',
        placeholder: 'moonshotai/kimi-k3',
        // NIM's id for Nemotron 3.5 Super VL, read from its model list on
        // 2026-10-16; it is asked with thinking on (ask.js MODEL_SAMPLING).
        options: Object.freeze(['nvidia/nemotron-3.5-super-vl-120b-a12b']),
      }),
    ]),
    tier: 'free',
  }),
  Object.freeze({
    id: 'xai',
    group: 'llm',
    // i18n-ignore: fork text, English only for now
    title: 'xAI GROK',
    unlocks:
      'AI Risk & Truth Assessment: adds Grok as a second opinion on the current view',
    getUrl: 'https://console.x.ai/',
    envVars: Object.freeze(['XAI_API_KEY']),
    optionalEnvVars: Object.freeze([
      Object.freeze({
        name: 'XAI_MODEL',
        // i18n-ignore: fork text, English only for now
        label: 'MODEL',
        placeholder: 'grok-4.6',
        options: Object.freeze([]),
      }),
    ]),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'anthropic',
    group: 'llm',
    // i18n-ignore: fork text, English only for now
    title: 'ANTHROPIC CLAUDE',
    unlocks:
      'AI Risk & Truth Assessment: adds Claude as a second opinion on the current view',
    getUrl: 'https://console.anthropic.com/',
    envVars: Object.freeze(['ANTHROPIC_API_KEY']),
    optionalEnvVars: Object.freeze([
      Object.freeze({
        name: 'ANTHROPIC_MODEL',
        // i18n-ignore: fork text, English only for now
        label: 'MODEL',
        placeholder: 'claude-fable-5-1',
        options: Object.freeze([]),
      }),
    ]),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'openrouter',
    group: 'llm',
    // i18n-ignore: fork text, English only for now
    title: 'OPENROUTER',
    unlocks:
      'AI Risk & Truth Assessment: one key that reaches many models; NVIDIA Nemotron 3.5 Super VL (free) unless another is chosen',
    getUrl: 'https://openrouter.ai/keys',
    envVars: Object.freeze(['OPENROUTER_API_KEY']),
    optionalEnvVars: Object.freeze([
      Object.freeze({
        name: 'OPENROUTER_MODEL',
        // i18n-ignore: fork text, English only for now
        label: 'MODEL',
        placeholder: 'nvidia/nemotron-3.5-super-vl:free',
        // OpenRouter's own ids, read from its model list on 2026-09-27 and
        // 2026-10-16.
        options: Object.freeze([
          'nvidia/nemotron-3.5-super-vl:free',
          'nvidia/nemotron-3.5-super-vl',
          'nvidia/nemotron-3-ultra-550b-a55b:free',
          'nvidia/nemotron-3-super-120b-a12b:free',
          'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
          'nvidia/nemotron-3.5-lightning:free',
          'nvidia/nemotron-3-ultra-550b-a55b',
          'nvidia/nemotron-3-super-120b-a12b',
          'openai/gpt-5.2',
        ]),
      }),
    ]),
    tier: 'metered',
  }),
  // Escape hatch: any other OpenAI-compatible endpoint, including one running
  // on this machine. Needs a base URL and model name as well as the key, which
  // is why it carries three env vars rather than one.
  Object.freeze({
    id: 'custom',
    group: 'llm',
    // i18n-ignore: fork text, English only for now
    title: 'CUSTOM LLM',
    unlocks:
      'AI Risk & Truth Assessment: any OpenAI-compatible endpoint, local or hosted',
    getUrl: 'https://platform.openai.com/docs/api-reference/chat',
    envVars: Object.freeze([
      'CUSTOM_LLM_API_KEY',
      'CUSTOM_LLM_BASE_URL',
      'CUSTOM_LLM_MODEL',
    ]),
    tier: 'free',
  }),
  // Social Media, Outbreak SOCIAL SEARCH, and Ultra GROK BOT SWARM each send
  // seven bots on GROK_BOT_API_KEY (or OPENAI_DOTS_API_KEY). GROK BOT, its
  // computer, and its Chief of Staff webhook share a group. The swarm press
  // uses the API key when it is set; without one it uses the computer, else
  // it opens Grok Bot and pastes the task. The webhook card stays for a
  // Chief of Staff routine the swarm buttons do not call.
  Object.freeze({
    id: 'grok-bot',
    group: 'grok-bot',
    // i18n-ignore: fork text, English only for now
    title: 'GROK BOT',
    unlocks:
      'Social Media, Outbreak SOCIAL SEARCH, and Ultra → GROK BOT SWARM: seven bots at once on their own xAI key; answers land in that panel. Without this key, GROK BOT — COMPUTER or Grok Bot with the task pasted to your Chief of Staff',
    getUrl: 'https://console.x.ai/',
    envVars: Object.freeze(['GROK_BOT_API_KEY']),
    optionalEnvVars: Object.freeze([
      Object.freeze({
        name: 'XAI_SWARM_MODEL',
        // i18n-ignore: fork text, English only for now
        label: 'MODEL',
        placeholder: 'grok-4.6',
        options: Object.freeze([]),
      }),
    ]),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'grok-bot-chief-of-staff',
    group: 'grok-bot',
    // i18n-ignore: fork text, English only for now
    title: 'GROK BOT — CHIEF OF STAFF',
    unlocks:
      'A webhook routine of your Chief of Staff bot in Grok Bot (Routines → When a webhook fires; paste its Webhook URL and Webhook key). GROK BOT SWARM uses the GROK BOT API key instead',
    getUrl: 'https://docs.x.ai/grok-bot/skills-routines-and-automations',
    envVars: Object.freeze(['GROK_BOT_WEBHOOK_URL', 'GROK_BOT_WEBHOOK_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'grok-bot-computer',
    group: 'grok-bot',
    // i18n-ignore: fork text, English only for now
    title: 'GROK BOT — COMPUTER',
    unlocks:
      "GROK BOT SWARM without a GROK BOT API key: send the sweep to a Grok Bot on this computer (or a Tailscale one) and write its report in the panel. Paste the gateway URL and token from that computer's gateway.json. Not a webhook",
    getUrl: 'https://docs.x.ai/grok-bot/skills-routines-and-automations',
    envVars: Object.freeze(['GROK_BOT_GATEWAY_URL', 'GROK_BOT_GATEWAY_TOKEN']),
    optionalEnvVars: Object.freeze([
      Object.freeze({
        name: 'GROK_BOT_GATEWAY_AGENT',
        // i18n-ignore: fork text, English only for now
        label: 'BOT',
        // i18n-ignore: fork text, English only for now
        placeholder: 'Chief-of-Staff',
        options: Object.freeze([]),
      }),
    ]),
    tier: 'free',
  }),
  Object.freeze({
    id: 'openai-dots',
    // i18n-ignore: fork text, English only for now
    title: 'OPENAI DOTS',
    unlocks:
      'Social Media, Outbreak SOCIAL SEARCH, and Ultra → OPENAI DOT SWARM: seven bots at once on their own OpenAI key, apart from voice control. Without this key, ChatGPT with the task pasted',
    getUrl: 'https://platform.openai.com/api-keys',
    envVars: Object.freeze(['OPENAI_DOTS_API_KEY']),
    optionalEnvVars: Object.freeze([
      Object.freeze({
        name: 'OPENAI_SWARM_MODEL',
        // i18n-ignore: fork text, English only for now
        label: 'MODEL',
        placeholder: 'gpt-6-astra',
        options: Object.freeze([]),
      }),
    ]),
    tier: 'metered',
  }),
  // Ultra Security Package SMS relay: a call for help texted to the owner's
  // own cell (a friend's SEND HELP) and to the saved helpers (the owner's own
  // SEND HELP) without a tap. Every message costs money at the provider's
  // rate, so nothing is sent until the keys are here. The two recipes share a
  // group: either one powers the relay, so the POWER UP chip counts it once.
  // The server reads these from process.env at call time (2026-09-28 ruling:
  // a save from this panel applies at once; a hand edit needs a full restart).
  Object.freeze({
    id: 'twilio-sms',
    group: 'ultra-sms',
    // i18n-ignore: fork text, English only for now
    title: 'SMS RELAY — TWILIO',
    unlocks:
      "Ultra Security Package: texts a call for help to your own cell and to your saved helpers automatically (costs money per message at Twilio's rate)",
    getUrl: 'https://console.twilio.com',
    envVars: Object.freeze([
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM_NUMBER',
    ]),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'ultra-sms-relay',
    group: 'ultra-sms',
    // i18n-ignore: fork text, English only for now
    title: 'SMS RELAY — YOUR OWN GATEWAY',
    unlocks:
      'Ultra Security Package: the same texts through an https gateway you run (it receives JSON { to, body } with a bearer token)',
    getUrl: 'https://www.twilio.com/docs/messaging/api/message-resource',
    envVars: Object.freeze(['ULTRA_SMS_RELAY_URL', 'ULTRA_SMS_RELAY_TOKEN']),
    tier: 'free',
  }),
  // Hidden because the Ultra box owns its own form (HELP NETWORK → SAVE
  // DIRECTORY); registering the names is what lets POST /api/setup/keys
  // accept them. The write token is optional: without it PUBLISH MY TOKEN
  // copies the entry for the owner to send instead of writing to GitHub.
  Object.freeze({
    id: 'ultra-directory',
    // i18n-ignore: fork text, English only for now
    title: 'HELP NETWORK DIRECTORY',
    unlocks:
      'Ultra Security Package → HELP NETWORK: the shared list of help links your group publishes; set it from that box',
    getUrl: 'https://github.com/settings/personal-access-tokens',
    envVars: Object.freeze(['ULTRA_DIRECTORY_URL']),
    optionalEnvVars: Object.freeze([
      Object.freeze({
        name: 'ULTRA_DIRECTORY_WRITE_TOKEN',
        // i18n-ignore: fork text, English only for now
        label: 'GITHUB WRITE TOKEN',
        // i18n-ignore: fork text, English only for now
        placeholder: 'github_pat_…',
        options: Object.freeze([]),
      }),
    ]),
    tier: 'free',
    hidden: true,
  }),
]);

/** Hostnames a Provider Settings request may arrive under or originate from. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** Socket addresses that count as this machine. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Whether a socket address is one the operator has explicitly declared to be
 * this machine through GEV_KEY_SETUP_TRUSTED_PEERS: a comma-separated list of
 * EXACT addresses, never wildcards, prefixes or hostnames. Unset trusts
 * nothing, which is every launcher but one.
 *
 * The shipped use is the Docker launcher (scripts/docker-start.mjs). A port
 * published on the host's loopback still reaches the container FROM the
 * container network's gateway, never from 127.0.0.1, so the loopback check
 * alone refuses the very machine running the server. Admitting that one
 * address relaxes nothing else: the sharing, Host, Origin, Content-Type and
 * proxy-header checks all still apply to it.
 */
function isTrustedPeerAddress(remoteAddress, env) {
  const normalize = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^::ffff:/, '');
  const address = normalize(remoteAddress);
  if (!address) return false;
  return String(env?.GEV_KEY_SETUP_TRUSTED_PEERS || '')
    .split(',')
    .some((entry) => entry.trim() !== '' && normalize(entry) === address);
}

/** Parse an exact local request authority from a Host header. */
function localAuthority(hostHeader, protocol) {
  const raw = String(hostHeader || '')
    .trim()
    .toLowerCase();
  const scheme = String(protocol || '').toLowerCase();
  if (!raw || !['http:', 'https:'].includes(scheme) || /[\s/?#@]/.test(raw))
    return null;
  try {
    const parsed = new URL(`${scheme}//${raw}`);
    return LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase())
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

/** True only for a subprocess that exited normally and successfully. */
export function commandCompletedSuccessfully(result) {
  return !!result && !result.error && !result.signal && result.status === 0;
}

/** Parse one RFC-4180-shaped CSV record, sufficient for `whoami /fo csv`. */
function parseCsvRecord(text) {
  const source = String(text || '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!source || /[\r\n]/.test(source)) return null;
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

/**
 * Extract the current token's user SID from `whoami /user /fo csv /nh`.
 * The SID must be the second CSV field and a user-shaped local/domain or Entra
 * SID; matching an SID-looking account name or a broad group SID is forbidden.
 */
export function parseWindowsUserSid(stdout) {
  const fields = parseCsvRecord(stdout);
  if (!fields || fields.length !== 2) return null;
  const sid = fields[1].trim();
  return /^(?:S-1-5-21-(?:\d+-){3}\d+|S-1-12-1-(?:\d+-){3}\d+)$/i.test(sid)
    ? sid
    : null;
}

/**
 * Whether the launcher has sharing on. Every sharing signal the launcher
 * recognizes (scripts/pinokio-preflight.mjs) counts, so the two sets cannot
 * drift apart. One DELIBERATE divergence: preflight is a boot check that
 * treats an empty PINOKIO_SHARE_VAR as sharing-on (fail closed before Start),
 * but here an empty/unset value is the NORMAL git-clone and Pinokio state, so
 * a bare/sentinel value is not sharing; only a real tunnel var is.
 */
export function isSharingEnabled(env = {}) {
  const shareVar = String(env.PINOKIO_SHARE_VAR ?? '').trim();
  return (
    ['PINOKIO_SHARE_CLOUDFLARE', 'PINOKIO_SHARE_LOCAL'].some((name) =>
      /^(1|true)$/i.test(String(env[name] || '').trim()),
    ) ||
    (shareVar !== '' && shareVar !== '__gev_sharing_disabled__')
  );
}

/**
 * The owner's own phone or tablet through the tailnet dashboard (Mirror of PC
 * GEVC on Cell). That listener answers only on this machine's tailnet IPv4
 * address, asks Tailscale who the caller is, and only for a device signed in
 * as this machine's owner does it stamp the request with two headers: this
 * process's in-memory token and the listener's own authority
 * (`http://<tailnet-ip>:<port>`, built from the listener, never the request).
 * It strips any copy a caller sent before deciding, so the stamp is set only
 * by the mirror. Writes from the owner device still need an exact Origin and a
 * JSON body; removing anything stored on this machine stays PC-only (owner
 * ruling 2026-10-11: "full write access - except delete or remove").
 */
export const OWNER_DEVICE_HEADER = 'x-gev-owner-device';
export const OWNER_DEVICE_AUTHORITY_HEADER = 'x-gev-owner-device-authority';
/**
 * An owner device's removal is refused without a message (owner ruling
 * 2026-10-11: "no message"): 403, this header and this exact body, never an
 * `error` field, so the phone can leave the item as it is and say nothing.
 */
export const OWNER_DEVICE_REMOVAL_HEADER = 'x-gev-removal';
export const OWNER_DEVICE_REMOVAL_BODY = Object.freeze({ removal: 'pc-only' });

/**
 * Answer an owner device's removal: 403 with OWNER_DEVICE_REMOVAL_HEADER and
 * OWNER_DEVICE_REMOVAL_BODY, never any error text. `headers` are a route's
 * own extra headers (security headers, say); they cannot change the type,
 * the caching or the marker.
 * @param {import('node:http').ServerResponse} res
 * @param {Record<string, string>} [headers]
 */
export function sendOwnerRemovalRefusal(res, headers = {}) {
  const fixed = new Set([
    'content-type',
    'cache-control',
    OWNER_DEVICE_REMOVAL_HEADER,
  ]);
  const extra = Object.fromEntries(
    Object.entries(headers || {}).filter(
      ([name]) => !fixed.has(String(name).toLowerCase()),
    ),
  );
  res.writeHead(403, {
    ...extra,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    [OWNER_DEVICE_REMOVAL_HEADER]: OWNER_DEVICE_REMOVAL_BODY.removal,
  });
  res.end(JSON.stringify(OWNER_DEVICE_REMOVAL_BODY));
}

/**
 * The read-only stamp the mirror used before full write access. The gate no
 * longer honours it; the name stays so the mirror can keep stripping it.
 * @deprecated use OWNER_DEVICE_HEADER
 */
export const OWNER_DEVICE_READ_HEADER = 'x-gev-owner-device-read';

let ownerDeviceToken = '';
/** Set by the tailnet dashboard at start-up; a short or empty token turns it off. */
export function setOwnerDeviceToken(token) {
  ownerDeviceToken =
    typeof token === 'string' && token.length >= 32 ? token : '';
}
/** @deprecated use setOwnerDeviceToken */
export const setOwnerDeviceReadToken = setOwnerDeviceToken;

/** True for an address in Tailscale's 100.64.0.0/10 range. */
export function isTailnetIPv4(address) {
  const text = String(address || '');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text)) return false;
  const parts = text.split('.').map(Number);
  if (parts.some((n) => n > 255)) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function ownerTokenMatches(value) {
  if (
    !ownerDeviceToken ||
    typeof value !== 'string' ||
    value.length !== ownerDeviceToken.length
  )
    return false;
  let diff = 0;
  for (let i = 0; i < value.length; i++)
    diff |= value.charCodeAt(i) ^ ownerDeviceToken.charCodeAt(i);
  return diff === 0;
}

/**
 * The mirror's origin (`http://<tailnet-ip>:<port>`) when this is a request
 * the mirror stamped for the owner's device, else null. Every one of these
 * must hold: the token matches; the socket is a tailnet IPv4 address; the
 * scheme is http; the authority header is exactly `http://<100.64/10>:<port>`
 * with no user, path, query or hash; and the request's own Host names that
 * same authority (a DNS-rebinding page carries a foreign Host and fails).
 */
export function ownerDeviceAuthority({
  remoteAddress,
  hostHeader,
  protocol = 'http:',
  headers = {},
} = {}) {
  if (!ownerTokenMatches(headers?.[OWNER_DEVICE_HEADER])) return null;
  const socket = String(remoteAddress || '').replace(/^::ffff:/i, '');
  if (!isTailnetIPv4(socket)) return null;
  if (String(protocol || '').toLowerCase() !== 'http:') return null;
  const stamped = headers?.[OWNER_DEVICE_AUTHORITY_HEADER];
  if (
    typeof stamped !== 'string' ||
    !/^http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}$/.test(stamped)
  )
    return null;
  let authority;
  try {
    const parsed = new URL(stamped);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      !isTailnetIPv4(parsed.hostname)
    )
      return null;
    authority = parsed.origin;
  } catch {
    return null;
  }
  const host = String(hostHeader || '')
    .trim()
    .toLowerCase();
  if (!host || /[\s/?#@\\]/.test(host)) return null;
  try {
    return new URL(`http://${host}`).origin === authority ? authority : null;
  } catch {
    return null;
  }
}

/**
 * The same test for gates that hold a Node request rather than the core's
 * fields. A request carrying proxy headers is never an owner device.
 * @param {import('node:http').IncomingMessage} req
 */
export function isOwnerDeviceRequest(req) {
  const headers = req?.headers || {};
  if (hasProxySignals(headers)) return false;
  return (
    ownerDeviceAuthority({
      remoteAddress: req?.socket?.remoteAddress,
      hostHeader: headers.host,
      protocol: req?.socket?.encrypted ? 'https:' : 'http:',
      headers,
    }) !== null
  );
}

/** Whether the request headers announce a body. */
function requestHasBody(headers = {}) {
  const length = Number(String(headers['content-length'] ?? '').trim());
  return (
    (Number.isFinite(length) && length > 0) ||
    String(headers['transfer-encoding'] ?? '').trim() !== ''
  );
}

/**
 * The admission gate for the Provider Settings endpoints — pure, exported so
 * every refusal below is pinned by a unit assertion rather than a review note.
 *
 * Why each check exists:
 *  - sharing signals: any tunnel/LAN sharing mode disables the surface
 *    outright — a credential-writing endpoint has no business existing on a
 *    shared instance, and tunnel traffic reaches the server FROM loopback, so
 *    the socket check below cannot carry that boundary alone;
 *  - owner device: the mirror's stamp (see ownerDeviceAuthority) stands in
 *    for the loopback socket and local Host. It may read and write, but every
 *    DELETE is refused with `removal: true` and no error text (removing is
 *    done on the PC; answer it with sendOwnerRemovalRefusal), and any other
 *    method but GET/HEAD needs an exact Origin and, with a body, JSON;
 *  - loopback socket: refuses LAN peers when the server is bound wide. The
 *    only exception is an exact address listed in
 *    GEV_KEY_SETUP_TRUSTED_PEERS, and every check below still applies to it;
 *  - local Host header: tunnel and DNS-rebinding traffic carries a foreign
 *    Host even when the socket says loopback;
 *  - exact same Origin on POST: a hostile web page can make a browser POST to
 *    localhost, and a non-browser caller must not bypass that boundary merely
 *    by omitting the header;
 *  - JSON Content-Type on POST: forces cross-origin browsers into a CORS
 *    preflight this server never answers, closing the simple-request CSRF
 *    write primitive.
 *
 * A refusal also carries `code`, which the panel turns into its own localized
 * sentence (keySetup.js); `error` stays the English for logs and API callers.
 * The owner-device refusal of a DELETE carries neither (`removal: true`).
 * @returns {{ok: true, ownerDevice: boolean} | {ok: false, status: number, error: string, code: string} | {ok: false, status: 403, removal: true}}
 */
export function admitKeySetupRequest({
  method,
  remoteAddress,
  hostHeader,
  protocol = 'http:',
  origin,
  contentType,
  proxyHeaders = {},
  env = {},
} = {}) {
  // A request carrying reverse-proxy / CDN forwarding headers did not originate
  // on this machine, whatever its socket says. Refuse them outright as defense
  // in depth — the shipped tunnel (Pinokio) is force-closed at boot, so these
  // only appear when someone has deliberately fronted the dev server.
  if (hasProxySignals(proxyHeaders)) {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings does not answer proxied requests',
      code: 'proxied',
    };
  }
  // Every sharing signal the launcher recognizes (scripts/pinokio-preflight.mjs)
  // also disables this surface — so the gate's set is complete, not a subset the
  // two files could drift apart on. One DELIBERATE divergence: preflight is a
  // boot check that treats an empty PINOKIO_SHARE_VAR as sharing-on (fail closed
  // before Start), but here an empty/unset value is the NORMAL git-clone and
  // Pinokio state — treating it as sharing would disable Provider Settings for
  // every ordinary launch. So a bare/sentinel value is not sharing; only a real
  // tunnel var is. This is defense in depth regardless: the loopback+Host checks
  // below independently refuse LAN/tunnel traffic, and under Pinokio the launcher
  // refuses to boot at all when sharing is genuinely on.
  if (isSharingEnabled(env)) {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings is disabled while sharing is enabled',
      code: 'sharing',
    };
  }
  const verb = String(method || '').toUpperCase();
  // The owner's own phone, stamped by the mirror after Tailscale confirmed it.
  const owner = ownerDeviceAuthority({
    remoteAddress,
    hostHeader,
    protocol,
    headers: proxyHeaders,
  });
  let authority = owner;
  if (owner) {
    // Full write access, except removing anything stored on the PC. No
    // error text: the caller answers with sendOwnerRemovalRefusal.
    if (verb === 'DELETE') {
      return { ok: false, status: 403, removal: true };
    }
  } else {
    // Off the owner path only: a Docker host's gateway address listed in
    // GEV_KEY_SETUP_TRUSTED_PEERS (#208) passes as this machine, and every
    // check below still applies to it.
    if (
      !LOOPBACK_ADDRESSES.has(String(remoteAddress || '')) &&
      !isTrustedPeerAddress(remoteAddress, env)
    ) {
      return {
        ok: false,
        status: 403,
        error: 'Provider Settings answers only the machine running the server',
        code: 'not-loopback',
      };
    }
    authority = localAuthority(hostHeader, protocol);
    if (!authority) {
      return {
        ok: false,
        status: 403,
        error: 'Provider Settings answers only local hostnames',
        code: 'not-local-host',
      };
    }
  }
  const originMissing =
    origin === undefined || origin === null || origin === '';
  if (originMissing && !owner && method === 'POST') {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings requires an exact local Origin',
      code: 'origin-required',
    };
  }
  if (originMissing && owner && verb !== 'GET' && verb !== 'HEAD') {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings requires an exact Origin',
    };
  }
  if (!originMissing) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(String(origin));
    } catch {
      return {
        ok: false,
        status: 403,
        error: 'Unrecognized Origin refused',
        code: 'origin-unrecognized',
      };
    }
    const exactOrigin =
      parsedOrigin.username === '' &&
      parsedOrigin.password === '' &&
      parsedOrigin.pathname === '/' &&
      parsedOrigin.search === '' &&
      parsedOrigin.hash === '' &&
      parsedOrigin.origin === authority;
    if (!exactOrigin) {
      return {
        ok: false,
        status: 403,
        error: 'Cross-origin requests are refused',
        code: 'cross-origin',
      };
    }
  }
  const needsJson = owner
    ? verb === 'POST' ||
      verb === 'PUT' ||
      verb === 'PATCH' ||
      (verb !== 'GET' && verb !== 'HEAD' && requestHasBody(proxyHeaders))
    : method === 'POST';
  if (
    needsJson &&
    !String(contentType || '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    return {
      ok: false,
      status: 415,
      error: 'Content-Type must be application/json',
      code: 'content-type',
    };
  }
  return { ok: true, ownerDevice: !!owner };
}

/** @returns {Set<string>} every env var the panel is allowed to write. */
export function knownKeySetupEnvVars() {
  const names = new Set();
  for (const entry of KEY_SETUP_KEYS) {
    for (const envVar of entry.envVars) names.add(envVar);
    for (const optional of entry.optionalEnvVars || [])
      names.add(optional.name);
  }
  return names;
}

// The SMS relay's own acceptance rules (twilioKeys and gatewayKeys in
// src/ultraSmsRelay.mjs), copied here because this module imports nothing.
// A value the relay would never use is refused at save time and never
// counts as set, so POWER UP and the Ultra box agree on whether the relay
// is configured. A test in keySetupCore.test.mjs pins that the two agree.
const SMS_E164 = /^\+[1-9]\d{7,14}$/;
const SMS_SECRET = /^[\x21-\x7e]{1,512}$/;

/** Whether a hostname is an IPv4 literal in 100.64.0.0/10, the range Tailscale hands out. */
function smsTailnetLiteral(hostname) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  return (
    octets.every((o) => o <= 255) &&
    octets[0] === 100 &&
    octets[1] >= 64 &&
    octets[1] <= 127
  );
}

/** https anywhere, or http to a Tailscale literal, never with user:password in it. */
function smsRelayUrlOk(value) {
  if (value.length > 2048) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && smsTailnetLiteral(url.hostname))
  );
}

/**
 * The Grok Bot computer's own gateway: loopback, a Tailscale 100.64.x.x
 * address, or https on a .ts.net name. No user:password, query, hash, or
 * path, so the token goes only to that computer.
 */
function grokBotGatewayUrlOk(value) {
  if (value.length > 2048) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const http = url.protocol === 'http:' || url.protocol === 'https:';
  if (!http) return false;
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    return true;
  }
  if (smsTailnetLiteral(host)) return true;
  return url.protocol === 'https:' && host.endsWith('.ts.net');
}

/**
 * The Webhook URL Grok Bot shows for a routine: https on its own backend
 * (api2.cursor.sh, or api.origin.cursor.com), /automations/webhook/<id>, and
 * nothing else, so the webhook key it carries goes nowhere but Grok Bot.
 */
function grokBotWebhookUrlOk(value) {
  if (value.length > 2048) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    return false;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.cursor.sh') && !host.endsWith('.cursor.com'))
    return false;
  return /^\/automations\/webhook\/[A-Za-z0-9._~%-]{1,200}$/.test(url.pathname);
}

const KEY_SETUP_FORMATS = Object.freeze({
  GROK_BOT_GATEWAY_URL: [
    grokBotGatewayUrlOk,
    'GROK_BOT_GATEWAY_URL must be http://127.0.0.1:1340, http to a 100.64.x.x Tailscale address, or https on a .ts.net name, with no user:password, query or path',
  ],
  GROK_BOT_GATEWAY_TOKEN: [
    (v) => SMS_SECRET.test(v),
    'GROK_BOT_GATEWAY_TOKEN is longer than any real token (512 max)',
  ],
  GROK_BOT_GATEWAY_AGENT: [
    (v) => /^[A-Za-z0-9][A-Za-z0-9._~-]{0,79}$/.test(v),
    'GROK_BOT_GATEWAY_AGENT is the bot id or a short name (letters, digits, . _ - ~; write a space as -, e.g. Chief-of-Staff)',
  ],
  GROK_BOT_WEBHOOK_URL: [
    grokBotWebhookUrlOk,
    'GROK_BOT_WEBHOOK_URL must be the Webhook URL Grok Bot shows for the routine: https://api2.cursor.sh/automations/webhook/…',
  ],
  GROK_BOT_WEBHOOK_KEY: [
    (v) => SMS_SECRET.test(v),
    'GROK_BOT_WEBHOOK_KEY is longer than any real key (512 max)',
  ],
  TWILIO_ACCOUNT_SID: [
    (v) => /^[A-Za-z0-9]{2,64}$/.test(v),
    'TWILIO_ACCOUNT_SID is letters and digits only (it starts AC)',
  ],
  TWILIO_AUTH_TOKEN: [
    (v) => SMS_SECRET.test(v),
    'TWILIO_AUTH_TOKEN is longer than any real token (512 max)',
  ],
  TWILIO_FROM_NUMBER: [
    (v) => SMS_E164.test(v.replace(/[\s()-]/g, '')),
    'TWILIO_FROM_NUMBER needs + and the country code, e.g. +15065550100',
  ],
  ULTRA_SMS_RELAY_URL: [
    smsRelayUrlOk,
    'ULTRA_SMS_RELAY_URL must be https, or http to a 100.64.x.x Tailscale address, with no user:password in it',
  ],
  ULTRA_SMS_RELAY_TOKEN: [
    (v) => SMS_SECRET.test(v),
    'ULTRA_SMS_RELAY_TOKEN is longer than any real token (512 max)',
  ],
});

/**
 * Why a value can never work for this env var, or '' when it can (or when
 * the name has no format beyond a plain key's). The sentence names the
 * rule, never the value.
 */
export function keySetupValueProblem(name, value) {
  const rule = Object.hasOwn(KEY_SETUP_FORMATS, name)
    ? KEY_SETUP_FORMATS[name]
    : null;
  return rule && !rule[0](String(value ?? '')) ? rule[1] : '';
}

/**
 * Env-var names a registry entry needs, joined with ' + ', for callers that
 * build the guidance sentence in the UI language (src/ui/keyGuidance.js).
 * @param {string} id Registry entry id.
 * @returns {string|null} null for an unknown or hidden entry.
 */
export function keySetupRequirementEnvVars(id) {
  const entry = KEY_SETUP_KEYS.find((candidate) => candidate.id === id);
  if (!entry || entry.hidden) return null;
  return entry.envVars.join(' + ');
}

/** English tooltip guidance for a control gated by one registry entry. */
export function keySetupRequirement(id) {
  const entry = KEY_SETUP_KEYS.find((candidate) => candidate.id === id);
  if (!entry || entry.hidden) return '';
  return `Needs ${entry.envVars.join(' + ')} — add it in Provider Settings`;
}

/**
 * Key guidance that also names switched-off sources whose key is already set.
 * @param {string} requirement What `keySetupRequirement` said ('' allowed).
 * @param {Array<{label: string, requiresKeyId?: string|null}>} [alternatives]
 */
export function keySetupWithAlternatives(requirement, alternatives = []) {
  const options = alternatives.map(({ label, requiresKeyId }) => {
    const entry = KEY_SETUP_KEYS.find(
      (candidate) => candidate.id === requiresKeyId,
    );
    const name = entry
      ? entry.title
          .toLowerCase()
          .replace(/\b\w/g, (letter) => letter.toUpperCase())
      : null;
    return name ? `light ${label} to use your ${name} key` : `light ${label}`;
  });
  if (!options.length) return requirement;
  const offer = `or ${options.join(', or ')}`;
  return requirement ? `${requirement}, ${offer}` : offer.replace(/^or l/, 'L');
}

/**
 * Decide whether a live provider value belongs to a source outside the store
 * Provider Settings is allowed to edit. `wasExternalAtBoot` carries source
 * provenance without carrying the credential itself; it closes the otherwise
 * undecidable case where an exported value and a dotenv assignment happen to
 * contain the same bytes.
 * @param {{effectiveValue: unknown, storedValue: unknown, wasExternalAtBoot?: boolean}} input
 */
export function isKeySetupExternallyManaged({
  effectiveValue,
  storedValue,
  wasExternalAtBoot = false,
} = {}) {
  const effective = String(effectiveValue ?? '').trim();
  const stored = String(storedValue ?? '').trim();
  return effective !== '' && (wasExternalAtBoot || effective !== stored);
}

/**
 * Build the status payload the panel renders from: the registry, plus
 * per-entry `set`, `present` and `unusable` resolved against the given
 * environment. It never includes a value, suffix, or other credential
 * material.
 * @param {Record<string, string|undefined>} env e.g. process.env
 */
export function keySetupStatus(env = {}) {
  const keys = KEY_SETUP_KEYS.filter((entry) => !entry.hidden).map((entry) => {
    const values = entry.envVars.map((name) => String(env[name] ?? '').trim());
    // A value the provider would refuse (a hand-edited .env, or one saved
    // before its rule existed) is not set, so the row and the chip never
    // claim a relay the box calls NOT CONFIGURED. It is still there, though:
    // `present` keeps the row's REMOVE (or its external badge), and
    // `unusable` names the refused variables, never their values.
    const unusable = entry.envVars.filter(
      (name, i) =>
        values[i].length > 0 && keySetupValueProblem(name, values[i]),
    );
    const present = values.every((value) => value.length > 0);
    const set = present && unusable.length === 0;
    return {
      id: entry.id,
      title: entry.title,
      unlocks: entry.unlocks,
      getUrl: entry.getUrl,
      envVars: [...entry.envVars],
      // A model id is a choice, not a credential: the box shows the one in use.
      optionalEnvVars: (entry.optionalEnvVars || []).map((optional) => ({
        name: optional.name,
        label: optional.label,
        placeholder: optional.placeholder,
        options: [...(optional.options || [])],
        value: String(env[optional.name] ?? '').trim(),
      })),
      tier: entry.tier,
      group: entry.group || null,
      clientExposed: Boolean(entry.clientExposed),
      set,
      present,
      unusable,
    };
  });
  // Alternatives share a group: it counts once in the total and any member
  // satisfies it. Everything else is its own slot.
  const slots = new Map();
  for (const key of keys) {
    const slot = key.group || key.id;
    slots.set(slot, Boolean(slots.get(slot)) || key.set);
  }
  return {
    keys,
    setCount: [...slots.values()].filter(Boolean).length,
    total: slots.size,
  };
}

/**
 * Validate a POST body into a clean {ENV_VAR: value} map, or say exactly why
 * not. Values must be single-line printable ASCII with no spaces — every real
 * provider credential is — which is also what makes the raw `KEY=value` line
 * below safe to write without quoting rules. A `null` value means REMOVE:
 * the writer comments the assignment back out, returning the file to its
 * template state for that key.
 * A refusal carries `code` and `params` for the panel's localized sentence
 * (keySetup.js) besides the English `error`.
 * @param {unknown} body Parsed JSON from the request.
 */
/**
 * True when validated updates would remove a stored key (a null value comments
 * it out of the store). The owner's phone may save keys but never remove one.
 */
export function keySetupUpdatesRemove(updates) {
  return Object.values(updates || {}).some((value) => value === null);
}

export function validateKeySetupUpdates(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      error: 'Body must be a JSON object of {ENV_VAR: value}',
      code: 'not-object',
    };
  }
  const entries = Object.entries(body);
  if (entries.length === 0)
    return { ok: false, error: 'No keys provided', code: 'no-keys' };
  if (entries.length > KEY_SETUP_UPDATE_LIMIT) {
    return {
      ok: false,
      error: `At most ${KEY_SETUP_UPDATE_LIMIT} keys per save`,
      code: 'too-many',
      params: { limit: KEY_SETUP_UPDATE_LIMIT },
    };
  }
  const known = knownKeySetupEnvVars();
  const updates = {};
  for (const [name, raw] of entries) {
    if (!known.has(name))
      return {
        ok: false,
        error: `Unknown key: ${name}`,
        code: 'unknown-key',
        params: { name },
      };
    if (raw === null) {
      updates[name] = null;
      continue;
    }
    if (typeof raw !== 'string')
      return {
        ok: false,
        error: `${name} must be a string`,
        code: 'not-string',
        params: { name },
      };
    const value = raw.trim();
    if (!value)
      return {
        ok: false,
        error: `${name} is empty`,
        code: 'empty',
        params: { name },
      };
    if (value.length > KEY_SETUP_VALUE_LIMIT) {
      return {
        ok: false,
        error: `${name} is longer than any real key (${KEY_SETUP_VALUE_LIMIT} max)`,
        code: 'too-long',
        params: { name, limit: KEY_SETUP_VALUE_LIMIT },
      };
    }
    if (!/^[\x21-\x7e]+$/.test(value)) {
      return {
        ok: false,
        error: `${name} may only contain printable characters with no spaces`,
        code: 'not-printable',
        params: { name },
      };
    }
    // Reject the dotenv metacharacters that would round-trip WRONG when written
    // unquoted (# starts a comment, quotes redelimit, $ expands, backslash and
    // backtick are escapes) — so a saved value can never differ from what Node's
    // parseEnv and Vite's expansion read back. Real provider keys never contain
    // these; they are base64url / hex / JWT alphabets.
    if (/[#"'$\\`]/.test(value)) {
      return {
        ok: false,
        error: `${name} contains a character that is not valid in a key (#, quotes, $, \\, or backtick)`,
        code: 'invalid-char',
        params: { name },
      };
    }
    // A few names have a shape of their own (the SMS relay's number, gateway
    // address and ids): refuse what the relay would silently never use.
    const problem = keySetupValueProblem(name, value);
    if (problem) return { ok: false, error: problem };
    updates[name] = value;
  }
  return { ok: true, updates };
}

/**
 * Upsert `KEY=value` lines into dotenv text, disturbing nothing else.
 *
 * Placement, per key: the LAST active assignment is replaced in place (last
 * is what dotenv parsing lets win); failing that, the last commented-out
 * assignment is uncommented in place, so a file copied from .env.example
 * keeps its curated shape; failing both, the line is appended at the end
 * under one shared header. Every untouched line — comments, blanks, other
 * keys — survives byte for byte, and the result always ends in a newline.
 *
 * A `null` value REMOVES: every active assignment for that key is commented
 * back out (`# KEY=`), returning the file to its template shape; a key with
 * no active assignment is left untouched.
 * @param {string} text Existing file content ('' births a new file).
 * @param {Record<string, string|null>} updates Validated {ENV_VAR: value} map.
 */
export function upsertDotenvValues(text, updates) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.length ? source.split(/\r?\n/) : [];
  const additions = [];
  for (const [name, value] of Object.entries(updates)) {
    const active = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
    const commented = new RegExp(`^\\s*#\\s*(?:export\\s+)?${name}\\s*=`);
    if (value === null) {
      lines.forEach((line, index) => {
        if (active.test(line)) lines[index] = `# ${name}=`;
      });
      continue;
    }
    const assignment = `${name}=${value}`;
    let lastActive = -1;
    let lastCommented = -1;
    lines.forEach((line, index) => {
      if (active.test(line)) lastActive = index;
      else if (commented.test(line)) lastCommented = index;
    });
    if (lastActive >= 0) lines[lastActive] = assignment;
    else if (lastCommented >= 0) lines[lastCommented] = assignment;
    else additions.push(assignment);
  }
  if (additions.length) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (!lines.some((line) => line.trim() === KEY_SETUP_APPEND_HEADER)) {
      if (lines.length) lines.push('');
      lines.push(KEY_SETUP_APPEND_HEADER);
    }
    lines.push(...additions);
  }
  const joined = lines.join('\n');
  if (!joined) return '';
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}
