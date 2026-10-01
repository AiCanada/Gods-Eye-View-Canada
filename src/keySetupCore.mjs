/**
 * Key setup ("POWER UP") — the pure core.
 *
 * One registry, three pure functions, zero dependencies. The dev server's
 * /api/setup endpoints (vite.config.js) and the in-app panel (keySetup.js)
 * are both thin shells over this module, so what a key is called, what it
 * unlocks, and how a .env line is written each live in exactly one place.
 *
 * Nothing here touches the filesystem, the network, or process.env — callers
 * pass environments in and write text out, which is also what makes every
 * behavior below unit-testable.
 */

/** Longest accepted key/token value. NASA Earthdata Login tokens are JWTs of
 * roughly 700 characters; every other provider key is far shorter. */
export const KEY_SETUP_VALUE_LIMIT = 4096;

/** Most env var NAMES accepted in one save. The registry defines twenty-nine,
 * plus seven optional boxes (the LLM and swarm MODEL ids and the directory
 * write token). */
export const KEY_SETUP_UPDATE_LIMIT = 40;

/** Header line written above keys the panel appends to a .env file. */
export const KEY_SETUP_APPEND_HEADER = '# Keys added by the in-app POWER UP panel';

/**
 * Provider credentials, in display order — most magic per
 * minute first. `tier` mirrors the README's color legend: 'metered' (🔴) is a
 * billing-enabled account, 'free' (🟡) is a register-and-paste key.
 * `clientExposed` marks the two keys that are injected into the browser
 * bundle by design (restrict them at the provider, per SECURITY.md).
 * `hidden` keeps advanced configuration out of the panel and missing-key count.
 */
export const KEY_SETUP_KEYS = Object.freeze([
  Object.freeze({
    id: 'google-maps',
    title: 'GOOGLE MAPS',
    unlocks: 'The photorealistic 3D planet + place search',
    getUrl: 'https://developers.google.com/maps/documentation/tile/get-api-key',
    envVars: Object.freeze(['GOOGLE_MAPS_API_KEY']),
    tier: 'metered',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'google-maps-server',
    title: 'GOOGLE MAPS — SERVER',
    unlocks: 'Places context + Street View fallback; optional separate key',
    getUrl: 'https://developers.google.com/maps/documentation/places/web-service/get-api-key',
    envVars: Object.freeze(['GOOGLE_MAPS_SERVER_API_KEY']),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'openai',
    title: 'OPENAI',
    unlocks: 'Voice control — talk to the planet',
    getUrl: 'https://platform.openai.com/api-keys',
    envVars: Object.freeze(['OPENAI_API_KEY']),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'aisstream',
    title: 'AISSTREAM',
    unlocks: 'Live ships, worldwide',
    getUrl: 'https://aisstream.io',
    envVars: Object.freeze(['AISSTREAM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'firms',
    title: 'NASA FIRMS',
    unlocks: 'Live active-fire detections',
    getUrl: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/',
    envVars: Object.freeze(['FIRMS_MAP_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'tomtom',
    title: 'TOMTOM',
    unlocks: 'Real live traffic (keyless runs a simulation)',
    getUrl: 'https://developer.tomtom.com',
    envVars: Object.freeze(['TOMTOM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'cesium-ion',
    title: 'CESIUM ION',
    unlocks: 'Bing imagery map stacks + world terrain',
    getUrl: 'https://ion.cesium.com/tokens',
    envVars: Object.freeze(['CESIUM_ION_TOKEN']),
    tier: 'free',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'opensky',
    title: 'OPENSKY',
    unlocks: 'More flight-polling credits (anonymous works without)',
    getUrl: 'https://opensky-network.org',
    envVars: Object.freeze(['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'launch-library',
    title: 'LAUNCH LIBRARY',
    unlocks: 'Higher space-missions request allowance',
    getUrl: 'https://thespacedevs.com',
    envVars: Object.freeze(['LL2_API_TOKEN']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'earthdata',
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
    title: 'ROAD511',
    unlocks: 'US traffic cams with no public image: looks one up only when you open that camera',
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
    title: 'NVIDIA NIM',
    unlocks: 'AI Risk & Truth Assessment: typed questions and one-click overviews of the view',
    getUrl: 'https://build.nvidia.com/',
    envVars: Object.freeze(['NVIDIA_API_KEY']),
    optionalEnvVars: Object.freeze([
      Object.freeze({ name: 'NVIDIA_MODEL', label: 'MODEL', placeholder: 'moonshotai/kimi-k3', options: Object.freeze([]) }),
    ]),
    tier: 'free',
  }),
  Object.freeze({
    id: 'xai',
    group: 'llm',
    title: 'xAI GROK',
    unlocks: 'AI Risk & Truth Assessment: adds Grok as a second opinion on the current view',
    getUrl: 'https://console.x.ai/',
    envVars: Object.freeze(['XAI_API_KEY']),
    optionalEnvVars: Object.freeze([
      Object.freeze({ name: 'XAI_MODEL', label: 'MODEL', placeholder: 'grok-4.6', options: Object.freeze([]) }),
    ]),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'anthropic',
    group: 'llm',
    title: 'ANTHROPIC CLAUDE',
    unlocks: 'AI Risk & Truth Assessment: adds Claude as a second opinion on the current view',
    getUrl: 'https://console.anthropic.com/',
    envVars: Object.freeze(['ANTHROPIC_API_KEY']),
    optionalEnvVars: Object.freeze([
      Object.freeze({ name: 'ANTHROPIC_MODEL', label: 'MODEL', placeholder: 'claude-fable-5-1', options: Object.freeze([]) }),
    ]),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'openrouter',
    group: 'llm',
    title: 'OPENROUTER',
    unlocks: 'AI Risk & Truth Assessment: one key that reaches many models; NVIDIA Nemotron 3 Ultra (free) unless another is chosen',
    getUrl: 'https://openrouter.ai/keys',
    envVars: Object.freeze(['OPENROUTER_API_KEY']),
    optionalEnvVars: Object.freeze([
      Object.freeze({
        name: 'OPENROUTER_MODEL',
        label: 'MODEL',
        placeholder: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        // OpenRouter's own ids, read from its model list on 2026-09-27.
        options: Object.freeze([
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
    title: 'CUSTOM LLM',
    unlocks: 'AI Risk & Truth Assessment: any OpenAI-compatible endpoint, local or hosted',
    getUrl: 'https://platform.openai.com/docs/api-reference/chat',
    envVars: Object.freeze(['CUSTOM_LLM_API_KEY', 'CUSTOM_LLM_BASE_URL', 'CUSTOM_LLM_MODEL']),
    tier: 'free',
  }),
  // Social Media Analysis → the bot swarms, each on a key of its own, apart
  // from the Ask panel's xAI key and voice control's OpenAI key. GROK BOT and
  // its Chief of Staff webhook share a group: either one powers GROK BOT
  // SWARM. With neither, the swarm still runs: it opens the Grok Bot desktop
  // app with its task copied, for the Chief of Staff bot.
  Object.freeze({
    id: 'grok-bot',
    group: 'grok-bot',
    title: 'GROK BOT',
    unlocks: 'Social Media → GROK BOT SWARM: seven bots at once on their own xAI key (without one, the task goes to your Chief of Staff bot in Grok Bot)',
    getUrl: 'https://console.x.ai/',
    envVars: Object.freeze(['GROK_BOT_API_KEY']),
    optionalEnvVars: Object.freeze([
      Object.freeze({ name: 'XAI_SWARM_MODEL', label: 'MODEL', placeholder: 'grok-4.6', options: Object.freeze([]) }),
    ]),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'grok-bot-chief-of-staff',
    group: 'grok-bot',
    title: 'GROK BOT — CHIEF OF STAFF',
    unlocks: 'Social Media → GROK BOT SWARM with no API key: each press sends the task to a webhook routine of your Chief of Staff bot in Grok Bot (Routines → When a webhook fires; paste its Webhook URL and Webhook key)',
    getUrl: 'https://docs.x.ai/grok-bot/skills-routines-and-automations',
    envVars: Object.freeze(['GROK_BOT_WEBHOOK_URL', 'GROK_BOT_WEBHOOK_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'openai-dots',
    title: 'OPENAI DOTS',
    unlocks: 'Social Media → OPENAI BOT SWARM: seven bots at once on their own OpenAI key, apart from voice control',
    getUrl: 'https://platform.openai.com/api-keys',
    envVars: Object.freeze(['OPENAI_DOTS_API_KEY']),
    optionalEnvVars: Object.freeze([
      Object.freeze({ name: 'OPENAI_SWARM_MODEL', label: 'MODEL', placeholder: 'gpt-6-astra', options: Object.freeze([]) }),
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
    title: 'SMS RELAY — TWILIO',
    unlocks: "Ultra Security Package: texts a call for help to your own cell and to your saved helpers automatically (costs money per message at Twilio's rate)",
    getUrl: 'https://console.twilio.com',
    envVars: Object.freeze(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER']),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'ultra-sms-relay',
    group: 'ultra-sms',
    title: 'SMS RELAY — YOUR OWN GATEWAY',
    unlocks: 'Ultra Security Package: the same texts through an https gateway you run (it receives JSON { to, body } with a bearer token)',
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
    title: 'HELP NETWORK DIRECTORY',
    unlocks: 'Ultra Security Package → HELP NETWORK: the shared list of help links your group publishes; set it from that box',
    getUrl: 'https://github.com/settings/personal-access-tokens',
    envVars: Object.freeze(['ULTRA_DIRECTORY_URL']),
    optionalEnvVars: Object.freeze([
      Object.freeze({ name: 'ULTRA_DIRECTORY_WRITE_TOKEN', label: 'GITHUB WRITE TOKEN', placeholder: 'github_pat_…', options: Object.freeze([]) }),
    ]),
    tier: 'free',
    hidden: true,
  }),
]);

/** Hostnames a Provider Settings request may arrive under or originate from. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** Socket addresses that count as this machine. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Parse an exact local request authority from a Host header. */
function localAuthority(hostHeader, protocol) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  const scheme = String(protocol || '').toLowerCase();
  if (!raw || !['http:', 'https:'].includes(scheme) || /[\s/?#@]/.test(raw)) return null;
  try {
    const parsed = new URL(`${scheme}//${raw}`);
    return LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase()) ? parsed.origin : null;
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
  const source = String(text || '').replace(/^\uFEFF/, '').trim();
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
 * The admission gate for the Provider Settings endpoints — pure, exported so
 * every refusal below is pinned by a unit assertion rather than a review note.
 *
 * Why each check exists:
 *  - sharing signals: any tunnel/LAN sharing mode disables the surface
 *    outright — a credential-writing endpoint has no business existing on a
 *    shared instance, and tunnel traffic reaches the server FROM loopback, so
 *    the socket check below cannot carry that boundary alone;
 *  - loopback socket: refuses LAN peers when the server is bound wide;
 *  - local Host header: tunnel and DNS-rebinding traffic carries a foreign
 *    Host even when the socket says loopback;
 *  - exact same Origin on POST: a hostile web page can make a browser POST to
 *    localhost, and a non-browser caller must not bypass that boundary merely
 *    by omitting the header;
 *  - JSON Content-Type on POST: forces cross-origin browsers into a CORS
 *    preflight this server never answers, closing the simple-request CSRF
 *    write primitive.
 *
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
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
  const PROXY_SIGNALS = ['forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'cf-ray'];
  if (PROXY_SIGNALS.some((name) => String(proxyHeaders[name] || '').trim() !== '')) {
    return { ok: false, status: 403, error: 'Provider Settings does not answer proxied requests' };
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
  const shareVar = String(env.PINOKIO_SHARE_VAR ?? '').trim();
  const sharingEnabled = ['PINOKIO_SHARE_CLOUDFLARE', 'PINOKIO_SHARE_LOCAL']
    .some((name) => /^(1|true)$/i.test(String(env[name] || '').trim()))
    || (shareVar !== '' && shareVar !== '__gev_sharing_disabled__');
  if (sharingEnabled) {
    return { ok: false, status: 403, error: 'Provider Settings is disabled while sharing is enabled' };
  }
  if (!LOOPBACK_ADDRESSES.has(String(remoteAddress || ''))) {
    return { ok: false, status: 403, error: 'Provider Settings answers only the machine running the server' };
  }
  const authority = localAuthority(hostHeader, protocol);
  if (!authority) {
    return { ok: false, status: 403, error: 'Provider Settings answers only local hostnames' };
  }
  if (method === 'POST' && (origin === undefined || origin === null || origin === '')) {
    return { ok: false, status: 403, error: 'Provider Settings requires an exact local Origin' };
  }
  if (origin !== undefined && origin !== null && origin !== '') {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(String(origin));
    } catch {
      return { ok: false, status: 403, error: 'Unrecognized Origin refused' };
    }
    const exactOrigin = parsedOrigin.username === ''
      && parsedOrigin.password === ''
      && parsedOrigin.pathname === '/'
      && parsedOrigin.search === ''
      && parsedOrigin.hash === ''
      && parsedOrigin.origin === authority;
    if (!exactOrigin) {
      return { ok: false, status: 403, error: 'Cross-origin requests are refused' };
    }
  }
  if (method === 'POST' && !String(contentType || '').toLowerCase().startsWith('application/json')) {
    return { ok: false, status: 415, error: 'Content-Type must be application/json' };
  }
  return { ok: true };
}

/** @returns {Set<string>} every env var the panel is allowed to write. */
export function knownKeySetupEnvVars() {
  const names = new Set();
  for (const entry of KEY_SETUP_KEYS) {
    for (const envVar of entry.envVars) names.add(envVar);
    for (const optional of entry.optionalEnvVars || []) names.add(optional.name);
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
  return octets.every((o) => o <= 255) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
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
  return url.protocol === 'https:' || (url.protocol === 'http:' && smsTailnetLiteral(url.hostname));
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
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return false;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.cursor.sh') && !host.endsWith('.cursor.com')) return false;
  return /^\/automations\/webhook\/[A-Za-z0-9._~%-]{1,200}$/.test(url.pathname);
}

const KEY_SETUP_FORMATS = Object.freeze({
  GROK_BOT_WEBHOOK_URL: [grokBotWebhookUrlOk, "GROK_BOT_WEBHOOK_URL must be the Webhook URL Grok Bot shows for the routine: https://api2.cursor.sh/automations/webhook/…"],
  GROK_BOT_WEBHOOK_KEY: [(v) => SMS_SECRET.test(v), 'GROK_BOT_WEBHOOK_KEY is longer than any real key (512 max)'],
  TWILIO_ACCOUNT_SID: [(v) => /^[A-Za-z0-9]{2,64}$/.test(v), 'TWILIO_ACCOUNT_SID is letters and digits only (it starts AC)'],
  TWILIO_AUTH_TOKEN: [(v) => SMS_SECRET.test(v), 'TWILIO_AUTH_TOKEN is longer than any real token (512 max)'],
  TWILIO_FROM_NUMBER: [(v) => SMS_E164.test(v.replace(/[\s()-]/g, '')), 'TWILIO_FROM_NUMBER needs + and the country code, e.g. +15065550100'],
  ULTRA_SMS_RELAY_URL: [smsRelayUrlOk, 'ULTRA_SMS_RELAY_URL must be https, or http to a 100.64.x.x Tailscale address, with no user:password in it'],
  ULTRA_SMS_RELAY_TOKEN: [(v) => SMS_SECRET.test(v), 'ULTRA_SMS_RELAY_TOKEN is longer than any real token (512 max)'],
});

/**
 * Why a value can never work for this env var, or '' when it can (or when
 * the name has no format beyond a plain key's). The sentence names the
 * rule, never the value.
 */
export function keySetupValueProblem(name, value) {
  const rule = Object.hasOwn(KEY_SETUP_FORMATS, name) ? KEY_SETUP_FORMATS[name] : null;
  return rule && !rule[0](String(value ?? '')) ? rule[1] : '';
}

/** Tooltip guidance for a control gated by one registry entry. */
export function keySetupRequirement(id) {
  const entry = KEY_SETUP_KEYS.find((candidate) => candidate.id === id);
  if (!entry || entry.hidden) return '';
  return `Needs ${entry.envVars.join(' + ')} — add it in Provider Settings`;
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
      (name, i) => values[i].length > 0 && keySetupValueProblem(name, values[i]),
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
 * @param {unknown} body Parsed JSON from the request.
 */
export function validateKeySetupUpdates(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object of {ENV_VAR: value}' };
  }
  const entries = Object.entries(body);
  if (entries.length === 0) return { ok: false, error: 'No keys provided' };
  if (entries.length > KEY_SETUP_UPDATE_LIMIT) {
    return { ok: false, error: `At most ${KEY_SETUP_UPDATE_LIMIT} keys per save` };
  }
  const known = knownKeySetupEnvVars();
  const updates = {};
  for (const [name, raw] of entries) {
    if (!known.has(name)) return { ok: false, error: `Unknown key: ${name}` };
    if (raw === null) {
      updates[name] = null;
      continue;
    }
    if (typeof raw !== 'string') return { ok: false, error: `${name} must be a string` };
    const value = raw.trim();
    if (!value) return { ok: false, error: `${name} is empty` };
    if (value.length > KEY_SETUP_VALUE_LIMIT) {
      return { ok: false, error: `${name} is longer than any real key (${KEY_SETUP_VALUE_LIMIT} max)` };
    }
    if (!/^[\x21-\x7e]+$/.test(value)) {
      return { ok: false, error: `${name} may only contain printable characters with no spaces` };
    }
    // Reject the dotenv metacharacters that would round-trip WRONG when written
    // unquoted (# starts a comment, quotes redelimit, $ expands, backslash and
    // backtick are escapes) — so a saved value can never differ from what Node's
    // parseEnv and Vite's expansion read back. Real provider keys never contain
    // these; they are base64url / hex / JWT alphabets.
    if (/[#"'$\\`]/.test(value)) {
      return { ok: false, error: `${name} contains a character that is not valid in a key (#, quotes, $, \\, or backtick)` };
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
