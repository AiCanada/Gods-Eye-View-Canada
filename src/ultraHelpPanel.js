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
import {
  ultraCameraRole,
  ultraCustomSkillList,
  ultraHelpSmsLink,
  ultraNeedsSkill,
  ultraNeedsSummary,
} from './ultraHelp.mjs';
import {
  DEVICE_FEEDS_CHANGED_EVENT,
  DEVICE_FEEDS_FOCUS_EVENT,
} from './deviceFeedsCore.mjs';

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
/* The key-setup route's own sentence, painted verbatim after SAVE DIRECTORY. */
const ENV_SAVED =
  'Saved to your local .env. Restarting — this page reloads itself.';

const TOKEN_NOTE = {
  unreadable:
    'The token store exists but cannot be read: fix the file or RESET TOKENS (every link stops working).',
  'key-invalid':
    'The token key file is present but not valid: existing tokens still work but cannot be shown or added to; RESET TOKENS to start again.',
  'no-key':
    'The token key file is missing: existing tokens still work but cannot be shown or added to; revoke them or RESET TOKENS, then mint again',
  'key-changed':
    'The token key file was replaced: existing tokens still work but cannot be shown; revoke them and mint again, or RESET TOKENS.',
  'key-exposed':
    'The token key file is no longer restricted to your account: another account on this computer could read it. Restore owner-only access to it, or RESET TOKENS and mint again.',
  'store-changed':
    'The token store was changed outside this program: a token row was removed, added or reordered. Check the rows below; minting, revoking or editing a token accepts the file as it is, RESET TOKENS starts again.',
  'no-listener':
    'Share links need the report listener: save the package under POWER UP and keep npm run dev running; SHARE shows the bare token until then',
};

const RELEASE_NOTE = {
  nobody:
    'Nobody receives this yet: tick Network on GENERATE NEW TOKEN, press NETWORK ON on a token below, or PUBLISH MY TOKEN under HELP NETWORK. The plea still goes to your phone for the PREDEFINED HELP # numbers.',
  'no-position':
    'Needs your position: open the phone link on the phone, or press SEND HELP there.',
};

const NETWORK_NOTE = {
  key: 'The token key file is missing or not valid, so the links in your home list cannot be opened or polled: revoke your tokens or RESET TOKENS, then add or UPDATE HOME LIST again',
  preview:
    'Polling runs under npm run dev only (vite preview shows the list without checking it)',
  directory:
    "Directory: none. Paste your group's directory address (an https file: GitHub, Hugging Face or Private Server) and SAVE DIRECTORY: it is written to your local .env, the dev server restarts and this page reloads. Only https Tail Net links are accepted.",
  /* The no-directory note's last line, on a line of its own. */
  activate:
    'Net Work activated when Tail Net + Ultra Encryption Token is released via HELP request.',
};

/* What a home-list row says about its link. 'quiet' is decided by age. */
const NETWORK_STATE = {
  new: 'NOT CHECKED YET',
  released: 'NEEDS HELP',
  off: 'NOT SHARING',
  dead: 'TOKEN DEAD (404)',
  unreachable: 'UNREACHABLE (is their machine on the tailnet?)',
  busy: 'BUSY (429)',
  'not-tailnet': 'NOT A TAILNET ADDRESS',
  missing: 'NOT IN DIRECTORY',
  moved: 'MOVED',
  own: 'YOUR OWN TOKEN',
  'no-key': 'NO KEY',
  tampered: 'TAMPERED',
};

const ENTRY_NOTE = {
  clipboard:
    'Send this to whoever keeps the directory, or paste it into the file yourself. Anyone who can read the directory sees where your phone is and threat type while you have pressed SEND HELP and have Network On.',
  github:
    'Written to the directory. GitHub serves raw files from a cache, so the others may see it only after about five minutes when they press UPDATE HOME LIST. Anyone who can read the directory sees where your phone is and threat type while you have pressed SEND HELP and have Network On.',
};

/* The form placeholders as the page ships them, restored when a saved value
 * goes away again (the poll repaints every three seconds). */
const PLACEHOLDER = {
  meName: 'Your name, as your holders see it',
  directoryUrl:
    'https://raw.githubusercontent.com/<group>/<repo>/main/ultra-directory.json',
  directoryToken: 'GitHub write token (optional, never shown)',
  directoryTokenSaved: 'write token saved — paste to replace, never shown',
};

/* What a token row and the reveal box say when the skills are sealed under
 * a key this machine does not hold (missing, invalid or replaced). Distinct
 * from an encrypted token minted with no skill sets, which the key opens. */
const SKILLS_HIDDEN_WORD = 'SKILLS HIDDEN (KEY MISSING OR CHANGED)';
const SKILLS_HIDDEN_LINE =
  'Skills hidden: the token key is missing or was changed, so the sealed skill sets cannot be shown';

/* How long the last action's sentence survives the status poll. */
const NOTICE_MS = 15_000;
/** What the token button says: at rest, while a token is made, and just after. */
const MINT_LABEL = Object.freeze({
  idle: 'GENERATE NEW TOKEN',
  busy: 'GENERATING…',
  done: 'GENERATED',
});
const MINT_DONE_MS = 2_000;

/* The ADD form's own placeholders, restored when RENAME lets go of it. A
 * handout is two things now, an address and a token, never one link. */
const ADD_ADDRESS_PLACEHOLDER =
  'Their tailnet address (https://<machine>.<tailnet>.ts.net)';
const ADD_TOKEN_PLACEHOLDER = 'Their Ultra Token (uht1.…)';
const ADD_RENAMING_PLACEHOLDER =
  'Renaming — enter an address and token to add one instead';
const ADD_INCOMPLETE =
  'Enter their tailnet address (https://….ts.net) and their Ultra Token (uht1.…)';
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

function dayDate(at) {
  const when = new Date(at);
  return Number.isFinite(when.getTime()) ? when.toLocaleDateString() : '';
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
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
  const summary = ultraNeedsSummary(needs);
  if (!summary) return '';
  const skill = ultraNeedsSkill(needs);
  if (!skill) return `Asks for ${summary}.`;
  const skilled = holders.filter(
    (token) =>
      Array.isArray(token?.skills) &&
      token.skills.some((item) => item?.code === skill),
  ).length;
  return `Asks for ${summary} · ${plural(skilled, 'holder')} with that skill.`;
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
      option.textContent = `${choice.name || choice.id}${choice.removed ? ' · REMOVED' : ''}${live ? ' · HELP ON' : ''}`;
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
      option.textContent = `FOR ${feed.name || feed.id}`;
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
    state.textContent = release ? `· ON UNTIL ${clockTime(release.until)}` : '';
    setClass(state, 'ultra-release-on', Boolean(release));
  }
  const send = byId(documentRef, 'ultra-release-send');
  if (send) {
    send.textContent = release ? 'EXTEND HELP' : 'SEND HELP';
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
        ? ` · ALSO ASKING FOR HELP: ${others.join(', ')}`
        : '';
    if (release) {
      const outcome = String(release.sms?.outcome || '');
      const asks = ultraNeedsLine(release.needs, holdersList);
      note.textContent = `HELP SENT ${clockTime(release.at)} · ${plural(holders, 'holder')} · ${watching} watching · until ${clockTime(release.until)} · EXTEND HELP renews four hours${outcome ? ` · ${outcome}` : ''}${also}${asks ? ` · ${asks}` : ''}`;
    } else if (also) {
      note.textContent = `Nothing sent for this package${also}`;
    } else if (holdersList.length === 0) {
      note.textContent = RELEASE_NOTE.nobody;
    } else if (!status?.position) {
      note.textContent = RELEASE_NOTE['no-position'];
    } else {
      const incident = String(
        byId(documentRef, 'ultra-incident')?.value || 'other',
      ).toUpperCase();
      const contacts = Array.isArray(status?.contacts)
        ? status.contacts.length
        : 0;
      const asks = ultraNeedsLine(status?.ownerNeeds, holdersList);
      note.textContent = `Sends your phone's position, the incident classification and any items or skills needed to encrypted Ultra Token holders for four hours, or until STAND DOWN, and hands your phone one tap that texts the Help to ${plural(contacts, 'saved helper')}. ${watching} watching now.${asks ? ` ${asks}` : ''}`;
    }
  }
  const plea = byId(documentRef, 'ultra-release-plea');
  if (plea) {
    const text = release ? String(release.plea || '') : '';
    plea.textContent = text ? `Plea: ${text}` : '';
    plea.hidden = !text;
  }
}

function paintReleaseRow(documentRef, message, isUnread) {
  const row = documentRef.createElement('div');
  row.className = 'cctv-controls ultra-inbox-row ultra-release-row';
  row.dataset.unread = isUnread ? '1' : '0';
  const active = message.active === true;
  row.dataset.active = active ? '1' : '0';
  const from = String(message.from || message.label || 'someone');
  /* The server fills `place` with the street address, or the coordinates
   * alone when it was offline; the fallback here is for a row written before
   * the geocode answered. */
  const place =
    String(message.place || '').trim() ||
    (hasPosition(message)
      ? `${message.lat.toFixed(4)}, ${message.lon.toFixed(4)}`
      : 'position unknown');
  const distance = Number.isFinite(message.distanceKm)
    ? ` · ${message.distanceKm < 10 ? message.distanceKm.toFixed(1) : Math.round(message.distanceKm)} KM`
    : '';
  const ended = active ? '' : ` · ENDED ${clockTime(message.until)}`;
  const sms = message.sms ? ` · ${message.sms}` : '';
  const readout = documentRef.createElement('span');
  readout.className = 'sst-readout';
  readout.textContent = `${from.toUpperCase()} · NEEDS HELP · ${place} · ${clockTime(message.at)}${distance}${ended}${sms}`;
  row.appendChild(readout);
  const pleaLine = documentRef.createElement('span');
  pleaLine.className = 'sst-readout ultra-plea';
  pleaLine.textContent = String(message.text || '');
  row.appendChild(pleaLine);
  if (isUnread) {
    row.appendChild(
      button(documentRef, 'READ', { ultraInboxRead: message.id }),
    );
  }
  /* Recipient-free on purpose: the helper forwards the plea to 911 or a
   * neighbour from their own phone. Nothing here ever addresses the victim's
   * cell, and the row carries no number at all. */
  const open = documentRef.createElement('a');
  open.className = 'scene-btn';
  open.href = ultraHelpSmsLink('', message.text || '');
  open.rel = 'noopener';
  open.textContent = 'OPEN IN SMS';
  open.dataset.ultraOpenSms = '1';
  row.appendChild(open);
  if (active && hasPosition(message) && message.networkId) {
    row.appendChild(
      button(documentRef, 'MAP', { ultraNetworkMap: message.networkId }),
    );
  }
  row.appendChild(
    button(documentRef, 'REMOVE', { ultraInboxRemove: message.id }),
  );
  return row;
}

function paintInbox(documentRef, status) {
  const inbox = byId(documentRef, 'ultra-inbox');
  const count = byId(documentRef, 'ultra-inbox-count');
  const unread = Number(status?.unread) || 0;
  if (count) {
    count.textContent = unread > 0 ? `· ${unread} NEW` : '';
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
      ? ` · at ${message.lat.toFixed(4)}, ${message.lon.toFixed(4)}`
      : '';
    /* The reply number is part of the readout, so the owner sees whom TEXT
     * BACK would reach before the SMS app opens on it. */
    const reply = message.number ? ` (${message.number})` : '';
    readout.textContent = `${clockTime(message.at)} · ${message.label || 'token'} · ${message.from || 'someone'}${reply}: ${message.text || ''}${where}`;
    row.appendChild(readout);
    if (isUnread) {
      row.appendChild(
        button(documentRef, 'READ', { ultraInboxRead: message.id }),
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
      anchor.textContent = 'TEXT BACK';
      anchor.title = `Text ${message.number}`;
      anchor.dataset.ultraTextBack = '1';
      row.appendChild(anchor);
    }
    row.appendChild(
      button(documentRef, 'REMOVE', { ultraInboxRemove: message.id }),
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
    note.textContent = TOKEN_NOTE[store];
  } else if (!status?.helpBase) {
    note.textContent = TOKEN_NOTE['no-listener'];
  } else {
    /* A Network token works only over Tailscale: say which address the
     * holders enter it beside, or that there is none yet, rather than
     * promise a LAN address works. `networkBase` is the bare origin. */
    const network = status?.networkBase
      ? `Your tailnet address for holders: ${status.networkBase}`
      : 'This machine has no tailnet address yet, so a Network token cannot reach another GEVC.';
    note.textContent = `Only when Network is on and SEND HELP is pressed, GENERATE NEW TOKEN creates an Ultra Token other GEVC users enter beside your tailnet address to receive this phone's location, the incident classification, any items or skills needed, and nothing else. With Network off a token opens nothing. Skills and Gifts are optional: tick the ones this person has, add up to five of your own, or leave them all off. Encrypt hides those skills inside the token string. ${network}`;
  }
}

function paintNumberForm(documentRef, status) {
  const input = byId(documentRef, 'ultra-number-input');
  const clear = byId(documentRef, 'ultra-number-clear');
  const number = status?.ownerNumber || '';
  if (input) {
    input.placeholder = number
      ? `SAVED: ${number.slice(0, 5)}…`
      : '+15065550100 your cell: calls for help you receive are texted here';
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
  const lines = [`${revealed.label || 'Token'}:`];
  /* No address with Network off (the token opens nothing) or while the
   * report listener is down: the token line stands alone and says so. */
  if (address) lines.push(`Tailnet address: ${address}`);
  lines.push(`Ultra Token: ${token}`);
  if (!address) {
    lines.push(
      'No tailnet address to show (Network is off, or the report listener is not up): the token is handed over with your tailnet address.',
    );
  }
  /* A sealed skill list this machine's key cannot open is hidden, not
   * absent: say which, so a replaced or missing key is not read as a token
   * minted with no skills. */
  if (revealed.hidden === true) {
    lines.push(SKILLS_HIDDEN_LINE);
  } else if (Array.isArray(revealed.skills)) {
    const names = skillWords(revealed.skills);
    lines.push(names.length ? names.join(', ') : 'No skill sets');
  }
  if (revealed.encrypted === true) lines.push('Skills encrypted in the token');
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
    `${how === 'github' ? `PUBLISHED to ${published.directory || 'the directory'}` : 'COPY THIS ENTRY'}:`,
    entryText,
  ];
  if (published.error) lines.push(`Not written to GitHub: ${published.error}`);
  pre.textContent = lines.join('\n');
  box.dataset.ultraEntry = entryText;
  if (note) note.textContent = ENTRY_NOTE[how];
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
      built.error === 'Two custom skill sets would share one token code'
        ? 'Two custom skill sets would share one token code. Change one of them.'
        : built.error;
    return;
  }
  if (!built.differs) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  note.hidden = false;
  note.textContent = `The token will say: ${built.skills.map((item) => item.label).join(', ')}`;
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

function tokenReadout(token) {
  const parts = [
    token.label || token.id,
    token.network ? 'NET' : '—',
    /* A token carries the location poll alone: shared only while asking,
     * and with Network off it opens nothing at all. */
    token.locationOnly
      ? 'LOCATION ONLY (DIRECTORY)'
      : token.network
        ? 'ONLY WHEN ASKING'
        : 'OPENS NOTHING UNTIL NETWORK ON',
    token.fingerprint || '',
    dayDate(token.createdAt),
  ];
  const skills = skillWords(token.skills);
  if (skills.length) parts.push(skills.join(', '));
  /* `hidden` is the server's word for a sealed list this key cannot open;
   * an encrypted token that opens to no skills reads ENCRYPTED alone, as a
   * token minted that way should. */
  if (token.hidden === true) parts.push(SKILLS_HIDDEN_WORD);
  if (token.encrypted === true) parts.push('ENCRYPTED');
  if (token.tampered) parts.push('TAMPERED');
  if (token.orphaned) parts.push('PACKAGE REMOVED');
  if (token.revokedAt) parts.push('REVOKED');
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
          button(documentRef, 'REVOKE', { ultraTokenRevoke: token.id }),
          button(documentRef, 'REMOVE', { ultraTokenRemove: token.id }),
        );
        rows.push([token.id, row]);
        continue;
      }
      row.append(
        readout,
        button(documentRef, 'SHARE', { ultraTokenShare: token.id }),
        button(documentRef, token.network ? 'NETWORK OFF' : 'NETWORK ON', {
          ultraTokenEdit: token.id,
          ultraField: 'network',
          ultraCurrent: token.network ? '1' : '0',
        }),
        button(documentRef, 'REVOKE', { ultraTokenRevoke: token.id }),
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
        button(documentRef, 'REMOVE', { ultraTokenRemove: token.id }),
      );
      rows.push([token.id, row]);
    }
    if (revoked.length > REVOKED_ROWS) {
      const row = documentRef.createElement('div');
      row.className = 'cctv-controls';
      row.appendChild(
        button(documentRef, 'REMOVE ALL REVOKED', { ultraTokenPurge: '1' }),
      );
      rows.push(['purge', row]);
    }
  }
  if (store !== 'ok') {
    const row = documentRef.createElement('div');
    row.className = 'cctv-controls';
    row.appendChild(
      button(documentRef, 'RESET TOKENS', { ultraTokenReset: '1' }),
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
  if (submit) submit.textContent = 'ADD TO HOME LIST';
  const addressInput = byId(documentRef, 'ultra-network-address');
  if (addressInput) addressInput.placeholder = ADD_ADDRESS_PLACEHOLDER;
  const tokenInput = byId(documentRef, 'ultra-network-token');
  if (tokenInput) tokenInput.placeholder = ADD_TOKEN_PLACEHOLDER;
}

function networkStateWord(entry, polling, now) {
  if (!polling) return 'NOT POLLED';
  if (entry.lastState === 'quiet') {
    const polledAt = Number(entry.lastPolledAt) || 0;
    return polledAt && now - polledAt > NETWORK_STALE_MS
      ? 'OK · STALE'
      : 'WATCHING';
  }
  return NETWORK_STATE[entry.lastState] || NETWORK_STATE.new;
}

function networkNote(network, directory) {
  if ((network.keyState || 'ok') !== 'ok') return NETWORK_NOTE.key;
  if (network.polling !== true) return NETWORK_NOTE.preview;
  if (!directory.configured) return NETWORK_NOTE.directory;
  const writes = directory.canPublish
    ? 'write token saved, PUBLISH writes to it'
    : directory.github
      ? 'no write token: PUBLISH copies the entry for you to send'
      : 'not a GitHub file: PUBLISH copies the entry for you to send';
  const last = directory.lastResult;
  let update = '';
  if (last && typeof last === 'object') {
    update = last.error
      ? ` · last update failed: ${last.error}`
      : ` · UPDATED ${clockTime(directory.lastUpdateAt)} · ${Number(last.added) || 0} added · ${Number(last.updated) || 0} renamed · ${Number(last.missing) || 0} missing · ${Number(last.moved) || 0} moved · ${Number(last.skipped) || 0} skipped · ${Number(last.total) || 0} listed`;
  }
  return `Directory: ${directory.url || ''} · ${writes}${update} · Anyone who can read the directory sees where the phones in it are while their owners ask for help, and nothing more: keep it private to your group.`;
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
        ? `· ${needHelp} NEED HELP`
        : entries.length
          ? `· ${plural(entries.length, 'token')}`
          : '';
    setClass(count.parentElement, 'ultra-unread', needHelp > 0);
  }
  const note = byId(documentRef, 'ultra-network-note');
  if (note) {
    const lead = networkNote(network, directory);
    let text = lead;
    const published = network.published;
    if (published && typeof published === 'object') {
      text += ` Your token is published (${published.how === 'github' ? 'written to the directory' : 'copied for the maintainer'} ${dayDate(published.at)})${published.live === false ? ' · THAT TOKEN IS REVOKED: publish again' : ''}.`;
    }
    if (lead === NETWORK_NOTE.directory) text += `\n${NETWORK_NOTE.activate}`;
    note.textContent = text;
  }
  /* Placeholders only: a value is never pre-filled, so the three-second poll
   * cannot overwrite what the owner is typing. */
  const meName = byId(documentRef, 'ultra-network-me-name');
  if (meName) {
    const name = String(network.me?.name || '');
    meName.placeholder = name ? `SAVED: ${name}` : PLACEHOLDER.meName;
  }
  const urlInput = byId(documentRef, 'ultra-directory-url');
  if (urlInput) {
    urlInput.placeholder =
      directory.configured && directory.url
        ? `SAVED: ${directory.url}`
        : PLACEHOLDER.directoryUrl;
  }
  const tokenInput = byId(documentRef, 'ultra-directory-token');
  if (tokenInput) {
    tokenInput.placeholder = directory.canPublish
      ? PLACEHOLDER.directoryTokenSaved
      : PLACEHOLDER.directoryToken;
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
      first.textContent = 'DIRECTORY TOKEN (made for you)';
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
        entry.source === 'directory' ? 'DIRECTORY' : 'MANUAL',
        state,
      ];
      /* The flags repeat the state word for a row that is in that very
       * state; say each thing once. */
      if (entry.directoryMissing && state !== 'NOT IN DIRECTORY') {
        parts.push('NOT IN DIRECTORY');
      }
      if (entry.moved && state !== 'MOVED') parts.push('MOVED');
      /* A hand-added link is polled where the owner put it; the directory
       * lists the same person elsewhere, and this is the row it means. */
      if (entry.directoryDiffers) parts.push('DIRECTORY LISTS ANOTHER HOST');
      if (Number(entry.lastPolledAt) > 0)
        parts.push(clockTime(entry.lastPolledAt));
      const peerSkills = skillWords(entry.skills);
      if (peerSkills.length) parts.push(peerSkills.join(', '));
      if (entry.encrypted === true) parts.push('ENCRYPTED');
      const readout = documentRef.createElement('span');
      readout.className = 'sst-readout';
      readout.textContent = parts.filter(Boolean).join(' · ');
      row.append(
        readout,
        button(documentRef, 'RENAME', { ultraNetworkRename: entry.id }),
        button(documentRef, 'REMOVE', { ultraNetworkRemove: entry.id }),
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
    relayLine.textContent = `SMS RELAY · ${configured ? `${String(relay.provider || '').toUpperCase()} (${relay.host || ''})` : 'NOT CONFIGURED (POWER UP → SMS RELAY)'}${relay.lastOutcome ? ` · ${relay.lastOutcome}` : ''}${relay.sentToday ? ` · ${relay.sentToday} SENT TODAY` : ''}`;
  }
  const test = byId(documentRef, 'ultra-sms-test');
  if (test) test.disabled = !configured || !status?.ownerNumber;
}

export function applyUltraHelpStatus(documentRef, status) {
  const model = byId(documentRef, 'ultra-model');
  if (model && status?.model?.id && model.value !== status.model.id) {
    model.value = status.model.id;
  }
  const modelId = model?.value || status?.model?.id || 'samsung-s22-ultra';
  for (const button of documentRef.querySelectorAll('[data-ultra-camera]')) {
    const role = button.dataset.ultraCamera;
    const offered = Boolean(ultraCameraRole(modelId, role));
    const always = role === 'front' || role === 'rear';
    button.hidden = !always && !offered;
  }
  const extras = byId(documentRef, 'ultra-extra-cameras');
  if (extras) {
    extras.hidden = !extras.querySelector('[data-ultra-camera]:not([hidden])');
  }
  const statusLine = byId(documentRef, 'ultra-status');
  if (statusLine) {
    const unread = Number(status?.unread) || 0;
    const release =
      status?.release && typeof status.release === 'object'
        ? status.release
        : null;
    const received = activeReleases(status)[0];
    if (release) {
      statusLine.textContent = `HELP SENT · UNTIL ${clockTime(release.until)} · ${Number(release.watching) || 0} WATCHING`;
    } else if (received) {
      statusLine.textContent = `NETWORK · ${String(received.from || received.label || 'someone').toUpperCase()} NEEDS HELP`;
    } else if (unread > 0) {
      statusLine.textContent = `HELP · ${unread} NEW`;
    } else if (status?.pending?.kind === 'camera') {
      statusLine.textContent = `LIVE VIDEO · ${status.pending.label}`;
    } else if (status?.cameraNote) {
      statusLine.textContent = status.cameraNote;
    } else if (status?.position) {
      statusLine.textContent = `PHONE · ${status.position.lat.toFixed(4)}, ${status.position.lon.toFixed(4)}`;
    } else {
      statusLine.textContent = 'PHONE · WAITING FOR A REPORT';
    }
  }
  const frame = byId(documentRef, 'ultra-frame');
  const wrap = byId(documentRef, 'ultra-frame-wrap');
  if (frame && wrap && frame.dataset.polling !== '1') {
    frame.dataset.polling = '1';
    let busy = false;
    const tick = () => {
      if (busy) return;
      busy = true;
      const probe = new Image();
      probe.onload = () => {
        frame.src = probe.src;
        wrap.hidden = false;
        busy = false;
      };
      probe.onerror = () => {
        busy = false;
      };
      probe.src = `/api/ultra-help/picture?t=${Date.now()}`;
    };
    tick();
    frame._ultraTick = setInterval(tick, 100);
  }
  const link = byId(documentRef, 'ultra-cam-link');
  if (link) {
    const rows = [];
    if (status?.camLink) {
      const anchor = documentRef.createElement('a');
      anchor.href = status.camLink;
      anchor.textContent =
        'Open this on the phone: it sends the phone’s position and camera (no app needed)';
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
      helpNote.textContent =
        'The helpers file was changed and is not being used. The next save replaces it.';
    }
  }
  const outboundNote = byId(documentRef, 'ultra-outbound-note');
  if (outboundNote) {
    const lines = [];
    if (status?.directoryStore === 'tampered') {
      lines.push(
        'The directory address was changed and is not being used. Save it again from the box.',
      );
    }
    if (status?.relayStore === 'tampered') {
      lines.push(
        'The SMS relay was changed and is not being used. Save it again from POWER UP.',
      );
    }
    if (status?.feedsStore === 'tampered') {
      lines.push(
        'The phone package was changed and is not being used. Save the package again.',
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
      remove.textContent = 'REMOVE';
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
      const from = message.from || message.label || 'Someone';
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
        speak(`${from} needs help. ${message.text || ''}`);
      } else if (!stoodDown.has(message.id)) {
        firstHeard.delete(message.id);
        stoodDown.add(message.id);
        /* A call that is over is never announced as new afterwards. */
        spoken.add(message.id);
        speak(`${from} stood down`);
      }
      continue;
    }
    if (message.readAt || spoken.has(message.id)) continue;
    spoken.add(message.id);
    speak(
      `Help message from ${message.from || 'someone'} via ${message.label || 'a help link'}: ${message.text || ''}`,
    );
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

export function initUltraHelpPanel({
  documentRef = document,
  fetchImpl = fetch,
  signal,
  windowRef = globalThis.window,
} = {}) {
  const panel = documentRef.getElementById?.('ultra-panel');
  if (!panel) return { destroy() {} };
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
  const paint = (status) => {
    const { revealed, published, ...rest } = status || {};
    latest = rest;
    applyUltraHelpStatus(documentRef, status);
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
          ? 'STAND DOWN NOT SENT — no answer from the dev server; press STAND DOWN again'
          : 'HELP NOT SENT — no answer from the dev server; press again'
        : 'Not sent: no answer from the dev server',
    );
    return null;
  };
  const post = async (action, body) => {
    if (disposed) return null;
    let response;
    try {
      response = await fetchImpl(`/api/ultra-help/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return unanswered(action, body);
    }
    if (!response.ok) {
      let error = 'Request refused';
      try {
        error = (await response.json())?.error || error;
      } catch {
        /* Keep the fallback line. */
      }
      say(error);
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
      say('Not saved: no answer from the dev server');
      return false;
    }
    let payload = {};
    try {
      payload = (await response.json()) || {};
    } catch {
      payload = {};
    }
    if (!response.ok || !payload.ok) {
      say(payload.error || 'Not saved');
      return false;
    }
    say(ENV_SAVED);
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
    control.textContent = copied ? 'COPIED' : 'SELECTED';
    const timer = setTimeout(() => {
      control.textContent = original;
      copyTimers.delete(control);
    }, 1500);
    copyTimers.set(control, { label: original, timer });
  };
  const confirmed = (question) =>
    typeof globalThis.confirm !== 'function' || globalThis.confirm(question);
  const onClick = (event) => {
    const target = event.target;
    const camera = target?.closest?.('[data-ultra-camera]');
    if (camera && !camera.hidden) {
      void post('camera', { role: camera.dataset.ultraCamera });
      return;
    }
    const id = target?.id;
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
          `Send help${name ? ` for ${name}` : ''}? ${name ? "That package's" : "Your phone's"} position and the incident go to ${name ? 'its' : 'your'} token holders with NETWORK on for four hours, and the phone gets the plea for your saved helpers.`,
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
          say('STOOD DOWN · NO CALL FOR HELP IS ON');
      });
      return;
    }
    if (id === 'ultra-inbox-read-all') {
      void post('inbox', { read: true });
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
        if (submit) submit.textContent = 'RENAME';
        const addressInput = byId(documentRef, 'ultra-network-address');
        if (addressInput) {
          addressInput.value = '';
          addressInput.placeholder = ADD_RENAMING_PLACEHOLDER;
        }
        const tokenInput = byId(documentRef, 'ultra-network-token');
        if (tokenInput) {
          tokenInput.value = '';
          tokenInput.placeholder = ADD_TOKEN_PLACEHOLDER;
        }
      }
      return;
    }
    const networkRemove = target?.closest?.('[data-ultra-network-remove]');
    if (networkRemove) {
      if (
        !confirmed(
          'Remove this link from your home list? Their calls for help stop reaching you.',
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
      if (!confirmed('Revoke this token? The link stops working at once.'))
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
          'Reset every help token? Every link stops working, the key file is deleted, and your home list is emptied (UPDATE HOME LIST brings the directory back).',
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
    if (event.target?.id === 'ultra-model') {
      applyUltraHelpStatus(documentRef, {
        ...(latest || {}),
        model: { id: event.target.value },
      });
      void post('model', { modelId: event.target.value });
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
  };
  const onCustomSkill = (event) => {
    if (String(event.target?.id || '').startsWith('ultra-skill-custom-'))
      paintCustomSkillPreview(documentRef);
  };
  const onSubmit = (event) => {
    const id = event.target?.id;
    if (id === 'ultra-contact') {
      event.preventDefault();
      void post('contacts', {
        label: byId(documentRef, 'ultra-contact-label')?.value,
        number: byId(documentRef, 'ultra-contact-number')?.value,
        kind: byId(documentRef, 'ultra-contact-kind')?.value,
      });
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
        button.textContent = MINT_LABEL.busy;
      }
      void post('tokens', body).then((status) => {
        if (!status) {
          if (button) {
            button.disabled = false;
            button.textContent = MINT_LABEL.idle;
          }
          return;
        }
        if (button) {
          /* Ready for the next token at once; the word stays two seconds. */
          button.disabled = false;
          button.textContent = MINT_LABEL.done;
          mintLabelTimer = setTimeout(() => {
            if (button.textContent === MINT_LABEL.done)
              button.textContent = MINT_LABEL.idle;
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
          say(ADD_INCOMPLETE);
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
          ? 'NO ANSWER FROM THE DEV SERVER — showing the last known state'
          : 'NO ANSWER FROM THE DEV SERVER — is npm run dev running?';
      }
    }
  };
  void load();
  const refreshStatus = setInterval(() => {
    void load();
  }, 3000);
  return {
    destroy() {
      disposed = true;
      clearInterval(refreshStatus);
      clearTimeout(mintLabelTimer);
      for (const entry of copyTimers.values()) clearTimeout(entry?.timer);
      const frame = byId(documentRef, 'ultra-frame');
      if (frame?._ultraTick) clearInterval(frame._ultraTick);
      panel.removeEventListener('click', onClick);
      panel.removeEventListener('change', onChange);
      panel.removeEventListener('input', onCustomSkill);
      panel.removeEventListener('submit', onSubmit);
    },
  };
}
