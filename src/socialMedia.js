/**
 * Social Media Analysis: public handles, platform menus, the public-news
 * query, and the one question each button sends. No DOM. A live map marker
 * is this device's own position, and only when a hooked-up account shares
 * that position.
 */

export const SOCIAL_ACCOUNTS_KEY = 'godsEyeView.social.accounts';

/** Included in every question, before and after the operator's note. */
export const SOCIAL_REQUEST_LIMIT =
  'Do not give steps to enter a private account, scrape a platform, bypass a login, or locate a person who has not published where they are.';

const REQUEST_RULES = [
  'Use only information that is already public or already in the scene JSON.',
  'If the scene JSON has no social post, say you cannot see live posts and do not invent posts, names, or locations.',
  'Do not ask for a password, cookie, session, or API key.',
  SOCIAL_REQUEST_LIMIT,
  'Draft words the operator can send. Do not send anything.',
].join(' ');

export const SOCIAL_ANALYSIS_PLATFORMS = Object.freeze([
  Object.freeze({ id: 'all', label: 'All platforms' }),
  Object.freeze({ id: 'facebook', label: 'Facebook' }),
  Object.freeze({ id: 'instagram', label: 'Instagram' }),
  Object.freeze({ id: 'threads', label: 'Threads' }),
  Object.freeze({ id: 'x', label: 'X' }),
  Object.freeze({ id: 'truth', label: 'Truth Social' }),
  Object.freeze({ id: 'snapchat', label: 'Snapchat' }),
  Object.freeze({ id: 'tiktok', label: 'TikTok' }),
]);

export const SOCIAL_NEWS_PLATFORMS = Object.freeze([
  Object.freeze({ id: 'all', label: 'All' }),
  Object.freeze({ id: 'facebook', label: 'Facebook' }),
  Object.freeze({ id: 'instagram', label: 'Instagram' }),
  Object.freeze({ id: 'threads', label: 'Threads' }),
  Object.freeze({ id: 'x', label: 'X' }),
  Object.freeze({ id: 'truth', label: 'Truth Social' }),
  Object.freeze({ id: 'tiktok', label: 'TikTok' }),
]);

export const SOCIAL_LOCATION_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'all',
    label: 'All location options',
    openUrl: null,
    note: '',
  }),
  Object.freeze({
    id: 'find-my',
    label: 'Apple Find My',
    openUrl: 'https://www.icloud.com/find',
    note: 'Share your own location with contacts you choose, for good or for a while.',
  }),
  Object.freeze({
    id: 'google-maps',
    label: 'Google Maps',
    openUrl: 'https://www.google.com/maps',
    note: 'Location Sharing works between iPhone and Android. People you pick see a live icon on their map.',
  }),
  Object.freeze({
    id: 'snap-map',
    label: 'Snapchat Snap Map',
    openUrl: 'https://map.snapchat.com/',
    note: 'Open Snap Map. You see people you already share with.',
  }),
  Object.freeze({
    id: 'bump',
    label: 'Bump',
    openUrl: 'https://apps.apple.com/app/id6471519217',
    note: 'A friend map. Someone appears after you both accept.',
  }),
  Object.freeze({
    id: 'blink',
    label: 'Blink',
    openUrl: 'https://blinkmap.com/',
    note: 'A map of friends who share back. A bump is two phones you are holding.',
  }),
  Object.freeze({
    id: 'life360',
    label: 'Life360',
    openUrl: 'https://www.life360.com/',
    note: 'A circle you create. Members of that circle see it.',
  }),
  Object.freeze({
    id: 'radarly',
    label: 'Radarly',
    openUrl: 'https://apps.apple.com/app/id6451498749',
    note: 'Open Radarly yourself.',
  }),
  Object.freeze({
    id: 'buzzly',
    label: 'Buzzly',
    openUrl: 'https://www.buzzlyapp.com/',
    note: 'People, groups, and events in the area you share.',
  }),
  Object.freeze({
    id: 'vicinity',
    label: 'Vicinity',
    openUrl: 'https://thevicinityapp.com/',
    note: 'Live local chat for a radius you set.',
  }),
  Object.freeze({
    id: 'nearjoy',
    label: 'NearJoy',
    openUrl: 'https://nearjoy.app/',
    note: 'A nearby alert. It does not publish your exact location to other people.',
  }),
  Object.freeze({
    id: 'happn',
    label: 'Happn',
    openUrl: 'https://www.happn.com/',
    note: 'Open your own Happn account.',
  }),
  Object.freeze({
    id: 'pure',
    label: 'Pure',
    openUrl: 'https://pure.app/',
    note: 'Open your own Pure account.',
  }),
  Object.freeze({
    id: 'sniffies',
    label: 'Sniffies',
    openUrl: 'https://sniffies.com/',
    note: 'Open your own Sniffies account.',
  }),
  Object.freeze({
    id: 'instagram-map',
    label: 'Instagram Map',
    openUrl: 'https://www.instagram.com/',
    note: 'Instagram Map is inside Instagram, for people you share with.',
  }),
  Object.freeze({
    id: 'facebook-checkin',
    label: 'Facebook check-ins',
    openUrl: 'https://www.facebook.com/',
    note: 'Public check-ins and one-time place posts.',
  }),
  Object.freeze({
    id: 'instagram-checkin',
    label: 'Instagram check-ins',
    openUrl: 'https://www.instagram.com/',
    note: 'Public place tags and one-time location shares.',
  }),
  Object.freeze({
    id: 'x-checkin',
    label: 'X check-ins',
    openUrl: 'https://x.com/explore',
    note: 'Public posts that name a place.',
  }),
]);

export const SOCIAL_ACCOUNT_PLATFORMS = Object.freeze([
  Object.freeze({
    id: 'facebook',
    label: 'Facebook',
    openUrl: 'https://www.facebook.com/',
    api: 'Graph API (Core)',
    apiUrl: 'https://developers.facebook.com/',
  }),
  Object.freeze({
    id: 'instagram',
    label: 'Instagram',
    openUrl: 'https://www.instagram.com/',
    api: 'Instagram API',
    apiUrl: 'https://developers.facebook.com/docs/instagram-platform/',
    sharesLocation: true,
  }),
  Object.freeze({
    id: 'threads',
    label: 'Threads',
    openUrl: 'https://www.threads.net/',
    api: 'Threads API',
    apiUrl: 'https://developers.facebook.com/docs/threads/',
  }),
  Object.freeze({
    id: 'x',
    label: 'X',
    openUrl: 'https://x.com/',
    api: 'X API v2',
    apiUrl: 'https://developer.x.com/',
  }),
  Object.freeze({
    id: 'truth',
    label: 'Truth Social',
    openUrl: 'https://truthsocial.com/',
  }),
  Object.freeze({
    id: 'snapchat',
    label: 'Snapchat',
    openUrl: 'https://www.snapchat.com/',
    sharesLocation: true,
  }),
  Object.freeze({
    id: 'tiktok',
    label: 'TikTok',
    openUrl: 'https://www.tiktok.com/',
    api: 'TikTok API',
    apiUrl: 'https://developers.tiktok.com/',
  }),
  Object.freeze({
    id: 'find-my',
    label: 'Apple Find My',
    openUrl: 'https://www.icloud.com/find',
    sharesLocation: true,
  }),
  Object.freeze({
    id: 'google-maps',
    label: 'Google Maps',
    openUrl: 'https://www.google.com/maps',
    sharesLocation: true,
  }),
  Object.freeze({
    id: 'bump',
    label: 'Bump',
    openUrl: 'https://apps.apple.com/app/id6471519217',
    sharesLocation: true,
  }),
  Object.freeze({
    id: 'blink',
    label: 'Blink',
    openUrl: 'https://blinkmap.com/',
    sharesLocation: true,
  }),
  Object.freeze({
    id: 'life360',
    label: 'Life360',
    openUrl: 'https://www.life360.com/',
    sharesLocation: true,
  }),
  Object.freeze({
    id: 'radarly',
    label: 'Radarly',
    openUrl: 'https://apps.apple.com/app/id6451498749',
  }),
  Object.freeze({
    id: 'buzzly',
    label: 'Buzzly',
    openUrl: 'https://www.buzzlyapp.com/',
  }),
  Object.freeze({
    id: 'vicinity',
    label: 'Vicinity',
    openUrl: 'https://thevicinityapp.com/',
  }),
  Object.freeze({
    id: 'nearjoy',
    label: 'NearJoy',
    openUrl: 'https://nearjoy.app/',
  }),
  Object.freeze({
    id: 'happn',
    label: 'Happn',
    openUrl: 'https://www.happn.com/',
  }),
  Object.freeze({ id: 'pure', label: 'Pure', openUrl: 'https://pure.app/' }),
  Object.freeze({
    id: 'sniffies',
    label: 'Sniffies',
    openUrl: 'https://sniffies.com/',
  }),
  // The gig economy and on-demand delivery. HELP locations from them, and
  // sending HELP through them with Find Ultra Help, are under development:
  // for now each opens its own site and keeps its login like the others.
  Object.freeze({
    id: 'doordash',
    label: 'DoorDash',
    openUrl: 'https://www.doordash.com/',
    gig: true,
  }),
  Object.freeze({
    id: 'uber',
    label: 'Uber',
    openUrl: 'https://www.uber.com/',
    gig: true,
    api: 'Uber Developers',
    apiUrl: 'https://developer.uber.com/',
  }),
  Object.freeze({
    id: 'lyft',
    label: 'Lyft',
    openUrl: 'https://www.lyft.com/',
    gig: true,
    api: 'Lyft Concierge API',
    apiUrl: 'https://developer.lyft.com/',
  }),
  Object.freeze({
    id: 'just-eat-takeaway',
    label: 'Just Eat Takeaway',
    openUrl: 'https://www.justeattakeaway.com/',
    gig: true,
  }),
  Object.freeze({
    id: 'delivery-hero',
    label: 'Delivery Hero',
    openUrl: 'https://www.deliveryhero.com/',
    gig: true,
  }),
  Object.freeze({
    id: 'grubhub',
    label: 'Grubhub',
    openUrl: 'https://www.grubhub.com/',
    gig: true,
  }),
]);

/**
 * Power Ups: one for each platform in the menu with anything saved, a login,
 * an API key or both (both still count once), out of one per platform.
 * @param {{platform?: string, passwordSaved?: boolean, apiKeySaved?: boolean}[]} rows
 */
export function socialPowerUps(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = SOCIAL_ACCOUNT_PLATFORMS.length;
  let attained = 0;
  for (const item of SOCIAL_ACCOUNT_PLATFORMS) {
    const row = list.find((entry) => entry?.platform === item.id);
    if (row?.passwordSaved === true || (item.api && row?.apiKeySaved === true))
      attained += 1;
  }
  return { attained, total, label: `${attained}/${total} Power Ups Attained` };
}

/** OPEN SAVED's name for each choice in its menu. */
export const SOCIAL_OPEN_SAVED_LABELS = Object.freeze({
  login: 'OPEN ID & PASS SITES',
  api: 'OPEN API SITES',
  all: 'OPEN ALL SAVED SITES',
});

/**
 * The sites OPEN SAVED opens: a saved login opens the platform's own site, a
 * saved API key opens its developer console. 'all' opens both kinds.
 * @param {{platform?: string, passwordSaved?: boolean, apiKeySaved?: boolean}[]} rows
 * @param {'login'|'api'|'all'} kind
 * @returns {{platform: string, label: string, url: string}[]}
 */
export function savedSiteUrls(rows, kind = 'login') {
  const list = Array.isArray(rows) ? rows : [];
  const urls = [];
  for (const item of SOCIAL_ACCOUNT_PLATFORMS) {
    const row = list.find((entry) => entry?.platform === item.id);
    if (!row) continue;
    if (kind !== 'api' && row.passwordSaved === true && item.openUrl) {
      urls.push({ platform: item.id, label: item.label, url: item.openUrl });
    }
    if (kind !== 'login' && row.apiKeySaved === true && item.apiUrl) {
      urls.push({
        platform: item.id,
        label: `${item.label} API`,
        url: item.apiUrl,
      });
    }
  }
  return urls;
}

/** Shown under the account menu when a gig-economy or delivery platform is picked. */
export const SOCIAL_GIG_HELP_NOTE =
  'HELP locations from this platform, and sending HELP through it with Find Ultra Help: under development. OPEN SITE opens its own site.';

/** Missing means show. The operator's hide choice is stored as '0'. */
export const SOCIAL_SHOW_LOCATION_KEY = 'godsEyeView.social.showLocation';

/** This computer's default HELP DELIVERY for the gig and delivery platforms. */
export const SOCIAL_HELP_DELIVERY_KEY = 'godsEyeView.social.helpDelivery';

/**
 * What help a gig or delivery platform would bring. Transportation names
 * where to take the person from their current location; every other kind takes
 * up to two entries of its own.
 */
export const SOCIAL_HELP_DELIVERY_KINDS = Object.freeze([
  Object.freeze({
    id: 'medicine',
    label: 'Medicine',
    entry: 'Medication',
    placeholders: ['Medication 1', 'Medication 2'],
  }),
  Object.freeze({
    id: 'transportation',
    label: 'Transportation',
    destinations: Object.freeze(['home', 'hospital']),
  }),
  Object.freeze({
    id: 'food',
    label: 'Food',
    entry: 'Type of food',
    placeholders: ['Type of food 1', 'Type of food 2'],
  }),
  Object.freeze({
    id: 'liquid',
    label: 'Liquid',
    entry: 'Type of liquid',
    placeholders: ['Type of liquid 1', 'Type of liquid 2'],
  }),
  Object.freeze({
    id: 'items',
    label: 'Items',
    entry: 'Type of item',
    placeholders: ['Item 1, e.g. Heart Defib', 'Item 2'],
  }),
]);

const HELP_ENTRY_MAX = 80;
const HELP_DESTINATIONS = Object.freeze({ home: 'Home', hospital: 'Hospital' });

/**
 * A HELP DELIVERY choice cleaned up: a known kind, and either a destination
 * (Transportation) or up to two short, single-line entries.
 * @returns {{ok: true, value: {kind: string, items: string[], destination: string}} | {ok: false, error: string}}
 */
export function normalizeHelpDelivery(input) {
  const kind = SOCIAL_HELP_DELIVERY_KINDS.find(
    (item) => item.id === input?.kind,
  );
  if (!kind) return { ok: false, error: 'Choose the help to be delivered.' };
  if (kind.destinations) {
    const destination = String(input?.destination || '');
    if (!kind.destinations.includes(destination)) {
      return { ok: false, error: 'Choose Home or Hospital.' };
    }
    return { ok: true, value: { kind: kind.id, items: [], destination } };
  }
  const items = (Array.isArray(input?.items) ? input.items : [])
    .map((value) =>
      String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 2);
  if (!items.length)
    return {
      ok: false,
      error: `Enter at least one ${kind.entry.toLowerCase()}.`,
    };
  if (items.some((value) => value.length > HELP_ENTRY_MAX)) {
    return {
      ok: false,
      error: `Keep each entry under ${HELP_ENTRY_MAX} characters.`,
    };
  }
  return { ok: true, value: { kind: kind.id, items, destination: '' } };
}

/** One line for a saved HELP DELIVERY default, e.g. "Medicine: Insulin, Ventolin". */
export function helpDeliverySummary(value) {
  const checked = normalizeHelpDelivery(value);
  if (!checked.ok) return '';
  const kind = SOCIAL_HELP_DELIVERY_KINDS.find(
    (item) => item.id === checked.value.kind,
  );
  if (kind.destinations) {
    return `${kind.label}: from current location to ${HELP_DESTINATIONS[checked.value.destination]}`;
  }
  return `${kind.label}: ${checked.value.items.join(', ')}`;
}

/** @param {Storage | {getItem: Function} | null | undefined} storage */
export function readHelpDelivery(storage) {
  try {
    const checked = normalizeHelpDelivery(
      JSON.parse(storage?.getItem(SOCIAL_HELP_DELIVERY_KEY) || 'null'),
    );
    return checked.ok ? checked.value : null;
  } catch {
    return null;
  }
}

/** @param {Storage | {setItem: Function} | null | undefined} storage */
export function writeHelpDelivery(storage, input) {
  const checked = normalizeHelpDelivery(input);
  if (!checked.ok) return checked;
  storage?.setItem(SOCIAL_HELP_DELIVERY_KEY, JSON.stringify(checked.value));
  return checked;
}

/**
 * @param {Storage | {getItem: Function} | null | undefined} storage
 * @returns {boolean}
 */
export function readShowLocation(storage) {
  try {
    return storage?.getItem(SOCIAL_SHOW_LOCATION_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * @param {Storage | {setItem: Function} | null | undefined} storage
 * @param {boolean} show
 */
export function writeShowLocation(storage, show) {
  storage?.setItem(SOCIAL_SHOW_LOCATION_KEY, show ? '1' : '0');
}

/**
 * Hooked-up accounts that share the operator's own live position.
 * A public handle is not enough, and a nearby-people app is not one of these.
 * @param {{platform?: string, passwordSaved?: boolean}[]} rows
 * @returns {{platform: string, label: string}[]}
 */
export function locationSharingAccounts(rows) {
  const found = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const platform = SOCIAL_ACCOUNT_PLATFORMS.find(
      (item) => item.id === row?.platform && item.sharesLocation === true,
    );
    if (!platform || row.passwordSaved !== true) continue;
    if (found.some((item) => item.platform === platform.id)) continue;
    found.push({ platform: platform.id, label: platform.label });
  }
  return found;
}

/** @param {{platform?: string, passwordSaved?: boolean}[]} rows */
export function liveLocationLabel(rows) {
  const labels = locationSharingAccounts(rows).map((row) => row.label);
  return labels.length ? `You · ${labels.join(', ')}` : '';
}

/**
 * This device's fix. Latitude, longitude, and accuracy only.
 * @param {object | null | undefined} position
 * @returns {{latitude: number, longitude: number, accuracy: number | null} | null}
 */
export function acceptDeviceFix(position) {
  const coords = position?.coords || position;
  const latitude = Number(coords?.latitude);
  const longitude = Number(coords?.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)
    return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)
    return null;
  const accuracy = Number(coords?.accuracy);
  return {
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
  };
}

/** Breaking News and Search stay on the last week. Analyze uses a month. */
export const SOCIAL_NEWS_LOOKBACK_DAYS = 7;
export const SOCIAL_ANALYSIS_LOOKBACK_DAYS = 30;

/**
 * Public sites a news index can already see. This is not a login and not a
 * feed from the platform.
 */
export const SOCIAL_PUBLIC_SITES = Object.freeze({
  facebook: Object.freeze(['facebook.com']),
  instagram: Object.freeze(['instagram.com']),
  threads: Object.freeze(['threads.net']),
  x: Object.freeze(['x.com', 'twitter.com']),
  truth: Object.freeze(['truthsocial.com']),
  snapchat: Object.freeze(['snapchat.com']),
  tiktok: Object.freeze(['tiktok.com']),
});

const SOCIAL_MENTION_TERMS = Object.freeze({
  facebook: Object.freeze(['Facebook']),
  instagram: Object.freeze(['Instagram']),
  threads: Object.freeze(['Threads']),
  x: Object.freeze(['Twitter', '"X.com"']),
  truth: Object.freeze(['"Truth Social"']),
  snapchat: Object.freeze(['Snapchat']),
  tiktok: Object.freeze(['TikTok']),
});

const SOCIAL_QUERY_MAX = 240;

const HANDLE_PATTERN = /^[\p{L}\p{N}._-]{1,64}$/u;
/** Seven or more digits, with only phone punctuation between them. */
const PHONE_SHAPE = /^\+?(?:\d[\s().-]*){7,}$/;
const SECRET_PATTERN =
  /password|api[_-]?key|bearer|\bsession\b|\bcookie\b|\bsecret\b|\btoken\b/i;
const SECRET_PREFIX = /^(?:sk-|xox[baprs]-|ghp_|ya29\.|eyJ)/;
const NOTE_MAX = 2000;

const LAYOUT = Object.freeze({
  analyze:
    'Use the heading ANALYSIS, then say what is public, what to open, and what you cannot see.',
  news: 'Use the heading BREAKING NEWS, then public reports only. If you cannot see live posts, say so.',
  help: 'Use the heading FIND HELP, then how the operator shares their own location with contacts they choose, the official app to open, and a short message they can send themselves.',
  search: 'Use three headings, in order: ANALYSIS, BREAKING NEWS, FIND HELP.',
});

const KIND = Object.freeze({
  analyze: 'ANALYZE',
  news: 'BREAKING NEWS',
  help: 'FIND HELP',
  search: 'SEARCH',
});

function hostsFrom(list) {
  const hosts = new Set();
  for (const item of list) {
    if (!item.openUrl) continue;
    hosts.add(new URL(item.openUrl).hostname);
  }
  return hosts;
}

const OPEN_HOSTS = new Set([
  ...hostsFrom(SOCIAL_LOCATION_OPTIONS),
  ...hostsFrom(SOCIAL_ACCOUNT_PLATFORMS),
]);

function findOpenOption(id) {
  return (
    SOCIAL_LOCATION_OPTIONS.find((item) => item.id === id) ||
    SOCIAL_ACCOUNT_PLATFORMS.find((item) => item.id === id) ||
    null
  );
}

function labelsFor(catalog, id) {
  if (id === 'all')
    return catalog
      .filter((item) => item.id !== 'all')
      .map((item) => item.label);
  const one = catalog.find((item) => item.id === id);
  return one ? [one.label] : [];
}

function idsFor(catalog, id) {
  if (id === 'all')
    return catalog.filter((item) => item.id !== 'all').map((item) => item.id);
  return catalog.some((item) => item.id === id) ? [id] : [];
}

function cleanNote(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
}

/**
 * A map place used only inside an official https search link.
 * @param {unknown} value
 * @returns {string}
 */
export function cleanPlace(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function coordinate(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number.toFixed(5);
}

function allowHttps(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!OPEN_HOSTS.has(parsed.hostname)) return null;
  if (
    parsed.hostname === 'apps.apple.com' &&
    !/^\/app\/id\d+\/?$/.test(parsed.pathname)
  ) {
    return null;
  }
  return parsed.toString();
}

/**
 * The official site for one menu id. A map view only fills Google Maps,
 * Facebook's public post search, or X's public search. Anything else is
 * refused, including a login, a key, or a host that is not in the catalog.
 * @param {string} id
 * @param {{latitude?: number, longitude?: number, place?: string}} [view]
 * @returns {string|null}
 */
export function officialOpenUrl(id, view = {}) {
  const option = findOpenOption(id);
  if (!option?.openUrl) return null;
  let url = option.openUrl;
  const latitude = coordinate(view.latitude, -90, 90);
  const longitude = coordinate(view.longitude, -180, 180);
  if (id === 'google-maps' && latitude != null && longitude != null) {
    url = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  }
  const place = cleanPlace(view.place);
  if (place && id === 'x-checkin') {
    url = `https://x.com/search?q=${encodeURIComponent(place)}&src=typed_query&f=live`;
  }
  if (place && id === 'facebook-checkin') {
    url = `https://www.facebook.com/search/posts?q=${encodeURIComponent(place)}`;
  }
  return allowHttps(url);
}

/**
 * Keep a public handle. A password, a key, a session, or a login URL is refused.
 * @param {unknown} raw
 * @returns {{ok: true, handle: string}|{ok: false, error: string}}
 */
export function normalizeSocialHandle(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'Type the public handle.' };
  if (/^https?:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, error: 'That link is not a public profile.' };
    }
    if (url.username || url.password) {
      return {
        ok: false,
        error: 'Save a public handle. This box does not take a login.',
      };
    }
    if (/token|key|password|code=/i.test(url.search)) {
      return {
        ok: false,
        error: 'That link carries a key. Paste the public handle only.',
      };
    }
    const parts = url.pathname.split('/').filter(Boolean);
    text = String(parts[parts.length - 1] || '').replace(/^@/u, '');
    if (/\.php$/i.test(text) || text === 'share' || text === 'search') {
      return {
        ok: false,
        error: 'Paste the public handle, not a search page.',
      };
    }
  } else {
    text = text.replace(/^@/u, '');
  }
  // A phone number is a login, never a public handle: kept as one it would go
  // to the news lookup and the model on every press.
  if (PHONE_SHAPE.test(text)) {
    return {
      ok: false,
      error: 'That looks like a phone number. Save a public handle.',
    };
  }
  if (SECRET_PATTERN.test(text) || SECRET_PREFIX.test(text)) {
    return {
      ok: false,
      error: 'Save a public handle. This box does not take passwords or keys.',
    };
  }
  if (!HANDLE_PATTERN.test(text)) {
    return {
      ok: false,
      error:
        'Use a public handle: letters, numbers, dot, underscore, or hyphen.',
    };
  }
  return { ok: true, handle: text };
}

function readStorage(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(SOCIAL_ACCOUNTS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const accounts = [];
    for (const row of parsed) {
      const platform = SOCIAL_ACCOUNT_PLATFORMS.find(
        (item) => item.id === row?.platform,
      );
      const handle = normalizeSocialHandle(row?.handle);
      if (!platform || !handle.ok) continue;
      if (accounts.some((item) => item.platform === platform.id)) continue;
      accounts.push({ platform: platform.id, handle: handle.handle });
    }
    return accounts;
  } catch {
    return [];
  }
}

/**
 * @param {{getItem: Function}} storage
 * @returns {{platform: string, handle: string}[]}
 */
export function readSocialAccounts(storage) {
  if (!storage) return [];
  return readStorage(storage);
}

/**
 * One public handle per platform. A second save for the same platform replaces it.
 * @param {{getItem: Function, setItem: Function}} storage
 * @param {string} platformId
 * @param {unknown} rawHandle
 */
export function saveSocialAccount(storage, platformId, rawHandle) {
  const platform = SOCIAL_ACCOUNT_PLATFORMS.find(
    (item) => item.id === platformId,
  );
  if (!platform) return { ok: false, error: 'Pick a platform.' };
  const handle = normalizeSocialHandle(rawHandle);
  if (!handle.ok) return handle;
  const accounts = readStorage(storage).filter(
    (row) => row.platform !== platform.id,
  );
  accounts.push({ platform: platform.id, handle: handle.handle });
  storage.setItem(SOCIAL_ACCOUNTS_KEY, JSON.stringify(accounts));
  return { ok: true, accounts };
}

/**
 * @param {{getItem: Function, setItem: Function}} storage
 * @param {string} platformId
 */
export function removeSocialAccount(storage, platformId) {
  const accounts = readStorage(storage).filter(
    (row) => row.platform !== platformId,
  );
  storage.setItem(SOCIAL_ACCOUNTS_KEY, JSON.stringify(accounts));
  return accounts;
}

function accountLine(accounts) {
  const parts = [];
  for (const row of Array.isArray(accounts) ? accounts : []) {
    const platform = SOCIAL_ACCOUNT_PLATFORMS.find(
      (item) => item.id === row?.platform,
    );
    const handle = normalizeSocialHandle(row?.handle);
    if (!platform || !handle.ok) continue;
    parts.push(`${platform.label} @${handle.handle}`);
  }
  return parts.length ? parts.join('; ') : 'none saved';
}

/**
 * Platforms a public-news lookup may name. Find Help is not one of them.
 * @param {string} action
 * @param {string} [analysisId]
 * @param {string} [newsId]
 * @returns {string[]}
 */
export function socialSearchPlatforms(action, analysisId, newsId) {
  if (action === 'analyze')
    return idsFor(SOCIAL_ANALYSIS_PLATFORMS, analysisId);
  if (action === 'news') return idsFor(SOCIAL_NEWS_PLATFORMS, newsId);
  if (action === 'search') {
    const ids = [];
    for (const id of [
      ...idsFor(SOCIAL_ANALYSIS_PLATFORMS, analysisId),
      ...idsFor(SOCIAL_NEWS_PLATFORMS, newsId),
    ]) {
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }
  return [];
}

/**
 * Words safe to put in a public news query. A password, a key, or a site
 * operator is left out so it is not sent upstream.
 * @param {unknown} value
 * @returns {string}
 */
export function scrubSocialLookupText(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\\"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (
    SECRET_PATTERN.test(text) ||
    /(?:sk-|xox[baprs]-|ghp_|ya29\.)/i.test(text) ||
    /\beyJ[\w-]{8,}/.test(text)
  ) {
    return '';
  }
  return text
    .replace(/\b(?:site|domain|domainis|inurl|intitle)\s*:/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * `platform:handle` pairs from the public-news query string.
 * @param {unknown} value
 * @returns {{platform: string, handle: string}[]}
 */
export function parseSocialHandleParam(value) {
  const accounts = [];
  for (const part of String(value || '')
    .split(',')
    .slice(0, 12)) {
    const split = part.indexOf(':');
    if (split <= 0) continue;
    accounts.push({
      platform: part.slice(0, split).slice(0, 32),
      handle: part.slice(split + 1).slice(0, 80),
    });
  }
  return accounts;
}

function lookupHandles(accounts, ids) {
  const handles = [];
  for (const row of Array.isArray(accounts) ? accounts : []) {
    if (!ids.includes(row?.platform)) continue;
    const handle = normalizeSocialHandle(row?.handle);
    if (!handle.ok || handles.includes(handle.handle)) continue;
    handles.push(handle.handle);
    if (handles.length >= 4) break;
  }
  return handles;
}

function assembleQuery(required, parts) {
  let text = String(required || '').trim();
  for (const part of parts) {
    if (!part) continue;
    const next = `${text} ${part}`.trim();
    if (next.length <= SOCIAL_QUERY_MAX) text = next;
  }
  return text.slice(0, SOCIAL_QUERY_MAX);
}

function quotePlace(place) {
  return place ? `"${place}"` : '';
}

/**
 * The three public-news queries for one press. Site first, then articles
 * that name the platform, then headlines about the place. Find Help and an
 * unknown platform do not search.
 * @param {{
 *   action?: string,
 *   analysisId?: string,
 *   newsId?: string,
 *   place?: string,
 *   text?: string,
 *   accounts?: {platform: string, handle: string}[],
 * }} [input]
 */
export function buildSocialPublicSearch(input = {}) {
  const action = input.action;
  const ids = socialSearchPlatforms(action, input.analysisId, input.newsId);
  const lookbackDays =
    action === 'analyze'
      ? SOCIAL_ANALYSIS_LOOKBACK_DAYS
      : SOCIAL_NEWS_LOOKBACK_DAYS;
  if (ids.length === 0) {
    return {
      ok: false,
      empty: false,
      error: 'Pick a platform.',
      labels: [],
      lookbackDays: null,
    };
  }
  const place = cleanPlace(input.place)
    .replace(/["\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const note = scrubSocialLookupText(input.text);
  const handles = lookupHandles(input.accounts, ids);
  if (!place && !note && handles.length === 0) {
    return {
      ok: false,
      empty: true,
      error: 'Name a place or type what to look up.',
      labels: [],
      lookbackDays: null,
    };
  }
  const topic =
    note || (action === 'news' || action === 'search' ? 'breaking news' : '');
  const sites = [];
  const mention = [];
  const labels = [];
  for (const id of ids) {
    for (const site of SOCIAL_PUBLIC_SITES[id] || []) {
      if (!sites.includes(site)) sites.push(site);
    }
    for (const term of SOCIAL_MENTION_TERMS[id] || []) {
      if (!mention.includes(term)) mention.push(term);
    }
    const catalog = SOCIAL_ANALYSIS_PLATFORMS.find((item) => item.id === id);
    labels.push(catalog?.label || id);
  }
  const placePart = quotePlace(place);
  const handlePart = handles.length
    ? handles.length === 1
      ? `"${handles[0]}"`
      : `(${handles.map((handle) => `"${handle}"`).join(' OR ')})`
    : '';
  const whenPart = `when:${lookbackDays}d`;
  const siteClause = `(${sites.map((site) => `site:${site}`).join(' OR ')})`;
  const domainClause = `(${sites.map((site) => `domainis:${site}`).join(' OR ')})`;
  const mentionClause = `(${mention.join(' OR ')})`;
  return {
    ok: true,
    empty: false,
    lookbackDays,
    timespan: lookbackDays <= SOCIAL_NEWS_LOOKBACK_DAYS ? '168h' : '1month',
    labels,
    siteQuery: assembleQuery(siteClause, [
      placePart,
      topic,
      whenPart,
      handlePart,
    ]),
    gdeltSiteQuery: assembleQuery(domainClause, [placePart, topic, handlePart]),
    mentionQuery: assembleQuery(mentionClause, [
      placePart,
      topic,
      whenPart,
      handlePart,
    ]),
    gdeltMentionQuery: assembleQuery(mentionClause, [
      placePart,
      topic,
      handlePart,
    ]),
    placeQuery: place ? assembleQuery(placePart, [topic, whenPart]) : '',
    gdeltPlaceQuery: place ? assembleQuery(placePart, [topic]) : '',
  };
}

/**
 * Query string for GET /api/social/public-news. The note is scrubbed here so
 * a password is not put on the URL.
 * @param {{
 *   action?: string,
 *   analysisId?: string,
 *   newsId?: string,
 *   place?: string,
 *   text?: string,
 *   accounts?: {platform: string, handle: string}[],
 * }} input
 * @returns {string}
 */
export function socialPublicNewsPath(input = {}) {
  const ids = socialSearchPlatforms(
    input.action,
    input.analysisId,
    input.newsId,
  );
  const pairs = [];
  for (const row of Array.isArray(input.accounts) ? input.accounts : []) {
    if (!ids.includes(row?.platform)) continue;
    const handle = normalizeSocialHandle(row?.handle);
    if (!handle.ok) continue;
    pairs.push(`${row.platform}:${handle.handle}`);
    if (pairs.length >= 4) break;
  }
  const params = new URLSearchParams({
    action: String(input.action || ''),
    analysis: String(input.analysisId || ''),
    news: String(input.newsId || ''),
    place: cleanPlace(input.place),
    q: scrubSocialLookupText(input.text),
    handles: pairs.join(','),
  });
  return `/api/social/public-news?${params.toString()}`;
}

/**
 * @param {URLSearchParams|{get?: Function}} searchParams
 */
export function readSocialPublicNewsInput(searchParams) {
  const get = (key) => String(searchParams?.get?.(key) || '');
  return {
    action: get('action').slice(0, 16),
    analysisId: get('analysis').slice(0, 32),
    newsId: get('news').slice(0, 32),
    place: get('place').slice(0, 80),
    text: get('q').slice(0, 200),
    accounts: parseSocialHandleParam(get('handles').slice(0, 400)),
  };
}

function safeArticleUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.username || url.password) return '';
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.href.slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Keep only the public fields the panel and the model are allowed to see.
 * @param {object|null|undefined} data
 */
export function normalizePublicNewsReport(data) {
  const empty = {
    status: 'unavailable',
    match: null,
    source: null,
    lookbackDays: null,
    platforms: [],
    articles: [],
  };
  if (!data || typeof data !== 'object') return empty;
  const articles = [];
  for (const row of Array.isArray(data.articles)
    ? data.articles.slice(0, 8)
    : []) {
    const title = cleanNote(row?.title).slice(0, 180);
    const domain = cleanNote(row?.domain).slice(0, 80);
    const url = safeArticleUrl(row?.url);
    if (!title || !url) continue;
    articles.push({
      title,
      domain,
      url,
      publishedAt: cleanNote(row?.publishedAt).slice(0, 40) || null,
    });
  }
  const platforms = [];
  for (const name of Array.isArray(data.platforms)
    ? data.platforms.slice(0, 8)
    : []) {
    const label = cleanNote(name).slice(0, 40);
    if (label) platforms.push(label);
  }
  const status =
    data.status === 'ready' || data.status === 'empty'
      ? data.status
      : 'unavailable';
  const lookback = Number(data.lookbackDays);
  return {
    status: articles.length ? status : status === 'ready' ? 'empty' : status,
    match:
      data.match === 'site' ||
      data.match === 'mention' ||
      data.match === 'place'
        ? data.match
        : null,
    source: cleanNote(data.source).slice(0, 80) || null,
    lookbackDays: Number.isFinite(lookback) ? lookback : null,
    platforms,
    articles,
  };
}

/**
 * What the operator sees in the log before the model answers.
 * @param {object|null|undefined} report
 * @returns {string}
 */
export function formatSocialSearchBody(report) {
  const normalized = normalizePublicNewsReport(report);
  if (normalized.status === 'unavailable') {
    return 'Public news lookup did not finish. No public item was returned.';
  }
  if (!normalized.articles.length) {
    return 'Public news lookup returned nothing. No public item was returned.';
  }
  const via = normalized.source ? ` via ${normalized.source}` : '';
  const days = normalized.lookbackDays
    ? `, past ${normalized.lookbackDays} days`
    : '';
  const kind =
    normalized.match === 'site'
      ? 'Public pages already in the news index'
      : normalized.match === 'mention'
        ? 'Public news that mentions these platforms'
        : 'Public news about this place, not from a platform account';
  const lines = [`${kind}${via}${days} (${normalized.articles.length}):`];
  for (const article of normalized.articles) {
    lines.push(
      article.domain
        ? `- ${article.title} (${article.domain})`
        : `- ${article.title}`,
    );
  }
  return lines.join('\n');
}

function publicNewsBlock(action, report) {
  if (action === 'help') {
    return 'No public-post lookup was run with this question.';
  }
  if (!report) {
    return 'No public item was supplied with this question. Do not invent posts, names, or locations.';
  }
  const normalized = normalizePublicNewsReport(report);
  if (normalized.status === 'unavailable') {
    return 'The public news lookup did not finish. No public item was returned. Do not invent posts, names, or locations.';
  }
  if (!normalized.articles.length) {
    return 'The public news lookup returned nothing. No public item was returned. Do not invent posts, names, or locations.';
  }
  let lead;
  if (normalized.match === 'site') {
    lead =
      'These items are public pages the news index already lists on the named platform sites. They are not a private feed.';
  } else if (normalized.match === 'mention') {
    lead =
      'These items are public news articles that mention the named platforms. They are not posts read from an account.';
  } else {
    const names = normalized.platforms.length
      ? ` Do not describe them as posts on ${normalized.platforms.join(', ')}.`
      : '';
    lead = `These items are public news about the map place. They are not posts from the selected platforms.${names}`;
  }
  const lines = normalized.articles.map((article) => {
    const head = article.domain
      ? `${article.title} (${article.domain})`
      : article.title;
    return `- ${head} ${article.url}`;
  });
  return `${lead}\n${lines.join('\n')}\nUse only these items. Do not invent posts, names, or locations.`;
}

/**
 * One Ask-panel question. The typed note is the analysis, the news question,
 * or the help to send. Search covers the three menus in that one question.
 * Public news items, when the caller has them, are the only posts the model may use.
 * @param {{
 *   action: string,
 *   text?: string,
 *   analysisId?: string,
 *   newsId?: string,
 *   helpId?: string,
 *   accounts?: {platform: string, handle: string}[],
 *   place?: string,
 *   providerId?: string,
 *   publicNews?: object|null,
 * }} input
 */
export function planSocialRequest(input = {}) {
  const action = input.action;
  const kind = KIND[action];
  if (!kind) return { ok: false, error: 'Pick an action.' };
  const provider = String(input.providerId || '').trim();
  if (!provider)
    return { ok: false, error: 'No model key yet. Add one in POWER UP.' };
  const typed = cleanNote(input.text);
  if (typed.length > NOTE_MAX)
    return { ok: false, error: 'That note is too long.' };
  if ((action === 'analyze' || action === 'search') && !typed) {
    return {
      ok: false,
      error:
        action === 'analyze'
          ? 'Type the kind of analysis first.'
          : 'Type what you want searched.',
    };
  }
  const analysis = labelsFor(SOCIAL_ANALYSIS_PLATFORMS, input.analysisId);
  const news = labelsFor(SOCIAL_NEWS_PLATFORMS, input.newsId);
  const help = labelsFor(SOCIAL_LOCATION_OPTIONS, input.helpId);
  if (action === 'analyze' && analysis.length === 0)
    return { ok: false, error: 'Pick a platform.' };
  if (action === 'news' && news.length === 0)
    return { ok: false, error: 'Pick a platform.' };
  if ((action === 'help' || action === 'search') && help.length === 0) {
    return { ok: false, error: 'Pick a location option.' };
  }
  if (action === 'search' && (analysis.length === 0 || news.length === 0)) {
    return { ok: false, error: 'Pick a platform.' };
  }

  let task;
  if (action === 'analyze') {
    task = `Analyze public social activity on ${analysis.join(', ')}. The kind of analysis the operator typed is: ${typed}`;
  } else if (action === 'news') {
    task = `Report public breaking news discussed on ${news.join(', ')}. The operator's question is: ${typed || 'breaking public news near the current map view'}`;
  } else if (action === 'help') {
    task = `The operator wants to send a request for help using these official location products: ${help.join(', ')}. Explain how they share their own location with contacts they choose, or how they look up public check-ins, and draft a short help message. The operator typed: ${typed || 'who can help near this view, and how I send them a request'}`;
  } else {
    task = `Do all three from the operator's note. Analysis platforms: ${analysis.join(', ')}. Breaking-news platforms: ${news.join(', ')}. Location products for sending help: ${help.join(', ')}. Operator note: ${typed}`;
  }
  const place = cleanPlace(input.place);
  // The map point goes with the place name, so every question is anchored
  // to where the operator is looking even when the name is a region.
  const latitude = coordinate(input.latitude, -90, 90);
  const longitude = coordinate(input.longitude, -180, 180);
  const point =
    latitude != null && longitude != null
      ? `${Number(latitude).toFixed(4)}, ${Number(longitude).toFixed(4)}`
      : '';
  const placeLine = place
    ? `Current map place: ${place}${point && point !== place ? ` (${point})` : ''}.`
    : point
      ? `Current map point: ${point}.`
      : 'No place name is on the map yet.';
  const question = [
    REQUEST_RULES,
    task,
    LAYOUT[action],
    `Saved public handles: ${accountLine(input.accounts)}.`,
    placeLine,
    publicNewsBlock(action, input.publicNews),
    REQUEST_RULES,
  ].join('\n\n');
  return { ok: true, provider, kind, question, place: place || null };
}
