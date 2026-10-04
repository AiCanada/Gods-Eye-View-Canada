import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  ULTRA_RELEASE_WINDOW_MS,
  ULTRA_CLOCK_MARGIN_MS,
  ULTRA_NETWORK_POLL_MS,
  ULTRA_NETWORK_TICK_MS,
  ULTRA_NETWORK_TIMEOUT_MS,
  ULTRA_NETWORK_ANSWER_LIMIT,
  ULTRA_NETWORK_CONCURRENCY,
  ULTRA_NETWORK_MAX_IN_FLIGHT,
  ULTRA_NETWORK_BACKOFF_BASE_MS,
  ULTRA_NETWORK_BACKOFF_MAX_MS,
  ULTRA_NETWORK_DEAD_MS,
  ULTRA_NETWORK_BUSY_MS,
  ULTRA_NETWORK_ENTRY_LIMIT,
  ULTRA_NETWORK_HOST_ENTRY_LIMIT,
  ULTRA_NETWORK_STALE_MS,
  ULTRA_NETWORK_EPISODE_GAP_MS,
  ULTRA_DIRECTORY_LIMIT,
  ULTRA_DIRECTORY_BYTES,
  ULTRA_DIRECTORY_TIMEOUT_MS,
  ULTRA_GITHUB_TIMEOUT_MS,
  ULTRA_GEOCODE_TIMEOUT_MS,
  ULTRA_GEOCODE_SPACING_MS,
  ULTRA_GEOCODE_MOVE_M,
  ULTRA_GEOCODE_RETRY_MS,
  ULTRA_WATCHING_MS,
  ULTRA_PHONE_HELP_LIMIT,
  ULTRA_INCIDENTS,
  ULTRA_HELP_LINK_PATTERN,
  ULTRA_HELP_LINK_LIMIT,
  ULTRA_NETWORK_ID_PATTERN,
  ULTRA_NETWORK_STATES,
  ULTRA_NETWORK_AAD,
  ULTRA_NETWORK_PLACE_LIMIT,
  ULTRA_NETWORK_PIN_COLOR,
  ultraTailnetAddress,
  ultraTailnetTarget,
  ultraHolderReachable,
  parseUltraHelpLink,
  ultraNetworkPollTarget,
  ultraHelpLinkFor,
  ultraTailnetBase,
  ultraDirectoryUrl,
  displayDirectoryUrl,
  ultraNetworkEntryId,
  sealUltraNetworkToken,
  openUltraNetworkToken,
  ultraIncident,
  ultraCoordinatesPlace,
  ultraClockTime,
  normalizeUltraRelease,
  newUltraRelease,
  ultraReleaseAnswer,
  normalizeUltraNetworkAnswer,
  ultraPollOutcome,
  ultraEpisodeDecision,
  ultraReleaseInboxRecord,
  ultraReleaseRowUpdate,
  normalizeUltraNetworkEntry,
  normalizeUltraNetworkStore,
  ultraNetworkPublicEntry,
  ultraNetworkPolicyMac,
  ultraNetworkPolicyState,
  stampUltraNetworkPolicy,
  ultraNetworkPollAllowed,
  ultraNetworkTamperFlags,
  ultraHelpStorePolicyMac,
  ultraHelpStorePolicyState,
  ultraOutboundPolicyState,
  ultraDirectoryPolicyMac,
  ultraRelayPolicyMac,
  ultraFeedsPolicyMac,
  normalizeUltraDirectory,
  mergeUltraDirectory,
  githubDirectoryApi,
  ultraDirectoryEntry,
  mergeDirectoryDocument,
  ultraDirectoryMailto,
  ultraNetworkPin,
  ultraWatchingCount,
  ultraGeocodeKey,
  ultraNeedsGeocode,
} from '../server/shared/ultraNetwork.mjs';
import {
  composeUltraToken,
  newUltraToken,
  ultraTokenHash,
  sealUltraToken,
  openUltraToken,
  normalizeUltraInboxRecord,
} from '../server/shared/ultraTokens.mjs';
import { ultraHelpMessage } from './ultraHelp.mjs';
import { securityFeedPolicyRecords } from './deviceFeedsCore.mjs';
import {
  ULTRA_SMS_DAILY_LIMIT,
  ULTRA_SMS_HOST_LIMIT,
  ULTRA_SMS_OWN_RESERVE,
  ultraSmsRelayMaterial,
} from '../server/shared/ultraSmsRelay.mjs';

const NOW = Date.parse('2026-09-28T18:00:00Z');
const KEY = Buffer.alloc(32, 7);
const fixedBytes = (fill) => (n) => Buffer.alloc(n, fill);
const tokenOf = (fill) => newUltraToken(fixedBytes(fill));
const T1 = tokenOf(1);
const T2 = tokenOf(2);
const T3 = tokenOf(3);
const T4 = tokenOf(4);
const T5 = tokenOf(5);
const MY = tokenOf(0x99);
const SAM = 'https://sam.tail9.ts.net';
const ANN = 'http://100.64.1.2:44173';
const MINE = 'https://mybox.tail0demo0.ts.net';
const link = (base, token) => `${base}/ultra/help/${token}`;
const PLACE = '10 Example St, Saint John, New Brunswick (45.2744, -66.0622)';
const hhmm = (ms) => {
  const d = new Date(ms);
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0')
  );
};

/** A home-list entry as config/ultra-network.json holds it. */
function entry(overrides = {}) {
  const { token = T1, ...rest } = overrides;
  const id = rest.id || 'n-0000000000000001';
  const base = rest.base || SAM;
  return {
    id,
    name: 'Sam',
    base,
    host: new URL(base).host,
    hash: ultraTokenHash(token),
    sealed: sealUltraToken(token, KEY, {
      id,
      randomBytes: fixedBytes(3),
      aad: ULTRA_NETWORK_AAD,
    }),
    source: 'manual',
    addedAt: NOW - 1000,
    lastPolledAt: null,
    lastState: 'new',
    directoryMissing: false,
    moved: false,
    ...rest,
  };
}

/** A peer's honest poll answer: pressed five seconds ago on their clock. */
function peerRelease(overrides = {}) {
  return {
    released: true,
    name: 'Van 7',
    lat: 45.27,
    lon: -66.06,
    at: NOW - 5000,
    until: NOW - 5000 + ULTRA_RELEASE_WINDOW_MS,
    incident: 'fire',
    ...overrides,
  };
}

/** A link of exactly `total` characters on a .ts.net name (labels of nine). */
function longLink(total) {
  const prefix = 'https://';
  const suffix = '.ts.net/ultra/help/' + T1;
  const need = total - prefix.length - suffix.length;
  let host = 'abcdefghi.'.repeat(Math.ceil(need / 10)).slice(0, need);
  if (host.endsWith('.')) host = host.slice(0, -1) + 'x';
  return prefix + host + suffix;
}

test('the constants are the numbers the design quotes', () => {
  assert.equal(ULTRA_RELEASE_WINDOW_MS, 14_400_000);
  assert.equal(ULTRA_CLOCK_MARGIN_MS, 120_000);
  assert.equal(ULTRA_NETWORK_POLL_MS, 20_000);
  assert.equal(ULTRA_NETWORK_TICK_MS, 5_000);
  assert.equal(ULTRA_NETWORK_TIMEOUT_MS, 5_000);
  assert.equal(ULTRA_NETWORK_ANSWER_LIMIT, 4096);
  assert.equal(ULTRA_NETWORK_CONCURRENCY, 4);
  assert.equal(ULTRA_NETWORK_BACKOFF_BASE_MS, 20_000);
  assert.equal(ULTRA_NETWORK_BACKOFF_MAX_MS, 600_000);
  assert.equal(ULTRA_NETWORK_DEAD_MS, 600_000);
  assert.equal(ULTRA_NETWORK_BUSY_MS, 60_000);
  assert.equal(ULTRA_NETWORK_ENTRY_LIMIT, 200);
  assert.equal(ULTRA_NETWORK_HOST_ENTRY_LIMIT, 8);
  assert.equal(ULTRA_NETWORK_STALE_MS, 120_000);
  assert.equal(ULTRA_NETWORK_EPISODE_GAP_MS, 600_000);
  assert.equal(ULTRA_DIRECTORY_LIMIT, 500);
  assert.equal(ULTRA_DIRECTORY_BYTES, 262_144);
  assert.equal(ULTRA_DIRECTORY_TIMEOUT_MS, 10_000);
  assert.equal(ULTRA_GITHUB_TIMEOUT_MS, 15_000);
  assert.equal(ULTRA_GEOCODE_TIMEOUT_MS, 5_000);
  assert.equal(ULTRA_GEOCODE_SPACING_MS, 1_000);
  assert.equal(ULTRA_GEOCODE_MOVE_M, 50);
  assert.equal(ULTRA_GEOCODE_RETRY_MS, 60_000);
  assert.equal(ULTRA_WATCHING_MS, 60_000);
  assert.deepEqual(ULTRA_PHONE_HELP_LIMIT, { max: 6, windowMs: 60_000 });
  assert.ok(Object.isFrozen(ULTRA_PHONE_HELP_LIMIT));
  assert.deepEqual(
    [...ULTRA_INCIDENTS],
    ['threat', 'fire', 'medical', 'other'],
  );
  assert.ok(Object.isFrozen(ULTRA_INCIDENTS));
  assert.equal(ULTRA_HELP_LINK_LIMIT, 512);
  assert.equal(String(ULTRA_NETWORK_ID_PATTERN), '/^n-[0-9a-f]{16}$/');
  assert.deepEqual(
    [...ULTRA_NETWORK_STATES],
    [
      'new',
      'quiet',
      'released',
      'off',
      'dead',
      'unreachable',
      'busy',
      'not-tailnet',
      'missing',
      'moved',
      'own',
      'no-key',
      'tampered',
    ],
  );
  assert.equal(ULTRA_NETWORK_AAD, 'ultra-network:');
  assert.equal(ULTRA_NETWORK_PLACE_LIMIT, 160);
  assert.equal(ULTRA_NETWORK_PIN_COLOR, '#ffb000');
  assert.match(link(SAM, T1), ULTRA_HELP_LINK_PATTERN);
  assert.doesNotMatch(T1, ULTRA_HELP_LINK_PATTERN);
});

test('ultraTailnetTarget accepts only https .ts.net names and 100.64.0.0/10 literals', () => {
  for (const target of [
    { scheme: 'https', hostname: 'mybox.tail0demo0.ts.net' },
    { scheme: 'https', hostname: 'x.ts.net' },
    { scheme: 'https:', hostname: 'MYBOX.TAIL0DEMO0.TS.NET' },
    { scheme: 'http', hostname: '100.101.102.103' },
    { scheme: 'https', hostname: '100.64.0.1' },
    { scheme: 'http', hostname: '100.127.255.255' },
  ]) {
    assert.equal(ultraTailnetTarget(target), true, JSON.stringify(target));
  }
  for (const hostname of [
    'van.local',
    'aicanada',
    '192.168.1.5',
    '10.0.0.7',
    '172.16.0.9',
    '127.0.0.1',
    'localhost',
    '169.254.1.1',
    '0.0.0.0',
    '224.0.0.1',
    '[::1]',
    '::1',
    '8.8.8.8',
    'example.com',
    'evil.ts.net.example.com',
    'ts.net',
    '.ts.net',
    'x.ts.net.',
    '100.63.255.255',
    '100.128.0.0',
    '100.64.0.256',
    'x.ts.net/evil',
    '',
    null,
    undefined,
  ]) {
    assert.equal(
      ultraTailnetTarget({ scheme: 'https', hostname }),
      false,
      String(hostname),
    );
    assert.equal(
      ultraTailnetTarget({ scheme: 'http', hostname }),
      false,
      'http ' + String(hostname),
    );
  }
  // Plain http is only ever good enough for a tailnet literal.
  assert.equal(
    ultraTailnetTarget({ scheme: 'http', hostname: 'x.ts.net' }),
    false,
  );
  assert.equal(
    ultraTailnetTarget({ scheme: 'ftp', hostname: '100.64.0.1' }),
    false,
  );
  assert.equal(ultraTailnetTarget({ hostname: 'x.ts.net' }), false);
  assert.equal(ultraTailnetTarget({}), false);
  assert.equal(ultraTailnetTarget(), false);
  assert.equal(ultraTailnetAddress('100.64.0.1'), true);
  assert.equal(ultraTailnetAddress('100.63.255.255'), false);
  assert.equal(ultraTailnetAddress('100.128.0.0'), false);
  assert.equal(ultraTailnetAddress('256.64.0.1'), false);
  assert.equal(ultraTailnetAddress('x.ts.net'), false);
});

test('ultraHolderReachable: the tailnet, or this machine with no proxy, and a Host a tailnet poll sends', () => {
  const reach = (
    remoteAddress,
    forwardedFor,
    host = 'box.tail1.ts.net:44173',
  ) => ultraHolderReachable({ remoteAddress, forwardedFor, host });
  // The tailnet, by IPv4 (edges of 100.64.0.0/10 included) and by IPv6.
  for (const address of [
    '100.64.0.1',
    '100.127.255.254',
    '::ffff:100.100.1.2',
    'fd7a:115c:a1e0::1',
    'FD7A:115C:A1E0:AB12:4843:CD96:6258:B240',
  ]) {
    assert.equal(reach(address), true, address);
  }
  // Behind tailscale serve: one forwarded tailnet address.
  assert.equal(reach('127.0.0.1', '100.64.0.9'), true);
  assert.equal(reach('::1', ' fd7a:115c:a1e0::9 '), true);
  // This machine itself, with no proxy in between.
  assert.equal(reach('127.0.0.1', undefined, 'localhost:44173'), true);
  assert.equal(reach('::ffff:127.0.0.1', ''), true);
  // Anywhere else, or anything forwarded that is not one tailnet address.
  for (const [address, forwarded] of [
    ['192.168.1.20'],
    ['10.0.0.7'],
    ['100.63.255.255'],
    ['100.128.0.1'],
    ['203.0.113.9'],
    ['fd7a:115c:a1e1::1'],
    ['fe80::1'],
    ['1270.0.0.1'],
    [''],
    [undefined],
    ['10.0.0.7', '100.64.0.9'],
    ['127.0.0.1', '203.0.113.9'],
    ['127.0.0.1', '192.168.1.20'],
    ['127.0.0.1', '127.0.0.1'],
    ['127.0.0.1', '100.64.0.9, 203.0.113.9'],
    ['127.0.0.1', '203.0.113.9, 100.64.0.9'],
  ]) {
    assert.equal(
      reach(address, forwarded),
      false,
      `${address} via ${forwarded}`,
    );
  }
  // The Host a tailnet poll sends: a *.ts.net name, an address, or localhost.
  const named = (host) =>
    ultraHolderReachable({ remoteAddress: '100.64.0.9', host });
  for (const host of [
    'box.tail1.ts.net',
    'BOX.Tail1.TS.NET:443',
    '100.101.0.1:44173',
    '[fd7a:115c:a1e0::1]:44173',
    'localhost:4173',
    'gev.localhost',
  ]) {
    assert.equal(named(host), true, host);
  }
  for (const host of [
    'rebind.evil:44173',
    'ts.net',
    'box.ts.net.evil.com',
    'box:44173',
    'box.tail1.ts.net.',
    '',
    undefined,
    null,
    'user@box.tail1.ts.net',
    'box.tail1.ts.net/x',
    'a b',
    'x'.repeat(301),
  ]) {
    assert.equal(named(host), false, String(host));
  }
});

test('parseUltraHelpLink takes a whole help link apart and refuses anything else', () => {
  assert.deepEqual(parseUltraHelpLink(link(SAM, T1)), {
    scheme: 'https',
    host: 'sam.tail9.ts.net',
    hostname: 'sam.tail9.ts.net',
    base: SAM,
    token: T1,
  });
  assert.deepEqual(parseUltraHelpLink(link(SAM, T1) + '/'), {
    scheme: 'https',
    host: 'sam.tail9.ts.net',
    hostname: 'sam.tail9.ts.net',
    base: SAM,
    token: T1,
  });
  assert.deepEqual(parseUltraHelpLink('  ' + link(ANN, T2) + '\n'), {
    scheme: 'http',
    host: '100.64.1.2:44173',
    hostname: '100.64.1.2',
    base: ANN,
    token: T2,
  });
  // Parsing does not judge the host; the tailnet rule does, separately.
  const publicLink = parseUltraHelpLink(link('https://example.com', T1));
  assert.equal(publicLink.host, 'example.com');
  assert.equal(ultraTailnetTarget(publicLink), false);
  assert.equal(ultraTailnetTarget(parseUltraHelpLink(link(SAM, T1))), true);
  assert.equal(ultraTailnetTarget(parseUltraHelpLink(link(ANN, T2))), true);
  assert.equal(parseUltraHelpLink(longLink(512)).host.length > 400, true);
  for (const bad of [
    link(SAM, T1) + '?x=1',
    link(SAM, T1) + '#x',
    'https://user:pw@sam.tail9.ts.net/ultra/help/' + T1,
    'https://user@sam.tail9.ts.net/ultra/help/' + T1,
    link(SAM, T1) + '/network',
    link(SAM, T1) + '/status',
    SAM + '/ultra/help/uht1.' + 'A'.repeat(42),
    SAM + '/ultra/help/uht1.' + 'A'.repeat(44),
    SAM + '/ultra/help/uht2.' + 'A'.repeat(43),
    SAM + '/ultra/help/' + T1.slice(5),
    SAM + '/ultra/' + T1,
    SAM + '/help/' + T1,
    SAM + '/ultra/help/',
    SAM + '/ultra/help',
    T1,
    '/ultra/help/' + T1,
    'sam.tail9.ts.net/ultra/help/' + T1,
    'ftp://sam.tail9.ts.net/ultra/help/' + T1,
    'HTTPS://sam.tail9.ts.net/ultra/help/' + T1,
    longLink(513),
    '',
    ' ',
    null,
    undefined,
    42,
    { toString: () => link(SAM, T1) },
    ['x'],
  ]) {
    assert.equal(parseUltraHelpLink(bad), null, String(bad));
  }
  const skilled = composeUltraToken(T1, [
    { code: 'ff', label: 'Firefighter' },
    { code: 'xcoast-guard', label: 'Coast Guard' },
  ]);
  assert.equal(parseUltraHelpLink(link(SAM, skilled)).token, skilled);
  assert.equal(
    ultraNetworkPollTarget(link(SAM, skilled)).url,
    `${SAM}/ultra/help/${skilled}/network`,
  );
  const hidden = composeUltraToken(T2, [{ code: 'dr', label: 'Doctor' }], {
    encrypt: true,
    key: KEY,
    randomBytes: fixedBytes(4),
  });
  const merged = mergeUltraDirectory({
    directory: normalizeUltraDirectory([
      { name: 'Sam', link: link(SAM, skilled) },
      { name: 'Ann', link: link(ANN, hidden) },
    ]),
    now: NOW,
    seal: (token, id) =>
      sealUltraToken(token, KEY, {
        id,
        aad: ULTRA_NETWORK_AAD,
        randomBytes: fixedBytes(3),
      }),
    newId: (() => {
      let n = 0;
      return () => 'n-' + String(++n).padStart(16, '0');
    })(),
  });
  assert.deepEqual(merged.entries[0].skills, ['Firefighter', 'Coast Guard']);
  assert.equal('encrypted' in merged.entries[0], false);
  assert.equal(merged.entries[1].encrypted, true);
  assert.equal('skills' in merged.entries[1], false);
  assert.ok(!JSON.stringify(merged.entries).includes(skilled));
  assert.ok(!JSON.stringify(merged.entries).includes('Doctor'));
});

test('ultraTailnetBase picks the address a help-network link must carry, never a LAN one', () => {
  assert.equal(
    ultraTailnetBase([
      'http://192.168.1.5:44173',
      'http://100.101.102.103:44173',
      'https://me.tail9.ts.net',
    ]),
    'https://me.tail9.ts.net',
    'a .ts.net name first, wherever it sits',
  );
  assert.equal(
    ultraTailnetBase(['http://10.0.0.2:44173', 'http://100.64.0.9:44173']),
    'http://100.64.0.9:44173',
  );
  // https to a bare 100.64 address: no certificate can name it, so never.
  assert.equal(ultraTailnetBase(['https://100.64.0.9:44173']), '');
  assert.equal(
    ultraTailnetBase(['https://100.64.0.9:44173', 'http://100.64.0.10:44173']),
    'http://100.64.0.10:44173',
  );
  for (const none of [
    [],
    ['http://192.168.1.5:44173'],
    ['http://me.tail9.ts.net:44173'],
    ['https://example.com'],
    ['http://100.128.0.1:44173'],
    ['https://me.tail9.ts.net/path'],
    'https://me.tail9.ts.net',
    null,
  ])
    assert.equal(ultraTailnetBase(none), '', JSON.stringify(none));
});

test('ultraNetworkPollTarget and ultraHelpLinkFor build the only URLs a link is used for', () => {
  assert.deepEqual(ultraNetworkPollTarget(link(SAM, T1)), {
    url: SAM + '/ultra/help/' + T1 + '/network',
    host: 'sam.tail9.ts.net',
    base: SAM,
  });
  assert.deepEqual(ultraNetworkPollTarget(link(ANN, T2) + '/'), {
    url: ANN + '/ultra/help/' + T2 + '/network',
    host: '100.64.1.2:44173',
    base: ANN,
  });
  for (const bad of [
    link('https://example.com', T1),
    link('http://sam.tail9.ts.net', T1),
    link('http://192.168.1.5:44173', T1),
    link('https://127.0.0.1', T1),
    T1,
    '',
    null,
  ]) {
    assert.equal(ultraNetworkPollTarget(bad), null, String(bad));
  }
  assert.equal(ultraHelpLinkFor(SAM, T1), link(SAM, T1));
  assert.equal(ultraHelpLinkFor(SAM + '/', T1), link(SAM, T1));
  assert.equal(ultraHelpLinkFor(ANN, T2), link(ANN, T2));
  assert.equal(ultraHelpLinkFor(SAM + '/path', T1), '');
  assert.equal(ultraHelpLinkFor('https://u:p@sam.tail9.ts.net', T1), '');
  assert.equal(ultraHelpLinkFor(SAM, T1.slice(5)), '');
  assert.equal(ultraHelpLinkFor('', T1), '');
  assert.equal(ultraHelpLinkFor(null, null), '');
});

test('ultraDirectoryUrl keeps an https address anywhere public and rewrites a GitHub page to raw', () => {
  const raw = 'https://raw.githubusercontent.com/g/r/main/ultra-directory.json';
  assert.equal(ultraDirectoryUrl(raw), raw);
  assert.equal(ultraDirectoryUrl('  ' + raw + '  '), raw);
  assert.equal(
    ultraDirectoryUrl('https://github.com/g/r/blob/main/ultra-directory.json'),
    raw,
  );
  assert.equal(
    ultraDirectoryUrl('https://github.com/g/r/blob/main/dir/ultra dir.json'),
    'https://raw.githubusercontent.com/g/r/main/dir/ultra%20dir.json',
  );
  assert.equal(
    ultraDirectoryUrl(
      'https://github.com/g/r/blob/main/ultra-directory.json#L3',
    ),
    raw,
  );
  assert.equal(
    ultraDirectoryUrl('https://example.com/dir.json?v=2#frag'),
    'https://example.com/dir.json?v=2',
  );
  assert.equal(
    ultraDirectoryUrl('https://files.tail0demo0.ts.net/dir.json'),
    'https://files.tail0demo0.ts.net/dir.json',
  );
  assert.equal(
    ultraDirectoryUrl('https://8.8.8.8/dir.json'),
    'https://8.8.8.8/dir.json',
  );
  // A GitHub page that is not a file page is left as an https URL.
  assert.equal(
    ultraDirectoryUrl('https://github.com/g/r'),
    'https://github.com/g/r',
  );
  for (const bad of [
    'http://raw.githubusercontent.com/g/r/main/ultra-directory.json',
    'ftp://example.com/dir.json',
    'https://user:pw@example.com/dir.json',
    'https://user@example.com/dir.json',
    'https://localhost/dir.json',
    'https://x.localhost/dir.json',
    'https://127.0.0.1/dir.json',
    'https://10.0.0.7/dir.json',
    'https://192.168.1.5/dir.json',
    'https://172.16.0.9/dir.json',
    'https://172.31.255.255/dir.json',
    'https://169.254.1.1/dir.json',
    'https://0.0.0.0/dir.json',
    'https://224.0.0.1/dir.json',
    'https://[::1]/dir.json',
    'https://van.local/dir.json',
    'https://intranet/dir.json',
    'example.com/dir.json',
    'https://',
    'https://x'.padEnd(2100, 'a') + '.example.com/x',
    '',
    ' ',
    null,
    undefined,
    42,
  ]) {
    assert.equal(ultraDirectoryUrl(bad), '', String(bad));
  }
  assert.equal(
    displayDirectoryUrl('https://example.com/d.json?token=abc#x'),
    'https://example.com/d.json',
  );
  assert.equal(displayDirectoryUrl(''), '');
  assert.equal(displayDirectoryUrl('junk'), '');
  assert.equal(displayDirectoryUrl(null), '');
});

test('ultraDirectoryUrl reads a Hugging Face file page or download address from its raw address', () => {
  // The download address answers with a redirect and the page with HTML;
  // the directory is read with no redirect followed, so both go to /raw/.
  const raw =
    'https://huggingface.co/datasets/g/r/raw/main/ultra-directory.json';
  assert.equal(ultraDirectoryUrl(raw), raw);
  assert.equal(
    ultraDirectoryUrl(
      'https://huggingface.co/datasets/g/r/blob/main/ultra-directory.json',
    ),
    raw,
  );
  assert.equal(
    ultraDirectoryUrl(
      'https://huggingface.co/datasets/g/r/resolve/main/ultra-directory.json?download=true#top',
    ),
    raw,
  );
  assert.equal(
    ultraDirectoryUrl('https://hf.co/g/r/blob/main/dir/ultra dir.json'),
    'https://huggingface.co/g/r/raw/main/dir/ultra%20dir.json',
  );
  assert.equal(
    ultraDirectoryUrl(
      'https://www.huggingface.co/spaces/g/r/resolve/v2/ultra-directory.json',
    ),
    'https://huggingface.co/spaces/g/r/raw/v2/ultra-directory.json',
  );
  // Anything that is not a file address is left as it is.
  for (const kept of [
    'https://huggingface.co/datasets/g/r',
    'https://huggingface.co/g/r/blob/main',
    'https://huggingface.co/g/r/tree/main/ultra-directory.json',
  ]) {
    assert.equal(ultraDirectoryUrl(kept), kept);
  }
  assert.equal(
    ultraDirectoryUrl('http://huggingface.co/g/r/blob/main/dir.json'),
    '',
  );
});

test('ultraNetworkEntryId and the network seal keep a peer token apart from the owner store', () => {
  assert.equal(ultraNetworkEntryId(fixedBytes(0xab)), 'n-abababababababab');
  assert.match(ultraNetworkEntryId(), ULTRA_NETWORK_ID_PATTERN);
  assert.notEqual(ultraNetworkEntryId(), ultraNetworkEntryId());
  const id = 'n-0000000000000001';
  const sealed = sealUltraNetworkToken(T1, KEY, {
    id,
    randomBytes: fixedBytes(3),
  });
  assert.deepEqual(Object.keys(sealed).sort(), ['data', 'iv', 'tag', 'v']);
  assert.ok(!JSON.stringify(sealed).includes(T1));
  assert.equal(openUltraNetworkToken(sealed, KEY, { id }), T1);
  assert.equal(openUltraToken(sealed, KEY, { id, aad: ULTRA_NETWORK_AAD }), T1);
  // Neither store opens the other's blob, and the entry id is bound in.
  assert.equal(openUltraToken(sealed, KEY, { id }), null);
  assert.equal(
    openUltraNetworkToken(sealUltraToken(T1, KEY, { id }), KEY, { id }),
    null,
  );
  assert.equal(
    openUltraNetworkToken(sealed, KEY, { id: 'n-0000000000000002' }),
    null,
  );
  assert.equal(
    openUltraNetworkToken(sealed, Buffer.alloc(32, 9), { id }),
    null,
  );
  assert.equal(openUltraNetworkToken(null, KEY, { id }), null);
});

test('ultraIncident, ultraCoordinatesPlace and ultraClockTime are the small words the rows use', () => {
  assert.equal(ultraIncident('fire'), 'fire');
  assert.equal(ultraIncident(' Threat '), 'threat');
  assert.equal(ultraIncident('medical'), 'medical');
  assert.equal(ultraIncident('other'), 'other');
  for (const bad of ['bomb', 'smoke', '', null, undefined, 7, {}, ['fire']])
    assert.equal(ultraIncident(bad), 'other', String(bad));
  assert.equal(
    ultraCoordinatesPlace({ lat: 45.2744, lon: -66.0622 }),
    '45.2744, -66.0622',
  );
  assert.equal(
    ultraCoordinatesPlace({ lat: 45.27, lon: -66.06 }),
    '45.2700, -66.0600',
  );
  assert.equal(ultraCoordinatesPlace({ lat: 0, lon: 0 }), '');
  assert.equal(ultraCoordinatesPlace({ lat: 91, lon: 0 }), '');
  assert.equal(ultraCoordinatesPlace(null), '');
  assert.equal(ultraClockTime(NOW), hhmm(NOW));
  assert.equal(ultraClockTime('x'), '');
  assert.equal(
    ultraClockTime(null),
    '00:00'.length === 5 ? ultraClockTime(0) : '',
  );
});

test('newUltraRelease records a press and keeps the start when it extends one', () => {
  const fix = { lat: 45.27, lon: -66.06, at: NOW - 5000 };
  const first = newUltraRelease({
    now: NOW,
    fix,
    feedId: 'security-van',
    incident: 'fire',
  });
  assert.deepEqual(first, {
    at: NOW,
    until: NOW + 14_400_000,
    lat: 45.27,
    lon: -66.06,
    fixAt: NOW - 5000,
    renewedAt: NOW,
    feedId: 'security-van',
    incident: 'fire',
  });
  const later = NOW + 60_000;
  const extended = newUltraRelease({
    now: later,
    fix: { lat: 45.3, lon: -66.1, at: later - 1000 },
    feedId: 'security-van',
    incident: 'medical',
    previous: first,
  });
  assert.deepEqual(extended, {
    at: NOW,
    until: later + 14_400_000,
    lat: 45.3,
    lon: -66.1,
    fixAt: later - 1000,
    renewedAt: later,
    feedId: 'security-van',
    incident: 'medical',
  });
  // EXTEND HELP with a fix older than the one the call already carries
  // keeps the newer position: a renewal never moves a call backwards.
  const behind = newUltraRelease({
    now: later + 60_000,
    fix: { lat: 44, lon: -65, at: NOW - 3_600_000 },
    feedId: 'security-van',
    incident: 'medical',
    previous: extended,
  });
  assert.deepEqual(
    [behind.lat, behind.lon, behind.fixAt, behind.renewedAt, behind.at],
    [45.3, -66.1, later - 1000, later + 60_000, NOW],
  );
  // A new press (no previous call) takes the fix it is given, whatever its age.
  assert.equal(
    newUltraRelease({
      now: later,
      fix: { lat: 44, lon: -65, at: NOW - 3_600_000 },
      feedId: 'security-home',
      previous: extended,
    }).lat,
    44,
  );
  // Another feed, or an expired previous release, starts afresh.
  assert.equal(
    newUltraRelease({
      now: later,
      fix,
      feedId: 'security-home',
      incident: 'fire',
      previous: first,
    }).at,
    later,
  );
  assert.equal(
    newUltraRelease({
      now: NOW + 14_400_000,
      fix,
      feedId: 'security-van',
      incident: 'fire',
      previous: first,
    }).at,
    NOW + 14_400_000,
  );
  assert.equal(
    newUltraRelease({ now: NOW, fix, feedId: 'security-van', previous: 'x' })
      .at,
    NOW,
  );
  // The incident is one of four words; a fix without a position is no release.
  assert.equal(
    newUltraRelease({ now: NOW, fix, feedId: 'f', incident: 'bomb' }).incident,
    'other',
  );
  assert.equal(
    newUltraRelease({ now: NOW, fix, feedId: 'f' }).incident,
    'other',
  );
  assert.equal(
    newUltraRelease({ now: NOW, fix: { lat: 0, lon: 0 }, feedId: 'f' }),
    null,
  );
  assert.equal(
    newUltraRelease({ now: NOW, fix: { lat: 91, lon: 1 }, feedId: 'f' }),
    null,
  );
  assert.equal(newUltraRelease({ now: NOW, fix: null, feedId: 'f' }), null);
  assert.equal(newUltraRelease({ now: NaN, fix, feedId: 'f' }), null);
  assert.equal(
    newUltraRelease({ now: NOW, fix: { lat: 1, lon: 2 }, feedId: 'f' }).fixAt,
    NOW,
  );
  assert.equal(
    newUltraRelease({ now: NOW, fix, feedId: 'f'.repeat(100) }).feedId.length,
    80,
  );
});

test('normalizeUltraRelease keeps a live release in shape and drops an expired or unusable one', () => {
  const stored = {
    at: NOW - 1000,
    until: NOW + 1000,
    lat: 45.27,
    lon: -66.06,
    fixAt: NOW - 2000,
    renewedAt: NOW - 500,
    feedId: 'security-van',
    incident: 'fire',
  };
  assert.deepEqual(normalizeUltraRelease(stored, NOW), stored);
  assert.deepEqual(
    normalizeUltraRelease(
      {
        ...stored,
        at: String(stored.at),
        until: String(stored.until),
        lat: '45.27',
        lon: '-66.06',
        fixAt: undefined,
        renewedAt: undefined,
        feedId: 'f'.repeat(100),
        incident: 'smoke',
        extra: true,
      },
      NOW,
    ),
    {
      ...stored,
      fixAt: NOW - 1000,
      // A file from before EXTEND was stamped: renewed at the press.
      renewedAt: NOW - 1000,
      feedId: 'f'.repeat(80),
      incident: 'other',
    },
  );
  // A renewal stamp is held between the press and the window's end.
  assert.equal(
    normalizeUltraRelease({ ...stored, renewedAt: NOW - 9000 }, NOW).renewedAt,
    NOW - 1000,
  );
  assert.equal(
    normalizeUltraRelease({ ...stored, renewedAt: NOW + 9000 }, NOW).renewedAt,
    NOW + 1000,
  );
  for (const bad of [
    { ...stored, until: NOW },
    { ...stored, until: NOW - 1 },
    { ...stored, until: 'soon' },
    { ...stored, until: null },
    { ...stored, at: null },
    { ...stored, at: 'x' },
    { ...stored, lat: 91 },
    { ...stored, lat: 0, lon: 0 },
    { ...stored, lat: null },
    { ...stored, lon: 'west' },
    null,
    undefined,
    'text',
    7,
    [],
  ]) {
    assert.equal(normalizeUltraRelease(bad, NOW), null, JSON.stringify(bad));
  }
});

test('ultraReleaseAnswer is exactly one of two shapes and serves the newest usable fix', () => {
  const release = {
    at: NOW - 10_000,
    until: NOW + 100,
    lat: 45.27,
    lon: -66.06,
    fixAt: NOW - 12_000,
    feedId: 'security-van',
    incident: 'fire',
  };
  const quiet = { released: false };
  assert.deepEqual(
    ultraReleaseAnswer({ release: null, name: 'Van 7', now: NOW }),
    quiet,
  );
  assert.deepEqual(ultraReleaseAnswer({ name: 'Van 7', now: NOW }), quiet);
  assert.deepEqual(ultraReleaseAnswer(), quiet);
  assert.deepEqual(
    ultraReleaseAnswer({ release, name: 'Van 7', now: NOW + 100 }),
    quiet,
  );
  assert.deepEqual(
    ultraReleaseAnswer({ release, name: 'Van 7', now: NOW, feedId: 'other' }),
    quiet,
  );
  assert.deepEqual(
    ultraReleaseAnswer({
      release: { ...release, lat: 91 },
      name: 'Van 7',
      now: NOW,
    }),
    quiet,
  );
  const answer = ultraReleaseAnswer({ release, name: 'Van 7', now: NOW });
  assert.deepEqual(Object.keys(answer), [
    'released',
    'name',
    'lat',
    'lon',
    'at',
    'until',
    'incident',
  ]);
  assert.deepEqual(answer, {
    released: true,
    name: 'Van 7',
    lat: 45.27,
    lon: -66.06,
    at: NOW - 10_000,
    until: NOW + 100,
    incident: 'fire',
  });
  assert.deepEqual(
    ultraReleaseAnswer({
      release,
      name: 'Van 7',
      now: NOW,
      feedId: 'security-van',
    }),
    answer,
  );
  // A newer phone fix moves the position and the time; an older one does not.
  const live = ultraReleaseAnswer({
    release,
    fix: { lat: 45.3, lon: -66.1, at: NOW - 1000 },
    name: 'Van 7',
    now: NOW,
  });
  assert.equal(live.lat, 45.3);
  assert.equal(live.lon, -66.1);
  assert.equal(live.at, NOW - 1000);
  const stale = ultraReleaseAnswer({
    release,
    fix: { lat: 45.3, lon: -66.1, at: NOW - 20_000 },
    name: 'Van 7',
    now: NOW,
  });
  assert.equal(stale.lat, 45.27);
  assert.equal(stale.at, NOW - 10_000);
  // `at` is never older than the press even when the stored fix is.
  assert.equal(
    ultraReleaseAnswer({
      release: { ...release, fixAt: NOW - 60_000 },
      name: 'Van 7',
      now: NOW,
    }).at,
    NOW - 10_000,
  );
  // EXTEND HELP moves `at` to the renewal even with no new fix, so a
  // receiver never reads an extended call as more than four hours stale.
  assert.equal(
    ultraReleaseAnswer({
      release: { ...release, renewedAt: NOW - 2000 },
      name: 'Van 7',
      now: NOW,
    }).at,
    NOW - 2000,
  );
  // A newer fix that is unusable makes the whole answer quiet.
  assert.deepEqual(
    ultraReleaseAnswer({
      release,
      fix: { lat: 91, lon: 0, at: NOW - 1000 },
      name: 'Van 7',
      now: NOW,
    }),
    quiet,
  );
  // The name is cleaned, cut at 60 and never empty; the incident is one of four.
  assert.equal(
    ultraReleaseAnswer({ release, name: '', now: NOW }).name,
    'Ultra',
  );
  assert.equal(ultraReleaseAnswer({ release, now: NOW }).name, 'Ultra');
  assert.equal(
    ultraReleaseAnswer({ release, name: 'x'.repeat(80), now: NOW }).name.length,
    60,
  );
  assert.equal(
    ultraReleaseAnswer({ release, name: 'Van\u0000 7', now: NOW }).name,
    'Van 7',
  );
  assert.equal(
    ultraReleaseAnswer({
      release: { ...release, incident: 'bomb' },
      name: 'Van 7',
      now: NOW,
    }).incident,
    'other',
  );
  assert.deepEqual(
    ultraReleaseAnswer({ release, name: 'Van 7', now: NaN }),
    quiet,
  );
});

test('an extended call stays a call on the receiver past four hours from the first press', () => {
  // The phone reported until ten minutes after the press, then went quiet;
  // the owner pressed EXTEND HELP on the desktop at 3 h 50 with no new fix.
  const HOUR = 3_600_000;
  const press = newUltraRelease({
    now: NOW,
    fix: { lat: 45.27, lon: -66.06, at: NOW + 10 * 60_000 },
    feedId: 'security-van',
    incident: 'threat',
  });
  const extendAt = NOW + 3 * HOUR + 50 * 60_000;
  const extended = newUltraRelease({
    now: extendAt,
    fix: { lat: 45.27, lon: -66.06, at: NOW + 10 * 60_000 },
    feedId: 'security-van',
    incident: 'threat',
    previous: press,
  });
  for (const minutes of [1, 15, 60, 3 * 60]) {
    const now = extendAt + minutes * 60_000;
    const served = ultraReleaseAnswer({
      release: extended,
      name: 'Van 7',
      now,
    });
    assert.equal(served.released, true);
    const read = normalizeUltraNetworkAnswer(served, { now });
    assert.equal(read.state, 'released', `${minutes} min after EXTEND`);
    assert.ok(read.release.until > now);
  }
});

test('normalizeUltraNetworkAnswer trusts nothing a peer sends', () => {
  const options = { now: NOW, entryName: 'Sam' };
  // Not a readable answer at all.
  for (const bad of [
    { released: 'yes' },
    { released: 'true' },
    { released: 1 },
    { released: null },
    {},
    null,
    undefined,
    [],
    [{ released: false }],
    'text',
    7,
  ]) {
    assert.equal(
      normalizeUltraNetworkAnswer(bad, options),
      null,
      JSON.stringify(bad),
    );
  }
  assert.equal(normalizeUltraNetworkAnswer(peerRelease(), { now: NaN }), null);
  // Quiet, whatever else rides along.
  assert.deepEqual(normalizeUltraNetworkAnswer({ released: false }, options), {
    state: 'quiet',
  });
  assert.deepEqual(
    normalizeUltraNetworkAnswer(
      { released: false, lat: 45, lon: -66, name: 'x', message: 'y' },
      options,
    ),
    { state: 'quiet' },
  );
  // A full release: the window is re-based on this clock and clamped.
  assert.deepEqual(normalizeUltraNetworkAnswer(peerRelease(), options), {
    state: 'released',
    release: {
      name: 'Van 7',
      lat: 45.27,
      lon: -66.06,
      at: NOW - 5000,
      until: NOW + ULTRA_RELEASE_WINDOW_MS,
      incident: 'fire',
    },
  });
  const skewed = normalizeUltraNetworkAnswer(
    peerRelease({ at: NOW + 3_600_000, until: NOW + 3_600_000 + 1_800_000 }),
    options,
  );
  assert.equal(skewed.state, 'released');
  assert.equal(skewed.release.until, NOW + 1_800_000);
  assert.equal(skewed.release.at, NOW + 3_600_000);
  assert.equal(
    normalizeUltraNetworkAnswer(
      peerRelease({ at: NOW - 1000, until: NOW - 1000 + 36_000_000 }),
      options,
    ).release.until,
    NOW + ULTRA_RELEASE_WINDOW_MS,
  );
  // A window closed on their clock beyond the margin, or an `at` beyond the window plus the margin, is quiet.
  const quiet = { state: 'quiet' };
  assert.deepEqual(
    normalizeUltraNetworkAnswer(
      peerRelease({ at: NOW, until: NOW - ULTRA_CLOCK_MARGIN_MS }),
      options,
    ),
    quiet,
  );
  assert.deepEqual(
    normalizeUltraNetworkAnswer(
      peerRelease({ at: NOW, until: NOW - 3_600_000 }),
      options,
    ),
    quiet,
  );
  const grace = normalizeUltraNetworkAnswer(
    peerRelease({ at: NOW, until: NOW - ULTRA_CLOCK_MARGIN_MS + 1 }),
    options,
  );
  assert.equal(grace.state, 'released');
  assert.equal(grace.release.until, NOW);
  const edge = ULTRA_RELEASE_WINDOW_MS + ULTRA_CLOCK_MARGIN_MS;
  assert.deepEqual(
    normalizeUltraNetworkAnswer(
      peerRelease({ at: NOW - edge - 1, until: NOW + 1000 }),
      options,
    ),
    quiet,
  );
  assert.deepEqual(
    normalizeUltraNetworkAnswer(
      peerRelease({ at: NOW - 5 * 3_600_000, until: NOW + 1000 }),
      options,
    ),
    quiet,
  );
  assert.deepEqual(
    normalizeUltraNetworkAnswer(
      peerRelease({ at: NOW + edge + 1, until: NOW + edge + 1001 }),
      options,
    ),
    quiet,
  );
  assert.equal(
    normalizeUltraNetworkAnswer(
      peerRelease({ at: NOW - edge, until: NOW - edge + 1000 }),
      options,
    ).state,
    'released',
  );
  // Positions and times must be real numbers in range.
  for (const junk of [
    { lat: 91 },
    { lon: -181 },
    { lat: 0, lon: 0 },
    { lat: '45.27' },
    { lon: '-66.06' },
    { lat: NaN },
    { lat: Infinity },
    { lat: null },
    { lat: undefined },
    { lat: [45.27] },
    { at: String(NOW - 5000) },
    { at: 'soon' },
    { at: NaN },
    { at: null },
    { until: String(NOW + 1000) },
    { until: null },
    { until: undefined },
    { until: {} },
  ]) {
    const body = peerRelease(junk);
    delete body.__none;
    for (const key of Object.keys(junk))
      if (junk[key] === undefined) delete body[key];
    assert.deepEqual(
      normalizeUltraNetworkAnswer(body, options),
      quiet,
      JSON.stringify(junk),
    );
  }
  // The name is cleaned and cut, falling back to the home-list name; the incident is one of four.
  assert.equal(
    normalizeUltraNetworkAnswer(
      peerRelease({ name: 'x'.repeat(10_000) }),
      options,
    ).release.name,
    'x'.repeat(60),
  );
  assert.equal(
    normalizeUltraNetworkAnswer(peerRelease({ name: '' }), options).release
      .name,
    'Sam',
  );
  assert.equal(
    normalizeUltraNetworkAnswer(peerRelease({ name: undefined }), options)
      .release.name,
    'Sam',
  );
  assert.equal(
    normalizeUltraNetworkAnswer(peerRelease({ name: 7 }), options).release.name,
    '7',
  );
  assert.equal(
    normalizeUltraNetworkAnswer(peerRelease({ name: { a: 1 } }), options)
      .release.name,
    'Sam',
  );
  assert.equal(
    normalizeUltraNetworkAnswer(
      peerRelease({ name: '<b>x</b>\u0000' }),
      options,
    ).release.name,
    '<b>x</b>',
  );
  assert.equal(
    normalizeUltraNetworkAnswer(peerRelease(), { now: NOW }).release.name,
    'Van 7',
  );
  assert.equal(
    normalizeUltraNetworkAnswer(peerRelease({ name: '' }), { now: NOW }).release
      .name,
    '',
  );
  assert.equal(
    normalizeUltraNetworkAnswer(peerRelease({ incident: 'bomb' }), options)
      .release.incident,
    'other',
  );
  assert.equal(
    normalizeUltraNetworkAnswer(peerRelease({ incident: undefined }), options)
      .release.incident,
    'other',
  );
  // Nothing else a peer adds survives.
  const extra = normalizeUltraNetworkAnswer(
    peerRelease({ message: 'x', number: '+15065550100', camera: true }),
    options,
  );
  assert.deepEqual(Object.keys(extra.release).sort(), [
    'at',
    'incident',
    'lat',
    'lon',
    'name',
    'until',
  ]);
});

test('normalizeUltraNetworkAnswer measures what is left of a call on the peer’s own clock', () => {
  // Pressed four hours less a minute ago, and the phone has not reported
  // since, so their `at` is still the press: a minute is all that is left.
  const lastMinute = peerRelease({
    at: NOW - ULTRA_RELEASE_WINDOW_MS + 60_000,
    until: NOW + 60_000,
  });
  assert.equal(
    normalizeUltraNetworkAnswer(lastMinute, { now: NOW, peerNow: NOW }).release
      .until,
    NOW + 60_000,
  );
  // A peer clock ninety seconds behind ours: still what is left on theirs.
  assert.equal(
    normalizeUltraNetworkAnswer(lastMinute, { now: NOW, peerNow: NOW - 90_000 })
      .release.until,
    NOW + 150_000,
  );
  // With no Date header it falls back to their `at`, as before.
  assert.equal(
    normalizeUltraNetworkAnswer(lastMinute, { now: NOW }).release.until,
    NOW + ULTRA_RELEASE_WINDOW_MS,
  );
  // A Date header that lies gains nothing: still four hours at most, and a
  // window closed on it past the margin is quiet.
  assert.equal(
    normalizeUltraNetworkAnswer(lastMinute, {
      now: NOW,
      peerNow: NOW - 10 * ULTRA_RELEASE_WINDOW_MS,
    }).release.until,
    NOW + ULTRA_RELEASE_WINDOW_MS,
  );
  assert.deepEqual(
    normalizeUltraNetworkAnswer(lastMinute, {
      now: NOW,
      peerNow: NOW + 60_000 + ULTRA_CLOCK_MARGIN_MS,
    }),
    { state: 'quiet' },
  );
  // Anything that is not a number is no clock at all.
  assert.equal(
    normalizeUltraNetworkAnswer(lastMinute, { now: NOW, peerNow: 'soon' })
      .release.until,
    NOW + ULTRA_RELEASE_WINDOW_MS,
  );
});

test('ultraPollOutcome schedules the next poll and backs off unreachable links', () => {
  assert.deepEqual(
    ultraPollOutcome({
      status: 200,
      answer: { state: 'quiet' },
      failures: 3,
      now: NOW,
    }),
    { state: 'quiet', nextAt: NOW + 20_000, failures: 0 },
  );
  assert.deepEqual(
    ultraPollOutcome({
      status: 200,
      answer: { state: 'released', release: {} },
      now: NOW,
    }),
    { state: 'released', nextAt: NOW + 20_000, failures: 0 },
  );
  assert.deepEqual(ultraPollOutcome({ status: 404, failures: 2, now: NOW }), {
    state: 'dead',
    nextAt: NOW + 600_000,
    failures: 2,
  });
  assert.deepEqual(ultraPollOutcome({ status: 429, failures: 2, now: NOW }), {
    state: 'busy',
    nextAt: NOW + 60_000,
    failures: 2,
  });
  // Everything else backs off: 20, 40, 80, 160, 320, 600, 600 seconds.
  const waits = [];
  let failures = 0;
  for (let i = 0; i < 7; i += 1) {
    const out = ultraPollOutcome({ status: 503, failures, now: NOW });
    assert.equal(out.state, 'unreachable');
    assert.equal(out.failures, failures + 1);
    waits.push((out.nextAt - NOW) / 1000);
    failures = out.failures;
  }
  assert.deepEqual(waits, [20, 40, 80, 160, 320, 600, 600]);
  for (const status of [null, undefined, 0, 500, 301, 200, '200', 'x']) {
    const out = ultraPollOutcome({ status, answer: null, now: NOW });
    assert.equal(out.state, 'unreachable', String(status));
    assert.equal(out.nextAt, NOW + 20_000);
    assert.equal(out.failures, 1);
  }
  // A 200 whose answer is unreadable, or names no state, is unreachable too.
  assert.equal(
    ultraPollOutcome({ status: 200, answer: { state: 'off' }, now: NOW }).state,
    'unreachable',
  );
  assert.equal(
    ultraPollOutcome({ status: 200, answer: 'quiet', now: NOW }).state,
    'unreachable',
  );
  assert.equal(
    ultraPollOutcome({ status: 503, failures: 'many', now: NOW }).failures,
    1,
  );
  assert.equal(
    ultraPollOutcome({ status: 503, failures: -4, now: NOW }).failures,
    1,
  );
});

test('ultraEpisodeDecision opens, updates, ends or leaves the NEEDS HELP row', () => {
  const released = { state: 'released', release: {} };
  const quiet = { state: 'quiet' };
  const row = 'm-0123456789abcdef';
  assert.equal(
    ultraEpisodeDecision({ entry: {}, answer: released, now: NOW }),
    'new',
  );
  assert.equal(ultraEpisodeDecision({ answer: released, now: NOW }), 'new');
  assert.equal(
    ultraEpisodeDecision({
      entry: { episodeId: row, episodeUntil: NOW + 1000 },
      answer: released,
      now: NOW,
    }),
    'update',
  );
  // Inside the ten-minute gap after an end the row is reused; without a row nothing happens.
  assert.equal(
    ultraEpisodeDecision({
      entry: {
        episodeId: row,
        episodeUntil: NOW - 1000,
        lastEpisodeAt: NOW - 1000,
      },
      answer: released,
      now: NOW,
    }),
    'update',
  );
  assert.equal(
    ultraEpisodeDecision({
      entry: { episodeId: row, episodeUntil: NOW - 599_999 },
      answer: released,
      now: NOW,
    }),
    'update',
  );
  assert.equal(
    ultraEpisodeDecision({
      entry: { episodeId: null, lastEpisodeAt: NOW - 1000 },
      answer: released,
      now: NOW,
    }),
    'none',
  );
  assert.equal(
    ultraEpisodeDecision({
      entry: { lastEpisodeAt: NOW - 599_999 },
      answer: released,
      now: NOW,
    }),
    'none',
  );
  // Past the gap a released answer is a new call.
  assert.equal(
    ultraEpisodeDecision({
      entry: {
        episodeId: row,
        episodeUntil: NOW - 600_000,
        lastEpisodeAt: NOW - 600_000,
      },
      answer: released,
      now: NOW,
    }),
    'new',
  );
  assert.equal(
    ultraEpisodeDecision({
      entry: { lastEpisodeAt: NOW - 600_000 },
      answer: released,
      now: NOW,
    }),
    'new',
  );
  // Quiet ends an active episode and nothing else.
  assert.equal(
    ultraEpisodeDecision({
      entry: { episodeId: row, episodeUntil: NOW + 1 },
      answer: quiet,
      now: NOW,
    }),
    'end',
  );
  assert.equal(
    ultraEpisodeDecision({
      entry: { episodeId: row, episodeUntil: NOW },
      answer: quiet,
      now: NOW,
    }),
    'none',
  );
  assert.equal(
    ultraEpisodeDecision({ entry: {}, answer: quiet, now: NOW }),
    'none',
  );
  assert.equal(
    ultraEpisodeDecision({ entry: {}, answer: null, now: NOW }),
    'none',
  );
  assert.equal(
    ultraEpisodeDecision({ entry: {}, answer: { state: 'off' }, now: NOW }),
    'none',
  );
  assert.equal(ultraEpisodeDecision(), 'none');
});

test('ultraReleaseInboxRecord opens a row that the inbox normaliser keeps as it is', () => {
  const answer = normalizeUltraNetworkAnswer(peerRelease(), {
    now: NOW,
    entryName: 'Sam',
  });
  const ids = { message: () => 'm-0123456789abcdef' };
  const row = ultraReleaseInboxRecord({
    entry: entry(),
    answer,
    now: NOW,
    ids,
  });
  const coordinates = '45.2700, -66.0600';
  assert.deepEqual(row, {
    id: 'm-0123456789abcdef',
    tokenId: '',
    kind: 'release',
    networkId: 'n-0000000000000001',
    label: 'Sam',
    from: 'Van 7',
    number: '',
    text: ultraHelpMessage(coordinates, 'fire'),
    place: coordinates,
    incident: 'fire',
    lat: 45.27,
    lon: -66.06,
    at: NOW,
    until: NOW + ULTRA_RELEASE_WINDOW_MS,
    sms: '',
    deliveredAt: null,
    readAt: null,
  });
  assert.equal(
    row.text,
    'Please HELP you are close by, to 45.2700, -66.0600 of victim in progress, fire thank you.',
  );
  assert.deepEqual(normalizeUltraInboxRecord(row), row);
  // With the receiver's geocode: the place and the plea composed from it.
  const placed = ultraReleaseInboxRecord({
    entry: entry(),
    answer,
    now: NOW,
    place: PLACE,
    plea: ultraHelpMessage(PLACE, 'fire'),
    ids,
  });
  assert.equal(placed.place, PLACE);
  assert.equal(
    placed.text,
    'Please HELP you are close by, to 10 Example St, Saint John, New Brunswick (45.2744, -66.0622) of victim in progress, fire thank you.',
  );
  assert.equal(
    ultraReleaseInboxRecord({
      entry: entry(),
      answer,
      now: NOW,
      place: PLACE,
      ids,
    }).text,
    ultraHelpMessage(PLACE, 'fire'),
  );
  // The release itself is accepted in place of the whole answer; the name falls back to the label.
  assert.equal(
    ultraReleaseInboxRecord({
      entry: entry(),
      answer: { ...answer.release, name: '' },
      now: NOW,
      ids,
    }).from,
    'Sam',
  );
  assert.equal(
    ultraReleaseInboxRecord({
      entry: entry(),
      answer,
      now: NOW,
      ids: () => 'm-ffffffffffffffff',
    }).id,
    'm-ffffffffffffffff',
  );
  assert.equal(
    ultraReleaseInboxRecord({
      entry: entry(),
      answer,
      now: NOW,
      ids: { randomBytes: fixedBytes(0xee) },
    }).id,
    'm-eeeeeeeeeeeeeeee',
  );
  assert.match(
    ultraReleaseInboxRecord({ entry: entry(), answer, now: NOW }).id,
    /^m-[0-9a-f]{16}$/,
  );
  assert.equal(
    ultraReleaseInboxRecord({ entry: entry(), answer: null, now: NOW, ids }),
    null,
  );
  assert.equal(
    ultraReleaseInboxRecord({
      entry: entry(),
      answer: { state: 'quiet' },
      now: NOW,
      ids,
    }),
    null,
  );
  assert.equal(
    ultraReleaseInboxRecord({
      entry: entry(),
      answer: { ...answer.release, lat: 91 },
      now: NOW,
      ids,
    }),
    null,
  );
  assert.equal(
    ultraReleaseInboxRecord({ entry: entry(), answer, now: NaN, ids }),
    null,
  );
});

test('ultraReleaseRowUpdate moves a row with the peer and re-stamps it only past 50 m', () => {
  const answer = normalizeUltraNetworkAnswer(peerRelease(), {
    now: NOW,
    entryName: 'Sam',
  });
  const row = ultraReleaseInboxRecord({
    entry: entry(),
    answer,
    now: NOW,
    place: PLACE,
    plea: ultraHelpMessage(PLACE, 'fire'),
    ids: { message: () => 'm-0123456789abcdef' },
  });
  const frozen = JSON.stringify(row);
  // Ten metres: the position follows, the time and the place do not.
  const near = ultraReleaseRowUpdate(
    row,
    { state: 'released', release: { ...answer.release, lat: 45.27009 } },
    { now: NOW + 20_000 },
  );
  assert.equal(near.lat, 45.27009);
  assert.equal(near.at, NOW);
  assert.equal(near.place, PLACE);
  assert.equal(near.text, row.text);
  assert.equal(near.until, row.until);
  assert.equal(JSON.stringify(row), frozen);
  // A hundred metres, a new window and a new name: the time moves to now.
  const far = ultraReleaseRowUpdate(
    row,
    {
      release: {
        ...answer.release,
        lat: 45.271,
        until: NOW + 100_000,
        name: 'Van Seven',
      },
    },
    { now: NOW + 40_000 },
  );
  assert.equal(far.lat, 45.271);
  assert.equal(far.at, NOW + 40_000);
  assert.equal(far.until, NOW + 100_000);
  assert.equal(far.from, 'Van Seven');
  assert.equal(far.place, PLACE);
  assert.equal(far.text, row.text);
  assert.equal(far.id, row.id);
  assert.equal(far.kind, 'release');
  // A new place recomposes the plea; a given plea wins.
  const other = '12 King St, Saint John, New Brunswick (45.2710, -66.0600)';
  const moved = ultraReleaseRowUpdate(row, answer, {
    place: other,
    now: NOW + 60_000,
  });
  assert.equal(moved.place, other);
  assert.equal(moved.text, ultraHelpMessage(other, 'fire'));
  assert.equal(moved.at, NOW);
  assert.equal(
    ultraReleaseRowUpdate(row, answer, {
      place: other,
      plea: 'custom',
      now: NOW,
    }).text,
    'custom',
  );
  // A changed incident recomposes with the row's place; an empty place falls back to coordinates.
  assert.equal(
    ultraReleaseRowUpdate(
      row,
      { ...answer.release, incident: 'medical' },
      { now: NOW },
    ).text,
    ultraHelpMessage(PLACE, 'medical'),
  );
  assert.equal(
    ultraReleaseRowUpdate(row, answer, { place: '', now: NOW }).place,
    '45.2700, -66.0600',
  );
  // An unusable position keeps the row's; an empty name keeps the row's.
  const kept = ultraReleaseRowUpdate(
    row,
    { ...answer.release, lat: 91, name: '' },
    { now: NOW + 5000 },
  );
  assert.equal(kept.lat, 45.27);
  assert.equal(kept.from, 'Van 7');
  assert.equal(kept.at, NOW);
  assert.deepEqual(normalizeUltraInboxRecord(far), far);
});

test('normalizeUltraNetworkStore keeps well-formed entries, one per token, at most 200', () => {
  const good = entry();
  assert.deepEqual(normalizeUltraNetworkEntry(good), good);
  const store = normalizeUltraNetworkStore({
    version: 1,
    me: { name: '  Jeff  ' },
    published: { tokenId: 't-0123456789abcdef', at: NOW, how: 'github' },
    entries: [good],
  });
  assert.deepEqual(store, {
    version: 1,
    me: { name: 'Jeff' },
    published: { tokenId: 't-0123456789abcdef', at: NOW, how: 'github' },
    entries: [good],
  });
  const dropped = [
    { ...good, id: 't-0000000000000001' },
    { ...good, id: 'n-000000000000000' },
    { ...good, id: 'n-000000000000000G' },
    { ...good, hash: good.hash.slice(1) },
    { ...good, hash: good.hash.toUpperCase() },
    { ...good, sealed: null },
    { ...good, sealed: 'text' },
    { ...good, sealed: { ...good.sealed, v: 2 } },
    {
      ...good,
      sealed: { ...good.sealed, iv: Buffer.alloc(16).toString('base64') },
    },
    {
      ...good,
      sealed: { ...good.sealed, tag: Buffer.alloc(12).toString('base64') },
    },
    { ...good, sealed: { ...good.sealed, data: '' } },
    { ...good, sealed: { ...good.sealed, data: 'not base64!' } },
    { ...good, sealed: { iv: good.sealed.iv, tag: good.sealed.tag } },
    { ...good, base: '' },
    { ...good, base: null },
    { ...good, base: 'sam.tail9.ts.net' },
    { ...good, base: SAM + '/ultra/help/' + T1 },
    { ...good, base: 'https://u:p@sam.tail9.ts.net' },
    { ...good, base: SAM + '?x=1' },
    { ...good, base: 'ftp://sam.tail9.ts.net' },
    null,
    'text',
    7,
    [],
  ];
  for (const item of dropped) {
    assert.equal(normalizeUltraNetworkEntry(item), null, JSON.stringify(item));
  }
  assert.deepEqual(
    normalizeUltraNetworkStore({ entries: dropped }).entries,
    [],
  );
  // Coercion: the host always comes from the base, the name from the host when empty, flags and state are checked.
  const loose = normalizeUltraNetworkEntry({
    ...good,
    name: '\u0000 ',
    host: 'evil.example.com',
    base: SAM + '/',
    source: 'stolen',
    addedAt: 'yesterday',
    lastPolledAt: String(NOW),
    lastState: 'exploded',
    directoryMissing: 'yes',
    moved: 1,
    extra: true,
  });
  assert.equal(loose.name, 'sam.tail9.ts.net');
  assert.equal(loose.host, 'sam.tail9.ts.net');
  assert.equal(loose.base, SAM);
  assert.equal(loose.source, 'manual');
  assert.equal(loose.addedAt, null);
  assert.equal(loose.lastPolledAt, NOW);
  assert.equal(loose.lastState, 'new');
  assert.equal(loose.directoryMissing, false);
  assert.equal(loose.moved, false);
  assert.equal('extra' in loose, false);
  assert.equal(
    normalizeUltraNetworkEntry({ ...good, name: 'x'.repeat(80) }).name.length,
    60,
  );
  assert.equal(
    normalizeUltraNetworkEntry({
      ...good,
      source: 'directory',
      lastState: 'missing',
    }).lastState,
    'missing',
  );
  // Junk at the top, a duplicate id, a duplicate hash under another id, and the cap.
  for (const junk of [
    null,
    'x',
    7,
    [],
    { entries: 'x' },
    { me: 'x', published: 'x' },
  ]) {
    assert.deepEqual(normalizeUltraNetworkStore(junk), {
      version: 1,
      me: { name: '' },
      published: null,
      entries: [],
    });
  }
  assert.equal(
    normalizeUltraNetworkStore({ entries: [good, { ...good }] }).entries.length,
    1,
  );
  assert.equal(
    normalizeUltraNetworkStore({
      entries: [good, entry({ id: 'n-0000000000000002' })],
    }).entries.length,
    1,
  );
  assert.equal(
    normalizeUltraNetworkStore({
      entries: [good, entry({ id: 'n-0000000000000002', token: T2 })],
    }).entries.length,
    2,
  );
  assert.equal(
    normalizeUltraNetworkStore({ published: { tokenId: 'x', at: NOW } })
      .published,
    null,
  );
  assert.deepEqual(
    normalizeUltraNetworkStore({
      published: { tokenId: 't-0123456789abcdef', at: NOW, how: 'x' },
    }).published,
    { tokenId: 't-0123456789abcdef', at: NOW, how: 'clipboard' },
  );
  const many = Array.from({ length: 250 }, (_, i) =>
    entry({
      id: 'n-' + i.toString(16).padStart(16, '0'),
      token: newUltraToken(fixedBytes(i)),
    }),
  );
  assert.equal(
    normalizeUltraNetworkStore({ entries: many }).entries.length,
    200,
  );
});

test('ultraNetworkPublicEntry never carries the base, the hash or the sealed blob', () => {
  const stored = entry({ lastPolledAt: NOW - 5000, lastState: 'quiet' });
  const row = ultraNetworkPublicEntry(stored, {}, NOW);
  assert.deepEqual(row, {
    id: 'n-0000000000000001',
    name: 'Sam',
    host: 'sam.tail9.ts.net',
    source: 'manual',
    addedAt: NOW - 1000,
    lastPolledAt: NOW - 5000,
    lastState: 'quiet',
    failures: 0,
    directoryMissing: false,
    moved: false,
    active: false,
  });
  for (const key of ['base', 'hash', 'sealed', 'link', 'token', 'policyMac'])
    assert.equal(key in row, false, key);
  assert.ok(!JSON.stringify(row).includes(T1));
  assert.ok(!JSON.stringify(row).includes(stored.hash));
  // Memory folds over the stored values.
  const live = ultraNetworkPublicEntry(
    stored,
    {
      lastPolledAt: NOW - 100,
      lastState: 'released',
      failures: 2.7,
      episodeId: 'm-0123456789abcdef',
      episodeUntil: NOW + 1000,
    },
    NOW,
  );
  assert.equal(live.lastPolledAt, NOW - 100);
  assert.equal(live.lastState, 'released');
  assert.equal(live.failures, 2);
  assert.equal(live.active, true);
  assert.equal(
    ultraNetworkPublicEntry(
      stored,
      { episodeId: 'm-0123456789abcdef', episodeUntil: NOW },
      NOW,
    ).active,
    false,
  );
  assert.equal(ultraNetworkPublicEntry(stored, { active: true }).active, true);
  assert.equal(
    ultraNetworkPublicEntry(stored, { lastState: 'exploded' }).lastState,
    'quiet',
  );
  assert.equal(ultraNetworkPublicEntry(stored, null).lastState, 'quiet');
  assert.equal(ultraNetworkPublicEntry(stored).active, false);
});

test('a home-list check covers the base, and a rewritten base is not polled', () => {
  const sam = entry();
  assert.deepEqual(normalizeUltraNetworkEntry(sam), sam);
  const stamped = stampUltraNetworkPolicy(sam, KEY);
  assert.equal(stamped.policyMac, ultraNetworkPolicyMac(stamped, KEY));
  assert.equal(ultraNetworkPolicyState(stamped, KEY), 'ok');
  const moved = { ...stamped, base: 'https://evil.tail9.ts.net' };
  assert.equal(ultraNetworkPolicyState(moved, KEY), 'bad');
  assert.equal(ultraNetworkPollAllowed(moved, [moved], KEY), false);
  const ann = stampUltraNetworkPolicy(
    entry({ id: 'n-0000000000000002', token: T2, base: ANN }),
    KEY,
  );
  const bare = entry();
  assert.equal(ultraNetworkPollAllowed(bare, [bare], KEY), true);
  assert.equal(ultraNetworkPollAllowed(bare, [bare, ann], KEY), false);
  assert.equal(ultraNetworkPollAllowed(ann, [bare, ann], KEY), true);
  assert.equal(
    normalizeUltraNetworkEntry(stamped).policyMac,
    stamped.policyMac,
  );
  assert.equal(
    normalizeUltraNetworkEntry({ ...sam, policyMac: 'nope' }).policyMac,
    'bad',
  );
  assert.equal('policyMac' in normalizeUltraNetworkEntry(sam), false);
  const row = ultraNetworkPublicEntry(stamped, {}, NOW);
  assert.equal('policyMac' in row, false);
  assert.equal('tampered' in row, false);
  assert.deepEqual(ultraNetworkTamperFlags([moved, ann], KEY), [true, false]);
  assert.deepEqual(ultraNetworkTamperFlags([bare, ann], KEY), [true, false]);
  assert.deepEqual(ultraNetworkTamperFlags([moved], Buffer.alloc(32, 1)), [
    false,
  ]);
});

test('the helpers-file check covers the number, the helpers and the releases, not the phone model', () => {
  const store = {
    version: 1,
    modelId: 'samsung-s22-ultra',
    contacts: [
      {
        id: 'other-+15065550100',
        label: 'Mum',
        number: '+15065550100',
        kind: 'other',
      },
    ],
    owner: { number: '+15065550199' },
    releases: [
      {
        feedId: 'security-van',
        at: NOW,
        until: NOW + 1000,
        lat: 45.27,
        lon: -66.06,
        fixAt: NOW,
        renewedAt: NOW,
        incident: 'fire',
      },
    ],
  };
  const policyMac = ultraHelpStorePolicyMac(store, KEY);
  assert.match(policyMac, /^[0-9a-f]{64}$/);
  assert.equal(ultraHelpStorePolicyState(store, KEY), 'legacy');
  assert.equal(ultraHelpStorePolicyState({ ...store, policyMac }, KEY), 'ok');
  assert.equal(
    ultraHelpStorePolicyState(
      { ...store, owner: { number: '+15065550100' }, policyMac },
      KEY,
    ),
    'bad',
  );
  assert.equal(
    ultraHelpStorePolicyState(
      { ...store, modelId: 'google-pixel', policyMac },
      KEY,
    ),
    'ok',
  );
  assert.equal(
    ultraHelpStorePolicyState({ ...store, policyMac: 'nope' }, KEY),
    'bad',
  );
});

test('the directory, relay and phone-package checks cover what would be sent', () => {
  const directory = ultraDirectoryPolicyMac(
    {
      url: 'https://raw.githubusercontent.com/group/repo/main/d.json',
      writeToken: 'github_pat_fixture',
    },
    KEY,
  );
  assert.match(directory, /^[0-9a-f]{64}$/);
  assert.notEqual(
    directory,
    ultraDirectoryPolicyMac(
      { url: 'https://evil.example/d.json', writeToken: 'github_pat_fixture' },
      KEY,
    ),
  );
  assert.notEqual(
    directory,
    ultraDirectoryPolicyMac(
      {
        url: 'https://raw.githubusercontent.com/group/repo/main/d.json',
        writeToken: 'other',
      },
      KEY,
    ),
  );
  // Two empty materials are the same check. Whether a URL is usable is decided before this.
  assert.equal(
    ultraDirectoryPolicyMac({ url: '', writeToken: '' }, KEY),
    ultraDirectoryPolicyMac({ url: '', writeToken: '' }, KEY),
  );
  const relayEnv = {
    TWILIO_ACCOUNT_SID: `AC${'f'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: 'auth-fixture',
    TWILIO_FROM_NUMBER: '+15065550000',
    ULTRA_SMS_RELAY_URL: 'https://sms.example/send',
    ULTRA_SMS_RELAY_TOKEN: 'gateway-fixture',
  };
  const relay = ultraSmsRelayMaterial(relayEnv);
  assert.equal(relay.url, 'https://sms.example/send');
  assert.equal(relay.token, 'gateway-fixture');
  assert.equal(relay.sid, relayEnv.TWILIO_ACCOUNT_SID);
  const movedGateway = ultraSmsRelayMaterial({
    ...relayEnv,
    ULTRA_SMS_RELAY_URL: 'https://evil.example/send',
  });
  assert.notEqual(
    ultraRelayPolicyMac(relay, KEY),
    ultraRelayPolicyMac(movedGateway, KEY),
  );
  const invalidGateway = ultraSmsRelayMaterial({
    ULTRA_SMS_RELAY_URL: 'http://evil.example/send',
    ULTRA_SMS_RELAY_TOKEN: 'gateway-fixture',
  });
  assert.equal(invalidGateway.url, '');
  assert.equal(invalidGateway.token, '');
  const phoneKey = 'a'.repeat(43);
  const van = {
    id: 'security-van',
    kind: 'security',
    name: 'Van 7',
    method: 'http-json',
    url: 'https://phone.example/pos',
    reportKey: phoneKey,
    lat: 45,
    lon: -66,
    follow: true,
    record: true,
    password: 'secret',
  };
  const tracker = {
    id: 'tracker-van',
    kind: 'tracker',
    name: 'Van',
    method: 'traccar',
    url: 'https://gps.example/api/positions',
  };
  const home = {
    id: 'security-home',
    kind: 'security',
    name: 'Home',
    method: 'http-json',
    url: 'https://phone.example/home',
  };
  const records = securityFeedPolicyRecords({
    version: 1,
    feeds: [tracker, van],
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].reportKey, phoneKey);
  assert.equal(records[0].password, 'secret');
  assert.equal('lat' in records[0], false);
  assert.equal('follow' in records[0], false);
  const samePlace = securityFeedPolicyRecords({
    version: 1,
    feeds: [{ ...van, lat: 1, follow: false, record: false }, tracker],
  });
  assert.equal(
    ultraFeedsPolicyMac(records, KEY),
    ultraFeedsPolicyMac(samePlace, KEY),
  );
  const otherPassword = securityFeedPolicyRecords({
    version: 1,
    feeds: [tracker, { ...van, password: 'other' }],
  });
  assert.notEqual(
    ultraFeedsPolicyMac(records, KEY),
    ultraFeedsPolicyMac(otherPassword, KEY),
  );
  const otherKey = securityFeedPolicyRecords({
    version: 1,
    feeds: [tracker, { ...van, reportKey: 'b'.repeat(43) }],
  });
  assert.notEqual(
    ultraFeedsPolicyMac(records, KEY),
    ultraFeedsPolicyMac(otherKey, KEY),
  );
  const ordered = securityFeedPolicyRecords({ version: 1, feeds: [van, home] });
  const flipped = securityFeedPolicyRecords({ version: 1, feeds: [home, van] });
  assert.notEqual(
    ultraFeedsPolicyMac(ordered, KEY),
    ultraFeedsPolicyMac(flipped, KEY),
  );
  assert.notEqual(
    ultraFeedsPolicyMac([], KEY),
    ultraFeedsPolicyMac(records, KEY),
  );
  const mac = ultraFeedsPolicyMac(records, KEY);
  assert.equal(ultraOutboundPolicyState(undefined, mac, KEY), 'legacy');
  assert.equal(ultraOutboundPolicyState('', mac, KEY), 'legacy');
  assert.equal(ultraOutboundPolicyState(null, mac, KEY), 'legacy');
  assert.equal(ultraOutboundPolicyState(mac, mac, KEY), 'ok');
  assert.equal(ultraOutboundPolicyState('b'.repeat(64), mac, KEY), 'bad');
  assert.equal(ultraOutboundPolicyState('nope', mac, KEY), 'bad');
  assert.equal(ultraOutboundPolicyState(mac, mac, Buffer.alloc(16)), 'bad');
  // The key is not mixed into this comparison. A check made under another
  // key is a different expected value, and that is what fails.
  assert.equal(
    ultraOutboundPolicyState(
      mac,
      ultraFeedsPolicyMac(records, Buffer.alloc(32, 1)),
      Buffer.alloc(32, 1),
    ),
    'bad',
  );
});

test('normalizeUltraDirectory judges every element on its own and keeps the first of a repeated token', () => {
  const document = {
    version: 1,
    note: 'ignored',
    entries: [
      { name: 'Sam', link: link(SAM, T1) },
      { name: 'Ann', link: link(ANN, T2), extra: 'ignored' },
      7,
      { name: '   ', link: link('https://kim.tail9.ts.net', T3) },
      { name: 'Eve', link: link('https://example.com', T4) },
      { name: 'Lan', link: link('http://192.168.1.5:44173', T5) },
      { name: 'Sam again', link: link('https://other.tail9.ts.net', T1) },
      'junk',
    ],
  };
  const out = normalizeUltraDirectory(document);
  assert.equal(out.unreadable, false);
  assert.equal(out.total, 8);
  assert.equal(out.skipped, 5);
  assert.deepEqual(out.entries, [
    {
      name: 'Sam',
      link: link(SAM, T1),
      token: T1,
      hash: ultraTokenHash(T1),
      host: 'sam.tail9.ts.net',
      base: SAM,
    },
    {
      name: 'Ann',
      link: link(ANN, T2),
      token: T2,
      hash: ultraTokenHash(T2),
      host: '100.64.1.2:44173',
      base: ANN,
    },
  ]);
  // A bare array is the same document; a trailing slash and whitespace are tolerated.
  assert.deepEqual(normalizeUltraDirectory(document.entries), out);
  assert.equal(
    normalizeUltraDirectory([
      { name: ' Sam ', link: ' ' + link(SAM, T1) + '/ ' },
    ]).entries[0].link,
    link(SAM, T1),
  );
  // Other junk on an element is refused with it: a missing link, a link that is not a string, a name that is not text.
  for (const item of [
    { name: 'Sam' },
    { link: link(SAM, T1) },
    { name: 'Sam', link: [link(SAM, T1)] },
    { name: { x: 1 }, link: link(SAM, T1) },
    { name: 'Sam', link: link(SAM, T1) + '?x' },
    { name: 'Sam', link: link('http://sam.tail9.ts.net', T1) },
    { name: 'Sam', link: link('https://127.0.0.1', T1) },
    { name: 'Sam', link: link('https://10.0.0.7', T1) },
    { name: 'Sam', link: link('https://169.254.1.1', T1) },
    { name: 'Sam', link: T1 },
    null,
    [],
    [{ name: 'Sam', link: link(SAM, T1) }],
  ]) {
    assert.deepEqual(
      normalizeUltraDirectory([item]),
      { entries: [], skipped: 1, total: 1, unreadable: false },
      JSON.stringify(item),
    );
  }
  // Names are text, cleaned and cut; a number is text too.
  const names = normalizeUltraDirectory([
    { name: '<b>Sam</b>', link: link(SAM, T1) },
    { name: 'x'.repeat(80) + '\u0000', link: link(SAM, T2) },
    { name: 7, link: link(SAM, T3) },
  ]);
  assert.deepEqual(
    names.entries.map((e) => e.name),
    ['<b>Sam</b>', 'x'.repeat(60), '7'],
  );
  // At most 500 elements are considered; the rest count as skipped.
  const flood = Array.from({ length: 600 }, (_, i) => ({
    name: 'P' + i,
    link: link(SAM, 'uht1.' + String(i).padStart(43, '0')),
  }));
  const capped = normalizeUltraDirectory(flood);
  assert.equal(capped.total, 600);
  assert.equal(capped.entries.length, 500);
  assert.equal(capped.skipped, 100);
  // A body that is neither an object with entries nor an array is unreadable.
  for (const body of [
    null,
    undefined,
    'text',
    7,
    {},
    { version: 1 },
    { entries: 'x' },
    { entries: {} },
  ]) {
    assert.deepEqual(
      normalizeUltraDirectory(body),
      { entries: [], skipped: 0, total: 0, unreadable: true },
      JSON.stringify(body),
    );
  }
  assert.deepEqual(normalizeUltraDirectory([]), {
    entries: [],
    skipped: 0,
    total: 0,
    unreadable: false,
  });
});

test('mergeUltraDirectory adds, renames, marks missing and moved, and never deletes', () => {
  let counter = 0;
  const newId = () => 'n-' + (counter += 1).toString(16).padStart(16, '0');
  const seal = (token, id) =>
    sealUltraToken(token, KEY, {
      id,
      randomBytes: fixedBytes(4),
      aad: ULTRA_NETWORK_AAD,
    });
  const pull = (items) => normalizeUltraDirectory(items);
  // Adding into an empty list.
  const first = mergeUltraDirectory({
    home: [],
    directory: {
      ...pull([
        { name: 'Sam', link: link(SAM, T1) },
        { name: 'Ann', link: link(ANN, T2) },
      ]),
      skipped: 2,
      total: 4,
    },
    ownHashes: [ultraTokenHash(MY)],
    ownBases: [MINE],
    now: NOW,
    seal,
    newId,
  });
  assert.deepEqual(
    { ...first, entries: undefined },
    {
      entries: undefined,
      added: 2,
      updated: 0,
      missing: 0,
      own: 0,
      moved: 0,
      skipped: 2,
      total: 4,
    },
  );
  assert.equal(first.entries.length, 2);
  assert.deepEqual(first.entries[0], {
    id: 'n-0000000000000001',
    name: 'Sam',
    base: SAM,
    host: 'sam.tail9.ts.net',
    hash: ultraTokenHash(T1),
    sealed: seal(T1, 'n-0000000000000001'),
    source: 'directory',
    addedAt: NOW,
    lastPolledAt: null,
    lastState: 'new',
    directoryMissing: false,
    moved: false,
  });
  assert.equal(first.entries[1].host, '100.64.1.2:44173');
  // Sealed under the network prefix: opens there and nowhere else.
  assert.equal(
    openUltraNetworkToken(first.entries[0].sealed, KEY, {
      id: 'n-0000000000000001',
    }),
    T1,
  );
  assert.equal(
    openUltraToken(first.entries[0].sealed, KEY, { id: 'n-0000000000000001' }),
    null,
  );
  assert.ok(!JSON.stringify(first.entries).includes(T1));
  // Renaming: a directory entry follows the file, a manual entry keeps the owner's name.
  const home = [
    entry({
      id: 'n-00000000000000aa',
      name: 'Sammy',
      source: 'manual',
      token: T1,
    }),
    entry({
      id: 'n-00000000000000bb',
      name: 'Ann',
      source: 'directory',
      base: ANN,
      token: T2,
      lastState: 'quiet',
      lastPolledAt: NOW - 100,
    }),
  ];
  const renamed = mergeUltraDirectory({
    home,
    directory: pull([
      { name: 'Sam', link: link(SAM, T1) },
      { name: 'Annie', link: link(ANN, T2) },
    ]),
    now: NOW,
    seal,
    newId,
  });
  assert.equal(renamed.added, 0);
  assert.equal(renamed.updated, 1);
  assert.equal(renamed.entries[0].name, 'Sammy');
  assert.equal(renamed.entries[1].name, 'Annie');
  assert.equal(renamed.entries[1].lastState, 'quiet');
  assert.equal(renamed.entries[1].lastPolledAt, NOW - 100);
  assert.equal(renamed.entries[1].id, 'n-00000000000000bb');
  // The home list handed in is not touched.
  assert.equal(home[1].name, 'Ann');
  assert.notEqual(renamed.entries, home);
  // Missing: a directory entry absent from the pull is marked, never deleted; a manual one is left alone; it clears when it returns.
  const gone = mergeUltraDirectory({
    home,
    directory: pull([
      { name: 'Bob', link: link('https://bob.tail9.ts.net', T3) },
    ]),
    now: NOW,
    seal,
    newId,
  });
  assert.equal(gone.missing, 1);
  assert.equal(gone.added, 1);
  assert.equal(gone.entries.length, 3);
  assert.equal(gone.entries[0].directoryMissing, false);
  assert.equal(gone.entries[0].lastState, 'new');
  assert.equal(gone.entries[1].directoryMissing, true);
  assert.equal(gone.entries[1].lastState, 'missing');
  assert.equal(gone.entries[2].name, 'Bob');
  const back = mergeUltraDirectory({
    home: gone.entries,
    directory: pull([
      { name: 'Annie', link: link(ANN, T2) },
      { name: 'Bob', link: link('https://bob.tail9.ts.net', T3) },
    ]),
    now: NOW,
    seal,
    newId,
  });
  assert.equal(back.missing, 0);
  assert.equal(back.entries[1].directoryMissing, false);
  assert.equal(back.entries[1].lastState, 'new');
  assert.equal(back.entries[1].name, 'Annie');
  assert.equal(back.updated, 1);
  // Moved: a known token under another base keeps its base, is flagged and not followed.
  const moved = mergeUltraDirectory({
    home: [
      entry({
        id: 'n-00000000000000bb',
        name: 'Ann',
        source: 'directory',
        base: ANN,
        token: T2,
        lastState: 'quiet',
      }),
    ],
    directory: pull([
      { name: 'Ann', link: link('https://evil.tail9.ts.net', T2) },
    ]),
    now: NOW,
    seal,
    newId,
  });
  assert.equal(moved.moved, 1);
  assert.equal(moved.added, 0);
  assert.equal(moved.missing, 0);
  assert.equal(moved.entries.length, 1);
  assert.equal(moved.entries[0].base, ANN);
  assert.equal(moved.entries[0].host, '100.64.1.2:44173');
  assert.equal(moved.entries[0].moved, true);
  assert.equal(moved.entries[0].lastState, 'moved');
  // The directory agrees again: the flag clears and the entry is polled again.
  const agreed = mergeUltraDirectory({
    home: moved.entries,
    directory: pull([{ name: 'Ann', link: link(ANN, T2) }]),
    now: NOW,
    seal,
    newId,
  });
  assert.equal(agreed.moved, 0);
  assert.equal(agreed.entries[0].moved, false);
  assert.equal(agreed.entries[0].lastState, 'new');
  // A link the owner added by hand is never switched off by the directory:
  // the disagreement is counted, the owner's own base stays and is polled.
  const manual = mergeUltraDirectory({
    home: [
      entry({
        id: 'n-00000000000000aa',
        name: 'Sammy',
        source: 'manual',
        token: T1,
        lastState: 'quiet',
      }),
    ],
    directory: pull([
      { name: 'Sam', link: link('https://evil.tail9.ts.net', T1) },
    ]),
    now: NOW,
    seal,
    newId,
  });
  assert.equal(manual.moved, 1);
  assert.equal(manual.entries[0].moved, false);
  assert.equal(manual.entries[0].base, SAM);
  assert.equal(manual.entries[0].lastState, 'quiet');
  // The row says so, and the flag goes once the directory agrees.
  assert.equal(manual.entries[0].directoryDiffers, true);
  assert.equal(
    normalizeUltraNetworkEntry(manual.entries[0]).directoryDiffers,
    true,
  );
  assert.equal(
    ultraNetworkPublicEntry(manual.entries[0]).directoryDiffers,
    true,
  );
  const settled = mergeUltraDirectory({
    home: manual.entries,
    directory: pull([{ name: 'Sam', link: link(SAM, T1) }]),
    now: NOW,
    seal,
    newId,
  });
  assert.equal(settled.entries[0].directoryDiffers, false);
  assert.equal(
    'directoryDiffers' in normalizeUltraNetworkEntry(settled.entries[0]),
    false,
  );
  // And a manual entry an older version flagged is released on the next pull.
  const released = mergeUltraDirectory({
    home: [
      entry({
        id: 'n-00000000000000aa',
        name: 'Sammy',
        source: 'manual',
        token: T1,
        lastState: 'moved',
        moved: true,
      }),
    ],
    directory: pull([
      { name: 'Sam', link: link('https://evil.tail9.ts.net', T1) },
    ]),
    now: NOW,
    seal,
    newId,
  });
  assert.equal(released.entries[0].moved, false);
  assert.equal(released.entries[0].lastState, 'new');
  // Own: my token or my base is never added, with either spelling of the base.
  const own = mergeUltraDirectory({
    home: [],
    directory: pull([
      { name: 'Me', link: link(MINE, MY) },
      { name: 'Me too', link: link('https://MYBOX.tail0demo0.ts.net', T4) },
      { name: 'Me again', link: link(MINE, T5) },
    ]),
    ownHashes: new Set([ultraTokenHash(MY)]),
    ownBases: [MINE + '/'],
    now: NOW,
    seal,
    newId,
  });
  assert.equal(own.own, 3);
  assert.equal(own.added, 0);
  assert.deepEqual(own.entries, []);
  // The cap: extras count as skipped.
  const full = Array.from({ length: 199 }, (_, i) =>
    entry({
      id: 'n-' + i.toString(16).padStart(16, '0'),
      token: newUltraToken(fixedBytes(i)),
      source: 'directory',
    }),
  );
  const capped = mergeUltraDirectory({
    home: full,
    directory: pull([
      ...full.map((e, i) => ({
        name: e.name,
        link: link(e.base, newUltraToken(fixedBytes(i))),
      })),
      { name: 'X', link: link('https://x.tail9.ts.net', tokenOf(0xf4)) },
      { name: 'Y', link: link('https://y.tail9.ts.net', tokenOf(0xf5)) },
      { name: 'Z', link: link('https://z.tail9.ts.net', tokenOf(0xf6)) },
    ]),
    now: NOW,
    seal,
    newId,
  });
  assert.equal(capped.added, 1);
  assert.equal(capped.skipped, 2);
  assert.equal(capped.missing, 0);
  assert.equal(capped.entries.length, 200);
  assert.equal(capped.entries[199].name, 'X');
  // An empty pull changes nothing, and a pull is accepted as a bare list too.
  const empty = mergeUltraDirectory({
    home,
    directory: pull([]),
    now: NOW,
    seal,
    newId,
  });
  assert.deepEqual(
    { ...empty, entries: empty.entries.map((e) => e.name) },
    {
      entries: ['Sammy', 'Ann'],
      added: 0,
      updated: 0,
      missing: 0,
      own: 0,
      moved: 0,
      skipped: 0,
      total: 0,
    },
  );
  assert.equal(empty.entries[1].directoryMissing, false);
  assert.equal(
    mergeUltraDirectory({
      home: [],
      directory: pull([{ name: 'Sam', link: link(SAM, T1) }]).entries,
      now: NOW,
      seal,
      newId,
    }).added,
    1,
  );
  assert.equal(mergeUltraDirectory().added, 0);
});

test('mergeUltraDirectory leaves at most eight polled links on one machine, however many a pull lists', () => {
  let counter = 0;
  const newId = () => 'n-' + (counter += 1).toString(16).padStart(16, '0');
  const seal = (token, id) =>
    sealUltraToken(token, KEY, {
      id,
      randomBytes: fixedBytes(4),
      aad: ULTRA_NETWORK_AAD,
    });
  const X = 'https://x.tail9.ts.net';
  const Y = 'https://y.tail9.ts.net';
  const onX = (row) => row.host === 'x.tail9.ts.net';
  // The owner's own link to x, and a directory that lists twenty more there.
  const manual = entry({
    id: 'n-00000000000000aa',
    base: X,
    token: tokenOf(0xa0),
  });
  const invented = Array.from({ length: 20 }, (_, i) => ({
    name: `Bogus ${i}`,
    link: link(X, tokenOf(0x10 + i)),
  }));
  const first = mergeUltraDirectory({
    home: [manual],
    directory: normalizeUltraDirectory([
      ...invented,
      { name: 'Yan', link: link(Y, tokenOf(0x40)) },
    ]),
    now: NOW,
    seal,
    newId,
  });
  assert.equal(first.added, 8);
  assert.equal(first.skipped, 13);
  assert.equal(
    first.entries.filter(onX).length,
    ULTRA_NETWORK_HOST_ENTRY_LIMIT,
    'the hand-added link and seven more',
  );
  assert.equal(first.entries[0].id, manual.id, 'the owner’s link is kept');
  assert.equal(
    first.entries.filter((row) => row.host === 'y.tail9.ts.net').length,
    1,
    'another machine is not held back',
  );
  // The next pull drops one of the directory's links to x: that one is no
  // longer polled, so a new token on x gets its place. Another port on the
  // same machine is the same machine, and is skipped.
  const second = mergeUltraDirectory({
    home: first.entries,
    directory: normalizeUltraDirectory([
      ...invented.slice(1, 7),
      { name: 'Fresh', link: link(X, tokenOf(0x50)) },
      { name: 'Extra', link: link(X, tokenOf(0x51)) },
      { name: 'Port', link: link(`${X}:8443`, tokenOf(0x52)) },
    ]),
    now: NOW,
    seal,
    newId,
  });
  assert.deepEqual([second.added, second.skipped, second.missing], [1, 2, 2]);
  assert.deepEqual(
    second.entries
      .filter((row) => onX(row) && !row.directoryMissing)
      .map((row) => row.name),
    [
      'Sam',
      'Bogus 1',
      'Bogus 2',
      'Bogus 3',
      'Bogus 4',
      'Bogus 5',
      'Bogus 6',
      'Fresh',
    ],
  );
});

test('githubDirectoryApi maps a raw or page URL to the contents API and nothing else', () => {
  assert.deepEqual(
    githubDirectoryApi(
      'https://raw.githubusercontent.com/g/r/main/ultra-directory.json',
    ),
    {
      contentsUrl:
        'https://api.github.com/repos/g/r/contents/ultra-directory.json',
      ref: 'main',
      owner: 'g',
      repo: 'r',
      path: 'ultra-directory.json',
    },
  );
  assert.deepEqual(
    githubDirectoryApi(
      'https://raw.githubusercontent.com/g/r/refs/heads/main/dir/ultra-directory.json',
    ),
    {
      contentsUrl:
        'https://api.github.com/repos/g/r/contents/dir/ultra-directory.json',
      ref: 'main',
      owner: 'g',
      repo: 'r',
      path: 'dir/ultra-directory.json',
    },
  );
  assert.deepEqual(
    githubDirectoryApi('https://github.com/g/r/blob/main/ultra%20dir.json'),
    {
      contentsUrl: 'https://api.github.com/repos/g/r/contents/ultra%20dir.json',
      ref: 'main',
      owner: 'g',
      repo: 'r',
      path: 'ultra dir.json',
    },
  );
  assert.equal(
    githubDirectoryApi(
      'https://raw.githubusercontent.com/g/r/main/ultra dir.json',
    ).contentsUrl,
    'https://api.github.com/repos/g/r/contents/ultra%20dir.json',
  );
  assert.equal(
    githubDirectoryApi('https://github.com/g/r/raw/v1.2/x.json').ref,
    'v1.2',
  );
  assert.equal(
    githubDirectoryApi('https://www.github.com/My-Org/my.repo/blob/main/x.json')
      .contentsUrl,
    'https://api.github.com/repos/My-Org/my.repo/contents/x.json',
  );
  for (const url of [
    'https://gist.github.com/g/abc',
    'https://drive.google.com/file/d/abc/view',
    'https://docs.google.com/document/d/abc',
    'http://raw.githubusercontent.com/g/r/main/x.json',
    'https://raw.githubusercontent.com/g/r',
    'https://raw.githubusercontent.com/g/r/main',
    'https://raw.githubusercontent.com/g/r/main/',
    'https://github.com/g/r/tree/main/x.json',
    'https://github.com/g/r',
    'https://github.com/g/r/blob/main',
    'https://github.com/g/r/blob/main/%2e%2e/x.json',
    'https://raw.githubusercontent.com/g%2Fx/r/main/x.json',
    'https://u:p@raw.githubusercontent.com/g/r/main/x.json',
    'https://api.github.com/repos/g/r/contents/x.json',
    'https://raw.githubusercontent.com.evil.test/g/r/main/x.json',
    'https://raw.githubusercontent.com/g/r/main/%ZZ.json',
    '',
    'junk',
    null,
    undefined,
  ]) {
    assert.equal(githubDirectoryApi(url), null, String(url));
  }
  // The write token only ever travels to api.github.com.
  for (const url of [
    'https://raw.githubusercontent.com/g/r/main/x.json',
    'https://github.com/g/r/blob/main/a/b/c.json',
  ]) {
    assert.equal(
      new URL(githubDirectoryApi(url).contentsUrl).host,
      'api.github.com',
    );
  }
});

test('ultraDirectoryEntry is exactly a name and a link', () => {
  const mine = ultraDirectoryEntry({
    name: 'Jeff (Van 7)',
    link: link(MINE, MY),
  });
  assert.deepEqual(Object.keys(mine), ['name', 'link']);
  assert.deepEqual(mine, { name: 'Jeff (Van 7)', link: link(MINE, MY) });
  assert.deepEqual(
    Object.keys(
      ultraDirectoryEntry({ name: 'x', link: 'y', number: '+1', lat: 1 }),
    ),
    ['name', 'link'],
  );
  assert.equal(ultraDirectoryEntry({ name: '', link: 'y' }).name, 'Ultra');
  assert.equal(ultraDirectoryEntry({ link: 'y' }).name, 'Ultra');
  assert.equal(
    ultraDirectoryEntry({ name: 'x'.repeat(80), link: 'y' }).name.length,
    60,
  );
  assert.equal(
    ultraDirectoryEntry({ name: 'a\u0000b', link: ' y ' }).link,
    'y',
  );
  assert.deepEqual(ultraDirectoryEntry(), { name: 'Ultra', link: '' });
  assert.equal(
    JSON.stringify(mine, null, 2),
    `{\n  "name": "Jeff (Van 7)",\n  "link": "${link(MINE, MY)}"\n}`,
  );
});

test('mergeDirectoryDocument puts my entry in without touching anyone else and refuses a file that is not JSON', () => {
  const mine = { name: 'Jeff (Van 7)', link: link(MINE, MY) };
  const sam = {
    name: 'Sam',
    link: link(SAM, T1),
    extra: { nested: [1, 'two', null] },
  };
  const old = {
    name: 'Old me',
    link: link('https://old.tail0demo0.ts.net', MY),
    note: 'stale',
  };
  const existing = JSON.stringify(
    {
      version: 1,
      note: 'keep',
      entries: [sam, 'garbage', 7, null, { broken: true }, old],
    },
    null,
    4,
  );
  const replaced = mergeDirectoryDocument(existing, mine);
  assert.equal(replaced.replaced, true);
  assert.ok(replaced.text.endsWith('\n'));
  assert.deepEqual(JSON.parse(replaced.text), {
    version: 1,
    note: 'keep',
    entries: [sam, 'garbage', 7, null, { broken: true }, mine],
  });
  assert.equal(
    replaced.text,
    JSON.stringify(JSON.parse(replaced.text), null, 2) + '\n',
  );
  // Absent: appended. Two copies of my own token collapse into one.
  const appended = mergeDirectoryDocument(
    JSON.stringify({ entries: [sam] }),
    mine,
  );
  assert.equal(appended.replaced, false);
  assert.deepEqual(JSON.parse(appended.text).entries, [sam, mine]);
  assert.deepEqual(
    JSON.parse(
      mergeDirectoryDocument(JSON.stringify({ entries: [old, sam, old] }), mine)
        .text,
    ).entries,
    [mine, sam],
  );
  // Nothing yet (an empty file or a 404) becomes the canonical document; a bare array stays an array.
  assert.deepEqual(mergeDirectoryDocument('', mine), {
    text: JSON.stringify({ version: 1, entries: [mine] }, null, 2) + '\n',
    replaced: false,
  });
  assert.deepEqual(JSON.parse(mergeDirectoryDocument('  \n', mine).text), {
    version: 1,
    entries: [mine],
  });
  assert.deepEqual(JSON.parse(mergeDirectoryDocument(undefined, mine).text), {
    version: 1,
    entries: [mine],
  });
  assert.deepEqual(JSON.parse(mergeDirectoryDocument('[]', mine).text), [mine]);
  assert.deepEqual(
    JSON.parse(mergeDirectoryDocument(JSON.stringify([sam]), mine).text),
    [sam, mine],
  );
  // A file that is not the document is never clobbered.
  for (const text of [
    '{not json',
    '{"foo":1}',
    '{"entries":"x"}',
    'null',
    '7',
    '"x"',
    'true',
  ]) {
    assert.equal(mergeDirectoryDocument(text, mine), null, text);
  }
  // My entry must itself be a whole help link.
  assert.equal(mergeDirectoryDocument('', { name: 'x', link: MY }), null);
  assert.equal(mergeDirectoryDocument('', { name: 'x', link: '' }), null);
  assert.equal(
    ultraDirectoryMailto('{"name":"x"}'),
    'mailto:?subject=' +
      encodeURIComponent('GEVC Ultra help directory entry') +
      '&body=' +
      encodeURIComponent(
        'Please add this entry to our Ultra help directory:\n\n{"name":"x"}',
      ),
  );
  assert.ok(
    ultraDirectoryMailto('a&b#c').endsWith(encodeURIComponent('a&b#c')),
  );
  assert.ok(ultraDirectoryMailto(null).startsWith('mailto:?subject='));
});

test('ultraNetworkPin is the Your Devices row for one active call and nothing when it is over', () => {
  const episode = {
    lat: 45.27,
    lon: -66.06,
    at: NOW - 5000,
    until: NOW + 1000,
    from: 'Van 7',
  };
  const pin = ultraNetworkPin(entry(), episode, NOW);
  assert.deepEqual(pin, {
    id: 'ultra-network:n-0000000000000001',
    kind: 'help',
    kindLabel: 'NEEDS HELP · ' + hhmm(NOW - 5000),
    color: '#ffb000',
    name: 'Van 7',
    lat: 45.27,
    lon: -66.06,
    altM: null,
    headingDeg: null,
    speedMps: null,
    live: true,
    fixed: false,
    at: NOW - 5000,
    follow: false,
    record: false,
    recordKm: 0,
    hasPicture: false,
    pictureUrl: null,
    error: '',
    history: null,
  });
  assert.ok(pin.kindLabel.length <= 30);
  // The name is the peer's, then the entry's, cut at 80; never the plea.
  assert.equal(
    ultraNetworkPin(entry(), { ...episode, from: '' }, NOW).name,
    'Sam',
  );
  assert.equal(
    ultraNetworkPin(entry({ name: '' }), { ...episode, from: '' }, NOW).name,
    'Ultra',
  );
  assert.equal(
    ultraNetworkPin(
      entry(),
      { ...episode, from: 'x'.repeat(100), text: 'plea' },
      NOW,
    ).name.length,
    80,
  );
  assert.ok(
    !JSON.stringify(
      ultraNetworkPin(entry(), { ...episode, text: 'the plea' }, NOW),
    ).includes('the plea'),
  );
  // Over, without a position, or with a bad entry: no pin.
  assert.equal(ultraNetworkPin(entry(), { ...episode, until: NOW }, NOW), null);
  assert.equal(
    ultraNetworkPin(entry(), { ...episode, until: null }, NOW),
    null,
  );
  assert.equal(
    ultraNetworkPin(entry(), { ...episode, lat: null, lon: null }, NOW),
    null,
  );
  assert.equal(ultraNetworkPin(entry(), { ...episode, lat: 91 }, NOW), null);
  assert.equal(ultraNetworkPin(entry(), { ...episode, at: 'x' }, NOW), null);
  assert.equal(ultraNetworkPin(entry({ id: 'x' }), episode, NOW), null);
  assert.equal(ultraNetworkPin(null, episode, NOW), null);
  assert.equal(ultraNetworkPin(entry(), null, NOW), null);
  assert.equal(ultraNetworkPin(entry(), 'x', NOW), null);
  // An inbox row of kind 'release' is an episode as it is.
  const row = ultraReleaseInboxRecord({
    entry: entry(),
    answer: normalizeUltraNetworkAnswer(peerRelease(), {
      now: NOW,
      entryName: 'Sam',
    }),
    now: NOW,
    ids: { message: () => 'm-0123456789abcdef' },
  });
  assert.equal(ultraNetworkPin(entry(), row, NOW).name, 'Van 7');
  assert.equal(
    ultraNetworkPin(entry(), row, NOW + ULTRA_RELEASE_WINDOW_MS),
    null,
  );
});

test('ultraWatchingCount counts live NETWORK tokens that polled within a minute', () => {
  const tokens = [
    { id: 't-0000000000000001', feedId: 'van', network: true, revokedAt: null },
    { id: 't-0000000000000002', feedId: 'van', network: true, revokedAt: null },
    {
      id: 't-0000000000000003',
      feedId: 'van',
      network: false,
      revokedAt: null,
    },
    {
      id: 't-0000000000000004',
      feedId: 'van',
      network: true,
      revokedAt: NOW - 1,
    },
    {
      id: 't-0000000000000005',
      feedId: 'home',
      network: true,
      revokedAt: null,
    },
    { id: 't-0000000000000006', feedId: 'van', network: true, revokedAt: null },
    {
      id: 't-0000000000000007',
      feedId: 'van',
      network: 'yes',
      revokedAt: null,
    },
    null,
  ];
  const polls = new Map([
    ['t-0000000000000001', NOW - 1000],
    ['t-0000000000000002', NOW - 60_000],
    ['t-0000000000000003', NOW],
    ['t-0000000000000004', NOW],
    ['t-0000000000000005', NOW - 100],
    ['t-0000000000000007', NOW],
  ]);
  assert.equal(ultraWatchingCount(tokens, polls, NOW), 2);
  assert.equal(ultraWatchingCount(tokens, polls, NOW, { feedId: 'van' }), 1);
  assert.equal(ultraWatchingCount(tokens, polls, NOW, { feedId: 'home' }), 1);
  assert.equal(ultraWatchingCount(tokens, polls, NOW, { feedId: 'boat' }), 0);
  assert.equal(ultraWatchingCount(tokens, polls, NOW + 59_000), 1);
  assert.equal(ultraWatchingCount(tokens, polls, NOW + 60_000), 0);
  assert.equal(ultraWatchingCount(tokens, new Map(), NOW), 0);
  assert.equal(ultraWatchingCount(tokens, null, NOW), 0);
  assert.equal(ultraWatchingCount(null, polls, NOW), 0);
  assert.equal(ultraWatchingCount([], polls, NOW), 0);
});

test('ultraGeocodeKey and ultraNeedsGeocode ask Nominatim only when the fix moved past 50 m', () => {
  assert.equal(
    ultraGeocodeKey({ lat: 45.27444, lon: -66.06222 }),
    '45.2744,-66.0622',
  );
  assert.equal(
    ultraGeocodeKey({ lat: '45.27', lon: '-66.06' }),
    '45.2700,-66.0600',
  );
  assert.equal(ultraGeocodeKey({ lat: 0, lon: 0 }), '');
  assert.equal(ultraGeocodeKey({ lat: 91, lon: 0 }), '');
  assert.equal(ultraGeocodeKey(null), '');
  const cached = { lat: 45.27, lon: -66.06, place: PLACE };
  assert.equal(ultraNeedsGeocode(cached, { lat: 45.27, lon: -66.06 }), false);
  assert.equal(
    ultraNeedsGeocode(cached, { lat: 45.27009, lon: -66.06 }),
    false,
  );
  assert.equal(
    ultraNeedsGeocode(cached, { lat: 45.27044, lon: -66.06 }),
    false,
  );
  assert.equal(ultraNeedsGeocode(cached, { lat: 45.271, lon: -66.06 }), true);
  assert.equal(ultraNeedsGeocode(cached, { lat: 45.27, lon: -66.061 }), true);
  assert.equal(ultraNeedsGeocode(null, { lat: 45.27, lon: -66.06 }), true);
  assert.equal(ultraNeedsGeocode({}, { lat: 45.27, lon: -66.06 }), true);
  assert.equal(
    ultraNeedsGeocode({ lat: 0, lon: 0 }, { lat: 45.27, lon: -66.06 }),
    true,
  );
  assert.equal(ultraNeedsGeocode(cached, { lat: 91, lon: 0 }), false);
  assert.equal(ultraNeedsGeocode(cached, null), false);
  assert.equal(ultraNeedsGeocode(null, null), false);
});

test('ultraNeedsGeocode asks again a minute after a lookup that failed, and not before', () => {
  const T = NOW;
  const here = { lat: 45.27, lon: -66.06 };
  const failed = { ...here, place: '', failedAt: T };
  assert.equal(ultraNeedsGeocode(failed, here, T + 20_000), false);
  assert.equal(
    ultraNeedsGeocode(failed, here, T + ULTRA_GEOCODE_RETRY_MS - 1),
    false,
  );
  assert.equal(
    ultraNeedsGeocode(failed, here, T + ULTRA_GEOCODE_RETRY_MS),
    true,
  );
  // A real move is asked about at once, failure or not.
  assert.equal(
    ultraNeedsGeocode(failed, { lat: 45.271, lon: -66.06 }, T),
    true,
  );
  // An address that was found is never asked again at the same spot.
  const found = { ...here, place: PLACE };
  assert.equal(ultraNeedsGeocode(found, here, T + 10 * 86_400_000), false);
  // Without a clock the distance rule alone decides, as before.
  assert.equal(ultraNeedsGeocode(failed, here), false);
});

test('the module loads where Buffer and node:crypto are only stubs (the browser bundle)', () => {
  // Nothing here belongs in a browser bundle, but importing the module must
  // still touch neither Buffer nor crypto until a function that needs them
  // runs. A child process with the Buffer global removed stands in for the
  // browser, exactly as the ultraTokens pin does.
  const moduleUrl = new URL(
    '../server/shared/ultraNetwork.mjs',
    import.meta.url,
  ).href;
  const script = [
    'delete globalThis.Buffer;',
    `const m = await import(${JSON.stringify(moduleUrl)});`,
    "process.stdout.write(String(m.ultraTailnetTarget({ scheme: 'https', hostname: 'x.ts.net' })) + '|' + String(m.ultraTailnetTarget({ scheme: 'https', hostname: 'example.com' })));",
  ].join('\n');
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  assert.equal(out, 'true|false');
});

test("the docs' poll, directory and relay figures match the code", () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const changelog = read('../CHANGELOG.md');
  const state = read('../docs/CURRENT-STATE.md');
  const env = read('../.env.example');
  const server = read('../server/providers/ultra-help.js');
  // The poller takes four a tick and more on a long list. The CHANGELOG
  // keeps "four at a time" once, where it describes the fault that was fixed.
  if (ULTRA_NETWORK_MAX_IN_FLIGHT > ULTRA_NETWORK_CONCURRENCY) {
    assert.doesNotMatch(changelog, /runs four at a time/);
    assert.doesNotMatch(state, /four at a time/);
    assert.doesNotMatch(server, /oldest first, four at a time/);
  }
  // Admission re-reads the token and device stores on every /network poll,
  // and PUBLISH rewrites the directory file as 2-space JSON.
  assert.doesNotMatch(changelog, /no file is read on that path/);
  assert.doesNotMatch(
    changelog,
    /keeps every other element of the file byte-for-byte/,
  );
  assert.match(changelog, /rewritten as 2-space JSON/);
  // No poll ever yields 'off': a token with NETWORK off answers the uniform
  // 404, so its row reads LINK DEAD, and no row state is NOT SHARING.
  for (const status of [0, 404, 429, 500]) {
    assert.notEqual(ultraPollOutcome({ status, now: NOW }).state, 'off');
  }
  for (const answer of [
    { released: false },
    normalizeUltraNetworkAnswer({ released: false }, { now: NOW }),
  ]) {
    assert.notEqual(
      ultraPollOutcome({ status: 200, answer, now: NOW }).state,
      'off',
    );
  }
  assert.doesNotMatch(changelog, /NOT SHARING/);
  // The day's SMS figures in .env.example follow the constants: the cap,
  // and where friends' calls and TEST SMS stop.
  assert.match(
    env,
    new RegExp(
      `${ULTRA_SMS_DAILY_LIMIT} a day[^.]*${ULTRA_SMS_DAILY_LIMIT - ULTRA_SMS_OWN_RESERVE}`,
    ),
  );
  assert.match(env, new RegExp(`the last ${ULTRA_SMS_OWN_RESERVE} kept`));
  // The same reserve holds in a provider host's hour.
  assert.match(
    env,
    new RegExp(
      `${ULTRA_SMS_HOST_LIMIT.max} an hour per host[^.]*${ULTRA_SMS_HOST_LIMIT.max - ULTRA_SMS_OWN_RESERVE}`,
    ),
  );
  // A failed helper text is tried again only by EXTEND HELP or a new press,
  // and a timeout keeps its place in the count.
  assert.doesNotMatch(state, /tried again a minute later and does not count/);
  assert.match(state, /nothing retries it\s+by itself/);
  // A full restart while the disk still refuses the write reloads the call
  // the file holds, so no entry may promise that a restart cannot.
  assert.doesNotMatch(changelog, /so a restart (still )?cannot bring/);
});
