/**
 * Ultra Security Package help. Loopback for the panel. The paired phone,
 * and only that phone, polls the report listener at /ultra/<key>. A person
 * the owner handed an Ultra Token reaches one route on that same listener:
 * GET /ultra/help/network, the location poll, with the token as the
 * Authorization bearer (never in the path: the token authenticates, the
 * tailnet address locates, and one address hands out many tokens so one
 * holder can be revoked on their own), and only while the token is marked
 * NETWORK. It says whether the owner has pressed SEND HELP and, while they
 * have, where the phone is: a name, a position, the time, the window end,
 * the incident class and any items or skill needed (HELP DELIVERY), and
 * nothing else. There is no page and no message box. CCTV is not involved.
 * No token, hash or Authorization header is ever logged. This server polls
 * the entries in the owner's home list the same way, over the tailnet only,
 * and the only credential it ever sends a peer is that peer's own token, as
 * the bearer, to an address that passes the tailnet rule.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';
import {
  credentialFileRestricted,
  replaceCredentialStore,
} from '../shared/keySetupHardening.mjs';
import { noteLocalProvidersSaved } from '../shared/localIntegrity.mjs';
import {
  DEVICE_FEED_STORE,
  DEVICE_RECORDING_DIR,
  deviceFeedPublicId,
  securityFeedPolicyRecords,
} from '../../src/deviceFeedsCore.mjs';
import {
  ULTRA_HELP_CONTACT_LIMIT,
  ULTRA_POSITION_MAX_AGE_MS,
  classifyUltraIncident,
  normalizeUltraNumber,
  ultraCameraRole,
  ultraCameraButtons,
  ultraContactKind,
  ultraDistanceKm,
  sendableNumber,
  ultraHelpMessage,
  ultraNeeds,
  ultraNeedsSkill,
  ultraPhoneModel,
  ULTRA_PHONE_MODELS,
} from '../../src/ultraHelp.mjs';
import {
  ULTRA_DIRECTORY_BYTES,
  ULTRA_DIRECTORY_TIMEOUT_MS,
  ULTRA_GEOCODE_SPACING_MS,
  ULTRA_GEOCODE_TIMEOUT_MS,
  ULTRA_GITHUB_TIMEOUT_MS,
  ULTRA_NETWORK_ANSWER_LIMIT,
  ULTRA_NETWORK_CONCURRENCY,
  ULTRA_NETWORK_MAX_IN_FLIGHT,
  ULTRA_NETWORK_ENTRY_LIMIT,
  ULTRA_NETWORK_EPISODE_GAP_MS,
  ULTRA_NETWORK_STATES,
  ULTRA_NETWORK_POLL_MS,
  ULTRA_NETWORK_TICK_MS,
  ULTRA_NETWORK_TIMEOUT_MS,
  ULTRA_PHONE_HELP_LIMIT,
  displayDirectoryUrl,
  githubDirectoryApi,
  mergeDirectoryDocument,
  mergeUltraDirectory,
  newUltraRelease,
  normalizeUltraDirectory,
  normalizeUltraNetworkAnswer,
  normalizeUltraNetworkStore,
  normalizeUltraRelease,
  openUltraNetworkToken,
  parseUltraHandout,
  sealUltraNetworkToken,
  stampUltraNetworkPolicy,
  ultraDirectoryPolicyMac,
  ultraDirectoryPolicyMacs,
  ultraFeedsPolicyMac,
  ultraFeedsPolicyMacs,
  ultraHelpStorePolicyMac,
  ultraHelpStorePolicyState,
  ultraOutboundPolicyState,
  ultraRelayPolicyMac,
  ultraRelayPolicyMacs,
  ultraNetworkPollAllowed,
  ultraNetworkPolicyState,
  ultraNetworkStoreHasPolicyMac,
  ultraNetworkTamperFlags,
  ultraCoordinatesPlace,
  ultraDirectoryEntry,
  ultraDirectoryMailto,
  ultraDirectoryUrl,
  ultraEpisodeDecision,
  ultraHelpHandout,
  ultraHolderReachable,
  ultraNeedsGeocode,
  ultraNetworkEntryId,
  ultraNetworkPin,
  ultraNetworkPollTarget,
  ultraNetworkPublicEntry,
  ultraPollOutcome,
  ultraReleaseAnswer,
  ultraReleaseInboxRecord,
  ultraReleaseRowUpdate,
  ultraTailnetBase,
  ultraTailnetTarget,
  ultraWatchingCount,
} from '../shared/ultraNetwork.mjs';
import {
  ULTRA_SMS_NO_NUMBER,
  ULTRA_SMS_NO_RELAY,
  ULTRA_SMS_SENDING,
  ULTRA_SMS_TEST_TEXT,
  ULTRA_SMS_UNKNOWN,
  newUltraSmsLedger,
  ultraOwnSmsOutcome,
  ultraSmsFailureCode,
  ultraSmsOutcome,
  ultraSmsRelayAllowed,
  ultraSmsRelayBody,
  ultraSmsRelayConfig,
  ultraSmsRelayForget,
  ultraSmsRelayMaterial,
  ultraSmsRelayPublic,
  ultraSmsRelayRequest,
  ultraSmsSentToday,
} from '../shared/ultraSmsRelay.mjs';
import {
  ULTRA_HELP_BODY_LIMIT,
  ULTRA_HELP_NAME_LIMIT,
  ULTRA_HOLDER_ADDRESS_LIMIT,
  ULTRA_HOLDER_MISS_LIMIT,
  ULTRA_INBOX_LIMIT,
  ULTRA_NOTIFY_LIMIT,
  ULTRA_TOKEN_LIMIT,
  ULTRA_TOKEN_PATTERN,
  allowUltraRequest,
  cleanHelpText,
  cleanPosition,
  composeUltraToken,
  newUltraToken,
  normalizeUltraSkillRequest,
  newUltraTokenKeyText,
  normalizeUltraInbox,
  normalizeUltraTokenStore,
  ultraInboxPolicyMac,
  ultraInboxVisibleMessages,
  openUltraToken,
  parseUltraTokenKey,
  readUltraTokenSkills,
  sealUltraToken,
  selectUltraToken,
  stampUltraTokenPolicy,
  stampUltraTokenStore,
  ultraClientAddress,
  ultraMessageId,
  ultraNotifyItem,
  ultraTokenDisplayedSkills,
  ultraTokenFingerprint,
  ultraTokenHash,
  ultraTokenHashEqual,
  ultraTokenId,
  ultraTokenKeyId,
  ultraTokenPolicyState,
  ultraTokenRowTampered,
  ultraTokenStoreHasPolicyMac,
  ultraTokenStoreState,
  ultraTokenTamperFlags,
  ultraTokenSkillFields,
} from '../shared/ultraTokens.mjs';

const KEY = /^[A-Za-z0-9_-]{43}$/;
/**
 * Memory that must outlive an in-process dev-server restart. Vite bundles
 * this file into its config and evaluates it afresh on every
 * server.restart() (a POWER UP save, SAVE DIRECTORY), and the report
 * listener restarts with it, so anything held at module level would start
 * empty: the cards waiting for the phone (the plea for the owner's helpers
 * among them), the one-slot command, the last fixes, each package's call
 * and what its texts did, and the SMS ledger. Those live on globalThis
 * instead, the way server/standalone/key-setup.js keeps its boot snapshot,
 * together with the checkout they belong to; a process restart still
 * starts them empty, and pointAt (another root, as a test does) clears them.
 */
const SHARED = (globalThis.__GEV_ULTRA_HELP_MEMORY ??= { root: '' });
const shared = (name, make) => (SHARED[name] ??= make());
const positions = shared('positions', () => new Map());
const commands = shared('commands', () => new Map());
const pictures = new Map();
const phoneHosts = new Map();
const viewers = new Set();
let reportBases = [];
const LIVE_BOUNDARY = 'gev-ultra';

// Every file this provider touches resolves from here. ultraHelpProxy points
// it at the checkout (server/providers/local.js) or, in a test, at a temp dir.
let sourceRoot = process.cwd();
// The credential-file hardener replaceCredentialStore should use; undefined
// means its own. A test injects a spy to prove the ACL path ran.
let hardenImpl;
// How a mint builds the bearer string from the secret and the skills;
// undefined means composeUltraToken. A test injects one that gives nothing
// back to prove that failure is said by its own code, not as weak random.
let composeImpl;
// Whether the key file is still owner-only, read before the key is trusted
// (credentialFileRestricted). A test that brings its own hardener owns the
// file's protection too and is answered true unless it brings a check.
let verifyImpl;
// The last answer, kept while the key file's stat is unchanged and for at
// most a few minutes: the Windows check spawns PowerShell.
let keyGuard = { stamp: '', restricted: true, at: 0 };
let keyExposedWarned = false;
const KEY_GUARD_TTL_MS = 300_000;
// Said once per detection, in the owner's own terminal: the key file holds a
// different key from the one the token store was last written under, or an
// exclusive key create had to fall back to a rename on this volume.
let keyChangedWarned = false;
let storeChangedWarned = false;
let keyLinkWarned = false;
const OWNER_BODY_LIMIT = 16_384;
const STORE_FAILURE_CODES = new Set([
  'GEV_HARDEN_FAILED',
  'GEV_STORE_UNREADABLE',
  'GEV_STORE_REPLACE_REFUSED',
  'GEV_TOKEN_KEY_MISSING',
  'GEV_TOKEN_KEY_INVALID',
  // A generator that has gone wrong: said plainly rather than as a 500.
  'GEV_WEAK_RANDOM',
  // The store already holds ULTRA_TOKEN_LIMIT tokens. Said plainly, not a 500.
  'GEV_TOKEN_LIMIT',
]);
const KEY_MISSING_MESSAGE =
  'the token key file is missing; revoke the existing tokens or RESET TOKENS, then mint again';
const KEY_INVALID_MESSAGE =
  'the token key file (ultra-tokens.key) is not a valid key; fix the file or RESET TOKENS, then mint again';
const STORE_UNREADABLE_MESSAGE =
  'the token store exists but cannot be read; fix or RESET TOKENS';
const KEY_CHANGED_MESSAGE =
  'This token cannot be shown any more (the key file changed): revoke it and mint a new one';
const TAMPERED_TOKEN_MESSAGE =
  'This token was changed in the token file: revoke it and mint a new one';

// Help-token state. The sealed store is re-read when its file changes; the
// inbox lives in memory after its first read and is written behind; the rest
// (notify queues, address and miss budgets) is memory only and starts empty
// with the process.
let tokenCache = { stamp: '', store: emptyTokenStore(), unreadable: false };
let feedCache = { stamp: '', feeds: [] };
let inbox = null;
let inboxTimer = null;
let inboxWarned = false;
let inboxHardened = false;
const notifies = shared('notifies', () => new Map());
const addressBuckets = new Map();
const missBuckets = new Map();
const missWarned = new Map();
/** Unknown phone keys per address: each one reads the device store and its check. */
const phoneMissBuckets = new Map();
/** Picture uploads per phone key. */
const pictureBuckets = new Map();

// ---- help network state ---------------------------------------------------
// The owner's own releases (SEND HELP), one per security package, keyed by
// the package id: read from config/ultra-help.json once and the truth in
// memory after that, so a press for one package can never end or replace
// another's call. `ownCalls` holds what each package's current call did for
// its saved helpers (the plea and, per number, whether the relay text is on
// its way, sent, failed or held by a limit); a new press — not an EXTEND —
// and STAND DOWN replace it. The home list is read from
// config/ultra-network.json once, written only by an owner action, and the
// links it holds are decrypted into `links` and never leave this process.
// Everything else here is memory that starts empty with the process: poll
// times, failures, episodes, the geocode cache, the SMS ledger and the timer.
const releases = shared('releases', () => new Map());
// Whether the file's releases have been read into `releases`: kept beside
// them on globalThis (SHARED.releasesLoaded), not at module level, because
// a copy of this module a dev-server restart evaluates afresh must not merge
// the file over memory again — a STAND DOWN whose write was refused is still
// in the file. A file that could not be read leaves it unset, so the first
// good read after the owner fixes it still loads the call it holds, except
// for a package pressed meanwhile (SHARED.releasesPressed): memory is
// already the truth for that one.
const ownCalls = shared('ownCalls', () => new Map());
/** How many releases the file may carry: far more packages than anyone saves. */
const RELEASE_LIMIT = 50;
// A SEND HELP or STAND DOWN whose write was refused still takes effect in
// memory at once; SHARED.releasesUnsaved says the file is behind, and the
// box's status poll, the phone's own poll and the network poller's tick
// write it again, no more often than this, until it lands.
const RELEASE_RETRY_MS = 15_000;
let releaseRetryAt = 0;
// The store objects readStore made from a config/ultra-help.json it could
// not read or parse. Writing one back would replace the owner's helpers and
// number with an empty list, so writeStore refuses it.
const unreadableStores = new WeakSet();
// A helpers file whose check does not match while this key opens some seal.
// readStore hands back an empty number and no helpers, and the next save
// writes that view. The file is not written over merely by being read.
const untrustedStores = new WeakSet();
let helpStoreWarned = false;
const HELP_STORE_UNREADABLE_MESSAGE =
  'config/ultra-help.json cannot be read; fix it first (your helpers and number are kept until then)';
const DIRECTORY_CHANGED_MESSAGE =
  'The directory address was changed and is not being used. Save it again from the box.';
const RELAY_CHANGED_MESSAGE =
  'The SMS relay was changed and is not being used. Save it again from POWER UP.';
const DIRECTORY_ENV = new Set([
  'ULTRA_DIRECTORY_URL',
  'ULTRA_DIRECTORY_WRITE_TOKEN',
]);
const RELAY_ENV = new Set([
  'ULTRA_SMS_RELAY_URL',
  'ULTRA_SMS_RELAY_TOKEN',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
]);
let outboundCache = null;
let outboundWarned = false;
let network = null;
// The home list as it was last read or written, as JSON: what a refused
// owner write rolls memory back to, whatever else was saved meanwhile.
let networkSaved = '';
let networkWarned = false;
let episodesResumed = false;
const links = new Map();
const networkMemory = new Map();
/**
 * How long a link's last answer with a call still counts as hearing it:
 * three poll periods, so a tick running late never counts, but a link whose
 * answers have stopped does (see followsCall).
 */
const ULTRA_NETWORK_HEARD_MS = 3 * ULTRA_NETWORK_POLL_MS;
const networkPolls = new Map();
const helpBuckets = new Map();
let geocodeQueue = Promise.resolve();
let geocodeAt = 0;
let geocodeWarnedAt = 0;
const smsLedger = shared('smsLedger', newUltraSmsLedger);
let lastRelayOutcome = '';
let lastDirectory = null;
let networkTimer = null;
/** Which dev server the current poll timer belongs to (see startNetworkPoller). */
let pollerOwner = 0;
// Work a poll detached (the reverse geocode, the inbox row, the notify).
// pollUltraNetworkOnce waits for it; the real poller never does. An SMS
// relay is never in here: it must not hold up a tick or an owner click.
const pendingWork = new Set();
// Rows of a new call for help whose street address is still being looked up
// (the row shows coordinates until then). The box holds its voice for it a
// few seconds, so the call is said once, with the street. Not on SHARED: a
// copy of this module evaluated afresh starts empty, and the box then
// speaks at once, as it would with no lookup at all.
const placing = new Set();
// Work already in flight when the root changes belongs to the old machine's
// worth of state: it checks this before it fetches or writes anything, so a
// geocode queued for one root can never land in another's inbox.
let rootGeneration = 0;
const ULTRA_USER_AGENT = 'gods-eye-view-ultra/0.2 (help network)';
/** How much of a GitHub contents answer is read before it is treated as junk. */
const ULTRA_GITHUB_BYTES = 1024 * 1024;
let fetchTool = (...args) => globalThis.fetch(...args);

/** Generic camera servers a phone app may already be serving on its own address. */
const GENERIC_PHONE_CAMERAS = Object.freeze([
  Object.freeze({ port: 8080, path: '/shot.jpg' }),
  Object.freeze({ port: 8080, path: '/video' }),
  Object.freeze({ port: 4747, path: '/mjpegfeed' }),
  Object.freeze({ port: 4747, path: '/video' }),
  Object.freeze({ port: 8081, path: '/shot.jpg' }),
  Object.freeze({ port: 8888, path: '/shot.jpg' }),
]);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'",
  // No other site may embed a picture, a live view or an answer.
  'Cross-Origin-Resource-Policy': 'same-origin',
};
/**
 * The holder route's headers: the phone routes' own, and Vary: Authorization,
 * since what /ultra/help/network answers depends on the bearer alone and no
 * cache in between may hand one holder's answer (or 404) to another.
 */
const HOLDER_HEADERS = { ...SECURITY_HEADERS, Vary: 'Authorization' };

/** The largest geocoder or map-search answer read. */
const LOOKUP_MAX_BYTES = 1024 * 1024;
/** Live views at once; past this the oldest is closed. */
const LIVE_VIEWER_LIMIT = 16;
/** Phone picture uploads per key per second. */
const PICTURE_LIMIT = Object.freeze({ max: 25, windowMs: 1000 });
const PICTURE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const storePath = () => path.join(sourceRoot, 'config', 'ultra-help.json');
const tokenStorePath = () =>
  path.join(sourceRoot, 'config', 'ultra-tokens.json');
const tokenKeyPath = () => path.join(sourceRoot, 'config', 'ultra-tokens.key');
const inboxPath = () => path.join(sourceRoot, 'config', 'ultra-inbox.json');
const networkStorePath = () =>
  path.join(sourceRoot, 'config', 'ultra-network.json');
const feedStorePath = () => path.join(sourceRoot, DEVICE_FEED_STORE);

function emptyStore() {
  return {
    version: 1,
    modelId: 'samsung-s22-ultra',
    contacts: [],
    owner: { number: '', needs: null },
    releases: [],
  };
}

function emptyTokenStore() {
  return { version: 1, tokens: [] };
}

function storeFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Point every path at a root. A different root is a different machine's
 * worth of state (a test's temp dir), so what is pending is written to the
 * old one and the memory is started afresh. The same root keeps what lives
 * on globalThis (see SHARED): a dev-server restart evaluates this module
 * again, so its own module-level memory is new either way, but the phone's
 * cards, the calls and the SMS ledger carry over.
 */
function pointAt(root, harden, compose, verify) {
  hardenImpl = harden;
  composeImpl = compose;
  verifyImpl =
    verify !== undefined
      ? verify
      : harden === undefined
        ? credentialFileRestricted
        : () => true;
  keyGuard = { stamp: '', restricted: true, at: 0 };
  keyExposedWarned = false;
  const next = path.resolve(String(root || process.cwd()));
  // The memory on globalThis already belongs to this checkout: a copy of
  // this module evaluated afresh by a dev-server restart keeps it.
  const kept = SHARED.root === next;
  if (next === sourceRoot && kept) return;
  if (!kept) {
    for (const map of [notifies, positions, commands, releases, ownCalls])
      map.clear();
    Object.assign(smsLedger, newUltraSmsLedger());
    // Another machine's file is not behind this one's memory, and its
    // releases are still to be read.
    SHARED.releasesUnsaved = false;
    SHARED.releasesLoaded = false;
    SHARED.releasesPressed = null;
    SHARED.root = next;
  }
  flushInbox();
  stopNetworkPoller();
  rootGeneration += 1;
  pendingWork.clear();
  sourceRoot = next;
  tokenCache = { stamp: '', store: emptyTokenStore(), unreadable: false };
  feedCache = { stamp: '', feeds: [] };
  outboundCache = null;
  outboundWarned = false;
  keyChangedWarned = false;
  storeChangedWarned = false;
  keyLinkWarned = false;
  inbox = null;
  inboxWarned = false;
  inboxHardened = false;
  reportBases = [];
  releaseRetryAt = 0;
  helpStoreWarned = false;
  network = null;
  networkSaved = '';
  networkWarned = false;
  episodesResumed = false;
  geocodeQueue = Promise.resolve();
  geocodeAt = 0;
  geocodeWarnedAt = 0;
  lastRelayOutcome = '';
  lastDirectory = null;
  for (const map of [
    addressBuckets,
    missBuckets,
    missWarned,
    phoneMissBuckets,
    pictureBuckets,
    pictures,
    phoneHosts,
    links,
    networkMemory,
    networkPolls,
    helpBuckets,
  ])
    map.clear();
}

/**
 * Whether this key opens any token seal, or any home-list seal already in
 * memory. It does not load the home list: the caller does that first when
 * it needs a home-list seal to count, so a check cannot recurse through
 * the inbox load the home list resumes.
 */
function keyOpensSomeSeal(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return false;
  for (const record of readTokenStore().tokens) {
    if (openUltraToken(record.sealed, key, { id: record.id })) return true;
  }
  const entries = network?.entries;
  if (!entries) return false;
  for (const entry of entries) {
    const token = openUltraNetworkToken(entry.sealed, key, { id: entry.id });
    if (token && ultraTokenHashEqual(entry.hash, token)) return true;
  }
  return false;
}

/**
 * Whether config/ultra-help.json may be acted on. No check yet is a file
 * from before this, and it is trusted. A check that matches is trusted. A
 * check that does not is trusted only when this key opens nothing: that is
 * a replaced key, and it cannot be told from a file this key never sealed.
 * Once any seal opens, a bad check is not used.
 */
function helpFileTrusted(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return true;
  const { key, state } = readTokenKey();
  if (state !== 'ok' || !key) return true;
  const policy = ultraHelpStorePolicyState(parsed, key);
  if (policy === 'legacy' || policy === 'ok') return true;
  if (!network) loadNetwork();
  return !keyOpensSomeSeal(key);
}

function readStore() {
  let parsed = null;
  // No file yet is an empty store. A file that is there but cannot be read
  // or parsed is not: it still holds the owner's helpers and number, so the
  // store made from it is marked and never written back (see writeStore).
  let unreadable = false;
  let text = null;
  try {
    text = fs.readFileSync(storePath(), 'utf8');
  } catch (error) {
    unreadable = error?.code !== 'ENOENT';
  }
  if (text !== null) {
    try {
      // A byte-order mark (an editor's save on Windows) is not damage.
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      parsed = null;
      unreadable = true;
    }
  }
  if (unreadable && !helpStoreWarned) {
    // Once until it reads again; the parser's message can quote the file.
    helpStoreWarned = true;
    console.warn(
      '[Ultra help] config/ultra-help.json could not be read; your helpers and number are not changed until it is fixed',
    );
  } else if (!unreadable) helpStoreWarned = false;
  // The releases are read once and memory is the truth after: a holder poll
  // and the phone's own poll both read them, and neither may touch the disk.
  // An unreadable file is no read: the next look tries it again. A file whose
  // check does not match is no read either: a planted call must not publish
  // the phone's position after a restart.
  const trusted = unreadable || !parsed || helpFileTrusted(parsed);
  if (!SHARED.releasesLoaded && !unreadable) {
    SHARED.releasesLoaded = true;
    if (trusted) {
      const pressed = SHARED.releasesPressed || new Set();
      SHARED.releasesPressed = null;
      const now = Date.now();
      const saved = [
        ...(Array.isArray(parsed?.releases) ? parsed.releases : []),
        // A file written when the machine kept one release for every package.
        ...(parsed?.release ? [parsed.release] : []),
      ].slice(0, RELEASE_LIMIT);
      for (const item of saved) {
        const kept = normalizeUltraRelease(item, now);
        if (
          kept?.feedId &&
          !releases.has(kept.feedId) &&
          !pressed.has(kept.feedId)
        )
          releases.set(kept.feedId, kept);
      }
    }
  }
  if (!parsed) {
    const empty = { ...emptyStore(), releases: heldReleases() };
    if (unreadable) unreadableStores.add(empty);
    return empty;
  }
  const modelId = ultraPhoneModel(parsed?.modelId).id;
  if (!trusted) {
    const safe = {
      version: 1,
      modelId,
      contacts: [],
      owner: { number: '', needs: null },
      releases: heldReleases(),
    };
    untrustedStores.add(safe);
    return safe;
  }
  const contacts = Array.isArray(parsed?.contacts) ? parsed.contacts : [];
  return {
    version: 1,
    modelId,
    contacts: contacts
      .map((item) => {
        const number = normalizeUltraNumber(item?.number);
        const kind = ultraContactKind(item?.kind);
        const label = String(item?.label || '')
          .trim()
          .slice(0, 60);
        if (!number || !kind || !label) return null;
        return { id: String(item.id || number), label, number, kind };
      })
      .filter(Boolean)
      .slice(0, ULTRA_HELP_CONTACT_LIMIT),
    // The owner's own cell, stored plain: calls for help from the home list
    // and TEST SMS are texted to it. No token holder is ever shown it.
    owner: {
      number: normalizeUltraNumber(parsed?.owner?.number) || '',
      // What SEND HELP asks to be brought (HELP DELIVERY, set on the Social
      // Media tab), from the box and from the phone alike.
      needs: ultraNeeds(parsed?.owner?.needs),
    },
    releases: heldReleases(),
  };
}

/**
 * Every release memory holds that is still inside its window, oldest press
 * first, as the file keeps them. One whose window is over is dropped (and
 * what its call did for the helpers); the next write drops it from the file.
 * This never reads the file: readStore itself uses it.
 */
function heldReleases(now = Date.now()) {
  for (const [feedId, item] of releases) {
    if (!(item.until > now)) {
      releases.delete(feedId);
      ownCalls.delete(feedId);
    }
  }
  return [...releases.values()].sort((a, b) => a.at - b.at);
}

/** Every live release, read from the file first if it has not been yet. */
function currentReleases(now = Date.now()) {
  if (!SHARED.releasesLoaded) readStore();
  return heldReleases(now);
}

/** One package's release while it is still inside its window, else null. */
function currentRelease(feedId, now = Date.now()) {
  currentReleases(now);
  return releases.get(feedId) || null;
}

/**
 * A press (SEND HELP, EXTEND HELP, STAND DOWN) made before the file could be
 * read: memory is the truth for that package from now on, so the file's
 * copy of its call, read once the owner fixes the file, is not merged over it.
 */
function notePress(feedId) {
  if (SHARED.releasesLoaded) return;
  (SHARED.releasesPressed ??= new Set()).add(feedId);
}

/**
 * Write the live releases into the store file, keeping everything else in
 * it. Memory is the truth and has already changed when this runs: a call
 * for help reaching its holders and a STAND DOWN taking effect are both the
 * safe direction, so a refused write never undoes or refuses either. It
 * says so once in the terminal instead, and the next status poll, phone
 * poll or poller tick writes it again (see retryUnsavedReleases). Whether
 * it landed is returned.
 */
function saveReleases(now = Date.now()) {
  try {
    const store = readStore();
    // A helpers file whose check failed is not written back from a press:
    // that would stamp the empty view over the owner's saved numbers. The
    // call stays in memory. A restart keeps it only once the file is trusted.
    if (untrustedStores.has(store)) return false;
    store.releases = currentReleases(now);
    writeStore(store);
    SHARED.releasesUnsaved = false;
    return true;
  } catch (error) {
    if (!SHARED.releasesUnsaved)
      console.warn(
        `[Ultra help] SEND HELP state not saved to disk (${String(error?.code || 'error').slice(0, 40)}); retrying`,
      );
    SHARED.releasesUnsaved = true;
    releaseRetryAt = now;
    return false;
  }
}

/**
 * A refused release write, tried again fifteen seconds after the last
 * attempt: the box polls every few seconds, the phone every second and the
 * poller ticks every five, and a disk that keeps refusing must not start
 * the hardener on every one. The phone and the poller call it too, so a
 * STAND DOWN pressed on the phone with no GEV tab open still reaches the
 * file, and a later restart cannot bring the call back.
 */
function retryUnsavedReleases(now = Date.now()) {
  if (!SHARED.releasesUnsaved || now - releaseRetryAt < RELEASE_RETRY_MS)
    return;
  saveReleases(now);
}

function writeStore(store) {
  if (unreadableStores.has(store))
    throw storeFailure('GEV_STORE_UNREADABLE', HELP_STORE_UNREADABLE_MESSAGE);
  // The check covers the number, the helpers and the releases about to be
  // written. The phone model is not part of it. A missing key writes no
  // check: a save while the key is gone is a file with no check, trusted
  // until a key that opens a seal exists and a later save stamps it.
  const body = {
    version: 1,
    modelId: store.modelId,
    contacts: store.contacts,
    owner: store.owner,
    releases: store.releases,
  };
  const read = readTokenKey();
  if (read.state === 'ok' && read.key) {
    const policyMac = ultraHelpStorePolicyMac(body, read.key);
    if (policyMac) body.policyMac = policyMac;
  }
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  replaceCredentialStore(file, `${JSON.stringify(body, null, 2)}\n`, {
    harden: hardenImpl,
  });
  untrustedStores.delete(store);
}

// ---- directory, relay and phone-package checks ---------------------------
// config/ultra-outbound.json holds one check each for the directory, the SMS
// relay and the phone packages. A check is written only when the owner saves
// that setting. The poller never writes this file, and neither does a status
// poll. No check yet is trusted. A bad check is not used while this key opens
// a seal. Sections are independent: a missing check beside one that is
// present is still an older setting, and it is trusted.

const outboundPath = (root) =>
  path.join(
    path.resolve(String(root || sourceRoot)),
    'config',
    'ultra-outbound.json',
  );

function macField(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
    ? value
    : 'bad';
}

function emptyOutboundView(missing, unreadable) {
  return {
    missing,
    unreadable,
    directoryMac: undefined,
    relayMac: undefined,
    feedsMac: undefined,
  };
}

/** The sidecar, re-read every time so a hand edit is seen without a restart. A missing file is not cached as a permanent absence. */
function readOutbound(root = sourceRoot) {
  const resolved = path.resolve(String(root || sourceRoot));
  const file = outboundPath(resolved);
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
    outboundCache &&
    outboundCache.root === resolved &&
    outboundCache.text === text &&
    outboundCache.missing === missing &&
    outboundCache.unreadable === unreadable
  ) {
    return outboundCache.view;
  }
  let view;
  if (missing) {
    view = emptyOutboundView(true, false);
    outboundWarned = false;
  } else if (unreadable) {
    view = emptyOutboundView(false, true);
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      view = emptyOutboundView(false, true);
    } else {
      view = {
        missing: false,
        unreadable: false,
        directoryMac: macField(parsed.directoryMac),
        relayMac: macField(parsed.relayMac),
        feedsMac: macField(parsed.feedsMac),
      };
      outboundWarned = false;
    }
  }
  if (view.unreadable && !outboundWarned) {
    outboundWarned = true;
    console.warn('[Ultra help] config/ultra-outbound.json could not be read');
  }
  outboundCache = { root: resolved, text, missing, unreadable, view };
  return view;
}

function writeOutbound(root, macs) {
  const body = { version: 1 };
  if (macs.directoryMac) body.directoryMac = macs.directoryMac;
  if (macs.relayMac) body.relayMac = macs.relayMac;
  if (macs.feedsMac) body.feedsMac = macs.feedsMac;
  const file = outboundPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Passing harden: undefined would replace the default hardener and throw.
  // Before pointAt (a device-feed test, a key-setup save) there is no
  // injected hardener, and the default one is the right one.
  const options =
    typeof hardenImpl === 'function' ? { harden: hardenImpl } : {};
  replaceCredentialStore(file, `${JSON.stringify(body, null, 2)}\n`, options);
  outboundCache = null;
}

/** The token key at a root. A malformed file is never overwritten. */
function readTokenKeyAt(root) {
  const file = path.join(
    path.resolve(String(root || sourceRoot)),
    'config',
    'ultra-tokens.key',
  );
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { key: null, state: 'missing' };
    return { key: null, state: 'invalid' };
  }
  const key = parseUltraTokenKey(text);
  return key ? { key, state: 'ok' } : { key: null, state: 'invalid' };
}

/** Whether a key opens a token or home-list seal in files at a root that is not this module's. */
function sealsOpenInFiles(root, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return false;
  const base = path.resolve(String(root));
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(base, 'config', 'ultra-tokens.json'), 'utf8'),
    );
    const tokens = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    for (const record of tokens) {
      try {
        if (openUltraToken(record?.sealed, key, { id: record?.id }))
          return true;
      } catch {
        /* one bad blob is not the rest of the file */
      }
    }
  } catch {
    /* no token file, or it cannot be read */
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(base, 'config', 'ultra-network.json'), 'utf8'),
    );
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const entry of entries) {
      try {
        const token = openUltraNetworkToken(entry?.sealed, key, {
          id: entry?.id,
        });
        if (token && ultraTokenHashEqual(entry?.hash, token)) return true;
      } catch {
        /* next */
      }
    }
  } catch {
    /* no home list */
  }
  return false;
}

/**
 * Whether this key opens a seal for the root being judged. This module's
 * own root uses the home list already in memory (loading it once when it
 * has not been read). Another root, a device-feed test's temp dir while
 * this module still points at the checkout, is judged from that dir's own
 * files: the checkout's key must not decide it.
 */
function sealsOpen(root, key) {
  try {
    const resolved = path.resolve(String(root || sourceRoot));
    if (resolved === path.resolve(sourceRoot)) {
      if (!network) loadNetwork();
      return keyOpensSomeSeal(key);
    }
    return sealsOpenInFiles(resolved, key);
  } catch {
    return false;
  }
}

function directoryMaterial() {
  return { url: directoryUrl(), writeToken: directoryWriteToken() };
}

/**
 * 'tampered' only when a check is present and wrong, or the sidecar cannot
 * be read, and this key opens a seal. No check yet is 'ok', and so is a key
 * that opens nothing: that is what replacing the key looks like.
 */
function outboundSectionStatus(root, macName, expected) {
  const view = readOutbound(root);
  const read = readTokenKeyAt(root);
  const keyOk = read.state === 'ok';
  if (view.unreadable)
    return keyOk && sealsOpen(root, read.key) ? 'tampered' : 'ok';
  const stored = view[macName];
  if (!stored) return 'ok';
  if (!keyOk) return 'ok';
  if (ultraOutboundPolicyState(stored, expected, read.key) === 'ok')
    return 'ok';
  return sealsOpen(root, read.key) ? 'tampered' : 'ok';
}

// The checks are judged against every form the key can give (the derived
// subkey first, then the raw key a file from before the key split carries),
// so an older sidecar still verifies; stamping writes the derived form only.
function directoryStatus(root = sourceRoot) {
  const read = readTokenKeyAt(root);
  const expected =
    read.state === 'ok'
      ? ultraDirectoryPolicyMacs(directoryMaterial(), read.key)
      : [];
  return outboundSectionStatus(root, 'directoryMac', expected);
}

function relayStatus(root = sourceRoot) {
  const read = readTokenKeyAt(root);
  const expected =
    read.state === 'ok'
      ? ultraRelayPolicyMacs(ultraSmsRelayMaterial(process.env), read.key)
      : [];
  return outboundSectionStatus(root, 'relayMac', expected);
}

/** The security packages at a root, or null when the device file cannot be read. A missing file is an empty list. */
function feedPolicyRecordsAt(root) {
  const file = path.join(
    path.resolve(String(root || sourceRoot)),
    DEVICE_FEED_STORE,
  );
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    return null;
  }
  try {
    return securityFeedPolicyRecords(JSON.parse(text));
  } catch {
    return null;
  }
}

function feedsStatus(root = sourceRoot) {
  const view = readOutbound(root);
  const read = readTokenKeyAt(root);
  const keyOk = read.state === 'ok';
  if (view.unreadable)
    return keyOk && sealsOpen(root, read.key) ? 'tampered' : 'ok';
  // No check yet: do not open a seal and do not read the device file again.
  if (!view.feedsMac) return 'ok';
  if (!keyOk) return 'ok';
  const records = feedPolicyRecordsAt(root);
  if (records === null) return sealsOpen(root, read.key) ? 'tampered' : 'ok';
  const expected = ultraFeedsPolicyMacs(records, read.key);
  if (ultraOutboundPolicyState(view.feedsMac, expected, read.key) === 'ok')
    return 'ok';
  return sealsOpen(root, read.key) ? 'tampered' : 'ok';
}

/** Whether phone packages at this root may admit a key or be fetched. Never throws. */
export function ultraOutboundFeedsTrusted(root = sourceRoot) {
  try {
    return feedsStatus(root) !== 'tampered';
  } catch {
    return false;
  }
}

/**
 * Write the checks for the sections the owner just saved. A section that
 * was not saved keeps its check, including one that no longer matches.
 * A missing key writes no check for the saved section. Nothing is written
 * when that would only create an empty file.
 */
function stampOutbound(root, which) {
  const resolved = path.resolve(String(root || sourceRoot));
  const view = readOutbound(resolved);
  const read = readTokenKeyAt(resolved);
  const keyOk = read.state === 'ok';
  const macs = view.unreadable
    ? {}
    : {
        directoryMac: view.directoryMac,
        relayMac: view.relayMac,
        feedsMac: view.feedsMac,
      };
  if (which.directory) {
    macs.directoryMac = keyOk
      ? ultraDirectoryPolicyMac(directoryMaterial(), read.key)
      : undefined;
  }
  if (which.relay) {
    macs.relayMac = keyOk
      ? ultraRelayPolicyMac(ultraSmsRelayMaterial(process.env), read.key)
      : undefined;
  }
  if (which.feeds) {
    macs.feedsMac = keyOk
      ? ultraFeedsPolicyMac(securityFeedPolicyRecords(which.config), read.key)
      : undefined;
  }
  const any = macs.directoryMac || macs.relayMac || macs.feedsMac;
  const hadNone =
    view.missing ||
    (!view.unreadable &&
      !view.directoryMac &&
      !view.relayMac &&
      !view.feedsMac);
  if (!any && hadNone) return;
  writeOutbound(resolved, macs);
}

/**
 * After a POWER UP save. A directory or relay name stamps that Ultra check.
 * A provider-key name stamps the separate local check. Either failure is
 * said by its code only; the .env save has already landed.
 */
export function noteOutboundEnvSaved(names, root = sourceRoot) {
  const list = Array.isArray(names) ? names : [];
  try {
    noteLocalProvidersSaved(list, root);
  } catch (error) {
    console.warn(
      `[Ultra help] provider check was not saved (${String(error?.code || 'error').slice(0, 40)})`,
    );
  }
  const directory = list.some((name) => DIRECTORY_ENV.has(name));
  const relay = list.some((name) => RELAY_ENV.has(name));
  if (!directory && !relay) return;
  stampOutbound(root, { directory, relay });
}

/** After a device save. The config is the one just written, not a second read. */
export function noteSecurityFeedsSaved(config, root = sourceRoot) {
  stampOutbound(root, { feeds: true, config });
}

/** Addresses the report listener is answering on, so the panel can show the phone link. */
export function noteUltraEndpoint(bases) {
  reportBases = (Array.isArray(bases) ? bases : []).filter((base) =>
    /^https?:\/\/[^/\s]+$/.test(String(base)),
  );
}

/** The phone that just connected, remembered only when it is a private LAN address. */
export function noteUltraPhone(key, remoteAddress) {
  if (!KEY.test(String(key || ''))) return '';
  const host = lanHost(remoteAddress);
  if (!host) return '';
  phoneHosts.set(key, host);
  return host;
}

function lanHost(address) {
  const host = String(address || '').replace(/^::ffff:/i, '');
  const parts = host.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return '';
  const [a, b] = parts;
  // RFC 1918, plus the CGNAT range Tailscale hands out (100.64.0.0/10).
  const privateLan =
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127);
  return privateLan ? host : '';
}

/**
 * Whether a key still names a saved security package. Only the store counts:
 * a key this process once saw a fix from is not enough, or NEW KEY and
 * removing a package would go on admitting the retired link until the next
 * dev-server restart — and that link can press SEND HELP.
 */
function knownSecurityKey(key) {
  if (!KEY.test(String(key || ''))) return false;
  return securityFeeds().some((feed) => sameKey(feed.reportKey, key));
}

/**
 * Whether the packages last read from the store name this key, without
 * reading it again. Only a way past the miss budget: admission itself
 * always reads the store.
 */
function cachedSecurityKey(key) {
  return feedCache.feeds.some((feed) => sameKey(feed.reportKey, key));
}

/** Two phone keys compared in constant time. */
function sameKey(saved, given) {
  const a = Buffer.from(String(saved ?? ''));
  const b = Buffer.from(String(given ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ultraCamLink(key) {
  const base = reportBases[0];
  return base && KEY.test(String(key || '')) ? `${base}/ultra/${key}/cam` : '';
}

function ultraHelpBase() {
  const base = reportBases[0];
  return base ? `${base}/ultra/help/` : '';
}

/**
 * The tailnet address a NETWORK handout carries, as a bare origin: this
 * machine's https *.ts.net name first, else its 100.64.x literal, or ''
 * when the listener has none. A LAN address is never used here — every
 * receiver's poller refuses it, so a published or shared address on one
 * would be silently dead. Never joined with a token.
 */
function ultraNetworkHelpBase() {
  return ultraTailnetBase(reportBases);
}

/** The saved package's key, so the phone link exists before the phone has ever reported. */
function firstSecurityKey() {
  try {
    if (!ultraOutboundFeedsTrusted()) return '';
    const config = JSON.parse(fs.readFileSync(feedStorePath(), 'utf8'));
    const feed = (config.feeds || []).find(
      (item) =>
        item?.kind === 'security' && KEY.test(String(item.reportKey || '')),
    );
    return feed ? feed.reportKey : '';
  } catch {
    return '';
  }
}

/**
 * The saved security packages (id, display name and the current phone key),
 * re-read only when config/device-feeds.json changes. A token stores a
 * package's id, never its key, so this is how a token's location poll finds
 * the phone after a NEW KEY rotation.
 */
function securityFeeds() {
  const file = feedStorePath();
  // The file itself is the stamp, not its timestamp. NEW KEY rewrites a file
  // of exactly the same length, and Windows hands two writes inside one
  // clock tick (about 15 ms) the same mtime even in nanoseconds — so a
  // stat-based cache can miss a key rotation, and this is the admission path
  // for every phone route. The file is a few kilobytes and warm in the page
  // cache; only the parse is skipped when nothing changed.
  let stamp = 'missing';
  try {
    stamp = fs.readFileSync(file, 'utf8');
  } catch {
    stamp = 'missing';
  }
  if (stamp !== feedCache.stamp) {
    let feeds = [];
    let read = false;
    if (stamp !== 'missing') {
      try {
        const config = JSON.parse(stamp);
        read = true;
        feeds = (Array.isArray(config?.feeds) ? config.feeds : [])
          .filter(
            (feed) =>
              feed?.kind === 'security' &&
              typeof feed.id === 'string' &&
              feed.id !== '' &&
              KEY.test(String(feed.reportKey || '')),
          )
          .map((feed) => ({
            id: feed.id,
            name: String(feed.name || '')
              .trim()
              .slice(0, ULTRA_HELP_NAME_LIMIT),
            reportKey: feed.reportKey,
            // For the Ultra tab's RECORD WITHIN choice, which saves the cell
            // again through the device route (it needs the method to).
            method: String(feed.method || ''),
            record: feed.record === true,
            recordKm: Number(feed.recordKm) || null,
          }));
      } catch {
        feeds = [];
        read = false;
      }
    }
    feedCache = { stamp, feeds };
    // The real list, so a check that fails does not look like every package
    // was removed and end the calls those packages are in.
    forgetRetiredKeys(feeds, { read });
  }
  // Admission sees nothing while the phone-package check fails. The cache
  // above still holds the file's packages for the call bookkeeping.
  return ultraOutboundFeedsTrusted() ? feedCache.feeds : [];
}

/**
 * Drop everything this process remembers under a key the store no longer
 * names. Without this a rotated (NEW KEY) or deleted package keeps its last
 * fix in `positions`, and that fix is what the desktop's SEND HELP would
 * publish and what the box would go on drawing. A package the store no
 * longer holds also ends its call for help — its phone and its tokens can
 * no longer be admitted, and a package saved again under the same name
 * (the same id) must not bring an old call back live. That happens only
 * when the store was read: a missing or half-written file never ends a
 * call (the box still shows it, and STAND DOWN still reaches it).
 */
function forgetRetiredKeys(feeds, { read = false } = {}) {
  const live = new Set(feeds.map((feed) => feed.reportKey));
  const liveIds = new Set(feeds.map((feed) => `feed:${feed.id}`));
  const kept = (key) => live.has(key) || liveIds.has(key);
  for (const map of [positions, commands, pictures, notifies, phoneHosts]) {
    for (const key of [...map.keys()]) if (!kept(key)) map.delete(key);
  }
  if (!read) return;
  const ids = new Set(feeds.map((feed) => feed.id));
  const gone = currentReleases().filter((item) => !ids.has(item.feedId));
  if (!gone.length) return;
  for (const item of gone) {
    releases.delete(item.feedId);
    ownCalls.delete(item.feedId);
  }
  console.log(
    `[Ultra help] SEND HELP ended for ${gone.length} removed package${gone.length === 1 ? '' : 's'}`,
  );
  // Memory is the truth; a refused write is said once and retried.
  saveReleases();
}

function securityFeed(feedId) {
  return securityFeeds().find((feed) => feed.id === feedId) || null;
}

function securityFeedKey(feedId) {
  return securityFeed(feedId)?.reportKey || '';
}

// ---- token key ------------------------------------------------------------

/** The key file's contents: 'ok' with the key, 'missing', or 'invalid' (present but not a key; never overwritten). */
function readTokenKey() {
  let text;
  try {
    text = fs.readFileSync(tokenKeyPath(), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { key: null, state: 'missing' };
    return { key: null, state: 'invalid' };
  }
  const key = parseUltraTokenKey(text);
  return key ? { key, state: 'ok' } : { key: null, state: 'invalid' };
}

/**
 * The key to seal a new token with. The file is made once, on the first mint
 * into an empty store, and only when nothing is there: the create is
 * exclusive (a hard link to the name, refused with EEXIST when the name is
 * taken), so a present file is never written over, not even by two mints
 * racing each other. It is then read back, so the bytes actually on disk
 * are the ones used even if another process won that race. A missing key
 * with tokens present, or a malformed one, refuses the mint: those tokens
 * still admit by hash, and RESET TOKENS is the way out.
 */
function ensureTokenKey(tokens) {
  const file = tokenKeyPath();
  let present = true;
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    present = false;
  }
  if (!present) {
    // A revoked record never needs the old key again (reveal refuses it),
    // so only a live token blocks a fresh key: revoking every token is a
    // real way out, as the refusal says.
    if (tokens.some((item) => item.revokedAt === null))
      throw storeFailure('GEV_TOKEN_KEY_MISSING', KEY_MISSING_MESSAGE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const installed = replaceCredentialStore(file, newUltraTokenKeyText(), {
        harden: hardenImpl,
        exclusive: true,
      });
      if (installed?.exclusive === false && !keyLinkWarned) {
        keyLinkWarned = true;
        console.warn(
          `[Ultra help] the token key was created by rename, not an exclusive link (${String(installed.linkError || 'error').slice(0, 20)}): this volume cannot make hard links.`,
        );
      }
    } catch (error) {
      // Another process won: its key is the one on disk, and the read-back
      // below uses it. Anything else is a real failure.
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const read = readTokenKey();
  if (read.state === 'invalid')
    throw storeFailure('GEV_TOKEN_KEY_INVALID', KEY_INVALID_MESSAGE);
  if (read.state === 'missing')
    throw storeFailure('GEV_TOKEN_KEY_MISSING', KEY_MISSING_MESSAGE);
  return read.key;
}

/** The key as a reveal needs it: present and well formed, or the refusal the owner sees. */
function requireTokenKey() {
  const read = readTokenKey();
  if (read.state === 'missing')
    throw storeFailure('GEV_TOKEN_KEY_MISSING', KEY_MISSING_MESSAGE);
  if (read.state === 'invalid')
    throw storeFailure('GEV_TOKEN_KEY_INVALID', KEY_INVALID_MESSAGE);
  return read.key;
}

// ---- token store ----------------------------------------------------------

/**
 * The sealed token store, re-read when the file changes. A store that exists
 * but cannot be read admits nobody; an owner write over it is refused
 * (`strict`) so a corrupt file is never quietly replaced by an empty one.
 */
function readTokenStore({ strict = false } = {}) {
  const file = tokenStorePath();
  // The file is its own stamp, for the reason given in securityFeeds: a
  // revocation can rewrite the store to the same length inside one clock
  // tick, and this decides who is admitted.
  let stamp = 'missing';
  try {
    stamp = fs.readFileSync(file, 'utf8');
  } catch {
    stamp = 'missing';
  }
  if (stamp !== tokenCache.stamp) {
    let store = emptyTokenStore();
    let unreadable = false;
    if (stamp !== 'missing') {
      try {
        store = normalizeUltraTokenStore(JSON.parse(stamp));
      } catch {
        // The parser's message can quote the file, so it is not repeated.
        unreadable = true;
        console.warn(
          '[Ultra help] config/ultra-tokens.json could not be read; no help link is admitted until it is fixed or RESET TOKENS is pressed.',
        );
      }
    }
    tokenCache = { stamp, store, unreadable };
  }
  if (strict && tokenCache.unreadable)
    throw storeFailure('GEV_STORE_UNREADABLE', STORE_UNREADABLE_MESSAGE);
  return tokenCache.store;
}

/**
 * Write the token store. Skill names are never kept in the file: they are
 * read back from the opened token. A policy MAC is stamped when this key
 * opens the seal and the hash matches, except a MAC that does not verify is
 * left as it is unless `blessIds` names that record — an owner edit, revoke
 * or directory publish of that one id. A record with no MAC is stamped only
 * for those ids, or when `stampLegacy` is set and no record in the file has
 * a MAC yet. Stamping a missing MAC beside one that is already present would
 * bless whatever flags are in the file now. A missing key, a key that cannot
 * open the seal, or a hash that does not match the opened token is never
 * stamped: restoring the old key must not then look like a forgery, and a
 * swapped hash must not be laundered.
 */
function writeTokenStore(store, { blessIds = [], stampLegacy = false } = {}) {
  const read = readTokenKey();
  const key = read.state === 'ok' ? read.key : null;
  const bless = new Set(blessIds);
  const normalized = normalizeUltraTokenStore(store);
  const incoming = normalized.tokens;
  const allowLegacy =
    stampLegacy === true && !ultraTokenStoreHasPolicyMac(incoming);
  let opensAny = false;
  const tokens = incoming.map((record) => {
    const stripped = { ...record, skills: [] };
    if (!key) return stripped;
    const opened = openUltraToken(stripped.sealed, key, { id: stripped.id });
    if (opened) opensAny = true;
    if (!opened || !ultraTokenHashEqual(stripped.hash, opened)) return stripped;
    const state = ultraTokenPolicyState(stripped, key);
    if (state === 'bad' && !bless.has(stripped.id)) return stripped;
    if (state === 'legacy' && !bless.has(stripped.id) && !allowLegacy)
      return stripped;
    return stampUltraTokenPolicy(stripped, key);
  });
  // The header names the key the seals were made under (ultraTokenKeyId,
  // nothing of the key itself), so a replaced key is told apart from a
  // file this key never sealed without opening a seal. The current key
  // earns the header when it opens a seal in the file, or the file holds no
  // token at all; a key that opens none of them is a replaced key, and the
  // header keeps naming the old one so the box can say so. A write without
  // a usable key keeps whatever the file said (the callers rebuild the
  // store from its records, so the stored header is read back here).
  const keyId =
    key && (opensAny || tokens.length === 0)
      ? ultraTokenKeyId(key)
      : (normalized.keyId ?? readTokenStore().keyId);
  let header = keyId ? { version: 1, keyId, tokens } : { version: 1, tokens };
  // The store-wide check (ultraTokenStoreMac) is stamped under the same
  // condition as the header: this key opened a seal here, or the file is
  // empty. A check that no longer matches the records is kept as it is on a
  // write nobody asked for (a holder's request stamping legacy rows), so the
  // box goes on saying the file was changed; an owner action on a named
  // record (mint, revoke, edit, publish) is the owner's say over the file
  // and stamps it afresh. Without a usable key the stale check is dropped
  // rather than left to fail: the file is then 'legacy', not 'tampered'.
  const canStamp = key && (opensAny || tokens.length === 0);
  // Judged on the file as it is on disk, before this write touched a row:
  // the callers rebuild the store from its records, so what they pass has
  // no check of its own to judge.
  const onDisk = readTokenStore();
  const wasBad = ultraTokenStoreState(onDisk, key) === 'bad';
  if (canStamp && (!wasBad || bless.size > 0))
    header = stampUltraTokenStore(header, key);
  else if (canStamp && wasBad)
    header = { ...header, storeMac: onDisk.storeMac, tokens };
  const file = tokenStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  replaceCredentialStore(file, `${JSON.stringify(header, null, 2)}\n`, {
    harden: hardenImpl,
  });
  tokenCache = { stamp: '', store: emptyTokenStore(), unreadable: false };
}

/**
 * One stamp for a file in which no record has a policy MAC yet, and a strip
 * of skill names still stored beside the seal. A missing MAC beside one that
 * is present is not filled in: that would bless the flags now in the file.
 * Not called from readTokenStore. A holder request may rewrite once; after
 * that it does not. A failed write leaves the previous file; admission still
 * works when the key cannot open the seal.
 */
function tokenPolicyNeedsWrite(record, key) {
  if (Array.isArray(record.skills) && record.skills.length > 0) return true;
  const opened = openUltraToken(record.sealed, key, { id: record.id });
  if (!opened || !ultraTokenHashEqual(record.hash, opened)) return false;
  return ultraTokenPolicyState(record, key) === 'legacy';
}

function maybeUpgradeTokenPolicy() {
  try {
    const read = readTokenKey();
    if (read.state !== 'ok') return;
    const store = readTokenStore();
    if (tokenCache.unreadable) return;
    const hasMac = ultraTokenStoreHasPolicyMac(store.tokens);
    const stampLegacy =
      !hasMac &&
      store.tokens.some((record) => tokenPolicyNeedsWrite(record, read.key));
    const stripSkills = store.tokens.some(
      (record) => Array.isArray(record.skills) && record.skills.length > 0,
    );
    // A file from before the store-wide check earns one once this key is
    // seen to open a seal in it (or it is empty): from then on a record
    // removed or copied in by hand is told. A check that is present and
    // wrong is not rewritten here; see writeTokenStore.
    const needsStoreMac =
      store.storeMac === undefined &&
      (store.tokens.length === 0 ||
        store.tokens.some((record) =>
          openUltraToken(record.sealed, read.key, { id: record.id }),
        ));
    if (!stampLegacy && !stripSkills && !needsStoreMac) return;
    writeTokenStore(store, { stampLegacy });
  } catch (error) {
    console.warn(
      `[Ultra help] token policy stamp skipped: ${String(error?.code || 'error').slice(0, 60)}`,
    );
  }
}

/**
 * Whether config/ultra-tokens.key is still restricted to this account. The
 * hardener proves that when it writes the file; this asks again on read, so
 * a key whose protection was widened afterwards (a chmod, an inherited ACL
 * put back, a copy restored from a backup with the folder's rights) is told
 * instead of trusted. Checked again when the file's stat changes or after
 * KEY_GUARD_TTL_MS; a missing file is not judged here (readTokenKey says
 * 'missing'). Any failure to check is counted as exposed.
 */
function keyFileRestricted(now = Date.now()) {
  const file = tokenKeyPath();
  let stamp;
  try {
    const entry = fs.lstatSync(file);
    stamp = `${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}:${entry.mode}`;
  } catch {
    return true;
  }
  if (
    stamp === keyGuard.stamp &&
    now - keyGuard.at < KEY_GUARD_TTL_MS &&
    now >= keyGuard.at
  )
    return keyGuard.restricted;
  let restricted = false;
  try {
    restricted =
      typeof verifyImpl === 'function' ? verifyImpl(file) === true : false;
  } catch {
    restricted = false;
  }
  keyGuard = { stamp, restricted, at: now };
  return restricted;
}

/**
 * What the box says about the store: one word the note is painted from.
 * 'key-changed' is a well-formed key that is not the one the store was last
 * written under (the header's keyId): its tokens are still admitted by
 * hash, but none can be shown and a mint seals under the new key. It is
 * said here once, rather than left for the owner to infer from a reveal
 * that answers KEY_CHANGED_MESSAGE. A store from before the header, or one
 * written while the key was missing, has no keyId and is not judged.
 */
function tokenStoreState() {
  const store = readTokenStore();
  if (tokenCache.unreadable) return 'unreadable';
  const { key, state } = readTokenKey();
  if (state === 'invalid') return 'key-invalid';
  if (
    state === 'missing' &&
    store.tokens.some((item) => item.revokedAt === null)
  )
    return 'no-key';
  if (state === 'ok' && store.keyId && store.keyId !== ultraTokenKeyId(key)) {
    if (!keyChangedWarned) {
      keyChangedWarned = true;
      console.warn(
        '[Ultra help] config/ultra-tokens.key is not the key the token store was written under: existing tokens still admit by hash but cannot be shown; revoke them and mint again, or RESET TOKENS.',
      );
    }
    return 'key-changed';
  }
  keyChangedWarned = false;
  // The key file's protection, asked again rather than remembered from the
  // write. The key is still used (nothing here can tell whether anyone read
  // it), so this is said to the owner: the way out is to restore owner-only
  // access, or RESET TOKENS for a key nobody else has had sight of.
  if (state === 'ok' && !keyFileRestricted()) {
    if (!keyExposedWarned) {
      keyExposedWarned = true;
      console.warn(
        '[Ultra help] config/ultra-tokens.key is no longer restricted to this account: another account on this computer could read it. Restore owner-only access to the file, or RESET TOKENS and mint again.',
      );
    }
    return 'key-exposed';
  }
  keyExposedWarned = false;
  // The store-wide check: a record removed, copied in, reordered, or
  // stripped of its own check while the file keeps the rest. Admission is
  // unchanged (each record still answers for itself; a removed record only
  // denies its own holder), so this is said to the owner rather than acted
  // on, and stays said until an owner action on the store stamps it again.
  if (state === 'ok' && ultraTokenStoreState(store, key) === 'bad') {
    if (!storeChangedWarned) {
      storeChangedWarned = true;
      console.warn(
        '[Ultra help] config/ultra-tokens.json does not match its store check: a token record was removed, added or reordered outside this program. Review the rows, then mint, revoke or edit one to accept the file as it is, or RESET TOKENS.',
      );
    }
    return 'store-changed';
  }
  storeChangedWarned = false;
  return 'ok';
}

// ---- inbox ----------------------------------------------------------------

/** The inbox, read once; memory is the truth from then on. */
function loadInbox() {
  if (inbox) return inbox;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(inboxPath(), 'utf8'));
  } catch (error) {
    // Messages are not credentials: an unreadable file is said once, the
    // inbox starts empty and the next write replaces it.
    if (error?.code !== 'ENOENT' && !inboxWarned) {
      inboxWarned = true;
      console.warn(
        '[Ultra help] config/ultra-inbox.json could not be read; starting with an empty inbox.',
      );
    }
  }
  inbox = normalizeUltraInbox(parsed);
  return inbox;
}

/** Write behind: appends, delivered marks and read marks within a second land together. */
function scheduleInboxWrite() {
  if (inboxTimer) return;
  inboxTimer = setTimeout(() => {
    inboxTimer = null;
    flushInbox();
  }, 1000);
  inboxTimer.unref?.();
}

/**
 * The inbox holds no owner secret, but it does hold strangers' reply numbers
 * and positions. Each row can carry a check under the token key. A file in
 * which no row has one is from before the check and is still shown; once any
 * row has one, a row whose check is missing or wrong is not shown or read
 * aloud. The first flush of a process goes through the credential-store path
 * (owner-only permissions, atomic rename) and the later ones rewrite that
 * same file in place, which keeps that permission without spawning the
 * hardener once a second. A file that is gone (or is a link) by then is made
 * again through the credential-store path: a file made anew in place would
 * take the folder's permissions. A failure keeps the memory copy and is said
 * once.
 */
function flushInbox() {
  if (inboxTimer) {
    clearTimeout(inboxTimer);
    inboxTimer = null;
  }
  if (!inbox) return;
  // No row has a check yet: stamp them all on the way out. A check that is
  // already there, good or not, is left alone, so a removed check is not
  // filled back in by the next write of some other row.
  stampLegacyInbox(inbox);
  const file = inboxPath();
  const text = `${JSON.stringify(inbox, null, 2)}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!inboxHardened || !rewriteInPlace(file, text)) {
      replaceCredentialStore(file, text, { harden: hardenImpl });
      inboxHardened = true;
    }
  } catch {
    if (!inboxWarned) {
      inboxWarned = true;
      console.warn(
        '[Ultra help] config/ultra-inbox.json could not be written; help messages are kept in memory until it can be.',
      );
    }
  }
}

/**
 * Rewrite an existing file where it is, so it keeps the permissions it has.
 * False, with nothing written, when the file is gone or is a link: opening
 * it r+ never creates one.
 */
function rewriteInPlace(file, text) {
  let fd;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return false;
    fd = fs.openSync(file, 'r+');
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.from(text, 'utf8');
    fs.ftruncateSync(fd, 0);
    let written = 0;
    while (written < buffer.length) {
      written += fs.writeSync(
        fd,
        buffer,
        written,
        buffer.length - written,
        written,
      );
    }
    fs.fsyncSync(fd);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether a row carries a check, including one that does not verify. */
function inboxCarriesPolicyMac(message) {
  const mac = message?.policyMac;
  return mac !== undefined && mac !== null && mac !== '';
}

/**
 * Stamp one row the process just wrote. A missing or unusable key leaves the
 * row alone, so a save while the key is gone stays a row with no check.
 */
function touchInbox(message) {
  const read = readTokenKey();
  if (read.state !== 'ok' || !read.key) return message;
  const policyMac = ultraInboxPolicyMac(message, read.key);
  if (policyMac) message.policyMac = policyMac;
  return message;
}

/**
 * Stamp every row when none of them has a check yet. Called before an edit,
 * so the edited row's new check does not make the others look unchecked.
 * A check that is already there is not rewritten.
 */
function stampLegacyInbox(box) {
  if (!box || !Array.isArray(box.messages)) return;
  const read = readTokenKey();
  if (read.state !== 'ok' || !read.key) return;
  if (box.messages.some(inboxCarriesPolicyMac)) return;
  for (const message of box.messages) touchInbox(message);
}

/**
 * Rows the box may show, speak and count. The file is not changed. The home
 * list has to be loaded first when a seal there should count: this does not
 * load it, or a helpers-file check would recurse through the inbox.
 */
function visibleInboxMessages() {
  const messages = loadInbox().messages;
  const read = readTokenKey();
  if (read.state !== 'ok' || !read.key) return messages;
  return ultraInboxVisibleMessages(messages, read.key, {
    sealsOpen: keyOpensSomeSeal(read.key),
  });
}

function appendInbox(message) {
  const box = loadInbox();
  stampLegacyInbox(box);
  touchInbox(message);
  box.messages.unshift(message);
  if (box.messages.length > ULTRA_INBOX_LIMIT)
    box.messages.length = ULTRA_INBOX_LIMIT;
  scheduleInboxWrite();
}

/** One kept row by id, or null: how the poller finds the episode it opened. */
function inboxRow(id) {
  if (!id) return null;
  return loadInbox().messages.find((item) => item.id === id) || null;
}

/**
 * Append, or replace the row that already carries this id. The poller only
 * ever writes the inbox this way, so a call for help that moves, is
 * geocoded or gets an SMS outcome stays one row through the same one-second
 * write-behind; it never goes through the credential store.
 */
function upsertInbox(message) {
  const box = loadInbox();
  const index = box.messages.findIndex((item) => item.id === message.id);
  if (index < 0) {
    appendInbox(message);
    return;
  }
  stampLegacyInbox(box);
  touchInbox(message);
  box.messages[index] = message;
  scheduleInboxWrite();
}

function markDelivered(items, now) {
  const ids = new Set(items.map((item) => item.id));
  const box = loadInbox();
  stampLegacyInbox(box);
  for (const message of box.messages) {
    if (ids.has(message.id) && message.deliveredAt === null) {
      message.deliveredAt = now;
      touchInbox(message);
    }
  }
  scheduleInboxWrite();
}

/**
 * Queue a card for the phone's next poll; separate from the one-slot
 * command so neither clobbers the other. Past the cap the oldest card goes — but an
 * SMS card (the plea for the owner's helpers, or Find Ultra Help's text) is
 * the last to go, so a burst of other cards cannot push it out before the
 * phone polls.
 */
function pushNotify(key, item) {
  const queue = notifies.get(key) || [];
  queue.push(item);
  while (queue.length > ULTRA_NOTIFY_LIMIT) {
    // Never the card just given: among the others, the oldest that is not
    // an SMS card, else simply the oldest.
    const oldest = queue.slice(0, -1).findIndex((card) => card?.kind !== 'sms');
    queue.splice(oldest === -1 ? 0 : oldest, 1);
  }
  notifies.set(key, queue);
}

/**
 * Drop the plea cards of one package's call that the phone has not popped
 * yet: after STAND DOWN, or once that call has ended or been replaced, they
 * must never pop up, buzz and ask to text the helpers hours later. `keep`
 * is the call still running, if any (a card for it stays).
 */
function dropPleaCards(key, feedId, keep = null) {
  const queue = notifies.get(key);
  if (!queue) return;
  const stale = (card) =>
    card?.kind === 'sms' &&
    typeof card.call === 'string' &&
    card.call.startsWith(`${feedId}:`) &&
    card.call !== keep;
  const kept = queue.filter((card) => !stale(card));
  if (kept.length) notifies.set(key, kept);
  else notifies.delete(key);
}

/**
 * One inbox row as the box paints it. A call for help received through the
 * help network carries where it is, what kind it is, when its window ends,
 * whether it is still running, whether its street is still being looked
 * up, how far away it is from this machine's own package and what the SMS
 * relay made of it — never a number to text back.
 */
function publicMessage(message, now, here) {
  const release = message.kind === 'release';
  const distance =
    release && here && message.lat !== null
      ? ultraDistanceKm(here, message)
      : null;
  return {
    id: message.id,
    tokenId: message.tokenId,
    kind: message.kind,
    networkId: message.networkId,
    label: message.label,
    from: message.from,
    number: message.number,
    text: message.text,
    place: message.place,
    incident: message.incident,
    needs: message.needs || null,
    lat: message.lat,
    lon: message.lon,
    at: message.at,
    until: message.until,
    active: release && message.until !== null && message.until > now,
    // The street is still being looked up: the text reads coordinates for
    // now, and the box waits a moment before it reads the call aloud.
    placing: release && placing.has(message.id),
    distanceKm: distance,
    sms: message.sms,
    deliveredAt: message.deliveredAt,
    readAt: message.readAt,
  };
}

// ---- the help network -----------------------------------------------------

/** Work a poll detached, tracked only so pollUltraNetworkOnce can wait for it. */
function detach(work) {
  const promise = Promise.resolve(work).catch(() => {});
  pendingWork.add(promise);
  void promise.finally(() => pendingWork.delete(promise));
  return promise;
}

async function settleNetworkWork() {
  while (pendingWork.size) await Promise.all([...pendingWork]);
}

/** Two origins that name the same machine, whatever the trailing slash or case. */
function sameBase(a, b) {
  const clean = (value) =>
    String(value || '')
      .trim()
      .replace(/\/+$/, '')
      .toLowerCase();
  return clean(a) === clean(b) && clean(a) !== '';
}

/**
 * The directory address and the GitHub write token, read from the
 * environment at call time (never at import), so a SAVE DIRECTORY applies
 * at once. Neither is ever painted, answered or logged.
 */
function directoryUrl() {
  return ultraDirectoryUrl(process.env.ULTRA_DIRECTORY_URL);
}

function directoryWriteToken() {
  return String(process.env.ULTRA_DIRECTORY_WRITE_TOKEN || '').trim();
}

/** What the box says about the key the home list is sealed under. */
function networkKeyState() {
  if (!loadNetwork().entries.length) return 'ok';
  const { state } = readTokenKey();
  if (state === 'invalid') return 'key-invalid';
  if (state === 'missing') return 'no-key';
  return 'ok';
}

/** Per-entry memory: when to poll it next, how it last answered, its episode. */
function entryMemory(id) {
  let memory = networkMemory.get(id);
  if (!memory) {
    memory = {
      nextAt: 0,
      failures: 0,
      inFlight: false,
      lastOkAt: null,
      lastPolledAt: null,
      lastState: '',
      episodeId: '',
      episodeUntil: null,
      lastEpisodeAt: null,
      geocode: null,
      // Reverse geocodes this entry has in the one-lane queue. While one is
      // waiting, a moving peer queues no more: the next poll after it lands
      // looks up wherever the peer is by then.
      geocoding: 0,
      // The window end the peer last sent with a call, as it sent it, and
      // the id of another link to the same machine this one is following
      // for that call (see followsCall).
      peerUntil: null,
      follows: '',
    };
    networkMemory.set(id, memory);
  }
  return memory;
}

/**
 * Decrypt the home-list entries that may be polled, each kept in memory as
 * { base, token }: the address and the opened token side by side, never
 * joined into a URL. A seal that will not open, a hash that does not match,
 * or a check that is missing or wrong while another entry still has one,
 * gets nothing: the opened token is not sent to a base somebody wrote into
 * the file.
 */
function openNetworkLinks() {
  links.clear();
  const { key, state } = readTokenKey();
  if (state !== 'ok' || !key) return;
  const entries = network.entries;
  for (const entry of entries) {
    if (!ultraNetworkPollAllowed(entry, entries, key)) continue;
    const token = openUltraNetworkToken(entry.sealed, key, { id: entry.id });
    const handout = token ? ultraHelpHandout(entry.base, token) : null;
    if (handout)
      links.set(entry.id, { base: handout.address, token: handout.token });
  }
}

/**
 * The home list, read once; memory is the truth from then on. An unreadable
 * file is said once and started empty — the links are recoverable from the
 * directory, and the next owner write replaces the file.
 */
function loadNetwork() {
  if (network) return network;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(networkStorePath(), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT' && !networkWarned) {
      networkWarned = true;
      console.warn(
        '[Ultra help] config/ultra-network.json could not be read; starting with an empty home list',
      );
    }
  }
  network = normalizeUltraNetworkStore(parsed);
  networkSaved = JSON.stringify(network);
  openNetworkLinks();
  const now = Date.now();
  network.entries.forEach((entry, index) => {
    // Staggered, so a restart does not fire the whole list at one instant.
    entryMemory(entry.id).nextAt = now + index * 250;
  });
  resumeEpisodes(now);
  return network;
}

/**
 * Rows of kind 'release' still inside their local window are the episodes
 * this machine was in the middle of when it stopped: they come back as they
 * were, so a restart neither duplicates a row nor speaks or texts again.
 * The peer's own window end comes back with them, so another link to the
 * same call that is answered first still sees it is that call (see
 * followsCall).
 */
function resumeEpisodes(now) {
  if (episodesResumed) return;
  episodesResumed = true;
  const known = new Set(network.entries.map((entry) => entry.id));
  // A rewritten call is not brought back. The home list is already loaded,
  // so a seal there counts when the inbox is judged.
  for (const row of visibleInboxMessages()) {
    if (row.kind !== 'release' || !known.has(row.networkId)) continue;
    const memory = entryMemory(row.networkId);
    if (memory.episodeId) continue;
    memory.episodeId = row.id;
    memory.episodeUntil = row.until;
    if (Number.isFinite(row.peerUntil)) memory.peerUntil = row.peerUntil;
    if (row.until !== null && row.until > now) memory.lastState = 'released';
    else memory.lastEpisodeAt = row.until ?? row.at;
  }
}

/**
 * The home list on disk. Only an owner action writes it, through the
 * credential store (owner-only permissions before the bytes land, atomic
 * rename); the poller never does, so no tick ever spawns the hardener. What
 * the poller learned is folded in on the way out. The write lands first (a
 * refused one changes nothing in memory), and then the list is committed in
 * place, never swapped for a new object: an owner action that read the home
 * list before an await (UPDATE HOME LIST waiting on the directory, PUBLISH
 * waiting on GitHub) still holds the live one when it resumes, so it cannot
 * write back a stale copy over what another action saved meanwhile.
 * The check on where each link points is stamped here and nowhere else:
 * not when the list is read, and not when it is polled. `blessIds` are
 * entries this action just added or resealed under a new key. A check that
 * does not match is left as it is unless that entry is one of them, and a
 * seal that will not open, or that opens onto a different token, is never
 * given a new check.
 */
function flushNetwork({ blessIds = [] } = {}) {
  const store = loadNetwork();
  const folded = store.entries.map((entry) => {
    const memory = networkMemory.get(entry.id);
    if (!memory) return entry;
    return {
      ...entry,
      lastPolledAt: memory.lastPolledAt ?? entry.lastPolledAt,
      // The poll word, never the tamper flag the row paints from. A stored
      // 'tampered' is a hand edit and is not written back from memory.
      lastState: ULTRA_NETWORK_STATES.includes(memory.lastState)
        ? memory.lastState
        : entry.lastState,
    };
  });
  const read = readTokenKey();
  const key = read.state === 'ok' ? read.key : null;
  let entries = folded;
  if (key) {
    const hasMac = ultraNetworkStoreHasPolicyMac(folded);
    const bless = new Set(blessIds);
    entries = folded.map((entry) => {
      const token = openUltraNetworkToken(entry.sealed, key, { id: entry.id });
      if (!token || !ultraTokenHashEqual(entry.hash, token)) return entry;
      const state = ultraNetworkPolicyState(entry, key);
      if (state === 'bad' && !bless.has(entry.id)) return entry;
      if (state === 'legacy' && !bless.has(entry.id) && hasMac) return entry;
      if (state === 'ok' || bless.has(entry.id) || !hasMac)
        return stampUltraNetworkPolicy(entry, key);
      return entry;
    });
  }
  const next = { ...store, entries };
  const text = JSON.stringify(next, null, 2);
  const file = networkStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  replaceCredentialStore(file, `${text}\n`, {
    harden: hardenImpl,
  });
  store.entries = entries;
  networkSaved = text;
  openNetworkLinks();
}

/**
 * The one URL a home-list entry is ever fetched at, or null when it may not
 * be polled at all. A link the directory no longer lists, or lists at
 * another host, is not polled any more, except while a call for help it
 * is carrying is still running: that call goes on being followed at the
 * base it was already trusted at (never the host the directory now names)
 * until it ends, so its STAND DOWN is heard and its row and pin do not
 * stay on NEEDS HELP for the rest of the four hours.
 */
function pollTarget(entry, now = Date.now()) {
  // Before the running-call exception: a rewritten base is not polled to
  // hear STAND DOWN either. The token would go to whatever host is in the file.
  const read = readTokenKey();
  if (
    read.state === 'ok' &&
    read.key &&
    !ultraNetworkPollAllowed(entry, network?.entries || [], read.key)
  )
    return null;
  if (entry.directoryMissing || entry.moved) {
    const until = Number(networkMemory.get(entry.id)?.episodeUntil);
    if (!(Number.isFinite(until) && until > now)) return null;
  }
  const handout = links.get(entry.id);
  return handout ? ultraNetworkPollTarget(handout) : null;
}

/**
 * The word the row shows: why it is not polled comes first, then how it last
 * answered. `tampered` is the live verdict for this status, not the word
 * stored on the entry. A stored 'tampered' is ignored once the check is clean.
 */
function entryState(entry, memory, tampered = false) {
  if (networkKeyState() !== 'ok') return 'no-key';
  if (tampered) return 'tampered';
  if (entry.directoryMissing) return 'missing';
  if (entry.moved) return 'moved';
  const handout = links.get(entry.id);
  if (!handout) return 'no-key';
  if (!ultraNetworkPollTarget(handout)) return 'not-tailnet';
  const stored = entry.lastState === 'tampered' ? '' : entry.lastState;
  return memory.lastState || stored || 'new';
}

/** Said once per change, with the entry's own id and nothing else about it. */
function sayState(entry, state) {
  const memory = entryMemory(entry.id);
  if (memory.lastState === state) return;
  memory.lastState = state;
  console.log(`[Ultra help] Network: ${entry.id} ${state.toUpperCase()}`);
}

/** A capped read of an answer body, or null when it runs past the cap (then it is junk). */
async function readCapped(response, limit) {
  const chunks = [];
  let total = 0;
  let over = false;
  try {
    for await (const chunk of response.body || []) {
      total += chunk.length;
      if (total > limit) {
        over = true;
        break;
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    return null;
  } finally {
    try {
      await response.body?.cancel();
    } catch {
      /* already closed */
    }
  }
  return over ? null : Buffer.concat(chunks).toString('utf8');
}

/**
 * The one request a home-list entry is ever used for: GET
 * <base>/ultra/help/network. The address is re-checked against the tailnet
 * rule here, right before the call, so a stored base that stopped passing
 * it can never be reached. The only credential in the request is the
 * Authorization bearer, and it is that peer's own Ultra Token, sent only to
 * the base it was handed out with (the token never rides the URL, so it is
 * in no log line, Referer or browser history on either side); no cookie, no
 * Referer, no redirect, five seconds.
 */
function tailnetFetch(handout) {
  const target = ultraNetworkPollTarget(handout);
  if (!target) return null;
  return fetchTool(target.url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${target.token}`,
      'User-Agent': ULTRA_USER_AGENT,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(ULTRA_NETWORK_TIMEOUT_MS),
  });
}

/** Said at most once a minute: the status or the word 'timeout', never the position. */
function warnGeocode(error, now) {
  if (now - geocodeWarnedAt < 60_000) return;
  geocodeWarnedAt = now;
  const name = String(error?.name || '');
  const reason =
    name === 'TimeoutError' || name === 'AbortError'
      ? 'timeout'
      : String(error?.message || 'error').slice(0, 20);
  console.warn(`[Ultra help] Reverse geocode failed: ${reason}`);
}

/**
 * The street address of a position, or the coordinates alone when the
 * lookup is refused or this machine is offline (then `failed` says so, so
 * the help network does not keep the coordinates as that spot's address).
 */
async function reverseGeocode(fix, fetchImpl) {
  try {
    const geo = await fetchJson(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${fix.lat.toFixed(5)}&lon=${fix.lon.toFixed(5)}&zoom=18&addressdetails=1`,
      ULTRA_GEOCODE_TIMEOUT_MS,
      fetchImpl,
    );
    return {
      place: streetAddress(geo?.address, geo?.display_name, fix),
      country: geo?.address?.country_code || '',
    };
  } catch (error) {
    warnGeocode(error, Date.now());
    return { place: streetAddress(null, '', fix), country: '', failed: true };
  }
}

/** One reverse geocode at a time, a second apart: Nominatim's rule, kept by this machine alone. */
function geocodeQueued(fix) {
  const generation = rootGeneration;
  const run = geocodeQueue.then(async () => {
    if (generation !== rootGeneration) return { place: '', country: '' };
    const wait = geocodeAt + ULTRA_GEOCODE_SPACING_MS - Date.now();
    if (wait > 0)
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, wait);
        timer.unref?.();
      });
    // Asked again after the wait: a lookup queued for another checkout must
    // not go out through this one's fetch, nor push its spacing back.
    if (generation !== rootGeneration) return { place: '', country: '' };
    geocodeAt = Date.now();
    return reverseGeocode(fix, fetchTool);
  });
  geocodeQueue = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * One text message, or the reason it did not go. The ledger is booked
 * before the request leaves (two presses in one moment must not both
 * send), and a send that fails gives its per-key stamp back, so a retry is
 * never held up by a cooldown for a text nobody received. The request
 * itself is fired and forgotten: nothing here ever holds up a poll tick,
 * the inbox or an owner click.
 */
function relaySms(kind, key, to, body, now = Date.now()) {
  // Before the "is one configured" check, and before the ledger: a relay
  // whose address was rewritten is not used, even when the new address
  // would still send. A relay with no check yet falls through to no-relay
  // when nothing is configured.
  if (relayStatus() === 'tampered')
    return { reason: 'relay-changed', outcome: Promise.resolve('') };
  const config = ultraSmsRelayConfig(process.env);
  if (!config.configured)
    return { reason: 'no-relay', outcome: Promise.resolve(ULTRA_SMS_NO_RELAY) };
  const number = normalizeUltraNumber(to);
  // A relay is set up but there is nobody to text: the row says to SAVE MY
  // #, not that there is no relay.
  if (!number)
    return {
      reason: 'no-number',
      outcome: Promise.resolve(ULTRA_SMS_NO_NUMBER),
    };
  const ledger = smsLedger;
  const allowed = ultraSmsRelayAllowed(ledger, {
    kind,
    key,
    host: config.host,
    now,
  });
  if (!allowed.ok)
    return { reason: allowed.reason, outcome: Promise.resolve('') };
  const outcome = sendRelay(config, number, body).then((word) => {
    const text = String(word);
    if (!text.startsWith('SMS SENT'))
      ultraSmsRelayForget(ledger, {
        key,
        at: now,
        // A timeout may have been delivered after all: it keeps its place
        // in the budgets. Every other failure gives its place back.
        spent: text === 'SMS FAILED: timeout',
      });
    return word;
  });
  return { reason: '', outcome };
}

async function sendRelay(config, number, body) {
  const request = ultraSmsRelayRequest(config, process.env, {
    to: number,
    body,
  });
  if (!request) return ULTRA_SMS_NO_RELAY;
  let outcome;
  let code = '';
  try {
    const response = await fetchTool(request.url, request.init);
    const text = await readCapped(response, ULTRA_NETWORK_ANSWER_LIMIT);
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    code = ultraSmsFailureCode(response.status, payload);
    outcome = ultraSmsOutcome(
      { status: response.status, json: payload },
      Date.now(),
    );
  } catch (error) {
    outcome = ultraSmsOutcome({ error }, Date.now());
  }
  const sent = outcome.startsWith('SMS SENT');
  // Counts and codes only: never the number, the name or the text.
  console.log(
    `[Ultra help] SMS relay: ${config.provider} ${sent ? 'sent' : `failed ${code || 'unreachable'}`}`,
  );
  lastRelayOutcome = outcome;
  return outcome;
}

/** How many live, non-orphaned NETWORK tokens of one package could receive a release. */
function holdersFor(feedId) {
  return readTokenStore().tokens.filter(
    (record) =>
      record.network === true &&
      record.revokedAt === null &&
      record.feedId === feedId &&
      securityFeed(record.feedId),
  ).length;
}

/** Of those, how many actually asked within the last minute. */
function watchingFor(feedId, now) {
  return ultraWatchingCount(readTokenStore().tokens, networkPolls, now, {
    feedId,
  });
}

/** The name a holder is answered with: what the owner chose for the network, else the package's. */
function networkName(feed) {
  return (
    cleanHelpText(loadNetwork().me.name, ULTRA_HELP_NAME_LIMIT) ||
    feed?.name ||
    'Ultra'
  );
}

/** A fresh record of what one call did for the owner's saved helpers. */
function newOwnCall() {
  return {
    plea: '',
    // The relayable cells of the last plea, and per number what happened.
    numbers: [],
    noRelay: false,
    sent: new Set(),
    pending: new Set(),
    failed: new Map(),
    limited: new Map(),
    lastSentAt: null,
  };
}

/** The SMS line and counts the box shows for one package's call. */
function ownSmsStatus(call, relay) {
  // A press always makes a record, so a call without one was reloaded from
  // the file after a full restart: what its texts did was memory only, and
  // SENDING would be a claim about texts nobody is sending. EXTEND HELP
  // makes a fresh record and the line recovers from there.
  if (!call)
    return {
      outcome: relay.configured ? ULTRA_SMS_UNKNOWN : ULTRA_SMS_NO_RELAY,
      sent: 0,
      failed: 0,
    };
  const outcome = call.noRelay ? ULTRA_SMS_NO_RELAY : ultraOwnSmsOutcome(call);
  return {
    // Nothing tried yet: the plea is still being composed behind the press.
    outcome:
      outcome || (relay.configured ? ULTRA_SMS_SENDING : ULTRA_SMS_NO_RELAY),
    sent: call.numbers.filter((n) => call.sent.has(n)).length,
    failed: call.numbers.filter((n) => !call.sent.has(n) && call.failed.has(n))
      .length,
  };
}

/**
 * Whether a package's last known fix may be published by a new SEND HELP:
 * 'none' with no fix, 'stale' when it is older than twenty minutes (a phone
 * that stopped reporting yesterday must not send helpers to where it was
 * then, stamped as now), else 'ok'. EXTEND
 * HELP on a running call is never refused: it keeps the call alive at the
 * newest position the call already has.
 */
function releaseFixState(fix, previous, now) {
  if (!fix) return 'none';
  if (previous) return 'ok';
  const at = Number(fix.at);
  return Number.isFinite(at) && now - at <= ULTRA_POSITION_MAX_AGE_MS
    ? 'ok'
    : 'stale';
}

/**
 * The position a running call already carries, as a fix: what EXTEND HELP
 * renews with when this process holds no fix for the package (after a
 * restart, before the phone reports again), so a running call is never
 * refused for want of one.
 */
function runningFix(previous) {
  return previous
    ? { lat: previous.lat, lon: previous.lon, at: previous.fixAt }
    : null;
}

/** The sentence a refused press answers with, naming how old the fix is. */
function staleFixMessage(fix, now, surface) {
  const minutes = Math.max(0, Math.round((now - Number(fix.at)) / 60_000));
  const age =
    minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
  return surface === 'phone'
    ? `No fresh position: the last one is ${age} old. Allow location for this page and wait for "Position sent", then press SEND HELP again.`
    : `The phone's last position is ${age} old, too old to send as where you are now: open the phone link on the phone (it sends a fresh one) or press SEND HELP there.`;
}

/**
 * One SEND HELP press for one package, from the box ('desktop') or from the
 * phone ('phone'); the two surfaces make the same release, which is why a
 * press on one shows on the other within a second. Each package has its
 * own release, so a press for one never touches another's call. It is
 * written at once (one deliberate press, so the credential store is the
 * right path), though a refused write never refuses the press: the call is
 * live in memory and saveReleases retries the file. The plea for the
 * owner's own saved helpers is composed behind it: this must not make the
 * person in trouble wait for a reverse geocode.
 */
function releaseAction({
  feed,
  fix,
  incident,
  needs = readStore().owner.needs,
  now,
  source = 'desktop',
}) {
  const previous = currentRelease(feed.id, now);
  const next = newUltraRelease({
    now,
    fix,
    feedId: feed.id,
    incident,
    needs,
    previous,
  });
  if (!next) return null;
  // EXTEND HELP renews the same call (same `at`) and keeps what its texts
  // already did; only a genuinely new press starts the record afresh.
  const renewed = Boolean(previous && next.at === previous.at);
  notePress(feed.id);
  releases.set(feed.id, next);
  if (!renewed || !ownCalls.has(feed.id)) ownCalls.set(feed.id, newOwnCall());
  saveReleases(now);
  // The phone has already noted its own fix by the time it gets here, so
  // both surfaces reach this with a position and nothing else differs.
  void source;
  detach(deliverOwnPlea(next, feed));
  return next;
}

/**
 * Which package a SEND HELP, EXTEND HELP or STAND DOWN from the box is for:
 * the one it names (`feedId`); else the only package saved; else, with
 * several saved, the one whose call is running when exactly one is — never
 * "whichever phone reported last". A STAND DOWN may still name a package
 * removed since its press, so that call can be ended; a press may not.
 */
function releaseFeedFor(body, now) {
  const packages = securityFeeds();
  const standDown = body?.standDown === true;
  const wanted =
    typeof body?.feedId === 'string' ? body.feedId.trim().slice(0, 200) : '';
  if (wanted) {
    const feed = packages.find((item) => item.id === wanted) || null;
    if (feed) return { feed, feedId: feed.id };
    if (standDown && releases.has(wanted))
      return { feed: null, feedId: wanted };
    return {
      status: 400,
      error: 'That Ultra Security Package is not saved any more',
    };
  }
  const live = currentReleases(now);
  // A STAND DOWN with no package named, when the one call running belongs
  // to a package the store does not show: that call is the one to end.
  if (
    standDown &&
    live.length === 1 &&
    !packages.some((feed) => feed.id === live[0].feedId)
  )
    return { feed: null, feedId: live[0].feedId };
  if (packages.length === 1)
    return { feed: packages[0], feedId: packages[0].id };
  if (!packages.length)
    return { status: 400, error: 'No Ultra Security Package is saved yet' };
  const running = live.filter((item) =>
    packages.some((feed) => feed.id === item.feedId),
  );
  if (running.length === 1) {
    const feed = packages.find((item) => item.id === running[0].feedId);
    return { feed, feedId: feed.id };
  }
  return {
    status: 400,
    error: standDown
      ? 'Choose which package to stand down'
      : 'Choose which package is asking for help',
  };
}

/** End one package's call: its release and what its texts did. */
function standDownRelease(feedId, now = Date.now()) {
  // The plea card still waiting for the phone goes first, whatever else
  // happens: nobody should be asked to text their helpers after standing down.
  const key = securityFeedKey(feedId);
  if (key) dropPleaCards(key, feedId);
  const had = releases.has(feedId) || ownCalls.has(feedId);
  notePress(feedId);
  releases.delete(feedId);
  ownCalls.delete(feedId);
  // Saved every time, even when memory no longer holds the call. A refused
  // write never refuses the STAND DOWN: the call has ended in memory (and a
  // copy of this module evaluated afresh keeps that memory), and the next
  // status poll, phone poll or poller tick writes the file once the disk
  // takes it, so a restart after that cannot bring the call back.
  saveReleases(now);
  return had;
}

/**
 * What the owner's own phone gets from a press: the plea, composed here
 * from this machine's reverse geocode and the incident class, as one card
 * that opens the SMS composer addressed to the PREDEFINED HELP # numbers,
 * and the same text relayed to those numbers when a relay is configured.
 * A press that a newer one (an EXTEND, a STAND DOWN, a new call) overtook
 * while the geocode ran leaves the delivery to that one.
 */
async function deliverOwnPlea(active, feed) {
  const generation = rootGeneration;
  const call = ownCalls.get(feed.id);
  const fix = { lat: active.lat, lon: active.lon, at: active.fixAt };
  const found = await geocodeQueued(fix);
  const overtaken = () =>
    generation !== rootGeneration ||
    ownCalls.get(feed.id) !== call ||
    currentRelease(feed.id)?.renewedAt !== active.renewedAt;
  if (!call || overtaken()) return;
  const place = found.place || ultraCoordinatesPlace(fix);
  const plea = ultraHelpMessage(place, active.incident, active.needs);
  call.plea = plea;
  const store = readStore();
  const numbers = store.contacts
    .map((item) => sendableNumber(item.number))
    .filter(Boolean);
  if (numbers.length) {
    // One plea card per call waits for the phone: an EXTEND replaces the one
    // not yet popped rather than stacking a second.
    dropPleaCards(feed.reportKey, feed.id);
    pushNotify(feed.reportKey, {
      kind: 'sms',
      id: ultraMessageId(),
      numbers,
      text: plea,
      at: Date.now(),
      // Which call the card belongs to, so STAND DOWN can take it back. It
      // stays on this machine: the phone is sent the card without it.
      call: `${feed.id}:${active.at}`,
    });
  }
  // 911 and 112 stay on the phone card: a relay may not text them.
  const cells = [...new Set(numbers.map(normalizeUltraNumber).filter(Boolean))];
  call.numbers = cells;
  call.noRelay = !cells.length;
  if (!cells.length) return;
  const text = ultraSmsRelayBody(networkName(feed), plea);
  for (const number of cells) {
    // Already on its way for this call: the answer to that send will say.
    if (call.pending.has(number)) continue;
    const attempt = relaySms('own', `${active.at}:${number}`, number, text);
    if (
      attempt.reason === 'no-relay' ||
      attempt.reason === 'no-number' ||
      attempt.reason === 'relay-changed'
    ) {
      call.noRelay = true;
      continue;
    }
    // A cooldown means this number was texted for this call within ten
    // minutes (that text stands), or its text failed under a minute ago (it
    // is tried again on a later press); either way the record already says
    // which.
    if (attempt.reason === 'cooldown') continue;
    // Held by a limit now: that is the reason the line gives, not an older
    // failure for the same number.
    if (attempt.reason) {
      call.limited.set(number, attempt.reason);
      call.failed.delete(number);
      continue;
    }
    call.pending.add(number);
    call.limited.delete(number);
    void attempt.outcome.then((outcome) => {
      call.pending.delete(number);
      if (!outcome) return;
      if (outcome.startsWith('SMS SENT')) {
        call.sent.add(number);
        call.failed.delete(number);
        call.lastSentAt = Date.now();
      } else {
        call.failed.set(number, outcome);
      }
    });
  }
}

/** Every episode this machine is holding, as a pin for the Your Devices layer. */
export function ultraNetworkPins(now = Date.now()) {
  const pins = [];
  for (const entry of loadNetwork().entries) {
    const memory = networkMemory.get(entry.id);
    const row = memory ? inboxRow(memory.episodeId) : null;
    if (!row || row.kind !== 'release') continue;
    const pin = ultraNetworkPin(entry, row, now);
    if (pin) pins.push(pin);
  }
  return pins;
}

/** A call for help that stopped: the row is marked ended, the pin goes, the id stays so a quick restart reuses the row. */
function endEpisode(entryId, now) {
  const memory = networkMemory.get(entryId);
  if (!memory?.episodeId) return;
  const row = inboxRow(memory.episodeId);
  if (row) {
    stampLegacyInbox(loadInbox());
    row.until = Math.min(row.until ?? now, now);
    touchInbox(row);
    scheduleInboxWrite();
  }
  memory.lastEpisodeAt = now;
  memory.episodeUntil = row ? row.until : now;
}

/**
 * The owner removed the row an episode lives in: there is nothing left to
 * reuse. Removing a row that is still running restarts the ten-minute gap
 * (the call is still answering, and the owner has just said they have seen
 * it); removing one that ended long ago must not, or a brand-new SEND HELP
 * from that person inside the next ten minutes would raise nothing at all —
 * so the gap keeps counting from when that episode really ended.
 */
function forgetEpisode(id, now) {
  for (const memory of networkMemory.values()) {
    if (id !== undefined && memory.episodeId !== id) continue;
    if (!memory.episodeId) continue;
    const until = Number(memory.episodeUntil);
    if (Number.isFinite(until) && until > now) memory.lastEpisodeAt = now;
    else {
      const ended = [memory.lastEpisodeAt, memory.episodeUntil]
        .filter((value) => value !== null && value !== undefined)
        .map(Number)
        .filter(Number.isFinite);
      memory.lastEpisodeAt = ended.length ? Math.max(...ended) : null;
    }
    memory.episodeId = '';
    memory.episodeUntil = null;
  }
}

/**
 * What a new or moved call for help becomes on this machine: the street
 * address from this machine's own geocode, the plea composed locally from
 * the incident class and that address (no peer string but the cleaned name
 * ever reaches it), the card on every one of the receiver's own phones and,
 * once per episode, one text to the receiver's own cell.
 */
async function deliverEpisode(entry, rowId, answer, { notify = true } = {}) {
  const generation = rootGeneration;
  const memory = entryMemory(entry.id);
  const fix = { lat: answer.release.lat, lon: answer.release.lon };
  let place = memory.geocode?.place || '';
  if (ultraNeedsGeocode(memory.geocode, fix, Date.now())) {
    memory.geocoding += 1;
    let found;
    try {
      found = await geocodeQueued(fix);
    } finally {
      memory.geocoding -= 1;
    }
    if (generation !== rootGeneration) return;
    place = found.failed ? '' : found.place;
    // Keep the address whatever happened while we waited: it is true of that
    // position, and throwing it away would geocode the same spot again. A
    // lookup that failed is no address: the row reads the coordinates, and
    // the spot is asked about again a minute later (not on every poll, so an
    // outage cannot fill the one-a-second lane everyone else shares).
    memory.geocode = found.failed
      ? { lat: fix.lat, lon: fix.lon, place: '', failedAt: Date.now() }
      : { lat: fix.lat, lon: fix.lon, place };
    // The wait is unbounded (one geocode a second, shared with every other
    // peer), so the world may have moved on: the peer may have stood down,
    // and the owner may have removed the link or the row. Neither may be
    // undone here. Another link to the same call that has taken the row
    // over (see takeOverCall) is still this call.
    if (![...networkMemory.values()].some((item) => item.episodeId === rowId))
      return;
  }
  const row = inboxRow(rowId);
  if (!row) return;
  // An episode already ended (stood down, or its link removed) stays ended.
  if (Number(row.until) <= Date.now()) return;
  // The row already holds this answer or a newer one: a poll that came in
  // while the lookup waited its turn has moved it on, and going back to this
  // older position, window or name would undo that with nothing to put it
  // right if the peer answers no more. So only the address and the plea are
  // written, and an address for a spot the row has since left by more than
  // 50 m is not where the peer is: the row reads its own coordinates, and
  // its next poll looks that spot up.
  const where = ultraNeedsGeocode(fix, row, Date.now())
    ? ultraCoordinatesPlace(row)
    : place || ultraCoordinatesPlace(fix);
  const updated = ultraReleaseRowUpdate(
    row,
    {},
    {
      place: where,
      plea: ultraHelpMessage(where, row.incident, row.needs),
    },
  );
  upsertInbox(updated);
  if (!notify) return;
  for (const feed of securityFeeds())
    pushNotify(feed.reportKey, ultraNotifyItem(updated));
  // While this machine's own call for help is on, its owner is the person in
  // trouble, not a helper: nothing texts their cell, whoever else is asking
  // (the card still shows, silently, on the phone page, and the row here).
  if (currentReleases().length) {
    const held = inboxRow(rowId);
    if (held) {
      stampLegacyInbox(loadInbox());
      held.sms = 'SMS HELD: YOUR CALL IS ON';
      touchInbox(held);
      scheduleInboxWrite();
    }
    return;
  }
  const attempt = relaySms(
    'peer',
    entry.id,
    readStore().owner.number,
    ultraSmsRelayBody(updated.from, updated.text),
  );
  // With no relay set up at all there is nothing to report: the row says
  // nothing about SMS rather than 'NO SMS RELAY' on every call for help. A
  // relay with no SAVE MY # says so ('NO SMS: SAVE MY # FIRST').
  if (attempt.reason === 'no-relay' || attempt.reason === 'relay-changed')
    return;
  void attempt.outcome.then((outcome) => {
    if (!outcome) return;
    const current = inboxRow(rowId);
    if (!current) return;
    stampLegacyInbox(loadInbox());
    current.sms = cleanHelpText(outcome, 40);
    touchInbox(current);
    scheduleInboxWrite();
  });
}

/**
 * Whether another link to the same machine already carries the call this
 * entry has just heard, so this one follows it quietly. The same machine
 * is not enough, since one machine can hold several packages, each its own
 * person: it has to be the same call, and the peer's own window end, to the
 * millisecond, is what says so. A link carries a call while its row is
 * running, and for the ten-minute gap after that row ended or was removed
 * (in which that link raises nothing new either). Once this entry follows
 * one it goes on following it while that row runs, even after an EXTEND
 * has moved the window end. If that link stops carrying the call (REMOVE,
 * say) while this one still hears it, this one raises it: the owner still
 * subscribes through it.
 *
 * The answer is 'follow' (stay quiet); 'take' when the link carrying the
 * row has stopped hearing the call (its last poll was dead, busy or
 * unreachable, or it has not answered for a minute) while this one still
 * does, so the row moves here (see takeOverCall); 'hold' when a link to the
 * same machine was carrying a call when this machine started and has not
 * been asked since, so whether it is this call is not known yet (a restart
 * polls the home list in order, and an EXTEND while this machine was off
 * moves the window end it kept); or '' to raise it.
 */
function followsCall(entry, memory, now) {
  const entries = loadNetwork().entries;
  const running = (theirs) =>
    Boolean(theirs?.episodeId) && Number(theirs.episodeUntil) > now;
  // A row resumed after a restart counts as heard until its link has been
  // asked once (if it can be asked at all); after that, only a recent answer
  // with the call counts.
  const unasked = (other, theirs) =>
    theirs.lastPolledAt === null && Boolean(pollTarget(other, now));
  const hearing = (other, theirs) =>
    unasked(other, theirs) ||
    (theirs.lastState === 'released' &&
      theirs.lastOkAt !== null &&
      now - theirs.lastOkAt <= ULTRA_NETWORK_HEARD_MS);
  const carrying = (other, theirs) =>
    hearing(other, theirs) ? 'follow' : 'take';
  const leader = entries.find((item) => item.id === memory.follows);
  const followed = leader ? networkMemory.get(leader.id) : null;
  if (running(followed)) return carrying(leader, followed);
  memory.follows = '';
  if (!Number.isFinite(memory.peerUntil)) return '';
  let unknown = false;
  for (const other of entries) {
    if (other.id === entry.id || !sameBase(other.base, entry.base)) continue;
    const theirs = networkMemory.get(other.id);
    if (!theirs) continue;
    if (theirs.peerUntil !== memory.peerUntil) {
      if (running(theirs) && unasked(other, theirs)) unknown = true;
      continue;
    }
    const endedAt = Number(theirs.lastEpisodeAt);
    const recent =
      theirs.lastEpisodeAt !== null &&
      Number.isFinite(endedAt) &&
      now - endedAt < ULTRA_NETWORK_EPISODE_GAP_MS;
    if (running(theirs)) {
      memory.follows = other.id;
      return carrying(other, theirs);
    }
    if (recent) {
      memory.follows = other.id;
      return 'follow';
    }
  }
  return unknown ? 'hold' : '';
}

/**
 * The link this entry follows carries the call's row but no longer hears
 * the call (its token revoked or switched off, or its answers failing),
 * while this one still does: the row moves here with its window and its
 * last address, so this link's answers go on moving it and a STAND DOWN it
 * hears still ends it. It stays one row, with no new card, word or text,
 * and the other link follows this one from now on.
 */
function takeOverCall(entry, memory) {
  const leader = networkMemory.get(memory.follows);
  memory.follows = '';
  if (!leader?.episodeId) return;
  memory.episodeId = leader.episodeId;
  memory.episodeUntil = leader.episodeUntil;
  memory.geocode = leader.geocode;
  leader.episodeId = '';
  leader.episodeUntil = null;
  leader.follows = entry.id;
  const row = inboxRow(memory.episodeId);
  if (row) {
    stampLegacyInbox(loadInbox());
    row.networkId = entry.id;
    touchInbox(row);
    scheduleInboxWrite();
  }
}

/** One entry, one poll: the answer judged, the state moved, the episode opened, updated or closed. */
async function pollEntry(entry, now) {
  const memory = entryMemory(entry.id);
  const handout = links.get(entry.id);
  memory.inFlight = true;
  let status = 0;
  let answer = null;
  // The peer's own window end, exactly as it sent it: the one thing two
  // links to the same call agree on to the millisecond (see followsCall).
  let peerUntil = null;
  try {
    const response = await tailnetFetch(handout);
    if (!response) {
      memory.inFlight = false;
      return;
    }
    status = response.status;
    if (status === 200) {
      const text = await readCapped(response, ULTRA_NETWORK_ANSWER_LIMIT);
      let parsed = null;
      try {
        parsed = text === null ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      // The peer's clock when it answered, from the Date header its server
      // adds to every answer: what is left of the call is measured on that
      // clock, not from when the call last changed (which, once the phone
      // stops reporting, is the press and would stretch the row here past
      // the call's real end if the peer then went unreachable).
      const peerNow = Date.parse(response.headers?.get?.('date') || '');
      answer = normalizeUltraNetworkAnswer(parsed, {
        now,
        entryName: entry.name,
        peerNow: Number.isFinite(peerNow) ? peerNow : null,
      });
      if (answer?.state === 'released') peerUntil = parsed.until;
    } else {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
    }
  } catch {
    // A refused connection, a refused redirect or a timeout: all unreachable.
    status = 0;
  } finally {
    memory.inFlight = false;
  }
  // REMOVE may have landed while this was in flight. The owner was told their
  // calls for help stop reaching them, so this answer is dropped rather than
  // raising a row against a link that is gone.
  if (networkMemory.get(entry.id) !== memory) return;
  const outcome = ultraPollOutcome({
    status,
    answer,
    failures: memory.failures,
    now,
  });
  memory.nextAt = outcome.nextAt;
  memory.failures = outcome.failures;
  memory.lastPolledAt = now;
  if (status === 200) memory.lastOkAt = now;
  if (!answer) {
    sayState(entry, outcome.state);
    return;
  }
  let decision = ultraEpisodeDecision({ entry: memory, answer, now });
  if (answer.state === 'released') memory.peerUntil = peerUntil;
  // One person, two links (one handed over by hand and the directory's, say):
  // another link to the same machine already carries this very call, so this
  // one follows it quietly instead of raising a second row, card and text.
  // If that link has stopped hearing the call, this one takes its row over,
  // and a STAND DOWN heard here then ends it.
  if (decision === 'new' || (answer.state === 'quiet' && memory.follows)) {
    const plan = followsCall(entry, memory, now);
    if (plan === 'take') {
      takeOverCall(entry, memory);
      decision = ultraEpisodeDecision({ entry: memory, answer, now });
    } else if (plan && decision === 'new') {
      // Not known yet whether a link resumed after a restart carries this
      // call: asked again on the next tick, by when that link has answered.
      if (plan === 'hold')
        memory.nextAt = Math.min(memory.nextAt, now + ULTRA_NETWORK_TICK_MS);
      sayState(entry, outcome.state);
      return;
    }
  }
  if (answer.state !== 'released') memory.follows = '';
  if (decision === 'new') {
    const place = ultraCoordinatesPlace(answer.release);
    const row = ultraReleaseInboxRecord({
      entry,
      answer,
      now,
      place,
      plea: ultraHelpMessage(
        place,
        answer.release.incident,
        answer.release.needs,
      ),
    });
    if (row) {
      // Kept with the row, so a restart still knows which call it is.
      row.peerUntil = peerUntil;
      appendInbox(row);
      memory.episodeId = row.id;
      memory.episodeUntil = row.until;
      console.log(`[Ultra help] Network: ${entry.id} needs help`);
      // Placing until deliverEpisode is done: it has written the address by
      // then (it awaits nothing after that), or given up on the row.
      placing.add(row.id);
      detach(
        deliverEpisode(entry, row.id, answer).finally(() =>
          placing.delete(row.id),
        ),
      );
    }
  } else if (decision === 'update') {
    const row = inboxRow(memory.episodeId);
    if (!row) {
      memory.episodeId = '';
    } else {
      const moved = ultraNeedsGeocode(memory.geocode, answer.release, now);
      const updated = {
        ...ultraReleaseRowUpdate(row, answer, { now }),
        peerUntil,
      };
      upsertInbox(updated);
      memory.episodeUntil = updated.until;
      // A new address is worth one lookup, and so is a spot whose lookup
      // failed a minute ago or more; nothing else is re-sent. Only one
      // per entry waits in the queue at a time, so a peer moving on every
      // poll cannot fill the lane ahead of everyone else's (and the owner's
      // own plea); the address lags at most one poll behind instead.
      if (moved && !memory.geocoding)
        detach(deliverEpisode(entry, updated.id, answer, { notify: false }));
    }
  } else if (decision === 'end') {
    endEpisode(entry.id, now);
  }
  sayState(entry, outcome.state);
}

/** One round: every entry that is due, oldest first, 4 to 16 at a time (see below). */
async function tick(now = Date.now()) {
  // A SEND HELP or STAND DOWN the disk refused is written from here too, so
  // it lands with no GEV tab open, whether or not there is a home list.
  retryUnsavedReleases(now);
  const home = loadNetwork();
  if (!home.entries.length || networkKeyState() !== 'ok') return;
  const due = home.entries.filter((entry) => {
    const memory = entryMemory(entry.id);
    return !memory.inFlight && memory.nextAt <= now && pollTarget(entry, now);
  });
  due.sort((a, b) => entryMemory(a.id).nextAt - entryMemory(b.id).nextAt);
  // Take as many as it costs to work the whole due list inside one poll
  // period, not a fixed four: at a flat four a tick, a long home list is
  // walked so slowly that a call for help waits minutes. The ceiling keeps
  // the number of requests in flight sane on a long list, and the oldest-due
  // sort means nobody is starved when there are more than that.
  const ticksPerPeriod = Math.max(
    1,
    Math.round(ULTRA_NETWORK_POLL_MS / ULTRA_NETWORK_TICK_MS),
  );
  const batch = Math.min(
    ULTRA_NETWORK_MAX_IN_FLIGHT,
    Math.max(ULTRA_NETWORK_CONCURRENCY, Math.ceil(due.length / ticksPerPeriod)),
  );
  await Promise.all(due.slice(0, batch).map((entry) => pollEntry(entry, now)));
}

/**
 * One poll round and everything it detached (the reverse geocode, the row,
 * the cards). Exported so a test drives the poller without a timer; the
 * real poller runs the round and waits for none of it. An SMS relay is
 * never waited for here either.
 */
export async function pollUltraNetworkOnce(now = Date.now()) {
  await tick(now);
  await settleNetworkWork();
}

/**
 * Start polling, and say which server owns the timer. Vite restarts itself in
 * process by creating the new server BEFORE closing the old one, so the old
 * server's `close` arrives after the new one has already started polling:
 * without an owner the departing server would switch the new poller off and
 * nobody would hear a call for help again until the process was restarted.
 * (When the restart evaluates this module afresh, each copy has its own
 * timer and its own owner, and the old copy's close stops only its own.)
 */
function startNetworkPoller() {
  stopNetworkPoller();
  networkTimer = setInterval(() => {
    void tick(Date.now()).catch(() => {});
  }, ULTRA_NETWORK_TICK_MS);
  networkTimer.unref?.();
  return ++pollerOwner;
}

/** Stop polling, but only on behalf of the server that still owns the timer. */
function stopNetworkPoller(owner = null) {
  if (owner !== null && owner !== pollerOwner) return;
  if (networkTimer) clearInterval(networkTimer);
  networkTimer = null;
}

/**
 * A page any phone browser can open: the phone link. It sends the phone's
 * position from the browser's own location service (no tracking app needed),
 * captures the chosen camera and posts stills back, keeps the screen awake
 * so it goes on doing both while it is open, and shows, vibrates for and
 * reads aloud the help messages the poll brings.
 */
function cameraPage() {
  return `<!doctype html>
<html lang="en">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ultra phone link</title>
<style>
  body { font: 14px sans-serif; background: #111; color: #eee; margin: 12px; }
  video, img { width: 100%; max-height: 50vh; background: #000; }
  button { margin: 8px 8px 0 0; padding: 8px 12px; }
  #gps { color: #7fe7ff; }
  #inbox { background: #1b2530; padding: 8px 10px; margin: 0 0 10px; }
  #inbox h2 { font-size: 15px; margin: 0 0 4px; }
  #notices { list-style: none; padding: 0; margin: 0; }
  #notices li { border-top: 1px solid #334; padding: 6px 0; }
  #notices a { color: #7fe7ff; margin-right: 12px; }
  #sendHelp { background: #b3261e; color: #fff; border: 0; font-weight: 700; padding: 12px 16px; font-size: 18px; }
  #standDown { background: #7fe7ff; color: #000; }
  #helpState { color: #ffb066; }
  #helpKind { font: inherit; padding: 8px; }
</style>
<p id="gps">Asking for this phone's location…</p>
<p id="helpRow"><select id="helpKind" aria-label="What is happening"><option value="threat">THREAT</option><option value="fire">FIRE</option><option value="medical">MEDICAL</option><option value="other" selected>OTHER</option></select> <button id="sendHelp" type="button">SEND HELP</button><button id="standDown" type="button">STAND DOWN</button></p>
<p id="helpState">SEND HELP tells everyone holding one of your Network tokens where this phone is, for four hours, until STAND DOWN, and gives you one tap that texts your saved helpers. Police and fire are asked from the map's FIND HELP.</p>
<p id="soundRow"><button id="sound" type="button">Sound on</button> so help messages are spoken as they arrive (a tap anywhere but the SEND HELP row does the same). While your own call for help is on, this page stays silent, and for a THREAT it does not vibrate either.</p>
<section id="inbox" hidden>
  <h2>Help messages</h2>
  <ul id="notices"></ul>
</section>
<video id="view" autoplay playsinline muted></video>
<p id="status">Starting the rear camera… nothing to press here; the map switches cameras from the Ultra box.</p>
<p><input id="file" type="file" accept="image/*" capture="environment"> Use this if the live camera is blocked.</p>
<p>Keep this page open: it sends the position every few seconds while it is on screen.</p>
<script>
const status = document.getElementById('status');
const view = document.getElementById('view');
const gps = document.getElementById('gps');
// Parsed as the map parses it (empty parts dropped), so /cam/ or a doubled
// slash still polls, sends help and posts pictures under /ultra/<key>.
const parts = location.pathname.split('/').filter(Boolean);
const key = parts[1] || '';
const root = '/ultra/' + key;
let role = 'rear';
let sending = false;
// ---- position: the browser's location service, posted as a report --------
let lastFixAt = 0;
let lastFix = null;
function postFix(position) {
  const c = position.coords;
  // gotAt is when this page received the fix, on this page's own clock: the
  // age a press sends never mixes the location service's clock with it.
  lastFix = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, gotAt: Date.now() };
  const params = new URLSearchParams({ id: key, lat: c.latitude, lon: c.longitude, timestamp: Math.floor(position.timestamp / 1000) });
  if (c.accuracy != null) params.set('accuracy', c.accuracy);
  if (c.altitude != null) params.set('altitude', c.altitude);
  if (c.heading != null && !Number.isNaN(c.heading)) params.set('bearing', c.heading);
  if (c.speed != null && !Number.isNaN(c.speed)) params.set('speedMps', c.speed);
  fetch('/?' + params, { method: 'POST' }).then((response) => {
    lastFixAt = Date.now();
    gps.textContent = response.ok
      ? 'Position sent ' + new Date().toLocaleTimeString() + ' (±' + Math.round(c.accuracy || 0) + ' m)'
      : 'Position refused (' + response.status + '): open this link from the card again.';
  }).catch(() => { gps.textContent = 'Position not sent: no connection to the map (is Tailscale on?)'; });
}
function fixFailed(error) {
  gps.textContent = 'Location blocked: ' + (error && error.message ? error.message : 'unavailable') + '. Allow location for this site.';
}
if (navigator.geolocation) {
  navigator.geolocation.watchPosition(postFix, fixFailed, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  // A phone that stops moving stops calling back; ask again every 20 s so the map knows it is still there.
  setInterval(() => { if (Date.now() - lastFixAt > 20000) navigator.geolocation.getCurrentPosition(postFix, fixFailed, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }); }, 20000);
} else {
  gps.textContent = 'This browser has no location service.';
}
if (navigator.wakeLock && navigator.wakeLock.request) {
  const keepAwake = () => navigator.wakeLock.request('screen').catch(() => {});
  keepAwake();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
}
// ---- help messages: popped with the poll, spoken once sound is allowed ----
const inbox = document.getElementById('inbox');
const notices = document.getElementById('notices');
const sound = document.getElementById('sound');
const NUMBER = /^\\+[1-9]\\d{7,14}$/;
const SENDABLE = /^(\\+[1-9]\\d{7,14}|911|112)$/;
let soundOn = false;
let unspoken = [];
let unseen = 0;
let flashTimer = null;
let statusBefore = null;
// This phone's own call for help: on while the map's last answer carried
// it, or while a committed press is on its way — never by comparing this
// phone's clock with the map's.
let ownCall = false;
let pressing = false;
let pressIncident = '';
let releaseUntil = 0;
let releaseIncident = '';
// While this phone is asking for help it never talks: a voice could give
// away someone hiding. For a THREAT it does not vibrate either.
function ownCallOn() {
  return ownCall || pressing;
}
function callIncident() {
  return pressing ? pressIncident : releaseIncident;
}
function buzz(pattern) {
  if (ownCallOn() && callIncident() === 'threat') return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* No vibration here. */ }
}
// The moment this phone's own call starts: stop whatever is being said (and,
// for a THREAT, buzzed) and drop what was waiting to be said.
function hush() {
  unspoken = [];
  try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch { /* Nothing to stop. */ }
  if (callIncident() === 'threat') {
    try { if (navigator.vibrate) navigator.vibrate(0); } catch { /* No vibration here. */ }
  }
}
// The map says this phone's call is on (a press answered, or a poll).
function callOn(info) {
  const was = ownCallOn();
  ownCall = true;
  releaseUntil = Number(info.until) || 0;
  releaseIncident = info.incident || '';
  if (!was) hush();
}
function callOff() {
  // The call has just ended: its SMS cards stay on screen but lose their
  // mark, so a stood-down plea ages out like any other card rather than
  // offering to text the helpers for as long as the page is open. Only on
  // the change: a Find Ultra Help text sent with no call on keeps its mark.
  if (ownCall) {
    Array.from(notices.children).forEach((li) => { if (li.className === 'sms') li.className = ''; });
  }
  ownCall = false;
  releaseUntil = 0;
  releaseIncident = '';
}
function sayText(words) {
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
  try {
    speechSynthesis.speak(new SpeechSynthesisUtterance(words));
  } catch { /* A voice that refuses must not hide the card. */ }
}
function speak(item) {
  if (item.kind === 'release') { sayText((item.from || 'someone') + ' needs help. ' + item.text); return; }
  if (item.kind === 'sms') { sayText('Text your helpers: tap send'); return; }
  sayText('Help message from ' + (item.from || 'someone') + ' via ' + item.label + ': ' + item.text);
}
function speakQueued() {
  const waiting = unspoken.splice(0);
  if (!ownCallOn()) waiting.forEach(speak);
}
// Until sound is armed the last ten wait; the cards above cap there too.
// Nothing is spoken, or kept to speak later, while this phone's own call
// for help is on: the card is enough.
function queueSpeech(item) {
  if (ownCallOn()) return;
  if (soundOn) speak(item); else { unspoken.push(item); if (unspoken.length > 10) unspoken.shift(); }
}
let flashText = '';
function flash(text) {
  if (statusBefore === null) statusBefore = status.textContent;
  flashText = text;
  status.textContent = text;
  clearTimeout(flashTimer);
  // Restore only if nothing else (a camera start) has written the line since.
  flashTimer = setTimeout(() => { if (status.textContent === flashText) { status.textContent = statusBefore; statusBefore = null; } }, 10000);
}
function card(li) {
  li.addEventListener('click', seen);
  notices.prepend(li);
  // Past ten the oldest card goes, but never the one just shown (it is on
  // top) and never the newest marked SMS card (the plea for your helpers or
  // Find Ultra Help's text), so a burst of messages cannot push the one-tap
  // text off the screen. Only the newest is kept: this list is not drained
  // like the map's queue, so the earlier pleas of an EXTENDed call age out
  // like any other card instead of taking the messages' places.
  while (notices.children.length > 10) {
    const all = Array.from(notices.children);
    const newestSms = all.find((li) => li.className === 'sms');
    const oldest = all[all.length - 1];
    (oldest === newestSms ? all[all.length - 2] : oldest).remove();
  }
  inbox.hidden = false;
  unseen += 1;
  document.title = '(' + unseen + ') Ultra phone link';
}
// Chrome on Android speaks only after a tap. The button asks for one before
// any message exists; any other tap on the page is the same gesture, so it
// arms sound too and speaks whatever arrived before it — except a tap on
// the SEND HELP row: the press that asks for help must not make this phone
// talk.
const soundRow = document.getElementById('soundRow');
function tapped(event) {
  const target = event && event.target;
  if (target && target.closest && target.closest('#helpRow')) return;
  soundOn = true;
  soundRow.hidden = true;
  speakQueued();
}
sound.addEventListener('click', () => {
  if (window.speechSynthesis) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  tapped();
});
document.addEventListener('touchend', tapped);
document.addEventListener('click', tapped);
function seen() {
  unseen = 0;
  document.title = 'Ultra phone link';
}
// One tap sends the plea to the numbers saved under PREDEFINED HELP #: a
// browser cannot text on its own, so the composer opens with all of them.
function showSms(item) {
  const numbers = (item.numbers || []).filter((n) => SENDABLE.test(n));
  if (!numbers.length) return;
  const li = document.createElement('li');
  const head = document.createElement('div');
  const count = item.numbers.length;
  head.textContent = 'SEND SMS TO ' + count + ' HELPER' + (count === 1 ? '' : 'S');
  const body = document.createElement('div');
  body.textContent = item.text;
  const link = document.createElement('a');
  link.href = 'sms:' + numbers.join(',') + '?body=' + encodeURIComponent(item.text);
  link.textContent = 'Send';
  li.append(head, body, link);
  // Marked so the ten-card trim keeps the newest one (see card()) until
  // the call ends (see callOff()).
  li.className = 'sms';
  card(li);
  flash('SEND SMS TO ' + count + ' HELPERS');
  buzz([300, 120, 300]);
  queueSpeech({ kind: 'sms', text: item.text });
}
function show(item) {
  if (item && item.kind === 'sms') { showSms(item); return; }
  const release = item && item.kind === 'release';
  // The card first: a vibrate or voice call that throws must not hide it.
  const li = document.createElement('li');
  const head = document.createElement('div');
  // The reply number is shown, not only linked: the owner sees whom Text back reaches.
  // A call for help never has one: the person in trouble is never texted.
  const reply = !release && NUMBER.test(item.number || '') ? item.number : '';
  const when = new Date(item.at || Date.now()).toLocaleTimeString();
  head.textContent = release
    ? when + ' · ' + (item.from || 'someone') + ' NEEDS HELP'
    : when + ' · ' + (item.from || 'someone') + (reply ? ' (' + reply + ')' : '') + ' via ' + item.label;
  const body = document.createElement('div');
  body.textContent = item.text;
  li.append(head, body);
  if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) {
    const place = document.createElement('div');
    place.textContent = (release && item.place ? item.place : 'at ' + item.lat.toFixed(4) + ', ' + item.lon.toFixed(4)) + ' ';
    const map = document.createElement('a');
    map.href = 'geo:' + item.lat + ',' + item.lon;
    map.textContent = 'Map';
    place.append(map);
    li.append(place);
  }
  // Every message opens in the SMS app: a reply to the sender's own number
  // when they gave one, otherwise a recipient-free forward the owner addresses.
  const smsLink = document.createElement('a');
  if (reply) {
    smsLink.href = 'sms:' + reply + '?body=' + encodeURIComponent('Re your help message: ');
    smsLink.textContent = 'Text back';
    smsLink.title = 'Text ' + reply;
  } else {
    smsLink.href = 'sms:?body=' + encodeURIComponent(release ? item.text : 'Help via ' + item.label + ': ' + item.text);
    smsLink.textContent = 'Open in SMS';
  }
  li.append(smsLink);
  card(li);
  flash(release ? 'NEEDS HELP · ' + (item.from || 'someone') : 'HELP MESSAGE from ' + (item.from || item.label));
  buzz(release ? [500, 150, 500, 150, 900] : [300, 120, 300, 120, 600]);
  queueSpeech(item);
}
// ---- send help: two taps, then this phone's position goes to the network --
const helpKind = document.getElementById('helpKind');
const sendHelp = document.getElementById('sendHelp');
const standDown = document.getElementById('standDown');
const helpState = document.getElementById('helpState');
let armedAt = 0;
let armTimer = null;
let helpPending = false;
let finding = false;
let standDownWanted = false;
let hadRelease = false;
// The select shows the running call's incident, so EXTEND HELP renews the
// call as it is; only a deliberate change on this page sends another one.
let kindTouched = false;
helpKind.addEventListener('change', () => { kindTouched = true; });
// Each poll is numbered; one sent before the last press was answered is
// older than that answer, so its view of this phone's call is not painted.
let pollSeq = 0;
let pressSeq = 0;
function armed() {
  return Date.now() - armedAt < 5000;
}
function disarm() {
  armedAt = 0;
  clearTimeout(armTimer);
  sendHelp.textContent = ownCall ? 'EXTEND HELP' : 'SEND HELP';
}
// AbortSignal.timeout is from 2022 (Safari 16, Chrome 103): an older phone
// gets the same bound from a controller, so its press still reaches the map
// instead of failing before it is sent.
function within(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  if (typeof AbortController !== 'function') return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
async function postHelp(payload) {
  helpPending = true;
  sendHelp.disabled = true;
  helpState.textContent = 'Sending…';
  try {
    // A bounded wait: on a stalled connection an open fetch would leave both
    // SEND HELP and STAND DOWN disabled for good, on the one page a person in
    // trouble is holding.
    const response = await fetch(root + '/help', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: within(15000) });
    pressSeq = pollSeq;
    if (response.ok) {
      const body = await response.json();
      if (body.release) {
        callOn(body.release);
        pressing = false;
        hadRelease = true;
        kindTouched = false;
        if (body.release.incident) helpKind.value = body.release.incident;
        helpState.textContent = 'HELP SENT ' + new Date().toLocaleTimeString() + ' · ' + body.release.watching + ' watching · until ' + new Date(body.release.until).toLocaleTimeString() + ' · STAND DOWN when you are safe';
        buzz([200, 80, 200]);
      } else {
        pressing = false;
        callOff();
        hadRelease = false;
        helpState.textContent = 'Stood down ' + new Date().toLocaleTimeString() + '. Nothing is sent to your network now.';
      }
    } else if (response.status === 409) {
      helpState.textContent = await response.text();
    } else if (response.status === 429) {
      helpState.textContent = 'Wait a moment, then try again';
    } else {
      helpState.textContent = 'Not sent (' + response.status + ')';
    }
  } catch (error) {
    // TimeoutError from AbortSignal.timeout, AbortError from the controller.
    helpState.textContent = error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      ? 'No answer in 15 seconds — press again to retry (is Tailscale on?)'
      : 'Not sent: no connection to the map (is Tailscale on?)';
  }
  pressing = false;
  helpPending = false;
  sendHelp.disabled = false;
  armedAt = 0;
  disarm();
}
// The position a press sends: the last fix when this page got it under a
// minute ago, else one asked for now (eight seconds at most, and the page
// stops waiting at nine whatever the location service does). Its age goes
// with it, on this page's own clock, so the map can refuse one too old to
// be where the phone is and never mistakes an old fix for a new one.
function freshFix() {
  return new Promise((resolve) => {
    if ((lastFix && Date.now() - lastFix.gotAt < 60000) || !navigator.geolocation) { resolve(lastFix); return; }
    helpState.textContent = 'Finding this phone first…';
    const deadline = setTimeout(() => resolve(lastFix), 9000);
    navigator.geolocation.getCurrentPosition(
      (position) => { clearTimeout(deadline); postFix(position); resolve(lastFix); },
      () => { clearTimeout(deadline); resolve(lastFix); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 });
  });
}
// A pocket tap must never publish a position: the first tap only arms.
sendHelp.addEventListener('click', async () => {
  if (helpPending) return;
  if (!armed()) {
    armedAt = Date.now();
    sendHelp.textContent = 'TAP AGAIN TO SEND HELP';
    clearTimeout(armTimer);
    armTimer = setTimeout(disarm, 5000);
    return;
  }
  // Committed: from here the page is asking for help, so it goes quiet now,
  // not when the map answers.
  helpPending = true;
  pressing = true;
  pressIncident = helpKind.value;
  hush();
  clearTimeout(armTimer);
  finding = true;
  sendHelp.disabled = true;
  sendHelp.textContent = 'FINDING THIS PHONE…';
  const fix = await freshFix();
  finding = false;
  // STAND DOWN tapped while the phone was being found wins: the press is
  // dropped and the stand-down goes instead.
  if (standDownWanted) {
    standDownWanted = false;
    pressing = false;
    void postHelp({ standDown: true });
    return;
  }
  void postHelp({ lat: fix ? fix.lat : null, lon: fix ? fix.lon : null, accuracy: fix ? fix.accuracy : null, age: fix ? Math.max(0, Date.now() - fix.gotAt) : null, incident: helpKind.value });
});
// Standing down is the safe direction, so it is one tap, and the button is
// always there: with no call on, a tap ends nothing and says so.
standDown.addEventListener('click', () => {
  if (finding) {
    standDownWanted = true;
    helpState.textContent = 'Standing down…';
    return;
  }
  if (!helpPending) void postHelp({ standDown: true });
});
function paintRelease(info) {
  if (info) {
    callOn(info);
    hadRelease = true;
    if (helpPending || armed()) return;
    if (!kindTouched && info.incident) helpKind.value = info.incident;
    const left = Math.max(0, Math.round((info.until - Date.now()) / 60000));
    helpState.textContent = 'HELP SENT · ' + left + ' min left · ' + info.watching + ' watching · STAND DOWN when you are safe';
    sendHelp.textContent = 'EXTEND HELP';
    return;
  }
  callOff();
  if (!hadRelease) return;
  hadRelease = false;
  if (helpPending || armed()) return;
  helpState.textContent = 'Help window ended ' + new Date().toLocaleTimeString() + '. Press SEND HELP to start again.';
  sendHelp.textContent = 'SEND HELP';
}
const hints = {
  front: /front|user|face|selfie/i,
  rear: /back|rear|environment/i,
  'rear-ultrawide': /wide/i,
  'rear-tele': /tele/i,
  inner: /inner|fold|cover/i
};
function facing(next) {
  return next === 'rear' || String(next).startsWith('rear') ? 'environment' : 'user';
}
async function start(next) {
  role = next || role;
  if (view.srcObject) view.srcObject.getTracks().forEach((track) => track.stop());
  if (!navigator.mediaDevices || !window.isSecureContext) {
    status.textContent = 'This browser blocks a live camera on a plain http address. Use the file button, or an app that serves /shot.jpg on port 8080.';
    return;
  }
  try {
    let stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing(role) }, audio: false });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hint = hints[role] || hints.rear;
    const named = devices.find((device) => device.kind === 'videoinput' && hint.test(device.label || ''));
    if (named) {
      stream.getTracks().forEach((track) => track.stop());
      stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: named.deviceId } }, audio: false });
    }
    view.srcObject = stream;
    status.textContent = 'Live video · ' + role;
  } catch (error) {
    status.textContent = 'Camera blocked: ' + (error && error.message ? error.message : 'unavailable') + '. Use the file button.';
  }
}
async function postFrame(blob) {
  if (!blob || sending) return;
  sending = true;
  try {
    await fetch(root + '/picture', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
  } catch { /* The next frame retries. */ }
  sending = false;
}
setInterval(async () => {
  const mine = ++pollSeq;
  try {
    const response = await fetch(root, { cache: 'no-store' });
    if (!response.ok) return;
    const body = await response.json();
    // This phone's own call first: whether it is asking for help decides
    // whether what follows may talk or buzz (a page reopened mid-call too).
    // An answer to a poll sent before the last press was answered is older
    // than that answer, so it cannot undo the press.
    if (mine > pressSeq) paintRelease(body.release || null);
    // A help message next, so a camera switch in the same answer never masks it.
    if (Array.isArray(body.notify)) body.notify.forEach(show);
    if (body.command && body.command.kind === 'camera' && body.command.role !== role) await start(body.command.role);
    else if (body.command && body.command.kind === 'sms') showSms(body.command);
  } catch { /* Keep the camera we already have. */ }
}, 1000);
setInterval(() => {
  if (!view.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(view.videoWidth, 640);
  canvas.height = Math.round(view.videoHeight * (canvas.width / view.videoWidth));
  canvas.getContext('2d').drawImage(view, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => { void postFrame(blob); }, 'image/jpeg', 0.55);
}, 80);
document.getElementById('file').addEventListener('change', () => {
  const file = document.getElementById('file').files && document.getElementById('file').files[0];
  if (file) void postFrame(file);
});
void start('rear');
</script>
</html>`;
}

function firstJpeg(buffer) {
  const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
  const end =
    start >= 0 ? buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2) : -1;
  if (start < 0 || end < 0) return null;
  return buffer.subarray(start, end + 2);
}

/** Try the usual phone-camera URLs on the address that reported in. One hit is enough. */
async function pullGenericPhonePicture(key, fetchImpl) {
  const host = phoneHosts.get(key);
  if (!host) return false;
  for (const camera of GENERIC_PHONE_CAMERAS) {
    try {
      const response = await fetchImpl(
        `http://${host}:${camera.port}${camera.path}`,
        {
          signal: AbortSignal.timeout(1200),
          redirect: 'error',
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      const type = String(response.headers.get('content-type') || '');
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > 1024 * 1024) break;
        chunks.push(chunk);
        if (
          !/^multipart\/x-mixed-replace/i.test(type) &&
          total > 0 &&
          chunks.length > 4
        )
          break;
      }
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      const buffer = Buffer.concat(chunks);
      const jpeg = /^image\/jpeg/i.test(type) ? buffer : firstJpeg(buffer);
      if (!jpeg || jpeg.length < 32) continue;
      publishFrame(key, jpeg, 'image/jpeg');
      return true;
    } catch {
      /* This port is not a camera. Try the next one. */
    }
  }
  return false;
}

/** Remember a position the paired security package just reported. */
// The device layer's own use of a fix the phone link sent (its pin, trail
// and saved route); set by device-feeds.js. A report the device layer took
// itself is never handed back.
let phoneFixListener = null;
/** Called with {feedId, lat, lon, at} for every fix the phone link takes. */
export function onUltraPhoneFix(listener) {
  phoneFixListener = typeof listener === 'function' ? listener : null;
}

export function noteUltraPosition(fix) {
  const key = KEY.test(String(fix?.key || ''))
    ? String(fix.key)
    : fix?.id
      ? `feed:${fix.id}`
      : '';
  if (!key) return false;
  const lat = Number(fix.lat);
  const lon = Number(fix.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat === 0 && lon === 0) return false;
  // A device's clock is not this machine's: a time ahead of now is held as
  // now (a fix cannot be newer than its arrival), and a missing or zero time
  // is now too. SEND HELP's twenty-minute rule measures this time.
  const now = Date.now();
  const at = Number(fix.at);
  positions.set(key, {
    key,
    name: String(fix.name || 'Ultra').slice(0, 60),
    lat,
    lon,
    at: Number.isFinite(at) && at > 0 ? Math.min(at, now) : now,
    ...(fix.typed === true ? { typed: true } : {}),
  });
  return true;
}

function latestPosition() {
  let best = null;
  for (const fix of positions.values())
    if (!best || fix.at > best.at) best = fix;
  return best;
}

/** The Ultra package's last fix, including one saved before this process started. */
function recallSecurityFeeds() {
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(feedStorePath(), 'utf8'));
  } catch {
    return [];
  }
  const feeds = Array.isArray(config?.feeds)
    ? config.feeds.filter((feed) => feed?.kind === 'security')
    : [];
  return feeds.map((feed) => {
    // A package has no fixed position unless its owner typed one: null is
    // "unknown", never 0, 0 (which is a real place in the Gulf of Guinea).
    let lat = Number.isFinite(feed.lat) ? feed.lat : NaN;
    let lon = Number.isFinite(feed.lon) ? feed.lon : NaN;
    let at = 0;
    try {
      const kept = JSON.parse(
        fs.readFileSync(
          path.join(
            sourceRoot,
            DEVICE_RECORDING_DIR,
            feed.id,
            'last-report.json',
          ),
          'utf8',
        ),
      );
      if (
        Number.isFinite(kept?.position?.lat) &&
        Number.isFinite(kept?.position?.lon)
      ) {
        lat = kept.position.lat;
        lon = kept.position.lon;
        // Dated by when the fix was taken, not when the report arrived: a
        // tracker's late batch must not make an hours-old fix look new. The
        // arrival bounds it, and stands in when the fix had no time.
        const fixTime = Number(kept.position.at);
        const received = Number(kept.at);
        at =
          Number.isFinite(fixTime) && fixTime > 0
            ? Math.min(
                fixTime,
                Number.isFinite(received) && received > 0 ? received : fixTime,
              )
            : Number.isFinite(received) && received > 0
              ? received
              : 0;
      }
    } catch {
      /* No saved report yet. */
    }
    // Never over a newer fix this process already holds (one the phone sent
    // with its SEND HELP, say): the saved report would make it look older.
    // A position with no time at all (one the owner typed) stands for where
    // the package always is, so it is held as current — but only in a slot
    // no real fix has filled.
    const held = positions.get(feed.reportKey);
    const usable = Number.isFinite(lat) && Number.isFinite(lon);
    const take = at ? !(held && held.at > at) : !held || held.typed === true;
    if (usable && take) {
      noteUltraPosition({
        id: feed.id,
        key: feed.reportKey,
        name: feed.name,
        lat,
        lon,
        at: at || Date.now(),
        typed: !at,
      });
    }
    return {
      id: feed.id,
      name: feed.name || 'Ultra',
      pictureUrl: feed.pictureUrl
        ? `/api/device-feeds/frame/${deviceFeedPublicId(feed)}`
        : null,
    };
  });
}

function streetAddress(address, displayName, fix) {
  const where = `${fix.lat.toFixed(4)}, ${fix.lon.toFixed(4)}`;
  const house = String(address?.house_number || '').trim();
  const road = String(
    address?.road || address?.pedestrian || address?.footway || '',
  ).trim();
  const city = String(
    address?.city || address?.town || address?.village || address?.hamlet || '',
  ).trim();
  const region = String(address?.state || '').trim();
  const line = [house, road].filter(Boolean).join(' ');
  const place = [line, city, region].filter(Boolean).join(', ');
  if (place) return `${place} (${where})`;
  const fallback = String(displayName || '').trim();
  return fallback ? `${fallback} (${where})` : where;
}

/** The request body up to a limit; past it the rest is not read and the caller answers 413. */
async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) return { overflowed: true, text: '' };
    chunks.push(chunk);
  }
  return { overflowed: false, text: Buffer.concat(chunks).toString('utf8') };
}

/** The JSON object a body holds, or null when it is not one. An array is not a body. */
function parseJsonBody(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Fetch Metadata gate: browsers label every request with where it came
 * from, and anything but a same-origin request (or a user typing the
 * address) is another website reaching into this box. The private-cameras
 * rule restated here, not imported, so this provider's boundary group stays
 * its own.
 */
function ultraFetchSiteAllowed(headers = {}) {
  const site = String(headers['sec-fetch-site'] || '').toLowerCase();
  return site === '' || site === 'same-origin' || site === 'none';
}

async function fetchJson(url, timeoutMs, fetchImpl) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': 'gods-eye-view-ultra/0.2 (local safety assist)',
      Accept: 'application/json',
    },
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  // Nominatim answers in a few kilobytes and Overpass in a few dozen: past
  // a megabyte the answer is broken or hostile and is not read to the end.
  const text = await readCapped(response, LOOKUP_MAX_BYTES);
  if (text === null) throw new Error('Answer too large or unreadable');
  return JSON.parse(text);
}

/**
 * What the box polls. Never a plaintext token and never a `revealed` key:
 * those two exist only in the answer to the mint or reveal the owner clicked.
 */
function publicStatus(store, { editable = false } = {}) {
  maybeUpgradeTokenPolicy();
  const feeds = recallSecurityFeeds();
  const fix = latestPosition();
  const livePicture = feeds.find((feed) => feed.pictureUrl)?.pictureUrl || null;
  const tokens = readTokenStore().tokens;
  const keyRead = readTokenKey();
  const tokenKey = keyRead.state === 'ok' ? keyRead.key : null;
  const tamperFlags = ultraTokenTamperFlags(tokens, tokenKey);
  // The home list first: a machine with no tokens of its own still has seals
  // there, and a rewritten help message is judged against them.
  loadNetwork();
  const messages = visibleInboxMessages();
  const now = Date.now();
  const relay = ultraSmsRelayConfig(process.env);
  const packages = securityFeeds();
  // SEND HELP, per package: where each package's position is going, to how
  // many, and what the relay made of its plea. Never a token, link or hash.
  // Every running call is listed, including one whose package the device
  // store does not show just now (a missing or unreadable file): a call the
  // box cannot see is a call nobody can stand down.
  const running = currentReleases(now).map((item) => {
    const call = ownCalls.get(item.feedId);
    const feed = packages.find((entry) => entry.id === item.feedId);
    return {
      at: item.at,
      until: item.until,
      renewedAt: item.renewedAt,
      lat: item.lat,
      lon: item.lon,
      fixAt: item.fixAt,
      feedId: item.feedId,
      name: feed ? feed.name || 'Ultra' : item.feedId,
      removed: !feed,
      incident: item.incident,
      needs: item.needs || null,
      holders: holdersFor(item.feedId),
      watching: watchingFor(item.feedId, now),
      plea: call?.plea || '',
      sms: ownSmsStatus(call, relay),
    };
  });
  // The most recent press, for everything that shows one call at a time.
  const latest =
    running.reduce(
      (best, item) => (!best || item.renewedAt > best.renewedAt ? item : best),
      null,
    ) || null;
  return {
    model: ultraPhoneModel(store.modelId),
    cameras: ultraCameraButtons(store.modelId),
    models: undefined,
    position: fix
      ? { name: fix.name, lat: fix.lat, lon: fix.lon, at: fix.at }
      : null,
    contacts: store.contacts,
    pending: fix && KEY.test(fix.key) ? commands.get(fix.key) || null : null,
    hasPicture: Boolean(livePicture) || (fix ? pictures.has(fix.key) : false),
    livePicture,
    // Shown before any report too: opening this link on the phone is what
    // produces the first one.
    camLink: ultraCamLink(
      fix && KEY.test(fix.key) ? fix.key : firstSecurityKey(),
    ),
    editable,
    // Every Ultra cell, with its map id (the Cell layer's) and what it
    // records. Never its key.
    packages: packages.map((feed) => ({
      id: feed.id,
      name: feed.name || 'Ultra',
      mapId: deviceFeedPublicId(feed),
      method: feed.method,
      record: feed.record,
      recordKm: feed.recordKm,
    })),
    ownerNumber: store.owner.number,
    // HELP DELIVERY: what SEND HELP asks to be brought, and the token skill
    // it calls for ('tr' for Transportation, else '').
    ownerNeeds: store.owner.needs,
    ownerNeedsSkill: ultraNeedsSkill(store.owner.needs),
    helpBase: ultraHelpBase(),
    // The tailnet address holders are given beside a NETWORK token, as a
    // bare origin; '' when this machine has no tailnet address.
    networkBase: ultraNetworkHelpBase(),
    tokenStore: tokenStoreState(),
    // 'tampered' when the helpers file's check failed and this key opens a
    // seal. A file with no check, or a key that opens nothing, stays 'ok'.
    helpStore: untrustedStores.has(store) ? 'tampered' : 'ok',
    // The directory, the relay and the phone packages. 'ok' includes no
    // check yet and a key that opens nothing. Not sent to a holder.
    directoryStore: directoryStatus(),
    relayStore: relayStatus(),
    feedsStore: feedsStatus(),
    tokens: tokens.map((record, index) => {
      const own = messages.filter((item) => item.tokenId === record.id);
      const skills = ultraTokenDisplayedSkills(record, tokenKey);
      // Tampered when this key opens the seal and the file disagrees, when
      // this check was removed while another token still has one, or when
      // this seal will not open while another one does. A deleted or
      // replaced key opens nothing, still admits by hash, and is not tampered.
      const tampered = tamperFlags[index] === true;
      return {
        id: record.id,
        feedId: record.feedId,
        label: record.label,
        sms: record.sms,
        voice: record.voice,
        // Whether this holder's own GEVC may receive the owner's position
        // while SEND HELP is on, and when it last asked.
        network: record.network,
        // Kept for the check on tokens already stored. Ignored at admission:
        // the page opens only while SEND HELP is pressed.
        anytime: record.anytime === true,
        // In the group directory: the position poll only, never the page.
        locationOnly: record.locationOnly === true,
        watchedAt: networkPolls.get(record.id) ?? null,
        createdAt: record.createdAt,
        revokedAt: record.revokedAt,
        // The package this token was minted for has been removed: every
        // holder request answers 404, so the box must not hand out its link.
        orphaned: !securityFeed(record.feedId),
        skills: skills.skills,
        encrypted: skills.encrypted,
        // Encrypted and sealed under a key this machine no longer holds: the
        // box says the skills are hidden, not that there are none.
        hidden: skills.hidden === true,
        tampered,
        fingerprint: ultraTokenFingerprint(record.hash),
        messages: own.length,
        lastAt: own.length ? own[0].at : null,
      };
    }),
    // Every kept message is shipped, so the unread count never names rows
    // the owner cannot see and READ.
    inbox: messages.map((item) => publicMessage(item, now, fix)),
    unread: messages.filter((item) => item.readAt === null).length,
    release: latest,
    releases: running,
    network: networkStatus(now, tokens, relay),
  };
}

/** The HELP NETWORK block: hosts, states and counts. Never a link, token, hash, sealed blob or secret. */
function networkStatus(now, tokens, relay) {
  const home = loadNetwork();
  const keyRead = readTokenKey();
  const tamperFlags = ultraNetworkTamperFlags(
    home.entries,
    keyRead.state === 'ok' ? keyRead.key : null,
  );
  const url = directoryUrl();
  const api = url ? githubDirectoryApi(url) : null;
  const published = home.published;
  const record = published
    ? tokens.find((item) => item.id === published.tokenId)
    : null;
  return {
    me: { name: home.me.name },
    polling: networkTimer !== null,
    keyState: networkKeyState(),
    directory: {
      url: displayDirectoryUrl(url),
      configured: Boolean(url),
      github: Boolean(api),
      canPublish: Boolean(api && directoryWriteToken()),
      lastUpdateAt: lastDirectory?.at ?? null,
      lastResult: lastDirectory
        ? lastDirectory.error
          ? { error: lastDirectory.error }
          : {
              added: lastDirectory.added,
              updated: lastDirectory.updated,
              missing: lastDirectory.missing,
              own: lastDirectory.own,
              moved: lastDirectory.moved,
              skipped: lastDirectory.skipped,
              total: lastDirectory.total,
            }
        : null,
    },
    published: published
      ? {
          tokenId: published.tokenId,
          at: published.at,
          how: published.how,
          live: Boolean(
            record && record.revokedAt === null && securityFeed(record.feedId),
          ),
        }
      : null,
    entries: home.entries.map((entry, index) => {
      const memory = entryMemory(entry.id);
      const row = inboxRow(memory.episodeId);
      return ultraNetworkPublicEntry(
        entry,
        {
          ...memory,
          lastState: entryState(entry, memory, tamperFlags[index] === true),
          active: Boolean(row && row.until !== null && row.until > now),
        },
        now,
      );
    }),
    relay: {
      ...ultraSmsRelayPublic(relay),
      lastTestAt: smsLedger.lastTestAt,
      lastOutcome: lastRelayOutcome,
      sentToday: ultraSmsSentToday(smsLedger, now),
    },
  };
}

/**
 * One whole frame to one live viewer. A viewer still taking an earlier frame
 * skips this one (a phone sends about twelve a second and only the newest
 * matters), so one that stops reading holds at most a frame here; a viewer
 * that cannot be written to is dropped.
 */
function writeFrame(viewer, bytes, type) {
  if (viewer.busy) return;
  const head = Buffer.from(
    `--${LIVE_BOUNDARY}\r\nContent-Type: ${type}\r\nContent-Length: ${bytes.length}\r\n\r\n`,
  );
  try {
    viewer.res.write(head);
    viewer.res.write(bytes);
    if (!viewer.res.write(Buffer.from('\r\n'))) {
      viewer.busy = true;
      viewer.res.once('drain', () => {
        viewer.busy = false;
      });
    }
  } catch {
    viewers.delete(viewer);
  }
}

/**
 * The phone key one package's picture is kept under, from the public id its
 * map card is given (`device-<package id>`), or '' for none.
 */
function packagePictureKey(publicId) {
  const feed = securityFeeds().find(
    (item) => deviceFeedPublicId(item) === publicId,
  );
  return feed?.reportKey || '';
}

/**
 * The type a phone picture is served as: JPEG, PNG or WebP, read from its
 * first bytes, and only when the phone also said it sent one of those.
 * Never the header as sent, which could name another type after a comma.
 */
function pictureType(declared, bytes) {
  const said = String(declared || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!PICTURE_TYPES.has(said)) return '';
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    return 'image/png';
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return '';
}

function publishFrame(key, bytes, type = 'image/jpeg') {
  pictures.set(key, { bytes, type, at: Date.now() });
  // A viewer of one package sees only that package's phone; the plain stream
  // sees every phone's newest frame.
  for (const viewer of viewers) {
    if (viewer.key && viewer.key !== key) continue;
    writeFrame(viewer, bytes, type);
  }
}

function json(
  res,
  status,
  body,
  type = 'application/json',
  headers = SECURITY_HEADERS,
) {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { ...headers, 'Content-Type': type });
  res.end(payload);
}

/** Whether a budget is already spent, without touching it. */
function overBudget(buckets, key, now, { max, windowMs }) {
  const since = now - windowMs;
  return (buckets.get(key) || []).filter((at) => at > since).length >= max;
}

/** Said once per window, like a refused report: the address, never the link. */
function warnMissBudget(req, address, now) {
  const last = missWarned.get(address) || 0;
  if (now - last < ULTRA_HOLDER_MISS_LIMIT.windowMs) return;
  missWarned.delete(address);
  missWarned.set(address, now);
  while (missWarned.size > 1000)
    missWarned.delete(missWarned.keys().next().value);
  const agent = String(req.headers?.['user-agent'] || '').slice(0, 40);
  // tailscale serve sets this header on its loopback proxy connection; on any
  // other socket it is whatever the client typed, so it is not repeated.
  const socketAddress = String(req.socket?.remoteAddress || '').replace(
    /^::ffff:/i,
    '',
  );
  const login = /^(127\.|::1$)/.test(socketAddress)
    ? String(req.headers?.['tailscale-user-login'] || '')
        .replace(/[^\x20-\x7e]/g, '')
        .slice(0, 80)
    : '';
  console.warn(
    `[Ultra help] Help links refused from ${address}: too many unknown links in a minute${agent ? `, ${agent}` : ''}${login ? `, tailnet user ${login}` : ''}`,
  );
}

/**
 * The live token and package a presented token names, or null for anything
 * else. `{ tampered: true }` is a known token whose file no longer checks
 * out: the same 404 as an unknown token, and not a miss. A copy placed above
 * the real record does not take its place when the real seal still opens.
 * A revoked record is rejected after that, so a revoked link still spends a
 * miss. A missing or replaced key, while it opens no seal in the file, is
 * still admitted by hash.
 */
function admitHolder(token) {
  if (!ULTRA_TOKEN_PATTERN.test(token)) return null;
  maybeUpgradeTokenPolicy();
  const store = readTokenStore();
  if (tokenCache.unreadable) return null;
  const read = readTokenKey();
  const key = read.state === 'ok' ? read.key : null;
  const selected = selectUltraToken(store.tokens, token, key);
  if (!selected) return null;
  if (selected.tampered) return { tampered: true };
  if (selected.record.revokedAt !== null) return null;
  const feed = securityFeed(selected.record.feedId);
  return feed ? { record: selected.record, feed } : null;
}

/**
 * The Ultra Token a holder's request carries, read from the Authorization
 * header alone: the Bearer scheme in any case, exactly one token after it,
 * and that token well formed, or '' for anything else — a missing header,
 * another scheme, two tokens, a token that is not one. Nothing is hashed or
 * looked up before the pattern passes, and the header's value is never
 * logged.
 */
function bearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return '';
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
  const token = match ? match[1] : '';
  return ULTRA_TOKEN_PATTERN.test(token) ? token : '';
}

/**
 * The holder's one route, admitted by the token alone: the location poll,
 * GET /ultra/help/network with the token as the Authorization bearer.
 * Anything unknown, revoked, malformed or orphaned gets the phone routes'
 * own 404 so nothing tells a guesser apart from a typo; the per-address
 * budgets bound guessing. The old form, with the token in the path, is a
 * credential guess at a route that no longer exists: the same 404, and a
 * miss. Every answer here varies by the header and is never cached.
 */
async function handleUltraHolder(req, res, parts) {
  // Tailnet only: a LAN neighbour or a rebinding page holding a published
  // token gets the unknown token's 404, before any budget, read or log.
  if (
    !ultraHolderReachable({
      remoteAddress: req.socket?.remoteAddress,
      forwardedFor: req.headers?.['x-forwarded-for'],
      host: req.headers?.host,
    })
  ) {
    json(res, 404, 'Not found', 'text/plain');
    return;
  }
  const now = Date.now();
  const address = ultraClientAddress({
    remoteAddress: req.socket?.remoteAddress,
    forwardedFor: req.headers?.['x-forwarded-for'],
  });
  if (
    !allowUltraRequest(addressBuckets, address, now, ULTRA_HOLDER_ADDRESS_LIMIT)
  ) {
    json(res, 429, 'Wait', 'text/plain');
    return;
  }
  if (overBudget(missBuckets, address, now, ULTRA_HOLDER_MISS_LIMIT)) {
    warnMissBudget(req, address, now);
    json(res, 429, 'Wait', 'text/plain');
    return;
  }
  // The token comes from the header and nowhere else. A path segment that
  // looks like one is not read: whoever sends the old form is told nothing
  // and spends a miss like any other unknown credential.
  const admitted = admitHolder(bearerToken(req));
  // The same 404 as an unknown token. Not a miss, or a holder's own poll
  // would burn the miss budget.
  if (admitted?.tampered) {
    json(res, 404, 'Not found', 'text/plain', HOLDER_HEADERS);
    return;
  }
  if (!admitted) {
    allowUltraRequest(missBuckets, address, now, ULTRA_HOLDER_MISS_LIMIT);
    json(res, 404, 'Not found', 'text/plain', HOLDER_HEADERS);
    return;
  }
  const { record, feed } = admitted;
  // A token carries the location poll and nothing else (owner ruling,
  // 2026-09-30): no page, no status and no message box, during a call too.
  // Any other route or method on a live token, and the poll on a token with
  // Network off, is that same 404, and not a miss: the holder guessed
  // nothing. Both conditions or nothing: Network on for the token, and its
  // package's SEND HELP call running, or the poll says only "not now". It
  // has to keep saying that on its twenty-second cadence, or a subscriber's
  // poller would read a 404 as a dead address and back off for ten minutes,
  // and miss the call when it came.
  if (
    parts.length !== 3 ||
    parts[2] !== 'network' ||
    req.method !== 'GET' ||
    record.network !== true
  ) {
    json(res, 404, 'Not found', 'text/plain', HOLDER_HEADERS);
    return;
  }
  // Past admission (which re-reads the token and device stores, each file
  // its own cache stamp) nothing is read from disk here, and nothing else is
  // ever in the answer: no id, message, camera, contact, number or other
  // token.
  networkPolls.set(record.id, now);
  json(
    res,
    200,
    ultraReleaseAnswer({
      release: currentRelease(feed.id, now),
      fix: positions.get(feed.reportKey) || null,
      name: networkName(feed),
      now,
      feedId: feed.id,
    }),
    'application/json',
    HOLDER_HEADERS,
  );
}

/** Phone poll and picture upload, admitted by the paired key alone; help-link holders are dispatched first. */
export async function handleUltraPhone(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'ultra' && parts[1] === 'help') {
    await handleUltraHolder(req, res, parts);
    return;
  }
  const key = parts[1] || '';
  if (parts[0] !== 'ultra' || !KEY.test(key)) {
    json(res, 404, 'Not found', 'text/plain');
    return;
  }
  // Unknown keys are budgeted per address, as unknown help links are: each
  // one reads the device store and its check. A key the last read named is
  // still let through to that check, so a phone whose old tab goes on asking
  // with a retired key (NEW KEY) is not shut out on its new one.
  const missAt = Date.now();
  const missFrom = ultraClientAddress({
    remoteAddress: req.socket?.remoteAddress,
    forwardedFor: req.headers?.['x-forwarded-for'],
  });
  if (
    overBudget(phoneMissBuckets, missFrom, missAt, ULTRA_HOLDER_MISS_LIMIT) &&
    !cachedSecurityKey(key)
  ) {
    json(res, 429, 'Wait', 'text/plain');
    return;
  }
  if (!knownSecurityKey(key)) {
    allowUltraRequest(
      phoneMissBuckets,
      missFrom,
      missAt,
      ULTRA_HOLDER_MISS_LIMIT,
    );
    json(res, 404, 'Not found', 'text/plain');
    return;
  }
  noteUltraPhone(key, req.socket?.remoteAddress);
  if (parts[2] === 'cam' && req.method === 'GET' && parts.length === 3) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'",
    });
    res.end(cameraPage());
    return;
  }
  // SEND HELP from the phone itself: the same release the box makes, under
  // the paired key alone, JSON only, four kilobytes, six a minute.
  if (parts[2] === 'help' && req.method === 'POST' && parts.length === 3) {
    const now = Date.now();
    if (!allowUltraRequest(helpBuckets, key, now, ULTRA_PHONE_HELP_LIMIT)) {
      json(res, 429, 'Wait', 'text/plain');
      return;
    }
    const type = String(req.headers?.['content-type'] || '').toLowerCase();
    if (!type.startsWith('application/json')) {
      json(res, 415, 'Send JSON', 'text/plain');
      return;
    }
    const { overflowed, text } = await readBody(req, ULTRA_HELP_BODY_LIMIT);
    if (overflowed) {
      json(res, 413, 'Too large', 'text/plain');
      return;
    }
    const body = parseJsonBody(text);
    if (!body) {
      json(res, 400, 'Send JSON', 'text/plain');
      return;
    }
    // Strictly this key's own package: a retired key must never be able to
    // speak for whichever package happens to be first in the file.
    const feed = securityFeeds().find((item) => item.reportKey === key) || null;
    if (!feed) {
      json(res, 404, 'Not found', 'text/plain');
      return;
    }
    try {
      if (body.standDown === true) {
        // Standing down is the safe direction, so it is never refused: it
        // clears this package's own call and no other, or there was nothing
        // to clear.
        standDownRelease(feed.id, now);
        json(res, 200, { ok: true, release: null });
        return;
      }
      const clean = cleanPosition(body.lat, body.lon);
      // The page says how old its fix is, on its own clock, so a skewed
      // phone clock cannot make an old fix look new. A page from before it
      // said (still open on the phone) gives no age: its coordinates are
      // taken as current only when nothing better dated is held, since the
      // same page reported each fix with its time as it came.
      const rawAge = body.age;
      const age = Number(rawAge);
      const dated =
        rawAge !== undefined && rawAge !== null && Number.isFinite(age);
      const fixAt = dated
        ? now - Math.min(Math.max(age, 0), 7 * 24 * 3_600_000)
        : now;
      const held = positions.get(key);
      const take = dated
        ? !(held && held.at > fixAt)
        : !held || held.typed === true;
      if (clean.lat !== null && take) {
        noteUltraPosition({
          key,
          name: feed.name,
          lat: clean.lat,
          lon: clean.lon,
          at: fixAt,
        });
        // The map pin, its trail and the package's saved route follow the
        // phone link too, not only reports from a tracker app.
        try {
          phoneFixListener?.({
            feedId: feed.id,
            lat: clean.lat,
            lon: clean.lon,
            at: fixAt,
          });
        } catch {
          /* the device layer's trouble never refuses the phone's fix */
        }
      }
      const previous = currentRelease(feed.id, now);
      const fix = positions.get(key) || runningFix(previous);
      const fixState = releaseFixState(fix, previous, now);
      if (fixState === 'none') {
        json(
          res,
          409,
          'No position yet: allow location for this page, then try again',
          'text/plain',
        );
        return;
      }
      if (fixState === 'stale') {
        json(res, 409, staleFixMessage(fix, now, 'phone'), 'text/plain');
        return;
      }
      const next = releaseAction({
        feed,
        fix,
        incident: classifyUltraIncident(body.incident) || 'other',
        now,
        source: 'phone',
      });
      if (!next) {
        json(
          res,
          409,
          'No position yet: allow location for this page, then try again',
          'text/plain',
        );
        return;
      }
      json(res, 200, {
        ok: true,
        release: {
          until: next.until,
          incident: next.incident,
          watching: watchingFor(feed.id, now),
        },
      });
    } catch (error) {
      if (STORE_FAILURE_CODES.has(error?.code)) {
        json(res, 409, `Not saved: ${error.message}`, 'text/plain');
        return;
      }
      json(res, 500, 'Ultra help failed', 'text/plain');
    }
    return;
  }
  if (parts[2] === 'picture' && req.method === 'POST') {
    // About twelve frames a second from the camera page; more is not a phone.
    if (!allowUltraRequest(pictureBuckets, key, Date.now(), PICTURE_LIMIT)) {
      json(res, 429, 'Wait', 'text/plain');
      return;
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) {
        json(res, 413, 'Too large', 'text/plain');
        return;
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const type = pictureType(req.headers?.['content-type'], bytes);
    if (!type) {
      json(res, 415, 'Not a picture', 'text/plain');
      return;
    }
    publishFrame(key, bytes, type);
    json(res, 200, 'taken', 'text/plain');
    return;
  }
  if (req.method !== 'GET' || parts.length !== 2) {
    json(res, 405, 'GET', 'text/plain');
    return;
  }
  // The one-slot command and the help queue are popped together, so a
  // pending camera switch and a help message arrive in the same answer.
  const now = Date.now();
  // A STAND DOWN (or SEND HELP) the disk refused is written from here too:
  // the owner may be out with the phone and no GEV tab open.
  retryUnsavedReleases(now);
  const feed = securityFeeds().find((item) => item.reportKey === key) || null;
  const active = feed ? currentRelease(feed.id, now) : null;
  // A plea card whose call has ended (expired, stood down elsewhere, or
  // replaced by a new call) is never handed over.
  if (feed)
    dropPleaCards(key, feed.id, active ? `${feed.id}:${active.at}` : null);
  const command = commands.get(key) || null;
  if (command) commands.delete(key);
  const notify = (notifies.get(key) || []).map(({ call, ...card }) => card);
  notifies.delete(key);
  if (notify.length) markDelivered(notify, now);
  // The phone's own view of SEND HELP, so a press or a STAND DOWN on the
  // desktop shows here within a second, and the other way round.
  const own = active
    ? {
        until: active.until,
        incident: active.incident,
        watching: watchingFor(feed.id, now),
      }
    : null;
  json(res, 200, { command, notify, release: own });
}

// ---- the group directory --------------------------------------------------

/** A directory failure the owner sees as one plain sentence: never a path, a link or GitHub's own body. */
function directoryFailure(status, message, code) {
  return Object.assign(new Error(message), {
    code: 'GEV_DIRECTORY',
    status,
    reason: code,
  });
}

/**
 * The directory file as text. https only, ten seconds, a quarter of a
 * megabyte, no redirect and no credential — except that a plain 404 on a
 * GitHub file with a write token saved is retried once through the
 * contents API, which is how a private group file is read.
 */
async function fetchDirectoryText(url) {
  if (directoryStatus() === 'tampered')
    throw directoryFailure(409, DIRECTORY_CHANGED_MESSAGE, 'changed');
  const ask = (target, headers, timeout) =>
    fetchTool(target, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        'User-Agent': ULTRA_USER_AGENT,
        ...headers,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
  let response;
  try {
    response = await ask(url, {}, ULTRA_DIRECTORY_TIMEOUT_MS);
  } catch {
    throw directoryFailure(
      502,
      'The directory did not answer (is the internet on?)',
      'timeout',
    );
  }
  const api = githubDirectoryApi(url);
  const token = directoryWriteToken();
  if (response.status === 404 && api && token) {
    try {
      await response.body?.cancel();
    } catch {
      /* already closed */
    }
    try {
      response = await ask(
        `${api.contentsUrl}?ref=${encodeURIComponent(api.ref)}`,
        {
          Accept: 'application/vnd.github.raw+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        ULTRA_GITHUB_TIMEOUT_MS,
      );
    } catch {
      throw directoryFailure(
        502,
        'The directory did not answer (is the internet on?)',
        'timeout',
      );
    }
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      /* already closed */
    }
    throw directoryFailure(
      502,
      `The directory did not answer (HTTP ${response.status}): check the address, or the file is private (a GitHub write token lets this machine read it)`,
      `HTTP ${response.status}`,
    );
  }
  const text = await readCapped(response, ULTRA_DIRECTORY_BYTES);
  if (text === null)
    throw directoryFailure(
      502,
      'The directory is larger than 256 KB',
      'too large',
    );
  return text;
}

/** The GitHub write: read the file, put mine into it, write it back. The token goes only to api.github.com. */
async function writeDirectory(api, token, entry) {
  if (directoryStatus() === 'tampered')
    return { ok: false, error: DIRECTORY_CHANGED_MESSAGE, reason: 'changed' };
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': ULTRA_USER_AGENT,
  };
  const refused = (status) =>
    status === 401 || status === 403
      ? `GitHub refused the write token (${status}): it needs Contents read and write on that repository`
      : status === 404
        ? 'GitHub cannot find that repository or file with this token (404)'
        : `GitHub did not write the directory (HTTP ${status})`;
  const read = async () => {
    const response = await fetchTool(
      `${api.contentsUrl}?ref=${encodeURIComponent(api.ref)}`,
      {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(ULTRA_GITHUB_TIMEOUT_MS),
      },
    );
    if (response.status === 404) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      return { sha: null, text: '' };
    }
    const raw = await readCapped(response, ULTRA_GITHUB_BYTES);
    if (!response.ok)
      throw directoryFailure(
        502,
        refused(response.status),
        `HTTP ${response.status}`,
      );
    let payload = null;
    try {
      payload = raw === null ? null : JSON.parse(raw);
    } catch {
      payload = null;
    }
    const content =
      typeof payload?.content === 'string'
        ? Buffer.from(payload.content, 'base64').toString('utf8')
        : '';
    return { sha: payload?.sha || null, text: content };
  };
  const put = async (current) => {
    const merged = mergeDirectoryDocument(current.text, entry);
    // A file that is not the shape this feature writes is never clobbered.
    if (!merged) return { ok: false, notJson: true };
    const response = await fetchTool(api.contentsUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `GEVC Ultra network: ${entry.name} published a help token`,
        content: Buffer.from(merged.text, 'utf8').toString('base64'),
        branch: api.ref,
        ...(current.sha ? { sha: current.sha } : {}),
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(ULTRA_GITHUB_TIMEOUT_MS),
    });
    try {
      await response.body?.cancel();
    } catch {
      /* already closed */
    }
    return { ok: response.ok, status: response.status };
  };
  try {
    let current = await read();
    let outcome = await put(current);
    // A 409 or 422 is somebody else's write landing first: read once more.
    if (
      !outcome.ok &&
      !outcome.notJson &&
      [409, 422].includes(outcome.status)
    ) {
      current = await read();
      outcome = await put(current);
    }
    if (outcome.notJson)
      return {
        ok: false,
        reason: 'not JSON',
        error:
          'The directory file is not JSON; ask the maintainer to fix it, or send them this entry',
      };
    if (outcome.ok) return { ok: true, reason: '', error: '' };
    return {
      ok: false,
      reason: `HTTP ${outcome.status}`,
      error: refused(outcome.status),
    };
  } catch (error) {
    if (error?.code === 'GEV_DIRECTORY')
      return {
        ok: false,
        reason: error.reason || 'error',
        error: error.message,
      };
    return {
      ok: false,
      reason: 'timeout',
      error: 'GitHub did not answer (is the internet on?)',
    };
  }
}

// ---- the owner's home-list actions ----------------------------------------

/**
 * One flag per body, like /contacts and /tokens. Every write reads the home
 * list from memory and flushes it at once through the credential store, and
 * every added link is sealed under the same key the owner's own tokens use.
 */
async function networkAction(body, store, now, answer) {
  const home = loadNetwork();
  // Every branch below edits the live home list and then writes it. If the
  // write is refused the owner is told "Not saved", so memory must go back to
  // what is on disk — otherwise a removed peer would keep being polled until
  // a restart, and a link that never reached the file would come back. That
  // is the last list saved, not a copy taken when this action began (another
  // action may have saved since, while this one waited on the directory or
  // on GitHub), and it goes back into the same object, so an action still
  // waiting holds the live list when it resumes.
  const rollback = () => {
    Object.assign(
      loadNetwork(),
      normalizeUltraNetworkStore(JSON.parse(networkSaved)),
    );
    openNetworkLinks();
  };
  try {
    return await networkEdit(body, home, store, now, answer);
  } catch (error) {
    rollback();
    throw error;
  }
}

async function networkEdit(body, home, store, now, answer) {
  if (body.me) {
    home.me = { name: cleanHelpText(body.name, ULTRA_HELP_NAME_LIMIT) };
    flushNetwork();
    return [200, answer(store)];
  }
  if (body.add) {
    // Two fields, kept apart: the address and the token. A body that joins
    // them into a link is refused whole — the panel splits a pasted legacy
    // link before it posts, and the server never reads one.
    const parts =
      'link' in body
        ? null
        : parseUltraHandout({ address: body.address, token: body.token });
    if (!parts)
      return [
        400,
        {
          error:
            'Enter their tailnet address (https://….ts.net) and their Ultra Token (uht1.…)',
        },
      ];
    if (!ultraTailnetTarget(parts))
      return [
        400,
        {
          error:
            'That address is not an https .ts.net address or a 100.64.x tailnet address, so it will not be polled',
        },
      ];
    const hash = ultraTokenHash(parts.token);
    const mine = readTokenStore().tokens.some((item) => item.hash === hash);
    if (mine || reportBases.some((base) => sameBase(base, parts.base)))
      return [
        409,
        { error: 'That is your own tailnet address or Ultra Token' },
      ];
    if (home.entries.some((entry) => entry.hash === hash))
      return [409, { error: 'Already in your home list' }];
    if (home.entries.length >= ULTRA_NETWORK_ENTRY_LIMIT)
      return [
        409,
        { error: 'The home list holds 200 entries; remove some first' },
      ];
    const key = ensureTokenKey(readTokenStore({ strict: true }).tokens);
    // Bounded like the token mint: a stuck generator must say so, not spin.
    let id = ultraNetworkEntryId();
    for (
      let attempt = 0;
      home.entries.some((entry) => entry.id === id);
      attempt += 1
    ) {
      if (attempt === 3)
        return [
          409,
          {
            error:
              'The random generator keeps returning an id this machine has already used; nothing was added',
          },
        ];
      id = ultraNetworkEntryId();
    }
    home.entries.push({
      id,
      name: cleanHelpText(body.name, ULTRA_HELP_NAME_LIMIT) || parts.host,
      base: parts.base,
      host: parts.host,
      hash,
      sealed: sealUltraNetworkToken(parts.token, key, { id }),
      source: 'manual',
      addedAt: now,
      lastPolledAt: null,
      lastState: 'new',
      directoryMissing: false,
      moved: false,
      ...ultraTokenSkillFields(parts.token),
    });
    links.set(id, { base: parts.base, token: parts.token });
    entryMemory(id).nextAt = 0;
    flushNetwork({ blessIds: [id] });
    return [200, answer(store)];
  }
  if (body.remove) {
    const entry = home.entries.find((item) => item.id === body.id);
    if (!entry) return [404, { error: 'No such link' }];
    home.entries = home.entries.filter((item) => item.id !== entry.id);
    links.delete(entry.id);
    // Written before anything else is touched: a refused write puts the list
    // and the link back, and the call they carry must then still be running,
    // with the same row, as if REMOVE had never been pressed.
    flushNetwork();
    // The REMOVE confirm promises their calls for help stop reaching you, so
    // close any call still running rather than leaving an amber row and a
    // MAP button whose pin has just gone, for the rest of its four hours.
    endEpisode(entry.id, now);
    forgetEpisode(entryMemory(entry.id).episodeId, now);
    networkMemory.delete(entry.id);
    return [200, answer(store)];
  }
  if (body.rename) {
    const name = cleanHelpText(body.name, ULTRA_HELP_NAME_LIMIT);
    if (!name) return [400, { error: 'Name who this link belongs to' }];
    const entry = home.entries.find((item) => item.id === body.id);
    if (!entry) return [404, { error: 'No such link' }];
    entry.name = name;
    flushNetwork();
    return [200, answer(store)];
  }
  if (body.update) return updateHomeList(home, store, now, answer);
  if (body.publish) return publishToken(home, body, store, now, answer);
  if (body.poll) {
    for (const entry of home.entries) entryMemory(entry.id).nextAt = 0;
    await pollUltraNetworkOnce(now);
    return [200, { ...answer(store), polling: true }];
  }
  if (body.testSms) {
    const config = ultraSmsRelayConfig(process.env);
    if (!config.configured)
      return [
        409,
        {
          error:
            'No SMS relay is configured: add Twilio or your own gateway under POWER UP',
        },
      ];
    const to = readStore().owner.number;
    if (!to)
      return [
        409,
        { error: 'SAVE MY # first: the test goes to your own cell' },
      ];
    const attempt = relaySms('test', 'test', to, ULTRA_SMS_TEST_TEXT, now);
    if (attempt.reason === 'relay-changed')
      return [409, { error: RELAY_CHANGED_MESSAGE }];
    if (attempt.reason === 'test')
      return [429, { error: 'One test every 10 minutes' }];
    if (attempt.reason)
      return [429, { error: 'The SMS relay has sent all it may for now' }];
    void attempt.outcome;
    return [200, answer(store)];
  }
  return [
    400,
    { error: 'Say me, add, remove, rename, update, publish, poll or testSms' },
  ];
}

/** UPDATE HOME LIST: one owner click, one read, a merge that never removes anything. */
async function updateHomeList(home, store, now, answer) {
  const url = directoryUrl();
  if (!url) {
    return [
      400,
      {
        error: process.env.ULTRA_DIRECTORY_URL
          ? 'The directory address must be https'
          : 'Set the directory first: SAVE DIRECTORY below (or ULTRA_DIRECTORY_URL in .env, then stop and start npm run dev)',
      },
    ];
  }
  let text;
  try {
    text = await fetchDirectoryText(url);
  } catch (error) {
    if (error?.code !== 'GEV_DIRECTORY') throw error;
    console.warn(
      `[Ultra help] Directory read failed: ${error.reason || 'error'}`,
    );
    lastDirectory = { at: now, error: error.message };
    return [error.status || 502, { error: error.message }];
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const pulled = parsed === null ? null : normalizeUltraDirectory(parsed);
  if (!pulled || pulled.unreadable) {
    console.warn('[Ultra help] Directory read failed: not JSON');
    lastDirectory = { at: now, error: 'The directory is not JSON' };
    return [502, { error: 'The directory is not JSON' }];
  }
  if (!pulled.entries.length)
    return [
      409,
      {
        error:
          'The directory has no valid entries; your home list was left alone',
      },
    ];
  const key = ensureTokenKey(readTokenStore({ strict: true }).tokens);
  // Before the merge reseals anything: a key that already opens a token or
  // a home-list seal is not new. A bad check is resealed only under a new
  // key, or UPDATE HOME LIST would stamp a base somebody else wrote.
  const keyIsNew = !keyOpensSomeSeal(key);
  const priorIds = new Set(home.entries.map((entry) => entry.id));
  const result = mergeUltraDirectory({
    home: home.entries,
    directory: pulled,
    ownHashes: readTokenStore().tokens.map((item) => item.hash),
    ownBases: reportBases,
    now,
    seal: (token, id) => sealUltraNetworkToken(token, key, { id }),
    newId: ultraNetworkEntryId,
  });
  home.entries = result.entries;
  // The merge seals; the plaintext link it sealed is matched back by hash so
  // the poller has something to go to, and it never leaves this process.
  const byHash = new Map(pulled.entries.map((item) => [item.hash, item]));
  const blessIds = home.entries
    .filter((entry) => !priorIds.has(entry.id))
    .map((entry) => entry.id);
  const had = new Set(links.keys());
  for (const entry of home.entries) {
    if (had.has(entry.id)) continue;
    const item = byHash.get(entry.hash);
    if (!item) continue;
    // The same token (the hash matched), but always at the entry's own base:
    // an entry the owner added by hand, or one whose MOVED flag has just
    // cleared, is never polled at a host the directory now names.
    if (!ultraHelpHandout(entry.base, item.token)) continue;
    const policy = ultraNetworkPolicyState(entry, key);
    const opened = openUltraNetworkToken(entry.sealed, key, { id: entry.id });
    if (!opened) {
      // A check that does not match is not resealed unless this key opens
      // nothing yet. Resealing would put a fresh seal on the base in the file.
      if (policy === 'bad' && !keyIsNew) continue;
      entry.sealed = sealUltraNetworkToken(item.token, key, { id: entry.id });
      if (keyIsNew) blessIds.push(entry.id);
    } else if (policy === 'bad') {
      continue;
    }
  }
  lastDirectory = {
    at: now,
    added: result.added,
    updated: result.updated,
    missing: result.missing,
    own: result.own,
    moved: result.moved,
    skipped: result.skipped,
    total: result.total,
  };
  flushNetwork({ blessIds });
  // Only a link this flush newly opened is due soon. One already polling
  // keeps the time it had.
  let waiting = 0;
  for (const entry of home.entries) {
    if (had.has(entry.id) || !links.has(entry.id)) continue;
    entryMemory(entry.id).nextAt = now + waiting * 250;
    waiting += 1;
  }
  return [200, answer(store)];
}

/**
 * PUBLISH MY TOKEN. The entry is exactly { name, address, token }: the
 * display name, this machine's tailnet address and the token the holder
 * would have been handed anyway, the last two kept apart. Every outcome
 * answers 200 with the entry, so publishing is never a dead end — a GitHub
 * write that failed becomes something to copy or email.
 */
async function publishToken(home, body, store, now, answer) {
  if (directoryStatus() === 'tampered')
    return [409, { error: DIRECTORY_CHANGED_MESSAGE }];
  const tokens = readTokenStore({ strict: true }).tokens;
  const liveNetwork = (id) =>
    tokens.find(
      (item) =>
        item.id === id &&
        item.revokedAt === null &&
        item.network === true &&
        securityFeed(item.feedId),
    ) || null;
  // Everyone who can read the directory holds what is published, so it is a
  // location subscription and nothing more: never a token that shows the
  // owner's number (SMS) or keeps its page open when no call is on (ANYTIME).
  // A token already made location only is safe whatever its ticks say.
  const locationOnly = (item) =>
    item.locationOnly === true || (item.sms !== true && item.anytime !== true);
  let record = null;
  if (body.id) {
    record = liveNetwork(String(body.id));
    if (!record) return [409, { error: 'Choose a live token with NETWORK on' }];
    if (!locationOnly(record))
      return [
        409,
        {
          error:
            'That token has SMS or ANYTIME on, which would give your number or an always-open page to everyone who reads the directory: turn both off on it, or publish the DIRECTORY TOKEN',
        },
      ];
  } else if (home.published?.tokenId) {
    // The DIRECTORY TOKEN choice reuses what was published last only while
    // it is still location only; otherwise a fresh Directory token is made.
    // …and only for the package asked for, when one is named.
    const last = liveNetwork(home.published.tokenId);
    const wantedFeed = String(body.feedId || '');
    record =
      last && locationOnly(last) && (!wantedFeed || last.feedId === wantedFeed)
        ? last
        : null;
  }
  if (!ultraHelpBase())
    return [
      409,
      {
        error:
          'The report listener is not up, so there is no link to publish yet: keep npm run dev running with the package saved, then try again',
      },
    ];
  const networkBase = ultraNetworkHelpBase();
  if (!networkBase)
    return [
      409,
      {
        error:
          'This machine has no tailnet address to publish, and the others can only reach it over Tailscale: set DEVICE_REPORT_PUBLIC_BASE to its https://<name>.<tailnet>.ts.net address (tailscale serve), or DEVICE_REPORT_PUBLIC_HOST to that name when the listener has its own certificate, restart npm run dev, then PUBLISH MY TOKEN again',
      },
    ];
  let token = '';
  if (record) {
    const key = requireTokenKey();
    token = openUltraToken(record.sealed, key, { id: record.id });
    if (!token) return [409, { error: KEY_CHANGED_MESSAGE }];
    if (ultraTokenRowTampered(record, tokens, key))
      return [409, { error: TAMPERED_TOKEN_MESSAGE }];
  } else {
    const packages = securityFeeds();
    if (!packages.length)
      return [400, { error: 'No Ultra Security Package is saved yet' }];
    const wanted = String(body.feedId || '');
    // With more than one package saved, never guess: a directory entry is a
    // standing subscription to one phone's position, and the owner has to
    // know which phone they are publishing. Minting matches this rule.
    const feed = wanted
      ? packages.find((item) => item.id === wanted)
      : packages.length === 1
        ? packages[0]
        : null;
    if (!feed)
      return [
        400,
        {
          error:
            'Choose which package to publish, beside PUBLISH MY TOKEN: the directory entry follows one phone',
        },
      ];
    // A token made for the group directory can never text the owner's
    // number: the directory carries a location subscription and nothing else.
    const minted = mintToken(
      tokens,
      feed,
      {
        label: 'Directory',
        sms: false,
        voice: false,
        network: true,
        locationOnly: true,
      },
      now,
    );
    record = minted.record;
    token = minted.token;
  }
  // Owner ruling, 2026-09-29: whatever goes in the directory answers the
  // position poll and nothing else, for good — its holders can never reach
  // the owner's phone, not even during a call for help.
  if (record.locationOnly !== true) {
    const latest = readTokenStore({ strict: true }).tokens;
    writeTokenStore(
      {
        version: 1,
        tokens: latest.map((item) =>
          item.id === record.id ? { ...item, locationOnly: true } : item,
        ),
      },
      { blessIds: [record.id] },
    );
    record = { ...record, locationOnly: true };
  }
  const feed = securityFeed(record.feedId);
  const handout = ultraHelpHandout(networkBase, token);
  // The same rule every receiver applies to the address before it adds or
  // polls an entry.
  if (!handout || !ultraNetworkPollTarget(handout))
    return [409, { error: 'This machine has no tailnet address to publish' }];
  const entry = ultraDirectoryEntry({
    name: home.me.name || feed?.name || 'Ultra',
    address: handout.address,
    token: handout.token,
  });
  const entryText = JSON.stringify(entry, null, 2);
  const url = directoryUrl();
  const api = url ? githubDirectoryApi(url) : null;
  const writeToken = directoryWriteToken();
  let how = 'clipboard';
  let error = '';
  // Reserved before the first await: a second PUBLISH clicked while GitHub
  // is still answering reuses this token (and replaces its own directory
  // element) instead of minting another and adding a second entry. It is
  // not written until the line after the write, which records how it went.
  if (home.published?.tokenId !== record.id)
    home.published = { tokenId: record.id, at: now, how };
  if (api && writeToken) {
    const outcome = await writeDirectory(api, writeToken, entry);
    if (outcome.ok) how = 'github';
    else {
      error = outcome.error;
      // The status or the word, never the URL, the entry or GitHub's own
      // answer body (which can quote what was sent).
      console.warn(`[Ultra help] Directory write failed: ${outcome.reason}`);
    }
  }
  home.published = { tokenId: record.id, at: now, how };
  flushNetwork();
  return [
    200,
    {
      ...answer(store),
      published: {
        how,
        entry,
        entryText,
        mailto: ultraDirectoryMailto(entryText),
        directory: displayDirectoryUrl(url),
        at: now,
        error,
      },
    },
  ];
}

/**
 * The owner's token actions, one flag per body like /contacts. Every write
 * but reset reads the store strictly first, so a corrupt file is never
 * replaced; reset is the way out of that and of a bad key file.
 */
function tokenAction(body, store, now, answer) {
  if (body.reset) {
    if (body.confirm !== true) return [400, { error: 'Confirm RESET TOKENS' }];
    // A folder at either path is somebody's data, not ours to delete: say
    // so instead of failing half way. The key goes first so that a failed
    // second step leaves 'no-key', which a second RESET clears.
    for (const file of [tokenKeyPath(), tokenStorePath()]) {
      let stat = null;
      try {
        stat = fs.lstatSync(file);
      } catch {
        stat = null;
      }
      if (stat?.isDirectory())
        throw storeFailure(
          'GEV_STORE_REPLACE_REFUSED',
          `${path.basename(file)} is a folder, not a file; move it away by hand, then RESET TOKENS again`,
        );
    }
    try {
      fs.rmSync(tokenKeyPath(), { force: true });
      fs.rmSync(tokenStorePath(), { force: true });
    } catch (error) {
      // EBUSY/EPERM on Windows: another program holds the file. Say so
      // rather than answering the generic failure.
      throw storeFailure(
        'GEV_STORE_REPLACE_REFUSED',
        `the token files could not be removed (${error?.code || 'error'}); close any program holding them, then RESET TOKENS again`,
      );
    }
    tokenCache = { stamp: '', store: emptyTokenStore(), unreadable: false };
    // Every sealed home-list link was sealed under the key that just went,
    // so the list cannot be opened or polled any more: it is emptied, and
    // UPDATE HOME LIST brings the directory's share of it back. The owner's
    // own network name stays.
    const home = loadNetwork();
    // Close anything still running first, or a call for help would stay amber
    // on the map for the rest of its four hours with no link behind it.
    for (const entry of home.entries) {
      endEpisode(entry.id, now);
      forgetEpisode(entryMemory(entry.id).episodeId, now);
    }
    home.entries = [];
    // The published marker points at a token RESET has just deleted, so it
    // describes nothing any more: the directory entry is dead either way and
    // the box should not go on showing one.
    home.published = null;
    links.clear();
    networkMemory.clear();
    flushNetwork();
    return [200, answer(store)];
  }
  const tokens = readTokenStore({ strict: true }).tokens;
  const live = (id) =>
    tokens.find((item) => item.id === id && item.revokedAt === null) || null;
  // What the owner hands a person: the token, and beside it, for a NETWORK
  // token, this machine's tailnet address — the only one a holder's own GEVC
  // will poll ('' until the listener has one). The two are never joined. A
  // token with Network off opens nothing, so it is handed out with no
  // address at all.
  const revealed = (record, token) => {
    // From the bearer string, not the file: Encrypt is not undone by a
    // skill list someone wrote beside the seal.
    const key = readTokenKey().key;
    const read = readUltraTokenSkills(token, key) || {
      skills: [],
      encrypted: record.encrypted === true,
    };
    return {
      id: record.id,
      label: record.label,
      token,
      ...(record.network === true ? { address: ultraNetworkHelpBase() } : {}),
      skills: read.skills,
      encrypted: read.encrypted === true,
      // The seal opened, but the skill blob inside the string did not: say
      // the skills are hidden rather than that there are none.
      ...(read.hidden === true ? { hidden: true } : {}),
    };
  };
  if (body.reveal) {
    const record = live(body.id);
    if (!record) return [404, { error: 'No such token' }];
    if (!securityFeed(record.feedId))
      return [
        409,
        {
          error:
            'This token belongs to a package that was removed; every request on its link answers 404. Revoke it and mint a new one',
        },
      ];
    const key = requireTokenKey();
    const token = openUltraToken(record.sealed, key, { id: record.id });
    if (!token) return [409, { error: KEY_CHANGED_MESSAGE }];
    return [200, { ...answer(store), revealed: revealed(record, token) }];
  }
  if (body.edit) {
    const record = live(body.id);
    if (!record) return [404, { error: 'No such token' }];
    const keyRead = readTokenKey();
    if (
      keyRead.state === 'ok' &&
      ultraTokenRowTampered(record, tokens, keyRead.key)
    )
      return [409, { error: TAMPERED_TOKEN_MESSAGE }];
    const changes = {};
    if (body.label !== undefined) {
      changes.label = cleanHelpText(body.label, ULTRA_HELP_NAME_LIMIT);
      if (!changes.label)
        return [400, { error: 'Name the Ultra Token holder' }];
    }
    if (typeof body.sms === 'boolean') changes.sms = body.sms;
    if (typeof body.voice === 'boolean') changes.voice = body.voice;
    if (typeof body.network === 'boolean') changes.network = body.network;
    // anytime is not editable. A stored flag stays for the check and is
    // ignored when the page is admitted. An edit cannot turn it on.
    writeTokenStore(
      {
        version: 1,
        tokens: tokens.map((item) =>
          item.id === record.id ? { ...item, ...changes } : item,
        ),
      },
      { blessIds: [record.id] },
    );
    return [200, answer(store)];
  }
  if (body.revoke) {
    const record = tokens.find((item) => item.id === body.id);
    if (!record) return [404, { error: 'No such token' }];
    // The record stays for audit: label, fingerprint and message count.
    writeTokenStore(
      {
        version: 1,
        tokens: tokens.map((item) =>
          item.id === record.id
            ? { ...item, revokedAt: item.revokedAt ?? now }
            : item,
        ),
      },
      { blessIds: [record.id] },
    );
    return [200, answer(store)];
  }
  if (body.remove) {
    if (!tokens.some((item) => item.id === body.id))
      return [404, { error: 'No such token' }];
    writeTokenStore({
      version: 1,
      tokens: tokens.filter((item) => item.id !== body.id),
    });
    return [200, answer(store)];
  }
  if (body.purge) {
    writeTokenStore({
      version: 1,
      tokens: tokens.filter((item) => item.revokedAt === null),
    });
    return [200, answer(store)];
  }
  const label = cleanHelpText(body.label, ULTRA_HELP_NAME_LIMIT);
  if (!label) return [400, { error: 'Name the Ultra Token holder' }];
  const chosen = normalizeUltraSkillRequest(body);
  if (!chosen.ok) return [400, { error: chosen.error }];
  const packages = securityFeeds();
  if (!packages.length)
    return [400, { error: 'No Ultra Security Package is saved yet' }];
  const wanted = String(body.feedId || '');
  const feed = wanted
    ? packages.find((item) => item.id === wanted)
    : packages.length === 1
      ? packages[0]
      : null;
  if (!feed) return [400, { error: 'Choose which package' }];
  const { record, token } = mintToken(
    tokens,
    feed,
    {
      label,
      // SMS and Voice belonged to the holder page, which is gone: they are
      // still stored (the token's check covers them) but open nothing, so
      // a body that does not ask for them gets them off.
      sms: body.sms === true,
      voice: body.voice === true,
      // Fail closed: a body that says nothing about the network gets no
      // network. The form's tick is visible and always sends its value.
      network: body.network === true,
      // Stored so the check still covers the field. New tokens are never
      // opened by it: the page opens only while SEND HELP is pressed.
      anytime: false,
      skills: chosen.skills,
      encrypt: chosen.encrypt,
    },
    now,
  );
  return [200, { ...answer(store), revealed: revealed(record, token) }];
}

/**
 * One new token, sealed and written. Shared by the owner's mint and by
 * PUBLISH MY TOKEN, which needs a token of its own when none is chosen.
 */
function mintToken(
  tokens,
  feed,
  {
    label,
    sms,
    voice,
    network,
    anytime = false,
    locationOnly = false,
    skills = [],
    encrypt = false,
  },
  now,
) {
  if (tokens.length >= ULTRA_TOKEN_LIMIT)
    throw storeFailure(
      'GEV_TOKEN_LIMIT',
      `At most ${ULTRA_TOKEN_LIMIT} help tokens are kept. Remove one, then mint again`,
    );
  const key = ensureTokenKey(tokens);
  // 256 bits make a repeat impossible in any practical sense (see
  // newUltraToken), but a generator that had gone wrong would repeat itself
  // rather than collide by chance, and this store is the one place that can
  // see it. Draw again rather than mint a token that is already out there.
  // The hash is of the whole string, skills included, so the check runs
  // after they are written in.
  // A string that cannot be built (a skill code the pattern cannot carry,
  // or a key the sealer refuses) is not the generator's fault: its own code
  // is not one the owner is shown, so it takes the generic 500, which logs
  // the code and never the token.
  const compose = composeImpl || composeUltraToken;
  let token = newUltraToken();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const composed = compose(token, skills, { encrypt, key });
    if (!composed)
      throw storeFailure(
        'GEV_TOKEN_COMPOSE',
        'the token could not be built; nothing was minted',
      );
    token = composed;
    const hash = ultraTokenHash(token);
    if (!tokens.some((item) => item.hash === hash)) break;
    if (attempt === 3)
      throw storeFailure(
        'GEV_WEAK_RANDOM',
        'the random generator returned a token this machine has already issued; nothing was minted',
      );
    token = newUltraToken();
  }
  // Bounded on purpose: against a generator stuck on one value an unbounded
  // redraw would spin for ever instead of saying what is wrong.
  let id = ultraTokenId();
  for (let attempt = 0; tokens.some((item) => item.id === id); attempt += 1) {
    if (attempt === 3)
      throw storeFailure(
        'GEV_WEAK_RANDOM',
        'the random generator keeps returning an id this machine has already used; nothing was minted',
      );
    id = ultraTokenId();
  }
  const record = {
    id,
    feedId: feed.id,
    label,
    sms,
    voice,
    network,
    anytime,
    locationOnly: locationOnly === true,
    // The names live in the bearer string. The file keeps the flag only.
    skills: [],
    encrypted: encrypt === true,
    createdAt: now,
    revokedAt: null,
    hash: ultraTokenHash(token),
    sealed: sealUltraToken(token, key, { id }),
  };
  writeTokenStore(
    { version: 1, tokens: [...tokens, record] },
    { blessIds: [id] },
  );
  return { record, token };
}

/** The owner's inbox actions: mark one or all read, remove one, clear; each is written at once. */
function inboxAction(body, store, now, answer) {
  const box = loadInbox();
  if (body.clear) {
    box.messages = [];
    // The row IS the episode: removing it ends the call for help here, so
    // the pin goes and the map stops drawing it.
    forgetEpisode(undefined, now);
  } else if (body.remove) {
    box.messages = box.messages.filter((item) => item.id !== body.id);
    forgetEpisode(String(body.id ?? ''), now);
  } else if (body.read) {
    stampLegacyInbox(box);
    for (const item of box.messages) {
      if ((!body.id || item.id === body.id) && item.readAt === null) {
        item.readAt = now;
        touchInbox(item);
      }
    }
  } else {
    return [400, { error: 'Say read, remove or clear' }];
  }
  flushInbox();
  return [200, answer(store)];
}

export function ultraHelpProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  sourceRoot: root = process.cwd(),
  harden,
  compose,
  verify,
} = {}) {
  pointAt(root, harden, compose, verify);
  // The poller, the directory, the geocode and the SMS relay all go out
  // through the same injected fetch, so a test drives every one of them.
  fetchTool = fetchImpl;
  const admit = (req) =>
    admitKeySetupRequest({
      method: req.method,
      remoteAddress: req.socket?.remoteAddress,
      hostHeader: req.headers?.host,
      protocol: req.socket?.encrypted ? 'https:' : 'http:',
      origin: req.headers?.origin,
      contentType: req.headers?.['content-type'],
      proxyHeaders: req.headers || {},
      env: process.env,
    });

  const makeHandler = ({ allowEdit }) => {
    const answer = (store) => publicStatus(store, { editable: allowEdit });
    return async (req, res) => {
      const admitted = admit(req);
      if (!admitted.ok) {
        json(res, admitted.status || 403, {
          error: String(admitted.error || 'Refused').replace(
            'Provider Settings',
            'Ultra help',
          ),
        });
        return;
      }
      if (!ultraFetchSiteAllowed(req.headers || {})) {
        json(res, 403, { error: 'Ultra help answers only its own page' });
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const pathName = url.pathname;
      try {
        // Inside the try: a helpers file that makes the read throw is a
        // generic failure here, never an uncaught throw out of the handler.
        const store = readStore();
        recallSecurityFeeds();
        if (
          req.method === 'GET' &&
          (pathName === '/' || pathName === '' || pathName === '/status')
        ) {
          // A SEND HELP or STAND DOWN the disk refused is written here.
          retryUnsavedReleases();
          const status = answer(store);
          status.models = ULTRA_PHONE_MODELS.map((model) =>
            ultraPhoneModel(model.id),
          );
          json(res, 200, status);
          return;
        }
        // /live and /picture are the newest phone's, for this box; with a
        // package's public id after them they are that package's phone alone,
        // which is what each package's map card asks for.
        const livePath = /^\/live(?:\/([a-z0-9-]{1,140}))?$/.exec(pathName);
        if (req.method === 'GET' && livePath) {
          const key = livePath[1] ? packagePictureKey(livePath[1]) : '';
          if (livePath[1] && !key) {
            json(res, 404, { error: 'No such package' });
            return;
          }
          req.socket?.setTimeout(0);
          res.setTimeout?.(0);
          res.writeHead(200, {
            'Content-Type': `multipart/x-mixed-replace; boundary=${LIVE_BOUNDARY}`,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...SECURITY_HEADERS,
          });
          const viewer = { res, key, busy: false };
          // The oldest view makes room: the newest is the one just opened.
          while (viewers.size >= LIVE_VIEWER_LIMIT) {
            const oldest = viewers.values().next().value;
            viewers.delete(oldest);
            try {
              oldest.res.end();
            } catch {
              /* already gone */
            }
          }
          viewers.add(viewer);
          const current = pictures.get(key || latestPosition()?.key || '');
          if (current?.bytes) writeFrame(viewer, current.bytes, current.type);
          const drop = () => viewers.delete(viewer);
          req.on('close', drop);
          res.on('close', drop);
          return;
        }
        const picturePath = /^\/picture(?:\/([a-z0-9-]{1,140}))?$/.exec(
          pathName,
        );
        if (req.method === 'GET' && picturePath) {
          const key = picturePath[1]
            ? packagePictureKey(picturePath[1])
            : latestPosition()?.key || '';
          const picture = key ? pictures.get(key) : null;
          if (!picture) {
            json(res, 404, { error: 'No picture' });
            return;
          }
          json(res, 200, picture.bytes, picture.type);
          return;
        }
        let body = null;
        if (req.method === 'POST') {
          const { overflowed, text } = await readBody(req, OWNER_BODY_LIMIT);
          if (overflowed) {
            json(res, 413, { error: 'Request too large' });
            return;
          }
          body = parseJsonBody(text);
          if (!body) {
            json(res, 400, { error: 'Bad JSON' });
            return;
          }
        }
        if (req.method === 'POST' && pathName === '/model') {
          store.modelId = ultraPhoneModel(body.modelId).id;
          writeStore(store);
          json(res, 200, answer(store));
          return;
        }
        if (req.method === 'POST' && pathName === '/contacts') {
          const number = normalizeUltraNumber(body.number);
          const kind = ultraContactKind(body.kind);
          const label = String(body.label || '')
            .trim()
            .slice(0, 60);
          if (body.remove) {
            store.contacts = store.contacts.filter(
              (item) => item.id !== body.id,
            );
          } else if (!number || !kind || !label) {
            json(res, 400, {
              error: 'Need a label, a +number, and police, fire, or other',
            });
            return;
          } else {
            store.contacts.push({
              id: `${kind}-${number}`,
              label,
              number,
              kind,
            });
          }
          writeStore(store);
          json(res, 200, answer(store));
          return;
        }
        if (req.method === 'POST' && pathName === '/camera') {
          const role = ultraCameraRole(store.modelId, body.role);
          if (!role) {
            json(res, 400, { error: 'This phone has no such camera' });
            return;
          }
          const known = answer(store);
          const fix = latestPosition();
          if (!fix || !KEY.test(fix.key)) {
            json(res, 400, {
              error:
                'No paired phone yet. The phone has to report in once first.',
            });
            return;
          }
          commands.set(fix.key, {
            kind: 'camera',
            role: role.id,
            label: role.label,
            at: Date.now(),
          });
          if (!known.livePicture && !pictures.has(fix.key)) {
            await pullGenericPhonePicture(fix.key, fetchImpl);
          }
          const status = answer(store);
          if (!status.livePicture && !status.hasPicture) {
            status.cameraNote = status.camLink
              ? 'Open the camera link on the phone. It sends live video into this box.'
              : 'The report listener is not up yet. Restart the dev server, then open the camera link on the phone.';
          }
          json(res, 200, status);
          return;
        }
        if (req.method === 'POST' && pathName === '/tokens') {
          if (!allowEdit) {
            json(res, 403, {
              error: 'Editing is available under the dev server only',
            });
            return;
          }
          const [status, payload] = tokenAction(
            body,
            store,
            Date.now(),
            answer,
          );
          json(res, status, payload);
          return;
        }
        if (req.method === 'POST' && pathName === '/release') {
          if (!allowEdit) {
            json(res, 403, {
              error: 'Editing is available under the dev server only',
            });
            return;
          }
          const now = Date.now();
          const picked = releaseFeedFor(body, now);
          if (picked.error) {
            json(res, picked.status, { error: picked.error });
            return;
          }
          if (body.standDown === true) {
            // Only the chosen package's call ends: standing down one never
            // silences another that is still asking for help.
            standDownRelease(picked.feedId, now);
            json(res, 200, answer(store));
            return;
          }
          const { feed } = picked;
          // That package's own phone, never "whichever phone reported last":
          // EXTEND HELP must renew the call it is pressed on.
          const previous = currentRelease(feed.id, now);
          const fix = positions.get(feed.reportKey) || runningFix(previous);
          const fixState = releaseFixState(fix, previous, now);
          if (fixState === 'none') {
            json(res, 409, {
              error:
                'No position yet: open the phone link on the phone, or press SEND HELP there',
            });
            return;
          }
          if (fixState === 'stale') {
            json(res, 409, { error: staleFixMessage(fix, now, 'desktop') });
            return;
          }
          releaseAction({
            feed,
            fix,
            incident: classifyUltraIncident(body.incident) || 'other',
            now,
            source: 'desktop',
          });
          json(res, 200, answer(store));
          return;
        }
        if (req.method === 'POST' && pathName === '/network') {
          if (!allowEdit) {
            json(res, 403, {
              error: 'Editing is available under the dev server only',
            });
            return;
          }
          const [status, payload] = await networkAction(
            body,
            store,
            Date.now(),
            answer,
          );
          json(res, status, payload);
          return;
        }
        if (req.method === 'POST' && pathName === '/needs') {
          if (!allowEdit) {
            json(res, 403, {
              error: 'Editing is available under the dev server only',
            });
            return;
          }
          // HELP DELIVERY from the Social Media tab; null clears it. A call
          // already running keeps what it was sent with.
          const needs = body.needs === null ? null : ultraNeeds(body.needs);
          if (body.needs !== null && !needs) {
            json(res, 400, { error: 'Choose the help to be delivered.' });
            return;
          }
          if (JSON.stringify(store.owner.needs) !== JSON.stringify(needs)) {
            store.owner.needs = needs;
            writeStore(store);
          }
          json(res, 200, answer(store));
          return;
        }
        if (req.method === 'POST' && pathName === '/number') {
          if (!allowEdit) {
            json(res, 403, {
              error: 'Editing is available under the dev server only',
            });
            return;
          }
          const raw = body.number;
          let number = '';
          if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
            number = normalizeUltraNumber(raw);
            if (!number) {
              json(res, 400, {
                error: 'Need a +number like +15065550100, or leave it empty',
              });
              return;
            }
          }
          store.owner.number = number;
          writeStore(store);
          json(res, 200, answer(store));
          return;
        }
        if (req.method === 'POST' && pathName === '/inbox') {
          if (!allowEdit) {
            json(res, 403, {
              error: 'Editing is available under the dev server only',
            });
            return;
          }
          const [status, payload] = inboxAction(
            body,
            store,
            Date.now(),
            answer,
          );
          json(res, status, payload);
          return;
        }
        json(res, 404, { error: 'Not found' });
      } catch (error) {
        // A store or key failure is said to the owner, path-free; anything
        // else stays the generic failure so no detail leaks.
        if (STORE_FAILURE_CODES.has(error?.code)) {
          json(res, 409, { error: `Not saved: ${error.message}` });
          return;
        }
        // The owner's own terminal gets the code so a failed RESET or mint
        // is not a silent 500; the code carries no token or link.
        console.warn(
          `[Ultra help] ${req.method} ${pathName} failed: ${String(error?.code || error?.name || 'error').slice(0, 60)}`,
        );
        json(res, 500, { error: 'Ultra help failed' });
      }
    };
  };

  const install = (server, { allowEdit }) => {
    server.middlewares.use('/api/ultra-help', makeHandler({ allowEdit }));
  };

  return {
    name: 'ultra-help',
    configureServer(server) {
      install(server, { allowEdit: true });
      // Only the real dev server polls the home list: the dashboard tab need
      // not be open. A test harness passes middlewares alone and drives
      // pollUltraNetworkOnce instead, so no test ever starts a timer.
      if (server.httpServer) {
        const owner = startNetworkPoller();
        server.httpServer.once('close', () => stopNetworkPoller(owner));
      }
    },
    configurePreviewServer(server) {
      // A preview build serves the box read-only: no token or number
      // changes, and no polling (the rows read NOT POLLED).
      install(server, { allowEdit: false });
    },
  };
}
