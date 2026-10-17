/**
 * ULTRA SECURITY PACKAGE box. The options are in the page, in the same
 * control rows as CCTV and Sea Temperature. This module only wires them.
 * The desktop never opens a camera and never sends an SMS itself; the one
 * thing it does with a help message is read it aloud. Everything painted
 * here goes through createElement/textContent, never innerHTML, because
 * inbox rows carry text a stranger typed.
 *
 * SEND HELP posts one loopback request with the incident; the server does
 * the rest. A received call for help (a row of kind 'release') is painted
 * with textContent, spoken, offered as a recipient-free sms: link and pinned
 * by the Your Devices layer, which this box only nudges through two window
 * events. The desktop still never sends an SMS itself: the relay lives in
 * the server, behind explicit keys, and this box only reads its outcome.
 */
import { ULTRA_MEDIA_VIEW_EVENT } from './data/ultraMediaOverlay.js';
import {
  isOwnerRemovalRefusal,
  noteOwnerRemovalRefusal,
  watchOwnerRemoval,
} from './ui/ownerRemoval.js';
import { showUltraMediaInCctv } from './ui/cctvUltraMediaView.js';
import { formatAskLogEntry, prependOutputLog } from './askOverview.js';
import { localDigits, localSay, msgl, tl, tln } from './i18n/index.js';
import {
  ULTRA_POSITION_MAX_AGE_MS,
  ultraCameraRole,
  ultraCustomSkillList,
  ultraHelpSmsLink,
  ultraNeedsSkill,
  ultraNeedsSummary,
} from './ultraHelp.mjs';
import {
  SOCIAL_SWARM_BOTS,
  SOCIAL_SWARM_DEFAULT_PURPOSE,
  SOCIAL_SWARM_PROVIDERS,
  formatSwarmBotLog,
} from './socialSwarm.mjs';
import { formatSwarmDesktopStatus, runSocialSwarm } from './socialSwarmRun.mjs';
import {
  SKILL_CHECK_APP_OPTIONS,
  SKILL_CHECK_APPS_MAX,
  SKILL_CHECK_VERDICTS,
  cleanSkillCheckClaim,
  readPastedUltraTokenSkills,
  skillCheckSwarmChoices,
  skillVerdictWords,
} from './ultraSkillCheck.mjs';
import { readPastedSkillReport, runSkillCheck } from './ultraSkillCheckRun.mjs';
import { initDeviceFeedSetup, ULTRA_PACKAGE_KIND } from './deviceFeedsSetup.js';
import {
  DEVICE_FEEDS_CHANGED_EVENT,
  DEVICE_FEEDS_FOCUS_EVENT,
  DEVICE_FEEDS_HISTORY_EVENT,
  DEVICE_FEEDS_VISIBLE_EVENT,
  DEVICE_HIDDEN_KEY,
  DEVICE_HISTORY_PERIOD_KEY,
  DEVICE_NO_PATH_KEY,
  DEVICE_RECORD_RADIUS_KM,
  DEVICE_RECORD_RADIUS_OPTIONS_KM,
  deviceHiddenIds,
  deviceHistoryPeriod,
  ULTRA_MEDIA_EVENT,
  ULTRA_MEDIA_SELECTED_KEY,
  ultraMediaNames,
} from './deviceFeedsCore.mjs';
/** Where a new Ultra cell is saved: the same route POWER UP's devices use. */
const DEVICE_CONFIG_ENDPOINT = '/api/device-feeds/config';

/** The map layer that draws Ultra holders and their paths (Cell). */
const ULTRA_MAP_LAYER_ID = 'device-feeds';
/** The switch for this machine's own private cameras (Private CCTV Cams). */
const PRIVATE_CAMS_LAYER_ID = 'private-cctv';

const STATUS = '/api/ultra-help/status';
const ENV_ROUTE = '/api/setup/keys';

/* A reload must not replay the whole inbox aloud, so on the first paint
 * every message older than this is marked as already spoken. */
const SPOKEN_SEED_AGE_MS = 10 * 60_000;
const READ_ALOUD_KEY = 'ultra-read-aloud';
const TEXT_BACK_PREFIX = 'Re your help message: ';
const REVOKED_ROWS = 10;
/* A holder whose server polled inside this window is watching right now. */
const WATCHING_MS = 60_000;
/* A quiet link not polled for this long reads OK · STALE instead of WATCHING. */
const NETWORK_STALE_MS = 2 * 60_000;
/* The key-setup route's own sentence, painted verbatim after SAVE DIRECTORY
 * (in the page's words through tl()). */
const ENV_SAVED = msgl(
  'Saved to your local .env. Restarting — this page reloads itself.',
);

const TOKEN_NOTE = {
  unreadable: msgl(
    'The token store exists but cannot be read: fix the file or RESET TOKENS (every link stops working).',
  ),
  'key-invalid': msgl(
    'The token key file is present but not valid: existing tokens still work but cannot be shown or added to; RESET TOKENS to start again.',
  ),
  'no-key': msgl(
    'The token key file is missing: existing tokens still work but cannot be shown or added to; revoke them or RESET TOKENS, then mint again',
  ),
  'key-changed': msgl(
    'The token key file was replaced: existing tokens still work but cannot be shown; revoke them and mint again, or RESET TOKENS.',
  ),
  'key-exposed': msgl(
    'The token key file is no longer restricted to your account: another account on this computer could read it. Restore owner-only access to it, or RESET TOKENS and mint again.',
  ),
  'store-changed': msgl(
    'The token store was changed outside this program: a token row was removed, added or reordered. Check the rows below; minting, revoking or editing a token accepts the file as it is, RESET TOKENS starts again.',
  ),
  'no-listener': msgl(
    'Share links need the report listener: save the package under POWER UP and keep npm run dev running; SHARE shows the bare token until then',
  ),
};

const RELEASE_NOTE = {
  nobody: msgl(
    'Nobody receives this yet: tick Network on GENERATE NEW TOKEN, press NETWORK ON on a token below, or PUBLISH MY TOKEN under HELP NETWORK. The plea still goes to your phone for the PREDEFINED HELP # numbers.',
  ),
  'no-position': msgl(
    'Needs your position: open the phone link on the phone, or press SEND HELP there.',
  ),
};

const NETWORK_NOTE = {
  key: msgl(
    'The token key file is missing or not valid, so the links in your home list cannot be opened or polled: revoke your tokens or RESET TOKENS, then add or UPDATE HOME LIST again',
  ),
  preview: msgl(
    'Polling runs under npm run dev only (vite preview shows the list without checking it)',
  ),
  directory: msgl(
    "Directory: none. Paste your group's directory address (an https file: GitHub, Hugging Face or Private Server) and SAVE DIRECTORY: it is written to your local .env, the dev server restarts and this page reloads. Only https Tail Net links are accepted.",
  ),
  /* The no-directory note's last line, on a line of its own. */
  activate: msgl(
    'Net Work activated when Tail Net + Ultra Encryption Token is released via HELP request.',
  ),
};

/* What a home-list row says about its link. 'quiet' is decided by age. */
const NETWORK_STATE = {
  new: msgl('NOT CHECKED YET'),
  released: msgl('NEEDS HELP'),
  off: msgl('NOT SHARING'),
  dead: msgl('TOKEN DEAD (404)'),
  unreachable: msgl('UNREACHABLE (is their machine on the tailnet?)'),
  busy: msgl('BUSY (429)'),
  'not-tailnet': msgl('NOT A TAILNET ADDRESS'),
  missing: msgl('NOT IN DIRECTORY'),
  moved: msgl('MOVED'),
  own: msgl('YOUR OWN TOKEN'),
  'no-key': msgl('NO KEY'),
  tampered: msgl('TAMPERED'),
};

const ENTRY_NOTE = {
  clipboard: msgl(
    'Send this to whoever keeps the directory, or paste it into the file yourself. Anyone who can read the directory sees where your phone is and threat type while you have pressed SEND HELP and have Network On.',
  ),
  github: msgl(
    'Written to the directory. GitHub serves raw files from a cache, so the others may see it only after about five minutes when they press UPDATE HOME LIST. Anyone who can read the directory sees where your phone is and threat type while you have pressed SEND HELP and have Network On.',
  ),
};

/* The form placeholders as the page ships them, restored when a saved value
 * goes away again (the poll repaints every three seconds). */
const PLACEHOLDER = {
  meName: msgl('Your name, as your holders see it'),
  directoryUrl:
    'https://raw.githubusercontent.com/<group>/<repo>/main/ultra-directory.json',
  directoryToken: msgl('GitHub write token (optional, never shown)'),
  directoryTokenSaved: msgl(
    'write token saved — paste to replace, never shown',
  ),
};

/* What a token row and the reveal box say when the skills are sealed under
 * a key this machine does not hold (missing, invalid or replaced). Distinct
 * from an encrypted token minted with no skill sets, which the key opens. */
const SKILLS_HIDDEN_WORD = msgl('SKILLS HIDDEN (KEY MISSING OR CHANGED)');
const SKILLS_HIDDEN_LINE = msgl(
  'Skills hidden: the token key is missing or was changed, so the sealed skill sets cannot be shown',
);

/* How long the last action's sentence survives the status poll. */
const NOTICE_MS = 15_000;
/** What the token button says: at rest, while a token is made, and just after. */
const MINT_LABEL = Object.freeze({
  idle: msgl('GENERATE NEW TOKEN'),
  busy: msgl('GENERATING…'),
  done: msgl('GENERATED'),
});
const MINT_DONE_MS = 2_000;
/** DELETE asks once; a second press within this long deletes. */
const ULTRA_MEDIA_DELETE_CONFIRM_MS = 4_000;
/** This browser's PHOTOS ON MAP and VIDEOS ON MAP ticks: {photos, videos}. */
const ULTRA_MEDIA_ON_MAP_KEY = 'ultra-media-on-map';
const MEDIA_ON_MAP_BOXES = Object.freeze({
  photos: 'ultra-photos-on-map',
  videos: 'ultra-videos-on-map',
});

/* The ADD form's own placeholders, restored when RENAME lets go of it. A
 * handout is two things now, an address and a token, never one link. */
const ADD_ADDRESS_PLACEHOLDER = msgl(
  'Their tailnet address (https://<machine>.<tailnet>.ts.net)',
);
const ADD_TOKEN_PLACEHOLDER = msgl('Their Ultra Token (uht1.…)');
const ADD_RENAMING_PLACEHOLDER = msgl(
  'Renaming — enter an address and token to add one instead',
);
const ADD_INCOMPLETE = msgl(
  'Enter their tailnet address (https://….ts.net) and their Ultra Token (uht1.…)',
);
/* The shape of an Ultra Token as the panel needs it: enough to tell a token
 * from a path segment when a legacy whole link lands in the address box.
 * The server checks the real pattern; this one only decides where to split. */
const TOKEN_SHAPE = /^uht1\.[A-Za-z0-9_-]{43}(?:\.[se]\.[A-Za-z0-9_.-]+)?$/;

/**
 * The owner pasted a legacy whole link (https://host/ultra/help/uht1.…)
 * into the address box and left the token box empty: split it here, so the
 * combined string is never posted. Anything else comes back unchanged, and
 * the server says what is wrong with it.
 */
export function splitUltraHandout(address, token) {
  const given = String(address || '').trim();
  const held = String(token || '').trim();
  if (held || !given) return { address: given, token: held };
  let url;
  try {
    url = new URL(given);
  } catch {
    return { address: given, token: held };
  }
  const parts = url.pathname.replace(/\/+$/, '').split('/');
  const last = parts[parts.length - 1] || '';
  if (parts.length < 2 || !TOKEN_SHAPE.test(last)) {
    return { address: given, token: held };
  }
  return { address: url.origin, token: last };
}

/* Message ids already read aloud (or deliberately skipped). Module-scoped so
 * a panel re-init inside one page load does not repeat them. */
const spoken = new Set();
/* Release rows whose end ('stood down') was already spoken, or seeded. */
const stoodDown = new Set();
let spokenSeeded = false;
/* When the box first saw a new call for help whose street the server was
 * still looking up (`placing`). Its voice waits for the address, but never
 * longer than this: one whole five-second lookup plus the one-second
 * spacing between lookups. */
const firstHeard = new Map();
const PLACE_WAIT_MS = 6_000;
/* Inbox row ids of active calls for help already handed to the map layer. */
const pinned = new Set();
/* What each list of rows last showed, row by row (see replaceRows): each
 * row's key, its node and its shape. Kept here rather than in a data-
 * attribute, so the inbox's message text is not copied into the page a
 * second time. */
const shownRows = new WeakMap();

function byId(documentRef, id) {
  return documentRef.getElementById(id);
}

function button(documentRef, text, data = {}) {
  const item = documentRef.createElement('button');
  item.type = 'button';
  item.className = 'scene-btn';
  item.textContent = text;
  for (const [key, value] of Object.entries(data)) item.dataset[key] = value;
  return item;
}

/* What a painted row shows and does, enough to tell whether a repaint would
 * change anything: tag, class, data-*, link, title, hidden and the text of
 * each leaf. */
function nodeShape(node) {
  const children = Array.from(node.children || []);
  return [
    node.tagName,
    node.className,
    { ...node.dataset },
    node.href || '',
    node.title || '',
    node.hidden === true,
    children.length ? '' : node.textContent,
    children.map(nodeShape),
  ];
}

/* A button's or link's identity inside its row across a repaint: what it
 * acts on, not whether it is on or off just now, so a toggle pressed from
 * the keyboard keeps the focus. */
function controlKey(node) {
  const acts = { ...node?.dataset };
  delete acts.ultraCurrent;
  return JSON.stringify(acts);
}

/* The poll repaints every three seconds. Swapping a row that did not change
 * would drop the focus from its buttons and links and lose a click pressed
 * across the swap, so each row, keyed by the message, token, home-list entry
 * or helper it shows, is swapped only when it would look or act
 * differently; the rows around it stay as they are. `rows` is a list of
 * [key, node] pairs in the order they are shown.
 *
 * Only a control that was focused inside a row taken out just now is
 * focused again, in that row's new node, and never with a scroll: a
 * mouse-clicked button keeps the focus while the owner scrolls the box to
 * read something else, and the box must not jump back to it. */
function replaceRows(documentRef, list, rows) {
  const before = shownRows.get(list) || new Map();
  const after = new Map();
  const nodes = [];
  for (const [id, fresh] of rows) {
    let key = String(id ?? '');
    for (let copy = 2; after.has(key); copy += 1) key = `${id}#${copy}`;
    const shape = JSON.stringify(nodeShape(fresh));
    const old = before.get(key);
    const node =
      old && old.shape === shape && old.node.parentElement === list
        ? old.node
        : fresh;
    after.set(key, { node, shape });
    nodes.push(node);
  }
  shownRows.set(list, after);
  /* A real HTMLCollection has no .every or .find. */
  const current = Array.from(list.children || []);
  if (
    current.length === nodes.length &&
    current.every((node, at) => node === nodes[at])
  ) {
    return;
  }
  const active = documentRef.activeElement;
  const holder =
    active && active !== list && list.contains?.(active)
      ? current.find((node) => node.contains?.(active))
      : null;
  const holderKey = holder
    ? Array.from(before).find(([, shown]) => shown.node === holder)?.[0]
    : undefined;
  const kept = new Set(nodes);
  for (const node of current) if (!kept.has(node)) node.remove();
  nodes.forEach((node, at) => {
    if (list.children[at] !== node) {
      list.insertBefore(node, list.children[at] || null);
    }
  });
  /* The focus stayed where it was: its row was neither swapped nor moved. */
  if (holderKey === undefined || documentRef.activeElement === active) return;
  const control = controlKey(active);
  const row = after.get(holderKey)?.node;
  if (!row || control === '{}') return;
  Array.from(row.querySelectorAll('button, a'))
    .find((node) => controlKey(node) === control)
    ?.focus?.({ preventScroll: true });
}

function clockTime(at) {
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return '--:--';
  return when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** When a skill check ran: day and time, since it can be weeks old. */
function checkedWhen(at) {
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return '';
  return when.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The CONFIRM ULTRA TOKEN SKILLS verdicts as list rows: the verdict, the
 * reason, and a link for each public source behind it.
 */
export function paintSkillVerdicts(documentRef, list, verdicts) {
  if (!list) return;
  const rows = (Array.isArray(verdicts) ? verdicts : []).map((row) => {
    const li = documentRef.createElement('li');
    li.dataset.verdict = String(row?.verdict || 'none');
    const words = documentRef.createElement('span');
    words.textContent = [skillVerdictWords(row), tl(row?.reason || '')]
      .filter(Boolean)
      .join(' · ');
    li.appendChild(words);
    (Array.isArray(row?.links) ? row.links : []).forEach((url, index) => {
      const link = documentRef.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = ` ${tl('SOURCE {number}', { number: index + 1 })}`;
      link.title = url;
      li.appendChild(link);
    });
    return li;
  });
  list.replaceChildren(...rows);
}

function skillCheckAppBoxes(documentRef) {
  const box = byId(documentRef, 'ultra-skill-check-apps');
  return Array.from(box?.querySelectorAll?.('input[type="checkbox"]') || []);
}

/** Fill Apps to search with the known sites, once. */
function paintSkillCheckApps(documentRef) {
  const box = byId(documentRef, 'ultra-skill-check-apps');
  if (!box || box.dataset.ultraAppsReady === '1') return;
  const heading = documentRef.createElement('span');
  heading.className = 'cctv-summary-label';
  heading.textContent = tl('Apps to search');
  const options = SKILL_CHECK_APP_OPTIONS.map((option) => {
    const label = documentRef.createElement('label');
    label.className = 'ultra-match';
    const input = documentRef.createElement('input');
    input.type = 'checkbox';
    input.id = `ultra-skill-check-app-${String(option.id).replace(/\s+/g, '-')}`;
    input.value = option.label;
    input.dataset.ultraSkillCheckApp = option.id;
    input.title = tl('Search {app} for the claimed skills', {
      app: tl(option.label),
    });
    const name = documentRef.createElement('span');
    name.textContent = tl(option.label);
    label.append(input, name);
    return label;
  });
  box.replaceChildren(heading, ...options);
  box.dataset.ultraAppsReady = '1';
}

function syncSkillCheckAppLimit(documentRef) {
  const boxes = skillCheckAppBoxes(documentRef);
  const full =
    boxes.filter((input) => input.checked).length >= SKILL_CHECK_APPS_MAX;
  for (const input of boxes) {
    if (!input.checked) input.disabled = full;
  }
}

function clearSkillCheckApps(documentRef) {
  for (const input of skillCheckAppBoxes(documentRef)) input.checked = false;
  syncSkillCheckAppLimit(documentRef);
}

function readSkillCheckApps(documentRef) {
  return skillCheckAppBoxes(documentRef)
    .filter((input) => input.checked)
    .map((input) => String(input.value || '').trim())
    .filter(Boolean)
    .join(', ');
}

function skillCheckLlm(provider) {
  const value = String(provider || '');
  return value === 'llm' || value.startsWith('llm:');
}

/** GROK BOT SWARM, OPENAI DOT SWARM, and LLM from POWER UP's Ask roster. */
function paintSkillCheckSwarm(documentRef, providers) {
  const select = byId(documentRef, 'ultra-skill-check-swarm');
  if (!select) return;
  const current = String(select.value || '');
  const choices = skillCheckSwarmChoices(providers);
  const options = choices.map((choice) => {
    const option = documentRef.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    return option;
  });
  select.replaceChildren(...options);
  const allowed = new Set(choices.map((choice) => choice.value));
  select.value = allowed.has(current) ? current : 'xai';
}

async function loadSkillCheckSwarm(documentRef, fetchImpl) {
  let providers = [];
  try {
    const response = await fetchImpl('/api/llm/providers', {
      headers: { Accept: 'application/json' },
    });
    const data = await response?.json?.().catch?.(() => null);
    providers = Array.isArray(data?.providers) ? data.providers : [];
  } catch {
    providers = [];
  }
  paintSkillCheckSwarm(documentRef, providers);
}

/** The CONFIRM ULTRA TOKEN SKILLS form's fields, as typed. */
export function readSkillCheckForm(documentRef) {
  const value = (id) => String(byId(documentRef, id)?.value ?? '');
  return {
    skills: value('ultra-skill-check-skills'),
    name: value('ultra-skill-check-name'),
    alias: value('ultra-skill-check-alias'),
    location: value('ultra-skill-check-location'),
    age: value('ultra-skill-check-age'),
    sex: value('ultra-skill-check-sex'),
    profession: value('ultra-skill-check-profession'),
    urls: value('ultra-skill-check-urls').split(/\s*\n\s*/),
    apps: readSkillCheckApps(documentRef),
  };
}

/** "2 CONFIRMED · 1 NO CONFIRMATION · 0 REJECTED CLAIM" */
export function skillCheckTally(verdicts) {
  const list = Array.isArray(verdicts) ? verdicts : [];
  return Object.entries(SKILL_CHECK_VERDICTS)
    .map(
      ([id, word]) =>
        `${list.filter((row) => row?.verdict === id).length} ${tl(word)}`,
    )
    .join(' · ');
}

function dayDate(at) {
  const when = new Date(at);
  return Number.isFinite(when.getTime()) ? when.toLocaleDateString() : '';
}

/** 1 holder, 3 holders. */
function holdersCount(count) {
  return tln(count, '{count} holder', '{count} holders');
}

function setClass(element, name, on) {
  if (!element?.classList) return;
  if (on) element.classList.add(name);
  else element.classList.remove(name);
}

function hasPosition(item) {
  return Number.isFinite(item?.lat) && Number.isFinite(item?.lon);
}

/** The tokens whose holders receive SEND HELP: live, with a package, NETWORK on. */
function networkTokens(status) {
  const tokens = Array.isArray(status?.tokens) ? status.tokens : [];
  return tokens.filter(
    (token) => token && !token.revokedAt && !token.orphaned && token.network,
  );
}

/**
 * What a call asks to be brought (HELP DELIVERY, saved on the Social Media
 * tab) and, when that is a skill such as Transportation, how many of the
 * holders who receive it have that skill on their token. '' when none.
 */
export function ultraNeedsLine(needs, holders = []) {
  const summary = ultraNeedsSummary(needs, localSay);
  if (!summary) return '';
  const skill = ultraNeedsSkill(needs);
  if (!skill) return tl('Asks for {needs}.', { needs: summary });
  const skilled = holders.filter(
    (token) =>
      Array.isArray(token?.skills) &&
      token.skills.some((item) => item?.code === skill),
  ).length;
  return tl('Asks for {needs} · {holders} with that skill.', {
    needs: summary,
    holders: holdersCount(skilled),
  });
}

/** Received calls for help still running, newest first. */
function activeReleases(status) {
  const inbox = Array.isArray(status?.inbox) ? status.inbox : [];
  return inbox
    .filter((row) => row?.kind === 'release' && row.active === true)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
}

/** The live calls for help the status carries, one per package. */
function runningReleases(status) {
  return Array.isArray(status?.releases)
    ? status.releases.filter((item) => item && typeof item === 'object')
    : [];
}

/**
 * The package SEND HELP, EXTEND HELP and STAND DOWN act on, shown only when
 * more than one is saved: each package has its own call, so a press for one
 * must never renew or end another's. It keeps the owner's choice across
 * the poll and starts on the newest call running, else the first package.
 */
function paintReleasePackage(documentRef, status) {
  const select = byId(documentRef, 'ultra-release-package');
  if (!select) return;
  const packages = Array.isArray(status?.packages) ? status.packages : [];
  const running = runningReleases(status);
  /* A call whose package the device store does not show just now is still a
   * choice: it can be stood down, never pressed for. */
  const choices = [
    ...packages.map((feed) => ({
      id: feed.id,
      name: feed.name,
      removed: false,
    })),
    ...running
      .filter((item) => !packages.some((feed) => feed.id === item.feedId))
      .map((item) => ({ id: item.feedId, name: item.name, removed: true })),
  ];
  const current = select.value;
  /* Rebuilding the options tears down an open popup, and this paints every
   * three seconds: leave the DOM alone unless the choices really changed. */
  const shape = choices
    .map((choice) => {
      const live = running.some((item) => item.feedId === choice.id);
      return `${choice.id}:${choice.name}:${live}:${choice.removed}`;
    })
    .join('|');
  if (select.dataset.ultraShape !== shape) {
    select.dataset.ultraShape = shape;
    select.replaceChildren();
    for (const choice of choices) {
      const option = documentRef.createElement('option');
      option.value = choice.id;
      const live = running.some((item) => item.feedId === choice.id);
      option.textContent = `${choice.name || choice.id}${choice.removed ? ` · ${tl('REMOVED')}` : ''}${live ? ` · ${tl('HELP ON')}` : ''}`;
      select.appendChild(option);
    }
    const newest = [...running].sort(
      (a, b) => (Number(b.renewedAt) || 0) - (Number(a.renewedAt) || 0),
    )[0];
    const offered = (id) => choices.some((choice) => choice.id === id);
    /* Until the owner picks a package, the box follows the newest call, so
     * a call that starts after it opened is the one its buttons act on. */
    const picked = select.dataset.ultraPicked === '1' && offered(current);
    if (picked) select.value = current;
    else if (newest && offered(newest.feedId)) select.value = newest.feedId;
    else if (offered(current)) select.value = current;
    else if (choices.length) select.value = choices[0].id;
  }
  select.hidden = choices.length <= 1;
}

/**
 * Which package a new DIRECTORY TOKEN follows: shown only with more than one
 * package saved and DIRECTORY TOKEN chosen, since the server never guesses
 * whose position a standing directory entry subscribes the group to.
 */
function paintPublishPackage(documentRef, status) {
  const select = byId(documentRef, 'ultra-publish-package');
  if (!select) return;
  const packages = Array.isArray(status?.packages) ? status.packages : [];
  const current = select.value;
  const shape = packages.map((feed) => `${feed.id}:${feed.name}`).join('|');
  if (select.dataset.ultraShape !== shape) {
    select.dataset.ultraShape = shape;
    select.replaceChildren();
    for (const feed of packages) {
      const option = documentRef.createElement('option');
      option.value = feed.id;
      option.textContent = tl('FOR {name}', { name: feed.name || feed.id });
      select.appendChild(option);
    }
    if (packages.some((feed) => feed.id === current)) select.value = current;
    else if (packages.length) select.value = packages[0].id;
  }
  const token = byId(documentRef, 'ultra-publish-token');
  select.hidden = packages.length <= 1 || Boolean(token?.value);
}

/** The package the SEND HELP block is showing, or '' when only one is saved. */
function chosenReleasePackage(documentRef) {
  const select = byId(documentRef, 'ultra-release-package');
  return select && !select.hidden ? String(select.value || '') : '';
}

/** The call running for that package (or the only one, with none chosen), else null. */
function releaseFor(status, chosen) {
  if (chosen)
    return (
      runningReleases(status).find((item) => item.feedId === chosen) || null
    );
  return status?.release && typeof status.release === 'object'
    ? status.release
    : null;
}

function paintRelease(documentRef, status, now = Date.now()) {
  const chosen = chosenReleasePackage(documentRef);
  const running = runningReleases(status);
  const release = releaseFor(status, chosen);
  const holdersList = networkTokens(status).filter(
    (token) => !chosen || token.feedId === chosen,
  );
  const holders =
    release && Number.isFinite(release.holders)
      ? release.holders
      : holdersList.length;
  const watching =
    release && Number.isFinite(release.watching)
      ? release.watching
      : holdersList.filter(
          (token) =>
            Number.isFinite(token.watchedAt) &&
            now - token.watchedAt <= WATCHING_MS,
        ).length;
  const state = byId(documentRef, 'ultra-release-state');
  if (state) {
    state.textContent = release
      ? `· ${tl('ON UNTIL {time}', { time: clockTime(release.until) })}`
      : '';
    setClass(state, 'ultra-release-on', Boolean(release));
  }
  const send = byId(documentRef, 'ultra-release-send');
  if (send) {
    send.textContent = release ? tl('EXTEND HELP') : tl('SEND HELP');
    /* A package the store does not show can only be stood down. */
    send.hidden = release?.removed === true;
  }
  const note = byId(documentRef, 'ultra-release-note');
  if (note) {
    /* Another package asking for help at the same time is said, never hidden. */
    const others = running
      .filter((item) => item.feedId !== (release?.feedId ?? chosen))
      .map((item) => String(item.name || item.feedId || 'Ultra'));
    const also =
      chosen && others.length
        ? ` · ${tl('ALSO ASKING FOR HELP: {names}', { names: others.join(', ') })}`
        : '';
    if (release) {
      const outcome = String(release.sms?.outcome || '');
      const asks = ultraNeedsLine(release.needs, holdersList);
      note.textContent = `${tl(
        'HELP SENT {at} · {holders} · {watching} watching · until {until} · EXTEND HELP renews four hours',
        {
          at: clockTime(release.at),
          holders: holdersCount(holders),
          watching,
          until: clockTime(release.until),
        },
      )}${outcome ? ` · ${tl(outcome)}` : ''}${also}${asks ? ` · ${asks}` : ''}`;
    } else if (also) {
      note.textContent = `${tl('Nothing sent for this package')}${also}`;
    } else if (holdersList.length === 0) {
      note.textContent = tl(RELEASE_NOTE.nobody);
    } else if (!status?.position) {
      note.textContent = tl(RELEASE_NOTE['no-position']);
    } else {
      const incident = String(
        byId(documentRef, 'ultra-incident')?.value || 'other',
      ).toUpperCase();
      const contacts = Array.isArray(status?.contacts)
        ? status.contacts.length
        : 0;
      const asks = ultraNeedsLine(status?.ownerNeeds, holdersList);
      note.textContent = `${tln(
        contacts,
        "Sends your phone's position, the incident classification and any items or skills needed to encrypted Ultra Token holders for four hours, or until STAND DOWN, and hands your phone one tap that texts the Help to {count} saved helper. {watching} watching now.",
        "Sends your phone's position, the incident classification and any items or skills needed to encrypted Ultra Token holders for four hours, or until STAND DOWN, and hands your phone one tap that texts the Help to {count} saved helpers. {watching} watching now.",
        { watching },
      )}${asks ? ` ${asks}` : ''}`;
    }
  }
  const plea = byId(documentRef, 'ultra-release-plea');
  if (plea) {
    const text = release ? String(release.plea || '') : '';
    plea.textContent = text ? tl('Plea: {text}', { text }) : '';
    plea.hidden = !text;
  }
}

function paintReleaseRow(documentRef, message, isUnread) {
  const row = documentRef.createElement('div');
  row.className = 'cctv-controls ultra-inbox-row ultra-release-row';
  row.dataset.unread = isUnread ? '1' : '0';
  const active = message.active === true;
  row.dataset.active = active ? '1' : '0';
  const from = String(message.from || message.label || tl('someone'));
  /* The server fills `place` with the street address, or the coordinates
   * alone when it was offline; the fallback here is for a row written before
   * the geocode answered. */
  const place =
    String(message.place || '').trim() ||
    (hasPosition(message)
      ? `${message.lat.toFixed(4)}, ${message.lon.toFixed(4)}`
      : tl('position unknown'));
  const distance = Number.isFinite(message.distanceKm)
    ? ` · ${tl('{km} KM', { km: localDigits(message.distanceKm < 10 ? message.distanceKm.toFixed(1) : Math.round(message.distanceKm)) })}`
    : '';
  const ended = active
    ? ''
    : ` · ${tl('ENDED {time}', { time: clockTime(message.until) })}`;
  const sms = message.sms ? ` · ${tl(message.sms)}` : '';
  const readout = documentRef.createElement('span');
  readout.className = 'sst-readout';
  readout.textContent = `${tl('{name} · NEEDS HELP · {place} · {time}', {
    name: from.toUpperCase(),
    place,
    time: clockTime(message.at),
  })}${distance}${ended}${sms}`;
  row.appendChild(readout);
  const pleaLine = documentRef.createElement('span');
  pleaLine.className = 'sst-readout ultra-plea';
  pleaLine.textContent = String(message.text || '');
  row.appendChild(pleaLine);
  if (isUnread) {
    row.appendChild(
      button(documentRef, tl('READ'), { ultraInboxRead: message.id }),
    );
  }
  /* Recipient-free on purpose: the helper forwards the plea to 911 or a
   * neighbour from their own phone. Nothing here ever addresses the victim's
   * cell, and the row carries no number at all. */
  const open = documentRef.createElement('a');
  open.className = 'scene-btn';
  open.href = ultraHelpSmsLink('', message.text || '');
  open.rel = 'noopener';
  open.textContent = tl('OPEN IN SMS');
  open.dataset.ultraOpenSms = '1';
  row.appendChild(open);
  if (active && hasPosition(message) && message.networkId) {
    row.appendChild(
      button(documentRef, tl('MAP'), { ultraNetworkMap: message.networkId }),
    );
  }
  row.appendChild(
    button(documentRef, tl('REMOVE'), { ultraInboxRemove: message.id }),
  );
  return row;
}

function paintInbox(documentRef, status) {
  const inbox = byId(documentRef, 'ultra-inbox');
  const count = byId(documentRef, 'ultra-inbox-count');
  const unread = Number(status?.unread) || 0;
  if (count) {
    count.textContent =
      unread > 0 ? `· ${tln(unread, '{count} NEW', '{count} NEW')}` : '';
    setClass(count.parentElement, 'ultra-unread', unread > 0);
  }
  if (!inbox) return;
  const rows = [];
  for (const message of status?.inbox || []) {
    const isUnread = !message.readAt;
    if (message.kind === 'release') {
      rows.push([message.id, paintReleaseRow(documentRef, message, isUnread)]);
      continue;
    }
    const row = documentRef.createElement('div');
    row.className = 'cctv-controls ultra-inbox-row';
    row.dataset.unread = isUnread ? '1' : '0';
    const readout = documentRef.createElement('span');
    readout.className = 'sst-readout';
    const where = hasPosition(message)
      ? ` · ${tl('at {point}', { point: `${message.lat.toFixed(4)}, ${message.lon.toFixed(4)}` })}`
      : '';
    /* The reply number is part of the readout, so the owner sees whom TEXT
     * BACK would reach before the SMS app opens on it. */
    const reply = message.number ? ` (${message.number})` : '';
    readout.textContent = `${clockTime(message.at)} · ${message.label || tl('token')} · ${tl('{from}: {text}', { from: `${message.from || tl('someone')}${reply}`, text: message.text || '' })}${where}`;
    row.appendChild(readout);
    if (isUnread) {
      row.appendChild(
        button(documentRef, tl('READ'), { ultraInboxRead: message.id }),
      );
    }
    /* The server only stores a number it validated as E.164; anything else
     * arrives as '' and gets no link, so a holder cannot plant an href. */
    const textBack = message.number
      ? ultraHelpSmsLink(message.number, TEXT_BACK_PREFIX)
      : '';
    if (textBack) {
      const anchor = documentRef.createElement('a');
      anchor.className = 'scene-btn';
      anchor.href = textBack;
      anchor.rel = 'noopener';
      anchor.textContent = tl('TEXT BACK');
      anchor.title = tl('Text {number}', { number: message.number });
      anchor.dataset.ultraTextBack = '1';
      row.appendChild(anchor);
    }
    row.appendChild(
      button(documentRef, tl('REMOVE'), { ultraInboxRemove: message.id }),
    );
    rows.push([message.id, row]);
  }
  replaceRows(documentRef, inbox, rows);
}

function paintTokenNote(documentRef, status) {
  const note = byId(documentRef, 'ultra-token-note');
  if (!note) return;
  const store = status?.tokenStore || 'ok';
  if (TOKEN_NOTE[store]) {
    note.textContent = tl(TOKEN_NOTE[store]);
  } else if (!status?.helpBase) {
    note.textContent = tl(TOKEN_NOTE['no-listener']);
  } else {
    /* A Network token works only over Tailscale: say which address the
     * holders enter it beside, or that there is none yet, rather than
     * promise a LAN address works. `networkBase` is the bare origin. */
    const network = status?.networkBase
      ? tl('Your tailnet address for holders: {address}', {
          address: status.networkBase,
        })
      : tl(
          'This machine has no tailnet address yet, so a Network token cannot reach another GEVC.',
        );
    note.textContent = `${tl(
      "Only when Network is on and SEND HELP is pressed, GENERATE NEW TOKEN creates an Ultra Token other GEVC users enter beside your tailnet address to receive this phone's location, the incident classification, any items or skills needed, and nothing else. With Network off a token opens nothing. Skills and Gifts are optional: tick the ones this person has, add up to five of your own, or leave them all off. Encrypt hides those skills inside the token string.",
    )} ${network}`;
  }
}

function paintNumberForm(documentRef, status) {
  const input = byId(documentRef, 'ultra-number-input');
  const clear = byId(documentRef, 'ultra-number-clear');
  const number = status?.ownerNumber || '';
  if (input) {
    input.placeholder = number
      ? tl('SAVED: {value}', { value: `${number.slice(0, 5)}…` })
      : tl(
          '+15065550100 your cell: calls for help you receive are texted here',
        );
  }
  if (clear) clear.hidden = !number;
}

function paintTokenForm(documentRef, status) {
  const select = byId(documentRef, 'ultra-token-package');
  if (!select) return;
  const packages = status?.packages || [];
  const current = select.value;
  select.replaceChildren();
  for (const feed of packages) {
    const option = documentRef.createElement('option');
    option.value = feed.id;
    option.textContent = feed.name || feed.id;
    select.appendChild(option);
  }
  if (packages.some((feed) => feed.id === current)) select.value = current;
  else if (packages.length) select.value = packages[0].id;
  select.hidden = packages.length <= 1;
}

/* The reveal box is the only place the plaintext ever lands. The status
 * poll's payload has no `revealed` key, so it never reaches this branch and
 * can neither wipe a token the owner is copying nor bring one back. The
 * handout is two labelled lines, the tailnet address and the token: the
 * token is never written into a URL, here or anywhere. */
function paintReveal(documentRef, status) {
  if (!status || status.revealed === undefined) return;
  const box = byId(documentRef, 'ultra-token-reveal');
  const pre = byId(documentRef, 'ultra-token-link');
  if (!box || !pre) return;
  const revealed = status.revealed;
  if (!revealed || typeof revealed !== 'object') {
    pre.textContent = '';
    delete box.dataset.ultraToken;
    delete box.dataset.ultraAddress;
    box.hidden = true;
    return;
  }
  const token = String(revealed.token || '');
  const address = String(revealed.address || '');
  const lines = [tl('{label}:', { label: revealed.label || tl('Token') })];
  /* No address with Network off (the token opens nothing) or while the
   * report listener is down: the token line stands alone and says so. */
  if (address) lines.push(tl('Tailnet address: {address}', { address }));
  lines.push(tl('Ultra Token: {token}', { token }));
  if (!address) {
    lines.push(
      tl(
        'No tailnet address to show (Network is off, or the report listener is not up): the token is handed over with your tailnet address.',
      ),
    );
  }
  /* A sealed skill list this machine's key cannot open is hidden, not
   * absent: say which, so a replaced or missing key is not read as a token
   * minted with no skills. */
  if (revealed.hidden === true) {
    lines.push(tl(SKILLS_HIDDEN_LINE));
  } else if (Array.isArray(revealed.skills)) {
    const names = shownSkills(revealed.skills);
    lines.push(names.length ? names.join(', ') : tl('No skill sets'));
  }
  if (revealed.encrypted === true)
    lines.push(tl('Skills encrypted in the token'));
  pre.textContent = lines.join('\n');
  box.dataset.ultraToken = token;
  if (address) box.dataset.ultraAddress = address;
  else delete box.dataset.ultraAddress;
  box.hidden = false;
}

/* The published entry follows the same contract: only the PUBLISH answer
 * carries `published`, so the poll can neither wipe the box nor re-show it. */
function paintPublished(documentRef, status) {
  if (!status || status.published === undefined) return;
  const box = byId(documentRef, 'ultra-network-entry');
  const pre = byId(documentRef, 'ultra-network-entry-text');
  if (!box || !pre) return;
  const note = byId(documentRef, 'ultra-network-entry-note');
  const mail = byId(documentRef, 'ultra-network-entry-mail');
  const published = status.published;
  if (!published || typeof published !== 'object') {
    pre.textContent = '';
    delete box.dataset.ultraEntry;
    if (note) note.textContent = '';
    if (mail) {
      mail.href = '';
      mail.hidden = true;
    }
    box.hidden = true;
    return;
  }
  const how = published.how === 'github' ? 'github' : 'clipboard';
  const entryText = String(published.entryText || '');
  const lines = [
    how === 'github'
      ? tl('PUBLISHED to {directory}:', {
          directory: published.directory || tl('the directory'),
        })
      : tl('COPY THIS ENTRY:'),
    entryText,
  ];
  if (published.error)
    lines.push(
      tl('Not written to GitHub: {error}', { error: published.error }),
    );
  pre.textContent = lines.join('\n');
  box.dataset.ultraEntry = entryText;
  if (note) note.textContent = tl(ENTRY_NOTE[how]);
  if (mail) {
    /* The mailto: comes from the loopback answer and carries only the entry;
     * it is offered when the entry has to travel by hand. */
    const mailto = String(published.mailto || '');
    const offered = how === 'clipboard' && mailto.startsWith('mailto:');
    mail.href = offered ? mailto : '';
    mail.hidden = !offered;
  }
  box.hidden = false;
}

function chosenSkillCodes(documentRef) {
  const form = byId(documentRef, 'ultra-token');
  const codes = [];
  for (const box of form?.querySelectorAll?.('[data-ultra-skill]') || []) {
    const code = box.dataset?.ultraSkill;
    if (box.checked && code) codes.push(code);
  }
  return codes;
}

function chosenCustomSkills(documentRef) {
  const custom = [];
  for (let index = 1; index <= 5; index += 1) {
    const value = byId(documentRef, `ultra-skill-custom-${index}`)?.value;
    if (String(value || '').trim()) custom.push(value);
  }
  return custom;
}

function clearTokenSkills(documentRef) {
  const encrypt = byId(documentRef, 'ultra-token-encrypt');
  if (encrypt) encrypt.checked = false;
  const form = byId(documentRef, 'ultra-token');
  for (const box of form?.querySelectorAll?.('[data-ultra-skill]') || [])
    box.checked = false;
  for (let index = 1; index <= 5; index += 1) {
    const field = byId(documentRef, `ultra-skill-custom-${index}`);
    if (field) field.value = '';
  }
  paintCustomSkillPreview(documentRef);
}

/** The line under the custom boxes: the short name the link will carry, or why the boxes cannot be minted. */
function paintCustomSkillPreview(documentRef) {
  const note = byId(documentRef, 'ultra-skill-custom-preview');
  if (!note) return;
  const values = chosenCustomSkills(documentRef);
  if (!values.length) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  const built = ultraCustomSkillList(values);
  if (!built.ok) {
    note.hidden = false;
    note.textContent =
      built.error === tl('Two custom skill sets would share one token code')
        ? tl(
            'Two custom skill sets would share one token code. Change one of them.',
          )
        : built.error;
    return;
  }
  if (!built.differs) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  note.hidden = false;
  note.textContent = tl('The token will say: {skills}', {
    skills: built.skills.map((item) => item.label).join(', '),
  });
}

function skillWords(skills) {
  if (!Array.isArray(skills)) return [];
  return skills
    .map((item) =>
      typeof item === 'string' ? item : String(item?.label || ''),
    )
    .map((text) => text.trim())
    .filter(Boolean);
}

/** The skills as the box shows them (the standard ones in the page's words). */
function shownSkills(skills) {
  return skillWords(skills).map((label) => tl(label));
}

function tokenReadout(token) {
  const parts = [
    token.label || token.id,
    token.network ? tl('NET') : '—',
    /* A token carries the location poll alone: shared only while asking,
     * and with Network off it opens nothing at all. */
    token.locationOnly
      ? tl('LOCATION ONLY (DIRECTORY)')
      : token.network
        ? tl('ONLY WHEN ASKING')
        : tl('OPENS NOTHING UNTIL NETWORK ON'),
    token.fingerprint || '',
    dayDate(token.createdAt),
  ];
  const skills = shownSkills(token.skills);
  if (skills.length) parts.push(skills.join(', '));
  /* `hidden` is the server's word for a sealed list this key cannot open;
   * an encrypted token that opens to no skills reads ENCRYPTED alone, as a
   * token minted that way should. */
  if (token.hidden === true) parts.push(tl(SKILLS_HIDDEN_WORD));
  if (token.encrypted === true) parts.push(tl('ENCRYPTED'));
  if (token.tampered) parts.push(tl('TAMPERED'));
  if (token.orphaned) parts.push(tl('PACKAGE REMOVED'));
  if (token.revokedAt) parts.push(tl('REVOKED'));
  return parts.filter(Boolean).join(' · ');
}

function paintTokens(documentRef, status) {
  const list = byId(documentRef, 'ultra-tokens');
  if (!list) return;
  const rows = [];
  const store = status?.tokenStore || 'ok';
  const broken = store === 'unreadable' || store === 'key-invalid';
  if (!broken) {
    const tokens = status?.tokens || [];
    const live = tokens.filter((token) => !token.revokedAt);
    const revoked = tokens
      .filter((token) => token.revokedAt)
      .sort((a, b) => (b.revokedAt || 0) - (a.revokedAt || 0));
    for (const token of live) {
      const row = documentRef.createElement('div');
      row.className = 'cctv-controls ultra-token-row';
      row.dataset.revoked = '0';
      const readout = documentRef.createElement('span');
      readout.className = 'sst-readout';
      readout.textContent = tokenReadout(token);
      if (token.orphaned || token.tampered) {
        /* A removed package answers 404. A token file whose flags no longer
         * match its seal is not offered for sharing or switching either:
         * either way there is only revoke or remove. */
        if (token.orphaned) row.dataset.orphaned = '1';
        if (token.tampered) row.dataset.tampered = '1';
        row.append(
          readout,
          button(documentRef, tl('REVOKE'), { ultraTokenRevoke: token.id }),
          button(documentRef, tl('REMOVE'), { ultraTokenRemove: token.id }),
        );
        rows.push([token.id, row]);
        continue;
      }
      row.append(
        readout,
        button(documentRef, tl('SHARE'), { ultraTokenShare: token.id }),
        button(
          documentRef,
          token.network ? tl('NETWORK OFF') : tl('NETWORK ON'),
          {
            ultraTokenEdit: token.id,
            ultraField: 'network',
            ultraCurrent: token.network ? '1' : '0',
          },
        ),
        button(documentRef, tl('REVOKE'), { ultraTokenRevoke: token.id }),
      );
      rows.push([token.id, row]);
    }
    for (const token of revoked.slice(0, REVOKED_ROWS)) {
      const row = documentRef.createElement('div');
      row.className = 'cctv-controls ultra-token-row';
      row.dataset.revoked = '1';
      const readout = documentRef.createElement('span');
      readout.className = 'sst-readout';
      readout.textContent = tokenReadout(token);
      row.append(
        readout,
        button(documentRef, tl('REMOVE'), { ultraTokenRemove: token.id }),
      );
      rows.push([token.id, row]);
    }
    if (revoked.length > REVOKED_ROWS) {
      const row = documentRef.createElement('div');
      row.className = 'cctv-controls';
      row.appendChild(
        button(documentRef, tl('REMOVE ALL REVOKED'), {
          ultraTokenPurge: '1',
        }),
      );
      rows.push(['purge', row]);
    }
  }
  if (store !== 'ok') {
    const row = documentRef.createElement('div');
    row.className = 'cctv-controls';
    row.appendChild(
      button(documentRef, tl('RESET TOKENS'), { ultraTokenReset: '1' }),
    );
    rows.push(['reset', row]);
  }
  replaceRows(documentRef, list, rows);
}

/* RENAME borrows the ADD TO HOME LIST form until its next submit, refused
 * or not, or until its row is gone from the home list. The address and
 * token boxes stay usable all along: a handout entered while RENAME is
 * armed is an ADD, and ends the rename. */
function endRenaming(documentRef) {
  const form = byId(documentRef, 'ultra-network-add');
  if (!form) return;
  delete form.dataset.ultraRenaming;
  const submit = form.querySelector?.('button');
  if (submit) submit.textContent = tl('ADD TO HOME LIST');
  const addressInput = byId(documentRef, 'ultra-network-address');
  if (addressInput) addressInput.placeholder = tl(ADD_ADDRESS_PLACEHOLDER);
  const tokenInput = byId(documentRef, 'ultra-network-token');
  if (tokenInput) tokenInput.placeholder = tl(ADD_TOKEN_PLACEHOLDER);
}

function networkStateWord(entry, polling, now) {
  if (!polling) return tl('NOT POLLED');
  if (entry.lastState === 'quiet') {
    const polledAt = Number(entry.lastPolledAt) || 0;
    return polledAt && now - polledAt > NETWORK_STALE_MS
      ? tl('OK · STALE')
      : tl('WATCHING');
  }
  return tl(NETWORK_STATE[entry.lastState] || NETWORK_STATE.new);
}

function networkNote(network, directory) {
  if ((network.keyState || 'ok') !== 'ok') return NETWORK_NOTE.key;
  if (network.polling !== true) return NETWORK_NOTE.preview;
  if (!directory.configured) return NETWORK_NOTE.directory;
  const writes = directory.canPublish
    ? tl('write token saved, PUBLISH writes to it')
    : directory.github
      ? tl('no write token: PUBLISH copies the entry for you to send')
      : tl('not a GitHub file: PUBLISH copies the entry for you to send');
  const last = directory.lastResult;
  let update = '';
  if (last && typeof last === 'object') {
    update = last.error
      ? ` · ${tl('last update failed: {error}', { error: last.error })}`
      : ` · ${tl(
          'UPDATED {time} · {added} added · {renamed} renamed · {missing} missing · {moved} moved · {skipped} skipped · {listed} listed',
          {
            time: clockTime(directory.lastUpdateAt),
            added: Number(last.added) || 0,
            renamed: Number(last.updated) || 0,
            missing: Number(last.missing) || 0,
            moved: Number(last.moved) || 0,
            skipped: Number(last.skipped) || 0,
            listed: Number(last.total) || 0,
          },
        )}`;
  }
  return `${tl('Directory: {address}', { address: directory.url || '' })} · ${writes}${update} · ${tl(
    'Anyone who can read the directory sees where the phones in it are while their owners ask for help, and nothing more: keep it private to your group.',
  )}`;
}

/* Only hosts, names, states and times are ever painted here: the status
 * carries no link, token or hash, so none can land in the page. */
function paintNetwork(documentRef, status, now = Date.now()) {
  const network =
    status?.network && typeof status.network === 'object' ? status.network : {};
  const entries = Array.isArray(network.entries) ? network.entries : [];
  const directory =
    network.directory && typeof network.directory === 'object'
      ? network.directory
      : {};
  const polling = network.polling === true;
  const needHelp = entries.filter((entry) => entry?.active === true).length;
  const count = byId(documentRef, 'ultra-network-count');
  if (count) {
    count.textContent =
      needHelp > 0
        ? `· ${tln(needHelp, '{count} NEED HELP', '{count} NEED HELP')}`
        : entries.length
          ? `· ${tln(entries.length, '{count} token', '{count} tokens')}`
          : '';
    setClass(count.parentElement, 'ultra-unread', needHelp > 0);
  }
  const note = byId(documentRef, 'ultra-network-note');
  if (note) {
    const lead = networkNote(network, directory);
    let text = tl(lead);
    const published = network.published;
    if (published && typeof published === 'object') {
      const how =
        published.how === 'github'
          ? tl('written to the directory {day}', { day: dayDate(published.at) })
          : tl('copied for the maintainer {day}', {
              day: dayDate(published.at),
            });
      text += ` ${
        published.live === false
          ? tl(
              'Your token is published ({how}) · THAT TOKEN IS REVOKED: publish again.',
              { how },
            )
          : tl('Your token is published ({how}).', { how })
      }`;
    }
    if (lead === NETWORK_NOTE.directory)
      text += `\n${tl(NETWORK_NOTE.activate)}`;
    note.textContent = text;
  }
  /* Placeholders only: a value is never pre-filled, so the three-second poll
   * cannot overwrite what the owner is typing. */
  const meName = byId(documentRef, 'ultra-network-me-name');
  if (meName) {
    const name = String(network.me?.name || '');
    meName.placeholder = name
      ? tl('SAVED: {value}', { value: name })
      : tl(PLACEHOLDER.meName);
  }
  const urlInput = byId(documentRef, 'ultra-directory-url');
  if (urlInput) {
    urlInput.placeholder =
      directory.configured && directory.url
        ? tl('SAVED: {value}', { value: directory.url })
        : PLACEHOLDER.directoryUrl;
  }
  const tokenInput = byId(documentRef, 'ultra-directory-token');
  if (tokenInput) {
    tokenInput.placeholder = directory.canPublish
      ? tl(PLACEHOLDER.directoryTokenSaved)
      : tl(PLACEHOLDER.directoryToken);
  }
  const select = byId(documentRef, 'ultra-publish-token');
  if (select) {
    const current = select.value;
    /* Only a location-only token can go in the directory. SMS would show
     * your number. An older token still marked anytime is left out too. */
    const candidates = networkTokens(status).filter(
      (token) =>
        token.locationOnly === true ||
        (token.sms !== true && token.anytime !== true),
    );
    /* Rebuilding the options tears down an open popup, and this paints every
     * three seconds: leave the DOM alone unless the choices really changed. */
    const shape = candidates
      .map((token) => `${token.id}:${token.label}:${token.fingerprint}`)
      .join('|');
    if (select.dataset.ultraShape !== shape) {
      select.dataset.ultraShape = shape;
      select.replaceChildren();
      const first = documentRef.createElement('option');
      first.value = '';
      first.textContent = tl('DIRECTORY TOKEN (made for you)');
      select.appendChild(first);
      for (const token of candidates) {
        const option = documentRef.createElement('option');
        option.value = token.id;
        option.textContent = `${token.label || token.id} · ${token.fingerprint || ''}`;
        select.appendChild(option);
      }
      select.value = candidates.some((token) => token.id === current)
        ? current
        : '';
    }
    select.hidden = candidates.length === 0;
  }
  paintPublishPackage(documentRef, status);
  const list = byId(documentRef, 'ultra-network-list');
  if (list) {
    const rows = [];
    const sorted = entries
      .filter((entry) => entry && entry.id)
      .sort((a, b) => {
        const byActive = (b.active === true) - (a.active === true);
        if (byActive) return byActive;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
    for (const entry of sorted) {
      const row = documentRef.createElement('div');
      row.className = 'cctv-controls ultra-network-row';
      row.dataset.state = String(entry.lastState || 'new');
      row.dataset.active = entry.active === true ? '1' : '0';
      row.dataset.source =
        entry.source === 'directory' ? 'directory' : 'manual';
      const state = networkStateWord(entry, polling, now);
      const parts = [
        entry.name || entry.host || entry.id,
        entry.host || '',
        entry.source === 'directory' ? tl('DIRECTORY') : tl('MANUAL'),
        state,
      ];
      /* The flags repeat the state word for a row that is in that very
       * state; say each thing once. */
      if (entry.directoryMissing && state !== tl('NOT IN DIRECTORY')) {
        parts.push(tl('NOT IN DIRECTORY'));
      }
      if (entry.moved && state !== tl('MOVED')) parts.push(tl('MOVED'));
      /* A hand-added link is polled where the owner put it; the directory
       * lists the same person elsewhere, and this is the row it means. */
      if (entry.directoryDiffers)
        parts.push(tl('DIRECTORY LISTS ANOTHER HOST'));
      if (Number(entry.lastPolledAt) > 0)
        parts.push(clockTime(entry.lastPolledAt));
      const peerSkills = shownSkills(entry.skills);
      if (peerSkills.length) parts.push(peerSkills.join(', '));
      if (entry.encrypted === true) parts.push(tl('ENCRYPTED'));
      /* CONFIRM ULTRA TOKEN SKILLS: the last check kept beside the token. */
      const check = entry.skillCheck;
      if (Array.isArray(check?.verdicts) && check.verdicts.length) {
        parts.push(
          check.verdicts.map((row) => skillVerdictWords(row)).join(', '),
        );
        parts.push(
          tl('SKILLS CHECKED {when}', { when: checkedWhen(check.at) }),
        );
      }
      const readout = documentRef.createElement('span');
      readout.className = 'sst-readout';
      readout.textContent = parts.filter(Boolean).join(' · ');
      row.append(
        readout,
        button(documentRef, tl('RENAME'), { ultraNetworkRename: entry.id }),
        button(documentRef, tl('REMOVE'), { ultraNetworkRemove: entry.id }),
      );
      rows.push([entry.id, row]);
    }
    replaceRows(documentRef, list, rows);
  }
  /* A RENAME whose row has gone (REMOVE, or RESET TOKENS emptying the list)
   * lets go of the ADD form: there is nothing left for it to rename. */
  const addForm = byId(documentRef, 'ultra-network-add');
  const armed = addForm?.dataset?.ultraRenaming;
  if (armed && !entries.some((item) => item?.id === armed)) {
    endRenaming(documentRef);
  }
  const relay =
    network.relay && typeof network.relay === 'object' ? network.relay : {};
  const configured = relay.configured === true;
  const relayLine = byId(documentRef, 'ultra-sms-relay');
  if (relayLine) {
    relayLine.textContent = `${tl('SMS RELAY · {relay}', {
      relay: configured
        ? `${String(relay.provider || '').toUpperCase()} (${relay.host || ''})`
        : tl('NOT CONFIGURED (POWER UP → SMS RELAY)'),
    })}${relay.lastOutcome ? ` · ${tl(relay.lastOutcome)}` : ''}${relay.sentToday ? ` · ${tl('{count} SENT TODAY', { count: relay.sentToday })}` : ''}`;
  }
  const test = byId(documentRef, 'ultra-sms-test');
  if (test) test.disabled = !configured || !status?.ownerNumber;
}

/** A stored JSON list, or [] for anything else. */
function parseList(text) {
  try {
    const value = JSON.parse(String(text || '[]'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** The saved photos and videos: kind, time, size and an OPEN link each. */
export function paintMedia(documentRef, items, selected = new Set()) {
  const list = byId(documentRef, 'ultra-media');
  if (!list) return;
  const rows = (Array.isArray(items) ? items : []).slice(0, 12).map((item) => {
    const li = documentRef.createElement('li');
    const tick = documentRef.createElement('input');
    tick.type = 'checkbox';
    tick.checked = selected.has(item.name);
    tick.dataset.ultraMediaName = item.name;
    tick.title = tl('Show this one on the map');
    li.appendChild(tick);
    const when = new Date(item.at);
    const label = documentRef.createElement('span');
    const megabytes = (Number(item.bytes) || 0) / (1024 * 1024);
    label.textContent = `${item.kind === 'clip' ? tl('VIDEO') : tl('PHOTO')} · ${
      Number.isNaN(when.getTime()) ? '' : when.toLocaleString()
    } · ${tl('{size} MB', { size: megabytes >= 0.1 ? localDigits(megabytes.toFixed(1)) : localDigits('<0.1') })}`;
    const view = documentRef.createElement('button');
    view.type = 'button';
    view.className = 'ultra-media-view';
    view.textContent = 'CCTV'; // i18n-ignore: the acronym is the same in every language
    view.title = tl('Show this one in the CCTV viewer');
    view.dataset.ultraMediaView = item.name;
    view.dataset.ultraMediaKind = item.kind;
    const open = documentRef.createElement('a');
    open.href = `/api/ultra-help/media/${encodeURIComponent(item.name)}`;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = tl('OPEN');
    li.appendChild(label);
    li.appendChild(view);
    li.appendChild(open);
    return li;
  });
  list.replaceChildren(...rows);
}

/** One entry of the CELL select. */
function cellOption(documentRef, value, text) {
  const option = documentRef.createElement('option');
  option.value = value;
  option.textContent = text;
  return option;
}

export function applyUltraHelpStatus(documentRef, status) {
  const model = byId(documentRef, 'ultra-model');
  if (model && status?.model?.id && model.value !== status.model.id) {
    model.value = status.model.id;
  }
  const modelId = model?.value || status?.model?.id || 'samsung-s22-ultra';
  // CELL: which saved phone TAKE PHOTO and TAKE VIDEO go to (owner request
  // 2026-10-16): AUTO, then one entry per saved package, the pick shown.
  const cell = byId(documentRef, 'ultra-camera-cell');
  if (cell && status && Array.isArray(status.packages)) {
    const wanted = ['', ...status.packages.map((item) => String(item.id))];
    const have = [...(cell.children || [])].map((item) => String(item.value));
    if (wanted.join('\n') !== have.join('\n')) {
      cell.replaceChildren(
        cellOption(
          documentRef,
          '',
          tl('AUTO · THE PHONE WHOSE PAGE IS OPEN, ELSE THE LAST TO REPORT'),
        ),
        ...status.packages.map((item) =>
          cellOption(
            documentRef,
            String(item.id),
            String(item.name || 'Ultra').toUpperCase(),
          ),
        ),
      );
    }
    const chosen =
      typeof status.cameraCell === 'string' ? status.cameraCell : '';
    if (cell.value !== chosen) cell.value = chosen;
  }
  // One row per camera (PHOTO, VIDEO, RECORD), shown when the model has it.
  for (const row of documentRef.querySelectorAll('[data-ultra-camera-row]')) {
    const role = row.dataset.ultraCameraRow;
    const offered = Boolean(ultraCameraRole(modelId, role));
    const always = role === 'front' || role === 'rear';
    row.hidden = !always && !offered;
  }
  const extras = byId(documentRef, 'ultra-extra-cameras');
  if (extras) {
    extras.hidden = !extras.querySelector(
      '[data-ultra-camera-row]:not([hidden])',
    );
  }
  const statusLine = byId(documentRef, 'ultra-status');
  if (statusLine) {
    // The mirror is on (the phone reaches this PC over Tailscale only), the
    // report listener is up, and none of its addresses is a tailnet one.
    const noTailnet = Boolean(
      status?.tailnetWanted && status?.camLink && !status?.networkBase,
    );
    const unread = Number(status?.unread) || 0;
    const release =
      status?.release && typeof status.release === 'object'
        ? status.release
        : null;
    const received = activeReleases(status)[0];
    if (release) {
      statusLine.textContent = tl(
        'HELP SENT · UNTIL {time} · {count} WATCHING',
        {
          time: clockTime(release.until),
          count: Number(release.watching) || 0,
        },
      );
    } else if (received) {
      statusLine.textContent = tl('NETWORK · {name} NEEDS HELP', {
        name: String(
          received.from || received.label || tl('someone'),
        ).toUpperCase(),
      });
    } else if (unread > 0) {
      statusLine.textContent = tln(
        unread,
        'HELP · {count} NEW',
        'HELP · {count} NEW',
      );
    } else if (status?.pending?.kind === 'camera') {
      // LIVE VIDEO only while the phone page is polling. A press it has not
      // picked up says what is missing: the page, the listener, or this
      // PC's Tailscale address.
      const label = tl(status.pending.label);
      statusLine.textContent = status.pageOpen
        ? tl('LIVE VIDEO · {camera}', { camera: label })
        : status.appLive
          ? tl('LIVE VIDEO · {camera} · CAMERA APP', { camera: label })
          : noTailnet
            ? tl(
                'ASKED · {camera} · THIS PC HAS NO TAILSCALE ADDRESS: CONNECT TAILSCALE ON THE PC',
                { camera: label },
              )
            : status.camLink
              ? tl(
                  'ASKED · {camera} · OPEN THE CAMERA LINK BELOW, OR START THE CAMERA APP ON THE PHONE',
                  { camera: label },
                )
              : tl(
                  'ASKED · {camera} · THE REPORT LISTENER IS NOT UP: RESTART THE DEV SERVER',
                  { camera: label },
                );
    } else if (status?.lapsed?.kind === 'camera') {
      statusLine.textContent = tl(
        'NOT TAKEN · {camera} · PRESS AGAIN WITH THE PHONE PAGE OPEN',
        { camera: tl(status.lapsed.label) },
      );
    } else if (status?.appLive) {
      statusLine.textContent = tl('LIVE VIDEO · CAMERA APP');
    } else if (status?.cameraNote) {
      statusLine.textContent = tl(status.cameraNote);
    } else if (noTailnet) {
      statusLine.textContent = tl(
        'TAILSCALE · THIS PC HAS NO TAILSCALE ADDRESS: THE PHONE CANNOT REACH IT',
      );
    } else if (status?.position) {
      statusLine.textContent = tl('PHONE · {point}', {
        point: `${status.position.lat.toFixed(4)}, ${status.position.lon.toFixed(4)}`,
      });
    } else {
      statusLine.textContent = tl('PHONE · WAITING FOR A REPORT');
    }
  }
  // The phone's live picture shows on the map only (the Cell layer's card),
  // never in this box (owner ruling, 2026-10-08).
  const link = byId(documentRef, 'ultra-cam-link');
  if (link) {
    const rows = [];
    if (status?.camLink) {
      const anchor = documentRef.createElement('a');
      anchor.href = status.camLink;
      // Which saved phone the link is for, when the box knows (two phones).
      anchor.textContent = status.camPackage
        ? tl(
            'Open this on the phone ({phone}): it sends the phone’s position and camera (no app needed)',
            { phone: status.camPackage },
          )
        : tl(
            'Open this on the phone: it sends the phone’s position and camera (no app needed)',
          );
      anchor.rel = 'noopener';
      rows.push(['cam', anchor]);
    }
    replaceRows(documentRef, link, rows);
  }
  paintReleasePackage(documentRef, status);
  paintRelease(documentRef, status);
  paintInbox(documentRef, status);

  const helpNote = byId(documentRef, 'ultra-help-store-note');
  if (helpNote) {
    const tampered = status?.helpStore === 'tampered';
    helpNote.hidden = !tampered;
    if (tampered) {
      helpNote.textContent = tl(
        'The helpers file was changed and is not being used. The next save replaces it.',
      );
    }
  }
  const outboundNote = byId(documentRef, 'ultra-outbound-note');
  if (outboundNote) {
    const lines = [];
    if (status?.directoryStore === 'tampered') {
      lines.push(
        tl(
          'The directory address was changed and is not being used. Save it again from the box.',
        ),
      );
    }
    if (status?.relayStore === 'tampered') {
      lines.push(
        tl(
          'The SMS relay was changed and is not being used. Save it again from POWER UP.',
        ),
      );
    }
    if (status?.feedsStore === 'tampered') {
      lines.push(
        tl(
          'The phone package was changed and is not being used. Save the package again.',
        ),
      );
    }
    outboundNote.hidden = lines.length === 0;
    outboundNote.textContent = lines.join(' ');
  }
  const saved = byId(documentRef, 'ultra-contacts');
  if (saved) {
    const rows = [];
    for (const contact of status?.contacts || []) {
      const row = documentRef.createElement('div');
      row.className = 'cctv-controls';
      const label = documentRef.createElement('span');
      label.className = 'sst-readout';
      label.textContent = `${contact.label} · ${contact.number} · ${contact.kind}`;
      const remove = documentRef.createElement('button');
      remove.type = 'button';
      remove.className = 'scene-btn';
      remove.textContent = tl('REMOVE');
      remove.dataset.ultraRemove = contact.id;
      row.append(label, remove);
      rows.push([contact.id, row]);
    }
    replaceRows(documentRef, saved, rows);
  }
  paintTokenNote(documentRef, status);
  paintNumberForm(documentRef, status);
  paintTokenForm(documentRef, status);
  paintTokens(documentRef, status);
  paintReveal(documentRef, status);
  paintNetwork(documentRef, status);
  paintPublished(documentRef, status);
}

/* Speak every unread message the box has not spoken yet. The first call
 * after page load seeds the set with anything older than ten minutes so a
 * reload stays quiet about messages the owner already heard. A received
 * call for help is spoken once as it starts (as soon as its street is known,
 * six seconds after it showed at most) and once as it ends; a call already
 * over at load is seeded silently. */
function readAloud(documentRef, status, now = Date.now()) {
  const messages = Array.isArray(status?.inbox) ? status.inbox : [];
  if (!spokenSeeded) {
    spokenSeeded = true;
    for (const message of messages) {
      if (now - (Number(message.at) || 0) > SPOKEN_SEED_AGE_MS) {
        spoken.add(message.id);
      }
      if (message.kind === 'release' && message.active !== true) {
        spoken.add(message.id);
        stoodDown.add(message.id);
      }
    }
  }
  const toggle = byId(documentRef, 'ultra-read-aloud');
  const wanted = toggle ? toggle.checked !== false : true;
  const synth = globalThis.speechSynthesis;
  const Utterance = globalThis.SpeechSynthesisUtterance;
  const speak = (sentence) => {
    if (!wanted || !synth || typeof Utterance !== 'function') return;
    try {
      synth.speak(new Utterance(sentence));
    } catch {
      /* A browser without a voice just shows the row. */
    }
  };
  for (const message of messages) {
    if (!message?.id) continue;
    if (message.kind === 'release') {
      const from = message.from || message.label || tl('Someone');
      if (message.active === true) {
        if (message.readAt || spoken.has(message.id)) continue;
        /* The row shows at once, with coordinates; the voice waits a few
         * seconds for the street, so the call is said once and said with
         * the address, not the coordinates first and nothing after. */
        if (message.placing === true) {
          const seen = firstHeard.get(message.id) ?? now;
          firstHeard.set(message.id, seen);
          if (now - seen < PLACE_WAIT_MS) continue;
        }
        firstHeard.delete(message.id);
        spoken.add(message.id);
        speak(
          tl('{name} needs help. {text}', {
            name: from,
            text: message.text || '',
          }),
        );
      } else if (!stoodDown.has(message.id)) {
        firstHeard.delete(message.id);
        stoodDown.add(message.id);
        /* A call that is over is never announced as new afterwards. */
        spoken.add(message.id);
        speak(tl('{name} stood down', { name: from }));
      }
      continue;
    }
    if (message.readAt || spoken.has(message.id)) continue;
    spoken.add(message.id);
    speak(
      tl('Help message from {name} via {link}: {text}', {
        name: message.from || tl('someone'),
        link: message.label || tl('a help link'),
        text: message.text || '',
      }),
    );
  }
}

function storedHiddenCells(key = DEVICE_HIDDEN_KEY) {
  try {
    return deviceHiddenIds(globalThis.localStorage?.getItem(key));
  } catch {
    return [];
  }
}

function rememberHiddenCells(ids, key = DEVICE_HIDDEN_KEY) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(ids));
  } catch {
    /* Blocked storage: the choice holds for this page only. */
  }
}

function storedMapPeriod() {
  try {
    return globalThis.localStorage?.getItem(DEVICE_HISTORY_PERIOD_KEY);
  } catch {
    return null;
  }
}

function rememberMapPeriod(id) {
  try {
    globalThis.localStorage?.setItem(DEVICE_HISTORY_PERIOD_KEY, id);
  } catch {
    /* Blocked storage: the choice holds for this page only. */
  }
}

function readAloudPreference() {
  try {
    return globalThis.localStorage?.getItem(READ_ALOUD_KEY);
  } catch {
    return null;
  }
}

function rememberReadAloud(checked) {
  try {
    globalThis.localStorage?.setItem(READ_ALOUD_KEY, checked ? '1' : '0');
  } catch {
    /* Private mode or blocked storage: the checkbox still works this session. */
  }
}

/**
 * Whether an Ultra panel POST asks to remove something: the client copy of
 * the server's ultraOwnerRemoval rule. Only these requests are watched for a
 * pc-only refusal, so a spoken press of any other button (UPDATE, TEST SMS,
 * SEND HELP) is answered at once rather than held for the server's reply.
 * A `me` save is always watched: the server strips hidden characters before
 * it decides whether the name is empty, and that write is local and quick.
 * @param {string} action
 * @param {Record<string, unknown> | null | undefined} body
 * @returns {boolean}
 */
export function ultraPostRemoves(action, body) {
  const ask = body && typeof body === 'object' ? body : {};
  switch (action) {
    case 'media/delete':
      return true;
    case 'contacts':
      return Boolean(ask.remove);
    case 'tokens':
      if (ask.reset) return true;
      if (ask.reveal || ask.edit) return false;
      return Boolean(ask.revoke || ask.remove || ask.purge);
    case 'network':
      if (ask.me) return true;
      if (ask.add) return false;
      return Boolean(ask.remove);
    case 'inbox':
      return Boolean(ask.clear || ask.remove);
    case 'number':
      return (
        ask.number === null ||
        ask.number === undefined ||
        String(ask.number).trim() === ''
      );
    case 'needs':
      return ask.needs === null;
    default:
      return false;
  }
}

export function initUltraHelpPanel({
  documentRef = document,
  fetchImpl = fetch,
  signal,
  windowRef = globalThis.window,
  dataManager = null,
} = {}) {
  const panel = documentRef.getElementById?.('ultra-panel');
  if (!panel) return { destroy() {} };
  paintSkillCheckApps(documentRef);
  void loadSkillCheckSwarm(documentRef, fetchImpl);
  let disposed = false;
  let latest = null;
  const readAloudBox = byId(documentRef, 'ultra-read-aloud');
  if (readAloudBox) {
    const remembered = readAloudPreference();
    if (remembered === '0') readAloudBox.checked = false;
    else if (remembered === '1') readAloudBox.checked = true;
  }
  const dispatchWindow = (type, detail) => {
    if (typeof windowRef?.dispatchEvent !== 'function') return;
    try {
      windowRef.dispatchEvent(new CustomEvent(type, { detail }));
    } catch {
      /* No CustomEvent here: the map simply is not nudged. */
    }
  };
  /* ULTRA ON MAP: the tick box is the Your Devices layer's own switch, kept
   * in step with it however it changes (its row, voice, auto display). The
   * period is this browser's choice of how much saved path the map draws. */
  const mapBox = byId(documentRef, 'ultra-map-show');
  const mapPeriod = byId(documentRef, 'ultra-map-period');
  /* PRIVATE CCTV ON MAP: the Private CCTV Cams layer's switch, the same way. */
  const privateBox = byId(documentRef, 'ultra-private-cams');
  if (mapPeriod) mapPeriod.value = deviceHistoryPeriod(storedMapPeriod()).id;
  const paintLayerBox = (box, layerId) => {
    if (!box) return;
    if (typeof dataManager?.isEnabled !== 'function') {
      box.disabled = true;
      return;
    }
    try {
      box.checked = Boolean(dataManager.isEnabled(layerId));
    } catch {
      /* Not registered on this page: the box keeps its last state. */
    }
  };
  const paintMapBox = () => {
    paintLayerBox(mapBox, ULTRA_MAP_LAYER_ID);
    paintLayerBox(privateBox, PRIVATE_CAMS_LAYER_ID);
  };
  paintMapBox();
  const stopMapWatch =
    typeof dataManager?.subscribe === 'function'
      ? dataManager.subscribe(paintMapBox)
      : () => {};
  /* A new call for help with a position turns the Your Devices layer on
   * (the same event a saved device fires), so its amber pin shows within one
   * poll of the layer. Said once per row; a row that ends leaves the set so
   * a resumed call nudges the layer again. */
  const syncPins = (status) => {
    const ids = new Set(
      activeReleases(status)
        .filter(hasPosition)
        .map((row) => row.id),
    );
    for (const id of [...pinned]) if (!ids.has(id)) pinned.delete(id);
    let fresh = false;
    for (const id of ids) {
      if (pinned.has(id)) continue;
      pinned.add(id);
      fresh = true;
    }
    if (fresh) dispatchWindow(DEVICE_FEEDS_CHANGED_EVENT, { count: 1 });
  };
  /* MAP: make sure the layer is on, then ask it for one flight to the pin.
   * The pin has follow off, so the camera is never held by it. */
  const dispatchFocus = (networkId) => {
    dispatchWindow(DEVICE_FEEDS_CHANGED_EVENT, { count: 1 });
    dispatchWindow(DEVICE_FEEDS_FOCUS_EVENT, {
      id: `ultra-network:${networkId}`,
    });
  };
  /* `latest` never holds a token or a published entry: the plaintext lives
   * only in its box until HIDE, and the poll's payload has neither key. */
  /* What the last action said, kept across the three-second poll. Every
   * refusal sentence is written into the status line, which the poll
   * repaints, so without this the owner never gets to read why an ADD, a
   * PUBLISH or a TEST SMS was refused. */
  let notice = null;
  const say = (text) => {
    notice = text ? { text, at: Date.now() } : null;
    const statusLine = byId(documentRef, 'ultra-status');
    if (statusLine && text) statusLine.textContent = text;
  };
  /* ULTRA CELLS: every saved Ultra phone, each with its own ON MAP tick and
   * its own HISTORY tick. Ticking all shows them together;
   * ONLY shows one alone; MAP flies to one. The choice is this browser's, and
   * a hidden cell still records. */
  let hiddenCells = new Set(storedHiddenCells());
  let noPathCells = new Set(storedHiddenCells(DEVICE_NO_PATH_KEY));
  let cellsShape = '';
  const sendHiddenCells = () => {
    const hidden = [...hiddenCells];
    const noPath = [...noPathCells];
    rememberHiddenCells(hidden);
    rememberHiddenCells(noPath, DEVICE_NO_PATH_KEY);
    dispatchWindow(DEVICE_FEEDS_VISIBLE_EVENT, { hidden, noPath });
  };
  const cellIds = () =>
    (Array.isArray(latest?.packages) ? latest.packages : [])
      .map((cell) => cell?.mapId)
      .filter((id) => typeof id === 'string');
  const showCellsLayer = () => {
    if (dataManager?.isEnabled?.(ULTRA_MAP_LAYER_ID)) return;
    Promise.resolve(
      dataManager?.setEnabled?.(ULTRA_MAP_LAYER_ID, true, { origin: 'user' }),
    )
      .catch(() => {})
      .finally(paintMapBox);
  };
  const paintCells = (status, force = false) => {
    const host = byId(documentRef, 'ultra-cells');
    if (!host) return;
    const cells = (
      Array.isArray(status?.packages) ? status.packages : []
    ).filter((cell) => typeof cell?.mapId === 'string');
    const shape = JSON.stringify([
      cells.map((cell) => [
        cell.mapId,
        cell.name,
        cell.record,
        cell.recordKm,
        cell.method,
      ]),
      [...hiddenCells].sort(),
      [...noPathCells].sort(),
      status?.editable !== false,
    ]);
    if (!force && shape === cellsShape) return;
    cellsShape = shape;
    host.replaceChildren();
    for (const cell of cells) {
      const row = documentRef.createElement('div');
      row.className = 'cctv-controls ultra-cell-row';
      const label = documentRef.createElement('label');
      label.className = 'ultra-match';
      const box = documentRef.createElement('input');
      box.type = 'checkbox';
      box.dataset.ultraCellMap = cell.mapId;
      box.checked = !hiddenCells.has(cell.mapId);
      box.title = tl('Show {name} on the map', { name: cell.name || 'Ultra' });
      label.appendChild(box);
      const name = documentRef.createElement('span');
      name.textContent = tl('{name} on map', { name: cell.name || 'Ultra' });
      label.appendChild(name);
      row.appendChild(label);
      const pathLabel = documentRef.createElement('label');
      pathLabel.className = 'ultra-match';
      const pathBox = documentRef.createElement('input');
      pathBox.type = 'checkbox';
      pathBox.dataset.ultraCellPath = cell.mapId;
      pathBox.checked = !noPathCells.has(cell.mapId);
      pathBox.disabled = hiddenCells.has(cell.mapId);
      pathBox.title = tl(
        "Show {name}'s location history (its path over time)",
        { name: cell.name || 'Ultra' },
      );
      pathLabel.appendChild(pathBox);
      const pathName = documentRef.createElement('span');
      pathName.textContent = tl('History');
      pathLabel.appendChild(pathName);
      row.appendChild(pathLabel);
      /* RECORD WITHIN: what this cell saves around it as it moves, up to
       * 50 km, or nothing. Read-only only when editing is off on this
       * server (preview build). */
      const record = documentRef.createElement('select');
      record.className = 'ultra-cell-record';
      record.dataset.ultraCellRecord = cell.id;
      record.title = tl('What {name} records around it', {
        name: cell.name || 'Ultra',
      });
      record.disabled = status?.editable === false || !cell.method;
      const off = documentRef.createElement('option');
      off.value = 'off';
      off.textContent = tl('Record off');
      record.appendChild(off);
      for (const km of DEVICE_RECORD_RADIUS_OPTIONS_KM) {
        const option = documentRef.createElement('option');
        option.value = String(km);
        option.textContent = tl('Record within {km} km', { km });
        record.appendChild(option);
      }
      record.value =
        cell.record === false
          ? 'off'
          : String(
              DEVICE_RECORD_RADIUS_OPTIONS_KM.includes(Number(cell.recordKm))
                ? Number(cell.recordKm)
                : DEVICE_RECORD_RADIUS_KM,
            );
      row.appendChild(record);
      for (const [action, text, title] of [
        [
          'only',
          tl('Only display'),
          tl('Show {name} alone on the map', { name: cell.name || 'Ultra' }),
        ],
        [
          'map',
          tl('Take to location on map'),
          tl('Fly the map to {name}', { name: cell.name || 'Ultra' }),
        ],
      ]) {
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.className = 'scene-btn ultra-cell-btn';
        button.dataset.ultraCellAction = action;
        button.dataset.ultraCellId = cell.mapId;
        button.textContent = text;
        button.title = title;
        row.appendChild(button);
      }
      host.appendChild(row);
    }
    const count = byId(documentRef, 'ultra-cells-count');
    if (count) count.textContent = cells.length ? `· ${cells.length}` : '';
    const form = byId(documentRef, 'ultra-cell-add');
    if (form) form.hidden = status?.editable === false;
    const note = byId(documentRef, 'ultra-cell-note');
    if (note) {
      note.hidden = !(status?.editable === false || !cells.length);
      note.textContent =
        status?.editable === false
          ? tl('Editing is off on this server (preview build).')
          : tl('No Ultra cell yet: name one and press + ADD ULTRA CELL.');
    }
  };
  /* RECORD WITHIN a cell: saved again through the device route, with what
   * the card already holds (left-out addresses keep what is saved). */
  const saveCellRecord = async (select) => {
    const cell = (Array.isArray(latest?.packages) ? latest.packages : []).find(
      (item) => item?.id === select.dataset.ultraCellRecord,
    );
    if (!cell?.method || disposed) return;
    const off = select.value === 'off';
    let response;
    try {
      response = await fetchImpl(DEVICE_CONFIG_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: cell.id,
          kind: 'security',
          name: cell.name,
          method: cell.method,
          record: !off,
          ...(off ? {} : { recordKm: Number(select.value) }),
        }),
      });
    } catch {
      say(tl('NOT SAVED — no answer from the dev server'));
      return;
    }
    if (!response.ok) {
      let error = msgl('Recording distance not saved');
      try {
        error = (await response.json())?.error || error;
      } catch {
        /* Keep the fallback line. */
      }
      say(tl(error));
      paintCells(latest, true);
      return;
    }
    const cellName = String(cell.name || 'Ultra').toUpperCase();
    say(
      off
        ? tl('{name} · RECORD OFF', { name: cellName })
        : tl('{name} · RECORDS WITHIN {km} KM', {
            name: cellName,
            km: select.value,
          }),
    );
    dispatchWindow(DEVICE_FEEDS_CHANGED_EVENT, { count: 1 });
    await load();
  };
  const addCell = async () => {
    const input = byId(documentRef, 'ultra-cell-name');
    const name = String(input?.value || '').trim();
    if (!name || disposed) return;
    const first = !(Array.isArray(latest?.packages) && latest.packages.length);
    let response;
    try {
      response = await fetchImpl(DEVICE_CONFIG_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'security',
          name,
          method: 'report-in',
          // The map follows one cell at a time: the first one saved.
          follow: first,
          record: true,
        }),
      });
    } catch {
      say(tl('ULTRA CELL NOT ADDED — no answer from the dev server'));
      return;
    }
    if (!response.ok) {
      let error = msgl('Ultra cell not added');
      try {
        error = (await response.json())?.error || error;
      } catch {
        /* Keep the fallback line. */
      }
      say(tl(error));
      return;
    }
    if (input) input.value = '';
    say(tl('ULTRA CELL ADDED · {name}', { name: name.toUpperCase() }));
    dispatchWindow(DEVICE_FEEDS_CHANGED_EVENT, { count: 1 });
    await load();
  };
  const paint = (status) => {
    const { revealed, published, ...rest } = status || {};
    latest = rest;
    applyUltraHelpStatus(documentRef, status);
    paintCells(status);
    readAloud(documentRef, status);
    syncPins(status);
    if (!notice) return;
    if (Date.now() - notice.at > NOTICE_MS) {
      notice = null;
      return;
    }
    const statusLine = byId(documentRef, 'ultra-status');
    if (statusLine) statusLine.textContent = notice.text;
  };
  /* A press whose request got no answer (the dev server stopped, or
   * restarting after SAVE DIRECTORY) says so and asks for the press again.
   * Nothing is retried by itself: SEND HELP stays one deliberate press, and
   * pressing it again while a call runs only renews that call. */
  const unanswered = (action, body) => {
    if (disposed) return null;
    say(
      action === 'release'
        ? body?.standDown
          ? tl(
              'STAND DOWN NOT SENT — no answer from the dev server; press STAND DOWN again',
            )
          : tl('HELP NOT SENT — no answer from the dev server; press again')
        : tl('Not sent: no answer from the dev server'),
    );
    return null;
  };
  const post = async (action, body) => {
    if (disposed) return null;
    let response;
    try {
      const request = fetchImpl(`/api/ultra-help/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      response = await (ultraPostRemoves(action, body)
        ? watchOwnerRemoval(request)
        : request);
    } catch {
      return unanswered(action, body);
    }
    if (!response.ok) {
      /* Only the PC removes: the phone's removal is a quiet no-op,
       * with no status line and no notice for the poll to repaint. */
      if (isOwnerRemovalRefusal(response)) return null;
      let error = msgl('Request refused');
      let refused = null;
      try {
        refused = await response.json();
        error = refused?.error || error;
      } catch {
        /* Keep the fallback line. */
      }
      if (isOwnerRemovalRefusal(response, refused)) {
        noteOwnerRemovalRefusal();
        return null;
      }
      say(tl(error));
      return null;
    }
    /* A body cut off on the way is no answer either. */
    let status;
    try {
      status = await response.json();
    } catch {
      return unanswered(action, body);
    }
    notice = null;
    paint(status);
    return status;
  };
  /* SAVE DIRECTORY reuses the key-setup route: it writes the repo-root .env
   * and restarts the dev server, whose client reloads this page. Its
   * sentences go through say() like every other action's, so the next poll
   * paints neither the phone's position nor an older refusal over them. */
  const saveEnv = async (body) => {
    if (disposed) return false;
    let response;
    try {
      response = await fetchImpl(ENV_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      say(tl('Not saved: no answer from the dev server'));
      return false;
    }
    let payload = {};
    try {
      payload = (await response.json()) || {};
    } catch {
      payload = {};
    }
    if (!response.ok || !payload.ok) {
      say(payload.error ? tl(payload.error) : tl('Not saved'));
      return false;
    }
    say(tl(ENV_SAVED));
    return true;
  };
  const copyTimers = new Map();
  let mintLabelTimer = null;
  const copyFrom = async (boxId, control, field) => {
    const box = byId(documentRef, boxId);
    const pre = box?.querySelector?.('pre') || null;
    const text = box?.dataset?.[field] || '';
    if (!text) return;
    let copied = false;
    try {
      await globalThis.navigator?.clipboard?.writeText(text);
      copied = true;
    } catch {
      copied = false;
    }
    if (!copied && pre) {
      try {
        const range = documentRef.createRange();
        range.selectNodeContents(pre);
        const selection = globalThis.getSelection?.();
        selection?.removeAllRanges();
        selection?.addRange(range);
      } catch {
        /* No selection API: the pre is still there to copy by hand. */
      }
    }
    if (!control) return;
    /* Flip the label for 1.5 s; a second click inside that window just
     * restarts the timer instead of remembering COPIED as the label. */
    const pending = copyTimers.get(control);
    if (pending) clearTimeout(pending.timer);
    const original = pending ? pending.label : control.textContent;
    control.textContent = copied ? tl('COPIED') : tl('SELECTED');
    const timer = setTimeout(() => {
      control.textContent = original;
      copyTimers.delete(control);
    }, 1500);
    copyTimers.set(control, { label: original, timer });
  };
  const confirmed = (question) =>
    typeof globalThis.confirm !== 'function' || globalThis.confirm(question);
  let swarming = false;
  const swarmStatus = (text) => {
    const line = byId(documentRef, 'ultra-swarm-status');
    if (line) line.textContent = text;
  };
  const swarmLog = (kind, body, place) => {
    const output = byId(documentRef, 'ultra-swarm-output');
    if (!output) return;
    output.textContent = prependOutputLog(
      output.textContent,
      formatAskLogEntry(kind, body, { locationName: place }),
    );
    output.scrollTop = 0;
  };
  const runSwarm = async () => {
    if (swarming) {
      swarmStatus(tl('The swarm is still out.'));
      return;
    }
    const run = byId(documentRef, 'ultra-swarm-run');
    const fix = latest?.position;
    const lat = Number(fix?.lat);
    const lon = Number(fix?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      swarmStatus(
        tl(
          'Needs a fresh phone position: open the phone link on the phone and wait for a report.',
        ),
      );
      return;
    }
    // A fix with no time cannot be shown fresh: it counts as stale.
    const at = Number(fix.at);
    if (!fix.at || !Number.isFinite(at)) {
      swarmStatus(
        tl(
          "The phone's last position has no time, too old to search from: open the phone link on the phone (it sends a fresh one).",
        ),
      );
      return;
    }
    if (Date.now() - at > ULTRA_POSITION_MAX_AGE_MS) {
      const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
      const age =
        minutes >= 120
          ? tl('{count} hours', { count: Math.round(minutes / 60) })
          : tl('{count} minutes', { count: minutes });
      swarmStatus(
        tl(
          "The phone's last position is {age} old, too old to search from: open the phone link on the phone (it sends a fresh one).",
          { age },
        ),
      );
      return;
    }
    const street = String(fix.place || fix.street || '').trim();
    const place = street || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    const typed = String(
      byId(documentRef, 'ultra-swarm-instructions')?.value || '',
    ).trim();
    const instructions = typed || SOCIAL_SWARM_DEFAULT_PURPOSE;
    const title = SOCIAL_SWARM_PROVIDERS.xai.title;
    swarming = true;
    const label = run?.textContent || title;
    if (run) {
      run.disabled = true;
      run.textContent = tl('SPINNING UP SWARM…');
    }
    swarmStatus(
      tl('SPINNING UP SWARM · {count} BOTS · {place}', {
        count: SOCIAL_SWARM_BOTS.length,
        place,
      }),
    );
    try {
      const result = await runSocialSwarm({
        request: fetchImpl,
        provider: 'xai',
        instructions,
        place,
        latitude: lat,
        longitude: lon,
        onBot({ bot, text, sources, error }) {
          swarmLog(
            `${tl(title)} · ${tl(bot.label)}`,
            error
              ? tl('BOT FAILED: {error}', { error })
              : formatSwarmBotLog({ text, sources }),
            place,
          );
        },
        onProgress({ back, total }) {
          swarmStatus(tl('SWARM OUT · {back}/{total} BACK', { back, total }));
        },
      });
      if (result.unconfigured) {
        swarmStatus(tl(result.unconfigured));
        return;
      }
      if (result.via === 'desktop') {
        swarmStatus(formatSwarmDesktopStatus(result));
        return;
      }
      const time = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      swarmStatus(
        tl('SWARM DONE {time} · {found} with reports · {empty} found nothing', {
          time,
          found: result.found,
          empty: result.empty,
        }) +
          (result.failed
            ? ` · ${tl('{failed} failed', { failed: result.failed })}`
            : ''),
      );
    } finally {
      swarming = false;
      if (run) {
        run.disabled = false;
        run.textContent = label;
      }
    }
  };
  /* CONFIRM ULTRA TOKEN SKILLS. The button below the token REMOVE rows
   * and above HELP NETWORK opens the form. Paste an Ultra Token to
   * decrypt its skills. The details typed here go out with the press
   * and are never kept. */
  let skillChecking = false;
  const skillCheckLine = (text) => {
    const line = byId(documentRef, 'ultra-skill-check-status');
    if (line) line.textContent = text;
  };
  const openSkillCheck = (entry) => {
    const form = byId(documentRef, 'ultra-skill-check');
    if (!form) return;
    paintSkillCheckApps(documentRef);
    form.hidden = false;
    if (entry?.id) form.dataset.ultraSkillEntry = entry.id;
    else delete form.dataset.ultraSkillEntry;
    delete form.dataset.ultraSkillSkills;
    const set = (id, value) => {
      const input = byId(documentRef, id);
      if (input) input.value = value;
    };
    set('ultra-skill-check-skills', skillWords(entry?.skills).join(', '));
    set('ultra-skill-check-name', entry?.name || '');
    for (const id of [
      'ultra-skill-check-alias',
      'ultra-skill-check-location',
      'ultra-skill-check-age',
      'ultra-skill-check-sex',
      'ultra-skill-check-profession',
      'ultra-skill-check-urls',
      'ultra-skill-check-report',
    ])
      set(id, '');
    clearSkillCheckApps(documentRef);
    const paste = byId(documentRef, 'ultra-skill-check-paste');
    if (paste) paste.hidden = true;
    const forLine = byId(documentRef, 'ultra-skill-check-for');
    if (forLine) {
      const sealed =
        entry?.encrypted === true && !skillWords(entry.skills).length
          ? ` ${tl('Its skills are encrypted: type the ones they told you.')}`
          : '';
      forLine.textContent = entry
        ? `${tl(
            'FOR {name} · the verdicts are kept beside this token on this PC.',
            { name: entry.name || entry.host || tl('this token') },
          )}${sealed}`
        : tl('The verdicts are shown, not kept.');
    }
    paintSkillVerdicts(
      documentRef,
      byId(documentRef, 'ultra-skill-check-results'),
      entry?.skillCheck?.verdicts || [],
    );
    skillCheckLine(
      entry?.skillCheck
        ? tl('LAST CHECK {when} · {tally}', {
            when: checkedWhen(entry.skillCheck.at),
            tally: skillCheckTally(entry.skillCheck.verdicts),
          })
        : '',
    );
    byId(documentRef, 'ultra-skill-check-skills')?.focus?.();
  };
  /* Show the verdicts, and keep them beside the token when the form was
   * opened from its row. */
  const keepSkillVerdicts = async (via, verdicts, extra = '') => {
    paintSkillVerdicts(
      documentRef,
      byId(documentRef, 'ultra-skill-check-results'),
      verdicts,
    );
    const tally = `${skillCheckTally(verdicts)}${extra}`;
    const entryId = byId(documentRef, 'ultra-skill-check')?.dataset
      ?.ultraSkillEntry;
    if (!entryId) {
      skillCheckLine(tl('DONE · {tally} · shown only, not kept', { tally }));
      return;
    }
    const saved = await post('network', {
      skillCheck: true,
      id: entryId,
      record: { via, verdicts },
    });
    skillCheckLine(
      saved
        ? tl('DONE · {tally} · SAVED BESIDE THE TOKEN', { tally })
        : tl('DONE · {tally} · NOT SAVED', { tally }),
    );
  };
  const fillSkillsFromPastedToken = async () => {
    const input = byId(documentRef, 'ultra-skill-check-skills');
    const raw = String(input?.value || '');
    const pasted = readPastedUltraTokenSkills(raw);
    if (!pasted) return true;
    if (pasted.error) {
      skillCheckLine(pasted.error);
      return false;
    }
    let labels = pasted.skills;
    if (pasted.encrypted) {
      const token = raw.replace(/\s+/g, '');
      let data = null;
      try {
        const response = await fetchImpl('/api/ultra-help/network', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ readTokenSkills: true, token }),
        });
        data = await response.json().catch(() => null);
        if (!response.ok) data = null;
      } catch {
        data = null;
      }
      labels = Array.isArray(data?.skills)
        ? data.skills.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      if (!labels.length) {
        skillCheckLine(
          tl(
            'Those skills are encrypted. Type the ones they told you, or use CONFIRM ULTRA TOKEN SKILLS on the home-list row.',
          ),
        );
        return false;
      }
    }
    if (!labels.length) {
      skillCheckLine(tl('That token names no skills.'));
      return false;
    }
    if (input) input.value = labels.join(', ');
    return true;
  };
  const runSkillCheckPress = async () => {
    if (skillChecking || disposed) return;
    const form = byId(documentRef, 'ultra-skill-check');
    if (!(await fillSkillsFromPastedToken())) return;
    const checked = cleanSkillCheckClaim(readSkillCheckForm(documentRef));
    if (!checked.ok) {
      skillCheckLine(checked.error);
      return;
    }
    const run = byId(documentRef, 'ultra-skill-check-run');
    const label = run?.textContent || tl('CHECK SKILLS');
    skillChecking = true;
    if (run) {
      run.disabled = true;
      run.textContent = tl('CHECKING…');
    }
    const paste = byId(documentRef, 'ultra-skill-check-paste');
    if (paste) paste.hidden = true;
    if (form) delete form.dataset.ultraSkillSkills;
    const provider = byId(documentRef, 'ultra-skill-check-swarm')?.value;
    const askingLlm = skillCheckLlm(provider);
    skillCheckLine(
      askingLlm ? tl('ASKING THE MODEL…') : tl('SPINNING UP SWARM…'),
    );
    try {
      const result = await runSkillCheck({
        request: fetchImpl,
        provider,
        claim: checked.claim,
        onProgress({ back, total }) {
          skillCheckLine(
            askingLlm
              ? tl('MODEL OUT · {back}/{total} BACK', { back, total })
              : tl('SWARM OUT · {back}/{total} BACK', { back, total }),
          );
        },
      });
      if (disposed) return;
      if (!result.ok) {
        skillCheckLine(
          result.error ? tl(result.error) : tl('The check did not run.'),
        );
        return;
      }
      if (result.via === 'desktop') {
        if (form) form.dataset.ultraSkillSkills = JSON.stringify(result.skills);
        if (paste) paste.hidden = false;
        skillCheckLine(
          `${formatSwarmDesktopStatus(result)} ${tl('Paste its report below, then READ REPORT.')}`,
        );
        return;
      }
      await keepSkillVerdicts(
        result.via,
        result.verdicts,
        result.failed
          ? ` · ${tl('{failed} of {total} bots failed', { failed: result.failed, total: result.total })}`
          : '',
      );
    } catch {
      skillCheckLine(tl('The check did not run.'));
    } finally {
      skillChecking = false;
      if (run) {
        run.disabled = false;
        run.textContent = label;
      }
    }
  };
  const readSkillReport = async () => {
    const form = byId(documentRef, 'ultra-skill-check');
    const box = byId(documentRef, 'ultra-skill-check-report');
    const text = String(box?.value || '').trim();
    if (!text) {
      skillCheckLine(tl("Paste the Chief of Staff's report first."));
      return;
    }
    let skills = [];
    try {
      skills = JSON.parse(form?.dataset?.ultraSkillSkills || '[]');
    } catch {
      skills = [];
    }
    if (!Array.isArray(skills) || !skills.length) {
      const checked = cleanSkillCheckClaim(readSkillCheckForm(documentRef));
      skills = checked.ok ? checked.claim.skills : [];
    }
    if (!skills.length) {
      skillCheckLine(tl('Name the skills the report is about first.'));
      return;
    }
    const { verdicts } = readPastedSkillReport(text, skills);
    /* The report is read once and not kept: only the verdicts are. */
    if (box) box.value = '';
    await keepSkillVerdicts('pasted', verdicts);
  };
  const onClick = (event) => {
    const target = event.target;
    const camera = target?.closest?.('[data-ultra-camera]');
    const viewItem = target?.closest?.('[data-ultra-media-view]');
    if (viewItem) {
      dispatchWindow(ULTRA_MEDIA_VIEW_EVENT, {
        name: viewItem.dataset.ultraMediaView,
        kind: viewItem.dataset.ultraMediaKind,
      });
      return;
    }
    if (target?.id === 'ultra-media-delete') {
      void deleteMedia();
      return;
    }
    const step = target?.closest?.('[data-ultra-media-step]');
    if (step) {
      stepMedia(
        step.dataset.ultraMediaStep,
        Number(step.dataset.ultraMediaDir) || 1,
      );
      return;
    }
    if (camera && !camera.closest?.('[data-ultra-camera-row]')?.hidden) {
      void post('camera', {
        role: camera.dataset.ultraCamera,
        mode: camera.dataset.ultraMode || 'video',
      });
      setTimeout(() => void loadMedia(), 4000);
      return;
    }
    const id = target?.id;
    if (id === 'ultra-swarm-run') {
      void runSwarm();
      return;
    }
    const cellAction = target?.dataset?.ultraCellAction;
    const cellTarget = target?.dataset?.ultraCellId;
    if (cellAction && cellTarget) {
      if (cellAction === 'only') {
        hiddenCells = new Set(cellIds().filter((item) => item !== cellTarget));
        noPathCells.delete(cellTarget);
        sendHiddenCells();
        showCellsLayer();
        paintCells(latest, true);
      } else if (cellAction === 'map') {
        // On the map first (a hidden cell has no pin to fly to).
        if (hiddenCells.delete(cellTarget)) {
          sendHiddenCells();
          paintCells(latest, true);
        }
        dispatchWindow(DEVICE_FEEDS_CHANGED_EVENT, { count: 1 });
        dispatchWindow(DEVICE_FEEDS_FOCUS_EVENT, { id: cellTarget });
      }
      return;
    }
    if (id === 'ultra-cells-all') {
      hiddenCells = new Set();
      noPathCells = new Set();
      sendHiddenCells();
      showCellsLayer();
      paintCells(latest, true);
      return;
    }
    if (id === 'ultra-release-send') {
      /* With several packages the press names the one chosen beside the
       * button, so EXTEND HELP renews that call and no other. */
      const feedId = chosenReleasePackage(documentRef);
      const name = feedId
        ? String(
            (Array.isArray(latest?.packages) ? latest.packages : []).find(
              (feed) => feed?.id === feedId,
            )?.name || feedId,
          )
        : '';
      if (
        !confirmed(
          name
            ? tl(
                "Send help for {name}? That package's position and the incident go to its token holders with NETWORK on for four hours, and the phone gets the plea for your saved helpers.",
                { name },
              )
            : tl(
                "Send help? Your phone's position and the incident go to your token holders with NETWORK on for four hours, and the phone gets the plea for your saved helpers.",
              ),
        )
      )
        return;
      /* EXTEND HELP renews the call as it is: its own incident, never
       * whatever the FIND HELP select happens to show. */
      const running = releaseFor(latest, feedId);
      void post('release', {
        incident:
          running?.incident ||
          byId(documentRef, 'ultra-incident')?.value ||
          'other',
        ...(feedId ? { feedId } : {}),
      });
      return;
    }
    if (id === 'ultra-release-stand-down') {
      /* No confirm: standing down is the safe direction. It ends the chosen
       * package's call only. The button stays beside SEND HELP with no call
       * on, where a press ends nothing, so an answer showing no call running
       * anywhere says so; another package's call keeps its own line. */
      const feedId = chosenReleasePackage(documentRef);
      void post('release', {
        standDown: true,
        ...(feedId ? { feedId } : {}),
      }).then((status) => {
        if (
          status &&
          !releaseFor(status, '') &&
          !runningReleases(status).length
        )
          say(tl('STOOD DOWN · NO CALL FOR HELP IS ON'));
      });
      return;
    }
    if (id === 'ultra-number-clear') {
      void post('number', { number: '' });
      return;
    }
    if (id === 'ultra-token-copy-address') {
      void copyFrom('ultra-token-reveal', target, 'ultraAddress');
      return;
    }
    if (id === 'ultra-token-copy') {
      void copyFrom('ultra-token-reveal', target, 'ultraToken');
      return;
    }
    if (id === 'ultra-token-hide') {
      applyUltraHelpStatus(documentRef, { ...(latest || {}), revealed: null });
      return;
    }
    if (id === 'ultra-network-publish') {
      const select = byId(documentRef, 'ultra-publish-token');
      const pick = byId(documentRef, 'ultra-publish-package');
      /* A chosen token carries its own package; DIRECTORY TOKEN names one
       * when there is more than one to choose from. */
      const feedId =
        !select?.value && pick && !pick.hidden
          ? pick.value || undefined
          : undefined;
      void post('network', {
        publish: true,
        id: select?.value || undefined,
        ...(feedId ? { feedId } : {}),
      });
      return;
    }
    if (id === 'ultra-network-update') {
      void post('network', { update: true });
      return;
    }
    if (id === 'ultra-network-poll') {
      void post('network', { poll: true });
      return;
    }
    if (id === 'ultra-sms-test') {
      void post('network', { testSms: true });
      return;
    }
    if (id === 'ultra-network-entry-copy') {
      void copyFrom('ultra-network-entry', target, 'ultraEntry');
      return;
    }
    if (id === 'ultra-network-entry-hide') {
      applyUltraHelpStatus(documentRef, { ...(latest || {}), published: null });
      return;
    }
    const remove = target?.closest?.('[data-ultra-remove]');
    if (remove) {
      void post('contacts', { remove: true, id: remove.dataset.ultraRemove });
      return;
    }
    const inboxRead = target?.closest?.('[data-ultra-inbox-read]');
    if (inboxRead) {
      void post('inbox', { read: true, id: inboxRead.dataset.ultraInboxRead });
      return;
    }
    const inboxRemove = target?.closest?.('[data-ultra-inbox-remove]');
    if (inboxRemove) {
      void post('inbox', {
        remove: true,
        id: inboxRemove.dataset.ultraInboxRemove,
      });
      return;
    }
    if (id === 'ultra-skill-check-open') {
      openSkillCheck(null);
      return;
    }
    if (id === 'ultra-skill-check-close') {
      const form = byId(documentRef, 'ultra-skill-check');
      if (form) form.hidden = true;
      return;
    }
    if (id === 'ultra-skill-check-read') {
      void readSkillReport();
      return;
    }
    const skillCheck = target?.closest?.('[data-ultra-skill-check]');
    if (skillCheck) {
      const entryId = skillCheck.dataset.ultraSkillCheck;
      openSkillCheck(
        (latest?.network?.entries || []).find((item) => item?.id === entryId) ||
          null,
      );
      return;
    }
    const map = target?.closest?.('[data-ultra-network-map]');
    if (map) {
      dispatchFocus(map.dataset.ultraNetworkMap);
      return;
    }
    const rename = target?.closest?.('[data-ultra-network-rename]');
    if (rename) {
      const entryId = rename.dataset.ultraNetworkRename;
      const entry = (latest?.network?.entries || []).find(
        (item) => item?.id === entryId,
      );
      const name = byId(documentRef, 'ultra-network-link-name');
      if (name) name.value = entry?.name || '';
      const form = byId(documentRef, 'ultra-network-add');
      if (form) {
        form.dataset.ultraRenaming = entryId;
        const submit = form.querySelector?.('button');
        if (submit) submit.textContent = tl('RENAME');
        const addressInput = byId(documentRef, 'ultra-network-address');
        if (addressInput) {
          addressInput.value = '';
          addressInput.placeholder = tl(ADD_RENAMING_PLACEHOLDER);
        }
        const tokenInput = byId(documentRef, 'ultra-network-token');
        if (tokenInput) {
          tokenInput.value = '';
          tokenInput.placeholder = tl(ADD_TOKEN_PLACEHOLDER);
        }
      }
      return;
    }
    const networkRemove = target?.closest?.('[data-ultra-network-remove]');
    if (networkRemove) {
      if (
        !confirmed(
          tl(
            'Remove this link from your home list? Their calls for help stop reaching you.',
          ),
        )
      )
        return;
      void post('network', {
        remove: true,
        id: networkRemove.dataset.ultraNetworkRemove,
      });
      return;
    }
    const share = target?.closest?.('[data-ultra-token-share]');
    if (share) {
      void post('tokens', { reveal: true, id: share.dataset.ultraTokenShare });
      return;
    }
    const edit = target?.closest?.('[data-ultra-token-edit]');
    if (edit) {
      /* NETWORK ON / NETWORK OFF is the one switch a token has. */
      void post('tokens', {
        edit: true,
        id: edit.dataset.ultraTokenEdit,
        network: edit.dataset.ultraCurrent !== '1',
      });
      return;
    }
    const revoke = target?.closest?.('[data-ultra-token-revoke]');
    if (revoke) {
      if (!confirmed(tl('Revoke this token? The link stops working at once.')))
        return;
      void post('tokens', {
        revoke: true,
        id: revoke.dataset.ultraTokenRevoke,
      });
      return;
    }
    const tokenRemove = target?.closest?.('[data-ultra-token-remove]');
    if (tokenRemove) {
      void post('tokens', {
        remove: true,
        id: tokenRemove.dataset.ultraTokenRemove,
      });
      return;
    }
    if (target?.closest?.('[data-ultra-token-purge]')) {
      void post('tokens', { purge: true });
      return;
    }
    if (target?.closest?.('[data-ultra-token-reset]')) {
      if (
        !confirmed(
          tl(
            'Reset every help token? Every link stops working, the key file is deleted, and your home list is emptied (UPDATE HOME LIST brings the directory back).',
          ),
        )
      )
        return;
      void post('tokens', { reset: true, confirm: true });
    }
  };
  const onChange = (event) => {
    /* Another package chosen: its own call shows at once, not at the next poll. */
    /* Choosing a token hides the package choice; DIRECTORY TOKEN shows it. */
    if (event.target?.id === 'ultra-publish-token') {
      if (latest) paintPublishPackage(documentRef, latest);
      return;
    }
    if (event.target?.id === 'ultra-release-package') {
      /* The owner's own pick from now on: the box stops following new calls. */
      event.target.dataset.ultraPicked = '1';
      if (latest) paintRelease(documentRef, latest);
      return;
    }
    if (event.target?.id === 'ultra-camera-cell') {
      void post('camera-cell', { id: event.target.value });
      return;
    }
    if (event.target?.id === 'ultra-model') {
      applyUltraHelpStatus(documentRef, {
        ...(latest || {}),
        model: { id: event.target.value },
      });
      void post('model', { modelId: event.target.value });
      return;
    }
    if (event.target?.dataset?.ultraCellRecord) {
      void saveCellRecord(event.target);
      return;
    }
    if (Object.values(MEDIA_ON_MAP_BOXES).includes(event.target?.id)) {
      saveOnMap();
      sendMedia();
      return;
    }
    if (event.target?.id === 'ultra-media-delete-all') {
      disarmDelete();
      return;
    }
    const mediaName = event.target?.dataset?.ultraMediaName;
    if (mediaName) {
      if (event.target.checked) selectedMedia.add(mediaName);
      else selectedMedia.delete(mediaName);
      saveSelection();
      disarmDelete();
      sendMedia();
      return;
    }
    const pathId = event.target?.dataset?.ultraCellPath;
    if (pathId) {
      if (event.target.checked === false) noPathCells.add(pathId);
      else noPathCells.delete(pathId);
      sendHiddenCells();
      paintCells(latest, true);
      return;
    }
    const cellId = event.target?.dataset?.ultraCellMap;
    if (cellId) {
      if (event.target.checked === false) hiddenCells.add(cellId);
      else {
        hiddenCells.delete(cellId);
        showCellsLayer();
      }
      sendHiddenCells();
      paintCells(latest, true);
      return;
    }
    const switched =
      event.target?.id === 'ultra-map-show'
        ? ULTRA_MAP_LAYER_ID
        : event.target?.id === 'ultra-private-cams'
          ? PRIVATE_CAMS_LAYER_ID
          : null;
    if (switched) {
      const on = event.target.checked !== false;
      Promise.resolve(
        dataManager?.setEnabled?.(switched, on, { origin: 'user' }),
      )
        .catch(() => {})
        .finally(paintMapBox);
      return;
    }
    if (event.target?.id === 'ultra-map-period') {
      const period = deviceHistoryPeriod(event.target.value).id;
      event.target.value = period;
      rememberMapPeriod(period);
      dispatchWindow(DEVICE_FEEDS_HISTORY_EVENT, { period });
      return;
    }
    if (event.target?.id === 'ultra-read-aloud') {
      rememberReadAloud(event.target.checked !== false);
      /* Unticking also silences what is already queued; a flood of long
       * messages could otherwise keep talking for minutes. */
      if (event.target.checked === false) {
        try {
          globalThis.speechSynthesis?.cancel();
        } catch {
          /* No voice to stop. */
        }
      }
      return;
    }
    if (String(event.target?.id || '').startsWith('ultra-skill-custom-'))
      paintCustomSkillPreview(documentRef);
    if (event.target?.dataset?.ultraSkillCheckApp)
      syncSkillCheckAppLimit(documentRef);
    if (
      event.target?.id === 'ultra-skill-check-skills' &&
      readPastedUltraTokenSkills(event.target.value)
    )
      void fillSkillsFromPastedToken();
  };
  const onCustomSkill = (event) => {
    if (String(event.target?.id || '').startsWith('ultra-skill-custom-'))
      paintCustomSkillPreview(documentRef);
    if (
      event.target?.id === 'ultra-skill-check-skills' &&
      readPastedUltraTokenSkills(event.target.value)
    )
      void fillSkillsFromPastedToken();
  };
  const onSubmit = (event) => {
    const id = event.target?.id;
    if (id === 'ultra-skill-check') {
      event.preventDefault();
      void runSkillCheckPress();
      return;
    }
    if (id === 'ultra-contact') {
      event.preventDefault();
      void post('contacts', {
        label: byId(documentRef, 'ultra-contact-label')?.value,
        number: byId(documentRef, 'ultra-contact-number')?.value,
        kind: byId(documentRef, 'ultra-contact-kind')?.value,
      });
      return;
    }
    if (id === 'ultra-cell-add') {
      event.preventDefault();
      void addCell();
      return;
    }
    if (id === 'ultra-number') {
      event.preventDefault();
      const input = byId(documentRef, 'ultra-number-input');
      const value = String(input?.value || '').trim();
      /* An empty SAVE is not a CLEAR; clearing has its own button, so an
       * Enter on the blank field cannot silently drop the saved number. */
      if (!value) return;
      void post('number', { number: value }).then((status) => {
        if (status && input) input.value = '';
      });
      return;
    }
    if (id === 'ultra-token') {
      event.preventDefault();
      const label = byId(documentRef, 'ultra-token-label');
      const select = byId(documentRef, 'ultra-token-package');
      const body = {
        label: label?.value || '',
        /* Always sent: the server treats an omitted flag as off. */
        network: byId(documentRef, 'ultra-token-network')?.checked !== false,
        encrypt: byId(documentRef, 'ultra-token-encrypt')?.checked === true,
        skills: chosenSkillCodes(documentRef),
        custom: chosenCustomSkills(documentRef),
      };
      /* The same check the mint runs. A list it will refuse is said here
       * and not posted, so GENERATE does not flash and the boxes stay. */
      const customSkills = ultraCustomSkillList(body.custom);
      if (!customSkills.ok) {
        say(customSkills.error);
        paintCustomSkillPreview(documentRef);
        return;
      }
      if (select?.value) body.feedId = select.value;
      /* The button says what is happening: GENERATING… while the token is
       * made (and a second press then is not a second token), GENERATED for
       * two seconds once it is — pressable again at once — then its own
       * words. A refusal puts it back at once; the reason is on the status
       * line. */
      const button = byId(documentRef, 'ultra-token-submit');
      if (button?.disabled) return;
      clearTimeout(mintLabelTimer);
      if (button) {
        button.disabled = true;
        button.textContent = tl(MINT_LABEL.busy);
      }
      void post('tokens', body).then((status) => {
        if (!status) {
          if (button) {
            button.disabled = false;
            button.textContent = tl(MINT_LABEL.idle);
          }
          return;
        }
        if (button) {
          /* Ready for the next token at once; the word stays two seconds. */
          button.disabled = false;
          button.textContent = tl(MINT_LABEL.done);
          mintLabelTimer = setTimeout(() => {
            if (button.textContent === tl(MINT_LABEL.done))
              button.textContent = tl(MINT_LABEL.idle);
          }, MINT_DONE_MS);
        }
        if (label) label.value = '';
        /* Skills name this one person. The next token starts from none. */
        clearTokenSkills(documentRef);
      });
      return;
    }
    if (id === 'ultra-network-me') {
      event.preventDefault();
      const input = byId(documentRef, 'ultra-network-me-name');
      const name = String(input?.value || '').trim();
      void post('network', { me: true, name }).then((status) => {
        if (status && input) input.value = '';
      });
      return;
    }
    if (id === 'ultra-network-add') {
      event.preventDefault();
      const form = byId(documentRef, 'ultra-network-add');
      const addressInput = byId(documentRef, 'ultra-network-address');
      const tokenInput = byId(documentRef, 'ultra-network-token');
      const nameInput = byId(documentRef, 'ultra-network-link-name');
      const name = String(nameInput?.value || '').trim();
      const renaming = form?.dataset?.ultraRenaming || '';
      /* A legacy whole link in the address box is split here; the server
       * never sees a string that is both an address and a token. */
      const { address, token } = splitUltraHandout(
        addressInput?.value,
        tokenInput?.value,
      );
      const handout = Boolean(address || token);
      /* An entered handout is always an ADD, even if RENAME was armed and
       * forgotten: renaming here would drop the handout on the floor. */
      if (renaming && handout) endRenaming(documentRef);
      if (!renaming || handout) {
        /* Half a handout is refused here, before anything is posted. */
        if (!address || !token) {
          say(tl(ADD_INCOMPLETE));
          return;
        }
      }
      const request =
        renaming && !handout
          ? post('network', { rename: true, id: renaming, name })
          : post('network', { add: true, address, token, name });
      void request.then((status) => {
        /* RENAME pressed on a row while this was on its way owns the form
         * now: leave it, and the name it filled in, alone. */
        const armed = form?.dataset?.ultraRenaming || '';
        if (armed && armed !== renaming) return;
        /* A refused rename lets go too, or the form would say RENAME for
         * good (a row that is gone can never be renamed). */
        endRenaming(documentRef);
        if (!status) return;
        if (addressInput) addressInput.value = '';
        if (tokenInput) tokenInput.value = '';
        if (nameInput) nameInput.value = '';
      });
      return;
    }
    if (id === 'ultra-directory') {
      event.preventDefault();
      const urlInput = byId(documentRef, 'ultra-directory-url');
      const tokenInput = byId(documentRef, 'ultra-directory-token');
      const url = String(urlInput?.value || '').trim();
      const token = String(tokenInput?.value || '').trim();
      /* The write token leaves the field the moment SAVE is pressed,
       * whatever the route answers: it is never left on screen. */
      if (tokenInput) tokenInput.value = '';
      if (!url && !token) return;
      const body = {};
      if (url) body.ULTRA_DIRECTORY_URL = url;
      if (token) body.ULTRA_DIRECTORY_WRITE_TOKEN = token;
      void saveEnv(body).then((ok) => {
        if (ok && urlInput) urlInput.value = '';
      });
    }
  };
  panel.addEventListener('click', onClick);
  panel.addEventListener('change', onChange);
  panel.addEventListener('input', onCustomSkill);
  panel.addEventListener('submit', onSubmit);
  const load = async () => {
    try {
      const response = await fetchImpl(STATUS, { cache: 'no-store', signal });
      if (!response.ok || disposed) return;
      paint(await response.json());
    } catch {
      /* A poll that did not answer is not news about the package. Repainting
       * from nothing would put SEND HELP back, hide STAND DOWN and say nobody
       * receives it while a call for help is running. Say the line went quiet
       * and leave every painted row where it is. */
      if (disposed) return;
      /* The last action's sentence (HELP NOT SENT, for one) stays up for its
       * fifteen seconds while the server is down, as it does on a good poll. */
      if (notice && Date.now() - notice.at <= NOTICE_MS) return;
      const statusLine = byId(documentRef, 'ultra-status');
      if (statusLine) {
        statusLine.textContent = latest
          ? tl('NO ANSWER FROM THE DEV SERVER — showing the last known state')
          : tl('NO ANSWER FROM THE DEV SERVER — is npm run dev running?');
      }
    }
  };
  /* The photos and videos the phone sent, newest first. The ticked ones are
   * on the map beside the Ultra cell (the Cell layer draws them); this box
   * says which, and which one of each shows now. */
  let mediaItems = [];
  let knownMedia = null;
  const mediaIndex = { photos: 0, videos: 0 };
  let storedSelection = null;
  try {
    storedSelection = windowRef?.localStorage?.getItem(
      ULTRA_MEDIA_SELECTED_KEY,
    );
  } catch {
    storedSelection = null;
  }
  const selectedMedia = new Set(ultraMediaNames(parseList(storedSelection)));
  const saveSelection = () => {
    try {
      windowRef?.localStorage?.setItem(
        ULTRA_MEDIA_SELECTED_KEY,
        JSON.stringify([...selectedMedia]),
      );
    } catch {
      /* This browser keeps nothing: the choice lasts this visit. */
    }
  };
  const ticked = (kind) =>
    mediaItems
      .filter((item) => item.kind === kind && selectedMedia.has(item.name))
      .map((item) => item.name);
  // Nothing ticked is where the map starts, so it is never announced.
  let lastMediaSaid = JSON.stringify({
    photos: [],
    videos: [],
    photoIndex: 0,
    videoIndex: 0,
  });
  // PHOTOS ON MAP and VIDEOS ON MAP: unticked, that kind leaves the map
  // (the list and its CCTV button still show them). Kept in this browser.
  try {
    const kept = JSON.parse(
      windowRef?.localStorage?.getItem(ULTRA_MEDIA_ON_MAP_KEY) || '{}',
    );
    for (const [key, id] of Object.entries(MEDIA_ON_MAP_BOXES)) {
      const box = byId(documentRef, id);
      if (box && kept?.[key] === false) box.checked = false;
    }
  } catch {
    /* Both on the map. */
  }
  const onMap = (key) =>
    byId(documentRef, MEDIA_ON_MAP_BOXES[key])?.checked !== false;
  const saveOnMap = () => {
    try {
      windowRef?.localStorage?.setItem(
        ULTRA_MEDIA_ON_MAP_KEY,
        JSON.stringify({ photos: onMap('photos'), videos: onMap('videos') }),
      );
    } catch {
      /* The choice lasts this visit. */
    }
  };
  const sendMedia = () => {
    const photos = ticked('photo');
    const videos = ticked('clip');
    for (const [key, list] of [
      ['photos', photos],
      ['videos', videos],
    ])
      mediaIndex[key] = list.length
        ? ((mediaIndex[key] % list.length) + list.length) % list.length
        : 0;
    // Three of each are on the map at once: say which ones, of how many.
    const position = (list, index) => {
      if (!list.length) return tl('NONE TICKED');
      if (list.length <= 3) return tl('ALL {count}', { count: list.length });
      const last = ((index + 2) % list.length) + 1;
      return tl('{first}–{last} OF {count}', {
        first: index + 1,
        last,
        count: list.length,
      });
    };
    const photoPos = byId(documentRef, 'ultra-photo-pos');
    if (photoPos) photoPos.textContent = position(photos, mediaIndex.photos);
    const videoPos = byId(documentRef, 'ultra-video-pos');
    if (videoPos) videoPos.textContent = position(videos, mediaIndex.videos);
    paintDelete();
    const detail = {
      photos: onMap('photos') ? photos : [],
      videos: onMap('videos') ? videos : [],
      photoIndex: mediaIndex.photos,
      videoIndex: mediaIndex.videos,
    };
    // Told only when something changed: the list is read every few seconds.
    const said = JSON.stringify(detail);
    if (said === lastMediaSaid) return;
    lastMediaSaid = said;
    dispatchWindow(ULTRA_MEDIA_EVENT, detail);
  };
  /* DELETE: the ticked ones, or every one with All ticked. The first press
   * asks; a second press within a few seconds deletes. */
  let deleteArmed = null;
  const deleteTargets = () =>
    byId(documentRef, 'ultra-media-delete-all')?.checked
      ? mediaItems.map((item) => item.name)
      : mediaItems
          .filter((item) => selectedMedia.has(item.name))
          .map((item) => item.name);
  const paintDelete = () => {
    const button = byId(documentRef, 'ultra-media-delete');
    if (!button) return;
    const all = Boolean(byId(documentRef, 'ultra-media-delete-all')?.checked);
    const count = deleteTargets().length;
    button.disabled = count === 0;
    button.textContent = deleteArmed
      ? tl('SURE? DELETE {count}', { count })
      : all
        ? `${tl('DELETE ALL')}${count ? ` ${count}` : ''}`
        : `${tl('DELETE TICKED')}${count ? ` ${count}` : ''}`;
  };
  const disarmDelete = () => {
    if (deleteArmed) clearTimeout(deleteArmed);
    deleteArmed = null;
    paintDelete();
  };
  const deleteMedia = async () => {
    const all = Boolean(byId(documentRef, 'ultra-media-delete-all')?.checked);
    const names = deleteTargets();
    if (!names.length) return disarmDelete();
    if (!deleteArmed) {
      deleteArmed = setTimeout(disarmDelete, ULTRA_MEDIA_DELETE_CONFIRM_MS);
      paintDelete();
      return;
    }
    disarmDelete();
    try {
      const response = await watchOwnerRemoval(
        fetchImpl('/api/ultra-help/media/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(all ? { all: true } : { names }),
        }),
      );
      if (!response.ok) {
        // Only the PC removes: on the owner's phone this is a quiet
        // no-op, and the ticks and the DELETE ALL box stay as they were.
        if (isOwnerRemovalRefusal(response)) return;
        let refused = null;
        try {
          refused = await response.json();
        } catch {
          /* Keep the fallback line. */
        }
        if (isOwnerRemovalRefusal(response, refused)) {
          noteOwnerRemovalRefusal();
          return;
        }
        say(tl('DELETE refused'));
        return;
      }
      const deleted = (await response.json())?.deleted || [];
      say(tl('DELETED {count}', { count: deleted.length }));
    } catch {
      say(tl('DELETE: no answer from the dev server'));
      return;
    }
    const box = byId(documentRef, 'ultra-media-delete-all');
    if (box) box.checked = false;
    await loadMedia();
  };
  const stepMedia = (key, dir) => {
    mediaIndex[key] += dir;
    sendMedia();
  };
  /* A photo or video clicked on the map, or CCTV in the list: the CCTV viewer. */
  const onViewMedia = (event) =>
    showUltraMediaInCctv(documentRef, event?.detail || {});
  windowRef?.addEventListener?.(ULTRA_MEDIA_VIEW_EVENT, onViewMedia);
  const loadMedia = async () => {
    let items = [];
    try {
      const response = await fetchImpl('/api/ultra-help/media', {
        cache: 'no-store',
        signal,
      });
      if (!response.ok || disposed) return;
      items = (await response.json())?.items || [];
    } catch {
      return;
    }
    mediaItems = items;
    const names = new Set(items.map((item) => item.name));
    // The newest photo and the newest video go on the map as they arrive
    // (and on a first visit with nothing chosen yet); the rest are the
    // owner's to tick.
    for (const kind of ['photo', 'clip']) {
      const newest = items.find((item) => item.kind === kind);
      if (!newest) continue;
      const arrived = knownMedia && !knownMedia.has(newest.name);
      const firstVisit = !knownMedia && !storedSelection;
      if (arrived || firstVisit) {
        selectedMedia.add(newest.name);
        // Show the new one now: it is first in the list.
        mediaIndex[kind === 'photo' ? 'photos' : 'videos'] = 0;
      }
    }
    knownMedia = names;
    for (const name of [...selectedMedia])
      if (!names.has(name)) selectedMedia.delete(name);
    saveSelection();
    paintMedia(documentRef, items, selectedMedia);
    sendMedia();
  };
  /* ULTRA SECURITY PACKAGE, last in the tab (moved from POWER UP, owner
   * request 2026-10-17): the package cards, drawn in the tab's own labels,
   * notes, rows and buttons. Hidden until /api/device-feeds answers. A save
   * here tells the map and POWER UP's devices section. */
  const packageHost = byId(documentRef, 'ultra-package-setup');
  const packageSetup = packageHost
    ? initDeviceFeedSetup({
        host: packageHost,
        documentRef,
        fetchImpl,
        signal,
        look: 'ultra',
        showKind: (kind) => kind.id === ULTRA_PACKAGE_KIND,
      })
    : null;
  void load();
  void loadMedia();
  let mediaTick = 0;
  const refreshStatus = setInterval(() => {
    void load();
    mediaTick += 1;
    if (mediaTick % 3 === 0) void loadMedia();
  }, 3000);
  return {
    destroy() {
      disposed = true;
      clearInterval(refreshStatus);
      windowRef?.removeEventListener?.(ULTRA_MEDIA_VIEW_EVENT, onViewMedia);
      if (deleteArmed) clearTimeout(deleteArmed);
      clearTimeout(mintLabelTimer);
      for (const entry of copyTimers.values()) clearTimeout(entry?.timer);
      panel.removeEventListener('click', onClick);
      panel.removeEventListener('change', onChange);
      panel.removeEventListener('input', onCustomSkill);
      panel.removeEventListener('submit', onSubmit);
      stopMapWatch();
      packageSetup?.destroy();
    },
  };
}
